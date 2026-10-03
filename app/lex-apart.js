// lex-apart.js — отдельный разговор заготовки на устройстве: расширение (все
// три окна и воркер), страница lex-me.club/app и программа для Мака.
//
// Заготовка в режиме «отдельный разговор» ведёт в каждом чате свою беседу:
// своё дерево реплик под ключом '__lex_preset__<ключ чата>__<слот>'. Куда
// уходит ход, решает сервер (llm-proxy, по режиму заготовки в каталоге) и
// сообщает первым кадром ответа (apartKey); выдача беседы урока (list_turns)
// отдаёт беседы его заготовок полем apart. Здесь — только то, что устройству
// нужно, чтобы держать эти беседы отдельно от урока и показать их в его ленте:
//
//   • разбор ключа — тот же, что у сервера (supabase/functions/_shared/apart-key.ts)
//     и у базы (public.lex_apart_lesson_key); векторы проверки общие
//     (dev-tools/test-lex-apart.mjs);
//   • merge — поставить ходы бесед заготовок в ленту урока. ГДЕ стоит каждый
//     вопрос, решил сервер: after_uid — сообщение урока, после которого его
//     показать (пусто — в начале ленты), anchor_at — порядок среди вопросов,
//     заданных под тем же сообщением. Устройство только вставляет. Сообщения
//     after_uid нет в показанной ленте урока — вопрос задан на другой ветке
//     урока и не показывается, как не показываются ходы под скрытой версией.
//
// Учителю ходы этих бесед не уходят никогда: они лежат под своим ключом, а
// переписку учителя (текст и голос) собирают из ключа урока.
(function (root) {
  'use strict';

  const PREFIX = '__lex_preset__';
  const SLOT_RE = /^[A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*$/;
  const KEY_RE = /^__lex_preset__(.+)__([A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*)$/;
  const VIDEO_KEY_RE = /^[A-Za-z0-9_-]{11}(?:__[0-9]+)?$/;

  // Вид ключа чата — то же правило, что public.lex_chat_key_kind.
  function chatKeyKind(key) {
    if (typeof key !== 'string' || !key) return null;
    if (key === '__lex_standalone__') return 'legacy';
    if (key.indexOf('__lex_standalone__') === 0) return 'standalone';
    if (key.indexOf('__lex_') === 0) return null;
    return VIDEO_KEY_RE.test(key) ? 'video' : null;
  }

  // Ключ беседы заготовки в этом чате; null — чат или слот не годятся.
  function keyOf(lessonKey, slot) {
    const kind = chatKeyKind(lessonKey);
    if (kind !== 'video' && kind !== 'standalone') return null;
    if (typeof slot !== 'string' || !SLOT_RE.test(slot)) return null;
    return PREFIX + lessonKey + '__' + slot;
  }

  // Чат и слот беседы заготовки по её ключу; null — ключ не такой.
  function lessonOf(key) {
    if (typeof key !== 'string' || key.indexOf(PREFIX) !== 0) return null;
    const m = KEY_RE.exec(key);
    if (!m) return null;
    const kind = chatKeyKind(m[1]);
    if (kind !== 'video' && kind !== 'standalone') return null;
    return { lessonKey: m[1], slot: m[2] };
  }

  function isKey(key) { return !!lessonOf(key); }

  // Начало ключей всех бесед заготовок одного чата.
  function prefixOf(lessonKey) { return PREFIX + String(lessonKey || '') + '__'; }

  // Ключ принадлежит беседе заготовки ЭТОГО чата.
  function belongsTo(key, lessonKey) {
    const p = lessonOf(key);
    return !!(p && p.lessonKey === lessonKey);
  }

  // Время как число миллисекунд: строка ISO из выдачи или число из своей копии.
  function msOf(v) {
    if (v == null || v === '') return 0;
    const n = typeof v === 'number' ? v : Date.parse(String(v));
    return Number.isFinite(n) ? n : 0;
  }

  // Ленту урока и беседы его заготовок — одной лентой показа.
  //
  //   lessonTurns — показанные реплики урока по порядку (уже на выбранной ветке);
  //   threads     — [{ key, turns }] — у каждой беседы заготовки её показанные
  //                 реплики по порядку; у вопроса afterUid и anchorAt (их
  //                 считает сервер, у живого хода — первый кадр ответа).
  //
  // Возвращает новый список: урок как был, и после каждой его реплики —
  // обмены заготовок, заданные под ней. Каждая реплика заготовки — копия с
  // полем threadKey (ключ её беседы). Входные массивы не меняются.
  function merge(lessonTurns, threads) {
    const lesson = Array.isArray(lessonTurns) ? lessonTurns : [];
    const groups = new Map();   // '' — в начале ленты; иначе uid реплики урока
    let order = 0;
    for (const th of (Array.isArray(threads) ? threads : [])) {
      if (!th || !th.key || !Array.isArray(th.turns)) continue;
      let cur = null;
      for (const t of th.turns) {
        if (!t || (t.role !== 'user' && t.role !== 'assistant')) continue;
        if (t.role === 'user' || !cur) {
          const after = (t.role === 'user' && t.afterUid) ? String(t.afterUid) : '';
          cur = {
            after,
            at: msOf(t.anchorAt) || msOf(t.at),
            key: String(th.key),
            seq: order++,
            turns: [],
          };
          if (!groups.has(after)) groups.set(after, []);
          groups.get(after).push(cur);
        }
        cur.turns.push(Object.assign({}, t, { threadKey: String(th.key) }));
      }
    }
    for (const list of groups.values()) {
      list.sort((a, b) => (a.at - b.at) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) || (a.seq - b.seq));
    }
    const out = [];
    const flush = (after) => {
      const list = groups.get(after);
      if (!list) return;
      for (const ex of list) for (const t of ex.turns) out.push(t);
    };
    flush('');
    for (const t of lesson) {
      out.push(t);
      if (t && t.uid) flush(String(t.uid));
    }
    // Вопросы под сообщениями урока, которых в показанной ленте нет (другая
    // ветка урока), сюда не попадают: до их группы обход ленты не доходит.
    return out;
  }

  const api = { PREFIX, chatKeyKind, keyOf, lessonOf, isKey, prefixOf, belongsTo, msOf, merge };
  root.LexApart = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
