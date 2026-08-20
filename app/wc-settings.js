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
    ['system', 'System'],
    ['light', 'Light'],
    ['dark', 'Dark'],
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

  // Какая сборка сейчас открыта. До этой строки узнать это было нельзя ничем:
  // номер существовал, но уходил только в базу. А открыт этот чат в трёх
  // местах сразу — в браузере, в программе для Мака и на телефоне, — и все
  // трое берут страницу с сервера, поэтому «у меня старое» и «у тебя новое»
  // раньше не различались никак.
  //
  // `webchat-dev` значит, что страницу отдают прямо из папки репозитория, а не
  // из сборки: у неотштампованной страницы номера нет и взяться ему неоткуда.
  function buildLine() {
    const b = global.WC_BUILD;
    if (!b || !b.version) return 'webchat-dev';
    return b.version + ' · ' + b.commit;
  }

  function select(options, value, onChange) {
    const s = el('select', { onchange: (e) => onChange(e.target.value) },
      options.map(([v, t]) => el('option', { value: v, text: t, selected: v === value })));
    return s;
  }

  const WcSettings = {
    // Read and applied before the first paint, so nothing flashes in the wrong
    // theme on the way in.
    //
    // Default is 'dark', not 'system': the product has no light identity of
    // its own — the extension this page has to read as the same product
    // (wc-app.css, top of file) is a dark ground with white laid over it and
    // never shows anything else. 'System'/'Light' stay in the picker below
    // for anyone who wants them; only the out-of-the-box look changed.
    async applyStored() {
      const s = await WcStore.get(['wcTheme', 'wcTextScale']);
      applyTheme(s.wcTheme || 'dark');
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
        // Кто вошёл и сколько на счету — но БЕЗ кнопки пополнения: она
        // теперь одна, в подвале шторки истории (решение владельца
        // 2026-08-20). Пополнение открывалось отсюда и оттуда — ровно тот
        // дубль, который здесь и снимается.
        el('.wc-field', {}, [
          el('.wc-field-row', {}, [
            el('.wc-field-label', {}, [
              el('b', { text: account.email || 'Not signed in' }),
              el('span', { text: account.signedIn ? 'Balance ' + fmtMoney(account.balanceUsd) : '' }),
            ]),
          ]),
        ]),

        field('Appearance', 'Light, dark, or follow the system',
          select(THEMES, stored.wcTheme || 'dark', (v) => {
            applyTheme(v);
            WcStore.set({ wcTheme: v });
          })),

        el('.wc-field', {}, [
          el('.wc-field-row', {}, [
            el('.wc-field-label', {}, [
              el('b', { text: 'Text size' }),
              el('span', { text: 'Changes the whole page' }),
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
            el('b', { text: 'Sign out' }),
            el('span', { text: 'On this device only' }),
          ]),
          el('button.wc-btn.wc-btn-ghost', {
            type: 'button', text: 'Sign out',
            style: { width: 'auto', padding: '7px 14px', color: 'var(--danger)', borderColor: 'var(--danger)' },
            onclick: () => { handle.close(); ctx.onSignOut(); },
          }),
        ]),
      ]));

      // Последней строкой, самым мелким — номер сборки. Он не настройка, его
      // не крутят; он нужен ровно в тот момент, когда спрашивают «а у тебя
      // какая версия», и тогда его надо найти, а не искать.
      body.push(el('.wc-field', { id: 'wc-build' }, [
        el('.wc-field-row', {}, [
          el('.wc-field-label', {}, [
            el('span', { text: 'Build' }),
          ]),
          el('.wc-field-value', { id: 'wc-build-value', text: buildLine() }),
        ]),
      ]));

      const handle = sheet('wc-settings', 'Settings', body);
      return handle;
    },
  };

  global.WcSettings = WcSettings;
})(typeof self !== 'undefined' ? self : globalThis);
