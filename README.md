# Flow Batch Downloader

Chrome extension (MV3) that batch-downloads videos from a Google Flow project at 720p or 1080p (upscaled), one after another, without clicking through each upscale by hand.

## How it works

It drives Flow's own UI: tile **More options → Download → resolution**. Flow performs the upscale and starts the browser download itself; the extension waits for that download to complete (`chrome.downloads`) and then moves to the next video. The queue is strictly serial because Flow asks users not to run multiple upscale jobs at once.

No Flow APIs are called directly and no credentials are read.

## Install

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. Pin the extension.

## Use

1. Open a Flow project (`https://flow.google.com/project/...`). The **Videos** view keeps the grid focused.
2. Click the extension icon to open the panel. Checkboxes appear on downloadable video tiles.
3. Tick videos, or click **Select all videos**.
4. Pick a resolution and press **Start**. Leave the tab open.

Tile outline colors: blue = queued, yellow = in progress, green = done, red = failed. **Retry failed** re-queues failed items.

## Notes

- Turn off Chrome's *"Ask where to save each file before downloading"*, otherwise every file opens a save dialog.
- Don't start other downloads during a run; the first download that starts after a click is attributed to the current video.
- Tiles are identified by grid position (Flow exposes no media id in the DOM). If the layout shifts mid-run, the extension falls back to matching by title; duplicate titles then fail and can be retried.
- Selectors rely on Flow's DOM (`flow-grid-tile-container`, `flow-video-tile`, Material menus). A Flow redesign may break them.
