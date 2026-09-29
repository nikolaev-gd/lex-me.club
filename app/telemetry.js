// voice/telemetry.js — RECORD_VOICE_CALL emitter for LexVoice.
//
// Old voice paths (shared.js singleton) sent RECORD_VOICE_CALL directly
// from finalize callbacks. Module path centralises the dispatch and gates
// it with config.recordCall:
//
//   recordVoiceCall({recordCall:true, payload:{...}}) — fire-and-forget
//                                                       chrome.runtime
//                                                       sendMessage.
//   recordVoiceCall({recordCall:false}) — no-op (tutor surface — never
//                                          writes to public.calls).
//
// The payload shape matches what bg.js recordVoiceCall handler expects.
// Surface decides recordCall:true|false in config.

(function (global) {
  'use strict';

  // v1.11.0 БАГ 5: returns Promise<{inputCost, outputCost, cost_usd} | null>.
  // bg.js recordVoiceCall handler computes cost from breakdown via
  // computeVoiceCost(MODEL_PRICING[apiModel], breakdown) and replies via
  // chrome.runtime sendResponse. Surface receives cost in onAssistantTurnComplete
  // turn object → applies applyCostPill on user + assistant bubbles.
  // Если recordCall:false или payload пустой — sync resolve(null).
  function recordVoiceCall(opts) {
    const o = opts || {};
    if (o.recordCall !== true) return Promise.resolve(null);
    if (!o.payload) return Promise.resolve(null);
    // Через «розетку» (voice/host-chrome.js в расширении).
    return global.LexVoiceHost.send({ type: 'RECORD_VOICE_CALL', payload: o.payload });
  }

  // v1.14.x voice_session: fire-and-forget запись цельной дорожки сеанса
  // (mic on → off, один WAV). Отдельно от recordVoiceCall — у той guard
  // hasExchange отсекает payload без текста. Здесь только audioB64; без него
  // ничего не шлём (пустой сеанс). Reply не ждём (cost не считается).
  function recordVoiceSession(opts) {
    const o = opts || {};
    if (o.recordCall !== true) return;
    if (!o.payload || !o.payload.audioB64) return;
    try { global.LexVoiceHost.post({ type: 'RECORD_VOICE_SESSION', payload: o.payload }); }
    catch (err) { console.warn('[lex-voice-telemetry] recordVoiceSession send failed:', err && err.message || err); }
  }

  global.LexVoiceTelemetry = { recordVoiceCall, recordVoiceSession };
})(typeof self !== 'undefined' ? self : globalThis);
