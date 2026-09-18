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
    'billing.shortMsg': 'Not enough balance for this request: {need} needed, {have} available ({missing} short). Nothing was charged.',
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

  function buttonLabel() { return t('billing.topupBtn'); }

  // ── Числа в отказе ────────────────────────────────────────────────────────
  //
  // Отказ бывает двух видов, и человеку они должны говорить разное:
  //   • на счету пусто — «пополните баланс»;
  //   • деньги есть, но на ЭТОТ запрос их не хватает — тогда сервер присылает
  //     числа, и честнее сказать, сколько нужно и сколько есть, чем повторять
  //     общее «пополните» человеку, у которого на счету что-то лежит.
  //
  // Числа приезжают прицепом к маркеру: `LEX_BILLING_GATE:{json}`
  // (lex-teacher-core.js). Разбор здесь, чтобы ни одна поверхность не парсила
  // строку ошибки сама.
  function parse(raw) {
    const s = String(raw == null ? '' : raw);
    const at = s.indexOf('LEX_BILLING_GATE:');
    if (at < 0) return null;
    const tail = s.slice(at + 'LEX_BILLING_GATE:'.length);
    // Строка ошибки могла обрасти хвостом — берём ровно объект.
    const end = tail.lastIndexOf('}');
    if (end < 0) return null;
    try {
      const j = JSON.parse(tail.slice(0, end + 1));
      return (j && typeof j === 'object') ? j : null;
    } catch (_) { return null; }
  }

  // Доллары для показа. Два знака после точки, как в остальном интерфейсе, — но
  // у мелких сумм этого мало: округление до центов превращает «нужно 0,0154,
  // есть 0,005» в «нужно $0.02, есть $0.01», и числа перестают сходиться между
  // собой. Поэтому всё меньше десяти центов показывается тремя знаками.
  function usd(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    const digits = Math.abs(n) < 0.1 ? 3 : 2;
    const p = Math.pow(10, digits);
    return '$' + (Math.round(n * p) / p).toFixed(digits);
  }

  // Надпись под конкретный отказ. Чисел нет — общее «пополните баланс», как
  // было всегда.
  function message(raw) {
    const info = (raw && typeof raw === 'object' && !(raw instanceof Error)) ? raw : parse(raw);
    const need = info && usd(info.needed);
    const have = info && usd(info.available != null ? info.available : info.balance);
    const missing = info && usd(info.missing);
    if (need && have && missing) {
      return t('billing.shortMsg')
        .replace('{need}', need).replace('{have}', have).replace('{missing}', missing);
    }
    return t('billing.gateMsg');
  }

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
    // opts.message — свой текст поверхности (её и так умеет путь субтитров);
    // opts.raw — строка ошибки, из которой надпись соберётся сама, с числами.
    text.textContent = (opts && opts.message) || message(opts && opts.raw);
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
    parse,
    usd,
    message,
    buttonLabel,
    setTopupAction,
    openTopup,
    createElement,
  });
})(typeof self !== 'undefined' ? self : globalThis);
