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
  // Сколько после отпускания живёт отметка «удержание состоялось». Клик,
  // который браузер присылает следом за отпусканием, приходит за миллисекунды;
  // дальше отметка обязана погаснуть сама. Раньше её гасил только сам клик по
  // этому элементу — а его мог не получить вовсе: вызывающий глотает клик раньше
  // (глушилка в chat-surface.js висит на document в capture-фазе и зовёт
  // stopImmediatePropagation), или палец отпустили уже над меню, которое
  // открыло удержание. Отметка оставалась навсегда, и все следующие нажатия
  // на кнопку глотались как «хвост удержания» — кнопка молчала до
  // перезагрузки вкладки (2026-09-29).
  const CLICK_TAIL_MS = 400;

  // attach(el, fire, opts) → { didFire(), detach() }
  //
  // fire(event) зовётся, когда удержание состоялось. Клик, который придёт
  // следом за состоявшимся удержанием, глотается здесь же (capture-фаза), но
  // вызывающему всё равно нужен didFire(): его собственный обработчик клика
  // мог быть повешен раньше нашего и на другом узле.
  function attach(el, fire, opts) {
    if (!el || typeof fire !== 'function') return { didFire: () => false, detach: () => {} };
    const holdMs = (opts && opts.holdMs) || HOLD_MS;
    let timer = 0;
    let fired = false;
    let tail = 0;
    let startX = 0;
    let startY = 0;

    const clear = () => { if (timer) { clearTimeout(timer); timer = 0; } };
    // Отметка гаснет сама — после клика-хвоста или через CLICK_TAIL_MS, если
    // этого клика не будет.
    const expire = (ms) => {
      if (!fired) return;
      if (tail) clearTimeout(tail);
      tail = setTimeout(() => { tail = 0; fired = false; }, ms);
    };

    // Слушатели заводятся списком, чтобы их можно было снять. Снимать
    // понадобилось, когда повод для жеста стал переменным: меню заготовок
    // открывается только со второй заготовки, и удалив её, жест надо ОТЦЕПИТЬ.
    // Оставленный висеть, он продолжал бы глотать клик после удержания —
    // кнопка молча не отправляла бы реплику.
    const bound = [];
    const on = (type, fn, opts) => { el.addEventListener(type, fn, opts); bound.push([type, fn, opts]); };

    on('pointerdown', (e) => {
      if (e.button != null && e.button !== 0) return;
      if (tail) { clearTimeout(tail); tail = 0; }
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
    on('pointermove', (e) => {
      if (!timer) return;
      if (Math.abs(e.clientX - startX) > MOVE_TOLERANCE_PX
        || Math.abs(e.clientY - startY) > MOVE_TOLERANCE_PX) clear();
    });
    // Мышь, в отличие от пальца, получает pointerleave и с зажатой кнопкой:
    // съехал с кнопки к открывшемуся меню и вернулся — отметка должна дожить до
    // отпускания, иначе клик после удержания пройдёт и запустит разговор.
    // Поэтому срок отметке ставит только отпускание (или уход без нажатия).
    ['pointerup', 'pointercancel'].forEach((t) => on(t, () => { clear(); expire(CLICK_TAIL_MS); }));
    on('pointerleave', (e) => { clear(); if (!(e.buttons & 1)) expire(CLICK_TAIL_MS); });
    // Клик-хвост глотается здесь, а отметка гаснет после всего его пути (0 мс
    // — следующая задача): обработчик клика вызывающего, повешенный на этот же
    // элемент, ещё видит didFire() === true и не запускает своё действие.
    on('click', (e) => {
      if (fired) { e.preventDefault(); e.stopPropagation(); expire(0); }
    }, true);

    return {
      didFire: () => fired,
      detach: () => {
        clear();
        if (tail) { clearTimeout(tail); tail = 0; }
        fired = false;
        bound.splice(0).forEach(([type, fn, opts]) => el.removeEventListener(type, fn, opts));
      },
    };
  }

  global.LexLongPress = { attach, HOLD_MS };
})(typeof self !== 'undefined' ? self : globalThis);
