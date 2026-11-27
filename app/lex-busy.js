// lex-busy.js — the press and the wait, the same on every surface (STANDARD.md, В7.74).
//
// Gennady 23.11.2026: «if something lags, nothing shows; I press the microphone and cannot see that it is
// starting». The system of loading he approved 27.11.2026 changed the numbers and took the line at the top of the
// window away everywhere: it was what drew the stripes over a screen that had already stood from the copy.
//
//   1. THE PRESS IS SEEN IN THE NEXT FRAME. Every pressable thing of Lex dims under the finger or the cursor
//      (`is-lex-pressed`, lex-busy.css) — a button, a row of a list, an item of a menu, whatever its own style
//      does or forgets. A touch waits 60 ms first: a finger that starts a scroll is not a press.
//   2. A BUTTON THAT WAITS FOR THE SERVER LONGER THAN 500 ms SHOWS THE RING in place of its words, the same width,
//      and takes no second press; the other buttons of its row go 0.5 and take no press. A shown ring stays 200 ms
//      at least; done well — a tick for 1 s, then the words again.
//   3. A WIDE THING THAT WAITS (a row of a list, an item of a closed menu, anything gone from the screen) SHOWS
//      NOTHING FOR 3 s, then the word of the head: «Updating…», «Connecting…» (the server of Lex does not answer),
//      «Waiting for network…» (the device has no network — that word stands while there is none, wait or not).
//      The place of the word is the line of waiting of the head (wordPlace below); the ladder of a screen without
//      a copy (lex-skeleton.js, В7.87) puts its word there too (slow()).
//   4. AN UPDATE AFTER THE COPY IS NEVER A WAIT. A screen that stood from the copy on the device (lex-reads.js,
//      twice) calls settle(): the press's waits end there, and the request that updates the screen behind it is
//      no wait of the press any more.
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
// (LEX_SEL), never a button of the site. The iPhone has the same rules in Parts/Busy.swift and Parts/Loading.swift.
(function (global) {
  'use strict';
  if (global.LexBusy || typeof document === 'undefined') return;

  const DELAY_MS = 500;      // a wait shorter than this shows nothing on a button
  const MIN_SHOW_MS = 200;   // a shown ring stays at least this long
  const WORD_MS = 3000;      // a wide wait shows the word of the head after this
  const DONE_MS = 1000;      // the tick of a button done well
  const ARM_MS = 400;        // a request started this soon after a press belongs to it
  const SETTLE_MS = 1500;    // settle() ends the waits of a press this young — the copy stood for it
  const AUTO_CAP_MS = 20000; // a wait found by itself is never shown longer than this
  const TOUCH_MS = 60;       // a finger dims the thing after this, a scroll cancels first
  const PRESSED_MIN_MS = 100;
  const WIDE_PX = 200;       // wider than this — a row: its wait shows nothing until the word
  const WORDS = Object.freeze({ updating: 'Updating…', connecting: 'Connecting…', offline: 'Waiting for network…' });

  // The panel of Lex inside a page of another site; on the page of Lex everything is Lex (configure).
  const LEX_SEL = '[data-lex-busy-host], .ytvocab-popup, .ytvocab-chat-surface, [class^="lex-"], [class*=" lex-"]';
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

  // ── 2. The word of the head ──────────────────────────────────────────────
  // Why the screen waits picks the word, not how long: no network on the device — «Waiting for network…» (it
  // stands while there is none); the server of Lex did not answer the last request — «Connecting…»; else a wait
  // longer than 3 s — «Updating…». slow() counts one wait longer than 3 s until its stop().
  let slowCount = 0;
  let offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  let unreachable = false;
  const listeners = new Set();
  const places = [];   // { el, when } — the last one whose when() holds shows the word
  let lastWord = null;

  function word() {
    if (offline) return WORDS.offline;
    if (!slowCount) return null;
    return unreachable ? WORDS.connecting : WORDS.updating;
  }
  function paintPlaces(w) {
    let taken = false;
    // A place with when() (a section with its own bar) goes before the place of the whole window; the latest first.
    const order = places.filter((p) => p.when).reverse().concat(places.filter((p) => !p.when).reverse());
    for (const p of order) {
      let mine = false;
      if (!taken && w && p.el.isConnected) {
        try { mine = !p.when || !!p.when(); } catch (_) { mine = false; }
      }
      if (mine) taken = true;
      const text = mine ? w : '';
      if (p.el.dataset.lexWord === text) continue;
      p.el.dataset.lexWord = text;
      p.el.textContent = '';
      p.el.hidden = !text;
      if (text) {
        const ring = document.createElement('span');
        ring.className = 'lex-busy-ring is-inline';
        ring.setAttribute('aria-hidden', 'true');
        const t = document.createElement('span');
        t.className = 'lex-busy-word-text';
        t.textContent = text;
        p.el.append(ring, t);
      }
    }
  }
  function changed() {
    const w = word();
    paintPlaces(w);
    if (w === lastWord) return;
    lastWord = w;
    document.documentElement.classList.toggle('is-lex-word', !!w);
    for (const fn of listeners) { try { fn(w); } catch (_) { /* a listener's own trouble */ } }
  }
  function slow() {
    let done = false;
    slowCount++;
    changed();
    return function stop() {
      if (done) return;
      done = true;
      slowCount--;
      changed();
    };
  }
  // The line of waiting of the head: el is filled with the ring 14 and the word, and hidden without it. when() —
  // whether this place stands for the screen now (a section with its own bar): the latest place whose when() holds
  // wins, a place without when() (the bar of the window) takes the word otherwise.
  function wordPlace(el, when) {
    if (!el) return () => {};
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.classList.add('lex-busy-word');
    const p = { el, when: typeof when === 'function' ? when : null };
    places.push(p);
    el.dataset.lexWord = '';
    el.hidden = true;
    paintPlaces(word());
    return () => { const i = places.indexOf(p); if (i >= 0) places.splice(i, 1); paintPlaces(word()); };
  }
  function setUnreachable(on) {
    if (unreachable === on) return;
    unreachable = on;
    changed();
  }
  function onNet() {
    offline = navigator.onLine === false;
    if (!offline) unreachable = false;
    changed();
  }

  // ── 3. The wait ──────────────────────────────────────────────────────────
  const ringCount = new WeakMap(); // element → how many waits show their ring on it
  let armed = null;                // { el, at, waits: Set of stop() }
  let lastPress = null;            // the same record, kept after the arming window for settle()
  let quietDepth = 0;

  // The other buttons of the row of a waiting button go 0.5 and take no press.
  function rowOf(el) {
    const p = el.parentElement;
    if (!p) return [];
    return Array.from(p.children).filter((n) => n !== el && n.matches && n.matches('button, [role="button"]'));
  }
  function ringOn(el) {
    const n = (ringCount.get(el) || 0) + 1;
    ringCount.set(el, n);
    if (n > 1) return;
    let pos = '';
    try { pos = getComputedStyle(el).position; } catch (_) { /* gone */ }
    if (pos === 'static' || pos === '') { el.style.position = 'relative'; el.dataset.lexBusyPos = '1'; }
    el.querySelectorAll(':scope > .lex-busy-tick').forEach((r) => r.remove());
    el.classList.remove('is-lex-done');
    const ring = document.createElement('span');
    ring.className = 'lex-busy-ring';
    ring.setAttribute('aria-hidden', 'true');
    el.append(ring);
    el.classList.add('is-lex-busy');
    el.setAttribute('aria-busy', 'true');
    if (!el.dataset.lexBusyPass) for (const b of rowOf(el)) b.classList.add('is-lex-row-wait');
  }
  function ringOff(el, ok) {
    const n = (ringCount.get(el) || 0) - 1;
    if (n > 0) { ringCount.set(el, n); return; }
    ringCount.delete(el);
    el.classList.remove('is-lex-busy');
    el.removeAttribute('aria-busy');
    el.querySelectorAll(':scope > .lex-busy-ring').forEach((r) => r.remove());
    for (const b of rowOf(el)) b.classList.remove('is-lex-row-wait');
    const back = () => { if (el.dataset.lexBusyPos && !ringCount.get(el)) { el.style.position = ''; delete el.dataset.lexBusyPos; } };
    if (!ok || !el.isConnected) { back(); return; }
    // Done well: a tick for 1 s in place of the words, then the words again.
    const tick = document.createElement('span');
    tick.className = 'lex-busy-tick';
    tick.setAttribute('aria-hidden', 'true');
    el.append(tick);
    el.classList.add('is-lex-done');
    setTimeout(() => {
      if (ringCount.get(el)) return;
      tick.remove();
      el.classList.remove('is-lex-done');
      back();
    }, DONE_MS);
  }

  // One wait. A small control on the screen shows the ring after DELAY_MS; anything else (wide, gone, no element)
  // shows nothing and counts toward the word of the head after WORD_MS.
  // opts: { block: false — the control keeps taking presses (and gets no tick); cap: ms }.
  // stop(ok) — ok true: done well, the tick shows where the ring stood.
  function start(target, opts) {
    const o = opts || {};
    const el = (target && target.nodeType === 1) ? target : null;
    let done = false;
    let shown = null; // 'ring' | 'slow'
    let shownAt = 0;
    let slowStop = null;
    const show = () => {
      if (done) return;
      if (el && isShown(el) && !isWide(el)) {
        shown = 'ring';
        shownAt = now();
        if (o.block === false) el.dataset.lexBusyPass = '1';
        ringOn(el);
      }
    };
    const toWord = () => {
      if (done || shown === 'ring') return;
      shown = 'slow';
      slowStop = slow();
    };
    const timer = setTimeout(show, DELAY_MS);
    const wordTimer = setTimeout(toWord, WORD_MS);
    const capTimer = o.cap ? setTimeout(() => stop(), o.cap) : null;
    function stop(ok) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(wordTimer);
      if (capTimer) clearTimeout(capTimer);
      if (shown === 'slow') { slowStop(); return; }
      if (shown !== 'ring') return;
      const tick = ok === true && o.block !== false;
      const off = () => { ringOff(el, tick); if (!ringCount.get(el)) delete el.dataset.lexBusyPass; };
      const left = MIN_SHOW_MS - (now() - shownAt);
      if (left > 0) setTimeout(off, left); else off();
    }
    return stop;
  }
  const answeredWell = (v) => !(v && typeof v === 'object' && (v.ok === false || v.error));
  function track(target, promise, opts) {
    const stop = start(target, opts);
    Promise.resolve(promise).then((v) => stop(answeredWell(v)), () => stop(false));
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
    // A control that shows its ring takes no second press: the first one is still being done; nor do the other
    // buttons of its row.
    if ((c.classList.contains('is-lex-busy') && !c.dataset.lexBusyPass) || c.classList.contains('is-lex-row-wait')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    // The screen may change under the word: its place goes where the screen now has it.
    if (lastWord) [60, 600].forEach((ms) => setTimeout(() => paintPlaces(word()), ms));
    if (c.closest(AUTO_OFF)) { armed = null; return; }
    armed = { el: c, at: now(), waits: new Set() };
    lastPress = armed;
  }
  // A wait found by itself, kept with its press so that settle() can end it.
  function pressWait(press, promise) {
    const stop = start(press.el, { cap: AUTO_CAP_MS });
    press.waits.add(stop);
    const end = (ok) => { press.waits.delete(stop); stop(ok); };
    Promise.resolve(promise).then((v) => end(answeredWell(v)), () => end(false));
    return stop;
  }

  // The screen stood from the copy on the device: what the press waited for is on the screen. Its waits end now,
  // and the requests that update the screen behind it are no wait of it (rule 4).
  function settle() {
    const p = lastPress;
    armed = null;
    if (!p || now() - p.at > SETTLE_MS) return;
    for (const stop of Array.from(p.waits)) stop(false);
    p.waits.clear();
  }

  // A request of the page to the server of Lex, within ARM_MS of a press: that press waits for its headers
  // (a stream's body is not waited for). Every request to the server of Lex tells whether it is reachable.
  function wrapFetch(win) {
    const orig = win && win.fetch;
    if (typeof orig !== 'function' || orig.__lexBusy) return;
    const wrapped = function fetch(input) {
      const p = orig.apply(win, arguments);
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || String(input || '');
        if (LEX_URL.test(url)) {
          p.then(() => setUnreachable(false), (err) => {
            if (!(err && err.name === 'AbortError') && !offline) setUnreachable(true);
          });
          const press = pressOfNow();
          if (press && !QUIET_URL.test(url)) pressWait(press, p);
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
      let end = null;
      const answered = new Promise((resolve) => { end = resolve; });
      pressWait(press, answered);
      const last = args[args.length - 1];
      if (typeof last === 'function') {
        args[args.length - 1] = function (v) { end(v); return last.apply(this, arguments); };
      }
      let r;
      try { r = orig.apply(obj, args); } catch (err) { end({ ok: false }); throw err; }
      if (r && typeof r.then === 'function') r.then(end, () => end({ ok: false }));
      else if (typeof last !== 'function') end();
      return r;
    };
    wrapped.__lexBusy = true;
    try { obj[name] = wrapped; } catch (_) { /* a frozen object: the waits found by name still show */ }
  }

  // Calls made inside fn (its synchronous part) are not a wait of a press: a poll, a heartbeat. A screen that
  // stood from the copy calls settle() instead: its update goes behind awaits.
  function quiet(fn) {
    quietDepth++;
    try { return fn(); } finally { quietDepth--; }
  }

  function install() {
    document.addEventListener('pointerdown', onDown, true);
    ['pointerup', 'pointercancel', 'dragstart'].forEach((t) => document.addEventListener(t, release, true));
    document.addEventListener('click', onClick, true);
    global.addEventListener && global.addEventListener('online', onNet);
    global.addEventListener && global.addEventListener('offline', onNet);
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
    settle,
    slow,
    word,
    wordPlace,
    onWord(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    WORDS,
    // For the tests (dev-tools/test-lex-busy.mjs, check-lex-busy.mjs).
    _: { controlOf, DELAY_MS, MIN_SHOW_MS, WORD_MS, DONE_MS, ARM_MS, LEX_URL, QUIET_URL, QUIET_TYPE },
  });
})(typeof self !== 'undefined' ? self : globalThis);
