// lex-chat-window.js — a chat in a window of its own (ios/Lex/STANDARD.md, В7.79; docs/spec/20-chat.md,
// «Отдельное окно чата»). One part for every list of chats of every surface that has windows: the page
// lex-me.club/app in a browser, the Mac app (the same page in WKWebView) and the extension of Chrome. The
// iPhone has no windows: there the part offers nothing.
//
// As in Claude desktop, Slack, Telegram Desktop and Arc (Gennady, 23.11.2026): any end chat of a list —
// a chat on the main page (All, Clients, a folder), a conversation of the panel (Today, This week…), a
// task chat of an agent — opens in a window of its own by
//   · a Cmd-click on its line (Ctrl-click on Windows and Linux), Cmd/Ctrl+Enter on a line in focus;
//   · «Open in new window», the first item of the menu of the chat (lex-chat-menu.js, В7.33);
//   · dragging the line out of the window, or dropping it in the window away from its list — only where
//     the window opens without the pointer's gesture (the Mac app, the extension): a browser lets a page
//     open a window only right after a press, and a drag can last longer than that.
// A folder, a section (Agents, Calendar, Shopping list…) or an agent itself is not a chat: its lines give
// no place, and nothing of this is offered for them.
//
// The window is the same page in its single mode — a chat only: its head, the feed, the one field; no
// panel, no list, no ☰, no arrow back. It is alive as any chat of the page is: the same messages, the
// same sending, the same signals of the server. The mode is the address of the page:
//   <page>?window=chat&key=<chat key>[&kind=…][&order=…][&folder=…][&agent=…]
// — the place of a chat the way a notification names it (wc-app.js openFromNotification), so the page
// opens it by the same path as a tap on a notification. webchat/index.html marks <html data-lex-window>
// in its head from the same address, so the first frame already has no panel.
//
// How each surface opens a window:
//   Mac app   the word { word: 'window', url, cursor } to the shell (macos/Sources/LexShell/ShellBridge.swift);
//             the shell opens an NSWindow with a WKWebView of the same store of the site (the same sign-in,
//             the same storage); cursor: true — a drag ended there: the window stands under the pointer.
//             Only a shell whose mark says `windows: true` (an older one does not know the word).
//   extension the message LEX_OPEN_CHAT_WINDOW to its worker (background.js): chrome.windows.create, a popup
//             window of the page lex-me.club/app in its single mode.
//   browser   window.open with the size of a chat window; one window per chat (its name), a second open of
//             the same chat brings that window up.
//
// Gives global.LexChatWindow:
//   urlFor(place)           the address of the single mode; place = { chatKey, kind, order, folder, agent }
//   placeOf(search)         the place from an address (location.search by default), or null
//   solo()                  the place this page stands in as a window of a chat, or null
//   can()                   this surface opens windows of chats
//   canDrag()               a line can be dragged out into a window here
//   open(place, at)         open the window; at — { x, y } on the screen (a drag), or nothing
//   item(place)             the item «Open in new window» of the menu of a chat, or null where it cannot
//   wire(row, getPlace)     Cmd/Ctrl-click, Cmd/Ctrl+Enter and the drag on a line of a chat; getPlace()
//                           → the place at the moment of the press, or null (no window for it)
(function (global) {
  'use strict';

  if (global.LexChatWindow) return;

  const MODE = 'chat';
  // The page of the extension's window: the extension has no page of its own for one chat.
  const APP_URL = 'https://lex-me.club/app/';
  // A chat window: about the size of the window of the Mac app (LexConfig.windowSize 460×680), a little taller.
  const SIZE = { width: 480, height: 760 };
  // The fields of a place, in the order of the address; chatKey goes as `key`.
  const FIELDS = [['chatKey', 'key'], ['kind', 'kind'], ['order', 'order'], ['folder', 'folder'], ['agent', 'agent']];
  const DRAG_TYPE = 'application/x-lex-chat';
  // The list a line belongs to — the place of the list on the screen, the box that scrolls it: a drop inside it is
  // not «away from the list». No such box — the list element itself.
  const LISTS = '.lex-section-list, .wc-convs, .wc-home, [role="list"]';
  function listOf(row) {
    for (let el = row.parentElement; el && el !== document.body; el = el.parentElement) {
      const y = getComputedStyle(el).overflowY;
      if ((y === 'auto' || y === 'scroll') && el.clientHeight > row.offsetHeight) return el;
    }
    return row.closest(LISTS) || row.parentElement;
  }

  const shell = () => global.__lexShell || null;
  const inExtension = () => {
    try { return !!(global.chrome && global.chrome.runtime && global.chrome.runtime.id) && !shell(); } catch (_) { return false; }
  };
  const isMac = () => {
    const n = global.navigator || {};
    const p = String((n.userAgentData && n.userAgentData.platform) || n.platform || '');
    return /mac/i.test(p);
  };

  function clean(place) {
    if (!place || typeof place.chatKey !== 'string' || !place.chatKey) return null;
    const out = {};
    for (const [name] of FIELDS) {
      const v = place[name];
      if (v != null && String(v) !== '') out[name] = String(v).slice(0, 200);
    }
    return out;
  }

  function query(place) {
    const p = new URLSearchParams();
    p.set('window', MODE);
    for (const [name, key] of FIELDS) if (place[name]) p.set(key, place[name]);
    return p.toString();
  }

  // The page of this surface: the page itself on the page and in the Mac app, lex-me.club/app in the extension.
  function base() {
    if (inExtension()) return APP_URL;
    const loc = global.location;
    if (!loc || !/^https?:$/.test(loc.protocol)) return APP_URL;
    return loc.origin + loc.pathname;
  }

  function urlFor(place) {
    const p = clean(place);
    return p ? `${base()}?${query(p)}` : null;
  }

  function placeOf(search) {
    let p;
    try { p = new URLSearchParams(search != null ? search : (global.location && global.location.search) || ''); } catch (_) { return null; }
    if (p.get('window') !== MODE) return null;
    const place = {};
    for (const [name, key] of FIELDS) {
      const v = p.get(key);
      if (v) place[name] = v;
    }
    return clean(place);
  }

  let soloPlace;
  function solo() {
    if (soloPlace === undefined) soloPlace = inExtension() ? null : placeOf();
    return soloPlace;
  }

  function can() {
    const s = shell();
    if (s) return s.platform === 'macos' && !!s.windows;
    if (inExtension()) return true;
    if (!global.open) return false;
    // A phone or a tablet in its browser: a new window there is a new tab, not a window beside the chat.
    try {
      return !global.matchMedia || global.matchMedia('(hover: hover) and (pointer: fine)').matches;
    } catch (_) { return true; }
  }
  // A drag opens the window after the press is long over: only where no gesture is asked for it.
  const canDrag = () => {
    const s = shell();
    return s ? s.platform === 'macos' && !!s.windows : inExtension();
  };

  function open(place, at) {
    const url = urlFor(place);
    if (!url || !can()) return false;
    const p = clean(place);
    const s = shell();
    if (s) {
      try {
        global.webkit.messageHandlers.lexshell.postMessage({ word: 'window', url, cursor: !!at });
        return true;
      } catch (_) { return false; }
    }
    // The window's top left a little up and left of the pointer: the line stays under it.
    const left = at ? Math.round(at.x - 60) : null;
    const top = at ? Math.round(at.y - 24) : null;
    if (inExtension()) {
      try {
        global.chrome.runtime.sendMessage({ type: 'LEX_OPEN_CHAT_WINDOW', url, width: SIZE.width, height: SIZE.height, left, top }, () => {
          void global.chrome.runtime.lastError;
        });
        return true;
      } catch (_) { return false; }
    }
    const scr = global.screen || {};
    const x = left != null ? left : Math.round((global.screenX || 0) + Math.max(0, ((global.outerWidth || SIZE.width) - SIZE.width) / 2) + 40);
    const y = top != null ? top : Math.round((global.screenY || 0) + 40);
    const features = `popup=yes,width=${SIZE.width},height=${Math.min(SIZE.height, scr.availHeight || SIZE.height)},left=${x},top=${y}`;
    const name = `lex-chat-${String(p.chatKey).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 80)}`;
    const w = global.open(url, name, features);
    if (w) { try { w.focus(); } catch (_) { /* another origin */ } }
    return !!w;
  }

  function item(place) {
    if (!clean(place) || !can()) return null;
    return { label: 'Open in new window', icon: 'window', run: () => { open(place); } };
  }

  // ── the drag ──────────────────────────────────────────────────────────────────
  // One drag at a time. The document takes it everywhere (dragover with preventDefault), so a drop inside the
  // window is seen and its point is known; a drag that left the window is told by the leave of the document,
  // or by the end point outside the window.
  let drag = null;
  let docWired = false;
  function wireDocument() {
    if (docWired || typeof document === 'undefined') return;
    docWired = true;
    document.addEventListener('dragover', (e) => {
      if (!drag) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'move'; } catch (_) { /* noop */ }
      drag.left = false;
    });
    document.addEventListener('dragleave', (e) => {
      if (!drag || e.relatedTarget) return;
      const w = global.innerWidth || 0;
      const h = global.innerHeight || 0;
      if (e.clientX <= 0 || e.clientY <= 0 || e.clientX >= w || e.clientY >= h) drag.left = true;
    });
    document.addEventListener('drop', (e) => {
      if (!drag) return;
      e.preventDefault();
      drag.dropped = { x: e.clientX, y: e.clientY };
    });
  }
  const insideRect = (r, x, y) => !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  function outsideWindow(e) {
    if (!Number.isFinite(e.screenX) || !Number.isFinite(e.screenY) || (!e.screenX && !e.screenY)) return false;
    const x0 = global.screenX || 0;
    const y0 = global.screenY || 0;
    return e.screenX < x0 || e.screenY < y0 || e.screenX > x0 + (global.outerWidth || 0) || e.screenY > y0 + (global.outerHeight || 0);
  }
  // A point of the page on the screen: the top of the window's frame is not the top of the page, close enough.
  const toScreen = (pt) => ({
    x: (global.screenX || 0) + pt.x,
    y: (global.screenY || 0) + ((global.outerHeight || 0) - (global.innerHeight || 0)) + pt.y,
  });

  function wireDrag(row, getPlace) {
    wireDocument();
    // The part of the line under the press carries the drag (a line of LexSection.row is a button inside a div);
    // WebKit drags an element only with -webkit-user-drag.
    const handle = row.querySelector(':scope > .lex-section-row-main') || row;
    handle.draggable = true;
    try { handle.style.webkitUserDrag = 'element'; } catch (_) { /* not WebKit */ }
    row.addEventListener('dragstart', (e) => {
      const place = clean(getPlace());
      if (!place || !canDrag() || !e.dataTransfer) { e.preventDefault(); return; }
      // Only a type of its own: nothing outside Lex takes the line (the desktop, a text field), so a drop
      // there ends with nothing taken — and that is the window.
      e.dataTransfer.setData(DRAG_TYPE, urlFor(place));
      e.dataTransfer.effectAllowed = 'move';
      const list = listOf(row);
      drag = { place, list, left: false, dropped: null };
      row.classList.add('is-lex-dragged');
    });
    row.addEventListener('dragend', (e) => {
      row.classList.remove('is-lex-dragged');
      const d = drag;
      drag = null;
      if (!d) return;
      if (d.dropped) {
        // Dropped in the window: away from its list it opens, on its list nothing happens.
        const r = d.list && d.list.isConnected ? d.list.getBoundingClientRect() : null;
        if (!insideRect(r, d.dropped.x, d.dropped.y)) open(d.place, toScreen(d.dropped));
        return;
      }
      if (d.left || outsideWindow(e)) open(d.place, { x: e.screenX, y: e.screenY });
    });
  }

  function wire(row, getPlace) {
    if (!row || typeof getPlace !== 'function' || row.__lexChatWindow) return;
    row.__lexChatWindow = true;
    const mod = (e) => (isMac() ? e.metaKey : e.ctrlKey) && !e.altKey && !e.shiftKey;
    // Capture: the press never reaches the line's own click (which would open the chat here).
    row.addEventListener('click', (e) => {
      if (!mod(e) || !can()) return;
      const place = clean(getPlace());
      if (!place) return;
      e.preventDefault();
      e.stopPropagation();
      open(place);
    }, true);
    row.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !mod(e) || !can()) return;
      const place = clean(getPlace());
      if (!place) return;
      e.preventDefault();
      e.stopPropagation();
      open(place);
    }, true);
    if (canDrag()) wireDrag(row, getPlace);
  }

  global.LexChatWindow = { urlFor, placeOf, solo, can, canDrag, open, item, wire, SIZE, MODE };
})(typeof self !== 'undefined' ? self : globalThis);
