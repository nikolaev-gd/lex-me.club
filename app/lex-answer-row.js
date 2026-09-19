// lex-answer-row.js — строка под ответом учителя. ОДНА на все браузерные окна:
// расширение (чат у видео, Shorts, маленькое окно Lex) и страница
// lex-me.club/app (её же показывает программа для Мака). Айфон родной и общего
// кода с браузерами не имеет — там та же строка написана на Swift
// (ios/Lex/Lex/MessageRow.swift) по тому же правилу.
//
// Что в строке, слева направо:
//   1. кнопка выбора модели — подпись «модель · уровень» ответа; только под
//      ПОСЛЕДНИМ ответом ленты; нажатие открывает меню моделей окна, выбор
//      переспрашивает этот ответ выбранной моделью (сам переспрос и меню —
//      у окна, модуль их не знает);
//   2. кнопка копирования — под КАЖДЫМ текстовым ответом, копирует текст
//      ответа в том виде, в каком его написала модель (разметка как есть).
//
// Цены в строке нет: цена под ответом — прибор разработчика, её ставит само
// окно рядом со строкой (расширение, shared.js pricePill).
//
// Правило «какой ответ последний» — здесь же (sync), чтобы окна не решали его
// каждое по-своему: кнопка модели стоит под последним ответом ленты, и только
// если этот ответ готов и текстовый. Последним в ленте оказался голосовой
// ответ, ответ с ошибкой или ответ, который ещё пишется, — кнопки модели нет
// нигде: переспросить можно только то, что стоит в самом конце беседы.
//
// Без chrome.*, без подписей на своём языке: тексты кнопок окно передаёт само
// (расширение — из своих словарей, страница — по-английски).
(function (global) {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  // Те же рисунки, что у кнопок страницы (webchat/wc-ui.js ICONS).
  const ICON_PATHS = {
    copy: 'M9 9h10v10H9zM5 15V5h10',
    check: 'M4 12l5 5L20 6',
    chevron: 'M7 10l5 5 5-5',
  };
  const COPIED_MS = 1400;

  function icon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'lex-answer-row-icon');
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', ICON_PATHS[name]);
    svg.appendChild(p);
    return svg;
  }

  // Копирование в буфер. Основной путь — Clipboard API; он бывает запрещён
  // (страница без безопасного адреса, рамка без разрешения), тогда — старый
  // execCommand через скрытое поле. Возвращает, удалось ли.
  async function copyText(text) {
    const value = String(text == null ? '' : text);
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch (_) { /* пробуем запасной путь */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return !!ok;
    } catch (_) {
      return false;
    }
  }

  function button(cls, label) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'lex-answer-row-btn ' + cls;
    if (label) {
      b.title = label;
      b.setAttribute('aria-label', label);
    }
    return b;
  }

  /**
   * Собрать строку под одним ответом. Кнопки модели в ней ещё нет — её ставит
   * sync (или setModel), когда известно, последний ли это ответ.
   * @param {{getText: () => string, copyLabel?: string, onCopied?: (ok: boolean) => void}} opts
   * @returns {HTMLElement}
   */
  function create(opts) {
    const o = opts || {};
    const row = document.createElement('div');
    row.className = 'lex-answer-row';
    const copy = button('lex-answer-row-copy', o.copyLabel || 'Copy');
    copy.appendChild(icon('copy'));
    let resetTimer = null;
    copy.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const ok = await copyText(typeof o.getText === 'function' ? o.getText() : '');
      if (ok) {
        // Отметка «скопировано» — галочкой на месте значка, а не всплывашкой:
        // так она видна ровно там, куда человек только что нажал.
        copy.replaceChildren(icon('check'));
        copy.classList.add('is-copied');
        clearTimeout(resetTimer);
        resetTimer = setTimeout(() => {
          copy.replaceChildren(icon('copy'));
          copy.classList.remove('is-copied');
        }, COPIED_MS);
      }
      if (typeof o.onCopied === 'function') {
        try { o.onCopied(ok); } catch (_) { /* noop */ }
      }
      try { copy.blur(); } catch (_) { /* noop */ }
    });
    row.appendChild(copy);
    return row;
  }

  /**
   * Поставить, обновить или снять кнопку выбора модели в строке.
   * @param {HTMLElement} row строка из create
   * @param {{label: string, title?: string, onClick: (btn: HTMLElement) => void}|null} spec
   *   null — кнопки в этой строке нет.
   * @returns {HTMLElement|null} кнопка
   */
  function setModel(row, spec) {
    if (!row) return null;
    let btn = row.querySelector(':scope > .lex-answer-row-model');
    if (!spec) {
      if (btn) btn.remove();
      return null;
    }
    if (!btn) {
      btn = button('lex-answer-row-model', spec.title || '');
      const text = document.createElement('span');
      text.className = 'lex-answer-row-model-label';
      btn.appendChild(text);
      btn.appendChild(icon('chevron'));
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (typeof btn._lexOnClick === 'function') btn._lexOnClick(btn);
      });
      row.insertBefore(btn, row.firstChild);
    }
    if (spec.title) {
      btn.title = spec.title;
      btn.setAttribute('aria-label', spec.title + ': ' + (spec.label || ''));
    }
    btn.querySelector('.lex-answer-row-model-label').textContent = spec.label || '';
    btn._lexOnClick = spec.onClick;
    return btn;
  }

  /**
   * Правило одной ленты: кнопка модели — только под последним ответом и
   * только если он готовый текстовый. Копирование уже стоит в каждой строке.
   * @param {Array<{row: HTMLElement|null, eligible: boolean, model?: object}>} entries
   *   ВСЕ ответы ленты в порядке показа, включая голосовые, ошибки и тот, что
   *   ещё пишется (у них row: null или eligible: false).
   */
  function sync(entries) {
    const list = Array.isArray(entries) ? entries : [];
    const last = list.length ? list[list.length - 1] : null;
    for (const e of list) {
      if (!e || !e.row) continue;
      setModel(e.row, (e === last && e.eligible && e.model) ? e.model : null);
    }
  }

  /**
   * Подпись кнопки модели: «модель · уровень» тем же правилом, что меню «плюс»
   * (реестр моделей). Принимает синтетический id «поставщик:модель:уровень»
   * или имя модели у поставщика плюс уровень отдельно.
   * @param {string} modelStr
   * @param {string} [effort]
   * @returns {string} пустая строка, если модель неизвестна
   */
  function modelLabel(modelStr, effort) {
    const s = String(modelStr || '');
    if (!s) return '';
    let api = s;
    let eff = effort || null;
    const parts = s.split(':');
    if (parts.length >= 2) {
      api = parts[1] || '';
      if (!eff && parts.length >= 3) eff = parts[2] || null;
    }
    const reg = global.LexModelRegistry;
    if (reg && typeof reg.modelEffortLabel === 'function') return reg.modelEffortLabel(api, eff);
    return (eff && eff !== 'none') ? api + ' · ' + eff : api;
  }

  /**
   * Id модели ответа из истории: сервер отдаёт в расходах беседы
   * (list_chat_money) имя модели у поставщика («gpt-5.6-terra» или с датой
   * «gpt-5.6-terra-2026-…») и уровень отдельно; подпись кнопки и галочка в
   * меню ждут «поставщик:модель:уровень». Модель ищется в реестре: точное имя,
   * иначе самое длинное имя, с которого начинается датированное.
   * @returns {string} '' — имени нет; голое имя — модели нет в реестре
   */
  function modelIdOfCharge(apiModel, effort) {
    const api = String(apiModel || '');
    if (!api) return '';
    const reg = global.LexModelRegistry;
    const models = (reg && Array.isArray(reg.models)) ? reg.models : [];
    let m = models.find((x) => x.apiModel === api);
    if (!m) {
      m = models
        .filter((x) => x.apiModel && api.indexOf(x.apiModel + '-') === 0)
        .sort((a, b) => b.apiModel.length - a.apiModel.length)[0];
    }
    if (!m) return api;
    return m.provider + ':' + m.apiModel + ':' + String(effort || 'none');
  }

  global.LexAnswerRow = { create, setModel, sync, modelLabel, modelIdOfCharge, copyText };
})(typeof window !== 'undefined' ? window : globalThis);
