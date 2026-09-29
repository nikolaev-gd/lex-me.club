// lex-open-markers.js — пометка разметки, у которой ещё не доехала пара
// (2026-09-26, перенесено из chat-surface.js без изменений в правиле).
//
// Ответ учителя приезжает кусками, и кусок часто кончается посреди пометки:
// «**Make» уже пришло, закрывающие «**» — ещё нет. Отрисовщик разметки
// показал бы эти звёздочки; здесь последняя незакрытая пометка на ПОСЛЕДНЕЙ
// строке снимается (строки выше закончены — непарная звёздочка там —
// настоящая звёздочка, как в законченном тексте), и слово стоит простым
// текстом, пока не доедет пара. Сначала код, потом жирный, потом курсив:
// «**», пришедшая пока одной «*», не считается ни тем ни другим.
//
// Один файл на расширение (chat-surface.js — голос и Live 1) и страницу
// lex-me.club/app (webchat/wc-thread.js — живой пузырь голоса). Chrome не нужен.
(function (global) {
  'use strict';
  if (global.LexOpenMarkers) return;

  function hide(text) {
    const s = String(text == null ? '' : text);
    const cut = s.lastIndexOf('\n') + 1;
    const lead = /^\s*(?:[-*]|\d+\.)\s+/.exec(s.slice(cut));
    const from = cut + (lead ? lead[0].length : 0);
    let line = s.slice(from);
    // Finished code spans are renderMarkdown's own: the stars and backticks in
    // them are no markers, so they are counted blanked out (same length —
    // indices stay the same in both strings).
    let seen = line.replace(/`[^`\n]+`/g, (m) => ' '.repeat(m.length));
    const drop = (i, n) => {
      line = line.slice(0, i) + line.slice(i + n);
      seen = seen.slice(0, i) + seen.slice(i + n);
    };
    if ((seen.match(/`/g) || []).length % 2) drop(seen.lastIndexOf('`'), 1);
    if ((seen.match(/\*\*/g) || []).length % 2) drop(seen.lastIndexOf('**'), 2);
    const singles = [...seen.matchAll(/(?<!\*)\*(?!\*)/g)];
    if (singles.length % 2) drop(singles[singles.length - 1].index, 1);
    return s.slice(0, from) + line;
  }

  global.LexOpenMarkers = { hide };
})(typeof self !== 'undefined' ? self : globalThis);
