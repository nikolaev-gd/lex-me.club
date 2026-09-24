// model-picker-dropdown.js — custom model+effort picker.
//
// Replaces the native <select> that used to list text models (grouped by
// provider) plus a second, separate <select> for effort. A native <select>
// can't show a hover submenu — the OS renders it, not us — so this is a
// hand-rolled popup: one row per model, and hovering a model with more than
// one supported effort opens a submenu to the side listing the efforts, a
// checkmark on whichever one is currently in effect. Clicking the model row
// itself (without detouring into the submenu) commits with that same
// checked effort — i.e. "whatever this model was last set to".
//
// Two ways in: `mount(trigger, config)` turns a <button> into a full
// self-contained picker (its own popup panel, positioning, outside-click/
// Escape/scroll close). `populateModelRows(container, opts)` is the lower-
// level piece mount() is built on — it only fills an ALREADY-open,
// caller-owned container with the grouped rows + hover-submenu behavior,
// for callers (chat-surface.js's per-message re-ask menu) that already have
// their own anchored-menu open/close/positioning machinery and just need
// the row content and the hover-effort logic, not a second copy of it.
//
// Loaded via manifest content_scripts AFTER model-registry.js and BEFORE
// chat-model-picker.js. Exposes globalThis.LexModelPickerDropdown =
// { mount, open, close, populateModelRows, scrollClosesMenu, takeEscapeForMenu }
// — the last two are the close rules every anchored menu shares (see below).

