// voice/microphone.js — mic capture + playback context helpers for LexVoice.
//
// Centralises the getUserMedia + AudioContext + ScriptProcessor pipeline
// that all three legacy voice paths (shared.js singleton, openTutor*Session,
// chat-surface.js factory port) duplicated. Two capture modes:
//
//   captureForRealtime()    — OpenAI Realtime / dictation. Just a MediaStream
//                             with echo-cancellation; no AudioContext (Realtime
//                             takes the track directly via RTCPeerConnection).
//
//   captureForGeminiLive()  — Gemini Live. MediaStream + 16 kHz AudioContext +
//                             ScriptProcessor (4096 frames mono) + silent
//                             MediaStreamDestination. The caller runs
//                             onaudioprocess and pumps PCM to the WS.
//
// PCM/base64 helpers + RMS analyser pool live here too so the OpenAI and
// Gemini clients can reuse the same primitives.

(function (global) {
  'use strict';

  // RIFF/WAVE PCM 16-bit mono encoder + 16 kHz downsampler — mirror of the
  // content.js helpers, kept here so the realtime segment recorder can turn
  // captured Float32 PCM into a WAV without reaching outside the module.
  function downsampleFloat32To16k(samples, inRate) {
    if (inRate <= 16000) return samples;
    const ratio = inRate / 16000;
    const outLen = Math.floor(samples.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.min(samples.length, Math.floor((i + 1) * ratio));
      let sum = 0, n = 0;
      for (let j = start; j < end; j++) { sum += samples[j]; n++; }
      out[i] = n > 0 ? sum / n : 0;
    }
    return out;
  }
  function encodeWavMono16(samples, sampleRate) {
    const numSamples = samples.length;
    const dataBytes = numSamples * 2;
    const buffer = new ArrayBuffer(44 + dataBytes);
    const view = new DataView(buffer);
    const writeAscii = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    writeAscii(0, 'RIFF'); view.setUint32(4, 36 + dataBytes, true); writeAscii(8, 'WAVE');
    writeAscii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    writeAscii(36, 'data'); view.setUint32(40, dataBytes, true);
    let off = 44;
    for (let i = 0; i < numSamples; i++) {
      let s = samples[i]; if (s > 1) s = 1; else if (s < -1) s = -1;
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true); off += 2;
    }
    return new Uint8Array(buffer);
  }

  // Как берётся микрофон живого разговора — и на старте, и заново, когда
  // дорожка кончилась (reacquireForRealtime, lex-mic-watch.js). Одно место,
  // чтобы новая дорожка не оказалась с другой обработкой звука, чем первая.
  const REALTIME_AUDIO = { echoCancellation: true, autoGainControl: false, noiseSuppression: false };

  // Взять микрофон заново — тот, что сейчас по умолчанию. Зовёт слежка
  // lex-mic-watch.js, когда дорожка разговора кончилась: сменились наушники —
  // разговор идёт дальше на новой дорожке; отказ — трубка.
  function reacquireForRealtime() {
    return navigator.mediaDevices.getUserMedia({ audio: Object.assign({}, REALTIME_AUDIO) }).then(announce);
  }

  // Кто ещё слушает микрофон разговора. Живая распознавалка, выбранная в блоке
  // «расшифровка речи в разговоре», пишет в пузырь то, что человек говорит, и
  // слушает для этого ТОТ ЖЕ поток, что и голосовая модель: второй захват
  // микрофона — второе разрешение и второй набор обработки звука. Поток
  // сообщается в миг захвата и заново, когда дорожку взяли снова (сменились
  // наушники).
  const streamListeners = new Set();
  function onStream(fn) {
    if (typeof fn !== 'function') return () => {};
    streamListeners.add(fn);
    return () => { streamListeners.delete(fn); };
  }
  function announce(stream) {
    streamListeners.forEach((fn) => {
      try { fn(stream); } catch (e) { console.warn('[LexVoiceMicrophone] stream listener threw:', e && e.message); }
    });
    return stream;
  }

  async function captureForRealtime() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: Object.assign({}, REALTIME_AUDIO) });
    announce(stream);
    const track = stream.getAudioTracks()[0];
    // v1.13.x: optional segment recorder — a SECOND consumer on the same
    // MediaStream (next to the WebRTC sender + RMS analyser). Captures the
    // user's raw PCM ONLY between beginSegment()/endSegment(), so one user
    // turn (speech_started → input_audio_buffer.committed) becomes a WAV the
    // caller attaches to the calls row. Best-effort: if AudioContext setup
    // throws, the methods no-op and the voice session is unaffected.
    let recCtx = null, recSource = null, recProc = null, recSink = null, recRate = 16000;
    let recChunks = null; // Float32Array[] while a segment is active, else null
    // v1.14.x: continuous session buffer — collects the WHOLE session (start →
    // teardown) into one track, INDEPENDENT of the per-turn segment buffer.
    // Both fed from the same onaudioprocess source below.
    let sessChunks = [], sessActive = true;
    try {
      recCtx = new AudioContext();
      recRate = recCtx.sampleRate;
      recSource = recCtx.createMediaStreamSource(stream);
      recProc = recCtx.createScriptProcessor(4096, 1, 1);
      recProc.onaudioprocess = (e) => {
        const data = e.inputBuffer.getChannelData(0);
        if (recChunks) { try { recChunks.push(new Float32Array(data)); } catch (_) {} }   // per-turn segment
        if (sessActive) { try { sessChunks.push(new Float32Array(data)); } catch (_) {} } // continuous session
      };
      recSink = recCtx.createMediaStreamDestination(); // silent sink, no playback
      recSource.connect(recProc);
      recProc.connect(recSink);
    } catch (e) {
      recProc = null;
    }
    const segmentRecorder = {
      beginSegment() { recChunks = []; },
      isRecording() { return recChunks !== null; },
      // Stop the current segment and return its WAV as clean base64 (16 kHz
      // mono), or null if nothing was captured. Idempotent.
      endSegment() {
        const chunks = recChunks; recChunks = null;
        if (!chunks || !chunks.length) return null;
        let total = 0; for (const c of chunks) total += c.length;
        if (!total) return null;
        const flat = new Float32Array(total);
        let off = 0; for (const c of chunks) { flat.set(c, off); off += c.length; }
        const ds = downsampleFloat32To16k(flat, recRate);
        const wav = encodeWavMono16(ds, 16000);
        return arrayBufferToBase64(wav);
      },
      dispose() {
        recChunks = null;
        try { if (recProc) { recProc.onaudioprocess = null; recProc.disconnect(); } } catch (_) {}
        try { if (recSink) recSink.disconnect(); } catch (_) {}
        try { if (recSource) recSource.disconnect(); } catch (_) {}
        try { if (recCtx && recCtx.state !== 'closed') recCtx.close(); } catch (_) {}
        recProc = recSource = recSink = recCtx = null;
      },
    };
    // v1.14.x: continuous whole-session recorder (one WAV, no per-reply
    // slicing). endSession() returns the full track as base64 (16 kHz mono)
    // or null if nothing was captured (mic opened, no audio).
    const sessionRecorder = {
      isActive() { return sessActive; },
      endSession() {
        sessActive = false;
        if (!sessChunks.length) return null;
        let total = 0; for (const c of sessChunks) total += c.length;
        if (!total) { sessChunks = []; return null; }
        const flat = new Float32Array(total);
        let off = 0; for (const c of sessChunks) { flat.set(c, off); off += c.length; }
        sessChunks = [];
        const ds = downsampleFloat32To16k(flat, recRate);
        const wav = encodeWavMono16(ds, 16000);
        return arrayBufferToBase64(wav);
      },
      dispose() { sessActive = false; sessChunks = []; },
    };
    // Микрофон вернулся на новой дорожке (lex-mic-watch.js): запись реплики и
    // запись сеанса идут дальше с неё, в те же буферы — сеанс не рвётся.
    function swapStream(next) {
      if (!recCtx || !recProc || !next) return;
      try { if (recSource) recSource.disconnect(); } catch (_) {}
      try { recSource = recCtx.createMediaStreamSource(next); recSource.connect(recProc); } catch (_) {}
    }
    return { stream, track, segmentRecorder, sessionRecorder, swapStream };
  }

  async function captureForGeminiLive() {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, autoGainControl: true, noiseSuppression: true },
    });
    announce(stream);
    const track = stream.getAudioTracks()[0];
    const micCtx = new AudioContext({ sampleRate: 16000 });
    if (micCtx.state === 'suspended') micCtx.resume().catch(() => {});
    const micSource = micCtx.createMediaStreamSource(stream);
    const micProc = micCtx.createScriptProcessor(4096, 1, 1);
    const micSink = micCtx.createMediaStreamDestination();
    micSource.connect(micProc);
    micProc.connect(micSink);
    // v1.14.x: feed-based segment recorder for user-speech WAV (calls.audio_url).
    // Unlike captureForRealtime (own AudioContext consumer), Gemini already has
    // micProc @16kHz pumping PCM to the WS — the caller feeds the SAME Float32
    // frames here via feed(), so no second AudioContext. Collects only between
    // beginSegment()/endSegment(). micCtx is 16kHz → no downsample.
    let segChunks = null;
    // v1.14.x: continuous whole-session buffer, fed alongside the per-turn segment.
    let sessChunks = [], sessActive = true;
    const segmentRecorder = {
      beginSegment() { segChunks = []; },
      isRecording() { return segChunks !== null; },
      feed(float32) {
        if (segChunks) { try { segChunks.push(new Float32Array(float32)); } catch (_) {} }   // per-turn segment
        if (sessActive) { try { sessChunks.push(new Float32Array(float32)); } catch (_) {} } // continuous session
      },
      endSegment() {
        const chunks = segChunks; segChunks = null;
        if (!chunks || !chunks.length) return null;
        let total = 0; for (const c of chunks) total += c.length;
        if (!total) return null;
        const flat = new Float32Array(total);
        let off = 0; for (const c of chunks) { flat.set(c, off); off += c.length; }
        const wav = encodeWavMono16(flat, 16000); // micCtx already 16kHz, no downsample
        return arrayBufferToBase64(wav);
      },
      dispose() { segChunks = null; },
    };
    // v1.14.x: continuous whole-session recorder (one WAV, no slicing). Fed via
    // segmentRecorder.feed() above (same Float32 frames). endSession() → full
    // track base64 (16 kHz mono) or null if empty. micCtx is 16kHz → no downsample.
    const sessionRecorder = {
      isActive() { return sessActive; },
      endSession() {
        sessActive = false;
        if (!sessChunks.length) return null;
        let total = 0; for (const c of sessChunks) total += c.length;
        if (!total) { sessChunks = []; return null; }
        const flat = new Float32Array(total);
        let off = 0; for (const c of sessChunks) { flat.set(c, off); off += c.length; }
        sessChunks = [];
        const wav = encodeWavMono16(flat, 16000);
        return arrayBufferToBase64(wav);
      },
      dispose() { sessActive = false; sessChunks = []; },
    };
    return { stream, track, micCtx, micSource, micProc, micSink, segmentRecorder, sessionRecorder };
  }

  function createPlaybackContext24k() {
    const ctx = new AudioContext({ sampleRate: 24000 });
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  // RMS sampler — caller drives it from a RAF loop, emits `level` callbacks
  // back to the surface (which renders the equalizer / mode-pill bars).
  // Source can be a MediaStream (mic) or an AudioContext destination
  // analyser (Gemini playback or OpenAI Realtime remote track).
  function createAnalyserFromStream(audioCtx, mediaStream) {
    const source = audioCtx.createMediaStreamSource(mediaStream);
    return createAnalyserFromNode(audioCtx, source);
  }

  function createAnalyserFromNode(audioCtx, sourceNode) {
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.5;
    sourceNode.connect(analyser);
    const buf = new Uint8Array(analyser.frequencyBinCount);
    return {
      node: analyser,
      sample() {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += Math.abs(buf[i] - 128);
        return sum / buf.length / 128;  // 0..1
      },
      disconnect() {
        try { analyser.disconnect(); } catch (_) {}
        try { sourceNode.disconnect(); } catch (_) {}
      },
    };
  }

  // PCM/base64 (Gemini Live audio I/O).
  function floatToInt16(float32) {
    const out = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }
  function int16ToFloat32(int16) {
    const out = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) out[i] = int16[i] / 0x8000;
    return out;
  }
  function arrayBufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }
  function base64ToArrayBuffer(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  global.LexVoiceMicrophone = {
    captureForRealtime,
    reacquireForRealtime,
    captureForGeminiLive,
    onStream,
    createPlaybackContext24k,
    createAnalyserFromStream,
    createAnalyserFromNode,
    floatToInt16,
    int16ToFloat32,
    arrayBufferToBase64,
    base64ToArrayBuffer,
  };
})(typeof self !== 'undefined' ? self : globalThis);
