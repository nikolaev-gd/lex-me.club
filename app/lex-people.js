// lex-people.js — the chats with people on the main page of the page and the Mac app: the tabs All, Profi.ru, Kolya
// in the bar and one list under them, in the place of the empty chat (docs/spec/20-chat.md, «Главная страница»; the
// iPhone has the same in PeopleTabs.swift and PeopleList.swift). The conversations with the model are not here: they
// stand in the panel on the left. The chats with people are read once as one list (people_home,
// supabase/migrations/people_home.sql): «All» is the whole list, the tab of a section is the lines that carry its id. A
// section the server marks `tab: false` (folder_no_tab.sql: Other) has no tab of its own, its lines stand in «All».
// The order, the pin and the dot are the server's (a client who did not answer the first message has no line here:
// profi_only_answered.sql); this file draws what comes. A line is the line its own section draws (lex-profi.js, lex-folders.js: `line`), with its menu, and a press
// opens the chat the way that section does.
//
// create(deps) takes:
//   tabsHost, listHost   where the row of tabs stands, and the frame of the list (a `.lex-section` with a status
//                        line and a body); the page shows and hides both with the main page
//   tabs(o)              the common tabs (WcUI.tabs, В7.27)
//   read(name, args, show)  the window's way of reading, the copy first (lex-reads.js)
//   signals              the channel of the database's signals (lex-account-events.js)
//   live(tabId)          the live section of a tab ('profi', 'folder:kolya'), built, or null
//   showFeed(order)      the chat of new orders, at that order or at its top (a screen of Profi.ru)
//   notify(text)         a failure the person has to see
//   gear(on)             the gear of Profi.ru in the bar of the page
//   onSelect(id)         a tab was chosen
// create(deps) gives: setSections(list), select(id), setActive(on), repaintTabs(), warm(), selected, hasTabs, hasTabRow.
(function (global) {
  'use strict';

  const ALL = 'all';
  const KEPT_TAB = 'lex.peopleTab';
  const STALE_S = 120;

  const isPeopleSection = (id) => id === 'profi' || String(id || '').startsWith('folder:');

  function create(deps) {
    const make = (tag, cls, text) => global.LexSection.make(tag, cls, text);
    const status = make('div', 'lex-section-status');
    status.setAttribute('role', 'status');
    status.hidden = true;
    const body = make('div', 'lex-section-body');
    deps.listHost.append(status, body);

    let sections = [];       // the people's sections the server named: [{ id, title, tab }], in its order
    let selected = null;
    let chosen = null;       // the tab the person pressed in this run; the one kept on the device before it
    let active = false;      // the main page is on the screen
    let home = null;
    let fresh = false;       // the list on the screen came from the server in this run
    let tabsRow = null;
    let follower = null;
    let reading = null;

    const say = (text, isError) => {
      status.textContent = text || '';
      status.hidden = !text;
      status.classList.toggle('is-error', !!isError);
    };

    const kept = () => {
      try { return localStorage.getItem(KEPT_TAB); } catch (_) { return null; }
    };
    // The sections that have a tab; a section without one (Other) has its chats in «All» only.
    const tabbed = () => sections.filter((s) => s.tab);
    const unreadOf = (id) => {
      const u = global.LexSection.unread().sections || {};
      if (id !== ALL) return Math.max(0, Math.floor(Number(u[id]) || 0));
      return sections.reduce((n, s) => n + Math.max(0, Math.floor(Number(u[s.id]) || 0)), 0);
    };
    const labelOf = (id, title) => {
      const n = unreadOf(id);
      return n ? `${title} · ${n > 99 ? '99+' : n}` : title;
    };
    const items = () => [
      { id: ALL, label: labelOf(ALL, 'All') },
      ...tabbed().map((s) => ({ id: s.id, label: labelOf(s.id, s.title) })),
    ];
    const known = (id) => sections.length > 0 && (id === ALL || tabbed().some((s) => s.id === id));

    function paintTabs() {
      if (!tabbed().length) { tabsRow = null; deps.tabsHost.replaceChildren(); return; }
      if (!tabsRow) {
        tabsRow = deps.tabs({ label: 'Chats', items: items(), selected, onSelect: (id) => select(id) });
        deps.tabsHost.replaceChildren(tabsRow);
      } else tabsRow.update(items(), selected);
    }

    // ── the list ───────────────────────────────────────────────────────────────
    const fail = (text) => deps.notify(text);

    function lineOf(c) {
      const live = deps.live(c.tab);
      if (!live || !live.line) return null;
      return live.line(c, { from: 'people', fail, after: () => { reload().catch(() => {}); }, feed: (order) => deps.showFeed(order) });
    }

    function monitorNote() {
      if (!home || !fresh || !home.feed) return null;
      const st = home.status || {};
      const at = home.statusAt ? new Date(home.statusAt).getTime() : 0;
      if (!at || Date.now() - at > STALE_S * 1000) return ['The monitor is not on line: nothing new will come until a Mac wakes up.', true];
      if (st.stopped) return [`The monitor is stopped: ${st.stopped}`, true];
      return null;
    }

    function paint() {
      body.replaceChildren();
      if (!selected || !home) { say(''); return; }
      const note = selected === 'profi' ? monitorNote() : null;
      say(note ? note[0] : '', !!note);
      const list = make('div', 'lex-section-list');
      if (selected === 'profi' && home.feed) {
        const feed = home.feed;
        list.appendChild(global.LexSection.row({
          lead: global.LexMessage.avatarMark('profi', 48),
          title: feed.title || 'New orders', sub: feed.last || 'Nothing yet.', strong: true,
          mark: feed.active ? `${feed.active} sending` : '', onClick: () => deps.showFeed(null),
          unread: { chat: '__lex_profi_orders__' },
        }));
      }
      const chats = (Array.isArray(home.chats) ? home.chats : []).filter((c) => selected === ALL || c.tab === selected);
      for (const c of chats) {
        const line = lineOf(c);
        if (line) list.appendChild(line);
      }
      if (list.children.length) body.appendChild(list);
      else body.appendChild(make('div', 'lex-section-empty', 'No chats here yet.'));
    }

    // ── reading ────────────────────────────────────────────────────────────────
    function reload() {
      if (reading) return reading;
      reading = deps.read('people_home', {}, (v, isFresh, same) => {
        // The copy this device kept draws the first frame; the server's answer takes its place.
        if (!v || typeof v !== 'object' || (same && home) || (!isFresh && home)) return;
        home = v;
        if (isFresh) fresh = true;
        paint();
      }).catch((e) => {
        console.warn('[people] read:', e && e.message);
        if (active && selected) say('The chats did not load. ' + ((e && e.message) || ''), true);
      }).finally(() => { reading = null; });
      return reading;
    }

    // The database says something of the people changed: the one list is read again, while it is on the screen.
    function watch() {
      if (follower || !deps.signals) return;
      follower = deps.signals.follow(['profi', 'folders'], () => reload(), {});
    }
    function unwatch() {
      if (follower) follower.stop();
      follower = null;
    }
    // The page shows the main page: the list follows the server and the gear of Profi.ru stands in the bar. `again` — the
    // page just came to this screen: the list is read again; a change of the tab only draws the lines it has.
    function sync(again) {
      const on = active && !!selected;
      if (on) { watch(); if (again || !home) reload(); } else unwatch();
      deps.gear(on && selected === 'profi');
    }

    // ── what the window says ───────────────────────────────────────────────────
    function select(id, quiet) {
      if (!known(id)) id = sections.length ? ALL : null;
      const changed = id !== selected;
      selected = id;
      if (!quiet && id) {
        chosen = id;
        try { localStorage.setItem(KEPT_TAB, id); } catch (_) { /* this time only */ }
      }
      paintTabs();
      paint();
      sync(false);
      if (changed && deps.onSelect) deps.onSelect(id);
    }

    return {
      get selected() { return selected; },
      // The account has chats with people: the main page shows them.
      get hasTabs() { return sections.length > 0; },
      // The row of tabs stands: a section with a tab of its own is there (Other alone has none, its chats stand in «All»).
      get hasTabRow() { return tabbed().length > 0; },
      // The buttons the server named: the sections of the people become the tabs and the list (and leave the buttons);
      // none — no main page of the people, the empty chat as it was.
      setSections(list) {
        sections = (Array.isArray(list) ? list : []).filter((s) => s && isPeopleSection(s.id))
          .map((s) => ({ id: s.id, title: s.title || s.id, tab: s.tab !== false }));
        // The tab chosen the last time; the first time — «All». A tab that is not there (the account has no such section
        // now) gives way to «All».
        select(known(chosen) ? chosen : (known(kept()) ? kept() : ALL), true);
      },
      select,
      setActive(on) {
        if (active === !!on) return;
        active = !!on;
        sync(true);
      },
      repaintTabs() { if (tabbed().length) paintTabs(); },
      // The list is read at the start, so that the first showing of the main page has it.
      warm() { return reload(); },
      isPeople: isPeopleSection,
    };
  }

  global.LexPeople = { create, isPeopleSection };
})(typeof window !== 'undefined' ? window : globalThis);
