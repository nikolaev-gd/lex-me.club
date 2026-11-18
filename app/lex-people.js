// lex-people.js — the tabs of the people over the list of conversations, on the page and the Mac app:
// Lex, All, Profi.ru, Kolya, Other (docs/spec/20-chat.md, «Вкладки людей»; the iPhone has the same in
// PeopleTabs.swift). Lex is the list of conversations with the model, as it always was. The other tabs are the
// chats with people, read once as one list (people_home, supabase/migrations/people_home.sql): «All» is the whole
// list, the tab of a section is the lines that carry its id. The order, the pin, the dot and the lines folded as
// «chats with no reply» are the server's; this file draws what comes. A line is the line its own section draws
// (lex-profi.js, lex-folders.js: `line`), with its menu, and a press opens the chat the way that section does.
//
// create(deps) takes:
//   tabsHost, listHost   where the row of tabs stands, and the frame of the list (a `.lex-section` with a status
//                        line and a body); convsHost — the list of conversations, hidden while another tab shows
//   tabs(o)              the common tabs (WcUI.tabs, В7.27)
//   read(name, args, show)  the window's way of reading, the copy first (lex-reads.js)
//   signals              the channel of the database's signals (lex-account-events.js)
//   live(tabId)          the live section of a tab ('profi', 'folder:kolya'), built, or null
//   showFeed(order)      the chat of new orders, at that order or at its top (a screen of Profi.ru)
//   openSettings()       the settings of Profi.ru
//   notify(text)         a failure the person has to see
//   gear(on)             the gear of Profi.ru in the bar of the panel
//   onSelect(id)         a tab was chosen
// create(deps) gives: setSections(list), select(id), setActive(on), repaintTabs(), warm(), selected.
(function (global) {
  'use strict';

  const LEX = 'lex';
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

    let sections = [];       // the people's sections the server named: [{ id, title }], in its order
    let selected = null;
    let chosen = null;       // the tab the person pressed in this run; the one kept on the device before it
    let active = false;      // the panel is open and a tab of the people is on it
    let home = null;
    let fresh = false;       // the list on the screen came from the server in this run
    let silentOpen = false;
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
    const unreadOf = (id) => {
      const u = global.LexSection.unread().sections || {};
      if (id !== ALL) return Math.max(0, Math.floor(Number(u[id]) || 0));
      return sections.reduce((n, s) => n + Math.max(0, Math.floor(Number(u[s.id]) || 0)), 0);
    };
    const labelOf = (id, title) => {
      const n = id === LEX ? 0 : unreadOf(id);
      return n ? `${title} · ${n > 99 ? '99+' : n}` : title;
    };
    const items = () => [
      { id: LEX, label: 'Lex' },
      { id: ALL, label: labelOf(ALL, 'All') },
      ...sections.map((s) => ({ id: s.id, label: labelOf(s.id, s.title) })),
    ];
    const known = (id) => id === LEX || (sections.length > 0 && (id === ALL || sections.some((s) => s.id === id)));

    function paintTabs() {
      deps.tabsHost.hidden = !sections.length;
      if (!sections.length) return;
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
      if (selected === LEX || !home) { say(''); return; }
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
      const silent = chats.filter((c) => c.group === 'silent');
      let drawn = 0;
      for (const c of chats) {
        if (c.group === 'silent') continue;
        const line = lineOf(c);
        if (line) { list.appendChild(line); drawn += 1; }
      }
      if (list.children.length) body.appendChild(list);
      else if (!silent.length) body.appendChild(make('div', 'lex-section-empty', 'No chats here yet.'));
      if (silent.length) {
        const text = (home.silent && home.silent.text && silent.length === Number(home.silent.count))
          ? home.silent.text
          : `${silent.length} ${silent.length === 1 ? 'chat' : 'chats'} with no reply`;
        const fold = global.LexMessage.fold({
          text, action: silentOpen ? 'Hide' : 'Show',
          onClick: () => { silentOpen = !silentOpen; paint(); },
        });
        fold.classList.add('lex-profi-fold');
        body.appendChild(fold);
        if (silentOpen) {
          const rest = make('div', 'lex-section-list');
          for (const c of silent) { const line = lineOf(c); if (line) rest.appendChild(line); }
          body.appendChild(rest);
        }
      }
    }

    // ── reading ────────────────────────────────────────────────────────────────
    function reload() {
      if (reading) return reading;
      reading = deps.read('people_home', {}, (v, isFresh, same) => {
        // The copy this device kept draws the first frame; the server's answer takes its place.
        if (!v || typeof v !== 'object' || (same && home) || (!isFresh && home)) return;
        home = v;
        if (isFresh) fresh = true;
        if (selected !== LEX) paint();
      }).catch((e) => {
        console.warn('[people] read:', e && e.message);
        if (active && selected !== LEX) say('The chats did not load. ' + ((e && e.message) || ''), true);
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
    function sync() {
      const on = active && selected !== LEX;
      if (on) { watch(); reload(); } else unwatch();
      deps.gear(on && selected === 'profi');
    }

    // ── what the window says ───────────────────────────────────────────────────
    function select(id, quiet) {
      if (!known(id)) id = sections.length ? ALL : LEX;
      const changed = id !== selected;
      selected = id;
      if (!quiet) {
        chosen = id;
        try { localStorage.setItem(KEPT_TAB, id); } catch (_) { /* this time only */ }
      }
      deps.convsHost.hidden = id !== LEX;
      deps.listHost.hidden = id === LEX;
      paintTabs();
      paint();
      sync();
      if (changed && deps.onSelect) deps.onSelect(id);
    }

    return {
      get selected() { return selected; },
      get hasTabs() { return sections.length > 0; },
      // The buttons the server named: the sections of the people become tabs (and leave the buttons); none — no
      // row, the list of conversations as it was.
      setSections(list) {
        sections = (Array.isArray(list) ? list : []).filter((s) => s && isPeopleSection(s.id)).map((s) => ({ id: s.id, title: s.title || s.id }));
        // The tab chosen the last time; the first time — «All».
        // A tab that is not there (the account has no such section now) gives way to «All», or to Lex when no tab stands.
        select(known(chosen) ? chosen : (known(kept()) ? kept() : (sections.length ? ALL : LEX)), true);
      },
      select,
      setActive(on) { active = !!on; sync(); },
      repaintTabs() { if (sections.length) paintTabs(); },
      // The list is read at the start, so that the first opening of the panel has it.
      warm() { return reload(); },
      isPeople: isPeopleSection,
    };
  }

  global.LexPeople = { create, isPeopleSection };
})(typeof window !== 'undefined' ? window : globalThis);
