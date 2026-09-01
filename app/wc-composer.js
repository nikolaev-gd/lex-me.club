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
  // даёт wc-backend.js. До ТРЁХ заготовок стоят пилюлями в ряд, тап по любой
  // сразу отправляет ЕЁ — без выбора «активной» и без меню (2026-09-01,
  // решение владельца; раньше здесь была одна пилюля с ▾-меню и стрелкой
  // отправки, тот же дизайн, что в chat-surface.js до этой же правки).
  //
  // ⚠️ Список приходит АСИНХРОННО, а ряд есть с первого кадра. Поэтому он
  // пересобирается на КАЖДОЕ изменение списка — иначе переименование или
  // новая заготовка в открытых настройках не долетит до уже открытой
  // страницы.
  const PRESETS = () => global.LexActionPresets || null;
  const MAX_VISIBLE_PRESETS = 3;
  let presetScope = null;        // 'shorts-main' — из описания ячейки, не литералом
  let presetActiveKey = null;    // activeNativePromptId_<scope>
  let presetPillEls = [];        // текущие кнопки ряда — syncButton() гасит/включает все разом

  // Подпись «Native» — запасная: её отдаёт labelOf(), пока имя первой заготовки
  // в каталоге не тронуто человеком. У расширения на её месте строка перевода,
  // здесь переводчика нет — и по решению эта страница показывает английский.
  const NATIVE_FALLBACK_LABEL = 'Native';

  function presetList() {
    const P = PRESETS();
    const items = (P && presetScope) ? P.current(presetScope) : [];
    return items.length ? items : [{ id: null, name: '', chars: null }];
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
    if (slotId && presetActiveKey) {
      WcStore.set({ [presetActiveKey]: slotId }).catch(() => {});
    }
    submit({ mode: 'native', slotId });
  }

  // Рисует ряд заново с нуля — проще и надёжнее патча трёх кнопок по месту,
  // а вызывается редко (сборка + смена списка, не на каждый кадр).
  function renderPresetPills() {
    if (!elModeSplit) return;
    const items = presetList().slice(0, MAX_VISIBLE_PRESETS);
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
    presetActiveKey = cell.activeIdStorageKey || null;
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
    // Сначала БЕЗ сети (запомненный список) — это то, что видно сразу после
    // перезагрузки страницы. Потом каталог: право проверяет сервер, и
    // не-редактору он отвечает 403, отчего список остаётся одиночкой и меню не
    // открывается. Отдельного гейта под «обычному пользователю заготовок не
    // видно» здесь нет — он получается сам.
    try { await P.list(presetScope); } catch (_) { /* остаёмся на запасной */ }
    renderPresetPills();
    try { await P.refresh(presetScope); } catch (_) { /* каталог молчит — не авария */ }
    renderPresetPills();
  }

  // Live conversation or push-to-talk. Remembered across sessions: it is a
  // preference about how a person talks, not a state of this page.
  const VOICE_MODE_KEY = 'wcVoiceMode';
  let voiceMode = 'live';

  // ── Recording (dictation) ────────────────────────────────────────────────
  let recorder = null;
  let chunks = [];
  let recStartedAt = 0;
  let transcribing = false;

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
  async function startRecording() {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      toast('No microphone: ' + ((err && err.message) || err), { error: true });
      return;
    }
    try {
      recorder = new MediaRecorder(stream);
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      toast('This browser cannot record audio', { error: true });
      return;
    }
    chunks = [];
    recStartedAt = Date.now();
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = async () => {
      // The tracks are released before the network call, not after: a
      // microphone that stays open shows a recording dot for as long as the
      // transcription takes, which reads as "still listening".
      stream.getTracks().forEach((t) => t.stop());
      const durationMs = Date.now() - recStartedAt;
      const blob = new Blob(chunks, { type: (recorder && recorder.mimeType) || 'audio/webm' });
      chunks = [];
      recorder = null;
      elMic.classList.remove('is-recording');
      if (!blob.size || durationMs < 350) { syncButton(); return; }
      await transcribe(blob, durationMs);
    };
    recorder.start();
    elMic.classList.add('is-recording');
    elMic.title = 'Stop dictating';
    elMic.setAttribute('aria-label', elMic.title);
    WcHaptics.tap();
  }

  function stopRecording() {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    elMic.title = 'Dictate';
    elMic.setAttribute('aria-label', elMic.title);
  }

  async function transcribe(blob, durationMs) {
    transcribing = true;
    elMic.classList.add('is-busy');
    try {
      const base64 = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onloadend = () => { const s = String(r.result || ''); resolve(s.slice(s.indexOf(',') + 1)); };
        r.onerror = () => reject(new Error('read failed'));
        r.readAsDataURL(blob);
      });
      const r = await WcBus.call('WC_DICTATE', { base64, mimeType: blob.type, durationMs });
      const text = (r && r.text || '').trim();
      if (!text) { toast('Nothing was recognised'); return; }
      // Appended, not replaced: dictating into a half-typed message must not
      // throw away what is already there.
      const cur = elInput.value;
      elInput.value = cur ? (cur.replace(/\s*$/, '') + ' ' + text) : text;
      autoGrow();
      syncButton();
      elInput.focus();
      // The caret goes to the end, or the next keystroke lands mid-sentence.
      try { elInput.setSelectionRange(elInput.value.length, elInput.value.length); } catch (_) {}
    } catch (err) {
      toast('Could not transcribe: ' + ((err && err.message) || err), { error: true });
    } finally {
      transcribing = false;
      elMic.classList.remove('is-busy');
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

      elMic.addEventListener('click', () => {
        if (transcribing) return;
        if (recorder) stopRecording();
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
