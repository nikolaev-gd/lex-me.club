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
// Gemini voice on this page is the extension's own module (voice/gemini-live.js,
// see startGemini below); this header is about the OpenAI path.
(function (global) {
  'use strict';

  const TAG = '[wc-voice]';
  // Имена кадров транспорта голосовой сессии — из общего модуля
  // (lex-voice-events.js), а не своей строкой. Своя строка здесь уже
  // расходилась: имя с приставкой `response.` не совпадает ни с чем и не
  // даёт ошибки — ветка просто молча не срабатывает.
  const VoiceEvents = global.LexVoiceEvents;
  const A = () => global.LexWebAuth;
  const SCOPE = 'shorts-main';

  // Same model the extension's own voice scenarios pin. It comes from the
  // published set when there is one.
  const DEFAULT_VOICE_MODEL = 'gpt-realtime-mini';

  const log = (...a) => { if (global.lexDebug && global.lexDebug.enabled) console.log(TAG, ...a); };

  // Как берётся микрофон разговора — и на старте, и заново, когда дорожка
  // кончилась (lex-mic-watch.js). Одно место, чтобы новая дорожка не
  // оказалась с другой обработкой звука, чем первая.
  const MIC_AUDIO = { echoCancellation: true, autoGainControl: false, noiseSuppression: false };
  const warn = (...a) => console.warn(TAG, ...a);

  let pc = null;
  let audioEl = null;
  let localStream = null;
  let micTrack = null;
  // Слежка «микрофон отобрали» (lex-mic-watch.js) за дорожкой разговора.
  let micWatch = null;
  let eventsWs = null;
  let eventsHb = null;
  let eventsSeen = null;
  let callId = null;
  let startedAt = 0;
  let closed = true;
  let connecting = false;
  // Номер попытки старта. teardown() его сдвигает, и старт, который ждал
  // сервера или микрофона, узнаёт, что его уже отменили (stale() в start()).
  // Одного флага connecting для этого мало: «положил трубку и сразу нажал
  // снова» заводит новую попытку, и её connecting=true старая приняла бы за
  // свой. Сервер держит старт до срока замены, пока ждёт прежний разговор, —
  // окно для такого нажатия стало долгим. Тот же приём, что у айфона
  // (VoiceSession.swift, `run == generation`).
  let attempt = 0;
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
    // Другой живой разговор этого аккаунта — во второй вкладке, в программе
    // для Мака, на телефоне. Закончить его может только тот, кто его ведёт.
    elsewhere: 'A voice conversation is already running in another window or on another device. End it there first.',
    no_listener: 'The server could not open the billing session — try again.',
    // Сервер ждал места в очереди платных вызовов аккаунта (до 30 с,
    // supabase/functions/_shared/call-slot.ts) и не дождался. Текст — общий
    // «сервис занят» из lex-error-text.js, тот же, что у чата.
    busy: (typeof LexErrorText !== 'undefined' && LexErrorText.busy)
      ? LexErrorText.busy()
      : 'The service is overloaded right now. Please try again in a minute.',
    // Голосовая модель, которой этот экран говорить не умеет, или сервер
    // отказал в самой модели (400 stage 'model'). Сырое «unknown or non-openai
    // voice model» на экран не идёт.
    model: 'This voice model is not available for a conversation here.',
    // Промпт по указателям не нашёлся (424) — тот же текст, что у чата.
    prompt: 'The teacher’s instructions are not published yet. Try again later.',
    generic: 'Could not start the conversation. Please try again.',
  };
  // Реплика разговора не дошла до сервера и после повторов (voice/call-server.js):
  // в беседе её нет, и учитель в тексте её не увидит. Тот же текст, что у
  // расширения (voice.status.turnNotSaved).
  const TURN_NOT_SAVED = 'A phrase from this voice conversation was not saved to the chat — the teacher won’t see it later in text.';

  // Why a conversation ended without the reader ending it, in words — one line
  // per reason the server sends with lex.session.ended (voice-watch and
  // voice-reaper), plus the one this page detects itself. The reason itself is
  // a machine word and never reaches the screen. Both languages live here; the
  // page has no language switch yet and speaks English everywhere, so `en` is
  // what it shows today. Ends the reader chose (the cross, leaving the chat)
  // stay silent — VOICE_END_BY_READER in wc-app.js.
  const ENDED_TEXT = {
    time_cap: {
      en: 'The conversation reached its time limit.',
      ru: 'Разговор закончился: вышло отведённое на него время.',
    },
    silence: {
      en: 'The conversation ended after a long silence.',
      ru: 'Разговор закончился: долго было тихо.',
    },
    client_gone: {
      en: 'The conversation ended: the connection was lost.',
      ru: 'Разговор закончился: пропала связь.',
    },
    budget_cap: {
      en: 'The conversation ended: your balance ran out.',
      ru: 'Разговор закончился: на балансе кончились деньги.',
    },
    listener_lost: {
      en: 'The conversation was cut off on the server. Press to start again.',
      ru: 'Разговор оборвался на сервере. Нажмите, чтобы начать заново.',
    },
    'connection-failed': {
      en: 'The conversation ended: the connection failed.',
      ru: 'Разговор закончился: связь не удалось удержать.',
    },
    // The server stopped confirming the conversation — either voice. Noticed
    // by the voice module (voice/call-server.js: the presence beat went
    // unanswered for 10 s or a turn was not accepted) or, for OpenAI voice, by
    // the server-side listener that could not write a turn or charge for it
    // and hung up. No server, no Lex.
    server_silent: {
      en: 'The conversation ended: the Lex server stopped confirming it. Press to start again.',
      ru: 'Разговор закончился: сервер Lex перестал его подтверждать. Нажмите, чтобы начать заново.',
    },
    signed_out: {
      en: 'The conversation ended: you were signed out. Sign in and press to start again.',
      ru: 'Разговор закончился: вы вышли из аккаунта. Войдите и нажмите, чтобы начать заново.',
    },
    // Detected by this page: another app took the microphone (lex-mic-watch.js).
    mic_lost: {
      en: 'The conversation ended: another app took the microphone.',
      ru: 'Разговор закончился: микрофон забрало другое приложение.',
    },
    // Anything else — a reason added on the server later, or none at all.
    other: {
      en: 'The conversation has ended.',
      ru: 'Разговор закончился.',
    },
  };
  // Концы, которые заметило устройство потому, что сервер перестал отвечать
  // или пускать: его ответа на отбой такой конец не ждёт.
  const SERVER_GONE = new Set(['server_silent', 'signed_out']);
  function endedText(reason, lang) {
    const row = Object.prototype.hasOwnProperty.call(ENDED_TEXT, reason) ? ENDED_TEXT[reason] : ENDED_TEXT.other;
    return row[lang === 'ru' ? 'ru' : 'en'];
  }

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

    // Тема разговора приватная: Realtime пускает в неё только по пропуску, и
    // правило в базе сверяет, что этот call_id принадлежит вошедшему. Поэтому
    // токен берётся ПЕРЕД каждым подключением, в том числе перед повторным:
    // разговор может пережить продление пропуска, а старый токен Realtime уже
    // не примет.
    const open = async () => {
      if (closed) return;
      let token = null;
      try { token = await A().validToken(); } catch (_) { token = null; }
      if (closed) return;
      if (!token) { warn('events: нет пропуска — канал разговора не открыть'); return; }
      let sock;
      try { sock = new WebSocket(wsUrl); } catch (e) { warn('events ws create failed:', e && e.message); return; }
      eventsWs = sock;

      sock.onopen = () => {
        try {
          sock.send(JSON.stringify({
            topic, event: 'phx_join', ref: String(++ref),
            payload: {
              config: { broadcast: { self: false }, presence: { key: '' }, private: true },
              access_token: token,
            },
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
          // Через общий модуль (voice/call-server.js): причину «пропал
          // собеседник» при неподтверждённом пульсе он читает как «сервер
          // молчит». Модуля нет, только пока номер звонка не назван.
          if (callServer) callServer.endedByServer(inner.reason || 'server-ended');
          else stop({ reason: inner.reason || 'server-ended' });
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
          setTimeout(() => { if (!closed) open().catch(() => {}); }, 1000);
        }
      };
      sock.onerror = () => { /* onclose follows */ };
    };

    open().catch((e) => warn('events open threw:', e && e.message));
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

  // ── Пульс присутствия ──────────────────────────────────────────────────────
  // Единственное, из чего сервер узнаёт, что человек всё ещё на линии. Без него
  // потеря связи посреди разговора серверу не видна вовсе: слушатель сидит между
  // сервером и OpenAI и о странице ничего не знает, а OpenAI о пропавшем
  // собеседнике молчит и замечает его сам только через ~29 с. Замер до пульса —
  // строка разговора закрывалась через 36-38 с, и всё это время следующее
  // нажатие упиралось в собственное «занято».
  //
  // Сам пульс — общий модуль voice/call-server.js, тот же, что у расширения и
  // у голоса Google на этой странице (до 2026-09-30 у голоса OpenAI здесь был
  // свой, и он знал только ответ 404). Раз в 3 с при пороге 10 с на сервере.
  // Заводится СРАЗУ по получении call_id, а не когда разговор «пошёл», — срок
  // на сервере взводится ПЕРВЫМ ударом, и дыра между ним и вторым не должна
  // быть длиннее порога.
  //
  // Модуль несёт и страховку «сервер молчит»: пульс не подтверждён 10 с (нет
  // ответа, сбой сервера, вышел из аккаунта) — разговор кончается здесь, с
  // надписью ENDED_TEXT.server_silent (или signed_out). Звук идёт к OpenAI
  // мимо нашего сервера, и без этого учитель продолжал бы говорить, пока
  // сервер лежит, а ходы этого времени не записывались бы и не списывались.
  // На старте она ничего не ждёт: отсчёт идёт от мига, когда сервер назвал
  // номер звонка.
  //
  // 404 на пульс — у сервера этого разговора больше нет. Запасной путь к
  // событию lex.session.ended: широковещание не повторяется, и если в миг
  // отбоя канал событий переподключался, страница иначе узнала бы о конце
  // только когда WebRTC сам сочтёт связь потерянной — через десятки секунд и с
  // чужой причиной. Причину сервер кладёт в ответ.
  let callServer = null;
  function startPresenceBeat() {
    if (callServer || !callId) return;
    const id = callId;
    const mine = () => !closed && callId === id;
    callServer = global.LexVoiceCallServer.create({
      log, warn,
      host: makePageHost(null),
      isClosed: () => !mine(),
      onServerEnded: (reason) => { if (mine()) stop({ reason: reason || 'server-ended' }); },
      onServerFailure: (info) => { if (mine()) stop({ reason: (info && info.reason) || 'server_silent' }); },
    });
    callServer.setCallId(id);
  }
  function stopPresenceBeat() {
    if (callServer) { callServer.stopPresence(); callServer = null; }
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
      case 'input_audio_buffer.committed':
        // Open the reader's bubble HERE, not on the transcript. The recognizer is
        // slower than the server's voice-activity detector, so the answer
        // starts streaming before the question is transcribed — a bubble
        // created on the transcript lands UNDER the reply it answers. This is
        // the documented moment the detector has confirmed speech.
        //
        // `committed` (the person finished the phrase) is the same place taken
        // a second time, for a phrase whose `speech_started` never arrived:
        // events are broadcast once, and a phrase begun in the first fraction
        // of a second — before this page joined the call's channel — loses it.
        // It still comes before the reply is created, so the order holds.
        if (!id || state.items.has(id)) break;
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

      case VoiceEvents.OUTPUT_AUDIO_STARTED:
        // The teacher's voice actually started coming out of the speaker. This
        // is the moment the first-turn microphone guard is waiting for.
        //
        // Имя кадра берётся из общего модуля, а не пишется здесь: своей
        // копией оно тут и разъехалось. Стояла лишняя приставка `response.`,
        // которой у кадров транспорта нет, — и ветка не срабатывала ни разу.
        // Замерено на живом звонке: пара приходит без приставки, и её вторая
        // половина, `.stopped` ниже, была написана верно — поэтому половина
        // пары работала, а половина нет.
        firstTurn.heardAudio = true;
        if (hooks.onTeacherSpeaking) hooks.onTeacherSpeaking(true);
        break;

      case VoiceEvents.OUTPUT_AUDIO_STOPPED:
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
    const my = ++attempt;
    // Отменена ли эта попытка (stop → teardown, возможно уже с новой попыткой
    // поверх). Отменённая попытка общего состояния модуля не трогает: оно
    // уже принадлежит teardown или новой попытке.
    const stale = () => my !== attempt;
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

      // Голос Google — общий модуль voice/gemini-live.js, тот же, что в
      // расширении (ниже, startGemini). Модель, которой нет ни у OpenAI, ни у
      // Google, — понятная фраза, а не сырой отказ сервера.
      const provider = voiceProviderOf(voiceModelId);
      if (provider === 'google') return await startGemini(opts, voiceModelId, knobs, stale);
      if (provider !== 'openai') { const e = new Error(GATE_TEXT.model); e.gate = 'model'; throw e; }

      // A conversation must exist before a paid call: llm-proxy requires a
      // bound session so the listener's row can never have a null session_id,
      // which is exactly what keeps it able to bill.
      const sessionId = await WcBus.call('WC_ENSURE_SESSION').then((r) => r && r.sessionId);
      if (stale()) return;
      if (sessionId == null) throw new Error('could not create a session for the conversation');

      // Mic first: a refused microphone should stop us before any server work.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: Object.assign({}, MIC_AUDIO) });
      // Отменили, пока ждали микрофон (или окошко разрешения), — микрофон,
      // взятый уже после отмены, сразу отпускаем, а не оставляем гореть.
      if (stale()) { try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {} return; }
      localStream = stream;
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

      // Микрофон отобрало другое приложение — трубка сразу, человеку
      // говорится почему (ENDED_TEXT.mic_lost). Признаки, подмена дорожки при
      // смене наушников и почему не по тишине — в lex-mic-watch.js.
      micWatch = global.LexMicWatch.watch(micTrack, {
        reacquire: () => navigator.mediaDevices.getUserMedia({ audio: Object.assign({}, MIC_AUDIO) }),
        onReplaced: async (stream, track) => {
          const sender = pc && pc.getSenders().find((s) => s.track === micTrack);
          if (!sender) throw new Error('no audio sender');
          // Выключенный человеком (или «держи и говори») микрофон остаётся
          // выключенным и на новой дорожке.
          track.enabled = micTrack ? micTrack.enabled : !userMuted;
          await sender.replaceTrack(track);
          try { if (localStream) localStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
          localStream = stream;
          micTrack = track;
        },
        onLost: (kind, detail) => {
          warn('microphone lost:', kind, detail ? JSON.stringify(detail) : '');
          stop({ reason: 'mic_lost' });
        },
        log,
      });

      // NO createDataChannel — see the header. An m=application line in the
      // offer is refused by the broker.
      const offer = await pc.createOffer();
      if (stale()) return;
      await pc.setLocalDescription(offer);
      if (stale()) return;

      const promptRefs = {
        base: { scope: SCOPE, cell: 'chatPrompts', slot: await activeSlot('activeChatPromptId', 'chatB1') },
        content: { scope: SCOPE, cell: 'contentTypePrompts', slot: 'text' },
        voice: { scope: SCOPE, cell: 'voicePrompts', slot: await activeSlot('activeVoicePromptId', 'voice1') },
      };

      const apiModel = resolveVoiceApiModel(voiceModelId);
      // gpt-live: the text model that thinks for the voice and the slot of its
      // prompt — a fourth catalogue ref the server keeps out of the voice
      // instructions. Sent only for gpt-live (same rule as the server's
      // voiceTransportOf); no other voice model has either.
      const live = /^gpt-live-/.test(String(apiModel || ''));
      const thinkingMeta = live ? {
        promptThinkingScope: SCOPE,
        promptThinkingCell: 'voiceThinkingPrompts',
        promptThinkingSlot: await activeSlot('activeVoiceThinkingPromptId', 'thinking1'),
        ...(knobs.voiceThinkingModel ? { thinkingModel: knobs.voiceThinkingModel } : {}),
        ...(Number.isFinite(knobs.voiceLiveTurnGapMs) ? { liveTurnGapMs: knobs.voiceLiveTurnGapMs } : {}),
      } : {};
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
          ...thinkingMeta,
        },
      });

      // Отменили, пока читали слоты промптов, — звонок не заказываем вовсе.
      if (stale()) return;
      let r = await открыть(sessionId);

      // ⚠️ 409 БЫВАЕТ ТРЁХ ВИДОВ, и различает их `stage`.
      //
      //   · stage 'session'    — `no_session`, гонка привязки. Сервер сам
      //     называет её временной и просит повторить (gateReasonToResp в
      //     llm-proxy).
      //   · stage 'voice_retry' — прежний разговор аккаунта замолчал, но
      //     закрыть его сервер пока не смог, или замок строки перехватил
      //     другой старт. Тоже временный.
      //   · stage 'voice_busy' — у аккаунта УЖЕ ЕСТЬ живая строка
      //     `voice_sessions` со status='active', и она подаёт сигнал «я на
      //     линии».
      //
      // Третий — это то, что видел владелец. И это не «в другом окне»: окно
      // одно, а строка осталась от ЕГО ЖЕ предыдущего разговора, потому что
      // раньше мы не сообщали серверу об отбое вовсе. Сама она снималась
      // только по сроку присутствия; теперь её заменяет следующий старт, если
      // от неё больше нет сигналов (правило замены на сервере).
      //
      // Настоящее лечение — закрывать строку на отбое (см. `endCallOnServer`
      // в stop()). Повтор — для обоих временных видов 409. Последний сервер
      // решает сам: ждёт прежний разговор и заменяет его, если тот замолчал
      // (правило замены, supabase/functions/_shared/voice-replace.ts), а
      // «занято» отвечает, только когда прежний жив, — повтор лишь оттягивал бы
      // отказ.
      const ПАУЗЫ = [800, 1800];
      for (let i = 0; i < ПАУЗЫ.length && !stale() && !r.ok && r.status === 409 && !(r.json && r.json.stage === 'voice_busy'); i++) {
        log('409 ' + ((r.json && r.json.stage) || '') + ' — temporary, retrying', i + 1);
        if (hooks.onStage) hooks.onStage('connecting');
        await new Promise((res) => setTimeout(res, ПАУЗЫ[i]));
        if (stale()) return;
        let sid2 = null;
        try { sid2 = await WcBus.call('WC_ENSURE_SESSION').then((x) => x && x.sessionId); } catch (_) {}
        if (stale()) return;
        r = await открыть(sid2 == null ? sessionId : sid2);
      }

      // Человек нажал «положить трубку», пока ждал ответа сервера (и, может
      // быть, уже нажал голос снова): stop() снёс всё на странице. Сервер ответа
      // не отменяет — он мог и ждать прежний разговор аккаунта по правилу
      // замены, и поставить звонок. Звонок, который никто не ждёт, кладём сразу,
      // а не оставляем серверу искать его по сроку присутствия.
      if (stale()) {
        if (r.ok && r.json && r.json.callId) await endCallOnServer(r.json.callId, { startedAt: 0 });
        return;
      }

      if (!r.ok) {
        // `stage` travels with the status because the codes are not unique —
        // 503 is both "no listener" and "the account gate is unavailable" —
        // and the two deserve different words.
        const stage = r.json && r.json.stage;
        const gate = stage === 'no_listener' ? 'no_listener'
          : r.status === 402 ? 'balance'
          : (r.status === 429 && stage === 'inflight') ? 'busy'
          : r.status === 429 ? 'cap'
          // voice_busy — у аккаунта идёт ДРУГОЙ живой разговор: сервер ждал
          // его сигнала и дождался (правило замены). «Нажми ещё раз» здесь
          // неправда — повтор получит тот же отказ, пока тот разговор идёт.
          : (r.status === 409 && stage === 'voice_busy') ? 'elsewhere'
          : r.status === 409 ? 'race'
          : r.status === 401 ? 'login'
          : (r.status === 400 && stage === 'model') ? 'model'
          // 424 бывает двух родов, и слова у них разные: промпт по указателям
          // не нашёлся (stage 'prompt') — и у модели или её расшифровки нет
          // цены (stage 'pricing'; сюда же попадало имя режима расшифровки,
          // посланное как имя модели). Второе — про модель, не про промпт.
          : (r.status === 424 && stage === 'prompt') ? 'prompt'
          : r.status === 424 ? 'model'
          : null;
        // Сырой ответ сервера на экран не идёт — только в консоль.
        if (!gate) warn('voice did not come up:', r.status, r.json && r.json.error);
        const err = new Error(GATE_TEXT[gate] || GATE_TEXT.generic);
        err.gate = gate;
        throw err;
      }

      callId = r.json.callId;
      startedAt = Date.now();
      closed = false;
      startPresenceBeat();
      if (hooks.onStage) hooks.onStage('negotiating');
      await pc.setRemoteDescription({ type: 'answer', sdp: r.json.answerSdp });
      // Отбой во время согласования: teardown уже положил этот звонок
      // (stop видел его callId), остальное здесь уже не наше.
      if (stale()) return;

      connectServerEvents(callId);

      // The one session.update the POST body cannot carry.
      // gpt-live has no response-length field — nothing to send.
      const maxTokens = live ? null : (Number(knobs.voiceMaxResponseTokens) || null);
      if (maxTokens) {
        await sendServerCmd([{ type: 'session.update', session: { type: 'realtime', max_output_tokens: maxTokens } }]);
        if (stale()) return;
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
      // Ошибка отменённой попытки — не новость для человека и не повод сносить
      // состояние, которое уже принадлежит новой попытке.
      if (stale()) return;
      // Сервер мог уже поставить звонок (callId есть), а сломалось согласование
      // на странице: звонок кладём сразу, как при отбое, — иначе строка
      // разговора жила бы до срока присутствия, и следующее нажатие ждало бы
      // её по правилу замены.
      // Без ожидания: пока отчёт в пути, человек может нажать голос снова, и
      // отложенная ошибка закрыла бы экран уже нового разговора.
      const failedCallId = callId;
      connecting = false;
      await teardown();
      if (failedCallId) endCallOnServer(failedCallId).catch(() => {});
      throw err;
    }
  }

  // ── Голос Google на странице (2026-09-26) ────────────────────────────────
  //
  // Тот же модуль, что в расширении: voice/gemini-live.js со своими
  // спутниками (voice/call-server.js — пульс, отбой, пары реплик с повтором;
  // voice/gemini-knobs.js — пороги слуха из тех же настроек). Звук идёт от
  // страницы к Google напрямую, по ключу, который выпускает сервер (в нём
  // зашиты инструкции учителя — страница их не видит). Каждый ход — пара
  // реплик с расходом — уходит на сервер сразу (voice-cmd, тело turn); сервер
  // пишет её в беседу и списывает деньги.
  //
  // Различие с расширением одно: у страницы нет воркера. Поэтому «розетка»
  // модуля (LexVoiceHost) здесь своя: сообщения модуля превращаются в прямые
  // запросы к серверу, копию беседы ведёт wc-app.js по событиям экрана, а
  // окно, закрытое без отбоя, сервер закрывает по сроку присутствия.
  let gem = null;          // ручка модуля текущего разговора Google

  function voiceProviderOf(voiceModelId) {
    const reg = global.LexModelRegistry;
    try {
      const facts = reg && reg.resolveModelFacts ? reg.resolveModelFacts(voiceModelId) : null;
      if (facts && facts.provider) return facts.provider;
    } catch (_) { /* below */ }
    const id = String(voiceModelId || '');
    if (/^gemini-/.test(id)) return 'google';
    if (/^gpt-/.test(id)) return 'openai';
    return null;
  }

  function promptMeta(refs) {
    if (!refs || !refs.base) return {};
    return {
      promptSource: 'server',
      promptScope: refs.base.scope, promptCell: refs.base.cell, promptSlot: refs.base.slot || '',
      ...(refs.content ? { promptContentScope: refs.content.scope, promptContentCell: refs.content.cell, promptContentSlot: refs.content.slot || '' } : {}),
      ...(refs.voice ? { promptVoiceScope: refs.voice.scope, promptVoiceCell: refs.voice.cell, promptVoiceSlot: refs.voice.slot || '' } : {}),
    };
  }

  // Розетка модуля на странице: те же сообщения, что в расширении уходят
  // воркеру, здесь — прямые запросы к серверу своим пропуском. Своя на
  // каждый разговор: беседа и сеанс — ЭТОГО разговора. Общая на страницу
  // отдала бы отчёт о конце прежнего разговора с сеансом нового, если новый
  // начали, пока прежний досчитывал последний ответ.
  function makePageHost(gemSession) {
    return {
    kind: 'page',
    async send(msg) {
      try {
        if (msg.type === 'VOICE_TOKEN_GEMINI') {
          const meta0 = msg.meta || {};
          const r = await post('/functions/v1/llm-proxy/voice-token-gemini', {
            model: msg.model,
            knobs: msg.knobs || null,
            voiceName: msg.voiceName || null,
            ptt: msg.ptt === true,
            relay: msg.relay === true,
            meta: {
              sessionId: gemSession ? gemSession.sessionId : null,
              videoId: meta0.videoId || null,
              surface: meta0.surface || 'standalone',
              pageType: 'text',
              ...promptMeta(msg.promptRefs),
            },
          });
          const j = r.json || {};
          if (!r.ok) {
            const queueBusy = r.status === 429 && j.stage === 'inflight';
            return { ok: false, status: r.status, stage: j.stage || null, queueBusy, over: r.status === 429 && !queueBusy, error: j.error || null };
          }
          // route 'server' — голос через наш сервер (voice-talk): вместо ключа
          // Google — адрес сокета voice-talk и пароль разговора.
          return { ok: true, callId: j.callId, token: j.token, apiModel: j.apiModel, provider: j.provider,
            route: j.route || 'direct', relayUrl: j.relayUrl || null, secret: j.secret || null };
        }
        if (msg.type === 'VOICE_CMD') {
          const body = { callId: msg.callId };
          if (msg.ping === true) body.ping = true;
          else if (msg.end === true) { body.end = true; if (msg.reason) body.reason = msg.reason; }
          else if (msg.said) body.said = msg.said;
          else if (msg.turn) body.turn = msg.turn;
          else body.commands = msg.commands || [];
          const r = await post('/functions/v1/voice-cmd', body);
          return Object.assign({}, r.json || {}, { ok: r.ok, status: r.status });
        }
      } catch (e) {
        // Нет пропуска (вышел из аккаунта) или сеть: ответа нет — модуль
        // решит сам (пару повторит, пульс пропустит).
        if (e && e.gate === 'login') return { ok: false, __gate: 'login' };
        return null;
      }
      return null;
    },
    post(msg) {
      if (msg.type === 'VOICE_CMD') { this.send(msg); return; }
      if (msg.type === 'VOICE_SESSION_END' && msg.callId) {
        // Отчёт о конце: закрывает строку разговора, если отбой не дошёл, и
        // добирает пару, которая до сервера не дошла (итог пар — от модуля).
        const convId = gemSession ? gemSession.conversationId : null;
        post('/functions/v1/llm-proxy/voice-usage-report', {
          model: msg.model,
          durationMs: Number(msg.durationMs) || 0,
          usage: msg.usage || {},
          meta: {
            sessionId: gemSession ? gemSession.sessionId : null,
            videoId: convId, chatKey: convId, surface: 'standalone', pageType: 'text',
            callId: msg.callId,
            reportId: (global.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()),
          },
        }).then((r) => { if (!r.ok) warn('voice report not accepted:', r.status, r.json && r.json.error); })
          .catch((e) => warn('voice report not sent:', e && e.message));
      }
      // Копию беседы, журнал и учёт на странице ведёт не модуль: реплики —
      // wc-app.js по событиям экрана (тем же уидом 'voice:<…>'), деньги —
      // сервер по парам.
    },
    connect() { return null; },
    };
  }

  // Коды отказа модуля → слова для человека (те же, что у голоса OpenAI).
  const GEM_GATE = {
    __LEX_VOICE_LOGIN__: 'login',
    __LEX_VOICE_BALANCE__: 'balance',
    __LEX_VOICE_QUEUE_BUSY__: 'busy',
    __LEX_VOICE_CAP__: 'cap',
    __LEX_VOICE_BUSY__: 'elsewhere',
    __LEX_VOICE_RETRY__: 'race',
    __LEX_VOICE_PROMPT_MISSING__: 'prompt',
    __LEX_VOICE_MINT_FAILED__: 'generic',
  };

  async function startGemini(opts, voiceModelId, knobs, stale) {
    const Gemini = global.LexVoiceGeminiLive;
    if (!Gemini) { const e = new Error(GATE_TEXT.model); e.gate = 'model'; throw e; }
    const sessionId = await WcBus.call('WC_ENSURE_SESSION').then((r) => r && r.sessionId);
    if (stale()) return;
    if (sessionId == null) throw new Error('could not create a session for the conversation');
    const convId = (opts && opts.conversationId) || null;
    const host = makePageHost({ sessionId, conversationId: convId });
    // Обработчики ЭТОГО разговора: следующий start() заменит модульные hooks
    // своими, а надпись «реплика не записалась» относится к этому.
    const myHooks = hooks;
    const promptRefs = {
      base: { scope: SCOPE, cell: 'chatPrompts', slot: await activeSlot('activeChatPromptId', 'chatB1') },
      content: { scope: SCOPE, cell: 'contentTypePrompts', slot: 'text' },
      voice: { scope: SCOPE, cell: 'voicePrompts', slot: await activeSlot('activeVoicePromptId', 'voice1') },
    };
    if (stale()) return;
    // Голос у каждого поставщика свой: у Google — из той же карты голосов.
    const voiceMap = (await WcStore.one('voiceNamesByProvider_' + SCOPE, null)) || {};
    const gemKnobs = Object.assign({}, knobs, { voiceName: voiceMap.google || 'Kore' });
    let handle = null;
    const mine = () => gem === handle && handle !== null;
    // «Держи и говори» — режим «нажми и говори» модуля: слух Google выключен,
    // реплику открывает первый звук после нажатия, закрывает отпускание
    // (holdStart / holdEnd ниже). Раньше страница держала живой разговор и на
    // «отпустил» глушила микрофон, и ответ ждал паузы, которую насчитает слух
    // Google.
    const holdToTalk = !!(opts && opts.mode === 'ptt');
    handle = await Gemini.create({
      surfaceId: 'webchat',
      mode: holdToTalk ? 'ptt' : 'voice',
      // Микрофон — только пока палец на кнопке (после ответа он сам не открывается).
      holdToTalk,
      voiceModelId,
      voiceApiModel: resolveVoiceApiModel(voiceModelId),
      surface: 'standalone',
      host,
      // Учёт и журнал расширения здесь не ведутся: деньги считает сервер по
      // парам, копию беседы — wc-app.js.
      recordCall: false,
      videoIdProvider: () => convId,
      instructionRefsProvider: async () => promptRefs,
      knobsProvider: async () => gemKnobs,
      // Переписка до разговора — из памяти открытой беседы, как в расширении
      // её берут из копии беседы на устройстве.
      historyProvider: async () => {
        try {
          const r = await WcBus.call('WC_OPEN_TURNS', { conversationId: convId });
          return (r && Array.isArray(r.turns)) ? r.turns : [];
        } catch (_) { return []; }
      },
      // Тишину и предел времени у разговора Google считает устройство (линии
      // к нему у сервера нет) — те же числа, что в расширении.
      idleTimeoutMs: (Number(knobs.voiceIdleTimeoutSec) || 60) * 1000,
      maxDurationMs: 5 * 60 * 1000,
      onConnecting: () => { if (hooks.onStage) hooks.onStage('connecting'); },
      onLocalStream: (stream) => { localStream = stream; if (hooks.onLocalStream) hooks.onLocalStream(stream); },
      onConnected: () => {
        if (!mine()) return;
        connecting = false;
        closed = false;
        callId = handle.callId();
        startedAt = Date.now();
        if (hooks.onConnected) hooks.onConnected({ callId, apiModel: voiceModelId });
        if (hooks.onStage) hooks.onStage('ready');
        log('gemini connected', callId);
      },
      // ⚠️ ВСЕ СЛОВА — ТОЛЬКО ПОКА РАЗГОВОР ЭТОТ И ЖИВОЙ (mine). После отбоя
      // модуль ещё до 3,5 с досчитывает последний ответ и шлёт события, а
      // лента страницы к тому мигу уже закрыта (endVoice), и модульные hooks
      // и state могли перейти к новому разговору: поздние слова заводили бы
      // в ленте второй пузырь того же ответа и писали бы в чужую беседу. Итог
      // прозвучавшего страница берёт у модуля сама, в миг отбоя
      // (heardNow в stopGemini).
      onUserSpeechStarted: ({ itemId }) => { if (mine() && itemId && hooks.onUserStart) hooks.onUserStart(itemId); },
      onUserTranscriptDelta: ({ itemId, text }) => { if (mine() && itemId && hooks.onUserDelta) hooks.onUserDelta(itemId, appendTo(itemId, 'user', text)); },
      onUserTranscriptComplete: ({ itemId, finalText }) => {
        if (!mine() || !itemId) return;
        state.items.set(itemId, { role: 'user', text: finalText });
        if (hooks.onUserDone) hooks.onUserDone(itemId, finalText);
      },
      onAssistantTranscriptDelta: ({ itemId, text }) => { if (mine() && itemId && hooks.onAssistantDelta) hooks.onAssistantDelta(itemId, appendTo(itemId, 'assistant', text)); },
      onAssistantTranscriptComplete: ({ itemId, finalText }) => {
        if (!mine() || !itemId) return;
        state.items.set(itemId, { role: 'assistant', text: finalText });
        if (hooks.onAssistantDone) hooks.onAssistantDone(itemId, finalText);
      },
      onAssistantTranscriptDropped: ({ itemId }) => {
        if (!mine() || !itemId) return;
        state.items.delete(itemId);
        if (hooks.onAssistantDrop) hooks.onAssistantDrop(itemId);
      },
      onAssistantTurnComplete: () => { if (!mine()) return; state.turns++; if (hooks.onTurnDone) hooks.onTurnDone(); },
      onTeacherSpeaking: (on) => { if (mine() && hooks.onTeacherSpeaking) hooks.onTeacherSpeaking(on); },
      onTurnNotSaved: () => { if (myHooks.onNotice) myHooks.onNotice(TURN_NOT_SAVED); },
      onError: (err) => { if (mine() && hooks.onError) hooks.onError(String((err && err.message) || err)); },
      // Конец, который модуль заметил сам (сервер закрыл разговор, сокет
      // оборвался, тишина, предел): страница сносит своё тем же путём, что и
      // по кнопке. Конец по кнопке сюда не доходит — ручка к тому мигу уже
      // снята (stopGemini).
      onDisconnected: ({ reason }) => { if (mine() && !/^gate-/.test(String(reason || ''))) stopGemini({ reason }, true); },
    });
    if (stale()) return;
    gem = handle;
    activeVoiceModelId = voiceModelId;
    try {
      await handle.start();
    } catch (err) {
      const code = String((err && err.message) || '');
      // Состояние модуля страницы сносит start() (его catch → teardown);
      // здесь только ручка — её больше нет.
      if (gem === handle) gem = null;
      if (Object.prototype.hasOwnProperty.call(GEM_GATE, code)) {
        const e = new Error(GATE_TEXT[GEM_GATE[code]]);
        e.gate = GEM_GATE[code];
        throw e;
      }
      warn('gemini voice did not come up:', code);
      throw new Error(GATE_TEXT.generic);
    }
    return { callId };
  }

  // Отбой разговора Google. fromModule — модуль уже снёс себя сам (сервер
  // закрыл разговор, сокет оборвался): ручку не трогаем, только своё.
  async function stopGemini(opts, fromModule) {
    const h = gem;
    if (!h) return;
    gem = null;
    const reason = (opts && opts.reason) || 'manual';
    const endingHooks = hooks;
    let endingTurns = state.turns;
    const endingCallId = callId || (h.callId && h.callId());
    if (!fromModule) { try { await h.stop({ reason }); } catch (_) {} }
    // Ответ, который учитель договаривал, — в том виде, в каком он ляжет в
    // беседу (только прозвучавшее), ДО закрытия ленты: поздних событий
    // модуля страница уже не слушает (mine() выше).
    const heard = h.heardNow ? h.heardNow() : null;
    if (heard && heard.itemId) {
      if (heard.text) {
        endingTurns++;   // ход досчитан здесь, а не событием модуля
        state.items.set(heard.itemId, { role: 'assistant', text: heard.text });
        if (endingHooks.onAssistantDone) endingHooks.onAssistantDone(heard.itemId, heard.text);
      } else {
        state.items.delete(heard.itemId);
        if (endingHooks.onAssistantDrop) endingHooks.onAssistantDrop(heard.itemId);
      }
    }
    closed = true;
    connecting = false;
    callId = null;
    localStream = null;
    attempt++;
    const myEnd = attempt;
    // AWAITED, как у голоса OpenAI: «stop() вернулся» значит «строка разговора
    // закрыта», и следующее нажатие не упирается в собственный разговор. Кроме
    // конца «сервер перестал подтверждать»: его ответа не ждём (см. stop), а
    // отбой с причиной модуль уже отправил сам.
    if (endingCallId && !SERVER_GONE.has(reason)) {
      await makePageHost(null).send(Object.assign({ type: 'VOICE_CMD', callId: endingCallId, end: true },
        (reason === 'silence' || reason === 'time_cap') ? { reason } : {}));
    }
    if (endingHooks.onDisconnected) await endingHooks.onDisconnected({ reason, turns: endingTurns, superseded: attempt !== myEnd });
    log('gemini stopped', reason, 'turns', endingTurns);
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
  // opts.startedAt — начало ИМЕННО этого звонка; звонок отменённой попытки
  // (он не начинался) — 0, а не время прошлого разговора из startedAt.
  async function endCallOnServer(id, opts) {
    if (!id) return;
    const from = (opts && 'startedAt' in opts) ? opts.startedAt : startedAt;
    const durationMs = from ? Math.max(0, Date.now() - from) : 0;
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
    if (gem) return stopGemini(opts);
    if (closed && !connecting) return;
    const reason = (opts && opts.reason) || 'manual';
    // Снимаем id ДО сноса: teardown обнуляет его, а отчёт без id бесполезен.
    const endingCallId = callId;
    // И обработчики с числом ходов — тоже до сноса: пока ниже идёт отчёт об
    // отбое, человек может нажать голос снова, и start() заменит модульные
    // hooks и state.turns на свои. Старый stop() зовёт обработчик СВОЕГО
    // разговора, а не нового.
    const endingHooks = hooks;
    const endingTurns = state.turns;
    await teardown();
    const myEnd = attempt;
    if (SERVER_GONE.has(reason)) {
      // Разговор кончился, потому что сервер перестал его подтверждать. Ждать
      // его ответа на отбой нельзя: запрос к повисшему серверу не отвечает
      // вовсе, и надпись «сервер перестал подтверждать» человек увидел бы
      // только когда запрос сам истечёт. Отбой (с причиной) и отчёт уходят
      // вдогонку — дойдут, если сервер в этот миг отвечает. Отчёт — после
      // отбоя, а не рядом с ним: строку закрывает первый дошедший, и отчёт,
      // обогнав отбой, записал бы конец как «человек».
      const named = endingCallId
        ? makePageHost(null).send({ type: 'VOICE_CMD', callId: endingCallId, end: true, reason })
        : Promise.resolve(null);
      named.catch(() => null).then(() => endCallOnServer(endingCallId)).catch(() => {});
    } else {
      // AWAITED: «stop() вернулся» обязано значить «шлюз свободен». Иначе
      // человек, нажавший микрофон сразу после отбоя, упирается в собственную
      // же незакрытую сессию.
      await endCallOnServer(endingCallId);
    }
    // AWAITED, not fired and forgotten: the handler is where the last exchange
    // gets written to the account, and "stop() resolved" has to mean "nothing
    // is still in flight". Without the await a caller that checks the
    // conversation right after hanging up reads it before the write lands.
    //
    // superseded — за время отчёта уже начат новый разговор (attempt ушёл
    // дальше того, что оставил teardown): экран и кнопки теперь его, и
    // обработчик их не трогает, только дописывает своё.
    if (endingHooks.onDisconnected) await endingHooks.onDisconnected({ reason, turns: endingTurns, superseded: attempt !== myEnd });
    log('stopped', reason, 'turns', endingTurns);
  }

  async function teardown() {
    closed = true;
    stopPresenceBeat();
    // Слежку — до того, как дорожки гасятся здесь же: свой stop() события
    // 'ended' не даёт, но и ловить после сноса нечего.
    if (micWatch) { micWatch.stop(); micWatch = null; }
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
    attempt++;
  }

  const WcVoice = {
    // The capability answer for THIS surface. Deliberately not the flag in
    // web/lex-platform-web.js: that one gates the older web build's buttons,
    // and flipping it would light up controls there that have no handlers
    // behind them. See the journal, decision 0.4.
    available: true,

    // The line the reader sees when a conversation ended without them ending
    // it (server hung up, link failed) — see ENDED_TEXT. The reason itself is
    // a machine word and never goes on screen.
    endedText(reason) { return endedText(reason, 'en'); },

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
      if (gem) { gem.mute(userMuted); return; }
      if (micTrack && !firstTurn.armed) micTrack.enabled = !userMuted;
    },
    // «Держи и говори»: палец на кнопке и палец снят. У голоса Google это
    // начало и конец реплики (модуль сам обрывает ответ, если учитель ещё
    // говорит, и закрывает реплику — ответ идёт сразу). У голоса OpenAI — как
    // было: та же живая сессия, микрофон открыт и закрыт.
    holdStart() {
      userMuted = false;
      if (gem && gem.talkPress) { gem.talkPress(); return; }
      WcVoice.mute(false);
    },
    holdEnd() {
      userMuted = true;
      if (gem && gem.talkRelease) { gem.talkRelease(); return; }
      WcVoice.mute(true);
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
    // У разговора Google отменить ответ командой нельзя — учитель замолкает,
    // когда человек заговорит.
    cancel() { if (gem) return Promise.resolve(null); return sendServerCmd([{ type: 'response.cancel' }]); },

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
