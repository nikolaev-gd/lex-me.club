// voice/history-injector.js — Gemini Live prior-history replay.
//
// Mirrors shared.js seedGeminiVoiceFromHistory (line ~3095). Three paths,
// chosen by the Live model's API contract:
//
//   1. gemini-3.1-flash-live-preview  — server accepts
//        clientContent.turns[] with real roles (user/model) + turnComplete:
//        true ONLY IF setup carried historyConfig.initialHistoryInClient
//        Content:true. Use this for new Live models.
//
//   2. legacy Gemini Live (e.g. gemini-2.0-flash-live-001) — server does
//        NOT accept role:'model' in clientContent. Pack the whole history
//        into a SINGLE user-turn body with [history] markers and turn
//        Complete:false (so the model doesn't reply to the seed).
//
//   3. native-audio models (gemini-2.5-flash-native-audio-*) — Google
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

  function isNewLivePath(voiceApiModel) {
    return voiceApiModel === 'gemini-3.1-flash-live-preview';
  }

  function isNativeAudio(voiceApiModel) {
    // Native-audio family — Google ignores clientContent history.
    return typeof voiceApiModel === 'string'
      && voiceApiModel.indexOf('native-audio') !== -1;
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
    if (isNewLivePath(voiceApiModel)) {
      const liveTurns = turns.map((t) => ({
        role: t.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: t.content || '' }],
      }));
      return { clientContent: { turns: liveTurns, turnComplete: true } };
    }
    // Legacy path — pack into one user-turn with [history] markers.
    const lines = turns.map((t) =>
      `${t.role === 'assistant' ? 'Assistant' : 'User'}: ${t.content || ''}`);
    const packed = `[history]\n${lines.join('\n')}\n[/history]`;
    return {
      clientContent: {
        turns: [{ role: 'user', parts: [{ text: packed }] }],
        turnComplete: false,
      },
    };
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
          path: isNewLivePath(voiceApiModel) ? 'initial-history-in-client-content' : 'packed-user-turn',
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
