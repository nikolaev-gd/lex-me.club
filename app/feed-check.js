// voice/feed-check.js — LexVoiceFeedCheck: отстала ли лента от беседы после
// голосового разговора (2026-10-14). Один на расширение (chat-surface.js) и
// страницу lex-me.club/app (webchat/wc-app.js).
//
// Реплики голосового разговора пишет в беседу сервер (слушатель звонка), а на
// экран они едут отдельно — событиями по каналу разговора. Событие может не
// доехать: канал переподключался, слушатель встал на звонок поздно, рассылка
// стояла. Тогда в беседе реплика есть, а в ленте её нет или она оборвана.
// Поверхность, когда разговор кончился, читает беседу с сервера и спрашивает
// здесь, чего на экране не хватает; есть пропуски — рисует беседу заново, как
// при её открытии.
//
// Здесь только правило сравнения, без DOM и без chrome.*: что показано, модулю
// говорит поверхность (shownTextOf).
(function (global) {
  'use strict';
  if (global.LexVoiceFeedCheck) return;

  // Только буквы и цифры: разметка ответа (**…**), пометки ('[voice] ') и
  // пробелы на экране и в беседе расходятся законно.
  function core(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  }

  // Сколько последних букв записанной реплики обязано стоять на экране.
  const TAIL = 24;

  // turns — реплики беседы с сервера ({uid, role, content} у расширения,
  // {uid, role, text} у страницы), уже на выбранной цепочке. shownTextOf(uid)
  // — текст пузыря с этим уидом на экране (без подписи автора) или null, если
  // пузыря нет. Ответ: уиды реплик голоса ('voice:…'), которых на экране нет
  // или которые там не дописаны.
  //
  // Ответ учителя, показанный НАЧАЛОМ записанного, — не пропуск: так лента
  // держит ответ, оборванный стопом человека, а слушатель пишет его в беседу
  // целиком. У реплики человека такой поблажки нет: её начало на экране — это
  // как раз застрявший пузырь «What does».
  function missingVoiceTurns(turns, shownTextOf) {
    const out = [];
    for (const t of (Array.isArray(turns) ? turns : [])) {
      if (!t || !t.uid || String(t.uid).indexOf('voice:') !== 0) continue;
      const want = core(t.content != null ? t.content : t.text);
      if (!want) continue;
      let shownRaw = null;
      try { shownRaw = shownTextOf(String(t.uid)); } catch (_) { shownRaw = null; }
      const shown = core(shownRaw);
      const whole = !!shown && shown.includes(want.slice(-TAIL));
      const cutByStop = t.role === 'assistant' && shown.length >= 12 && want.includes(shown.slice(-TAIL));
      if (!whole && !cutByStop) out.push(String(t.uid));
    }
    return out;
  }

  // Когда сверять: последний ответ слушатель дописывает в беседу уже после
  // отбоя, поэтому дважды.
  const DELAYS_MS = [3000, 12000];

  global.LexVoiceFeedCheck = { missingVoiceTurns, DELAYS_MS };
})(typeof self !== 'undefined' ? self : globalThis);
