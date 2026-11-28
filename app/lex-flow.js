// lex-flow.js — «Flow», the one list of every chat, on the page and in the Mac app (28.11.2026, iteration 3 of
// docs/PLAN-HOME-TODAY-FLOW.md; docs/spec/20-chat.md, «Поток»; ios/Lex/STANDARD.md В7.90). The chats of the people
// (Profi.ru and the folders), «New orders», «Агент Профи», «Questions», the task chats of the agents and the chats of Lex
// stand in one list by time, the pinned ones first, under the chips All · Waiting · <the sections of the people with a
// tab, named and ordered by the server: Clients, Kolya> · Lex. A section without a tab (Other) has its chats in «All» only.
// The part is mounted in one of two places (`mount`): the column 300 right of the rail of a wide window, or the drawer of a
// narrow one (#wc-sidebar), where two tiles «Today» and «New chat» stand over the chips. It replaced the main page of the
// people (lex-people.js, 19.11–28.11.2026): its tabs are the chips, its list is this list.
//
// The data is one read of the server, `lex_flow` (supabase/migrations/flow_feed.sql), with the filter 'all': the chips cut
// it on the device (`filters` of a row), so a chip changes nothing on the server. The first portion carries every row
// that is not a chat of Lex and the first portion of the chats of Lex; the next portions (by `cursor`, while scrolling)
// carry only chats of Lex. The rule of the portions (the contract of iteration 3): while there is a cursor, «All» and
// «Lex» show only the rows at or above the last chat of Lex loaded (its time) and the pinned ones, so no row ever comes in
// above one already on the screen; the chips with no chats of Lex show everything at once; a row with no time goes last.
// A read again (a signal) reads as many portions as were loaded, so the list does not shrink under the person.
// The copy this device kept of the first portion draws the first frame (lex-reads.js, `lex_flow`); a read that failed
// says nothing on the screen and is tried again by the ladder of the sections (LexSection.AGAIN_MS), the copy stays, no
// red line (Gennady, 20.11.2026). The list follows the signals profi, folders, unread, chats and agent_screen while it is
// on the screen.
//
// A row is drawn by the part that draws it elsewhere, with its menu: a chat of a person — its section's line
// (lex-profi.js, lex-folders.js `line`), a task chat — the line of the folder of the agents (wc-agents.js `line`), a chat
// of Lex — the line of the conversations (wc-sidebar.js createRows, look 'flow'); «New orders», «Агент Профи» and
// «Questions» — the lines below (LexSection.row). The numbers on the chips are the device's: how many rows of the chip
// have something unread now (LexSection.unread: one per chat, as the tabs counted), Waiting — how many rows wait; Lex
// has no number (В7.48). The row «Archived» on top opens the archive of the chip in the same place (lex_flow_archived:
// the people, the chats of Lex, the task chats), the arrow of the head brings the list back.
//
// create(deps) — deps:
//   read(name, args, show)   the window's way of reading, the copy first (lex-reads.js)
//   rpc(name, args)          a read with no copy: the next portions, the archive
//   signals                  the channel of the database's signals (lex-account-events.js)
//   tabs(o)                  the common tabs (WcUI.tabs, В7.27): the chips
//   live(id)                 the live section of a chip ('profi', 'folder:kolya'), built, or null
//   lexRows(ctx)             the lines of the conversations (WcSidebar.createRows): { row(item) }
//   lexHooks                 what a line of a conversation does: { onOpen, onAct, onDelete, onRename }
//   itemOf(chat, archived)   a row of list_chats as the line of a conversation takes it (WcHistory.itemOf)
//   agentLine(c, o)          the line of a task chat (wc-agents.js line), or null without the section Agents
//   showFeed(order)          the chat of new orders, at that order or at its top
//   showBot()                the bot's service chat
//   openQuestions()          the feed of questions
//   openAgent(agent, chatKey)  a task chat of an agent, beside the list
//   onNew()                  the pencil of the head, the tile «New chat»
//   onToday()                the tile «Today» (the drawer)
//   gear()                   the gear of Profi.ru in the head, on the chip of Profi.ru
//   fillTitles(items)        the conversations with no name yet: the server is asked to name them
//   notify(text)             a failure the person has to see
// create(deps) gives: el, mount(host, place), setSections(list), select(id), toAll(), setActive(on), repaintChips(),
// warm(), reload(), pick(key), titles(map), line(c), hasPeople, selected, archiveOpen, closeArchive(), isPeople.
(function (global) {
  'use strict';

  const ALL = 'all';
  const WAITING = 'waiting';
  const LEX = 'lex';
  const EVENTS = ['profi', 'folders', 'unread', 'chats', 'agent_screen'];
  // The rows that count on a chip: the chats of the people and the two chats of Profi.ru (the old tabs counted them).
  const PEOPLE_KINDS = new Set(['person', 'orders', 'bot']);
  const BACK = ['M15 5l-7 7 7 7'];
  const GEAR = ['M10.08 4.34 L11.01 2.45 L12.99 2.45 L13.92 4.34 L16.06 5.22 L18.05 4.55 L19.45 5.95 L18.78 7.94 L19.66 10.08 L21.55 11.01 L21.55 12.99 L19.66 13.92 L18.78 16.06 L19.45 18.05 L18.05 19.45 L16.06 18.78 L13.92 19.66 L12.99 21.55 L11.01 21.55 L10.08 19.66 L7.94 18.78 L5.95 19.45 L4.55 18.05 L5.22 16.06 L4.34 13.92 L2.45 12.99 L2.45 11.01 L4.34 10.08 L5.22 7.94 L4.55 5.95 L5.95 4.55 L7.94 5.22 Z', 'M8.9 12a3.1 3.1 0 1 0 6.2 0a3.1 3.1 0 1 0 -6.2 0'];

  // The device kept the tab pressed until 20.11.2026; it is not read any more, and the key goes at the start.
  try { global.localStorage && global.localStorage.removeItem('lex.peopleTab'); } catch (_) { /* nothing kept */ }

  const isPeopleSection = (id) => id === 'profi' || String(id || '').startsWith('folder:');
  const ms = (at) => (at ? Date.parse(at) : NaN);
  const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const textOf = (v) => { try { return JSON.stringify(v); } catch (_) { return null; } };
  const valid = (v) => !!v && typeof v === 'object' && Array.isArray(v.rows);

  // Every row, the portions merged: a chat of Lex that moved between two portions comes once; pinned first, then by time
  // (no time last), then the order the server gave.
  function merge(first, more) {
    const seen = new Set();
    const out = [];
    for (const r of [...((first && first.rows) || []), ...(more || [])]) {
      if (!r || typeof r !== 'object' || !r.key || seen.has(`${r.kind}|${r.key}`)) continue;
      seen.add(`${r.kind}|${r.key}`);
      out.push(r);
    }
    return out.map((r, i) => ({ r, i })).sort((a, b) => {
      const p = (b.r.pinned ? 1 : 0) - (a.r.pinned ? 1 : 0);
      if (p) return p;
      const x = ms(a.r.at);
      const y = ms(b.r.at);
      const xn = Number.isNaN(x);
      const yn = Number.isNaN(y);
      if (xn !== yn) return xn ? 1 : -1;
      if (!xn && x !== y) return y - x;
      return a.i - b.i;
    }).map((x) => x.r);
  }
  const inFilter = (r, f) => Array.isArray(r.filters) && r.filters.includes(f);
  // The rows a chip shows now (the rule of the portions above).
  function shown(rows, f, cursor) {
    const mine = rows.filter((r) => inFilter(r, f));
    if (!cursor || (f !== ALL && f !== LEX)) return mine;
    const lex = rows.filter((r) => r.kind === 'lex' && !r.pinned).map((r) => ms(r.at)).filter((x) => !Number.isNaN(x));
    const edge = lex.length ? Math.min(...lex) : -Infinity;
    return mine.filter((r) => r.pinned || ms(r.at) >= edge);
  }
  // Something unread in a row now: the live numbers (LexSection.unread), the row's own until they came.
  function unreadOf(r) {
    const u = (global.LexSection && global.LexSection.unread()) || {};
    const known = Object.keys(u.chats || {}).length + Object.keys(u.orders || {}).length > 0;
    let n = null;
    if (r.kind === 'person' && r.line) {
      n = r.line.source === 'profi' ? (u.orders || {})[r.line.order] : (u.chats || {})[r.line.chatKey];
    } else if (r.kind === 'orders') n = (u.chats || {}).__lex_profi_orders__;
    else if (r.kind === 'bot') n = (u.chats || {}).__lex_profi_bot__;
    if (!known) n = r.unread;
    return Math.max(0, Math.floor(Number(n) || 0));
  }
  // The number of a chip (В7.48: a number only where people write): how many of its rows of people have something
  // unread; Waiting — how many rows wait; Lex — none.
  function chipCount(rows, f) {
    if (f === LEX) return 0;
    if (f === WAITING) return rows.filter((r) => inFilter(r, WAITING) && r.waiting).length;
    return rows.filter((r) => inFilter(r, f) && PEOPLE_KINDS.has(r.kind) && unreadOf(r) > 0).length;
  }

  // A read younger than this stands for «read on coming on the screen».
  const FRESH_MS = 5000;

  function create(deps) {
    const S = global.LexSection;
    const make = (tag, cls, text) => S.make(tag, cls, text);
    const iconBtn = (paths, label, onClick) => {
      const b = S.button('lex-section-icon lex-flow-btn', null, onClick);
      b.appendChild(S.markSvg(paths, 20, 2));
      b.title = label;
      b.setAttribute('aria-label', label);
      return b;
    };

    // ── the frame: the head, the tiles of the drawer, the chips, the list ────────
    const el = make('div', 'lex-flow lex-section');
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', 'Flow');
    const head = make('div', 'lex-flow-head');
    const backBtn = iconBtn(BACK, 'Back to Flow', () => closeArchive());
    const title = make('h2', 'lex-flow-title', 'Flow');
    const gap = make('span', 'lex-flow-gap');
    const gearBtn = iconBtn(GEAR, 'Profi.ru settings', () => deps.gear && deps.gear());
    const newBtn = iconBtn(S.RAIL_MARKS.pencil, 'New chat', () => deps.onNew && deps.onNew());
    head.append(backBtn, title, gap, gearBtn, newBtn);
    const tiles = make('div', 'lex-flow-tiles');
    S.entries(tiles, [
      { id: 'today', title: 'Today', mark: S.RAIL_MARKS.today },
      { id: 'new', title: 'New chat', mark: S.RAIL_MARKS.pencil },
    ], (id) => (id === 'today' ? deps.onToday && deps.onToday() : deps.onNew && deps.onNew()));
    tiles.setAttribute('aria-label', 'Today and a new chat');
    const chipsHost = make('div', 'lex-flow-chips');
    const body = make('div', 'lex-section-body lex-flow-body');
    el.append(head, tiles, chipsHost, body);

    let place = 'column';
    let sections = [];       // the people's sections the server named: [{ id, title, tab }], in its order
    let selected = null;
    let chosen = null;       // the chip pressed since «New chat» or a notification last put «All»
    let active = false;
    let answer = null;       // the first portion
    let more = [];           // the rows of the next portions
    let cursor = null;       // the next portion; null — no more
    let depth = 0;           // how many next portions were read
    let epoch = 0;           // a new first portion: a next portion asked before it is not taken
    let rows = [];
    let drawn = '';
    // Pin and Unpin of a chat of Lex, shown at once (as Mute is): key → { on, at }. `at` is the moment the server took the
    // press (Infinity while it is on its way); a read that left after it is the server's word and takes the mark off.
    const pins = new Map();
    const withPins = (list) => (!pins.size ? list : list.map((r) => {
      const o = r && r.kind === 'lex' ? pins.get(String(r.key)) : null;
      if (!o || !!r.pinned === o.on) return r;
      return Object.assign({}, r, { pinned: o.on, chat: r.chat ? Object.assign({}, r.chat, { pinned: o.on }) : r.chat });
    }));
    const mergePinned = () => merge({ rows: withPins((answer && answer.rows) || []) }, withPins(more));
    const drawnText = () => textOf([answer, more, cursor, [...pins]]);
    let picked = null;       // the key of the row of the chat open beside the list
    const titled = new Map();   // the names the server gave the conversations since the read
    const tops = new Map();     // the place of each chip's list
    let follower = null;
    let reading = null;
    let again = false;
    let moreReading = null;
    let moreFailed = false;
    let fails = 0;
    let againTimer = null;
    let wait = null;
    let archiveOpen = false;
    let archived = null;
    let archiveReading = null;

    const tabbed = () => sections.filter((s) => s.tab);
    const known = (id) => sections.length > 0 && (id === ALL || id === WAITING || id === LEX || tabbed().some((s) => s.id === id));
    const label = (t, n) => (n ? `${t} · ${n > 99 ? '99+' : n}` : t);
    const items = () => [
      { id: ALL, label: label('All', chipCount(rows, ALL)) },
      { id: WAITING, label: label('Waiting', chipCount(rows, WAITING)) },
      ...tabbed().map((s) => ({ id: s.id, label: label(s.title, chipCount(rows, s.id)) })),
      { id: LEX, label: 'Lex' },
    ];
    let chips = null;
    function paintChips() {
      if (!sections.length) { chips = null; chipsHost.replaceChildren(); return; }
      if (!chips) {
        chips = deps.tabs({ label: 'Filters', items: items(), selected, onSelect: (id) => select(id) });
        chipsHost.replaceChildren(chips);
      } else chips.update(items(), selected);
    }
    function paintHead() {
      const gear = !archiveOpen && selected === 'profi' && !!deps.gear;
      title.textContent = archiveOpen ? 'Archived' : 'Flow';
      backBtn.hidden = !archiveOpen;
      gearBtn.hidden = !gear;
      newBtn.hidden = place !== 'column' || archiveOpen;
      // The drawer has the tiles in place of the head: the head stands there only for the archive and the gear.
      head.hidden = place === 'drawer' && !archiveOpen && !gear;
      tiles.hidden = place !== 'drawer';
    }

    // ── the lines ───────────────────────────────────────────────────────────────
    const fail = (text) => deps.notify && deps.notify(text);
    const after = () => { reload().catch(() => {}); if (archiveOpen) readArchived(); };
    const lexItems = new Map();
    const lex = deps.lexRows ? deps.lexRows({
      host: () => body, items: () => [...lexItems.values()], active: () => picked, rerender: () => paint(),
      archiveKnown: () => true, hooks: deps.lexHooks, look: 'flow',
    }) : null;

    // A chat of a person: drawn and opened by the section that holds its chat — a chat of a folder by its folder, also
    // when it stands under another chip (a client's group under «Clients», client_group_chat.sql). from — 'flow' (this
    // list) or 'people' (the blocks «Today», `line`).
    function personLine(c, from) {
      const live = deps.live(c.source === 'folder' && c.folder ? `folder:${c.folder}` : c.tab);
      if (!live || !live.line) return null;
      return live.line(c, { from, fail, feed: (order) => deps.showFeed(order), after });
    }
    // «New orders» (19.11.2026): the mark of Профи.ру, the last order, how many are sending.
    function ordersRow(r) {
      const feed = (answer && answer.feed && typeof answer.feed === 'object') ? answer.feed : {};
      return S.row({
        lead: global.LexMessage.avatarMark('profi', 48),
        title: feed.title || r.title || 'New orders', sub: feed.last || oneLine(r.sub) || 'Nothing yet.', strong: true,
        mark: feed.active ? `${feed.active} sending` : '', time: S.listTime(r.at), pinned: !!r.pinned,
        onClick: () => deps.showFeed(null), unread: { chat: '__lex_profi_orders__', number: true },
      });
    }
    // The bot's service chat (19.11.2026): the mark of Lex, its last message.
    function botRow(r) {
      return S.row({
        lead: global.LexMessage.avatarBrand(48),
        title: r.title || 'Агент Профи', sub: oneLine(r.sub) || 'Nothing yet.', strong: true,
        time: S.listTime(r.at), pinned: !!r.pinned,
        onClick: () => deps.showBot(), unread: { chat: '__lex_profi_bot__', number: true },
      });
    }
    // «Questions»: the sign of the section, the last question; a section has a dot, never a number (В7.48).
    function questionsRow(r) {
      return S.row({
        lead: S.sectionFace('questions', { size: 48 }),
        title: 'Questions', sub: oneLine(r.sub), time: S.listTime(r.at),
        onClick: () => deps.openQuestions(), unread: { section: 'questions' },
      });
    }
    // A task chat of an agent: the line of its folder, with the face of the agent and its name as the title.
    function agentRow(r) {
      const a = r.agent || {};
      const key = a.key || (r.face && r.face.agent) || '';
      const who = { key, name: a.name || r.title || key };
      const c = {
        chatKey: r.key, title: who.name, state: a.state || 'working', last: r.sub, stage: a.stage || null,
        stageText: a.stageText || null, at: r.at, archived: !!r.archived,
      };
      const open = () => deps.openAgent(who, r.key);
      const line = deps.agentLine ? deps.agentLine(c, { agent: who, lead: S.agentFace(key, { size: 48 }), open, after }) : null;
      return line || S.agentRow({
        key, name: who.name, time: S.listTime(r.at), state: c.state === 'waiting' ? 'waiting' : 'working',
        text: oneLine(r.sub), unread: Number(r.unread) || 0, id: r.key, onClick: open,
      });
    }
    function lexRow(r) {
      if (!lex || !deps.itemOf || !r.chat) return null;
      const it = deps.itemOf(r.chat, !!r.archived);
      if (titled.has(it.id)) { it.title = titled.get(it.id); it.titlePending = false; }
      lexItems.set(it.id, it);
      return lex.row(it);
    }
    function lineOf(r) {
      try {
        let line = null;
        if (r.kind === 'person') line = r.line ? personLine(r.line, 'flow') : null;
        else if (r.kind === 'orders') line = ordersRow(r);
        else if (r.kind === 'bot') line = botRow(r);
        else if (r.kind === 'questions') line = questionsRow(r);
        else if (r.kind === 'agent') line = agentRow(r);
        else if (r.kind === 'lex') line = lexRow(r);
        if (line) line.dataset.flowKey = String(r.key);
        return line;
      } catch (e) {
        console.warn('[flow] line:', r && r.kind, e && e.message);
        return null;
      }
    }

    // ── the Archive ─────────────────────────────────────────────────────────────
    // How many archived chats the chip has: «All» — the three archives, «Lex» — the chats of Lex, a chip of people — its
    // archived chats; Waiting — none.
    function archivedCount() {
      const a = answer && answer.archived;
      if (!a || typeof a !== 'object') return 0;
      const p = (a.people && typeof a.people === 'object') ? a.people : {};
      const n = (x) => Math.max(0, Math.floor(Number(x) || 0));
      if (selected === ALL) return n(p.count) + n(a.lex) + n(a.agents);
      if (selected === LEX) return n(a.lex);
      if (selected === WAITING) return 0;
      return n((p.tabs || {})[selected]);
    }
    function archivedRow(nArchived) {
      const r = S.row({
        lead: S.sectionFace('archive', { size: 48 }),
        title: 'Archived', time: String(nArchived), onClick: () => openArchive(),
      });
      r.classList.add('lex-flow-archived');
      return r;
    }
    function openArchive() {
      tops.set(selected, body.scrollTop);
      archiveOpen = true;
      archived = null;
      paint();
      body.scrollTop = 0;
      readArchived();
    }
    function closeArchive(quiet) {
      if (!archiveOpen) return;
      archiveOpen = false;
      archived = null;
      if (!quiet) { paint(); body.scrollTop = tops.get(selected) || 0; }
    }
    function readArchived() {
      if (archiveReading) return archiveReading;
      const want = selected;
      archiveReading = Promise.resolve(deps.rpc('lex_flow_archived', { p_filter: want })).then((v) => {
        if (!archiveOpen || want !== selected) return;
        archived = valid(v) ? v.rows : [];
        paint();
      }).catch((e) => console.warn('[flow] archive:', e && e.message))
        .finally(() => { archiveReading = null; });
      return archiveReading;
    }
    function paintArchive() {
      const list = make('div', 'lex-section-list');
      for (const r of archived || []) {
        const line = lineOf(r);
        if (line) list.appendChild(line);
      }
      if (list.children.length) body.appendChild(list);
      else if (archived) body.appendChild(make('div', 'lex-section-empty', 'No archived chats.'));
    }

    // ── the list ────────────────────────────────────────────────────────────────
    // There is no red line over this list (Gennady, 20.11.2026): a monitor that stopped is told by the bot's alert in its
    // own chat, and a list that did not load keeps the copy on the screen.
    function paint() {
      paintHead();
      paintChips();
      const top = body.scrollTop;
      if (!selected || !answer) return;
      body.replaceChildren();
      lexItems.clear();
      if (archiveOpen) { paintArchive(); markPicked(false); return; }
      const list = make('div', 'lex-section-list');
      const nArchived = archivedCount();
      if (nArchived) list.appendChild(archivedRow(nArchived));
      for (const r of shown(rows, selected, cursor)) {
        const line = lineOf(r);
        if (line) list.appendChild(line);
      }
      if (list.children.length) body.appendChild(list);
      else body.appendChild(make('div', 'lex-section-empty', 'No chats here yet.'));
      body.scrollTop = top;
      markPicked(false);
      // A portion came and the list is still shorter than its place: no scroll will ask for the next one.
      if (cursor && body.clientHeight && body.scrollHeight <= body.clientHeight + 4) loadMore();
      if (deps.fillTitles) {
        const pending = [...lexItems.values()].filter((it) => it.titlePending);
        if (pending.length) deps.fillTitles(pending);
      }
    }
    function markPicked(reveal) {
      let on = null;
      body.querySelectorAll('[data-flow-key]').forEach((n) => {
        const yes = picked != null && n.dataset.flowKey === String(picked);
        n.classList.toggle('is-picked', yes);
        if (yes) { n.setAttribute('aria-current', 'true'); on = n; } else n.removeAttribute('aria-current');
      });
      // Only the column brings the row into view: the drawer, closed, is off the screen and keeps its own place.
      if (reveal && on && place === 'column' && typeof on.scrollIntoView === 'function' && body.offsetParent) on.scrollIntoView({ block: 'nearest' });
    }

    function commit(first, extra, cur, leftAt) {
      epoch += 1;
      answer = first;
      more = extra;
      cursor = cur || null;
      moreFailed = false;
      for (const [key, o] of pins) if (leftAt > o.at) pins.delete(key);
      rows = mergePinned();
      const text = drawnText();
      if (text !== null && text === drawn) return;
      drawn = text;
      if (wait) { const w = wait; wait = null; w.done(paint); } else paint();
      if (archiveOpen) readArchived();
      // The chat open beside the list came in with this read but stands below the portions loaded: read down to it.
      if (picked != null && !shown(rows, selected, cursor).some((r) => String(r.key) === picked)) seek(picked);
    }

    // The next portion of the chats of Lex, while scrolling (one at a time; a failure stops it till the next read).
    function loadMore() {
      if (moreReading || reading || !cursor || moreFailed || archiveOpen) return moreReading || reading || null;
      const mine = epoch;
      const at = cursor;
      moreReading = Promise.resolve(deps.rpc('lex_flow', { p_filter: ALL, p_cursor_at: at.at, p_cursor_id: at.id }))
        .then((r) => {
          if (mine !== epoch || !valid(r)) return;
          more = more.concat(r.rows);
          cursor = r.cursor || null;
          depth += 1;
          rows = mergePinned();
          drawn = drawnText();
          paint();
        })
        .catch((e) => { moreFailed = true; console.warn('[flow] portion:', e && e.message); })
        // A scroll to the end while this portion was read asks again here: no scroll may come after it.
        .finally(() => { moreReading = null; if (nearEnd()) loadMore(); });
      return moreReading;
    }
    // The row of the chat open beside the list may stand below the last chat of Lex loaded (the rule of the portions keeps
    // it out of «All» till then): the portions are read down to it, at most ten, and the column brings it into view.
    let seeking = 0;
    async function seek(key) {
      const mine = ++seeking;
      for (let i = 0; i <= 10; i += 1) {
        if (mine !== seeking || picked !== key || !rows.some((r) => String(r.key) === key)) return;
        if (shown(rows, selected, cursor).some((r) => String(r.key) === key)) { markPicked(true); return; }
        if (!cursor || moreFailed || archiveOpen) return;
        try { await loadMore(); } catch (_) { return; }
      }
    }
    // The end of the list is near (half a screen) on a list on the screen that scrolls: the next portion is wanted. A
    // short list (a filter of a few rows) asks for no portion, as before: no scroll comes on it.
    const nearEnd = () => !!cursor && !archiveOpen && body.clientHeight > 0 && body.scrollHeight > body.clientHeight + 1
      && body.scrollHeight - body.scrollTop - body.clientHeight < body.clientHeight * 0.5;
    body.addEventListener('scroll', () => { if (nearEnd()) loadMore(); }, { passive: true });

    // ── reading ─────────────────────────────────────────────────────────────────
    // join — a read in flight already answers the ask (the list came on the screen while warm() was reading): no second
    // read after it. A signal of the base never joins: what changed may have come after the read in flight left.
    let readAt = 0;
    let readLeft = 0;          // when the last read that answered left for the server
    let offAt = Date.now();     // when Flow last went off the screen (it hears no signal while off)
    function reload(join) {
      if (reading) { if (join !== true) again = true; return reading; }
      const L = global.LexSkeleton;
      if (wait && wait.phase() !== 'failed') { wait.stop(); wait = null; }
      if (!answer && L && !wait) {
        wait = L.ladder(body, {
          skeleton: () => L.list(L.chatRow, 6),
          shown: () => !!body.offsetParent,
          retry: () => { if (wait) { wait.stop(); wait = null; } reload(); },
        });
      }
      const leftAt = Date.now();
      reading = (async () => {
        const first = await deps.read('lex_flow', { p_filter: ALL }, (v, fresh) => {
          // The copy draws the first frame; it never covers a list on the screen.
          if (!fresh && !answer && valid(v)) commit(v, [], v.cursor, 0);
        });
        if (!valid(first)) throw new Error('no answer');
        // As many portions as were on the screen, so the list does not shrink.
        let extra = [];
        let cur = first.cursor || null;
        try {
          for (let i = 0; i < depth && cur; i += 1) {
            const r = await deps.rpc('lex_flow', { p_filter: ALL, p_cursor_at: cur.at, p_cursor_id: cur.id });
            if (!valid(r)) break;
            extra = extra.concat(r.rows);
            cur = r.cursor || null;
          }
        } catch (e) {
          console.warn('[flow] portions again:', e && e.message);
          extra = more;
          cur = cursor;
        }
        commit(first, extra, cur, leftAt);
      })().then(() => {
        fails = 0;
        readAt = Date.now();
        readLeft = leftAt;
        stopAgain();
      }, (e) => {
        if (wait) wait.fail();
        console.warn('[flow] read:', e && e.message);
        readAgain();
      }).finally(() => {
        reading = null;
        if (again) { again = false; reload(); }
        // A scroll to the end during the read was dropped (no portion while the list reads): it is asked again now.
        else if (nearEnd()) loadMore();
      });
      return reading;
    }
    function stopAgain() {
      if (againTimer) { clearTimeout(againTimer); againTimer = null; }
    }
    function readAgain() {
      // One rung per retry: a failure while a retry already waits (a re-read asked by a signal) does not climb the ladder.
      if (againTimer || !follower) return;
      fails += 1;
      const ladder = S.AGAIN_MS;
      againTimer = setTimeout(() => { againTimer = null; if (follower) reload(); }, ladder[Math.min(fails - 1, ladder.length - 1)]);
    }
    function watch() {
      if (follower || !deps.signals) return;
      follower = deps.signals.follow(EVENTS, () => reload(), {});
    }
    function unwatch() {
      if (follower) offAt = Date.now();
      if (follower) follower.stop();
      follower = null;
      stopAgain();
      fails = 0;
    }
    function sync(fresh) {
      const on = active && !!selected;
      // On the screen again: read anew, unless a read has just answered (warm() at the start, ~0.5 s on the server) or
      // one is in flight — one read at the start, not two. A read that left before Flow went off the screen does not
      // count: a signal it missed while off (a chat opened and read beside the closed drawer) is read now.
      const recent = readLeft >= offAt && Date.now() - readAt <= FRESH_MS;
      if (on) { watch(); if (!answer || (fresh && !recent)) reload(true); } else unwatch();
    }

    // ── what the window says ────────────────────────────────────────────────────
    function select(id, quiet) {
      if (!known(id)) id = sections.length ? ALL : null;
      if (id !== selected && selected) tops.set(selected, body.scrollTop);
      const changed = id !== selected;
      selected = id;
      if (!quiet && id) chosen = id;
      if (changed && archiveOpen) closeArchive(true);
      paint();
      if (changed) body.scrollTop = tops.get(selected) || 0;
      sync(false);
    }

    return {
      el,
      // The place of the part: the column of a wide window ('column') or the drawer of a narrow one ('drawer').
      mount(host, where) {
        const top = body.scrollTop;
        place = where === 'drawer' ? 'drawer' : 'column';
        if (host && el.parentNode !== host) host.appendChild(el);
        el.classList.toggle('is-drawer', place === 'drawer');
        paintHead();
        body.scrollTop = top;
      },
      get place() { return place; },
      get selected() { return selected; },
      // The account has chats with people (decision 14): «Today» and «Flow» are its.
      get hasPeople() { return sections.length > 0; },
      get hasTabs() { return sections.length > 0; },
      setSections(list) {
        sections = (Array.isArray(list) ? list : []).filter((s) => s && isPeopleSection(s.id))
          .map((s) => ({ id: s.id, title: s.title || s.id, tab: s.tab !== false }));
        select(known(chosen) ? chosen : ALL, true);
      },
      select,
      // «New chat» and a notification: «All», at its top.
      toAll() {
        chosen = null;
        closeArchive(true);
        tops.set(ALL, 0);
        select(ALL, true);
        body.scrollTop = 0;
      },
      setActive(on) {
        if (active === !!on) return;
        const top = tops.get(`shown:${selected}`);
        if (!on) tops.set(`shown:${selected}`, body.scrollTop);
        active = !!on;
        sync(true);
        if (active && top != null) body.scrollTop = top;
      },
      get archiveOpen() { return archiveOpen; },
      // Flow is on the screen (the column, or the drawer open) and follows the server.
      get active() { return active; },
      closeArchive() { closeArchive(); },
      // The numbers of the unread came: the chips count again (the lines repaint their own slots).
      repaintChips() { if (sections.length) paintChips(); },
      // The read of the start: a read in flight (the list came on the screen first) answers it.
      warm() { return reload(true); },
      reload,
      // Pin or Unpin of a chat of Lex from its menu, at once: on — true or false while the press is on its way; 'sent' —
      // the server took it (the next read confirms it); null — the server refused, the server's state again.
      markPinned(key, on) {
        const k = String(key);
        if (on === 'sent') { const o = pins.get(k); if (o) o.at = Date.now(); return; }
        if (on === null) pins.delete(k); else pins.set(k, { on: !!on, at: Infinity });
        if (!answer) return;
        rows = mergePinned();
        drawn = drawnText();
        paint();
      },
      // The chat open beside the list: its row stands picked.
      pick(key) {
        const was = picked;
        picked = key == null ? null : String(key);
        markPicked(picked !== was);
        if (picked != null && picked !== was) seek(picked);
      },
      // The server named conversations (WC_TITLES_FILLED): { id → title }.
      titles(map) {
        let hit = false;
        for (const [id, t] of map) { titled.set(id, t); if (lexItems.has(id)) hit = true; }
        if (hit) paint();
      },
      // The line of one chat of a person (an element of people_home), drawn and opened by its section: the blocks
      // «Today» draw the chats that wait for Gennady with it (lex-today.js). null — no section.
      line: (c) => (c && typeof c === 'object' ? personLine(c, 'people') : null),
      isPeople: isPeopleSection,
    };
  }

  // The pure rules, for the check of the part (dev-tools/test-lex-flow.mjs).
  global.LexFlow = { create, isPeopleSection, merge, shown, chipCount, CHIPS: { ALL, WAITING, LEX } };
})(typeof window !== 'undefined' ? window : globalThis);
