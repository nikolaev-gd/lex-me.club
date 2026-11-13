// lex-account-events.js — the database's signals to an open Lex: one channel per window.
//
// The database sends a signal the moment something of the account changes (a section of
// Profi.ru moved, an entry of Extended Mind came, a command got its answer, the balance moved):
// supabase/migrations/account_signals.sql. It goes through the channel part of the server
// (Supabase Realtime) into the account's own private topic, account:<account id>. This file
// holds that topic open and hands every signal to whoever follows it; nothing in Lex asks the
// server on a timer whether there is something new (Gennady, 2026-11-13).
//
// A signal is a hint, never data: it names what changed, and the follower reads it under its
// own pass, the same reading as before. While the channel is down nothing is read on a timer;
// when it is open again every follower reads once, to catch up with what came meanwhile.
//
// The iPhone has the same in AccountEvents.swift, value for value: the topic, the way in, the
// heartbeat, the pauses after a break. The way in is the one of the voice's events
// (webchat/wc-voice.js, connectServerEvents): a raw socket of the channel part.
//
// No chrome.*: the page and the Mac app load this file (dev-tools/check-webchat-clean.sh).
//
//   const ch = LexAccountEvents.create({ url, key, token })   url — Lex's address, key — the
//                                                               public key, token() — a pass
//   ch.start() / ch.stop()
//   ch.on(event, fn(payload))          → off()
//   ch.onLive(fn(isLive))              → off()
//   ch.follow([events], run(signal), { onLost(isLost) })
//        run(signal) — read what the signal names ({ event, payload }); signal null — read to
//        catch up (the channel is open again). Never two runs at once: what comes during a run
//        makes one more run after it, with the latest signal. onLost — the channel has been
//        down LOST_AFTER_MS.                                        → { stop(), now() }
//   ch.wake()                          the window is back on the screen: is the socket alive?
(function (global) {
  'use strict';

  if (global.LexAccountEvents) return;

  // Without a heartbeat the channel part closes a silent socket; 25 s, as the voice's events.
  const HEARTBEAT_MS = 25000;
  // A heartbeat without an answer this long: the socket is dead, open another.
  const ANSWER_MS = 10000;
  // Coming back to the screen the socket answers this fast, or it is opened again.
  const WAKE_ANSWER_MS = 4000;
  // Pauses before the next try after a break, then the last one again and again.
  const RETRY_MS = [300, 1000, 2000, 5000, 10000, 20000, 30000];
  // The channel down this long: a follower may say so ("No connection to the server").
  const LOST_AFTER_MS = 8000;
  // A fresh pass is handed to the channel this long before the old one ends.
  const PASS_AHEAD_MS = 30000;

  function claimsOf(token) {
    try {
      const part = String(token || '').split('.')[1] || '';
      const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
      const bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
      return JSON.parse(decodeURIComponent(Array.from(bin, (c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join('')));
    } catch (_) {
      return null;
    }
  }
  const accountOf = (token) => { const c = claimsOf(token); return (c && typeof c.sub === 'string' && c.sub) || null; };

  function create(o) {
    const url = String(o.url || '').replace(/\/+$/, '').replace(/^http/, 'ws')
      + '/realtime/v1/websocket?apikey=' + encodeURIComponent(o.key || '') + '&vsn=1.0.0';
    const WS = o.WebSocket || global.WebSocket;
    const log = o.log || ((...a) => { try { console.log('[signals]', ...a); } catch (_) {} });
    const now = o.now || (() => Date.now());
    const later = o.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    const cancel = o.clearTimeout || ((id) => clearTimeout(id));

    const handlers = new Map();   // event → Set(fn)
    const liveFns = new Set();
    let ws = null;
    let topic = null;
    let account = null;
    let ref = 0;
    let joinRef = null;
    let live = false;
    let stopped = true;
    let opening = false;
    let tries = 0;
    let retryTimer = null;
    let beatTimer = null;
    let answerTimer = null;
    let beatWaits = null;
    let passTimer = null;
    let wakeOn = false;

    function setLive(v) {
      if (live === v) return;
      live = v;
      for (const fn of [...liveFns]) { try { fn(v); } catch (e) { log('live handler:', e && e.message); } }
    }

    function send(frame) {
      if (!ws || ws.readyState !== 1) return false;
      try { ws.send(JSON.stringify(frame)); return true; } catch (_) { return false; }
    }

    function clearTimers() {
      for (const t of [retryTimer, beatTimer, answerTimer, passTimer]) if (t) cancel(t);
      retryTimer = beatTimer = answerTimer = passTimer = null;
      beatWaits = null;
    }

    // A break of any kind: the socket goes, the next try comes after a pause.
    function broken(why) {
      const sock = ws;
      ws = null;
      joinRef = null;
      clearTimers();
      setLive(false);
      if (sock) {
        sock.onopen = sock.onmessage = sock.onclose = sock.onerror = null;
        try { sock.close(); } catch (_) {}
      }
      if (stopped) return;
      const pause = RETRY_MS[Math.min(tries, RETRY_MS.length - 1)];
      tries += 1;
      log(`channel down (${why}); again in ${pause} ms`);
      retryTimer = later(() => { retryTimer = null; open(); }, pause);
    }

    // A heartbeat; no answer in `wait` — the socket is dead.
    function probe(wait) {
      if (!ws || beatWaits) return;
      const mine = String(++ref);
      beatWaits = mine;
      send({ topic: 'phoenix', event: 'heartbeat', ref: mine, payload: {} });
      answerTimer = later(() => {
        answerTimer = null;
        if (beatWaits === mine) broken('no answer to the heartbeat');
      }, wait);
    }

    function beat() {
      beatTimer = later(() => {
        beatTimer = null;
        probe(ANSWER_MS);
        if (ws) beat();
      }, HEARTBEAT_MS);
    }

    // The pass of the channel ends with the session's pass: a fresh one goes in before that.
    function planPass(token) {
      if (passTimer) { cancel(passTimer); passTimer = null; }
      const c = claimsOf(token);
      if (!c || !c.exp) return;
      const wait = Math.max(5000, c.exp * 1000 - now() - PASS_AHEAD_MS);
      passTimer = later(async () => {
        passTimer = null;
        if (!ws || !topic) return;
        let next = null;
        try { next = await o.token(); } catch (_) { next = null; }
        if (!ws || !next) return;
        if (accountOf(next) !== account) { broken('another account'); return; }
        send({ topic, event: 'access_token', ref: String(++ref), payload: { access_token: next } });
        planPass(next);
      }, wait);
    }

    async function open() {
      if (stopped || ws || opening) return;
      opening = true;
      let token = null;
      try { token = await o.token(); } catch (_) { token = null; }
      opening = false;
      if (stopped || ws) return;
      if (!token) { broken('no pass'); return; }
      account = accountOf(token);
      if (!account) { broken('a pass without an account'); return; }
      topic = 'realtime:account:' + account;
      let sock;
      try { sock = new WS(url); } catch (e) { broken('socket: ' + (e && e.message)); return; }
      ws = sock;
      sock.onopen = () => {
        if (ws !== sock) return;
        joinRef = String(++ref);
        send({
          topic, event: 'phx_join', ref: joinRef,
          payload: { config: { broadcast: { self: false }, presence: { key: '' }, private: true }, access_token: token },
        });
        beat();
      };
      sock.onmessage = (e) => {
        if (ws !== sock) return;
        let m;
        try { m = JSON.parse(e.data); } catch (_) { return; }
        if (!m) return;
        if (m.event === 'phx_reply') {
          if (m.ref && m.ref === beatWaits) {
            beatWaits = null;
            if (answerTimer) { cancel(answerTimer); answerTimer = null; }
            return;
          }
          if (m.ref === joinRef && m.topic === topic) {
            if (!(m.payload && m.payload.status === 'ok')) {
              broken('refused: ' + JSON.stringify((m.payload && m.payload.response) || {}).slice(0, 200));
              return;
            }
            tries = 0;
            planPass(token);
            setLive(true);
          }
          return;
        }
        if (m.topic !== topic) return;
        if (m.event === 'phx_error' || m.event === 'phx_close') { broken(m.event); return; }
        if (m.event === 'system' && m.payload && m.payload.status === 'error') { broken('system: ' + (m.payload.message || '')); return; }
        if (m.event !== 'broadcast' || !m.payload) return;
        const name = m.payload.event;
        const data = m.payload.payload || {};
        for (const fn of [...(handlers.get(name) || [])]) {
          try { fn(data); } catch (err) { log(`${name} handler:`, err && err.message); }
        }
      };
      sock.onclose = () => { if (ws === sock) broken('closed'); };
      sock.onerror = () => { /* onclose follows */ };
    }

    function on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(fn);
      return () => { const s = handlers.get(event); if (s) s.delete(fn); };
    }

    function onLive(fn) {
      liveFns.add(fn);
      return () => liveFns.delete(fn);
    }

    function follow(events, run, opts) {
      return followOver({ on, onLive, isLive: () => live }, events, run, opts, { later, cancel, log });
    }

    // A window back on the screen (a laptop woken up) may hold a socket that died meanwhile:
    // a dead one is opened again at once, not after the pause.
    function wake() {
      if (stopped) return;
      if (ws) { probe(WAKE_ANSWER_MS); return; }
      if (opening) return;
      if (retryTimer) { cancel(retryTimer); retryTimer = null; }
      tries = 0;
      open();
    }

    return {
      start() {
        if (!stopped) return;
        stopped = false;
        tries = 0;
        open();
        if (!wakeOn && global.document && global.document.addEventListener) {
          wakeOn = true;
          global.document.addEventListener('visibilitychange', () => {
            if (global.document.visibilityState === 'visible') wake();
          });
          if (global.addEventListener) global.addEventListener('online', wake);
        }
      },
      stop() {
        stopped = true;
        broken('stopped');
      },
      on,
      onLive,
      follow,
      wake,
      isLive: () => live,
      account: () => account,
    };
  }

  // A window without a socket of its own (a chat window of the extension: a content script, the
  // side panel) follows the socket another window holds (the extension's service worker), over
  // a line of messages. The same on / onLive / follow as above, so the code that follows does
  // not know which one it has.
  //
  //   createRelay({ connect })   connect(onMessage, onGone) → { close() } opens the line; a
  //                              message is { type: 'live', live } or { type: 'signal', event,
  //                              payload }. A line that broke is opened again after a pause.
  function createRelay(o) {
    const log = o.log || (() => {});
    const later = o.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    const cancel = o.clearTimeout || ((id) => clearTimeout(id));
    const handlers = new Map();
    const liveFns = new Set();
    let line = null;
    let live = false;
    let stopped = true;
    let tries = 0;
    let retryTimer = null;

    function setLive(v) {
      if (live === v) return;
      live = v;
      for (const fn of [...liveFns]) { try { fn(v); } catch (e) { log('live handler:', e && e.message); } }
    }
    function open() {
      if (stopped || line) return;
      try {
        line = o.connect((m) => {
          if (!m) return;
          if (m.type === 'live') { tries = 0; setLive(!!m.live); return; }
          if (m.type !== 'signal') return;
          for (const fn of [...(handlers.get(m.event) || [])]) {
            try { fn(m.payload || {}); } catch (e) { log(`${m.event} handler:`, e && e.message); }
          }
        }, () => {
          line = null;
          setLive(false);
          if (stopped) return;
          const pause = RETRY_MS[Math.min(tries, RETRY_MS.length - 1)];
          tries += 1;
          retryTimer = later(() => { retryTimer = null; open(); }, pause);
        });
      } catch (e) {
        line = null;
        log('relay:', e && e.message);
      }
    }
    // The same follower as the socket's: the code is shared, the source differs.
    const inner = { on, onLive, isLive: () => live };
    function on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(fn);
      return () => { const s = handlers.get(event); if (s) s.delete(fn); };
    }
    function onLive(fn) {
      liveFns.add(fn);
      return () => liveFns.delete(fn);
    }
    return {
      start() { if (!stopped) return; stopped = false; open(); },
      stop() {
        stopped = true;
        if (retryTimer) { cancel(retryTimer); retryTimer = null; }
        if (line) { try { line.close(); } catch (_) {} line = null; }
        setLive(false);
      },
      on,
      onLive,
      follow: (events, run, opts) => followOver(inner, events, run, opts, { later, cancel, log }),
      wake() { if (!line && !stopped) { if (retryTimer) { cancel(retryTimer); retryTimer = null; } tries = 0; open(); } },
      isLive: () => live,
    };
  }

  // follow() over any source that has on / onLive / isLive.
  function followOver(src, events, run, opts, t) {
    const fo = opts || {};
    let over = false;
    let running = false;
    let again;
    let lostTimer = null;
    let lost = false;
    const setLost = (v) => {
      if (lost === v) return;
      lost = v;
      if (fo.onLost) { try { fo.onLost(v); } catch (_) {} }
    };
    const go = (sig) => {
      if (over) return;
      if (running) { again = (again === null || sig === null) ? null : sig; return; }
      running = true;
      Promise.resolve()
        .then(() => run(sig))
        .catch((e) => t.log('follower:', e && e.message))
        .finally(() => {
          running = false;
          if (again !== undefined && !over) { const s = again; again = undefined; go(s); }
        });
    };
    const offs = (events || []).map((name) => src.on(name, (payload) => go({ event: name, payload })));
    const watchLost = () => {
      if (lostTimer) { t.cancel(lostTimer); lostTimer = null; }
      if (src.isLive()) { setLost(false); return; }
      lostTimer = t.later(() => { lostTimer = null; if (!src.isLive() && !over) setLost(true); }, LOST_AFTER_MS);
    };
    const offLive = src.onLive((v) => { watchLost(); if (v) go(null); });
    watchLost();
    return {
      stop() {
        over = true;
        offs.forEach((off) => off());
        offLive();
        if (lostTimer) { t.cancel(lostTimer); lostTimer = null; }
        setLost(false);
      },
      now() { go(null); },
    };
  }

  global.LexAccountEvents = { create, createRelay, accountOf, LOST_AFTER_MS, HEARTBEAT_MS, RETRY_MS };
})(typeof self !== 'undefined' ? self : globalThis);
