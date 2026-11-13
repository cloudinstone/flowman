// Flow Batch Downloader — side panel.
//
// Owns the queue, selection state and download tracking. Talks to the
// content script in the bound Flow tab over a long-lived port:
//   panel -> page : view (selection/status mirror), scan, trigger (RPC)
//   page  -> panel: toggle (checkbox), flow-error (snackbar), layout-changed
// Downloads are observed directly via chrome.downloads; the first download
// created after a trigger is attributed to the current item. Flow asks users
// not to run several upscales at once, so the queue is strictly serial.

const PORT_NAME = 'fbd';
const FLOW_PROJECT_RE = /^https:\/\/flow\.google\.com\/project\//;
const ITEM_TIMEOUT_MS = 15 * 60 * 1000;
const RPC_TIMEOUT_MS = 90 * 1000;
const BETWEEN_ITEMS_MS = 1500;

const RES_OPTIONS = {
  VIDEO: [
    { value: '720p', label: '720p', hint: 'Original size. Downloads right away.' },
    { value: '1080p', label: '1080p', hint: 'Upscaled by Flow. Takes about 1–2 minutes per video.' },
    { value: '4K', label: '4K', hint: 'Upscaled by Flow. Only available on some plans.' },
  ],
  IMAGE: [
    { value: '1K', label: '1K', hint: 'Original size. Downloads right away.' },
    { value: '2K', label: '2K', hint: 'Upscaled by Flow.' },
    { value: '4K', label: '4K', hint: 'Upscaled by Flow. Only available on some plans.' },
  ],
};

const MEDIA_NOUN = {
  VIDEO: { singular: 'video', plural: 'videos' },
  IMAGE: { singular: 'image', plural: 'images' },
};

const ICONS = {
  queued:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>',
  running: '<div class="spinner" aria-hidden="true"></div>',
  done: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>',
  failed:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>',
};

