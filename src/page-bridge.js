// Flow Batch Downloader — MAIN-world bridge.
//
// Runs inside the Flow page's JS context so it can read Angular's LView tree
// and invoke Flow's internal download/upscale service (`_.IP.prototype.Eu`)
// directly—without scrolling the viewport, hovering tiles, or opening DOM
// context menus.

(() => {
  'use strict';

  if (window.__fbdBridgeLoaded) return;
  window.__fbdBridgeLoaded = true;

  const REQ_EVENT = 'fbd:bridge-req';
  const RES_EVENT = 'fbd:bridge-res';

  const getNs = () => window.default_AiSandboxAngularFrontend;

  // Capture the LView associated with a `flow-grid-tile-container` element by
  // intercepting Angular's context-restore helper (`_.u`) during a synthetic,
  // side-effect-free `drop` event that we abort immediately via a sentinel.
  function captureTileLView(tileEl) {
    const _ = getNs();
    if (!_ || typeof _.u !== 'function' || !tileEl) return null;
    const origU = _.u;
    let captured = null;
    const sentinel = { __fbdStop: true };
    _.u = function (lView) {
      captured = lView;
      throw sentinel;
    };
    try {
      tileEl.dispatchEvent(new DragEvent('drop', { bubbles: false, cancelable: true }));
    } catch (err) {
      if (err !== sentinel) {
        // Ignore unexpected errors and restore `_.u`.
      }
    } finally {
      _.u = origU;
    }
    return captured;
  }

  // Extract the tile model (`Oa`) and parent `flow-project-page` component
  // instance from a captured tile LView.
  function resolveFromTileElement(tileEl) {
    const lView = captureTileLView(tileEl);
    if (!lView) return null;

    let tileData = null;
    let pageComp = null;
    let cur = lView;
    for (let depth = 0; depth < 12 && cur; depth++) {
      const ctx = cur[8];
      if (ctx && typeof ctx === 'object') {
        if (!tileData && ctx.Oa && typeof ctx.Oa === 'object') {
          tileData = ctx.Oa;
        }
        if (
          !pageComp &&
          typeof ctx.OA === 'function' &&
          ctx.Ya &&
          typeof ctx.Ya.Eu === 'function'
        ) {
          pageComp = ctx;
        }
      }
      cur = cur[14];
    }
    return { tileData, pageComp };
  }

  function getPageComponent() {
    const tiles = document.querySelectorAll('flow-grid-tile-container');
    for (const tileEl of tiles) {
      const res = resolveFromTileElement(tileEl);
      if (res?.pageComp) return res.pageComp;
    }
    return null;
  }

  function isDownloadableVideoData(tile) {
    return (
      tile &&
      tile.type === 'VIDEO' &&
      !tile.wb &&
      typeof tile.primaryMediaId === 'string' &&
      tile.primaryMediaId.length > 0 &&
      tile.Db?.Tc === 'success'
    );
  }

  function getTileTitle(tile) {
    return (tile?.displayName || tile?.Db?.prompt || '').trim() || '(untitled)';
  }

  function getTileThumb(tile) {
    const raw = tile?.Db?.Yb;
    if (typeof raw !== 'string' || !raw) return { thumb: '', thumbType: '' };
    const normalized = raw.replace(
      'https://lh3.googleusercontent.com/asb/',
      'https://flow.google.com/asb/',
    );
    if (tile.type === 'VIDEO') {
      const url = normalized.includes('=') ? normalized : `${normalized}=mm,22,15`;
      return { thumb: url, thumbType: 'video' };
    }
    const url = normalized.includes('=') ? normalized : `${normalized}=s160-rw`;
    return { thumb: url, thumbType: 'image' };
  }

  // Stamp `data-fbd-media-id` and `data-fbd-title` onto rendered DOM tiles so
  // the isolated-world content script can identify them without depending on
  // scroll coordinates.
  function syncDomTileAttributes() {
    const tiles = document.querySelectorAll('flow-grid-tile-container');
    let stamped = 0;
    for (const tileEl of tiles) {
      if (!tileEl.querySelector('flow-video-tile')) {
        delete tileEl.dataset.fbdMediaId;
        delete tileEl.dataset.fbdTitle;
        continue;
      }
      const res = resolveFromTileElement(tileEl);
      const data = res?.tileData;
      if (data && isDownloadableVideoData(data)) {
        tileEl.dataset.fbdMediaId = data.primaryMediaId;
        tileEl.dataset.fbdTitle = getTileTitle(data);
        stamped++;
      } else {
        delete tileEl.dataset.fbdMediaId;
        delete tileEl.dataset.fbdTitle;
      }
    }
    return { stamped };
  }

  // Return all downloadable videos in the current project view directly from
  // Angular's in-memory state (`pageComp.OA()`), in grid order, without
  // scrolling the page.
  function scanVideos() {
    syncDomTileAttributes();
    const pageComp = getPageComponent();
    if (!pageComp) {
      throw new Error('Media grid not ready. Make sure a project is open in Flow.');
    }
    const allItems = pageComp.OA?.() || [];
    const videos = [];
    const seen = new Set();
    for (const item of allItems) {
      if (!isDownloadableVideoData(item)) continue;
      const key = item.primaryMediaId;
      if (seen.has(key)) continue;
      seen.add(key);
      const { thumb, thumbType } = getTileThumb(item);
      videos.push({
        key,
        title: getTileTitle(item),
        thumb,
        thumbType,
      });
    }
    return videos;
  }

  function findVideoData(pageComp, mediaId, title) {
    const allItems = [
      ...(pageComp.OA?.() || []),
      ...(pageComp.ua?.() || []),
    ];
    let match = allItems.find((t) => isDownloadableVideoData(t) && t.primaryMediaId === mediaId);
    if (!match && title) {
      const byTitle = allItems.filter(
        (t) => isDownloadableVideoData(t) && getTileTitle(t) === title,
      );
      if (byTitle.length === 1) match = byTitle[0];
    }
    return match || null;
  }

  // Trigger Flow's internal video download / upscale pipeline directly via
  // `ipService.Eu(...)`, bypassing all hover overlays and menus.
  async function triggerVideoDownload({ key, title, resolution }) {
    const _ = getNs();
    const pageComp = getPageComponent();
    if (!_ || !pageComp || !pageComp.Ya) {
      throw new Error('Flow internal download service unavailable');
    }
    const ipService = pageComp.Ya;
    const tile = findVideoData(pageComp, key, title);
    if (!tile) {
      throw new Error('Video not found in project state');
    }

    const currentRes =
      (typeof pageComp.Ova === 'function' ? pageComp.Ova(tile) : tile.Db?.resolution) ?? 1;
    const isUserUploaded =
      typeof pageComp.o4 === 'function' ? !!pageComp.o4(tile) : false;
    const isUpsampleSupported =
      !isUserUploaded &&
      (typeof _.c0 === 'function' ? !!_.c0(tile.Db) : true);
    const durationSec = tile.Db?.Hf;
    const trimBounds =
      typeof pageComp.Nva === 'function' ? pageComp.Nva(tile.Db) : undefined;

    let chosenOption = null;
    if (typeof _.g0 === 'function') {
      const options = _.g0(ipService, {
        uq: currentRes,
        qg: isUpsampleSupported,
        ep: durationSec,
      });
      chosenOption = options.find((opt) => opt.label === resolution);
      if (!chosenOption) {
        throw new Error(`${resolution} option is not available for this video`);
      }
      if (!chosenOption.Yc) {
        throw new Error(
          chosenOption.Yf || `${resolution} isn't available for this video on your plan`,
        );
      }
    } else {
      const resMap = { '270p': 'gif', '720p': 1, '1080p': 2, '4K': 3 };
      const mapped = resMap[resolution];
      if (mapped === undefined) throw new Error(`Unsupported resolution: ${resolution}`);
      chosenOption = { resolution: mapped };
    }

    const description =
      (tile.displayName || tile.Db?.prompt || title || 'video').trim() || 'video';

    // `ipService.Eu` initiates either direct download (720p) or server-side
    // upscale + automatic download upon completion (1080p / 4K).
    // Note: Do not await completion of the entire upscale if `Eu` resolves
    // after initiating the job; `Eu` resolves once the initial RPC or download
    // action finishes.
    await ipService.Eu({
      mediaId: tile.primaryMediaId,
      description,
      resolution: chosenOption.resolution,
      Mk: chosenOption.Mk,
      Ue: trimBounds,
    });

    return { key: tile.primaryMediaId };
  }

  window.addEventListener(REQ_EVENT, async (event) => {
    const detail = event.detail;
    if (!detail || detail.id == null) return;
    const { id, type, payload } = detail;
    try {
      let result;
      if (type === 'sync-dom') {
        result = syncDomTileAttributes();
      } else if (type === 'scan') {
        result = scanVideos();
      } else if (type === 'trigger') {
        result = await triggerVideoDownload(payload);
      } else {
        throw new Error(`Unknown bridge command: ${type}`);
      }
      window.dispatchEvent(new CustomEvent(RES_EVENT, { detail: { id, result } }));
    } catch (err) {
      window.dispatchEvent(
        new CustomEvent(RES_EVENT, {
          detail: { id, error: String(err?.message || err) },
        }),
      );
    }
  });
})();
