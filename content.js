// content.js — isolated world.
// Two jobs:
//   1. Enumerate <video> elements already in the DOM (so the popup can offer them
//      alongside the network-sniffed streams from background.js).
//   2. Host the floating, draggable, resizable Shadow-DOM player and play any
//      stream the popup hands it (progressive files natively, HLS via hls.js).
(function () {
  'use strict';

  // ── LAN / TV-box guard ───────────────────────────────────────────────────────
  // Media served from a private-network address (e.g. a Swisscom TV box at
  // 192.168.x.x) must never be touched. Loopback/localhost stays allowed so a
  // local dev server (test.html) still works.
  function hostnameOf(u) {
    try { return new URL(u, location.href).hostname; } catch (_) { return ''; }
  }
  function isPrivateHost(host) {
    if (!host) return false;
    host = host.replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
    const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m) {
      const a = +m[1], b = +m[2];
      if (a === 10) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 192 && b === 168) return true;
      if (a === 169 && b === 254) return true;
      return false;
    }
    if (/\.local$/i.test(host)) return true;
    if (/^fe80:/i.test(host)) return true;
    if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true;
    return false;
  }

  // On a LAN page (the TV box's own web UI, a router, a NAS) the extension stays
  // completely inert: no player, no message listeners, no DOM scanning.
  if (isPrivateHost(location.hostname)) return;

  // hls.js is loaded into this same isolated world by the manifest, before us.
  const Hls = window.Hls;

  const GEOM_KEY = 'cp_player_geom';
  const MIN_W = 320;
  const MIN_H = 200;

  let host = null;      // shadow host element
  let root = null;      // shadow root
  let video = null;
  let statusEl = null;
  let titleEl = null;
  let shield = null;    // transparent capture layer used while dragging/resizing
  let currentHls = null;

  // ── DOM <video> discovery ────────────────────────────────────────────────────
  function domVideos() {
    const out = [];
    document.querySelectorAll('video').forEach((v) => {
      let src = v.currentSrc || v.src || '';
      if (!src) {
        const s = v.querySelector('source[src]');
        if (s) src = s.src;
      }
      // blob:/MediaSource streams can't be replayed from a URL — the network
      // sniffer usually catches the underlying manifest instead, so skip these.
      if (!src || src.startsWith('blob:')) return;
      // Skip anything hosted on a local-network device (TV box, NAS, …).
      if (isPrivateHost(hostnameOf(src))) return;
      out.push({
        url: src,
        type: /\.m3u8/i.test(src) ? 'hls' : /\.mpd/i.test(src) ? 'dash' : 'progressive',
        size: 0,
        title: (src.split('/').pop() || src).split(/[?#]/)[0] || src,
        resolution: v.videoWidth && v.videoHeight ? `${v.videoWidth}×${v.videoHeight}` : '',
        source: 'dom',
      });
    });
    return out;
  }

  // ── Player construction (once) ───────────────────────────────────────────────
  const STYLE = `
    :host { all: initial; }
    .cp-panel {
      position: fixed; z-index: 2147483647; top: 80px; right: 24px;
      width: 640px; height: 400px; min-width: ${MIN_W}px; min-height: ${MIN_H}px;
      background: #0b0d12; border: 1px solid #2a2f3a; border-radius: 10px;
      box-shadow: 0 12px 40px rgba(0,0,0,.55); display: flex; flex-direction: column;
      overflow: hidden; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    }
    .cp-header {
      display: flex; align-items: center; gap: 8px; padding: 8px 10px;
      background: #151922; cursor: move; user-select: none; flex: 0 0 auto;
    }
    .cp-title {
      flex: 1; min-width: 0; color: #e6e9ef; font-size: 12px; font-weight: 600;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .cp-btn {
      appearance: none; border: 0; background: transparent; color: #aab2c0;
      width: 26px; height: 26px; border-radius: 6px; cursor: pointer; font-size: 15px;
      line-height: 1; display: flex; align-items: center; justify-content: center;
    }
    .cp-btn:hover { background: #232936; color: #fff; }
    .cp-body { position: relative; flex: 1 1 auto; background: #000; min-height: 0; }
    .cp-video { width: 100%; height: 100%; display: block; background: #000; object-fit: contain; }
    .cp-status {
      position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
      padding: 16px; text-align: center; color: #cbd3e1; font-size: 13px; line-height: 1.5;
      background: rgba(0,0,0,.55); pointer-events: none;
    }
    .cp-status.show { display: flex; }
    .cp-resize {
      position: absolute; right: 0; bottom: 0; width: 18px; height: 18px;
      cursor: nwse-resize; z-index: 2;
      background: linear-gradient(135deg, transparent 50%, #3a4152 50%, #3a4152 60%, transparent 60%, transparent 72%, #3a4152 72%, #3a4152 82%, transparent 82%);
    }
    /* Captures the mouse while dragging/resizing so page iframes & the video
       element can't swallow mousemove and stall the gesture. */
    .cp-shield { position: fixed; inset: 0; z-index: 2147483646; display: none; }
    .cp-shield.show { display: block; }
  `;

  function buildPlayer() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'clean-player-host';
    root = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = STYLE;
    root.appendChild(style);

    const panel = document.createElement('div');
    panel.className = 'cp-panel';
    panel.innerHTML = `
      <div class="cp-header">
        <span class="cp-title">Clean Player</span>
        <button class="cp-btn cp-pip" title="Picture-in-picture">⧉</button>
        <button class="cp-btn cp-close" title="Close">✕</button>
      </div>
      <div class="cp-body">
        <video class="cp-video" controls autoplay playsinline></video>
        <div class="cp-status"></div>
      </div>
      <div class="cp-resize" title="Drag to resize"></div>
    `;
    root.appendChild(panel);

    shield = document.createElement('div');
    shield.className = 'cp-shield';
    root.appendChild(shield);

    (document.body || document.documentElement).appendChild(host);

    video = root.querySelector('.cp-video');
    statusEl = root.querySelector('.cp-status');
    titleEl = root.querySelector('.cp-title');

    root.querySelector('.cp-close').addEventListener('click', closePlayer);
    root.querySelector('.cp-pip').addEventListener('click', togglePip);

    makeDraggable(panel, root.querySelector('.cp-header'));
    makeResizable(panel, root.querySelector('.cp-resize'));
    restoreGeom(panel);
  }

  function status(msg) {
    if (!statusEl) return;
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('show', !!msg);
  }

  // ── Drag & resize (geometry persisted across pages) ──────────────────────────
  let saveTimer = null;
  function saveGeom(panel) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const g = { left: panel.style.left, top: panel.style.top, width: panel.style.width, height: panel.style.height };
      try { chrome.storage.local.set({ [GEOM_KEY]: g }); } catch (_) {}
    }, 250);
  }

  function restoreGeom(panel) {
    try {
      chrome.storage.local.get({ [GEOM_KEY]: null }, (d) => {
        const g = d[GEOM_KEY];
        if (!g) return;
        if (g.left)  { panel.style.left = g.left; panel.style.right = 'auto'; }
        if (g.top)   { panel.style.top = g.top; }
        if (g.width) { panel.style.width = g.width; }
        if (g.height){ panel.style.height = g.height; }
      });
    } catch (_) {}
  }

  function showShield(cursor) { if (shield) { shield.style.cursor = cursor; shield.classList.add('show'); } }
  function hideShield() { if (shield) shield.classList.remove('show'); }

  function makeDraggable(panel, handle) {
    let sx, sy, sl, st;
    const onMove = (e) => {
      const nl = sl + (e.clientX - sx);
      const nt = st + (e.clientY - sy);
      panel.style.left = Math.max(0, Math.min(nl, window.innerWidth - 60)) + 'px';
      panel.style.top = Math.max(0, Math.min(nt, window.innerHeight - 40)) + 'px';
      panel.style.right = 'auto';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseup', onUp, true);
      hideShield();
      saveGeom(panel);
    };
    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('.cp-btn')) return;
      const r = panel.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; sl = r.left; st = r.top;
      panel.style.left = r.left + 'px'; panel.style.top = r.top + 'px'; panel.style.right = 'auto';
      showShield('move');
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup', onUp, true);
      e.preventDefault();
    });
  }

  function makeResizable(panel, handle) {
    let sx, sy, sw, sh;
    const onMove = (e) => {
      panel.style.width = Math.max(MIN_W, sw + (e.clientX - sx)) + 'px';
      panel.style.height = Math.max(MIN_H, sh + (e.clientY - sy)) + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseup', onUp, true);
      hideShield();
      saveGeom(panel);
    };
    handle.addEventListener('mousedown', (e) => {
      const r = panel.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; sw = r.width; sh = r.height;
      showShield('nwse-resize');
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup', onUp, true);
      e.preventDefault();
    });
  }

  function togglePip() {
    try {
      if (document.pictureInPictureElement) document.exitPictureInPicture();
      else if (video) video.requestPictureInPicture();
    } catch (_) {}
  }

  // ── Loading a stream ─────────────────────────────────────────────────────────
  function destroyHls() {
    if (currentHls) { try { currentHls.destroy(); } catch (_) {} currentHls = null; }
  }

  function openPlayer(url, type, title) {
    buildPlayer();
    host.style.display = '';
    titleEl.textContent = title || url;
    destroyHls();
    video.removeAttribute('src');
    video.load();
    status('Loading…');

    if (type === 'hls' && !video.canPlayType('application/vnd.apple.mpegurl')) {
      if (Hls && Hls.isSupported()) {
        const hls = new Hls({ enableWorker: true, lowLatencyMode: false });
        currentHls = hls;
        hls.on(Hls.Events.MANIFEST_PARSED, () => { status(''); video.play().catch(() => {}); });
        hls.on(Hls.Events.ERROR, (evt, data) => {
          if (!data.fatal) return;
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            // First fatal network error is often a transient segment miss; retry
            // once, then give up with a helpful message.
            if (!hls._cpRetried) { hls._cpRetried = true; hls.startLoad(); return; }
            status('Stream blocked by the site (CORS / hotlink protection) or unavailable.');
            destroyHls();
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            hls.recoverMediaError();
          } else {
            status('Could not play this stream.');
            destroyHls();
          }
        });
        hls.loadSource(url);
        hls.attachMedia(video);
      } else {
        status('This browser has no HLS support.');
      }
      return;
    }

    // Native path: progressive files, and HLS on browsers that play it natively.
    video.src = url;
    video.play().then(() => status('')).catch(() => {
      // Autoplay can be blocked before a user gesture — the controls still work.
      status('');
    });
    video.addEventListener('error', () => {
      status(type === 'dash'
        ? 'DASH streams are not supported by the built-in player.'
        : 'Could not load this video (blocked by the site or unsupported format).');
    }, { once: true });
  }

  function closePlayer() {
    destroyHls();
    if (video) { try { video.pause(); } catch (_) {} video.removeAttribute('src'); video.load(); }
    if (host) host.style.display = 'none';
  }

  // ── Messaging from the popup ─────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'getDomVideos') {
      sendResponse({ videos: domVideos() });
      return true;
    }
    if (message.action === 'playVideo') {
      openPlayer(message.url, message.type, message.title);
      sendResponse({ ok: true });
      return true;
    }
    if (message.action === 'closePlayer') {
      closePlayer();
      sendResponse({ ok: true });
      return true;
    }
  });
})();
