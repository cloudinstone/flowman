# Flowman - Google Flow Batch Downloader

Chrome Extension (Manifest V3) that batch-downloads **videos** (`720p`, `1080p`, `4K`) and **images** (`1K`, `2K`, `4K`) from a Google Flow project, one after another, via Chrome's native Side Panel with Material Design 3 UI.

## How It Works

1. **Native Chrome Side Panel**: Browse, filter, and select project videos or images with live thumbnails directly in Chrome's side panel.
2. **Silent Internal Triggering**: Invokes Flow's internal download and upscaling pipeline directly without opening hover menus or scrolling your viewport (with menu automation kept as a fallback).
3. **Serial Queue Automation**: Uses `chrome.downloads` to await each file's completion before starting the next item, respecting Flow's recommendation against running multiple simultaneous upscales.

## Installation

1. Clone this repository:
   ```bash
   git clone https://github.com/cloudinstone/flowman.git
   ```
2. Open `chrome://extensions` in Google Chrome.
3. Enable **Developer mode** in the top right.
4. Click **Load unpacked** and select the `flowman` directory.
5. Pin **Flowman** to your toolbar.

## Usage

1. Open a Google Flow project (`https://flow.google.com/project/...`).
2. Click the extension toolbar icon to open Chrome's Side Panel.
3. Choose **Videos** or **Images**, then pick your target resolution (`1080p` / `720p` / `4K` for videos, `1K` / `2K` / `4K` for images).
4. Select items in the Side Panel list (or hold `Option` / `Alt` and click tiles directly on the Flow page).
5. Click **Start download** / **Download X items**. Keep the tab and panel open while processing.

Tile outline colors on Flow: blue = selected / queued, yellow = in progress, green = done, red = failed. **Retry failed** re-queues failed items.

## Notes

- Turn off Chrome's *"Ask where to save each file before downloading"*, otherwise every file opens a save dialog.
- Don't start other downloads during a run; the first download that starts after a trigger is attributed to the current item.
- Items are tracked by Flow's internal `primaryMediaId` (falling back to grid position only if unavailable).
- Relies on Flow's Angular frontend internals and DOM (`flow-grid-tile-container`, `flow-video-tile`, `flow-image-tile`). A Flow redesign may require selector or bridge updates.
