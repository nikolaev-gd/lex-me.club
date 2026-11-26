// webchat/wc-mac-dictation.js — the agent «Диктовка» on the Mac: recording and recognition for the Mac program
// (2026-11-25, Gennady: Scribe moves into Lex as a separate agent with its own settings and every recognizer Lex has).
//
// ── Who does what ───────────────────────────────────────────────────────────
// The Mac program (macos/Sources/LexShell/Dictation*.swift) owns what a page cannot: the global keys (right Cmd+Space,
// right Opt+Space), the pill «В эфире», the dot at the mouse, the paste into the field of another program — and, since
// 26.11.2026, the microphone for every recognizer that takes a file: it records from the press itself, as Scribe did
// (the page's getUserMedia woke up late and the first words were lost), and keeps the file on disk. This page owns
// the rest — the recognizer and the text, and the microphone of a LIVE recognizer — with the same parts as the
// microphone of the field (wc-composer.js): the recognizer catalog (lex-dictation-catalog.js), a file or a live
// session (lex-dictation-live.js), the direct mode (the sound goes from the Mac straight to the provider,
// LexDirectProviders through WC_DICTATE / LEX_DICTATION_LIVE_*). Its recognizer and knobs are the AGENT's (the base,
// supabase/functions/dictation-agent), not the chat microphone's; its money belongs to no conversation (noChat).
//
// ── The words between them ───────────────────────────────────────────────────
// Mac → page: feed(id, piece) · recognize({clientId, app, appId, mimeType, durationMs, at, reason}) — a file the Mac
//   recorded itself (every recognizer that takes a file); log({clientId, status, audioMs, …}) — a row without a
//   recognition; drop(id) — ✕ while recognizing, the late answer is dropped and logged «cancelled»;
//   start({clientId, app, appId}) · stop() · cancel() — a LIVE recognizer, the page records; settings().
// Page → Mac: lexshell.postMessage({word: 'dictation', event, …}):
//   settings {keys_on, model, live, wavRate, maxRecordMs} — the agent's settings and the recognizer's route (read on
//                                   load and after every dictation): the Mac picks WAV / m4a before the press;
//   state {phase}                 — live only: 'recording', 'busy' (recognizing), 'idle';
//   level {v}                     — live only: the loudness 0…1, 20 times a second while recording;
//   alarm {kind}                  — live only: 'nosound' (the microphone ended or went mute), 'quiet' (12 s at the floor);
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
      // The Mac records the file itself from the press (Dictation.swift): it must know the format before it.
      let route = null;
      try { route = await global.LexDictationCatalog.route(settings.model, global.LexModelRegistry.defaultDictationModel); }
      catch (e) { console.warn(TAG, 'route:', e && e.message); }
      const ok = !!(route && route.ok);
      tell('settings', { keys_on: settings.keys_on, model: ok ? route.model : settings.model, live: ok ? !!route.live : false,
        wavRate: ok && route.wavRate ? route.wavRate : null, maxRecordMs: ok && route.maxRecordMs ? route.maxRecordMs : null });
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

  // ── A file the Mac recorded (the recognizers that take a file) ───────────────
  // The Mac writes the sound from the press itself (AVAudioRecorder, the way Scribe did — the page's microphone woke
  // up late and the first words were lost) and hands the finished file here in base64 pieces: feed(id, piece)…,
  // then recognize({clientId, app, appId, mimeType, durationMs, at, reason}). The answer goes back by the words
  // result / error with the same clientId; the log row is written here as for the page's own recording.
  const parts = new Map();
  // ✕ on the pill while recognizing: the answer that comes later is not the text — the row says «cancelled».
  const dropped = new Set();
  function drop(id) { dropped.add(id); return true; }
  function feed(id, piece) {
    const a = parts.get(id) || [];
    a.push(String(piece || ''));
    parts.set(id, a);
    return 'ok';
  }

  async function recognize(o) {
    const id = o.clientId;
    const base64 = (parts.get(id) || []).join('');
    parts.delete(id);
    const d = { clientId: id, app: o.app || null, appId: o.appId || null, at: Number(o.at) || Date.now(),
      audioMs: o.durationMs || null, stoppedAt: Date.now(), cancelled: false };
    const s = await readSettings(false);
    const route = await global.LexDictationCatalog.route(s.model, global.LexModelRegistry.defaultDictationModel);
    if (!route.ok) {
      finish(d, null, route.gate === 'login' ? 'Sign in to Lex to dictate.' : 'No list of recognizers: ' + (route.error || ''));
      return false;
    }
    // A live recognizer chosen after the press: the file goes to the default file recognizer.
    d.model = route.live ? null : route.model;
    try {
      const r = await global.WcBus.call('WC_DICTATE', { base64, mimeType: o.mimeType || 'audio/wav', durationMs: d.audioMs,
        requestId: id, dict: { model: d.model, knobs: route.live ? {} : (s.knobs || {}) }, noChat: true, ref: 'mac-dictation:' + id });
      const text = ((r && r.text) || '').trim();
      if (dropped.delete(id)) { d.cancelled = true; finish(d, null, null); return true; }
      if (!text && o.reason) finish(d, null, o.reason);
      else finish(d, text, null);
    } catch (e) {
      if (dropped.delete(id)) { d.cancelled = true; finish(d, null, null); return true; }
      finish(d, null, (e && e.message) || String(e));
    }
    return true;
  }

  // A row for what never reached a recognizer (✕ on the Mac's own recording, a microphone that did not start).
  async function log(o) {
    const d = { clientId: o.clientId, app: o.app || null, appId: o.appId || null, at: Date.now() - (o.audioMs || 0),
      audioMs: o.audioMs || null, model: settings && settings.model };
    await journal(d, o.status || 'cancelled', o.reason ? { reason: String(o.reason).slice(0, 500) } : null);
    return true;
  }

  global.LexMacDictation = Object.freeze({
    start, stop, cancel, feed, recognize, drop, log,
    settings: () => readSettings(true),
    busy: () => !!cur,
  });
  // The keys follow the agent's settings from the first moment the page is up.
  setTimeout(() => readSettings(true), 1500);
})(typeof self !== 'undefined' ? self : globalThis);
