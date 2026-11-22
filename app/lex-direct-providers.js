// lex-direct-providers.js — what the device has to understand of a provider's
// answer when it calls the provider itself (direct mode, lex-direct-mode.js).
//
// On the server path these rules live on the server, and the apps receive one
// shape whoever the provider was. In direct mode the device gets the provider's
// raw answer, so the same rules are here, ported line for line from the server
// files named at each block. When a server file changes, change its port here
// in the same commit — dev-tools/check-direct-mode.mjs runs both on the same
// recorded answers.
//
// Loaded by the extension's service worker (importScripts) and by the page
// (<script>). No browser-extension API anywhere (dev-tools/check-webchat-clean.sh).
(function (global) {
  'use strict';

  if (global.LexDirectProviders) return;

  const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim();
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

  // ── Google Interactions transcription (_shared/model-pricing.ts readGeminiTranscription)

  function readGeminiTranscription(j) {
    let text = '';
    for (const step of (Array.isArray(j && j.steps) ? j.steps : [])) {
      for (const c of (Array.isArray(step && step.content) ? step.content : [])) {
        if (c && typeof c.text === 'string') text += c.text;
      }
    }
    const u = (j && j.usage) || {};
    let audioIn = 0, textIn = 0;
    for (const m of (Array.isArray(u.input_tokens_by_modality) ? u.input_tokens_by_modality : [])) {
      const n = Number(m && m.tokens) || 0;
      if (String(m && m.modality).toLowerCase() === 'audio') audioIn += n; else textIn += n;
    }
    let textOut = 0;
    for (const inv of (Array.isArray(u.model_invocation_token_counts) ? u.model_invocation_token_counts : [])) {
      for (const d of (Array.isArray(inv && inv.candidates_tokens_details) ? inv.candidates_tokens_details : [])) {
        textOut += Number(d && d.tokens) || 0;
      }
    }
    return { text, audioIn, textIn, textOut };
  }

  // ── Microsoft file transcription (_shared/microsoft-transcript.ts) ─────────

  const SPEAKER_LABEL = 'Speaker';
  function clock(ms) {
    const total = Math.max(0, Math.floor(Number(ms) || 0));
    const h = Math.floor(total / 3600000);
    const m = Math.floor((total % 3600000) / 60000);
    const s = Math.floor((total % 60000) / 1000);
    const tail = `${String(s).padStart(2, '0')}.${String(total % 1000).padStart(3, '0')}`;
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${tail}` : `${m}:${tail}`;
  }
  const tstr = (v) => (typeof v === 'string' ? v.trim() : '');

  function readMicrosoftTranscription(j, marks) {
    const mk = marks || { timeMarks: '', speakers: false };
    const dur = Number(j && j.durationMilliseconds);
    const seconds = Number.isFinite(dur) && dur > 0 ? dur / 1000 : null;
    const phrases = Array.isArray(j && j.phrases) ? j.phrases.filter((p) => tstr(p && p.text)) : [];
    const plain = () => {
      const combined = (Array.isArray(j && j.combinedPhrases) ? j.combinedPhrases : [])
        .map((c) => tstr(c && c.text)).filter(Boolean).join(' ');
      return combined || phrases.map((p) => tstr(p.text)).join(' ');
    };
    const byTime = mk.timeMarks === 'segment' || mk.timeMarks === 'word';
    if (!byTime && !mk.speakers) return { text: plain(), seconds };
    const numbers = new Map();
    const label = (p) => {
      if (!mk.speakers || typeof (p && p.speaker) !== 'number') return '';
      if (!numbers.has(p.speaker)) numbers.set(p.speaker, numbers.size + 1);
      return `${SPEAKER_LABEL} ${numbers.get(p.speaker)}: `;
    };
    if (!byTime) {
      const lines = [];
      for (const p of phrases) {
        const who = label(p);
        const last = lines[lines.length - 1];
        if (last && last.who === who) last.text += ' ' + tstr(p.text);
        else lines.push({ who, text: tstr(p.text) });
      }
      return { text: lines.map((l) => l.who + l.text).join('\n') || plain(), seconds };
    }
    const lines = phrases.map((p) => {
      const who = label(p);
      const words = Array.isArray(p.words) ? p.words.filter((w) => tstr(w && w.text)) : [];
      if (mk.timeMarks === 'word' && words.length) {
        return words.map((w, i) => `[${clock(w.offsetMilliseconds)}] ${i === 0 ? who : ''}${tstr(w.text)}`).join(' ');
      }
      return `[${clock(p.offsetMilliseconds)}] ${who}${tstr(p.text)}`;
    });
    return { text: lines.join('\n') || plain(), seconds };
  }

  // The marks of a Microsoft dictation, from the knobs as the device sends them
  // (_shared/dictation-fields.ts dictationRequest: timeMarks, speakers).
  function microsoftMarksOf(knobs) {
    const k = knobs && typeof knobs === 'object' ? knobs : {};
    const tm = str(k.timeMarks);
    return {
      timeMarks: ['none', 'segment', 'word'].includes(tm) ? tm : 'none',
      speakers: k.speakers === true || k.speakers === 'true',
    };
  }

  // ── Subtitle ASR (_shared/subtitle-asr.ts) ─────────────────────────────────

  function speakerNumbering() {
    const seen = new Map();
    return (raw) => {
      if (raw === undefined || raw === null || raw === '') return null;
      const key = String(raw);
      if (!seen.has(key)) seen.set(key, seen.size);
      return seen.get(key);
    };
  }

  function readDeepgramSubtitle(j) {
    const spk = speakerNumbering();
    const toWord = (w) => ({
      text: str((w && (w.punctuated_word || w.word))),
      start: num(w && w.start), end: num(w && w.end),
      speaker: spk(w && w.speaker),
    });
    const ch = j && j.results && Array.isArray(j.results.channels) ? j.results.channels[0] : null;
    const alt = (ch && Array.isArray(ch.alternatives) && ch.alternatives[0]) || null;
    const utterances = Array.isArray(j && j.results && j.results.utterances) ? j.results.utterances : [];
    let segments;
    if (utterances.length) {
      segments = utterances.map((u) => {
        const words = (Array.isArray(u && u.words) ? u.words : []).map(toWord).filter((w) => w.text);
        return {
          start: num(u && u.start), end: num(u && u.end) || num(u && u.start),
          text: str(u && u.transcript),
          speaker: words.length ? words[0].speaker : spk(u && u.speaker),
          words,
        };
      });
    } else {
      const words = (Array.isArray(alt && alt.words) ? alt.words : []).map(toWord).filter((w) => w.text);
      segments = words.length || str(alt && alt.transcript)
        ? [{
          start: words[0] ? words[0].start : 0, end: words.length ? words[words.length - 1].end : 0,
          text: str(alt && alt.transcript), speaker: words[0] ? words[0].speaker : null, words,
        }]
        : [];
    }
    const d = num(j && j.metadata && j.metadata.duration);
    return { segments, durationSec: d > 0 ? d : null };
  }

  const GAP_SPLIT_SEC = 0.8;
  const SENTENCE_END = /[.!?…]["”')\]]*$/;
  function wordsToSegments(words) {
    const out = [];
    let cur = [];
    const flush = () => {
      if (!cur.length) return;
      out.push({ start: cur[0].start, end: cur[cur.length - 1].end, text: cur.map((w) => w.text).join(' '), speaker: cur[0].speaker, words: cur });
      cur = [];
    };
    for (const w of words) {
      const prev = cur[cur.length - 1];
      if (prev && (w.speaker !== prev.speaker || w.start - prev.end >= GAP_SPLIT_SEC || SENTENCE_END.test(prev.text))) flush();
      cur.push(w);
    }
    flush();
    return out;
  }
  const offsetSec = (v) => num(String(v == null ? '' : v).replace(/s$/, ''));

  function readGeminiSubtitle(j) {
    const spk = speakerNumbering();
    const words = [];
    let text = '';
    for (const step of (Array.isArray(j && j.steps) ? j.steps : [])) {
      for (const c of (Array.isArray(step && step.content) ? step.content : [])) {
        if (c && typeof c.text === 'string') text += c.text;
        for (const a of (Array.isArray(c && c.annotations) ? c.annotations : [])) {
          if (!a || a.type !== 'word_info' || !str(a.text)) continue;
          words.push({ text: str(a.text), start: offsetSec(a.start_offset), end: offsetSec(a.end_offset), speaker: spk(a.speaker) });
        }
      }
    }
    words.sort((a, b) => a.start - b.start);
    const segments = words.length ? wordsToSegments(words)
      : (str(text) ? [{ start: 0, end: 0, text: str(text), speaker: null, words: [] }] : []);
    return { segments, durationSec: null };
  }

  function readMicrosoftSubtitle(j) {
    const spk = speakerNumbering();
    const ms = (v) => num(v) / 1000;
    const segments = [];
    for (const p of (Array.isArray(j && j.phrases) ? j.phrases : [])) {
      if (!str(p && p.text)) continue;
      const speaker = spk(p.speaker);
      const words = (Array.isArray(p.words) ? p.words : [])
        .filter((w) => str(w && w.text))
        .map((w) => ({ text: str(w.text), start: ms(w.offsetMilliseconds), end: ms(num(w.offsetMilliseconds) + num(w.durationMilliseconds)), speaker }));
      segments.push({ start: ms(p.offsetMilliseconds), end: ms(num(p.offsetMilliseconds) + num(p.durationMilliseconds)), text: str(p.text), speaker, words });
    }
    const d = num(j && j.durationMilliseconds);
    return { segments, durationSec: d > 0 ? d / 1000 : null };
  }

  // The provider's subtitle answer → the body the server path returns
  // (llm-proxy, «Звук видео: ответ поставщика → один вид»).
  function subtitleBody(provider, model, j, providerMs, fallbackSec) {
    const r = provider === 'deepgram' ? readDeepgramSubtitle(j)
      : provider === 'google' ? readGeminiSubtitle(j)
      : readMicrosoftSubtitle(j);
    return {
      provider, model,
      durationSec: r.durationSec != null ? r.durationSec : (Number.isFinite(fallbackSec) ? fallbackSec : null),
      providerMs: Number.isFinite(providerMs) ? providerMs : null,
      segments: r.segments,
    };
  }

  // The usage a report carries, «as the provider gave it» (60-server.md,
  // «Отчёт о прямом вызове»): Google — its token counter; Deepgram — metadata
  // with the duration; Microsoft — the duration; OpenAI — the usage of the answer.
  function subtitleUsage(provider, j) {
    if (provider === 'deepgram') return j && j.metadata ? { duration: j.metadata.duration } : null;
    if (provider === 'microsoft') return j && j.durationMilliseconds != null ? { durationMilliseconds: j.durationMilliseconds } : null;
    return (j && j.usage) || null;
  }

  // ── File dictation: the provider's answer → { text, usage, seconds } ───────
  //
  // OpenAI answers JSON, or SSE when the «text grows» knob is on (the server
  // path forwards that SSE as is; the SW reads transcript.text.delta/done).
  function readSse(text) {
    const events = [];
    for (const part of String(text || '').split(/\r?\n\r?\n/)) {
      const dataLines = [];
      for (const line of part.split(/\r?\n/)) if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      const data = dataLines.join('\n');
      if (!data || data === '[DONE]') continue;
      try { events.push(JSON.parse(data)); } catch (_) { /* skip */ }
    }
    return events;
  }

  function dictationResult(provider, bodyText, knobs) {
    if (provider === 'openai') {
      let j = null;
      try { j = JSON.parse(bodyText); } catch (_) { j = null; }
      if (j && typeof j.text === 'string') return { text: j.text.trim(), usage: j.usage || null };
      // SSE: the last done frame is authoritative; deltas only show growth.
      let text = '', usage = null;
      for (const ev of readSse(bodyText)) {
        if (ev.type === 'transcript.text.delta' && typeof ev.delta === 'string') text += ev.delta;
        else if (ev.type === 'transcript.text.done' && typeof ev.text === 'string') { text = ev.text; usage = ev.usage || usage; }
      }
      return { text: text.trim(), usage };
    }
    let j = null;
    try { j = JSON.parse(bodyText); } catch (_) { j = null; }
    if (provider === 'google') {
      const g = readGeminiTranscription(j || {});
      return { text: g.text.trim(), usage: (j && j.usage) || null };
    }
    const ms = readMicrosoftTranscription(j || {}, microsoftMarksOf(knobs));
    return { text: ms.text.trim(), usage: j && j.durationMilliseconds != null ? { durationMilliseconds: j.durationMilliseconds } : null, seconds: ms.seconds };
  }

  // ── Live dictation (_shared/live-dictation-providers.ts readFrame and the
  //    segment rules of dictation-live/index.ts) ───────────────────────────

  const LIVE_RULES = {
    openai: { endsWhenNoOpenSegment: false, finalWaitMs: 6000, openTimeoutMs: 8000 },
    google: { endsWhenNoOpenSegment: true, finalWaitMs: 6000, openTimeoutMs: 8000 },
  };

  function readLiveFrame(provider, j, committed) {
    if (provider === 'openai') {
      const t = j && j.type;
      if (t === 'session.updated') return { kind: 'ready' };
      if (t === 'error') return { kind: 'error', message: String((j.error && j.error.message) || 'provider refused') };
      if (t === 'conversation.item.input_audio_transcription.delta') {
        return typeof j.delta === 'string' && j.delta ? { kind: 'interim', text: j.delta, append: true } : { kind: 'ignore' };
      }
      if (t === 'conversation.item.input_audio_transcription.completed') {
        const sec = Number(j.usage && j.usage.seconds);
        return { kind: 'done', seconds: Number.isFinite(sec) && sec > 0 ? sec : null, text: typeof j.transcript === 'string' ? j.transcript : undefined, usage: j.usage || null };
      }
      if (t === 'conversation.item.input_audio_transcription.failed') {
        return { kind: 'error', message: String((j.error && j.error.message) || 'transcription failed') };
      }
      return { kind: 'ignore' };
    }
    if (j && j.setupComplete) return { kind: 'ready' };
    const va = j && j.voiceActivity && j.voiceActivity.type;
    if (va === 'ACTIVITY_START') return { kind: 'activity', speaking: true };
    if (va === 'ACTIVITY_END') return { kind: 'activity', speaking: false };
    const sc = j && j.serverContent;
    if (sc) {
      const interim = sc.interimInputTranscription && sc.interimInputTranscription.text;
      if (typeof interim === 'string') return { kind: 'interim', text: interim };
      const settled = sc.inputTranscription && sc.inputTranscription.text;
      if (typeof settled === 'string') return { kind: 'settled', text: settled };
      if (sc.generationComplete === true && committed) return { kind: 'done', seconds: null };
    }
    return { kind: 'ignore' };
  }

  // A socket that speaks the protocol of the server's `dictation-live`
  // (start → ready, audio, ping, stop/abort → final; delta and error between)
  // but talks to the provider itself, by the recipe. The relay
  // (lex-dictation-relay.js) drives it exactly as it drives the server socket:
  // one relay, two sockets, nothing else changes for the tab.
  //
  // opts: { recipe, slots, settledOnly, WebSocket, onReport(report), log }
  function createLiveDictationSocket(opts) {
    const o = opts || {};
    const recipe = o.recipe || {};
    const provider = recipe.provider;
    const rules = LIVE_RULES[provider] || LIVE_RULES.openai;
    const fill = global.LexDirectMode.fill;
    const Ctor = o.WebSocket || global.WebSocket;
    const sampleRate = Number(recipe.sampleRate) > 0 ? Number(recipe.sampleRate) : 24000;
    const capMs = Number(recipe.maxSeconds) > 0 ? Number(recipe.maxSeconds) * 1000 : 120000;
    const log = (l) => { try { o.log && o.log(l); } catch (_) {} };

    const sock = {
      readyState: 0, onopen: null, onmessage: null, onerror: null, onclose: null,
      send(data) { handle(data); },
      close() { finish('client_closed', true); },
    };
    let up = null, upOpen = false, readyTold = false, finishing = false, settled = false;
    let segments = [], current = '', speaking = false, lastSent = null;
    let providerSeconds = null, providerUsage = null, audioBytes = 0;
    let finalWaiter = null, capTimer = null, config = {};
    const startedAt = Date.now();
    let firstTextAt = null;

    const emit = (m) => { try { sock.onmessage && sock.onmessage({ data: JSON.stringify(m) }); } catch (_) {} };
    const segmentOpen = () => speaking || current !== '';
    const wakeFinal = () => { if (finalWaiter) { const f = finalWaiter; finalWaiter = null; f(); } };
    const shown = () => {
      const s = segments.join(' ');
      if (o.settledOnly || !current) return s;
      return s ? s + ' ' + current : current;
    };
    const pushText = () => {
      const t = shown();
      if (!t || t === lastSent) return;
      if (firstTextAt == null) firstTextAt = Date.now();
      lastSent = t;
      emit({ type: 'delta', textSoFar: t });
    };

    // The socket «opens» at once, as a socket to our server would; the
    // provider is dialled on the start frame.
    setTimeout(() => { sock.readyState = 1; try { sock.onopen && sock.onopen(); } catch (_) {} }, 0);

    function openUpstream() {
      const conn = recipe.connect || {};
      const url = fill(conn.url, o.slots);
      const protocols = Array.isArray(conn.protocols) ? fill(conn.protocols, o.slots) : undefined;
      let answered = false;
      const giveUp = setTimeout(() => {
        if (answered) return;
        answered = true;
        failStart('provider did not open in time');
      }, rules.openTimeoutMs);
      try { up = protocols ? new Ctor(url, protocols) : new Ctor(url); }
      catch (e) { clearTimeout(giveUp); failStart(String((e && e.message) || e)); return; }
      up.onopen = () => {
        upOpen = true;
        try { up.send(JSON.stringify(conn.firstFrame || {})); } catch (_) {}
      };
      up.onmessage = async (ev) => {
        let raw = ev.data;
        if (typeof Blob !== 'undefined' && raw instanceof Blob) { try { raw = await raw.text(); } catch (_) { return; } }
        else if (raw instanceof ArrayBuffer) raw = new TextDecoder().decode(raw);
        let j; try { j = JSON.parse(String(raw)); } catch (_) { return; }
        const e = readLiveFrame(provider, j, finishing);
        switch (e.kind) {
          case 'ready':
            if (!answered) {
              answered = true;
              clearTimeout(giveUp);
              readyTold = true;
              emit({ type: 'ready', maxDurationMs: capMs });
              capTimer = setTimeout(() => finish('cap', false), capMs);
            }
            return;
          case 'interim': current = e.append ? current + e.text : e.text; pushText(); return;
          case 'settled':
            if (e.text) segments.push(e.text);
            current = '';
            pushText();
            if (finishing && rules.endsWhenNoOpenSegment && !segmentOpen()) wakeFinal();
            return;
          case 'activity':
            speaking = e.speaking;
            if (!e.speaking && finishing && rules.endsWhenNoOpenSegment && !segmentOpen()) wakeFinal();
            return;
          case 'done':
            if (typeof e.text === 'string') { segments = [e.text]; current = ''; }
            if (e.seconds != null && e.seconds > 0) providerSeconds = e.seconds;
            if (e.usage) providerUsage = e.usage;
            pushText();
            wakeFinal();
            return;
          case 'error':
            if (!answered) { answered = true; clearTimeout(giveUp); failStart(e.message); return; }
            emit({ type: 'error', stage: 'provider', message: e.message });
            wakeFinal();
            return;
          default:
        }
      };
      up.onerror = () => { if (!answered) { answered = true; clearTimeout(giveUp); failStart('provider socket error'); } };
      up.onclose = (ev) => {
        upOpen = false;
        if (!answered) {
          answered = true;
          clearTimeout(giveUp);
          failStart('provider closed on setup' + (ev && ev.code ? ' ' + ev.code : '') + (ev && ev.reason ? ': ' + String(ev.reason).slice(0, 200) : ''));
          return;
        }
        wakeFinal();
        finish('provider_closed', false);
      };
    }

    // Refused before «ready» — the relay sees an error before ready and goes
    // the server path (its own fallback).
    function failStart(why) {
      log('[lex-direct live] start failed: ' + why);
      sock.directFailed = why;
      emit({ type: 'error', stage: 'direct', message: why, direct: true });
      closeAll();
    }

    function closeAll() {
      if (capTimer) { clearTimeout(capTimer); capTimer = null; }
      try { if (up) { up.onopen = up.onmessage = up.onerror = up.onclose = null; up.close(); } } catch (_) {}
      up = null; upOpen = false;
      if (sock.readyState !== 3) {
        sock.readyState = 3;
        setTimeout(() => { try { sock.onclose && sock.onclose({ code: 1000 }); } catch (_) {} }, 0);
      }
    }

    async function finish(reason, quiet) {
      if (settled || finishing) { if (quiet) closeAll(); return; }
      finishing = true;
      if (reason === 'cap') emit({ type: 'closing', reason, maxDurationMs: capMs });
      if (up && upOpen && readyTold) {
        if (recipe.commitFrame) { try { up.send(JSON.stringify(recipe.commitFrame)); } catch (_) {} }
        if (!(rules.endsWhenNoOpenSegment && !segmentOpen())) {
          await Promise.race([
            new Promise((res) => { finalWaiter = res; }),
            new Promise((res) => setTimeout(res, rules.finalWaitMs)),
          ]);
        }
        finalWaiter = null;
      }
      settled = true;
      const text = current ? (segments.length ? segments.join(' ') + ' ' + current : current) : segments.join(' ');
      const audioSeconds = audioBytes / 2 / sampleRate;
      if (readyTold && typeof o.onReport === 'function') {
        try {
          o.onReport({
            kind: 'dictation-live', provider: (recipe.report && recipe.report.provider) || provider,
            model: (recipe.report && recipe.report.model) || recipe.model,
            usage: providerUsage || (providerSeconds ? { seconds: providerSeconds } : null),
            audioSeconds: Math.round(audioSeconds * 100) / 100,
            totalMs: Date.now() - startedAt,
            ttftMs: firstTextAt != null ? firstTextAt - startedAt : null,
            text: text || null,
            config,
          });
        } catch (_) {}
      }
      if (!quiet || readyTold) {
        emit({ type: 'final', text, seconds: providerSeconds || Math.round(audioSeconds * 10) / 10, billedCostUsd: null, reason, direct: true });
      }
      closeAll();
    }

    function handle(data) {
      let m; try { m = JSON.parse(String(data)); } catch (_) { return; }
      if (!m) return;
      if (m.type === 'start') { config = m.config || {}; openUpstream(); return; }
      if (m.type === 'ping') return;
      if (m.type === 'audio') {
        if (!up || !upOpen || !readyTold || finishing) return;
        const b64 = typeof m.b64 === 'string' ? m.b64 : '';
        if (!b64) return;
        audioBytes += Math.floor((b64.length * 3) / 4);
        try { up.send(JSON.stringify(fill(recipe.audioFrame, { LEX_PCM16_BASE64: b64 }))); } catch (_) {}
        return;
      }
      if (m.type === 'stop' || m.type === 'abort') finish(m.type === 'abort' ? 'abort' : 'stop', false);
    }

    return sock;
  }

  // ── OpenAI realtime: usage of response.done → the server's counters ────────
  // (the same mapping voice/openai-realtime.js parseOpenAIRealtimeBreakdown
  // makes; the server bills a pair by these names, 60-server.md «Голос: отчёты»).
  function realtimeUsage(usage) {
    if (!usage || typeof usage !== 'object') return null;
    const inD = usage.input_token_details || {};
    const outD = usage.output_token_details || {};
    const cached = inD.cached_tokens_details || {};
    // Totals with their cached parts: the server takes the cached part out of
    // the total itself (_shared/model-pricing.ts voiceCostSplit).
    return {
      audioInput: Number(inD.audio_tokens) || 0,
      audioCachedInput: Number(cached.audio_tokens) || 0,
      textInput: Number(inD.text_tokens) || 0,
      textCachedInput: Number(cached.text_tokens) || 0,
      audioOutput: Number(outD.audio_tokens) || 0,
      textOutput: Number(outD.text_tokens) || 0,
      thoughtsOutput: 0,
    };
  }
  function addUsage(a, b) {
    if (!a) return b ? Object.assign({}, b) : null;
    if (!b) return a;
    const out = Object.assign({}, a);
    for (const k of Object.keys(b)) out[k] = (Number(out[k]) || 0) + (Number(b[k]) || 0);
    return out;
  }

  // ── Calls by recipe, the same on both surfaces ───────────────────────────
  //
  // d — a LexDirectMode.create() instance. Each helper returns null when this
  // call has no recipe (the server path), and handles its own failure trace
  // (d.failure) when the one try did not work — the caller then goes the
  // server path too.

  const reportModelOf = (rc, fallback) => (rc.report && rc.report.model) || rc.model || fallback;

  // A file-shaped call (dictation, subtitle-asr). → {ok:true, text, ms, recipe}
  // | {ok:false, answered?} | null.
  // A provider that hangs must not hang the press: no answer (its headers) in
  // firstMs — the call is given up, and the caller takes the server path. An
  // answer begun is never followed by the server path (the provider is doing
  // the work, a second call would be a second job and a second bill): its
  // body may take as long as it keeps coming — the limit bodyMs is on the
  // silence between two pieces (a streamed transcription of a long recording
  // runs well past it), and an error after a 2xx head is final
  // (e.answered = true; fileCall → {ok:false, answered:true}). → {resp, text}.
  const FIRST_BYTE_MS = 20000;
  const BODY_MS = 15000;
  const SDP_MS = 10000;
  async function timedFetch(url, init, firstMs, bodyMs) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const gapMs = bodyMs || BODY_MS;
    let stage = 'answer';
    let timer = null;
    let resp = null;
    const arm = (ms) => { if (timer) clearTimeout(timer); timer = ctl ? setTimeout(() => ctl.abort(), ms) : null; };
    arm(firstMs);
    try {
      resp = await fetch(url, Object.assign({}, init, ctl ? { signal: ctl.signal } : {}));
      stage = 'body';
      arm(gapMs);
      let text = '';
      const reader = resp.body && typeof resp.body.getReader === 'function' ? resp.body.getReader() : null;
      if (reader) {
        const dec = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          arm(gapMs);
          text += dec.decode(value, { stream: true });
        }
        text += dec.decode();
      } else {
        text = await resp.text();
      }
      return { resp, text };
    } catch (e) {
      const err = (ctl && ctl.signal.aborted)
        ? new Error(stage === 'body'
          ? 'timeout: the provider\'s answer stopped for ' + Math.round(gapMs / 1000) + ' s'
          : 'timeout: no answer from the provider in ' + Math.round(firstMs / 1000) + ' s')
        : e;
      if (resp && resp.ok) { try { err.answered = true; } catch (_) {} }
      throw err;
    } finally { if (timer) clearTimeout(timer); }
  }

  async function fileCall(d, kind, body, input, tag) {
    const r = await d.recipe(kind, body);
    if (!r) return null;
    const at = Date.now();
    const fail = (error, httpStatus, answered) => {
      d.failure(kind, Object.assign({}, tag || {}, {
        provider: r.recipe.provider, model: reportModelOf(r.recipe, body.model), error,
        httpStatus: httpStatus || null, totalMs: Date.now() - at,
      }));
      return Object.assign({ ok: false, status: httpStatus || null }, answered ? { answered: true, error } : {});
    };
    try {
      const inp = Object.assign({}, input || {});
      // A JSON recipe carries the audio inline (Google): base64 only then.
      if (r.recipe.request && r.recipe.request.json && inp.base64 == null && inp.blob) inp.base64 = await blobBase64(inp.blob);
      const { url, init } = global.LexDirectMode.buildRequest(r.recipe, r.slots, inp);
      // A long recording takes the provider longer before it answers at all.
      const sec = Number(inp.audioSec);
      const firstMs = FIRST_BYTE_MS + (Number.isFinite(sec) && sec > 0 ? Math.round(sec * 500) : 0);
      const { resp, text } = await timedFetch(url, init, firstMs);
      if (!resp.ok) return fail(`HTTP ${resp.status}: ${text.slice(0, 200)}`, resp.status);
      return { ok: true, text, ms: Date.now() - at, recipe: r.recipe };
    } catch (e) {
      return fail(String((e && e.message) || e), null, !!(e && e.answered));
    }
  }
  async function blobBase64(blob) {
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  // File dictation. a: {model, knobs, blob, base64?, mime, fileName, durationMs?, tag}.
  // → {text, seconds, provider, ms} (the report is queued) | {failed, error}
  // (the provider's answer broke off: no server path for this press) | null.
  async function dictateFile(d, a) {
    const knobs = a.knobs || {};
    const res = await fileCall(d, 'dictation', { model: a.model, knobs },
      { blob: a.blob, base64: a.base64, mime: a.mime, fileName: a.fileName,
        audioSec: Number.isFinite(a.durationMs) ? a.durationMs / 1000 : null }, a.tag);
    if (res && res.answered) return { failed: true, error: res.error };
    if (!res || !res.ok) return null;
    const out = dictationResult(res.recipe.provider, res.text, knobs);
    const seconds = Number.isFinite(out.seconds) ? out.seconds
      : (Number.isFinite(a.durationMs) ? Math.round(a.durationMs) / 1000 : null);
    d.report(Object.assign({}, a.tag || {}, {
      kind: 'dictation', provider: res.recipe.provider, model: reportModelOf(res.recipe, a.model),
      usage: out.usage || null, audioSeconds: seconds, totalMs: res.ms, text: out.text || null,
    }));
    return { text: out.text || '', seconds, provider: res.recipe.provider, ms: res.ms };
  }

  // A piece of a video's audio → subtitle segments in the server's answer
  // shape (subtitle-asr). a: {model, knobs, blob, fileName, audioSec, tag}.
  // → {body, ms, provider} (the report is queued) | {failed, error} | null.
  async function subtitleFile(d, a) {
    const res = await fileCall(d, 'subtitle-asr', { model: a.model, knobs: a.knobs },
      { blob: a.blob, mime: a.blob && a.blob.type || 'audio/mpeg', fileName: a.fileName, audioSec: a.audioSec }, a.tag);
    if (res && res.answered) return { failed: true, error: res.error };
    if (!res || !res.ok) return null;
    let j = null;
    try { j = JSON.parse(res.text); } catch (_) { j = null; }
    if (!j) {
      d.failure('subtitle-asr', Object.assign({}, a.tag || {}, { provider: res.recipe.provider, model: a.model, error: 'answer is not JSON' }));
      // The provider answered (and billed): not a second job through the server.
      return { failed: true, error: 'the provider\'s answer is not JSON' };
    }
    const body = subtitleBody(res.recipe.provider, a.model, j, res.ms, a.audioSec);
    const rep = res.recipe.report || {};
    d.report(Object.assign({}, a.tag || {}, {
      kind: 'subtitle-asr', provider: res.recipe.provider, model: rep.model || a.model,
      usage: subtitleUsage(res.recipe.provider, j),
      audioSeconds: Number.isFinite(body.durationSec) ? body.durationSec : (Number.isFinite(a.audioSec) ? a.audioSec : null),
      totalMs: res.ms, addons: Array.isArray(rep.addons) ? rep.addons : [],
    }));
    return { body, ms: res.ms, provider: res.recipe.provider };
  }

  // Live dictation: the relay's `direct` hook (lex-dictation-relay.js). The
  // socket speaks to the provider by the recipe and answers the relay in the
  // language of the server's dictation-live. → {socket, failed(why)} | null.
  async function liveDictation(d, config, opts) {
    const cfg = config || {};
    const knobs = (cfg.knobs && typeof cfg.knobs === 'object') ? cfg.knobs : {};
    const model = typeof cfg.model === 'string' ? cfg.model : '';
    if (!model) return null;
    const r = await d.recipe('dictation-live', { model, knobs });
    if (!r) {
      try { opts && opts.log && opts.log('[lex-direct] dictation-live ' + model + ': no held recipe (' + (d.isDirect() ? 'miss' : 'server route') + ') — through the server'); } catch (_) {}
      return null;
    }
    const tag = {
      chatKey: cfg.chatKey || null, turnRef: cfg.turnRef || null, videoId: cfg.videoId || null,
      surface: cfg.surface || null, pageType: cfg.pageType || null,
    };
    const socket = createLiveDictationSocket({
      recipe: r.recipe, slots: r.slots,
      settledOnly: knobs.liveText === 'settled',
      WebSocket: opts && opts.WebSocket,
      onReport: (rep) => { const x = Object.assign({}, tag, rep); delete x.config; d.report(x); },
      log: opts && opts.log,
    });
    return {
      socket,
      failed: (why) => d.failure('dictation-live', Object.assign({}, tag, {
        provider: r.recipe.provider, model: reportModelOf(r.recipe, model), error: why,
      })),
    };
  }

  // The live voice of OpenAI: the device's offer → POST /v1/realtime/calls by
  // the recipe (multipart sdp + session). The answer cap is not taken by that
  // POST (OpenAI refuses it there — see buildSessionConfig in
  // voice/openai-realtime.js): it is cut out here, and the voice module sends
  // it over the data channel right after it opens.
  async function openaiCall(recipe, slots, sdp) {
    const at = Date.now();
    try {
      const conn = recipe.connect || {};
      const session = Object.assign({}, recipe.session || {});
      // Not in the POST: the ceiling of the answer (OpenAI refuses it there) and the functions (their documented
      // place is session.update — the window sends them first thing on the data channel, as the iPhone does).
      delete session.max_output_tokens;
      delete session.tools;
      delete session.tool_choice;
      const fd = new FormData();
      fd.set('sdp', String(sdp || ''));
      fd.set('session', JSON.stringify(session));
      // No answer in 10 s — the call is given up (the window takes the
      // server path): a hung provider would otherwise hang the press.
      const { resp, text } = await timedFetch(global.LexDirectMode.fill(conn.url, slots), {
        method: conn.method || 'POST', headers: global.LexDirectMode.fill(conn.headers || {}, slots), body: fd,
      }, SDP_MS, SDP_MS);
      if (!resp.ok) return { ok: false, status: resp.status, error: text.slice(0, 300), ms: Date.now() - at };
      const loc = resp.headers.get('Location') || '';
      return { ok: true, answerSdp: text, providerCallId: loc.split('/').pop() || null, ms: Date.now() - at };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e), ms: Date.now() - at };
    }
  }

  global.LexDirectProviders = Object.freeze({
    openaiCall,
    readGeminiTranscription, readMicrosoftTranscription, microsoftMarksOf,
    readDeepgramSubtitle, readGeminiSubtitle, readMicrosoftSubtitle, subtitleBody, subtitleUsage,
    dictationResult, readSse,
    readLiveFrame, createLiveDictationSocket, LIVE_RULES,
    realtimeUsage, addUsage,
    fileCall, dictateFile, subtitleFile, liveDictation, timedFetch,
  });
})(typeof self !== 'undefined' ? self : globalThis);
