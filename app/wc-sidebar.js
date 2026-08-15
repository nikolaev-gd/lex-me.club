// webchat/wc-sidebar.js — the list of conversations.
//
// Rename is inline rather than a modal: renaming is the one list action people
// do repeatedly, and a dialog for every one of them is three extra clicks. The
// per-row menu holds it too, because an inline editor with no visible entry
// point is not discoverable and is unreachable without a pointer.
//
// A conversation with no title shows its first message instead of an empty
// row. That is a display fallback, NOT a title: renaming an untitled
// conversation must start from an empty field, not from a sentence the person
// never chose.
(function (global) {
  'use strict';

  const { el, icon, iconBtn, menu, confirm, prompt } = WcUI;

  let elList, elSidebar, elRoot, elScrim;
  let hooks = {};
  let items = [];
  let activeId = null;
  let renamingId = null;

  const DAY = 86400e3;
  function groupOf(ts) {
    const age = Date.now() - (ts || 0);
    if (age < DAY) return 'Сегодня';
    if (age < 7 * DAY) return 'На этой неделе';
    if (age < 30 * DAY) return 'В этом месяце';
    return 'Раньше';
  }

  const displayTitle = WcUI.conversationTitle;

  async function doRename(id) {
    const it = items.find((x) => x.id === id);
    if (!it) return;
    renamingId = id;
    render();
    const input = elList.querySelector('.wc-conv-rename');
    if (!input) {
      // No inline field to focus (the row is not on screen) — fall back to the
      // dialog rather than leaving the person with nothing.
      renamingId = null;
      const next = await prompt('Название беседы', (it.title || '').trim(), { okText: 'Переименовать' });
      if (next !== null) await hooks.onRename(id, next);
      return;
    }
    input.focus();
    input.select();
  }

  async function commitRename(id, value) {
    renamingId = null;
    const it = items.find((x) => x.id === id);
    const next = String(value || '').trim().slice(0, 120);
    if (it && next === (it.title || '').trim()) { render(); return; }
    await hooks.onRename(id, next);
  }

  function rowMenu(anchor, it) {
    menu(anchor, [
      { label: 'Переименовать', icon: 'pencil', onSelect: () => doRename(it.id) },
      { separator: true },
      {
        label: 'Удалить',
        icon: 'trash',
        danger: true,
        onSelect: async () => {
          const t = displayTitle(it);
          const ok = await confirm(
            'Удалить беседу?',
            'Из списка она пропадёт. Переписка в облаке остаётся — эта таблица ничего не теряет.'
              + (t.untitled ? '' : '\n\n' + t.text),
            { okText: 'Удалить', danger: true }
          );
          if (ok) await hooks.onDelete(it.id);
        },
      },
    ]);
  }

  function row(it) {
    if (it.id === renamingId) {
      const input = el('input.wc-conv-rename', {
        type: 'text',
        value: (it.title || '').trim(),
        maxlength: 120,
        placeholder: 'Название',
        onkeydown: (e) => {
          if (e.key === 'Enter') { e.preventDefault(); commitRename(it.id, e.target.value); }
          else if (e.key === 'Escape') { e.preventDefault(); renamingId = null; render(); }
        },
        // Blur commits rather than cancels: clicking away from a field you
        // just typed into means "keep it" to almost everybody.
        onblur: (e) => { if (renamingId === it.id) commitRename(it.id, e.target.value); },
      });
      return el('.wc-conv', {}, [input]);
    }

    const t = displayTitle(it);
    const more = iconBtn('dots', 'Ещё', (e) => {
      e.stopPropagation();
      rowMenu(e.currentTarget, it);
    }, 'wc-conv-more');

    return el('.wc-conv' + (it.id === activeId ? '.is-active' : ''), {
      role: 'listitem',
      tabindex: '0',
      onclick: () => hooks.onOpen(it.id),
      onkeydown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); hooks.onOpen(it.id); }
        else if (e.key === 'F2') { e.preventDefault(); doRename(it.id); }
      },
      // A long press is how a touch device reaches a hover menu. Kept
      // alongside the visible button, not instead of it.
      oncontextmenu: (e) => { e.preventDefault(); rowMenu(more, it); },
    }, [
      el('.wc-conv-title' + (t.untitled ? '.is-untitled' : ''), { text: t.text, title: t.text }),
      more,
    ]);
  }

  function render() {
    if (!items.length) {
      elList.replaceChildren(el('.wc-convs-empty', { text: 'Бесед пока нет.' }));
      return;
    }
    const nodes = [];
    let lastGroup = null;
    items.forEach((it) => {
      const g = groupOf(it.updatedAt);
      if (g !== lastGroup) { nodes.push(el('.wc-convs-group', { text: g })); lastGroup = g; }
      nodes.push(row(it));
    });
    elList.replaceChildren(...nodes);
  }

  const WcSidebar = {
    init(h) {
      hooks = h;
      elList = document.getElementById('wc-convs');
      elSidebar = document.getElementById('wc-sidebar');
      elRoot = document.getElementById('wc-root');
      elScrim = document.getElementById('wc-scrim');

      document.getElementById('wc-new-chat').addEventListener('click', () => {
        hooks.onNew();
        WcSidebar.closeOnNarrow();
      });
      document.getElementById('wc-sidebar-close').addEventListener('click', () => WcSidebar.toggle(false));
      document.getElementById('wc-sidebar-open').addEventListener('click', () => WcSidebar.toggle(true));
      elScrim.addEventListener('click', () => WcSidebar.toggle(false));
    },

    setItems(next, active) {
      items = (next || []).slice();
      activeId = active === undefined ? activeId : active;
      render();
    },

    setActive(id) {
      activeId = id;
      render();
    },

    toggle(open) {
      const collapsed = elRoot.classList.contains('is-sidebar-collapsed');
      const want = open === undefined ? collapsed : open;
      elRoot.classList.toggle('is-sidebar-collapsed', !want);
      // The scrim only exists on a narrow screen; the class decides, so the
      // rule lives in one place — the stylesheet.
      elScrim.hidden = !want || !elRoot.classList.contains('is-narrow');
    },

    // On a narrow screen the sidebar covers the thread, so any action that
    // moves the reader into the thread has to close it.
    closeOnNarrow() {
      if (elRoot.classList.contains('is-narrow')) WcSidebar.toggle(false);
    },

    startRename(id) { return doRename(id); },
  };

  global.WcSidebar = WcSidebar;
})(typeof self !== 'undefined' ? self : globalThis);
