// lex-dictation-limit.js — потолок обычной (файловой) диктовки: одно правило на
// все браузерные поверхности.
//
// ── Правило ─────────────────────────────────────────────────────────────────
//
// Запись файлом, забытая включённой, платит за каждую минуту тишины. Поэтому
// у неё есть потолок: дошла до него — запись заканчивается ТАК ЖЕ, как по
// нажатию кнопки (записанное уходит на расшифровку, а не выбрасывается), и
// человеку говорится почему. Раньше это правило стояло двумя копиями — в
// расширении (dictation.js) и на странице (wc-composer.js) — со своими
// запасными числами у каждой. Теперь число, запасной набор и таймер — здесь, а
// хозяин передаёт только «как остановить» и «чья это запись».
//
// У живой диктовки потолка на клиенте нет вовсе: его ставит сервер
// (server_config.dictation_live_max_sec), сам закрывает сессию и называет число
// в кадре «готов». Здесь только подпись этого числа для страницы (`label`).
//
// Айфон держит то же правило на Swift (AudioRecorder.armLimit), число —
// зеркалом реестра (Config.swift, сверяет dev-tools/check-dictation-parity-ios.mjs).
//
// Файл грузится и контент-скриптами расширения, и страницей, у которой
// требование — ноль обращений к API расширения во всём графе зависимостей
// (dev-tools/check-webchat-clean.sh).
(function (global) {
  'use strict';

  if (global.LexDictationLimit) return;

  // Числа микрофона живут в реестре моделей (LexModelRegistry.dictationCapture)
  // — там же, откуда их берут все браузерные поверхности, и там же, с чем
  // сверяется зеркало айфона. Здесь — единственный запасной набор на случай,
  // если реестр не загрузился: молчащий микрофон хуже, чем микрофон со
  // вчерашними числами.
  const CAPTURE_FALLBACK = Object.freeze({ minDurationMs: 300, minBlobBytes: 1000, maxDurationMs: 60000 });

  function capture() {
    const R = global.LexModelRegistry;
    return (R && R.dictationCapture) || CAPTURE_FALLBACK;
  }

  // Завести потолок файловой записи. Зовётся в миг, когда запись пошла.
  //   onFire(maxMs)  — закончить запись так же, как нажатием кнопки
  //   isStillMine()  — идёт ли ещё именно эта запись (следующая могла начаться)
  // Возвращает { maxMs, cancel() }; cancel() можно звать сколько угодно раз.
  function arm(opts) {
    const o = opts || {};
    const maxMs = Number(capture().maxDurationMs);
    let timer = null;
    const handle = {
      maxMs: maxMs > 0 ? maxMs : 0,
      cancel() { if (timer !== null) { clearTimeout(timer); timer = null; } },
    };
    if (!(maxMs > 0) || typeof o.onFire !== 'function') return handle;
    timer = setTimeout(() => {
      timer = null;
      if (typeof o.isStillMine === 'function' && !o.isStillMine()) return;
      try { o.onFire(maxMs); } catch (e) { console.warn('[lex-dictation-limit] onFire threw:', e && e.message); }
    }, maxMs);
    return handle;
  }

  // Подпись потолка для человека: целые минуты — минутами («1 minute»,
  // «2 minutes»), иначе секундами. Одна на файловый и живой потолок страницы;
  // двойник на айфоне — LiveDictation.endMessage.
  function label(ms) {
    const n = Number(ms);
    if (!(n > 0)) return '';
    return (n >= 60000 && n % 60000 === 0)
      ? (n / 60000) + (n === 60000 ? ' minute' : ' minutes')
      : Math.round(n / 1000) + ' seconds';
  }

  global.LexDictationLimit = Object.freeze({ capture, arm, label });
})(typeof self !== 'undefined' ? self : globalThis);
