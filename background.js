// background.js — service worker
// Sniffs network traffic for real video streams and keeps a per-tab, ranked
// list of candidates that the popup can launch in the floating player.

// ── What counts as a video ────────────────────────────────────────────────────
// Manifests (adaptive streaming) and progressive container files. Individual HLS
// segments (.ts/.m4s) are intentionally ignored — they're parts of a stream, not
// something to play on their own; the manifest is the real handle.
const MEDIA_EXT = /\.(m3u8|mpd|mp4|m4v|webm|mov|ogv|mkv)(?:[?#]|$)/i;
const SEGMENT_EXT = /\.(ts|m4s)(?:[?#]|$)/i;
const MEDIA_MIME = /^(video\/|application\/(vnd\.apple\.mpegurl|x-mpegurl|dash\+xml))/i;

// Progressive files smaller than this are almost always ads / previews / sprites,
// not the main feature — drop them so the list stays clean.
const MIN_PROGRESSIVE_BYTES = 300 * 1024;

// tabId -> Map(url -> candidate). In-memory for speed; mirrored to storage so the
// popup still works if the service worker was torn down.
const tabVideos = new Map();

function typeOf(url, mime) {
  if (/\.(m3u8)(?:[?#]|$)/i.test(url) || /mpegurl/i.test(mime)) return 'hls';
  if (/\.(mpd)(?:[?#]|$)/i.test(url) || /dash\+xml/i.test(mime)) return 'dash';
  return 'progressive';
}

// LAN / TV-box guard. Media served from a private-network address (e.g. a
// Swisscom TV box at 192.168.x.x, a NAS, a router UI) is deliberately ignored:
// the sniffer is passive, but we don't want local devices ever becoming
// playable candidates. Loopback/localhost stays ALLOWED so a local dev server
// (test.html) still works.
function hostnameOf(url) {
  try { return new URL(url).hostname; } catch (_) { return ''; }
}

function isPrivateHost(host) {
  if (!host) return false;
  host = host.replace(/^\[|\]$/g, '');                 // strip IPv6 brackets
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a === 10) return true;                          // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
    if (a === 192 && b === 168) return true;            // 192.168.0.0/16
    if (a === 169 && b === 254) return true;            // 169.254.0.0/16 link-local
    return false;
  }
  if (/\.local$/i.test(host)) return true;              // mDNS (e.g. box.local)
  if (/^fe80:/i.test(host)) return true;                // IPv6 link-local
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true;    // IPv6 unique-local fc00::/7
  return false;
}

function fileName(url) {
  try {
    const p = new URL(url).pathname;
    const base = p.substring(p.lastIndexOf('/') + 1);
    return decodeURIComponent(base) || url;
  } catch (_) {
    return url;
  }
}

function header(headers, name) {
  if (!headers) return '';
  const h = headers.find(x => x.name.toLowerCase() === name);
  return h ? h.value || '' : '';
}

// Content-Range ("bytes 0-1023/12345678") reveals the FULL size even on a range
// request; fall back to Content-Length otherwise.
function sizeFromHeaders(headers) {
  const range = header(headers, 'content-range');
  const m = range.match(/\/(\d+)\s*$/);
  if (m) return parseInt(m[1], 10);
  const len = parseInt(header(headers, 'content-length'), 10);
  return isNaN(len) ? 0 : len;
}

function persist(tabId) {
  const map = tabVideos.get(tabId);
  const list = map ? Array.from(map.values()) : [];
  chrome.storage.local.set({ [`cp_videos_${tabId}`]: list });
  chrome.action.setBadgeText({ text: list.length ? String(list.length) : '', tabId });
  chrome.action.setBadgeBackgroundColor({ color: '#2563eb', tabId });
}

function clearTab(tabId) {
  tabVideos.delete(tabId);
  chrome.storage.local.remove(`cp_videos_${tabId}`);
  chrome.action.setBadgeText({ text: '', tabId });
}

function recordCandidate(tabId, url, type, mime, size, frameId) {
  if (!tabVideos.has(tabId)) tabVideos.set(tabId, new Map());
  const map = tabVideos.get(tabId);
  const existing = map.get(url);
  if (existing) {
    // Keep the largest size we ever saw for this URL.
    if (size > existing.size) existing.size = size;
    return;
  }
  map.set(url, {
    url,
    type,          // 'hls' | 'dash' | 'progressive'
    mime,
    size,          // bytes; 0 = unknown (typical for manifests)
    title: fileName(url),
    frameId,
    ts: Date.now(),
  });
  persist(tabId);
}

// ── Inspect every response and pick out the media ─────────────────────────────
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const { tabId, url, type, frameId, responseHeaders } = details;
    if (tabId < 0) return;

    // A fresh top-level document means a new page — reset that tab's list.
    if (type === 'main_frame') {
      clearTab(tabId);
      return;
    }

    // Never record media from a local-network device (TV box, NAS, router …).
    if (isPrivateHost(hostnameOf(url))) return;

    if (SEGMENT_EXT.test(url)) return; // stream part, not a standalone video

    const mime = header(responseHeaders, 'content-type');
    const looksLikeMedia = MEDIA_EXT.test(url) || MEDIA_MIME.test(mime);
    if (!looksLikeMedia) return;

    const kind = typeOf(url, mime);
    const size = sizeFromHeaders(responseHeaders);

    // Progressive files must clear the size floor; manifests are always kept
    // (they're small text but represent the real adaptive stream).
    if (kind === 'progressive' && size && size < MIN_PROGRESSIVE_BYTES) return;

    recordCandidate(tabId, url, kind, mime, size, frameId);
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

// ── Message routing ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'getVideos') {
    const tabId = message.tabId != null ? message.tabId : (sender.tab && sender.tab.id);
    if (tabId == null) { sendResponse({ videos: [] }); return true; }
    const map = tabVideos.get(tabId);
    if (map) {
      sendResponse({ videos: Array.from(map.values()) });
    } else {
      chrome.storage.local.get({ [`cp_videos_${tabId}`]: [] }, (d) => {
        sendResponse({ videos: d[`cp_videos_${tabId}`] || [] });
      });
    }
    return true;
  }

  if (message.action === 'clearVideos') {
    const tabId = message.tabId != null ? message.tabId : (sender.tab && sender.tab.id);
    if (tabId != null) clearTab(tabId);
    sendResponse({ ok: true });
    return true;
  }
});

// ── Cleanup ───────────────────────────────────────────────────────────────────
chrome.tabs.onRemoved.addListener((tabId) => clearTab(tabId));
