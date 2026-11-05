// lex-section.js — the frame of a section of Lex, on the page, the Mac app and the extension.
// It draws what every section has: the top bar with the title and the gear, the status line,
// a line of a list with the unread dot and the three dots, the screens inside a section with
// the way back, the watch over the server, the opening of an item. A section gives only what
// is its own: what stands in a line, what lies in the menu, what the head of an open item
// holds, how often to look at the server. A new section gets the rest by asking for a frame.
// The iPhone has the same frame in SectionFrame.swift. docs/spec/27-sections.md.
//
// No chrome.* and no word about any one section: every window loads this file, and not every
// window has every section.
//
// createFrame takes:
//   title          the name of the section
//   cls            one more class on the root, the section's own styles hang on it
//   back           the arrow of the window, see lex-back.js
//   tools          buttons of the bar, on the first screen only
//   gear()         what the gear opens; no gear without it
//   every, check() how often to look at the server, and the look itself
//   notify(text)   the server is lost while the section is off the screen
//   onBack(id)     the person came back to this screen
(function (global) {
  'use strict';

  // Failed looks in a row before the status line says so: one lost answer is not news.
  const LOST_AFTER = 3;
  // A look that gave no answer for this long counts as failed, and the next one goes.
  const STUCK_MS = 15000;
  const LOST_TEXT = 'No connection to the server. Lex keeps trying.';

  const GEAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>';
  const DOTS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5h.01M12 12h.01M12 19h.01"/></svg>';

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

  // items: [{ label, onSelect }]. host: where the menu stands, the frame when not named.
  function moreButton(items, host) {
    const b = iconButton('lex-section-more', DOTS, 'More', () => {
      openMenu(b, items, host || b.closest('.lex-section'));
    });
    return b;
  }

  // ── a line of a list ────────────────────────────────────────────────────────
  // What stands in it is the section's: title, sub, mark (a small label at the title), dot
  // (not read yet), strong (bold whatever is read), wrap (the title and the sub take several
  // lines), end (a node at the right end of the sub line), more (the menu of the dots), id and
  // cls (of the main button), onClick.
  function row(o) {
    const el = make('div', 'lex-section-row');
    el.classList.toggle('is-unread', !!o.dot);
    el.classList.toggle('is-strong', !!o.strong);
    el.classList.toggle('is-wrap', !!o.wrap);
    const main = button(`lex-section-row-main${o.cls ? ` ${o.cls}` : ''}`, null, o.onClick);
    if (o.id != null) main.dataset.id = o.id;
    const top = make('span', 'lex-section-row-top');
    top.appendChild(make('span', 'lex-section-row-title', o.title));
    if (o.mark) top.appendChild(make('span', 'lex-section-mark', o.mark));
    main.appendChild(top);
    if (o.end) {
      const line = make('span', 'lex-section-row-subline');
      line.appendChild(make('span', 'lex-section-row-sub', o.sub || ''));
      line.appendChild(o.end);
      main.appendChild(line);
    } else if (o.sub) main.appendChild(make('span', 'lex-section-row-sub', o.sub));
    el.appendChild(main);
    if (o.more && o.more.length) el.appendChild(moreButton(o.more));
    return el;
  }

  const markRead = (rowEl) => rowEl.classList.remove('is-unread');

  // ── the frame ───────────────────────────────────────────────────────────────
  function createFrame(opts) {
    const root = make('section', `lex-section${opts.cls ? ` ${opts.cls}` : ''}`);
    const bar = make('header', 'lex-section-bar');
    const titleEl = make('div', 'lex-section-title', opts.title);
    const tools = make('div', 'lex-section-tools');
    tools.append(...(opts.tools || []));
    if (opts.gear) tools.appendChild(iconButton('lex-section-gear', GEAR, 'Settings', opts.gear));
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

    // The watch goes on after any error: a failed look only tells the status line, and the
    // first good one takes the words away. Looks do not pile up on a slow network.
    let timer = null;
    let looking = 0;
    let fails = 0;
    function failed(e) {
      console.warn(`[section] ${opts.title}:`, e && e.message);
      fails += 1;
      if (fails < LOST_AFTER || lost) return;
      lost = true;
      paintStatus();
      if (!isShown() && opts.notify) opts.notify(LOST_TEXT);
    }
    async function look() {
      if (looking) {
        if (Date.now() - looking < STUCK_MS) return;
        looking = 0;
        failed(new Error('no answer'));
      }
      const mine = Date.now();
      looking = mine;
      try {
        await opts.check();
        if (looking !== mine) return;
        fails = 0;
        if (lost) {
          lost = false;
          paintStatus();
        }
      } catch (e) {
        if (looking === mine) failed(e);
      } finally {
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
        if (!timer && opts.check) timer = setInterval(look, opts.every);
      },
      unwatch() {
        clearInterval(timer);
        timer = null;
        looking = 0;
        fails = 0;
        if (lost) {
          lost = false;
          paintStatus();
        }
      },
    };
  }

  global.LexSection = { createFrame, row, markRead, moreButton, make, button, newOpId };
})(typeof window !== 'undefined' ? window : globalThis);
