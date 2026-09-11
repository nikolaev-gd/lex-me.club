// lex-dictation-catalog.js — какие распознавалки диктовки есть, какая из них
// живая и на какой частоте звука она слушает.
//
// ── Откуда это знание ───────────────────────────────────────────────────────
//
// Из строк таблицы моделей в базе (`public.models`, колонки `dictation`,
// `sample_rate_hz`, `dictation_fields`, `price_estimated`), а не из списка на
// клиенте. Раньше
// список жил у каждого приложения своим: реестр моделей у браузеров и его
// зеркало у айфона, — и шестая распознавалка требовала правки всех клиентов и
// новой сборки айфона. Теперь её добавляют правкой сервера и строкой в базе;
// приложения узнают о ней сами, при следующем чтении каталога.
//
// Сервер держит свой перечень (supabase/functions/_shared/dictation-fields.ts)
// — по нему он раскладывает ручки в поля поставщика. Совпадение строк базы с
// ним стережёт dev-tools/check-dictation-fields-parity.mjs.
//
// ── Две половины ────────────────────────────────────────────────────────────
//
//   • `fetchRows` — один запрос к базе на все браузерные поверхности. Его зовёт
//     тот, у кого пропуск аккаунта: фоновый воркер расширения и фоновый слой
//     страницы. Айфон повторяет ровно этот адрес (`PATH`) — сверяет
//     dev-tools/check-dictation-parity-ios.mjs.
//   • остальное — память и ответы для интерфейса и микрофона. Источник строк
//     задаёт хозяин (`setSource`): расширение спрашивает свой воркер, страница —
//     свой фоновый слой.
//
// ── Когда каталога нет ──────────────────────────────────────────────────────
//
// Пустой ответ базы неотличим от «строк нет» (невошедшему политика отдаёт
// пустой массив), а настоящий каталог пустым не бывает, — поэтому пустота
// считается отказом, а не каталогом. Пока каталога нет, хранимое имя модели
// НЕ подменяется умолчанием: иначе выбор человека молча превратился бы в
// чужую модель от одной неудачной загрузки. Микрофон без каталога не
// стартует и говорит почему — угадывать путь (живой или файловый) нельзя.
//
// Файл грузится и воркером расширения (importScripts), и страницей, у которой
// требование — ноль обращений к API расширения во всём графе зависимостей
// (dev-tools/check-webchat-clean.sh). Поэтому здесь обычный скрипт без export
// и без единого имени из API браузерного расширения.
(function (global) {
  'use strict';

  if (global.LexDictationCatalog) return;

  // Наши имена ручек — те же, что у сервера (DictationField в
  // dictation-fields.ts).
  const FIELD_NAMES = Object.freeze(['language', 'languages', 'keywords', 'prompt', 'stream',
    'delay', 'mode', 'timestamps', 'diarization', 'liveText']);
  const NO_FIELDS = Object.freeze(FIELD_NAMES.reduce((o, f) => { o[f] = false; return o; }, {}));

  // Порядок — порядок появления строк: новая распознавалка встаёт в конец
  // списка настроек, старые не переставляются.
  const SELECT = 'api_model,dictation,sample_rate_hz,dictation_fields,price_estimated';
  const PATH = '/rest/v1/models?select=' + SELECT
    + '&dictation=not.is.null&order=created_at.asc,internal_id.asc';

  // Сколько живёт прочитанный каталог в памяти приложения. Распознавалки
  // меняются редко; час ожидания новой строки никому не нужен, десять минут —
  // достаточно.
  const TTL_MS = 10 * 60 * 1000;
  // Срок на весь ответ базы: сеть, которая молчит, не должна держать нажатие
  // микрофона дольше, чем его держал бы честный отказ.
  const FETCH_TIMEOUT_MS = 6000;

  // Строки базы → записи каталога. Строка без имени, без пути или живая без
  // частоты пропускается: по ней нельзя ни снять звук, ни выбрать путь.
  function parseRows(rows) {
    if (!Array.isArray(rows)) return { ok: false, error: 'bad answer' };
    const list = [];
    for (const r of rows) {
      const apiModel = r && typeof r.api_model === 'string' ? r.api_model : '';
      const path = r && r.dictation;
      if (!apiModel || (path !== 'file' && path !== 'live')) continue;
      const live = path === 'live';
      const rate = Number(r.sample_rate_hz);
      if (live && !(rate > 0)) continue;
      const have = Array.isArray(r.dictation_fields) ? r.dictation_fields : [];
      const fields = {};
      FIELD_NAMES.forEach((f) => { fields[f] = have.indexOf(f) >= 0; });
      list.push(Object.freeze({
        apiModel, live, sampleRate: live ? rate : null, fields: Object.freeze(fields),
        // Цену этой распознавалки считаем мы, а не поставщик: вычисляемая
        // колонка строки цены (нет часовой ставки, есть коэффициенты пересчёта).
        priceEstimated: r.price_estimated === true,
      }));
    }
    if (!list.length) return { ok: false, error: 'empty' };
    return { ok: true, list };
  }

  // Один запрос к базе. `token` — пропуск аккаунта: без него каталог не
  // читается (строки видит только вошедший), и это говорится как «нужен вход».
  async function fetchRows(opts) {
    const o = opts || {};
    if (!o.token) return { ok: false, gate: 'login' };
    const f = o.fetchImpl || global.fetch;
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    let timedOut = false;
    const timer = ctl ? setTimeout(() => { timedOut = true; ctl.abort(); }, FETCH_TIMEOUT_MS) : null;
    try {
      let res;
      try {
        res = await f(String(o.baseUrl || '').replace(/\/+$/, '') + PATH, {
          headers: { apikey: o.apikey, Authorization: 'Bearer ' + o.token },
          signal: ctl ? ctl.signal : undefined,
        });
      } catch (e) {
        return { ok: false, error: 'network: ' + (timedOut ? 'timeout' : String((e && e.message) || e)) };
      }
      if (!res || !res.ok) return { ok: false, status: res && res.status, error: 'HTTP ' + (res && res.status) };
      let rows = null;
      try { rows = await res.json(); } catch (_) { return { ok: false, error: timedOut ? 'network: timeout' : 'bad json' }; }
      if (!Array.isArray(rows) || !rows.length) return { ok: false, error: 'empty' };
      // `at` — миг чтения базы: по нему считается возраст каталога.
      return { ok: true, rows, at: Date.now() };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ── Память приложения ────────────────────────────────────────────────────

  let source = null;
  let snap = null;        // { list, at } — последний удачно прочитанный каталог
  let inflight = null;
  let lastFailure = null; // { gate?, error?, status? } — почему последняя загрузка не удалась

  function setSource(fn) { source = typeof fn === 'function' ? fn : null; }

  // Каталог в памяти есть — он отдаётся СРАЗУ, даже устаревший, а перечитывание
  // идёт в фоне: нажатие микрофона и окно настроек не ждут сеть из-за того, что
  // прошло десять минут. Ждёт только тот, у кого каталога нет вовсе (или кто
  // просит `force`). Неудача оставляет прошлый удачный каталог на месте: база
  // моргнула — выбор человека не должен моргнуть вместе с ней. Возвращает то,
  // что есть в памяти (может быть null).
  function load(opts) {
    const force = !!(opts && opts.force);
    if (snap && !force) {
      if (Date.now() - snap.at >= TTL_MS) refresh();
      return Promise.resolve(snap);
    }
    return refresh();
  }

  function refresh() {
    if (inflight) return inflight;
    if (!source) {
      lastFailure = { error: 'no source' };
      return Promise.resolve(snap);
    }
    inflight = (async () => {
      let r = null;
      try { r = await source(); } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
      const parsed = r && r.ok ? parseRows(r.rows) : null;
      if (parsed && parsed.ok) {
        // Возраст — от чтения базы, а не от прихода ответа: у расширения между
        // базой и вкладкой стоит память воркера, и без этого каталог мог бы жить
        // дольше обещанных десяти минут.
        const at = r && Number(r.at) > 0 ? Math.min(Number(r.at), Date.now()) : Date.now();
        snap = Object.freeze({ list: parsed.list, at });
        lastFailure = null;
      } else {
        lastFailure = parsed ? { error: parsed.error } : {
          gate: r && (r.gate || r.__gate) || undefined,
          error: (r && r.error) || 'no answer',
          status: r && r.status,
        };
      }
      return snap;
    })();
    inflight.then(() => { inflight = null; }, () => { inflight = null; });
    return inflight;
  }

  function entry(apiModel) {
    if (!snap) return null;
    const name = String(apiModel || '');
    for (const e of snap.list) if (e.apiModel === name) return e;
    return null;
  }

  // Каталог прочитан хоть раз (пусть и не сейчас).
  function known() { return !!snap; }
  // Имена в порядке списка настроек; пусто — каталога ещё нет.
  function options() { return snap ? snap.list.map((e) => e.apiModel) : []; }
  // true / false — живая или файловая; null — неизвестно (каталога нет или
  // такой распознавалки в нём нет).
  function isLive(apiModel) { const e = entry(apiModel); return e ? e.live : null; }
  // Частота живой распознавалки, Гц; null — не живая или неизвестная.
  function sampleRate(apiModel) { const e = entry(apiModel); return e && e.live ? e.sampleRate : null; }
  // Какие ручки принимает распознавалка: { languages: true, prompt: false, … }.
  // У незнакомой — все false: окно спрячет всё, а не покажет ручки чужой модели.
  function fields(apiModel) { const e = entry(apiModel); return e ? e.fields : NO_FIELDS; }
  // Приблизительна ли цена этой распознавалки — красная строка под списком в
  // окне настроек. Признак — из строки цены в базе, а не список здесь: по той же
  // строке считает сервер. Незнакомая или каталога нет — false: строки нет.
  function priceEstimated(apiModel) { const e = entry(apiModel); return !!(e && e.priceEstimated); }

  // Хранимое имя → имя, которое можно послать. Пусто — умолчание. Каталог
  // прочитан и такой распознавалки в нём нет (сняли, опечатка, старый набор)
  // — умолчание. Каталога нет — хранимое как есть: подменять выбор человека
  // по неудачной загрузке нельзя.
  function normalize(stored, fallback) {
    const dflt = (typeof fallback === 'string' && fallback) ? fallback : null;
    if (!stored || typeof stored !== 'string') return dflt;
    if (!snap) return stored;
    return entry(stored) ? stored : (dflt || stored);
  }

  // Путь микрофона на нажатии: какая модель, живая ли, на какой частоте.
  // Ждёт каталог, если его ещё нет (обычно он уже в памяти: хозяин загружает
  // его при открытии окна, а зовёт это параллельно с запросом микрофона).
  async function route(stored, fallback) {
    await load();
    if (!snap) {
      const f = lastFailure || {};
      return { ok: false, gate: f.gate, status: f.status, error: 'recognizer list unavailable' + (f.error ? ' (' + f.error + ')' : '') };
    }
    const model = normalize(stored, fallback);
    const e = entry(model);
    if (!e) return { ok: false, error: 'unknown recognizer: ' + model };
    return { ok: true, model, live: e.live, sampleRate: e.sampleRate };
  }

  global.LexDictationCatalog = Object.freeze({
    FIELD_NAMES, SELECT, PATH, TTL_MS,
    parseRows, fetchRows,
    setSource, load, known, options, entry, isLive, sampleRate, fields, priceEstimated, normalize, route,
    // Только для проверок (dev-tools/test-dictation-catalog.mjs).
    _reset() { snap = null; inflight = null; lastFailure = null; source = null; },
  });
})(typeof self !== 'undefined' ? self : globalThis);
