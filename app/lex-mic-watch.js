// lex-mic-watch.js — ОДНО правило «микрофон у живого разговора отобрали» для
// браузерных поверхностей: расширение и страница lex-me.club/app (её же
// показывает программа для Мака). У айфона своё, родное: VoiceSession.swift
// кладёт трубку на прерывании аудиосессии.
//
// ── Решение владельца ──────────────────────────────────────────────────────
//
// Другое приложение забрало микрофон — трубка кладётся СРАЗУ, возвращения
// микрофона не ждём, человеку говорится почему. Иначе он говорит в пустоту, а
// деньги идут.
//
// ── Чем ловится, и почему только этим ──────────────────────────────────────
//
// Ложное срабатывание здесь хуже несработки: оно обрывает живой разговор.
// Поэтому признак ОДИН, и он от самого браузера, а не догадка по звуку:
//
//   дорожка микрофона КОНЧИЛАСЬ ('ended'), а взять микрофон заново не дали.
//   Браузер кончает дорожку, когда устройство пропало или захват сломался:
//   вынули гарнитуру, отключились наушники с микрофоном, отозвали разрешение,
//   устройство забрали в монопольное владение (так делает Windows). Наушники —
//   это ОБЫЧНОЕ дело, и трубку из-за них класть нельзя. Поэтому сначала
//   пробуем взять микрофон заново, тот, что сейчас по умолчанию: взяли —
//   разговор идёт дальше на новой дорожке, человек ничего не замечает; не
//   дали (устройство занято, запрещено, его нет) — трубка. Второй конец
//   дорожки в течение 10 с после такой подмены — трубка без новой попытки:
//   устройство, которое умирает сразу после подмены, отобрано, а не
//   переключено.
//
// Чего здесь нет, и нарочно:
//   • ЗАГЛУШЁННОЙ дорожки ('mute'). Им браузер помечает и прерывание захвата
//     другим приложением, и заглушение САМИМ ЧЕЛОВЕКОМ: кнопка на гарнитуре,
//     нажатие на ножку AirPods, значок микрофона в Safari и в окне WebKit.
//     По дорожке одно от другого не отличить, а оборвать разговор человеку,
//     который просто заглушил себя, с надписью «микрофон забрало другое
//     приложение» — ровно то ложное срабатывание, которого быть не должно.
//     Заглушённый и так и не оживший разговор закрывает сервер сроком тишины.
//     До 2026-09-11 здесь стояло «заглушена дольше 2 с — трубка»; снято по
//     этой причине. События пишутся в журнал — для разбора, не для решения.
//     Своя кнопка «заглушить микрофон» страницы сюда не относится вовсе: она
//     выключает дорожку (enabled=false), и браузер 'mute' на это не даёт —
//     проверено живьём в Chrome;
//   • тишины в звуке — пауза в речи, выкрученная в ноль громкость и
//     собственная кнопка «заглушить» дают ту же тишину, что и отобранный
//     микрофон. Долгую тишину закрывает сервер своим сроком;
//   • devicechange — он приходит на любое подключение наушников;
//   • прерванного AudioContext — оно про звук на выход, не про микрофон.
//
// На Маке в Chrome другое приложение обычно НЕ отбирает микрофон вовсе:
// устройство общее, звук продолжает идти в браузер. Там и ловить нечего —
// учитель человека слышит.
//
// ── Граница ────────────────────────────────────────────────────────────────
//
// Как взять микрофон заново, как подставить новую дорожку в соединение и что
// делать при потере — решает тот, кто следит, параметрами. Здесь — только
// правило и его числа. Ни chrome.*, ни слов про сервер: файл грузится и
// веб-страницей (dev-tools/check-webchat-clean.sh). Поведение стережёт
// dev-tools/test-mic-watch.mjs.
(function (global) {
  'use strict';

  if (global.LexMicWatch) return;

  // Сколько ждать новый микрофон. Висящий запрос — это тоже «не дали».
  const REACQUIRE_TIMEOUT_MS = 4000;
  // Вторая смерть дорожки в этом окне после подмены — потеря без попытки.
  const RECOVERY_WINDOW_MS = 10000;

  const now = () => ((global.performance && typeof global.performance.now === 'function')
    ? global.performance.now() : Date.now());

  function stopStream(stream) {
    try { if (stream && stream.getTracks) stream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} }); } catch (_) {}
  }

  // watch(track, { reacquire, onReplaced, onLost, log }) → { stop(), track }
  //
  //   track      — дорожка микрофона, которая сейчас идёт в разговор.
  //   reacquire  — () => Promise<MediaStream>: взять микрофон заново (тот, что
  //                по умолчанию, с теми же ограничениями). Без неё конец
  //                дорожки — сразу потеря.
  //   onReplaced — (stream, track) => void | Promise: подставить новую дорожку
  //                в соединение. Бросила — это потеря, новый поток гасится.
  //   onLost     — (kind, detail) => void: микрофона нет, класть трубку.
  //                kind — 'ended'. Зовётся не больше одного раза.
  //   log        — (…args) => void, необязателен.
  //
  // stop() снимает слежку; повторный вызов ничего не делает. Поток, который
  // придёт от reacquire уже после stop(), гасится сразу — микрофон не
  // останется занятым за закрытым разговором.
  function watch(track, opts) {
    const o = opts || {};
    if (!track || typeof track.addEventListener !== 'function') {
      throw new TypeError('LexMicWatch.watch: a MediaStreamTrack is required');
    }
    if (typeof o.onLost !== 'function') {
      throw new TypeError('LexMicWatch.watch: onLost must be a function');
    }
    const log = (...a) => { try { if (typeof o.log === 'function') o.log(...a); } catch (_) {} };

    let current = null;
    let stopped = false;
    let recovering = false;
    let lastRecoveryAt = -Infinity;

    // Только в журнал: заглушить мог и сам человек (см. шапку).
    function onMute() { if (!stopped) log('microphone muted by the system or by the person — not a loss, the conversation goes on'); }
    function onUnmute() { if (!stopped) log('microphone unmuted'); }
    function onEnded() {
      if (stopped || recovering) return;
      recover();
    }

    function attach(t) {
      detach();
      current = t;
      t.addEventListener('ended', onEnded);
      t.addEventListener('mute', onMute);
      t.addEventListener('unmute', onUnmute);
      // Дорожка могла умереть раньше, чем за ней начали следить: событие уже
      // прошло и второй раз не придёт.
      if (t.readyState === 'ended') onEnded();
    }
    function detach() {
      if (!current) return;
      try {
        current.removeEventListener('ended', onEnded);
        current.removeEventListener('mute', onMute);
        current.removeEventListener('unmute', onUnmute);
      } catch (_) {}
      current = null;
    }
    function lose(kind, detail) {
      if (stopped) return;
      stopped = true;
      detach();
      log('microphone lost:', kind, detail || '');
      try { o.onLost(kind, detail || null); } catch (_) {}
    }

    async function recover() {
      if (typeof o.reacquire !== 'function') { lose('ended', { why: 'no-reacquire' }); return; }
      if (now() - lastRecoveryAt < RECOVERY_WINDOW_MS) { lose('ended', { why: 'ended-again' }); return; }
      recovering = true;
      detach();
      log('microphone track ended — asking for the microphone again');
      let stream = null;
      let error = null;
      let timedOut = false;
      try {
        stream = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { timedOut = true; reject(new Error('timeout')); }, REACQUIRE_TIMEOUT_MS);
          Promise.resolve().then(() => o.reacquire()).then(
            (s) => { clearTimeout(timer); if (timedOut) stopStream(s); else resolve(s); },
            (e) => { clearTimeout(timer); reject(e); },
          );
        });
      } catch (e) { error = e; }
      recovering = false;
      if (stopped) { stopStream(stream); return; }
      const fresh = stream && stream.getAudioTracks ? stream.getAudioTracks()[0] : null;
      if (!fresh || fresh.readyState === 'ended') {
        stopStream(stream);
        lose('ended', { why: 'reacquire-failed', error: timedOut ? 'timeout' : ((error && (error.name || error.message)) || 'no-track') });
        return;
      }
      try {
        if (typeof o.onReplaced === 'function') await o.onReplaced(stream, fresh);
      } catch (e) {
        stopStream(stream);
        lose('ended', { why: 'replace-failed', error: (e && (e.name || e.message)) || '' });
        return;
      }
      if (stopped) { stopStream(stream); return; }
      lastRecoveryAt = now();
      log('microphone back on a fresh track — the conversation goes on');
      attach(fresh);
    }

    attach(track);

    return {
      stop() { stopped = true; detach(); },
      get track() { return current; },
    };
  }

  global.LexMicWatch = Object.freeze({
    watch,
    REACQUIRE_TIMEOUT_MS,
    RECOVERY_WINDOW_MS,
  });
})(typeof self !== 'undefined' ? self : globalThis);
