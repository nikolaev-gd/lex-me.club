// webchat/wc-voice.js — the live voice conversation.
//
// WebRTC to OpenAI Realtime, but the offer/answer exchange goes to OUR server,
// never to OpenAI. That is not plumbing preference, it is the security model:
// the ephemeral-token endpoint is deliberately closed (it let a client open a
// session with its own instructions, around the server's prompt), so llm-proxy
// does the exchange with its own key and assembles the teacher's instructions
// from the catalogue itself.
//
// ── Three consequences of server-prompt mode, all easy to get wrong ─────────
//
// 1. THE OFFER MUST CARRY NO DATA CHANNEL. The broker refuses an offer with an
//    `m=application` line outright — a data channel is the path an instruction
//    could take around it. So no pc.createDataChannel, and Realtime events do
//    NOT come back over the peer connection.
//
// 2. EVENTS ARRIVE OVER SUPABASE REALTIME. The server-side listener is also
//    the event bus: it forwards a whitelist of Realtime events to a broadcast
//    topic named after the call. The page subscribes to `voice:<callId>` with
//    a raw phoenix socket.
//
// 3. COMMANDS GO OUT THROUGH voice-cmd. With no data channel there is nothing
//    to write into, so a barge-in cancel or a seeded history item is POSTed to
//    the voice-cmd edge function, which checks the call belongs to the caller.
//
// ── Money ────────────────────────────────────────────────────────────────────
// Counted by the server-side listener (voice-watch), which attaches a second
// socket to the live call by an id only the server knows, bills each
// response.done and takes authority before its first bill. THE CLIENT DOES NOT
// SUBSTITUTE FOR IT and sends no usage report: the extension's teardown report
// exists for reconciliation, and once the listener has authority it writes
// zero anyway. "No listener, no conversation" holds here exactly as it does in
// the extension — the broker refuses to hand back an answer until a shift has
// reported that it is attached and counting.
//
// Gemini voice is excluded from this surface entirely — owner's decision.
(function (global) {
  'use strict';

  const TAG = '[wc-voice]';
  const A = () => global.LexWebAuth;
  const SCOPE = 'shorts-main';

  // Same model the extension's own voice scenarios pin. It comes from the
  // published set when there is one.
  const DEFAULT_VOICE_MODEL = 'gpt-realtime-mini';

  const log = (...a) => { if (global.lexDebug && global.lexDebug.enabled) console.log(TAG, ...a); };
  const warn = (...a) => console.warn(TAG, ...a);

  let pc = null;
  let audioEl = null;
  let localStream = null;
  let micTrack = null;
  let eventsWs = null;
  let eventsHb = null;
  let eventsSeen = null;
  let callId = null;
  let closed = true;
  let connecting = false;
  let hooks = {};

  // What the reader is told, in words, at each stage. A voice session that
  // fails silently is indistinguishable from one that is listening.
  const GATE_TEXT = {
    login: 'Войдите в аккаунт, чтобы говорить с учителем.',
    balance: 'На балансе не хватает денег на голосовой разговор.',
    cap: 'Достигнут предел по голосу. Попробуйте позже.',
    busy: 'Голосовой разговор уже идёт в другом окне.',
    no_listener: 'Сервер не смог начать счёт разговора — попробуйте ещё раз.',
  };

  async function post(path, body) {
    const token = await A().validToken();
    if (!token) { const e = new Error(GATE_TEXT.login); e.gate = 'login'; throw e; }
    const resp = await fetch(A().supabaseUrl() + path, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        apikey: A().anonKey(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const json = await resp.json().catch(() => ({}));
    return { ok: resp.ok, status: resp.status, json };
  }

  // ── The session object ───────────────────────────────────────────────────
  // Ported field for field, because every one of them was bought with a live
  // request. Two that look arbitrary and are not:
  //   · truncation.token_limits.post_instructions = 98304 — NOT 128000. The
  //     provider answers "Expected a value <= 98304"; go higher and voice stops
  //     coming up at all rather than slightly under-performing.
  //   · max_output_tokens is absent here on purpose: POST /v1/realtime/calls
  //     rejects it. It goes as a session.update once the session exists.
  function buildSessionConfig(apiModel, voiceName) {
    return {
      type: 'realtime',
      model: apiModel,
      audio: {
        input: { transcription: { model: 'gpt-4o-mini-transcribe' } },
        output: { voice: voiceName },
      },
      truncation: {
        type: 'retention_ratio',
        retention_ratio: 0.8,
        token_limits: { post_instructions: 98304 },
      },
      // No `instructions`: in server-prompt mode anything sent here is
      // discarded by the broker, and sending it anyway only invites the
      // question of which one won.
    };
  }

  // ── Events over Supabase Realtime ────────────────────────────────────────
  function connectServerEvents(id) {
    const wsUrl = A().supabaseUrl().replace(/^http/, 'ws')
      + '/realtime/v1/websocket?apikey=' + encodeURIComponent(A().anonKey()) + '&vsn=1.0.0';
    const topic = 'realtime:voice:' + id;
    eventsSeen = new Set();
    let ref = 0;

    const open = () => {
      if (closed) return;
      let sock;
      try { sock = new WebSocket(wsUrl); } catch (e) { warn('events ws create failed:', e && e.message); return; }
      eventsWs = sock;

      sock.onopen = () => {
        try {
          sock.send(JSON.stringify({
            topic, event: 'phx_join', ref: String(++ref),
            payload: { config: { broadcast: { self: false }, presence: { key: '' }, private: false } },
          }));
        } catch (_) {}
        if (eventsHb) clearInterval(eventsHb);
        eventsHb = setInterval(() => {
          try { sock.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', ref: String(++ref), payload: {} })); }
          catch (_) {}
        }, 25000);
        log('events joined', topic);
      };

      sock.onmessage = (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch (_) { return; }
        if (!m || m.event !== 'broadcast' || m.topic !== topic) return;
        const inner = m.payload && m.payload.payload;
        if (!inner || !inner.type) return;
        // Shifts overlap by design, so the same event can arrive twice.
        if (inner.event_id) {
          if (eventsSeen.has(inner.event_id)) return;
          eventsSeen.add(inner.event_id);
          if (eventsSeen.size > 4096) {
            const first = eventsSeen.values().next();
            if (!first.done) eventsSeen.delete(first.value);
          }
        }
        if (inner.type === 'lex.session.ended') {
          log('server ended session:', inner.reason);
          stop({ reason: inner.reason || 'server-ended' });
          return;
        }
        handleServerEvent(inner);
      };

      sock.onclose = () => {
        if (eventsHb) { clearInterval(eventsHb); eventsHb = null; }
        // A transient drop costs the transcript, not the audio — the voice
        // keeps flowing over WebRTC. One reconnect per drop.
        if (!closed && eventsWs === sock) {
          log('events dropped — reconnecting');
          setTimeout(() => { if (!closed) open(); }, 1000);
        }
      };
      sock.onerror = () => { /* onclose follows */ };
    };

    open();
  }

  function sendServerCmd(commands) {
    if (!callId) return Promise.resolve(null);
    return post('/functions/v1/voice-cmd', { callId, commands })
      .then((r) => {
        if (!r.ok) warn('voice-cmd relay failed:', r.status, r.json && r.json.error);
        return r;
      })
      .catch((e) => { warn('voice-cmd threw:', e && e.message); return null; });
  }

  // ── What the reader sees while talking ───────────────────────────────────
  const state = { userText: '', assistantText: '', turns: 0 };

  function handleServerEvent(ev) {
    switch (ev.type) {
      case 'input_audio_buffer.speech_started':
        // Pre-create the reader's own bubble HERE, not on the transcript.
        // Whisper is slower than the server's voice-activity detector, so the
        // answer starts streaming before the question is transcribed — and a
        // bubble created on the transcript lands UNDER the reply it answers.
        // This is the documented moment the detector has confirmed speech.
        state.userText = '';
        if (hooks.onUserStart) hooks.onUserStart();
        break;
      case 'conversation.item.input_audio_transcription.delta':
        state.userText += ev.delta || '';
        if (hooks.onUserDelta) hooks.onUserDelta(state.userText);
        break;
      case 'conversation.item.input_audio_transcription.completed':
        state.userText = ev.transcript || state.userText;
        if (hooks.onUserDone) hooks.onUserDone(state.userText);
        break;
      case 'conversation.item.input_audio_transcription.failed':
        // Clean up the bubble that was opened in advance rather than leaving
        // an empty one on screen.
        if (hooks.onUserFailed) hooks.onUserFailed();
        break;
      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta':
        state.assistantText += ev.delta || '';
        if (hooks.onAssistantDelta) hooks.onAssistantDelta(state.assistantText);
        break;
      case 'response.done':
        state.turns++;
        if (hooks.onAssistantDone) hooks.onAssistantDone(state.assistantText);
        state.assistantText = '';
        break;
      case 'error':
        warn('realtime error:', ev.error && ev.error.message);
        if (hooks.onError) hooks.onError((ev.error && ev.error.message) || 'ошибка голосовой сессии');
        break;
      default:
        break;
    }
  }

  // ── Start ────────────────────────────────────────────────────────────────
  async function start(opts) {
    if (!closed || connecting) return;
    connecting = true;
    hooks = (opts && opts.hooks) || {};
    state.userText = '';
    state.assistantText = '';
    state.turns = 0;

    try {
      const voiceModelId = await WcStore.one('activeVoiceModelId_' + SCOPE, DEFAULT_VOICE_MODEL);
      // One reader for both surfaces of this page — the knobs are per-key
      // (knob<Name>_<scope>), never an object. See wc-backend.readKnobs.
      const knobs = await global.WcBackend.readKnobs();
      const voiceName = knobs.voiceName || 'marin';

      // A conversation must exist before a paid call: llm-proxy requires a
      // bound session so the listener's row can never have a null session_id,
      // which is exactly what keeps it able to bill.
      const sessionId = await WcBus.call('WC_ENSURE_SESSION').then((r) => r && r.sessionId);
      if (sessionId == null) throw new Error('не удалось завести сессию для разговора');

      // Mic first: a refused microphone should stop us before any server work.
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, autoGainControl: false, noiseSuppression: false },
      });
      micTrack = localStream.getAudioTracks()[0];
      if (!micTrack) throw new Error('микрофон не дал дорожку');

      audioEl = document.createElement('audio');
      audioEl.autoplay = true;
      audioEl.style.display = 'none';
      audioEl.setAttribute('data-lex-voice-audio', '1');
      document.body.append(audioEl);

      pc = new RTCPeerConnection();
      pc.onconnectionstatechange = () => {
        log('pc', pc.connectionState);
        // Only 'failed' is fatal; 'disconnected' recovers on its own often
        // enough that tearing down on it drops healthy sessions.
        if (pc.connectionState === 'failed') stop({ reason: 'connection-failed' });
      };
      pc.ontrack = (e) => {
        audioEl.srcObject = e.streams[0];
        if (hooks.onRemoteStream) hooks.onRemoteStream(e.streams[0]);
      };
      pc.addTrack(micTrack, localStream);

      // NO createDataChannel — see the header. An m=application line in the
      // offer is refused by the broker.
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const promptRefs = {
        base: { scope: SCOPE, cell: 'chatPrompts', slot: await activeSlot('activeChatPromptId', 'chatB1') },
        content: { scope: SCOPE, cell: 'contentTypePrompts', slot: 'text' },
        voice: { scope: SCOPE, cell: 'voicePrompts', slot: await activeSlot('activeVoicePromptId', 'voice1') },
      };

      const apiModel = resolveVoiceApiModel(voiceModelId);
      const r = await post('/functions/v1/llm-proxy/voice-sdp-openai', {
        model: voiceModelId,
        sdp: offer.sdp,
        session: buildSessionConfig(apiModel, voiceName),
        meta: {
          sessionId,
          videoId: (opts && opts.conversationId) || null,
          surface: 'standalone',
          pageType: 'text',
          promptSource: 'server',
          promptScope: promptRefs.base.scope,
          promptCell: promptRefs.base.cell,
          promptSlot: promptRefs.base.slot,
          promptContentScope: promptRefs.content.scope,
          promptContentCell: promptRefs.content.cell,
          promptContentSlot: promptRefs.content.slot,
          promptVoiceScope: promptRefs.voice.scope,
          promptVoiceCell: promptRefs.voice.cell,
          promptVoiceSlot: promptRefs.voice.slot,
        },
      });

      if (!r.ok) {
        // `stage` travels with the status because the codes are not unique —
        // 503 is both "no listener" and "the account gate is unavailable" —
        // and the two deserve different words.
        const stage = r.json && r.json.stage;
        const gate = stage === 'no_listener' ? 'no_listener'
          : r.status === 402 ? 'balance'
          : r.status === 429 ? 'cap'
          : r.status === 409 ? 'busy'
          : r.status === 401 ? 'login'
          : null;
        const err = new Error(GATE_TEXT[gate] || ((r.json && r.json.error) || ('голос не поднялся: HTTP ' + r.status)));
        err.gate = gate;
        throw err;
      }

      callId = r.json.callId;
      closed = false;
      await pc.setRemoteDescription({ type: 'answer', sdp: r.json.answerSdp });

      connectServerEvents(callId);

      // The one session.update the POST body cannot carry.
      const maxTokens = Number(knobs.voiceMaxResponseTokens) || null;
      if (maxTokens) {
        await sendServerCmd([{ type: 'session.update', session: { type: 'realtime', max_output_tokens: maxTokens } }]);
      }

      connecting = false;
      if (hooks.onConnected) hooks.onConnected({ callId, apiModel: r.json.apiModel });
      log('connected', callId, r.json.apiModel);
      return { callId };
    } catch (err) {
      connecting = false;
      await teardown();
      throw err;
    }
  }

  async function activeSlot(key, fallback) {
    const v = await WcStore.one(key, null);
    return v || fallback;
  }

  function resolveVoiceApiModel(voiceModelId) {
    const reg = global.LexModelRegistry;
    try {
      const facts = reg && reg.resolveModelFacts ? reg.resolveModelFacts(voiceModelId) : null;
      if (facts && facts.apiModel) return facts.apiModel;
    } catch (_) { /* fall through */ }
    return voiceModelId;
  }

  // ── Stop ─────────────────────────────────────────────────────────────────
  async function stop(opts) {
    if (closed && !connecting) return;
    const reason = (opts && opts.reason) || 'manual';
    await teardown();
    // AWAITED, not fired and forgotten: the handler is where the last exchange
    // gets written to the account, and "stop() resolved" has to mean "nothing
    // is still in flight". Without the await a caller that checks the
    // conversation right after hanging up reads it before the write lands.
    if (hooks.onDisconnected) await hooks.onDisconnected({ reason, turns: state.turns });
    log('stopped', reason, 'turns', state.turns);
  }

  async function teardown() {
    closed = true;
    // The events socket is closed LAST and deliberately not before the peer
    // connection: a reply still arriving at hangup should still be seen by the
    // listener that bills it. The listener is server-side and does not depend
    // on this socket, but the transcript on screen does.
    if (eventsHb) { clearInterval(eventsHb); eventsHb = null; }
    try { if (eventsWs) eventsWs.close(); } catch (_) {}
    eventsWs = null;
    eventsSeen = null;

    try { if (pc) pc.close(); } catch (_) {}
    pc = null;
    try { if (localStream) localStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    localStream = null;
    micTrack = null;
    if (audioEl) {
      try { audioEl.srcObject = null; audioEl.remove(); } catch (_) {}
      audioEl = null;
    }
    callId = null;
    connecting = false;
  }

  const WcVoice = {
    // The capability answer for THIS surface. Deliberately not the flag in
    // web/lex-platform-web.js: that one gates the older web build's buttons,
    // and flipping it would light up controls there that have no handlers
    // behind them. See the journal, decision 0.4.
    available: true,

    get active() { return !closed; },
    get connecting() { return connecting; },
    callId: () => callId,
    turns: () => state.turns,

    start,
    stop,
    toggle(opts) { return (!closed || connecting) ? stop() : start(opts); },

    // Mic on/off without ending the session — the reader's way to think in
    // peace without hanging up.
    mute(on) { if (micTrack) micTrack.enabled = !on; },
    muted() { return !!(micTrack && !micTrack.enabled); },

    // Barge-in: stop the model talking over you.
    cancel() { return sendServerCmd([{ type: 'response.cancel' }]); },

    async settingsFields() {
      const { el } = WcUI;
      const key = 'voiceNamesByProvider_' + SCOPE;
      const stored = await WcStore.get([key]);
      const map = stored[key] || {};
      const VOICES = ['marin', 'cedar', 'alloy', 'echo', 'shimmer'];
      const sel = el('select', {
        // Written into the SAME cell the extension uses — a map keyed by
        // provider, not a flat value: one account can prefer a different voice
        // on each provider, and a flat value would overwrite the other's.
        onchange: async (e) => {
          await WcStore.set({ [key]: Object.assign({}, map, { openai: e.target.value }) });
        },
      }, VOICES.map((v) => el('option', { value: v, text: v, selected: v === (map.openai || 'marin') })));

      return [el('.wc-field', {}, [
        el('.wc-field-row', {}, [
          el('.wc-field-label', {}, [
            el('b', { text: 'Голос учителя' }),
            el('span', { text: 'Каким голосом он говорит вслух' }),
          ]),
          sel,
        ]),
      ])];
    },
  };

  global.WcVoice = WcVoice;
})(typeof self !== 'undefined' ? self : globalThis);