const STATUS_LABEL = { queued: 'Queued', done: 'Downloaded', failed: 'Failed' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = {
  tabId: null,
  tabUrl: '',
  /** @type {chrome.runtime.Port | null} */
  port: null,
  connectError: '',
  mediaType: 'VIDEO',
  resolutionByType: { VIDEO: '1080p', IMAGE: '1K' },
  /** @type {Array<{key: string, title: string, mediaType?: string, thumb?: string, thumbType?: string}>} */
  catalog: [],
  /** @type {{VIDEO: Map<string, string>, IMAGE: Map<string, string>}} */
  selectedByType: { VIDEO: new Map(), IMAGE: new Map() },
  /** @type {{VIDEO: Array, IMAGE: Array}} */
  itemsByType: { VIDEO: [], IMAGE: [] },
  running: false,
  stopRequested: false,
  scanning: false,
  message: '',
};

const activeResolution = () => state.resolutionByType[state.mediaType];
const activeSelected = () => state.selectedByType[state.mediaType];
const activeItems = () => state.itemsByType[state.mediaType];
const activeCatalog = () =>
  state.catalog.filter((item) => (item.mediaType || 'VIDEO') === state.mediaType);

const $ = (id) => document.getElementById(id);
const el = {
  empty: $('empty'),
  emptyText: $('empty-text'),
  main: $('main'),
  mediaType: $('media-type'),
  resolution: $('resolution'),
  resHint: $('res-hint'),
  selectionCount: $('selection-count'),
  refresh: $('refresh'),
  selectAll: $('select-all'),
  clear: $('clear'),
  start: $('start'),
  startLabel: $('start-label'),
  stop: $('stop'),
  retry: $('retry'),
  progress: $('progress'),
  progressBar: $('progress-bar'),
  progressIndicator: $('progress-indicator'),
  progressText: $('progress-text'),
  message: $('message'),
  list: $('list'),
};

// -----------------------------------------------------------------------------
// Port + RPC
// -----------------------------------------------------------------------------

let rpcSeq = 0;
/** @type {Map<number, {resolve: Function, reject: Function, timer: number}>} */
const rpcPending = new Map();

function rejectAllRpc(reason) {
  for (const { reject, timer } of rpcPending.values()) {
    clearTimeout(timer);
    reject(new Error(reason));
  }
  rpcPending.clear();
}

function rpc(type, payload = {}) {
  return new Promise((resolve, reject) => {
    if (!state.port) {
      reject(new Error('Not connected to the Flow tab'));
      return;
    }
    const id = ++rpcSeq;
    const timer = setTimeout(() => {
      rpcPending.delete(id);
      reject(new Error(`The Flow tab didn't respond (${type})`));
    }, RPC_TIMEOUT_MS);
    rpcPending.set(id, { resolve, reject, timer });
    state.port.postMessage({ id, type, ...payload });
  });
}

function disconnect() {
  if (state.port) {
    const p = state.port;
    state.port = null;
    p.disconnect();
  }
  rejectAllRpc('Disconnected from the Flow tab');
}

function connect(tabId, url) {
  const sameProject = state.tabId === tabId && state.tabUrl === url;
  if (sameProject && state.port) return;
  disconnect();
  if (!sameProject) {
    // Selection keys are project-scoped media IDs (or fallback grid positions).
    state.catalog = [];
    state.selectedByType = { VIDEO: new Map(), IMAGE: new Map() };
    state.itemsByType = { VIDEO: [], IMAGE: [] };
    state.message = '';
  }
  state.tabId = tabId;
  state.tabUrl = url;
  state.connectError = '';

  const port = chrome.tabs.connect(tabId, { name: PORT_NAME });
  state.port = port;
  port.onMessage.addListener(onPortMessage);
  port.onDisconnect.addListener(() => {
    // Reading lastError marks it as handled.
    const err = chrome.runtime.lastError;
    if (state.port !== port) return;
    state.port = null;
    rejectAllRpc('The Flow tab was reloaded or closed');
    if (err) state.connectError = 'Reload the Flow tab to connect.';
    render();
  });
  pushView();
  render();
  refreshCatalog({ silent: true });
}

function onPortMessage(msg) {
  if (msg.id != null) {
    const entry = rpcPending.get(msg.id);
    if (!entry) return;
    rpcPending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error) entry.reject(new Error(msg.error));
    else entry.resolve(msg.result);
    return;
  }
  switch (msg.type) {
    case 'toggle': {
      if (state.running) break;
      const type = msg.mediaType === 'IMAGE' ? 'IMAGE' : 'VIDEO';
      const sel = state.selectedByType[type];
      if (msg.checked) sel.set(msg.key, msg.title);
      else sel.delete(msg.key);
      if (type !== state.mediaType) state.mediaType = type;
      render();
      break;
    }
    case 'flow-error':
      pendingDownload?.reject(new Error(`Flow: ${msg.text}`));
      break;
    case 'layout-changed':
      if (!state.running && (state.selectedByType.VIDEO.size || state.selectedByType.IMAGE.size)) {
        state.selectedByType.VIDEO.clear();
        state.selectedByType.IMAGE.clear();
        setMessage('The Flow layout changed, so the selection was cleared. Select again.');
      }
      break;
  }
}

function pushView() {
  if (!state.port) return;
  const statuses = {};
  for (const i of [...state.itemsByType.VIDEO, ...state.itemsByType.IMAGE]) {
    statuses[i.key] = i.status;
  }
  const selected = [
    ...state.selectedByType.VIDEO.keys(),
    ...state.selectedByType.IMAGE.keys(),
  ];
  state.port.postMessage({
    type: 'view',
    selected,
    statuses,
    locked: state.running || state.scanning,
  });
}

// Bind to the active tab of this window (not while a run is in progress).
async function bindToActiveTab() {
  if (state.running) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url && FLOW_PROJECT_RE.test(tab.url)) {
    connect(tab.id, tab.url);
  } else {
    disconnect();
    state.tabId = null;
    state.tabUrl = '';
    render();
  }
}

chrome.tabs.onActivated.addListener(bindToActiveTab);
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'complete' || info.url) bindToActiveTab();
});

// -----------------------------------------------------------------------------
// Download tracking
// -----------------------------------------------------------------------------

/** @type {null | {id: number|null, filename: string, resolve: Function, reject: Function}} */
let pendingDownload = null;

function waitForDownload(timeoutMs) {
  const promise = new Promise((resolve, reject) => {
    const finish = (fn, value) => {
      clearTimeout(timer);
      pendingDownload = null;
      fn(value);
    };
    const timer = setTimeout(
      () => finish(reject, new Error('No download started within 15 minutes')),
      timeoutMs,
    );
    pendingDownload = {
      id: null,
      filename: '',
      resolve: (v) => finish(resolve, v),
      reject: (e) => finish(reject, e),
    };
  });
  promise.catch(() => {}); // Avoid unhandled-rejection noise; callers still await it.
  return promise;
}

