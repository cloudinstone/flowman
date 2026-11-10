// Service worker: only wires the toolbar icon to the side panel.
// Queue state and download tracking live in the side panel page.

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => {
  console.error('Failed to set side panel behavior', err);
});
