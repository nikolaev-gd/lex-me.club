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
// ── ТРИ СЛОЯ ИСТОЧНИКА СПИСКА, и почему их три ──────────────────────────────
// Задание называет два — каталог и статический массив запасным. Между ними
// пришлось поставить третий, ЗАПОМНЕННЫЙ список (`lexActionPresets_<scope>` в
// chrome.storage.local), и вот почему:
//
//   1. Разметка композера строится СИНХРОННО, а каталог — сетевой запрос. Без
//      локальной копии после каждой перезагрузки страницы меню заготовок было
//      бы пустым до первого захода в настройки.
//   2. Статический массив на эту роль не годится: он описывает СЛОТЫ, а не то,
//      что реально лежит в каталоге, и эти два множества не обязаны совпадать.
//      Слот, которого в каталоге нет, промпт не разрешит — а отправка через
//      неразрешённый слот теперь получает явный отказ (llm-proxy отвечает 424).
//      Поэтому статический массив остаётся ровно тем, чем назван, — ЗАПАСНЫМ,
//      и сворачивается до ПЕРВОГО слота.
//
//      ⚠️ Здесь стояло «в каталоге сегодня ровно один слот — chatB1». Это было
//      неверно уже к 2026-08-25 и стоило отдельного разбора: в каталоге лежат
//      ОБА статических слота — chatB1 «Native» и chatB2 (переименован в
//      «recommendation»), — плюс заведённые владельцем. То есть Native и
//      recommendation — такие же заготовки, как любая другая, и ходят тем же
//      путём. Не писать сюда состояние базы: оно меняется, а комментарий нет.
//
// Отсюда правило, одно на все случаи:
//
//   каталог ответил   → список = строки каталога (минус помеченные удалёнными);
//                       он же записывается в запомненный ключ;
//   каталог не отвечал, но запомненный ключ есть → он;
//   ни того, ни другого → ОДНА заготовка Native (первый статический слот).
//
// Третья ветка — это ровно сегодняшнее поведение у всех, кто не редактор:
// prompts-admin отвечает им 403, список сворачивается в одну заготовку, меню
// долгого нажатия не открывается (chat-surface.js цепляет его только при
// длине > 1). Так же ведёт себя и веб: там нет chrome.runtime, запрос не
// уходит вовсе. То есть «у обычного пользователя и в вебе — одна кнопка
// Native, как сегодня» получается САМО, отдельного гейта не понадобилось.
//
// ⚠️ Обратная сторона того же факта, и она пережила публикацию заготовок
// (2026-08-25): ТЕКСТ опубликованной заготовки до обычного пользователя
// доезжает — его подставляет llm-proxy по указателю, — а СПИСОК нет. Каталог
// (prompts-admin) отвечает не-редактору 403, ячейка nativePrompts_<scope> снята
// с публикации, ключ lexActionPresets_<scope> машинно-локальный. Поэтому у
// обычного пользователя в меню по-прежнему ОДНА заготовка — первый статический
// слот, — и опубликованная владельцем «Лимерик» ему не покажется, сколько её ни
// публикуй. Публикация меняет то, ЧТО ответит уже видимая заготовка, а не то,
// СКОЛЬКО их видно. Осознанный хвост, решение за владельцем.
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

  // Запомненный список — машинно-локальный кэш серверного состояния, по одному
  // ключу на scope. НЕ публикуемый: у каждой установки он свой и восстанавливается
  // из каталога (см. background.js isMachineLocalKey).
  const listKey = (scope) => 'lexActionPresets_' + scope;

  function cellDesc() {
    try {
      return (global.LexSettingsCells && global.LexSettingsCells.cellFor(CELL_NAME)) || null;
    } catch (_) { return null; }
  }

  // Запасная одиночка: ПЕРВЫЙ статический слот. Имя пустое намеренно — подпись
  // ему даст labelOf() из i18n (см. ниже).
  function fallbackList() {
    const c = cellDesc();
    const s = c && c.slots && c.slots[0];
    return s ? [{ id: s.id, name: '', chars: null }] : [];
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

  // ИМЯ КЛЮЧА МОДЕЛИ ЗАГОТОВКИ — одно правило на обе поверхности.
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

  // ── Состояние на ОКНО ────────────────────────────────────────────────────
  // Список тянется с сервера ОДИН раз за жизнь окна (задание, шаг 2) и живёт
  // здесь. `fetched` отмечает состоявшийся заход, `inflight` склеивает
  // одновременных зовущих (настройки и меню чипа открываются независимо).
  const state = new Map();   // scope → {list, fetched, inflight, loaded}
  function slot(scope) {
    let s = state.get(scope);
    if (!s) { s = { list: null, fetched: false, inflight: null, loaded: null }; state.set(scope, s); }
    return s;
  }

  const listeners = new Set();
  function notify(scope) {
    listeners.forEach((fn) => { try { fn(scope); } catch (_) { /* noop */ } });
  }

  function isDeletedName(name) {
    return typeof name === 'string' && name.indexOf(DELETED_PREFIX) === 0;
  }

  // Порядок показа. Статические слоты идут первыми и в своём порядке (Native
  // обязана быть первой), остальные — как отдал каталог. Полагаться на то, что
  // сгенерированный id отсортируется после 'chatB1', нельзя: каталог сортирует
  // по имени слота, и одна буква решала бы порядок заготовок на экране.
  function orderList(items) {
    const c = cellDesc();
    const staticIds = (c && c.slots ? c.slots : []).map((s) => s.id);
    const rank = (id) => {
      const i = staticIds.indexOf(id);
      return i < 0 ? staticIds.length : i;
    };
    return items.slice().sort((a, b) => rank(a.id) - rank(b.id));
  }

  // Прочитать запомненный список (без сети). Пусто → запасная одиночка.
  async function loadRemembered(scope) {
    const r = await storageGet([listKey(scope)]);
    const raw = r[listKey(scope)];
    if (!Array.isArray(raw) || !raw.length) return null;
    const clean = raw
      .filter((p) => p && typeof p.id === 'string' && p.id && !isDeletedName(p.name))
      .map((p) => ({
        id: p.id,
        name: typeof p.name === 'string' ? p.name : '',
        chars: (typeof p.chars === 'number') ? p.chars : null,
        dirty: !!p.dirty,
        published: !!p.published,
      }));
    return clean.length ? orderList(clean) : null;
  }

  async function remember(scope, items) {
    await storageSet({
      [listKey(scope)]: items.map((p) => ({
        id: p.id, name: p.name, chars: p.chars, dirty: !!p.dirty, published: !!p.published,
      })),
    });
  }

  // Синхронное «что показывать прямо сейчас»: то, что уже в памяти, иначе
  // запасная одиночка. Разметка строится синхронно — ей нужен ответ без await.
  function current(scope) {
    const s = slot(scope);
    if (s.list && s.list.length) return s.list;
    return fallbackList();
  }

  // Список без сети: память → запомненный ключ → запасная одиночка.
  async function list(scope) {
    const s = slot(scope);
    if (s.list && s.list.length) return s.list;
    if (!s.loaded) {
      s.loaded = (async () => {
        const remembered = await loadRemembered(scope);
        if (remembered && !(s.list && s.list.length)) s.list = remembered;
        return s.list || fallbackList();
      })();
    }
    await s.loaded;
    return s.list && s.list.length ? s.list : fallbackList();
  }

  // Список С сервера. Один заход за жизнь окна; `force` — после своей правки.
  async function refresh(scope, opts) {
    const s = slot(scope);
    const force = !!(opts && opts.force);
    if (s.inflight) return s.inflight;
    if (s.fetched && !force) return list(scope);
    s.inflight = (async () => {
      // До сети — поднять запомненное, чтобы отказ сервера не откатывал показ
      // к одиночке там, где список уже был.
      await list(scope);
      const c = cellDesc();
      const res = await promptsAdmin({ action: 'list' });
      if (!res || !res.ok || !Array.isArray(res.cells)) {
        // 403 / офлайн / нет runtime. НЕ авария: остаёмся на том, что есть, и
        // помечаем заход состоявшимся — второй раз за окно не ходим.
        s.fetched = true;
        return list(scope);
      }
      const ref = c && c.ref;
      const rows = res.cells.filter((x) => x
        && ref && x.scope === ref.scope && x.cell === ref.cell
        && typeof x.slot === 'string' && x.slot
        && !isDeletedName(x.name));
      s.fetched = true;
      // Пустой ответ по этой ячейке — не повод стереть список: строки могли не
      // доехать, а заготовки на экране должны пережить это.
      if (!rows.length) return list(scope);
      // `dirty` считает СЕРВЕР (prompts-admin action:'list' сравнивает текст
      // черновика с текстом последней версии). Клиенту сравнивать нечем: текста
      // у него нет ни в одном виде — ни черновика, ни опубликованного.
      // `published` = null означает «не публиковали ни разу»; сервер в этом
      // случае и сам ставит dirty=true, но признак «никогда не публиковалась»
      // нужен отдельно — он читается иначе («ещё не у людей», а не «правка не
      // уехала»).
      s.list = orderList(rows.map((x) => ({
        id: x.slot,
        name: typeof x.name === 'string' ? x.name : '',
        chars: typeof x.chars === 'number' ? x.chars : null,
        dirty: !!x.dirty,
        published: !!x.published,
      })));
      await remember(scope, s.list);
      await mirrorNames(scope, s.list);
      notify(scope);
      return s.list;
    })();
    try { return await s.inflight; } finally { s.inflight = null; }
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
    await refresh(scope, { force: true });
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
    const items = await list(scope);
    if (items.length >= MAX_PRESETS) return { error: 'limit' };
    const id = newSlotId(items.map((p) => p.id));
    if (!id) return { error: 'no id' };
    const res = await putDraft(c.ref, id, normName(name), body);
    if (res.error) return res;
    await refresh(scope, { force: true });
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
    await refresh(scope, { force: true });
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
    // Убрать из запомненного до перечитки: каталог отдаст строку с меткой, и
    // фильтр её отбросит, но список на экране должен обновиться сразу.
    const s = slot(scope);
    if (s.list) s.list = s.list.filter((p) => p.id !== id);
    if (s.list) await remember(scope, s.list);
    // Указатель активной заготовки не должен пережить саму заготовку: висячий
    // id читают и чип, и отправка, и первый из них его гасит своим гардом, а
    // вторая — нет. Переставляем на первую оставшуюся.
    const c2 = cellDesc();
    if (c2 && c2.activeIdStorageKey) {
      const cur = await storageGet([c2.activeIdStorageKey]);
      if (cur[c2.activeIdStorageKey] === id) {
        const first = (s.list && s.list[0]) || fallbackList()[0];
        if (first) await storageSet({ [c2.activeIdStorageKey]: first.id });
      }
    }
    notify(scope);
    await refresh(scope, { force: true });
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

  // Разрешится ли промпт этой заготовки. Отвечает по тому, что известно ЛОКАЛЬНО
  // (задание, шаг 6: запрос не должен уходить вовсе):
  //   - слота нет в текущем списке → нет;
  //   - каталог отвечал и сказал, что текст пуст → нет;
  //   - каталог не отвечал (не редактор, офлайн) → да: списка чужих строк у
  //     нас нет, и запрещать отправку по незнанию хуже, чем разрешить.
  function resolves(scope, id) {
    const items = current(scope);
    const hit = items.find((p) => p.id === id);
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
    const hit = current(scope).find((p) => p.id === id);
    if (hit && (hit.dirty || !hit.published)) return true;
    return await modelDirty(scope, id);
  }

  // Ключ указателя активной заготовки — он же указатель активного слота ячейки.
  // Один ключ, а не два: отправка уже читает активный слот ячейки
  // (chat-surface.js readPromptCell), так что чип и отправка не могут разъехаться.
  function activeIdKey() {
    const c = cellDesc();
    return c ? c.activeIdStorageKey : null;
  }

  function onChange(fn) {
    if (typeof fn === 'function') listeners.add(fn);
    return () => listeners.delete(fn);
  }

  // Правка в соседней вкладке — тот же список. Ключ машинно-локальный, значит
  // он же и общий для вкладок одной установки.
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        Object.keys(changes).forEach((k) => {
          if (k.indexOf('lexActionPresets_') !== 0) return;
          const scope = k.slice('lexActionPresets_'.length);
          const s = slot(scope);
          const next = changes[k].newValue;
          if (!Array.isArray(next) || !next.length) return;
          s.list = orderList(next
            .filter((p) => p && typeof p.id === 'string' && p.id && !isDeletedName(p.name))
            .map((p) => ({
              id: p.id,
              name: p.name || '',
              chars: (typeof p.chars === 'number') ? p.chars : null,
              dirty: !!p.dirty,
              published: !!p.published,
            })));
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
    current,
    list,
    refresh,
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
    activeIdKey,
    onChange,
  };
})(typeof window !== 'undefined' ? window : self);
