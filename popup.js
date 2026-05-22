// popup.js

const ISSUE_META = {
  popup:           { icon: '🚨', high: true  },
  notification:    { icon: '🔔', high: true  },
  links:           { icon: '🔗', high: false },
  download:        { icon: '⬇️', high: false },
  redirect:        { icon: '↩️', high: true  },
  iframe:          { icon: '🖼️', high: true  },
  drivebydownload: { icon: '💀', high: true  },
  fakeplay:        { icon: '▶️', high: true  },
  floatingad:      { icon: '📢', high: false },
};

function captionFor(score) {
  if (score === 0)  return 'All clear';
  if (score < 30)   return 'Low risk';
  if (score < 60)   return 'Medium risk';
  return 'High risk';
}

function colorFor(score) {
  if (score === 0)  return '#9e9e9e';
  if (score < 30)   return '#388e3c';
  if (score < 60)   return '#f57c00';
  return '#c62828';
}

// ── Current-page issues ───────────────────────────────────────────────────────
function renderResults(data) {
  const gaugeRing    = document.getElementById('gaugeRing');
  const gaugeScore   = document.getElementById('gaugeScore');
  const gaugeCaption = document.getElementById('gaugeCaption');
  const issuesList   = document.getElementById('issuesList');
  const allClear     = document.getElementById('allClear');
  const noData       = document.getElementById('noData');

  if (!data) {
    noData.hidden = false;
    gaugeCaption.textContent = 'Unavailable';
    return;
  }

  const { score, issues } = data;
  gaugeScore.textContent = score;
  gaugeCaption.textContent = captionFor(score);
  gaugeRing.style.setProperty('--pct', score + '%');
  gaugeRing.style.setProperty('--risk-color', colorFor(score));

  if (!issues || issues.length === 0) {
    if (score === 0) allClear.hidden = false;
    return;
  }

  issues.forEach(issue => {
    const meta = ISSUE_META[issue.type] || { icon: '⚠️', high: false };
    const li = document.createElement('li');
    li.className = 'issue-item' + (meta.high ? ' high' : '');
    li.innerHTML = `
      <span class="issue-icon">${meta.icon}</span>
      <span>${issue.message}</span>
    `;
    issuesList.appendChild(li);
  });
}

// ── Attempt history ───────────────────────────────────────────────────────────
function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatUrl(raw) {
  try { return new URL(raw).hostname; } catch (_) { return raw; }
}

function renderHistory(log) {
  const list    = document.getElementById('historyList');
  const noHist  = document.getElementById('noHistory');

  list.innerHTML = '';

  if (!log || log.length === 0) {
    noHist.hidden = false;
    return;
  }

  log.forEach(entry => {
    const meta = ISSUE_META[entry.type] || { icon: '⚠️' };
    const li = document.createElement('li');
    li.className = 'history-item';
    li.innerHTML = `
      <div class="history-item-top">
        <span class="history-icon">${meta.icon}</span>
        <span class="history-type">${entry.type}</span>
        <span class="history-time">${formatTime(entry.timestamp)}</span>
      </div>
      <div class="history-msg">${entry.message}</div>
      <div class="history-url" title="${entry.url}">${formatUrl(entry.url)}</div>
    `;
    list.appendChild(li);
  });
}

// ── Clear log button ──────────────────────────────────────────────────────────
document.getElementById('clearLogBtn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'clearLog' }, () => {
    document.getElementById('historyList').innerHTML = '';
    document.getElementById('noHistory').hidden = false;
  });
});

// ── Boot ─────────────────────────────────────────────────────────────────────
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  if (!tabs || tabs.length === 0) {
    renderResults(null);
  } else {
    chrome.tabs.sendMessage(tabs[0].id, { action: 'getState' }, (response) => {
      renderResults(chrome.runtime.lastError ? null : response);
    });
  }
});

chrome.storage.local.get({ attempt_log: [] }, (data) => {
  renderHistory(data.attempt_log);
});