chrome.downloads.onCreated.addListener((item) => {
  if (!pendingDownload || pendingDownload.id !== null) return;
  pendingDownload.id = item.id;
  pendingDownload.filename = item.filename || '';
  setCurrentDetail('Saving file');
});

chrome.downloads.onChanged.addListener((delta) => {
  if (!pendingDownload || delta.id !== pendingDownload.id) return;
  if (delta.filename?.current) pendingDownload.filename = delta.filename.current;
  if (delta.state?.current === 'complete') pendingDownload.resolve(pendingDownload.filename);
  else if (delta.state?.current === 'interrupted') {
    pendingDownload.reject(new Error(`Download interrupted (${delta.error?.current || 'unknown reason'})`));
  }
});

// -----------------------------------------------------------------------------
// Queue
// -----------------------------------------------------------------------------

async function downloadOne(item) {
  const res = activeResolution();
  const done = waitForDownload(ITEM_TIMEOUT_MS);
  try {
    const { key } = await rpc('trigger', {
      item: {
        key: item.key,
        title: item.title,
        mediaType: item.mediaType || state.mediaType,
      },
      resolution: res,
    });
    item.key = key;
  } catch (err) {
    pendingDownload?.reject(err);
    throw err;
  }
  setCurrentDetail(res === '720p' || res === '1K' ? 'Starting download' : 'Upscaling');
  const filename = await done;
  return filename.split(/[\\/]/).pop();
}

async function runQueue() {
  if (state.running) return;
  const queue = activeItems().filter((i) => i.status === 'queued');
  if (!queue.length) return;
  state.running = true;
  state.stopRequested = false;
  setMessage('');
  const ticker = setInterval(renderList, 1000);
  try {
    for (const item of queue) {
      if (state.stopRequested) break;
      item.status = 'running';
      item.detail = 'Preparing download';
      item.startedAt = Date.now();
      render();
      try {
        const name = await downloadOne(item);
        item.status = 'done';
        item.detail = name || 'Downloaded';
      } catch (err) {
        if (state.stopRequested) {
          item.status = 'queued';
          item.detail = '';
        } else {
          item.status = 'failed';
          item.detail = String(err?.message || err);
        }
      }
      render();
      if (!state.stopRequested) await sleep(BETWEEN_ITEMS_MS);
    }
  } finally {
    clearInterval(ticker);
    state.running = false;
    const done = count('done');
    const failed = count('failed');
    if (state.stopRequested) {
      setMessage('Stopped. Flow may still finish the upscale that was in progress and download it.');
    } else {
      setMessage(failed ? `Finished. ${done} downloaded, ${failed} failed.` : `Finished. ${done} downloaded.`);
    }
    // The tab may have changed while we were running.
    bindToActiveTab();
  }
}

function buildQueueFromSelection() {
  const catalog = activeCatalog();
  const selected = activeSelected();
  const catalogByKey = new Map(catalog.map((v) => [v.key, v]));
  const catalogOrder = new Map(catalog.map((v, idx) => [v.key, idx]));
  const keys = [...selected.keys()];
  if (keys.every((k) => /^\d+:\d+$/.test(k))) {
    keys.sort(compareKeys);
  } else {
    keys.sort((a, b) => (catalogOrder.get(a) ?? 1e9) - (catalogOrder.get(b) ?? 1e9));
  }
  const previous = new Map(activeItems().map((i) => [i.key, i]));
  state.itemsByType[state.mediaType] = keys.map((key) => {
    const prev = previous.get(key);
    const meta = catalogByKey.get(key);
    if (prev?.status === 'done') return prev;
    return {
      key,
      title: selected.get(key) || meta?.title || '(untitled)',
      mediaType: meta?.mediaType || state.mediaType,
      thumb: meta?.thumb || prev?.thumb || '',
      thumbType: meta?.thumbType || prev?.thumbType || '',
      status: 'queued',
      detail: '',
    };
  });
}

function compareKeys(a, b) {
  const [at, al] = a.split(':').map(Number);
  const [bt, bl] = b.split(':').map(Number);
  return at - bt || al - bl;
}

const count = (status) => activeItems().filter((i) => i.status === status).length;

function setCurrentDetail(detail) {
  const cur = activeItems().find((i) => i.status === 'running');
  if (!cur) return;
  cur.detail = detail;
  renderList();
}

function setMessage(text) {
  state.message = text;
  render();
}

// -----------------------------------------------------------------------------
// Events
// -----------------------------------------------------------------------------

el.mediaType.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-value]');
  if (!btn || state.running) return;
  state.mediaType = btn.dataset.value;
  state.message = '';
  render();
});

