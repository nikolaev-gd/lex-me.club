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
  let startedAt = 0;
  let closed = true;
  let connecting = false;
  let hooks = {};
  // Whether the READER muted themselves, kept apart from the first-turn guard
  // holding the microphone. Two different reasons for one track being off, and
  // conflating them means releasing the guard un-mutes somebody who did not
  // ask to be un-muted.
  let userMuted = false;
  // Идентификатор голосовой модели текущего разговора: его требует отчёт об
  // отбое, а он отправляется уже после того, как всё остальное снесено.
  let activeVoiceModelId = null;
  // Два факта, из которых складывается «человека уже слышно», и защёлка на
  // них. Разбор — у announceReady() ниже.
  let linkUp = false;
  let sessionUp = false;
  let readyTold = false;

  // What the reader is told, in words, at each stage. A voice session that
  // fails silently is indistinguishable from one that is listening.
  const GATE_TEXT = {
    login: 'Sign in to talk with the teacher.',
    balance: 'Your balance is too low for a voice conversation.',
    cap: 'Voice limit reached. Try again later.',
    // Гонка привязки сессии, пережившая ОДИН автоматический повтор. Про «другое
    // окно» здесь говорить нельзя: никакого другого окна нет, эта формулировка
    // была домыслом клиента о коде 409 — см. разбор у места повтора.
    race: 'Could not start the conversation. Press again.',
    no_listener: 'The server could not open the billing session — try again.',
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
  //
  // ⚠️ THE AUDIO BLOCK IS NOT WRITTEN HERE ANY MORE, and that was the bug.
  // This function used to send `input: { transcription: {...} }` and nothing
  // else — no `turn_detection` at all — so the session ran on OpenAI's
  // defaults: threshold 0.5, 500 ms of silence. On a phone, where the speaker
  // is centimetres from the microphone, that is enough for the teacher to hear
  // itself, decide it has been interrupted, and stop mid-sentence. The
  // extension has never had that problem because it builds the same block from
  // the owner's tuned knobs (threshold 0.75, silence 1500 ms). Those values now
  // come from WcVoiceConfig, which is that builder ported field for field and
  // kept honest by dev-tools/check-voice-config-parity.mjs.
  function buildSessionConfig(apiModel, voiceName, knobs) {
    const built = global.WcVoiceConfig.buildAudioConfig(knobs);
    const audio = built.audio;
    audio.output = Object.assign({}, audio.output, { voice: voiceName });
    const session = {
      type: 'realtime',
      model: apiModel,
      audio,
      truncation: {
        type: 'retention_ratio',
        retention_ratio: 0.8,
        token_limits: { post_instructions: 98304 },
      },
      // No `instructions`: in server-prompt mode anything sent here is
      // discarded by the broker, and sending it anyway only invites the
      // question of which one won.
    };
    if (built.reasoning) session.reasoning = built.reasoning;
    return session;
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
  //
  // ⚠️ EVERY TRANSCRIPT IS KEYED BY item_id. This used to be two flat strings
  // (`userText += delta`), and that is what produced BOTH of the transcript
  // bugs the owner photographed:
  //
  //   · «Understa nd» — two utterances overlap (exactly what self-interruption
  //     causes), their deltas arrive interleaved, and blind concatenation
  //     welds fragments of two different items into one bubble mid-word;
  //   · the reply appearing ABOVE the question — a second speech_started
  //     appends a second question bubble below the answer, while the answer's
  //     remaining deltas keep flowing into the bubble that is still above it.
  //
  // The extension has always keyed by item_id and refuses an event that
  // carries none (voice/openai-realtime.js:682, :760, :770, :822, :846, :857).
  // The server relays events VERBATIM (voice-watch/index.ts:1030), so item_id
  // survives the trip and there is nothing to reconstruct.
  const state = { items: new Map(), turns: 0 };

  function textOf(itemId) {
    const it = state.items.get(itemId);
    return it ? it.text : '';
  }
  function appendTo(itemId, role, delta) {
    let it = state.items.get(itemId);
    if (!it) { it = { role, text: '' }; state.items.set(itemId, it); }
    it.text += delta || '';
    return it.text;
  }

  function handleServerEvent(ev) {
    // An event with no item_id cannot be attributed to a bubble. Dropping it
    // is what the extension does, and it is safer than guessing "the current
    // one" — guessing is precisely how two utterances end up in one bubble.
    const id = ev.item_id;

    switch (ev.type) {
      case 'input_audio_buffer.speech_started':
        // Open the reader's bubble HERE, not on the transcript. Whisper is
        // slower than the server's voice-activity detector, so the answer
        // starts streaming before the question is transcribed — a bubble
        // created on the transcript lands UNDER the reply it answers. This is
        // the documented moment the detector has confirmed speech.
        if (!id) break;
        state.items.set(id, { role: 'user', text: '' });
        if (hooks.onUserStart) hooks.onUserStart(id);
        break;

      case 'conversation.item.input_audio_transcription.delta':
        if (!id) break;
        if (hooks.onUserDelta) hooks.onUserDelta(id, appendTo(id, 'user', ev.delta));
        break;

      case 'conversation.item.input_audio_transcription.completed': {
        if (!id) break;
        // The final transcript REPLACES the deltas, never appends to them —
        // appending is the duplication the extension recorded as v1.11.0 BUG 3.
        const finalText = ev.transcript || textOf(id);
        state.items.set(id, { role: 'user', text: finalText });
        if (hooks.onUserDone) hooks.onUserDone(id, finalText);
        break;
      }

      case 'conversation.item.input_audio_transcription.failed':
        if (!id) break;
        state.items.delete(id);
        // Drop the bubble opened in advance rather than leaving an empty one:
        // an empty bubble reads as "they said nothing".
        if (hooks.onUserFailed) hooks.onUserFailed(id);
        break;

      case 'response.output_audio_transcript.delta':
        if (!id) break;
        if (hooks.onAssistantDelta) hooks.onAssistantDelta(id, appendTo(id, 'assistant', ev.delta));
        break;

      case 'response.output_audio_transcript.done': {
        if (!id) break;
        const finalText = ev.transcript || textOf(id);
        state.items.set(id, { role: 'assistant', text: finalText });
        if (hooks.onAssistantDone) hooks.onAssistantDone(id, finalText);
        break;
      }

      case 'response.output_audio_buffer.started':
        // The teacher's voice actually started coming out of the speaker. This
        // is the moment the first-turn microphone guard is waiting for.
        firstTurn.heardAudio = true;
        if (hooks.onTeacherSpeaking) hooks.onTeacherSpeaking(true);
        break;

      case 'output_audio_buffer.stopped':
        if (hooks.onTeacherSpeaking) hooks.onTeacherSpeaking(false);
        releaseFirstTurnGuard('teacher-finished');
        break;

      case 'response.done':
        state.turns++;
        if (hooks.onTurnDone) hooks.onTurnDone();
        break;

      case 'error':
        warn('realtime error:', ev.error && ev.error.message);
        if (hooks.onError) hooks.onError((ev.error && ev.error.message) || 'voice session error');
        break;

      default:
        break;
    }
  }

  // ── The first-turn microphone guard — ВЫКЛЮЧЕНА 2026-08-28 ───────────────
  //
  // ⚠️ ЗАЩИТА СНЯТА. Одна строка ниже — `FIRST_TURN_GUARD = false`. Механизм
  // цел и не разобран; чтобы вернуть глушение, достаточно поставить `true`.
  //
  // Почему сняли — три факта, каждый из которых по отдельности отменяет её:
  //
  //   1. УЧИТЕЛЬ ПЕРВЫМ НЕ ЗДОРОВАЕТСЯ. Промпты это прямо запрещают, и в
  //      живых прогонах модель молчит, пока не заговорят с ней. Значит из
  //      двух веток снятия срабатывала ВСЕГДА одна и та же — «никто не
  //      заговорил за GREETING_WAIT_MS», — то есть защита работала вхолостую
  //      на КАЖДОМ веб-звонке, отнимая ~1850 мс у каждого.
  //
  //   2. ЖАЛОБА БЫЛА ПРО ДРУГОЕ. Учитель перебивал сам себя не в начале
  //      звонка, а на каждой реплике в течение всего разговора. Защита живёт
  //      только первую реплику и такую жалобу не закрывает в принципе.
  //
  //   3. ОБОСНОВАНИЕ В КОДЕ БЫЛО НЕВЕРНЫМ. Здесь стояло «у провайдера нет
  //      поля „эту реплику нельзя перебивать“». Поле есть, и Lex им уже
  //      пользуется: ручка voiceInterruptResponse разведена в
  //      turn_detection.interrupt_response (chat-knobs.js:247). Второе
  //      обоснование — полторы-две секунды на сходимость эхоподавителя —
  //      честно помечено «measured by other people»: в проекте этого не мерил
  //      никто.
  //
  // Цена, которую платили за всё это, — человеку писали «Listening», а его в
  // это время не было слышно. Приглашали говорить туда, где не слышат.
  //
  // Что НЕ трогали этой правкой: turn_detection, эхоподавление (оно как было
  // включено в getUserMedia, так и осталось), интерфейс и тексты.
  //
  // ── Ниже — исходное обоснование защиты, как оно было записано ────────────
  //
  // There is no API field for "this response may not be interrupted" — the
  // OpenAI schema's create_response/interrupt_response pair is not it (setting
  // both false stops the model answering at all, and interrupt_response:false
  // is reported as not honoured anyway). The reliable fix is on our side: do
  // not send microphone audio until the teacher's FIRST utterance is over.
  //
  // Two independent reasons, both measured by other people and both pointing
  // the same way: acoustic echo cancellation needs one to two seconds to
  // estimate the speaker-to-microphone delay before it suppresses anything,
  // and the greeting is exactly what lands inside that window. That is why the
  // symptom is «the first seconds» and not «the whole conversation».
  //
  // The guard releases on whichever comes first:
  //   · the teacher finished speaking (output_audio_buffer.stopped), or
  //   · nobody started speaking within GREETING_WAIT_MS — a session where the
  //     teacher waits for the reader must not sit deaf forever.
  //
  // ⚠️ ЗАХВАТ И ОТСЧЁТ — РАЗНЫЕ МОМЕНТЫ, и в первой версии этой защиты они были
  // одним. Дорожка глушится сразу, как только микрофон получен, — это верно и
  // так и осталось. А вот ОТСЧЁТ «учитель не здоровается» стартовал там же, то
  // есть ДО обмена SDP. Обмен идёт секунды (несколько кругов по сети — свойство
  // протокола, записано в шаге 2), таймер истекал прямо посреди него, защита
  // снималась ещё до того, как сессия вообще возникала, и микрофон встречал
  // приветствие открытым — ровно то, от чего она заводилась.
  //
  // Поймано не глазами: в сквозном проходе на экране не появилось НИ «Учитель
  // говорит…», НИ подписи про придержанный микрофон — то есть к моменту
  // соединения захвата уже не было.
  //
  // Поэтому отсчёт стартует отдельно, `startGreetingWait()`, ровно перед
  // `onConnected`.

  // ЕДИНСТВЕННЫЙ выключатель защиты. `true` — глушение первой реплики
  // возвращается целиком, ровно в том виде, в каком оно работало до
  // 2026-08-28. Ничего, кроме этой строки, для отката менять не надо.
  const FIRST_TURN_GUARD = false;

  const GREETING_WAIT_MS = 1600;
  // AEC has converged by the time the tail of the greeting has played out, but
  // the speaker is still physically ringing for a moment after the last sample.
  const SETTLE_MS = 250;
  const firstTurn = { armed: false, heardAudio: false, timer: null };

  // Заглушить дорожку. Зовётся сразу после getUserMedia: приветствие может
  // начать приходить в тот же миг, что и ответ брокера, и глушить позже — поздно.
  function armFirstTurnGuard() {
    if (!FIRST_TURN_GUARD) return;   // защита снята — дорожка открыта с первого кадра
    firstTurn.armed = true;
    firstTurn.heardAudio = false;
    if (micTrack) micTrack.enabled = false;
    if (hooks.onMicHeld) hooks.onMicHeld(true);
    clearTimeout(firstTurn.timer);
  }

  // Начать отсчёт «учитель молчит — значит ждёт нас». Только когда сессия уже
  // есть: до этого молчание ничего не означает, кроме того, что мы ещё не
  // соединились.
  function startGreetingWait() {
    if (!firstTurn.armed) return;
    if (firstTurn.heardAudio) return;   // учитель уже заговорил — ждём его конца
    clearTimeout(firstTurn.timer);
    firstTurn.timer = setTimeout(() => {
      if (!firstTurn.heardAudio) releaseFirstTurnGuard('no-greeting');
    }, GREETING_WAIT_MS);
  }

  function releaseFirstTurnGuard(why) {
    if (!firstTurn.armed) return;
    clearTimeout(firstTurn.timer);
    firstTurn.timer = setTimeout(() => {
      firstTurn.armed = false;
      // `userMuted` wins: releasing the guard must never switch the microphone
      // back on for somebody who muted it themselves while the teacher talked.
      if (micTrack && !userMuted) micTrack.enabled = true;
      if (hooks.onMicHeld) hooks.onMicHeld(false);
      log('first-turn guard released:', why);
    }, SETTLE_MS);
  }

  // ── «Listening» — по связи, а не по ответу брокера ───────────────────────
  //
  // Надпись приглашает говорить, поэтому появляться она обязана тогда, когда
  // сказанное УЖЕ СЛЫШНО. Чеканилась она из onConnected — то есть в тот миг,
  // когда брокер вернул ответ и мы применили его к соединению, — а транспорт
  // в этот момент только НАЧИНАЕТ подниматься. Замер на стенде (10 прогонов,
  // 2026-08-28, шаг опроса 20 мс): pc уходит в 'connecting' в тот же кадр,
  // что и надпись (расхождение 1-15 мс), а 'connected' приходит на 729-904 мс
  // позже, медиана 787. Ровно столько речи и терялось — и это ПОТЕРЯ, а не
  // задержка: WebRTC не буферизует звук, пойманный до готовности канала, он
  // его выбрасывает. Скидки на prefix_padding_ms здесь нет: серверный VAD
  // хранит то, что ПРИШЛО, а сказанное до подъёма транспорта не приходит
  // никуда.
  //
  // ⚠️ ФАКТОВ ДВА, И ПОРЯДОК ИХ НЕ ФИКСИРОВАН:
  //   · связь поднята      — pc.connectionState === 'connected';
  //   · сессия состоялась  — start() дошёл до конца, не отказав.
  // Обычно вторым приходит первый (обмен SDP кончается раньше, чем жмётся
  // DTLS), но между ними лежит ещё и session.update, и на медленной сети
  // порядок переворачивается. Чеканим по ВТОРОМУ из них. По одной только
  // связи надпись могла бы появиться перед отказом, который тут же снесёт
  // сессию: человеку сказали бы «говорите» и положили трубку.
  //
  // ⚠️ ФИКСИРОВАННОЙ ЗАДЕРЖКИ ЗДЕСЬ НЕТ И БЫТЬ НЕ МОЖЕТ. Она была бы подгонкой
  // под этот замер: на медленной сети соврала бы в другую сторону, на быстрой
  // отняла бы у человека время впустую.
  //
  // Защёлка на один раз: после каждого 'disconnected' — а это в живом
  // разговоре штатная рябь, из-за которой сессию и не рвут, — 'connected'
  // приходит снова. Без защёлки надпись перечеканивалась бы посреди речи и
  // заново запускала своё двухсекундное гашение.
  //
  // Тот же признак, по которому расширение чеканит «связь поднята» в плашке
  // «Голосовая связь» (voice/openai-realtime.js). Второго способа отвечать на
  // один и тот же вопрос в проекте быть не должно.
  function announceReady() {
    if (readyTold || !linkUp || !sessionUp) return;
    readyTold = true;
    if (hooks.onStage) hooks.onStage('ready');
  }

  // ── Start ────────────────────────────────────────────────────────────────
  async function start(opts) {
    if (!closed || connecting) return;
    connecting = true;
    hooks = (opts && opts.hooks) || {};
    state.items.clear();
    state.turns = 0;
    userMuted = false;
    linkUp = false;
    sessionUp = false;
    readyTold = false;
    // Said before any network work, because the wait that follows is the long
    // one and an empty screen during it is the complaint being fixed.
    if (hooks.onStage) hooks.onStage('mic');

    try {
      const voiceModelId = await WcStore.one('activeVoiceModelId_' + SCOPE, DEFAULT_VOICE_MODEL);
      activeVoiceModelId = voiceModelId;
      // One reader for both surfaces of this page — the knobs are per-key
      // (knob<Name>_<scope>), never an object. See wc-backend.readKnobs.
      const knobs = await global.WcBackend.readKnobs();
      const voiceName = knobs.voiceName || 'marin';

      // A conversation must exist before a paid call: llm-proxy requires a
      // bound session so the listener's row can never have a null session_id,
      // which is exactly what keeps it able to bill.
      const sessionId = await WcBus.call('WC_ENSURE_SESSION').then((r) => r && r.sessionId);
      if (sessionId == null) throw new Error('could not create a session for the conversation');

      // Mic first: a refused microphone should stop us before any server work.
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, autoGainControl: false, noiseSuppression: false },
      });
      micTrack = localStream.getAudioTracks()[0];
      if (!micTrack) throw new Error('the microphone yielded no track');
      // Held from the very first frame, before the track is even attached to
      // the connection — the greeting can start arriving the moment the answer
      // does, and arming after that is arming too late.
      armFirstTurnGuard();
      if (hooks.onLocalStream) hooks.onLocalStream(localStream);
      if (hooks.onStage) hooks.onStage('connecting');

      audioEl = document.createElement('audio');
      audioEl.autoplay = true;
      audioEl.style.display = 'none';
      audioEl.setAttribute('data-lex-voice-audio', '1');
      document.body.append(audioEl);

      pc = new RTCPeerConnection();
      pc.onconnectionstatechange = () => {
        log('pc', pc.connectionState);
        // Связь поднята — с этого мгновения звук физически идёт в модель.
        // Первый исходящий аудиопакет отстаёт отсюда на десятки миллисекунд
        // (замер на стенде — 26-80 мс, шаг опроса 20 мс; в расширении
        // независимо намерено 17-63), и гнаться за ним опросом getStats()
        // значило бы завести в продукте периодический таймер ради разницы
        // меньше слога. См. announceReady.
        if (pc.connectionState === 'connected' && !linkUp) { linkUp = true; announceReady(); }
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
      const открыть = (sid) => post('/functions/v1/llm-proxy/voice-sdp-openai', {
        model: voiceModelId,
        sdp: offer.sdp,
        session: buildSessionConfig(apiModel, voiceName, knobs),
        meta: {
          sessionId: sid,
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

      let r = await открыть(sessionId);

      // ⚠️ 409 БЫВАЕТ ДВУХ ВИДОВ, и различает их `stage`.
      //
      //   · stage 'session'    — `no_session`, гонка привязки. Сервер сам
      //     называет её временной и просит повторить (llm-proxy:234-239).
      //   · stage 'voice_busy' — у аккаунта УЖЕ ЕСТЬ живая строка
      //     `voice_sessions` со status='active' (llm-proxy:2590).
      //
      // Второй — это то, что видел владелец. И это не «в другом окне»: окно
      // одно, а строка осталась от ЕГО ЖЕ предыдущего разговора, потому что
      // раньше мы не сообщали серверу об отбое вовсе. Сама она снимается
      // только по устареванию — через пять минут.
      //
      // Настоящее лечение — закрывать строку на отбое (см. `endCallOnServer`
      // в stop()). Повтор оставлен для первого вида 409 и для случая, когда
      // отчёт об отбое не дошёл.
      const ПАУЗЫ = [800, 1800];
      for (let i = 0; i < ПАУЗЫ.length && !r.ok && r.status === 409; i++) {
        log('409 no_session — binding race, retrying', i + 1);
        if (hooks.onStage) hooks.onStage('connecting');
        await new Promise((res) => setTimeout(res, ПАУЗЫ[i]));
        let sid2 = null;
        try { sid2 = await WcBus.call('WC_ENSURE_SESSION').then((x) => x && x.sessionId); } catch (_) {}
        r = await открыть(sid2 == null ? sessionId : sid2);
      }

      if (!r.ok) {
        // `stage` travels with the status because the codes are not unique —
        // 503 is both "no listener" and "the account gate is unavailable" —
        // and the two deserve different words.
        const stage = r.json && r.json.stage;
        const gate = stage === 'no_listener' ? 'no_listener'
          : r.status === 402 ? 'balance'
          : r.status === 429 ? 'cap'
          : r.status === 409 ? 'race'
          : r.status === 401 ? 'login'
          : null;
        const err = new Error(GATE_TEXT[gate] || ((r.json && r.json.error) || ('voice did not come up: HTTP ' + r.status)));
        err.gate = gate;
        throw err;
      }

      callId = r.json.callId;
      startedAt = Date.now();
      closed = false;
      if (hooks.onStage) hooks.onStage('negotiating');
      await pc.setRemoteDescription({ type: 'answer', sdp: r.json.answerSdp });

      connectServerEvents(callId);

      // The one session.update the POST body cannot carry.
      const maxTokens = Number(knobs.voiceMaxResponseTokens) || null;
      if (maxTokens) {
        await sendServerCmd([{ type: 'session.update', session: { type: 'realtime', max_output_tokens: maxTokens } }]);
      }

      connecting = false;
      // Отсчёт «учитель не здоровается» — только отсюда. См. длинный комментарий
      // у startGreetingWait: запущенный раньше, он истекал посреди обмена SDP.
      startGreetingWait();
      if (hooks.onConnected) hooks.onConnected({ callId, apiModel: r.json.apiModel });
      // Сессия состоялась. Это ВТОРОЙ из двух фактов, а не сигнал «говорите»:
      // надпись отсюда больше не чеканится, см. announceReady.
      sessionUp = true;
      announceReady();
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
  // ── Сказать серверу, что мы положили трубку ──────────────────────────────
  //
  // Без этого строка `voice_sessions` остаётся со `status='active'`, и
  // следующий разговор ЭТОГО ЖЕ человека получает 409 `voice_busy` — пока
  // строку не снимет устаревание, то есть до пяти минут. Именно это владелец
  // видел как «голосовой разговор уже идёт в другом окне» на каждое второе
  // нажатие: никакого другого окна не было, была его собственная незакрытая
  // строка.
  //
  // Эндпоинт для этого и существует — «Clean teardown: end the live
  // voice_sessions row» (llm-proxy:2394-2400), и закрывает он её независимо от
  // того, легла ли строка расхода.
  //
  // ДЕНЕГ ЭТО НЕ КАСАЕТСЯ. Считает по-прежнему серверный слушатель: у него
  // authority, и наш отчёт при этом пишет ноль. Поле `accumulatorLost` мы не
  // ставим — именно оно, и только оно, поднимает на сервере тревогу «EMPTY
  // REPORT» (llm-proxy:1876-1880).
  async function endCallOnServer(id) {
    if (!id) return;
    const durationMs = startedAt ? Math.max(0, Date.now() - startedAt) : 0;
    try {
      const r = await post('/functions/v1/llm-proxy/voice-usage-report', {
        model: activeVoiceModelId || DEFAULT_VOICE_MODEL,
        durationMs,
        usage: {},
        meta: { callId: id, surface: 'standalone' },
      });
      if (!r.ok) warn('hang-up not confirmed by the server:', r.status, r.json && r.json.error);
      else log('the server closed the conversation row', id);
    } catch (e) {
      warn('could not report the hang-up:', e && e.message);
    }
  }

  async function stop(opts) {
    if (closed && !connecting) return;
    const reason = (opts && opts.reason) || 'manual';
    // Снимаем id ДО сноса: teardown обнуляет его, а отчёт без id бесполезен.
    const endingCallId = callId;
    await teardown();
    // AWAITED: «stop() вернулся» обязано значить «шлюз свободен». Иначе
    // человек, нажавший микрофон сразу после отбоя, упирается в собственную
    // же незакрытую сессию.
    await endCallOnServer(endingCallId);
    // AWAITED, not fired and forgotten: the handler is where the last exchange
    // gets written to the account, and "stop() resolved" has to mean "nothing
    // is still in flight". Without the await a caller that checks the
    // conversation right after hanging up reads it before the write lands.
    if (hooks.onDisconnected) await hooks.onDisconnected({ reason, turns: state.turns });
    log('stopped', reason, 'turns', state.turns);
  }

  async function teardown() {
    closed = true;
    clearTimeout(firstTurn.timer);
    firstTurn.timer = null;
    firstTurn.armed = false;
    firstTurn.heardAudio = false;
    linkUp = false;
    sessionUp = false;
    readyTold = false;
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
    //
    // The reader's choice is remembered separately from the first-turn guard,
    // and un-muting while the guard still holds the track does NOT open the
    // microphone: it records the intent, and the guard opens it when the
    // greeting is over. Otherwise a reader who taps the button during the
    // greeting would defeat the very protection they cannot see.
    mute(on) {
      userMuted = !!on;
      if (micTrack && !firstTurn.armed) micTrack.enabled = !userMuted;
    },
    // What the BUTTON should say — the reader's intent, not the track's state.
    // While the guard holds the track the two disagree on purpose, and showing
    // the track's state would render the button "unmuted → tap to mute" as
    // "muted", flipping its label for a second at the start of every call.
    muted() { return userMuted; },
    // Whether the microphone is being held by the first-turn guard rather than
    // by the reader. The screen says so in words; without it, a held mic is
    // indistinguishable from a broken one.
    micHeld() { return firstTurn.armed; },

    // Barge-in: stop the model talking over you.
    cancel() { return sendServerCmd([{ type: 'response.cancel' }]); },

    // ⚠️ NO settingsFields() ANY MORE — «Голос учителя» is the owner's control,
    // not the reader's, and this page was the only place it leaked out.
    //
    // Checked in the extension rather than assumed: the same select lives in
    // `emitVoiceModels` (settings-popover.js:131-135), which appears only
    // inside the `devMain`/`devWord` composites; those are wrapped by
    // `emitDevOnly` into a `hidden` div (settings-popover.js:733-735) that
    // exactly one line in the repo un-hides (chat-surface.js:9055-9056), and
    // only when `lexDevModeUiEnabled` is set — which background.js:4213 sets
    // solely when the signed-in address equals nikolaev.gd@gmail.com. An
    // ordinary user has never seen it on any surface, and the label «Голос
    // учителя» does not exist in the extension at all: this page invented it.
    //
    // The stored cell (`voiceNamesByProvider_<scope>`) is untouched and is
    // still READ at session start, so whatever the owner publishes still wins.
  };

  global.WcVoice = WcVoice;
})(typeof self !== 'undefined' ? self : globalThis);
