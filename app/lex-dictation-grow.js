// lex-dictation-grow.js — ОДНО правило роста надиктованного текста в поле ввода
// для браузерных поверхностей (расширение: окно учителя, суперчат, попап
// произношения; страница lex-me.club/app и программа для Мака). Айфон держит
// то же самое на Swift — ios/Lex/Lex/DictationField.swift, поведение одно; их
// совпадение шаг за шагом сверяет dev-tools/check-dictation-grow-parity-ios.mjs.
//
// ── Что это ─────────────────────────────────────────────────────────────────
//
// Пока распознавалка работает, в поле растёт кусок текста; потом приходит итог
// и встаёт на его место. Человек при этом может печатать, стирать, отправлять,
// нажимать микрофон снова, пока прошлая запись ещё договаривает. Этот модуль
// решает, чем стать полю на каждый кусок и на каждый итог. Сам он в поле не
// пишет: на вход — что в поле сейчас, на выход — чем ему стать (или «не
// трогать»). Фокус, каретку, высоту поля делает хозяин.
//
// ── Главное: учёт ведётся на ПОЛЕ, а не на запись ──────────────────────────
//
// Раньше у каждой записи был свой учёт, и «поле тронули» он определял как «в
// поле не то, что я написал последним». Итог прошлой записи, пришедший, пока
// растёт новая, для учёта новой выглядел ровно как правка человека — и рост
// новой замирал до её «стоп» (то же на всех трёх поверхностях). Теперь учёт
// один на поле: в нём основание (что было до наших записей) и куски записей
// по порядку их начала. Пишет ли в поле прошлая запись или новая — это наша
// запись, и все участники остаются живыми. Правкой человека считается только
// расхождение поля с последней записью учёта.
//
// ── Правка человека ─────────────────────────────────────────────────────────
//
// Человек тронул поле — рост всех растущих кусков прекращается (дописывать в
// поле, где человек печатает, нельзя). Итог такой записи всё равно встаёт НА
// МЕСТО своего выросшего куска, если тот стоит в поле, — иначе текст оказался
// бы в поле дважды. Место кусок помнит с поправкой на саму правку (набранное
// перед ним сдвигает его, набранное после — нет), и из нескольких одинаковых
// вхождений берётся ближайшее к этому месту, а не последнее: короткая фраза,
// повторённая следующей записью, иначе заменила бы чужой кусок. Пока учёт цел
// (растут записи, начатые после правки), итог ищет своё место только в
// основании — внутрь растущего куска соседки он не встаёт никогда.
//
// ── Два вида итога ──────────────────────────────────────────────────────────
//
//   finish       — итог «стоп»: на место выросшего куска; куска в поле нет —
//                  дописывается, по порядку записей. Возвращает новое значение
//                  поля всегда.
//   serverFinal  — итог конца, объявленного сервером (потолок, сторож, обрыв):
//                  строже. Запись не росла — дописывается; росла — только на
//                  место выросшего, дописать нельзя (человек мог отправить
//                  выросшее, пока итог ехал, и текст вернулся бы в пустое поле);
//                  итог сервера без потолка в «готов» (старый сервер, без
//                  последнего отрезка) не ставится вовсе. `null` — поле не
//                  трогать.
//
// У одной записи итог один: второй итог (или итог после «бросили») поле не
// трогает. Пустой итог — тоже. Итог подрезается по краям от пробелов.
//
// Файл грузится и веб-страницей, у которой требование — ноль `chrome.*` во всём
// графе (dev-tools/check-webchat-clean.sh); DOM здесь тоже нет: модуль гоняется
// в node (dev-tools/test-dictation-grow.mjs).
(function (global) {
  'use strict';

  if (global.LexDictationGrow) return;

  // Склейка «что было + новое» через ОДИН пробел. Пустое основание (или из
  // одних пробелов и переводов строки) — просто новое; хвостовые пробелы
  // основания срезаются. «Пробел» — ровно тот набор, что у trim()/\s в
  // JavaScript; айфонный двойник держит этот же набор явно.
  function compose(base, text) {
    const b = String(base == null ? '' : base);
    const t = String(text == null ? '' : text);
    return b.trim().length === 0 ? t : b.replace(/\s+$/, '') + ' ' + t;
  }

  // Вхождение `needle` в `hay`, ближайшее к позиции `near`; -1 — нет.
  function nearestIndexOf(hay, needle, near) {
    if (!needle) return -1;
    let best = -1;
    let bestD = Infinity;
    for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) {
      const d = Math.abs(i - near);
      if (d < bestD) { best = i; bestD = d; }
    }
    return best;
  }

  // Где кусок [at, at+len) строки `before` оказался в `after` после правки
  // человека: общее начало не сдвигает его, общий конец сдвигает на разницу
  // длин. Кусок внутри правленого места — прежняя позиция (дальше решит поиск
  // ближайшего вхождения).
  function shiftedPos(before, after, at, len) {
    if (at < 0) return at;
    const max = Math.min(before.length, after.length);
    let p = 0;
    while (p < max && before.charCodeAt(p) === after.charCodeAt(p)) p++;
    let s = 0;
    while (s < max - p && before.charCodeAt(before.length - 1 - s) === after.charCodeAt(after.length - 1 - s)) s++;
    if (at + len <= p) return at;
    if (at >= before.length - s) return at + (after.length - before.length);
    return at;
  }

  // field() → учёт одного поля ввода. Запись (живая или файловая) заводится
  // begin() и дальше называется своим номером; номера растут по порядку начала.
  function field() {
    let base = '';
    let lastWritten = null;       // что стало в поле после нашей последней записи
    let pieces = [];              // [{ id, text, frozen, at }] по порядку начала записей
    const detached = new Map();   // id → { text, at }: росла, но человек тронул поле
    const done = new Set();       // у этих записей итог уже был (или их бросили)
    let seq = 0;

    const find = (id) => pieces.find((p) => p.id === id) || null;
    const touchedByHuman = (current) => lastWritten !== null && current !== lastWritten;
    const clean = (text) => String(text == null ? '' : text).trim();

    function recompose() {
      let v = base;
      for (const p of pieces) {
        if (!p.text) { p.at = -1; continue; }
        const next = compose(v, p.text);
        p.at = next.length - p.text.length;
        v = next;
      }
      lastWritten = v;
      // Все куски застыли — сворачиваем их в основание: учёт снова пуст.
      if (pieces.every((p) => p.frozen)) { base = v; pieces = []; }
      return v;
    }

    // Человек тронул поле: растущие куски отцепляются (помнят свой текст и
    // место, поправленное на эту правку), застывшие больше не нужны. Учёт
    // начинается заново от того, что в поле сейчас.
    function detachAll(current) {
      for (const p of pieces) {
        if (p.frozen || !p.text) continue;
        const at = lastWritten !== null ? shiftedPos(lastWritten, current, p.at, p.text.length) : p.at;
        detached.set(p.id, { text: p.text, at });
      }
      pieces = [];
      lastWritten = null;
      base = '';
    }

    function replaceNear(current, d, text) {
      const at = nearestIndexOf(current, d.text, d.at);
      if (at < 0) return null;
      return current.slice(0, at) + text + current.slice(at + d.text.length);
    }

    // Итог записи, которая не росла (или чей кусок из поля ушёл): дописать.
    // Застывшим куском учёта — на место по порядку начала записей, чтобы
    // растущие соседи не сочли эту запись правкой человека.
    function appendFinal(id, text, current) {
      if (touchedByHuman(current)) detachAll(current);
      if (lastWritten === null) base = current;
      const p = find(id);
      if (p) {
        p.text = text;
        p.frozen = true;
      } else {
        const np = { id, text, frozen: true, at: -1 };
        const i = pieces.findIndex((x) => x.id > id);
        if (i < 0) pieces.push(np); else pieces.splice(i, 0, np);
      }
      return recompose();
    }

    // Итог отцепленной записи — на место её куска. Учёт цел (в поле ровно наша
    // последняя запись: растут записи, начатые после правки) — кусок лежит в
    // ОСНОВАНИИ, и только там его и ищем: внутри растущей соседки его нет по
    // определению. Поле тронуто снова — отцепляем всех и ищем прямо в поле.
    // Не нашёлся — null.
    function placeDetached(d, text, current) {
      if (lastWritten !== null && !touchedByHuman(current)) {
        const at = nearestIndexOf(base, d.text, d.at);
        if (at < 0) return null;
        base = base.slice(0, at) + text + base.slice(at + d.text.length);
        return recompose();
      }
      if (touchedByHuman(current)) detachAll(current);
      return replaceNear(current, d, text);
    }

    return {
      begin() { seq += 1; return seq; },

      // Очередной кусок: текст записи на этот миг целиком. Возвращает, чем
      // стать полю, или null — не писать (человек тронул поле, итог уже был,
      // пусто).
      push(id, sofar, current) {
        const cur = String(current == null ? '' : current);
        if (detached.has(id) || done.has(id) || !sofar) return null;
        if (touchedByHuman(cur)) {
          detachAll(cur);
          if (detached.has(id)) return null;
        }
        if (lastWritten === null) base = cur;
        let p = find(id);
        if (!p) { p = { id, text: '', frozen: false, at: -1 }; pieces.push(p); }
        if (p.frozen) return null;
        p.text = String(sofar);
        return recompose();
      },

      // Итог «стоп». Всегда возвращает значение поля.
      finish(id, text, current) {
        const cur = String(current == null ? '' : current);
        const t = clean(text);
        if (!t || done.has(id)) return cur;
        done.add(id);
        const d = detached.get(id);
        if (d) {
          detached.delete(id);
          const v = placeDetached(d, t, cur);
          return v !== null ? v : appendFinal(id, t, cur);
        }
        const p = find(id);
        if (!p || !p.text) return appendFinal(id, t, cur);
        if (touchedByHuman(cur)) {
          detachAll(cur);
          const dd = detached.get(id);
          detached.delete(id);
          const v = dd ? replaceNear(cur, dd, t) : null;
          return v !== null ? v : appendFinal(id, t, cur);
        }
        p.text = t;
        p.frozen = true;
        return recompose();
      },

      // Итог конца, объявленного сервером. `hasCap` — был ли потолок в кадре
      // «готов» (есть — сервер новый). null — поле не трогать.
      serverFinal(id, text, current, opts) {
        const cur = String(current == null ? '' : current);
        const t = clean(text);
        if (!t || done.has(id)) return null;
        done.add(id);
        const d = detached.get(id);
        const p = find(id);
        const grown = d ? d.text : (p ? p.text : '');
        if (!grown) return appendFinal(id, t, cur);
        if (!(opts && opts.hasCap)) {
          detached.delete(id);
          if (p) { p.frozen = true; if (!touchedByHuman(cur)) recompose(); }
          return null;
        }
        if (d) { detached.delete(id); return placeDetached(d, t, cur); }
        if (touchedByHuman(cur)) {
          detachAll(cur);
          const dd = detached.get(id);
          detached.delete(id);
          return dd ? replaceNear(cur, dd, t) : null;
        }
        p.text = t;
        p.frozen = true;
        return recompose();
      },

      // Запись бросили (без итога): её кусок остаётся в поле как есть.
      forget(id) {
        done.add(id);
        detached.delete(id);
        const p = find(id);
        if (p) { p.frozen = true; if (lastWritten !== null) recompose(); }
      },

      // Сам выросший кусок этой записи — для хозяина, которому надо знать, росла ли.
      grown(id) {
        const d = detached.get(id);
        if (d) return d.text;
        const p = find(id);
        return p ? p.text : '';
      },
    };
  }

  global.LexDictationGrow = Object.freeze({ field, compose });
})(typeof self !== 'undefined' ? self : globalThis);