el.resolution.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-value]');
  if (!btn || state.running) return;
  state.resolutionByType[state.mediaType] = btn.dataset.value;
  render();
});

async function refreshCatalog({ silent = false } = {}) {
  if (state.running || state.scanning || !state.port) return false;
  state.scanning = true;
  if (!silent) setMessage(`Scanning the project for ${MEDIA_NOUN[state.mediaType].plural}…`);
  else render();
  try {
    const items = await rpc('scan');
    state.catalog = Array.isArray(items) ? items : [];
    const catalogMap = new Map(state.catalog.map((v) => [v.key, v]));
    for (const sel of Object.values(state.selectedByType)) {
      for (const [k] of sel) {
        const match = catalogMap.get(k);
        if (match) sel.set(k, match.title);
      }
    }
    if (!silent) {
      const countInType = activeCatalog().length;
      setMessage(countInType ? '' : `No downloadable ${MEDIA_NOUN[state.mediaType].plural} found in this view.`);
    }
    return true;
  } catch (err) {
    if (!silent) setMessage(String(err?.message || err));
    return false;
  } finally {
    state.scanning = false;
    render();
  }
}

el.refresh.addEventListener('click', () => {
  refreshCatalog({ silent: false });
});

el.selectAll.addEventListener('click', async () => {
  if (state.running || state.scanning) return;
  const ok = await refreshCatalog({ silent: false });
  if (!ok) return;
  state.selectedByType[state.mediaType] = new Map(
    activeCatalog().map((v) => [v.key, v.title]),
  );
  render();
});

el.clear.addEventListener('click', () => {
  if (state.running) return;
  activeSelected().clear();
  state.itemsByType[state.mediaType] = [];
  setMessage('');
});

el.start.addEventListener('click', () => {
  buildQueueFromSelection();
  runQueue();
});

el.stop.addEventListener('click', () => {
  state.stopRequested = true;
  pendingDownload?.reject(new Error('Stopped'));
  setMessage('Stopping…');
});

el.retry.addEventListener('click', () => {
  for (const i of activeItems()) {
    if (i.status === 'failed') {
      i.status = 'queued';
      i.detail = '';
    }
  }
  runQueue();
});

// -----------------------------------------------------------------------------
// Render
// -----------------------------------------------------------------------------

function formatElapsed(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function toggleSelection(key, title) {
  if (state.running) return;
  const selected = activeSelected();
  if (selected.has(key)) selected.delete(key);
  else selected.set(key, title);
  render();
}

const thumbObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const target = entry.target;
      const lazySrc = target.dataset.src;
      if (lazySrc && !target.src) {
        target.src = lazySrc;
      }
      thumbObserver.unobserve(target);
    }
  },
  { rootMargin: '120px' },
);

function createThumbEl(src, thumbType) {
  if (!src) return null;
  if (thumbType === 'video' || src.includes('=mm')) {
    const video = document.createElement('video');
    video.className = 'thumb';
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.dataset.src = `${src}#t=0.1`;
    thumbObserver.observe(video);
    return video;
  }
  const img = document.createElement('img');
  img.className = 'thumb';
  img.src = src;
  img.alt = '';
  img.loading = 'lazy';
  return img;
}

