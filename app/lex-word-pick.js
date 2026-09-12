// lex-word-pick.js — выбор слов нажатием: одна общая часть на все поверхности.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ ФАЙЛ. Механизм «нажал на слово → оно копится в наборе → набор
// уходит учителю одной репликой» родился внутри субтитров и был написан там
// точечно: набор лежал приватным массивом в content.js, а нарезка текста на
// слова существовала в ДВУХ независимых построителях (панель транскрипта и
// бегущая строка), написанных по-разному. Дальше тот же механизм нужен чату, а
// потом произвольным страницам — с третьей копией он бы разъехался так же, как
// разъезжались списки в lex-surface-deps.js.
//
// ГРАНИЦА (решение владельца). Здесь живёт то, что одинаково для всех
// поверхностей:
//   • хранение набора выбранных слов;
//   • порядок слов в наборе (по тексту, а не по порядку нажатий);
//   • подсветка выбранного слова;
//   • ряд фишек над строкой ввода (их состав; доставку в своё окно делает
//     поверхность — окна у поверхностей разные);
//   • признак источника и замок поверхности.
//   • предел ряда фишек (не больше трёх строк; мерит поверхность — rowsFor);
//   • места набора для сервера (sendPicks). Сам вопрос учителю — порядок слов,
//     отрывок вокруг каждого места, скобки, строки Word/Context — собирает
//     СЕРВЕР (supabase/functions/_shared/word-pick.ts), один на все поверхности.
// В адаптере поверхности остаётся её своё:
//   • как разрезать текст на слова (что подать в renderLine);
//   • где лежат её слова: живой текст словами и места набора в нём (placesOf);
//   • сколько строк займёт её ряд фишек (rowsFor);
//   • что сделать, когда набор ушёл учителю (onSent) — опустошить набор.
//     Касания слов для базы знаний ученика пишет сервер.
//
// Модуль НЕ ЗНАЕТ про таймкоды, cue и субтитры. Всё, что нужно поверхности для
// её собственных расчётов, она кладёт в pick.meta — модуль туда не смотрит.
//
// Вход от поверхности — описание выбранного слова (pick):
//   { key, word, source, fallback, meta }
//     key      — опознавательный ярлык МЕСТА слова, по нему снимается выбор
//                (нажатие на фишку и повторное нажатие по слову — одно и то же
//                действие). Разные места одного и того же слова — разные ярлыки;
//     word     — само слово, уже очищенное (stripPunctuation);
//     source   — признак источника: с какой поверхности пришло слово;
//     fallback — запасной кусок { words, from, to }: значение ЛИБО функция.
//                Уходит серверу, когда живого текста с этим словом нет;
//     meta     — своё поверхности, модулю непрозрачно;
//     silent   — необязательный: единица БЕЗ фишки. Кусок из нескольких слов,
//                выделенный карандашом, уже стоит текстом в поле ввода, поэтому
//                над полем не показывается и в список Words не входит — но его
//                место уходит серверу наравне со словами.
//
// Наружу: add / remove / toggle / clear / text / chips / sendPicks, плюс
// отрисовка строки слов (renderLine) и подсветка.
(function (global) {
  'use strict';

  if (global.LexWordPick) return;

  const TAG = '[lex-word-pick]';
  const SELECTED_CLASS = 'vocab-word--selected';
  const WORD_CLASS = 'vocab-word';
  // Полный исходный кусок текста (слово вместе с прилипшей пунктуацией) —
  // пишется на спан, когда он отличается от того, что осталось внутри спана.
  // Нужен читателям, которым важен текст КАК В ИСХОДНИКЕ: границу предложения
  // при сборке контекста ищут по хвостовой пунктуации, а её в спане больше нет.
  const TOKEN_ATTR = 'lexTok';

  // Буква или цифра ЛЮБОГО языка. Тот же набор, что в stripPunctuation
  // (shared.js): решение «это слово, по нему можно нажать» и решение «что от
  // слова остаётся после очистки» обязаны совпадать, иначе появится нажимаемое
  // слово, которое очищается в пустую строку.
  const WORD_CHAR_RE = /[\p{L}\p{N}]/u;

  // ── Нарезка одного куска на «до / слово / после» ─────────────────────────
  //
  // Ядро — от первой буквы или цифры до последней включительно. Поэтому точка,
  // запятая, кавычки и скобки остаются СНАРУЖИ ядра, а апостроф и дефис внутри
  // слова («don't», «well-known») — внутри. Кусок без единой буквы и цифры
  // («...», «—», «>>») ядра не имеет вовсе: нажимаемым он не станет.
  function splitToken(text) {
    const s = String(text == null ? '' : text);
    let at = 0;
    let first = -1;
    let last = -1;
    // Обход по кодовым точкам, а не по s[i]: символы вне BMP занимают два
    // индекса, и посимвольная проверка разрезала бы их пополам.
    for (const ch of s) {
      if (WORD_CHAR_RE.test(ch)) {
        if (first < 0) first = at;
        last = at + ch.length;
      }
      at += ch.length;
    }
    if (first < 0) return { lead: '', core: '', trail: s };
    return { lead: s.slice(0, first), core: s.slice(first, last), trail: s.slice(last) };
  }

  function isWord(text) {
    return WORD_CHAR_RE.test(String(text == null ? '' : text));
  }

  // Исходный кусок текста этого слова — со знаками препинания, как в тексте.
  function tokenOf(span) {
    if (!span) return '';
    const raw = span.dataset ? span.dataset[TOKEN_ATTR] : null;
    return (raw != null && raw !== '') ? raw : String(span.textContent || '');
  }

  // ── Отрисовка строки слов — ОДНА на все поверхности ──────────────────────
  //
  // tokens: [{ text, startMs?, cueIdx?, place?, br? }] — куски в порядке чтения.
  // Поверхность отвечает только за то, как она их набрала; правила ниже общие:
  //
  //   • между кусками — РОВНО ОДИН пробел, и это настоящий текстовый узел, а
  //     не отступ оформления. Поэтому текст, выделенный мышью и скопированный
  //     из субтитров, вставляется в блокнот с пробелами и без мусора;
  //   • знак препинания не входит в нажимаемое слово: «food.» даёт спан «food»
  //     и текстовый узел «.» рядом. Подсветка накрывает только буквы, а сама
  //     точка — обычный текст: слово по ней не выбирается и не подсвечивается,
  //     во всём остальном она ведёт себя как соседний пробел (решение
  //     владельца 2026-08-18). У панели транскрипта это значит, что нажатие
  //     по ней перематывает видео к началу предложения, как и было до выноса;
  //   • кусок без букв и цифр (« ... », «—», «>>») спана не получает вовсе —
  //     нажимаемым словом он не становится;
  //   • { br: true } — перевод строки внутри строки (многострочный cue).
  //     Пробел вокруг него не ставится.
  function renderLine(lineEl, tokens) {
    if (!lineEl) return lineEl;
    const list = Array.isArray(tokens) ? tokens : [];
    let needSpace = false;
    for (let i = 0; i < list.length; i++) {
      const tok = list[i];
      if (!tok) continue;
      if (tok.br) {
        lineEl.appendChild(document.createElement('br'));
        needSpace = false;
        continue;
      }
      const text = String(tok.text == null ? '' : tok.text);
      if (!text) continue;
      if (needSpace) lineEl.appendChild(document.createTextNode(' '));
      needSpace = true;
      const { lead, core, trail } = splitToken(text);
      if (!core) {
        lineEl.appendChild(document.createTextNode(text));
        continue;
      }
      if (lead) lineEl.appendChild(document.createTextNode(lead));
      const span = document.createElement('span');
      span.className = WORD_CLASS;
      span.textContent = core;
      if (core !== text) span.dataset[TOKEN_ATTR] = text;
      const cueIdx = Number(tok.cueIdx);
      if (tok.cueIdx != null && Number.isFinite(cueIdx) && cueIdx >= 0) {
        span.dataset.cueIdx = String(cueIdx);
      }
      const ms = Number(tok.startMs);
      if (Number.isFinite(ms)) span.dataset.startMs = String(ms);
      // Место слова в тексте, которое поверхность посчитала сама (у субтитров —
      // «кусок + номер слова в куске»). Модуль его не толкует, только кладёт на
      // спан: по нему поверхность опознаёт слово, когда одно и то же место
      // живёт двумя копиями.
      if (tok.place != null && tok.place !== '') span.dataset.lexPlace = String(tok.place);
      lineEl.appendChild(span);
      if (trail) lineEl.appendChild(document.createTextNode(trail));
    }
    // Строка собрана заново — вернуть на неё подсветку выбранных слов. Бегущая
    // строка пересобирается на каждой смене куска, поэтому без этого выбор
    // пропадал бы с экрана, оставаясь в наборе.
    decorateLine(lineEl);
    return lineEl;
  }

  // ── Набор выбранных слов ─────────────────────────────────────────────────
  const picks = [];
  let pickKeys = new Set();
  // Поверхности регистрируют свои адаптеры один раз; ключ — признак источника.
  const adapters = new Map();
  // Кто владел набором последним. Нужен на очистке: набор уже пуст, а спросить
  // адаптер (например, обновить подсветку его правилами) всё ещё надо.
  let lastSource = null;

  // Шесть зон телеметрии сводятся к трём значениям для учителя. Ключи — то,
  // что отдают zoneOf адаптеров (они же значения `calls.source`).
  const SOURCE_LABELS = {
    subtitles: 'subtitles',
    page: 'page text',
    comments: 'page text',
    description: 'page text',
    'video-title': 'page text',
    'lex-chat': 'chat',
  };

  function register(adapter) {
    if (!adapter || !adapter.source) {
      console.warn(TAG, 'register() без source — адаптер не принят');
      return;
    }
    adapters.set(String(adapter.source), adapter);
  }

  function adapterFor(source) {
    return adapters.get(String(source == null ? '' : source)) || null;
  }

  // ── Порядок слов в наборе — по тексту, а не по порядку нажатий ───────────
  //
  // Считается В МОМЕНТ ЧТЕНИЯ, а не в момент нажатия. Причина конкретная: у
  // субтитров положение слова в тексте выводится из состояния страницы (поток
  // слов панели транскрипта), и на первом нажатии панель может быть ещё не
  // собрана. Замороженный тогда порядок остался бы порядком нажатий навсегда,
  // и правило «по тексту» молча не работало бы ровно в том случае, в котором
  // его труднее всего заметить.
  //
  // Адаптер отдаёт положение числом или массивом чисел (сравнение
  // лексикографическое — так поверхность может дать грубую позицию и уточнение
  // к ней). Не смог определить — слово встаёт в конец, сохраняя порядок
  // нажатий среди таких же неопределившихся.
  function orderKeyOf(pick) {
    const ad = adapterFor(pick.source);
    if (!ad || typeof ad.orderOf !== 'function') return [];
    let raw = null;
    try { raw = ad.orderOf(pick); } catch (e) {
      console.warn(TAG, 'orderOf failed:', e && e.message);
      return [];
    }
    if (raw == null) return [];
    const arr = Array.isArray(raw) ? raw : [raw];
    const out = [];
    for (let i = 0; i < arr.length; i++) {
      const n = Number(arr[i]);
      if (!Number.isFinite(n)) break;   // с первого нечисла позиция обрывается
      out.push(n);
    }
    return out;
  }

  function cmpOrder(a, b) {
    if (!a.length && !b.length) return 0;
    if (!a.length) return 1;            // неизвестное — в конец
    if (!b.length) return -1;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return a.length - b.length;
  }

  function sortedPicks(list) {
    const rows = (list || picks).map((p, i) => ({ p, i, o: orderKeyOf(p) }));
    rows.sort((x, y) => cmpOrder(x.o, y.o) || (x.i - y.i));
    return rows.map((r) => r.p);
  }

  // ── Предел ряда фишек ────────────────────────────────────────────────────
  //
  // Фишки занимают не больше MAX_CHIP_ROWS строк над полем ввода. Прокрутки
  // внутри ряда нет, поэтому слово, с которым ряд не поместился бы, просто не
  // добавляется: ни подсветки, ни фишки. Убрать слово можно всегда — предел
  // стоит только на добавлении.
  //
  // Правило одно на все поверхности и живёт здесь; мерит ряд поверхность,
  // потому что ряд у каждой свой (adapter.rowsFor(labels) → сколько строк
  // займут фишки с такими подписями при нынешней ширине, либо null — «не знаю»,
  // тогда слово добавляется). Сузилось окно и уже выбранные фишки заняли
  // больше трёх строк — они остаются все (решение владельца 2026-09-12), а
  // новые не добавляются, пока ряд снова не влезет.
  const MAX_CHIP_ROWS = 3;

  function fitsChipRows(item) {
    const ad = adapterFor(item.source);
    if (!ad || typeof ad.rowsFor !== 'function') return true;
    const labels = sortedPicks(picks.concat([item])).filter((p) => !p.silent).map((p) => p.word);
    let rows = null;
    try { rows = ad.rowsFor(labels); } catch (e) {
      console.warn(TAG, 'rowsFor failed:', e && e.message);
      return true;
    }
    return !(Number.isFinite(rows) && rows > MAX_CHIP_ROWS);
  }

  // Сколько строк займёт ряд фишек с такими подписями — общий замер для
  // поверхностей, у которых ряд нарисован в DOM. Пробный ряд ставится туда же,
  // где стоит настоящий (parent + перед refNode), с теми же классами, поэтому
  // ширина и перенос у него ровно те же; снимается в том же проходе скрипта, и
  // браузер его не рисует. Родитель не показан (ширина ноль) — null.
  function measureChipRows(parent, refNode, cls, labels) {
    if (!parent || typeof document === 'undefined') return null;
    const probe = document.createElement('div');
    probe.className = cls.strip;
    probe.setAttribute('aria-hidden', 'true');
    probe.style.visibility = 'hidden';
    probe.hidden = false;
    (Array.isArray(labels) ? labels : []).forEach((label) => {
      const chip = document.createElement('span');
      chip.className = cls.chip;
      const text = document.createElement('span');
      text.className = cls.label;
      text.textContent = String(label);
      chip.appendChild(text);
      probe.appendChild(chip);
    });
    parent.insertBefore(probe, refNode && refNode.parentNode === parent ? refNode : null);
    const width = probe.offsetWidth;
    let rows = 0;
    let lastTop = null;
    for (let i = 0; i < probe.children.length; i++) {
      const top = probe.children[i].offsetTop;
      if (lastTop === null || top > lastTop + 1) { rows++; lastTop = top; }
    }
    probe.remove();
    return width ? rows : null;
  }

  // ── Замок поверхности ────────────────────────────────────────────────────
  //
  // Набор однороден: пока в нём есть хоть одно слово, слово с ДРУГОЙ
  // поверхности в него не ложится. Иначе в одной реплике учителю ушли бы
  // куски текста из несвязанных мест, а кусок вокруг слова у каждой поверхности
  // добывается по-своему — склеить их в один осмысленный контекст нечем.
  // Набор пустеет двумя путями: реплика отправлена или все слова убраны руками.
  function lockedSource() {
    return picks.length ? picks[0].source : null;
  }

  function normalizePick(pick) {
    if (!pick) return null;
    const key = pick.key == null ? '' : String(pick.key);
    const word = pick.word == null ? '' : String(pick.word);
    if (!key || !word) return null;
    return {
      key,
      word,
      source: pick.source == null ? '' : String(pick.source),
      // silent — единица набора БЕЗ фишки. Такую кладёт карандаш над куском из
      // нескольких слов: сам кусок уже стоит текстом в поле ввода (это вопрос
      // человека, а не единица разбора), поэтому над полем он не повторяется и
      // в список Words не входит. В наборе он лежит ради ОДНОГО — чтобы его
      // место ушло серверу наравне с выбранными словами (строка Selection и
      // своя пара скобок в отрывке).
      silent: !!pick.silent,
      fallback: pick.fallback,
      meta: pick.meta || null,
    };
  }

  // Положить слово. Возвращает true, если набор изменился.
  function add(pick) {
    const item = normalizePick(pick);
    if (!item) return false;
    const locked = lockedSource();
    if (locked !== null && locked !== item.source) {
      // Не ошибка и не сбой: так и задумано. След в логе нужен затем, что для
      // человека нажатие просто «ничего не сделало».
      lexPickLog('слово с поверхности «' + item.source + '» отклонено: набор занят «' + locked + '»');
      return false;
    }
    if (pickKeys.has(item.key)) return false;
    if (!item.silent && !fitsChipRows(item)) {
      lexPickLog('слово «' + item.word + '» не добавлено: ряд фишек занял бы больше ' + MAX_CHIP_ROWS + ' строк');
      return false;
    }
    picks.push(item);
    pickKeys.add(item.key);
    lastSource = item.source;
    refreshHighlight();
    return true;
  }

  // Убрать слово по ярлыку. Крестик на фишке и повторное нажатие по слову в
  // тексте — это одно и то же действие: набор единственный источник правды,
  // поэтому снятое сюда же и не уедет учителю.
  function remove(key) {
    const k = key == null ? '' : String(key);
    const at = picks.findIndex((p) => p.key === k);
    if (at < 0) return false;
    picks.splice(at, 1);
    pickKeys = new Set(picks.map((p) => p.key));
    refreshHighlight();
    return true;
  }

  function toggle(pick) {
    const item = normalizePick(pick);
    if (!item) return false;
    if (pickKeys.has(item.key)) return remove(item.key);
    return add(item);
  }

  function clear() {
    if (!picks.length) return false;
    picks.length = 0;
    pickKeys = new Set();
    refreshHighlight();
    return true;
  }

  function has(key) {
    return pickKeys.has(key == null ? '' : String(key));
  }

  function size() {
    return picks.length;
  }

  function items() {
    return sortedPicks().slice();
  }

  // ── Откуда взят набор ────────────────────────────────────────────────────
  //
  // ОДНО место на весь Lex, где этот вопрос решается. Читателей два, и им
  // нужна разная подробность: сервер, собирая вопрос, сводит ответ к трём
  // значениям для учителя (строка Source), а колонка `calls.source`
  // (lex-word-to-chat.js) пишет подробный. Свод — там, где он нужен; сам
  // ответ — здесь, иначе две реализации разошлись бы и учитель с телеметрией
  // рассказывали бы про один ход разное.
  //
  // Отвечает АДАПТЕР поверхности (zoneOf), а не разбор строки источника
  // общим модулем: 'page-text', 'subtitles' и 'chat:<окно>' — имена, которые
  // придумали сами поверхности, и знать их здесь незачем. У страницы ответ
  // вдобавок зависит от единицы (карандаш несёт свою зону, нажатие — нет),
  // и это знает только она.
  //
  // null — набор пуст либо адаптер зоны не объявил. Второе — дефект: набор
  // есть, а сказать о нём нечего. Кричит тот, кому это помешало.
  function sourceZone() {
    const list = sortedPicks();
    if (!list.length) return null;
    const ad = adapterFor(list[0].source);
    if (!ad || typeof ad.zoneOf !== 'function') return null;
    try {
      const z = ad.zoneOf(list);
      return z ? String(z) : null;
    } catch (e) {
      console.warn(TAG, 'zoneOf failed:', e && e.message);
      return null;
    }
  }

  // Набор ушёл учителю — сказать его владельцу. Тот пишет касания слов и
  // опустошает набор (обе эти вещи знает только он: у субтитров своя метка
  // источника и своя зона, у страницы свои).
  //
  // Зачем через модуль, а не напрямую: зовущий (приёмник lex-word-to-chat.js)
  // видит окно чата, а не поверхность, с которой слова пришли. Владелец
  // выводится из самого набора — по замку, — и это единственное место, где он
  // известен наверняка.
  //
  // Возвращает false, когда у владельца нет onSent. Это НЕ обязательно ошибка:
  // окна чата регистрируют свой источник без него — набор, выбранный в тексте
  // самого окна, окно опустошает у себя на отправке. Решать, что делать с
  // false, — зовущему: он один знает, ждал он опустошения или нет.
  function notifySent() {
    const ad = adapterFor(lockedSource());
    if (!ad || typeof ad.onSent !== 'function') return false;
    try { ad.onSent(); } catch (e) {
      console.warn(TAG, 'onSent failed:', e && e.message);
      return false;
    }
    return true;
  }

  // ── Подсветка ────────────────────────────────────────────────────────────
  //
  // Слово опознаётся по ярлыку, а не по узлу DOM: один и тот же кусок текста
  // может жить сразу двумя спанами (у субтитров это бегущая строка и панель
  // транскрипта), и один из них вдобавок пересобирается на каждой смене куска.
  // Ярлык переживает и то, и другое — поэтому снять выбор можно с любой копии,
  // а подсветка возвращается на пересобранную строку сама.
  function keyForSpan(span) {
    if (!span || !span.classList || !span.classList.contains(WORD_CLASS)) return null;
    const ad = adapterFor(lockedSource() || lastSource);
    if (ad && typeof ad.keyForSpan === 'function') {
      try { return ad.keyForSpan(span); } catch (e) {
        console.warn(TAG, 'keyForSpan failed:', e && e.message);
        return null;
      }
    }
    return null;
  }

  // Подсветка одной строки — зовётся сразу после её сборки.
  function decorateLine(lineEl) {
    if (!lineEl || !pickKeys.size) return;
    const spans = lineEl.querySelectorAll('.' + WORD_CLASS);
    for (let i = 0; i < spans.length; i++) {
      if (pickKeys.has(keyForSpan(spans[i]))) spans[i].classList.add(SELECTED_CLASS);
    }
  }

  // Полный проход — после каждого изменения набора. Считает ярлык у всех слов
  // на странице; это тысячи спанов панели, но происходит только по нажатию
  // человека, не в цикле отрисовки.
  function refreshHighlight() {
    if (typeof document === 'undefined') return;
    const spans = document.querySelectorAll('.' + WORD_CLASS);
    for (let i = 0; i < spans.length; i++) {
      const s = spans[i];
      const on = pickKeys.size > 0 && pickKeys.has(keyForSpan(s));
      if (on !== s.classList.contains(SELECTED_CLASS)) s.classList.toggle(SELECTED_CLASS, on);
    }
  }

  function highlightedCount() {
    if (typeof document === 'undefined') return 0;
    return document.querySelectorAll('.' + SELECTED_CLASS).length;
  }

  // ── Что уходит учителю ───────────────────────────────────────────────────
  //
  // С 2026-09-12 вопрос учителю собирает СЕРВЕР (supabase/functions/_shared/
  // word-pick.ts): порядок слов, отрывок вокруг каждого места, скобки ⟦…⟧ и
  // строки Word/Selection/Context/Source. Поверхность отдаёт ему три вещи —
  // куски текста словами, выбранные места в них и откуда взят набор
  // (sendPicks ниже). Своего счёта отрывка у поверхностей больше нет: до этого
  // он жил здесь и в пяти адаптерах, а айфон не считал его вовсе.

  // Единицы набора, у которых есть фишка: всё, кроме silent. Через них идут и
  // строка слов, и полоска фишек — то есть весь путь «что человек выбрал», в
  // котором молчаливому куску делать нечего.
  function chipPicks() {
    return sortedPicks().filter((p) => !p.silent);
  }

  // Слова разделяются ПРОБЕЛОМ, без запятых (решение владельца 2026-08-17).
  // Строка нужна шапке окна: в композере слова стоят фишками, а текстом
  // реплики становятся уже на отправке.
  function text() {
    return chipPicks().map((p) => p.word).join(' ');
  }

  // Фишки над строкой ввода — по одной на выбранное слово. Ярлык тот же, что у
  // набора: нажатие на фишку снимает слово по нему, не отличаясь от повторного
  // нажатия по самому слову. Крестика у фишки слова нет ни на одной поверхности.
  function chips() {
    return chipPicks().map((p) => ({ key: p.key, label: p.word }));
  }

  // Сколько слов текста брать по обе стороны от выбранных мест. Кусок уходит
  // на сервер не целиком (расшифровка часового ролика — тысячи слов на каждый
  // ход), а окрестностью мест; окно учителя (не меньше десяти слов в сторону и
  // дальше до границы предложения) укладывается в неё с большим запасом. Места,
  // между которыми больше двух запасов, уходят разными кусками — их окна всё
  // равно не сошлись бы.
  const PICK_BLOCK_MARGIN = 400;
  // Кусок длиннее — не слово (ссылка, склеенный мусор разметки). Сервер такой
  // не примет, поэтому режется здесь, а не роняет ход.
  const PICK_TOKEN_MAX = 2000;

  function isSelectionUnit(p) {
    const tap = p && p.meta && p.meta.tap;
    return !!(tap && tap.source === 'selection');
  }

  // Запасной кусок единицы: { words, from, to } — строка слов и место в ней.
  // Поверхность кладёт его в pick.fallback (значение или функция; функция
  // зовётся здесь, в момент сборки хода). Нужен, когда живого текста с этим
  // словом уже нет (пузырь пересобрали, страницу перерисовали) или ещё нет
  // (панель расшифровки не собрана). Нет и его — единица уходит сама собой:
  // кусок из её собственных слов.
  function fallbackOf(pick) {
    let fb = pick && pick.fallback;
    if (typeof fb === 'function') {
      try { fb = fb(); } catch (e) {
        console.warn(TAG, 'fallback() failed:', e && e.message);
        fb = null;
      }
    }
    if (fb && Array.isArray(fb.words) && Number.isInteger(fb.from) && Number.isInteger(fb.to)
        && fb.from >= 0 && fb.to >= fb.from && fb.to < fb.words.length
        && (pick.silent || fb.from === fb.to)) {
      return fb;
    }
    const own = String((pick && pick.word) || '').split(/\s+/).filter(Boolean);
    if (!own.length) return null;
    return { words: own, from: 0, to: pick.silent ? own.length - 1 : 0 };
  }

  // Большой кусок — окрестности мест, а не весь.
  function sliceStream(words, units) {
    const sorted = units.slice().sort((a, b) => (a.from - b.from) || (a.to - b.to));
    const groups = [];
    sorted.forEach((u) => {
      const g = groups[groups.length - 1];
      if (g && u.from <= g.hi + 2 * PICK_BLOCK_MARGIN) {
        g.units.push(u);
        if (u.to > g.hi) g.hi = u.to;
      } else {
        groups.push({ lo: u.from, hi: u.to, units: [u] });
      }
    });
    return groups.map((g) => {
      const start = Math.max(0, g.lo - PICK_BLOCK_MARGIN);
      const end = Math.min(words.length - 1, g.hi + PICK_BLOCK_MARGIN);
      return {
        words: words.slice(start, end + 1),
        units: g.units.map((u) => ({ pick: u.pick, from: u.from - start, to: u.to - start })),
      };
    });
  }

  // Места набора для сервера: { zone, blocks: [{ words }], units: [{ block,
  // from, to, chip, via? }] }. null — набор пуст.
  //
  // Живой текст и места в нём отдаёт адаптер поверхности (placesOf) — только он
  // знает, где его слова лежат. Единица, которую адаптер не нашёл, уходит своим
  // запасным куском. Одно место дважды (одно и то же слово, выбранное через две
  // копии) уходит один раз: это одно и то же нажатое место. Прочие ошибки мест
  // сервер не чинит — отказывает (validatePicks).
  function sendPicks() {
    const list = sortedPicks();
    if (!list.length) return null;
    const zone = sourceZone();
    if (!zone) {
      console.error(TAG, 'источник набора не определился — места учителю не отправляются');
      return null;
    }
    const ad = adapterFor(list[0].source);
    let streams = [];
    if (ad && typeof ad.placesOf === 'function') {
      try { streams = ad.placesOf(list) || []; } catch (e) {
        console.warn(TAG, 'placesOf failed:', e && e.message);
        streams = [];
      }
    }
    const order = new Map(list.map((p, i) => [p, i]));
    const placed = new Set();
    const parts = [];
    streams.forEach((s) => {
      const words = s && Array.isArray(s.words) ? s.words : [];
      const seen = new Set();
      const units = (s && Array.isArray(s.units) ? s.units : []).filter((u) => {
        if (!u || !order.has(u.pick) || placed.has(u.pick)) return false;
        if (!Number.isInteger(u.from) || !Number.isInteger(u.to)) return false;
        if (u.from < 0 || u.to < u.from || u.to >= words.length) return false;
        if (!u.pick.silent && u.from !== u.to) return false;
        const k = u.from + ':' + u.to;
        if (seen.has(k)) { placed.add(u.pick); return false; }
        seen.add(k);
        return true;
      });
      if (!units.length) return;
      units.forEach((u) => placed.add(u.pick));
      sliceStream(words, units).forEach((p) => parts.push(p));
    });
    list.forEach((p) => {
      if (placed.has(p)) return;
      const fb = fallbackOf(p);
      if (!fb) return;
      placed.add(p);
      parts.push({ words: fb.words, units: [{ pick: p, from: fb.from, to: fb.to }] });
    });
    if (!parts.length) return null;
    // Куски — в порядке текста: по самому раннему месту набора в каждом.
    const first = (part) => Math.min.apply(null, part.units.map((u) => order.get(u.pick)));
    parts.sort((a, b) => first(a) - first(b));
    const blocks = [];
    const units = [];
    parts.forEach((part) => {
      const bi = blocks.length;
      blocks.push({
        words: part.words.map((w) => {
          const s = String(w == null ? '' : w);
          return s.length > PICK_TOKEN_MAX ? s.slice(0, PICK_TOKEN_MAX) : s;
        }),
      });
      part.units.forEach((u) => {
        const unit = { block: bi, from: u.from, to: u.to, chip: !u.pick.silent };
        if (isSelectionUnit(u.pick)) unit.via = 'selection';
        units.push(unit);
      });
    });
    return { zone, blocks, units };
  }

  // ── Обратная операция: снять скрытую часть с сохранённого хода ───────────
  //
  // ПЕРЕЕХАЛО СЮДА ИЗ chat-surface.js (2026-08-23) — тело буква в букву.
  // Причина переезда: ту же ленту перечитывает страница `lex-me.club/app`, и
  // копия правила у неё не сторожилась бы ничем. Цена расхождения известна и
  // измерена: ход человека пропадает из ленты ЦЕЛИКОМ (реплей принимает его за
  // служебную инструкцию). Прямую операцию — сборку вопроса — с 2026-09-12
  // делает сервер (supabase/functions/_shared/word-pick.ts buildPickTurn); эти
  // две половины одного правила обязаны править вместе.
  //
  // Выбранные слова уезжают учителю скрытым префиксом
  // 'Word(s): "…"\nContext: "…"' перед напечатанным текстом; окно приклеивает
  // его через пустую строку. В ленте человек видит только напечатанное —
  // значит и реплей обязан показывать только его.
  //
  // Граница — ПЕРВОЕ '"\n\n' после открывающей кавычки Context. Разделителя,
  // которого не бывает в тексте, здесь нет: и куски контекста, и напечатанное
  // могут содержать кавычку. Промахнуться можно только на куске контекста,
  // ОКАНЧИВАЮЩЕМСЯ кавычкой — тогда в пузырь попадёт хвост контекста. Выбрано
  // именно так, потому что обратный выбор (последнее вхождение) в своём
  // промахе съедал бы НАЧАЛО написанного человеком, а терять его слова хуже,
  // чем показать лишнее.
  function stripHiddenPickPrefix(s) {
    const src = String(s == null ? '' : s);
    // Форм несколько, и все они появились вместе с контекстом у выделенного
    // куска (2026-08-20): кусок карандаша называется своей строкой
    // 'Selection(s): "…"', фишки — прежними 'Word(s): "…"', а у ходов того дня
    // скрытая часть начиналась прямо с 'Context: "' (строки Selection тогда ещё
    // не было — форма оставлена ради них). Не узнать любую из них здесь значило
    // бы худшее из возможного: ход человека содержал бы ⟦ и целиком пропал бы
    // из реплея как служебная инструкция (isHiddenOnlyText ниже).
    if (!/^(?:Words?:\s*"|Selections?:\s*"|Context:\s*")/.test(src)) return src;
    const ctxAt = src.search(/(?:^|\n)Context:\s*"/);
    if (ctxAt < 0) return src;                       // не наша форма — не трогаем
    const openAt = src.indexOf('"', ctxAt);
    // Между закрывающей кавычкой Context и пустой строкой может стоять строка
    // источника — 'Source: chat' (2026-08-21, три значения: subtitles / page
    // text / chat). Необязательная: у хода без выбранных слов её нет вовсе, и у
    // ходов, сделанных до её появления, тоже. Не узнать её здесь значило бы
    // худшее из возможного: граница не нашлась бы, и ход человека пропал бы из
    // реплея ЦЕЛИКОМ.
    const tail = src.slice(openAt + 1);
    const m = /"\n(?:Source:[^\n]*\n)?\n/.exec(tail);
    return m ? tail.slice(m.index + m[0].length) : '';  // ничего после — ход и есть инструкция
  }

  // Ход, который показывать нечего — по УЖЕ очищенному видимому тексту. Два
  // случая: скрытая часть съела его целиком (легаси-инструкция выключенного
  // лексического попапа) и кодовая метка ⟦, которой в написанном человеком не
  // бывает (инструкция иной исторической формы — до появления 'Word: "…"').
  function isHiddenOnlyText(visible) {
    const v = String(visible == null ? '' : visible);
    return !v.trim() || v.indexOf('⟦') !== -1;
  }

  // ── Протяжка мышью — это копирование, а не выбор ─────────────────────────
  //
  // Человек тянет мышью через несколько слов, чтобы выделить и скопировать
  // текст. Нажатие по итогам такой протяжки не должно ни выбирать слово, ни
  // делать что-либо ещё по нажатию (у субтитров вторая ветка того же
  // обработчика перематывала видео на начало строки, через которую тянули).
  //
  // Два условия, оба обязательны: курсор сместился между нажатием и
  // отпусканием И в момент отпускания есть выделенный текст. Одного мало:
  // дрожание руки на нажатии даёт смещение без выделения, а выделение может
  // остаться на странице с прошлого раза.
  const DRAG_SLOP_PX = 4;
  let lastDownAt = null;

  function noteMouseDown(e) {
    if (!e || e.button !== 0) return;
    lastDownAt = { x: e.clientX, y: e.clientY };
  }

  function isDragRelease(e) {
    if (!e || !lastDownAt) return false;
    const dx = e.clientX - lastDownAt.x;
    const dy = e.clientY - lastDownAt.y;
    if (Math.hypot(dx, dy) <= DRAG_SLOP_PX) return false;
    let sel = null;
    try { sel = global.getSelection ? global.getSelection() : null; } catch (_) { return false; }
    if (!sel || sel.isCollapsed) return false;
    return !!String(sel).trim();
  }

  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('mousedown', noteMouseDown, true);
  }

  function lexPickLog(msg) {
    try {
      if (typeof global.lexLog === 'function') global.lexLog(TAG, msg);
    } catch (_) { /* лог никогда не мешает работе */ }
  }

  // Дев-инспекция: что сейчас выбрано и что из этого уйдёт серверу. Только
  // чтение — набор не меняет. Видно и порядок набора, и сами места в кусках.
  function inspect() {
    const list = sortedPicks();
    return {
      words: list.map((p) => p.word),
      keys: list.map((p) => p.key),
      silent: list.map((p) => !!p.silent),
      picks: sendPicks(),
      highlighted: highlightedCount(),
    };
  }

  global.LexWordPick = {
    // нарезка и отрисовка
    renderLine,
    splitToken,
    isWord,
    tokenOf,
    // набор
    register,
    add,
    remove,
    toggle,
    clear,
    has,
    size,
    items,
    lockedSource,
    notifySent,
    // предел ряда фишек и общий замер ряда в DOM
    MAX_CHIP_ROWS,
    measureChipRows,
    // что уходит учителю: места набора; вопрос из них собирает сервер
    text,
    chips,
    sourceZone,
    sendPicks,
    PICK_BLOCK_MARGIN,
    // обратная операция к сборке вопроса: что из сохранённого хода видит человек
    stripHiddenPickPrefix,
    isHiddenOnlyText,
    // подсветка
    decorateLine,
    refreshHighlight,
    // протяжка
    isDragRelease,
    // дев
    inspect,
    SELECTED_CLASS,
    WORD_CLASS,
  };
})(typeof self !== 'undefined' ? self : globalThis);
