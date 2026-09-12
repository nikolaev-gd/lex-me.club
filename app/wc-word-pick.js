// webchat/wc-word-pick.js — клик по словам в ленте чата: адаптер этой страницы
// поверх общего механизма (`../lex-word-pick.js`).
//
// ЧТО ЗДЕСЬ И ЧЕГО ЗДЕСЬ НЕТ. Сам механизм — набор выбранных слов, его порядок
// по тексту, подсветка, состав ряда фишек, признак источника и замок
// поверхности — живёт в общем модуле и с расширением у нас общий, байт в байт.
// Здесь только то, что у этой страницы своё:
//   • как разрезать сообщение на слова (разметку строит wc-markdown.js —
//     УЗЛАМИ, а не строкой HTML, поэтому режем обходом текстовых узлов);
//   • как опознать слово в ленте и посчитать кусок текста вокруг него;
//   • ряд фишек над полем ввода (окно у страницы своё, общего кода отрисовки с
//     расширением нет — общий у нас контракт `chips()` и `sendPicks()`).
//
// ПОЧЕМУ ОТДЕЛЬНЫЙ ФАЙЛ, А НЕ ВНУТРИ wc-thread.js. Ровно затем, зачем общий
// модуль отделён от субтитров: у этой страницы уже есть история про
// разъехавшиеся копии (renderMarkdown). Лента отвечает за ленту, выбор слов —
// за выбор слов, и пересекаются они в нескольких явных вызовах.
//
// ЧЕГО ЗДЕСЬ НЕТ НАМЕРЕННО:
//   • карандаша над выделением (он нужен там, где чат ещё НЕ открыт — на чужой
//     странице; здесь чат и есть окно, выделять текст в нём незачем);
//   • замка между источниками — источник на этой странице ровно один, замку не
//     между чем стоять;
//   • поиска слова «где-то рядом со старой позицией» (resolveChatWordIndex в
//     расширении). Он существует ради переспроса с другим вариантом ответа —
//     механизма, которого на этой странице нет вовсе. Здесь пузырь
//     пересобирается ровно одним способом (кнопка «заново»), и на него ответ
//     честнее: слова этого пузыря из набора убираются (forgetBubble).
(function (global) {
  'use strict';

  const WP = global.LexWordPick;
  // Источник набора. Имя своё, не 'chat' — общий модуль держит замок за
  // источник, и общее имя означало бы, что набор этой страницы и набор ленты
  // расширения считаются одним. Страницы эти никогда не живут в одном окне, но
  // имя всё равно должно называть поверхность, а не «какой-то чат».
  const SOURCE = 'chat:webchat';
  // Зона для учителя. РОВНО 'lex-chat' и ничего другого: по этому ключу общий
  // модуль (SOURCE_LABELS) сводит источник к строке `Source: chat` в скрытой
  // части хода. Любое другое значение — и строка молча не взводится, а модуль
  // кричит в консоль «источник набора не определился».
  const ZONE = 'lex-chat';

  // Ключ настройки. ОДНО место на страницу: его читает загрузка (wc-app.js) и
  // пишет переключатель в настройках (wc-settings.js). Хранилище — WcStore, то
  // есть IndexedDB происхождения этой страницы; у браузера, у программы для
  // Мака и у приложения на iPhone оно СВОЁ, поэтому и значение своё на каждой
  // из трёх поверхностей — этого и требует задание. Расширение — четвёртая
  // поверхность со своим ключом в chrome.storage; общего значения у них нет и
  // не задумано.
  const STORAGE_KEY = 'wcWordPickEnabled';

  const MSG_ATTR = 'data-lex-msg-id';
  let msgCounter = 0;

  // Включён ли режим. Значение хранится в WcStore (wc-settings.js), здесь —
  // рабочая копия. Дефолт до первого чтения — ВЫКЛЮЧЕНО: включать человеку
  // нажимаемый текст, о котором он не просил, страница не должна.
  let enabled = false;
  let onChipsChanged = null;

  // ── Опознание пузыря ─────────────────────────────────────────────────────
  function tagBubble(bubble) {
    if (!bubble) return null;
    if (!bubble.getAttribute(MSG_ATTR)) bubble.setAttribute(MSG_ATTR, String(++msgCounter));
    return bubble.getAttribute(MSG_ATTR);
  }

  function bubbleOfSpan(span) {
    return (span && span.closest) ? span.closest('[' + MSG_ATTR + ']') : null;
  }

  function bubbleById(msgId) {
    return document.querySelector('[' + MSG_ATTR + '="' + msgId + '"]');
  }

  // Буква/цифра слова без пунктуации и без регистра — часть ярлыка. Тот же
  // алфавит, что WORD_CHAR_RE в общем модуле: решение «это слово» и решение
  // «что от слова остаётся» обязаны совпадать.
  function wordCore(w) {
    return String(w == null ? '' : w).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  }

  // Слова пузыря в порядке чтения, каждое со своей хвостовой пунктуацией
  // (`tokenOf`) — именно в этом виде их ждёт счётчик окна: границу предложения
  // он ищет по хвосту слова. Один канонический способ считать позицию: ярлык и
  // окно обязаны видеть один и тот же индекс.
  function wordStream(bubble) {
    const spans = [];
    const words = [];
    if (bubble) {
      const all = bubble.querySelectorAll('.' + WP.WORD_CLASS);
      for (let i = 0; i < all.length; i++) {
        const t = WP.tokenOf(all[i]).trim();
        if (!t) continue;
        spans.push(all[i]);
        words.push(t);
      }
    }
    return { spans, words };
  }

  // ── Нарезка сообщения на слова ───────────────────────────────────────────
  //
  // Разметка сообщения — дерево узлов от wc-markdown.js (жирный, курсив, код,
  // списки, таблицы, ссылки). Режем ПО ТЕКСТОВЫМ УЗЛАМ: каждый узел уходит в
  // общий `renderLine` ровно как строка субтитров — модуль решает КАК резать
  // поданный кусок, адаптер решает, ЧТО ему подать.
  function wordTokens(text) {
    const tokens = [];
    String(text == null ? '' : text).split('\n').forEach((part, idx) => {
      if (idx > 0) tokens.push({ br: true });
      part.split(/\s+/).forEach((t) => { if (t) tokens.push({ text: t }); });
    });
    return tokens;
  }

  // Ведущий/хвостовой пробел этого текстового узла — НАСТОЯЩАЯ граница с
  // соседним узлом дерева, а не «пробел между словами внутри одного вызова
  // renderLine» (тот renderLine восстанавливает сам). Markdown режет строку на
  // куски жирным/курсивом/кодом, и пробел на стыке «…значит <strong>это</strong>…»
  // целиком живёт В ОДНОМ из двух соседних узлов. `wordTokens` делит по /\s+/ и
  // разделители отбрасывает — без явного возврата края узла слова на стыке
  // слиплись бы («значитэто»).
  function sliceTextNode(textNode) {
    const raw = String(textNode.nodeValue == null ? '' : textNode.nodeValue);
    const tokens = wordTokens(raw);
    if (!tokens.length) return;
    const frag = document.createDocumentFragment();
    if (/^\s/.test(raw)) frag.appendChild(document.createTextNode(' '));
    WP.renderLine(frag, tokens);
    if (/\s$/.test(raw)) frag.appendChild(document.createTextNode(' '));
    textNode.replaceWith(frag);
  }

  // Текстовые узлы, которые режем. Три исключения, и каждое по своей причине:
  //   <a>   — нажатие по ссылке обязано вести по ссылке. У этой страницы
  //           исключение НЕ теоретическое: wc-markdown.js ссылки правда строит
  //           (правило [текст](адрес) в его таблице INLINE).
  //   <pre> — блок кода. Слова в коде — не лексика, а `renderLine` ставит между
  //           кусками РОВНО один пробел и отступ строки стёр бы начисто.
  //           Расширение отступ спасает отдельной веткой; здесь дешевле и
  //           честнее не трогать код вовсе.
  //   пустые — узлы из одних пробелов между блоками.
  function walkableTextNodes(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        let el = node.parentElement;
        while (el && el !== root) {
          if (el.tagName === 'A' || el.tagName === 'PRE') return NodeFilter.FILTER_REJECT;
          el = el.parentElement;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    return nodes;
  }

  // Нарезать пузырь целиком. Список узлов материализуется ДО первой замены —
  // `replaceWith` одного узла не мешает обходу соседних, но обходить дерево,
  // которое сам же и меняешь, нельзя.
  //
  // Зовётся ТОЛЬКО когда сообщение дописано до конца. Резать во время потока
  // бессмысленно по построению: `WcMarkdown.into` на каждом кадре делает
  // replaceChildren — нарезка предыдущего кадра стирается вместе со всем
  // остальным, а разметка при этом мигала бы на каждом токене.
  function sliceBubble(bubble) {
    if (!enabled || !bubble) return;
    // Пузырь без исходника резать НЕЛЬЗЯ: снять с него нарезку потом будет
    // нечем (unsliceBubble восстанавливает из `lexSrc`), и выключение режима
    // оставило бы его нарезанным навсегда. Такие в ленте есть: пузырь ошибки и
    // плашка «кончились деньги» — их строит сама лента, минуя ready(), и текста
    // в привычном смысле у второй вообще нет (там надпись и кнопка).
    if (!bubble.dataset || bubble.dataset.lexSrc == null) return;
    tagBubble(bubble);
    walkableTextNodes(bubble).forEach(sliceTextNode);
    WP.decorateLine(bubble);
  }

  // ── Снять нарезку ────────────────────────────────────────────────────────
  //
  // Не «собрать текст обратно из спанов», а перерисовать пузырь из ИСХОДНИКА,
  // который лента положила на него при создании. Обратная сборка вернула бы
  // текст, а не разметку: пробелы между кусками renderLine ставит свои, и
  // склейка двух подряд идущих узлов дерева отличалась бы от исходной.
  function unsliceBubble(bubble) {
    if (!bubble || !bubble.dataset) return;
    const src = bubble.dataset.lexSrc;
    if (src == null) return;
    if (bubble.dataset.lexKind === 'markdown') global.WcMarkdown.into(bubble, src);
    else bubble.textContent = src;
  }

  // ── Ярлык, порядок, контекст ─────────────────────────────────────────────
  function keyForSpan(span) {
    const bubble = bubbleOfSpan(span);
    if (!bubble) return null;
    const idx = wordStream(bubble).spans.indexOf(span);
    if (idx < 0) return null;
    // Слово — часть ярлыка, не только позиция: пузырь могли переписать
    // («заново»), и тогда позиция совпадает, а слово другое. Ярлык обязан
    // разойтись сам, а не подсветить случайно совпавшего соседа.
    return 'msg:' + bubble.getAttribute(MSG_ATTR) + '|' + idx + '|' + wordCore(span.textContent);
  }

  // Порядок в наборе — по тексту: раньше в ленте, раньше во фразе. Номер
  // сообщения растёт вниз по ленте (лента растёт только вниз), позиция слова
  // внутри сообщения — второй ступенью.
  function orderOf(item) {
    const meta = item && item.meta;
    if (!meta) return null;
    const msgId = Number(meta.msgId);
    if (!Number.isFinite(msgId)) return null;
    return [msgId, Number(meta.wordIdx)];
  }

  // Где стоят выбранные слова — для вопроса учителю: текст сообщения словами
  // (каждое со своей пунктуацией) и номер слова в нём. Разные сообщения —
  // разные куски; внутри одного сообщения места делят один кусок. Отрывок
  // вокруг, склейку и скобки считает сервер (supabase/functions/_shared/
  // word-pick.ts) — своего счёта отрывка у страницы больше нет.
  //
  // Позиция сверяется со словом: пузырь могли переписать. Не сошлось — слово
  // уходит своим снимком, снятым в момент нажатия (pick.fallback).
  function placesOf(list) {
    const items = Array.isArray(list) ? list : [];
    const byMsg = new Map();
    items.forEach((item) => {
      const msgId = item && item.meta && item.meta.msgId;
      if (msgId == null) return;
      if (!byMsg.has(msgId)) byMsg.set(msgId, []);
      byMsg.get(msgId).push(item);
    });
    const streams = [];
    byMsg.forEach((groupItems, msgId) => {
      const stream = wordStream(bubbleById(msgId));
      const units = [];
      groupItems.forEach((item) => {
        const at = Number(item.meta.wordIdx);
        if (Number.isInteger(at) && at >= 0 && at < stream.words.length
            && wordCore(stream.words[at]) === wordCore(item.word)) {
          units.push({ pick: item, from: at, to: at });
        }
      });
      if (units.length) streams.push({ words: stream.words, units });
    });
    return streams;
  }

  // Описание нажатого слова в виде, который принимает общий модуль. Запасной
  // кусок — снимок сообщения словами в момент нажатия: если пузырь исчезнет
  // или перепишется до отправки, слово уйдёт серверу со своим текстом.
  function describePick(span) {
    const bubble = bubbleOfSpan(span);
    if (!bubble) return null;
    tagBubble(bubble);
    const stream = wordStream(bubble);
    const wordIdx = stream.spans.indexOf(span);
    if (wordIdx < 0) return null;
    const word = span.textContent || '';
    if (!word) return null;
    const msgId = bubble.getAttribute(MSG_ATTR);
    return {
      key: 'msg:' + msgId + '|' + wordIdx + '|' + wordCore(word),
      word,
      source: SOURCE,
      meta: { msgId, wordIdx },
      fallback: { words: stream.words.slice(), from: wordIdx, to: wordIdx },
    };
  }

  // ── Ряд фишек над полем ввода ────────────────────────────────────────────
  //
  // Своё окно, свой ряд: общего кода отрисовки с расширением нет и быть не
  // может — там разметка расширения, здесь разметка этой страницы. Общий у нас
  // КОНТРАКТ: состав ряда отдаёт `LexWordPick.chips()`, а нажатие на фишку снимает слово
  // тем же ярлыком, каким его снимает повторное нажатие по самому слову. Набор
  // — единственный источник правды, поэтому «снял» значит «не уедет».
  // Крестика у фишки слова нет: нажатие на саму фишку снимает слово — тем же
  // ярлыком, что повторное нажатие по слову в ленте. Фишка — кнопка, поэтому
  // до неё доходит и клавиатура, и скринридер.
  const CHIP_CLASSES = { strip: 'wc-wordchips', chip: 'wc-wordchip', label: 'wc-wordchip-label' };

  function paintChips() {
    const strip = document.getElementById('wc-wordchips');
    if (!strip) return;
    const chips = (WP.lockedSource() === SOURCE) ? WP.chips() : [];
    strip.replaceChildren();
    strip.hidden = !chips.length;
    chips.forEach((chip) => {
      const label = document.createElement('span');
      label.className = 'wc-wordchip-label';
      label.textContent = chip.label;
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'wc-wordchip';
      el.title = 'Remove';
      el.setAttribute('aria-label', 'Remove ' + chip.label);
      el.append(label);
      el.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (WP.remove(chip.key)) changed();
      });
      strip.append(el);
    });
  }

  // Сколько строк займёт ряд с такими подписями при нынешней ширине —
  // для предела в три строки (LexWordPick.MAX_CHIP_ROWS).
  function rowsFor(labels) {
    const strip = document.getElementById('wc-wordchips');
    if (!strip || !strip.parentNode) return null;
    return WP.measureChipRows(strip.parentNode, strip, CHIP_CLASSES, labels);
  }

  // Набор изменился: перерисовать ряд и сказать композеру — при пустом поле
  // отправлять всё равно есть что.
  function changed() {
    paintChips();
    if (typeof onChipsChanged === 'function') onChipsChanged();
  }

  // ── Что уходит учителю ───────────────────────────────────────────────────
  //
  // Две части, и они разные. Слова становятся ВИДИМЫМ текстом реплики (они
  // называют предмет, дописанное человеком — сам вопрос), а их места уходят
  // серверу отдельно (`picks`): строки Word/Context перед видимым текстом
  // ставит он, одинаково для всех поверхностей (supabase/functions/_shared/
  // word-pick.ts). Собранную реплику сервер присылает первым кадром потока —
  // её страница и кладёт в свою память беседы (wc-backend.js).
  function takeTurn(typed) {
    const mine = WP.lockedSource() === SOURCE && WP.size() > 0;
    const plain = String(typed || '').trim();
    if (!mine) return { visible: plain, sent: plain, picks: null };
    const words = WP.text();
    const picks = WP.sendPicks();
    const visible = words ? (words + ' ' + String(typed || '')).trim() : plain;
    WP.clear();
    changed();
    return { visible, sent: visible, picks };
  }

  const WcWordPick = {
    init(opts) {
      onChipsChanged = opts && opts.onChipsChanged;
      WP.register({
        source: SOURCE,
        keyForSpan,
        orderOf,
        placesOf,
        rowsFor,
        zoneOf: () => ZONE,
      });

      // Один обработчик на всю ленту, а не на каждый пузырь: пузыри приходят и
      // уходят, лента одна.
      const thread = document.getElementById('wc-turns');
      if (thread) {
        thread.addEventListener('click', (e) => {
          if (!enabled) return;
          // Протяжка мышью — это копирование текста, а не выбор. Щит общий, в
          // нём два условия сразу (курсор сместился И есть выделение), иначе
          // дрожание руки на нажатии ловилось бы как протяжка.
          if (WP.isDragRelease(e)) return;
          const span = (e.target && e.target.closest) ? e.target.closest('.' + WP.WORD_CLASS) : null;
          if (!span || !thread.contains(span)) return;
          const pick = describePick(span);
          if (!pick) return;
          if (!WP.toggle(pick)) return;
          changed();
        });
      }
    },

    // Значение переключателя из настроек. `persist` здесь не при чём — писать
    // в хранилище дело настроек; здесь только применение.
    setEnabled(next) {
      const on = !!next;
      if (on === enabled) return;
      enabled = on;
      document.body.classList.toggle('wc-wordpick-on', enabled);
      if (enabled) {
        // Включили — нарезать всё, что уже на экране: иначе режим начал бы
        // работать только со следующего сообщения.
        document.querySelectorAll('#wc-turns .wc-bubble').forEach(sliceBubble);
      } else {
        // Выключили — снять нарезку И очистить набор. Одного первого мало:
        // слово, выбранное до выключения, иначе тихо доехало бы скрытой частью
        // до следующей отправки просто потому, что новые нажатия погашены, а
        // старый выбор — нет.
        if (WP.lockedSource() === SOURCE) WP.clear();
        document.querySelectorAll('#wc-turns .wc-bubble').forEach(unsliceBubble);
        changed();
      }
    },

    isEnabled() { return enabled; },

    // Сколько единиц в НАШЕМ наборе. Композер спрашивает, чтобы решить, есть
    // ли что отправлять при пустом поле.
    count() { return WP.lockedSource() === SOURCE ? WP.size() : 0; },

    // Лента зовёт это на каждый готовый пузырь: «этот дописан, можно резать».
    // Исходник кладётся всегда, даже когда режим выключен, — иначе включение
    // режима посреди беседы нашло бы пузыри без исходника и не смогло бы потом
    // снять с них нарезку.
    ready(bubble, src, kind) {
      if (!bubble) return;
      if (bubble.dataset) {
        bubble.dataset.lexSrc = String(src == null ? '' : src);
        bubble.dataset.lexKind = (kind === 'markdown') ? 'markdown' : 'text';
      }
      sliceBubble(bubble);
    },

    // Ленту сменили целиком (открыли другую беседу, начали новую) — весь набор
    // вон. Ключи набора указывают на пузыри, которых больше нет: фишки
    // остались бы висеть над полем, кнопка отправки — горящей, а следующая
    // реплика уехала бы со словом из ЧУЖОЙ беседы и с отрывком «само слово»
    // (окно считать не по чему, единица уходит сиротой). Проверено живьём до
    // правки: фишка «in» пережила переключение, и в скрытой части стояло
    // Word: "in" / Context: "in".
    forgetAll() {
      if (WP.lockedSource() !== SOURCE) return;
      WP.clear();
      changed();
    },

    // Пузырь переписывают («заново») — его слова из набора вон. Позиция после
    // переписывания указывает на другой текст, и «найти слово где-то рядом» —
    // это гадание: честнее убрать.
    forgetBubble(bubble) {
      const msgId = bubble && bubble.getAttribute && bubble.getAttribute(MSG_ATTR);
      if (!msgId) return;
      const prefix = 'msg:' + msgId + '|';
      let hit = false;
      WP.items().forEach((p) => {
        if (p.source === SOURCE && String(p.key).indexOf(prefix) === 0) {
          WP.remove(p.key);
          hit = true;
        }
      });
      if (hit) changed();
    },

    takeTurn,
    paintChips,
    STORAGE_KEY,

    // Показать человеку то, что он напечатал, — без скрытой части хода.
    // Правило общее с расширением (`../lex-word-pick.js`), потому что лента
    // одна и та же: беседа, начатая в расширении, читается здесь и наоборот.
    visibleText(text) { return WP.stripHiddenPickPrefix(String(text == null ? '' : text)); },
    isHiddenOnly(visible) { return WP.isHiddenOnlyText(visible); },
  };

  global.WcWordPick = WcWordPick;
})(typeof self !== 'undefined' ? self : globalThis);
