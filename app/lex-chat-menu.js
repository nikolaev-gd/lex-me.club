// lex-chat-menu.js — the menu of a chat in a list (ios/Lex/STANDARD.md, В7.33): one part for every
// list of chats of the page and of the Mac app — Profi.ru (lex-profi.js) and Chats
// (webchat/wc-sidebar.js), and the lists to come. The iPhone has the same items in Swift
// (`ChatActions`, ios/Lex/Lex/SectionFrame.swift): a swipe to the left and a long press.
//
// What an item does is the server's (supabase/migrations/chat_states.sql, `chat_act`): the order of
// the list, its groups, the pin, the dot and what is gone come back in the next answer of the list,
// the same on every device. This file only opens the menu and names the items.
//
// The look is the common menu of a held button (В7.8–В7.9, lex-send-later.js `menu`, plain): a card
// at the pointer of a right click, on a touch screen at the line after a hold of 480 ms; on top a
// line 12/600 --fg-muted with the name of the chat; items 44 with an icon 16 — Pin or Unpin, Mark as
// read or Mark as unread, Mark as important or Unmark important where a person writes (2026-11-17,
// part 6 of «Уведомления и непрочитанное»: a message there rings an alarm on the iPhone through the
// silent switch; supabase/migrations/important_chats.sql), Rename where the list has it, Delete chat
// in --danger. Nothing is dimmed;
// the line of the chat stands on --bg-hover while the menu is open. Delete chat asks first (the
// dialog В7.16, the window's own `confirm`).
//
// Gives global.LexChatMenu:
//   items(o)            the items: o = { pinned, unread, important, act(name), rename(), remove() };
//                       important true or false — the list has the mark, absent — it has not
//   open(o)             the menu: o = { row, title, at: {x, y}, pinned, unread, important, act, rename, remove, onClose }
//   attach(row, get)    a right click, a hold on a touch screen and the key of the menu open it on
//                       this line; get() → o of open() at the moment of the press, or null
//   remove(o)           asks «Delete this chat?» and acts: o = { confirm, text, act } → Promise<boolean>
(function (global) {
  'use strict';

  function items(o) {
    const out = [
      o.pinned
        ? { label: 'Unpin', icon: 'pinOff', run: () => o.act('unpin') }
        : { label: 'Pin', icon: 'pin', run: () => o.act('pin') },
      o.unread
        ? { label: 'Mark as read', icon: 'read', run: () => o.act('read') }
        : { label: 'Mark as unread', icon: 'unread', run: () => o.act('unread') },
    ];
    if (typeof o.important === 'boolean') {
      out.push(o.important
        ? { label: 'Unmark important', icon: 'bellOff', run: () => o.act('unimportant') }
        : { label: 'Mark as important', icon: 'bell', run: () => o.act('important') });
    }
    if (typeof o.rename === 'function') out.push({ label: 'Rename', icon: 'pencil', run: () => o.rename() });
    out.push({ label: 'Delete chat', icon: 'trash', danger: true, run: () => o.remove() });
    return out;
  }

  function open(o) {
    if (!o || !o.row || !global.LexSendLater) return null;
    const r = o.row.getBoundingClientRect();
    return global.LexSendLater.menu({
      plain: true,
      anchor: o.row,
      lit: o.row,
      align: 'left',
      // A hold or the key of the menu: under the line, at its start.
      at: o.at || { x: r.left + 16, y: r.bottom - 6 },
      head: o.title || '',
      items: items(o),
      onClose: o.onClose,
    });
  }

  // A right click with a mouse; a hold with a finger (the page on a touch screen has no right
  // button). A browser that also sends a right click after a hold does not open the menu twice.
  function attach(row, get) {
    if (!row || typeof get !== 'function') return;
    let finger = false;
    const show = (at) => {
      const o = get();
      if (o) open({ ...o, row, at });
    };
    row.addEventListener('pointerdown', (e) => { finger = e.pointerType === 'touch' || e.pointerType === 'pen'; }, true);
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (finger) return;
      show({ x: e.clientX, y: e.clientY });
    });
    if (global.LexLongPress) {
      global.LexLongPress.attach(row, (e) => show(e && e.clientX != null ? { x: e.clientX, y: e.clientY } : null),
        { when: () => finger });
    }
    row.addEventListener('keydown', (e) => {
      if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
        e.preventDefault();
        show(null);
      }
    });
  }

  // Delete chat asks first; the text says what goes and what stays.
  async function remove(o) {
    const ok = typeof o.confirm === 'function'
      ? await o.confirm('Delete this chat?', o.text || '', { okText: 'Delete', danger: true })
      : false;
    if (ok) await o.act('delete');
    return !!ok;
  }

  global.LexChatMenu = { items, open, attach, remove };
})(typeof self !== 'undefined' ? self : globalThis);
