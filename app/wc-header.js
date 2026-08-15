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
// В шапке остались ровно две вещи: название беседы и кнопка нового чата.
(function (global) {
  'use strict';

  const { fmtMoney } = WcUI;

  let elTitle, elAvatar, elEmail, elBalance, elAccount;
  let hooks = {};
  let account = { signedIn: false };

  function paintAccount() {
    const email = account.email || '';
    elEmail.textContent = email || 'Не выполнен вход';
    elAvatar.textContent = email ? email[0] : '?';

    const bal = account.balanceUsd;
    elBalance.textContent = account.signedIn ? fmtMoney(bal) : '—';
    // Ноль — это не то же самое, что «не смогли прочитать»: пустой баланс
    // означает, что строка не прочиталась, и красить это тревожным цветом
    // значит пугать из-за моргнувшей сети.
    elBalance.classList.toggle('is-empty', Number.isFinite(Number(bal)) && Number(bal) <= 0);
    elAccount.title = email ? (email + ' · баланс ' + fmtMoney(bal)) : 'Не выполнен вход';
  }

  const WcHeader = {
    init(h) {
      hooks = h;
      elTitle = document.getElementById('wc-topbar-title');
      elAccount = document.getElementById('wc-account');
      elAvatar = document.getElementById('wc-account-avatar');
      elEmail = document.getElementById('wc-account-email');
      elBalance = document.getElementById('wc-account-balance');

      elAccount.addEventListener('click', () => hooks.onSettings());

      paintAccount();
    },

    setAccount(next) {
      account = next || { signedIn: false };
      paintAccount();
    },

    setTitle(text) {
      const t = (text || '').trim();
      elTitle.textContent = t || 'Новый чат';
      elTitle.title = t;
      // The browser tab and the shell window read this. A conversation you can
      // find by its window title is worth the two lines.
      document.title = t ? t + ' — Lex' : 'Lex';
    },

    account() { return account; },
  };

  global.WcHeader = WcHeader;
})(typeof self !== 'undefined' ? self : globalThis);
