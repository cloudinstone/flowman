# Flow Batch Downloader

Chrome Extension (Manifest V3) that batch-downloads videos from a Google Flow project at 720p or 1080p (upscaled), one after another, via Chrome's native Side Panel with Material Design 3 UI.

## How It Works

1. **Native Chrome Side Panel**: The control center runs in Chrome's native side panel with GM3 styling, avoiding overlay clutter on the Flow workspace.
2. **Serial Queue Automation**: Automatically opens the video menu (`More options` -> `Download` -> `1080p Upscaled` / `720p`), triggers generation, and uses `chrome.downloads` directly in the side panel to await completion before proceeding to the next video.
3. **Flow Safety**: Respects Flow's recommendation against running multiple simultaneous upscales by keeping the pipeline strictly serial.

## Installation

1. Open `chrome://extensions` in Google Chrome.
2. Enable **Developer mode** in the top right.
3. Click **Load unpacked** and choose the `~/projects/flow-batch-downloader` directory.
4. Pin the **Flow Batch Downloader** extension to your toolbar.

## Usage

1. Navigate to your Google Flow project (e.g. `https://flow.google.com/project/...`).
2. Click the extension toolbar icon. Chrome's Side Panel will open.
3. Select your desired resolution (**1080p** recommended for upscaled exports).
4. Use **Select all** or tick checkboxes directly on video tiles in the Flow grid.
5. Click **Download X videos** / **Start download**. Leave the tab and panel open while processing.

Tile outline colors: blue = queued, yellow = in progress, green = done, red = failed. **Retry failed** re-queues failed items.

## Notes

- Turn off Chrome's *"Ask where to save each file before downloading"*, otherwise every file opens a save dialog.
- Don't start other downloads during a run; the first download that starts after a click is attributed to the current video.
- Tiles are identified by grid position (Flow exposes no media id in the DOM). If the layout shifts mid-run, the extension falls back to matching by title; duplicate titles then fail and can be retried.
- Selectors rely on Flow's DOM (`flow-grid-tile-container`, `flow-video-tile`, Material menus). A Flow redesign may break them.
