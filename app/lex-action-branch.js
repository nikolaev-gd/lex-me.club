// lex-action-branch.js — КЛЮЧ ВЕТКИ ЗАГОТОВКИ ДЕЙСТВИЯ, одно тело на все реалмы.
//
// Ход через ЗАГОТОВКУ ДЕЙСТВИЯ живёт не в треде урока, а в своей ветке:
//
//     '__lex_action__' + <ключ чата> + '__' + <слот заготовки>
//
// Ключ чата — то, что отдаёт videoIdProvider() поверхности ('<vid>__<sid>' у
// видео, '__lex_standalone__<sid>' у страницы); слот — id заготовки в ячейке
// nativePrompts (lex-action-presets.js).
//
// ── ПОЧЕМУ ОТДЕЛЬНЫЙ ФАЙЛ ────────────────────────────────────────────────────
// Правило жило в video-threads.js, и там же было записано, зачем ему один дом:
// его читают ТРИ реалма (страница расширения, service worker, путь слияния
// дельты). 2026-08-25 появился ЧЕТВЁРТЫЙ — страница lex-me.club/app: заготовки
// работают и там, а chrome.storage, вокруг которого построен video-threads.js,
// на публичной странице нет вовсе. Выбор был между копией правила в вебе и
// переездом правила сюда; копия здесь стоит дороже всего остального, потому
// что промах не даёт ошибки — он показывает или сносит ЧУЖИЕ переписки.
// video-threads.js теперь делегирует сюда, своего тела у него нет.
//
// ⚠️ ГРАНИЦА МЕЖДУ КЛЮЧОМ ЧАТА И СЛОТОМ — одна пара '__', и разбирается она
// ТОЛЬКО справа: у слота '__' не бывает. Разделителя лучше нет — и ключ чата,
// и слот набраны из [A-Za-z0-9_-]. Случай, ради которого это важно: до чеканки
// ключа урока videoIdProvider() отдаёт ГОЛЫЙ id видео, и без правила «в хвосте
// нет '__'» префикс '__lex_action__<vid>__' накрыл бы ветки ВСЕХ уроков этого
// ролика ('__lex_action__<vid>__<sid>__<слот>') — снос по «Новому чату» унёс
// бы чужие переписки, а лента показала бы их вперемешку.
//
// Отсюда требование к id слота: без '__'. Сегодня оно выполняется само —
// статические слоты 'chatB1'/'chatB2', сгенерированные 'p<base36>-<rnd>'
// (lex-action-presets.js newSlotId), человек id не вводит вовсе.
//
// Регрессия — dev-tools/test-action-branch-key.mjs; тела правил она выдёргивает
// из ЭТОГО файла, а не копирует.
(function (global) {
  'use strict';

  if (global.LexActionBranch) return;

  const ACTION_BRANCH_PREFIX = '__lex_action__';
  // Легаси-литерал ветки до появления формата выше. Живых записей уже может не
  // быть, но узнавать его надо: такой ключ — тоже ветка заготовки, а не беседа.
  const LEGACY_ACTION_KEY = '__lex_native__';

  /**
   * Это ключ ветки заготовки, а не беседы? Гейт на пути облака: такие ветки
   * ездят вместе с чатом, но НЕ листаются в «Недавних».
   * @param {string} key
   * @returns {boolean}
   */
  function isActionBranchKey(key) {
    return typeof key === 'string'
      && (key === LEGACY_ACTION_KEY || key.indexOf(ACTION_BRANCH_PREFIX) === 0);
  }

  /**
   * Префикс всех веток заготовок ОДНОГО чата. Синхронный: зовущие снимают его
   * до первого await (ключ чата гаснет следующей же строкой у «Нового чата»).
   * @param {string} chatKey ключ чата (videoIdProvider())
   * @returns {string|null}
   */
  function actionBranchPrefixOf(chatKey) {
    if (typeof chatKey !== 'string' || !chatKey) return null;
    return ACTION_BRANCH_PREFIX + chatKey + '__';
  }

  /**
   * Ключ ветки конкретной заготовки этого чата.
   * @param {string} chatKey
   * @param {string} slotId id слота заготовки (без '__')
   * @returns {string|null}
   */
  function actionBranchKeyOf(chatKey, slotId) {
    const prefix = actionBranchPrefixOf(chatKey);
    if (!prefix || !slotId) return null;
    return prefix + slotId;
  }

  /**
   * Принадлежит ли ключ ветки этому чату — правило разбора в одном месте
   * (см. врезку выше про хвост без '__').
   * @param {string} key
   * @param {string} prefix из actionBranchPrefixOf
   * @returns {boolean}
   */
  function actionBranchBelongsTo(key, prefix) {
    if (typeof key !== 'string' || !prefix || key.indexOf(prefix) !== 0) return false;
    const slot = key.slice(prefix.length);
    return !!slot && slot.indexOf('__') === -1;
  }

  global.LexActionBranch = {
    ACTION_BRANCH_PREFIX,
    LEGACY_ACTION_KEY,
    isActionBranchKey,
    actionBranchPrefixOf,
    actionBranchKeyOf,
    actionBranchBelongsTo,
  };
})(typeof window !== 'undefined' ? window : self);
