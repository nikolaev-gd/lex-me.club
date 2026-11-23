// lex-busy.js — the press and the wait, the same on every surface (STANDARD.md, В7.74).
//
// Gennady 23.11.2026: «if something lags, nothing shows; I press the microphone and cannot see that it is
// starting». Two rules, one module, so no screen has to remember them:
//
//   1. THE PRESS IS SEEN IN THE NEXT FRAME. Every pressable thing of Lex dims under the finger or the cursor
//      (`is-lex-pressed`, lex-busy.css) — a button, a row of a list, an item of a menu, whatever its own style
//      does or forgets. A touch waits 60 ms first: a finger that starts a scroll is not a press.
//   2. A WAIT LONGER THAN 0.2 s IS SEEN. A small control that waits — a button, an icon — shows the ring in
//      place of its face and takes no second press until it is done; a wide one (a row of a list, an item of a
//      closed menu, anything gone from the screen) gives its wait to the line: a thin running stripe at the top
//      of the window of Lex. A wait shorter than 0.2 s shows nothing (no flicker); a shown one stays 0.25 s at
//      least.
//
// What waits is known two ways:
//   - by itself: a request to the server of Lex (`fetch` of /rest/v1/, /functions/v1/, /storage/v1/ on the page
//     and in the Mac app; `chrome.runtime.sendMessage` in the extension) started within 0.4 s of a press belongs
//     to that press. Streams of answers, voice, dictation and the heartbeats are not a wait of a press
//     (QUIET_URL, QUIET_TYPE), and the message box keeps its own states (AUTO_OFF): its arrow turns into Stop,
//     and a ring there would lock Stop;
//   - by name: LexBusy.track(el, promise) / LexBusy.start(el) → stop() for a wait that is not a request (the
//     microphone opening, a route asked of the catalog).
//
// Loaded by the page (webchat/index.html, the first script: it must wrap fetch before anybody keeps a copy of
// it), and by the extension (lex-surface-deps.js right after lex-debug.js; manifest.json both blocks). In the
// extension it runs in pages that are not Lex (YouTube and every site): it touches only the panel of Lex there
// (LEX_SEL), never a button of the site. The iPhone has the same two rules in Parts/Busy.swift.
(function (global) {
  'use strict';
  if (global.LexBusy || typeof document === 'undefined') return;

  const DELAY_MS = 200;      // a wait shorter than this shows nothing
  const MIN_SHOW_MS = 250;   // a shown ring or line stays at least this long
  const ARM_MS = 400;        // a request started this soon after a press belongs to it
  const AUTO_CAP_MS = 20000; // a wait found by itself is never shown longer than this
  const TOUCH_MS = 60;       // a finger dims the thing after this, a scroll cancels first
  const PRESSED_MIN_MS = 100;
  const WIDE_PX = 200;       // wider than this — a row: its wait goes to the line

  // The panel of Lex inside a page of another site; on the page of Lex everything is Lex (configure).
  const LEX_SEL = '[data-lex-busy-host], .ytvocab-popup, .ytvocab-chat-surface, [class^="lex-"], [class*=" lex-"]';
  // Where the line runs: the panel of the extension; on the page — the top of the window.
  const HOST_SEL = '[data-lex-busy-host], .ytvocab-chat-surface';
  const CONTROL_SEL = 'button, [role="button"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], '
    + '[role="tab"], [role="option"], [role="switch"], [role="link"], a[href], summary, .lex-press';
  const TYPING_SEL = 'input:not([type="button"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]), '
    + 'textarea, select, [contenteditable=""], [contenteditable="true"]';
  // Their own states: the message box (the arrow becomes Stop), the dictation bar, the voice screen.
  const AUTO_OFF = '[data-lex-busy="off"], .wc-composer, .ytvocab-chat-input-wrapper, .lex-dictation-bar, .wc-voice-screen';
  const LEX_URL = /\/(rest|functions|storage)\/v1\//;
  const QUIET_URL = /\/functions\/v1\/(llm-proxy|voice-|dictation|transcribe|realtime)|lex_chat_presence|lex_missed_summary|lex_changes_since/;
  const QUIET_TYPE = /^(CHAT_MESSAGE|STOP_STREAM|LEX_CHAT_PRESENCE|LEX_DIRECT_VOICE|LEX_VOICE|VOICE_|DICTATION|LEX_DICTATION|LEX_TRANSCRIBE|TRANSCRIBE|GET_|LEX_HAS_VALID_TOKEN|LEX_OP_STATE|LEX_LOG|LOG_)/;

  // 'all' — the page of Lex, where everything is Lex (`data-scope="all"` on its script tag); 'lex' — the panel of
  // Lex inside another site.
  let scope = (document.currentScript && document.currentScript.dataset && document.currentScript.dataset.scope === 'all')
    ? 'all' : 'lex';
  const now = () => (global.performance && performance.now) ? performance.now() : Date.now();

  function inScope(el) { return scope === 'all' || !!(el && el.closest && el.closest(LEX_SEL)); }
  function isDisabled(el) {
    return !!(el.disabled || el.getAttribute('aria-disabled') === 'true' || (el.closest && el.closest('[inert]')));
  }
  // The pressable thing under a press: a control by its tag or role; a row drawn as a div — by its cursor.
  function controlOf(target) {
    let el = target && (target.nodeType === 1 ? target : target.parentElement);
    if (!el || !el.closest) return null;
    if (el.closest(TYPING_SEL)) return null;
    const c = el.closest(CONTROL_SEL);
    if (c) return isDisabled(c) ? null : c;
    for (let n = el, i = 0; n && n !== document.body && n !== document.documentElement && i < 6; n = n.parentElement, i++) {
      let cur = '';
      try { cur = getComputedStyle(n).cursor; } catch (_) { return null; }
      if (cur === 'pointer') return isDisabled(n) ? null : n;
    }
    return null;
  }
  function isWide(el) {
    const r = el.getBoundingClientRect();
    return r.width > WIDE_PX;
  }
  function isShown(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // ── 1. The press ─────────────────────────────────────────────────────────
  let pressedEl = null;
  let pressedAt = 0;
  let touchTimer = null;
  function pressOn(c, wide) {
    pressedEl = c;
    pressedAt = now();
    c.classList.add('is-lex-pressed');
    if (wide) c.classList.add('is-lex-wide');
  }
  function release() {
    if (touchTimer) { clearTimeout(touchTimer); touchTimer = null; }
    const c = pressedEl;
    if (!c) return;
    pressedEl = null;
    const off = () => c.classList.remove('is-lex-pressed', 'is-lex-wide');
    const left = PRESSED_MIN_MS - (now() - pressedAt);
    if (left > 0) setTimeout(off, left); else off();
  }
  function onDown(e) {
    if (e.button) return; // the main button and touches only
    release();
    const c = controlOf(e.target);
    if (!c || !inScope(c)) return;
    const wide = isWide(c);
    if (e.pointerType === 'touch') {
      touchTimer = setTimeout(() => { touchTimer = null; pressOn(c, wide); }, TOUCH_MS);
    } else {
      pressOn(c, wide);
    }
  }

  // ── 2. The wait ──────────────────────────────────────────────────────────
  const ringCount = new WeakMap(); // element → how many waits show their ring on it
  const lines = new Map();         // host (null — the window) → { el, n }
  let armed = null;                // { el, at, host }
  let quietDepth = 0;

  function hostOf(el) { return (el && el.isConnected && el.closest) ? el.closest(HOST_SEL) : null; }

  function ringOn(el) {
    const n = (ringCount.get(el) || 0) + 1;
    ringCount.set(el, n);
    if (n > 1) return;
    let pos = '';
    try { pos = getComputedStyle(el).position; } catch (_) { /* gone */ }
    if (pos === 'static' || pos === '') { el.style.position = 'relative'; el.dataset.lexBusyPos = '1'; }
    const ring = document.createElement('span');
    ring.className = 'lex-busy-ring' + (el.getBoundingClientRect().height < 32 ? ' is-small' : '');
    ring.setAttribute('aria-hidden', 'true');
    el.append(ring);
    el.classList.add('is-lex-busy');
    el.setAttribute('aria-busy', 'true');
  }
  function ringOff(el) {
    const n = (ringCount.get(el) || 0) - 1;
    if (n > 0) { ringCount.set(el, n); return; }
    ringCount.delete(el);
    el.classList.remove('is-lex-busy');
    el.removeAttribute('aria-busy');
    el.querySelectorAll(':scope > .lex-busy-ring').forEach((r) => r.remove());
    if (el.dataset.lexBusyPos) { el.style.position = ''; delete el.dataset.lexBusyPos; }
  }

  function lineOn(host) {
    let rec = lines.get(host);
    if (!rec) {
      const el = document.createElement('div');
      el.className = 'lex-busy-line' + (host ? ' is-in-host' : '');
      el.setAttribute('role', 'progressbar');
      el.setAttribute('aria-label', 'Loading');
      el.append(document.createElement('span'));
      if (host) {
        try { if (getComputedStyle(host).position === 'static') host.style.position = 'relative'; } catch (_) { /* gone */ }
        host.append(el);
      } else {
        (document.body || document.documentElement).append(el);
      }
      rec = { el, n: 0 };
      lines.set(host, rec);
    }
    rec.n++;
  }
  function lineOff(host) {
    const rec = lines.get(host);
    if (!rec) return;
    rec.n--;
    if (rec.n > 0) return;
    lines.delete(host);
    rec.el.remove();
  }

  // One wait: shown after DELAY_MS, on the control if it is small and on the screen, else on the line.
  // opts: { line: true — always the line; block: false — the control keeps taking presses; cap: ms }.
  function start(target, opts) {
    const o = opts || {};
    const el = (target && target.nodeType === 1) ? target : null;
    const host = el ? hostOf(el) : (armed && armed.host) || null;
    let done = false;
    let shown = null; // 'ring' | 'line'
    let shownAt = 0;
    const show = () => {
      if (done) return;
      shownAt = now();
      if (el && !o.line && isShown(el) && !isWide(el)) {
        shown = 'ring';
        ringOn(el);
        if (o.block === false) el.dataset.lexBusyPass = '1';
      } else {
        shown = 'line';
        lineOn(host);
      }
    };
    const timer = setTimeout(show, DELAY_MS);
    const capTimer = o.cap ? setTimeout(() => stop(), o.cap) : null;
    function stop() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (capTimer) clearTimeout(capTimer);
      if (!shown) return;
      const off = () => {
        if (shown === 'ring') { ringOff(el); if (!ringCount.get(el)) delete el.dataset.lexBusyPass; }
        else lineOff(host);
      };
      const left = MIN_SHOW_MS - (now() - shownAt);
      if (left > 0) setTimeout(off, left); else off();
    }
    return stop;
  }
  function track(target, promise, opts) {
    const stop = start(target, opts);
    Promise.resolve(promise).then(stop, stop);
    return promise;
  }

  // The press that a request started now belongs to, if any.
  function pressOfNow() {
    if (quietDepth > 0 || !armed) return null;
    if (now() - armed.at > ARM_MS) { armed = null; return null; }
    return armed;
  }
  function onClick(e) {
    const c = controlOf(e.target);
    if (!c || !inScope(c)) return;
    // A control that shows its ring takes no second press: the first one is still being done.
    if (c.classList.contains('is-lex-busy') && !c.dataset.lexBusyPass) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (c.closest(AUTO_OFF)) { armed = null; return; }
    armed = { el: c, at: now(), host: hostOf(c) };
  }

  // A request of the page to the server of Lex, within ARM_MS of a press: that press waits for its headers
  // (a stream's body is not waited for).
  function wrapFetch(win) {
    const orig = win && win.fetch;
    if (typeof orig !== 'function' || orig.__lexBusy) return;
    const wrapped = function fetch(input) {
      const p = orig.apply(win, arguments);
      try {
        const press = pressOfNow();
        if (press) {
          const url = typeof input === 'string' ? input : (input && input.url) || String(input || '');
          if (LEX_URL.test(url) && !QUIET_URL.test(url)) track(press.el, p, { cap: AUTO_CAP_MS });
        }
      } catch (_) { /* the request goes on as it is */ }
      return p;
    };
    wrapped.__lexBusy = true;
    win.fetch = wrapped;
  }
  // A message of the panel of the extension to its worker, within ARM_MS of a press: that press waits for the
  // answer (a callback or the promise).
  function wrapSend(obj, name) {
    const orig = obj && obj[name];
    if (typeof orig !== 'function' || orig.__lexBusy) return;
    const wrapped = function () {
      const args = Array.prototype.slice.call(arguments);
      const press = pressOfNow();
      const msg = args.find((a) => a && typeof a === 'object' && typeof a.type === 'string');
      if (!press || !msg || QUIET_TYPE.test(msg.type)) return orig.apply(obj, args);
      const stop = start(press.el, { cap: AUTO_CAP_MS });
      const last = args[args.length - 1];
      if (typeof last === 'function') {
        args[args.length - 1] = function () { stop(); return last.apply(this, arguments); };
      }
      let r;
      try { r = orig.apply(obj, args); } catch (err) { stop(); throw err; }
      if (r && typeof r.then === 'function') r.then(stop, stop);
      else if (typeof last !== 'function') stop();
      return r;
    };
    wrapped.__lexBusy = true;
    try { obj[name] = wrapped; } catch (_) { /* a frozen object: the waits found by name still show */ }
  }

  // Calls made inside fn (its synchronous part) are not a wait of a press: a poll, a heartbeat.
  function quiet(fn) {
    quietDepth++;
    try { return fn(); } finally { quietDepth--; }
  }

  function install() {
    document.addEventListener('pointerdown', onDown, true);
    ['pointerup', 'pointercancel', 'dragstart'].forEach((t) => document.addEventListener(t, release, true));
    document.addEventListener('click', onClick, true);
    wrapFetch(global);
    try {
      if (global.chrome && chrome.runtime && chrome.runtime.id) wrapSend(chrome.runtime, 'sendMessage');
    } catch (_) { /* not the extension */ }
  }

  install();

  global.LexBusy = Object.freeze({
    // 'all' on the page of Lex (everything there is Lex); 'lex' — only the panel of Lex inside another site.
    configure(o) { if (o && (o.scope === 'all' || o.scope === 'lex')) scope = o.scope; },
    start,
    track,
    quiet,
    // For the tests (dev-tools/test-lex-busy.mjs).
    _: { controlOf, DELAY_MS, MIN_SHOW_MS, ARM_MS, LEX_URL, QUIET_URL, QUIET_TYPE },
  });
})(typeof self !== 'undefined' ? self : globalThis);
