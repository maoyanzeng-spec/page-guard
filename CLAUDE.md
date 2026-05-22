# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Loading and Testing

No build step — the extension is pure vanilla JS loaded directly by Chrome.

1. Open `chrome://extensions/`, enable **Developer mode**, click **Load unpacked**, and select this directory.
2. After any code change, click the reload icon on the extension card.
3. Open `test.html` in a browser tab (via a local server or `file://`) with the extension active to manually trigger each detector and verify the risk score and badge update.

## Architecture

This is a **Manifest V3** Chrome extension with three execution contexts that communicate via messages:

### `main-world.js` → `content.js` (via `postMessage`)
`main-world.js` runs in the **page's own JS context** (`"world": "MAIN"` in manifest). It patches browser APIs (`window.open`, `Notification.requestPermission`, `HTMLAnchorElement.prototype.click`, `URL.createObjectURL`) *before* any page script can call them. When an API is intercepted, it signals `content.js` via `window.postMessage({ _pageguard: true, type, detail })`. Always check for the `_pageguard` marker before acting on a message.

### `content.js` — isolated world, DOM checks and badge
Runs in Chrome's isolated world. Responsibilities:
- Listens for `postMessage` signals from `main-world.js`
- Performs DOM-based checks: external links, fake download/play buttons, meta-refresh redirects, hidden cross-origin iframes, floating ads
- Manages the floating badge (`#pageguard-badge`) injected into every page
- Forwards risk state to the background via `chrome.runtime.sendMessage({ action: 'updateRisk' })`
- Re-runs DOM checks on a 500ms debounced `MutationObserver` for dynamic content
- Resets state on SPA navigation (hooks `pushState`/`replaceState`/`popstate`/`hashchange`)

### `background.js` — service worker
Persists per-tab risk state in `chrome.storage.local` (key `tab_<tabId>`), updates the toolbar badge color and text, and maintains a capped attempt log (max 100 entries, key `attempt_log`). Cleans up storage on tab close and navigation.

### `popup.html` + `popup.js`
Popup queries the active tab's content script (`getState` message) for the current score and issues, then reads the attempt log from storage. Renders a circular gauge, issue list, and blocked-attempt history.

## Risk Score Rules

- Scores are **additive and capped at 100**. Each issue type fires at most once per page load (deduped by `type` in the `issues` array).
- Thresholds: **< 30** = low (green `#388e3c`), **30–59** = medium (orange `#f57c00`), **≥ 60** = high (red `#c62828`). These same colors are used in the badge, toolbar badge, and gauge.
- Point values per detector: popup 30, notification 35, drivebydownload 50, redirect 35, iframe 30, fakeplay 40, links 20, download 25, floatingad 20.

## Floating Ad Detector

`checkFloatingAds()` in `content.js` flags a `position: fixed` element as an ad if it meets **any** of:
1. Its `id` or `class` matches `AD_PATTERN` (ad, banner, sponsor, adsense, adsbygoogle, etc.)
2. It contains an `<iframe>` (typical for third-party ad serving)
3. It has a close button **and** covers > 5% of the viewport area

**Close sequence:** `findCloseBtn(el)` searches first by `aria-label`/`title`/CSS class hints (`.close`, `.dismiss`, `.btn-close`, etc.), then by button text (`×`, `close`, `dismiss`, `skip`, `got it`). If a button is found it is clicked; a 300 ms `setTimeout` then re-checks computed style and force-hides the element with `display: none !important` if it is still visible. If no button is found the element is hidden immediately.

Each element is stamped `_pgAdBlocked = true` (in the isolated world — not readable from page context via `page.evaluate`) to prevent re-processing on MutationObserver rescans.

## Key Constraints

- `badge.css` uses `!important` on every rule to resist host-page stylesheets overriding the badge.
- `main-world.js` must never use any Chrome extension APIs (no `chrome.*`) — it runs in the page context and has no access to them.
- The extension requests only `storage` and `tabs` permissions; avoid adding broader permissions without a strong reason.
