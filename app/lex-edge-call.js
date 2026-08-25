// lex-edge-call.js — ОДИН способ позвать edge-функцию Lex и разобрать ответ.
//
// Зачем отдельный файл. Один и тот же кусок лежал ДОСЛОВНО в трёх местах:
// `callSettingsPublish` и `callPromptsAdmin` в service worker'е расширения и
// адаптер `promptsAdmin` на странице `lex-me.club/app` (у неё worker'а нет и
// она ходит в функции сама, своим токеном). Три копии — три места, где
// расходится разбор ответа; а разбор здесь не косметика: по нему клиент
// отличает «не редактор» (403) от «сервер недоступен» (0) и от «отказ по делу».
//
// Форма ответа — ровно та, что уже была у всех трёх, менять её нельзя:
//   успех → { ok: true, ...тело ответа }
//   отказ → { error: <строка>, status: <HTTP-код>, stage?: <стадия> }
//
// Две вещи, которые легко потерять при сведении и которые здесь сохранены:
//
//   1. `status: 0` + `stage: 'network'` — ЭТО НЕ HTTP-ОТВЕТ. Так помечается
//      случай, когда fetch бросил и ответа не было вовсе (офлайн, DNS, CORS).
//      Единственный случай, когда клиенту честно говорить «не достучались до
//      сервера»; на любом реальном коде так говорить нельзя — сервер ответил.
//   2. Заголовок стадии у двух функций РАЗНЫЙ (`x-lex-publish-stage` против
//      `x-lex-prompts-stage`), и это наблюдаемое снаружи различие. Поэтому
//      стадия читается из ТЕЛА ответа (поле `stage`, оно общее), а заголовок
//      не трогается вовсе — иначе сведение молча поменяло бы одну из функций.
//
// Токен и ключи НЕ добываются здесь: у расширения и у страницы они берутся
// по-разному (`authValidToken()` против `LexWebAuth.validToken()`). Зовущий
// передаёт их готовыми — так у модуля нет ни одного имени чужой поверхности.
(function (global) {
  'use strict';

  if (global.LexEdgeCall) return;

  // fnName — имя функции ('prompts-admin' / 'settings-publish'), не полный
  // адрес: базу даёт зовущий, и она разная у дев-стенда и у прода.
  async function callEdgeJson(fnName, body, opts) {
    const o = opts || {};
    const token = o.token;
    if (!token) return { error: 'login', status: 401 };

    let resp;
    try {
      resp = await fetch(String(o.baseUrl || '').replace(/\/+$/, '') + '/functions/v1/' + fnName, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          apikey: o.anonKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      // Настоящий сбой транспорта — ответа не было. См. п.1 в шапке.
      try { if (global.lexLog) global.lexLog('[lex-edge-call] ' + fnName + ': fetch threw', e); } catch (_) { /* noop */ }
      return { error: String((e && e.message) || e), status: 0, stage: 'network' };
    }

    const json = await resp.json().catch(() => null);
    if (!resp.ok) {
      const out = { error: (json && json.error) || ('HTTP ' + resp.status), status: resp.status };
      // Стадия — из тела; у обеих функций поле называется одинаково.
      if (json && typeof json.stage === 'string' && json.stage) out.stage = json.stage;
      return out;
    }
    return Object.assign({ ok: true }, json || {});
  }

  global.LexEdgeCall = Object.freeze({ callEdgeJson });
})(typeof self !== 'undefined' ? self : globalThis);
