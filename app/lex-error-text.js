// lex-error-text.js — одно правило на два кодовых дерева: что человек читает
// вместо служебного кода отказа.
//
// Служебные коды нужны разработчику и бесполезны человеку. `EMAIL_TAKEN`,
// `HTTP 400`, `Anthropic 529: {"type":"overloaded_error"}` — это не сообщения, а
// внутренние маркеры: они ничего не объясняют и выглядят как поломка, хотя
// чаще всего ничего не сломалось (адрес занят, сервис занят, попробуйте
// через минуту).
//
// Тот же приём, что в `lex-billing-gate.js`: код с экрана уходит, но не
// пропадает — каждое место логирует сырую строку через `lexLog` ПЕРЕД тем, как
// нарисовать человеческую. Без этого в журнале не отличить один отказ от
// другого.
//
// Мест, где такие коды доходили до человека, три, и кодовых деревьев за ними
// два (расширение и страница `lex-me.club/app`, а через неё обе оболочки
// Apple) — поэтому карта лежит здесь, а места только зовут:
//
//   1. вход и регистрация      — `popup.js`, `login-frame.js`, `webchat/wc-app.js`
//   2. окно пополнения         — `topup-window.js`, `webchat/wc-topup.js`
//   3. ответ провайдера в чате — `chat-surface.js`
//
// Подключён в `manifest.json` (оба блока content_scripts), `popup.html`,
// `login-frame.html`, `lex-surface-deps.js` и `webchat/index.html`.
(function (global) {
  'use strict';

  if (global.LexErrorText) return;

  // Английский запасной текст. В расширении есть переводчик, на странице его
  // нет — поэтому ключ сперва спрашивается у `LexI18n`, а сюда падаем, когда
  // переводчика нет. Значения обязаны совпадать с `i18n/en.js` СЛОВО В СЛОВО:
  // две разных формулировки на двух поверхностях — ровно то, что чинит этот
  // файл.
  const FALLBACK = {
    'err.auth.emailTaken': 'That address is already taken — sign in instead.',
    'err.auth.badCredentials': 'Wrong email or password.',
    'err.auth.weakPassword': 'The password is too short — use at least 6 characters.',
    'err.auth.badCode': 'That code is wrong or has expired — request a new one.',
    'err.auth.rateLimited': 'Too many attempts. Please try again in a minute.',
    'err.auth.generic': "Couldn't do that right now. Please try again.",
    'topup.errAuth': 'Please sign in first.',
    'topup.errAmount': 'Enter an amount between ${min} and ${max}.',
    'topup.errProvider': 'Could not start the payment. Nothing was charged — please try again.',
    'err.prompt.notPublished': 'This preset has not been published yet — the teacher has no instructions. You were not charged.',
    'err.provider.busy': 'The service is overloaded right now. Please try again in a minute.',
    'err.provider.generic': 'The answer did not come through. Please try again.',
  };

  // Подстановка `{min}` / `{max}` в запасном тексте — тем же видом скобок, что
  // и у переводчика (`i18n/index.js`), иначе запасная строка разъедется с
  // переведённой.
  function format(str, params) {
    if (!params) return str;
    return String(str).replace(/\{(\w+)\}/g, (m, k) => (params[k] != null ? String(params[k]) : m));
  }

  function t(key, params) {
    try {
      if (global.LexI18n && typeof global.LexI18n.t === 'function') {
        const s = global.LexI18n.t(key, params);
        // Переводчик отдаёт сам ключ, когда строки нет, — это не перевод.
        if (s && s !== key) return s;
      }
    } catch (_) { /* noop */ }
    return format(FALLBACK[key] || key, params);
  }

  function str(raw) {
    return String(raw == null ? '' : (raw && raw.message) || raw);
  }

  // ── 1. Вход и регистрация ─────────────────────────────────────────────────
  //
  // На вход приходит либо наш код (`EMAIL_TAKEN` / `RATE_LIMITED` из
  // `authSignUp`), либо дословный текст GoTrue (`gotrue()` берёт `msg` /
  // `error_description` / `error_code`), либо строка вида `signup failed: 500`.
  // Первые два узнаём, остальное — общий текст.
  function auth(raw) {
    const s = str(raw);
    if (/EMAIL_TAKEN|user_already_exists|already registered/i.test(s)) return t('err.auth.emailTaken');
    if (/RATE_LIMITED|rate_limit|too many requests|\b429\b/i.test(s)) return t('err.auth.rateLimited');
    if (/invalid login credentials|invalid_credentials|invalid_grant|bad_credentials/i.test(s)) {
      return t('err.auth.badCredentials');
    }
    if (/weak_password|password should be at least|password is too short/i.test(s)) {
      return t('err.auth.weakPassword');
    }
    // Восстановление пароля по коду: GoTrue отвечает «Token has expired or is
    // invalid» — человеку нужно знать, что код просрочен, а не «что-то не так».
    if (/otp_expired|token has expired|invalid.{0,12}(otp|token)|token.{0,12}invalid/i.test(s)) {
      return t('err.auth.badCode');
    }
    return t('err.auth.generic');
  }

  // ── 2. Окно пополнения ────────────────────────────────────────────────────
  //
  // Карта родилась в `topup-window.js` (расширение) и переехала сюда целиком,
  // чтобы страница показывала ТО ЖЕ, а не `HTTP 400`. Коды ставит сервер
  // (`create-payment`), поэтому список закрытый: всё, что не «не вошёл» и не
  // «не та сумма», для человека одно и то же — касса не открылась, деньги не
  // тронуты.
  function topup(code, params) {
    switch (str(code)) {
      case 'not_signed_in': return t('topup.errAuth');
      case 'bad_amount': return t('topup.errAmount', params);
      default: return t('topup.errProvider');
    }
  }

  // ── 3. Ответ провайдера в пузыре чата ─────────────────────────────────────
  //
  // Адаптеры в `lex-teacher-core.js` складывают отказ провайдера в строку вида
  // `Anthropic 529: {"type":"overloaded_error",…}` — имя, HTTP-код, начало тела.
  // llm-proxy пропускает статус и тело провайдера насквозь (см. комментарий
  // «Provider error → pass status + body through unchanged»), поэтому у живого
  // пользователя приезжает ровно эта форма.
  //
  // Узнаём её ПО КОДУ, а не по имени провайдера: строка
  // `OpenAI API key not set. Open extension settings.` тоже начинается с имени,
  // но это не ответ сервиса, а понятное указание разработчику — его трогать
  // нельзя.
  const PROVIDER_RE = /^[A-Za-z][A-Za-z0-9 .-]*\s(\d{3}):/;

  // Ответ ли это провайдера. `null` — значит нет, место рисует своё прежнее.
  function providerStatus(raw) {
    const m = PROVIDER_RE.exec(str(raw).trim());
    return m ? Number(m[1]) : null;
  }

  function isProviderError(raw) {
    return providerStatus(raw) != null;
  }

  // Занятость сервиса — отдельным текстом от остальных отказов: это не поломка,
  // а «сейчас не влезли», и человеку важно, что повторять имеет смысл.
  // 429 — превышена частота, 529 (Anthropic) / 503 / 502 / 504 — перегрузка.
  function isBusyStatus(status) {
    return status === 429 || status === 529 || status === 503 || status === 502 || status === 504;
  }

  // Текст для ответа провайдера, либо `null`, если строка на ответ провайдера
  // не похожа.
  function provider(raw) {
    const status = providerStatus(raw);
    if (status == null) return null;
    if (isBusyStatus(status) || /overloaded|rate.?limit/i.test(str(raw))) return t('err.provider.busy');
    return t('err.provider.generic');
  }

  // ── 4. Промпт не опубликован ──────────────────────────────────────────────
  //
  // llm-proxy отвечает 424 + stage 'prompt', адаптеры в `lex-teacher-core.js`
  // превращают это в маркер `LEX_PROMPT_MISSING`. Маркер служебный — человеку
  // он не говорит ничего, поэтому обе поверхности спрашивают текст здесь.
  //
  // Отдельным текстом от «ответ не пришёл»: это не сбой и не перегрузка, а
  // состояние, которое чинится действием владельца (опубликовать заготовку), и
  // человеку важно, что денег с него не взяли.
  function isPromptMissing(raw) {
    return str(raw).includes('LEX_PROMPT_MISSING');
  }

  function promptMissing() {
    return t('err.prompt.notPublished');
  }

  global.LexErrorText = Object.freeze({
    auth,
    topup,
    provider,
    isProviderError,
    providerStatus,
    isPromptMissing,
    promptMissing,
  });
})(typeof self !== 'undefined' ? self : globalThis);
