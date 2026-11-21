// lex-turn-follow.js — an answer the server writes now, followed by a window that does not hold its
// stream (2026-11-20, supabase/migrations/chat_turn_live.sql). One rule for the page, the Mac app and
// the extension; the iPhone has the same rule in Swift (ios/Lex/Lex/TurnFollow.swift).
//
// Gennady sent a message, went to another chat and came back: only his question stood — no dots, no
// grey line of work, no Stop — while Claude Code worked minutes without a word. Now the chat read
// gives such an answer with its state, its number and the step it is at (`live`), the window draws
// it as the stream, and follows it to its end by its number: the database's signal «chat» of that
// number wakes it, its fate (lex_op_state) says the words, the step and the end.
//
// The follow asks nothing on a timer (Gennady, 21.11.2026: «по часам идут только сроки, где время и
// есть событие; новость приходит сигналом»). The fate is read once when the follow starts, once at
// every signal «chat» of the answer or its chat, once when the channel of signals is open again and
// its journal could not say what was missed (the follower gets null), and once when the server has
// been silent as long as it itself gives the answer before it counts it lost (the deadline, below).
// A reading that failed is tried again by the ladder of the sections (LexSection.AGAIN_MS).
//
//   LexTurnFollow.isRunning(turn)      — a turn of a read (a server row or a window's turn) is an
//                                        answer the server writes now: drawn as the stream, followed
//   LexTurnFollow.next(seen, fate)     — one answer of lex_op_state against what the window shows:
//                                        { text, step, end } — the words to add, the step to draw,
//                                        and whether the follow ends: 'done', 'stopped' or 'lost'
//                                        (the server writes it no more, or there is no such message)
//   LexTurnFollow.quietMs(fate)        — the deadline after a reading: how long the server may be
//                                        silent before the fate can have changed by the clock alone
//                                        (null — the fate does not change by the clock)
//   LexTurnFollow.follow(o)            — the follow itself, the same for every window (below)
(function (global) {
  'use strict';

  // The server's own deadlines (supabase/migrations/chat_turn_live.sql, chat_turn_fate.sql): an answer
  // with no word and no beat for 90 s is not written any more (lex_turn_running); a message taken but
  // not begun for 5 minutes is not there (lex_op_state). A fate that says how much of it is left
  // (`lost_in`, seconds — chat_turn_signal_only.sql) is taken at its word; one a second past it the
  // server has surely crossed its own line.
  const RUNNING_MS = 90000;
  const PENDING_MS = 5 * 60000;
  const PAST_MS = 1000;
  // Not a word from the server — the reading itself fails — this long: no connection. 20 s while it
  // is not known that the server has the message, 90 s once it is (its answer is written there all
  // the same). The window then says so; Retry goes with the same number.
  const SILENT_UNKNOWN_MS = 20000;
  const SILENT_KNOWN_MS = 90000;

  // A server row (op_id) or a window's turn (opId): an answer, with its number and `live`.
  function isRunning(t) {
    if (!t || t.role !== 'assistant') return false;
    const op = t.opId || t.op_id;
    return !!(op && t.live && typeof t.live === 'object');
  }

  // The step a read or a fate names, as the stream's frame of work names it (lex_proxy_tool).
  function stepOf(s) {
    if (!s || typeof s !== 'object' || s.seq == null) return null;
    return { seq: s.seq, name: s.name || '', label: s.label || '', line: s.line || '', cc: s.cc === true };
  }

  // seen — what the window shows of the answer: { text, stepSeq }. It is not changed here: the
  // caller adds `text` to what it shows and takes `step.seq` as the step it draws.
  function next(seen, fate) {
    const out = { text: '', step: null, end: null };
    if (!fate || typeof fate !== 'object') return out;
    if (fate.status === 'none') { out.end = 'lost'; return out; }
    // Still being taken (no answer yet): wait.
    if (fate.status !== 'begun') return out;
    const shown = String((seen && seen.text) || '');
    const content = String(fate.content || '');
    // The answer only grows while it is written; a content that is not a continuation of what is
    // shown (cut by a Stop) adds nothing — the end says the rest.
    if (content.length > shown.length && content.startsWith(shown)) out.text = content.slice(shown.length);
    const streaming = fate.state === 'streaming';
    if (!streaming) { out.end = fate.state === 'stopped' ? 'stopped' : 'done'; return out; }
    // The server writes it no more (it died mid-turn, lex_turn_running): no dots, no step and no
    // Stop are left behind; what came of it stays.
    if (fate.alive === false) { out.end = 'lost'; return out; }
    const step = stepOf(fate.step);
    if (step && step.seq !== (seen ? seen.stepSeq : null)) out.step = step;
    return out;
  }

  // Every other change of the fate comes by the signal «chat»: words, a step, the end, a release.
  // Only these two change by the clock, on the server's side, with no write to signal them.
  function quietMs(fate) {
    if (!fate || typeof fate !== 'object') return null;
    const n = fate.lost_in;
    const own = typeof n === 'number' && Number.isFinite(n) ? Math.max(0, n * 1000) : null;
    if (fate.status === 'pending') return (own == null ? PENDING_MS : own) + PAST_MS;
    if (fate.status === 'begun' && fate.state === 'streaming' && fate.alive !== false) {
      return (own == null ? RUNNING_MS : own) + PAST_MS;
    }
    return null;
  }

  // ── the follow ────────────────────────────────────────────────────────────────────────────────
  //   o.op, o.chat     the number of the message and its chat: a signal «chat» that names either
  //                    makes a reading
  //   o.seen           { text, stepSeq } — what the window shows of the answer now
  //   o.read()         → Promise of the fate (lex_op_state); rejects when the server was not heard
  //   o.signals        the channel (LexAccountEvents: follow(events, run) → { stop() }), or null
  //   o.known          the server is known to have the message (a follow that starts from a read)
  //   o.open()         optional: the window still wants the answer (false — the follow ends 'quit')
  //   o.onBegun()      the server writes the answer: Stop now goes by its number
  //   o.onText(text)   words to add to what the window shows
  //   o.onStep(step)   the step of the work to draw (the grey line)
  // → { stop(how), done }   done resolves once with { end, fate }; end is
  //   'done' | 'stopped' | 'lost'  — as next() says: the answer stands, as far as it came
  //   'none'                       — the server does not have the message
  //   'silent'                     — the server was not heard (SILENT_UNKNOWN_MS / SILENT_KNOWN_MS)
  //   'quit'                       — the window let it go (o.open() said no), or stop(how) — how
  // Never two readings at once: what comes during one makes one more after it, not one each. After a
  // reading that went, one timer waits for the deadline (quietMs); after one that failed, for the
  // next step of the ladder, never past the moment the server counts as not heard. The timer is a
  // deadline, not a question: every signal and every reading moves it.
  function follow(o) {
    const seen = { text: String((o.seen && o.seen.text) || ''), stepSeq: o.seen && o.seen.stepSeq != null ? o.seen.stepSeq : null };
    let over = false;
    let busy = false;
    let again = false;
    let timer = 0;
    let fails = 0;
    let known = !!o.known;
    let begun = false;
    let heard = Date.now();
    let finish = null;
    const done = new Promise((r) => { finish = r; });
    const pauses = () => (global.LexSection && Array.isArray(global.LexSection.AGAIN_MS) ? global.LexSection.AGAIN_MS : []);
    const arm = (ms) => {
      clearTimeout(timer);
      timer = setTimeout(() => { timer = 0; look(); }, Math.max(0, ms));
    };
    let follower = null;
    function end(how, fate) {
      if (over) return;
      over = true;
      clearTimeout(timer);
      timer = 0;
      if (follower) { try { follower.stop(); } catch (_) { /* gone */ } }
      finish({ end: how, fate: fate || null });
    }
    function take(s) {
      if (s.status === 'none') { end('none', s); return; }
      known = true;
      if (s.status === 'begun') {
        if (!begun) { begun = true; if (o.onBegun) o.onBegun(); }
        const n = next(seen, s);
        if (n.text) { seen.text += n.text; if (o.onText) o.onText(n.text); }
        if (n.step) { seen.stepSeq = n.step.seq; if (o.onStep) o.onStep(n.step); }
        if (n.end) { end(n.end, s); return; }
      }
      const q = quietMs(s);
      if (q != null) arm(q);
    }
    function failed() {
      fails += 1;
      const left = heard + (known ? SILENT_KNOWN_MS : SILENT_UNKNOWN_MS) - Date.now();
      if (left <= 0) { end('silent'); return; }
      const list = pauses();
      arm(list.length ? Math.min(list[Math.min(fails - 1, list.length - 1)], left) : left);
    }
    function look() {
      if (over) return;
      if (busy) { again = true; return; }
      if (o.open && !o.open()) { end('quit'); return; }
      clearTimeout(timer);
      timer = 0;
      busy = true;
      Promise.resolve()
        .then(() => o.read())
        .then((s) => {
          if (over) return;
          if (!s || typeof s !== 'object') throw new Error('no fate');
          // The window let the answer go while it was read: nothing of it is drawn.
          if (o.open && !o.open()) { end('quit'); return; }
          fails = 0;
          heard = Date.now();
          take(s);
        })
        .catch(() => { if (!over) failed(); })
        .then(() => {
          busy = false;
          if (again && !over) { again = false; look(); }
        });
    }
    if (o.signals && typeof o.signals.follow === 'function') {
      follower = o.signals.follow(['chat'], (sig) => {
        const p = sig && sig.payload;
        if (!sig || (p && ((o.op && p.op === o.op) || (o.chat && p.chat === o.chat)))) look();
      });
    }
    look();
    return { stop(how) { end(how || 'quit'); }, done, seen };
  }

  global.LexTurnFollow = {
    isRunning, next, stepOf, quietMs, follow,
    RUNNING_MS, PENDING_MS, PAST_MS, SILENT_UNKNOWN_MS, SILENT_KNOWN_MS,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
