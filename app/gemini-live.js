// voice/gemini-live.js — LexVoice Gemini Live client.
//
// С сервером (2026-09-25) — так же, как голос OpenAI, через общий
// voice/call-server.js:
//   - разговор начинает сервер (llm-proxy voice-token-gemini): проверяет
//     деньги и занятость линии, удерживает запас, заводит строку разговора и
//     выпускает одноразовый ключ Google С ЗАШИТОЙ настройкой — инструкции
//     учителя и модель ставит сервер, свой кадр настройки устройство шлёт, но
//     Google его игнорирует. Текста промпта устройство не видит;
//   - звук идёт к Google напрямую, как и шёл: линии к звонку у сервера нет;
//   - каждый законченный ход — пара реплик с расходом, который прислал
//     Google, — сразу уходит на сервер (voice-cmd turn): сервер пишет её в
//     беседу и списывает деньги; под теми же уидами пара ложится в копию
//     беседы на устройстве;
//   - пульс, связь окна с воркером и отбой — те же, что у OpenAI.
//
// Founded on the old direct shared.js openTutorGeminiLiveSession (removed
// 2026-09-29 with the other direct-to-Google paths). Extended with:
//
//   - knobs: the raw values go to the server, which turns them into the
//     setup (_shared/gemini-live-setup.ts geminiClientSetupFromKnobs — one
//     rule for every surface, the iPhone included)
//   - history injection via voice/history-injector.js (clientContent after
//     setupComplete; the historyConfig flag is set by the server)
//   - sessionResumption handle kept in memory only (nothing resumes a closed session)
//   - idle / max-duration timers
//   - mic + playback RMS analyser → onMicLevel / onPlaybackLevel
//   - normalised surface callbacks (matching openai-realtime.js shape)
//   - thread-writer + telemetry gated by noPersistentThread / recordCall
//
// Module-level state forbidden — each handle has its own closure. Doesn't
// touch shared.js's geminiVoice* singletons.

