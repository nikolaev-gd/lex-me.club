// lex-today.js — the blocks «Today» over the tabs of the main page of the people, on the page and in the Mac app
// (iteration 1 of docs/PLAN-HOME-TODAY-FLOW.md; docs/spec/20-chat.md, «Главная страница: чаты людей», «Блоки
// «Сегодня»»). Two cards, the same on every tab: «Waiting for you» — what waits for Gennady, the freshest first, three
// lines and «Show all N»; «Day» — what is left of today in the calendar, the nearest one in the colour of «look here»,
// and the line of the shopping list. The iPhone draws the same over its tabs (PeopleHome.swift, Parts/TodayCard.swift).
//
// The data is one answer of the edge function today (GET /functions/v1/today; its contract —
// dev-tools/fixtures/today-answer.json): the copy kept on the device draws the first frame, the server's answer takes
// its place (lex-reads.js, `today`). The blocks follow the signals of the database through the frame of a section
// (LexSection.createFrame: watch, lookNow, the ladder of a failed read), only while the main page is on the screen —
// no timer. Every part fails on its own: a part the server could not read (null, or named in `failed`) keeps what
// the screen showed of it; nothing shown yet — that part draws nothing (never «Nothing is waiting» for a part that did
// not answer). A kept copy of another day (by Moscow) draws no events; an event over by the time of the drawing is not
// drawn. The service only reads: nothing here marks anything read.
//
// A line opens what its own place opens: a chat of a person — its section's line (lex-people.js line, the same press as
// in the list), an agent — its task chat over its folder (as the section Agents does), «New orders» — the chat of new
// orders, «Questions» — the feed of questions; «Calendar ›» and a line of the day — the section Calendar, the line of
// the shopping list — the section Shopping list.
//
// create(deps) — deps:
//   host                 the element the cards stand in (a `.lex-section`, out of the list of the people)
//   read(show)           the window's way of reading `today`: the copy first, the answer after (LexReads.twice)
//   signals              the channel of the database's signals (lex-account-events.js)
//   line(c)              the line of a chat of a person (lex-people.js line), or null
//   openAgent(key, chatKey)  the task chat of an agent over its folder
//   showFeed()           the chat of new orders
//   openQuestions()      the feed of questions
//   openCalendar(at)     the section Calendar (at — the start of an event pressed, ms, or null)
//   openShopping()       the section Shopping list
//   onShown(on)          the cards stand on the screen or not (the window makes room for them)
// create(deps) gives: setActive(on), warm(), lookNow(), shown, answer.
(function (global) {
  'use strict';

  // The signals of the sources (docs/PLAN-HOME-TODAY-FLOW.md, «Под капотом»): the chats of the people (unread, chats,
  // profi, folders), the questions (em), the calendar and the shopping list, and those the section Agents reads again
  // on (webchat/wc-agents.js: folders, unread, agent_screen).
  const EVENTS = ['unread', 'chats', 'profi', 'folders', 'em', 'calendar', 'shopping', 'agent_screen'];
  const FOLD = 3;
  const DAY_MAX = 3;

  // The day of Moscow, 'YYYY-MM-DD' (the day of the answer is Moscow's: `day.day`).
  let moscow = null;
  function moscowDay(at) {
    const d = at instanceof Date ? at : new Date(at);
    try {
      if (!moscow) moscow = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' });
      const p = Object.fromEntries(moscow.formatToParts(d).map((x) => [x.type, x.value]));
      return `${p.year}-${p.month}-${p.day}`;
    } catch (_) {
      // No zone database: Moscow is UTC+3 all the year.
      return new Date(d.getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10);
    }
  }
  const ms = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : null; };
  const pad = (n) => String(n).padStart(2, '0');
  // The time as the calendar writes it (wc-calendar.js hm): the device's own clock.
  const hm = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

  // The events to draw now: none from a copy of another day; none that is over (its end, or its start when it has no
  // end); at most three, in the server's order. The first is the nearest.
  function dayEvents(day, now) {
    if (!day || typeof day !== 'object' || !Array.isArray(day.events)) return [];
    const t = now instanceof Date ? now.getTime() : Number(now);
    if (day.day !== moscowDay(t)) return [];
    return day.events.filter((e) => {
      if (!e || typeof e !== 'object') return false;
      const start = ms(e.at);
      // An event of the whole day without an end lasts the day of its start.
      const end = ms(e.end) != null ? ms(e.end) : (e.all_day === true && start != null ? start + 24 * 3600 * 1000 : start);
      return end != null && end > t;
    }).slice(0, DAY_MAX);
  }
  // The day of the answer is today: its events say something of today (a copy of another day says nothing).
  const isToday = (day, now) => !!(day && typeof day === 'object' && day.day === moscowDay(now));

  // The parts of an answer taken into what the screen holds: a part that failed keeps what was there. The agents fail
  // on their own inside «waiting» (`failed` names "agents", the rest of «waiting» came): the agents' lines the screen
  // held stay among the new ones, by their time.
  const PARTS = ['waiting', 'day', 'shopping'];
  const timeOf = (r) => ms(r && r.at) || 0;
  function merge(held, v) {
    const out = Object.assign({}, held || {});
    const failed = new Set(Array.isArray(v && v.failed) ? v.failed.map(String) : []);
    for (const k of PARTS) {
      if (v && v[k] != null && typeof v[k] === 'object' && !failed.has(k)) out[k] = v[k];
    }
    const before = held && held.waiting && Array.isArray(held.waiting.rows) ? held.waiting.rows : [];
    if (failed.has('agents') && !failed.has('waiting') && out.waiting && out.waiting !== (held && held.waiting)) {
      const kept = before.filter((r) => r && r.kind === 'agent');
      const rows = (Array.isArray(out.waiting.rows) ? out.waiting.rows : []).filter((r) => !(r && r.kind === 'agent'));
      const all = rows.concat(kept).sort((a, b) => timeOf(b) - timeOf(a));
      out.waiting = Object.assign({}, out.waiting, { rows: all, count: (Number(out.waiting.count) || rows.length) + kept.length });
    }
    if (v && v.sections && typeof v.sections === 'object') out.sections = v.sections;
    if (v && v.at) out.at = v.at;
    return out;
  }

  function create(deps) {
    const S = global.LexSection;
    const host = deps.host;
    let active = false;
    let held = null;        // what the screen holds: { sections, waiting, day, shopping }, parts merged by merge()
    let drawn = '';         // the last answer drawn, as text: an equal answer draws nothing again
    let open = false;       // «Show all N» pressed
    let shown = false;
    const textOf = (v) => { try { return JSON.stringify(v); } catch (_) { return null; } };

    // ── the lines of «Waiting for you» ────────────────────────────────────────
    const at = (r) => (r && r.at ? S.listTime(r.at) : '');
    const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    function waitLine(r) {
      if (!r || typeof r !== 'object') return null;
      try {
        if (r.kind === 'person') return r.line && deps.line ? deps.line(r.line) : null;
        if (r.kind === 'agent') {
          const key = (r.face && r.face.agent) || r.key;
          return S.agentRow({
            key, name: r.title || key, time: at(r), state: 'waiting', text: oneLine(r.sub),
            unread: Number(r.unread) || 0, id: `today:${r.chatKey || key}`,
            onClick: () => deps.openAgent(key, r.chatKey || null),
          });
        }
        if (r.kind === 'orders') {
          // The line «New orders» of the main page (lex-people.js): the mark of Профи.ру, its number of the unread.
          return S.row({
            lead: global.LexMessage.avatarMark('profi', 48),
            title: r.title || 'New orders', sub: oneLine(r.sub) || 'Nothing yet.', strong: true,
            onClick: () => deps.showFeed(), unread: { chat: '__lex_profi_orders__', number: true },
          });
        }
        if (r.kind === 'questions') {
          // The section's sign, its title and the last question; a section has a dot, never a number (В7.48).
          return S.row({
            lead: S.sectionFace('questions', { size: 48 }),
            title: 'Questions', sub: oneLine(r.sub), time: at(r),
            onClick: () => deps.openQuestions(), unread: { section: 'questions' },
          });
        }
      } catch (e) {
        console.warn('[today] line:', r.kind, e && e.message);
      }
      return null;
    }
    function waitingCard(w) {
      const rows = (Array.isArray(w.rows) ? w.rows : []).map(waitLine).filter(Boolean);
      const count = Number.isFinite(Number(w.count)) ? Number(w.count) : rows.length;
      return S.todayCard({
        title: 'Waiting for you', count, rows, empty: 'Nothing is waiting for you.', fold: FOLD, open,
        onToggle: (on) => { open = on; },
      });
    }

    // ── «Day» ─────────────────────────────────────────────────────────────────
    function dayCard(day, shopping, sections, now) {
      const rows = [];
      const today = isToday(day, now);
      const list = dayEvents(day, now);
      // The nearest: the first with an hour; an event of the whole day is not «next» while one with an hour is there.
      const timed = list.findIndex((e) => e.all_day !== true);
      const nearest = timed >= 0 ? timed : 0;
      list.forEach((e, i) => {
        const start = ms(e.at);
        const time = e.all_day === true ? 'all day' : hm(start);
        rows.push(S.dayLine({
          time, title: oneLine(e.title), now: i === nearest,
          label: `${time}, ${oneLine(e.title)}${i === nearest ? ', next' : ''}`,
          onClick: () => deps.openCalendar(null),   // the day of today, as on the iPhone (TodayBlocks.swift)
        }));
      });
      const events = rows.length;
      if (sections.shopping !== false && shopping && Number(shopping.count) > 0) {
        rows.push(S.shoppingLine({ count: shopping.count, first: shopping.first, onClick: () => deps.openShopping() }));
      }
      const card = S.todayCard({
        title: 'Day', link: { label: 'Calendar', onClick: () => deps.openCalendar(null) },
        rows, fold: rows.length,
      });
      // Nothing left today — the grey line under the head, the shopping list under it; a copy of another day says
      // nothing of today, and the line is not written.
      if (!events && today) {
        const empty = S.make('div', 'lex-today-empty', 'Nothing else today.');
        card.insertBefore(empty, card.querySelector('.lex-today-rows'));
      }
      return card;
    }

    function paint() {
      const cards = [];
      if (active && held) {
        const sections = held.sections && typeof held.sections === 'object' ? held.sections : {};
        const now = new Date();
        if (held.waiting) cards.push(waitingCard(held.waiting));
        if (sections.calendar !== false && held.day) cards.push(dayCard(held.day, held.shopping, sections, now));
      }
      host.replaceChildren(...cards);
      const on = cards.length > 0;
      host.hidden = !on;
      if (on !== shown) {
        shown = on;
        if (deps.onShown) deps.onShown(on);
      }
    }

    // ── reading ───────────────────────────────────────────────────────────────
    let reading = null;
    function reload() {
      if (reading) return reading;
      reading = Promise.resolve(deps.read((v, isFresh) => {
        if (!v || typeof v !== 'object') return;
        // The copy draws the first frame only while the screen holds nothing; the server's answer takes its place.
        if (!isFresh && held) return;
        const text = textOf(v);
        if (isFresh && text !== null && text === drawn) return;
        held = merge(held, v);
        if (isFresh) drawn = text;
        paint();
      })).finally(() => { reading = null; });
      return reading;
    }

    // The frame of a section is the watch: a signal of a source — a look; the channel back after a break — a look; a
    // look that failed is tried again after the pauses of the ladder, silently. Its element is never shown.
    const frame = S.createFrame({ title: 'Today', signals: deps.signals, events: EVENTS, check: () => reload() });

    return {
      // The main page is on the screen: the blocks stand and follow the server; off — they go and stop following.
      setActive(on) {
        on = !!on;
        if (active === on) return;
        active = on;
        if (on) {
          frame.watch();
          // What the screen held is drawn again first: an event over since the last drawing goes.
          paint();
          reload().catch((e) => { console.warn('[today] read:', e && e.message); frame.lookNow(); });
        } else {
          frame.unwatch();
          paint();
        }
      },
      // Read at the start, so that the first showing of the main page has the blocks.
      warm() { return reload().catch((e) => console.warn('[today] warm:', e && e.message)); },
      lookNow() { if (active) frame.lookNow(); },
      get shown() { return shown; },
      get answer() { return held; },
    };
  }

  global.LexToday = { create, dayEvents, moscowDay, merge, EVENTS };
})(typeof window !== 'undefined' ? window : globalThis);