(function (global) {
  'use strict';

  const ModelRegistry = global.LexModelRegistry;
  const PROVIDER_ORDER = ['openai', 'google', 'anthropic'];

  // `only` — необязательное имя поставщика: список сужается до его моделей.
  // Нужен вкладкам поставщиков в панели настроек (2026-09-06): внутри вкладки
  // показываются модели ТОЛЬКО этого поставщика. Не передали — как было, все.
  function textModelsGrouped(only) {
    const groupLabels = ModelRegistry.providerGroupLabel || {};
    const groups = [];
    for (const provider of PROVIDER_ORDER) {
      if (only && provider !== only) continue;
      const models = ModelRegistry.models.filter(
        (m) => m.type === 'text' && !m.hidden && m.provider === provider,
      );
      if (!models.length) continue;
      groups.push({ provider, label: groupLabels[provider] || provider, models });
    }
    return groups;
  }

  async function resolveEffort(apiModel, opts) {
    const supported = ModelRegistry.effortSupport[apiModel] || ['none'];
    let stored = null;
    try { stored = await opts.getEffort(apiModel); } catch (_) { /* noop */ }
    const fallback = ModelRegistry.defaultEffort[apiModel] || supported[0] || 'none';
    return supported.includes(stored) ? stored : fallback;
  }

  // One open picker at a time, tracked module-wide so opening a second one
  // (or clicking outside, or Escape) always closes whatever was open first.
  let active = null;
  // Номер последнего open(): open() ждёт ответов (getSelected, leadRow, а у
  // меню под блоком «Subtitles» — tailRow.isVisible, до 1,5 с), и второе
  // нажатие за это время начинает новое открытие. Показывает меню только
  // последнее — иначе первое вставало бы на экран мимо `active` и его нечем
  // было бы закрыть.
  let openSeq = 0;

  function closeActive() {
    if (!active) return;
    active.cleanup();
    active = null;
  }

  // ── When a menu opened at a button closes ──────────────────────────────
  //
  // ONE rule for every menu anchored to a button: the model menus of this file
  // (model buttons in settings, the model tree off the «+» menu, the Subtitles
  // block, the answer's model on lex-me.club) and the menus of chat-surface.js
  // openAnchoredMenu (the model under an answer, «+», the voice mode, action
  // presets). chat-surface calls these two functions — there is no second copy.

  // A scroll closes the menu only when it can move the menu's button: the page
  // itself (target = document) or an element that holds the button (the chat
  // feed, the settings window). The menu's own list and a neighbour that
  // scrolls by itself do not: the transcript panel follows the playing video
  // line by line, and closing on that shut every menu within a couple of
  // seconds of a playing video (until v1.262.0 the Subtitles block's too).
  // A button redrawn while the menu is open has no known place any more — then
  // any scroll closes it, as before.
  // isInside(node) — the node belongs to the menu (its list, its submenu).
  function scrollClosesMenu(target, anchor, isInside) {
    if (!target || target.nodeType !== 1) return true;
    if (isInside && isInside(target)) return false;
    if (!anchor || !anchor.isConnected) return true;
    return target.contains(anchor);
  }

  // Escape closes the open menu — and only it: the event is marked handled
  // (preventDefault) and stopped, so the settings window under the menu, the
  // small Lex window and YouTube itself do not act on the same press. Called
  // from capture-phase listeners: the small window and the side panel stop key
  // bubbling at their root (chat-surface isolateEvents), and a bubbling
  // listener never heard an Escape pressed inside them — the window closed
  // and the menu stayed hanging on the page. The price window (LexDialog) sits
  // above everything; its Escape is its own. Returns true when it took the key.
  function takeEscapeForMenu(e, close) {
    if (e.key !== 'Escape' || e.defaultPrevented) return false;
    try { if (global.LexDialog && typeof global.LexDialog.isOpen === 'function' && global.LexDialog.isOpen()) return false; } catch (_) { /* noop */ }
    e.preventDefault();
    e.stopPropagation();
    close();
    return true;
  }

  document.addEventListener('mousedown', (e) => {
    if (!active) return;
    if (active.contains(e.target)) return;
    closeActive();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (active) takeEscapeForMenu(e, closeActive);
  }, true);
  document.addEventListener('scroll', (e) => {
    if (!active) return;
    if (scrollClosesMenu(e.target, active.anchor, (n) => active.contains(n))) closeActive();
  }, true);

  function clampIntoViewport(el, preferLeft, preferTop) {
    const r = el.getBoundingClientRect();
    let left = preferLeft;
    let top = preferTop;
    if (left + r.width > window.innerWidth - 4) left = Math.max(4, window.innerWidth - r.width - 4);
    if (left < 4) left = 4;
    if (top + r.height > window.innerHeight - 4) top = Math.max(4, window.innerHeight - r.height - 4);
    if (top < 4) top = 4;
    el.style.left = Math.round(left) + 'px';
    el.style.top = Math.round(top) + 'px';
  }

  // Fills `container` with provider-grouped model rows, each carrying a
  // checkmark for the currently selected model and — for any model with
  // more than one supported effort — a hover submenu of efforts (also
  // checkmarked). This is the ONE place that logic lives; every caller that
  // needs a "pick a model, optionally pick its effort too" list (the bar's
  // own trigger+panel below, and chat-surface.js's per-message re-ask menu)
  // populates its own container through this instead of re-implementing the
  // hover-submenu dance — and the position:fixed-before-measuring-width fix
  // (see openSubmenu) only has to be right in one place.
  //
  // `container` owns its own visibility/positioning/outside-click handling;
  // this function only ever appends rows to it and portals the submenu to
  // <body> (so it isn't clipped by container's own overflow/size). Returns a
  // handle so the caller can fold the submenu into ITS OWN "is this click
  // still inside my menu" and "close everything" logic:
  //   { closeSubmenu(), containsNode(node) }
  //
  // opts.selected: {provider, apiModel} | null — which row gets the checkmark.
  // opts.leadRow: {label, selected, onPick()} | null — optional first row
  //   above the models (a choice that is not a model and has no efforts).
  // opts.tailRow: {label, onPick(row)} | null — optional last row below the
  //   models: an action, not a choice. It does not close the menu — onPick
  //   decides what happens next (see tailRow in open()).
  // opts.getEffort(apiModel): () => Promise<string|null> — persisted effort.
  // opts.onPick(provider, apiModel, effort): called on a committed choice.
  function populateModelRows(container, opts) {
    let submenuEl = null;
    let submenuForApiModel = null;

    function closeSubmenu() {
      if (submenuEl) { submenuEl.remove(); submenuEl = null; submenuForApiModel = null; }
    }

    function openSubmenu(rowEl, apiModel, efforts, currentEffort, onChoose) {
      if (submenuForApiModel === apiModel) return;
      closeSubmenu();
      submenuForApiModel = apiModel;
      const sub = document.createElement('div');
      sub.className = 'ytvocab-model-picker-submenu';
      for (const eff of efforts) {
        const item = document.createElement('div');
        item.className = 'ytvocab-model-picker-effort-row';
        if (eff === currentEffort) item.classList.add('is-selected');
        const check = document.createElement('span');
        check.className = 'ytvocab-model-picker-check';
        check.textContent = eff === currentEffort ? '✓' : '';
        const label = document.createElement('span');
        label.className = 'ytvocab-model-picker-label';
        label.textContent = eff;
        item.appendChild(check);
        item.appendChild(label);
        item.addEventListener('mousedown', (e) => e.stopPropagation());
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          onChoose(eff);
        });
        sub.appendChild(item);
      }
      // position MUST be set before measuring offsetWidth below — until it
      // is, this is a plain static block appended to <body> and reports its
      // width as the full page width, not its shrink-to-fit content width.
      // That bogus width used to make the "does it fit on the right?" check
      // fail even with room to spare, flipping the submenu all the way to
      // the left edge of the viewport instead of hugging the row.
      sub.style.position = 'fixed';
      document.body.appendChild(sub);
      submenuEl = sub;
      const rr = rowEl.getBoundingClientRect();
      let left = rr.right + 2;
      const subW = sub.offsetWidth;
      if (left + subW > window.innerWidth - 4) left = rr.left - subW - 2;
      // Не вылезать за низ окна: у кнопки внизу панели подменю иначе режется.
      const top = Math.min(rr.top, window.innerHeight - sub.offsetHeight - 4);
      sub.style.top = Math.round(Math.max(4, top)) + 'px';
      sub.style.left = Math.round(Math.max(4, left)) + 'px';
    }

    // opts.leadRow — необязательная первая строка над моделями: выбор, который
    // не модель и ступеней не имеет, например «(как основной чат)» у заготовки
    // действия. { label, selected, onPick() }.
    if (opts.leadRow) {
      const lead = opts.leadRow;
      const row = document.createElement('div');
      row.className = 'ytvocab-model-picker-row ytvocab-model-picker-lead-row';
      if (lead.selected) row.classList.add('is-selected');
      const check = document.createElement('span');
      check.className = 'ytvocab-model-picker-check';
      check.textContent = lead.selected ? '✓' : '';
      const label = document.createElement('span');
      label.className = 'ytvocab-model-picker-label';
      label.textContent = lead.label;
      row.appendChild(check);
      row.appendChild(label);
      row.addEventListener('mouseenter', closeSubmenu);
      row.addEventListener('click', () => {
        closeSubmenu();
        lead.onPick();
      });
      container.appendChild(row);
    }

    // opts.provider — сузить до одного поставщика (вкладки в настройках).
    // Тогда заголовок группы не рисуется: он повторял бы имя открытой вкладки.
    const only = opts.provider || null;
    const groups = textModelsGrouped(only);
    for (const group of groups) {
      if (!only) {
        const groupEl = document.createElement('div');
        groupEl.className = 'ytvocab-model-picker-group-label';
        groupEl.textContent = group.label;
        container.appendChild(groupEl);
      }

      for (const m of group.models) {
        const row = document.createElement('div');
        row.className = 'ytvocab-model-picker-row';

        let selected = false;
        try { selected = !!(opts.selected && opts.selected.provider === group.provider && opts.selected.apiModel === m.apiModel); } catch (_) { /* noop */ }
        if (selected) row.classList.add('is-selected');

        const check = document.createElement('span');
        check.className = 'ytvocab-model-picker-check';
        check.textContent = selected ? '✓' : '';
        const label = document.createElement('span');
        label.className = 'ytvocab-model-picker-label';
        label.textContent = m.label;
        row.appendChild(check);
        row.appendChild(label);

        const supported = ModelRegistry.effortSupport[m.apiModel] || ['none'];
        let resolvedEffort = null;
        async function ensureResolved() {
          if (resolvedEffort == null) resolvedEffort = await resolveEffort(m.apiModel, opts);
          return resolvedEffort;
        }

        if (supported.length > 1) {
          const chevron = document.createElement('span');
          chevron.className = 'ytvocab-model-picker-chevron';
          chevron.textContent = '›';
          row.appendChild(chevron);

          row.addEventListener('mouseenter', async () => {
            const eff = await ensureResolved();
            openSubmenu(row, m.apiModel, supported, eff, (chosenEff) => {
              closeSubmenu();
              opts.onPick(group.provider, m.apiModel, chosenEff);
            });
          });
        } else {
          row.addEventListener('mouseenter', closeSubmenu);
        }

        row.addEventListener('click', async () => {
          const eff = await ensureResolved();
          closeSubmenu();
          opts.onPick(group.provider, m.apiModel, eff);
        });

        container.appendChild(row);
      }
    }

    // opts.tailRow — необязательная последняя строка под моделями, за чертой:
    // действие, а не выбор модели (пункт «Transcribe audio» под блоком
    // «Subtitles»). Ни галочки, ни ступеней; меню она не закрывает — что
    // дальше, решает onPick (пункт раскрывает под собой подтверждение).
    if (opts.tailRow) {
      const tail = opts.tailRow;
      const sep = document.createElement('div');
      sep.className = 'ytvocab-model-picker-sep';
      container.appendChild(sep);
      const row = document.createElement('div');
      row.className = 'ytvocab-model-picker-row ytvocab-model-picker-tail-row';
      const check = document.createElement('span');
      check.className = 'ytvocab-model-picker-check';
      const label = document.createElement('span');
      label.className = 'ytvocab-model-picker-label';
      label.textContent = tail.label;
      row.appendChild(check);
      row.appendChild(label);
      row.addEventListener('mouseenter', closeSubmenu);
      row.addEventListener('click', () => {
        closeSubmenu();
        tail.onPick(row);
      });
      container.appendChild(row);
    }

    return {
      closeSubmenu,
      containsNode(node) {
        return !!(submenuEl && submenuEl.contains(node));
      },
    };
  }

  function openPanel(trigger, opts) {
    closeActive();
    const panel = document.createElement('div');
    panel.className = 'ytvocab-model-picker-panel';
    document.body.appendChild(panel);

    // Закрыть именно это меню, если оно ещё открыто (не то, что открыли после).
    const closeThis = () => { if (active && active.panel === panel) closeActive(); };
    // Место на экране: под якорем, внизу места нет — над ним. Зовётся ещё раз,
    // когда меню меняет размер (последняя строка раскрыла подтверждение).
    const place = () => {
      if (!trigger.isConnected) {
        // Якорь перерисовали, пока меню открыто: остаёмся где стоим, только в
        // пределах окна.
        clampIntoViewport(panel, parseFloat(panel.style.left) || 4, parseFloat(panel.style.top) || 4);
        return;
      }
      const tr = trigger.getBoundingClientRect();
      // Внизу места нет (якорь у нижнего края, например «+» композера) — вверх.
      if (opts.side) {
        // Сбоку от строки чужого меню, как подменю: вправо, не влезает — влево.
        let left = tr.right + 2;
        if (left + panel.offsetWidth > window.innerWidth - 4) left = tr.left - panel.offsetWidth - 2;
        clampIntoViewport(panel, left, tr.top);
      } else {
        const below = tr.bottom + 4;
        const fitsBelow = below + panel.offsetHeight <= window.innerHeight - 4;
        clampIntoViewport(panel, tr.left, fitsBelow ? below : tr.top - panel.offsetHeight - 4);
      }
    };

    const rows = populateModelRows(panel, {
      selected: opts.selected,
      provider: opts.provider,
      leadRow: opts.leadRow
        ? { ...opts.leadRow, onPick: () => { closeActive(); opts.leadRow.onPick(); } }
        : null,
      tailRow: opts.tailRow
        ? { label: opts.tailRow.label, onPick: (row) => opts.tailRow.onPick({ row, panel, relayout: place, close: closeThis }) }
        : null,
      getEffort: opts.getEffort,
      onPick: (provider, apiModel, effort) => {
        closeActive();
        opts.onPick(provider, apiModel, effort);
      },
    });

    panel.style.position = 'fixed';
    place();

    active = {
      anchor: trigger,
      panel,
      contains(node) {
        return trigger.contains(node) || panel.contains(node) || rows.containsNode(node);
      },
      cleanup() {
        rows.closeSubmenu();
        panel.remove();
      },
    };
  }

  // trigger: the element (a <button>) that opens the picker on click.
  // opts.getSelected(): () => Promise<{provider, apiModel}|null> — which row
  //   gets the checkmark / .is-selected treatment.
  // opts.getEffort(apiModel): () => Promise<string|null> — the persisted
  //   effort for that model, or null (falls back to the registry default).
  // opts.onPick(provider, apiModel, effort): called once the user commits a
  //   choice, either by clicking the model row (effort = whatever was
  //   checked) or an effort row in the submenu (effort = that explicit pick).
  // opts.leadRow: {label, isSelected(): Promise<bool>, onPick()} — optional
  //   first row above the models, e.g. «(same as main chat)» of an action mode.
  // opts.tailRow: {label (string | () => string), isVisible(): bool |
  //   Promise<bool>, onPick(ctl)} — optional last row below the models, an
  //   action rather than a model («Transcribe audio» under the Subtitles
  //   block). isVisible is asked on every open; onPick gets
  //   ctl = {row, panel, relayout(), close()} and the menu stays open.
  function mount(trigger, config) {
    trigger.classList.add('ytvocab-model-picker-trigger');
    trigger.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (active && active.contains(trigger)) { closeActive(); return; }
      await open(trigger, config);
    });
  }

  // Открыть дерево под элементом без кнопки-триггера — для пункта чужого меню
  // (строка модели в меню «+» композера): само меню к этому моменту закрыто,
  // дерево встаёт под anchor. config — тот же, что у mount.
  // opts.side — встать сбоку от anchor (открытие по наведению на строку меню).
  async function open(anchor, config, openOpts) {
      if (openOpts && openOpts.side && active && active.anchor === anchor) return;
      closeActive();
      const seq = ++openSeq;
      // config.tailRow — { label, isVisible(), onPick(ctl) }: строка под
      // моделями. Показывать ли её, спрашивается на каждое открытие и сразу —
      // параллельно с остальными вопросами: ответ может идти до секунды.
      const tailShown = config.tailRow
        ? Promise.resolve().then(() => config.tailRow.isVisible()).then((v) => !!v, () => false)
        : null;
      let selected = null;
      try { selected = await config.getSelected(); } catch (_) { /* noop */ }
      // config.provider — строка или функция: вкладка настроек считает её на
      // момент нажатия, а не на момент подключения.
      let provider = null;
      try { provider = (typeof config.provider === 'function') ? config.provider() : (config.provider || null); } catch (_) { /* noop */ }
      // config.leadRow — { label, isSelected(), onPick() }: строка над
      // моделями; отмечена ли она, тоже считается на момент нажатия.
      let leadRow = null;
      if (config.leadRow) {
        let leadSelected = false;
        try { leadSelected = !!(await config.leadRow.isSelected()); } catch (_) { /* noop */ }
        leadRow = { label: config.leadRow.label, selected: leadSelected, onPick: config.leadRow.onPick };
      }
      let tailRow = null;
      if (tailShown && await tailShown) {
        const label = (typeof config.tailRow.label === 'function') ? config.tailRow.label() : config.tailRow.label;
        tailRow = { label: String(label || ''), onPick: config.tailRow.onPick };
      }
      // Пока ждали, началось другое открытие — показывает оно.
      if (seq !== openSeq) return;
      openPanel(anchor, {
        selected,
        provider,
        leadRow,
        tailRow,
        getEffort: config.getEffort,
        onPick: config.onPick,
        side: !!(openOpts && openOpts.side),
      });
  }

  global.LexModelPickerDropdown = {
    mount, open, close: closeActive, populateModelRows,
    scrollClosesMenu, takeEscapeForMenu,
  };
})(typeof self !== 'undefined' ? self : globalThis);