(function (global) {
  'use strict';

  const DEFAULT_API_MODEL = 'gemini-3.1-flash-live-preview';
  const DEFAULT_VOICE = 'Kore';

  // Minimal voice-name validation — kept in sync with shared.js
  // GEMINI_LIVE_VOICES (29 prebuilt voices on 2026-05-26). Module-local
  // copy so voice/ doesn't depend on shared.js export.
  const GEMINI_LIVE_VOICES = new Set([
    'Achernar', 'Achird', 'Algenib', 'Algieba', 'Alnilam', 'Aoede',
    'Autonoe', 'Callirrhoe', 'Charon', 'Despina', 'Enceladus', 'Erinome',
    'Fenrir', 'Gacrux', 'Iapetus', 'Kore', 'Laomedeia', 'Leda',
    'Orus', 'Puck', 'Pulcherrima', 'Rasalgethi', 'Sadachbia', 'Sadaltager',
    'Schedar', 'Sulafat', 'Umbriel', 'Vindemiatrix', 'Zephyr', 'Zubenelgenubi',
  ]);

  async function create(config) {
    const cfg = config || {};
    const cb = makeCallbacks(cfg);
    // «Розетка»: всё, что уходит наружу (сервер, копия беседы, учёт), — через
    // неё. В расширении — воркер (voice/host-chrome.js), на странице —
    // прямые запросы к серверу (pageHost в webchat/wc-voice.js).
    const host = cfg.host || global.LexVoiceHost;
    const log = (msg, ...rest) => lexLog(`[lex-voice-gemini-live][${cfg.surfaceId || '?'}]`, msg, ...rest);
    const warn = (msg, ...rest) => console.warn(`[lex-voice-gemini-live][${cfg.surfaceId || '?'}]`, msg, ...rest);

    // ── State (closure-private) ───────────────────────────────────────
    let ws = null;
    let localStream = null, micTrack = null;
    let micCtx = null, micSource = null, micProc = null, micSink = null;
    // v1.14.x звук: сегментный рекордер реплики пользователя (calls.audio_url).
    let segmentRecorder = null, lastUserSegmentWav = null, segStartTs = 0, modelSpokeThisTurn = false;
    let sessionRecorder = null; // v1.14.x: whole-session continuous WAV (voice_session row)
    const MAX_SEGMENT_MS = 90000; // предохранитель: потолок длины одного сегмента
    let playbackCtx = null, nextStartTime = 0;
    let micAnalyser = null, playbackAnalyser = null, analyserCtx = null;
    let rafId = null;
    let setupComplete = false, closed = false, connecting = false, opened = false;
    let pendingSends = [];
    let idleTimer = null, maxDurationTimer = null;
    // Имя модели у поставщика — сервер называет его в ответе на старт.
    let voiceApiModel = cfg.voiceApiModel || DEFAULT_API_MODEL;
    // v1.11.0 БАГ 1: voiceName resolve переехало из const init в start() —
    // нужно подхватывать актуальное значение из knobs.voiceName (живёт в
    // voiceNamesByProvider['google']) на каждый start, не один раз при
    // create(). Стартовый default — DEFAULT_VOICE; перезапишется ниже в
    // start() после resolveKnobs.
    let voiceName = GEMINI_LIVE_VOICES.has(cfg.voiceName) ? cfg.voiceName : DEFAULT_VOICE;
    let lastInstructions = '';
    // Указатели серверного промпта этой сессии (scope/cell/slot). Живут ради
    // журнала: в text_call_io пишется МЕТКА указателей, а не сам текст, —
    // так же, как на пути OpenAI. Текст промпта секретный, а журнал читает
    // не только его хозяин.
    let lastPromptRefs = null;
    let lastKnobs = null;
    let turnIndex = 0;
    let turnStartedAt = null;
    let turnFirstAudioAt = null;
    let turnUserText = '';
    let turnAssistantText = '';
    // v1.13.0: once-per-turn flag для синтетического speech_started
    // emit. Gemini Live не имеет server-side `speech_started` events
    // как OpenAI Realtime. Surface через onUserSpeechStarted pre-create
    // user bubble — гарантирует порядок user → assistant даже если
    // server packs outputTranscription/modelTurn в первом chunk без
    // inputTranscription. Сбрасывается в finalizeTurn для следующего
    // turn'а.
    let speechStartedEmittedThisTurn = false;
    let turnUsage = null;   // v1.11.0 БАГ 5: usageMetadata accumulator
    let sessionResumptionHandle = null;

    // ── Разговор на сервере ──────────────────────────────────────────────
    // callId — номер разговора, который назначил сервер (voice_sessions);
    // pairSeq — номер хода в этом разговоре. Номер пары реплик —
    // «<callId>-<pairSeq>»: из него и сервер, и эта копия беседы чеканят уиды
    // 'voice:<пара>-u' и 'voice:<пара>-a' — поэтому запись сервера и запись
    // устройства одна строка, и цена хода встаёт под ответом.
    let callId = null;
    let pairSeq = 0;
    const pairId = () => `${callId || 'gm'}-${pairSeq}`;
    // Миг (performance.now), когда человек договорил реплику этого хода: из
    // него сервер считает время реплики («сколько назад»).
    let turnUserEndedAt = null;
    // Учителя перебили: Google присылает «перебит», а следом отдельным кадром
    // «ход закончен» с расходом (замерено 2026-09-25, ~50 мс). Ход закрывается
    // по второму — иначе его расход достался бы пустому следующему ходу.
    // Запасной таймер — если второй кадр так и не пришёл.
    let turnInterrupted = false;
    // Звук учителя в этом ходе уже шёл. Отдельно от modelSpokeThisTurn: тот
    // принадлежит записи реплики человека и в «нажми и говори» не
    // сбрасывается вовсе.
    let teacherSpokeThisTurn = false;
    let interruptTimer = null;
    // Сколько звука ответа этого хода пришло и сколько из него прозвучало до
    // обрыва. Google шлёт текст ответа быстрее, чем звук успевает проиграться:
    // замер 2026-09-26 — перебили на 5,5 с из 16,9 с пришедшего звука, а
    // текст пришёл весь. В беседу идёт только прозвучавшая доля текста
    // (heardText), иначе учитель в тексте «помнит» то, чего человек не слышал.
    let turnAudioSec = 0;
    let turnHeardSec = null;
    const INTERRUPT_CLOSE_MS = 2500;
    // Человек заговорил, пока учитель ещё говорил (перебил): пузырь следующей
    // реплики человека ставится сразу, как закроется перебитый ход.
    let pendingSpeechStart = false;
    // Набранный во время разговора текст — реплика человека ближайшего хода.
    let pendingTyped = '';
    // Отбой посреди хода (2026-09-29). Звук и микрофон отпускаются сразу —
    // учитель замолкает в миг нажатия, — а связь с Google ещё держится: ответ
    // обрывается у Google командой, и Google присылает «ход закончен» с
    // расходом (замер: через 0,15–0,25 с после обрыва). Тогда ход пишется и
    // оплачивается, и только потом связь закрывается. Без обрыва Google
    // присылает расход, лишь «доиграв» ответ у себя, — у длинного ответа это
    // десятки секунд, и ход уходил бесплатным.
    //   • Ответ уже звучит — обрыв сразу, ждём не дольше CUT_WAIT_MS.
    //   • Человек договорил, а ответа ещё нет — ждём первого кадра ответа не
    //     дольше SETTLE_MS и обрываем на нём. Раньше обрывать нельзя: в
    //     живом режиме команда обрыва закончила бы реплику человека, и Google
    //     ответил бы целиком (замерено).
    // Команда обрыва: в «нажми и говори» — activityStart (так же отменяется
    // ответ по кнопке); в живом режиме — пустой clientContent с turnComplete
    // (activityStart при слухе сервера Google не слушает). В живом режиме
    // Google сразу начинает ответ заново — поэтому связь закрывается на
    // первом же «ход закончен» после обрыва, без пауз.
    const SETTLE_MS = 3500;
    const CUT_WAIT_MS = 1500;
    let settleResolve = null;
    let settleTimer = null;
    let cutPending = false;
    let cutSent = false;
    // Итог расхода и длительности всех ходов разговора — для отчёта о конце
    // (VOICE_SESSION_END). Считается здесь, а не только в воркере: у страницы
    // воркера нет.
    const sessionUsage = { textInput: 0, audioInput: 0, textCachedInput: 0, audioCachedInput: 0, textOutput: 0, audioOutput: 0, thoughtsOutput: 0 };
    let sessionMs = 0;

    const server = global.LexVoiceCallServer.create({
      log, warn, host,
      isClosed: () => closed,
      // 404 на пульс (сервер закрыл разговор: деньги, предел времени, пропажа
      // пульса) или «клади трубку» в ответе на пару — причина от сервера.
      onServerEnded: (reason) => { stop({ reason, source: 'server' }); },
      // Сервер перестал подтверждать разговор (пульс не отвечает, пара не
      // принята): разговор кончается на устройстве, с надписью по причине. Не
      // работает сервер — не работает разговор (правило Геннадия): ходы и
      // деньги этого разговора сервер знает только от устройства.
      onServerFailure: (info) => { stop({ reason: (info && info.reason) || 'server_silent', source: 'device' }); },
      onTurnNotSaved: (info) => { try { cb.onTurnNotSaved && cb.onTurnNotSaved(info); } catch (_) {} },
    });

    // ── PTT state (v1.11.0 / legacy shared.js v1.5.252) ───────────────
    // mode='ptt' disables server-side AAD and switches to manual
    // activityStart/activityEnd around each user turn. Voice mode keeps
    // AAD on with knob tuning. See docs/LESSONS.md PTT entry + Live API
    // RealtimeInputConfig.automaticActivityDetection.disabled.
    const mode = cfg.mode === 'ptt' ? 'ptt' : 'voice';
    const isPtt = mode === 'ptt';
    // «Нажми и держи» (страница): микрофон открыт ТОЛЬКО пока палец на кнопке
    // (talkPress / talkRelease). В «нажми и говори» расширения микрофон после
    // ответа учителя открывается сам — следующая реплика идёт без нажатия; здесь
    // так нельзя: он слал бы Google звук комнаты, пока никто не держит кнопку.
    const holdToTalk = isPtt && cfg.holdToTalk === true;
    // Сколько кусков звука ушло с последнего activityStart: «отпустил, не
    // сказав ничего» не закрывает реплику (голого activityEnd Google не ждёт).
    let pttChunksSinceStart = 0;
    let pttState = 'ready';        // 'ready' | 'speaking'
    let pttActivityOpen = false;   // true between activityStart and activityEnd
    // v1.5.255 legacy: server takes ~100–300 ms to actually stop after
    // activityStart-on-cancel; chunks already in flight would refill the
    // playback queue and the user perceives a tail burst. Drop incoming
    // PCM chunks until interrupted/turnComplete confirms the cut, OR
    // until the user starts a new turn (handleGeminiPttButtonClick →
    // ready branch flips it false).
    let playbackSuppressed = false;
    // v1.5.254 legacy: track every BufferSourceNode so we can stop them
    // all on barge-in (PTT cancel). Web Audio scheduler drains queued
    // sources after the server stops generating — user perceives "model
    // still talking". .stop() on each cuts playback instantly.
    const activeSources = [];

    function clearTimers() {
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      if (maxDurationTimer) { clearTimeout(maxDurationTimer); maxDurationTimer = null; }
    }
    function bumpIdle() {
      if (!cfg.idleTimeoutMs) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        log('idle auto-close after', cfg.idleTimeoutMs, 'ms');
        // Тишину у этого разговора считает устройство (линии у сервера нет):
        // причина та же, что у сервера OpenAI, и надпись та же.
        stop({ reason: 'silence' });
      }, cfg.idleTimeoutMs);
    }
    function armHardLimit() {
      if (!cfg.maxDurationMs) return;
      maxDurationTimer = setTimeout(() => {
        log('max-duration auto-close after', cfg.maxDurationMs, 'ms');
        stop({ reason: 'time_cap' });
      }, cfg.maxDurationMs);
    }
    function ensureAnalyserCtx() {
      if (analyserCtx) return analyserCtx;
      analyserCtx = new AudioContext();
      if (analyserCtx.state === 'suspended') analyserCtx.resume().catch(() => {});
      return analyserCtx;
    }
    function startRmsLoop() {
      if (rafId !== null) return;
      const tick = () => {
        if (closed) return;
        if (cb.onMicLevel && micAnalyser) {
          try { cb.onMicLevel(micAnalyser.sample()); } catch (_) {}
        }
        if (cb.onPlaybackLevel && playbackAnalyser) {
          try { cb.onPlaybackLevel(playbackAnalyser.sample()); } catch (_) {}
        }
        rafId = requestAnimationFrame(tick);
      };
      rafId = requestAnimationFrame(tick);
    }
    function stopRmsLoop() {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    }

    // ── PCM playback (24kHz, sequenced) ───────────────────────────────
    function playPcmChunk(b64) {
      if (closed || !playbackCtx) return;
      // v1.5.255 legacy: drop in-flight chunks after a PTT barge-in
      // until server confirms the cut via interrupted/turnComplete.
      if (playbackSuppressed) return;
      try {
        const buf = global.LexVoiceMicrophone.base64ToArrayBuffer(b64);
        const int16 = new Int16Array(buf);
        const float = global.LexVoiceMicrophone.int16ToFloat32(int16);
        const audioBuf = playbackCtx.createBuffer(1, float.length, 24000);
        audioBuf.copyToChannel(float, 0);
        const src = playbackCtx.createBufferSource();
        src.buffer = audioBuf;
        src.connect(playbackCtx.destination);
        const now = playbackCtx.currentTime;
        const startAt = Math.max(now, nextStartTime);
        src.start(startAt);
        nextStartTime = startAt + audioBuf.duration;
        turnAudioSec += audioBuf.duration;
        noteTeacherSpeaking(nextStartTime - now);
        // v1.5.254 legacy: track for barge-in cut.
        activeSources.push(src);
        src.onended = () => {
          const idx = activeSources.indexOf(src);
          if (idx >= 0) activeSources.splice(idx, 1);
        };
        if (turnFirstAudioAt === null && turnStartedAt !== null) {
          turnFirstAudioAt = performance.now();
        }
      } catch (err) {
        warn('playPcmChunk failed:', err);
      }
    }

    // v1.5.254 legacy: stop every queued BufferSourceNode immediately so
    // barge-in (PTT cancel) feels instant. Also resets nextStartTime so
    // the next turn's audio plays without a stale schedule gap.
    // «Учитель говорит» — пока в очереди есть звук ответа. Поверхности, которой
    // это нужно (страница рисует им состояние кнопки), — событие на смену.
    let teacherSpeaking = false;
    let speakingTimer = null;
    function setTeacherSpeaking(on) {
      if (teacherSpeaking === on) return;
      teacherSpeaking = on;
      try { cb.onTeacherSpeaking && cb.onTeacherSpeaking(on); } catch (_) {}
    }
    function noteTeacherSpeaking(leftSec) {
      setTeacherSpeaking(true);
      if (speakingTimer) clearTimeout(speakingTimer);
      speakingTimer = setTimeout(() => { speakingTimer = null; setTeacherSpeaking(false); }, Math.max(0, leftSec) * 1000 + 150);
    }

    function stopPlaybackImmediately() {
      // Первый обрыв хода: то, что стояло в очереди, человек не услышит.
      // Звука этого хода ещё не было — не прозвучало ничего (0), и ответ,
      // который придёт следом, в беседу не ляжет.
      if (turnHeardSec === null && playbackCtx) {
        const queued = Math.max(0, nextStartTime - playbackCtx.currentTime);
        turnHeardSec = Math.max(0, turnAudioSec - queued);
      }
      if (speakingTimer) { clearTimeout(speakingTimer); speakingTimer = null; }
      setTeacherSpeaking(false);
      for (const src of activeSources.splice(0)) {
        try { src.onended = null; } catch (_) {}
        try { src.stop(); } catch (_) {}
        try { src.disconnect(); } catch (_) {}
      }
      if (playbackCtx) nextStartTime = playbackCtx.currentTime;
    }

    // ── Start ─────────────────────────────────────────────────────────
    // Разговор, упавший на полпути (микрофон не дали, сервер отказал, сокет
    // не встал), — мёртвый: поверхность бросает его ручку. Здесь он сносит
    // себя сам: связь с воркером, взятый микрофон и разговор на сервере, если
    // сервер его уже завёл.
    async function start() {
      try { return await startCall(); }
      catch (err) {
        if (!closed) {
          if (callId) {
            try { teardown(); } catch (_) {}
          } else {
            closed = true;
            server.closeLink(false);
            releaseMedia();
          }
          connecting = false;
        }
        throw err;
      }
    }

    async function startCall() {
      if (opened || connecting || closed) return;
      connecting = true;
      // Связь с воркером — с первого мига подключения (как у OpenAI): стоп
      // посреди подготовки рвёт её без done, и разговор, который сервер всё же
      // заведёт, воркер закроет сам, как только узнает его номер.
      server.openLink();
      try { cb.onConnecting && cb.onConnecting(); } catch (_) {}

      // Указатели на промпт в серверном каталоге. Есть они — инструкцию
      // собирает сервер и зашивает в ключ; нет (окно произношения со своей
      // инструкцией) — текст окна едет серверу вместе с просьбой о ключе, как
      // у OpenAI без указателей.
      lastPromptRefs = null;
      if (typeof cfg.instructionRefsProvider === 'function') {
        try { lastPromptRefs = await cfg.instructionRefsProvider(); } catch (_) { lastPromptRefs = null; }
        if (lastPromptRefs && !lastPromptRefs.base) lastPromptRefs = null;
      }
      lastInstructions = lastPromptRefs ? '' : String((await resolveInstructions(cfg)) || '');
      lastKnobs = await resolveKnobs(cfg);
      // v1.11.0 БАГ 1: подхватить voiceName из knobs (voiceNamesByProvider
      // ['google']) на каждый start.
      if (lastKnobs && typeof lastKnobs.voiceName === 'string' && GEMINI_LIVE_VOICES.has(lastKnobs.voiceName)) {
        voiceName = lastKnobs.voiceName;
      }

      // Pre-fetch history BEFORE socket open so seedAfterSetupComplete
      // has it ready.
      let priorTurns = null;
      if (typeof cfg.historyProvider === 'function') {
        try { priorTurns = await cfg.historyProvider(); } catch (_) { priorTurns = null; }
      }

      // Mic capture chain (16 kHz) — до просьбы о ключе: окно разрешения
      // микрофона может висеть сколько угодно, а ключ живёт 60 с до начала.
      const mic = await global.LexVoiceMicrophone.captureForGeminiLive();
      localStream = mic.stream;
      micTrack = mic.track;
      micCtx = mic.micCtx;
      micSource = mic.micSource;
      micProc = mic.micProc;
      micSink = mic.micSink;
      // v1.14.x звук: Gemini в живом режиме НЕ шлёт начало речи пользователя —
      // первую реплику пишем от старта сессии (mic уже открыт).
      segmentRecorder = mic.segmentRecorder || null;
      sessionRecorder = mic.sessionRecorder || null; // v1.14.x: whole-session capture
      lastUserSegmentWav = null; modelSpokeThisTurn = false;
      // v1.15.x A: voice_session только живой — в PTT гасим session-рекордер.
      if (mode === 'ptt' && sessionRecorder) { sessionRecorder.dispose(); sessionRecorder = null; }
      if (closed) { releaseMedia(); return; }
      // Поток микрофона — поверхности, которой он нужен для полоски уровня
      // или для «нажми и держи» (страница глушит дорожку).
      try { cb.onLocalStream && cb.onLocalStream(localStream); } catch (_) {}

      // Пожелания устройства — значения ручек, голос и «нажми и говори». В
      // настройку разговора их переводит сервер — одно правило на все
      // поверхности, включая айфон (_shared/gemini-live-setup.ts), — и
      // зашивает её в ключ вместе со своими инструкциями и моделью.
      const resp = await requestGoogleCall(cfg, lastPromptRefs, {
        linkId: server.linkId, knobs: geminiKnobsOf(lastKnobs), voiceName, ptt: isPtt,
      }, host);
      // Остановили, пока сервер заводил разговор: окно уже снесло себя, а
      // разговор, если сервер его завёл, закроет воркер — разрыв связи без done.
      // Ответ сервера (в том числе отказ «окна нет» от воркера) здесь уже ничего
      // не значит и надписи не даёт.
      if (closed) {
        releaseMedia();
        // Сервер разговор всё-таки завёл — закрыть его строку сразу. В
        // расширении это сделает и воркер (разрыв связи без done); у страницы
        // воркера нет, и строка висела бы до замены или уборщика.
        if (resp && resp.ok && resp.callId) {
          try { host.post({ type: 'VOICE_CMD', callId: resp.callId, end: true }); } catch (_) {}
        }
        return;
      }
      const auth = googleCallOf(resp, cb);
      callId = auth.callId;
      if (auth.apiModel) voiceApiModel = auth.apiModel;
      // Первый кадр сокета обязан быть настройкой, но всё, кроме модели, Google
      // берёт из ключа, а присланное здесь игнорирует (проверено 2026-09-25).
      const clientSetup = { model: `models/${voiceApiModel}` };
      // Номер разговора — в связь с воркером и в пульс (он заводится сразу).
      server.setCallId(callId);

      // v1.15.x B: первый сегмент открываем сразу ТОЛЬКО в живом режиме.
      if (!isPtt && segmentRecorder) { segmentRecorder.beginSegment(); segStartTs = Date.now(); }

      // Playback (24 kHz).
      playbackCtx = global.LexVoiceMicrophone.createPlaybackContext24k();
      nextStartTime = 0;

      // RMS analysers.
      try {
        const ctx = ensureAnalyserCtx();
        micAnalyser = global.LexVoiceMicrophone.createAnalyserFromStream(ctx, localStream);
        startRmsLoop();
      } catch (err) { warn('mic analyser failed:', err && err.message); }
      playbackAnalyser = null;

      // WS handshake: the v1alpha *Constrained* method with ?access_token=
      // (NOT plain BidiGenerateContent + ?key= — that 404s the token). The
      // token carries the whole setup; the frame below is ignored by Google
      // (verified live 2026-09-25) and is sent only because the protocol
      // requires a first setup message.
      const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=${encodeURIComponent(auth.token)}`;
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        try {
          ws.send(JSON.stringify({ setup: clientSetup }));
          log('setup sent, model =', voiceApiModel, ', voice =', voiceName, ', call =', callId);
        } catch (err) { warn('setup send failed:', err); }
      };

      ws.onmessage = async (event) => {
        let raw = event.data;
        if (raw instanceof Blob) {
          try { raw = await raw.text(); }
          catch (err) { warn('blob.text failed:', err); return; }
        }
        let data;
        try { data = JSON.parse(raw); } catch (err) { warn('JSON parse failed:', err); return; }
        if (!data) return;
        handleServerMessage(data, priorTurns);
      };

      ws.onerror = (err) => {
        warn('ws error:', err);
        if (closed) return;
        try { cb.onError && cb.onError(new Error('Gemini Live WS error')); } catch (_) {}
      };

      ws.onclose = (event) => {
        log('ws closed, code =', event.code, ', reason =', event.reason);
        if (settleResolve) endSettle();
        if (!closed) {
          // A close before setupComplete means the server never accepted our
          // setup message (rejected config) — surface that as an error, not
          // a benign disconnect. Same for a close mid-session with a non-
          // normal code (1000 = normal closure, 1001 = going away are the
          // only "expected" codes).
          const wasHealthy = setupComplete;
          const abnormalCode = event.code !== 1000 && event.code !== 1001;
          teardown();
          if (!wasHealthy || abnormalCode) {
            const detail = `code ${event.code}${event.reason ? ': ' + event.reason : ''}`;
            try {
              cb.onError && cb.onError(new Error(
                (wasHealthy ? 'Gemini Live closed unexpectedly (' : 'Gemini Live closed before setup completed (') + detail + ')'
              ));
            } catch (_) {}
          }
          try { cb.onDisconnected && cb.onDisconnected({ reason: 'ws-closed', code: event.code }); } catch (_) {}
        }
      };

      // Mic loop.
      micProc.onaudioprocess = (e) => {
        if (closed || !setupComplete) return;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        // Заглушённый микрофон в живом режиме шлёт ТИШИНУ, а не ничего: слух
        // Google закрывает реплику только по тишине после речи. Кадров нет —
        // реплика человека не кончается, и учитель не отвечает, пока звук не
        // пойдёт снова (страница: «нажми и держи» отпускает кнопку глушением).
        // В «нажми и говори» слух выключен, реплику закрывает activityEnd, и
        // тишина там открыла бы новую реплику, — там по-прежнему ничего.
        if (!micTrack.enabled && isPtt) return;
        // v1.5.252 legacy: PTT — skip audio while the model is responding.
        if (isPtt && pttState === 'speaking') return;
        // v1.5.252 legacy: PTT — lazy-open the user activity before the very
        // first chunk of a new turn (AAD is disabled).
        if (isPtt && !pttActivityOpen) {
          try {
            ws.send(JSON.stringify({ realtimeInput: { activityStart: {} } }));
            pttActivityOpen = true;
            pttChunksSinceStart = 0;
            if (segmentRecorder) { lastUserSegmentWav = null; segmentRecorder.beginSegment(); segStartTs = Date.now(); }
          } catch (err) {
            warn('ws.send (activityStart) failed:', err);
          }
        }
        const raw = e.inputBuffer.getChannelData(0);
        const float = micTrack.enabled ? raw : new Float32Array(raw.length);
        // v1.14.x звук: копим те же кадры в сегмент реплики.
        if (segmentRecorder && segmentRecorder.isRecording()) {
          segmentRecorder.feed(float);
          if (segStartTs && (Date.now() - segStartTs) > MAX_SEGMENT_MS) {
            try { lastUserSegmentWav = segmentRecorder.endSegment(); } catch (_) {}
            segStartTs = 0;
          }
        }
        const int16 = global.LexVoiceMicrophone.floatToInt16(float);
        const b64 = global.LexVoiceMicrophone.arrayBufferToBase64(int16.buffer);
        try {
          ws.send(JSON.stringify({
            realtimeInput: {
              audio: { data: b64, mimeType: 'audio/pcm;rate=16000' },
            },
          }));
          if (isPtt) pttChunksSinceStart++;
        } catch (err) {
          warn('ws.send (audio) failed:', err);
        }
      };
    }

    function handleServerMessage(data, priorTurns) {
      // Кадр закрытого разговора, который уже досчитал свой последний ход (или
      // не ждал его): ничего не читаем — ни звука, ни расхода. Иначе расход
      // хода, который Google начал после обрыва, лёг бы на место уже
      // оплаченного.
      if (closed && !settleResolve) return;
      // Расход хода Google кладёт В ТОТ ЖЕ кадр, что и «ход закончен»
      // (замерено 2026-09-25): читать его надо до разбора serverContent, иначе
      // он теряется, и ход уходит на сервер без расхода.
      if (data.usageMetadata) turnUsage = data.usageMetadata;
      if (data.setupComplete) {
        log('setupComplete received');
        setupComplete = true;
        opened = true;
        connecting = false;
        // Drain queued sends.
        while (pendingSends.length > 0) {
          const fn = pendingSends.shift();
          try { fn(); } catch (_) {}
        }
        // Seed history if any.
        if (priorTurns && priorTurns.length > 0) {
          global.LexVoiceHistoryInjector.seedAfterSetupComplete(ws, voiceApiModel, priorTurns);
        }
        // text_call_io: log the session-start outgoing context — a LABEL of the
        // server prompt (its text is the server's and never reaches this page)
        // + the seeded history ([Video transcript] + prior turns).
        if (cfg.recordCall === true) {
          try {
            host.post({
              type: 'LEX_LOG_VOICE_START',
              payload: {
                voiceModelId: cfg.voiceModelId || null,
                surface: cfg.surface || null,
                videoId: resolveVideoId(cfg),
                instructions: lastPromptRefs
                  ? `[server prompt: ${lastPromptRefs.base.scope}/${lastPromptRefs.base.cell}/${lastPromptRefs.base.slot}`
                    + (lastPromptRefs.content ? ` + ${lastPromptRefs.content.scope}/${lastPromptRefs.content.cell}/${lastPromptRefs.content.slot}` : '')
                    + (lastPromptRefs.voice ? ` + ${lastPromptRefs.voice.scope}/${lastPromptRefs.voice.cell}/${lastPromptRefs.voice.slot}` : '')
                    + `] call ${callId}`
                  : (lastInstructions || ''),
                seeded_context: Array.isArray(priorTurns)
                  ? priorTurns.map((t) => ({ role: t.role, content: t.content }))
                  : [],
                transcription_mode: null,
              },
            });
          } catch (_) {}
        }
        try { cb.onConnected && cb.onConnected(); } catch (_) {}
        armHardLimit();
        bumpIdle();
        return;
      }
      if (data.sessionResumptionUpdate) {
        const newHandle = data.sessionResumptionUpdate.newHandle;
        const resumable = data.sessionResumptionUpdate.resumable;
        if (newHandle && resumable !== false) sessionResumptionHandle = newHandle;
        return;
      }
      // Начало и конец речи человека (voiceActivity). Начало, пока учитель уже
      // говорил, — перебивание: пузырь новой реплики встанет, как только
      // закроется перебитый ход. Конец — миг, когда человек договорил.
      const va = data.voiceActivity && data.voiceActivity.type;
      if (va === 'ACTIVITY_END' && turnUserEndedAt == null) turnUserEndedAt = performance.now();
      if (va === 'ACTIVITY_START' && speechStartedEmittedThisTurn && (turnAssistantText || teacherSpokeThisTurn)) {
        pendingSpeechStart = true;
      }
      if (data.serverContent) {
        const sc = data.serverContent;
        // Кадр закрытого разговора, который досчитывает последний ход: звука
        // больше не играем, пузырей новых не открываем. Отбой пришёлся до
        // начала ответа — обрываем ответ на первом его кадре.
        if (closed && cutPending && (sc.modelTurn || sc.outputTranscription)) cutAnswer();
        bumpIdle();
        const onlyTurnEnd = (sc.turnComplete || sc.interrupted) && !sc.modelTurn && !sc.inputTranscription && !sc.outputTranscription;
        // «Ход закончен» после «перебит» открывать новый ход не должен.
        if (turnStartedAt === null && !onlyTurnEnd) turnStartedAt = performance.now();
        // v1.13.0: emit синтетический onUserSpeechStarted на ПЕРВОМ serverContent
        // хода — ДО transcript deltas и ДО modelTurn audio. Surface pre-create
        // user bubble — гарантирует порядок user → assistant.
        if (!speechStartedEmittedThisTurn && !onlyTurnEnd && !closed) {
          speechStartedEmittedThisTurn = true;
          try { cb.onUserSpeechStarted && cb.onUserSpeechStarted({ itemId: `${pairId()}-u` }); } catch (_) {}
        }
        if (sc.modelTurn && sc.modelTurn.parts) {
          for (const p of sc.modelTurn.parts) {
            if (p.inlineData && p.inlineData.data) {
              // v1.14.x звук: первый аудио-кусок ответа модели = конец реплики
              // пользователя. Режем сегмент один раз за turn; WAV ждёт finalizeTurn.
              if (!isPtt && !modelSpokeThisTurn && segmentRecorder && segmentRecorder.isRecording()) {
                try { lastUserSegmentWav = segmentRecorder.endSegment(); } catch (_) {}
                modelSpokeThisTurn = true; segStartTs = 0;
              }
              if (!teacherSpokeThisTurn && turnUserEndedAt == null) turnUserEndedAt = performance.now();
              teacherSpokeThisTurn = true;
              if (!closed) playPcmChunk(p.inlineData.data);
            }
          }
        }
        if (sc.inputTranscription && typeof sc.inputTranscription.text === 'string') {
          const t = sc.inputTranscription.text;
          turnUserText += t;
          try { cb.onUserTranscriptDelta && cb.onUserTranscriptDelta({ itemId: `${pairId()}-u`, text: t }); } catch (_) {}
        }
        if (sc.outputTranscription && typeof sc.outputTranscription.text === 'string') {
          const t = sc.outputTranscription.text;
          // Оборванный ответ дальше не растёт — ни после «перебит», ни после
          // отбоя, ни после отмены в «нажми и говори»: с мига обрыва звук этого
          // хода больше не считается, и текст обязан стоять вместе с ним, иначе
          // доля прозвучавшего (heardText) легла бы на текст длиннее
          // пришедшего до обрыва звука.
          if (!turnInterrupted && turnHeardSec === null) {
            turnAssistantText += t;
            try { cb.onAssistantTranscriptDelta && cb.onAssistantTranscriptDelta({ itemId: `${pairId()}-a`, text: t, isFinal: false }); } catch (_) {}
          }
        }
        if (sc.interrupted) {
          log('interrupted');
          // v1.5.255 legacy: server confirmed the cut.
          playbackSuppressed = false;
          stopPlaybackImmediately();
          if (isPtt && !closed) {
            if (!holdToTalk) { try { if (micTrack) micTrack.enabled = true; } catch (_) {} }
            pttState = 'ready';
            try { cb.onPttStateChange && cb.onPttStateChange('ready'); } catch (_) {}
          }
          // Ход закроется по «ход закончен», который Google шлёт следом вместе
          // с расходом; не пришёл — закрываем сами.
          turnInterrupted = true;
          if (interruptTimer) clearTimeout(interruptTimer);
          interruptTimer = setTimeout(() => { interruptTimer = null; if (turnInterrupted) finalizeTurn(); }, INTERRUPT_CLOSE_MS);
        }
        if (sc.turnComplete) {
          playbackSuppressed = false;
          if (isPtt && !closed) {
            if (!holdToTalk) { try { if (micTrack) micTrack.enabled = true; } catch (_) {} }
            pttState = 'ready';
            pttActivityOpen = false;
            try { cb.onPttStateChange && cb.onPttStateChange('ready'); } catch (_) {}
          }
          finalizeTurn();
        }
        // v1.14.x звук: модель договорила → снова очередь пользователя.
        if (!isPtt && sc.generationComplete && segmentRecorder && !closed) {
          modelSpokeThisTurn = false;
          segmentRecorder.beginSegment(); segStartTs = Date.now();
        }
        return;
      }
      if (data.goAway) {
        log('goAway received, timeLeft =', data.goAway.timeLeft);
      }
    }

    // Закрыть ход: пузыри — итоговым текстом, пара реплик с расходом — на
    // сервер (там её пишут в беседу и списывают деньги), та же пара под теми
    // же уидами — в копию беседы на устройстве.
    async function finalizeTurn() {
      if (interruptTimer) { clearTimeout(interruptTimer); interruptTimer = null; }
      const typed = pendingTyped;
      const userText = turnUserText.trim() || typed.trim();
      const streamedText = turnAssistantText.trim();
      const asstText = heardText(streamedText, turnAudioSec, turnHeardSec);
      const usage = turnUsage;
      const id = pairId();
      const totalMs = turnStartedAt !== null ? Math.round(performance.now() - turnStartedAt) : null;
      const ttftMs = (turnStartedAt !== null && turnFirstAudioAt !== null)
        ? Math.round(turnFirstAudioAt - turnStartedAt) : null;
      const userEndedAt = turnUserEndedAt;
      const wasInterrupted = turnInterrupted;
      // Ответ у Google начался (пришёл его звук или текст), даже если человек
      // не услышал из него ничего. Без расхода сервер по этому признаку
      // списывает минимум за ход (voice-floor.ts). Только у хода, закрытого
      // отбоем (обрыв, срок ожидания): посреди разговора ход без расхода
      // закрывает таймер перебивания, и опоздавший расход Google ляжет в
      // следующую пару — минимум сверху был бы вторым списанием того же хода.
      const answered = closed && (!!streamedText || teacherSpokeThisTurn);

      // Сбросить ход ДО любых await: следующий кадр уже про новый ход.
      turnIndex += 1;
      turnUserText = '';
      turnAssistantText = '';
      turnStartedAt = null;
      turnFirstAudioAt = null;
      turnUsage = null;
      turnUserEndedAt = null;
      turnInterrupted = false;
      turnAudioSec = 0;
      turnHeardSec = null;
      teacherSpokeThisTurn = false;
      speechStartedEmittedThisTurn = false;
      if (typed) pendingTyped = '';
      // Последний ход закрытого разговора досчитан — связь закрывается сейчас
      // же (settleAndReport): в живом режиме Google после обрыва уже начинает
      // ответ заново.
      if (settleResolve && (asstText || usage || cutSent)) endSettle();

      // Пустой ход (кадр «ход закончен» без слов и без расхода) — ничего не
      // пишем и номер пары не тратим.
      // Набежавший на экран ответ, от которого не прозвучало ничего: в беседу
      // он не ляжет, и пузырь с ним снимается.
      const dropStreamed = () => {
        if (streamedText && !asstText) {
          try { cb.onAssistantTranscriptDropped && cb.onAssistantTranscriptDropped({ itemId: `${id}-a` }); } catch (_) {}
        }
      };
      if (!userText && !asstText && !usage) {
        dropStreamed();
        turnIndex -= 1;
        armNextSpeech();
        return;
      }
      pairSeq += 1;

      const breakdown = parseGeminiUsageBreakdown(usage);
      if (breakdown) for (const k of Object.keys(sessionUsage)) sessionUsage[k] += Number(breakdown[k] || 0);
      if (totalMs) sessionMs += totalMs;
      const turnInfo = {
        userText, assistantText: asstText,
        actualModel: voiceApiModel,
        tokensIn: 0, tokensOut: 0,
        breakdown,
        totalMs, ttftMs,
        turnIndex: turnIndex - 1,
        inputCost: null,
        outputCost: null,
        interrupted: wasInterrupted,
      };
      if (userText) {
        try { cb.onUserTranscriptComplete && cb.onUserTranscriptComplete({ itemId: `${id}-u`, finalText: userText }); } catch (_) {}
      }
      if (asstText) {
        try { cb.onAssistantTranscriptComplete && cb.onAssistantTranscriptComplete({ itemId: `${id}-a`, finalText: asstText }); } catch (_) {}
      } else {
        dropStreamed();
      }

      // Пара — на сервер сразу. Тексты — ровно те, что легли в пузыри; расход
      // — как его прислал Google, разложенный по видам (звук/текст).
      server.sendTurn({
        id,
        user: userText ? { text: userText, endedAt: userEndedAt != null ? userEndedAt : performance.now() } : null,
        teacher: asstText ? { text: asstText, endedAt: performance.now() } : null,
        usage: breakdown,
        answered,
      });

      // Копия беседы на устройстве — под теми же уидами, что у сервера.
      const videoId = resolveVideoId(cfg);
      if (videoId && (userText || asstText)) {
        const items = [];
        if (userText) items.push({ role: 'user', text: userText, uid: `voice:${id}-u` });
        if (asstText) items.push({ role: 'assistant', text: asstText, uid: `voice:${id}-a` });
        global.LexVoiceThreadWriter.flushItemsViaSW({
          videoId, items,
          noPersistentThread: cfg.noPersistentThread === true,
          marker: cfg.threadTurnMarker || null,   // '[word]' у попапа по слову
        });
      }
      armNextSpeech();

      // v1.14.x звук: WAV реплики пользователя этого хода.
      if (!lastUserSegmentWav && segmentRecorder && segmentRecorder.isRecording() && !closed) {
        try { lastUserSegmentWav = segmentRecorder.endSegment(); } catch (_) {}
      }
      const userSegmentWav = lastUserSegmentWav;
      lastUserSegmentWav = null;

      // Учёт устройства — для сверки: деньги этого хода списал сервер по паре
      // выше, отчёт о конце разговора у Gemini больше не списывает.
      const teleResp = await global.LexVoiceTelemetry.recordVoiceCall({
        recordCall: cfg.recordCall === true,
        payload: {
          billTo: 'server-aggregate',
          callId,
          responseId: id,
          videoId,
          voiceModelId: cfg.voiceModelId || null,
          promptText: lastPromptRefs ? '' : (lastInstructions || ''),
          turn_index: turnIndex - 1,
          input_text: userText || null,
          output_text: asstText || null,
          ttft_ms: ttftMs,
          total_ms: totalMs,
          breakdown,
          effort: null,
          max_tokens: null,
          error_message: null,
          http_status: null,
          transcription_mode: null,
          surface: cfg.surface || null,
          audioB64: userSegmentWav,
        },
      });
      if (teleResp) {
        turnInfo.inputCost = teleResp.inputCost;
        turnInfo.outputCost = teleResp.outputCost;
      }

      if (cfg.recordCall === true) {
        try {
          host.post({
            type: 'LEX_LOG_VOICE_TURN',
            payload: {
              voiceModelId: cfg.voiceModelId || null,
              surface: cfg.surface || null,
              videoId,
              turn_index: turnIndex - 1,
              user_speech: userText || null,
              audio_input: !!userSegmentWav,
              audioB64: userSegmentWav,
              assistant_text: asstText || null,
              usage_main: breakdown,
              usage_oob: null,
              transcription_mode: null,
            },
          });
        } catch (_) {}
      }

      try { cb.onAssistantTurnComplete && cb.onAssistantTurnComplete(turnInfo); } catch (_) {}
    }

    // Человек заговорил поверх учителя — пузырь его реплики встаёт сразу за
    // закрытым ходом, не дожидаясь расшифровки.
    function armNextSpeech() {
      if (!pendingSpeechStart) return;
      pendingSpeechStart = false;
      if (closed) return;
      speechStartedEmittedThisTurn = true;
      turnStartedAt = performance.now();
      try { cb.onUserSpeechStarted && cb.onUserSpeechStarted({ itemId: `${pairId()}-u` }); } catch (_) {}
    }

    function parseGeminiUsageBreakdown(usage) {
      if (!usage) return null;
      // promptTokensDetails / responseTokensDetails — массивы
      // {modality:'TEXT'|'AUDIO'|'VIDEO'|'IMAGE', tokenCount}. У Live выход
      // называется responseTokensDetails (замерено 2026-09-25); старое имя
      // candidatesTokensDetails — у обычного generateContent, оставлено
      // запасным.
      function aggregate(details) {
        const out = { TEXT: 0, AUDIO: 0 };
        if (Array.isArray(details)) {
          for (const d of details) {
            const mod = d && d.modality;
            if (mod === 'TEXT' || mod === 'AUDIO') out[mod] += (d.tokenCount || 0);
          }
        }
        return out;
      }
      const inAgg = aggregate(usage.promptTokensDetails);
      const outAgg = aggregate(usage.responseTokensDetails || usage.candidatesTokensDetails);
      const cachedAgg = aggregate(usage.cacheTokensDetails);
      const cachedTotal = usage.cachedContentTokenCount || 0;
      // Кэш по видам, если Google его разложил; иначе весь — в текст.
      const byMod = (cachedAgg.TEXT + cachedAgg.AUDIO) > 0;
      return {
        textInput: inAgg.TEXT,
        audioInput: inAgg.AUDIO,
        textCachedInput: byMod ? cachedAgg.TEXT : cachedTotal,
        audioCachedInput: byMod ? cachedAgg.AUDIO : 0,
        textOutput: outAgg.TEXT,
        audioOutput: outAgg.AUDIO,
        thoughtsOutput: usage.thoughtsTokenCount || 0,
      };
    }

    async function stop(opts) {
      if (closed) return;
      const reason = (opts && opts.reason) || 'manual';
      teardown(reason);
      try { cb.onDisconnected && cb.onDisconnected(Object.assign({ reason }, opts && opts.source ? { source: opts.source } : {})); } catch (_) {}
    }

    // Микрофон, звук ответа, анализаторы — то, что человек видит и слышит.
    function releaseMedia() {
      stopRmsLoop();
      try { stopPlaybackImmediately(); } catch (_) {}
      try { if (segmentRecorder) { if (segmentRecorder.isRecording()) lastUserSegmentWav = segmentRecorder.endSegment(); segmentRecorder.dispose(); } } catch (_) {}
      try { if (micProc) micProc.onaudioprocess = null; } catch (_) {}
      try { if (micProc) micProc.disconnect(); } catch (_) {}
      try { if (micSource) micSource.disconnect(); } catch (_) {}
      try { if (micSink) micSink.disconnect(); } catch (_) {}
      try { if (micCtx) micCtx.close(); } catch (_) {}
      try { if (playbackCtx) playbackCtx.close(); } catch (_) {}
      try { if (micAnalyser) micAnalyser.disconnect(); } catch (_) {}
      try { if (analyserCtx) analyserCtx.close(); } catch (_) {}
      try { if (localStream) localStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
      localStream = null; micTrack = null;
      micCtx = null; micSource = null; micProc = null; micSink = null;
      playbackCtx = null;
      analyserCtx = null; micAnalyser = null; playbackAnalyser = null;
    }

    // reason — почему кончился разговор; серверу из них уходят только те, что
    // заметило само устройство (тишина, предел времени).
    function teardown(reason) {
      closed = true;
      server.stopPresence();
      clearTimers();
      // Отбой — серверу СРАЗУ: строка разговора закрывается в миг нажатия, и
      // следующее нажатие не упирается в «разговор уже идёт». Связь с воркером
      // — сразу за отбоем (done только если отбой ушёл отсюда).
      const endSent = server.hangup(reason);
      server.closeLink(endSent);
      // v1.14.x voice_session: цельная дорожка сеанса — до освобождения ctx.
      try {
        if (sessionRecorder) {
          const wav = sessionRecorder.endSession();
          if (wav) global.LexVoiceTelemetry.recordVoiceSession({
            recordCall: cfg.recordCall === true,
            payload: { voiceModelId: cfg.voiceModelId || null, surface: cfg.surface || null, videoId: resolveVideoId(cfg), audioB64: wav, callId },
          });
          sessionRecorder.dispose();
        }
      } catch (_) {}
      releaseMedia();
      settleAndReport();
    }

    // Обрыв ответа у Google без закрытия связи (см. SETTLE_MS выше). Одна
    // команда на разговор; дальше ждём «ход закончен» не дольше CUT_WAIT_MS.
    function cutAnswer() {
      cutPending = false;
      if (cutSent || !ws || ws.readyState !== WebSocket.OPEN) return;
      cutSent = true;
      try {
        ws.send(JSON.stringify(isPtt
          ? { realtimeInput: { activityStart: {} } }
          : { clientContent: { turns: [], turnComplete: true } }));
        log('hang-up mid-turn: answer cut at the provider, waiting for its usage');
      } catch (err) { warn('cut send failed:', err); }
      armSettle(CUT_WAIT_MS);
    }
    function armSettle(ms) {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => { settleTimer = null; endSettle(); }, ms);
    }
    function endSettle() {
      if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
      cutPending = false;
      if (settleResolve) { const r = settleResolve; settleResolve = null; r(); }
    }

    // Разговор кончился посреди хода: ответ обрывается у Google, его «ход
    // закончен» с расходом дожидается, и ход записывается и оплачивается, как
    // у OpenAI. Потом — незакрытый ход (человек договорил, ответа нет) и отчёт
    // о конце разговора.
    async function settleAndReport() {
      // Ход у Google уже идёт: учитель заговорил, его перебили, или человек
      // договорил (Google слышал реплику целиком и отвечает — за это он
      // возьмёт деньги, даже если звук ответа ещё не пришёл). Человек
      // оборвал себя на полуслове — ждать нечего.
      const personDone = turnUserEndedAt != null || !!pendingTyped || (isPtt && pttState === 'speaking');
      const answerStarted = !!(turnAssistantText || teacherSpokeThisTurn);
      const open = !!(ws && ws.readyState === WebSocket.OPEN);
      if (open && (answerStarted || turnInterrupted || personDone)) {
        await new Promise((resolve) => {
          settleResolve = resolve;
          // Перебит — «ход закончен» уже в пути (~50 мс), обрывать нечего.
          if (turnInterrupted) armSettle(CUT_WAIT_MS);
          else if (answerStarted) cutAnswer();
          else { cutPending = true; armSettle(SETTLE_MS); }
        });
      }
      try { if (ws) { ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null; ws.close(); } } catch (_) {}
      ws = null;
      try {
        if ((turnUserText && turnUserText.trim()) || (turnAssistantText && turnAssistantText.trim()) || turnUsage || pendingTyped) {
          await Promise.race([finalizeTurn(), new Promise((r) => setTimeout(r, 1500))]);
        }
      } catch (_) {}
      // Пары, стоящие в очереди, — раньше отчёта (не дольше 4 с): отчёт ничего
      // не списывает, но сверку пишет по тому, что устройство насчитало.
      try { await Promise.race([server.drained(), new Promise((r) => setTimeout(r, 4000))]); } catch (_) {}
      try {
        // usage/durationMs — итог пар этого разговора, как их посчитал сам
        // модуль. Воркер расширения шлёт отчёт из своего учёта, страница — из
        // этого итога: отчёт добирает пару, не дошедшую до сервера.
        host.post({ type: 'VOICE_SESSION_END', callId, model: cfg.voiceModelId, surface: cfg.surface || null, turns: pairSeq, usage: sessionUsage, durationMs: sessionMs });
      } catch (_) {}
    }

    function sendUserText(text) {
      if (closed) return;
      const send = async () => {
        if (closed || !ws || ws.readyState !== WebSocket.OPEN) return;
        let payloadText = text;
        // v1.11.0 Область 6 + LESSONS 2026-05-04: для native-audio моделей
        // audio-input игнорирует clientContent.turns history — prior turns
        // вклеиваются в текст этого хода.
        const videoId = resolveVideoId(cfg);
        if (videoId && global.LexVoiceHistoryInjector
            && global.LexVoiceHistoryInjector.isNativeAudio(voiceApiModel)
            && typeof cfg.historyProvider === 'function') {
          try {
            const turns = await cfg.historyProvider();
            if (Array.isArray(turns) && turns.length > 0) {
              const lines = turns.map((t) =>
                `${t.role === 'assistant' ? 'Assistant' : 'User'}: ${t.content || ''}`);
              payloadText =
                'This is the prior conversation in this video — read it carefully and remember the facts:\n\n' +
                lines.join('\n') +
                '\n\n[end of prior conversation]\n\nNow reply to the user\'s next message.\n\nUser: ' + text;
            }
          } catch (err) {
            warn('native-audio history glue failed:', err && err.message || err);
          }
        }
        try {
          ws.send(JSON.stringify({
            clientContent: {
              turns: [{ role: 'user', parts: [{ text: payloadText }] }],
              turnComplete: true,
            },
          }));
        } catch (err) { warn('sendUserText failed:', err); }
        // Набранный текст — реплика человека ближайшего хода: расшифровки у
        // него нет, и в беседу (на сервере и в копии) он ляжет парой с ответом
        // учителя, когда ход закроется.
        pendingTyped = pendingTyped ? pendingTyped + '\n' + text : text;
        if (turnUserEndedAt == null) turnUserEndedAt = performance.now();
      };
      if (setupComplete) send(); else pendingSends.push(send);
    }

    // v1.11.0 / legacy shared.js v1.5.252 handleGeminiPttButtonClick.
    //
    // OpenAI Realtime mapping        Gemini Live mapping
    //   input_audio_buffer.commit  →  realtimeInput.activityEnd
    //   response.create            →  (no-op — model replies
    //                                  automatically once activityEnd
    //                                  lands on AAD-disabled session)
    //   response.cancel +          →  realtimeInput.activityStart
    //     output_audio_buffer.clear   (also implicitly re-opens the
    //                                  next user turn — server emits
    //                                  serverContent.interrupted)
    //   response.done              →  serverContent.turnComplete
    //
    // Voice-mode (AAD on): no-op — server VAD detects end of speech.
    function commitTurn() {
      if (closed) return;
      if (!isPtt) return;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      bumpIdle();
      if (pttState === 'ready') {
        // ready → speaking: commit accumulated audio. Mute mic first
        // so the model's response can't leak into a future user turn
        // via the open mic.
        playbackSuppressed = false;
        // v1.15.x B: PTT конец реплики = ручной commit. Режем сегмент здесь (по
        // кнопке), ДО глушения mic; WAV ждёт finalizeTurn (как OpenAI PTT).
        try { if (segmentRecorder && segmentRecorder.isRecording()) lastUserSegmentWav = segmentRecorder.endSegment(); } catch (_) {}
        try { if (micTrack) micTrack.enabled = false; } catch (_) {}
        try {
          ws.send(JSON.stringify({ realtimeInput: { activityEnd: {} } }));
        } catch (err) {
          warn('ws.send (activityEnd) failed:', err);
        }
        pttActivityOpen = false;
        pttState = 'speaking';
        try { cb.onPttStateChange && cb.onPttStateChange('speaking'); } catch (_) {}
      } else {
        // speaking → ready (cancel / barge-in). Order matters:
        //   1. Stop local playback FIRST — Web Audio drains queued
        //      chunks otherwise (v1.5.254).
        //   2. Suppress incoming chunks until interrupted/turnComplete
        //      lands (v1.5.255 — server has ~100–300 ms RTT before it
        //      actually stops).
        //   3. Tell server to stop via activityStart on AAD-disabled
        //      session — server emits serverContent.interrupted.
        //   4. Re-enable the mic + flip the state immediately — user
        //      has already moved on; don't wait for interrupted.
        stopPlaybackImmediately();
        playbackSuppressed = true;
        try {
          ws.send(JSON.stringify({ realtimeInput: { activityStart: {} } }));
          pttActivityOpen = true;
          pttChunksSinceStart = 0;
        } catch (err) {
          warn('ws.send (activityStart on cancel) failed:', err);
        }
        try { if (micTrack) micTrack.enabled = true; } catch (_) {}
        pttState = 'ready';
        try { cb.onPttStateChange && cb.onPttStateChange('ready'); } catch (_) {}
      }
    }

    // «Нажми и держи» (страница и программа для Мака, 2026-09-29): палец на
    // кнопке — реплика идёт, отпустил — реплика закончена. До этого страница
    // держала живой разговор и на «отпустил» только глушила микрофон, и
    // учитель ждал, пока слух Google насчитает паузу после речи (1,5 с по
    // опубликованной ручке, у живого голоса дольше). Теперь это тот же режим
    // «нажми и говори», что в расширении: слух Google выключен, конец реплики
    // отмечает activityEnd, и ответ идёт сразу.
    //   talkPress — учитель ещё отвечает: ответ обрывается (как отмена в
    //     commitTurn), микрофон открыт; реплику откроет первый же кусок звука
    //     (activityStart в цикле микрофона).
    //   talkRelease — реплика закончена, если звук после activityStart уже
    //     ушёл; иначе (касание короче первого куска звука, или только оборвал
    //     учителя) микрофон просто закрывается, а открытая реплика ждёт
    //     следующего нажатия — пустую реплику Google отвечать не станет.
    function talkPress() {
      if (closed || !isPtt) return;
      if (pttState === 'speaking') commitTurn();
      try { if (micTrack) micTrack.enabled = true; } catch (_) {}
    }
    function talkRelease() {
      if (closed || !isPtt) return;
      if (pttState === 'ready' && pttActivityOpen && pttChunksSinceStart > 0) { commitTurn(); return; }
      try { if (micTrack) micTrack.enabled = false; } catch (_) {}
    }

    function mute(on) {
      if (closed) return;
      try { micTrack.enabled = !on; } catch (_) {}
    }

    function updateInstructions(text) {
      // Промпт держит сервер — местной подмене тут делать нечего (то же
      // правило, что у OpenAI: updateInstructions skipped на server-held).
      // Без этого следующая сессия стартовала бы с локальным текстом, то есть
      // с пустой ролью.
      if (lastPromptRefs) { log('updateInstructions skipped (server-held prompt)'); return; }
      // Gemini Live setup is frozen after setupComplete (per spec). Note
      // and queue for next session start.
      lastInstructions = text || '';
      log('updateInstructions queued for next session (Live setup is frozen)');
    }

    function updateKnobs(knobsPatch) {
      // Same — Gemini Live config frozen. Cache for next start.
      lastKnobs = Object.assign({}, lastKnobs || {}, knobsPatch || {});
      log('updateKnobs queued for next session (Live setup is frozen)');
    }

    return {
      start,
      stop,
      sendUserText,
      mute,
      isOpen: () => opened && !closed,
      isConnecting: () => connecting,
      // Номер разговора, который назначил сервер (null — ещё не назначен).
      callId: () => callId,
      // Ответ незакрытого хода, каким он ляжет в беседу, — прямо сейчас. После
      // отбоя текст не растёт, поэтому это и есть итог хода: поверхности, у
      // которой лента закрывается вместе с отбоем, не нужно ждать «ход
      // закончен» (страница). null — ответа в этом ходе нет.
      heardNow: () => {
        const streamed = turnAssistantText.trim();
        if (!streamed) return null;
        return { itemId: `${pairId()}-a`, text: heardText(streamed, turnAudioSec, turnHeardSec) };
      },
      commitTurn,
      talkPress,
      talkRelease,
      updateInstructions,
      updateKnobs,
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────────
  function makeCallbacks(cfg) {
    return {
      onConnecting: cfg.onConnecting,
      onConnected: cfg.onConnected,
      onDisconnected: cfg.onDisconnected,
      onError: cfg.onError,
      onUserSpeechStarted: cfg.onUserSpeechStarted,
      onUserTranscriptDelta: cfg.onUserTranscriptDelta,
      onUserTranscriptComplete: cfg.onUserTranscriptComplete,
      onUserTranscriptFailed: cfg.onUserTranscriptFailed,
      onAssistantTranscriptDelta: cfg.onAssistantTranscriptDelta,
      onAssistantTranscriptComplete: cfg.onAssistantTranscriptComplete,
      // Ответ набежал на экран, а не прозвучало из него ничего — снять пузырь.
      onAssistantTranscriptDropped: cfg.onAssistantTranscriptDropped,
      onAssistantTurnComplete: cfg.onAssistantTurnComplete,
      onMicLevel: cfg.onMicLevel,
      onPlaybackLevel: cfg.onPlaybackLevel,
      onPttStateChange: cfg.onPttStateChange,
      // Пара реплик не дошла до сервера и после повторов (voice/call-server.js).
      onTurnNotSaved: cfg.onTurnNotSaved,
      // Страница: поток микрофона и «учитель говорит».
      onLocalStream: cfg.onLocalStream,
      onTeacherSpeaking: cfg.onTeacherSpeaking,
    };
  }

  // Доля текста ответа, которая прозвучала: звук обрезан на heardSec из
  // audioSec пришедших секунд. Речь идёт ровным темпом, поэтому доля звука —
  // доля текста; обрезка — по концу слова, на котором звук оборвался. Звук
  // прозвучал весь (или обрыва не было) — текст целиком.
  function heardText(text, audioSec, heardSec) {
    if (!text || heardSec == null) return text;
    if (!(audioSec > 0)) return '';
    const share = heardSec / audioSec;
    if (share >= 0.98) return text;
    if (share <= 0) return '';
    let n = Math.round(text.length * share);
    while (n < text.length && !/\s/.test(text[n])) n++;
    return text.slice(0, n).trimEnd();
  }

  // Разговор начинает сервер (llm-proxy voice-token-gemini, через воркер):
  // деньги, занятость линии, запас, строка разговора, ключ Google с зашитой
  // настройкой. Ответ — номер разговора, ключ и модель; текста промпта в нём
  // нет. Отказ по сути (не вошёл, нет денег, линия занята, очередь, промпт не
  // опубликован) — ожидаемое «нет», не поломка: onDisconnected с причиной
  // gate-… и помеченная ошибка, по которой поверхность пишет надпись.
  async function requestGoogleCall(cfg, promptRefs, extra, host) {
    return host.send({
      type: 'VOICE_TOKEN_GEMINI',
      linkId: extra && extra.linkId || null,
      model: cfg.voiceModelId,
      meta: {
        videoId: resolveVideoId(cfg), surface: cfg.surface || null,
        // Тип страницы разговора: голос поднимается и в суперчате на
        // произвольном сайте, где 'youtube' был бы неправдой.
        pageType: (global.LexPageType && global.LexPageType.current()) || null,
      },
      // Указатели, по которым сервер соберёт инструкцию и зашьёт её в ключ.
      // Текста инструкций устройство не шлёт вовсе: сервер его не принимает
      // (без указателей — отказ 400 'prompt').
      promptRefs: promptRefs || null,
      knobs: (extra && extra.knobs) || null,
      voiceName: (extra && extra.voiceName) || null,
      ptt: !!(extra && extra.ptt),
    });
  }

  // Ответ сервера на старт → номер разговора и ключ, либо помеченная ошибка.
  function googleCallOf(resp, cb) {
    if (resp && resp.ok && resp.token && resp.callId) return { token: resp.token, callId: resp.callId, apiModel: resp.apiModel || null };
    const gate =
      (resp && resp.__gate === 'login') ? ['login', '__LEX_VOICE_LOGIN__'] :
      // 402 = денег нет (llm-proxy): просьба пополнить, а не «голос недоступен».
      (resp && resp.status === 402) ? ['balance', '__LEX_VOICE_BALANCE__'] :
      // 424 = сервер не нашёл промпта по присланным указателям; 400 'prompt' —
      // указателей нет вовсе. Платный разговор не с тем собеседником —
      // молчать об этом нельзя.
      (resp && (resp.status === 424 || (resp.status === 400 && resp.stage === 'prompt'))) ? ['prompt', '__LEX_VOICE_PROMPT_MISSING__'] :
      // Места в очереди платных вызовов не дождались — «сервис занят».
      (resp && resp.queueBusy) ? ['queuebusy', '__LEX_VOICE_QUEUE_BUSY__'] :
      (resp && resp.over) ? ['cap', '__LEX_VOICE_CAP__'] :
      // 409: 'voice_busy' — у аккаунта идёт другой живой разговор; любой другой
      // 409 — временный («нажмите ещё раз»), как у голоса OpenAI.
      (resp && resp.status === 409 && resp.stage === 'voice_busy') ? ['busy', '__LEX_VOICE_BUSY__'] :
      (resp && resp.status === 409) ? ['retry', '__LEX_VOICE_RETRY__'] : null;
    if (gate) {
      try { cb && cb.onDisconnected && cb.onDisconnected({ reason: 'gate-' + gate[0] }); } catch (_) {}
      throw new Error(gate[1]);
    }
    throw new Error('__LEX_VOICE_MINT_FAILED__');
  }

  async function resolveInstructions(cfg) {
    if (typeof cfg.instructionsProvider === 'function') {
      try { return await cfg.instructionsProvider(); } catch (_) { return ''; }
    }
    return cfg.instructions || '';
  }

  async function resolveKnobs(cfg) {
    if (typeof cfg.knobsProvider === 'function') {
      try { return await cfg.knobsProvider(); } catch (_) { return null; }
    }
    return null;
  }

  function resolveVideoId(cfg) {
    if (typeof cfg.videoIdProvider === 'function') {
      try { return cfg.videoIdProvider() || null; } catch (_) {}
    }
    return cfg.videoId || null;
  }

  // Ручки, которые сервер переводит в настройку разговора Google (имена — как
  // в настройках, knob<Имя> без приставки). Только простые значения: сервер
  // всё равно пропускает их через белый список.
  const GEMINI_KNOBS = ['voiceMaxResponseTokens', 'voiceSilenceDurationMs', 'voicePrefixPaddingMs',
    'voiceVadThreshold', 'voiceEndSensitivity', 'voiceInterruptResponse', 'voiceLongSessions',
    'voiceOutputLanguage', 'voiceThinkingLevel'];
  function geminiKnobsOf(knobs) {
    const out = {};
    if (!knobs || typeof knobs !== 'object') return out;
    for (const k of GEMINI_KNOBS) {
      const v = knobs[k];
      if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') out[k] = v;
    }
    return out;
  }

  global.LexVoiceGeminiLive = { create, heardText };
})(typeof self !== 'undefined' ? self : globalThis);
