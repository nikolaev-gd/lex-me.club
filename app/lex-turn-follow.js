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
//   LexTurnFollow.isRunning(turn)      — a turn of a read (a server row or a window's turn) is an
//                                        answer the server writes now: drawn as the stream, followed
//   LexTurnFollow.next(seen, fate)     — one answer of lex_op_state against what the window shows:
//                                        { text, step, end } — the words to add, the step to draw,
//                                        and whether the follow ends: 'done', 'stopped' or 'lost'
//                                        (the server writes it no more, or there is no such message)
(function (global) {
  'use strict';

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

  global.LexTurnFollow = { isRunning, next, stepOf };
})(typeof globalThis !== 'undefined' ? globalThis : this);
