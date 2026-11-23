// LexDictationLive — живая диктовка: звук уходит потоком, пока человек говорит,
// и текст растёт в поле ввода, не дожидаясь конца речи.
//
// ЧЕМ ЭТО ОТЛИЧАЕТСЯ ОТ ОБЫЧНОЙ ДИКТОВКИ. Обычная (dictation.js, wc-composer.js)
// пишет весь звук в файл и отправляет его ПОСЛЕ того, как человек отпустил
// кнопку; поток там — это поток ОТВЕТА, и текст поэтому появляется взрывом в
// конце. Здесь наоборот: звук едет во время речи, и куски текста возвращаются
// по ходу. Модель у этого своя (`gpt-live-transcribe`), и на обычный путь
// `v1/audio/transcriptions` она не отвечает вовсе.
//
// ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ. Ни адреса провайдера, ни ключа, ни имени модели по
// умолчанию, ни цены, ни строки расхода. Всё это живёт на сервере, в функции
// `dictation-live`, ОДИН раз на все четыре поверхности. Этот файл умеет ровно
// две вещи: снять с микрофона звук в том виде, который провайдер принимает, и
// отдать наверх текст, который вернулся. Так и написано в задании: клиенты
// гонят звук и рисуют текст.
//
// ПОЧЕМУ ЗАВИСИМОСТИ ПРИХОДЯТ АРГУМЕНТОМ. Расширение и страница разговаривают
// со своим фоном по-разному (`chrome.runtime` против `WcBus`), а на странице
// `LexPlatform` вовсе не загружен. Поэтому транспорт — это две функции,
// которые даёт хозяин: `call(type, payload)` и `subscribe(fn)`. Тот же приём,
// которым живёт ядро учителя (lex-teacher-core.js): всё внешнее — аргументом.
//
// ЧТО ДЕРЖИТ СОКЕТ. Не этот файл. В расширении — service worker, чтобы пропуск
// аккаунта не уезжал в content-script на чужой странице; на странице — её
// собственный фоновый слой. Отсюда уходят только сообщения.