function renderList() {
  const items = activeItems();
  const selected = activeSelected();
  const catalog = activeCatalog();

  if (state.running) {
    el.list.replaceChildren(
      ...items.map((item) => {
        const li = document.createElement('li');
        li.className = `list-item ${item.status}`;

        const leading = document.createElement('div');
        leading.className = 'leading';
        leading.innerHTML = ICONS[item.status] || '';

        const thumb = createThumbEl(item.thumb, item.thumbType);

        const content = document.createElement('div');
        content.className = 'content';
        const headline = document.createElement('div');
        headline.className = 'headline';
        headline.textContent = item.title;
        headline.title = item.title;
        const supporting = document.createElement('div');
        supporting.className = 'supporting-text';
        supporting.textContent = item.detail || STATUS_LABEL[item.status] || '';
        content.append(headline, supporting);

        li.append(leading);
        if (thumb) li.append(thumb);
        li.append(content);

        if (item.status === 'running' && item.startedAt) {
          const trailing = document.createElement('div');
          trailing.className = 'trailing';
          trailing.textContent = formatElapsed(Date.now() - item.startedAt);
          li.append(trailing);
        }
        return li;
      }),
    );
    return;
  }

  const itemByKey = new Map(items.map((i) => [i.key, i]));
  const rows = catalog.length
    ? catalog
    : [...selected.entries()].map(([key, title]) => ({ key, title, thumb: '' }));

  el.list.replaceChildren(
    ...rows.map((entry) => {
      const prev = itemByKey.get(entry.key);
      const status = prev?.status || '';
      const li = document.createElement('li');
      li.className = `list-item selectable${status ? ` ${status}` : ''}`;

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'item-check';
      cb.checked = selected.has(entry.key);
      cb.ariaLabel = `Select ${entry.title}`;
      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', () => toggleSelection(entry.key, entry.title));

      li.addEventListener('click', () => toggleSelection(entry.key, entry.title));

      const thumb = createThumbEl(entry.thumb || prev?.thumb, entry.thumbType || prev?.thumbType);

      const content = document.createElement('div');
      content.className = 'content';
      const headline = document.createElement('div');
      headline.className = 'headline';
      headline.textContent = entry.title;
      headline.title = entry.title;
      content.append(headline);

      if (prev && (prev.detail || STATUS_LABEL[prev.status])) {
        const supporting = document.createElement('div');
        supporting.className = 'supporting-text';
        supporting.textContent = prev.detail || STATUS_LABEL[prev.status] || '';
        content.append(supporting);
      }

      li.append(cb);
      if (thumb) li.append(thumb);
      li.append(content);

      if (status === 'done' || status === 'failed') {
        const badge = document.createElement('div');
        badge.className = 'leading';
        badge.innerHTML = ICONS[status] || '';
        li.append(badge);
      }

      return li;
    }),
  );
}

function render() {
  const onFlow = state.tabId !== null;
  const usable = onFlow && !!state.port;
  el.empty.hidden = usable || (state.running && onFlow);
  el.main.hidden = !el.empty.hidden;
  el.emptyText.textContent = !onFlow
    ? 'Open a project in Google Flow to start.'
    : state.connectError || 'Connecting to the Flow tab…';

  const busy = state.running || state.scanning;
  const noun = MEDIA_NOUN[state.mediaType];
  const resOpts = RES_OPTIONS[state.mediaType];
  const currentRes = activeResolution();

  for (const btn of el.mediaType.querySelectorAll('button')) {
    btn.setAttribute('aria-checked', String(btn.dataset.value === state.mediaType));
    btn.disabled = state.running;
  }

  const resButtons = [...el.resolution.querySelectorAll('button')];
  resOpts.forEach((opt, idx) => {
    const btn = resButtons[idx];
    if (!btn) return;
    btn.dataset.value = opt.value;
    btn.setAttribute('aria-checked', String(opt.value === currentRes));
    btn.disabled = state.running;
    const labelEl = btn.querySelector('.res-label');
    if (labelEl) labelEl.textContent = opt.label;
    else btn.append(opt.label);
  });
  el.resHint.textContent = resOpts.find((o) => o.value === currentRes)?.hint || '';

  const selected = activeSelected();
  const items = activeItems();
  const n = selected.size;
  const catalogTotal = activeCatalog().length;
  el.selectionCount.textContent =
    n === 0
      ? catalogTotal
        ? `0 of ${catalogTotal} selected`
        : `No ${noun.plural} selected`
      : catalogTotal
        ? `${n} of ${catalogTotal} selected`
        : n === 1
          ? `1 ${noun.singular} selected`
          : `${n} ${noun.plural} selected`;
  el.refresh.disabled = busy;
  el.selectAll.disabled = busy;
  el.selectAll.textContent = state.scanning ? 'Scanning…' : 'Select all';
  el.clear.disabled = busy || (!n && !items.length);

  el.start.hidden = state.running;
  el.start.disabled = busy || !n;
  el.startLabel.textContent = n > 1 ? `Download ${n} ${noun.plural}` : 'Start download';
  el.stop.hidden = !state.running;
  el.stop.disabled = state.stopRequested;
  el.retry.hidden = state.running || !count('failed');

  const total = items.length;
  const finished = count('done') + count('failed');
  el.progress.hidden = !state.running;
  el.progressIndicator.style.width = total ? `${(finished / total) * 100}%` : '0';
  el.progressBar.setAttribute('aria-valuenow', String(finished));
  el.progressBar.setAttribute('aria-valuemax', String(total));
  el.progressText.textContent = `${finished} of ${total} finished`;

  el.message.textContent = state.message;
  renderList();
  pushView();
}

bindToActiveTab();
render();
