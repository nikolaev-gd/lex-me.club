// webchat/wc-header.js — шапка и строка аккаунта внизу шторки.
//
// ── Что отсюда убрано и почему ──────────────────────────────────────────────
//
// Было три органа в шапке: пилюля с балансом, шестерёнка и кружок с первой
// буквой почты. Вместе с листом настроек они давали дубли, которые владелец и
// назвал в разборе: пополнение открывалось из ТРЁХ мест (пилюля, меню кружка,
// кнопка в настройках), настройки из двух (шестерёнка и меню кружка), выход из
// двух (меню кружка и настройки).
//
// Стало: один вход — строка аккаунта внизу шторки. Она показывает почту и
// баланс и открывает лист настроек, внутри которого и пополнение, и выход.
// Ровно так устроены ChatGPT, Claude и Gemini на телефоне: аккаунт внизу
// шторки, новый чат наверху.
//
// ── Что в шапке (решение владельца, 2026-08-17) ─────────────────────────────
//
// РОВНО ДВА органа и больше ничего: слева три полоски, открывающие шторку
// истории, справа — ручка нового чата. Название беседы из шапки убрано; оно
// осталось в заголовке вкладки и окна оболочки, где не отнимает у телефона
// строку экрана.
//
// Ручка нового чата показывается ТОЛЬКО когда в текущем чате что-то есть.
// «Новый чат» поверх пустого чата не делает ничего — кнопка, нажатие на
// которую ничем не отличается от бездействия, хуже отсутствующей: человек
// жмёт и решает, что сломалось.
//
// В строке аккаунта внизу шторки почты больше нет — тоже решение владельца.
// Свой адрес человек знает; строка стоит дороже сведения. Адрес остался
// внутри листа настроек.
(function (global) {
  'use strict';

  const { fmtMoney } = WcUI;

  let elBalance, elSettings, elTopup, elNewChat, elVoiceGear;
  let hooks = {};
  let account = { signedIn: false };
  let hasContent = false;
  let voiceActive = false;

  // Both right-side controls are driven off the SAME two inputs, in one
  // place, because they used to fight each other: WcThread.setEmpty() calls
  // setHasContent(true) the instant the first spoken bubble lands — which is
  // early in every call — and a plain per-caller toggle on #wc-new-chat.hidden
  // would silently win that race back open mid-call. `[hidden]` also carries
  // `!important` (wc-app.css, top of file) precisely so it always wins over a
  // stray display rule, which rules out papering over this with CSS instead.
  function paintTopbarRight() {
    if (elNewChat) elNewChat.hidden = voiceActive || !hasContent;
    if (elVoiceGear) elVoiceGear.hidden = !voiceActive;
  }

  function paintAccount() {
    const email = account.email || '';
    const bal = account.balanceUsd;
    elBalance.textContent = account.signedIn ? fmtMoney(bal) : '—';
    // Ноль — это не то же самое, что «не смогли прочитать»: пустой баланс
    // означает, что строка не прочиталась, и красить это тревожным цветом
    // значит пугать из-за моргнувшей сети.
    elBalance.classList.toggle('is-empty', Number.isFinite(Number(bal)) && Number(bal) <= 0);
    // Адрес ушёл с экрана, но не из доступности: он остаётся подписью кнопки
    // настроек — за ней он и лежит, — так что и скринридер, и наведение мышью
    // его называют.
    elSettings.title = email ? (email + ' · Settings') : 'Settings';
    elTopup.title = account.signedIn ? ('Top up balance · ' + fmtMoney(bal)) : 'Top up balance';
  }

  const WcHeader = {
    init(h) {
      hooks = h;
      elSettings = document.getElementById('wc-account-settings');
      elTopup = document.getElementById('wc-account-topup');
      elBalance = document.getElementById('wc-account-balance');
      elNewChat = document.getElementById('wc-new-chat');
      elVoiceGear = document.getElementById('wc-voice-gear');

      // Две кнопки — два действия, и каждое ведёт ровно в одно место.
      elSettings.addEventListener('click', () => hooks.onSettings());
      elTopup.addEventListener('click', () => hooks.onTopUp());
      // Visible only mid-call (wc-app.css, .is-voice) — opens the existing
      // Live conversation / Push to talk switcher, anchored to itself.
      elVoiceGear.addEventListener('click', (e) => hooks.onVoiceSettings(e.currentTarget));

      paintAccount();
      paintTopbarRight();
    },

    setAccount(next) {
      account = next || { signedIn: false };
      paintAccount();
    },

    setTitle(text) {
      const t = (text || '').trim();
      // Шапка название больше не показывает — оно живёт в заголовке вкладки и
      // окна оболочки. Беседу, которую можно найти по заголовку окна, стоит
      // назвать.
      document.title = t ? t + ' — Lex' : 'Lex';
    },

    // Есть ли в текущем чате хоть один ход. Один из двух источников правды
    // для правого края шапки — см. paintTopbarRight.
    setHasContent(has) {
      hasContent = !!has;
      paintTopbarRight();
    },

    // Второй источник правды для правого края шапки: во время звонка ручка
    // нового чата гаснет (начинать второй чат посреди разговора нет смысла),
    // а на её месте встаёт шестерёнка. Дёргается из wc-app.js рядом с
    // WcComposer.setVoiceActive — тем же событием, что открывает и закрывает
    // сам звонок.
    setVoiceActive(on) {
      voiceActive = !!on;
      paintTopbarRight();
    },

    account() { return account; },
  };

  global.WcHeader = WcHeader;
})(typeof self !== 'undefined' ? self : globalThis);
