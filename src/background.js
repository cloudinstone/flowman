// Service worker: stateless relay between chrome.* APIs and the Flow content script.
// The content script owns the queue; this worker only forwards events.

const FLOW_TABS = { url: 'https://flow.google.com/*' };

async function broadcast(message) {
  const tabs = await chrome.tabs.query(FLOW_TABS);
  await Promise.all(
    tabs.map(async (tab) => {
      try {
        await chrome.tabs.sendMessage(tab.id, message);
      } catch {
        // Tab has no content script (e.g. still loading); ignore.
      }
    }),
  );
}

chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle-panel' });
  } catch {
    // Not a Flow tab or content script not injected yet.
  }
});

chrome.downloads.onCreated.addListener((item) => {
  broadcast({
    type: 'download-created',
    id: item.id,
    url: item.url,
    filename: item.filename || '',
  });
});

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state && !delta.filename) return;
  broadcast({
    type: 'download-changed',
    id: delta.id,
    state: delta.state?.current,
    filename: delta.filename?.current,
    error: delta.error?.current,
  });
});
