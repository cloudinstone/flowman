// Flow Batch Downloader — content script.
//
// Drives Flow's own UI (tile "More options" menu -> Download -> resolution)
// one video at a time. Flow itself performs the upscale and starts the
// browser download; we treat "download completed" as the signal to move on.
// Flow explicitly asks users not to run multiple upscale jobs at once, so the
// queue is strictly serial.

(() => {
  'use strict';

  if (window.__fbdLoaded) return;
  window.__fbdLoaded = true;

  const RESOLUTIONS = ['720p', '1080p', '4K'];
  const ITEM_TIMEOUT_MS = 15 * 60 * 1000;
  const MENU_TIMEOUT_MS = 5000;
  const RENDER_WAIT_MS = 500;
  const BETWEEN_ITEMS_MS = 1500;
  const FAILURE_SNACKBAR_RE = /fail|error|unable|couldn.?t|could not|try again|went wrong/i;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const state = {
    panelOpen: false,
    running: false,
    stopRequested: false,
    resolution: '1080p',
    /** @type {Map<string, string>} position key -> title */
    selected: new Map(),
    /** @type {Array<{key: string, title: string, status: string, detail: string}>} */
    items: [],
    message: '',
  };

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

  // Virtual scrolling recycles tile elements, and Flow exposes no media id in
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
    if (!scroller) throw new Error('Media grid not found. Open a Flow project first.');
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

  // Bring the tile for `item` into the DOM and return it. Falls back to a
  // unique title match if the layout shifted (resize, new generations, ...).
  async function locateTile(item) {
    const scroller = getScroller();
    if (!scroller) throw new Error('Media grid not found');
    const [top] = parseKey(item.key);
    scroller.scrollTop = Math.max(0, top - 120);
    await sleep(RENDER_WAIT_MS);
    const atPos = videoTiles().find((t) => keysMatch(tileKey(t, scroller), item.key));
    if (atPos && tileTitle(atPos) === item.title) return atPos;

    const matches = (await scanAllVideos()).filter((v) => v.title === item.title);
    if (matches.length !== 1) {
      throw new Error('Grid layout changed and the video could not be identified');
    }
    item.key = matches[0].key;
    const [newTop] = parseKey(item.key);
    scroller.scrollTop = Math.max(0, newTop - 120);
    await sleep(RENDER_WAIT_MS);
    const tile = videoTiles().find((t) => keysMatch(tileKey(t, scroller), item.key));
    if (!tile) throw new Error('Video tile not found');
    return tile;
  }

  // ---------------------------------------------------------------------------
  // Download tracking (events relayed by the service worker)
  // ---------------------------------------------------------------------------

  /** @type {null | {id: number|null, filename: string, resolve: Function, reject: Function}} */
  let pending = null;

  function waitForDownload(timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(reject, new Error('Timed out waiting for download')), timeoutMs);
      const finish = (fn, value) => {
        clearTimeout(timer);
        pending = null;
        fn(value);
      };
      pending = {
        id: null,
        filename: '',
        resolve: (v) => finish(resolve, v),
        reject: (e) => finish(reject, e),
      };
    });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    switch (msg?.type) {
      case 'toggle-panel':
        togglePanel();
        break;
      case 'download-created':
        if (pending && pending.id === null) {
          pending.id = msg.id;
          pending.filename = msg.filename || '';
          setCurrentDetail('downloading…');
        }
        break;
      case 'download-changed':
        if (!pending || msg.id !== pending.id) break;
        if (msg.filename) pending.filename = msg.filename;
        if (msg.state === 'complete') pending.resolve(pending.filename);
        else if (msg.state === 'interrupted') pending.reject(new Error(`Download interrupted (${msg.error || 'unknown'})`));
        break;
    }
  });

  // Reject the pending item if Flow shows an error snackbar.
  new MutationObserver((mutations) => {
    if (!pending) return;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        const bar = node.matches?.('flow-snackbar') ? node : node.querySelector?.('flow-snackbar');
        const text = bar?.textContent?.replace(/\s+/g, ' ').trim();
        if (text && FAILURE_SNACKBAR_RE.test(text)) {
          pending.reject(new Error(`Flow: ${text.replace(/\bDismiss\b/g, '').trim()}`));
          return;
        }
      }
    }
  }).observe(document.body, { childList: true, subtree: true });

  // ---------------------------------------------------------------------------
  // Queue
  // ---------------------------------------------------------------------------

  async function downloadOne(item) {
    const tile = await locateTile(item);
    tile.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    tile.querySelector('button[aria-haspopup="menu"]').click();

    const downloadEntry = await waitFor(
      () => menuItems().find((el) => menuItemIcon(el) === 'download'),
      MENU_TIMEOUT_MS,
      'Download menu item',
    );
    downloadEntry.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    downloadEntry.click();

    const resEntry = await waitFor(
      () => menuItems().find((el) => menuItemLabel(el) === state.resolution),
      MENU_TIMEOUT_MS,
      `${state.resolution} option`,
    );
    if (resEntry.disabled || resEntry.getAttribute('aria-disabled') === 'true') {
      closeMenus();
      throw new Error(`${state.resolution} is not available for this video`);
    }

    const done = waitForDownload(ITEM_TIMEOUT_MS);
    resEntry.click();
    setCurrentDetail(state.resolution === '720p' ? 'starting download…' : 'upscaling…');
    const filename = await done;
    return filename.split(/[\\/]/).pop();
  }

  async function runQueue() {
    if (state.running) return;
    const queue = state.items.filter((i) => i.status === 'queued');
    if (!queue.length) {
      setMessage('Nothing to download. Select videos first.');
      return;
    }
    state.running = true;
    state.stopRequested = false;
    render();
    try {
      for (const item of queue) {
        if (state.stopRequested) break;
        item.status = 'running';
        item.detail = 'opening menu…';
        render();
        try {
          const name = await downloadOne(item);
          item.status = 'done';
          item.detail = name || 'downloaded';
        } catch (err) {
          closeMenus();
          item.status = state.stopRequested ? 'queued' : 'failed';
          item.detail = state.stopRequested ? '' : String(err.message || err);
        }
        render();
        if (!state.stopRequested) await sleep(BETWEEN_ITEMS_MS);
      }
    } finally {
      state.running = false;
      const done = state.items.filter((i) => i.status === 'done').length;
      const failed = state.items.filter((i) => i.status === 'failed').length;
      setMessage(state.stopRequested ? 'Stopped.' : `Finished: ${done} done, ${failed} failed.`);
    }
  }

  function buildQueueFromSelection() {
    const keys = [...state.selected.keys()].sort(compareKeys);
    const previous = new Map(state.items.map((i) => [i.key, i]));
    state.items = keys.map((key) => {
      const prev = previous.get(key);
      if (prev && prev.status === 'done') return prev;
      return { key, title: state.selected.get(key), status: 'queued', detail: '' };
    });
  }

  function setCurrentDetail(detail) {
    const cur = state.items.find((i) => i.status === 'running');
    if (cur) {
      cur.detail = detail;
      render();
    }
  }

  function setMessage(text) {
    state.message = text;
    render();
  }

  // ---------------------------------------------------------------------------
  // In-grid checkboxes
  // ---------------------------------------------------------------------------

  function syncTiles() {
    const scroller = getScroller();
    const statusByKey = new Map(state.items.map((i) => [i.key, i.status]));
    for (const tile of allTiles()) {
      let cb = tile.querySelector(':scope > .fbd-check');
      if (!state.panelOpen || !scroller || !isDownloadableVideo(tile)) {
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
          if (!s) return;
          const key = tileKey(tile, s);
          if (cb.checked) state.selected.set(key, tileTitle(tile));
          else state.selected.delete(key);
          render();
        });
        tile.appendChild(cb);
      }
      const key = tileKey(tile, scroller);
      cb.checked = state.selected.has(key);
      cb.disabled = state.running;
      const status = statusByKey.get(key);
      if (status) tile.dataset.fbdStatus = status;
      else delete tile.dataset.fbdStatus;
    }
  }

  let syncScheduled = false;
  function scheduleSync() {
    if (syncScheduled || !state.panelOpen) return;
    syncScheduled = true;
    requestAnimationFrame(() => {
      syncScheduled = false;
      syncTiles();
    });
  }

  new MutationObserver(scheduleSync).observe(document.body, { childList: true, subtree: true });
  document.addEventListener('scroll', scheduleSync, true);
  window.addEventListener('resize', () => {
    if (state.running || !state.selected.size) return;
    // Positions are layout-dependent; a resize invalidates the selection.
    state.selected.clear();
    setMessage('Window resized — selection cleared.');
  });

  // ---------------------------------------------------------------------------
  // Panel (shadow DOM, isolated from Flow's styles)
  // ---------------------------------------------------------------------------

  let host = null;
  let ui = null;

  const PANEL_CSS = `
    :host { all: initial; }
    .panel {
      position: fixed; left: 16px; bottom: 16px; z-index: 2147483647;
      width: 340px; max-height: 70vh; display: flex; flex-direction: column;
      background: #1f1f1f; color: #e3e3e3; border: 1px solid #444; border-radius: 12px;
      font: 13px/1.4 system-ui, -apple-system, sans-serif; box-shadow: 0 8px 24px rgba(0,0,0,.5);
    }
    header { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid #333; font-weight: 600; }
    .body { padding: 10px 12px; display: grid; gap: 8px; }
    .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    button, select {
      font: inherit; color: inherit; background: #2d2d2d; border: 1px solid #555;
      border-radius: 6px; padding: 4px 10px; cursor: pointer;
    }
    button:hover:not(:disabled) { background: #3a3a3a; }
    button:disabled, select:disabled { opacity: .45; cursor: default; }
    button.primary { background: #8ab4f8; color: #111; border-color: #8ab4f8; }
    button.icon { border: none; background: none; font-size: 16px; padding: 0 4px; }
    .msg { color: #aaa; min-height: 1.4em; }
    ol { margin: 0; padding: 0 12px 10px 32px; overflow: auto; }
    li { margin: 3px 0; word-break: break-word; }
    li .d { color: #999; font-size: 12px; }
    li.done { color: #81c995; } li.failed { color: #f28b82; } li.running { color: #fdd663; }
  `;

  function createPanel() {
    host = document.createElement('div');
    host.id = 'fbd-host';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${PANEL_CSS}</style>
      <div class="panel">
        <header><span>Flow Batch Downloader</span><button class="icon" data-act="close" title="Close">✕</button></header>
        <div class="body">
          <div class="row">
            <label>Resolution
              <select data-ref="res">${RESOLUTIONS.map((r) => `<option value="${r}">${r}</option>`).join('')}</select>
            </label>
            <span data-ref="count"></span>
          </div>
          <div class="row">
            <button data-act="all">Select all videos</button>
            <button data-act="clear">Clear</button>
          </div>
          <div class="row">
            <button class="primary" data-act="start">Start</button>
            <button data-act="stop">Stop</button>
            <button data-act="retry">Retry failed</button>
          </div>
          <div class="msg" data-ref="msg"></div>
        </div>
        <ol data-ref="list"></ol>
      </div>`;
    ui = {
      res: root.querySelector('[data-ref="res"]'),
      count: root.querySelector('[data-ref="count"]'),
      msg: root.querySelector('[data-ref="msg"]'),
      list: root.querySelector('[data-ref="list"]'),
      btn: Object.fromEntries([...root.querySelectorAll('[data-act]')].map((b) => [b.dataset.act, b])),
    };
    ui.res.value = state.resolution;
    ui.res.addEventListener('change', () => {
      state.resolution = ui.res.value;
    });
    ui.btn.close.addEventListener('click', togglePanel);
    ui.btn.all.addEventListener('click', onSelectAll);
    ui.btn.clear.addEventListener('click', () => {
      state.selected.clear();
      if (!state.running) state.items = [];
      setMessage('');
    });
    ui.btn.start.addEventListener('click', () => {
      buildQueueFromSelection();
      runQueue();
    });
    ui.btn.stop.addEventListener('click', () => {
      state.stopRequested = true;
      // Flow keeps processing the in-flight upscale and will still download it.
      pending?.reject(new Error('stopped'));
      setMessage('Stopping…');
    });
    ui.btn.retry.addEventListener('click', () => {
      for (const i of state.items) {
        if (i.status === 'failed') {
          i.status = 'queued';
          i.detail = '';
        }
      }
      runQueue();
    });
    document.documentElement.appendChild(host);
  }

  async function onSelectAll() {
    if (state.running) return;
    setMessage('Scanning project…');
    try {
      const videos = await scanAllVideos();
      state.selected = new Map(videos.map((v) => [v.key, v.title]));
      setMessage(`Selected ${videos.length} videos.`);
    } catch (err) {
      setMessage(String(err.message || err));
    }
  }

  function render() {
    scheduleSync();
    if (!ui) return;
    const r = state.running;
    ui.res.disabled = r;
    ui.btn.all.disabled = r;
    ui.btn.clear.disabled = r;
    ui.btn.start.disabled = r || !state.selected.size;
    ui.btn.stop.disabled = !r;
    ui.btn.retry.disabled = r || !state.items.some((i) => i.status === 'failed');
    ui.count.textContent = `${state.selected.size} selected`;
    ui.msg.textContent = state.message;
    ui.list.replaceChildren(
      ...state.items.map((i) => {
        const li = document.createElement('li');
        li.className = i.status;
        const icon = { queued: '⏳', running: '▶', done: '✓', failed: '✗' }[i.status] || '';
        li.textContent = `${icon} ${i.title}`;
        if (i.detail) {
          const d = document.createElement('div');
          d.className = 'd';
          d.textContent = i.detail;
          li.appendChild(d);
        }
        return li;
      }),
    );
  }

  function togglePanel() {
    state.panelOpen = !state.panelOpen;
    if (state.panelOpen && !host) createPanel();
    if (host) host.style.display = state.panelOpen ? '' : 'none';
    document.body.classList.toggle('fbd-active', state.panelOpen);
    render();
    syncTiles();
  }
})();
