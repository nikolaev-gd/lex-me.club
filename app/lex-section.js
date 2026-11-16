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
//   tools          buttons of the bar, on the first screen only; a button with an icon is
//                  iconButton(cls + ' lex-section-icon', svg, title, onClick), a zone of 44 (В7.11)
//   gear()         what the gear opens; no gear without it
//   signals,       the channel of the database's signals (lex-account-events.js) and which of
//   events         them mean «look again» for this section; no channel — no watch. The frame
//                  never asks the server on a timer (Gennady, 2026-11-13).
//   check(signal)  the look itself: signal — what came ({ event, payload }), null — a look to
//                  catch up, the channel being open again
//   notify(text)   the server is lost while the section is off the screen
//   onBack(id)     the person came back to this screen
(function (global) {
  'use strict';

  // Failed looks in a row before the status line says so: one lost answer is not news.
  const LOST_AFTER = 3;
  // A look that gave no answer for this long counts as failed, and the next one may go.
  const STUCK_MS = 15000;
  // A failed look is tried again after these pauses: something changed and is not on the
  // screen yet. This is no watch for news — it stops at the first good look.
  const AGAIN_MS = [1000, 2000, 5000, 10000, 20000, 30000];
  const LOST_TEXT = 'No connection to the server. Lex keeps trying.';

  const GEAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>';
  const DOTS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5h.01M12 12h.01M12 19h.01"/></svg>';
  // The pin of a pinned chat (В7.34), the same drawing as Pin in the menu of a chat (lex-send-later.js).
  const PIN = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="Pinned"><path d="M12 17v5"/><path d="M8 3h8"/><path d="M9 3v7l-3 4h12l-3-4V3"/></svg>';

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
  // bot's: «Bot:» before it). Its menu is the menu of a chat (lex-chat-menu.js).
  function row(o) {
    const el = make('div', 'lex-section-row');
    el.classList.toggle('is-unread', !!o.dot);
    el.classList.toggle('is-strong', !!o.strong);
    el.classList.toggle('is-wrap', !!o.wrap);
    el.classList.toggle('is-chat', o.time != null || !!o.pinned);
    const main = button(`lex-section-row-main${o.cls ? ` ${o.cls}` : ''}`, null, o.onClick);
    if (o.id != null) main.dataset.id = o.id;
    const top = make('span', 'lex-section-row-top');
    top.appendChild(make('span', 'lex-section-row-title', o.title));
    if (o.mark) top.appendChild(make('span', 'lex-section-mark', o.mark));
    if (o.pinned) {
      const pin = make('span', 'lex-section-row-pin');
      pin.innerHTML = PIN;
      top.appendChild(pin);
    }
    if (o.time) top.appendChild(make('span', 'lex-section-row-time', o.time));
    main.appendChild(top);
    const sub = () => {
      const n = make('span', 'lex-section-row-sub');
      if (o.bot) n.append(make('span', 'lex-section-row-bot', 'Bot:'), ' ');
      n.append(o.sub || '');
      return n;
    };
    if (o.end) {
      const line = make('span', 'lex-section-row-subline');
      line.appendChild(sub());
      line.appendChild(o.end);
      main.appendChild(line);
    } else if (o.sub) main.appendChild(sub());
    el.appendChild(main);
    if (o.more && o.more.length) el.appendChild(moreButton(o.more));
    return el;
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
    bar.append(titleEl, tools);
    const status = make('div', 'lex-section-status');
    status.setAttribute('role', 'status');
    status.hidden = true;
    const first = { id: 'home', title: opts.title, body: make('div', 'lex-section-body'), top: 0 };
    root.append(bar, status, first.body);
    const stack = [first];
    const top = () => stack[stack.length - 1];
    const isShown = () => root.isConnected && !root.closest('[hidden]');

    // What the section says, and over it what the watch has to say.
    let said = [''];
    let lost = false;
    function paintStatus() {
      const [text, isError, isBusy] = lost ? [LOST_TEXT, true] : said;
      status.textContent = text || '';
      status.hidden = !text;
      status.classList.toggle('is-error', !!isError);
      status.classList.toggle('is-busy', !!text && !isError && !!isBusy);
    }
    function say(text, isError, isBusy) {
      said = [text, isError, isBusy];
      paintStatus();
    }

    // The arrow of the window leads from a screen inside the section to the one under it.
    function paintScreen() {
      titleEl.textContent = top().title;
      tools.hidden = stack.length > 1;
      root.classList.toggle('is-inner', stack.length > 1);
      if (!opts.back) return;
      if (stack.length > 1) opts.back.cameFrom({ title: stack[stack.length - 2].title, go: pop });
      else opts.back.clear();
    }

    // A screen over the current one. Everything under it stays alive, at its place.
    function push(screen) {
      const from = top();
      from.top = from.body.scrollTop;
      from.body.hidden = true;
      const body = make('div', 'lex-section-body');
      root.appendChild(body);
      stack.push({ id: screen.id, title: screen.title, body });
      say('');
      paintScreen();
      return body;
    }

    function pop() {
      if (stack.length < 2) return undefined;
      stack.pop().body.remove();
      const to = top();
      to.body.hidden = false;
      to.body.scrollTop = to.top;
      say('');
      paintScreen();
      return opts.onBack ? opts.onBack(to.id) : undefined;
    }

    // The watch follows the signals of the server: a signal of this section — a look. The
    // channel opens again after a break — one look, to catch up. A failed look only tells
    // the status line, is tried again after a pause until one goes, and the first good one
    // takes the words away; so does the channel coming back. Looks never pile up: what comes
    // during one makes one more after it (lex-account-events.js, follow).
    let follower = null;
    let fails = 0;
    let channelLost = false;
    let againTimer = null;
    let looking = 0;
    function paintLost() {
      const now = channelLost || fails >= LOST_AFTER;
      if (now === lost) return;
      lost = now;
      paintStatus();
      if (lost && !isShown() && opts.notify) opts.notify(LOST_TEXT);
    }
    function failed(e) {
      console.warn(`[section] ${opts.title}:`, e && e.message);
      fails += 1;
      paintLost();
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
        paintLost();
      } catch (e) {
        if (looking === mine) failed(e);
      } finally {
        clearTimeout(stuck);
        if (looking === mine) looking = 0;
      }
    }

    // A press on an item. run(wanted) is the section's: wanted() turns false when the person
    // went elsewhere meanwhile, and then nothing moves. What failed goes to the status line.
    let opening = 0;
    async function open(run, failText) {
      opening += 1;
      const mine = opening;
      const wanted = () => opening === mine;
      try {
        await run(wanted);
      } catch (e) {
        if (wanted()) say(`${failText} ${(e && e.message) || ''}`.trim(), true);
      }
    }

    return {
      el: root,
      say,
      push,
      pop,
      open,
      isShown,
      get screen() { return top().id; },
      get body() { return top().body; },
      // The section came on screen: the arrow stands as its screen needs it.
      enter: paintScreen,
      stopOpening() { opening += 1; },
      watch() {
        if (follower || !opts.check || !opts.signals) return;
        follower = opts.signals.follow(opts.events || [], look, {
          onLost: (v) => { channelLost = v; paintLost(); },
        });
      },
      unwatch() {
        if (follower) follower.stop();
        follower = null;
        if (againTimer) { clearTimeout(againTimer); againTimer = null; }
        looking = 0;
        fails = 0;
        channelLost = false;
        paintLost();
      },
      // A look now, as after a signal: the section knows something changed by itself.
      lookNow() { if (follower) follower.now(); },
    };
  }

  global.LexSection = { createFrame, row, listTime, markRead, moreButton, openMenu, iconButton, make, button, newOpId, keep };
})(typeof window !== 'undefined' ? window : globalThis);
