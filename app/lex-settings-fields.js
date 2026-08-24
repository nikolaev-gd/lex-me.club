// lex-settings-fields.js — как выглядит СТРОКА настроек. Один вид на все
// поверхности.
//
// Общий с веб-страницей (webchat/index.html грузит этот же файл байт в байт) —
// и с приложением на iPhone и программой для Мака, которые её показывают.
// Раньше строку настроек рисовали двое: страница своими `.wc-field`, а
// расширение своей сеткой `.ytvocab-settings-*`. Они разъехались по цвету,
// кеглю, порядку и по самому устройству строки — и это ровно то, что владелец
// назвал «сделай точно так же».
//
// Строка одна и та же везде: слева жирный заголовок и серая подсказка под ним,
// справа орган управления, при необходимости — значение справа от органа.
//
// Вид — в парном файле lex-settings-fields.css, на переменных `--lex-field-*`
// со СВОИМИ именами и тёмными значениями по умолчанию. Имена свои, а не
// заимствованные у страницы (`--fg`, `--line`), намеренно: расширение рисуется
// ВНУТРИ чужого сайта, и переменная с расхожим именем там может оказаться
// чужой. Страница переопределяет их своими токенами один раз (wc-app.css), и
// светлая тема продолжает работать.
//
// Расширение грузит файл через manifest content_scripts (и STANDALONE_CHAT_DEPS
// в background.js); страница — тегом <script src="../lex-settings-fields.js">.
// Отдаёт global.LexSettingsFields.
(function (global) {
  'use strict';

  function elFromHtml(html) {
    const t = document.createElement('template');
    t.innerHTML = String(html == null ? '' : html).trim();
    return t.content;
  }

  function put(parent, thing) {
    if (thing == null) return;
    if (typeof thing === 'string') parent.appendChild(elFromHtml(thing));
    else parent.appendChild(thing);
  }

  // Одна строка настроек. control и value принимают и узел, и строку разметки —
  // страница строит органы узлами, расширение собирает разметку строкой.
  function fieldNode(opts) {
    const o = opts || {};
    const wrap = document.createElement('div');
    wrap.className = 'lex-field' + (o.className ? ' ' + o.className : '');
    const row = document.createElement('div');
    row.className = 'lex-field-row';
    const label = document.createElement('div');
    label.className = 'lex-field-label';
    if (o.label != null) {
      const b = document.createElement('b');
      b.textContent = o.label;
      label.appendChild(b);
    }
    if (o.hint != null && o.hint !== '') {
      const span = document.createElement('span');
      span.textContent = o.hint;
      // Подсказку иногда ведёт кто-то снаружи (текст и видимость): даём ей
      // собственное имя и начальное состояние, чтобы её было чем найти.
      if (o.hintClass) span.className = o.hintClass;
      if (o.hintHidden) span.hidden = true;
      label.appendChild(span);
    }
    row.appendChild(label);
    put(row, o.control);
    if (o.value != null && o.value !== '') {
      const v = document.createElement('div');
      v.className = 'lex-field-value';
      if (typeof o.value === 'string') v.textContent = o.value; else v.appendChild(o.value);
      row.appendChild(v);
    }
    wrap.appendChild(row);
    // Раскрывающийся хвост строки (подтверждение удаления, поле суммы) —
    // отдельным рядом под ней, чтобы не ломать выравнивание самой строки.
    put(wrap, o.extra);
    return wrap;
  }

  function fieldHtml(opts) {
    return fieldNode(opts).outerHTML;
  }

  // Кто вошёл. Первая строка блока настроек и на странице, и в расширении:
  // почта обычным кеглем, баланс серой строкой ПОД ней. Не коробка и не
  // пилюля — баланс здесь только справка, а распоряжаются им в другом месте
  // (кнопка пополнения в подвале шторки бесед).
  function identityNode(opts) {
    const o = opts || {};
    return fieldNode({
      className: 'lex-field-identity',
      label: o.email || o.emptyLabel || '',
      hint: o.balance || '',
    });
  }

  function identityHtml(opts) {
    return identityNode(opts).outerHTML;
  }

  // Строка-действие: заголовок с подсказкой слева, кнопка справа.
  function buttonHtml(text, opts) {
    const o = opts || {};
    const cls = ['lex-field-btn'];
    if (o.danger) cls.push('lex-field-btn--danger');
    if (o.className) cls.push(o.className);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls.join(' ');
    b.textContent = text;
    return b.outerHTML;
  }

  global.LexSettingsFields = {
    fieldNode, fieldHtml, identityNode, identityHtml, buttonHtml,
  };
})(typeof self !== 'undefined' ? self : globalThis);
