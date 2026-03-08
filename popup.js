const btn = document.getElementById('toggleBtn');

btn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  try {
    // Always inject — the guard at top of content.js makes it idempotent
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    });
  } catch (e) {
    // Restricted page (chrome://, extensions page, etc.)
    window.close();
    return;
  }

  // Brief delay so the script's message listener is registered before we send
  setTimeout(() => {
    chrome.tabs.sendMessage(tab.id, { action: 'toggle' }).catch(() => {});
    window.close();
  }, 60);
});
