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

  let elForm, elInput, elSend, elVoice, elMic, elPlus, elNative, elNote;
  let hooks = {};
  let streaming = false;
  let currentRequestId = null;
  let voiceActive = false;

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
      || (global.WcAttach && WcAttach.count() > 0);
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

    // The chip sends, so it is dead while there is nothing to send and while a
    // turn is already streaming.
    elNative.disabled = streaming || !canSend();

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
  // One helper, because three controls want it (the chip, the round button and
  // — in the thread — a message). Pointer events rather than touch events: the
  // same gesture has to work under a mouse for testing.
  function onLongPress(el, fire, opts) {
    const holdMs = (opts && opts.holdMs) || 480;
    let timer = 0;
    let fired = false;
    let startX = 0;
    let startY = 0;

    const clear = () => { if (timer) { clearTimeout(timer); timer = 0; } };

    el.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button !== 0) return;
      fired = false;
      startX = e.clientX;
      startY = e.clientY;
      clear();
      timer = setTimeout(() => {
        timer = 0;
        fired = true;
        WcHaptics.press();
        fire(e);
      }, holdMs);
    });
    // A finger that travels is a scroll, not a press.
    el.addEventListener('pointermove', (e) => {
      if (!timer) return;
      if (Math.abs(e.clientX - startX) > 10 || Math.abs(e.clientY - startY) > 10) clear();
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((t) =>
      el.addEventListener(t, () => clear()));
    // Swallow the click that follows a press that already did something.
    el.addEventListener('click', (e) => {
      if (fired) { e.preventDefault(); e.stopPropagation(); fired = false; }
    }, true);

    return { didFire: () => fired };
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
      elNative = document.getElementById('wc-native');
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
      // (config.composerPlusItems). One item today; it is a menu rather than a
      // direct paperclip so the second item does not change the control.
      elPlus.addEventListener('click', (e) => {
        menu(e.currentTarget, [
          { label: 'Attach image', icon: 'image', onSelect: () => hooks.onAttach() },
        ]);
      });

      // The chip sends in Native mode. Long press is reserved for the day a
      // second mode exists and deliberately shows nothing today — an empty
      // menu would be worse than no menu.
      const nativePress = onLongPress(elNative, () => {});
      elNative.addEventListener('click', () => {
        if (nativePress.didFire()) return;
        submit({ mode: 'native' });
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
