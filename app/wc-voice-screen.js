// webchat/wc-voice-screen.js — экран голосового разговора.
//
// ── Почему экран, а не плашка ────────────────────────────────────────────────
//
// Было: карточка «Голосовой разговор» с двумя кнопками, висящая поверх
// переписки. Так не делает ни один из эталонов, и по делу: пока идёт разговор,
// человек не читает и не печатает — ему нужны крупные цели под большой палец,
// понятное «тебя слышно», и один очевидный способ положить трубку. Плашка
// поверх ленты даёт ровно обратное: мелкие кнопки и текст под ними, который
// всё равно не читают.
//
// Взято у эталонов (разбор в журнале, шаг 1):
//   · полноэкранный режим с «шаром», который дышит в такт звуку, — ChatGPT;
//   · крупные круглые органы в ряд внизу и «×» для выхода — Claude;
//   · подпись состояния словами рядом с шаром — все трое.
//
// Чего НЕ взято: ChatGPT в 2026 отказался от отдельного экрана в пользу шара
// поверх видимой переписки. Владелец попросил именно отдельный экран — это его
// решение, и оно здесь исполнено; лента с расшифровкой никуда не делась и ждёт
// за экраном.
//
// ── Про «уровень звука» ──────────────────────────────────────────────────────
// Шар дышит от РЕАЛЬНОЙ громкости, а не от таймера. Это не украшение: анимация
// «вообще» идёт одинаково и когда всё работает, и когда микрофон отвалился, а
// дышащий от сигнала шар — единственное, что отличает «тебя слышно» от «экран
// красивый, а звука нет».
(function (global) {
  'use strict';

  const { el } = WcUI;

  let host = null;
  let nodes = {};
  let hooks = {};
  let audioCtx = null;
  let meters = [];      // { analyser, data, kind }
  let raf = 0;
  let open = false;

  // Что показывать на каждой ступени подключения. Ступени названы по тому, что
  // РЕАЛЬНО происходит, а не «подождите»: подключение к голосу занимает
  // секунды по устройству протокола (несколько обменов по сети до первого
  // звука), и человеку легче ждать, когда видно, что дело движется.
  const STAGE_TEXT = {
    mic: 'Asking for the microphone…',
    connecting: 'Connecting to the teacher…',
    negotiating: 'Negotiating the connection…',
    ready: 'Listening. Go ahead.',
  };
  const STAGE_ORDER = ['mic', 'connecting', 'negotiating', 'ready'];
  const HELD_TEXT = 'One moment — listening to the teacher…';
  // Придержан ли микрофон прямо сейчас. Экран должен знать это сам: подпись
  // «говорите» и состояние «не слышу» не должны спорить друг с другом.
  let held = false;

  function stopMeters() {
    cancelAnimationFrame(raf);
    raf = 0;
    meters = [];
    if (audioCtx) { try { audioCtx.close(); } catch (_) {} audioCtx = null; }
  }

  function tick() {
    raf = requestAnimationFrame(tick);
    if (!nodes.orb) return;
    let peak = 0;
    for (const m of meters) {
      m.analyser.getByteTimeDomainData(m.data);
      let max = 0;
      for (let i = 0; i < m.data.length; i += 4) {
        const v = Math.abs(m.data[i] - 128) / 128;
        if (v > max) max = v;
      }
      if (max > peak) peak = max;
    }
    // Корень — чтобы тихая речь была видна: линейная громкость почти всё время
    // сидит у нуля и шар выглядит неподвижным.
    const amp = Math.min(1, Math.sqrt(peak) * 1.6);
    nodes.orb.style.setProperty('--wc-orb-amp', amp.toFixed(3));
  }

  function meter(stream, kind) {
    if (!stream) return;
    try {
      if (!audioCtx) audioCtx = new (global.AudioContext || global.webkitAudioContext)();
      const src = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      meters.push({ analyser, data: new Uint8Array(analyser.fftSize), kind });
      if (!raf) raf = requestAnimationFrame(tick);
    } catch (e) {
      // Без индикатора экран останется рабочим — молча, но рабочим.
      console.warn('[wc-voice-screen] audio level unavailable:', e && e.message);
    }
  }

  // «Держи и говори» вместо открытого микрофона. Живёт здесь, потому что от
  // него зависит только поведение кнопки на этом экране.
  let ptt = false;

  function build() {
    const orb = el('.wc-vs-orb', { id: 'wc-vs-orb' }, [el('.wc-vs-orb-core')]);
    const status = el('.wc-vs-status', { id: 'wc-vs-status', role: 'status', 'aria-live': 'polite', text: STAGE_TEXT.mic });
    const hint = el('.wc-vs-hint', { id: 'wc-vs-hint' });
    const line = el('.wc-vs-line', { id: 'wc-vs-line' });

    // Один орган на два способа говорить.
    //
    // Обычный разговор: микрофон открыт, кнопка его закрывает и открывает —
    // нажатие переключает.
    //
    // «Держи и говори»: микрофон закрыт, и открыт ровно пока палец на кнопке.
    // Это НЕ другой транспорт и не другая сессия — та же живая сессия, просто
    // дорожка выключена между репликами. Поэтому и кнопка та же: у неё
    // меняется способ нажатия, а не назначение.
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

    const close = el('button.wc-vs-close', {
      type: 'button', 'aria-label': 'Back to the chat', title: 'Back to the chat',
      onclick: () => hooks.onCollapse && hooks.onCollapse(),
    }, [iconChevron()]);

    nodes = { orb, status, hint, line, mic, end, close };

    return el('.wc-vs', {}, [
      el('.wc-vs-top', {}, [close]),
      el('.wc-vs-body', {}, [orb, status, hint, line]),
      el('.wc-vs-controls', {}, [mic, end]),
    ]);
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
  const iconEnd = () => svg(['M2.5 9.5a14 14 0 0 1 19 0l-2.2 2.7a2 2 0 0 1-2.6.4l-1.6-1a1.6 1.6 0 0 1-.7-1.6l.2-1.3a11 11 0 0 0-5.2 0l.2 1.3a1.6 1.6 0 0 1-.7 1.6l-1.6 1a2 2 0 0 1-2.6-.4z']);
  const iconChevron = () => svg(['M6 9l6 6 6-6']);

  const WcVoiceScreen = {
    open(h) {
      hooks = h || {};
      host = document.getElementById('wc-voice');
      host.replaceChildren(build());
      host.hidden = false;
      open = true;
      document.getElementById('wc-root').classList.add('is-voice');
      // Уводим фокус на экран: иначе он остаётся в поле ввода за экраном, и
      // экранный диктор продолжает читать переписку, которой уже не видно.
      try { nodes.end.focus({ preventScroll: true }); } catch (_) {}
    },

    close() {
      stopMeters();
      open = false;
      held = false;
      if (host) { host.hidden = true; host.replaceChildren(); }
      document.getElementById('wc-root').classList.remove('is-voice');
      nodes = {};
    },

    isOpen() { return open; },

    /** Переключить экран в «держи и говори». Выбор человека, помнится между
     *  сессиями — хранит его композер. */
    pushToTalk(on) {
      ptt = !!on;
      if (!nodes.mic) return;
      nodes.mic.classList.toggle('is-ptt', ptt);
      const label = ptt ? 'Hold to talk' : 'Mute microphone';
      nodes.mic.title = label;
      nodes.mic.setAttribute('aria-label', label);
    },

    // Ступень подключения. Пока не 'ready' — шар «ждёт», а не «слушает»: это
    // единственное честное различие между «идёт соединение» и «говорите».
    stage(name) {
      if (!nodes.status) return;
      // «Слушаю. Говорите.» нельзя показывать, пока микрофон придержан защитой
      // первой реплики: приглашать говорить туда, где тебя не слышат, — хуже,
      // чем молчать. Пока держим — так и пишем.
      if (name === 'ready' && held) { nodes.status.textContent = HELD_TEXT; return; }
      nodes.status.textContent = STAGE_TEXT[name] || STAGE_TEXT.mic;
      const idx = STAGE_ORDER.indexOf(name);
      if (nodes.orb) {
        nodes.orb.classList.toggle('is-waiting', name !== 'ready');
        nodes.orb.style.setProperty('--wc-orb-step', String(Math.max(0, idx)));
      }
    },

    status(text) { if (nodes.status) nodes.status.textContent = text; },

    hint(text) { if (nodes.hint) nodes.hint.textContent = text || ''; },

    // Последняя реплика на экране — чтобы человек видел, что его расслышали
    // правильно, не сворачивая экран ради ленты.
    line(role, text) {
      if (!nodes.line) return;
      nodes.line.textContent = text || '';
      nodes.line.classList.toggle('is-teacher', role === 'assistant');
    },

    speaking(on) {
      if (nodes.orb) nodes.orb.classList.toggle('is-speaking', !!on);
      if (on) WcVoiceScreen.status('The teacher is speaking…');
    },

    // Микрофон придержан на первую реплику — это надо СКАЗАТЬ. Молча
    // придержанный микрофон неотличим от сломанного.
    micHeld(on) {
      held = !!on;
      if (nodes.mic) nodes.mic.classList.toggle('is-held', held);
      WcVoiceScreen.hint(held ? 'The microphone comes back on as soon as the teacher finishes' : '');
      // Отпустили — теперь приглашение говорить стало правдой, и шар перестаёт
      // ждать. Оба перехода делаются здесь, а не в stage(): в этот момент
      // stage('ready') уже давно прошёл и второй раз не придёт.
      if (!held && nodes.status && nodes.status.textContent === HELD_TEXT) {
        nodes.status.textContent = STAGE_TEXT.ready;
        if (nodes.orb) nodes.orb.classList.remove('is-waiting');
      }
    },

    muted(on) {
      if (!nodes.mic) return;
      nodes.mic.classList.toggle('is-muted', !!on);
      nodes.mic.replaceChildren(on ? iconMicOff() : iconMic());
      const label = on ? 'Unmute microphone' : 'Mute microphone';
      nodes.mic.title = label;
      nodes.mic.setAttribute('aria-label', label);
    },

    meterLocal(stream) { meter(stream, 'local'); },
    meterRemote(stream) { meter(stream, 'remote'); },
  };

  global.WcVoiceScreen = WcVoiceScreen;
})(typeof self !== 'undefined' ? self : globalThis);
