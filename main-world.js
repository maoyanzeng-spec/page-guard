// Runs in the PAGE's JS context via manifest "world": "MAIN".
// Overrides risky APIs before any page script can call them, then signals
// the isolated-world content script via postMessage.
(function () {
  'use strict';

  function signal(type, detail) {
    window.postMessage({ _pageguard: true, type: type, detail: detail || null }, '*');
  }

  // ── Block popup via window.open ───────────────────────────────────────────────
  window.open = function () {
    signal('popup');
    return null; // blocked
  };

  // ── Intercept Notification permission ────────────────────────────────────────
  if (window.Notification && typeof Notification.requestPermission === 'function') {
    var _origReqPerm = Notification.requestPermission.bind(Notification);
    Notification.requestPermission = function () {
      signal('notification');
      return _origReqPerm.apply(this, arguments);
    };
  }

  // ── Block drive-by download via programmatic anchor .click() ─────────────────
  var DANGEROUS_EXT = /\.(exe|msi|bat|ps1|scr|cmd|vbs|jar|dmg|pkg|sh|hta|pif|com)\b/i;
  var _origAnchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    var href = this.href || '';
    if (this.download || DANGEROUS_EXT.test(href)) {
      signal('drivebydownload', this.download || href);
      return; // blocked — do not call original
    }
    return _origAnchorClick.apply(this, arguments);
  };

  // ── Block drive-by download via URL.createObjectURL (binary blob) ─────────────
  var _origCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    var result = _origCreateObjectURL.call(URL, obj);
    if (obj instanceof Blob) {
      var t = obj.type || '';
      if (t === '' || !/^(image|text|audio|video|font|application\/json|application\/pdf)/.test(t)) {
        signal('drivebydownload', t || 'unknown blob type');
      }
    }
    return result;
  };
})();