(function (global) {
  'use strict';

  // Частота звука — свойство РАСПОЗНАВАЛКИ, а не этого файла. Каждая живая
  // распознавалка требует свою и отвергает всю настройку сессии целиком, если
  // частота не та: OpenAI на 16 000 отвечает «Expected a value >= 24000», и
  // сессия молча не распознаёт ничего (замерено 2026-09-09). Источник —
  // строка модели в базе (`sample_rate_hz`), её читает каталог
  // (lex-dictation-catalog.js). Запасного числа здесь нет: снять звук не на той
  // частоте хуже, чем честно отказаться, — поставщик распознает тишину.
  function sampleRateFor(apiModel) {
    const C = global.LexDictationCatalog;
    const v = C && typeof C.sampleRate === 'function' ? C.sampleRate(apiModel) : null;
    return (typeof v === 'number' && v > 0) ? v : null;
  }
  // Сколько отсчётов набирается перед отправкой. 4096 при 24 кГц — это ~170 мс
  // звука в сообщении: достаточно редко, чтобы не топить шину сообщениями, и
  // достаточно часто, чтобы текст рос без рывков.
  const FRAME_SAMPLES = 4096;
  // Страховка на связь, которая умерла молча (сеть пропала без закрытия): тогда
  // не придёт ни кадр конца, ни закрытие сокета, и кнопка горела бы, пока ОС не
  // сдастся на TCP. Срок — потолок сессии, названный сервером, плюс этот запас на
  // его итог; своего потолка у поверхности нет.
  const BACKSTOP_SLACK_MS = 15000;
  // Потолок на звук, накопленный ДО того, как сервер сказал «готов». Обычно
  // это доли секунды, но если сервер не отвечает вовсе — память расти не
  // должна. Сервер может ждать свободного места в очереди платных вызовов до
  // 30 секунд (реле тогда продлевает срок старта), и всё это время человек
  // говорит: 45 секунд покрывают ожидание и самое медленное подключение из
  // замеренных. Сверху память держит срок старта в реле — не дождались
  // «готов», запись кончается. Считается от частоты той распознавалки,
  // которую выбрали.
  const PREBUFFER_MAX_SEC = 45;

  // ── The sound from the press ────────────────────────────────────────────
  //
  // Gennady, 23.11.2026: «I press and speak at once, and the start of the phrase is lost». A MediaStream keeps
  // nothing: what the microphone hears before an audio graph is connected to it is gone. The surfaces used
  // to connect the graph only after the microphone had opened, the recognizer had been chosen and the
  // sign-in checked, and the graph itself then took a moment to start. Whatever was said in that time was
  // lost. So the graph rises AT THE PRESS (`capture()`), in parallel with getUserMedia, and the stream is
  // attached to it the moment it comes. Every frame from then on waits in the capture's queue until a
  // live session takes it: first the queue, in order, then each frame as it comes.
  //
  // The rate of the capture is guessed at the press: the recognizer is often not chosen yet. The guess is
  // the rate of the last live session in this window, or of the default recognizer, from the catalog. When
  // the chosen recognizer wants another rate, the session converts every frame (`resampler`), so a wrong
  // guess costs nothing but a little arithmetic.
  let lastRate = null;
  function guessRate() {
    if (lastRate) return lastRate;
    const R = global.LexModelRegistry;
    return sampleRateFor(R && R.defaultDictationModel) || null;
  }

  // A streaming converter of the rate for frames of Float32: linear interpolation, with a low-pass filter
  // (two Butterworth biquads, cut-off at 45% of the new rate) before it when the rate goes down, so the
  // speech above the new Nyquist frequency does not fold back into the band. The state is kept across
  // frames: the output is one continuous signal, whatever the sizes of the frames.
  function resampler(from, to) {
    const step = from / to;
    const stages = [];
    let filter = null;
    if (to < from) {
      const w = (2 * Math.PI * 0.45 * to) / from;
      const cos = Math.cos(w);
      const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
      const a0 = 1 + alpha;
      const b0 = ((1 - cos) / 2) / a0;
      const b1 = (1 - cos) / a0;
      const a1 = (-2 * cos) / a0;
      const a2 = (1 - alpha) / a0;
      for (let k = 0; k < 2; k++) stages.push({ x1: 0, x2: 0, y1: 0, y2: 0 });
      filter = (x) => {
        for (const s of stages) {
          const y = b0 * x + b1 * s.x1 + b0 * s.x2 - a1 * s.y1 - a2 * s.y2;
          s.x2 = s.x1; s.x1 = x; s.y2 = s.y1; s.y1 = y;
          x = y;
        }
        return x;
      };
    }
    let prev = 0;   // the last sample of the previous frame — index -1 of the next one
    let t = 0;      // where the next output sample stands, in samples of the current frame (−1 ≤ t)
    return (input) => {
      const n = input.length;
      if (!n) return new Float32Array(0);
      const x = filter ? Float32Array.from(input, filter) : input;
      const out = new Float32Array(Math.max(0, Math.ceil((n - 1 - t) / step) + 1));
      let k = 0;
      while (t < n - 1 && k < out.length) {
        const i = Math.floor(t);
        const f = t - i;
        const a = i < 0 ? prev : x[i];
        out[k++] = a + (x[i + 1] - a) * f;
        t += step;
      }
      t -= n;
      prev = x[n - 1];
      return k === out.length ? out : out.subarray(0, k);
    };
  }

  // The audio graph of one press: it rises now; `attach(stream)` connects the microphone the moment it is
  // open; from that frame on the sound waits in the queue until a session `take`s it. Owned by the press
  // until a session starts on it (start() closes it on every way out from then); a press that does not get
  // there (the microphone refused, the cross, a recognizer of files) calls `close()`.
  //   options: { rate } — the rate wanted (default: the guess above)
  function capture(options) {
    const AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) throw new Error('no AudioContext here');
    const want = (options && Number(options.rate) > 0) ? Number(options.rate) : guessRate();
    let ctx;
    try { ctx = want ? new AC({ sampleRate: want }) : new AC(); }
    catch (_) { ctx = new AC(); }
    // Created inside the press, the context may still be held (a web view): asked to run at once.
    try { if (ctx.state === 'suspended' && typeof ctx.resume === 'function') ctx.resume().catch(() => {}); } catch (_) { /* noop */ }
    const rate = ctx.sampleRate;
    const maxSamples = PREBUFFER_MAX_SEC * rate;
    let source = null, processor = null, sink = null, closed = false;
    let queue = [], queued = 0, dropped = 0, taker = null;
    let attachedAt = null;
    const cap = {
      rate,
      context: ctx,
      // The microphone is open: the sound goes into the queue from its first frame.
      attach(stream) {
        if (closed) return false;
        if (source) return true;
        source = ctx.createMediaStreamSource(stream);
        // ScriptProcessorNode, not AudioWorklet, on purpose: a worklet is loaded from a SEPARATE file by
        // address, and in a content script on someone else's page that address is checked by THE PAGE'S
        // CSP — on a strict site the microphone would silently not start. The node is marked deprecated
        // but works in Chrome and in WKWebView (the macOS shell) and loads nothing.
        processor = ctx.createScriptProcessor(FRAME_SAMPLES, 1, 1);
        processor.onaudioprocess = (e) => {
          if (closed) return;
          // A copy: the browser reuses the buffer of the event.
          const f = new Float32Array(e.inputBuffer.getChannelData(0));
          if (taker) { taker(f); return; }
          if (queued + f.length > maxSamples) { dropped++; return; }
          queue.push(f);
          queued += f.length;
        };
        source.connect(processor);
        // The node must be connected to the output or Chrome does not call it. Nothing is written into
        // its output buffer, and it is muted on the way: the person must not hear their own voice.
        sink = ctx.createGain();
        sink.gain.value = 0;
        processor.connect(sink);
        sink.connect(ctx.destination);
        attachedAt = Date.now();
        return true;
      },
      attached: () => !!source && !closed,
      attachedAt: () => attachedAt,
      // A session takes the sound: what waited, in order, then each frame as it comes. → frames dropped
      // over the ceiling of the queue.
      take(fn) {
        const q = queue;
        queue = [];
        queued = 0;
        taker = null;
        q.forEach(fn);
        taker = fn;
        return dropped;
      },
      // The microphone goes quiet at once (stop pressed); the context closes with close().
      silence() {
        try { if (processor) { processor.onaudioprocess = null; processor.disconnect(); } } catch (_) {}
        try { if (source) source.disconnect(); } catch (_) {}
        processor = null; source = null; taker = null;
      },
      close() {
        if (closed) return;
        cap.silence();
        closed = true;
        try { if (sink) sink.disconnect(); } catch (_) {}
        try { if (ctx.state !== 'closed') ctx.close(); } catch (_) {}
        sink = null; queue = []; queued = 0;
      },
    };
    return cap;
  }

  // Float32 [-1, 1] → PCM16 little-endian. Обрезка по краям обязательна:
  // микрофон отдаёт значения чуть за единицу, и без неё они переполняют
  // разрядность и превращаются в щелчки.
  function toPcm16(float32) {
    const out = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      let s = float32[i];
      if (s > 1) s = 1; else if (s < -1) s = -1;
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  // Int16Array → base64. Шина сообщений и в расширении, и на странице возит
  // JSON, двоичное по ней не проходит — та же причина, по которой обычная
  // диктовка отправляет файл в base64.
  function toBase64(int16) {
    const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
    let bin = '';
    // Кусками: apply на массиве в сотни тысяч элементов переполняет стек.
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  // options:
  //   transport  { call(type, payload) => Promise<any>, subscribe(fn) => () => void }
  //   onReady    ()               — сервер подключился, звук пошёл
  //   onDelta    (textSoFar, settledLen) — текст на данный момент, целиком, и
  //                                сколько первых его знаков (UTF-16) уже не
  //                                перепишется; остальное — хвост, который
  //                                распознавалка ещё может поправить. Старый
  //                                сервер числа не шлёт — тогда settledLen равен
  //                                длине текста: набело всё
  //   onError    (message, info)  — отказ; info.status — код, если он был
  //   onCaptureStart ()            — звук пошёл; кнопку зажигать здесь
  //   onClosing  ({reason, maxDurationMs}) — сервер заканчивает сессию САМ
  //                                (потолок, сторож, остановка воркера): звук
  //                                уже снят, кнопку гасить здесь; текст итога
  //                                придёт следом в onEnded
  //   onEnded    ({text, reason, maxDurationMs}) — сессии больше нет, а
  //                                «договорил» человек не нажимал: сервер
  //                                закончил сам (`text` — его итог) или связь
  //                                пропала (`reason:'lost'`, текста нет)
  //   logTag     string
  //
  // returns { start(stream, config), stop(), abort(), isRunning(), isReady(), maxDurationMs() }
  //
  // КАК ПОВЕРХНОСТЬ УЗНАЁТ О КОНЦЕ, КОТОРОГО НЕ ПРОСИЛА. Сессию может
  // закончить не человек: потолок длительности (он на сервере), сторож «на
  // связи», остановка воркера платформой, уход поставщика, обрыв связи. Раньше
  // об этом не узнавал никто — фон тихо стирал сессию, кнопка горела минутами,
  // и только нажатие «стоп» приносило «не удалось распознать». Теперь фон
  // (страница) говорит вкладке кадром CLOSING, когда сервер предупредил, и
  // кадром ENDED, когда сессии не стало; а пульс, на который фон отвечает
  // «такой сессии нет», ловит то, о чём фон сказать не успел (например,
  // перезапуск воркера расширения).
  // Сколько знаков догадки встало набело: число сервера в пределах текста;
  // числа нет (старый сервер) — весь текст.
  function settledOf(text, n) {
    const len = String(text || '').length;
    return (Number.isInteger(n) && n >= 0) ? Math.min(n, len) : len;
  }

  function create(options) {
    const opts = options || {};
    const TAG = opts.logTag || '[lex-dictation-live]';
    const transport = opts.transport;
    if (!transport || typeof transport.call !== 'function' || typeof transport.subscribe !== 'function') {
      throw new Error('LexDictationLive.create: transport with call() and subscribe() is required');
    }

    // The audio graph of this session (capture() above): the press's own, or one made here.
    let cap = null;
    let requestId = null;
    let running = false;
    let ready = false;
    let unsub = null;
    let prebuffer = [];
    let prebufferSamples = 0;
    let prebufferDropped = 0;
    // Пульс «на связи» этой сессии — ручка общего таймера LexPulse.
    let presence = null;
    // Потолок ЭТОЙ сессии — число сервера из кадра «готов». Своего числа у
    // поверхности нет: потолок ставит сервер.
    let sessionMaxMs = null;
    // Человек нажал «договорил», и ответ ещё едет: конец, пришедший в это
    // время, — это и есть его ответ, отдельным событием он не нужен.
    let stopping = false;
    // Сервер сказал «закрываю» — звук уже снят, ждём итог.
    let closing = false;
    let ended = false;
    // «Stop» pressed while the line still rose (Gennady 23.11.2026: a short phrase said at the press must not
    // be lost): stop() waits for the start's outcome here — true: «ready» came and the queue went first.
    let startDone = Promise.resolve(false);
    // Sound taken from the microphone in this session, in samples of the recognizer's rate.
    let heardSamples = 0;
    let backstopTimer = null;
    function clearBackstop() { if (backstopTimer) { clearTimeout(backstopTimer); backstopTimer = null; } }

    // Сессии больше нет, и «договорил» человек не нажимал.
    function serverEnded(info) {
      if (stopping || ended) return;
      ended = true;
      clearBackstop();
      running = false;
      ready = false;
      stopListening();
      teardownAudio();
      if (typeof opts.onEnded === 'function') {
        try { opts.onEnded(info); } catch (e) { console.warn(TAG, 'onEnded threw:', e && e.message); }
      }
    }

    function newRequestId() {
      return (global.crypto && global.crypto.randomUUID)
        ? global.crypto.randomUUID()
        : String(Date.now()) + Math.random();
    }

    function sendAudio(b64) {
      // Огонь и забыли: подтверждать каждый кусок звука значит ждать ответа
      // десять раз в секунду. Обрыв заметен по другому — по кадру ошибки и по
      // тому, что stop() вернёт отказ.
      try { transport.call('LEX_DICTATION_LIVE_AUDIO', { requestId, b64 }); } catch (_) { /* noop */ }
    }

    // Пульс «на связи». Отдельный короткий кадр раз в несколько секунд, пока
    // сессия открыта: по нему сервер знает, что человек ещё здесь. Звук
    // пульсом не считается — поток может идти и из брошенной вкладки. Шлёт его
    // именно этот модуль, а не фон и не страница-хозяин: закрылась вкладка с
    // микрофоном — пульс прекращается сам, и сервер закрывает сессию.
    //
    // Сам таймер — общий LexPulse (lex-pulse.js), тот же, что у голосового
    // разговора: первый удар сразу, а не через интервал, следующие — по
    // расписанию, и зависший удар следующих не держит. Своих правил у него нет:
    // частоту и содержимое удара даём мы. Читается в миг старта, а не при
    // загрузке файла: на странице lex-pulse.js грузится позже этого файла.
    function beatMs() {
      const R = global.LexModelRegistry;
      const c = R && R.dictationCapture;
      return (c && c.livePresenceBeatMs) || 3000;
    }
    function stopBeat() {
      if (presence) { presence.stop(); presence = null; }
    }
    function startBeat() {
      stopBeat();
      const id = requestId;
      presence = global.LexPulse.start({
        everyMs: beatMs(),
        beat: () => {
          // Гасит пульс тот, кто заканчивает сессию (stopBeat на каждом
          // выходе); здесь только не шлём лишнего.
          if (!running || requestId !== id) return;
          // Ответ на пульс обычно пуст; «такой сессии нет» значит, что связь
          // уже пропала, а сказать об этом было некому (фон перезапустился,
          // кадр конца потерялся). Это тот же конец, что и ENDED.
          let p = null;
          try { p = transport.call('LEX_DICTATION_LIVE_PING', { requestId: id }); } catch (_) { /* noop */ }
          if (p && typeof p.then === 'function') {
            p.then((r) => {
              // Если сервер успел закончить сам, фон держит его итог и отдаёт его
              // здесь же — выбросить его значило бы потерять правку последних слов.
              if (r && r.gone && requestId === id && running) {
                serverEnded({ text: typeof r.text === 'string' ? r.text : '', reason: r.reason || 'lost', maxDurationMs: sessionMaxMs });
              }
            }, () => {});
          }
        },
      });
    }

    function teardownAudio() {
      stopBeat();
      try { if (cap) cap.close(); } catch (_) {}
      cap = null;
      prebuffer = [];
      prebufferSamples = 0;
    }

    function stopListening() {
      if (unsub) { try { unsub(); } catch (_) {} unsub = null; }
    }

    // Снять со ЗВУКА, не трогая сервер. Микрофон замолкает сразу — человек
    // отпустил кнопку и должен видеть, что его больше не слушают, — а сервер
    // в это время ещё дочитывает последние куски и досчитывает деньги.
    function stopCapture() {
      try { if (cap) cap.silence(); } catch (_) {}
    }

    // config — то, что человек выбрал в полосе «Диктовка», плюс метки для
    // строки расхода. Проверяет и применяет их сервер; здесь они только
    // перекладываются.
    // input — the press's capture (capture() above, the microphone already attached), or a MediaStream
    // (the voice talk's chain): then the graph is made here. From this call the session owns the capture
    // and closes it on every way out.
    async function start(input, config) {
      const given = input && typeof input.attach === 'function' && typeof input.take === 'function' ? input : null;
      if (running) { if (given) { try { given.close(); } catch (_) {} } return false; }
      running = true;
      ready = false;
      stopping = false;
      closing = false;
      ended = false;
      sessionMaxMs = null;
      prebuffer = [];
      prebufferSamples = 0;
      prebufferDropped = 0;
      heardSamples = 0;
      requestId = newRequestId();
      const myId = requestId;
      let settleStart = null;
      startDone = new Promise((r) => { settleStart = r; });
      try {
        return await startInner(input, config, given, myId);
      } finally {
        settleStart(ready && requestId === myId);
      }
    }

    async function startInner(input, config, given, myId) {
      // ── Звук снимается ПЕРВЫМ, до всякой сети ────────────────────────────
      //
      // В этом весь смысл живой диктовки против голосового звонка: соединение
      // встаёт не мгновенно, и всё сказанное в это время должно не потеряться,
      // а подождать в очереди. Замеряли путь через WebRTC — там сказанное в
      // первые полторы-три секунды пропадает совсем, потому что буфера нет.
      // С нажатия звук уже пишется в очередь захвата (capture()); здесь сессия
      // забирает её целиком и дальше каждый кадр.
      // Частота — из каталога распознавалок; пульс — общий таймер. Нет того или
      // другого — отказ до сервера (микрофон к этому мигу уже открыт хозяином,
      // он же его и отпустит по `false`), а не посреди оплачиваемой сессии.
      const rate = sampleRateFor(config && config.model);
      if (!rate || !global.LexPulse || typeof global.LexPulse.start !== 'function') {
        running = false;
        if (given) { try { given.close(); } catch (_) {} }
        const why = !rate
          ? 'no sample rate for ' + ((config && config.model) || 'this recognizer')
          : 'presence pulse (lex-pulse.js) is not loaded';
        console.error(TAG, why);
        if (typeof opts.onError === 'function') opts.onError(why, {});
        return false;
      }
      lastRate = rate;
      const prebufferMax = PREBUFFER_MAX_SEC * rate;
      try {
        cap = given || capture({ rate });
        if (!given) cap.attach(input);
        if (!cap.attached()) throw new Error('the microphone is not attached to the capture');
        // The capture's rate is the press's guess; another recognizer's rate is converted here.
        const convert = Math.abs(cap.rate - rate) > 1 ? resampler(cap.rate, rate) : null;
        if (convert) lexLogSafe(`${TAG} capture at ${cap.rate} Hz, recognizer at ${rate} Hz — converted`);
        const dropped = cap.take((frame) => {
          if (!running || requestId !== myId) return;
          const pcm = toPcm16(convert ? convert(frame) : frame);
          if (!pcm.length) return;
          heardSamples += pcm.length;
          const b64 = toBase64(pcm);
          if (ready) { sendAudio(b64); return; }
          if (prebufferSamples + pcm.length > prebufferMax) { prebufferDropped++; return; }
          prebuffer.push(b64);
          prebufferSamples += pcm.length;
        });
        if (dropped > 0) prebufferDropped += dropped;
        // Звук с этого мига действительно пишется, и поверхность обязана
        // показать это ЗДЕСЬ, а не после ответа сервера: соединение встаёт
        // за секунду-две, и всё это время человек уже говорит в погашенную
        // кнопку. Обещание старта разрешится позже — вид кнопки к нему не
        // привязан.
        if (typeof opts.onCaptureStart === 'function') {
          try { opts.onCaptureStart(); }
          catch (e) { console.warn(TAG, 'onCaptureStart threw:', e && e.message); }
        }
      } catch (err) {
        console.error(TAG, 'audio capture failed:', err);
        running = false;
        if (given && cap !== given) { try { given.close(); } catch (_) {} }
        teardownAudio();
        if (typeof opts.onError === 'function') opts.onError(String((err && err.message) || err), {});
        return false;
      }

      // Слушатель заводится ДО отправки: первые куски текста приходят раньше,
      // чем разрешится обещание старта.
      unsub = transport.subscribe((msg) => {
        if (!msg || msg.requestId !== myId) return;
        if (msg.type === 'LEX_DICTATION_LIVE_DELTA') {
          if (typeof msg.textSoFar === 'string' && typeof opts.onDelta === 'function') {
            opts.onDelta(msg.textSoFar, settledOf(msg.textSoFar, msg.settledLen));
          }
        } else if (msg.type === 'LEX_DICTATION_LIVE_ERROR') {
          if (typeof opts.onError === 'function') opts.onError(msg.message || '', { status: msg.status });
        } else if (msg.type === 'LEX_DICTATION_LIVE_CLOSING') {
          // Сервер заканчивает сам. Звук больше не нужен — снимаем сразу, чтобы
          // кнопка погасла в этот миг, а не через секунды ожидания итога.
          if (stopping || closing || ended) return;
          closing = true;
          running = false;
          stopBeat();
          stopCapture();
          const max = Number(msg.maxDurationMs) > 0 ? Number(msg.maxDurationMs) : sessionMaxMs;
          if (typeof opts.onClosing === 'function') {
            try { opts.onClosing({ reason: msg.reason || '', maxDurationMs: max }); }
            catch (e) { console.warn(TAG, 'onClosing threw:', e && e.message); }
          }
        } else if (msg.type === 'LEX_DICTATION_LIVE_ENDED') {
          const max = Number(msg.maxDurationMs) > 0 ? Number(msg.maxDurationMs) : sessionMaxMs;
          serverEnded({ text: typeof msg.text === 'string' ? msg.text : '', reason: msg.reason || 'lost', maxDurationMs: max });
        }
      });

      let res = null;
      try {
        // A field of the config may still be on its way (the extension mints a new chat's key while the
        // sound is already taken, dictation.js): it is awaited here, right before the start frame.
        const sent = {};
        for (const k of Object.keys(config || {})) {
          const v = config[k];
          sent[k] = v && typeof v.then === 'function' ? await Promise.resolve(v).catch(() => null) : v;
        }
        if (!running || requestId !== myId) return false;
        res = await transport.call('LEX_DICTATION_LIVE_START', { requestId: myId, config: sent });
      } catch (err) {
        res = { ok: false, error: String((err && err.message) || err) };
      }
      // Пока ждали ответа, человек мог уже отпустить кнопку: «бросил» — конец;
      // «договорил» — stop() ждёт здесь, и очередь уходит, как только связь встала.
      if (requestId !== myId || (!running && !stopping)) return false;
      if (!res || !res.ok) {
        running = false;
        stopListening();
        teardownAudio();
        if (typeof opts.onError === 'function') {
          opts.onError((res && (res.error || res.__gate)) || 'start failed', { status: res && res.status, gate: res && res.__gate });
        }
        return false;
      }

      ready = true;
      sessionMaxMs = Number(res.maxDurationMs) > 0 ? Number(res.maxDurationMs) : null;
      if (stopping) {
        // «Договорил» пришёл раньше «готов»: сказанное уходит сейчас, конец — у stop().
        const queued0 = prebuffer;
        prebuffer = [];
        prebufferSamples = 0;
        queued0.forEach(sendAudio);
        lexLogSafe(`${TAG} stop before «ready»: ${queued0.length} queued frame(s) sent, then the stop`);
        return false;
      }
      if (sessionMaxMs) {
        clearBackstop();
        backstopTimer = setTimeout(() => {
          backstopTimer = null;
          if (requestId === myId && !ended && !stopping) {
            console.warn(TAG, 'no end from the server long after its cap — the connection died silently');
            serverEnded({ text: '', reason: 'lost', maxDurationMs: sessionMaxMs });
          }
        }, sessionMaxMs + BACKSTOP_SLACK_MS);
      }
      try { startBeat(); }
      catch (e) {
        // Таймер отказал (например, испорченная частота пульса в реестре): без
        // пульса сервер закроет сессию сам через десять секунд, а платить за них
        // незачем — бросаем сразу.
        console.error(TAG, 'presence pulse refused to start:', e && e.message);
        abort();
        if (typeof opts.onError === 'function') opts.onError('presence pulse failed', {});
        return false;
      }
      if (prebufferDropped > 0) {
        console.warn(TAG, `dropped ${prebufferDropped} prebuffered frame(s) — server took too long to accept audio`);
      }
      const queued = prebuffer;
      prebuffer = [];
      prebufferSamples = 0;
      queued.forEach(sendAudio);
      lexLogSafe(`${TAG} live session started (${queued.length} frame(s) buffered while connecting)`);
      if (typeof opts.onReady === 'function') opts.onReady();
      return true;
    }

    // Договорить: звук перекрываем, сервер досылает последнее провайдеру и
    // возвращает окончательный текст вместе с ценой.
    async function stop() {
      if (!running) return null;
      const myId = requestId;
      running = false;
      stopping = true;
      clearBackstop();
      stopBeat();
      stopCapture();
      if (!ready) {
        // The line still rises. What was said waits in the queue and goes the moment it stands
        // (start above); only then the stop — a short phrase is not thrown away.
        const up = await startDone;
        if (!up || requestId !== myId) {
          stopListening();
          teardownAudio();
          return { ok: false, error: 'no live session' };
        }
      }
      let res = null;
      try {
        res = await transport.call('LEX_DICTATION_LIVE_STOP', { requestId: myId });
      } catch (err) {
        res = { ok: false, error: String((err && err.message) || err) };
      }
      stopListening();
      teardownAudio();
      return res;
    }

    // Бросить: окна больше нет, текст никому не нужен. Сервер всё равно
    // закрывает соединение с провайдером и записывает расход за уже сказанное
    // — платит человек за то, что произнёс, а не за то, что дождался.
    function abort() {
      clearBackstop();
      if (!running) { stopListening(); teardownAudio(); return; }
      const myId = requestId;
      running = false;
      stopBeat();
      stopCapture();
      try { transport.call('LEX_DICTATION_LIVE_ABORT', { requestId: myId }); } catch (_) {}
      stopListening();
      teardownAudio();
    }

    function lexLogSafe(line) {
      try { (global.lexLog || console.log)(line); } catch (_) {}
    }

    return {
      start,
      stop,
      abort,
      isRunning: () => running,
      isReady: () => ready,
      // Sound was taken in this session: «stop» then has something to transcribe, even before «ready».
      heard: () => heardSamples > 0,
      maxDurationMs: () => sessionMaxMs,
    };
  }

  // ── Цепочка живых сессий на один поток звука ─────────────────────────────
  //
  // Для голосового разговора: живая распознавалка слушает рядом с голосовой
  // моделью и пишет в пузырь то, что говорит человек (chat-surface.js,
  // startVoiceLiveAsr). У живой сессии свой потолок — его ставит сервер
  // (server_config.dictation_live_max_sec), а разговор длиннее. Поэтому, как
  // только сервер объявил конец сессии, следующая стартует на том же потоке:
  // звук копится в её очереди, пока она подключается, и не теряется.
  //
  // onText(text, settledLen) получает весь текст цепочки целиком: тексты
  // сессий подряд, через пробел, и сколько первых знаков его встало набело
  // (прошлые сессии набело целиком, у текущей — её число). Внутри сессии — ровно то, что прислала распознавалка
  // (onDelta), а на её конце — её итог; ничего не сглаживается и не
  // задерживается.
  //
  // options: transport, config() → кадр начала (на каждую сессию свой),
  //          onText(text), onError(message, info), logTag
  // returns  { begin(stream), stop() }
  function createChain(options) {
    const opts = options || {};
    const TAG = opts.logTag || '[lex-dictation-live:chain]';
    // Сессия, упавшая сразу после старта, трижды подряд — значит, не встанет и
    // четвёртая: цепочка останавливается, а не молотит сервер по кругу.
    const QUICK_END_MS = 5000;
    const QUICK_END_MAX = 3;
    const texts = [];
    const settled = [];
    let stream = null;
    let cur = null;
    let stopped = false;
    let quickEnds = 0;
    function emit() {
      if (typeof opts.onText !== 'function') return;
      let n = 0;
      const parts = [];
      texts.forEach((t, i) => {
        if (!t) return;
        if (parts.length) n += 1;
        n += (i === texts.length - 1) ? Math.min(settled[i] == null ? t.length : settled[i], t.length) : t.length;
        parts.push(t);
      });
      try { opts.onText(parts.join(' '), n); }
      catch (e) { console.warn(TAG, 'onText threw:', e && e.message); }
    }
    async function next() {
      if (stopped || !stream) return;
      const idx = texts.length;
      texts.push('');
      settled.push(null);
      const startedAt = Date.now();
      const s = create({
        transport: opts.transport,
        logTag: TAG,
        onDelta: (soFar, settledLen) => { texts[idx] = soFar || ''; settled[idx] = settledLen; emit(); },
        // Сервер заканчивает сессию сам (потолок): следующая — сразу, итог
        // этой придёт следом в onEnded.
        onClosing: () => { if (cur === s) { cur = null; restart(startedAt); } },
        onEnded: (info) => {
          const t = ((info && info.text) || '').trim();
          if (t) { texts[idx] = t; settled[idx] = t.length; emit(); }
          if (cur === s) { cur = null; restart(startedAt); }
        },
        onError: (msg, info) => {
          console.warn(TAG, 'live session failed:', msg, info || {});
          if (cur === s) cur = null;
          if (typeof opts.onError === 'function') {
            try { opts.onError(msg, info); } catch (_) {}
          }
        },
      });
      cur = s;
      let config = null;
      try { config = (typeof opts.config === 'function') ? await opts.config() : (opts.config || null); }
      catch (e) { console.warn(TAG, 'config failed:', e && e.message); }
      if (stopped || cur !== s) return;
      const ok = await s.start(stream, config || {});
      if (!ok && cur === s) cur = null;
    }
    function restart(startedAt) {
      quickEnds = (Date.now() - startedAt < QUICK_END_MS) ? quickEnds + 1 : 0;
      if (quickEnds >= QUICK_END_MAX) {
        console.warn(TAG, `${QUICK_END_MAX} sessions in a row ended right after start — giving up`);
        return;
      }
      next();
    }
    return {
      // Поток пришёл (или сменился — взяли дорожку заново): сессия заводится
      // на нём; прежняя, если была, бросается.
      begin(nextStream) {
        if (stopped || !nextStream || nextStream === stream) return;
        stream = nextStream;
        if (cur) { const old = cur; cur = null; old.abort(); }
        next();
      },
      // Разговор кончился: итог никому не нужен, расход за сказанное досчитает
      // сервер.
      stop() {
        stopped = true;
        const old = cur;
        cur = null;
        if (old) old.abort();
      },
    };
  }

  // sampleRateFor наружу — частота той распознавалки, которую выбрали, из
  // каталога (строка базы); своей копии числа у поверхности нет.
  global.LexDictationLive = { create, createChain, capture, resampler, sampleRateFor, settledOf };
})(typeof self !== 'undefined' ? self : globalThis);
