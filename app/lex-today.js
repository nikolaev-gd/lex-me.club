// lex-today.js — the blocks «Today» over the tabs of the main page of the people, on the page and in the Mac app
// (iteration 1 of docs/PLAN-HOME-TODAY-FLOW.md; docs/spec/20-chat.md, «Главная страница: чаты людей», «Блоки
// «Сегодня»»). Two cards, the same on every tab: «Waiting for you» — what waits for Gennady, the freshest first, three
// lines and «Show all N»; «Day» — what is left of today in the calendar, the nearest one in the colour of «look here»,
// and the line of the shopping list. The iPhone draws the same over its tabs (PeopleHome.swift, Parts/TodayCard.swift).
//
// The data is one answer of the edge function today (GET /functions/v1/today; its contract —
// dev-tools/fixtures/today-answer.json): the copy kept on the device draws the first frame, the server's answer takes
// its place (lex-reads.js, `today`). The place of the blocks holds from the first showing, and the list under them does not
// move while they come: nothing known yet (the copy and the answer on their way, or no copy at all) — two empty cards
// (LexSection.todayPlace) stand at the height of the folded blocks at their fullest; what comes into that place keeps the
// area at least that high while the main page stays on the screen (`hold`), from the next showing it hugs the cards.
// The empty place climbs the one ladder of loading (lex-skeleton.js, В7.87): from 500 ms the skeletons of the two
// cards stand in it at the same heights (LexSkeleton.todayCard), the word of the head comes at 3 s; what comes takes
// their place by a fade of 120 ms, and nothing under them moves.
// Nothing to show once something is known (an answer with no part, a read that failed with no copy) — the held place
// stands empty while the page is on the screen, and from the next showing there are no blocks. The blocks follow the signals of the database through the frame of a section
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
// and for the board (a wide window, below):
//   head(node | null)    the head of the board (LexSection.boardHead) into the bar of the window, or out of it
//   openAgents()         the section Agents, on its list
//   openNews(row)        a letter of News (a row of `news.rows`: its first unread card `card` opens its chat)
//   checkShopping(id, done)  the purchase marked bought (or not) — the same change as the section Shopping list makes
// create(deps) gives: setActive(on), setLayout('blocks' | 'board'), warm(), lookNow(), shown, answer, layout.
//
// The board (iteration 2 of docs/PLAN-HOME-TODAY-FLOW.md; docs/spec/20-chat.md, «Главная на компьютере») is the same
// read, the same answer and the same signals drawn on the whole window of 900 and wider: three columns of cards with
// nothing folded — «Waiting for you», all of it; «Day», the whole day by the hours (what is over in the colours of what
// is not looked at now) and under it «Shopping list · N» with every purchase to buy and its circle; «Agents» (the agents
// at work with their stage, then what they did without Gennady since the start of the day) and «News» (the unread
// letters, only when there are some). Its head — the date of Moscow and «Today» — stands in the bar of the window.
(function (global) {
  'use strict';

  // The signals of the sources (docs/PLAN-HOME-TODAY-FLOW.md, «Под капотом»): the chats of the people (unread, chats,
  // profi, folders), the questions (em), the calendar and the shopping list, and those the section Agents reads again
  // on (webchat/wc-agents.js: folders, unread, agent_screen).
  // The board reads on the signal of News too (lex-news.js: news).
  const EVENTS = ['unread', 'chats', 'profi', 'folders', 'em', 'calendar', 'shopping', 'agent_screen', 'news'];
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
      const end = start == null ? null : endOf(e);
      return end != null && end > t;
    }).slice(0, DAY_MAX);
  }
  // The day of the answer is today: its events say something of today (a copy of another day says nothing).
  const isToday = (day, now) => !!(day && typeof day === 'object' && day.day === moscowDay(now));
  // The end of an event: its end; an event of the whole day without one lasts the day of its start; else its start.
  const endOf = (e) => {
    const start = ms(e.at);
    return ms(e.end) != null ? ms(e.end) : (e.all_day === true && start != null ? start + 24 * 3600 * 1000 : start);
  };
  // The board's day: every event of today, the past ones too (`day.all`; an older answer has only what is left —
  // `day.events`), each with `past`. None from a copy of another day.
  function dayAll(day, now) {
    if (!day || typeof day !== 'object') return [];
    const t = now instanceof Date ? now.getTime() : Number(now);
    if (day.day !== moscowDay(t)) return [];
    const list = Array.isArray(day.all) ? day.all : (Array.isArray(day.events) ? day.events : []);
    return list.filter((e) => e && typeof e === 'object' && ms(e.at) != null).map((e) => {
      const end = endOf(e);
      return Object.assign({}, e, { past: end != null && end <= t });
    });
  }
  // «Friday, 27 November»: the day of Moscow in English words.
  let moscowWords = null;
  function dayWords(at) {
    const d = at instanceof Date ? at : new Date(at);
    try {
      if (!moscowWords) moscowWords = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Moscow', weekday: 'long', day: 'numeric', month: 'long' });
      const p = Object.fromEntries(moscowWords.formatToParts(d).map((x) => [x.type, x.value]));
      return `${p.weekday}, ${p.day} ${p.month}`;
    } catch (_) {
      const m = new Date(d.getTime() + 3 * 3600 * 1000);
      const W = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const M = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
      return `${W[m.getUTCDay()]}, ${m.getUTCDate()} ${M[m.getUTCMonth()]}`;
    }
  }

  // The parts of an answer taken into what the screen holds: a part that failed keeps what was there. The agents fail
  // on their own inside «waiting» (`failed` names "agents", the rest of «waiting» came): the agents' lines the screen
  // held stay among the new ones, by their time — and the part `agents` of the board stays as it was too.
  const PARTS = ['waiting', 'day', 'shopping', 'news', 'agents'];
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
    let layout = 'blocks';  // 'blocks' — over the list of the people; 'board' — the board on the whole window
    let held = null;        // what the screen holds: { sections, waiting, day, shopping, news, agents }, by merge()
    const ticked = new Set();   // the purchases marked on the board, drawn bought until an answer no longer has them
    let drawn = '';         // the last answer drawn, as text: an equal answer draws nothing again
    let open = false;       // «Show all N» pressed
    let shown = false;
    let settled = false;    // something is known: a copy or an answer came, or the read failed — the empty place goes
    let hold = 0;           // the height (px) the empty place stood at, while this showing of the main page lasts
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

    // ── the board ─────────────────────────────────────────────────────────────
    function boardDay(day, shopping, sections, now) {
      const rows = [];
      const list = sections.calendar !== false ? dayAll(day, now) : [];
      const ahead = list.findIndex((e) => !e.past && e.all_day !== true);
      const nearest = ahead >= 0 ? ahead : list.findIndex((e) => !e.past);
      list.forEach((e, i) => {
        const time = e.all_day === true ? 'all day' : hm(ms(e.at));
        rows.push(S.dayLine({
          time, title: oneLine(e.title), now: i === nearest, past: e.past,
          label: `${time}, ${oneLine(e.title)}${i === nearest ? ', next' : ''}${e.past ? ', over' : ''}`,
          onClick: () => deps.openCalendar(ms(e.at)),
        }));
      });
      let next = null;
      if (sections.shopping !== false && shopping) {
        if (Array.isArray(shopping.items) && global.LexChecklist) {
          const items = shopping.items.filter((x) => x && x.id != null && String(x.text || '').trim());
          if (items.length) {
            const body = S.make('div', 'lex-check lex-today-check');
            for (const it of items) {
              const id = String(it.id).toLowerCase();
              const r = global.LexChecklist.row({
                text: oneLine(it.text), done: ticked.has(id),
                onCircle: () => tick(id),
                onText: () => deps.openShopping(),
              });
              r.el.dataset.id = id;
              body.appendChild(r.el);
            }
            next = { title: 'Shopping list', count: items.filter((x) => !ticked.has(String(x.id).toLowerCase())).length, body };
          }
        } else if (Number(shopping.count) > 0) {
          // An older answer: the line of the shopping list, as in the blocks.
          rows.push(S.shoppingLine({ count: shopping.count, first: shopping.first, onClick: () => deps.openShopping() }));
        }
      }
      if (sections.calendar === false) {
        if (!next && !rows.length) return null;
        const alone = S.todayCard({ title: 'Shopping list', count: next ? next.count : 0, rows, fold: Infinity });
        if (next) { next.body.classList.add('lex-today-next'); alone.appendChild(next.body); }
        return alone;
      }
      const card = S.todayCard({
        title: 'Day', link: { label: 'Calendar', onClick: () => deps.openCalendar(null) },
        rows, fold: Infinity, next,
      });
      // Nothing left today: the grey line under the day (a copy of another day says nothing of today).
      if (isToday(day, now) && !list.some((e) => !e.past)) {
        const empty = S.make('div', 'lex-today-empty', 'Nothing else today.');
        const after = card.querySelector('.lex-today-rows');
        card.insertBefore(empty, after ? after.nextSibling : card.querySelector('.lex-today-head.is-next'));
      }
      return card;
    }
    // A purchase marked on the board: drawn bought at once, the change goes the section's way; a press again takes it back.
    function tick(id) {
      const done = !ticked.has(id);
      if (done) ticked.add(id); else ticked.delete(id);
      paint();
      Promise.resolve(deps.checkShopping ? deps.checkShopping(id, done) : null).catch((e) => {
        console.warn('[today] shopping:', e && e.message);
        if (done) ticked.delete(id); else ticked.add(id);
        paint();
      });
    }
    function agentsCard(a) {
      const rows = [];
      for (const r of Array.isArray(a.working) ? a.working : []) {
        if (!r || !r.key) continue;
        rows.push(S.agentRow({
          key: r.key, name: r.title || r.key, time: at(r), state: 'working', stage: r.stage || null, text: oneLine(r.stageText) || null,
          id: `board:working:${r.chatKey || r.key}`, onClick: () => deps.openAgent(r.key, r.chatKey || null),
        }));
      }
      for (const r of Array.isArray(a.done) ? a.done : []) {
        if (!r || !r.key) continue;
        rows.push(S.agentRow({
          key: r.key, name: r.title || r.key, time: at(r), state: 'idle', text: oneLine(r.text),
          id: `board:done:${r.key}:${r.run || r.at || ''}`, onClick: () => deps.openAgent(r.key, null),
        }));
      }
      return S.todayCard({
        title: 'Agents', link: { label: 'Agents', onClick: () => deps.openAgents && deps.openAgents() },
        rows, empty: 'No agents at work today.', fold: Infinity,
      });
    }
    function newsCard(n) {
      const list = (Array.isArray(n.rows) ? n.rows : []).filter((r) => r && r.id != null);
      if (!list.length) return null;
      const count = Number(n.count) > 0 ? Math.floor(Number(n.count)) : list.length;
      const rows = list.map((r) => S.row({
        lead: S.sectionFace('news', { size: 48 }),
        title: oneLine(r.title) || 'News', sub: oneLine(r.sub), time: at(r),
        id: `board:news:${r.id}`, onClick: () => deps.openNews && deps.openNews(r),
      }));
      return S.todayCard({ title: 'News', countText: `${count} new`, rows, fold: Infinity });
    }
    function boardCards(now) {
      const sections = held.sections && typeof held.sections === 'object' ? held.sections : {};
      const one = held.waiting ? S.todayCard({
        title: 'Waiting for you', count: Number.isFinite(Number(held.waiting.count)) ? Number(held.waiting.count) : undefined,
        rows: (Array.isArray(held.waiting.rows) ? held.waiting.rows : []).map(waitLine).filter(Boolean),
        empty: 'Nothing is waiting for you.', fold: Infinity,
      }) : null;
      const two = (held.day || held.shopping) ? boardDay(held.day, held.shopping, sections, now) : null;
      const three = [];
      if (sections.agents !== false && held.agents && typeof held.agents === 'object') three.push(agentsCard(held.agents));
      if (sections.news !== false && held.news && typeof held.news === 'object') three.push(newsCard(held.news));
      return S.board([[one], [two], three]);
    }

    function paint() {
      host.classList.toggle('is-board', layout === 'board');
      if (layout === 'board') { paintBoard(); return; }
      const cards = [];
      // What comes into the empty place keeps its height: measured as it stands, before it is taken.
      if (active && settled && !hold && host.querySelector('.lex-today-place, .lex-skel-today')) hold = host.offsetHeight;
      if (active && !settled) {
        const P = S.TODAY_PLACE;
        cards.push(S.todayPlace(P.waiting), S.todayPlace(P.day));
      } else if (active && held) {
        const sections = held.sections && typeof held.sections === 'object' ? held.sections : {};
        const now = new Date();
        if (held.waiting) cards.push(waitingCard(held.waiting));
        if (sections.calendar !== false && held.day) cards.push(dayCard(held.day, held.shopping, sections, now));
      }
      host.replaceChildren(...cards);
      const on = cards.length > 0 || (active && hold > 0);
      host.hidden = !on;
      host.style.minHeight = active && hold > 0 ? `${hold}px` : '';
      if (deps.head) deps.head(null);
      if (on !== shown) {
        shown = on;
        if (deps.onShown) deps.onShown(on);
      }
    }
    // The board stands whole while the main page is on the screen: nothing known yet — the three columns with empty
    // places (no word, no motion), as the blocks hold theirs.
    function paintBoard() {
      host.style.minHeight = '';
      if (!active) {
        host.replaceChildren();
        host.hidden = true;
        if (deps.head) deps.head(null);
        if (shown) { shown = false; if (deps.onShown) deps.onShown(false); }
        return;
      }
      const now = new Date();
      if (deps.head) deps.head(S.boardHead({ date: dayWords(now), title: 'Today' }));
      if (!settled || !held) {
        const P = S.TODAY_PLACE;
        host.replaceChildren(settled ? S.board([[], [], []]) : S.board([[S.todayPlace(P.waiting)], [S.todayPlace(P.day)], [S.todayPlace(P.day)]]));
      } else host.replaceChildren(boardCards(now));
      host.hidden = false;
      if (!shown) { shown = true; if (deps.onShown) deps.onShown(true); }
    }

    // ── reading ───────────────────────────────────────────────────────────────
    let reading = null;
    // The ladder of the empty place (lex-skeleton.js): climbed only while the main page is on the screen and nothing is
    // known; the skeleton stands in the place of the two empty cards, at their heights.
    let wait = null;
    function climb() {
      const K = global.LexSkeleton;
      if (wait || settled || !active || !K) return;
      const P = S.TODAY_PLACE;
      const heights = [P.waiting, P.day];
      wait = K.ladder(host, {
        // The board keeps its three columns: a skeleton card stands where each empty card stood (paintBoard).
        skeleton: () => {
          // Each in a list of one, as the blocks' cards stand: the list is what breathes them (lex-skeleton.css).
          if (layout === 'board') return S.board([P.waiting, P.day, P.day].map((h) => [K.list(() => K.todayCard(h), 1)]));
          let i = 0;
          return K.list(() => K.todayCard(heights[i++]), heights.length);
        },
        put: (n) => { if (!settled && active) host.replaceChildren(n); },
        shown: () => active && !host.hidden,
        empty: () => null,
      });
    }
    // Something is known: the held height is taken as the place stands (empty cards or their skeleton), then the
    // skeleton gives way — not before it stood its 200 ms.
    function settle(draw) {
      // Only the blocks hold a height (the board fills the window): a board measured here would hold the blocks of a
      // window narrowed later at the height of the whole window.
      if (active && layout !== 'board' && !hold && host.querySelector('.lex-today-place, .lex-skel-today')) hold = host.offsetHeight;
      const w = wait;
      wait = null;
      if (w) w.done(draw); else draw();
    }
    function reload() {
      if (reading) return reading;
      climb();
      reading = Promise.resolve(deps.read((v, isFresh) => {
        const was = settled;
        if (isFresh) settled = true;
        if (!v || typeof v !== 'object') { if (!was && settled) settle(paint); return; }
        // The copy draws the first frame only while the screen holds nothing; the server's answer takes its place.
        if (!isFresh && held) return;
        settled = true;
        const text = textOf(v);
        if (isFresh && text !== null && text === drawn) { if (!was) settle(paint); return; }
        held = merge(held, v);
        // A purchase marked on the board leaves the marks when the answer no longer has it to buy.
        if (isFresh && ticked.size && held.shopping && Array.isArray(held.shopping.items)) {
          const left = new Set(held.shopping.items.map((x) => String(x && x.id).toLowerCase()));
          for (const id of [...ticked]) if (!left.has(id)) ticked.delete(id);
        }
        if (isFresh) drawn = text;
        if (!was) settle(paint); else paint();
      })).catch((e) => {
        // Nothing came: the empty place goes (what the screen held, if anything, stays).
        if (!settled) { settled = true; settle(paint); }
        throw e;
      }).finally(() => { reading = null; });
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
          climb();
          reload().catch((e) => { console.warn('[today] read:', e && e.message); frame.lookNow(); });
        } else {
          frame.unwatch();
          if (wait) { wait.stop(); wait = null; }
          // The held height is of one showing: the next one hugs the cards.
          hold = 0;
          paint();
        }
      },
      // 'board' on a wide window, 'blocks' over the list of the people: the same answer drawn again in the other way.
      setLayout(l) {
        l = l === 'board' ? 'board' : 'blocks';
        if (layout === l) return;
        layout = l;
        hold = 0;
        paint();
      },
      get layout() { return layout; },
      // Read at the start, so that the first showing of the main page has the blocks.
      warm() { return reload().catch((e) => console.warn('[today] warm:', e && e.message)); },
      lookNow() { if (active) frame.lookNow(); },
      get shown() { return shown; },
      get answer() { return held; },
    };
  }

  global.LexToday = { create, dayEvents, dayAll, dayWords, moscowDay, merge, EVENTS };
})(typeof window !== 'undefined' ? window : globalThis);
