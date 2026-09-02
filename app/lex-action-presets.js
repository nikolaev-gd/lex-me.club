// lex-action-presets.js — ЗАГОТОВКИ ДЕЙСТВИЙ: откуда берётся их список.
//
// Заготовка = ОДИН СЛОТ ячейки nativePrompts в серверном каталоге промптов
// (scope 'shorts-main'). У слота есть имя (колонка `name`) и текст — это и есть
// название заготовки и её промпт. Ничего больше заводить не понадобилось:
// prompts-admin `put` делает upsert по составному ключу (scope, cell, slot), то
// есть новый слот появляется сам от первой же записи. Ни таблиц, ни edge-функций
// эта работа не трогает.
//
// ⚠️ ЧЕГО ЗДЕСЬ НЕТ. Кнопка в композере (config.actionButtons) осталась ОДНА и
// по-прежнему зовётся 'native'. Заготовка — это НЕ вторая кнопка: это выбранный
// слот у той же кнопки. Отсюда следствие, которое легко сломать, приняв
// заготовку за режим: `action_id` в журнале вызовов у всех заготовок один и тот
// же — 'native'. Своим у каждой заготовки становится имя, текст промпта, модель
// и ПЕРЕПИСКА.
//
// ⚠️ Переписка стала своей 2026-08-25 и не даром: ключ ветки треда считается от
// СЛОТА, а не от id кнопки (`__lex_action__<ключ чата>__<слот>`, правило в
// video-threads.js). До этого ключ брался от id кнопки — он у всех заготовок
// 'native', — и «Носитель» в том же чате открывал переписку «Лимерика».
// Требование к id слота отсюда одно: без '__' (newSlotId ниже его и не даёт).
//
// ── ДВА СПИСКА, И ПУТАТЬ ИХ НЕЛЬЗЯ ──────────────────────────────────────────
//
// 1. ПУБЛИЧНЫЙ (`current` / `refresh`) — то, что видно пилюлями. Его целиком
//    считает СЕРВЕР, действием `presets` мимо гейта редактора: он же отбирает
//    строки, он же задаёт порядок, он же кладёт готовый id модели. Клиент не
//    отбирает и не сортирует ничего — иначе три поверхности (расширение,
//    страница, айфон) разъезжаются, что уже случилось однажды с именем ключа
//    модели.
//
//    ⚠️ Ответ у этого действия РАЗНЫЙ, и решает это сервер, а не клиент:
//    редактору список собирается по ЧЕРНОВИКАМ (и опубликованные, и ещё нет),
//    всем остальным — по опубликованным версиям. Так владелец пробует новую
//    заготовку до её первой публикации: без этого кнопки для неё в ряду просто
//    не было бы. Здесь эта развилка не видна вовсе — и не должна быть видна.
//
// 2. КАТАЛОГ РЕДАКТОРА (`catalog` / `refreshCatalog`) — то, что видно в отсеке
//    настроек: признак расхождения, «ни разу не публиковали», длина черновика.
//    Ходит прежним действием `list`, и его по-прежнему отдают только редактору.
//    Публичный список этих признаков не несёт и нести не должен.
//
// ── СОХРАНЁННЫЙ СПИСОК: КНОПКА ЕСТЬ ВСЕГДА И ВСЕГДА С НАЗВАНИЕМ ─────────────
//
// Решение владельца 2026-09-02. Ряд, пропадающий на неответе сервера, отклонён:
// человек открывает продукт и видит пустое место там, где вчера были кнопки.
// Поэтому список переживает закрытие окна — ключ `lexActionPresets_<scope>` в
// хранилище.
//
// Порядок на открытии: нарисовать сохранённое, параллельно спросить сервер,
// пришёл ответ — заменить. Никаких пометок «несвежий» и никакой особой
// отрисовки: это обычные кнопки. Пустой ряд остаётся ровно у одного человека —
// того, кто открыл продукт впервые и ответа ещё ни разу не получал.
//
// ⚠️ СОХРАНЁННОЕ ПРИВЯЗАНО К АККАУНТУ, и это обязательное условие, а не
// перестраховка. У редактора в списке лежат ЧЕРНОВЫЕ заготовки — те, которых
// обычный человек видеть не должен. Один браузер, выход из редакторского
// аккаунта и вход обычным — и без привязки его первый кадр показал бы чужие
// черновики. Поэтому рядом со списком лежит id аккаунта, под которым он снят, и
// список чужого аккаунта не читается вовсе (`loadRemembered` ниже). Вторым
// рубежом стоит общая уборка при смене человека: ключ аккаунтный, при выходе
// его стирают, а слушатель ниже гасит и копию в памяти — «ни на мгновение»
// значит и это тоже.
//
// ⚠️ Запасной одиночки Native при этом НЕ ВЕРНУЛОСЬ. Она врала: показывала
// кнопку, за которой не стоит подтверждённого сервером промпта, и нажатие
// уходило к модели без инструкции либо упиралось в 424. Сохранённый список
// такого не делает — в нём лежит то, что сервер однажды подтвердил.
//
// ── УДАЛЕНИЕ ────────────────────────────────────────────────────────────────
// Два шага, и оба обязательны (2026-08-25):
//   1. `unpublish` — снять опубликованную версию, иначе текст удалённой
//      заготовки продолжает жить на сервере и отдаваться людям навсегда;
//   2. `put` с пустым текстом и пометкой DELETED_PREFIX в начале имени — такие
//      строки список отбрасывает.
// Строку каталога физически стереть по-прежнему нечем: DELETE у prompts-admin
// нет, и заводить его не стали — снятие с публикации решает задачу, не ломая
// append-only историю. Префикс начинается с подчёркиваний, а интерфейс
// запрещает человеку начинать имя с '_' — случайно завести невидимую заготовку
// нельзя. Порядок шагов и цена сбоя на каждом — во врезке у самой remove().
(function (global) {
  'use strict';

  if (global.LexActionPresets) return;

  // Ячейка одна и известна заранее: заготовки живут только у неё.
  const CELL_NAME = 'nativePrompts';

  const MAX_PRESETS = 10;          // включая Native
  const TEXT_MAX = 6000;           // потолок промпта, считается в интерфейсе
  const NAME_MAX = 120;            // ровно NAME_MAX из prompts-admin
  const SLOT_ID_MAX = 40;          // ровно SLOT_RE из prompts-admin
  const DELETED_PREFIX = '__deleted__';

  // Сохранённый список — по ключу на scope. Внутри не голый массив, а
  // { account, items }: без имени аккаунта список нечем отличить от чужого.
  const listKey = (scope) => 'lexActionPresets_' + scope;

  function cellDesc() {
    try {
      return (global.LexSettingsCells && global.LexSettingsCells.cellFor(CELL_NAME)) || null;
    } catch (_) { return null; }
  }

  // ── Подпись заготовки — ОДНО правило на чип, меню и отсек настроек ────────
  // Заготовку подписывает её имя. Исключение ровно одно, и оно про Native:
  // пока её имя не тронуто человеком, подпись берётся из i18n. Без этого
  // русский интерфейс молча сменил бы «Носитель» на «Native» — имя в каталоге
  // английское, оно там с посева. «Не тронуто» = пусто ИЛИ дословно равно
  // засеянному имени из реестра ячеек; переименовал владелец — показываем его
  // имя, как у любой другой заготовки.
  function labelOf(preset, i18nNative) {
    if (!preset) return i18nNative || '';
    const c = cellDesc();
    const first = c && c.slots && c.slots[0];
    const isNative = !!(first && (!preset.id || preset.id === first.id));
    if (isNative) {
      const untouched = !preset.name || (first && preset.name === first.defaultName);
      if (untouched) return i18nNative || preset.name || preset.id || '';
    }
    return preset.name || preset.id || '';
  }

  // ── ЧЕМ МОДУЛЬ ХОДИТ НАРУЖУ ──────────────────────────────────────────────
  // Две вещи: хранилище (ключ модели заготовки — редакторский стейджинг) и
  // каталог промптов. В расширении обе есть даром — chrome.storage.local и
  // chrome.runtime.sendMessage в service worker. На странице lex-me.club/app
  // нет НИ ОДНОЙ: хранилище там IndexedDB (WcStore), а до prompts-admin
  // страница ходит сама, своим токеном, без посредника.
  //
  // Поэтому обе вынесены за впрыск. Не «поддержка веба внутри общего модуля»
  // (это затянуло бы сюда имена чужой поверхности), а ровно две функции,
  // которые зовущий обязан дать, если у него нет chrome. Не дал и chrome нет —
  // список остаётся пустым, то есть ряда пилюль нет вовсе.
  let adapter = null;
  function configure(a) {
    adapter = (a && typeof a === 'object') ? a : null;
  }

  function storageGet(keys) {
    try {
      if (adapter && adapter.kv) return Promise.resolve(adapter.kv.get(keys));
    } catch (_) { /* fall through */ }
    try {
      if (global.LexPlatform && global.LexPlatform.kv) return global.LexPlatform.kv.local.get(keys);
    } catch (_) { /* fall through */ }
    return new Promise((resolve) => {
      try { chrome.storage.local.get(keys, (r) => resolve(r || {})); } catch (_) { resolve({}); }
    });
  }
  function storageSet(obj) {
    try {
      if (adapter && adapter.kv) return Promise.resolve(adapter.kv.set(obj));
    } catch (_) { /* fall through */ }
    try {
      if (global.LexPlatform && global.LexPlatform.kv) return global.LexPlatform.kv.local.set(obj);
    } catch (_) { /* fall through */ }
    return new Promise((resolve) => {
      try { chrome.storage.local.set(obj, () => resolve()); } catch (_) { resolve(); }
    });
  }

  // ID ВОШЕДШЕГО — только чтобы понять, чей сохранённый список читать.
  //
  // Третья функция за впрыском, по той же причине, что и две соседние: в
  // расширении ответ живёт в service worker, на странице — в её собственной
  // сессии. Не дали и chrome нет → null, и тогда сохранённое просто не
  // читается: показать чужое хуже, чем не показать ничего.
  function accountTag() {
    if (adapter && typeof adapter.accountId === 'function') {
      return Promise.resolve().then(() => adapter.accountId()).catch(() => null);
    }
    return new Promise((resolve) => {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
        resolve(null);
        return;
      }
      try {
        chrome.runtime.sendMessage({ type: 'LEX_ACCOUNT_ID' }, (res) => {
          resolve((res && typeof res.accountId === 'string' && res.accountId) || null);
        });
      } catch (_) { resolve(null); }
    });
  }

  // Один раунд-трип в SW → prompts-admin. Право проверяет сервер: публичное
  // действие `presets` отвечает любому вошедшему, редакторские (`list`, `get`,
  // `put`, `publish`, …) — только редактору, остальным 403.
  function promptsAdmin(body) {
    if (adapter && typeof adapter.promptsAdmin === 'function') {
      return Promise.resolve()
        .then(() => adapter.promptsAdmin(body))
        .then((res) => res || { error: 'no response', status: 0 })
        .catch((e) => ({ error: String((e && e.message) || e), status: 0 }));
    }
    return new Promise((resolve) => {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
        resolve({ error: 'no runtime', status: 0 });
        return;
      }
      try {
        chrome.runtime.sendMessage({ type: 'LEX_PROMPT_ADMIN', body }, (res) => {
          resolve(res || { error: 'no response', status: 0 });
        });
      } catch (e) {
        resolve({ error: String((e && e.message) || e), status: 0 });
      }
    });
  }

  // ⚠️ ЗДЕСЬ ЖИЛИ ТРИ ВЕЩИ, И ВСЕ ТРИ СНЯТЫ 2026-09-02 ОДНИМ РЕШЕНИЕМ.
  //
  //   · `modelKeyFor` — правило имени ключа 'activeActionModelId_<scope>_<слот>';
  //   · `publishKeysCall` — точечная публикация этого ключа через settings-publish;
  //   · `publishedKeysCall` — чтение опубликованного набора ради сверки модели.
  //
  // Все три существовали потому, что МОДЕЛЬ заготовки хранилась отдельно от её
  // текста: текст на сервере, модель в chrome.storage.local у редактора. Модель
  // переехала в каталог, к тексту (колонка model_id), и вместе с переездом
  // исчезла и причина. Ключа в хранилище больше нет ВОВСЕ — ни как источника,
  // ни как отражения: пока он существует, остаётся дверь, через которую значение
  // пишется мимо сервера, а эта дверь уже однажды затёрла выбор владельца
  // (публикация всего scope сняла снимок с локального хранилища).
  //
  // Следствие, ради которого всё и делалось: `publishOne` стал ОДНИМ вызовом.
  // Половинчатого исхода «текст уехал, модель нет» больше не бывает.

  // ── Состояние на ОКНО: ДВА списка, каждый со своим заходом ───────────────
  //
  // `pub` — публичный (пилюли), `cat` — каталог редактора (отсек настроек).
  // Держатся врозь намеренно: у них разный источник, разные права и разный смысл
  // пустоты. Общее состояние на двоих означало бы, что заход редактора в
  // настройки подменяет людям ряд пилюль черновиками.
  //
  // `inflight` склеивает одновременных зовущих (ряд пилюль и настройки строятся
  // независимо друг от друга).
  const pubState = new Map();   // scope → {list, inflight, account}
  const catState = new Map();   // scope → {list, fetched, inflight}
  function pub(scope) {
    let s = pubState.get(scope);
    if (!s) { s = { list: null, inflight: null, account: null }; pubState.set(scope, s); }
    return s;
  }
  function cat(scope) {
    let s = catState.get(scope);
    if (!s) { s = { list: null, fetched: false, inflight: null }; catState.set(scope, s); }
    return s;
  }

  const listeners = new Set();
  function notify(scope) {
    listeners.forEach((fn) => { try { fn(scope); } catch (_) { /* noop */ } });
  }

  function isDeletedName(name) {
    return typeof name === 'string' && name.indexOf(DELETED_PREFIX) === 0;
  }

  // ── ПУБЛИЧНЫЙ СПИСОК: то, что видит человек ──────────────────────────────

  // Синхронное «что показывать прямо сейчас»: разметка ряда строится синхронно,
  // ей нужен ответ без await. Пусто ровно в одном случае — сохранённого списка
  // нет и сервер ещё не ответил.
  function current(scope) {
    const s = pub(scope);
    return (s.list && s.list.length) ? s.list : [];
  }

  // Прочитать сохранённый список. Чужой аккаунт — НЕ читаем: у редактора там
  // лежат черновые заготовки, и показать их обычному человеку нельзя даже на
  // один кадр. Не знаем, кто вошёл, — тоже не читаем.
  async function loadRemembered(scope) {
    const s = pub(scope);
    const account = await accountTag();
    if (!account) return null;
    const r = await storageGet([listKey(scope)]);
    const raw = r[listKey(scope)];
    if (!raw || typeof raw !== 'object' || raw.account !== account) return null;
    const items = Array.isArray(raw.items) ? raw.items : [];
    const clean = items
      .filter((p) => p && typeof p.id === 'string' && p.id)
      .map((p) => ({
        id: p.id,
        name: typeof p.name === 'string' ? p.name : '',
        chars: (typeof p.chars === 'number') ? p.chars : null,
        modelId: typeof p.modelId === 'string' ? p.modelId : '',
      }));
    if (!clean.length) return null;
    s.account = account;
    return clean;
  }

  // Сохранённое пишется ВМЕСТЕ с именем аккаунта — иначе его нечем отличить от
  // чужого. Ключ аккаунтный: при смене человека общая уборка его стирает.
  async function remember(scope, items, account) {
    if (!account) return;
    await storageSet({ [listKey(scope)]: { account, items } });
  }

  // Список С СЕРВЕРА, действие `presets`. Зовётся на открытие чата — то есть у
  // каждого, а не только у того, кто зашёл в настройки.
  //
  // Два шага в одном заходе: сперва поднять сохранённое (без сети — ряд обязан
  // быть на месте сразу), потом спросить сервер и заменить.
  //
  // ⚠️ ЗАХОД НЕ ЗАЩЁЛКИВАЕТСЯ НА НЕУДАЧЕ, и это уже стоило одной поломки: до
  // входа каталог отвечает 401, и прежний признак «сходили» превращал 401 в
  // пустой ряд НАВСЕГДА, до перезагрузки страницы (врезка в wc-composer.js).
  // Поэтому флага «сходили» здесь нет вовсе: удачный ответ кладёт список,
  // неудачный оставляет сохранённый, и следующее открытие чата пробует снова.
  async function refresh(scope) {
    const s = pub(scope);
    if (s.inflight) return s.inflight;
    s.inflight = (async () => {
      if (!(s.list && s.list.length)) {
        const remembered = await loadRemembered(scope);
        if (remembered && !(s.list && s.list.length)) {
          s.list = remembered;
          notify(scope);
        }
      }
      const account = await accountTag();
      const res = await promptsAdmin({ action: 'presets' });
      // 401 / офлайн / нет runtime → остаёмся на сохранённом. Ряд не мигает.
      if (!res || !res.ok || !Array.isArray(res.presets)) return current(scope);
      // Отбор и порядок уже сделаны СЕРВЕРОМ — здесь только перекладка полей.
      // Ни filter, ни sort: любой из них означал бы вторую копию правила.
      s.list = res.presets.map((x) => ({
        id: x.slot,
        name: typeof x.name === 'string' ? x.name : '',
        chars: typeof x.chars === 'number' ? x.chars : null,
        // Пустая строка = «наследовать модель чата». Не подменять её ничем.
        modelId: typeof x.modelId === 'string' ? x.modelId : '',
      })).filter((x) => typeof x.id === 'string' && x.id);
      s.account = account;
      await remember(scope, s.list, account);
      notify(scope);
      return s.list;
    })();
    try { return await s.inflight; } finally { s.inflight = null; }
  }

  // ── КАТАЛОГ РЕДАКТОРА: черновики и признак расхождения ───────────────────

  // Каталог без сети, если он уже приезжал за жизнь окна.
  async function catalog(scope) {
    const s = cat(scope);
    if (s.list) return s.list;
    return await refreshCatalog(scope);
  }

  // Каталог С сервера, действие `list`. Не-редактору сервер отвечает 403 — тогда
  // список остаётся пустым, и отсек настроек у него всё равно не нарисован.
  async function refreshCatalog(scope, opts) {
    const s = cat(scope);
    const force = !!(opts && opts.force);
    if (s.inflight) return s.inflight;
    if (s.fetched && !force) return s.list || [];
    s.inflight = (async () => {
      const c = cellDesc();
      const res = await promptsAdmin({ action: 'list' });
      if (!res || !res.ok || !Array.isArray(res.cells)) {
        s.fetched = true;
        return s.list || [];
      }
      const ref = c && c.ref;
      const rows = res.cells.filter((x) => x
        && ref && x.scope === ref.scope && x.cell === ref.cell
        && typeof x.slot === 'string' && x.slot
        && !isDeletedName(x.name));
      s.fetched = true;
      // `dirty` считает СЕРВЕР (prompts-admin action:'list' сравнивает текст
      // черновика с текстом последней версии). Клиенту сравнивать нечем: текста
      // у него нет ни в одном виде — ни черновика, ни опубликованного.
      // `published` = null означает «не публиковали ни разу»; сервер в этом
      // случае и сам ставит dirty=true, но признак «никогда не публиковалась»
      // нужен отдельно — он читается иначе («ещё не у людей», а не «правка не
      // уехала»).
      //
      // Порядок здесь считается НА КЛИЕНТЕ, и это не противоречие запрету:
      // запрет — про список, который видит человек. Каталог редактора видит
      // один человек, и «в каком порядке лежат его черновики» — вопрос его
      // отсека настроек, а не продукта.
      s.list = orderCatalog(rows.map((x) => ({
        id: x.slot,
        name: typeof x.name === 'string' ? x.name : '',
        chars: typeof x.chars === 'number' ? x.chars : null,
        // ЧЕРНОВАЯ модель — её и рисует выпадашка в отсеке настроек. Локальной
        // копии этого выбора больше нет: единственный источник — каталог.
        modelId: typeof x.modelId === 'string' ? x.modelId : '',
        dirty: !!x.dirty,
        published: !!x.published,
      })));
      await mirrorNames(scope, s.list);
      return s.list;
    })();
    try { return await s.inflight; } finally { s.inflight = null; }
  }

  // Порядок каталога редактора: статические слоты первыми и в своём порядке,
  // остальные — как отдал каталог (он сортирует по имени слота).
  function orderCatalog(items) {
    const c = cellDesc();
    const staticIds = (c && c.slots ? c.slots : []).map((s) => s.id);
    const rank = (id) => {
      const i = staticIds.indexOf(id);
      return i < 0 ? staticIds.length : i;
    };
    return items.slice().sort((a, b) => rank(a.id) - rank(b.id));
  }

  // Правка заготовки меняет ОБА списка, и обновлять надо оба: каталог — чтобы
  // строка в настройках стала свежей, публичный — чтобы пилюля появилась или
  // исчезла. Одного каталога мало: пилюли из него не строятся.
  async function refreshBoth(scope) {
    await refreshCatalog(scope, { force: true });
    await refresh(scope);
  }

  // Имена слотов дублируются в ячейку nativePrompts_<scope> — её читают
  // прежние пути (карандаш редактора в settings-popover.js, подпись слота на
  // отправке). Текст туда НЕ кладём: он серверный, и локальная копия его была
  // вычищена переездом на сервер (background.js purgeMigratedPromptTexts).
  async function mirrorNames(scope, items) {
    const c = cellDesc();
    if (!c) return;
    const r = await storageGet([c.storageKey]);
    const obj = r[c.storageKey] || {};
    let changed = false;
    items.forEach((p) => {
      const was = obj[p.id];
      if (!was || was.name !== p.name) {
        obj[p.id] = { name: p.name, text: (was && was.text) || '' };
        changed = true;
      }
    });
    if (changed) await storageSet({ [c.storageKey]: obj });
  }

  // ── Имя слота ────────────────────────────────────────────────────────────
  // Человеку не показывается (задание, шаг 3) — это адрес строки в каталоге.
  // Латиница, цифры, дефис, подчёркивание, до 40 знаков: ровно SLOT_RE
  // серверной функции. Ведущая 'p' — чтобы id заготовки нельзя было спутать со
  // статическими 'chatB1'/'chatB2'.
  function newSlotId(taken) {
    const used = new Set(taken || []);
    for (let i = 0; i < 50; i += 1) {
      const rnd = Math.random().toString(36).slice(2, 8);
      const id = ('p' + Date.now().toString(36) + '-' + rnd).slice(0, SLOT_ID_MAX);
      if (!used.has(id)) return id;
    }
    return null;
  }

  function isNativeId(id) {
    const c = cellDesc();
    return !!(c && c.slots && c.slots[0] && c.slots[0].id === id);
  }

  function normName(name) {
    return String(name == null ? '' : name).replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  }

  // Имя, которое человеку вводить нельзя: пустое и начинающееся с '_' (там
  // живёт метка удаления). Возвращает код причины или null.
  function nameProblem(name) {
    const n = normName(name);
    if (!n) return 'empty';
    if (n.indexOf('_') === 0) return 'reserved';
    return null;
  }

  // Пустой текст отвергается ЗДЕСЬ, до сети, и это не дублирование серверной
  // проверки, а другое место в цепочке. Сервер откажет только на публикации
  // (`draft is empty`), а черновик к тому моменту УЖЕ записан: человек видел бы
  // ошибку, а заготовка молча оставалась бы наполовину сохранённой — с пустым
  // промптом, то есть ровно такой, ходить через которую нельзя.
  function textProblem(text) {
    const t = String(text == null ? '' : text);
    if (!t.trim()) return 'emptyText';
    if (t.length > TEXT_MAX) return 'too long';
    return null;
  }

  // ЧЕРНОВИК И ТОЛЬКО ЧЕРНОВИК (решение владельца 2026-08-25).
  //
  // Здесь раньше стояла пара put+publish в одной функции: заведение и правка
  // заготовки писали черновик и ТУТ ЖЕ публиковали его. Из-за этого «черновик»
  // и «опубликованное» совпадали по построению, и любая правка текста мгновенно
  // уезжала всем — в том числе недописанная. Развилка «редактору черновик,
  // остальным опубликованное» на сервере при этом была и работала: публиковать
  // было нечего, потому что всё публиковалось само.
  //
  // Теперь запись — это put. Публикация отдельным действием и отдельной кнопкой
  // (publishOne ниже), по одной заготовке за раз.
  async function putDraft(ref, slotId, name, text) {
    const put = await promptsAdmin({
      action: 'put', scope: ref.scope, cell: ref.cell, slot: slotId, text, name,
    });
    if (!put || !put.ok) return { error: (put && (put.error || put.status)) || 'put failed' };
    return { ok: true };
  }

  // ПУБЛИКАЦИЯ ОДНОЙ ЗАГОТОВКИ — буквально одно действие.
  //
  // Раньше их было два: текст уезжал в каталог (prompts-admin), ключ модели — в
  // опубликованные настройки (settings-publish), и между ними было окно, в
  // котором половина заготовки уже у людей, а половина ещё нет. Модель переехала
  // в каталог, к тексту, поэтому publish копирует строку целиком, и разъехаться
  // половинам больше нечем.
  async function publishOne(scope, id, note) {
    const c = cellDesc();
    if (!c || !c.ref) return { error: 'no cell' };
    const pub = await promptsAdmin({
      action: 'publish', scope: c.ref.scope, cell: c.ref.cell, slot: id,
      note: note || 'action preset published',
    });
    if (!pub || !pub.ok) return { error: (pub && (pub.error || pub.status)) || 'publish failed' };
    await refreshBoth(scope);
    return { ok: true };
  }

  // Смена модели заготовки — правка ЧЕРНОВИКА, без публикации. Текст с собой не
  // возим: его у клиента нет, и сервер разрешает объявить одну только модель.
  async function setModel(scope, id, modelId) {
    const c = cellDesc();
    if (!c || !c.ref) return { error: 'no cell' };
    const res = await promptsAdmin({
      action: 'put', scope: c.ref.scope, cell: c.ref.cell, slot: id,
      modelId: String(modelId == null ? '' : modelId),
    });
    if (!res || !res.ok) return { error: (res && (res.error || res.status)) || 'put failed' };
    await refreshBoth(scope);
    return { ok: true };
  }

  async function create(scope, name, text) {
    const c = cellDesc();
    if (!c || !c.ref) return { error: 'no cell' };
    const problem = nameProblem(name);
    if (problem) return { error: problem };
    const body = String(text == null ? '' : text);
    const tp = textProblem(body);
    if (tp) return { error: tp };
    const items = await catalog(scope);
    if (items.length >= MAX_PRESETS) return { error: 'limit' };
    const id = newSlotId(items.map((p) => p.id));
    if (!id) return { error: 'no id' };
    const res = await putDraft(c.ref, id, normName(name), body);
    if (res.error) return res;
    await refreshBoth(scope);
    return { ok: true, id };
  }

  async function update(scope, id, name, text) {
    const c = cellDesc();
    if (!c || !c.ref) return { error: 'no cell' };
    const problem = nameProblem(name);
    if (problem) return { error: problem };
    const body = String(text == null ? '' : text);
    const tp = textProblem(body);
    if (tp) return { error: tp };
    const res = await putDraft(c.ref, id, normName(name), body);
    if (res.error) return res;
    await refreshBoth(scope);
    return { ok: true };
  }

  // Удаление: строку каталога стереть нечем, поэтому пустой текст + метка в
  // имени.
  //
  // ⚠️ ДВА ШАГА, И ВТОРОЙ ОБЯЗАТЕЛЕН (решение владельца 2026-08-25).
  //
  // Раньше здесь стоял только put с меткой: помеченная строка исчезала из
  // списка, а ОПУБЛИКОВАННАЯ версия оставалась на сервере со старым текстом
  // навсегда. Пока список читался только редактором, это было незаметно; как
  // только заготовки поехали людям, «удалил» обязано значить «людям больше не
  // отдаётся», а не «пропало у меня из списка».
  //
  // Через `publish` снять нельзя: он берёт текст из черновика, а черновик здесь
  // пуст — сервер ответит 400 `draft is empty`, и это правило снимать нельзя.
  // Поэтому снятие — своё действие `unpublish` (вставляет версию с пустым
  // текстом, историю не трогает; см. врезку в prompts-admin). Резолвер на
  // пустом тексте слот больше не отдаёт → ход по нему получает явный отказ.
  //
  // Порядок: сперва СНЯТЬ С ПУБЛИКАЦИИ, потом пометить черновик. Обратный
  // порядок оставлял бы окно, в котором заготовка уже исчезла у редактора из
  // списка, а людям всё ещё отдаётся; при сбое на втором шаге это окно стало бы
  // постоянным. При выбранном порядке сбой на втором шаге даёт заготовку,
  // которая видна редактору и не отдаётся людям, — состояние честное и
  // чинится повторным удалением.
  //
  // Native не удаляется (решение задания) — гард здесь, а не только в разметке.
  async function remove(scope, id) {
    const c = cellDesc();
    if (!c || !c.ref) return { error: 'no cell' };
    if (isNativeId(id)) return { error: 'native' };
    const un = await promptsAdmin({
      action: 'unpublish', scope: c.ref.scope, cell: c.ref.cell, slot: id,
      note: 'action preset deleted',
    });
    if (!un || !un.ok) return { error: (un && (un.error || un.status)) || 'unpublish failed' };
    const put = await promptsAdmin({
      action: 'put', scope: c.ref.scope, cell: c.ref.cell, slot: id,
      text: '', name: DELETED_PREFIX + Date.now().toString(36),
      // Единственное место во всём коде, где пустой текст записывается
      // намеренно. Сервер по умолчанию такую запись отвергает (2026-08-26),
      // поэтому исключение объявляется здесь явно и видно глазами.
      allowEmpty: true,
    });
    if (!put || !put.ok) return { error: (put && (put.error || put.status)) || 'put failed' };
    // Убрать из обоих списков ДО перечитки: сервер отдаст строку с меткой и
    // фильтр её отбросит, но экран должен обновиться сразу, а не через сеть.
    const cs = cat(scope);
    if (cs.list) cs.list = cs.list.filter((p) => p.id !== id);
    const ps = pub(scope);
    if (ps.list) ps.list = ps.list.filter((p) => p.id !== id);
    // ⚠️ Указателя активной заготовки здесь БОЛЬШЕ НЕ ПЕРЕСТАВЛЯЕМ: ключа
    // activeNativePromptId_<scope> не существует (2026-09-02). Каждая пилюля
    // везёт свой слот сама, поэтому висячего указателя, который надо было бы
    // чинить после удаления, взяться неоткуда.
    notify(scope);
    await refreshBoth(scope);
    return { ok: true };
  }

  // Текст заготовки — только с сервера: локальной копии текстов больше нет.
  async function getText(scope, id) {
    const c = cellDesc();
    if (!c || !c.ref) return null;
    const res = await promptsAdmin({ action: 'get', scope: c.ref.scope, cell: c.ref.cell, slot: id });
    if (!res || !res.ok || typeof res.text !== 'string') return null;
    return res.text;
  }

  // Разрешится ли промпт этой заготовки — проверка ДО сети, чтобы ход без
  // инструкции не уходил вовсе.
  //
  // ⚠️ Ветки «каталог не отвечал → разрешаем по незнанию» здесь БОЛЬШЕ НЕТ, и
  // её отсутствие — часть новой конструкции. Она existовала, пока список у
  // обычного человека был запасной одиночкой, про которую клиент не знал
  // ничего. Теперь в публичном списке лежат ТОЛЬКО те слоты, про которые сервер
  // сказал «опубликовано и текст непустой», а пилюли строятся только из него.
  // Значит «нет в списке» — это уже не незнание, а факт.
  function resolves(scope, id) {
    const hit = current(scope).find((p) => p.id === id);
    if (!hit) return false;
    if (typeof hit.chars === 'number' && hit.chars <= 0) return false;
    return true;
  }

  // РАСХОЖДЕНИЕ ЗАГОТОВКИ — целиком серверный признак.
  //
  // Раньше он считался в двух местах: текст сравнивал сервер (клиенту нечем — у
  // него нет ни черновика, ни опубликованного), а ключ модели клиент сверял сам
  // с опубликованным набором. Обе половины теперь лежат в одной строке каталога,
  // и сравнивает их сервер (`dirty` в действии list). Второй половине здесь
  // взяться неоткуда: локального значения модели больше не существует.
  //
  // `published` = null означает «не публиковали ни разу» — это тоже расхождение,
  // но читается иначе: «ещё не у людей», а не «правка не уехала».
  async function isDirty(scope, id) {
    const hit = (cat(scope).list || []).find((p) => p.id === id);
    return !!(hit && (hit.dirty || !hit.published));
  }

  function onChange(fn) {
    if (typeof fn === 'function') listeners.add(fn);
    return () => listeners.delete(fn);
  }

  // ── СМЕНА ЧЕЛОВЕКА ГАСИТ РЯД НЕМЕДЛЕННО ──────────────────────────────────
  //
  // Выход из аккаунта стирает аккаунтные ключи, и сохранённый список — один из
  // них. Но КОПИЯ В ПАМЯТИ пережила бы это: окно не пересобирается на выходе, и
  // черновые заготовки редактора остались бы на экране, пока следующий человек
  // не откроет чат заново. Требование владельца — «ни на мгновение», поэтому
  // исчезновение ключа гасит и память, и ряд перерисовывается пустым.
  //
  // Здесь же ловится и правка списка в соседней вкладке: ключ один на установку.
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        Object.keys(changes).forEach((k) => {
          if (k.indexOf('lexActionPresets_') !== 0) return;
          const scope = k.slice('lexActionPresets_'.length);
          const s = pub(scope);
          const next = changes[k].newValue;
          // Ключ стёрли (выход, смена человека) → гасим память и ряд.
          if (!next || typeof next !== 'object' || !Array.isArray(next.items)) {
            s.list = null; s.account = null; notify(scope);
            return;
          }
          // Записал кто-то другой в этой же установке — берём как есть, но
          // только если это ТОТ ЖЕ аккаунт, что уже подтверждён у нас.
          if (s.account && next.account !== s.account) {
            s.list = null; s.account = null; notify(scope);
            return;
          }
          s.list = next.items
            .filter((p) => p && typeof p.id === 'string' && p.id)
            .map((p) => ({
              id: p.id,
              name: typeof p.name === 'string' ? p.name : '',
              chars: (typeof p.chars === 'number') ? p.chars : null,
              modelId: typeof p.modelId === 'string' ? p.modelId : '',
            }));
          notify(scope);
        });
      });
    }
  } catch (_) { /* noop */ }


  global.LexActionPresets = {
    configure,
    MAX_PRESETS,
    TEXT_MAX,
    NAME_MAX,
    DELETED_PREFIX,
    cellDesc,
    labelOf,
    // Публичный список — ряд пилюль.
    current,
    refresh,
    // Каталог редактора — отсек настроек.
    catalog,
    refreshCatalog,
    create,
    update,
    remove,
    publishOne,
    setModel,
    isDirty,
    getText,
    resolves,
    isNativeId,
    nameProblem,
    textProblem,
    onChange,
  };
})(typeof window !== 'undefined' ? window : self);
