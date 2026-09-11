// webchat/wc-composer.js — the input box: text, the plus, the mode chip, the
// microphone, and the one round button that is either "talk" or "send".
//
// ── Why the round button is ONE control ─────────────────────────────────────
// Live conversation and send occupy the same slot and cross-fade into each
// other. The extension hides one and shows the other outright, which is right
// for a cursor and wrong for a thumb: the control under the finger would change
// identity between two frames, with no motion to say it happened. Here both
// live in the slot the whole time and only their opacity and transform move,
// so the change is something you can watch.
//
// ── Why the microphone is not the voice button ──────────────────────────────
// It used to open a live conversation, which left the product with two ways
// into the same thing and no way at all to the obvious one: saying a message
// instead of typing it. The microphone now DICTATES — it records, sends the
// audio to the same server route the extension uses (`openai-asr` through
// llm-proxy) and drops the text into the field, where it can still be edited
// before it goes anywhere. Nothing is sent by speaking.
(function (global) {
  'use strict';

  const { menu, toast } = WcUI;

  let elForm, elInput, elSend, elVoice, elMic, elPlus, elModeSplit, elNote;
  let hooks = {};
  let streaming = false;
  let currentRequestId = null;
  let voiceActive = false;

  // ── ЗАГОТОВКИ ДЕЙСТВИЙ ────────────────────────────────────────────────────
  //
  // Кнопка в композере ОДНА, а заготовок у неё много: каждая — слот ячейки
  // промптов, со своим именем, своим текстом и своей моделью. Список общий с
  // расширением по коду (lex-action-presets.js), хранилище и каталог модулю
  // даёт wc-backend.js. Заготовки стоят пилюлями в ряд, тап по любой сразу
  // отправляет ЕЁ — без выбора «активной» и без меню (2026-09-01, решение
  // владельца; раньше здесь была одна пилюля с ▾-меню и стрелкой отправки,
  // тот же дизайн, что в chat-surface.js до этой же правки).
  //
  // ⚠️ СРЕЗА В ТРИ ЗАГОТОВКИ БОЛЬШЕ НЕТ (2026-09-02): ряд показывает всё, что
  // отдал сервер, лишнее доскролливается вбок (.wc-mode-split, overflow-x).
  //
  // ⚠️ Список приходит АСИНХРОННО, а ряд есть с первого кадра. Поэтому он
  // пересобирается на КАЖДОЕ изменение списка — иначе переименование или
  // новая заготовка в открытых настройках не долетит до уже открытой
  // страницы.
  const PRESETS = () => global.LexActionPresets || null;
  let presetScope = null;        // 'shorts-main' — из описания ячейки, не литералом
  let presetPillEls = [];        // текущие кнопки ряда — syncButton() гасит/включает все разом

  // Подпись «Native» — запасная: её отдаёт labelOf(), пока имя первой заготовки
  // в каталоге не тронуто человеком. У расширения на её месте строка перевода,
  // здесь переводчика нет — и по решению эта страница показывает английский.
  const NATIVE_FALLBACK_LABEL = 'Native';

  // Пусто — значит ряда нет ВОВСЕ. Запасной одиночки Native тут больше нет
  // намеренно (шапка lex-action-presets.js): пилюля без подтверждённого
  // сервером промпта уводит ход к модели без инструкции.
  function presetList() {
    const P = PRESETS();
    return (P && presetScope) ? P.current(presetScope) : [];
  }

  const presetLabel = (p) => {
    const P = PRESETS();
    return P ? P.labelOf(p, NATIVE_FALLBACK_LABEL) : ((p && p.name) || NATIVE_FALLBACK_LABEL);
  };

  // Отправка КОНКРЕТНОЙ заготовкой p — той, чью пилюлю нажали. Кнопка
  // выключена (disabled), пока отправлять нечего или уже идёт стрим —
  // syncButton() держит это в актуальном состоянии, отдельной проверки
  // здесь по той же причине, что и раньше, нет.
  function sendWithPreset(p) {
    const slotId = p && p.id;
    // ОТКАЗ ВМЕСТО ОТВЕТА БЕЗ ИНСТРУКЦИИ. Весь смысл заготовки в её
    // промпте: ход без него — не «чуть хуже», а совсем не то, что просили.
    // Проверка локальная и до отправки (LexActionPresets.resolves): слот
    // обязан быть в списке, а если каталог отвечал — ещё и с непустым
    // текстом. Каталог не отвечал (не редактор, офлайн) — не запрещаем:
    // чужих строк мы не видим, и запрет по незнанию был бы хуже.
    const P = PRESETS();
    if (P && presetScope && !P.resolves(presetScope, slotId)) {
      toast('«' + presetLabel(p) + '» has no prompt yet', { error: true });
      return;
    }
    // ⚠️ ЗДЕСЬ ПИСАЛСЯ activeNativePromptId_<scope>. Ключа больше нет
    // (2026-09-02): «активной» заготовки не бывает, слот едет с ходом.
    // Модель — тоже готовым значением из строки списка, а не по имени ключа,
    // которое страница собирала у себя: та копия правила уже расходилась
    // однажды (врезка в wc-backend.js).
    submit({ mode: 'native', slotId, modelId: (p && p.modelId) || '' });
  }

  // Рисует ряд заново с нуля — проще и надёжнее патча трёх кнопок по месту,
  // а вызывается редко (сборка + смена списка, не на каждый кадр).
  function renderPresetPills() {
    if (!elModeSplit) return;
    const items = presetList();
    elModeSplit.innerHTML = '';
    presetPillEls = items.map((p) => {
      const lbl = presetLabel(p);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'wc-mode-pill';
      if (p.id) btn.dataset.presetId = p.id;
      btn.title = 'Send as ' + lbl;
      btn.setAttribute('aria-label', btn.title);
      btn.textContent = lbl;
      btn.addEventListener('click', () => sendWithPreset(p));
      elModeSplit.appendChild(btn);
      return btn;
    });
    syncButton();   // выставить disabled по текущему полю сразу, не только на input
  }

  // Сборка органа. БЕЗ СЕТИ и без ожидания: ряд обязан быть живым с первого
  // кадра, а список доедет и перерисуется сам.
  function initPresets() {
    const P = PRESETS();
    const cells = global.LexSettingsCells;
    if (!P || !cells) return;                       // старая сборка — одна кнопка, как раньше
    const cell = cells.cellFor('nativePrompts');
    if (!cell) return;
    presetScope = (cell.ref && cell.ref.scope) || null;
    if (!presetScope) return;
    renderPresetPills();
    P.onChange((scope) => { if (scope === presetScope) renderPresetPills(); });
  }

  // ── Список заготовок тянется ПОСЛЕ ВХОДА, а не при сборке композера ──────
  //
  // Каталог промптов отвечает только по токену: до входа он даёт 401. А заход
  // в каталог у модуля ОДИН ЗА ЖИЗНЬ ОКНА (`fetched`) — сходи мы туда на
  // сборке, ответ был бы 401, список навсегда остался бы одиночкой, и после
  // входа заготовки не появились бы до перезагрузки страницы. Ровно это и
  // наблюдалось. Поэтому зовёт эту функцию enterApp() — единственная точка,
  // через которую страница попадает в приложение, и оба пути (вход руками и
  // возврат с уже живой сессией) проходят через неё.
  async function loadPresets() {
    const P = PRESETS();
    if (!P || !presetScope) return;
    // Один заход, публичным действием: список приходит любому вошедшему, и в
    // нём уже сделаны отбор и порядок. Внутри refresh два шага — сперва
    // поднимается СОХРАНЁННЫЙ список (ряд обязан быть на месте сразу, даже если
    // сервер молчит), потом приходит свежий и заменяет его. Ряд перерисовывает
    // подписка onChange, поэтому ждать здесь нечего.
    try { await P.refresh(presetScope); } catch (_) { /* остаёмся на сохранённом */ }
    renderPresetPills();
  }

  // Live conversation or push-to-talk. Remembered across sessions: it is a
  // preference about how a person talks, not a state of this page.
  const VOICE_MODE_KEY = 'wcVoiceMode';
  let voiceMode = 'live';

  // ── Recording (dictation) ────────────────────────────────────────────────
  let recorder = null;
  // Живая диктовка. Рядом с recorder, а не вместо: распознавалок две породы, и
  // выбор между ними — ручка настроек, которую человек меняет на ходу.
  let live = null;
  let recStartedAt = 0;
  // Потолок обычной записи — ручка общего таймера (lex-dictation-limit.js).
  let recLimit = null;
  // Пороги, потолок записи и его подпись — одно правило на все браузерные
  // поверхности (lex-dictation-limit.js): числа из реестра моделей и
  // единственный запасной набор живут там. Раньше здесь стояли свои: 350 мс
  // «слишком коротко» против 300 в расширении и отсутствие потолка против
  // минуты у него, и один микрофон вёл себя по-разному в зависимости от того,
  // где его нажали.
  const Limit = global.LexDictationLimit;
  const capture = () => Limit.capture();
  const clearRecLimit = () => { if (recLimit) { recLimit.cancel(); recLimit = null; } };

  function autoGrow() {
    elInput.style.height = 'auto';
    const h = elInput.scrollHeight;
    // A field that is not laid out yet reports 0, and init() runs while the
    // whole app is still hidden behind the boot skeleton. Writing that 0 back
    // pinned the textarea at its padding height — 16px — until the first
    // keystroke, which is why the placeholder sat in the composer with its
    // descenders sliced off. Leaving the height unset lets the stylesheet give
    // it its natural single-row height instead.
    if (!h) { elInput.style.height = ''; return; }
    elInput.style.height = Math.min(h, 220) + 'px';
  }

  function canSend() {
    return elInput.value.trim().length > 0
      || (global.WcAttach && WcAttach.count() > 0)
      // Слова, выбранные нажатием в ленте, — это уже вопрос: они называют
      // предмет, а дописывать к ним что-то человек не обязан.
      || (global.WcWordPick && WcWordPick.count() > 0);
  }

  // Which of the two round buttons is showing. Driven by data-off rather than
  // by `hidden`, because a display swap cancels the transition — and the
  // transition is the point.
  function syncButton() {
    const sending = streaming || canSend();
    elSend.dataset.off = sending ? '0' : '1';
    elVoice.dataset.off = sending ? '1' : '0';
    // Спрятанный перетеканием орган остаётся в раскладке (иначе нечего
    // анимировать), а значит остаётся достижимым с клавиатуры и для
    // скринридера. `disabled` — то, что убирает его оттуда, не трогая
    // анимацию: pointer-events закрывает только палец и мышь.
    elSend.disabled = !sending;
    elVoice.disabled = sending;

    elSend.classList.toggle('is-stop', streaming);
    elSend.title = streaming ? 'Stop' : 'Send';
    elSend.setAttribute('aria-label', elSend.title);
    const path = elSend.querySelector('path');
    if (path) {
      path.setAttribute('d', streaming
        ? 'M7 7h10v10H7z'                 // a square: stop
        : 'M12 19V5M5 12l7-7 7 7');       // an arrow: send
    }

    // The pills send, so they are dead while there is nothing to send and
    // while a turn is already streaming.
    const pillsOff = streaming || !canSend();
    presetPillEls.forEach((btn) => { btn.disabled = pillsOff; });

    elVoice.classList.toggle('is-active', voiceActive);
    elVoice.title = voiceActive
      ? 'Back to the conversation'
      : (voiceMode === 'ptt' ? 'Hold to talk' : 'Live conversation');
    elVoice.setAttribute('aria-label', elVoice.title);
  }

  async function submit(opts) {
    if (streaming) {
      if (currentRequestId) hooks.onStop(currentRequestId);
      return;
    }
    if (!canSend()) return;
    const text = elInput.value.trim();
    elInput.value = '';
    autoGrow();
    syncButton();
    WcHaptics.tap();
    await hooks.onSend(text, opts || {});
  }

  // ── Long press ───────────────────────────────────────────────────────────
  // Сам жест — в общем с расширением модуле (lex-long-press.js): длительность
  // удержания и допуск на съезд пальца человек чувствует как одно свойство
  // продукта, и держать их в двух копиях нельзя. Здесь остаётся только отклик
  // под пальцем — его в расширении нет, там нет родной оболочки.
  function onLongPress(el, fire, opts) {
    return LexLongPress.attach(el, (e) => { WcHaptics.press(); fire(e); }, opts);
  }

  // ── Dictation ────────────────────────────────────────────────────────────
  // ── Живая диктовка ───────────────────────────────────────────────────────
  //
  // Та же кнопка, та же строка состояния, то же поле ввода; потолок у живой
  // ставит сервер и сам заканчивает сессию (endedByServer ниже). Отличие ровно одно: звук уходит во время речи, и текст растёт по
  // ходу. Всё, что решает (модель, поля запроса, цена, строка расхода), живёт
  // на сервере — здесь только микрофон и поле.
  async function startLive(stream, dict) {
    const grower = makeGrower();
    let finished = false;
    // Сессию закончил сервер, а не человек: потолок (он на сервере), сторож «на
    // связи», остановка воркера функции, уход поставщика, обрыв связи. Кнопка
    // гаснет, плашка говорит почему, выросший текст остаётся, итог сервера
    // встаёт на его место. То же, что в dictation.js, — одно поведение.
    let closedByServer = false;
    const micOff = () => {
      elMic.classList.remove('is-recording');
      elMic.title = 'Dictate';
      elMic.setAttribute('aria-label', elMic.title);
    };
    function endedByServer(info) {
      if (finished) return false;
      finished = true;
      closedByServer = true;
      stream.getTracks().forEach((t) => t.stop());
      // Кнопку и плашку трогает только текущая сессия — сирота молчит.
      if (live !== me) return true;
      live = null;
      micOff();
      syncButton();
      if (info && info.reason === 'cap') {
        const ms = Number(info.maxDurationMs);
        toast(ms > 0 ? 'Recording stopped: the limit is ' + Limit.label(ms) + '.' : 'Recording stopped: the limit was reached.');
      } else {
        toast('Dictation stopped: the connection to the recognizer was lost.', { error: true });
      }
      return true;
    }
    // Итог конца, объявленного сервером, — строже, чем на «стоп»: человек мог
    // уже отправить или переписать выросшее — дописывать нельзя, только на
    // место выросшего; итог старого сервера (без потолка в «готов») не ставим
    // вовсе — он без последнего отрезка. То же правило, что в dictation.js.
    function placeServerFinal(text, info) {
      grower.serverFinal(text, !!(info && Number(info.maxDurationMs) > 0));
    }
    // Итог встаёт на место выросшего куска; в конец — только если куска нет.
    function placeFinal(text) { grower.finish(text); }
    // Своего номера сессии здесь не чеканим: его чеканит сам модуль живой
    // диктовки и им же метит все свои сообщения. Здешний был мёртвым — уезжал
    // внутри набора настроек, где его никто не читал, и при разборе журнала
    // подсовывал не тот номер.
    live = global.LexDictationLive.create({
      transport: {
        call: (type, payload) => WcBus.call(type, payload).catch(() => null),
        subscribe: (fn) => WcBus.subscribe(fn),
      },
      // Кнопка краснеет в тот же миг, с которого пишется звук, а не когда
      // встала связь: между ними секунда-две, и всё это время человек говорит
      // в погашенную кнопку.
      onCaptureStart: () => {
        recStartedAt = Date.now();
        elMic.classList.add('is-recording');
        elMic.title = 'Stop dictating';
        elMic.setAttribute('aria-label', elMic.title);
        WcHaptics.tap();
        // Потолка живой записи здесь нет: его ставит сервер и сам говорит
        // «закрываю» (onClosing ниже).
      },
      onDelta: (textSoFar) => { if (textSoFar) grower.push(textSoFar); },
      onClosing: (info) => { endedByServer(info); },
      onEnded: (info) => {
        if (!endedByServer(info) && !closedByServer) return;
        const text = ((info && info.text) || '').trim();
        // Пустой итог поле не трогает: выросший текст остаётся как есть.
        if (text) placeServerFinal(text, info);
        grower.forget();
      },
      onError: (msg, info) => {
        if (finished) return;
        if (info && info.status === 402) { toast('Not enough balance for dictation.', { error: true }); return; }
        toast('Could not transcribe: ' + msg, { error: true });
      },
    });
    // Эта сессия — своя переменная, а не общая `live`: после «стоп» общая
    // освобождается сразу, и новое нажатие начинает новую сессию, пока эта
    // ещё договаривает с сервером.
    const me = live;
    // Завершение описано ДО старта: кнопка горит с первого кадра звука, значит
    // второе нажатие может прийти, пока связь ещё встаёт.
    live.__finish = async (wantText) => {
      if (finished) return;
      finished = true;
      clearRecLimit();
      // Кнопка гаснет в миг нажатия и больше не меняется: всё, что осталось
      // серверу, он доделывает молча. Никакого «занята».
      if (live === me) live = null;
      elMic.classList.remove('is-recording');
      elMic.title = 'Dictate';
      elMic.setAttribute('aria-label', elMic.title);
      // Связь ещё не встала — расшифровывать нечего и ошибки не было: человек
      // передумал. Бросаем молча; расход за уже переданное досчитает сервер.
      const want = wantText && !!(me && me.isReady && me.isReady());
      // stop() глушит звук сразу, до всякой сети; микрофон отдаём тут же, а не
      // после ответа, — иначе точка записи горела бы над погасшей кнопкой.
      const pending = want ? me.stop() : (me.abort(), null);
      stream.getTracks().forEach((t) => t.stop());
      const res = pending ? await pending : null;
      syncButton();
      if (!want) { grower.forget(); return; }
      if (!res || !res.ok) { grower.forget(); toast('Could not transcribe', { error: true }); return; }
      const text = (res.text || '').trim();
      if (!text) { grower.forget(); toast('Nothing was recognised'); return; }
      placeFinal(text);
    };
    // Ручки уезжают КАК ЕСТЬ: что из них примет распознавалка, решает сервер
    // (_shared/dictation-fields.ts), один на все поверхности. Раньше здесь
    // звался реестр с именами ручек, которых он не понимал, и на сервер
    // уходили одни умолчания — языки, точные слова, описание, режим терялись.
    // Имя модели уже проверено каталогом на нажатии (startRecording).
    const apiModel = dict && dict.model;
    const started = await live.start(stream, {
      model: apiModel,
      knobs: (dict && dict.knobs) || {},
      surface: 'standalone',
      pageType: 'text',
    });
    if (!started) {
      if (!finished) {
        if (live === me) live = null;
        stream.getTracks().forEach((t) => t.stop());
        elMic.classList.remove('is-recording');
        elMic.title = 'Dictate';
        elMic.setAttribute('aria-label', elMic.title);
        syncButton();
      }
    }
  }

  async function startRecording() {
    // Какая распознавалка выбрана и каким путём снимать звук, спрашивается
    // ПАРАЛЛЕЛЬНО с микрофоном, а не после него: каталог распознавалок (строки
    // базы, lex-dictation-catalog.js) обычно уже в памяти, а если нет — его
    // чтение идёт, пока браузер открывает микрофон, и нажатие не ждёт лишнего.
    const choiceP = (async () => {
      let dict = { model: null, knobs: {} };
      try { dict = await global.WcBackend.readDictationKnobs(); } catch (_) { /* умолчания сервера рабочие */ }
      const route = await global.LexDictationCatalog.route(dict.model, global.LexModelRegistry.defaultDictationModel);
      return { dict, route };
    })();
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      toast('No microphone: ' + ((err && err.message) || err), { error: true });
      return;
    }
    // Какая распознавалка выбрана — решает та же ручка, что и в расширении.
    // Живая не пишет файл вовсе, поэтому MediaRecorder ниже ей не нужен.
    const choice = await choiceP;
    const route = choice.route;
    if (!route.ok) {
      // Без каталога путь угадывать нельзя: живую распознавалку файлом не
      // расшифровать, а файловую — сокетом.
      stream.getTracks().forEach((t) => t.stop());
      toast(route.gate === 'login' ? 'Sign in to dictate.' : 'Could not load the list of recognizers. Please try again.', { error: true });
      return;
    }
    const dict = { model: route.model, knobs: (choice.dict && choice.dict.knobs) || {} };
    if (route.live) {
      // Файловый путь живой распознавалке не подходит вовсе: обычная ручка
      // расшифровки отвечает ей «Invalid URL». Поэтому не откатываемся к
      // записи файла молча, а говорим человеку. Случай не выдуманный: вкладка,
      // открытая ещё до выкладки, живого модуля не содержит — и молчаливый
      // откат отправлял бы заведомо мёртвый запрос на каждое нажатие.
      if (!global.LexDictationLive) {
        stream.getTracks().forEach((t) => t.stop());
        toast('Live dictation is not loaded here — reload the page', { error: true });
        return;
      }
      await startLive(stream, dict);
      return;
    }
    let rec;
    try {
      // Распознавалка, которая сжатых файлов не читает (у файловой строки
      // каталога есть частота), получает WAV — общим куском с расширением
      // (lex-dictation-wav.js). Остальные — то, что пишет платформа: webm в
      // Chrome, mp4 в WebKit.
      rec = route.wavRate ? global.LexDictationWav.create(stream, route.wavRate) : new MediaRecorder(stream);
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      toast('This browser cannot record audio', { error: true });
      return;
    }
    recorder = rec;
    // Куски и начало — свои у каждой записи: пока одна отправляется на
    // расшифровку, следующая уже может писаться, и общий массив они бы делили.
    const myChunks = [];
    const myStartedAt = Date.now();
    recStartedAt = myStartedAt;
    rec.ondataavailable = (e) => { if (e.data && e.data.size) myChunks.push(e.data); };
    rec.onstop = async () => {
      // The tracks are released before the network call, not after: a
      // microphone that stays open shows a recording dot for as long as the
      // transcription takes, which reads as "still listening".
      stream.getTracks().forEach((t) => t.stop());
      const durationMs = Date.now() - myStartedAt;
      const blob = new Blob(myChunks, { type: rec.mimeType || 'audio/webm' });
      const cap = capture();
      if (blob.size < cap.minBlobBytes || durationMs < cap.minDurationMs) { syncButton(); return; }
      await transcribe(blob, durationMs);
    };
    rec.start();
    elMic.classList.add('is-recording');
    elMic.title = 'Stop dictating';
    elMic.setAttribute('aria-label', elMic.title);
    WcHaptics.tap();
    // Потолок записи — общее правило (lex-dictation-limit.js): микрофон, забытый
    // включённым, платит за каждую минуту тишины, поэтому запись кончается
    // сама так же, как по кнопке, и человеку говорится почему.
    clearRecLimit();
    recLimit = Limit.arm({
      isStillMine: () => recorder === rec && rec.state !== 'inactive',
      onFire: (maxMs) => {
        stopRecording();
        toast('Recording stopped: the limit is ' + Limit.label(maxMs) + '.');
      },
    });
  }

  function stopRecording() {
    clearRecLimit();
    // Живая сессия заканчивается по-своему: файла нет, и «остановить запись»
    // значит «дать серверу договорить с провайдером и вернуть итог».
    if (live && live.__finish) { live.__finish(true); return; }
    // Кнопка гаснет в миг нажатия, а запись отпускается сразу: следующее
    // нажатие начинает новую, пока эта ещё уходит на расшифровку.
    const r = recorder;
    recorder = null;
    elMic.classList.remove('is-recording');
    if (r && r.state !== 'inactive') r.stop();
    elMic.title = 'Dictate';
    elMic.setAttribute('aria-label', elMic.title);
  }

  // Растущий кусок держится ЗА СВОИМ ОТРЕЗКОМ, а не «дописывается в конец»:
  // человек может печатать, пока идёт расшифровка. Правило — общее с
  // расширением и айфоном, lex-dictation-grow.js: учёт на ПОЛЕ (одно поле ввода
  // на страницу), каждая запись — его участник; итог прошлой записи, пришедший,
  // пока растёт новая, рост новой не останавливает. Здесь — только мост к полю.
  const growField = global.LexDictationGrow.field();
  function makeGrower() {
    const id = growField.begin();
    const put = (v, focus) => {
      elInput.value = v;
      autoGrow();
      syncButton();
      if (focus) elInput.focus();
      // Каретка в конец, иначе следующая буква встанет посреди фразы.
      try { elInput.setSelectionRange(elInput.value.length, elInput.value.length); } catch (_) {}
    };
    return {
      push(sofar) {
        const v = growField.push(id, sofar, elInput.value || '');
        if (v !== null) put(v, false);
      },
      // Итог «стоп»: на место выросшего куска, куска нет — в конец.
      finish(text) { put(growField.finish(id, text, elInput.value || ''), true); },
      // Итог конца, объявленного сервером: только на место выросшего; старый
      // сервер без потолка в «готов» — не ставим (см. модуль).
      serverFinal(text, hasCap) {
        const v = growField.serverFinal(id, text, elInput.value || '', { hasCap: !!hasCap });
        if (v !== null) put(v, true);
      },
      forget() { growField.forget(id); },
    };
  }

  async function transcribe(blob, durationMs) {
    // Кнопку не трогает: запись кончилась на «стоп», и доезжающий текст —
    // забота сервера и поля, а не кнопки.
    const requestId = (global.crypto && global.crypto.randomUUID)
      ? global.crypto.randomUUID() : String(Date.now()) + Math.random();
    const grower = makeGrower();
    // Подписка заводится ДО отправки и снимается в любом исходе: иначе она
    // пережила бы свой запрос и дописывала бы в поле чужие куски.
    const unsub = WcBus.subscribe((msg) => {
      if (!msg || msg.type !== 'WC_DICTATE_DELTA' || msg.requestId !== requestId) return;
      if (typeof msg.textSoFar === 'string' && msg.textSoFar) grower.push(msg.textSoFar);
    });
    try {
      const base64 = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onloadend = () => { const s = String(r.result || ''); resolve(s.slice(s.indexOf(',') + 1)); };
        r.onerror = () => reject(new Error('read failed'));
        r.readAsDataURL(blob);
      });
      const r = await WcBus.call('WC_DICTATE', { base64, mimeType: blob.type, durationMs, requestId });
      const text = (r && r.text || '').trim();
      if (!text) { toast('Nothing was recognised'); return; }
      // Не затирает набранное: рос текст — итог встаёт на его место; не рос —
      // дописывается к набранному через пробел.
      grower.finish(text);
    } catch (err) {
      toast('Could not transcribe: ' + ((err && err.message) || err), { error: true });
    } finally {
      unsub();
      // Итога не было (отказ, пустота) — выросшее остаётся как есть.
      grower.forget();
    }
  }

  // ── Voice mode ───────────────────────────────────────────────────────────
  function voiceModeMenu(anchor) {
    // The chosen one wears a tick instead of its own glyph — the menu has two
    // items and no room for a separate state column.
    menu(anchor, [
      {
        label: 'Live conversation',
        icon: voiceMode === 'live' ? 'check' : 'wave',
        onSelect: () => setVoiceMode('live'),
      },
      {
        label: 'Push to talk',
        icon: voiceMode === 'ptt' ? 'check' : 'mic',
        onSelect: () => setVoiceMode('ptt'),
      },
    ]);
  }

  function setVoiceMode(next) {
    voiceMode = next === 'ptt' ? 'ptt' : 'live';
    WcStore.set({ [VOICE_MODE_KEY]: voiceMode });
    syncButton();
    toast(voiceMode === 'ptt' ? 'Push to talk' : 'Live conversation');
  }

  const WcComposer = {
    async init(h) {
      hooks = h;
      elForm = document.getElementById('wc-composer');
      elInput = document.getElementById('wc-input');
      elSend = document.getElementById('wc-send');
      // 'wc-talk', а НЕ 'wc-voice': под вторым именем живёт оверлей голосового
      // экрана, и пока оба назывались одинаково, getElementById отдавал обоим
      // читателям первый в документе — то есть эту кнопку. Экран разговора
      // рисовался ВНУТРЬ неё.
      elVoice = document.getElementById('wc-talk');
      elMic = document.getElementById('wc-mic');
      elPlus = document.getElementById('wc-plus');
      elModeSplit = document.getElementById('wc-mode-split');
      elNote = document.getElementById('wc-composer-note');

      try {
        const stored = await WcStore.one(VOICE_MODE_KEY, 'live');
        voiceMode = stored === 'ptt' ? 'ptt' : 'live';
      } catch (_) { voiceMode = 'live'; }

      elForm.addEventListener('submit', (e) => { e.preventDefault(); submit(); });

      elInput.addEventListener('input', () => { autoGrow(); syncButton(); });

      // Что делает Enter — решает общий модуль, один на четыре места
      // (`lex-composer-input.js`): на столе отправляет, на телефоне переносит
      // строку, а отправка там остаётся за стрелкой в поле. Подпись на синей
      // клавише ставится оттуда же, чтобы она не обещала отправку, которой не
      // будет.
      elInput.setAttribute('enterkeyhint', LexComposerInput.enterKeyHint());
      elInput.addEventListener('keydown', (e) => {
        if (LexComposerInput.enterSends(e)) {
          e.preventDefault();
          submit();
        }
      });

      // The plus carries the surface's own menu, exactly as in the extension
      // (config.composerPlusItems). Two items now: what the conversation is
      // BOUND TO — first, and only when there is a binding — and «attach a
      // file». Собирается на КАЖДОЕ открытие: беседа переключается под панелью,
      // и привязка вместе с ней.
      //
      // Раньше привязку показывала отдельная полоска над композером. Она ушла
      // 2026-08-28 вслед за расширением: там полоска осталась только у СВЕЖЕЙ
      // беседы, где привязку ещё можно открепить, а здесь таких не бывает —
      // привязку запечатывает сервер, и полоска показывалась ровно в том
      // случае, который в расширении теперь живёт в этом меню.
      elPlus.addEventListener('click', (e) => {
        const items = [];
        let att = null;
        try { att = hooks.attachedPage && hooks.attachedPage(); } catch (_) { att = null; }
        if (att && att.url) {
          items.push({
            label: att.label,
            icon: 'link',
            iconUrl: att.iconUrl || null,
            onSelect: () => { try { window.open(att.url, '_blank', 'noopener'); } catch (_) {} },
          });
        }
        items.push({ label: 'Attach image', icon: 'image', onSelect: () => hooks.onAttach() });
        // Меню открывается по обычному нажатию, значит и отклик обычный —
        // `tap`. `press` носит долгое удержание (onLongPress выше), и разница
        // между ними здесь смысловая: она говорит пальцу, каким жестом это
        // было вызвано.
        WcHaptics.tap();
        menu(e.currentTarget, items);
      });

      // Кнопка показывает намерение человека, а не состояние соединения:
      // нажал — горит, нажал ещё раз — погасла. Промежуточного «занята» у неё
      // нет, и расшифровка, которая ещё доезжает с прошлого нажатия, новое
      // нажатие не блокирует — она доделывается сама и дописывает свой текст.
      elMic.addEventListener('click', () => {
        if (recorder || live) stopRecording();
        else startRecording();
      });

      // Long press on the round button chooses how talking works; a plain tap
      // does it.
      const voicePress = onLongPress(elVoice, (e) => voiceModeMenu(e.currentTarget || elVoice));
      elVoice.addEventListener('click', () => {
        if (voicePress.didFire()) return;
        hooks.onVoice({ mode: voiceMode });
      });

      autoGrow();
      syncButton();
      initPresets();
    },

    // Список заготовок из каталога. Зовёт enterApp() — там уже есть токен.
    loadPresets() {
      return loadPresets().catch((err) => console.warn('[wc-composer] presets:', err && err.message));
    },

    setStreaming(on, requestId) {
      streaming = !!on;
      currentRequestId = on ? requestId : null;
      syncButton();
    },

    // The attachment strip changes what "empty" means, so it has to be able to
    // ask for a re-check.
    refresh() { syncButton(); },

    // Фокус. Правило — в общем модуле, здесь только повод.
    //
    // Без повода (сменили беседу, вернулись из правки хода) на телефоне фокус
    // НЕ ставится: клавиатура закрыла бы ровно ту беседу, которую человек
    // только что открыл — он нажал «прочитать», а получил «печатать».
    //
    // `raiseKeyboard: true` — это ОКНО, которое человек открыл сам: запуск
    // приложения, показ окна на Маке. Там он и пришёл печатать, поэтому
    // клавиатура поднимается сразу и палочка мигает в поле.
    focus(opts) {
      LexComposerInput.focus(elInput, opts);
    },

    // Симметрично focus() — расфокус поля, одна и та же точка для всех, кто
    // должен убрать курсор/клавиатуру (боковая панель бесед).
    blur() {
      LexComposerInput.blur(elInput);
    },

    // Ставить курсор до тех пор, пока каретка не встанет НА САМОМ ДЕЛЕ, и
    // сказать, встала ли. По этому ответу оболочка снимает заставку: показывать
    // человеку экран раньше клавиатуры значит показывать, как он подпрыгивает.
    // Правило и срок — в общем модуле, здесь только поле.
    focusUntilCaret(opts) {
      return LexComposerInput.focusUntilCaret(elInput, opts);
    },

    note(text) { elNote.textContent = text || ''; },

    setVoiceActive(on) {
      voiceActive = !!on;
      syncButton();
    },

    voiceMode() { return voiceMode; },

    // The gear shown in the top bar during a call opens this SAME menu — the
    // brief is explicit that it must be the existing switcher, not a second
    // one. anchor is whatever element the caller wants the menu positioned
    // against (its own button, typically).
    openVoiceModeMenu(anchor) { voiceModeMenu(anchor); },

    // Exposed for the voice module: a spoken turn lands in the same box.
    setText(text) {
      elInput.value = text || '';
      autoGrow();
      syncButton();
    },

    text() { return elInput.value; },
  };

  global.WcComposer = WcComposer;
})(typeof self !== 'undefined' ? self : globalThis);
