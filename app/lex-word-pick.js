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
// В адаптере поверхности остаётся её своё:
//   • как разрезать текст на слова (что подать в renderLine);
//   • как достать кусок текста вокруг слова (contextBlocks / pick.context);
//   • что сделать, когда набор ушёл учителю (onSent) — поверхность пишет свои
//     касания слов в public.word_taps и опустошает набор сама. Модуль только
//     зовёт владельца (notifySent), потому что знает, чей набор, а поверхность
//     знает, ЧТО про него записать.
//
// Модуль НЕ ЗНАЕТ про таймкоды, cue и субтитры. Всё, что нужно поверхности для
// её собственных расчётов, она кладёт в pick.meta — модуль туда не смотрит.
//
// Вход от поверхности — описание выбранного слова (pick):
//   { key, word, source, context, meta }
//     key     — опознавательный ярлык, по нему снимается выбор (крестик на
//               фишке и повторное нажатие — одно и то же действие);
//     word    — само слово, уже очищенное (stripPunctuation);
//     source  — признак источника: с какой поверхности пришло слово;
//     context — кусок текста вокруг слова: строка ЛИБО функция. Функция нужна
//               субтитрам: кусок зависит от состояния страницы и считается в
//               момент сборки запроса, а не в момент нажатия;
//     meta    — своё поверхности, модулю непрозрачно;
//     silent  — необязательный: единица БЕЗ фишки. Кусок из нескольких слов,
//               выделенный карандашом, уже стоит текстом в поле ввода, поэтому
//               над полем не показывается и в список Words не входит — но окно
//               контекста ему считается и склеивается наравне со словами.
//
// Наружу: add / remove / toggle / clear / text / chips / contextBlocks /
// sendPrefix, плюс отрисовка строки слов (renderLine) и подсветка.
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

  // ── Обводка единицы разбора в куске текста ───────────────────────────────
  //
  // Кусок текста, который уезжает учителю, печатается СЛОВАМИ ПОТОКА, а слово
  // потока несёт свою пунктуацию: «Ethiopia.», «(HTML)"», «well-known,». Это
  // нужно счётчику окна — границу предложения он ищет по хвосту слова. Но
  // обводить надо не весь кусок, а ту единицу, о которой спрашивают: в строке
  // `Word` стоит «Ethiopia», и внутри ⟦…⟧ обязано стоять то же самое, иначе
  // учитель ищет названное и не находит его в скобках буква в букву.
  //
  // Поэтому скобка ставится по ядру, а не по краю куска:
  //   «region of ⟦Ethiopia⟧.», а не «region of ⟦Ethiopia.⟧».
  // Сам знак препинания при этом НИКУДА не девается — кусок остаётся дословным
  // текстом страницы, двигается только граница скобки (решение владельца).
  //
  // Считаем, а не помечаем флагом: у одного слова скобок может сойтись
  // несколько (слово выбрано и отдельно, и внутри куска карандаша), и потерять
  // одну пару значит выпустить в запрос непарные скобки.
  //
  // Одна функция на все поверхности — субтитры, три окна чата и чужую
  // страницу. Пять копий этой строки уже разъезжались бы порознь.
  function markToken(token, opens, closes) {
    const raw = String(token == null ? '' : token);
    const o = Math.max(0, Number(opens) || 0);
    const c = Math.max(0, Number(closes) || 0);
    if (!o && !c) return raw;
    const { lead, core, trail } = splitToken(raw);
    // Кусок без единой буквы и цифры ядра не имеет — обводим целиком, иначе
    // скобки схлопнулись бы в пустое место и пара потерялась бы.
    if (!core) return '⟦'.repeat(o) + raw + '⟧'.repeat(c);
    return lead + '⟦'.repeat(o) + core + '⟧'.repeat(c) + trail;
  }


  // ── Окно контекста вокруг единицы разбора ────────────────────────────────
  //
  // ПЕРЕЕХАЛО СЮДА ИЗ shared.js (2026-08-23) — целиком, буква в букву. Причина
  // переезда: тот же счёт понадобился странице `lex-me.club/app`, а `shared.js`
  // туда не подключить (он весь про расширение и `chrome.*`). Копия этих
  // счётчиков в вебе разъехалась бы с оригиналом молча, и учитель получал бы
  // отрывки разной ширины на двух поверхностях одного продукта. Дом выбран
  // этот, потому что склейка уже звала отсюда `markToken`, а сам модуль уже
  // грузится обеими поверхностями.
  //
  // `shared.js` теперь ДЕЛЕГИРУЕТ сюда, не повторяя ни строчки: `VocabShared`
  // по-прежнему отдаёт те же имена, и ни один читатель расширения не заметил
  // разницы.
  //
  // Собрать отрывок, который Lex посылает учителю про нажатое слово: взять не
  // меньше minWords слов с каждой стороны, дальше дотянуть каждую сторону до
  // ближайшей границы предложения, а саму единицу обвести ⟦…⟧ — тогда её место
  // однозначно даже когда слово в отрывке повторяется. Границу предложения
  // ищем по самим словам: слово потока несёт свою хвостовую пунктуацию.
  const LEX_CONTEXT_MIN_WORDS = 10;
  const LEX_CONTEXT_SENT_END = /[.!?…]/;
  // Ширина окна считается СЧЁТЧИКАМИ, а строка режется по ним. Выбору
  // нескольких слов границы нужны затем, что пересекающиеся окна склеиваются по
  // индексам слов, а не по тексту: склейка текстов не отличила бы «одно и то же
  // место» от «два раза одинаковый кусок».
  function takeContextLeftCount(beforeWords, minWords) {
    let n = 0;
    for (let i = beforeWords.length - 1; i >= 0; i--) {
      n++;
      if (n >= minWords) {
        if (i === 0 || LEX_CONTEXT_SENT_END.test(beforeWords[i - 1])) break;
      }
    }
    return n;
  }
  function takeContextRightCount(afterWords, minWords) {
    let n = 0;
    for (let i = 0; i < afterWords.length; i++) {
      n++;
      if (n >= minWords && LEX_CONTEXT_SENT_END.test(afterWords[i])) break;
    }
    return n;
  }
  function takeContextLeft(beforeWords, minWords) {
    const n = takeContextLeftCount(beforeWords, minWords);
    return n ? beforeWords.slice(beforeWords.length - n).join(' ') : '';
  }
  function takeContextRight(afterWords, minWords) {
    const n = takeContextRightCount(afterWords, minWords);
    return n ? afterWords.slice(0, n).join(' ') : '';
  }
  function buildWindowedContext(beforeWords, target, afterWords, opts) {
    const min = (opts && Number.isFinite(opts.minWords)) ? opts.minWords : LEX_CONTEXT_MIN_WORDS;
    const before = Array.isArray(beforeWords) ? beforeWords.filter(Boolean) : [];
    const after = Array.isArray(afterWords) ? afterWords.filter(Boolean) : [];
    const left = takeContextLeft(before, min);
    const right = takeContextRight(after, min);
    const mark = '⟦' + String(target == null ? '' : target).trim() + '⟧';
    return (left ? left + ' ' : '') + mark + (right ? ' ' + right : '');
  }

  // Границы того же окна, но в индексах: [start, end] включительно внутри
  // массива `words` (слова в порядке чтения, каждое со своей хвостовой
  // пунктуацией — граница предложения ищется по ним же). Ширина и правила —
  // ровно те, по которым buildWindowedContext собирает строку, поэтому окно
  // одного слова, отрисованное по этим границам, совпадает с его строкой
  // слово в слово. Возвращает null, если targetIdx вне массива.
  //
  // Единица, вокруг которой считается окно, — не обязательно ОДНО слово.
  // Карандаш над выделением приносит кусок из нескольких слов подряд: на фишки
  // он не дробится (это сам вопрос человека, а не набор единиц разбора), но
  // окно ему нужно то же самое — не меньше LEX_CONTEXT_MIN_WORDS в каждую
  // сторону ОТ ЕГО ГРАНИЦ, дальше до границы предложения. Поэтому счёт живёт в
  // span-форме, а привычный однословный вызов — её частный случай startIdx ===
  // endIdx. Второй реализации, второй константы и второго счётчика тут нет
  // намеренно: разъехавшись, они дали бы два разных окна на одной странице.
  function windowedContextRangeSpan(words, startIdx, endIdx, opts) {
    const min = (opts && Number.isFinite(opts.minWords)) ? opts.minWords : LEX_CONTEXT_MIN_WORDS;
    const list = Array.isArray(words) ? words : [];
    const a = Number(startIdx);
    const b = Number(endIdx);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    if (a < 0 || b < a || b >= list.length) return null;
    const left = takeContextLeftCount(list.slice(0, a), min);
    const right = takeContextRightCount(list.slice(b + 1), min);
    return { start: a - left, end: b + right };
  }
  function windowedContextRange(words, targetIdx, opts) {
    return windowedContextRangeSpan(words, targetIdx, targetIdx, opts);
  }

  // Склейка окон в куски текста — чистая часть, без единого обращения к DOM.
  // `words` — поток слов материала, `ranges` — по одному на выбранную единицу:
  //   { start, end } — границы её окна в индексах потока;
  //   { from, to }   — границы САМОЙ единицы внутри окна (у слова from === to,
  //                    у куска карандаша это несколько слов подряд).
  // Пересёкшиеся и сошедшиеся ВСТЫК окна печатаются одним куском, каждая
  // единица внутри обводится ⟦…⟧ — кусок карандаша ОДНОЙ парой скобок на
  // весь себя, а не по словам.
  //
  // Скобки СЧИТАЮТСЯ, а не помечаются флагом: у одного индекса их может
  // сойтись несколько (слово выбрано и отдельно, и внутри куска карандаша), и
  // множество молча потеряло бы одну из пар — открывающих стало бы меньше, чем
  // закрывающих.
  //
  // Поверхностей с такой склейкой три: текст чужой страницы (page-word-pick.js
  // pageContextBlocks), лента чата расширения (chat-surface.js
  // chatContextBlocks) и лента чата страницы (webchat/wc-word-pick.js).
  // Разъехавшись, копии дали бы разные скобки на одном и том же наборе.
  // Проверяется без браузера — dev-tools/test-page-context-span.mjs.
  function mergeRangesToBlocks(words, ranges) {
    const list = Array.isArray(words) ? words : [];
    const rows = (Array.isArray(ranges) ? ranges.slice() : [])
      .sort((a, b) => (a.start - b.start) || (a.end - b.end));
    const bump = (map, i) => map.set(i, (map.get(i) || 0) + 1);
    const merged = [];
    rows.forEach((r) => {
      const last = merged[merged.length - 1];
      if (last && r.start <= last.end + 1) {
        if (r.end > last.end) last.end = r.end;
        bump(last.opens, r.from);
        bump(last.closes, r.to);
      } else {
        const m = { start: r.start, end: r.end, opens: new Map(), closes: new Map() };
        bump(m.opens, r.from);
        bump(m.closes, r.to);
        merged.push(m);
      }
    });
    const out = [];
    merged.forEach((m) => {
      const parts = [];
      for (let i = m.start; i <= m.end && i < list.length; i++) {
        // Скобка обводит ЯДРО слова, знак препинания остаётся снаружи неё:
        // «⟦food⟧.», а не «⟦food.⟧». Слово потока несёт свою пунктуацию (по ней
        // счётчик окна ищет границу предложения), а в строке `Word` оно стоит
        // без неё — и внутри скобок обязано стоять то же самое, иначе учитель
        // ищет названное и не находит его буква в букву. markToken — прямо
        // здесь, в этом же файле, рядом со splitToken, который и режет кусок на
        // «до / слово / после».
        parts.push(markToken(list[i], m.opens.get(i) || 0, m.closes.get(i) || 0));
      }
      if (parts.length) out.push(parts.join(' '));
    });
    return out;
  }

  // Исходный кусок текста этого слова — со знаками препинания, как в тексте.
  function tokenOf(span) {
    if (!span) return '';
    const raw = span.dataset ? span.dataset[TOKEN_ATTR] : null;
    return (raw != null && raw !== '') ? raw : String(span.textContent || '');
  }

  // ── Отрисовка строки слов — ОДНА на все поверхности ──────────────────────
  //
  // tokens: [{ text, startMs?, cueIdx?, br? }] — куски в порядке чтения.
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

  function sortedPicks() {
    const rows = picks.map((p, i) => ({ p, i, o: orderKeyOf(p) }));
    rows.sort((x, y) => cmpOrder(x.o, y.o) || (x.i - y.i));
    return rows.map((r) => r.p);
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
      // окно контекста считалось и склеивалось наравне с окнами выбранных слов.
      silent: !!pick.silent,
      context: pick.context,
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
  // нужна разная подробность: скрытая часть хода (sendPrefix ниже) сводит
  // ответ к трём значениям для учителя, а колонка `calls.source`
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

  // Кусок текста вокруг одного слова. Строка — как есть; функция — вызывается
  // здесь, в момент сборки запроса (субтитрам нужен поздний расчёт).
  function contextOf(pick) {
    const c = pick && pick.context;
    if (typeof c === 'function') {
      try { return String(c() || ''); } catch (e) {
        console.warn(TAG, 'context() failed:', e && e.message);
        return '';
      }
    }
    return c == null ? '' : String(c);
  }

  // Блоки контекста на весь набор. Поверхность, которая умеет сшивать
  // пересекающиеся куски в один (у субтитров окна двух рядом стоящих слов
  // перекрываются, и печатать текст дважды нельзя), отдаёт готовые блоки сама.
  // Остальным хватает куска на слово; повторы отбрасываются.
  function contextBlocks() {
    const list = sortedPicks();
    if (!list.length) return [];
    const ad = adapterFor(list[0].source);
    if (ad && typeof ad.contextBlocks === 'function') {
      try {
        const blocks = ad.contextBlocks(list);
        if (Array.isArray(blocks)) return blocks;
      } catch (e) {
        console.warn(TAG, 'contextBlocks failed:', e && e.message);
      }
    }
    const out = [];
    list.forEach((p) => {
      const t = contextOf(p);
      if (t && out.indexOf(t) < 0) out.push(t);
    });
    return out;
  }

  // Единицы набора, у которых есть фишка: всё, кроме silent. Через них идут и
  // строка слов, и полоска фишек, и список Words — то есть весь путь «что
  // человек выбрал», в котором молчаливому куску делать нечего.
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
  // набора: по нему крестик снимает слово, не отличаясь от повторного нажатия.
  function chips() {
    return chipPicks().map((p) => ({ key: p.key, label: p.word }));
  }

  // Служебная часть, которую человек в поле не видит: она уходит учителю
  // отдельным скрытым префиксом. Форма для одного слова — прежняя дословно,
  // чтобы разбор одиночного нажатия не поменялся; для набора те же два поля во
  // множественном числе.
  function sendPrefix() {
    const list = sortedPicks();
    if (!list.length) return '';
    const ctx = contextBlocks().join('\n\n');
    // Пустой контекст при непустом наборе — дефект сборки, а не состояние
    // продукта: у каждой единицы есть свой кусок текста, и добыть его не
    // получилось ни у одной. Отправлять 'Context: ""' нельзя (учитель получит
    // пустое поле и будет обсуждать его), поэтому префикс не взводим вовсе —
    // ход уйдёт тем, что человек напечатал. console.error печатается всегда,
    // мимо гейта lex-debug.js: промах обязан быть слышен на разработке.
    if (!ctx) {
      console.error(TAG, 'контекст набора пуст — скрытая часть хода не взводится');
      return '';
    }
    // ── Три части хода со словами ────────────────────────────────────────
    //
    // Строка(и) единиц — ЧТО спрашивают, поле Context — ГДЕ это стоит, а сам
    // текст реплики (его приклеивает окно) — вопрос человека. Единицы названы
    // отдельно не для красоты: обведённое место в отрывке может повторяться в
    // нём же несколько раз, и учитель ищет спрашиваемое ВНУТРИ скобок, а не по
    // всему отрывку.
    //
    // Фишка и кусок карандаша названы РАЗНЫМИ строками, потому что это разные
    // вещи. Фишки в поле ввода нет вовсе — она и есть вопрос. Кусок карандаша
    // в поле ЕСТЬ, и человек правит его как хочет: стирает половину, дописывает
    // своё, оставляет одно слово. Скобки при этом не двигаются — они держатся
    // за исходное выделение, снятое в момент протяжки (решение владельца
    // 2026-08-20). Поэтому строка Selection и нужна: без неё учитель видел бы
    // в скобках одно, в реплике другое и гадал бы, что из этого спрашивают.
    // ── Строка источника ─────────────────────────────────────────────────
    //
    // Три значения, и других не бывает: учителю нужно знать, читает он
    // субтитры, чужую страницу или собственную переписку, а различать
    // комментарий и статью ему незачем (решение владельца 2026-08-21).
    // Подробность остаётся в телеметрии: колонка `calls.source` и таблица
    // `word_taps` по-прежнему пишут все шесть зон. Свод живёт ЗДЕСЬ, потому
    // что здесь единственное место, где текст хода собирается целиком.
    const zone = sourceZone();
    const label = SOURCE_LABELS[zone] || null;
    if (!label) {
      // Набор есть, а откуда он — неизвестно. Строку не пишем (пустая метка
      // хуже отсутствующей: учитель начнёт её обсуждать), но молчать нельзя —
      // это дефект сборки, и он обязан быть слышен на разработке.
      // console.error печатается всегда, мимо гейта lex-debug.js.
      console.error(TAG, 'источник набора не определился (' + JSON.stringify(zone) + ') — строка Source не взводится');
    }
    const chipped = chipPicks();
    const picked = list.filter((p) => p.silent);
    const quoted = (rows) => rows.map((p) => '"' + p.word + '"').join(', ');
    const head = [];
    if (chipped.length === 1) head.push('Word: ' + quoted(chipped));
    else if (chipped.length > 1) head.push('Words: ' + quoted(chipped));
    if (picked.length === 1) head.push('Selection: ' + quoted(picked));
    else if (picked.length > 1) head.push('Selections: ' + quoted(picked));
    head.push('Context: "' + ctx + '"');
    // ПОСЛЕ Context и перед пустой строкой с текстом человека. Реплей ленты
    // режет скрытую часть по этой границе и про строку знает
    // (chat-surface.js stripHiddenPickPrefix, регрессия
    // dev-tools/test-replay-hidden-prefix.mjs).
    if (label) head.push('Source: ' + label);
    return head.join('\n');
  }

  // ── Обратная операция: снять скрытую часть с сохранённого хода ───────────
  //
  // ПЕРЕЕХАЛО СЮДА ИЗ chat-surface.js (2026-08-23) — тело буква в букву.
  // Причина переезда: ту же ленту перечитывает страница `lex-me.club/app`, и
  // копия правила у неё не сторожилась бы ничем. Цена расхождения известна и
  // измерена: ход человека пропадает из ленты ЦЕЛИКОМ (реплей принимает его за
  // служебную инструкцию). Живёт рядом с sendPrefix намеренно — это ровно
  // обратная ему операция, и две половины одного правила обязаны править
  // вместе.
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

  // Дев-инспекция: что сейчас выбрано и что из этого уйдёт учителю. Только
  // чтение — набор не меняет. Ею проверяется сборка контекста без браузерных
  // догадок: видно и сами блоки, и готовую скрытую часть запроса.
  function inspect() {
    const list = sortedPicks();
    return {
      words: list.map((p) => p.word),
      keys: list.map((p) => p.key),
      silent: list.map((p) => !!p.silent),
      blocks: contextBlocks(),
      prefix: sendPrefix(),
      highlighted: highlightedCount(),
    };
  }

  global.LexWordPick = {
    // нарезка и отрисовка
    renderLine,
    splitToken,
    isWord,
    tokenOf,
    markToken,
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
    // что уходит учителю
    text,
    chips,
    contextOf,
    contextBlocks,
    sourceZone,
    sendPrefix,
    // окно контекста вокруг единицы и склейка окон в куски текста. Переехало
    // из shared.js (2026-08-23): счёт понадобился странице lex-me.club/app,
    // куда shared.js не подключить. VocabShared отдаёт те же имена, делегируя
    // сюда.
    buildWindowedContext,
    windowedContextRange,
    windowedContextRangeSpan,
    mergeRangesToBlocks,
    LEX_CONTEXT_MIN_WORDS,
    // обратная операция к sendPrefix: что из сохранённого хода видит человек
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
