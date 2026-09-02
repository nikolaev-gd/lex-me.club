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
// 1. ПУБЛИЧНЫЙ (`current` / `refresh`) — то, что человек видит пилюлями. Его
//    целиком считает СЕРВЕР, действием `presets` мимо гейта редактора: он же
//    отбирает опубликованные слоты, он же задаёт порядок, он же кладёт в строку
//    готовый id модели. Клиент не отбирает и не сортирует ничего — иначе три
//    поверхности (расширение, страница, айфон) разъезжаются, что уже случилось
//    однажды с именем ключа модели.
//
// 2. КАТАЛОГ РЕДАКТОРА (`catalog` / `refreshCatalog`) — то, что видно в отсеке
//    настроек: ЧЕРНОВИКИ, признак расхождения, «ни разу не публиковали». Ходит
//    прежним действием `list`, и его по-прежнему отдают только редактору.
//
// Отсюда следствие, которое стоит знать заранее: у РЕДАКТОРА в ряду пилюль
// видны тоже только опубликованные заготовки. Цикл «поправил → проверил на
// себе» при этом жив — llm-proxy отдаёт редактору ЧЕРНОВОЙ текст уже
// опубликованного слота, — теряется ровно одно: попробовать совсем новую
// заготовку до её первой публикации. Это цена принципа «публикация решает всё»,
// и она уплачена сознательно.
//
// ⚠️ ЗАПОМНЕННОГО СПИСКА БОЛЬШЕ НЕТ, и это тоже решение, а не упрощение. Здесь
// стоял третий слой — копия списка в chrome.storage под ключом
// `lexActionPresets_<scope>`, чтобы разметка (она строится СИНХРОННО) не ждала
// сети. Он снят целиком вместе с ключом: пока список был редакторским, «показать
// вчерашнее» было безобидно, а теперь это значит показать человеку заготовку,
// которую владелец уже снял с публикации, — и она молча уедет к модели. Правило
// стало жёстким: человек видит ЛИБО актуальный список, ЛИБО не видит ряда вовсе.
// Ряд просто появляется на кадр позже, когда ответит сервер.
//
// ⚠️ И запасной одиночки Native тоже больше нет. Сервер не ответил (офлайн, не
// вошёл, сбой) — ряда нет. Пилюля, за которой не стоит подтверждённого сервером
// промпта, хуже отсутствия пилюли: нажатие по ней уходит к модели без
// инструкции либо упирается в 424.
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
  // Две вещи: хранилище (запомненный список, указатель активной заготовки) и
  // каталог промптов. В расширении обе есть даром — chrome.storage.local и
  // chrome.runtime.sendMessage в service worker. На странице lex-me.club/app
  // нет НИ ОДНОЙ: хранилище там IndexedDB (WcStore), а до prompts-admin
  // страница ходит сама, своим токеном, без посредника.
  //
  // Поэтому обе вынесены за впрыск. Не «поддержка веба внутри общего модуля»
  // (это затянуло бы сюда имена чужой поверхности), а ровно две функции,
  // которые зовущий обязан дать, если у него нет chrome. Не дал и chrome нет —
  // модуль честно деградирует до запасной одиночки, как и раньше.
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

  // Один раунд-трип в SW → prompts-admin. Право проверяет сервер; не-редактор
  // получает 403, и тогда список остаётся на запомненном/запасном слое.
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

  // ИМЯ КЛЮЧА МОДЕЛИ ЗАГОТОВКИ — ТОЛЬКО ДЛЯ РЕДАКТОРА (2026-09-02).
  //
  // ⚠️ Путь ОТПРАВКИ этим правилом больше не пользуется: id модели приезжает
  // готовым полем `modelId` в строке публичного списка, потому что имя ключа
  // считает сервер. Здесь оно осталось ровно для двух вещей, и обе — редакторские:
  // выбор модели в отсеке настроек (пишется в local как стейджинг) и публикация
  // этого выбора (publishOne). Следствие для редактора: выбранная, но не
  // опубликованная модель на отправку больше не влияет — сперва «Опубликовать».
  //
  // Ниже — исходная врезка о том, почему правило вообще свели в одно место.
  //
  // Лежало в двух копиях: `actionModelKeyFor` в chat-surface.js и
  // `nativeModelKeyFor` в webchat/wc-backend.js. Копии уже расходились: на
  // странице хвост остался 'native', когда расширение перешло на слот, — и
  // страница читала ключ, в который больше никто не пишет, молча отвечая
  // моделью основного чата, каким бы ни был выбор владельца. Правило переехало
  // сюда, к владельцу заготовок.
  //
  // Scope берётся у ЯЧЕЙКИ (её refScope, сегодня 'shorts-main'), а не у окна:
  // конфигурация заготовки одна на все окна, где живёт её кнопка. Аргумент
  // scope — запасной, на поверхность, чья ячейка не разрешилась.
  function modelKeyFor(scope, slotId) {
    const c = cellDesc();
    const cellScope = c && c.ref && c.ref.scope;
    return 'activeActionModelId_' + (cellScope || scope) + '_' + slotId;
  }

  // ── Публикация настроек: точечно, своими ключами ──────────────────────────
  // Своей двери у страницы и у расширения снова две (SW против прямого fetch),
  // поэтому обе отданы впрыску — с запасным путём через chrome.runtime, как у
  // promptsAdmin выше. Не объявлено и chrome нет → честный отказ, а не тишина.
  function publishKeysCall(scope, keys, note) {
    if (adapter && typeof adapter.publishKeys === 'function') {
      return Promise.resolve()
        .then(() => adapter.publishKeys(scope, keys, note))
        .then((res) => res || { error: 'no response', status: 0 })
        .catch((e) => ({ error: String((e && e.message) || e), status: 0 }));
    }
    return new Promise((resolve) => {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
        resolve({ error: 'no runtime', status: 0 });
        return;
      }
      try {
        chrome.runtime.sendMessage({ type: 'LEX_PUBLISH_KEYS', scope, keys, note }, (res) => {
          resolve(res || { error: 'no response', status: 0 });
        });
      } catch (e) {
        resolve({ error: String((e && e.message) || e), status: 0 });
      }
    });
  }

  // Последний опубликованный набор этого scope — для сравнения ключа модели.
  // Возвращает объект либо null (прочитать не удалось / истории нет).
  function publishedKeysCall(scope) {
    if (adapter && typeof adapter.publishedKeys === 'function') {
      return Promise.resolve()
        .then(() => adapter.publishedKeys(scope))
        .catch(() => null);
    }
    return new Promise((resolve) => {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
        resolve(null);
        return;
      }
      try {
        chrome.runtime.sendMessage({ type: 'LEX_PUBLISHED_KEYS', scope }, (res) => {
          resolve(res && res.ok && res.data && typeof res.data === 'object' ? res.data : null);
        });
      } catch (_) {
        resolve(null);
      }
    });
  }

  // ── Состояние на ОКНО: ДВА списка, каждый со своим заходом ───────────────
  //
  // `pub` — публичный (пилюли), `cat` — каталог редактора (отсек настроек).
  // Держатся врозь намеренно: у них разный источник, разные права и разный смысл
  // пустоты. Общее состояние на двоих означало бы, что заход редактора в
  // настройки подменяет людям ряд пилюль черновиками.
  //
  // `inflight` склеивает одновременных зовущих (ряд пилюль и настройки строятся
  // независимо друг от друга).
  const pubState = new Map();   // scope → {list, inflight}
  const catState = new Map();   // scope → {list, fetched, inflight}
  function pub(scope) {
    let s = pubState.get(scope);
    if (!s) { s = { list: null, inflight: null }; pubState.set(scope, s); }
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

  // Синхронное «что показывать прямо сейчас». Разметка ряда пилюль строится
  // синхронно, ей нужен ответ без await. Пусто до первого удачного ответа
  // сервера — и это НЕ дефект, а само правило: ряда нет, пока список неизвестен.
  function current(scope) {
    const s = pub(scope);
    return (s.list && s.list.length) ? s.list : [];
  }

  // Список С СЕРВЕРА, действие `presets`. Зовётся на открытие чата — то есть у
  // каждого, а не только у того, кто зашёл в настройки.
  //
  // ⚠️ ЗАХОД НЕ ЗАЩЁЛКИВАЕТСЯ НА НЕУДАЧЕ, и это уже стоило одной поломки: до
  // входа каталог отвечает 401, и прежний признак «сходили» превращал 401 в
  // пустой ряд НАВСЕГДА, до перезагрузки страницы (врезка в wc-composer.js).
  // Поэтому здесь нет флага «сходили» вовсе: удачный ответ кладёт список,
  // неудачный не трогает НИЧЕГО, и следующее открытие чата пробует снова.
  async function refresh(scope) {
    const s = pub(scope);
    if (s.inflight) return s.inflight;
    s.inflight = (async () => {
      const res = await promptsAdmin({ action: 'presets' });
      // 401 / офлайн / нет runtime → оставляем как есть. Ряд, которого ещё не
      // было, не появится; ряд, который уже видно, не мигнёт.
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

  // ПУБЛИКАЦИЯ ОДНОЙ ЗАГОТОВКИ: текст промпта и ключ модели одним действием.
  //
  // Две половины уезжают в РАЗНЫЕ места и разными функциями — текст в каталог
  // (prompts-admin), ключ модели в опубликованные настройки (settings-publish),
  // — но для человека это одно нажатие, поэтому и отказ должен быть один.
  // Порядок: сперва текст, потом ключ модели. Обратный порядок открывал бы окно
  // «модель уже переключилась, промпт ещё старый».
  //
  // Ключ модели публикуется ТОЧЕЧНО, действием 'publishKeys' (см. врезку в
  // settings-publish): дописывает свои ключи в последний опубликованный набор,
  // не трогая соседние. Прежняя форма (весь набор scope одним куском) утащила
  // бы вместе с заготовкой все несохранённые черновики остальных настроек.
  async function publishOne(scope, id, note) {
    const c = cellDesc();
    if (!c || !c.ref) return { error: 'no cell' };

    const pub = await promptsAdmin({
      action: 'publish', scope: c.ref.scope, cell: c.ref.cell, slot: id,
      note: note || 'action preset published',
    });
    if (!pub || !pub.ok) return { error: (pub && (pub.error || pub.status)) || 'publish failed' };

    // Вторая половина — ключ модели этой заготовки. Его может не быть вовсе
    // (модель не выбирали → «наследовать модель чата»); тогда публикуем пустую
    // строку, а не пропускаем ключ: у людей могло остаться ранее опубликованное
    // значение, и «не трогать» означало бы «оставить чужой выбор».
    const modelKey = modelKeyFor(scope, id);
    const r = await storageGet([modelKey]);
    const res = await publishKeysCall(
      c.ref.scope,
      { [modelKey]: typeof r[modelKey] === 'string' ? r[modelKey] : '' },
      note || 'action preset published',
    );
    if (!res || !res.ok) return { error: (res && (res.error || res.status)) || 'model publish failed' };
    // Оба списка: каталог — чтобы погасла точка расхождения, публичный — чтобы
    // заготовка появилась в ряду у людей. Публикация без второго обновления
    // выглядела бы как «нажал, и ничего не произошло».
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

  // РАСХОЖДЕНИЕ ЗАГОТОВКИ — одно значение на две независимые половины.
  //
  // Текст: признак считает сервер и присылает полем `dirty` (клиенту сравнивать
  // нечем — текста у него нет ни в одном виде).
  // Ключ модели: сравнивается ЗДЕСЬ, локальное значение против опубликованного.
  // Опубликованный набор читается прямо из published_settings (его отдаёт любому
  // вошедшему), поэтому сравнение доступно и без прав редактора — но зовёт его
  // только отсек настроек, а он и так виден одному редактору.
  //
  // Пустая строка и отсутствие ключа — ОДНО И ТО ЖЕ состояние («наследовать
  // модель чата»), иначе заготовка, у которой модель никогда не выбирали,
  // вечно светилась бы расходящейся.
  async function modelDirty(scope, id) {
    const c = cellDesc();
    if (!c || !c.ref) return false;
    const modelKey = modelKeyFor(scope, id);
    // Не смогли прочитать опубликованное — не выдумываем расхождение.
    const published = await publishedKeysCall(c.ref.scope);
    if (!published) return false;
    const local = await storageGet([modelKey]);
    const a = typeof local[modelKey] === 'string' ? local[modelKey] : '';
    const b = typeof published[modelKey] === 'string' ? published[modelKey] : '';
    return a !== b;
  }

  // Сводный признак для строки заготовки в настройках: текст ИЛИ ключ модели.
  // Человеку не нужно знать, какая из половин разошлась, — ему нужно знать, что
  // нажатие «Опубликовать» что-то изменит.
  async function isDirty(scope, id) {
    // КАТАЛОГ, а не публичный список: расхождение — про черновик, и в публичном
    // списке признаков черновика нет по построению.
    const hit = (cat(scope).list || []).find((p) => p.id === id);
    if (hit && (hit.dirty || !hit.published)) return true;
    return await modelDirty(scope, id);
  }

  function onChange(fn) {
    if (typeof fn === 'function') listeners.add(fn);
    return () => listeners.delete(fn);
  }

  // ⚠️ ЗДЕСЬ СТОЯЛ СЛУШАТЕЛЬ chrome.storage.onChanged, подхватывавший правку
  // списка из соседней вкладки через запомненный ключ. Ключа больше нет (см.
  // шапку), поэтому нет и слушателя. Синхронность вкладок теперь даёт сам
  // источник: каждая вкладка спрашивает сервер на открытии чата.

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
    isDirty,
    modelDirty,
    modelKeyFor,
    getText,
    resolves,
    isNativeId,
    nameProblem,
    textProblem,
    onChange,
  };
})(typeof window !== 'undefined' ? window : self);
