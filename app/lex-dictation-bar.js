// lex-dictation-bar.js — the dictation bar: what the message box shows while a
// dictation records (Gennady's boards of 22.11.2026, STANDARD.md В7.72). One part
// for the web page lex-me.club/app (and so the Mac app) and every window of the
// extension: the main chat, the pronunciation popup, the side panel. Its look is
// lex-dictation-bar.css next door; the numbers are the composer's
// (lex-composer-box.css, «Полоса диктовки»); the iPhone draws the same in SwiftUI.
//
// While recording, the same places of the box hold other things:
//   «+»                → the cross: throw away what this recording said;
//   the field (one line) or the presets (several lines) → the wave of the level;
//   the microphone     → Stop: the text stays in the field;
//   the round button   → the send arrow: stop, wait for the final text, send.
// No text yet — one line: × | wave | ■ | ↑ (the field is still there, under the
// wave, and takes typing). Text — the text on top and the bar under it
// (LexComposerBox.fit reads the class `is-dictating`).
//
// The bar does not record and does not send: the host (webchat/wc-composer.js,
// dictation.js) owns the microphone, the recognizer and the send path, and gets
// the three presses as callbacks. What the bar does itself:
//   - the wave: the level of the same microphone stream, through an AnalyserNode
//     of its own on both paths (the live recognizer's ScriptProcessor hands out
//     4096 samples at 24 kHz, ~170 ms a frame — slower than the 100 ms the wave
//     must answer in);
//   - the muted tail: the words the live recognizer may still rewrite are
//     painted --fg-muted on a mirror under the textarea, while the field still
//     holds the dictation's last write (no edit of the person since);
//   - the last minute (board 9): the host names the moment this recording
//     stops by its own limit (deadline(at)); countdown-lead seconds before it
//     «0:59»…«0:00» stands between the wave and Stop (the wave gets shorter).
//     Before that no time is shown. The bar does not stop anything at 0:00 —
//     the host's own limit path does, as before;
//   - the question on the cross (board 8): a recording of discard-ask-after
//     seconds or longer is not thrown away at once — the bar asks through the
//     host's dialog (handlers.ask, В7.16) while the recording goes on; the
//     recording ends by itself meanwhile — the question is closed
//     (handlers.dismissAsk).
//
// Level → bar height (the same rule on every surface, the contract of the boards):
//   db = 20·log10(rms); norm = clamp((db − floor) / (ceil − floor), 0, 1);
//   norm < 0.08 → the silence dot; else min + 2·round(norm·(max − min) / 2).
// One bar per tick: the peak norm seen during that tick.
//
// No colour lives here (test-page-standard, rule 4): the bars are classes.
// Loaded by the page (webchat/index.html), both content_scripts of manifest.json
// and LexSurfaceDeps — before dictation.js and wc-composer.js. No chrome.* here.
(function (global) {
  'use strict';

  if (global.LexDictationBar) return;

  const SILENCE = 0.08;

  // The numbers of the bar, read from the composer's stylesheet each start.
  function numbers(box) {
    const st = getComputedStyle(box);
    const n = (name) => parseFloat(st.getPropertyValue('--lex-composer-wave-' + name));
    const c = (name) => parseFloat(st.getPropertyValue('--lex-composer-' + name));
    return {
      bar: n('bar'), gap: n('gap'), min: n('min'), max: n('max'), dot: n('dot'),
      tick: n('tick'), floorDb: n('floor-db'), ceilDb: n('ceil-db'),
      lead: c('countdown-lead'), askAfter: c('discard-ask-after'),
    };
  }

  // Seconds left → «0:42» (the countdown never shows a minute or more).
  function clock(sec) {
    const s = Math.max(0, Math.floor(sec));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  // The question of the cross (one wording on every surface, board 8): whole
  // minutes, «1 min» under two.
  function askText(elapsedMs) {
    const min = Math.max(1, Math.floor(elapsedMs / 60000));
    return {
      title: 'The recording is ' + min + ' min long.',
      body: 'Its text will be lost.',
      discard: 'Discard Recording',
      keep: 'Keep Recording',
    };
  }

  // rms (0..1) → the share of the scale (0..1).
  function norm(rms, k) {
    if (!(rms > 0)) return 0;
    const db = 20 * Math.log10(rms);
    const v = (db - k.floorDb) / (k.ceilDb - k.floorDb);
    return v < 0 ? 0 : (v > 1 ? 1 : v);
  }
  // The share → the height of a bar; 0 — the silence dot.
  function height(share, k) {
    if (!(share >= SILENCE)) return 0;
    return k.min + 2 * Math.round(share * (k.max - k.min) / 2);
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  function icon(kind) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const el = document.createElementNS(SVG_NS, kind === 'stop' ? 'rect' : 'path');
    if (kind === 'stop') {
      [['x', 6], ['y', 6], ['width', 12], ['height', 12], ['rx', 3]].forEach(([a, v]) => el.setAttribute(a, v));
    } else {
      el.setAttribute('d', kind === 'cancel' ? 'M6 6l12 12M18 6L6 18' : 'M12 19V5M5 12l7-7 7 7');
    }
    svg.appendChild(el);
    return svg;
  }
  function button(kind, label, onPress) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'lex-dictation-btn lex-dictation-' + kind;
    b.title = label;
    b.setAttribute('aria-label', label);
    b.appendChild(icon(kind));
    // The field keeps its focus (and the caret) when a button is pressed.
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onPress();
    });
    return b;
  }

  const bars = new WeakMap();

  // Where a focus went last, on the whole page from the start (the bar of a
  // field is made at its first recording, after the press that moved the
  // focus): a bar gives the focus back only to a field that had it the moment
  // the microphone was pressed.
  let lastOut = null;
  if (typeof document !== 'undefined') {
    document.addEventListener('focusout', (e) => { lastOut = { from: e.target, to: e.relatedTarget || null, at: Date.now() }; }, true);
  }

  // attach(field, handlers) → the bar of this field (one per field; a second
  // call replaces the handlers; without them it only finds the bar). handlers:
  // onCancel(), onStop(), onSend(),
  // onLayout() — lay the box out again (the host's own fit with its room),
  // ask({ title, body, discard, keep }) → Promise<boolean> — the host's dialog
  //   (В7.16) with a destructive «discard» and a «keep»; true — discard,
  // dismissAsk() — close that dialog (the recording ended under it).
  // Without ask the cross discards at once, however long the recording.
  function attach(field, handlers) {
    let me = bars.get(field);
    if (me) { me.handlers(handlers); return me; }
    me = make(field, handlers);
    bars.set(field, me);
    return me;
  }

  function make(field, firstHandlers) {
    let h = firstHandlers || {};
    const box = field.parentElement;
    const call = (name) => { if (typeof h[name] === 'function') { try { h[name](); } catch (e) { console.warn('[lex-dictation-bar]', name, e && e.message); } } };

    const el = document.createElement('div');
    el.className = 'lex-dictation-bar';
    // The last minute: the time left, for the eye and for a screen reader
    // («N seconds left»; a timer is not read out on every change).
    const countdown = document.createElement('span');
    countdown.className = 'lex-dictation-countdown';
    countdown.setAttribute('role', 'timer');
    countdown.hidden = true;
    const wave = document.createElement('div');
    wave.className = 'lex-dictation-wave';
    wave.setAttribute('aria-hidden', 'true');
    const track = document.createElement('div');
    track.className = 'lex-dictation-wave-track';
    wave.appendChild(track);
    el.append(
      button('cancel', 'Cancel recording', () => pressCancel()),
      wave,
      countdown,
      button('stop', 'Stop recording', () => call('onStop')),
      button('send', 'Send', () => call('onSend')),
    );
    const mirror = document.createElement('div');
    mirror.className = 'lex-dictation-mirror';
    mirror.setAttribute('aria-hidden', 'true');

    let on = false;
    let k = null;
    let heights = [];
    let ctx = null;
    let analyser = null;
    let buf = null;
    let timer = null;
    let sampled = 0;
    let peak = 0;
    let painted = null;     // the value the tail was painted for
    let mutedLen = 0;
    let resizeObs = null;
    let levelFn = null;     // start(null, { level }) — a level without a microphone (the canvas)
    let startedAt = 0;      // when this recording began (the cross asks after discard-ask-after s)
    let endsAt = null;      // when the host's limit stops it (deadline); null — not known
    let shownSec = null;    // the second the countdown shows; null — hidden
    let asking = false;     // the question of the cross is open
    let session = 0;        // grows with every start: an answer to an old question is dropped

    const reduced = () => !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
    const step = () => k.bar + k.gap;

    // ── The wave ───────────────────────────────────────────────────────────
    function slots() {
      const pad = parseFloat(getComputedStyle(wave).paddingLeft) + parseFloat(getComputedStyle(wave).paddingRight);
      const w = wave.clientWidth - (pad || 0);
      return Math.max(1, Math.ceil(Math.max(0, w) / step()) + 2);
    }
    function paintBar(i, hgt) {
      i.classList.toggle('is-dot', !hgt);
      i.style.height = hgt ? hgt + 'px' : '';
    }
    function fill() {
      const n = slots();
      while (heights.length < n) heights.unshift(0);
      while (heights.length > n) heights.shift();
      while (track.children.length < n) track.insertBefore(document.createElement('i'), track.firstChild);
      while (track.children.length > n) track.removeChild(track.firstChild);
      Array.prototype.forEach.call(track.children, (i, x) => paintBar(i, heights[x]));
    }
    function push(hgt) {
      heights.push(hgt);
      heights.shift();
      if (reduced()) {
        // The wave does not move: every bar keeps its place and only its height changes.
        Array.prototype.forEach.call(track.children, (i, x) => paintBar(i, heights[x]));
        return;
      }
      const i = document.createElement('i');
      paintBar(i, hgt);
      track.appendChild(i);
      if (track.firstChild) track.removeChild(track.firstChild);
      // The new bar enters at the right and the whole wave slides left by one step over the tick.
      if (typeof track.animate === 'function') {
        try {
          track.animate([{ transform: 'translateX(' + step() + 'px)' }, { transform: 'translateX(0)' }],
            { duration: k.tick, easing: 'linear' });
        } catch (_) { /* a browser without the Web Animations API just jumps */ }
      }
    }
    function sample() {
      let rms = 0;
      if (analyser) {
        analyser.getFloatTimeDomainData(buf);
        let s = 0;
        for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
        rms = Math.sqrt(s / buf.length);
      } else if (levelFn) {
        rms = Number(levelFn()) || 0;
      } else return;
      const v = norm(rms, k);
      if (v > peak) peak = v;
    }
    // Three samples a tick: a voice shows on the next tick, under 100 ms.
    const PER_TICK = 3;
    // ── The last minute ────────────────────────────────────────────────────
    function showCountdown(sec) {
      if (sec === shownSec) return;
      const was = shownSec;
      shownSec = sec;
      if (sec === null) { countdown.hidden = true; countdown.textContent = ''; countdown.removeAttribute('aria-label'); }
      else {
        countdown.textContent = clock(sec);
        countdown.setAttribute('aria-label', sec + (sec === 1 ? ' second left' : ' seconds left'));
        countdown.hidden = false;
      }
      // Shown or gone — the wave's width changed: its bars are counted again.
      if ((was === null) !== (sec === null) && on) fill();
    }
    function tickCountdown() {
      const lead = k && k.lead;
      if (endsAt === null || !(lead > 0)) { showCountdown(null); return; }
      const left = endsAt - Date.now();
      showCountdown(left < lead * 1000 ? Math.max(0, Math.floor(left / 1000)) : null);
    }
    // When this recording stops by its own limit (ms since the epoch); null —
    // not known (no countdown).
    function deadline(at) {
      endsAt = Number.isFinite(at) && at > 0 ? at : null;
      if (on) tickCountdown();
    }

    // ── The cross ──────────────────────────────────────────────────────────
    function pressCancel() {
      if (!on) return;
      const elapsed = Date.now() - startedAt;
      const after = k && k.askAfter;
      if (typeof h.ask !== 'function' || !(after >= 0) || elapsed < after * 1000) { call('onCancel'); return; }
      if (asking) return;
      asking = true;
      const mine = session;
      let answer;
      try { answer = h.ask(askText(elapsed)); } catch (e) { answer = false; console.warn('[lex-dictation-bar] ask', e && e.message); }
      Promise.resolve(answer).then((yes) => {
        if (session !== mine) return;
        asking = false;
        if (yes === true && on) call('onCancel');
      }, () => { if (session === mine) asking = false; });
    }

    function loop() {
      tickCountdown();
      sample();
      sampled += 1;
      if (sampled < PER_TICK) return;
      sampled = 0;
      push(height(peak, k));
      peak = 0;
    }
    function listen(stream) {
      if (!stream) return;
      try {
        const AC = global.AudioContext || global.webkitAudioContext;
        ctx = new AC();
        const src = ctx.createMediaStreamSource(stream);
        analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        buf = new Float32Array(analyser.fftSize);
        src.connect(analyser);
        // Connected through a silent gain to the output: WebKit (the Mac app) does not
        // reliably pull an analyser that leads nowhere. The person never hears himself.
        const mute = ctx.createGain();
        mute.gain.value = 0;
        analyser.connect(mute);
        mute.connect(ctx.destination);
        if (ctx.state === 'suspended' && typeof ctx.resume === 'function') ctx.resume().catch(() => {});
      } catch (e) {
        console.warn('[lex-dictation-bar] no level meter:', e && e.message);
        unlisten();
      }
    }
    function unlisten() {
      try { if (ctx && ctx.state !== 'closed') ctx.close(); } catch (_) {}
      ctx = null; analyser = null; buf = null;
    }

    // ── The muted tail ─────────────────────────────────────────────────────
    const COPY = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontStretch', 'fontVariant', 'fontFeatureSettings',
      'lineHeight', 'letterSpacing', 'wordSpacing', 'textIndent', 'textTransform', 'tabSize', 'whiteSpace', 'wordBreak',
      'overflowWrap', 'paddingTop', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderBottomWidth',
      'borderLeftWidth', 'borderRightWidth', 'boxSizing', 'direction', 'textAlign'];
    function clearTail() {
      painted = null;
      mutedLen = 0;
      box.classList.remove('lex-dictation-tail');
      mirror.textContent = '';
    }
    function renderTail() {
      if (painted === null) return;
      const v = painted;
      const cut = v.length - mutedLen;
      const st = getComputedStyle(field);
      COPY.forEach((p) => { mirror.style[p] = st[p]; });
      // A scrollbar of the field takes its width off the text: the mirror wraps the same.
      const bar = field.offsetWidth - field.clientWidth
        - (parseFloat(st.borderLeftWidth) || 0) - (parseFloat(st.borderRightWidth) || 0);
      mirror.style.paddingRight = ((parseFloat(st.paddingRight) || 0) + Math.max(0, bar)) + 'px';
      mirror.style.width = field.offsetWidth + 'px';
      mirror.style.height = field.offsetHeight + 'px';
      const a = document.createElement('span');
      a.textContent = v.slice(0, cut);
      const b = document.createElement('span');
      b.className = 'lex-dictation-soft';
      // A field that ends with a line break shows the empty line under it; a div does not.
      b.textContent = v.slice(cut) + (v.endsWith('\n') ? '​' : '');
      mirror.replaceChildren(a, b);
      mirror.scrollTop = field.scrollTop;
      box.classList.add('lex-dictation-tail');
    }
    // The dictation wrote `value` into the field; its last `muted` characters may
    // still change. Painted only while the field still holds exactly that.
    function tail(value, muted) {
      const v = String(value == null ? '' : value);
      const m = Math.min(Number(muted) || 0, v.length);
      if (!on || m <= 0 || field.value !== v) { clearTail(); return; }
      painted = v;
      mutedLen = m;
      renderTail();
    }
    field.addEventListener('input', () => { if (painted !== null && field.value !== painted) clearTail(); });
    field.addEventListener('scroll', () => { if (painted !== null) mirror.scrollTop = field.scrollTop; });

    // ── On and off ─────────────────────────────────────────────────────────
    // start(stream[, { level }]): the bar on, the wave from this stream's level.
    // level() → rms 0..1 stands in for a stream where there is no microphone
    // (the canvas of the parts).
    function start(stream, o) {
      if (!box) return;
      if (!el.parentNode) box.appendChild(el);
      if (!mirror.parentNode) box.insertBefore(mirror, field);
      field.classList.add('lex-dictation-field');
      box.classList.add('lex-dictation-box');
      stop();
      on = true;
      session += 1;
      startedAt = Date.now();
      endsAt = (o && Number.isFinite(o.deadline) && o.deadline > 0) ? o.deadline : null;
      if (o && Number.isFinite(o.startedAt) && o.startedAt > 0) startedAt = o.startedAt;
      levelFn = (o && typeof o.level === 'function') ? o.level : null;
      // The field was focused, and the microphone took the focus by the press
      // and is about to step aside: the focus goes back to the field, so the keys
      // pressed next type there. A field that was not focused stays so (no
      // keyboard opens on a phone by a tap on the microphone).
      const had = typeof document !== 'undefined' ? document.activeElement : null;
      const fromBox = !!had && had !== field && box.contains(had)
        && !!lastOut && lastOut.from === field && lastOut.to === had && Date.now() - lastOut.at < 15000;
      box.classList.add('is-dictating');
      if (fromBox) { try { field.focus({ preventScroll: true }); } catch (_) { /* noop */ } }
      call('onLayout');
      k = numbers(box);
      heights = [];
      track.replaceChildren();
      if (Number.isFinite(k.tick) && k.tick > 0 && Number.isFinite(k.bar)) {
        fill();
        tickCountdown();
        listen(stream);
        timer = setInterval(loop, Math.max(1, Math.round(k.tick / PER_TICK)));
        if (typeof ResizeObserver === 'function') {
          resizeObs = new ResizeObserver(() => { if (on) { fill(); renderTail(); } });
          resizeObs.observe(wave);
        }
      } else {
        console.warn('[lex-dictation-bar] the numbers of the wave are not on this box (lex-composer-box.css)');
      }
    }
    function stop() {
      if (timer) { clearInterval(timer); timer = null; }
      if (resizeObs) { resizeObs.disconnect(); resizeObs = null; }
      unlisten();
      levelFn = null;
      sampled = 0;
      peak = 0;
      clearTail();
      endsAt = null;
      showCountdown(null);
      // The recording ended (the limit, an error, Stop) with the question open:
      // the question goes — there is nothing left to discard by it.
      if (asking) {
        asking = false;
        session += 1;
        if (typeof h.dismissAsk === 'function') { try { h.dismissAsk(); } catch (e) { console.warn('[lex-dictation-bar] dismissAsk', e && e.message); } }
      }
      if (!on) return;
      on = false;
      box.classList.remove('is-dictating');
      call('onLayout');
    }

    // listen(stream): the bar stands already (from the press, before the microphone answered) — the wave
    // takes this stream's level from now on, nothing else restarts. A bar that is off starts.
    function listenTo(stream) {
      if (!on) { start(stream); return; }
      unlisten();
      listen(stream);
    }

    return {
      start,
      listen: listenTo,
      stop,
      tail,
      deadline,
      isOn: () => on,
      handlers(next) { if (next) h = next; },
    };
  }

  global.LexDictationBar = Object.freeze({ attach, norm, height, clock, askText, SILENCE });
})(typeof self !== 'undefined' ? self : globalThis);
