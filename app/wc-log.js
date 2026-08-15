// webchat/wc-log.js — the logging gate, and the two globals the shared
// teacher core expects to find.
//
// The extension's lex-debug.js does this job over there. It is not loaded here
// on purpose: it is registered into three realms with a table in its header
// about which, and none of that applies to a page that has exactly one. What
// the core actually needs from it is two names — `lexLog` and `lexDebug` — and
// those are twelve lines, not a shared dependency.
//
// Default is SILENT, the same as the extension. console.warn and console.error
// are never gated: they are the only trace left when something breaks on a
// real person's machine. Turn the rest on from the console with
// `lexDebug.enable()`; a reload puts it back.
(function (global) {
  'use strict';

  let enabled = false;
  try {
    // Survives a reload, which is what makes it usable while chasing a bug
    // that only appears during boot.
    enabled = localStorage.getItem('wcDebug') === '1';
  } catch (_) { /* private mode */ }

  global.lexDebug = {
    get enabled() { return enabled; },
    enable() {
      enabled = true;
      try { localStorage.setItem('wcDebug', '1'); } catch (_) {}
      return 'lex debug logging: on';
    },
    disable() {
      enabled = false;
      try { localStorage.removeItem('wcDebug'); } catch (_) {}
      return 'lex debug logging: off';
    },
  };

  global.lexLog = function lexLog() {
    if (enabled) console.log.apply(console, arguments);
  };
})(typeof self !== 'undefined' ? self : globalThis);

