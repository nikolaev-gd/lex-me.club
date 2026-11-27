// lex-agent-words.js — the words of the last action of an agent: one table for the server and both surfaces
// (docs/spec/29-folders.md, «Раздел «Агенты»»; the contract of the base of 22.11.2026).
//
// What it says. An action of an agent (`last_action` of a row of the list, a line of the journal) carries its kind and,
// most often, a subject of its own. The words of the action are its subject; a subject the base did not write — the word
// of its kind (KIND_WORDS); an unknown kind — nothing (the place that draws it says what stands instead).
//
// One file of truth, read as it is by every place that needs it:
//   - the page and the program for the Mac: a script of webchat/index.html (global LexAgentWords), read by wc-agents.js;
//   - the edge functions `folder-agents` and `today`: `import "./lex-agent-words.js"` in agents-list.ts
//     (globalThis.LexAgentWords);
//   - the iPhone: dev-tools/ios-composer-box.mjs puts KIND_WORDS into composer-box.json (key `agentWords`) at every
//     build, AgentWords.kind (AgentsData.swift) reads it.
// dev-tools/test-agent-words.mjs checks that every place reads this file and that no copy is back. A word is changed
// here and nowhere else.
//
// No dependencies, no DOM, no chrome.*.
(function (root) {
  'use strict';

  const KIND_WORDS = {
    summary: 'Call summary', stitch: 'Calls stitched', deal: 'Deal updated', whois: 'Who is this', digest: 'Morning digest',
    correction: 'Instruction correction', order: 'Profi.ru order', lex_chat: 'Chat in Lex', chat: 'Task chat',
    attachment: 'Attachment read',
  };

  const oneLine = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const kindWord = (kind) => (Object.prototype.hasOwnProperty.call(KIND_WORDS, kind) ? KIND_WORDS[kind] : '');
  // The words of an action: its subject in one line, else the word of its kind; no action — nothing.
  const actionWords = (x) => (x ? oneLine(x.subject) || kindWord(x.kind) : '');

  root.LexAgentWords = { KIND_WORDS, kindWord, actionWords };
})(typeof window !== 'undefined' ? window : globalThis);
