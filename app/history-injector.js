// voice/history-injector.js — Gemini Live prior-history replay.
//
// Two paths, chosen by the Live model's family:
//
//   1. every Gemini Live model but native-audio (3.1 Flash Live, 3.8 Live) —
//        server accepts clientContent.turns[] with real roles (user/model) +
//        turnComplete: true, and does not answer them, ONLY IF setup carried
//        historyConfig.initialHistoryInClientContent: true (live check
//        2026-11-14, dev-tools/probe-gemini-live-voice.ts: without the flag
//        both 3.1 and 3.8 answer the seed aloud). The server puts the flag into
//        the sealed setup by the same family rule (_shared/gemini-live-setup.ts
//        geminiTakesHistoryTurns), and the iPhone builds the same frame
//        (GeminiTurns.seedFrame). Until 2026-11-14 the rule named 3.1 alone,
//        and a third path packed the history into one user turn for the
//        retired gemini-2.0-flash-live-001; no model of the registry took it.
//
//   2. native-audio models (gemini-2.5-flash-native-audio-*) — Google
//        confirmed audio-input ignores clientContent history (see LESSONS
//        2026-05-04). Skip; the workaround is to inject important context
//        into systemInstruction instead — that's the caller's job, not ours.
//
// applyHistoryConfigToSetup(setup, voiceApiModel) — call once on the
// `setup` object BEFORE `ws.send({setup})`. Adds historyConfig.initial
// HistoryInClientContent when the model supports the new path. No-op
// otherwise.
//
// seedAfterSetupComplete(ws, voiceApiModel, priorTurns) — call ONCE in
// the setupComplete handler. Sends the appropriate clientContent payload.
// No-op when priorTurns is empty / null.

(function (global) {
  'use strict';

  function isNativeAudio(voiceApiModel) {
    // Native-audio family — Google ignores clientContent history.
    return typeof voiceApiModel === 'string'
      && voiceApiModel.indexOf('native-audio') !== -1;
  }

  // Role turns after the setup — every Gemini Live model but native-audio.
  function isNewLivePath(voiceApiModel) {
    return typeof voiceApiModel === 'string'
      && voiceApiModel.indexOf('gemini-') === 0
      && !isNativeAudio(voiceApiModel);
  }

  function applyHistoryConfigToSetup(setup, voiceApiModel) {
    if (!setup || typeof setup !== 'object') return;
    if (isNewLivePath(voiceApiModel)) {
      setup.historyConfig = setup.historyConfig || {};
      setup.historyConfig.initialHistoryInClientContent = true;
    }
  }

  function buildSeedPayload(voiceApiModel, priorTurns) {
    const turns = Array.isArray(priorTurns) ? priorTurns : [];
    if (turns.length === 0) return null;
    if (isNativeAudio(voiceApiModel)) {
      // Skip — see file header comment.
      return null;
    }
    if (!isNewLivePath(voiceApiModel)) return null;
    const liveTurns = turns.map((t) => ({
      role: t.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: t.content || '' }],
    }));
    return { clientContent: { turns: liveTurns, turnComplete: true } };
  }

  function seedAfterSetupComplete(ws, voiceApiModel, priorTurns) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const payload = buildSeedPayload(voiceApiModel, priorTurns);
    if (!payload) return;
    try {
      const str = JSON.stringify(payload);
      lexLog('[lex-voice-history-injector]',
        JSON.stringify({
          apiModel: voiceApiModel,
          path: 'initial-history-in-client-content',
          turnsCount: priorTurns.length,
          sentChars: str.length,
        }));
      ws.send(str);
    } catch (err) {
      console.warn('[lex-voice-history-injector] ws.send failed:', err && err.message || err);
    }
  }

  global.LexVoiceHistoryInjector = {
    applyHistoryConfigToSetup,
    seedAfterSetupComplete,
    buildSeedPayload,         // exposed for tests
    isNewLivePath,
    isNativeAudio,
  };
})(typeof self !== 'undefined' ? self : globalThis);
