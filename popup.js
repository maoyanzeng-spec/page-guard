// popup.js — lists detected video streams for the active tab and launches the
// chosen one in the on-page floating player.

const TYPE_META = {
  hls:         { icon: '📡', label: 'HLS stream' },
  dash:        { icon: '📶', label: 'DASH stream' },
  progressive: { icon: '🎞️', label: 'Video file' },
};

// hls.js is loaded (via popup.html) so HLS candidates can preview inline, not
// just progressive files.
const Hls = window.Hls;

let activeTab = null;
let previews = []; // { hls, video } for each inline preview, torn down on rescan/close

function fmtSize(bytes) {
  if (!bytes) return '';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return (mb / 1024).toFixed(1) + ' GB';
  if (mb >= 1) return mb.toFixed(1) + ' MB';
  return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

// Rank the "real" video first: adaptive manifests are almost always the main
// feature; among progressive files the biggest wins; DOM-reported resolution
// breaks remaining ties.
function rank(v) {
  let score = v.size || 0;
  if (v.type === 'hls' || v.type === 'dash') score += 5 * 1024 * 1024 * 1024; // float manifests to the top
  if (v.resolution) {
    const h = parseInt((v.resolution.split(/[×x]/)[1] || '0'), 10);
    score += h * 1000;
  }
  return score;
}

function dedupe(list) {
  const seen = new Map();
  list.forEach((v) => {
    const prev = seen.get(v.url);
    if (!prev) { seen.set(v.url, v); return; }
    // Merge: keep the larger size and any resolution we learned from the DOM.
    if ((v.size || 0) > (prev.size || 0)) prev.size = v.size;
    if (v.resolution && !prev.resolution) prev.resolution = v.resolution;
  });
  return Array.from(seen.values());
}

function render(videos) {
  const list = document.getElementById('videoList');
  const empty = document.getElementById('emptyState');
  const footStatus = document.getElementById('footStatus');
  clearPreviews();
  list.innerHTML = '';

  videos = dedupe(videos).sort((a, b) => rank(b) - rank(a));

  if (videos.length === 0) {
    empty.hidden = false;
    footStatus.textContent = '';
    return;
  }
  empty.hidden = true;
  footStatus.textContent = `${videos.length} stream${videos.length > 1 ? 's' : ''} found`;

  videos.forEach((v, i) => {
    const meta = TYPE_META[v.type] || TYPE_META.progressive;
    const li = document.createElement('li');
    li.className = 'video-item' + (i === 0 ? ' primary' : '');

    const details = [meta.label, v.resolution, fmtSize(v.size)].filter(Boolean).join(' · ');
    li.innerHTML = `
      <span class="video-thumb">
        <video muted loop playsinline preload="metadata"></video>
        <span class="thumb-fallback">${meta.icon}</span>
      </span>
      <span class="video-info">
        <span class="video-title">${i === 0 ? '<b class="tag">Main</b> ' : ''}${escapeHtml(v.title)}</span>
        <span class="video-meta">${escapeHtml(details)}</span>
      </span>
      <button class="play-btn">▶ Play</button>
    `;
    li.querySelector('.play-btn').addEventListener('click', () => play(v));
    list.appendChild(li);
    startPreview(li.querySelector('.video-thumb'), v);
  });
}

// ── Inline previews ────────────────────────────────────────────────────────────
// Each row plays a muted, low-buffer preview. Progressive files load cross-origin
// natively; HLS goes through hls.js (needs permissive CORS, same as the main
// player). Anything that fails just keeps the emoji fallback — no broken tiles.
function startPreview(thumbEl, v) {
  const videoEl = thumbEl.querySelector('video');
  const loaded = () => thumbEl.classList.add('loaded');
  const fail = () => { thumbEl.classList.remove('loaded'); teardownPreview(videoEl); };

  videoEl.addEventListener('error', fail, { once: true });

  if (v.type === 'hls' && !videoEl.canPlayType('application/vnd.apple.mpegurl')) {
    if (Hls && Hls.isSupported()) {
      // Tiny footprint: no worker, small buffer, cap quality to the thumbnail size.
      const hls = new Hls({ enableWorker: false, maxBufferLength: 6, capLevelToPlayerSize: true });
      previews.push({ hls, video: videoEl });
      hls.on(Hls.Events.MANIFEST_PARSED, () => { loaded(); videoEl.play().catch(() => {}); });
      hls.on(Hls.Events.ERROR, (evt, data) => { if (data && data.fatal) fail(); });
      hls.loadSource(v.url);
      hls.attachMedia(videoEl);
    } else {
      fail();
    }
    return;
  }

  // Progressive files, and HLS on browsers with native support.
  previews.push({ hls: null, video: videoEl });
  videoEl.src = v.url;
  videoEl.addEventListener('loadeddata', () => { loaded(); videoEl.play().catch(() => {}); }, { once: true });
}

function teardownPreview(videoEl) {
  const idx = previews.findIndex((p) => p.video === videoEl);
  if (idx >= 0) {
    try { previews[idx].hls && previews[idx].hls.destroy(); } catch (_) {}
    previews.splice(idx, 1);
  }
  try { videoEl.pause(); videoEl.removeAttribute('src'); videoEl.load(); } catch (_) {}
}

function clearPreviews() {
  previews.forEach((p) => {
    try { p.hls && p.hls.destroy(); } catch (_) {}
    try { p.video.pause(); p.video.removeAttribute('src'); p.video.load(); } catch (_) {}
  });
  previews = [];
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function play(v) {
  if (!activeTab) return;
  chrome.tabs.sendMessage(activeTab.id, {
    action: 'playVideo', url: v.url, type: v.type, title: v.title,
  }, () => {
    if (chrome.runtime.lastError) {
      document.getElementById('footStatus').textContent = 'Cannot open player on this page.';
    } else {
      window.close();
    }
  });
}

// ── Load: merge network-sniffed streams (background) with DOM videos (content) ──
function load() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    activeTab = tabs && tabs[0];
    if (!activeTab) { render([]); return; }

    const collected = [];
    let pending = 2;
    const done = () => { if (--pending === 0) render(collected); };

    chrome.runtime.sendMessage({ action: 'getVideos', tabId: activeTab.id }, (resp) => {
      if (!chrome.runtime.lastError && resp && resp.videos) collected.push(...resp.videos);
      done();
    });

    chrome.tabs.sendMessage(activeTab.id, { action: 'getDomVideos' }, (resp) => {
      // lastError is expected on restricted pages (chrome://, web store) — ignore.
      if (!chrome.runtime.lastError && resp && resp.videos) collected.push(...resp.videos);
      done();
    });
  });
}

document.getElementById('refreshBtn').addEventListener('click', load);
load();
