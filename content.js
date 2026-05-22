// content.js — injected into every webpage
(function () {
  'use strict';

  // ── State ────────────────────────────────────────────────────────────────────
  let issues = [];
  let riskScore = 0;

  // ── Persist a blocked-attempt record ─────────────────────────────────────────
  function logAttempt(type, message) {
    try {
      chrome.runtime.sendMessage({
        action: 'logAttempt',
        entry: {
          timestamp: new Date().toISOString(),
          url: location.href,
          type,
          message,
        }
      });
    } catch (_) {}
  }

  // ── Helper ───────────────────────────────────────────────────────────────────
  function addIssue(type, message, points) {
    if (issues.some(i => i.type === type)) return;
    issues.push({ type, message });
    riskScore = Math.min(100, riskScore + points);
    logAttempt(type, message);
    refreshBadge();
    notifyBackground();
  }

  function resetState() {
    issues = [];
    riskScore = 0;
    refreshBadge();
    notifyBackground();
    runAllChecks();
  }

  // ── Detector 1 & 2: Popup / Notification (signals from main-world.js) ────────
  window.addEventListener('message', (e) => {
    if (!e.data || !e.data._pageguard) return;
    const { type, detail } = e.data;
    if (type === 'popup') {
      addIssue('popup', 'Popup window blocked', 30);
    } else if (type === 'notification') {
      addIssue('notification', 'Notification permission request intercepted', 35);
    } else if (type === 'drivebydownload') {
      const label = detail ? ` (${detail})` : '';
      addIssue('drivebydownload', `Drive-by download blocked${label}`, 50);
    }
  });

  // ── Detector 3: Too many external links ─────────────────────────────────────
  function checkExternalLinks() {
    const host = location.hostname;
    let count = 0;
    document.querySelectorAll('a[href]').forEach(a => {
      try {
        const url = new URL(a.href);
        if (url.hostname && url.hostname !== host) count++;
      } catch (_) {}
    });
    if (count > 15) {
      addIssue('links', `High number of external links: ${count} found`, 20);
    }
  }

  // ── Detector 4: Fake download buttons ───────────────────────────────────────
  function checkFakeDownloadButtons() {
    const pattern = /(free\s*download|download\s*now|click\s*here|install\s*now|update\s*now|get\s*it\s*now)/i;
    let count = 0;
    document.querySelectorAll('a, button, [role="button"], input[type="button"], input[type="submit"]').forEach(el => {
      const text = (el.textContent || el.value || '').trim()
        .replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ');
      if (pattern.test(text) && el.getBoundingClientRect().width > 80) count++;
    });
    if (count >= 2) {
      addIssue('download', `Suspicious download buttons detected: ${count}`, 25);
    }
  }

  // ── Detector 5: Fake play buttons — detect + block click navigation ──────────
  const PLAY_PATTERN = /(\bplay\b|\bwatch\b|\bstream\b|▶|▷|⏵|▸|⯈|►)/i;

  function checkFakePlayButtons() {
    const host = location.hostname;
    let count = 0;
    document.querySelectorAll('a[href]').forEach(a => {
      if (a._pgBlocked) return;
      try {
        const url = new URL(a.href);
        if (!url.hostname || url.hostname === host) return;
        const label = [a.textContent, a.title, a.getAttribute('aria-label'), a.innerHTML].join(' ');
        if (PLAY_PATTERN.test(label)) {
          a._pgBlocked = true;
          a.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); }, true);
          count++;
        }
      } catch (_) {}
    });
    if (count > 0) {
      addIssue('fakeplay', `Deceptive play button blocked (${count} found)`, 40);
    }
  }

  // ── Detector 6: Auto-redirect — detect + neutralize ──────────────────────────
  function checkSuspiciousRedirects() {
    const meta = document.querySelector('meta[http-equiv="refresh"]');
    if (!meta) return;
    const delay = parseFloat(meta.getAttribute('content') || '');
    if (!isNaN(delay) && delay < 5) {
      meta.setAttribute('content', '99999'); // neutralize
      addIssue('redirect', 'Auto-redirect blocked (meta refresh)', 35);
    }
  }

  // ── Detector 7: Hidden cross-origin iframes — detect + blank ─────────────────
  function checkHiddenIframes() {
    let count = 0;
    document.querySelectorAll('iframe').forEach(f => {
      if (f._pgBlocked) return;
      const rect = f.getBoundingClientRect();
      const style = window.getComputedStyle(f);
      const hidden = rect.width <= 2 || rect.height <= 2
        || style.visibility === 'hidden'
        || style.opacity === '0'
        || style.display === 'none';
      const src = f.src || '';
      if (hidden && src && !src.startsWith(location.origin)) {
        f._pgBlocked = true;
        f.src = 'about:blank'; // block
        count++;
      }
    });
    if (count > 0) {
      addIssue('iframe', `Hidden cross-origin iframe${count > 1 ? 's' : ''} blocked: ${count}`, 30);
    }
  }

  // ── Detector 8: Floating ads — detect + close ────────────────────────────────
  const AD_PATTERN = /\b(ad|ads|advert|advertisement|banner|sponsor|sponsored|promo|promoted|adsense|adsbygoogle|ad-unit|ad-slot|ad-wrap|ad-box|ad-container|ad-banner)\b/i;

  function findCloseBtn(el) {
    const byAttr = el.querySelector(
      '[aria-label*="close" i], [aria-label*="dismiss" i], [title*="close" i], ' +
      '.close, .dismiss, .btn-close, .close-btn, .close-button, .icon-close'
    );
    if (byAttr) return byAttr;
    return Array.from(el.querySelectorAll('button, a, [role="button"], span')).find(b => {
      const t = (b.textContent || '').trim();
      return /^([×✕✗✖x]|close|dismiss|no\s*thanks|skip|got\s*it)$/i.test(t);
    }) || null;
  }

  function checkFloatingAds() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let count = 0;

    document.querySelectorAll('*').forEach(el => {
      if (el._pgAdBlocked) return;
      const style = window.getComputedStyle(el);
      if (style.position !== 'fixed') return;
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return;

      const rect = el.getBoundingClientRect();
      if (rect.width < 80 || rect.height < 40) return;

      const id = el.id || '';
      const cls = typeof el.className === 'string' ? el.className : '';
      const hasAdName    = AD_PATTERN.test(id + ' ' + cls);
      const hasAdIframe  = !!el.querySelector('iframe');
      const hasCloseBtn  = !!findCloseBtn(el);
      const coversArea   = rect.width * rect.height > vw * vh * 0.05;

      // Must match at least one of: ad-related name, contains iframe, or has a close button covering >5% viewport
      if (!hasAdName && !hasAdIframe && !(hasCloseBtn && coversArea)) return;

      el._pgAdBlocked = true;
      const btn = findCloseBtn(el);
      if (btn) {
        btn.click();
        setTimeout(() => {
          const s = window.getComputedStyle(el);
          if (s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0') {
            el.style.setProperty('display', 'none', 'important');
          }
        }, 300);
      } else {
        el.style.setProperty('display', 'none', 'important');
      }
      count++;
    });

    if (count > 0) {
      addIssue('floatingad', `Floating ad${count > 1 ? 's' : ''} closed: ${count}`, 20);
    }
  }

  // ── Run all DOM-based checks ──────────────────────────────────────────────────
  function runAllChecks() {
    checkExternalLinks();
    checkFakeDownloadButtons();
    checkFakePlayButtons();
    checkSuspiciousRedirects();
    checkHiddenIframes();
    checkFloatingAds();
  }

  // ── MutationObserver: re-scan when new nodes are injected ────────────────────
  let mutationTimer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(mutationTimer);
    mutationTimer = setTimeout(runAllChecks, 500);
  });

  function startObserver() {
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  // ── SPA navigation reset ─────────────────────────────────────────────────────
  let lastUrl = location.href;
  function handleNavigation() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    resetState();
  }

  window.addEventListener('popstate', handleNavigation);
  window.addEventListener('hashchange', handleNavigation);

  ['pushState', 'replaceState'].forEach(method => {
    const orig = history[method];
    history[method] = function () {
      orig.apply(this, arguments);
      handleNavigation();
    };
  });

  // ── Floating badge ───────────────────────────────────────────────────────────
  function createBadge() {
    if (document.getElementById('pageguard-badge')) return;
    const badge = document.createElement('div');
    badge.id = 'pageguard-badge';
    badge.title = 'Page Guard — open the extension for details';
    badge.textContent = '🛡️ Risk: 0%';
    document.body.appendChild(badge);
  }

  function refreshBadge() {
    const badge = document.getElementById('pageguard-badge');
    if (!badge) return;
    badge.textContent = `🛡️ Risk: ${riskScore}%`;
    if (riskScore === 0) {
      badge.style.display = 'none';
    } else {
      badge.style.display = 'flex';
      badge.classList.remove('risk-low', 'risk-medium', 'risk-high');
      if (riskScore >= 60)      badge.classList.add('risk-high');
      else if (riskScore >= 30) badge.classList.add('risk-medium');
      else                       badge.classList.add('risk-low');
    }
  }

  // ── Messaging ────────────────────────────────────────────────────────────────
  function notifyBackground() {
    try {
      chrome.runtime.sendMessage({ action: 'updateRisk', score: riskScore, issues });
    } catch (_) {}
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'getState') {
      sendResponse({ score: riskScore, issues });
    }
  });

  // ── Boot ─────────────────────────────────────────────────────────────────────
  function init() {
    createBadge();
    runAllChecks();
    notifyBackground();
    startObserver();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
