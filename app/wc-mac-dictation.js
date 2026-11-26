// webchat/wc-mac-dictation.js — the agent «Диктовка» on the Mac: recording and recognition for the Mac program
// (2026-11-25, Gennady: Scribe moves into Lex as a separate agent with its own settings and every recognizer Lex has).
//
// ── Who does what ───────────────────────────────────────────────────────────
// The Mac program (macos/Sources/LexShell/Dictation*.swift) owns what a page cannot: the global keys (right Cmd+Space,
// right Opt+Space), the pill «В эфире», the dot at the mouse, and the paste into the field of another program. This
// page owns the rest — the microphone, the recognizer, the text — with the same parts as the microphone of the
// field (wc-composer.js): the recognizer catalog (lex-dictation-catalog.js), a file (WAV for the recognizers that need
// it) or a live session (lex-dictation-live.js), the direct mode (the sound goes from the Mac straight to the provider,
// LexDirectProviders through WC_DICTATE / LEX_DICTATION_LIVE_*). Its recognizer and knobs are the AGENT's (the base,
// supabase/functions/dictation-agent), not the chat microphone's; its money belongs to no conversation (noChat).
//
// ── The words between them ───────────────────────────────────────────────────
// Mac → page: window.LexMacDictation.start({clientId, app, appId}) · stop() · cancel() · settings().
// Page → Mac: lexshell.postMessage({word: 'dictation', event, …}):
//   settings {keys_on, model}     — what the agent's settings say (read on load and after every dictation);
//   state {phase}                 — 'recording' (the sound is being written), 'busy' (recognizing), 'idle';
//   level {v}                     — the loudness 0…1, 20 times a second while recording;
//   alarm {kind}                  — 'nosound' (the microphone ended or went mute), 'quiet' (12 s at the floor);
//   result {clientId, text}       — the text to paste; error {clientId, message} — no text, and why.
// After a result or a failure the page writes the dictation's row to the base's log (op «put»).
//
// Active only inside the Mac program that says so (window.__lexShell.dictation), and never in a window of one chat.
(function (global) {
  'use strict';

  const shell = global.__lexShell;
  if (!shell || shell.platform !== 'macos' || !shell.dictation || shell.solo) return;

  const TAG = '[wc-mac-dictation]';
  const QUIET_DB = -55;          // the floor: below it a level counts as silence
  const QUIET_ALARM_MS = 12000;  // so long at the floor — «Микрофон?»
  const LEVEL_MS = 50;           // 20 times a second

  function tell(event, more) {
    try { global.webkit.messageHandlers.lexshell.postMessage(Object.assign({ word: 'dictation', event }, more || {})); }
    catch (e) { console.warn(TAG, 'shell:', e && e.message); }
  }

  // ── The agent's settings (the base) ─────────────────────────────────────────
  let settings = null;
  let settingsAt = 0;
  async function readSettings(fresh) {
    if (!fresh && settings && Date.now() - settingsAt < 60000) return settings;
    try {
      const r = await global.WcHistory.dictationAgent({ op: 'settings' });
      settings = { model: r.model || null, knobs: (r.knobs && typeof r.knobs === 'object') ? r.knobs : {}, keys_on: !!r.keys_on, version: r.version };
      settingsAt = Date.now();
      tell('settings', { keys_on: settings.keys_on, model: settings.model });
    } catch (e) {
      console.warn(TAG, 'settings:', e && e.message);
    }
    return settings || { model: null, knobs: {}, keys_on: false };
  }

  // The provider by the recognizer's name, for the log: the catalog does not carry it.
  function providerOf(model) {
    const m = String(model || '').toLowerCase();
    if (m.startsWith('mai-')) return 'microsoft';
    if (m.startsWith('gpt') || m.includes('whisper')) return 'openai';
    if (m.startsWith('gemini') || m.startsWith('chirp')) return 'google';
    if (m.startsWith('nova') || m.includes('deepgram')) return 'deepgram';
    if (m.startsWith('scribe') || m.includes('eleven')) return 'elevenlabs';
    return null;
  }

  // ── One dictation ───────────────────────────────────────────────────────────
  let cur = null;   // { clientId, app, appId, at, stream, rec, live, chunks, route, dict, meter, cancelled }

  function meter(stream) {
    let ctx, an, timer;
    let quietSince = Date.now();
    let quietTold = false;
    try {
      ctx = new (global.AudioContext || global.webkitAudioContext)();
      const src = ctx.createMediaStreamSource(stream);
      an = ctx.createAnalyser();
      an.fftSize = 1024;
      src.connect(an);
    } catch (e) { console.warn(TAG, 'meter:', e && e.message); }
    const buf = an ? new Float32Array(an.fftSize) : null;
    timer = setInterval(() => {
      if (!an) return;
      an.getFloatTimeDomainData(buf);
      let s = 0;
      for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
      const db = 20 * Math.log10(Math.sqrt(s / buf.length) || 1e-9);
      const v = Math.max(0, Math.min(1, (db - QUIET_DB) / 40));
      tell('level', { v: Math.round(v * 100) / 100 });
      if (db > QUIET_DB) { quietSince = Date.now(); quietTold = false; }
      else if (!quietTold && Date.now() - quietSince > QUIET_ALARM_MS) { quietTold = true; tell('alarm', { kind: 'quiet' }); }
    }, LEVEL_MS);
    stream.getAudioTracks().forEach((t) => {
      t.addEventListener('ended', () => tell('alarm', { kind: 'nosound' }));
      t.addEventListener('mute', () => tell('alarm', { kind: 'nosound' }));
    });
    return { close() { clearInterval(timer); try { ctx && ctx.close(); } catch (_) { /* noop */ } } };
  }

  function release(d) {
    if (d.meter) d.meter.close();
    if (d.stream) d.stream.getTracks().forEach((t) => t.stop());
  }

  async function journal(d, status, extra) {
    const row = Object.assign({
      client_id: d.clientId, at: new Date(d.at).toISOString(), ended_at: new Date().toISOString(), status,
      audio_ms: d.audioMs != null ? d.audioMs : null, recognizer: providerOf(d.model), model: d.model || null,
      app: d.app || null, app_id: d.appId || null, device: 'mac', source: 'mac',
      seconds: d.stoppedAt ? Math.round((Date.now() - d.stoppedAt) / 100) / 10 : null,
    }, extra || {});
    Object.keys(row).forEach((k) => { if (row[k] === null || row[k] === undefined) delete row[k]; });
    try { await global.WcHistory.dictationAgent({ op: 'put', dictation: row }); }
    catch (e) { console.warn(TAG, 'log:', e && e.message); }
  }

  function finish(d, text, err) {
    if (cur === d) cur = null;
    tell('state', { phase: 'idle' });
    if (d.cancelled) { journal(d, 'cancelled'); return; }
    if (err) {
      tell('error', { clientId: d.clientId, message: String(err) });
      journal(d, 'failed', { reason: String(err).slice(0, 500) });
    } else if (!text) {
      tell('error', { clientId: d.clientId, message: 'Nothing was recognised' });
      journal(d, 'empty');
    } else {
      tell('result', { clientId: d.clientId, text });
      journal(d, 'ok', { text });
    }
    readSettings(true);
  }

  async function start(opts) {
    if (cur) return false;
    const o = opts || {};
    const d = { clientId: o.clientId || (global.crypto.randomUUID ? global.crypto.randomUUID() : String(Date.now())),
      app: o.app || null, appId: o.appId || null, at: Date.now(), chunks: [], cancelled: false };
    cur = d;
    let cap = null;
    try { cap = global.LexDictationLive && global.LexDictationLive.capture ? global.LexDictationLive.capture() : null; } catch (_) { cap = null; }
    const choiceP = (async () => {
      const s = await readSettings(false);
      const route = await global.LexDictationCatalog.route(s.model, global.LexModelRegistry.defaultDictationModel);
      return { s, route };
    })();
    try {
      d.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (cap) { try { cap.attach(d.stream); } catch (_) { try { cap.close(); } catch (__) { /* noop */ } cap = null; } }
    } catch (e) {
      if (cap) { try { cap.close(); } catch (_) { /* noop */ } }
      finish(d, null, 'No microphone: ' + ((e && e.message) || e));
      return false;
    }
    d.meter = meter(d.stream);
    const { s, route } = await choiceP;
    if (d.cancelled) { if (cap) { try { cap.close(); } catch (_) { /* noop */ } } release(d); finish(d, null, null); return false; }
    if (!route.ok) {
      if (cap) { try { cap.close(); } catch (_) { /* noop */ } }
      release(d);
      finish(d, null, route.gate === 'login' ? 'Sign in to Lex to dictate.' : 'No list of recognizers: ' + (route.error || ''));
      return false;
    }
    d.model = route.model;
    d.dict = { model: route.model, knobs: s.knobs || {} };
    if (route.live) {
      if (!global.LexDictationLive) { release(d); finish(d, null, 'Live dictation is not loaded — reload Lex'); return false; }
      let final = null;
      d.live = global.LexDictationLive.create({
        transport: { call: (type, payload) => global.WcBus.call(type, payload).catch(() => null), subscribe: (fn) => global.WcBus.subscribe(fn) },
        onCaptureStart: () => { d.at = Date.now(); tell('state', { phase: 'recording' }); },
        onDelta: () => {},
        onClosing: () => { if (cur === d) stop(); },
        onEnded: (info) => { final = ((info && info.text) || '').trim() || final; },
        onError: (msg) => { if (!d.stoppedAt) { release(d); finish(d, null, msg); } },
      });
      const taken = cap;
      cap = null;
      await d.live.start(taken || d.stream, { model: route.model, knobs: d.dict.knobs, surface: 'standalone', pageType: 'text', noChat: true });
      d.liveFinal = () => final;
      return true;
    }
    if (cap) { try { cap.close(); } catch (_) { /* noop */ } }
    try {
      d.rec = route.wavRate ? global.LexDictationWav.create(d.stream, route.wavRate) : new MediaRecorder(d.stream, { audioBitsPerSecond: 64000 });
    } catch (e) {
      release(d);
      finish(d, null, 'Cannot record audio here');
      return false;
    }
    d.rec.ondataavailable = (e) => { if (e.data && e.data.size) d.chunks.push(e.data); };
    d.rec.onstop = async () => {
      release(d);
      if (d.cancelled) { finish(d, null, null); return; }
      d.audioMs = Date.now() - d.at;
      const blob = new Blob(d.chunks, { type: d.rec.mimeType || 'audio/webm' });
      const lim = global.LexDictationLimit.capture();
      if (blob.size < lim.minBlobBytes || d.audioMs < lim.minDurationMs) { finish(d, null, null); return; }
      tell('state', { phase: 'busy' });
      try {
        const base64 = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onloadend = () => { const t = String(r.result || ''); resolve(t.slice(t.indexOf(',') + 1)); };
          r.onerror = () => reject(new Error('read failed'));
          r.readAsDataURL(blob);
        });
        const r = await global.WcBus.call('WC_DICTATE', { base64, mimeType: blob.type, durationMs: d.audioMs,
          requestId: d.clientId, dict: d.dict, noChat: true, ref: 'mac-dictation:' + d.clientId });
        finish(d, ((r && r.text) || '').trim(), null);
      } catch (e) {
        finish(d, null, (e && e.message) || String(e));
      }
    };
    d.rec.start();
    d.at = Date.now();
    tell('state', { phase: 'recording' });
    if (route.maxRecordMs > 0) d.capTimer = setTimeout(() => { if (cur === d) stop(); }, route.maxRecordMs);
    return true;
  }

  async function stop() {
    const d = cur;
    if (!d || d.stoppedAt) return false;
    d.stoppedAt = Date.now();
    if (d.capTimer) clearTimeout(d.capTimer);
    if (d.rec) { if (d.rec.state !== 'inactive') d.rec.stop(); return true; }
    if (d.live) {
      d.audioMs = Date.now() - d.at;
      tell('state', { phase: 'busy' });
      const heard = d.live.heard ? d.live.heard() : d.live.isReady();
      const pending = heard ? d.live.stop() : (d.live.abort(), null);
      release(d);
      const res = pending ? await pending : null;
      if (!heard) { finish(d, null, null); return true; }
      if (!res || !res.ok) { finish(d, null, 'Could not transcribe'); return true; }
      finish(d, ((res.text || (d.liveFinal && d.liveFinal()) || '')).trim(), null);
      return true;
    }
    return false;
  }

  function cancel() {
    const d = cur;
    if (!d) return false;
    d.cancelled = true;
    if (d.capTimer) clearTimeout(d.capTimer);
    if (d.rec && d.rec.state !== 'inactive') { d.rec.stop(); return true; }
    if (d.live) { try { d.live.abort(); } catch (_) { /* noop */ } release(d); finish(d, null, null); return true; }
    return true;
  }

  global.LexMacDictation = Object.freeze({
    start, stop, cancel,
    settings: () => readSettings(true),
    busy: () => !!cur,
  });
  // The keys follow the agent's settings from the first moment the page is up.
  setTimeout(() => readSettings(true), 1500);
})(typeof self !== 'undefined' ? self : globalThis);
