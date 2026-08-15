// webchat/wc-settings.js — the settings sheet.
//
// WHAT IS NOT HERE, AND WHY. No model picker, no prompt editor, no request
// log, no cost pill, no answer comparison. Those are the owner's instruments
// and they stay in the extension (docs/PLAN-NEW-CHAT.md, «Чего не делаем»).
// The model this page sends to is the one the owner published — the person
// using this page does not choose it and does not need a control that implies
// they could.
//
// What is left is what a reader actually owns: how the page looks, what
// language it speaks to them in, and how the voice sounds. Each block is its
// own field with its own label, per the house rule that different features do
// not share a row.
(function (global) {
  'use strict';

  const { el, sheet, fmtMoney } = WcUI;

  const THEMES = [
    ['system', 'Как в системе'],
    ['light', 'Светлая'],
    ['dark', 'Тёмная'],
  ];

  function applyTheme(value) {
    const root = document.documentElement;
    if (value === 'light' || value === 'dark') {
      root.dataset.theme = value;
      root.style.colorScheme = value;
    } else {
      delete root.dataset.theme;
      root.style.colorScheme = 'light dark';
    }
  }

  function applyTextScale(value) {
    // Scales the whole page from one number. Bounded because the layout stops
    // being a chat somewhere past 130% and unreadable below 85%.
    const n = Math.max(85, Math.min(130, Number(value) || 100));
    document.documentElement.style.fontSize = (15 * n / 100).toFixed(2) + 'px';
  }

  function field(label, hint, control) {
    return el('.wc-field', {}, [
      el('.wc-field-row', {}, [
        el('.wc-field-label', {}, [el('b', { text: label }), hint ? el('span', { text: hint }) : null]),
        control,
      ]),
    ]);
  }

  function select(options, value, onChange) {
    const s = el('select', { onchange: (e) => onChange(e.target.value) },
      options.map(([v, t]) => el('option', { value: v, text: t, selected: v === value })));
    return s;
  }

  const WcSettings = {
    // Read and applied before the first paint, so nothing flashes in the wrong
    // theme on the way in.
    async applyStored() {
      const s = await WcStore.get(['wcTheme', 'wcTextScale']);
      applyTheme(s.wcTheme || 'system');
      applyTextScale(s.wcTextScale || 100);
    },

    async open(ctx) {
      const stored = await WcStore.get(['wcTheme', 'wcTextScale']);
      const account = (ctx && ctx.account) || {};

      const scaleValue = el('.wc-field-value', { text: (stored.wcTextScale || 100) + '%' });
      const scale = el('input', {
        type: 'range', min: '85', max: '130', step: '5',
        value: String(stored.wcTextScale || 100),
        // 'input', not 'change': a slider that only reacts on release gives no
        // feedback while it is being dragged, which is the whole point of one.
        oninput: (e) => {
          const v = Number(e.target.value);
          scaleValue.textContent = v + '%';
          applyTextScale(v);
          WcStore.set({ wcTextScale: v });
        },
      });

      const body = [
        el('.wc-field', {}, [
          el('.wc-field-row', {}, [
            el('.wc-field-label', {}, [
              el('b', { text: account.email || 'Не выполнен вход' }),
              el('span', { text: account.signedIn ? 'Баланс ' + fmtMoney(account.balanceUsd) : '' }),
            ]),
            el('button.wc-btn.wc-btn-ghost', {
              type: 'button', text: 'Пополнить',
              style: { width: 'auto', padding: '7px 14px' },
              onclick: () => ctx.onTopUp(),
            }),
          ]),
        ]),

        field('Оформление', 'Светлая, тёмная или как в системе',
          select(THEMES, stored.wcTheme || 'system', (v) => {
            applyTheme(v);
            WcStore.set({ wcTheme: v });
          })),

        el('.wc-field', {}, [
          el('.wc-field-row', {}, [
            el('.wc-field-label', {}, [
              el('b', { text: 'Размер текста' }),
              el('span', { text: 'Меняет всю страницу целиком' }),
            ]),
            scale,
            scaleValue,
          ]),
        ]),
      ];

      // Voice settings are step 4 and register themselves — the sheet does not
      // need to know what is in them.
      if (global.WcVoice && WcVoice.settingsFields) {
        (await WcVoice.settingsFields()).forEach((f) => body.push(f));
      }

      body.push(el('.wc-field', {}, [
        el('.wc-field-row', {}, [
          el('.wc-field-label', {}, [
            el('b', { text: 'Выйти из аккаунта' }),
            el('span', { text: 'Только на этом устройстве' }),
          ]),
          el('button.wc-btn.wc-btn-ghost', {
            type: 'button', text: 'Выйти',
            style: { width: 'auto', padding: '7px 14px', color: 'var(--danger)', borderColor: 'var(--danger)' },
            onclick: () => { handle.close(); ctx.onSignOut(); },
          }),
        ]),
      ]));

      const handle = sheet('wc-settings', 'Настройки', body);
      return handle;
    },
  };

  global.WcSettings = WcSettings;
})(typeof self !== 'undefined' ? self : globalThis);
