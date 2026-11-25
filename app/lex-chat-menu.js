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
// read or Mark as unread, Archive or Unarchive where the list has its archive (2026-11-23, chat_archive.sql), Mark as important or Unmark important where a person writes (2026-11-17,
// part 6 of «Уведомления и непрочитанное»: a message there rings an alarm on the iPhone through the
// silent switch; supabase/migrations/important_chats.sql), Mute or Unmute (2026-11-25, chat_read_one.sql), Rename where
// the list has it, Delete chat
// in --danger. Nothing is dimmed;
// the line of the chat stands on --bg-hover while the menu is open. Delete chat asks first (the
// dialog В7.16, the window's own `confirm`).
//
// «Open in new window» (2026-11-23, lex-chat-window.js, В7.79) stands first where the line names the place of
// its chat (`window`) and the surface has windows; the same line opens its window by a Cmd-click (Ctrl-click
// on Windows and Linux) and, in the Mac app and the extension, by dragging it out. A list whose lines have no
// actions of the server (the task chats of an agent) gives only `window`: its menu is that one item.
//
// Gives global.LexChatMenu:
//   items(o)            the items: o = { window, pinned, unread, archived, important, muted, act(name), mute(on),
//                       rename(), remove() }; muted true or false — Unmute or Mute (act 'mute' / 'unmute', or mute(on)
//                       where the line is not a chat: an agent), absent — the server has no Mute yet;
//                       window — the place of the chat (lex-chat-window.js), absent — no window for it;
//                       Pin and Read only with act, Pin not with pinned null (the folder of an agent,
//                       an archived conversation); archived, important true or false — the list has the mark, absent — it has
//                       not; Delete chat only with remove
//   open(o)             the menu: o = { row, title, at: {x, y}, window, pinned, unread, archived, important, act,
//                       rename, remove, layer, onClose }
//   attach(row, get)    a right click, a hold on a touch screen and the key of the menu open it on
//                       this line, a Cmd/Ctrl-click and a drag open its window; get() → o of open() at
//                       the moment of the press, or null
//   remove(o)           asks «Delete this chat?» and acts: o = { confirm, text, act } → Promise<boolean>
(function (global) {
  'use strict';

  function items(o) {
    const out = [];
    const win = o.window && global.LexChatWindow ? global.LexChatWindow.item(o.window) : null;
    if (win) out.push(win);
    const acts = typeof o.act === 'function';
    if (acts) {
      // A list without a pin of its own (the folder of an agent, an archived conversation) gives `pinned: null`.
      if (o.pinned !== null) {
        out.push(o.pinned
          ? { label: 'Unpin', icon: 'pinOff', run: () => o.act('unpin') }
          : { label: 'Pin', icon: 'pin', run: () => o.act('pin') });
      }
      out.push(o.unread
        ? { label: 'Mark as read', icon: 'read', run: () => o.act('read') }
        : { label: 'Mark as unread', icon: 'unread', run: () => o.act('unread') });
      // Archive (chat_archive.sql): right after the read; an archived chat — Unarchive.
      if (typeof o.archived === 'boolean') {
        out.push(o.archived
          ? { label: 'Unarchive', icon: 'unarchive', run: () => o.act('unarchive') }
          : { label: 'Archive', icon: 'archive', run: () => o.act('archive') });
      }
    }
    if (acts && typeof o.important === 'boolean') {
      out.push(o.important
        ? { label: 'Unmark important', icon: 'bellOff', run: () => o.act('unimportant') }
        : { label: 'Mark as important', icon: 'bell', run: () => o.act('important') });
    }
    // Mute (2026-11-25, chat_read_one.sql): the chat's own position Off — no banner, no number, no dot; Unmute gives it
    // back to the levels above (the agent or the folder, then the kind). Any chat whose server says muted or not.
    if (typeof o.muted === 'boolean' && (acts || typeof o.mute === 'function')) {
      const on = !o.muted;
      const run = () => (typeof o.mute === 'function' ? o.mute(on) : o.act(on ? 'mute' : 'unmute'));
      out.push(o.muted ? { label: 'Unmute', icon: 'bell', run } : { label: 'Mute', icon: 'bellOff', run });
    }
    if (typeof o.rename === 'function') out.push({ label: 'Rename', icon: 'pencil', run: () => o.rename() });
    if (typeof o.remove === 'function') out.push({ label: 'Delete chat', icon: 'trash', danger: true, run: () => o.remove() });
    return out;
  }

  function open(o) {
    if (!o || !o.row || !global.LexSendLater) return null;
    const list = items(o);
    if (!list.length) return null;
    const r = o.row.getBoundingClientRect();
    return global.LexSendLater.menu({
      plain: true,
      anchor: o.row,
      lit: o.row,
      align: 'left',
      // A hold or the key of the menu: under the line, at its start.
      at: o.at || { x: r.left + 16, y: r.bottom - 6 },
      head: o.title || '',
      items: list,
      // The windows of the extension stand over the page: the menu goes into their layer.
      layer: o.layer || null,
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
    if (global.LexChatWindow) global.LexChatWindow.wire(row, () => { const o = get(); return (o && o.window) || null; });
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
