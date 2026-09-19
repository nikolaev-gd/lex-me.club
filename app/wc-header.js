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

  let elBalance, elSettings, elTopup, elNewChat, elVoiceGear, elMoney, elMoneySum, elMoneyTip;
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

  // Подписи строк разбивки итога — те же виды, что у расширения (порядок
  // строк отдаёт LexChatMoney.breakdown). Страница только по-английски.
  const MONEY_KIND_LABELS = {
    preprocess: 'Preprocess',
    chat: 'Chat',
    voice: 'Voice',
    transcription: 'Transcription',
    dictation: 'Dictation',
    title: 'Conversation title',
  };
  // Цены под ответами прячутся и показываются нажатием на итог — как в
  // расширении; по умолчанию спрятаны. Положение помнит этот браузер.
  const PRICES_KEY = 'lexShowPrices';
  function pricesShown() {
    try { return localStorage.getItem(PRICES_KEY) === '1'; } catch (_) { return false; }
  }
  function paintPricesShown() {
    document.body.classList.toggle('wc-prices-hidden', !pricesShown());
  }

  const WcHeader = {
    init(h) {
      hooks = h;
      elSettings = document.getElementById('wc-account-settings');
      elTopup = document.getElementById('wc-account-topup');
      elBalance = document.getElementById('wc-account-balance');
      elNewChat = document.getElementById('wc-new-chat');
      elVoiceGear = document.getElementById('wc-voice-gear');
      elMoney = document.getElementById('wc-money');
      elMoneySum = document.getElementById('wc-money-sum');
      elMoneyTip = document.getElementById('wc-money-tip');
      if (elMoney) {
        elMoney.addEventListener('click', () => {
          try { localStorage.setItem(PRICES_KEY, pricesShown() ? '0' : '1'); } catch (_) {}
          paintPricesShown();
        });
      }
      paintPricesShown();

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
    // Итог беседы — только когда сервер велит показывать деньги (show). total
    // — { usd, byKind } из LexChatMoney.normalize; null — «$0».
    setMoney(total, show) {
      if (!elMoney) return;
      elMoney.hidden = !show;
      const usd = total ? total.usd : 0;
      elMoneySum.textContent = global.LexChatMoney.format(usd);
      elMoney.dataset.lexUsd = String(usd);
      const rows = global.LexChatMoney.breakdown(total);
      elMoneyTip.replaceChildren(...rows.map((r) => {
        const row = document.createElement('span');
        row.className = 'wc-money-row';
        const label = document.createElement('span');
        label.textContent = MONEY_KIND_LABELS[r.kind] || r.kind;
        const value = document.createElement('span');
        value.textContent = global.LexChatMoney.format(r.usd);
        row.append(label, value);
        return row;
      }));
      elMoneyTip.hidden = !rows.length;
    },

    setVoiceActive(on) {
      voiceActive = !!on;
      paintTopbarRight();
    },

    account() { return account; },
  };

  global.WcHeader = WcHeader;
})(typeof self !== 'undefined' ? self : globalThis);
