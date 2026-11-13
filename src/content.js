// Flow Batch Downloader — content script (executor).
//
// Coordinates between the Side Panel and the MAIN-world bridge (`page-bridge.js`):
// - Renders selection checkboxes on video tiles and mirrors queue status outlines.
// - Scans all videos and triggers downloads/upscales directly via Flow's
//   internal Angular services (`page-bridge.js`) without scrolling the page,
//   hovering tiles, or opening DOM context menus.
// - Falls back to DOM menu automation only if Flow's internal bridge is unavailable.

(() => {
  'use strict';

  if (window.__fbdLoaded) return;
  window.__fbdLoaded = true;

  const PORT_NAME = 'fbd';
  const BRIDGE_REQ_EVENT = 'fbd:bridge-req';
  const BRIDGE_RES_EVENT = 'fbd:bridge-res';
  const BRIDGE_TIMEOUT_MS = 30000;
  const MENU_TIMEOUT_MS = 5000;
  const RENDER_WAIT_MS = 500;
  const FAILURE_SNACKBAR_RE = /fail|error|unable|couldn.?t|could not|try again|went wrong/i;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------------------------------------------------------------------
  // MAIN-world bridge RPC
  // ---------------------------------------------------------------------------

  let bridgeSeq = 0;
  const bridgePending = new Map();

  window.addEventListener(BRIDGE_RES_EVENT, (event) => {
    const detail = event.detail;
    if (!detail || detail.id == null) return;
    const entry = bridgePending.get(detail.id);
    if (!entry) return;
    bridgePending.delete(detail.id);
    clearTimeout(entry.timer);
    if (detail.error) entry.reject(new Error(detail.error));
    else entry.resolve(detail.result);
  });

  function callBridge(type, payload = {}) {
    return new Promise((resolve, reject) => {
      const id = ++bridgeSeq;
      const timer = setTimeout(() => {
        bridgePending.delete(id);
        reject(new Error(`Page bridge timed out (${type})`));
      }, BRIDGE_TIMEOUT_MS);
      bridgePending.set(id, { resolve, reject, timer });
      window.dispatchEvent(
        new CustomEvent(BRIDGE_REQ_EVENT, { detail: { id, type, payload } }),
      );
    });
  }

  // ---------------------------------------------------------------------------
  // Flow DOM helpers
  // ---------------------------------------------------------------------------

  const getScroller = () => document.querySelector('[cdkvirtualscrollingelement]');

  const allTiles = () => [...document.querySelectorAll('flow-grid-tile-container')];

  const tileTitle = (tile) =>
    tile.dataset.fbdTitle || tile.getAttribute('aria-label') || '(untitled)';

  // Failed generations are video tiles too, but have no context menu.
  const isDownloadableVideo = (tile) =>
    !!tile.querySelector('flow-video-tile') && !!tile.querySelector('button[aria-haspopup="menu"]');

  const videoTiles = () => allTiles().filter(isDownloadableVideo);

  // Prefer the stable `data-fbd-media-id` stamped by `page-bridge.js`;
  // fall back to virtual-scroll grid position only if unavailable.
  function tileKey(tile, scroller) {
    if (tile.dataset.fbdMediaId) return tile.dataset.fbdMediaId;
    if (!scroller) return '';
    const r = tile.getBoundingClientRect();
    const s = scroller.getBoundingClientRect();
    return `${Math.round(r.top - s.top + scroller.scrollTop)}:${Math.round(r.left - s.left)}`;
  }

  const isPositionKey = (key) => /^\d+:\d+$/.test(key);
  const parseKey = (key) => key.split(':').map(Number);

  const compareKeys = (a, b) => {
    if (!isPositionKey(a) || !isPositionKey(b)) return 0;
    const [at, al] = parseKey(a);
    const [bt, bl] = parseKey(b);
    return at - bt || al - bl;
  };

  const keysMatch = (a, b) => {
    if (a === b) return true;
    if (!isPositionKey(a) || !isPositionKey(b)) return false;
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
      await sleep(50);
    }
    throw new Error(`Timed out waiting for ${what}`);
  }

  function closeMenus() {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.querySelectorAll('.cdk-overlay-backdrop').forEach((b) => b.click());
  }

  // Primary scan: read all videos in memory via `page-bridge.js` without scrolling.
  // Fallback: scroll through the grid if the bridge fails.
  async function scanAllVideos() {
    try {
      const videos = await callBridge('scan');
      if (Array.isArray(videos) && videos.length > 0) return videos;
    } catch {
      // Fall through to DOM scan if bridge is unavailable.
    }

    const scroller = getScroller();
    if (!scroller) throw new Error('Media grid not found. Open a project in Flow first.');
    const original = scroller.scrollTop;
    const found = new Map();
    scroller.scrollTop = 0;
    await sleep(RENDER_WAIT_MS);
    for (;;) {
      await callBridge('sync-dom').catch(() => {});
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
    if (!isPositionKey(key)) {
      await callBridge('sync-dom').catch(() => {});
      return videoTiles().find((t) => t.dataset.fbdMediaId === key);
    }
    const [top] = parseKey(key);
    scroller.scrollTop = Math.max(0, top - 120);
    await sleep(RENDER_WAIT_MS);
    return videoTiles().find((t) => keysMatch(tileKey(t, scroller), key));
  }

  async function locateTileFallback(item) {
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

  // Primary trigger: invoke Flow's internal service directly via `page-bridge.js`
  // (zero hover, zero menu popup, zero scrolling).
  // Fallback: click through Flow's menu if internal bridge fails.
  async function trigger(item, resolution) {
    try {
      return await callBridge('trigger', {
        key: item.key,
        title: item.title,
        resolution,
      });
    } catch (bridgeErr) {
      // If the bridge reported a plan/availability error, surface it directly
      // rather than falling back to clicking the disabled menu item.
      const msg = String(bridgeErr?.message || bridgeErr);
      if (/isn't available|not available|plan|upgrade|seconds/i.test(msg)) {
        throw bridgeErr;
      }
    }

    const { tile, key } = await locateTileFallback(item);
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
  // In-grid status outlines & Alt/Option+Click selection
  // ---------------------------------------------------------------------------

  async function syncTiles() {
    if (port) {
      await callBridge('sync-dom').catch(() => {});
    }
    const scroller = getScroller();
    for (const tile of allTiles()) {
      // Clean up any legacy checkbox from earlier versions.
      tile.querySelector(':scope > .fbd-check')?.remove();

      if (!port || !scroller || !isDownloadableVideo(tile)) {
        delete tile.dataset.fbdSelected;
        delete tile.dataset.fbdStatus;
        continue;
      }
      const key = tileKey(tile, scroller);
      if (view.selected.has(key)) tile.dataset.fbdSelected = 'true';
      else delete tile.dataset.fbdSelected;

      const status = view.statuses.get(key);
      if (status) tile.dataset.fbdStatus = status;
      else delete tile.dataset.fbdStatus;
    }
  }

  // Support Alt/Option + Click on any video tile to toggle selection without
  // placing a permanent checkbox overlay over narrow 9:16 tiles.
  for (const evtName of ['pointerdown', 'mousedown', 'click']) {
    document.addEventListener(
      evtName,
      (e) => {
        if (!port || view.locked || !e.altKey) return;
        const tile = e.target?.closest?.('flow-grid-tile-container');
        if (!tile || !isDownloadableVideo(tile)) return;
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (evtName !== 'click') return;

        const scroller = getScroller();
        if (!scroller) return;
        const key = tileKey(tile, scroller);
        if (!key) return;
        port.postMessage({
          type: 'toggle',
          key,
          title: tileTitle(tile),
          checked: !view.selected.has(key),
        });
      },
      true,
    );
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
    if (!port) return;
    // Only notify layout-changed if tiles are still using position keys instead of media IDs.
    const anyPosKey = [...view.selected].some(isPositionKey);
    if (anyPosKey) {
      port.postMessage({ type: 'layout-changed' });
    } else {
      scheduleSync();
    }
  });
})();
