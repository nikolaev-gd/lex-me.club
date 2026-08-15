// webchat/wc-composer.js — the input row: text, send/stop, paperclip, mic.
//
// The send button and the stop button are ONE control that changes state, not
// two that swap places. Two controls means the layout shifts under the thumb
// at the exact moment a person is reaching for it, and on a phone that turns
// "stop the answer" into "send an empty message".
(function (global) {
  'use strict';

  let elForm, elInput, elSend, elMic, elAttach, elNote;
  let hooks = {};
  let streaming = false;
  let currentRequestId = null;

  function autoGrow() {
    elInput.style.height = 'auto';
    elInput.style.height = Math.min(elInput.scrollHeight, 220) + 'px';
  }

  function canSend() {
    return elInput.value.trim().length > 0
      || (global.WcAttach && WcAttach.count() > 0);
  }

  function syncButton() {
    elSend.classList.toggle('is-stop', streaming);
    elSend.disabled = !streaming && !canSend();
    elSend.title = streaming ? 'Остановить' : 'Отправить';
    elSend.setAttribute('aria-label', elSend.title);
    const path = elSend.querySelector('path');
    if (path) {
      path.setAttribute('d', streaming
        ? 'M7 7h10v10H7z'                 // a square: stop
        : 'M12 19V5M5 12l7-7 7 7');       // an arrow: send
    }
  }

  async function submit() {
    if (streaming) {
      if (currentRequestId) hooks.onStop(currentRequestId);
      return;
    }
    if (!canSend()) return;
    const text = elInput.value.trim();
    elInput.value = '';
    autoGrow();
    syncButton();
    await hooks.onSend(text);
  }

  const WcComposer = {
    init(h) {
      hooks = h;
      elForm = document.getElementById('wc-composer');
      elInput = document.getElementById('wc-input');
      elSend = document.getElementById('wc-send');
      elMic = document.getElementById('wc-mic');
      elAttach = document.getElementById('wc-attach');
      elNote = document.getElementById('wc-composer-note');

      elForm.addEventListener('submit', (e) => { e.preventDefault(); submit(); });

      elInput.addEventListener('input', () => { autoGrow(); syncButton(); });

      elInput.addEventListener('keydown', (e) => {
        // Enter sends, Shift+Enter breaks the line. On a touch keyboard Enter
        // is the "send" key (enterkeyhint in the markup) and there is no Shift
        // to hold, so the newline lives behind the multiline keyboard instead.
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          submit();
        }
      });

      elMic.addEventListener('click', () => hooks.onVoice());
      elAttach.addEventListener('click', () => hooks.onAttach());

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

    focus() { try { elInput.focus(); } catch (_) {} },

    note(text) { elNote.textContent = text || ''; },

    setVoiceActive(on) {
      elMic.classList.toggle('is-active', !!on);
      elMic.title = on ? 'Завершить разговор' : 'Голос';
      elMic.setAttribute('aria-label', elMic.title);
    },

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
