// webchat/wc-voice-screen.js — the call controls, docked where the composer
// sits.
//
// ── Why the thread stays on screen ───────────────────────────────────────────
//
// This used to build a full-screen "call" takeover — a breathing orb, a
// status line, the last line spoken, one button to go back to the chat
// without hanging up. That was a deliberate, explicit request from the owner
// at the time (see git history), and it stood until 2026-08-19, when a fresh,
// equally explicit request replaced it: during a call this should look like
// the ordinary chat screen, because it IS the ordinary chat screen — spoken
// turns already land in the same thread as typed ones (WcThread.beginVoiceUser
// / voiceUserText / voiceAssistantText, wired from wc-app.js). The one thing
// that has to change is the composer, because there is nothing to type into
// while talking. So this module no longer owns a screen — it owns the two
// buttons that replace the composer's form, mounted inside the SAME
// .wc-composer-wrap the form lives in (index.html), shown and hidden by the
// same .is-voice class on #wc-root that already existed (wc-app.css hides
// .wc-composer under it and shows this in its place). There is no "collapse"
// control any more, because there is no separate place to collapse away from.
//
// Dropped with the takeover: the orb that breathed with real microphone
// volume, and the running "The teacher is speaking…" commentary. Neither had
// anywhere left to live once the only thing this module draws is the control
// row, and neither was asked for.
//
// ONE line of text came back on 2026-08-20, and only one: with the orb gone,
// pressing "talk" left the screen completely silent for the seconds the
// connection takes, and there was no way to tell a slow connect from a dead
// button. So there is a single status line above the row — "Connecting…"
// while the session is being set up, "Listening" the moment it is live, and
// then it fades out after two seconds and the lit mic button carries the
// state on its own. It is driven ONLY from stage() below, i.e. from the
// transport's own stages; nothing else writes into it, because the thing this
// screen must not become again is a running commentary on the call.
(function (global) {
  'use strict';

  const { el } = WcUI;

  let host = null;
  let nodes = {};
  let hooks = {};
  let open = false;

  // Придержан ли микрофон прямо сейчас (защита первой реплики). Экран должен
  // знать это сам: не спорить с muted() на противоречивое состояние кнопки.
  let held = false;

  // «Держи и говори» вместо открытого микрофона.
  let ptt = false;

  // Гашение строки «Listening». Хранится, чтобы отбой посреди соединения не
  // оставил висящий таймер, который потом тронет узлы уже закрытого экрана.
  let fadeTimer = null;
  const stopFade = () => { if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; } };

  function build() {
    // Обычный разговор: микрофон открыт, кнопка его закрывает и открывает —
    // нажатие переключает.
    //
    // «Держи и говори»: микрофон закрыт, и открыт ровно пока палец на
    // кнопке. Это НЕ другой транспорт и не другая сессия — та же живая
    // сессия, просто дорожка выключена между репликами. Поэтому и кнопка та
    // же: у неё меняется способ нажатия, а не назначение.
    const mic = el('button.wc-vs-btn.wc-vs-mic', {
      type: 'button', 'aria-label': 'Mute microphone', title: 'Mute microphone',
      onclick: () => { if (!ptt) hooks.onToggleMute && hooks.onToggleMute(); },
      onpointerdown: (e) => {
        if (!ptt) return;
        // Палец на кнопке — дорожка открыта. setPointerCapture: пока говорят,
        // палец ездит, и без захвата «отпустил» приходило бы на другой
        // элемент, а микрофон оставался бы открытым.
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
        hooks.onHoldStart && hooks.onHoldStart();
      },
      onpointerup: () => { if (ptt && hooks.onHoldEnd) hooks.onHoldEnd(); },
      onpointercancel: () => { if (ptt && hooks.onHoldEnd) hooks.onHoldEnd(); },
    }, [iconMic()]);

    const end = el('button.wc-vs-btn.wc-vs-end', {
      type: 'button', 'aria-label': 'End conversation', title: 'End conversation',
      onclick: () => hooks.onEnd && hooks.onEnd(),
    }, [iconEnd()]);

    // Пока идёт соединение — «Connecting…»; как соединились — «Listening»,
    // и через две секунды строка гаснет, оставляя подсвеченный микрофон
    // единственным знаком, что говорить можно. Пустой экран во время
    // соединения — то, из-за чего эта строка и вернулась: человек нажал
    // разговор и не знает, случилось ли что-нибудь.
    // id — тот самый '#wc-voice-status', который читает голосовой сценарий
    // (dev-tools/scenarios/cases/webchat-voice.mjs). Строку когда-то убрали
    // вместе с полноэкранным листом, и селектор с тех пор молча возвращал
    // пустоту; теперь диагностика снова показывает настоящее состояние.
    const status = el('.wc-vs-status', { id: 'wc-voice-status', role: 'status', 'aria-live': 'polite' }, ['Connecting…']);

    nodes = { mic, end, status };

    return el('.wc-vs', {}, [status, el('.wc-vs-controls', {}, [mic, end])]);
  }

  const svg = (paths, extra) => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    paths.forEach((d) => {
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', d);
      s.append(p);
    });
    if (extra) extra(s);
    return s;
  };
  const iconMic = () => svg(['M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z', 'M5 11a7 7 0 0 0 14 0', 'M12 18v4']);
  const iconMicOff = () => svg(['M9 5a3 3 0 0 1 6 0v4', 'M15 13a3 3 0 0 1-6 0v-1', 'M5 11a7 7 0 0 0 11 5.3', 'M12 18v4', 'M3 3l18 18']);
  // Крестик, а не трубка (решение владельца 2026-08-20). Действие то же:
  // разговор заканчивается, человек остаётся в том же чате.
  const iconEnd = () => svg(['M6 6l12 12', 'M18 6L6 18']);

  const WcVoiceScreen = {
    open(h) {
      hooks = h || {};
      host = document.getElementById('wc-voice');
      host.replaceChildren(build());
      host.hidden = false;
      open = true;
      document.getElementById('wc-root').classList.add('is-voice');
      // The composer's input is hidden the instant this opens (wc-app.css,
      // .is-voice hides .wc-composer) — if focus was left inside it, it is
      // now sitting in a hidden field. Move it to the one control a keyboard
      // or screen-reader user can actually act on.
      try { nodes.end.focus({ preventScroll: true }); } catch (_) {}
    },

    close() {
      open = false;
      held = false;
      stopFade();
      if (host) { host.hidden = true; host.replaceChildren(); }
      document.getElementById('wc-root').classList.remove('is-voice');
      nodes = {};
    },

    isOpen() { return open; },

    /** Переключить в «держи и говори». Выбор человека, помнится между
     *  сессиями — хранит его композер. */
    pushToTalk(on) {
      ptt = !!on;
      if (!nodes.mic) return;
      nodes.mic.classList.toggle('is-ptt', ptt);
      const label = ptt ? 'Hold to talk' : 'Mute microphone';
      nodes.mic.title = label;
      nodes.mic.setAttribute('aria-label', label);
    },

    // Ступень подключения. Приходит 'mic' → 'connecting' → 'negotiating' от
    // транспорта и 'ready' из onConnected (wc-app.js). Всё, кроме 'ready', —
    // это ещё соединение: микрофон притушен, над ним «Connecting…».
    stage(name) {
      if (!nodes.mic) return;
      const ready = name === 'ready';
      nodes.mic.classList.toggle('is-connecting', !ready);
      if (!nodes.status) return;
      stopFade();
      if (!ready) {
        nodes.status.textContent = 'Connecting…';
        nodes.status.classList.remove('is-gone');
        return;
      }
      nodes.status.textContent = 'Listening';
      nodes.status.classList.remove('is-gone');
      // Гаснет, а не исчезает: строка держит свою высоту, и ряд кнопок не
      // дёргается вверх в тот момент, когда человек начинает говорить.
      fadeTimer = setTimeout(() => {
        fadeTimer = null;
        if (nodes.status) nodes.status.classList.add('is-gone');
      }, 2000);
    },

    // Заглушка, и она должна ею остаться. Строка над кнопками есть (см. шапку
    // и stage()), но пишет в неё ТОЛЬКО stage() — по ступеням соединения.
    // Раньше сюда прилетал routine-пинг «Listening. Go ahead.» на каждую
    // паузу учителя; пустить его в ту же строку значит вернуть бегущий
    // комментарий к разговору, от которого экран и уходил. Ошибки идут
    // тостом (WcUI.toast) из wc-app.js, тем же путём, что и остальные сбои
    // голосового старта.
    status() {},

    hint() {},

    // Реплика уже падает пузырём в саму ленту (WcThread.voiceUserText /
    // voiceAssistantText) — здесь дублировать её негде и незачем. Заглушка,
    // а не удалённый метод: wc-app.js вызывает её на каждый кусок голосового
    // ответа, и без неё звонок падал бы на TypeError.
    line() {},

    // Дышащего шара больше нет — говорить ему нечего. Заглушка по той же
    // причине, что у line(): чтобы onTeacherSpeaking из wc-app.js не падал.
    speaking() {},

    // Придержан микрофон на первую реплику — это не «выключен», кнопка
    // тускнеет, а не выглядит как обычный мьют. Молча придержанный микрофон
    // неотличим от сломанного, но объяснять это текстом было ровно тем
    // текстом, который эта правка убирает — тусклая кнопка и есть весь
    // сигнал теперь.
    micHeld(on) {
      held = !!on;
      if (nodes.mic) nodes.mic.classList.toggle('is-held', held);
    },

    muted(on) {
      if (!nodes.mic) return;
      nodes.mic.classList.toggle('is-muted', !!on);
      nodes.mic.replaceChildren(on ? iconMicOff() : iconMic());
      const label = on ? 'Unmute microphone' : 'Mute microphone';
      nodes.mic.title = label;
      nodes.mic.setAttribute('aria-label', label);
    },

    // Индикатор громкости ушёл вместе с шаром — заглушки, чтобы
    // onLocalStream/onRemoteStream в wc-app.js не падали.
    meterLocal() {},
    meterRemote() {},
  };

  global.WcVoiceScreen = WcVoiceScreen;
})(typeof self !== 'undefined' ? self : globalThis);
