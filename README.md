# Clean Player

A Chrome extension that detects the **real video stream** on a page and plays it in a
draggable, resizable, ad-free **floating player** — so you can watch the main video without
the surrounding page, ads, or pop-ups.

> Previously "Page Guard", a risk-scoring / ad-blocking extension. It has been repurposed into
> a video grabber + safe player.

## How it works

1. As a page loads, the extension **sniffs network traffic** for video streams and ranks them
   by size/resolution — the biggest is almost always the real feature (small clips are ads/previews).
2. Click the toolbar icon to see the detected streams. The top one is tagged **Main**.
3. Hit **Play** and the video opens in a floating overlay you can **drag anywhere** and
   **resize freely** from the corner. Its size and position are remembered.

Supported streams:

| Type | Example | Playback |
|---|---|---|
| Progressive | `.mp4`, `.webm`, `.mov` | Native `<video>` |
| HLS (adaptive) | `.m3u8` | Bundled [hls.js](https://github.com/video-dev/hls.js) — auto-picks the highest quality |
| DASH | `.mpd` | Detected; native attempt only (no bundled engine) |

**Out of scope:** `blob:`/MediaSource players (YouTube-style) and DRM streams (Netflix) can't be
extracted to a playable URL.

## Installation

1. Clone or download this repository.
2. Open `chrome://extensions/` and enable **Developer mode**.
3. Click **Load unpacked** and select the repository folder.

## Testing

Open `test.html` with the extension active, let the sample MP4 and HLS videos load, then click
the toolbar icon and play each one in the floating player.

## Architecture

Two execution contexts plus a popup, message-passed:

- **`background.js`** — service worker. Uses `chrome.webRequest` to detect media responses,
  reads their `Content-Length`/`Content-Range` for the size heuristic, and keeps a ranked,
  per-tab candidate list (badge shows the count).
- **`content.js`** — isolated content script. Enumerates DOM `<video>` elements and hosts the
  Shadow-DOM floating player (drag + resize + Picture-in-Picture), playing streams via native
  `<video>` or bundled hls.js.
- **`popup.*`** — merges network + DOM candidates, ranks them, and launches the chosen stream.

Requires `storage`, `tabs`, `webRequest`, and `<all_urls>` host access (needed to see media requests).

See `CLAUDE.md` for the detailed developer reference.
