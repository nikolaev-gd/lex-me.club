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
  // The field takes no text (a group, a chat that takes no messages now): setHint(…, true).
  let locked = false;

  // The words of the field changed — by a key, a dictation, a send, the window: the draft of the chat
  // the field belongs to is the window's (wc-app.js, lex-drafts.js). setText(…, { quiet: true }) — the
  // window filled the field itself (a chat opened with its draft) and is not told.
  function changed() {
    if (typeof hooks.onFieldChange === 'function') {
      try { hooks.onFieldChange(elInput.value); } catch (e) { console.warn('[wc-composer] field:', e && e.message); }
    }
  }
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
  // Заготовка, через которую уйдёт ОБЫЧНАЯ отправка (круглая кнопка, Enter).
  // Взводит её «Edit» у вопроса, заданного заготовкой: текст ложится в поле, и
  // правка уходит той же заготовкой (решение владельца 2026-09-21). Её пилюля
  // подсвечена, пока взведено, — отправка через заготовку не бывает невидимой.
  // Снимается отправкой, нажатием любой пилюли и опустевшим полем.
  let armedPresetSlot = null;
  // «Edit» своего вопроса: с какого вопроса начали правку. Отправка несёт его
  // номер, и сервер берёт из того вопроса скрытый блок выбранного слова
  // (Word/Context/Source) — иначе правленый вопрос ушёл бы учителю без него.
  let editSourceUid = null;

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
    // ОТКАЗ ВМЕСТО ОТВЕТА БЕЗ ИНСТРУКЦИИ. Весь смысл заготовки в её промпте, а
    // на следующих ходах — в её короткой строке: ход без одного из них — не
    // «чуть хуже», а совсем не то, что просили. Проверка локальная и до
    // отправки (LexActionPresets.problemOf): слот обязан быть в списке, с
    // непустым промптом и с короткой строкой. Сервер откажет на то же самое
    // сам, до денег; здесь — чтобы вопрос не лёг в ленту без ответа.
    const P = PRESETS();
    const problem = (P && presetScope) ? P.problemOf(presetScope, slotId) : null;
    if (problem) {
      toast(problem === 'noLine'
        ? '«' + presetLabel(p) + '» has no short line yet — nothing was sent. The owner has to add it in the preset settings.'
        : '«' + presetLabel(p) + '» has no prompt yet', { error: true });
      // Взвод НЕ снимается: иначе следующий Enter отправил бы правленый
      // вопрос заготовки обычным вопросом.
      return;
    }
    armPreset(null);
    // ⚠️ ЗДЕСЬ ПИСАЛСЯ activeNativePromptId_<scope>. Ключа больше нет
    // (2026-09-02): «активной» заготовки не бывает, слот едет с ходом.
    // Модель — тоже готовым значением из строки списка, а не по имени ключа,
    // которое страница собирала у себя: та копия правила уже расходилась
    // однажды (врезка в wc-backend.js).
    // laterOf — пузырь хода сразу строкой и фразой (LexActionPresets.laterOf);
    // только показ, кадр сервера со строкой перерисует его своей версией.
    submit({
      mode: 'native', slotId, modelId: (p && p.modelId) || '',
      // Режим заготовки из списка — только чтобы сразу подписать пузырь
      // «учитель этого не видит». Куда ход уйдёт, решает сервер.
      presetMode: (p && p.mode) || null,
      // Набор заготовок — чтобы страница узнала заготовку выбранного
      // материала (pickDefaultOf) и нарисовала её пузырь без строки.
      presetScope,
      laterOf: (phrase) => ((P && presetScope && typeof P.laterOf === 'function')
        ? P.laterOf(presetScope, slotId, phrase) : ''),
    });
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
      if (armedPresetSlot && p.id === armedPresetSlot) btn.classList.add('is-armed');
      elModeSplit.appendChild(btn);
      return btn;
    });
    syncButton();   // выставить disabled по текущему полю сразу, не только на input
  }

  // Взвести (slotId) или снять (null) заготовку обычной отправки. Взводится
  // и заготовка, которой в ряду уже нет (её удалили после хода): правленый
  // вопрос заготовки обязан уйти ею или не уйти вовсе, а не обычным вопросом
  // (решение владельца 2026-09-21, вариант «б»). Отказ даёт submit.
  function armPreset(slotId) {
    const next = slotId || null;
    if (next === armedPresetSlot) return;
    armedPresetSlot = next;
    presetPillEls.forEach((btn) => btn.classList.toggle('is-armed', !!next && btn.dataset.presetId === next));
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

  // The box's layout and the field's height — one rule for every surface
  // (../lex-composer-box.js, LexComposerBox.fit): one line while what is typed
  // fits, the text above a row of buttons once it does not or once there is
  // something to send with the presets on show; up to 15 lines, then the text
  // scrolls inside. A field that is not laid out yet (init() runs while the app
  // is still hidden behind the boot skeleton) is left at the stylesheet's
  // height — fit() handles that: writing a 0 back used to slice the hint's
  // descenders off until the first keystroke.
  function autoGrow() {
    global.LexComposerBox.fit(elInput, { canSend: canSend(), room: fieldRoom });
  }

  // How tall the field may get: the room between the top bar and the bottom
  // of the box (the keyboard's top on a phone) less the box's own chrome — the
  // row of buttons, the paddings and anything above the box in its strip.
  function fieldRoom() {
    const wrap = elForm.closest('.wc-composer-wrap');
    const bar = document.querySelector('.wc-topbar');
    if (!wrap || !bar) return Infinity;
    let bottom = wrap.getBoundingClientRect().bottom;
    const vv = global.visualViewport;
    if (vv) bottom = Math.min(bottom, vv.offsetTop + vv.height);
    const top = bar.getBoundingClientRect().bottom;
    const chrome = wrap.offsetHeight - elInput.offsetHeight;
    return bottom - top - chrome;
  }

  function canSend() {
    if (locked) return false;
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
    elVoice.disabled = sending || locked;
    // A field that takes no text: nothing in the box works — no dictation, no files, no voice.
    elForm.classList.toggle('is-locked', locked);
    if (elMic) elMic.disabled = locked;
    if (elPlus) elPlus.disabled = locked;

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

    // A window that hides the voice button has nothing in the slot while there
    // is nothing to send — the slot folds and the microphone ends the box; send
    // unfolds it (wc-app.css, .wc-send-slot.is-folded). Every chat of this page
    // has the voice conversation since 2026-11-13 (one box everywhere), the
    // order chats of Profi.ru and the feeds of Extended Mind included.
    const slot = elSend.parentElement;
    if (slot) slot.classList.toggle('is-folded', !sending && getComputedStyle(elVoice).display === 'none');
    // What can be sent decides the layout too (presets live in the row under
    // the text), so the box is laid out again after every such change.
    autoGrow();
  }

  async function submit(opts) {
    if (streaming) {
      if (currentRequestId) hooks.onStop(currentRequestId);
      return;
    }
    if (!canSend()) return;
    // A file still on its way to the server: the message waits for it — it goes with the file's
    // path (lex-file-attach.js), and a message without the file would be another message.
    if (global.WcAttach && typeof WcAttach.busy === 'function' && WcAttach.busy()) {
      toast(global.LexFileAttach.refusal('busy'));
      return;
    }
    // Обычная отправка при взведённой заготовке уходит через неё — как нажатие
    // её пилюли (там же проверка промпта и строки).
    if (!(opts && opts.mode) && armedPresetSlot) {
      const p = presetList().find((x) => x.id === armedPresetSlot);
      if (!p) {
        // Заготовки больше нет: текст остаётся в поле, взвод тоже — человек
        // сам решает, стереть ли текст (взвод снимется) или скопировать его.
        toast('The preset of this question is no longer available — nothing was sent.', { error: true });
        return;
      }
      sendWithPreset(p);
      return;
    }
    // Выбраны слова в ленте — обычная отправка уходит заготовкой по умолчанию
    // (LexActionPresets.pickDefaultOf, решение владельца 2026-09-23), как
    // нажатие её пилюли. Взведённая заготовка выше важнее. Не перехватываем
    // во время живого разговора и когда заготовка неотправима — тогда ход
    // уходит обычным вопросом, а не отказом.
    if (!(opts && opts.mode) && !voiceActive
      && global.WcWordPick && WcWordPick.count() > 0) {
      const P = PRESETS();
      const p = (P && presetScope && typeof P.pickDefaultOf === 'function') ? P.pickDefaultOf(presetScope) : null;
      if (p) { sendWithPreset(p); return; }
    }
    const text = elInput.value.trim();
    elInput.value = '';
    wasBegun = false; // cleared by code, no input event: the next chat's first letter asks again
    autoGrow();
    syncButton();
    changed();
    WcHaptics.tap();
    const pickFrom = editSourceUid;
    editSourceUid = null;
    await hooks.onSend(text, { ...(opts || {}), ...(pickFrom ? { pickFrom } : {}) });
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
      dictBar().stop();
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
    function placeFinal(text) { grower.finish(text); return true; }
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
        clockMark('capture');
        recStartedAt = Date.now();
        micRecording();
        // Полоса стоит с нажатия (armIntent); с первого кадра звука в ней волна.
        dictBar().listen(stream);
        // Потолка живой записи здесь нет: его ставит сервер и сам говорит
        // «закрываю» (onClosing ниже).
      },
      // settledLen — сколько первых знаков догадки уже не перепишется: хвост
      // после них поле красит приглушённым (lex-dictation-bar.js).
      onDelta: (textSoFar, settledLen) => { if (textSoFar) { clockMark('first word'); grower.push(textSoFar, settledLen); } },
      onReady: () => clockMark('ready'),
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
        // Места в очереди платных вызовов сервер не дождался — «сервис занят»,
        // тот же текст, что у чата, а не сырое too_many_inflight.
        if (info && info.status === 429) {
          toast((typeof LexErrorText !== 'undefined' && LexErrorText.busy)
            ? LexErrorText.busy() : 'The service is overloaded right now. Please try again in a minute.', { error: true });
          return;
        }
        toast('Could not transcribe: ' + msg, { error: true });
      },
    });
    // Эта сессия — своя переменная, а не общая `live`: после «стоп» общая
    // освобождается сразу, и новое нажатие начинает новую сессию, пока эта
    // ещё договаривает с сервером.
    const me = live;
    // Завершение описано ДО старта: кнопка горит с первого кадра звука, значит
    // второе нажатие может прийти, пока связь ещё встаёт.
    // wantText: true — «стоп» (итог в поле), false — бросить молча (выросшее
    // остаётся), 'discard' — крестик полосы: сказанное в этой записи уходит из
    // поля. Возвращает, встал ли в поле итог (по нему отправка во время записи
    // решает, отправлять ли).
    live.__finish = async (wantText) => {
      if (finished) return false;
      finished = true;
      clearRecLimit();
      dictBar().stop();
      // Кнопка гаснет в миг нажатия и больше не меняется: всё, что осталось
      // серверу, он доделывает молча. Никакого «занята».
      if (live === me) live = null;
      elMic.classList.remove('is-recording');
      elMic.title = 'Dictate';
      elMic.setAttribute('aria-label', elMic.title);
      // Связь ещё не встала — расшифровывать нечего и ошибки не было: человек
      // передумал. Бросаем молча; расход за уже переданное досчитает сервер.
      const want = wantText === true && !!(me && me.isReady && me.isReady());
      // stop() глушит звук сразу, до всякой сети; микрофон отдаём тут же, а не
      // после ответа, — иначе точка записи горела бы над погасшей кнопкой.
      const pending = want ? me.stop() : (me.abort(), null);
      stream.getTracks().forEach((t) => t.stop());
      if (wantText === 'discard') grower.discard();
      const res = pending ? await pending : null;
      syncButton();
      if (!want) { grower.forget(); return false; }
      if (!res || !res.ok) { grower.forget(); toast('Could not transcribe', { error: true }); return false; }
      const text = (res.text || '').trim();
      if (!text) { grower.forget(); toast('Nothing was recognised'); return false; }
      return placeFinal(text);
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
    // Последняя минута (доска 9): предел живой записи называет сервер в «готов»;
    // отсчёт — от начала звука. Останавливает запись по-прежнему сервер
    // (onClosing → endedByServer), полоса только показывает время.
    if (started && !finished && live === me && me.maxDurationMs && me.maxDurationMs() > 0) {
      dictBar().deadline(recStartedAt + me.maxDurationMs());
    }
    if (!started) {
      if (!finished) {
        if (live === me) live = null;
        stream.getTracks().forEach((t) => t.stop());
        dictBar().stop();
        elMic.classList.remove('is-recording');
        elMic.title = 'Dictate';
        elMic.setAttribute('aria-label', elMic.title);
        syncButton();
      }
    }
  }

  // ── Нажатие раньше микрофона ─────────────────────────────────────────────
  //
  // Геннадий 23.11.2026: «запись должна начинаться моментально везде, всегда».
  // Кнопка и полоса встают В МИГ НАЖАТИЯ — это намерение человека; микрофон
  // (getUserMedia: десятые доли секунды, первый раз дольше) и выбор
  // распознавалки приходят следом, и волна встаёт в полосу, когда пошёл звук.
  // Второе нажатие, крестик или стрелка в это время заканчивают запись молча:
  // записано ещё ничего не было.
  let arming = null;
  function micRecording() {
    elMic.classList.add('is-recording');
    elMic.title = 'Stop dictating';
    elMic.setAttribute('aria-label', elMic.title);
  }
  function micIdle() {
    elMic.classList.remove('is-recording');
    elMic.title = 'Dictate';
    elMic.setAttribute('aria-label', elMic.title);
  }
  function armIntent() {
    const a = { cancelled: false };
    arming = a;
    clockPress();
    micRecording();
    WcHaptics.tap();
    dictBar().start(null);
    requestAnimationFrame(() => clockMark('bar'));
    return a;
  }
  // How soon the microphone answers a press, in the console: one line per step, counted from the
  // press (`[Lex] dict start: <step> +<ms> ms`) — the steps of the iPhone's DictationPressClock.
  let clockT0 = 0;
  let clockSeen = null;
  function clockPress() { clockT0 = performance.now(); clockSeen = new Set(); console.debug('[Lex] dict start: press'); }
  function clockMark(step) {
    if (!clockSeen || clockSeen.has(step)) return;
    clockSeen.add(step);
    console.debug(`[Lex] dict start: ${step} +${Math.round(performance.now() - clockT0)} ms`);
  }
  // Запись так и не началась (отказ микрофона, нет каталога): намерение снимается.
  function dropIntent(a) {
    if (arming === a) arming = null;
    if (a.cancelled) return;
    micIdle();
    dictBar().stop();
    syncButton();
  }
  function cancelArming() {
    const a = arming;
    if (!a) return false;
    a.cancelled = true;
    arming = null;
    micIdle();
    dictBar().stop();
    syncButton();
    return true;
  }

  // The first letter of a message or the dictation button: a new chat's session is made while the
  // person writes (wc-backend.js WC_PREPARE). Never awaited; the backend does nothing when nothing
  // is due.
  let wasBegun = false;
  function prepareSend() {
    try { WcBus.call('WC_PREPARE', {}).catch(() => {}); } catch (_) { /* no backend on this page */ }
  }

  async function startRecording() {
    const intent = armIntent();
    prepareSend();
    // Какая распознавалка выбрана и каким путём снимать звук, спрашивается
    // ПАРАЛЛЕЛЬНО с микрофоном, а не после него: каталог распознавалок (строки
    // базы, lex-dictation-catalog.js) обычно уже в памяти, а если нет — его
    // чтение идёт, пока браузер открывает микрофон, и нажатие не ждёт лишнего.
    const choiceP = (async () => {
      let dict = { model: null, knobs: {} };
      try { dict = await global.WcBackend.readDictationKnobs(); } catch (_) { /* умолчания сервера рабочие */ }
      clockMark('settings');
      const route = await global.LexDictationCatalog.route(dict.model, global.LexModelRegistry.defaultDictationModel);
      return { dict, route };
    })();
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      clockMark('microphone open');
    } catch (err) {
      const quiet = intent.cancelled;
      dropIntent(intent);
      if (!quiet) toast('No microphone: ' + ((err && err.message) || err), { error: true });
      return;
    }
    // Какая распознавалка выбрана — решает та же ручка, что и в расширении.
    // Живая не пишет файл вовсе, поэтому MediaRecorder ниже ей не нужен.
    const choice = await choiceP;
    clockMark('route');
    // Передумал, пока открывался микрофон: микрофон отдаём, больше ничего.
    if (intent.cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
    const route = choice.route;
    if (!route.ok) {
      // Без каталога путь угадывать нельзя: живую распознавалку файлом не
      // расшифровать, а файловую — сокетом.
      stream.getTracks().forEach((t) => t.stop());
      dropIntent(intent);
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
        dropIntent(intent);
        toast('Live dictation is not loaded here — reload the page', { error: true });
        return;
      }
      // С этого мига запись — живой сессии (live), её и останавливают.
      arming = null;
      await startLive(stream, dict);
      return;
    }
    let rec;
    try {
      // Распознавалка, которая сжатых файлов не читает (у файловой строки
      // каталога есть частота), получает WAV — общим куском с расширением
      // (lex-dictation-wav.js). Остальные — то, что пишет платформа: webm в
      // Chrome, mp4 в WebKit.
      // Сжатый файл — 64 кбит/с: получас выходит ~15 МБ, меньше предела файла
      // у OpenAI (25 МБ). То же у расширения (dictation.js, REC_BITS_PER_SEC).
      rec = route.wavRate ? global.LexDictationWav.create(stream, route.wavRate)
        : new MediaRecorder(stream, { audioBitsPerSecond: 64000 });
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      dropIntent(intent);
      toast('This browser cannot record audio', { error: true });
      return;
    }
    arming = null;
    recorder = rec;
    // Куски и начало — свои у каждой записи: пока одна отправляется на
    // расшифровку, следующая уже может писаться, и общий массив они бы делили.
    const myChunks = [];
    const myStartedAt = Date.now();
    recStartedAt = myStartedAt;
    // Чем кончилась эта запись: встал ли итог в поле. Его ждёт отправка во
    // время записи (sendRecording); крестик отвечает «нет» сразу.
    let doneWith;
    rec.__done = new Promise((resolve) => { doneWith = resolve; });
    rec.__stream = stream;
    rec.__doneWith = (v) => doneWith(v);
    rec.ondataavailable = (e) => { if (e.data && e.data.size) myChunks.push(e.data); };
    rec.onstop = async () => {
      // Dictation cancelled (cancelRecording: the field over a dimmed screen closed, В7.64): the microphone is let go,
      // nothing goes to the recognizer and nothing lands in the field.
      if (rec.__cancelled) { stream.getTracks().forEach((t) => t.stop()); syncButton(); return; }
      // The tracks are released before the network call, not after: a
      // microphone that stays open shows a recording dot for as long as the
      // transcription takes, which reads as "still listening".
      stream.getTracks().forEach((t) => t.stop());
      const durationMs = Date.now() - myStartedAt;
      const blob = new Blob(myChunks, { type: rec.mimeType || 'audio/webm' });
      const cap = capture();
      if (blob.size < cap.minBlobBytes || durationMs < cap.minDurationMs) { syncButton(); doneWith(false); return; }
      doneWith(await transcribe(blob, durationMs));
    };
    rec.start();
    micRecording();
    // Обычная распознавалка: во время записи — только волна, текст после «стоп».
    // Полоса стоит с нажатия (armIntent); с этого мига в ней волна.
    dictBar().listen(stream);
    // Потолок записи — общее правило (lex-dictation-limit.js): микрофон, забытый
    // включённым, платит за каждую минуту тишины, поэтому запись кончается
    // сама так же, как по кнопке, и человеку говорится почему.
    clearRecLimit();
    recLimit = Limit.arm({
      maxMs: route.maxRecordMs,
      isStillMine: () => recorder === rec && rec.state !== 'inactive',
      onFire: (maxMs) => {
        stopRecording();
        toast('Recording stopped: the limit is ' + Limit.label(maxMs) + '.');
      },
    });
    // Последняя минута (доска 9): тот же предел, что у таймера выше.
    if (recLimit && recLimit.maxMs > 0) dictBar().deadline(Date.now() + recLimit.maxMs);
  }

  // Возвращает обещание: встал ли итог этой записи в поле.
  function stopRecording() {
    if (cancelArming()) return Promise.resolve(false);
    clearRecLimit();
    // Живая сессия заканчивается по-своему: файла нет, и «остановить запись»
    // значит «дать серверу договорить с провайдером и вернуть итог».
    if (live && live.__finish) return live.__finish(true);
    // Кнопка гаснет в миг нажатия, а запись отпускается сразу: следующее
    // нажатие начинает новую, пока эта ещё уходит на расшифровку.
    const r = recorder;
    recorder = null;
    elMic.classList.remove('is-recording');
    dictBar().stop();
    if (r && r.state !== 'inactive') r.stop();
    elMic.title = 'Dictate';
    elMic.setAttribute('aria-label', elMic.title);
    return (r && r.__done) || Promise.resolve(false);
  }

  // ── Полоса диктовки (lex-dictation-bar.js) ───────────────────────────────
  //
  // Крестик, волна, стоп и отправка на местах «+», поля, микрофона и круглой
  // кнопки, пока идёт запись. Здесь — только что значат её три кнопки.
  function dictBar() {
    return global.LexDictationBar.attach(elInput, {
      onCancel: cancelRecording,
      onStop: () => { stopRecording(); },
      onSend: sendRecording,
      onLayout: () => { autoGrow(); },
      // Крестик на записи от минуты (доска 8): общий диалог страницы (В7.16), запись
      // идёт, пока он открыт; кончилась сама — полоса закрывает его (dismissAsk).
      ask: (q) => {
        if (askAbort) askAbort.abort();
        const ctl = new AbortController();
        askAbort = ctl;
        return WcUI.confirm(q.title, q.body, { okText: q.discard, cancelText: q.keep, danger: true, signal: ctl.signal })
          .then((v) => { if (askAbort === ctl) askAbort = null; return v === true; });
      },
      dismissAsk: () => { if (askAbort) { askAbort.abort(); askAbort = null; } },
    });
  }
  let askAbort = null;

  // Крестик: сказанное в ЭТОЙ записи выбрасывается. Обычная распознавалка —
  // звук никуда не уходит вовсе; живая — сессия брошена, её текст уходит из
  // поля. Набранное до записи остаётся.
  function cancelRecording() {
    if (cancelArming()) return;
    clearRecLimit();
    if (live && live.__finish) { live.__finish('discard'); return; }
    const r = recorder;
    recorder = null;
    elMic.classList.remove('is-recording');
    elMic.title = 'Dictate';
    elMic.setAttribute('aria-label', elMic.title);
    dictBar().stop();
    if (!r) return;
    const own = r.__stream;
    r.ondataavailable = null;
    r.onstop = () => { if (own) own.getTracks().forEach((t) => t.stop()); };
    try { if (r.state !== 'inactive') r.stop(); else r.onstop(); } catch (_) { r.onstop(); }
    if (r.__doneWith) r.__doneWith(false);
    syncButton();
  }

  // Стрелка во время записи: остановить, дождаться итога и отправить тем же
  // путём, что обычная стрелка (submit). Итог живой распознавалки ждём не
  // дольше SEND_WAIT_MS (сервер сам ждёт последнее слово 6 с); обычной —
  // сколько идёт расшифровка: без неё текста нет вовсе. Пустой итог — ничего
  // не уходит. Пока идёт ответ, обычная стрелка — «стоп» ответа, поэтому
  // текст тогда остаётся в поле.
  const SEND_WAIT_MS = 10000;
  let sendWaiting = false;
  async function sendRecording() {
    if (sendWaiting) return;
    sendWaiting = true;
    const wasLive = !!live;
    let placed = false;
    try {
      const done = stopRecording();
      placed = await (wasLive
        ? Promise.race([done, new Promise((resolve) => setTimeout(() => resolve(false), SEND_WAIT_MS))])
        : done);
    } catch (_) { placed = false; }
    sendWaiting = false;
    if (!placed || streaming) return;
    submit();
  }

  // Dictation cancelled, not finished: the live session is dropped (its grown words are the caller's to take back), the
  // file recording stops without a transcription. The quick field over a dimmed screen (wc-app.js, В7.64) calls it when
  // it closes without sending: «nothing is kept». Not the cross of the dictation bar (cancelRecording above): the cross
  // takes this recording's words out of the field itself.
  function dropRecording() {
    if (cancelArming()) return;
    clearRecLimit();
    if (live && live.__finish) { live.__finish(false); return; }
    const r = recorder;
    recorder = null;
    elMic.classList.remove('is-recording');
    elMic.title = 'Dictate';
    elMic.setAttribute('aria-label', elMic.title);
    dictBar().stop();
    if (r && r.state !== 'inactive') { r.__cancelled = true; r.stop(); }
    if (r && r.__doneWith) r.__doneWith(false);
    syncButton();
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
      changed();
      if (focus) elInput.focus();
      // Каретка в конец, иначе следующая буква встанет посреди фразы.
      try { elInput.setSelectionRange(elInput.value.length, elInput.value.length); } catch (_) {}
      // A field taller than its cap scrolls: the newest words are in sight, not
      // the first lines (the caret moved by script does not scroll it).
      elInput.scrollTop = elInput.scrollHeight;
    };
    return {
      // settledLen — сколько первых знаков куска встало набело (живая
      // распознавалка); остальное красится приглушённым, пока поле — ровно
      // наша запись (lex-dictation-bar.js). Нет числа — набело всё.
      push(sofar, settledLen) {
        const v = growField.push(id, sofar, elInput.value || '');
        if (v === null) return;
        put(v, false);
        const settled = Number.isInteger(settledLen) ? Math.min(Math.max(settledLen, 0), sofar.length) : sofar.length;
        dictBar().tail(v, v.endsWith(sofar) ? sofar.length - settled : 0);
      },
      // Итог «стоп»: на место выросшего куска, куска нет — в конец.
      finish(text) { put(growField.finish(id, text, elInput.value || ''), true); },
      // Крестик: кусок этой записи уходит из поля (null — поле не трогать).
      discard() {
        const v = growField.discard(id, elInput.value || '');
        if (v !== null) put(v, true);
      },
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
      if (!text) { toast('Nothing was recognised'); return false; }
      // Не затирает набранное: рос текст — итог встаёт на его место; не рос —
      // дописывается к набранному через пробел.
      grower.finish(text);
      return true;
    } catch (err) {
      // «Сервис занят» уже сказан словами целиком — без приставки.
      toast(err && err.lexBusy ? err.message : 'Could not transcribe: ' + ((err && err.message) || err), { error: true });
      return false;
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

      // Holding the arrow opens the chat's own ways of sending (hooks.sendMenu(text) → { head,
      // items: [{label, icon, run(text) → Promise<boolean>}] }): in an order chat of Profi.ru —
      // the text to the client at once, without the model, or at a time (lex-profi.js
      // sendMenu). The menu is the one of the whole of Lex (lex-send-later.js): the chat dims
      // around the field, the arrow gets a ring. An item that took the text clears the field;
      // one that did not (the person closed the sheet, the server refused) leaves it. A chat
      // without such ways has no hold at all: a long press sends as before.
      const waysOf = (text) => (hooks.sendMenu && text ? hooks.sendMenu(text) : null);
      onLongPress(elSend, () => {
        const text = elInput.value.trim();
        const ways = waysOf(text);
        if (!ways || !ways.items || !ways.items.length) return;
        global.LexSendLater.menu({
          anchor: elSend,
          align: 'right',
          lit: elForm,
          ring: elSend,
          head: ways.head,
          items: ways.items.map((it) => ({
            label: it.label,
            icon: it.icon,
            run: async () => {
              let ok = false;
              try { ok = await it.run(text); } catch (err) {
                toast((err && err.message) || 'Not sent.', { error: true });
              }
              if (ok && elInput.value.trim() === text) {
                elInput.value = '';
                wasBegun = false;
                autoGrow();
                syncButton();
                changed();
              }
            },
          })),
        });
      }, {
        when: () => !streaming && !armedPresetSlot && !!global.LexSendLater
          && !!(waysOf(elInput.value.trim()) || {}).items,
      });

      elInput.addEventListener('input', () => {
        autoGrow(); syncButton(); changed();
        // A message is begun (the field was empty): what its send needs is made ready now (WC_PREPARE).
        const begun = !!elInput.value.trim();
        if (begun && !wasBegun) prepareSend();
        wasBegun = begun;
        // Поле стёрли — взведённая правкой заготовка больше ни к чему.
        if (!elInput.value.trim()) { armPreset(null); editSourceUid = null; }
      });

      // Что делает Enter — решает общий модуль, один на четыре места
      // (`lex-composer-input.js`): на столе отправляет, на телефоне переносит
      // строку, а отправка там остаётся за стрелкой в поле. Подпись на синей
      // клавише ставится оттуда же, чтобы она не обещала отправку, которой не
      // будет.
      //
      // Пока учитель думает или пишет, Enter не делает НИЧЕГО — ни отправки,
      // ни «стопа»: остановить ответ можно только нажатием на квадрат, как в
      // расширении. Раньше Enter шёл в submit(), а тот во время ответа жмёт
      // «стоп», и лишний Enter в ожидании первого слова выбрасывал уже
      // оплаченный ответ (2026-09-13, программа для Мака).
      elInput.setAttribute('enterkeyhint', LexComposerInput.enterKeyHint());
      elInput.addEventListener('keydown', (e) => {
        if (LexComposerInput.enterSends(e)) {
          e.preventDefault();
          if (streaming) return;
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
        // Any file (2026-11-17): a PDF, a document, a video, an archive — to the message, so that it
        // can go on to people. A picture picked here goes the way of a picture (WcAttach.accept).
        if (hooks.onAttachFile) items.push({ label: 'File', icon: 'file', onSelect: () => hooks.onAttachFile() });
        // Модель по умолчанию для следующих вопросов — так же, как пункт «Text
        // model» в меню «+» расширения. Меню моделей встаёт у кнопки «+».
        let tm = null;
        try { tm = hooks.textModel && hooks.textModel(); } catch (_) { tm = null; }
        if (tm) {
          const anchor = e.currentTarget;
          items.push({
            // Just the model and its level, «Opus 5.5 · high» (Gennady, 23.11.2026).
            label: tm.label || 'Text model',
            icon: 'spark',
            onSelect: () => tm.open(anchor),
          });
        }
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
        if (recorder || live || arming) stopRecording();
        else startRecording();
      });

      // Long press on the round button chooses how talking works; a plain tap
      // does it.
      const voicePress = onLongPress(elVoice, (e) => voiceModeMenu(e.currentTarget || elVoice));
      elVoice.addEventListener('click', () => {
        if (voicePress.didFire()) return;
        hooks.onVoice({ mode: voiceMode });
      });
      // Прямой режим: рука на кнопке голоса — рецепт разговора берётся
      // сейчас, если его ещё нет (wc-voice.js warmDirect; без прямого режима
      // ничего не спрашивается).
      elVoice.addEventListener('pointerenter', () => {
        try { if (global.WcVoice && typeof global.WcVoice.warmDirect === 'function') global.WcVoice.warmDirect(null, 0); } catch (_) {}
      });

      autoGrow();
      syncButton();
      initPresets();

      // The window's size is the field's room and the box's width.
      global.addEventListener('resize', autoGrow);
      if (global.visualViewport) global.visualViewport.addEventListener('resize', autoGrow);
      // Entering or leaving a chat that hides presets or the voice button (an
      // order chat, a feed of Extended Mind) is a class on the page's main
      // column: the box re-reads what it has.
      const main = elForm.closest('.wc-main');
      if (main && global.MutationObserver) {
        new MutationObserver(syncButton).observe(main, { attributes: true, attributeFilter: ['class'] });
      }
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

    // Exposed for the voice module: a spoken turn lands in the same box. opts.quiet — the window
    // fills the field of a chat it opens with the chat's draft: the draft is not told (changed()).
    setText(text, opts) {
      elInput.value = text || '';
      autoGrow();
      syncButton();
      if (!(opts && opts.quiet)) changed();
      // Поле очистили снаружи (новая беседа, другая беседа) — взведённая
      // правкой заготовка к нему больше не относится.
      if (!elInput.value.trim()) { armPreset(null); editSourceUid = null; }
    },

    // «Edit» вопроса, заданного заготовкой: следующая обычная отправка уйдёт
    // через неё. null — снять.
    armPreset(slotId) { armPreset(slotId || null); },
    // «Edit» вопроса: номер вопроса, с которого начали правку (null — снять).
    armEditSource(uid) { editSourceUid = uid ? String(uid) : null; },

    text() { return elInput.value; },

    // The microphone of the field, pressed from outside it: the capsule of a new chat (wc-app.js, В7.64) opens the field
    // and starts the dictation the field's own button starts. A dictation going on is left as it is.
    dictate() { if (!recorder && !live && !arming && !locked) startRecording(); },
    // A dictation going on is dropped: no transcription, no words (see dropRecording).
    cancelDictation() { if (recorder || live || arming) dropRecording(); },
    isDictating() { return !!(recorder || live || arming); },

    // The words of the empty field (LexComposerBox.hint): none, except in a field that takes no text at
    // all. lock — the field takes no text (a group: Lex does not write there): it says so at once, takes
    // no typing, and no button of the box works. The field's name for a screen reader stays «Message».
    setHint(words, lock) {
      if (!elInput) return;
      const next = words || '';
      if (elInput.placeholder !== next) elInput.placeholder = next;
      elInput.setAttribute('aria-label', next || 'Message');
      const was = locked;
      locked = !!lock;
      elInput.disabled = locked;
      if (locked !== was) {
        if (locked) { armPreset(null); editSourceUid = null; LexComposerInput.blur(elInput); }
        syncButton();
      }
    },
  };

  global.WcComposer = WcComposer;
})(typeof self !== 'undefined' ? self : globalThis);
