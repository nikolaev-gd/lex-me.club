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
    // ⚠️ ПИШЕТСЯ МНОЖИТЕЛЬ, А НЕ ГОТОВЫЙ РАЗМЕР.
    //
    // Здесь стоял `style.fontSize = 15 * n / 100`, и ползунок НЕ РАБОТАЛ
    // вовсе — не «плохо работал», а не двигал в переписке ни одной буквы
    // (замерено в приложении: на 130% корень отдавал 19.5px, а `body`, поле
    // ввода и лента — прежние 15/16/15). Причина: размер ставился только на
    // корне, а `html, body` в таблице стилей задавала `body` свои 15px
    // напрямую, и наследовать было нечего; `rem` в этом файле стилей не
    // встречается ни разу, так что и через единицы измерения корень ни на что
    // не влиял.
    //
    // Теперь база живёт в стилях (`--wc-font-base`, у телефона своя), а отсюда
    // уходит только во сколько раз её увеличили. Ползунок и поверхность
    // перестали спорить за одно и то же свойство: они множатся.
    document.documentElement.style.setProperty('--wc-font-scale', (n / 100).toFixed(4));
  }

  // Строку настроек рисует ОБЩИЙ с расширением модуль (lex-settings-fields.js).
  // Своей вёрстки `.wc-field` здесь больше нет: пока она была своя, страница и
  // расширение разъезжались по кеглю, цвету и устройству строки.
  const field = (label, hint, control) =>
    LexSettingsFields.fieldNode({ label, hint, control });

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

  // ── Переключатель ────────────────────────────────────────────────────────
  //
  // Готового не было: в этом листе до сих пор жили только выпадающие списки и
  // ползунок. Внутри — обычный `<input type="checkbox">`, а не div с
  // обработчиком: он сам приходит с ролью, с фокусом, с пробелом как нажатием
  // и с состоянием для скринридера. Вид ему задаёт CSS (`.wc-switch`), и это
  // ровно тот случай, когда «сделать новый компонент» значит одеть родной, а
  // не написать свой.
  function toggle(checked, onChange) {
    const input = el('input', {
      type: 'checkbox',
      checked: !!checked || null,
      onchange: (e) => onChange(!!e.target.checked),
    });
    return el('label.wc-switch', {}, [input, el('span.wc-switch-track', {}, [el('span.wc-switch-knob')])]);
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
      const stored = await WcStore.get(['wcTheme', 'wcTextScale', WcWordPick.STORAGE_KEY]);
      const account = (ctx && ctx.account) || {};

      const scaleValue = el('span', { text: (stored.wcTextScale || 100) + '%' });
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
        LexSettingsFields.identityNode({
          email: account.email,
          emptyLabel: 'Not signed in',
          balance: account.signedIn ? 'Balance ' + fmtMoney(account.balanceUsd) : '',
        }),

        field('Appearance', 'Light, dark, or follow the system',
          select(THEMES, stored.wcTheme || 'dark', (v) => {
            applyTheme(v);
            WcStore.set({ wcTheme: v });
          })),

        LexSettingsFields.fieldNode({
          label: 'Text size',
          hint: 'Changes the whole page',
          control: scale,
          value: scaleValue,
        }),

        // Своя настройка, свой блок с заголовком — правило дома: разные вещи
        // не делят строку. Рисуется тем же общим модулем, что и соседние
        // строки (`field` выше → LexSettingsFields.fieldNode): своей вёрстки
        // у настроек этой страницы больше нет.
        //
        // Значение живёт в хранилище ЭТОЙ поверхности, то есть включённое в
        // браузере не включается на Маке и на телефоне: у каждой оболочки своя
        // IndexedDB, даже когда адрес страницы один и тот же.
        field('Tap words', 'Tap a word in any message to ask about it',
          toggle(stored[WcWordPick.STORAGE_KEY] === true, (on) => {
            // Применяем СРАЗУ, не дожидаясь записи: лист настроек полупрозрачен
            // и лента под ним видна — человек видит, что произошло, тем же
            // движением.
            WcWordPick.setEnabled(on);
            WcStore.set({ [WcWordPick.STORAGE_KEY]: on });
          })),
      ];

      // Voice settings are step 4 and register themselves — the sheet does not
      // need to know what is in them.
      if (global.WcVoice && WcVoice.settingsFields) {
        (await WcVoice.settingsFields()).forEach((f) => body.push(f));
      }

      const signOutBtn = el('button.lex-field-btn.lex-field-btn--danger', {
        type: 'button', text: 'Sign out',
        onclick: () => { handle.close(); ctx.onSignOut(); },
      });
      body.push(LexSettingsFields.fieldNode({
        label: 'Sign out',
        hint: 'On this device only',
        control: signOutBtn,
      }));

      // Последней строкой, самым мелким — номер сборки. Он не настройка, его
      // не крутят; он нужен ровно в тот момент, когда спрашивают «а у тебя
      // какая версия», и тогда его надо найти, а не искать.
      const buildField = LexSettingsFields.fieldNode({ hint: 'Build', value: buildLine() });
      buildField.id = 'wc-build';
      const buildValue = buildField.querySelector('.lex-field-value');
      if (buildValue) buildValue.id = 'wc-build-value';
      body.push(buildField);

      const handle = sheet('wc-settings', 'Settings', body);
      return handle;
    },
  };

  global.WcSettings = WcSettings;
})(typeof self !== 'undefined' ? self : globalThis);
