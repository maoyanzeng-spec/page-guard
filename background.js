// background.js — service worker

const MAX_LOG = 100;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // ── Risk update from content.js ───────────────────────────────────────────
  if (message.action === 'updateRisk' && sender.tab) {
    const { score, issues } = message;
    const tabId = sender.tab.id;
    chrome.storage.local.set({ [`tab_${tabId}`]: { score, issues } });
    chrome.action.setBadgeText({ text: score > 0 ? String(score) : '', tabId });
    chrome.action.setBadgeBackgroundColor({
      color: score >= 60 ? '#c62828' : score >= 30 ? '#f57c00' : '#388e3c',
      tabId
    });
    sendResponse({ ok: true });
    return true;
  }

  // ── Blocked-attempt log entry from content.js ─────────────────────────────
  if (message.action === 'logAttempt') {
    chrome.storage.local.get({ attempt_log: [] }, (data) => {
      const log = data.attempt_log;
      log.unshift(message.entry);       // newest first
      if (log.length > MAX_LOG) log.length = MAX_LOG;
      chrome.storage.local.set({ attempt_log: log });
    });
    sendResponse({ ok: true });
    return true;
  }

  // ── Clear log (from popup) ────────────────────────────────────────────────
  if (message.action === 'clearLog') {
    chrome.storage.local.remove('attempt_log');
    sendResponse({ ok: true });
    return true;
  }
});

// Clear tab data on navigation
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    chrome.storage.local.remove(`tab_${tabId}`);
    chrome.action.setBadgeText({ text: '', tabId });
  }
});

// Clean up closed tab data
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.remove(`tab_${tabId}`);
});
