// voice/thread-writer.js — gated videoThreads writes for LexVoice.
//
// Every voice session (OpenAI Realtime + Gemini Live) ends a turn by calling:
//
//   flushItemsViaSW({videoId, items, noPersistentThread, marker})
//     — APPEND_CONVERSATION_ITEMS message to bg.js, which mirrors into
//       local turns AND piggybacks OpenAI server-side conversation when
//       conversationId already exists.
//
// Gated by `noPersistentThread`. When the caller (LexVoice handle's owning
// surface) opted out of the per-video thread, no write happens. This replaced
// the temporary `activeVoiceNoPersistentThread` gating that v1.10.0 ФИКС 1
// sprayed across shared.js / chat-surface.js / bg.js as a stopgap — gating now
// lives in the voice module itself.
//
// `marker` — in-band surface prefix (config.threadTurnMarker, today only the
// word-click popup's '[word]'). Glued HERE and only here, so the persisted form
// is exactly '[word] [voice] …': renderStoredTurns groups a word breakdown by a
// LEADING '[word] ' (chat-surface.js isWordTurn), and its isVoiceTurn already
// tolerates '[word] ' in front. The reverse order would pass marker stripping
// and keep the voice italics, yet silently fall out of the folded block.
// (The sibling text path glues the same prefix in chat-surface.js's finalize
// persist and _doCommitLastExchange.)

(function (global) {
  'use strict';

  function flushItemsViaSW(opts) {
    const o = opts || {};
    if (!o.videoId || !Array.isArray(o.items) || o.items.length === 0) return;
    // Marker is stored WITHOUT a trailing space (content.js threadTurnMarker:
    // '[word]'); every consumer adds the single space itself.
    const pre = o.marker ? (o.marker + ' ') : '';
    // Через «розетку» (voice/host-chrome.js): в расширении это воркер. У
    // страницы копию беседы ведёт она сама (память открытой беседы в
    // wc-backend.js), общей розетки там нет — и писать некуда.
    // Уид и время реплики едут вместе с текстом и при пометке — иначе копия
    // на устройстве завела бы реплику под случайным уидом рядом с серверной.
    if (!global.LexVoiceHost) return;
    try {
      global.LexVoiceHost.post({
        type: 'APPEND_CONVERSATION_ITEMS',
        videoId: o.videoId,
        items: pre
          ? o.items.map((it) => Object.assign({}, it, { text: pre + it.text }))
          : o.items,
        noPersistentThread: o.noPersistentThread === true,
      });
    } catch (err) {
      console.warn('[lex-voice-thread-writer] flushItemsViaSW failed:', err && err.message || err);
    }
  }

  global.LexVoiceThreadWriter = {
    flushItemsViaSW,
  };
})(typeof self !== 'undefined' ? self : globalThis);
