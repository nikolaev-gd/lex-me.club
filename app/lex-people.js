// lex-people.js — the chats with people on the main page of the page and the Mac app: the tabs All, Clients, Kolya
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
//   tabsHost, listHost   where the row of tabs stands, and the frame of the list (a `.lex-section` with a body, and
//                        no status line: a list that did not load says nothing, Gennady 20.11.2026); the page shows
//                        and hides both with the main page
//   tabs(o)              the common tabs (WcUI.tabs, В7.27)
//   read(name, args, show)  the window's way of reading, the copy first (lex-reads.js)
//   signals              the channel of the database's signals (lex-account-events.js)
//   live(tabId)          the live section of a tab ('profi', 'folder:kolya'), built, or null
//   showFeed(order)      the chat of new orders, at that order or at its top (a screen of Profi.ru)
//   showBot()            the bot's service chat (a screen of Profi.ru), the line under the new orders
//   notify(text)         a failure the person has to see
//   back(target)         the arrow of the window (lex-back.js): { title, go, archive: true } while the archive stands on
//                        the main page, null — the archive closed
//   gear(on)             the gear of Profi.ru in the bar of the page
//   onSelect(id)         a tab was chosen
// create(deps) gives: setSections(list), select(id), toAll(), setActive(on), repaintTabs(), warm(), selected, hasTabs,
// hasTabRow.
//
// The Archive (2026-11-23, chat_archive.sql): the chats put into it are not in the list; at its top a row «Archived» —
// the face of the archive, the gray number of the archived chats of the tab (on «All» all of them), none — no row. A
// press shows the archived chats of the tab in the place of the list (people_archived, the same lines, their menu says
// Unarchive), the arrow of the window leads back; «No archived chats.» when there are none. A new message of the person
// puts a chat back in the list by itself (the server's rule).
//
// The tab is «All» by default (Gennady, 20.11.2026): the start of the page, «New chat» and a notification put it there
// (`toAll`). The tab pressed holds only while the person goes from the list into a chat and back by the arrow.
(function (global) {
  'use strict';

  const ALL = 'all';
  // The device kept the tab pressed until 20.11.2026; it is not read any more, and the key goes at the start.
  const OLD_KEPT_TAB = 'lex.peopleTab';
  try { global.localStorage && global.localStorage.removeItem(OLD_KEPT_TAB); } catch (_) { /* nothing kept */ }

  const isPeopleSection = (id) => id === 'profi' || String(id || '').startsWith('folder:');

  function create(deps) {
    const make = (tag, cls, text) => global.LexSection.make(tag, cls, text);
    const body = make('div', 'lex-section-body');
    deps.listHost.append(body);

    let sections = [];       // the people's sections the server named: [{ id, title, tab }], in its order
    let selected = null;
    let chosen = null;       // the tab the person pressed since the main page last came by «New chat» or a notification
    let active = false;      // the main page is on the screen
    let home = null;
    let drawn = '';          // `home` as text: what the screen shows, to tell the server's answer from it
    const textOf = (v) => { try { return JSON.stringify(v); } catch (_) { return null; } };
    let tabsRow = null;
    let follower = null;
    let reading = null;
    // A read that failed says nothing on the screen, and is tried again after a pause until one goes: the same ladder as
    // the looks of the sections (lex-section.js), so that the copy of the last time does not stay for good. It runs only
    // while the main page is on the screen (`follower`), and stops at the first good read.
    let fails = 0;
    let againTimer = null;
    // The line of the bot's service chat reads its last message itself (profi_bot_chat(1)): people_home stays as it was.
    let botHead = null;
    // The Archive: open or not, and the archived lines as people_archived last gave them (null — not read yet).
    let archiveOpen = false;
    let archived = null;
    let archiveReading = null;

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
      // A line is drawn and opened by the section that holds its chat: a chat of a folder — by its folder, also when
      // it stands under another tab (a client's group under «Clients», client_group_chat.sql).
      const live = deps.live(c.source === 'folder' && c.folder ? `folder:${c.folder}` : c.tab);
      if (!live || !live.line) return null;
      return live.line(c, {
        from: 'people', fail, feed: (order) => deps.showFeed(order),
        after: () => { reload().catch(() => {}); if (archiveOpen || archived) readArchived(); },
      });
    }

    // ── the Archive ────────────────────────────────────────────────────────────
    // How many archived chats the tab has: «All» — all of them (people_home → archived: { count, tabs }).
    function archivedCount() {
      const a = home && home.archived;
      if (!a || typeof a !== 'object') return 0;
      const n = selected === ALL ? a.count : (a.tabs || {})[selected];
      return Math.max(0, Math.floor(Number(n) || 0));
    }
    function archivedRow(n) {
      return global.LexSection.row({
        lead: global.LexSection.sectionFace('archive', { size: 48 }),
        title: 'Archived', time: String(n), onClick: () => openArchive(),
      });
    }
    const arrow = { title: 'Chats', go: () => closeArchive(), archive: true };
    function openArchive() {
      archiveOpen = true;
      paint();
      if (deps.back) deps.back(arrow);
      readArchived();
    }
    function closeArchive(quiet) {
      if (!archiveOpen) return;
      archiveOpen = false;
      if (deps.back) deps.back(null);
      if (!quiet) paint();
    }
    function readArchived() {
      if (archiveReading) return archiveReading;
      archiveReading = Promise.resolve(deps.read('people_archived', {}, (v) => {
        if (!v || typeof v !== 'object') return;
        archived = Array.isArray(v.chats) ? v.chats : [];
        if (archiveOpen) paint();
      })).catch((e) => console.warn('[people] archive:', e && e.message))
        .finally(() => { archiveReading = null; });
      return archiveReading;
    }
    function paintArchive() {
      const list = make('div', 'lex-section-list');
      const rows = (archived || []).filter((c) => selected === ALL || c.tab === selected);
      for (const c of rows) {
        const line = lineOf(c);
        if (line) list.appendChild(line);
      }
      if (list.children.length) body.appendChild(list);
      else if (archived) body.appendChild(make('div', 'lex-section-empty', 'No archived chats.'));
    }

    // There is no red line over this list (Gennady, 20.11.2026): a monitor that stopped or went silent is told
    // by the bot's alert in its own chat, and a list that did not load keeps the copy on the screen.

    function paint() {
      body.replaceChildren();
      if (!selected || !home) return;
      if (archiveOpen) { paintArchive(); return; }
      const list = make('div', 'lex-section-list');
      const nArchived = archivedCount();
      if (nArchived) list.appendChild(archivedRow(nArchived));
      if (selected === 'profi' && home.feed) {
        const feed = home.feed;
        list.appendChild(global.LexSection.row({
          lead: global.LexMessage.avatarMark('profi', 48),
          title: feed.title || 'New orders', sub: feed.last || 'Nothing yet.', strong: true,
          mark: feed.active ? `${feed.active} sending` : '', onClick: () => deps.showFeed(null),
          unread: { chat: '__lex_profi_orders__' },
        }));
        // The bot's service chat (19.11.2026): under the new orders, the same line as in the section.
        const heard = (botHead && botHead.messages) || [];
        const lastWords = heard[heard.length - 1] || null;
        list.appendChild(global.LexSection.row({
          lead: global.LexMessage.avatarBrand(48),
          title: (botHead && botHead.title) || 'Бот Профи', sub: lastWords ? String(lastWords.text || '') : 'Nothing yet.', strong: true,
          time: lastWords ? global.LexSection.listTime(lastWords.at) : '',
          onClick: () => deps.showBot(),
          unread: { chat: '__lex_profi_bot__' },
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
    // The bot's last message, for its line. An account without the section of Profi.ru has no such chat: nothing to draw.
    function readBot() {
      return Promise.resolve(deps.read('profi_bot_chat', { p_limit: 1 }, (b) => {
        if (!b || typeof b !== 'object') return;
        botHead = b;
        if (selected === 'profi' && home) paint();
      })).catch(() => {});
    }

    function reload() {
      if (reading) return reading;
      readBot();
      reading = deps.read('people_home', {}, (v, isFresh) => {
        // The copy this device kept draws the first frame; the server's answer takes its place. A copy never covers a
        // list that stands on the screen already.
        if (!v || typeof v !== 'object' || (!isFresh && home)) return;
        // The answer is compared with the list on THIS screen, not with the copy: the `same` of the reads says the answer
        // is that copy, and a copy that was not drawn (the list stood already) says nothing of the screen. Another
        // window of the page keeps its own, newer copy, and the two can be equal while this window still shows the dot
        // that the other one has put out.
        const text = textOf(v);
        if (isFresh && home && text !== null && text === drawn) return;
        home = v;
        drawn = text;
        paint();
        // The archive on the screen follows the same signals: what came back leaves it, what went in comes.
        if (archiveOpen) readArchived();
      }).then(() => {
        fails = 0;
        stopAgain();
      }, (e) => {
        // Silent on the screen: the copy of the last time stays, and the bot's alert tells what is broken.
        console.warn('[people] read:', e && e.message);
        readAgain();
      }).finally(() => { reading = null; });
      return reading;
    }

    function stopAgain() {
      if (againTimer) { clearTimeout(againTimer); againTimer = null; }
    }
    function readAgain() {
      fails += 1;
      if (againTimer || !follower) return;
      const ladder = global.LexSection.AGAIN_MS;
      againTimer = setTimeout(() => { againTimer = null; if (follower) reload(); }, ladder[Math.min(fails - 1, ladder.length - 1)]);
    }

    // The database says something of the people changed: the one list is read again, while it is on the screen.
    function watch() {
      if (follower || !deps.signals) return;
      follower = deps.signals.follow(['profi', 'folders'], () => reload(), {});
    }
    function unwatch() {
      if (follower) follower.stop();
      follower = null;
      stopAgain();
      fails = 0;
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
      if (!quiet && id) chosen = id;
      paintTabs();
      paint();
      sync(false);
      if (changed && deps.onSelect) deps.onSelect(id);
      // The arrow of the archive stands as long as the archive is on the main page on the screen.
      if (archiveOpen && active && deps.back) deps.back(arrow);
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
        // The tab pressed in this run; at the start — «All». A tab that is not there (the account has no such section
        // now) gives way to «All».
        select(known(chosen) ? chosen : ALL, true);
      },
      select,
      // «New chat» and a notification: the main page behind them is «All», whatever tab was pressed before.
      toAll() {
        chosen = null;
        closeArchive(true);
        select(ALL, true);
      },
      setActive(on) {
        if (active === !!on) return;
        active = !!on;
        sync(true);
        // Back from a chat opened in the archive: the archive again, with its arrow.
        if (active && archiveOpen && deps.back) deps.back(arrow);
      },
      // The archive of the main page stands on the screen.
      get archiveOpen() { return archiveOpen; },
      closeArchive() { closeArchive(); },
      repaintTabs() { if (tabbed().length) paintTabs(); },
      // The list is read at the start, so that the first showing of the main page has it.
      warm() { return reload(); },
      isPeople: isPeopleSection,
    };
  }

  global.LexPeople = { create, isPeopleSection };
})(typeof window !== 'undefined' ? window : globalThis);
