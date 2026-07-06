# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## What this is

**Clean Player** is a Manifest V3 Chrome extension that finds the *real* video stream on a
page and plays it in a draggable, resizable, ad-free floating player. It replaced an earlier
"Page Guard" risk-scoring/ad-blocking extension (git history predates the pivot). The goal:
watch the main video (common on streaming / adult tube sites) without the surrounding page,
ads, or pop-ups — similar to a downloader's preview pane, but full-size and freely resizable.

## Loading and Testing

No build step — pure vanilla JS plus a vendored `hls.js`, loaded directly by Chrome.

1. Open `chrome://extensions/`, enable **Developer mode**, click **Load unpacked**, select this dir.
2. After any code change, click the reload icon on the extension card. Changing `background.js`
   or the manifest requires the reload; content-script/popup changes just need a page/popup reopen.
3. Open `test.html` (via `file://` or a local server). Let the sample videos load, click the
   toolbar icon, and confirm both the MP4 and the HLS stream appear and play in the overlay.

## Architecture

Three contexts, message-passed. There is **no** `main-world.js` anymore (the old API-patching
context) — everything runs in the isolated content-script world or the service worker.

### `background.js` — service worker, the media sniffer
The core of detection. Uses `chrome.webRequest.onHeadersReceived` over `<all_urls>` to inspect
every response and keep a per-tab, in-memory `Map(url → candidate)` (mirrored to
`chrome.storage.local` key `cp_videos_<tabId>` so the popup still works if the worker was torn down).

- **What counts as media:** URL matches `MEDIA_EXT` (`.m3u8/.mpd/.mp4/.m4v/.webm/.mov/.ogv/.mkv`)
  **or** the `Content-Type` matches `MEDIA_MIME` (`video/*`, HLS/DASH manifest MIMEs). HLS/DASH
  segments (`.ts/.m4s`, `SEGMENT_EXT`) are **ignored** — they're parts of a stream, not playable
  handles; only the manifest is surfaced.
- **Size = the real-video heuristic.** `sizeFromHeaders` reads the full size from `Content-Range`
  (`bytes 0-1023/12345678` → `12345678`) when present, else `Content-Length`. Progressive files
  under `MIN_PROGRESSIVE_BYTES` (300 KB) are dropped as ads/previews. Manifests are always kept
  regardless of size (they're small text but represent the real adaptive stream).
- `typeOf()` classifies each URL as `'hls' | 'dash' | 'progressive'`.
- **LAN guard.** Media served from a private-network host (`isPrivateHost`: `10/8`,
  `172.16/12`, `192.168/16`, `169.254/16` link-local, `*.local` mDNS, IPv6 `fe80::`/`fc00::/7`)
  is never recorded — so local devices like a Swisscom TV box, NAS, or router UI never become
  playable candidates. Loopback/localhost is deliberately **allowed** so a local dev server for
  `test.html` still works.
- A `main_frame` response clears that tab's list (new page). `tabs.onRemoved` cleans up.
- Sets the toolbar badge to the candidate count per tab.
- Messages: `getVideos {tabId}` → candidate list; `clearVideos {tabId}`.

### `content.js` — isolated world, DOM detection + floating player
`vendor/hls.light.min.js` is listed **before** `content.js` in the manifest's `js` array, so
they share the isolated world and `content.js` reads `window.Hls`.

- **LAN guard.** On a page whose own host is private (`isPrivateHost(location.hostname)` — same
  ranges as `background.js`), the whole content script returns immediately: no player, no message
  listeners, no DOM scan. It also skips any `<video>` whose `src` resolves to a private host, so a
  local TV box / NAS never surfaces as a candidate.
- **`domVideos()`** enumerates on-page `<video>` elements (their `currentSrc`/`<source>`, plus
  `videoWidth×videoHeight` as `resolution`). `blob:`/MediaSource sources are skipped — they can't
  be replayed from a URL; the network sniffer catches their underlying manifest instead.
- **Floating player** is built once inside a **Shadow DOM** (`#clean-player-host`, `mode: open`)
  so page CSS can't touch it; styles live in the `STYLE` string, `z-index: 2147483647`. Header is
  the drag handle; a bottom-right `.cp-resize` handle resizes (min `MIN_W`×`MIN_H`). Geometry is
  persisted to `chrome.storage.local` key `cp_player_geom` and restored on next open. A ⧉ button
  toggles native Picture-in-Picture.
- **Playback (`openPlayer`)**: progressive files and natively-HLS-capable browsers set
  `video.src` directly. Otherwise HLS goes through **hls.js** with fatal-error handling —
  one retry on `NETWORK_ERROR` then a "blocked by CORS/hotlink" message, `recoverMediaError()`
  on `MEDIA_ERROR`. DASH has no bundled engine (falls back to native `video.src`, usually fails).
- Messages from the popup: `getDomVideos`, `playVideo {url,type,title}`, `closePlayer`.

### `popup.html` / `popup.js` / `popup.css`
Merges two sources for the active tab: network candidates from `background.js`
(`getVideos`) **and** DOM videos from `content.js` (`getDomVideos`), dedupes by URL, then
**ranks** (`rank()`): HLS/DASH manifests float to the top (main feature), then largest byte size,
then DOM resolution as a tiebreak. Top entry is tagged **Main**. Clicking **Play** sends
`playVideo` to the content script and closes the popup. Dark UI; restricted pages (`chrome://`,
web store) simply yield no DOM videos (`lastError` swallowed).

**Inline previews.** `popup.html` also loads `vendor/hls.light.min.js` (before `popup.js`) so
each row can show a muted live preview thumbnail. `startPreview()` plays progressive files
natively and HLS through a small hls.js instance (`enableWorker:false`, `maxBufferLength:6`,
`capLevelToPlayerSize`). A stream that fails (CORS/hotlink) just keeps its type-emoji fallback —
no broken tiles. Previews are tracked in `previews[]` and torn down (`clearPreviews`) on every
rescan; closing the popup destroys the context and stops them.

## CORS / hotlink reality (important constraints)

- hls.js currently uses its **default loader**, so HLS playback works when the CDN sends permissive
  CORS headers (most public tube-site CDNs do). Hotlink-protected streams that check `Referer` or
  omit `Access-Control-Allow-Origin` will fail with the "blocked" message. The intended future fix
  is a background-proxied hls.js loader (the service worker has `host_permissions` and can fetch
  cross-origin without CORS) — not yet implemented.
- **Out of scope, don't try:** `blob:`/MediaSource streams (YouTube) and DRM/EME (Netflix). We
  bundle `hls.light` specifically because it drops EME. These can't be extracted to a playable URL.

## Permissions

`storage`, `tabs`, `webRequest`, and `host_permissions: <all_urls>`. `webRequest` + `<all_urls>`
are load-bearing for the sniffer — don't remove them. Avoid adding more without a strong reason.

## Vendored dependency

`vendor/hls.light.min.js` is hls.js **1.5.17** (`hls.light` build — no EME/alt-audio/subtitles).
To update, re-download from `https://cdn.jsdelivr.net/npm/hls.js@<ver>/dist/hls.light.min.js`
and re-test `test.html`. It loads both as a content script (shares `content.js`'s isolated world)
**and** as a plain `<script>` in `popup.html` (for inline previews). It is not a web-accessible
resource — only the extension's own scripts/pages reference it.

## Keep CLAUDE.md in sync

`CLAUDE.md` is a near-verbatim copy of this file for Claude Code. When you change architecture,
detectors, permissions, or the CORS notes here, mirror the edits into `CLAUDE.md` so they don't drift.
