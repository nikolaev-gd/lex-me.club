// lex-billing-gate.js — одно правило на четыре места: что человек видит, когда
// на счету кончились деньги.
//
// Сервер отвечает на такой ход кодом 402 и телом `{"error":"balance
// depleted","stage":"balance"}`, а клиент по дороге превращает это в строку
// `LEX_BILLING_GATE`. Показывать эту строку человеку нельзя — она ничего ему не
// говорит и выглядит как поломка, хотя ничего не сломалось: просто пора
// пополнить счёт.
//
// Мест, где этот отказ доходит до человека, четыре: расширение (главный чат и
// видеочат), страница lex-me.club/app в браузере, программа для Мака и
// приложение на iPhone. Кода за ними ДВА — страница и расширение написаны
// отдельно, — и надпись легко разъезжается: в расширении была человеческая
// строка с кнопкой, на странице — красная рамка со служебным кодом. Поэтому
// надпись, кнопка и адрес кассы живут здесь, а места только зовут.
//
// Подключён и в `lex-surface-deps.js` (расширение), и в `webchat/index.html`
// (страница, а через неё обе оболочки Apple).
(function (global) {
  'use strict';

  if (global.LexBillingGate) return;

  // Касса. Адрес нужен только как последний рубеж: обычно окно пополнения
  // поднимает та поверхность, на которой человек стоит (см. `setTopupAction`), а
  // ссылку на оплату выдаёт сервер под конкретный заказ. Сюда попадаем, только
  // если окна пополнения на поверхности нет вовсе.
  const CHECKOUT_URL = 'https://lex-me.club/checkout/';

  // Тексты. В расширении есть переводчик, на странице его нет — поэтому ключ
  // спрашивается у `LexI18n`, а английский лежит здесь же запасным. Значения
  // обязаны совпадать с `i18n/en.js` слово в слово: две разных формулировки на
  // двух поверхностях — это ровно то, что чинит этот файл.
  const FALLBACK = {
    'billing.gateMsg': 'Please top up your balance',
    'billing.topupBtn': 'Top up',
  };

  function t(key) {
    try {
      if (global.LexI18n && typeof global.LexI18n.t === 'function') {
        const s = global.LexI18n.t(key);
        // Переводчик отдаёт сам ключ, когда строки нет, — это не перевод.
        if (s && s !== key) return s;
      }
    } catch (_) { /* noop */ }
    return FALLBACK[key] || key;
  }

  function message() { return t('billing.gateMsg'); }
  function buttonLabel() { return t('billing.topupBtn'); }

  // ── Признак «это отказ по деньгам» ────────────────────────────────────────
  //
  // Маркер `LEX_BILLING_GATE` ставит клиент на всех платных путях; сырой текст
  // сервера (`balance depleted`) проверяем тоже — на случай пути, который
  // маркер ещё не проставляет.
  function isGateError(raw) {
    const s = String(raw == null ? '' : raw);
    return s.includes('LEX_BILLING_GATE') || s.includes('balance depleted');
  }

  // ── Куда ведёт кнопка ─────────────────────────────────────────────────────
  //
  // Поверхность объявляет своё окно пополнения САМА, а не угадывается отсюда по
  // именам глобальных объектов. Так у страницы остаётся возможность передать
  // окну свои обработчики (после оплаты нужно обновить баланс на экране), а у
  // расширения — не менять поведение кнопки, которое уже работает.
  let topupAction = null;

  function setTopupAction(fn) {
    if (typeof fn === 'function') topupAction = fn;
  }

  function openTopup() {
    if (topupAction) {
      try { topupAction(); return true; } catch (_) { /* падаем в запасной путь */ }
    }
    // Окна пополнения на этой поверхности нет — открываем кассу страницей.
    // `_blank` здесь обязателен: внутри оболочки Apple он и означает «наружу,
    // в системный браузер».
    try { global.open(CHECKOUT_URL, '_blank', 'noopener'); return true; } catch (_) { /* noop */ }
    return false;
  }

  // ── Сам блок ──────────────────────────────────────────────────────────────
  //
  // Имена классов — те же `ytvocab-*`, что были в расширении до появления этого
  // файла. Они СОЗНАТЕЛЬНО не переименованы: на них уже висит правило в
  // `styles.css`, которое гасит красную рамку ошибки вокруг этого блока, и
  // переименование стоило бы красной рамки на единственной поверхности, где всё
  // и так работало. Страница просто описывает те же классы своими цветами.
  function createElement(opts) {
    const doc = (opts && opts.document) || global.document;
    const wrap = doc.createElement('div');
    wrap.className = 'ytvocab-billing-gate';

    const text = doc.createElement('span');
    text.className = 'ytvocab-billing-gate-text';
    text.textContent = (opts && opts.message) || message();
    wrap.appendChild(text);

    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'ytvocab-billing-gate-btn';
    btn.textContent = buttonLabel();
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openTopup();
    });
    wrap.appendChild(btn);

    return wrap;
  }

  global.LexBillingGate = Object.freeze({
    CHECKOUT_URL,
    isGateError,
    message,
    buttonLabel,
    setTopupAction,
    openTopup,
    createElement,
  });
})(typeof self !== 'undefined' ? self : globalThis);
