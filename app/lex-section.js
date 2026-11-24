// lex-section.js — the frame of a section of Lex, on the page, the Mac app and the extension.
// It draws what every section has: the top bar with the title and the gear, the status line,
// a line of a list with the unread dot and the three dots, the screens inside a section with
// the way back, the watch over the server, the opening of an item. A section gives only what
// is its own: what stands in a line, what lies in the menu, what the head of an open item
// holds, which signals of the server mean «look again». A new section gets the rest by asking
// for a frame. The iPhone has the same frame in SectionFrame.swift. docs/spec/27-sections.md.
//
// No chrome.* and no word about any one section: every window loads this file, and not every
// window has every section.
//
// createFrame takes:
//   title          the name of the section
//   cls            one more class on the root, the section's own styles hang on it
//   back           the arrow of the window, see lex-back.js
//   root()         { title, go } of the screen outside the section the person comes from (the main page of the
//                  people), or null: the arrow of the section's first two screens leads there at once, and the
//                  section's own first screen is no stop on the way: with a root it is never shown, the screen the
//                  section is entered on stands over it
//   tools          buttons of the bar, on the first screen only; a button with an icon is
//                  iconButton(cls + ' lex-section-icon', svg, title, onClick), a zone of 44 (В7.11)
//   gear()         what the gear opens; no gear without it
//   signals,       the channel of the database's signals (lex-account-events.js) and which of
//   events         them mean «look again» for this section; no channel — no watch. The frame
//                  never asks the server on a timer (Gennady, 2026-11-13).
//   check(signal)  the look itself: signal — what came ({ event, payload }), null — a look to
//                  catch up, the channel being open again
//   onBack(id)     the person came back to this screen
(function (global) {
  'use strict';

  // A look that gave no answer for this long counts as failed, and the next one may go.
  const STUCK_MS = 15000;
  // A failed look is tried again after these pauses: something changed and is not on the
  // screen yet. This is no watch for news — it stops at the first good look.
  const AGAIN_MS = [1000, 2000, 5000, 10000, 20000, 30000];

  const GEAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>';
  const DOTS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5h.01M12 12h.01M12 19h.01"/></svg>';
  // The pin of a pinned chat (В7.34), the same drawing as Pin in the menu of a chat (lex-send-later.js).
  const PIN = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="Pinned"><path d="M12 17v5"/><path d="M8 3h8"/><path d="M9 3v7l-3 4h12l-3-4V3"/></svg>';
  // Mute in the card of a person (В7.41): the crossed bell 14 right after the name.
  const MUTED = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="Muted"><path d="M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5"/><path d="M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/><path d="M2 2l20 20"/></svg>';

  function make(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function button(cls, text, onClick) {
    const b = make('button', cls, text);
    b.type = 'button';
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }

  function iconButton(cls, icon, title, onClick) {
    const b = button(cls, null, onClick);
    b.innerHTML = icon;
    b.title = title;
    b.setAttribute('aria-label', title);
    return b;
  }

  function newOpId() {
    if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
  }

  // ── the three dots ──────────────────────────────────────────────────────────
  // The menu stands in the frame, outside the list: a list scrolls and would cut it.
  let closeMenu = null;

  function openMenu(anchor, items, host) {
    const again = closeMenu && closeMenu.anchor === anchor;
    if (closeMenu) closeMenu();
    if (again) return;
    const menu = make('div', 'lex-section-menu');
    menu.setAttribute('role', 'menu');
    // A press on the dots themselves is theirs: it closes the menu by the check above.
    const onPress = (e) => {
      const path = e.composedPath();
      if (!path.includes(menu) && !path.includes(anchor)) close();
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const close = () => {
      closeMenu = null;
      menu.remove();
      document.removeEventListener('pointerdown', onPress, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
    for (const it of items) {
      const item = button('lex-section-menu-item', it.label, () => { close(); it.onSelect(); });
      item.setAttribute('role', 'menuitem');
      menu.appendChild(item);
    }
    host.appendChild(menu);
    const h = host.getBoundingClientRect();
    const a = anchor.getBoundingClientRect();
    const m = menu.getBoundingClientRect();
    // The menu hangs from the right end of the dots. A list has no room below its last line.
    const floor = host.classList.contains('lex-section') ? h.bottom : window.innerHeight;
    const below = a.bottom + 4 + m.height <= floor - 4;
    menu.style.left = `${Math.max(4, a.right - h.left - m.width)}px`;
    menu.style.top = `${Math.max(4, (below ? a.bottom + 4 : a.top - m.height - 4) - h.top)}px`;
    closeMenu = close;
    closeMenu.anchor = anchor;
    document.addEventListener('pointerdown', onPress, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
  }

  // items: [{ label, onSelect }]. host: where the menu stands, the frame when not named. cls — one
  // more class: `lex-section-icon` makes the dots a button of a bar, a zone of 44 (the head of a news).
  function moreButton(items, host, cls) {
    const b = iconButton(`lex-section-more${cls ? ` ${cls}` : ''}`, DOTS, 'More', () => {
      openMenu(b, items, host || b.closest('.lex-section'));
    });
    return b;
  }

  // ── a line of a list ────────────────────────────────────────────────────────
  // What stands in it is the section's: title, sub, mark (a small label at the title), dot
  // (not read yet), strong (bold whatever is read), wrap (the title and the sub take several
  // lines), end (a node at the right end of the sub line), more (the menu of the dots), id and
  // cls (of the main button), onClick. A line of a chat (В7.34) has more: time (at the right end
  // of the title, listTime), pinned (the pin before the time) and bot (the last message is the
  // bot's: «Bot:» before it), and lead — the photo or the letter of the person 48 at the left
  // (LexMessage.avatar, В7.12; New orders — LexMessage.avatarMark), 12 before the words; the dot of
  // the unread then stands left of the photo. Its menu is the menu of a chat (lex-chat-menu.js).
  // unread — what the number of the unread of the line counts (В7.48): { chat: key }, { order: number }
  // or { section: id }; it stands at the right end of the sub line, and with a number the dot does not.
  // draft — the key of the chat of the line: while the chat has a draft (lex-drafts.js) the sub line says
  // «Draft:» in red and its first words, as in Telegram, in place of the last message (draftSub below).
  // lex — what the agent «Кто это» waits for in this chat (В7.54, the mark `whois.wait`: { kind, text }): the sub line
  // says «Lex:» and the headline of the agent's word in place of the last message, as «Draft:» does — «Lex:» in
  // `--attention` when it waits for a word of Gennady (a guess, a question), in `--fg` for an attach done by itself.
  function row(o) {
    const el = make('div', 'lex-section-row');
    el.classList.toggle('is-unread', !!o.dot);
    el.classList.toggle('is-strong', !!o.strong);
    el.classList.toggle('is-wrap', !!o.wrap);
    // subLines: 3 — the title on one line, the sub on up to three (a block of memory of an agent, board AgMemory).
    el.classList.toggle('is-sub3', o.subLines === 3);
    el.classList.toggle('is-chat', o.time != null || !!o.pinned);
    el.classList.toggle('has-lead', !!o.lead);
    el.classList.toggle('is-muted', !!o.muted);
    const main = button(`lex-section-row-main${o.cls ? ` ${o.cls}` : ''}`, null, o.onClick);
    if (o.id != null) main.dataset.id = o.id;
    // With a photo the words go into a block of their own, right of it.
    let words = main;
    if (o.lead) {
      main.appendChild(o.lead);
      words = make('span', 'lex-section-row-words');
      main.appendChild(words);
    }
    const top = make('span', 'lex-section-row-top');
    top.appendChild(make('span', 'lex-section-row-title', o.title));
    if (o.muted) {
      const bell = make('span', 'lex-section-row-muted');
      bell.innerHTML = MUTED;
      top.appendChild(bell);
    }
    if (o.mark) top.appendChild(make('span', 'lex-section-mark', o.mark));
    if (o.pinned) {
      const pin = make('span', 'lex-section-row-pin');
      pin.innerHTML = PIN;
      top.appendChild(pin);
    }
    if (o.time) top.appendChild(make('span', 'lex-section-row-time', o.time));
    words.appendChild(top);
    const sub = () => {
      const n = make('span', 'lex-section-row-sub');
      const lex = o.lex && typeof o.lex === 'object' && String(o.lex.text || '').trim() ? o.lex : null;
      const own = () => (lex
        ? [make('span', `lex-section-row-lex${lex.kind === 'attached' ? '' : ' is-ask'}`, 'Lex:'), ' ', String(lex.text).trim()]
        : [...(o.bot ? [make('span', 'lex-section-row-bot', 'Bot:'), ' '] : []), o.sub || '']);
      if (o.draft) draftSub(n, o.draft, own);
      else n.append(...own());
      return n;
    };
    const num = o.unread ? count(o.unread) : null;
    const hasSub = !!(o.sub || o.draft || (o.lex && o.lex.text));
    if (o.end || (num && hasSub)) {
      const line = make('span', 'lex-section-row-subline');
      line.appendChild(sub());
      if (o.end) line.appendChild(o.end);
      if (num) line.appendChild(num);
      words.appendChild(line);
    } else {
      if (hasSub) words.appendChild(sub());
      if (num) top.appendChild(num);
    }
    el.appendChild(main);
    if (o.more && o.more.length) el.appendChild(moreButton(o.more));
    if (num) { el.dataset.unreadHost = ''; paintCount(num); }
    return el;
  }

  // ── the number of the unread (В7.48) ─────────────────────────────────────────
  // The same count on every surface and on the icon of the iPhone (supabase/migrations/unread_counts.sql):
  // how many messages of a chat, or how many chats of a section, are not seen yet. The page holds the
  // server's last answer here (setUnread: from lex_missed_summary, from the answer of lex_chat_presence, at
  // the signal «unread»). Every number on the page is a slot that names what it counts, and a new answer
  // repaints them all in place: no list has to be drawn again for it. The host of a slot (an element with
  // data-unread-host — a line, a chat of the list Chats, a button of a section) gets the class has-count.
  let unreadNow = { chats: {}, orders: {}, sections: {} };
  function unreadOf(what) {
    if (!what) return 0;
    const n = what.chat != null ? unreadNow.chats[what.chat]
      : what.order != null ? unreadNow.orders[what.order]
        : what.section != null ? unreadNow.sections[what.section] : 0;
    return Number(n) > 0 ? Math.floor(Number(n)) : 0;
  }
  // A number stands only in the lines of people (a client or a person wrote and Gennady has not answered: what.number);
  // everywhere else — agents, sections, chats of Lex — the same slot is the yellow dot, no digits. A line with a dot
  // (host class has-dot) shows it at its left, the entry of a section at its right.
  function paintCount(slot) {
    const d = slot.dataset;
    const n = unreadOf(d.unreadChat != null ? { chat: d.unreadChat }
      : d.unreadOrder != null ? { order: d.unreadOrder } : { section: d.unreadSection });
    const dot = d.dot != null;
    slot.textContent = dot ? '' : (n > 99 ? '99+' : String(n));
    slot.hidden = !n;
    slot.setAttribute('aria-label', dot ? 'Unread' : `${n} unread`);
    const host = slot.closest('[data-unread-host]');
    if (host) host.classList.toggle(dot ? 'has-dot' : 'has-count', !!n);
  }
  function count(what) {
    const slot = make('span', what.number ? 'lex-section-count' : 'lex-section-count is-dot');
    if (!what.number) slot.dataset.dot = '';
    if (what.chat != null) slot.dataset.unreadChat = String(what.chat);
    else if (what.order != null) slot.dataset.unreadOrder = String(what.order);
    else slot.dataset.unreadSection = String(what.section || '');
    paintCount(slot);
    return slot;
  }
  // The chats marked important (2026-11-17, part 6, important_chats.sql) come with the numbers: a message a
  // person wrote there rings an alarm on the iPhone. An answer of a server before part 6 has no list: the
  // marks known stay.
  let importantNow = new Set();
  function setUnread(u) {
    if (!u || typeof u !== 'object') return;
    unreadNow = { chats: u.chats || {}, orders: u.orders || {}, sections: u.sections || {} };
    if (Array.isArray(u.important)) importantNow = new Set(u.important.map(String));
    // Only the slots of the unread.
    const slots = '.lex-section-count[data-unread-chat], .lex-section-count[data-unread-order], '
      + '.lex-section-count[data-unread-section]';
    if (typeof document !== 'undefined') document.querySelectorAll(slots).forEach(paintCount);
  }
  const unread = () => unreadNow;
  const isImportant = (chatKey) => chatKey != null && importantNow.has(String(chatKey));
  // A press of «Mark as important» shows at once; the next answer of the numbers confirms or puts it back.
  function markImportant(chatKey, on) {
    if (chatKey == null) return;
    if (on) importantNow.add(String(chatKey)); else importantNow.delete(String(chatKey));
  }

  // ── the draft of a chat in a list (2026-11-17) ──────────────────────────────
  // A chat with words typed and not sent shows «Draft: <the first words>» under its title, as in
  // Telegram: «Draft:» in the red of errors, the words in the grey of the sub line. Every list of chats
  // of the page — Chats and the lists of the sections — has the same slot; the window says what the drafts are
  // (setDrafts(line): line(key) → the words or null, LexDrafts.line) and repaints the slots in place
  // when one changes (paintDrafts): no list is drawn again for it.
  //   draftSub(slot, key, own)  the slot of a sub line: the draft while there is one, own() when not
  //   draft(key)                a slot of its own (the list Chats has no sub line): hidden with no draft
  let draftOf = () => null;
  function paintDraft(slot) {
    const words = slot.dataset.draftChat ? draftOf(slot.dataset.draftChat) : null;
    slot.classList.toggle('is-draft', !!words);
    if (words) slot.replaceChildren(make('span', 'lex-draft-word', 'Draft:'), ' ', make('span', 'lex-draft-words', words));
    else slot.replaceChildren(...(slot._own ? slot._own() : []));
    if (slot._bare) slot.hidden = !words;
  }
  function draftSub(slot, key, own) {
    slot.dataset.draftChat = String(key);
    slot._own = own;
    paintDraft(slot);
    return slot;
  }
  function draft(key) {
    const slot = make('span', 'lex-draft');
    slot._bare = true;
    return draftSub(slot, key, null);
  }
  function setDrafts(line) {
    draftOf = typeof line === 'function' ? (key) => { try { return line(key); } catch (_) { return null; } } : () => null;
    paintDrafts();
  }
  function paintDrafts(keys) {
    if (typeof document === 'undefined') return;
    const only = Array.isArray(keys) ? new Set(keys.map(String)) : null;
    document.querySelectorAll('[data-draft-chat]').forEach((slot) => {
      if (!only || only.has(slot.dataset.draftChat)) paintDraft(slot);
    });
  }

  // The time of a line of a chat (В7.34), the device's day: today — the hour, yesterday — «Вчера»,
  // this year — the day and the month, before — the date.
  function listTime(at, now) {
    const d = at instanceof Date ? at : new Date(at);
    if (!at || Number.isNaN(d.getTime())) return '';
    const n = now ? new Date(now) : new Date();
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const pad = (x) => String(x).padStart(2, '0');
    const days = Math.round((day(n) - day(d)) / 86400000);
    if (days <= 0) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (days === 1) return 'Вчера';
    if (d.getFullYear() === n.getFullYear()) {
      return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' }).format(d);
    }
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
  }

  const markRead = (rowEl) => rowEl.classList.remove('is-unread');

  // ── items held and read ahead ───────────────────────────────────────────────
  // A press shows an item at once from what the window already holds: what the section read
  // of it the last time, or read ahead while its line was on the screen. The section asks the
  // server right after the press, and the fresh answer takes the place of the held one.
  // This holding lives as long as the window; the device keeps its own copy of every answer
  // (lex-reads.js), and after a restart a press takes that. docs/spec/27-sections.md.
  //
  // keep({ load, limit }):
  //   load(id, held)  the section's reading of one item; held — what is held of it now, so a
  //                   section can read only what changed since (a feed of Extended Mind)
  //   limit           how many items are held; the one used longest ago goes first
  // .get(id)          what is held, or null
  // .put(id, v, s)    hold v under the stamp s (the line's look: when it changes, the line is
  //                   read again); null lets the item go
  // .ahead(id, s)     read the item unless it is held under this stamp already
  // .watch(el, id, s) read it ahead once its line el comes on the screen
  // .unwatch()        the lines watched so far are gone (a list painted anew)
  const AHEAD_AT_ONCE = 2;
  const HELD = 80;

  function keep(opts) {
    const limit = opts.limit || HELD;
    const items = new Map();    // id → { value, stamp }, the one used last at the end
    const waiting = new Map();  // id → stamp, the ones to read, in the order they came
    const busy = new Map();     // id → stamp, the ones being read now
    const again = new Map();    // id → stamp, asked again while being read: once more after it
    const lines = new WeakMap();
    let reading = 0;
    let observer = null;

    function hold(id, entry) {
      items.delete(id);
      items.set(id, entry);
      while (items.size > limit) items.delete(items.keys().next().value);
    }
    const isHeld = (id, stamp) => stamp != null && items.has(id) && items.get(id).stamp === stamp;

    function get(id) {
      const e = items.get(id);
      if (!e) return null;
      hold(id, e);
      return e.value;
    }
    function put(id, value, stamp) {
      if (value == null) { items.delete(id); return; }
      const old = items.get(id);
      hold(id, { value, stamp: stamp !== undefined ? stamp : (old ? old.stamp : null) });
    }

    function pump() {
      while (reading < AHEAD_AT_ONCE && waiting.size) {
        const [id, stamp] = waiting.entries().next().value;
        waiting.delete(id);
        if (isHeld(id, stamp)) continue;
        reading += 1;
        busy.set(id, stamp);
        const old = items.get(id);
        // What the window put meanwhile (the press brought a fresher answer) stays: a reading
        // that began before it is older than it.
        Promise.resolve()
          .then(() => opts.load(id, old ? old.value : null))
          .then((v) => { if (v != null && items.get(id) === old) put(id, v, stamp); })
          .catch((e) => console.warn('[section] read ahead:', e && e.message))
          .finally(() => {
            reading -= 1;
            busy.delete(id);
            if (again.has(id)) {
              const more = again.get(id);
              again.delete(id);
              waiting.delete(id);
              waiting.set(id, more);
            }
            pump();
          });
      }
    }
    function ahead(id, stamp) {
      if (id == null || isHeld(id, stamp)) return;
      if (busy.has(id)) {
        // Being read under this look: once is enough. Under another, or asked to read again:
        // once more after this reading, however many times it is asked meanwhile.
        if (stamp != null && busy.get(id) === stamp) return;
        again.set(id, stamp);
        return;
      }
      waiting.delete(id);
      waiting.set(id, stamp);
      pump();
    }

    function watch(el, id, stamp) {
      if (!el || id == null) return;
      if (typeof IntersectionObserver === 'undefined') { ahead(id, stamp); return; }
      if (!observer) {
        observer = new IntersectionObserver((entries) => {
          for (const en of entries) {
            if (!en.isIntersecting) continue;
            observer.unobserve(en.target);
            const line = lines.get(en.target);
            if (line) ahead(line.id, line.stamp);
          }
        });
      }
      lines.set(el, { id, stamp });
      observer.observe(el);
    }
    function unwatch() {
      if (observer) observer.disconnect();
    }

    return { get, put, ahead, watch, unwatch, forget: (id) => items.delete(id) };
  }

  // ── the frame ───────────────────────────────────────────────────────────────
  function createFrame(opts) {
    const root = make('section', `lex-section${opts.cls ? ` ${opts.cls}` : ''}`);
    const bar = make('header', 'lex-section-bar');
    const titleEl = make('div', 'lex-section-title', opts.title);
    const tools = make('div', 'lex-section-tools');
    tools.append(...(opts.tools || []));
    // The gear is a button with an icon of the bar, a zone of 44 (В7.11), as every tool of the bar.
    if (opts.gear) tools.appendChild(iconButton('lex-section-gear lex-section-icon', GEAR, 'Settings', opts.gear));
    // The centred head of a screen (В7.18, 22.11.2026, board AgF2HeadA): a slot 108 on each side, in the middle a button
    // 44 — the name 16/650 with a chevron 16 when it opens something, under it a line 13 (`--attention` when it waits);
    // on the right the second button 44 (В7.7) with a mark 20 and a word. The arrow back stays where it is on the page
    // (the bar of the window, lex-back.js): the left slot only keeps the name in the middle.
    const center = make('div', 'lex-section-center');
    center.hidden = true;
    bar.append(titleEl, tools, center);
    const status = make('div', 'lex-section-status');
    status.setAttribute('role', 'status');
    status.hidden = true;
    const first = { id: 'home', title: opts.title, body: make('div', 'lex-section-body'), top: 0, head: opts.head || null };
    root.append(bar, status, first.body);
    const stack = [first];
    // A section entered from outside (opts.root) is never on its first screen: it stays under the others, hidden, and the
    // arrow does not stop there (paintScreen).
    const stays = (screen) => !!opts.root && screen === first;
    first.body.hidden = stays(first);
    const top = () => stack[stack.length - 1];
    const isShown = () => root.isConnected && !root.closest('[hidden]');

    // What the section says. The watch says nothing here: a lost connection is no red line (Gennady, 20.11.2026).
    let said = [''];
    function paintStatus() {
      const [text, isError, isBusy] = said;
      status.textContent = text || '';
      status.hidden = !text;
      status.classList.toggle('is-error', !!isError);
      status.classList.toggle('is-busy', !!text && !isError && !!isBusy);
    }
    function say(text, isError, isBusy) {
      said = [text, isError, isBusy];
      paintStatus();
    }

    // The arrow of the window leads from a screen inside the section to the one under it; from the first two
    // screens of a section entered from outside (opts.root) — out of the section, the screens starting over.
    let headPainted = false;
    let headSides = null;   // the watch of the second button's width (both slots grow to it, the name stays centred)
    function paintHead(h) {
      if (headSides) { headSides.disconnect(); headSides = null; }
      bar.classList.toggle('is-center', !!h);
      center.hidden = !h;
      titleEl.hidden = !!h;
      if (!h) { if (headPainted) { center.replaceChildren(); headPainted = false; } return; }
      headPainted = true;
      const name = make('span', 'lex-section-head-name', h.title || top().title || '');
      const line = make('span', 'lex-section-head-line');
      line.appendChild(name);
      if (h.onTitle) line.appendChild(markSvg(['M9 6l6 6-6 6'], 16, 2));
      const mid = make(h.onTitle ? 'button' : 'div', 'lex-section-head');
      mid.appendChild(line);
      if (h.sub) mid.appendChild(make('span', `lex-section-head-sub${h.subTone === 'attention' ? ' is-attention' : ''}`, h.sub));
      if (h.onTitle) {
        mid.type = 'button';
        mid.setAttribute('aria-label', h.titleLabel || `${h.title || ''}: settings`);
        mid.addEventListener('click', h.onTitle);
      }
      const right = make('div', 'lex-section-slot is-right');
      const a = h.action;
      if (a && global.LexMessage && global.LexMessage.button) {
        const b = global.LexMessage.button({ label: a.label, icon: a.icon ? markSvg(a.icon, 20, 2) : null });
        b.classList.add('lex-section-head-action');
        if (a.ariaLabel) b.setAttribute('aria-label', a.ariaLabel);
        b.addEventListener('click', a.onClick);
        right.appendChild(b);
      }
      const left = make('div', 'lex-section-slot');
      // The left slot keeps one icon button of 44 (h.lead): the order of the list (В7.73). The arrow back is the window's.
      if (h.lead) { left.appendChild(h.lead); left.classList.add('has-lead'); }
      center.replaceChildren(left, mid, right);
      // The second button shows its word whole: when it is wider than 108, both slots take its width, so the name
      // stays in the middle and is the one to give way (its lines cut themselves).
      const btn = right.firstChild;
      if (btn && typeof global.ResizeObserver === 'function') {
        headSides = new global.ResizeObserver(() => {
          const w = `${Math.max(108, Math.ceil(btn.getBoundingClientRect().width))}px`;
          left.style.flexBasis = w;
          right.style.flexBasis = w;
        });
        headSides.observe(btn);
      }
    }
    function paintScreen() {
      titleEl.textContent = top().title;
      paintHead(top().head);
      tools.hidden = stack.length > 1 || !!top().head;
      root.classList.toggle('is-inner', stack.length > 1);
      if (!opts.back) return;
      const out = opts.root ? opts.root() : null;
      if (stack.length > 2 || (stack.length === 2 && !out)) opts.back.cameFrom({ title: stack[stack.length - 2].title, go: pop });
      else if (out) opts.back.cameFrom({ title: out.title, go: () => { reset(); return out.go(); } });
      else opts.back.clear();
    }

    // Every screen over the first is taken off, at once: the section is entered afresh.
    function reset() {
      if (stack.length < 2) return;
      while (stack.length > 1) stack.pop().body.remove();
      const to = top();
      to.body.hidden = stays(to);
      to.body.scrollTop = to.top;
      say('');
      paintScreen();
    }

    // A screen over the current one. Everything under it stays alive, at its place.
    function push(screen) {
      const from = top();
      from.top = from.body.scrollTop;
      from.body.hidden = true;
      const body = make('div', 'lex-section-body');
      root.appendChild(body);
      stack.push({ id: screen.id, title: screen.title, body, head: screen.head || null });
      say('');
      paintScreen();
      return body;
    }

    function pop() {
      if (stack.length < 2) return undefined;
      stack.pop().body.remove();
      const to = top();
      to.body.hidden = stays(to);
      to.body.scrollTop = to.top;
      say('');
      paintScreen();
      return opts.onBack ? opts.onBack(to.id) : undefined;
    }

    // The watch follows the signals of the server: a signal of this section — a look. The
    // channel opens again after a break — one look, to catch up. A failed look is tried again
    // after a pause until one goes, and says nothing — no line, no toast (Gennady, 20.11.2026):
    // the screen keeps what it has, and the bot's alert tells what is broken. Looks never pile
    // up: what comes during one makes one more after it (lex-account-events.js, follow).
    let follower = null;
    let fails = 0;
    let againTimer = null;
    let looking = 0;
    function failed(e) {
      console.warn(`[section] ${opts.title}:`, e && e.message);
      fails += 1;
      if (againTimer || !follower) return;
      const pause = AGAIN_MS[Math.min(fails - 1, AGAIN_MS.length - 1)];
      againTimer = setTimeout(() => { againTimer = null; if (follower) follower.now(); }, pause);
    }
    async function look(signal) {
      const mine = Date.now();
      looking = mine;
      let stuck = null;
      try {
        await Promise.race([
          opts.check(signal),
          new Promise((_, no) => { stuck = setTimeout(() => no(new Error('no answer')), STUCK_MS); }),
        ]);
        if (looking !== mine) return;
        fails = 0;
        if (againTimer) { clearTimeout(againTimer); againTimer = null; }
      } catch (e) {
        if (looking === mine) failed(e);
      } finally {
        clearTimeout(stuck);
        if (looking === mine) looking = 0;
      }
    }

    // A press on an item. run(wanted) is the section's: wanted() turns false when the person
    // went elsewhere meanwhile, and then nothing moves. What failed goes to the status line, or
    // to onFail(text) when the item is opened from a screen that is not this section's (the tabs of the people).
    let opening = 0;
    async function open(run, failText, onFail) {
      opening += 1;
      const mine = opening;
      const wanted = () => opening === mine;
      try {
        await run(wanted);
      } catch (e) {
        if (!wanted()) return;
        const text = `${failText} ${(e && e.message) || ''}`.trim();
        if (onFail) onFail(text); else say(text, true);
      }
    }

    return {
      el: root,
      say,
      push,
      pop,
      reset,
      open,
      isShown,
      get screen() { return top().id; },
      // The head of the screen on top: { title, sub, subTone: 'attention' | 'muted', onTitle, titleLabel,
      // action: { icon: [paths], label, ariaLabel, onClick }, lead: an icon button of 44 in the left slot (orderButton) }
      // — the centred head (В7.18); null — the title on the left.
      setHead(head) { top().head = head || null; paintScreen(); },
      get body() { return top().body; },
      // The section came on screen: the arrow stands as its screen needs it.
      enter: paintScreen,
      stopOpening() { opening += 1; },
      watch() {
        if (follower || !opts.check || !opts.signals) return;
        follower = opts.signals.follow(opts.events || [], look, {});
      },
      unwatch() {
        if (follower) follower.stop();
        follower = null;
        if (againTimer) { clearTimeout(againTimer); againTimer = null; }
        looking = 0;
        fails = 0;
      },
      // A look now, as after a signal: the section knows something changed by itself.
      lookNow() { if (follower) follower.now(); },
    };
  }

  // ══ The parts of the sections of 21.11.2026 (ios/Lex/STANDARD.md, В7.56–В7.63) ══════════════════════════════
  // One drawing for every section that shows agents, settings, an empty screen or the menu of the sections: the
  // canvas «Новые разделы: одна система», board Parts. The iPhone draws the same parts in ios/Lex/Lex/Parts/
  // (AgentFace.swift, AgentState.swift, SettingRow.swift, NoteMenu.swift, SectionEmpty.swift, SectionEntries.swift,
  // SheetHead.swift) from the same marks: dev-tools/test-ios-standard.mjs compares them path by path.

  // The marks, viewBox 24, drawn by a line: one list of paths per mark. A circle and a rounded rectangle of the
  // board are written as paths, so the iPhone parses the very same strings (LexSVGPath).
  const MARKS = {
    agent: {
      'instruction-editor': ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z'],
      'english-teacher': ['M2 5h6a4 4 0 0 1 4 4v11a3 3 0 0 0-3-3H2z', 'M22 5h-6a4 4 0 0 0-4 4v11a3 3 0 0 1 3-3h7z'],
      'correspondence-assistant': ['M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z'],
      morning: ['M8 12a4 4 0 1 0 8 0a4 4 0 1 0 -8 0', 'M12 2v2', 'M12 20v2', 'M4.9 4.9l1.4 1.4', 'M17.7 17.7l1.4 1.4', 'M2 12h2', 'M20 12h2', 'M4.9 19.1l1.4-1.4', 'M17.7 6.3l1.4-1.4'],
      whois: ['M6 8a4 4 0 1 0 8 0a4 4 0 1 0 -8 0', 'M2 21c.8-4 4-6 8-6 1.2 0 2.3.2 3.3.5', 'M17 12.5a2 2 0 1 1 2.7 1.9c-.5.2-.7.6-.7 1.1v.5', 'M19 19.5h.01'],
      deals: ['M4.5 4h2a1.5 1.5 0 0 1 1.5 1.5v13a1.5 1.5 0 0 1 -1.5 1.5h-2a1.5 1.5 0 0 1 -1.5 -1.5v-13a1.5 1.5 0 0 1 1.5 -1.5z', 'M11.5 4h2a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1 -1.5 1.5h-2a1.5 1.5 0 0 1 -1.5 -1.5v-7a1.5 1.5 0 0 1 1.5 -1.5z', 'M18.5 4h1a1.5 1.5 0 0 1 1.5 1.5v10a1.5 1.5 0 0 1 -1.5 1.5h-1a1.5 1.5 0 0 1 -1.5 -1.5v-10a1.5 1.5 0 0 1 1.5 -1.5z'],
      'call-stitch': ['M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7', 'M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7'],
      'call-summary': ['M6 3h9l4 4v14H6z', 'M14 3v5h5', 'M9 13h7', 'M9 17h5'],
      ideas: ['M9 18h6', 'M10 21h4', 'M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z'],
      // The eleventh agent (21.11.2026), not on the board: a paper clip in the same line.
      attachments: ['M21 11.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9'],
      // The twelfth (22.11.2026, «Профи-маркетолог»), not on the board: a line going up.
      'profi-marketer': ['M3 17l6-6 4 4 8-8', 'M15 7h6v6'],
    },
    // The marks of the buttons of a head (В7.18): Activity — a clock (board AgF2HeadA); the order of a list (В7.73) —
    // three lines, each shorter than the one above.
    tool: {
      activity: ['M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0', 'M12 7v5l3 2'],
      order: ['M4 7h16', 'M7 12h10', 'M10 17h4'],
    },
    section: {
      agents: ['M7 8h10a3 3 0 0 1 3 3v6a3 3 0 0 1 -3 3h-10a3 3 0 0 1 -3 -3v-6a3 3 0 0 1 3 -3z', 'M12 4v4', 'M11 3a1 1 0 1 0 2 0a1 1 0 1 0 -2 0', 'M9 13v2', 'M15 13v2'],
      calendar: ['M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2z', 'M3 10h18', 'M8 3v4', 'M16 3v4'],
      shopping: ['M3 4h2l2.4 11h10.2L20 7H6.2', 'M7.5 19a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0', 'M15.5 19a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0'],
      questions: ['M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0', 'M9.6 9.2a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.4v.6', 'M12 16.8h.01'],
      em: ['M12 4a3 3 0 0 0-5.6 1.2A3 3 0 0 0 4 10a3 3 0 0 0 .8 5.2A3.2 3.2 0 0 0 12 17z', 'M12 4a3 3 0 0 1 5.6 1.2A3 3 0 0 1 20 10a3 3 0 0 1-.8 5.2A3.2 3.2 0 0 1 12 17z', 'M12 4v16'],
      news: ['M5 5h11v14H6a2 2 0 0 1-2-2V6a1 1 0 0 1 1-1z', 'M16 9h3a1 1 0 0 1 1 1v7a2 2 0 0 1-4 0', 'M8 9h4', 'M8 13h4'],
      // The archive of a list (2026-11-23, chat_archive.sql): a box with its lid — the face of the row «Archived».
      archive: ['M3 4h18v4H3z', 'M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8', 'M10 12h4'],
    },
  };
  const SVG_NS = 'http://www.w3.org/2000/svg';
  // A mark as an svg node: the paths, a line of `stroke` in the colour of the text around it.
  function markSvg(paths, size, stroke) {
    const n = document.createElementNS(SVG_NS, 'svg');
    n.setAttribute('viewBox', '0 0 24 24');
    n.setAttribute('width', String(size));
    n.setAttribute('height', String(size));
    n.setAttribute('fill', 'none');
    n.setAttribute('stroke', 'currentColor');
    n.setAttribute('stroke-width', String(stroke));
    n.setAttribute('stroke-linecap', 'round');
    n.setAttribute('stroke-linejoin', 'round');
    n.setAttribute('aria-hidden', 'true');
    n.setAttribute('class', 'lex-mark');
    for (const d of paths) {
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', d);
      n.appendChild(p);
    }
    return n;
  }
  const sectionMark = (id, size) => markSvg(MARKS.section[id] || MARKS.section.agents, size || 20, 2);

  // ── В7.56 the face of an agent ──────────────────────────────────────────────
  // A square with rounded corners, the mark of the agent by a line in the middle, half of the side. Sizes 40, 48, 96
  // (radius 10, 12, 18). People are circles (В7.12), agents and services are squares. The bot of Profi.ru has the mark
  // of Profi.ru (LexMessage.channel); an agent without a mark of its own — the mark of the section Agents.
  // o: { size: 40 | 48 | 96, name (what a reader of the screen hears), quiet (on a ground of --bg-raised — a menu, a
  // banner — and in the empty state: the face lies on the hover wash, the mark in grey) }.
  const FACE_SIZES = [40, 48, 96];
  function agentFace(key, o) {
    o = o || {};
    const size = FACE_SIZES.includes(o.size) ? o.size : 48;
    const n = make('span', `lex-face is-${size}${o.quiet ? ' is-quiet' : ''}`);
    if (o.name) { n.setAttribute('role', 'img'); n.setAttribute('aria-label', o.name); } else n.setAttribute('aria-hidden', 'true');
    if (key === 'profi-bot' && global.LexMessage && global.LexMessage.channel) {
      const m = global.LexMessage.channel('profi');
      m.setAttribute('width', String(size));
      m.setAttribute('height', String(size));
      n.classList.add('is-service');
      n.appendChild(m);
      return n;
    }
    n.appendChild(markSvg(MARKS.agent[key] || MARKS.section.agents, size / 2, 1.8));
    return n;
  }
  // The face of a section: the empty state and anything that stands for a whole section.
  function sectionFace(id, o) {
    const n = make('span', `lex-face is-${(o && o.size) || 48} is-quiet`);
    n.setAttribute('aria-hidden', 'true');
    n.appendChild(markSvg(MARKS.section[id] || MARKS.section.agents, ((o && o.size) || 48) / 2, 1.8));
    return n;
  }

  // ── В7.63 the live line of a stage ──────────────────────────────────────────
  // The words of the five stages of a running agent (stage of /folders/agents/chats): what the list says after the
  // spinner and what the last line of a chat says while the agent works.
  const STAGES = {
    taken: 'Taking the task…',
    gathering: 'Reading the journal…',
    thinking: 'Thinking…',
    acting: 'Doing it…',
    writing: 'Writing the answer…',
  };
  const stageWords = (stage) => STAGES[stage] || 'Working…';
  function spinner(size) {
    const n = make('span', `lex-spin is-${size === 14 ? 14 : 12}`);
    n.setAttribute('aria-hidden', 'true');
    return n;
  }
  // The last line of the feed of a chat while its agent works: the spinner 14 and the stage 13. Nothing under the
  // message box. o: { stage } or { text }. .set(o) changes the words in place.
  function liveStage(o) {
    const n = make('div', 'lex-live-stage');
    n.setAttribute('role', 'status');
    const words = make('span', 'lex-live-stage-words');
    n.append(spinner(14), words);
    n.set = (x) => { words.textContent = x && x.text ? String(x.text) : stageWords(x && x.stage); };
    n.set(o);
    return n;
  }

  // ── В7.57 the state line of an agent ────────────────────────────────────────
  // The second line of a line of the list (В7.34), 14: the word of the state is always written, the colour is never
  // the only sign. o: { state: waiting | working | idle | paused | failed, text (the question of the agent, the last
  // thing it did — in Russian, as the server or the section put it), stage (working), reason (failed) }.
  function agentState(o) {
    o = o || {};
    const n = make('span', `lex-astate is-${o.state || 'idle'}`);
    const word = (cls, w) => make('span', `lex-astate-word ${cls}`, w);
    if (o.state === 'waiting') n.append(word('is-wait', 'Waiting for you:'), ' ', String(o.text || ''));
    else if (o.state === 'working') n.append(spinner(12), make('span', 'lex-astate-stage', o.text ? String(o.text) : stageWords(o.stage)));
    else if (o.state === 'paused') n.append(word('is-paused', 'Paused'));
    else if (o.state === 'failed') n.append(word('is-failed', 'Failed:'), ' ', String(o.reason || o.text || ''));
    else n.append(String(o.text || ''));
    return n;
  }
  // A line of the list of agents: the face 48, the name, the time, the state line (the word «Waiting for you:» is the
  // state's), the yellow dot and the bold name while a chat of the agent is unread (24.11.2026: the dot is the unread's
  // alone, a chat that waits and is read has none); a paused agent is dimmed as a whole. o: { key, name, time, state,
  // text, stage, reason, unread (number of the chats unread), onClick, more, id }.
  function agentRow(o) {
    const el = row({
      id: o.id != null ? o.id : o.key,
      lead: agentFace(o.key, { size: 48 }),
      title: o.name || o.key,
      time: o.time || '',
      sub: agentState(o),
      dot: o.unread > 0,
      more: o.more,
      onClick: o.onClick,
      cls: 'lex-agent-row',
    });
    el.classList.toggle('is-paused', o.state === 'paused');
    return el;
  }

  // ── В7.58 the label of a group in a list ────────────────────────────────────
  // «Waiting for you · 4», «Working · 1», «Closed»: 13/600 in grey, 16 over it and 6 under it.
  function groupLabel(text, n) {
    return make('div', 'lex-group-label', n != null ? `${text} · ${n}` : String(text));
  }

  // ── В7.73 the order of a list ───────────────────────────────────────────────
  // An icon button of 44 with the mark `tool.order` in the left slot of the centred head (В7.18): a press opens the
  // menu Group by · Sort by (LexListOrder.menuItems, drawn by the window's menu В7.8). A choice other than the default
  // shows the button pressed (`is-on`), so the person sees the list is not in its usual order.
  // o: { prefs, onClick(anchor) }; the button answers `set(prefs)`.
  function orderButton(o) {
    const b = button('lex-section-icon lex-list-sort', null, () => o.onClick(b));
    b.appendChild(markSvg(MARKS.tool.order, 20, 2));
    b.set = (prefs) => {
      const L = global.LexListOrder;
      const label = L ? L.label(prefs) : 'Group and sort';
      b.title = label;
      b.setAttribute('aria-label', label);
      b.setAttribute('aria-haspopup', 'menu');
      b.classList.toggle('is-on', !!L && !L.isDefault(prefs));
    };
    b.set(o.prefs);
    return b;
  }

  // ── the switch (В7.59) ──────────────────────────────────────────────────────
  // 52 × 32 in a zone of 44: on — the track of the main colour and the knob of the background at the right. The native
  // checkbox stays under it: it brings the role, the focus, the space bar and the state for a reader of the screen.
  function toggle(on, onChange, label) {
    const input = make('input');
    input.type = 'checkbox';
    input.checked = !!on;
    input.setAttribute('role', 'switch');
    if (label) input.setAttribute('aria-label', label);
    input.addEventListener('change', () => onChange(input.checked, input));
    const track = make('span', 'lex-switch-track');
    track.appendChild(make('span', 'lex-switch-knob'));
    // A span, not a label: the input covers the whole box, and a row that is a label itself may hold it.
    const box = make('span', 'lex-switch');
    box.append(input, track);
    box.input = input;
    return box;
  }

  // ── В7.59 the row of a setting ──────────────────────────────────────────────
  // In a block of settings (settingsBlock): the title 17 and under it the note 13 (two lines at most) at the left, one
  // value at the right — one of three:
  //   menu:   { value, tone, onOpen(anchor) } — the words of the choice 15 and the up-down mark; the press opens the menu
  //           with notes (WcUI.menu with `note` items, В7.60) at the button. `tone` colours the words: 'attention' (the
  //           yellow: a choice that asks for care, «Alarm» of the notifications), 'faint' (a choice that turns a thing
  //           off, «Off»); none — the soft grey
  //   toggle: { on, onChange(on) } — the switch 52 × 32
  //   go:     { value, onClick() } — a way inside Lex: the words 15 and the chevron; the whole row is the button
  // o: { title, note, menu | toggle | go, id }.
  const UPDOWN = ['M8 9l4-4 4 4', 'M8 15l4 4 4-4'];
  const CHEVRON = ['M9 6l6 6-6 6'];
  function settingRow(o) {
    const words = make('span', 'lex-setting-words');
    words.appendChild(make('span', 'lex-setting-title', o.title));
    if (o.note) words.appendChild(make('span', 'lex-setting-note', o.note));
    let el;
    if (o.go) {
      el = button('lex-setting is-go', null, () => o.go.onClick && o.go.onClick());
      const val = make('span', 'lex-setting-value');
      if (o.go.value != null) val.appendChild(make('span', 'lex-setting-value-words', String(o.go.value)));
      val.appendChild(markSvg(CHEVRON, 16, 2));
      el.append(words, val);
    } else {
      el = make('div', 'lex-setting');
      el.appendChild(words);
      if (o.menu) {
        const b = button('lex-setting-menu', null, () => o.menu.onOpen && o.menu.onOpen(b));
        b.setAttribute('aria-haspopup', 'menu');
        b.setAttribute('aria-label', `${o.title}: ${o.menu.value}`);
        b.append(make('span', 'lex-setting-value-words', String(o.menu.value || '')), markSvg(UPDOWN, 16, 2));
        const tone = (t) => {
          b.classList.toggle('is-attention', t === 'attention');
          b.classList.toggle('is-faint', t === 'faint');
        };
        tone(o.menu.tone);
        el.appendChild(b);
        el.setValue = (v, t) => {
          b.firstChild.textContent = String(v || '');
          b.setAttribute('aria-label', `${o.title}: ${v}`);
          tone(t);
        };
      } else if (o.toggle) {
        const sw = toggle(o.toggle.on, (on, input) => o.toggle.onChange && o.toggle.onChange(on, input), o.title);
        el.appendChild(sw);
        el.input = sw.input;
      }
    }
    if (o.id) el.dataset.setting = o.id;
    return el;
  }
  // The block around rows of settings: the ground of a card (--lex-section-bubble), radius 10, a line between rows.
  function settingsBlock(rows) {
    const n = make('div', 'lex-settings-block');
    for (const r of rows || []) if (r) n.appendChild(r);
    return n;
  }

  // ── В7.59 the block «About» (22.11.2026, board AgPassport) ─────────────────────
  // What a thing is, read only: a card of the ground of a bubble, radius 10, 12 14 inside; the head 13/600 in the
  // muted grey, under it on 4 the pairs — the caption 13 muted over the value 15 (the iPhone 17, as the text of the
  // card of a person, В7.41), 2 apart, pairs 10 apart. rows: [{ caption, value }]; a pair without a value is not drawn.
  function aboutBlock(title, rows) {
    const n = make('div', 'lex-about');
    if (title) n.appendChild(make('div', 'lex-about-head', title));
    for (const r of rows || []) {
      if (!r || r.value == null || String(r.value).trim() === '') continue;
      const pair = make('div', 'lex-about-pair');
      if (r.caption) pair.appendChild(make('div', 'lex-about-caption', r.caption));
      pair.appendChild(make('div', 'lex-about-value', String(r.value)));
      n.appendChild(pair);
    }
    return n;
  }

  // ── В7.61 the empty state of a section ──────────────────────────────────────
  // One for every section: in the middle of the screen the face of the section (or of an agent) 48 on the hover wash,
  // the line 16/600, one line 14 in the faint grey under it, and when needed one second button (В7.7).
  // o: { section (the id of its mark) | face (a node), title, line, action: { label, onClick } }.
  function emptyState(o) {
    const n = make('div', 'lex-empty');
    n.appendChild(o.face || sectionFace(o.section || 'agents'));
    n.appendChild(make('div', 'lex-empty-title', o.title || ''));
    if (o.line) n.appendChild(make('div', 'lex-empty-line', o.line));
    if (o.action && global.LexMessage && global.LexMessage.button) {
      const b = global.LexMessage.button({ label: o.action.label });
      b.classList.add('lex-empty-act');
      b.addEventListener('click', () => o.action.onClick && o.action.onClick());
      n.appendChild(b);
    }
    return n;
  }

  // ── В7.62 the entries of the sections in the menu of chats ──────────────────
  // Lines of one block (the ground of a card, radius 10, a line between), 44 high: the mark 20, the title 15/600, the
  // yellow dot of the unread (В7.48) when the section waits. No chevrons: the whole line is the entry. The order and
  // the titles are the part's, whatever order and words the server sends: Agents, Calendar, Shopping list, Questions,
  // Extended Mind, News; a section the part does not know stands after them in the server's order, with its title.
  const ENTRY_ORDER = ['agents', 'calendar', 'shopping', 'questions', 'em', 'news'];
  const ENTRY_TITLES = { agents: 'Agents', calendar: 'Calendar', shopping: 'Shopping list', questions: 'Questions', em: 'Extended Mind', news: 'News' };
  // entries(host, sections, onPick) → { setActive(id) }: sections — [{ id, title }] as the server named them; the line of
  // the open section stands chosen (--lex-section-active).
  function entries(host, sections, onPick) {
    host.replaceChildren();
    host.classList.add('lex-entries');
    host.setAttribute('role', 'navigation');
    host.setAttribute('aria-label', 'Sections');
    const list = (Array.isArray(sections) ? sections : []).filter((s) => s && s.id);
    const place = (s) => { const i = ENTRY_ORDER.indexOf(s.id); return i < 0 ? ENTRY_ORDER.length : i; };
    list.map((s, i) => ({ s, i })).sort((a, b) => place(a.s) - place(b.s) || a.i - b.i).forEach(({ s }) => {
      const b = button('lex-entry', null, () => onPick(s.id));
      b.dataset.section = s.id;
      const icon = make('span', 'lex-entry-icon');
      icon.appendChild(sectionMark(s.id, 20));
      b.append(icon, make('span', 'lex-entry-title', ENTRY_TITLES[s.id] || s.title || s.id));
      b.dataset.unreadHost = '';
      const num = count({ section: s.id });
      b.appendChild(num);
      b.classList.toggle('has-dot', !num.hidden);
      host.appendChild(b);
    });
    host.hidden = !host.childElementCount;
    const api = {
      setActive(id) {
        host.querySelectorAll('.lex-entry').forEach((b) => {
          const on = id != null && b.dataset.section === String(id);
          b.classList.toggle('is-active', on);
          if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
        });
      },
    };
    host._entries = api;
    return api;
  }

  // AGAIN_MS is the pauses of a failed read: the main page of the people (lex-people.js) tries again by the same ladder.
  global.LexSection = { createFrame, row, listTime, markRead, moreButton, openMenu, iconButton, make, button, newOpId, keep,
    count, setUnread, unread, isImportant, markImportant, draft, setDrafts, paintDrafts, AGAIN_MS,
    MARKS, markSvg, sectionMark, agentFace, sectionFace, agentState, agentRow, STAGES, stageWords, liveStage,
    groupLabel, orderButton, toggle, settingRow, settingsBlock, aboutBlock, emptyState, entries, ENTRY_ORDER, ENTRY_TITLES };
})(typeof window !== 'undefined' ? window : globalThis);
