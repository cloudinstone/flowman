// Flow Batch Downloader — content script (executor).
//
// Owns everything that touches Flow's DOM: scanning the grid, rendering
// selection checkboxes on tiles, and clicking through
// "More options -> Download -> <resolution>" for one video at a time.
// The side panel owns the queue and decides what to trigger; the two talk
// over a long-lived port so the page knows when the panel is open.

(() => {
  'use strict';

  if (window.__fbdLoaded) return;
  window.__fbdLoaded = true;

  const PORT_NAME = 'fbd';
  const MENU_TIMEOUT_MS = 5000;
  const RENDER_WAIT_MS = 500;
  const FAILURE_SNACKBAR_RE = /fail|error|unable|couldn.?t|could not|try again|went wrong/i;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------------------------------------------------------------------
  // Flow DOM helpers
  // ---------------------------------------------------------------------------

  const getScroller = () => document.querySelector('[cdkvirtualscrollingelement]');

  const allTiles = () => [...document.querySelectorAll('flow-grid-tile-container')];

  const tileTitle = (tile) => tile.getAttribute('aria-label') || '(untitled)';

  // Failed generations are video tiles too, but have no context menu.
  const isDownloadableVideo = (tile) =>
    !!tile.querySelector('flow-video-tile') && !!tile.querySelector('button[aria-haspopup="menu"]');

  const videoTiles = () => allTiles().filter(isDownloadableVideo);

  // Virtual scrolling recycles tile elements and Flow exposes no media id in
  // the DOM, so a tile is identified by its absolute position in the grid.
  function tileKey(tile, scroller) {
    const r = tile.getBoundingClientRect();
    const s = scroller.getBoundingClientRect();
    return `${Math.round(r.top - s.top + scroller.scrollTop)}:${Math.round(r.left - s.left)}`;
  }

  const parseKey = (key) => key.split(':').map(Number);

  const compareKeys = (a, b) => {
    const [at, al] = parseKey(a);
    const [bt, bl] = parseKey(b);
    return at - bt || al - bl;
  };

  const keysMatch = (a, b) => {
    const [at, al] = parseKey(a);
    const [bt, bl] = parseKey(b);
    return Math.abs(at - bt) <= 4 && Math.abs(al - bl) <= 4;
  };

  const menuItems = () => [
    ...document.querySelectorAll('.cdk-overlay-container [role="menu"] [role="menuitem"]'),
  ];
  const menuItemLabel = (el) => (el.querySelector('.label')?.textContent || '').trim();
  const menuItemIcon = (el) => (el.querySelector('mat-icon')?.textContent || '').trim();

  async function waitFor(fn, timeoutMs, what) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const v = fn();
      if (v) return v;
      await sleep(100);
    }
    throw new Error(`Timed out waiting for ${what}`);
  }

  function closeMenus() {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.querySelectorAll('.cdk-overlay-backdrop').forEach((b) => b.click());
  }

  // Scroll through the whole grid and collect every downloadable video tile.
  async function scanAllVideos() {
    const scroller = getScroller();
    if (!scroller) throw new Error('Media grid not found. Open a project in Flow first.');
    const original = scroller.scrollTop;
    const found = new Map();
    scroller.scrollTop = 0;
    await sleep(RENDER_WAIT_MS);
    for (;;) {
      for (const tile of videoTiles()) found.set(tileKey(tile, scroller), tileTitle(tile));
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) break;
      const prev = scroller.scrollTop;
      scroller.scrollTop += Math.floor(scroller.clientHeight * 0.7);
      await sleep(RENDER_WAIT_MS);
      if (scroller.scrollTop === prev) break;
    }
    scroller.scrollTop = original;
    return [...found.entries()]
      .sort(([a], [b]) => compareKeys(a, b))
      .map(([key, title]) => ({ key, title }));
  }

  async function scrollToKey(scroller, key) {
    const [top] = parseKey(key);
    scroller.scrollTop = Math.max(0, top - 120);
    await sleep(RENDER_WAIT_MS);
    return videoTiles().find((t) => keysMatch(tileKey(t, scroller), key));
  }

  // Bring the tile for `item` into the DOM and return it with its current key.
  // Falls back to a unique title match if the layout shifted.
  async function locateTile(item) {
    const scroller = getScroller();
    if (!scroller) throw new Error('Media grid not found');
    const atPos = await scrollToKey(scroller, item.key);
    if (atPos && tileTitle(atPos) === item.title) return { tile: atPos, key: item.key };

    const matches = (await scanAllVideos()).filter((v) => v.title === item.title);
    if (matches.length !== 1) {
      throw new Error('The grid layout changed and this video could not be identified');
    }
    const tile = await scrollToKey(scroller, matches[0].key);
    if (!tile) throw new Error('Video tile not found');
    return { tile, key: matches[0].key };
  }

  // Click through Flow's menu. Resolves once the resolution was clicked; the
  // side panel then waits for the browser download.
  async function trigger(item, resolution) {
    const { tile, key } = await locateTile(item);
    tile.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    tile.querySelector('button[aria-haspopup="menu"]').click();

    const downloadEntry = await waitFor(
      () => menuItems().find((el) => menuItemIcon(el) === 'download'),
      MENU_TIMEOUT_MS,
      'the Download menu item',
    );
    downloadEntry.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    downloadEntry.click();

    const resEntry = await waitFor(
      () => menuItems().find((el) => menuItemLabel(el) === resolution),
      MENU_TIMEOUT_MS,
      `the ${resolution} option`,
    );
    if (resEntry.disabled || resEntry.getAttribute('aria-disabled') === 'true') {
      throw new Error(`${resolution} isn't available for this video on your plan`);
    }
    resEntry.click();
    return { key };
  }

  // ---------------------------------------------------------------------------
  // Port to the side panel
  // ---------------------------------------------------------------------------

  /** @type {chrome.runtime.Port | null} */
  let port = null;
  let view = { selected: new Set(), statuses: new Map(), locked: false };

  const resetView = () => {
    view = { selected: new Set(), statuses: new Map(), locked: false };
  };

  chrome.runtime.onConnect.addListener((p) => {
    if (p.name !== PORT_NAME) return;
    if (port) port.disconnect();
    port = p;
    resetView();
    document.body.classList.add('fbd-active');
    p.onMessage.addListener((msg) => handleMessage(p, msg));
    p.onDisconnect.addListener(() => {
      if (port !== p) return;
      port = null;
      resetView();
      document.body.classList.remove('fbd-active');
      syncTiles();
    });
    scheduleSync();
  });

  async function handleMessage(p, msg) {
    if (msg.type === 'view') {
      view = {
        selected: new Set(msg.selected),
        statuses: new Map(Object.entries(msg.statuses)),
        locked: msg.locked,
      };
      scheduleSync();
      return;
    }
    if (msg.id == null) return;
    try {
      let result;
      if (msg.type === 'scan') result = await scanAllVideos();
      else if (msg.type === 'trigger') result = await trigger(msg.item, msg.resolution);
      else throw new Error(`Unknown request: ${msg.type}`);
      p.postMessage({ id: msg.id, result });
    } catch (err) {
      closeMenus();
      p.postMessage({ id: msg.id, error: String(err?.message || err) });
    }
  }

  // Report Flow error snackbars so the panel can fail the current item.
  new MutationObserver((mutations) => {
    if (!port) return;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        const bar = node.matches?.('flow-snackbar') ? node : node.querySelector?.('flow-snackbar');
        const text = bar?.textContent?.replace(/\s+/g, ' ').replace(/\bDismiss\b/g, '').trim();
        if (text && FAILURE_SNACKBAR_RE.test(text)) {
          port.postMessage({ type: 'flow-error', text });
          return;
        }
      }
    }
  }).observe(document.body, { childList: true, subtree: true });

  // ---------------------------------------------------------------------------
  // In-grid checkboxes
  // ---------------------------------------------------------------------------

  function syncTiles() {
    const scroller = getScroller();
    for (const tile of allTiles()) {
      let cb = tile.querySelector(':scope > .fbd-check');
      if (!port || !scroller || !isDownloadableVideo(tile)) {
        cb?.remove();
        delete tile.dataset.fbdStatus;
        continue;
      }
      if (!cb) {
        cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'fbd-check';
        cb.title = 'Select for batch download';
        for (const evt of ['click', 'mousedown', 'pointerdown', 'mouseup', 'pointerup', 'dblclick']) {
          cb.addEventListener(evt, (e) => e.stopPropagation());
        }
        cb.addEventListener('change', () => {
          const s = getScroller();
          if (!s || !port) return;
          port.postMessage({
            type: 'toggle',
            key: tileKey(tile, s),
            title: tileTitle(tile),
            checked: cb.checked,
          });
        });
        tile.appendChild(cb);
      }
      const key = tileKey(tile, scroller);
      cb.checked = view.selected.has(key);
      cb.disabled = view.locked;
      const status = view.statuses.get(key);
      if (status) tile.dataset.fbdStatus = status;
      else delete tile.dataset.fbdStatus;
    }
  }

  let syncScheduled = false;
  function scheduleSync() {
    if (syncScheduled) return;
    syncScheduled = true;
    requestAnimationFrame(() => {
      syncScheduled = false;
      syncTiles();
    });
  }

  new MutationObserver(() => {
    if (port) scheduleSync();
  }).observe(document.body, { childList: true, subtree: true });
  document.addEventListener(
    'scroll',
    () => {
      if (port) scheduleSync();
    },
    true,
  );
  window.addEventListener('resize', () => {
    // Positions are layout-dependent; let the panel decide what to do.
    port?.postMessage({ type: 'layout-changed' });
  });
})();
