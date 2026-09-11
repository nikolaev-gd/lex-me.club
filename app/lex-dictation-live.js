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
  // должна. Десять секунд с запасом покрывают самое медленное подключение из
  // замеренных; считается от частоты той распознавалки, которую выбрали.
  function prebufferMaxFrames(rate) {
    return Math.ceil((10 * rate) / FRAME_SAMPLES);
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
  //   onDelta    (textSoFar)      — текст на данный момент, целиком
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
  function create(options) {
    const opts = options || {};
    const TAG = opts.logTag || '[lex-dictation-live]';
    const transport = opts.transport;
    if (!transport || typeof transport.call !== 'function' || typeof transport.subscribe !== 'function') {
      throw new Error('LexDictationLive.create: transport with call() and subscribe() is required');
    }

    let ctx = null;
    let source = null;
    let processor = null;
    let sink = null;
    let requestId = null;
    let running = false;
    let ready = false;
    let unsub = null;
    let prebuffer = [];
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
      try { if (processor) { processor.onaudioprocess = null; processor.disconnect(); } } catch (_) {}
      try { if (source) source.disconnect(); } catch (_) {}
      try { if (sink) sink.disconnect(); } catch (_) {}
      try { if (ctx && ctx.state !== 'closed') ctx.close(); } catch (_) {}
      processor = null; source = null; sink = null; ctx = null;
      prebuffer = [];
    }

    function stopListening() {
      if (unsub) { try { unsub(); } catch (_) {} unsub = null; }
    }

    // Снять со ЗВУКА, не трогая сервер. Микрофон замолкает сразу — человек
    // отпустил кнопку и должен видеть, что его больше не слушают, — а сервер
    // в это время ещё дочитывает последние куски и досчитывает деньги.
    function stopCapture() {
      try { if (processor) { processor.onaudioprocess = null; processor.disconnect(); } } catch (_) {}
      try { if (source) source.disconnect(); } catch (_) {}
      processor = null; source = null;
    }

    // config — то, что человек выбрал в полосе «Диктовка», плюс метки для
    // строки расхода. Проверяет и применяет их сервер; здесь они только
    // перекладываются.
    async function start(stream, config) {
      if (running) return false;
      running = true;
      ready = false;
      stopping = false;
      closing = false;
      ended = false;
      sessionMaxMs = null;
      prebuffer = [];
      prebufferDropped = 0;
      requestId = newRequestId();
      const myId = requestId;

      // ── Звук снимается ПЕРВЫМ, до всякой сети ────────────────────────────
      //
      // В этом весь смысл живой диктовки против голосового звонка: соединение
      // встаёт не мгновенно, и всё сказанное в это время должно не потеряться,
      // а подождать в очереди. Замеряли путь через WebRTC — там сказанное в
      // первые полторы-три секунды пропадает совсем, потому что буфера нет.
      // Частота — из каталога распознавалок; пульс — общий таймер. Нет того или
      // другого — отказ до съёма звука и до сервера (микрофон к этому мигу уже
      // открыт хозяином, он же его и отпустит по `false`), а не посреди
      // оплачиваемой сессии.
      const rate = sampleRateFor(config && config.model);
      if (!rate || !global.LexPulse || typeof global.LexPulse.start !== 'function') {
        running = false;
        const why = !rate
          ? 'no sample rate for ' + ((config && config.model) || 'this recognizer')
          : 'presence pulse (lex-pulse.js) is not loaded';
        console.error(TAG, why);
        if (typeof opts.onError === 'function') opts.onError(why, {});
        return false;
      }
      const prebufferMax = prebufferMaxFrames(rate);
      try {
        ctx = new (global.AudioContext || global.webkitAudioContext)({ sampleRate: rate });
        // Аппаратура может не дать запрошенную частоту. Тогда пересчитывать
        // пришлось бы нам, а этого мы не умеем — честнее отказаться сразу.
        if (Math.abs(ctx.sampleRate - rate) > 1) {
          throw new Error('audio context refused ' + rate + ' Hz (got ' + ctx.sampleRate + ')');
        }
        source = ctx.createMediaStreamSource(stream);
        // ScriptProcessorNode, а не AudioWorklet, и это осознанно. Worklet
        // грузится ОТДЕЛЬНЫМ файлом по адресу, и в content-script на чужой
        // странице этот адрес проверяет CSP САМОЙ СТРАНИЦЫ — то есть на строгом
        // сайте микрофон молча не завёлся бы. Узел ниже помечен устаревшим, но
        // работает и в Chrome, и в WKWebView (оболочка macOS), и ничего не
        // грузит. Менять — только когда у worklet появится путь без внешнего
        // файла.
        processor = ctx.createScriptProcessor(FRAME_SAMPLES, 1, 1);
        processor.onaudioprocess = (e) => {
          if (!running || requestId !== myId) return;
          const b64 = toBase64(toPcm16(e.inputBuffer.getChannelData(0)));
          if (ready) { sendAudio(b64); return; }
          if (prebuffer.length >= prebufferMax) { prebufferDropped++; return; }
          prebuffer.push(b64);
        };
        source.connect(processor);
        // Узел обязан быть подключён к выходу, иначе Chrome его не вызывает.
        // В его выходной буфер мы не пишем ничего, да ещё и глушим по дороге:
        // свой голос человек слышать не должен.
        sink = ctx.createGain();
        sink.gain.value = 0;
        processor.connect(sink);
        sink.connect(ctx.destination);
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
        teardownAudio();
        if (typeof opts.onError === 'function') opts.onError(String((err && err.message) || err), {});
        return false;
      }

      // Слушатель заводится ДО отправки: первые куски текста приходят раньше,
      // чем разрешится обещание старта.
      unsub = transport.subscribe((msg) => {
        if (!msg || msg.requestId !== myId) return;
        if (msg.type === 'LEX_DICTATION_LIVE_DELTA') {
          if (typeof msg.textSoFar === 'string' && typeof opts.onDelta === 'function') opts.onDelta(msg.textSoFar);
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
        res = await transport.call('LEX_DICTATION_LIVE_START', { requestId: myId, config: config || {} });
      } catch (err) {
        res = { ok: false, error: String((err && err.message) || err) };
      }
      // Пока ждали ответа, человек мог уже отпустить кнопку.
      if (!running || requestId !== myId) return false;
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
      maxDurationMs: () => sessionMaxMs,
    };
  }

  // sampleRateFor наружу — частота той распознавалки, которую выбрали, из
  // каталога (строка базы); своей копии числа у поверхности нет.
  global.LexDictationLive = { create, sampleRateFor };
})(typeof self !== 'undefined' ? self : globalThis);
