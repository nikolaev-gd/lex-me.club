// lex-long-press.js — «нажал и подержал» на одном органе управления.
//
// Общий с веб-страницей (webchat/index.html грузит этот же файл байт в байт).
// Жест один и тот же в трёх местах: круглая кнопка разговора (выбрать живой
// разговор или «нажми и говори»), чип режима отправки и — на телефоне — ход в
// ленте. Разъезжаться правилу нельзя: длительность удержания и то, сколько
// пальцу позволено проехать, человек чувствует как одно свойство продукта, а
// не как настройку конкретной кнопки.
//
// Pointer-события, а не touch: тем же жестом надо уметь пользоваться мышью —
// иначе автопрогон и проверка с ноутбука проверяют не то, чем пользуются.
//
// Расширение грузит файл через manifest content_scripts (и STANDALONE_CHAT_DEPS
// в background.js) до chat-surface.js. Отдаёт global.LexLongPress.
(function (global) {
  'use strict';

  // 480 мс — столько же держит веб-страница. Меньше — срабатывает на обычном
  // клике по кнопке с двойным назначением; больше — человек успевает решить,
  // что кнопка не отвечает.
  const HOLD_MS = 480;
  // Палец, который поехал, — это прокрутка, а не удержание.
  const MOVE_TOLERANCE_PX = 10;

  // attach(el, fire, opts) → { didFire() }
  //
  // fire(event) зовётся, когда удержание состоялось. Клик, который придёт
  // следом за состоявшимся удержанием, глотается здесь же (capture-фаза), но
  // вызывающему всё равно нужен didFire(): его собственный обработчик клика
  // мог быть повешен раньше нашего и на другом узле.
  function attach(el, fire, opts) {
    if (!el || typeof fire !== 'function') return { didFire: () => false };
    const holdMs = (opts && opts.holdMs) || HOLD_MS;
    let timer = 0;
    let fired = false;
    let startX = 0;
    let startY = 0;

    const clear = () => { if (timer) { clearTimeout(timer); timer = 0; } };

    el.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button !== 0) return;
      fired = false;
      startX = e.clientX;
      startY = e.clientY;
      clear();
      timer = setTimeout(() => {
        timer = 0;
        fired = true;
        fire(e);
      }, holdMs);
    });
    el.addEventListener('pointermove', (e) => {
      if (!timer) return;
      if (Math.abs(e.clientX - startX) > MOVE_TOLERANCE_PX
        || Math.abs(e.clientY - startY) > MOVE_TOLERANCE_PX) clear();
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((t) =>
      el.addEventListener(t, () => clear()));
    el.addEventListener('click', (e) => {
      if (fired) { e.preventDefault(); e.stopPropagation(); fired = false; }
    }, true);

    return { didFire: () => fired };
  }

  global.LexLongPress = { attach, HOLD_MS };
})(typeof self !== 'undefined' ? self : globalThis);
