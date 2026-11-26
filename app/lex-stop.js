// lex-stop.js — one Stop for every chat of Lex (docs/spec/21-chat-canvas.md, «Стоп»; plan PLAN-CHAT-UNIFY, stage 5).
//
// Three things can be stopped from a chat, and they are one control with one parameter — WHOSE it is:
//   turn  — the answer of the model being written (the page's own stream, or one followed from the server's read): the
//           door sends the characters seen (WC_STOP → llm-proxy), the answer stops on the screen at once;
//   agent — the agent of a task chat while its copy says «Working» (folder-agents, op stop): the chat is drawn stopped at
//           once — while the press is on its way and AFTER_MS after (the relay of the base a moment behind) a copy that
//           still says «Working» is drawn stopped;
//   task  — a development task of Lex, its row «mac:N» while it streams (lex_dev_stop, dev_tasks.sql).
// Whose the round button of the field stops is the profile of the chat (`stop` of lex-chat-profile.js: turn | agent |
// null) and what is going on: the page's own answer holds the button over the agent. The task's Stop is never the
// field's (ios/Lex/STANDARD.md В7.77): it stands under its row, and goes through the same controller and the same words.
// A refusal says one thing everywhere: «Not stopped. <why>».
//
// The iPhone mirrors this file: ios/Lex/Lex/LexStop.swift (the same whose, the same hold, the same words). The voice of a
// talk has no Stop of this kind: its round button hangs the talk up (wc-voice.js, VoiceSession.stop) — another action.
//
// No DOM, no chrome.*: lex-message.js (and the extension through it) may read `refusal` when it is loaded.
//   LexStop.WHO, LexStop.AFTER_MS
//   LexStop.fieldWho(profile, { answering, agentWorks }) → 'turn' | 'agent' | null — whose the field's button stops now
//   LexStop.idOf(who, key) / LexStop.parse(id) → the number the field's button carries ({ who, key })
//   LexStop.refusal(err) → 'Not stopped. <why>' (the words of the server's JSON «message» when it sent one)
//   LexStop.create({ doors: { turn(key), agent(key), task(key) }, changed(who, key) }) → {
//     stop(who, key) → Promise<true>; a refusal rejects with an Error whose message (and .words) is refusal(err);
//                      a press while the last one is on its way resolves false and asks nobody;
//     holding(who, key) — pressed: on its way or in the AFTER_MS after (the copy is drawn stopped);
//     pending(who, key) — on its way;
//     settle(who, key)  — the copy says it does not work: the hold after a stop is over (one on its way stays);
//     forget(who, key)  — a new word starts it anew: no hold at all }
(function (root) {
  'use strict';

  const WHO = ['turn', 'agent', 'task'];
  // How long after a Stop went through a copy that still says it works is drawn stopped (agent only: a turn and a task
  // are rewritten by the server's own read).
  const AFTER_MS = 15000;
  const AFTER = { turn: 0, agent: AFTER_MS, task: 0 };
  const WORDS = 'Not stopped. ';

  function fieldWho(profile, o) {
    const s = o || {};
    if (s.answering) return 'turn';
    if (profile && profile.stop === 'agent' && s.agentWorks) return 'agent';
    return null;
  }

  // The field's button carries a number: a turn — its request (as it always did), the others — «who:key».
  const idOf = (who, key) => (who === 'turn' ? String(key == null ? '' : key) : `${who}:${key}`);
  function parse(id) {
    const s = String(id == null ? '' : id);
    for (const who of WHO) if (who !== 'turn' && s.startsWith(who + ':')) return { who, key: s.slice(who.length + 1) };
    return { who: 'turn', key: s };
  }

  function why(err) {
    const m = String((err && err.message) || (typeof err === 'string' ? err : '') || '').trim();
    const said = /"message"\s*:\s*"([^"]+)"/.exec(m);
    return said ? said[1] : (m || 'Try again.');
  }
  function refusal(err) {
    if (err && typeof err.words === 'string') return err.words;
    const w = why(err);
    return w.startsWith(WORDS) ? w : WORDS + w;
  }

  function create(o) {
    const doors = (o && o.doors) || {};
    const changed = (o && typeof o.changed === 'function') ? o.changed : () => {};
    const held = new Map();   // 'who:key' → the moment the hold ends; Infinity while the press is on its way
    const k = (who, key) => `${who}:${key}`;
    function holding(who, key) {
      const until = held.get(k(who, key));
      if (!until) return false;
      if (until !== Infinity && Date.now() > until) { held.delete(k(who, key)); return false; }
      return true;
    }
    const pending = (who, key) => held.get(k(who, key)) === Infinity;
    function settle(who, key) { if (!pending(who, key)) held.delete(k(who, key)); }
    function forget(who, key) { held.delete(k(who, key)); }
    async function stop(who, key) {
      const door = doors[who];
      if (typeof door !== 'function' || pending(who, key)) return false;
      held.set(k(who, key), Infinity);
      changed(who, key);
      try {
        await door(key);
      } catch (err) {
        held.delete(k(who, key));
        changed(who, key);
        const words = refusal(err);
        const e = new Error(words);
        e.words = words;
        throw e;
      }
      const after = AFTER[who] || 0;
      if (after > 0) held.set(k(who, key), Date.now() + after);
      else held.delete(k(who, key));
      changed(who, key);
      return true;
    }
    return { stop, holding, pending, settle, forget };
  }

  root.LexStop = { WHO, AFTER_MS, fieldWho, idOf, parse, refusal, create };
})(typeof window !== 'undefined' ? window : globalThis);
