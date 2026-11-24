// lex-list-order.js — the order of a list of task chats (ios/Lex/STANDARD.md, В7.73), one for every list where an agent
// does tasks (23.11.2026, Gennady: «inside an agent it is often not clear when which order was»; the menu as Claude has
// it — Group by and Sort by, nothing else). The chats with people keep the order of a messenger and do not take it.
//
//   Group by  Date updated | Date created | Status | None
//   Sort by   Last updated | Date created | Name, then Descending | Ascending
//
// The two are separate: Group by cuts the list into groups (by the day of the last movement, by the day of the birth, by
// the state), Sort by orders the rows inside them — and the groups themselves, when it sorts by a date (Descending: the
// newest group first). So «by Date created, inside by Name» is a choice. A choice kept before 24.11.2026 as `date|…` is
// read as the date the list was sorted by.
//
// The default is the order the folders had before: by status (waiting, working, closed), the last movement first.
// The choice is kept on the device, one for every list of the same kind (`key`): what a person set in one agent stays
// in the others. Pure: no page, no server — the page draws the menu (WcUI.menu, В7.8) and the button
// (LexSection.orderButton); the iPhone has the same choices, words and groups in Parts/ListOrder.swift.
//
// LexListOrder:
//   DEFAULTS, GROUPS, SORTS, DIRS     the choices and their words
//   norm(prefs) / parse(text) / text(prefs)   a choice made whole; «status|updated|desc» and back
//   load(key, storage) / save(key, prefs, storage)   the choice kept on the device (localStorage by default)
//   isDefault(prefs)
//   dateGroup(ms, now)  → { id, title, rank } — Today, Yesterday, Previous 7 days, Previous 30 days, a month
//   arrange(items, prefs, o) → [{ id, title, count, items }] — o: { at(it), created(it), name(it), status(it),
//                       statuses: [{ id, title, counted, rest }], now }; one group with title null when not grouped
//   menuItems(prefs, onPick) → the items of WcUI.menu: heads, choices with the check, separators
//   label(prefs)        → what the button says to a reader of the screen
(function (global) {
  'use strict';

  const GROUPS = [{ id: 'updated', label: 'Date updated' }, { id: 'created', label: 'Date created' },
    { id: 'status', label: 'Status' }, { id: 'none', label: 'None' }];
  const SORTS = [{ id: 'updated', label: 'Last updated' }, { id: 'created', label: 'Date created' }, { id: 'name', label: 'Name' }];
  const DIRS = [{ id: 'desc', label: 'Descending' }, { id: 'asc', label: 'Ascending' }];
  const DEFAULTS = Object.freeze({ group: 'status', sort: 'updated', dir: 'desc' });
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October',
    'November', 'December'];
  const PREFIX = 'lex.listOrder.';

  const has = (list, id) => list.some((x) => x.id === id);
  function norm(p) {
    p = p || {};
    return {
      group: has(GROUPS, p.group) ? p.group : DEFAULTS.group,
      sort: has(SORTS, p.sort) ? p.sort : DEFAULTS.sort,
      dir: has(DIRS, p.dir) ? p.dir : DEFAULTS.dir,
    };
  }
  function parse(s) {
    const [group, sort, dir] = String(s || '').split('|');
    // The first menu had one «Date» that took the date from Sort by.
    return norm({ group: group === 'date' ? (sort === 'created' ? 'created' : 'updated') : group, sort, dir });
  }
  const text = (p) => { const n = norm(p); return `${n.group}|${n.sort}|${n.dir}`; };
  const isDefault = (p) => text(p) === text(DEFAULTS);

  function store(storage) {
    if (storage) return storage;
    try { return global.localStorage || null; } catch (_) { return null; }
  }
  function load(key, storage) {
    try { const s = store(storage); return parse(s ? s.getItem(PREFIX + key) : ''); } catch (_) { return norm(); }
  }
  function save(key, p, storage) {
    try { const s = store(storage); if (s) s.setItem(PREFIX + key, text(p)); } catch (_) { /* private window: the choice lives as long as the page */ }
  }

  // The group of a moment, by the days of the calendar: Today, Yesterday, Previous 7 days, Previous 30 days, then the
  // month («October», «October 2025» in another year). rank — the newer, the smaller.
  function dateGroup(ms, now) {
    if (!Number.isFinite(ms)) return { id: 'none', title: 'No date', rank: Infinity };
    const n = new Date(Number.isFinite(now) ? now : Date.now());
    const d = new Date(ms);
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((day(n) - day(d)) / 86400000);
    if (days <= 0) return { id: 'today', title: 'Today', rank: 0 };
    if (days === 1) return { id: 'yesterday', title: 'Yesterday', rank: 1 };
    if (days < 7) return { id: 'week', title: 'Previous 7 days', rank: 2 };
    if (days < 30) return { id: 'month', title: 'Previous 30 days', rank: 3 };
    const months = (n.getFullYear() - d.getFullYear()) * 12 + (n.getMonth() - d.getMonth());
    const title = d.getFullYear() === n.getFullYear() ? MONTHS[d.getMonth()] : `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
    return { id: `m${d.getFullYear()}-${d.getMonth() + 1}`, title, rank: 4 + Math.max(0, months) };
  }

  const num = (v) => (Number.isFinite(v) ? v : null);
  // A moment as milliseconds: a number, a Date or the text of the server.
  function ms(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return num(v);
    const t = v instanceof Date ? v.getTime() : Date.parse(v);
    return num(t);
  }
  const collator = typeof Intl !== 'undefined' && Intl.Collator ? new Intl.Collator(['ru', 'en'], { numeric: true, sensitivity: 'base' }) : null;
  const byName = (a, b) => (collator ? collator.compare(a, b) : (a < b ? -1 : a > b ? 1 : 0));

  function arrange(items, prefs, o) {
    const p = norm(prefs);
    o = o || {};
    const at = (it) => ms(o.at ? o.at(it) : it.at);
    // A list whose server does not give the birth of an item yet sorts by its last movement.
    const created = (it) => { const c = ms(o.created ? o.created(it) : it.created); return c == null ? at(it) : c; };
    const name = (it) => String((o.name ? o.name(it) : it.title) || '').trim();
    const list = (Array.isArray(items) ? items : []).map((it, i) => ({ it, i, at: at(it), created: created(it), name: name(it) }));
    const sign = p.dir === 'asc' ? 1 : -1;
    const cmp = (a, b) => {
      if (p.sort === 'name') {
        const d = byName(a.name, b.name);
        if (d) return sign * d;   // Ascending — A to Z
      } else {
        const x = p.sort === 'created' ? a.created : a.at;
        const y = p.sort === 'created' ? b.created : b.at;
        if (x == null && y != null) return 1;   // what has no moment goes last both ways
        if (y == null && x != null) return -1;
        if (x !== y && x != null) return sign * (x - y);
      }
      if (a.at !== b.at) return (b.at || 0) - (a.at || 0);
      return a.i - b.i;
    };
    const sorted = list.slice().sort(cmp);
    const out = (x) => x.map((e) => e.it);

    if (p.group === 'none') return sorted.length ? [{ id: 'all', title: null, count: null, items: out(sorted) }] : [];

    if (p.group === 'status') {
      const statuses = Array.isArray(o.statuses) && o.statuses.length ? o.statuses : [{ id: 'all', title: null, rest: true }];
      const rest = statuses.find((s) => s.rest) || statuses[statuses.length - 1];
      const of = (e) => { const id = o.status ? o.status(e.it) : e.it.state; return statuses.find((s) => s.id === id) || rest; };
      return statuses.map((s) => {
        const mine = sorted.filter((e) => of(e) === s);
        return { id: s.id, title: s.title == null ? null : s.title, count: s.counted ? mine.length : null, items: out(mine) };
      }).filter((g) => g.items.length);
    }

    // Date updated | Date created: the groups are the days of that moment; the rows keep the order of Sort by inside
    // them. The newest group first, or the oldest when Sort by is a date and Ascending.
    const groups = new Map();
    for (const e of sorted) {
      const g = dateGroup(p.group === 'created' ? e.created : e.at, o.now);
      if (!groups.has(g.id)) groups.set(g.id, { id: g.id, title: g.title, rank: g.rank, count: null, items: [] });
      groups.get(g.id).items.push(e.it);
    }
    const up = p.sort !== 'name' && p.dir === 'asc';
    return [...groups.values()]
      .sort((a, b) => (a.rank === Infinity ? 1 : b.rank === Infinity ? -1 : (up ? b.rank - a.rank : a.rank - b.rank)))
      .map(({ rank, ...g }) => g);
  }

  function menuItems(prefs, onPick) {
    const p = norm(prefs);
    const pick = (change) => () => onPick(norm(Object.assign({}, p, change)));
    return [
      { head: 'Group by' },
      ...GROUPS.map((g) => ({ label: g.label, checked: p.group === g.id, onSelect: pick({ group: g.id }) })),
      { separator: true },
      { head: 'Sort by' },
      ...SORTS.map((s) => ({ label: s.label, checked: p.sort === s.id, onSelect: pick({ sort: s.id }) })),
      { separator: true },
      ...DIRS.map((d) => ({ label: d.label, checked: p.dir === d.id, onSelect: pick({ dir: d.id }) })),
    ];
  }

  const word = (list, id) => (list.find((x) => x.id === id) || {}).label || '';
  function label(prefs) {
    const p = norm(prefs);
    return `Group and sort: group by ${word(GROUPS, p.group)}, sort by ${word(SORTS, p.sort)}, ${word(DIRS, p.dir)}`;
  }

  const api = { DEFAULTS, GROUPS, SORTS, DIRS, norm, parse, text, isDefault, load, save, dateGroup, arrange, menuItems, label };
  global.LexListOrder = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
