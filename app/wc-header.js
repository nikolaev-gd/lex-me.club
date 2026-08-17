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

  let elAvatar, elBalance, elAccount, elNewChat;
  let hooks = {};
  let account = { signedIn: false };

  function paintAccount() {
    const email = account.email || '';
    elAvatar.textContent = email ? email[0] : '?';

    const bal = account.balanceUsd;
    elBalance.textContent = account.signedIn ? fmtMoney(bal) : '—';
    // Ноль — это не то же самое, что «не смогли прочитать»: пустой баланс
    // означает, что строка не прочиталась, и красить это тревожным цветом
    // значит пугать из-за моргнувшей сети.
    elBalance.classList.toggle('is-empty', Number.isFinite(Number(bal)) && Number(bal) <= 0);
    // Адрес ушёл с экрана, но не из доступности: он остаётся подписью строки,
    // так что и скринридер, и наведение мышью его называют.
    elAccount.title = email ? (email + ' · balance ' + fmtMoney(bal)) : 'Not signed in';
  }

  const WcHeader = {
    init(h) {
      hooks = h;
      elAccount = document.getElementById('wc-account');
      elAvatar = document.getElementById('wc-account-avatar');
      elBalance = document.getElementById('wc-account-balance');
      elNewChat = document.getElementById('wc-new-chat');

      elAccount.addEventListener('click', () => hooks.onSettings());

      paintAccount();
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

    // Есть ли в текущем чате хоть один ход. Единственный источник правды для
    // того, показывать ли ручку нового чата.
    setHasContent(has) {
      if (elNewChat) elNewChat.hidden = !has;
    },

    account() { return account; },
  };

  global.WcHeader = WcHeader;
})(typeof self !== 'undefined' ? self : globalThis);
