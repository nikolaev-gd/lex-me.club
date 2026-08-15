// webchat/wc-header.js — the top bar: conversation title, balance, account.
//
// The balance is a button, not a label. It is the only place in the interface
// where "I have run out" and "here is how to fix it" can be the same gesture,
// and a person who has just been refused an answer should not have to go
// hunting through a menu for the top-up page.
(function (global) {
  'use strict';

  const { el, menu, fmtMoney } = WcUI;

  let elTitle, elBalance, elBalanceValue, elAvatar, elLetter;
  let hooks = {};
  let account = { signedIn: false };

  function paintAccount() {
    const bal = account.balanceUsd;
    elBalanceValue.textContent = account.signedIn ? fmtMoney(bal) : '—';
    // Zero is not the same as unknown: a null balance means we could not read
    // the row, and painting that red would cry wolf on a flaky network.
    elBalance.classList.toggle('is-empty', Number.isFinite(Number(bal)) && Number(bal) <= 0);
    elBalance.title = account.signedIn
      ? 'Баланс ' + fmtMoney(bal) + ' — нажмите, чтобы пополнить'
      : 'Не выполнен вход';

    const email = account.email || '';
    elLetter.textContent = email ? email[0] : '?';
    elAvatar.title = email || 'Аккаунт';
  }

  const WcHeader = {
    init(h) {
      hooks = h;
      elTitle = document.getElementById('wc-topbar-title');
      elBalance = document.getElementById('wc-balance');
      elBalanceValue = document.getElementById('wc-balance-value');
      elAvatar = document.getElementById('wc-account-open');
      elLetter = document.getElementById('wc-avatar-letter');

      elBalance.addEventListener('click', () => hooks.onTopUp());
      document.getElementById('wc-settings-open').addEventListener('click', () => hooks.onSettings());

      elAvatar.addEventListener('click', (e) => {
        menu(e.currentTarget, [
          { head: account.email || 'Не выполнен вход' },
          { separator: true },
          { label: 'Пополнить баланс', icon: 'wallet', onSelect: () => hooks.onTopUp() },
          { label: 'Настройки', icon: 'dots', onSelect: () => hooks.onSettings() },
          { separator: true },
          { label: 'Выйти', icon: 'logout', danger: true, onSelect: () => hooks.onSignOut() },
        ]);
      });

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
