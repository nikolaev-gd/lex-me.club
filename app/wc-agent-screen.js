// wc-agent-screen.js — the agent's own screen, drawn from the base's description (26.11.2026, the contract «Scribe в
// Lex», p. 1; the first agent with one is Scribe, key `dictation`).
//
// The base describes the screen (folder-agents op «screen» → brain-tool /folders/agents/screen): {v, agent, rev,
// blocks: [{id, kind, v, place, …}]}. A block is typed (Airbnb's Ghost Platform): every kind has exactly one drawer
// here, the data come inside the block, the presses are typed too. A kind this page does not know is skipped with one
// grey line «Update Lex to see this». The words of the screen are the base's (English, as all of Lex).
//   place  card — the block stands in the passport after About; main — on the agent's main screen
//   kind   settings  rows: choice (a menu of options), text (a line of words; show_if {row: [values]}), switch (on/off);
//                     a row with `shell` keeps its value in the Mac program (`__lexShell.acts` names it): a page
//                     without that action does not draw the row, the base's value is the default
//          totals    weeks [{from, to, hours, usd, count}] · months [{month, hours, usd, count}]
//          list      items by pages of 50 (next — the base's mark, as `next_before` of the journal), search (q), group
//                     by day; fields [{key, as}] — as: title, time, meta, duration, money, badge; actions [{id, label,
//                     run: copy | server | shell, field?, shell?, on?, confirm?}]; an item's `acts` — what it may do (the
//                     base decides). run shell with on:"device" — only on the Mac whose `__lexShell.device` is the
//                     item's `device`; elsewhere the line says `device_label` («On Mac Kenneth»)
// A press goes to the base (op «screen_act» {block, row?, action?, id?, value?}) and the block comes back drawn anew
// ({ok, block}) or the line goes ({ok, removed}). The Mac's own presses go to the program (LexMacDictation.act, the
// word `agent`). A signal `agent_screen` {agent} — the open screen reads its first page and the totals again.
//
// create(deps) → { read(), cardBlocks(), paintMain(host), refresh(), blocks() }
//   deps.agent            the agent's key
//   deps.call(body)       folder-agents (op screen / screen_act)
//   deps.menu(anchor, items)  the page's menu (WcUI.menu)
//   deps.toast(text, error)   the line that pops up
//   deps.confirm(title, body, opts) → Promise<true|null>;  deps.prompt(title, value, opts) → Promise<string|null>
//   deps.money(usd)       the money as the page writes it (WcUI.fmtMoney)
//   deps.onChange()       the blocks changed (the passport paints itself again)
(function (global) {
  'use strict';

  const KINDS = new Set(['settings', 'totals', 'list']);
  const AS = new Set(['title', 'time', 'meta', 'duration', 'money', 'badge']);
  const oneLine = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const MAX_TITLE = 400;

  // The Mac program's part of the agent (wc-mac-dictation.js): its device and its presses; null elsewhere.
  const shell = () => global.LexMacDictation || null;
  const canShell = (name) => { const s = shell(); return !!(s && typeof s.can === 'function' && s.can(name)); };

  function duration(ms) {
    const n = Math.round(Number(ms) / 1000);
    if (!Number.isFinite(n) || n <= 0) return '';
    const h = Math.floor(n / 3600);
    const m = Math.floor((n % 3600) / 60);
    const s = String(n % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }
  const hhmm = (at) => {
    const d = new Date(at);
    if (!at || Number.isNaN(d.getTime())) return '';
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  function hours(h) {
    const n = Number(h);
    if (!Number.isFinite(n)) return '';
    return n >= 10 ? `${Math.round(n)} h` : `${(Math.round(n * 10) / 10).toFixed(1)} h`;
  }
  const count = (n) => `${Number(n) || 0} ${Number(n) === 1 ? 'dictation' : 'dictations'}`;
  function weekWords(w) {
    const f = new Date(`${w.from}T12:00:00`);
    const t = new Date(`${w.to}T12:00:00`);
    if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) return `${w.from || ''} – ${w.to || ''}`;
    const day = (d) => new Intl.DateTimeFormat('en-GB', { day: 'numeric' }).format(d);
    const month = (d) => new Intl.DateTimeFormat('en-GB', { month: 'short' }).format(d);
    return f.getMonth() === t.getMonth() ? `${day(f)}–${day(t)} ${month(t)}` : `${day(f)} ${month(f)} – ${day(t)} ${month(t)}`;
  }
  function monthWords(m) {
    const d = new Date(`${m.month}-15T12:00:00`);
    if (Number.isNaN(d.getTime())) return String(m.month || '');
    return new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' }).format(d);
  }

  function create(deps) {
    const S = global.LexSection;
    const make = S.make;
    let screen = null;            // the last answer of op «screen» without a block
    let hosts = [];               // where the main blocks stand now
    const lists = new Map();      // the state of a list block: { items, next, q, reading, done }

    const money = (usd) => (usd == null || usd === '' ? '' : (deps.money ? deps.money(usd) : `$${Number(usd).toFixed(2)}`));
    const blocks = () => (screen && Array.isArray(screen.blocks) ? screen.blocks.filter((b) => b && b.id) : []);
    const say = (text, error) => { if (deps.toast) deps.toast(text, error); };
    const opId = () => (S.newOpId ? S.newOpId() : String(Date.now()));

    async function read() {
      const got = await deps.call({ op: 'screen', agent: deps.agent });
      if (!got || !Array.isArray(got.blocks)) return null;
      screen = got;
      // A list keeps its search and its further pages; its first page is the fresh one.
      for (const b of blocks()) if (b.kind === 'list') mergeFirst(b);
      return screen;
    }

    // ── kind «settings» ─────────────────────────────────────────────────────────────────────────────────────────
    function rowValue(b, id) {
      const r = (b.rows || []).find((x) => x && x.id === id);
      return r ? r.value : undefined;
    }
    function shown(b, r) {
      if (!r.show_if || typeof r.show_if !== 'object') return true;
      return Object.entries(r.show_if).every(([k, vals]) => Array.isArray(vals) && vals.includes(rowValue(b, k)));
    }
    async function act(b, body, waitText) {
      let got;
      try {
        got = await deps.call(Object.assign({ op: 'screen_act', agent: deps.agent, block: b.id, opId: opId() }, body));
      } catch (e) {
        say(`${waitText || 'Not saved.'} ${(e && e.message) || ''}`.trim(), true);
        return null;
      }
      if (got && got.block && got.block.id) {
        const i = screen.blocks.findIndex((x) => x && x.id === got.block.id);
        if (i >= 0) screen.blocks[i] = got.block; else screen.blocks.push(got.block);
        if (got.block.kind === 'list') mergeFirst(got.block);
      }
      return got || {};
    }
    function settingRow(b, r) {
      if (!r || !r.id || !shown(b, r)) return null;
      if (r.shell && !canShell(r.shell)) return null;
      const title = String(r.title || r.id);
      if (r.type === 'choice') {
        const opts = Array.isArray(r.options) ? r.options : [];
        const now = opts.find((o) => o && o.value === r.value);
        return S.settingRow({ id: r.id, title, note: r.note || undefined, menu: {
          value: now ? now.label : (r.value || '—'),
          onOpen: (anchor) => deps.menu(anchor, opts.map((o) => ({ label: o.label, note: o.note, checked: o.value === r.value,
            onSelect: async () => {
              if (o.value === r.value) return;
              const got = await act(b, { row: r.id, value: o.value });
              if (got) { say(`${title}: ${o.label}`); changed(); }
            } }))),
        } });
      }
      if (r.type === 'text') {
        const v = oneLine(r.value);
        return S.settingRow({ id: r.id, title, note: r.note || undefined, go: {
          value: v ? (v.length > 40 ? `${v.slice(0, 40)}…` : v) : (r.placeholder || 'None'),
          onClick: async () => {
            const next = await deps.prompt(title, String(r.value || ''), { maxlength: Number(r.max) || 1000, okText: 'Save',
              body: r.placeholder || undefined });
            if (next == null || next === String(r.value || '')) return;
            const got = await act(b, { row: r.id, value: next });
            if (got) changed();
          },
        } });
      }
      if (r.type === 'switch') {
        const local = r.shell && shell() && typeof shell().keysHere === 'function' ? shell().keysHere() : null;
        const on = typeof local === 'boolean' ? local : !!r.value;
        return S.settingRow({ id: r.id, title, note: r.note || undefined, toggle: { on,
          onChange: async (next, input) => {
            if (r.shell) {
              if (!shell().act(r.shell, null, next) && input) input.checked = !next;
              return;
            }
            const got = await act(b, { row: r.id, value: next });
            if (!got && input) input.checked = !next;
            else changed();
          } } });
      }
      return unknownRow();
    }
    const unknownRow = () => S.settingsBlock([S.row({ title: 'Update Lex to see this', cls: 'lex-agent-screen-unknown' })]);
    function settings(b) {
      return S.settingsBlock((b.rows || []).map((r) => settingRow(b, r)).filter(Boolean));
    }

    // ── kind «totals» ───────────────────────────────────────────────────────────────────────────────────────────
    function totals(b) {
      const n = make('div', 'lex-section-list lex-agent-screen-totals');
      const line = (title, x) => S.row({ title, sub: [hours(x.hours), count(x.count)].filter(Boolean).join(' · '), time: money(x.usd) });
      const weeks = Array.isArray(b.weeks) ? b.weeks : [];
      const months = Array.isArray(b.months) ? b.months : [];
      if (weeks.length) {
        n.appendChild(S.groupLabel('Weeks'));
        for (const w of weeks) n.appendChild(line(weekWords(w), w));
      }
      if (months.length) {
        n.appendChild(S.groupLabel('Months'));
        for (const m of months) n.appendChild(line(monthWords(m), m));
      }
      return n;
    }

    // ── kind «list» ─────────────────────────────────────────────────────────────────────────────────────────────
    const order = (x, y) => (Date.parse(y.at || '') || 0) - (Date.parse(x.at || '') || 0) || String(y.id).localeCompare(String(x.id));
    function stateOf(b) {
      if (!lists.has(b.id)) lists.set(b.id, { items: [], next: null, q: '', reading: false, done: false, block: b });
      return lists.get(b.id);
    }
    // The first page of the base: its lines replace the same lines, new ones come in; the further pages stay.
    function mergeFirst(b) {
      const st = stateOf(b);
      st.block = b;
      if (st.q) return;   // a search on the screen keeps its own lines; it reads again by itself
      const fresh = Array.isArray(b.items) ? b.items.filter((x) => x && x.id) : [];
      if (!st.items.length) { st.items = fresh; st.next = b.next || null; st.done = !b.next; return; }
      const by = new Map(st.items.map((x) => [x.id, x]));
      for (const x of fresh) by.set(x.id, x);
      const oldest = fresh.length ? fresh[fresh.length - 1] : null;
      // A line of the first page's span that the base no longer gives is gone (Delete on another surface).
      const keep = [...by.values()].filter((x) => fresh.some((f) => f.id === x.id) || !oldest || order(x, oldest) > 0);
      st.items = keep.sort(order);
    }
    async function page(b, host, fresh) {
      const st = stateOf(b);
      if (st.reading || (!fresh && (st.done || !st.next))) return;
      st.reading = true;
      try {
        const body = { op: 'screen', agent: deps.agent, block: b.id };
        if (!fresh && st.next) body.before = st.next;
        if (st.q) body.q = st.q;
        const asked = st.q;
        const got = await deps.call(body);
        if (asked !== st.q) return;
        const blk = got && Array.isArray(got.blocks) ? got.blocks.find((x) => x && x.id === b.id) : null;
        const items = blk && Array.isArray(blk.items) ? blk.items.filter((x) => x && x.id) : [];
        st.items = fresh ? items : st.items.concat(items.filter((x) => !st.items.some((y) => y.id === x.id)));
        st.next = (blk && blk.next) || null;
        st.done = !st.next || !items.length;
      } catch (e) {
        if (e && e.status) say(String(e.message || ''), true);
        else console.warn('[agent-screen] page:', e && e.message);
      } finally { st.reading = false; }
      paintList(b, host);
    }
    function actionsOf(b, item) {
      const all = Array.isArray(b.actions) ? b.actions : [];
      const may = Array.isArray(item.acts) ? item.acts : [];
      const sh = shell();
      const here = !!(sh && sh.device && item.device && sh.device === item.device);
      let elsewhere = false;
      const out = [];
      for (const a of all) {
        if (!a || !may.includes(a.id)) continue;
        if (a.run === 'shell') {
          if (a.on === 'device' && !here) { elsewhere = true; continue; }
          if (!canShell(a.shell)) { elsewhere = true; continue; }
        } else if (a.run !== 'copy' && a.run !== 'server') continue;
        out.push(a);
      }
      return { list: out, elsewhere };
    }
    async function run(b, a, item, host) {
      if (a.run === 'copy') {
        const text = String(item[a.field || 'text'] || '');
        try { await navigator.clipboard.writeText(text); say('Copied'); } catch (_) { say('Could not copy', true); }
        return;
      }
      if (a.run === 'shell') { if (!shell().act(a.shell, item.id)) say('This Mac cannot do it', true); return; }
      if (a.confirm) {
        const yes = await deps.confirm(a.confirm, oneLine(item.text).slice(0, 140) || undefined, { okText: a.label || 'OK', danger: a.id === 'delete' });
        if (!yes) return;
      }
      const got = await act(b, { action: a.id, id: item.id }, 'It did not work.');
      if (!got) return;
      if (got.removed) {
        const st = stateOf(b);
        st.items = st.items.filter((x) => x.id !== got.removed);
        // Delete on the Mac that holds the recording: its file and its note go too (amendment 2).
        const sh = shell();
        if (a.id === 'delete' && sh && sh.device && sh.device === item.device && canShell('dictation.delete')) sh.act('dictation.delete', item.id);
      }
      paintList(b, host);
    }
    function itemRow(b, item, host) {
      const fields = (Array.isArray(b.fields) ? b.fields : []).filter((f) => f && AS.has(f.as));
      const val = (as) => { const f = fields.find((x) => x.as === as); return f ? item[f.key] : undefined; };
      let title = oneLine(val('title'));
      if (title.length > MAX_TITLE) title = `${title.slice(0, MAX_TITLE)}…`;
      const { list, elsewhere } = actionsOf(b, item);
      const badge = val('badge');
      // A line without words carries its badge as the title («Recognizing…»), not twice.
      const sub = [oneLine(val('meta')), duration(val('duration')), money(val('money')), badge && title ? oneLine(badge) : '',
        elsewhere && item.device_label ? oneLine(item.device_label) : ''].filter(Boolean).join(' · ');
      const row = S.row({ id: item.id, title: title || (badge ? oneLine(badge) : '—'), sub, time: hhmm(val('time')), wrap: true,
        cls: 'lex-agent-screen-item',
        more: list.length ? list.map((a) => ({ label: a.label || a.id, onSelect: () => { run(b, a, item, host); } })) : null });
      row.classList.add('lex-agent-screen-line');
      if (item.status && item.status !== 'ok') row.dataset.status = item.status;
      return row;
    }
    function searchBox(b, host) {
      const st = stateOf(b);
      const box = S.settingsBlock([]);
      box.classList.add('lex-agent-screen-search');
      const input = make('input', 'lex-check-input');
      input.type = 'search';
      input.placeholder = 'Search';
      input.autocomplete = 'off';
      input.maxLength = 200;
      input.value = st.q;
      input.setAttribute('aria-label', 'Search');
      let timer = null;
      input.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          const q = input.value.trim();
          if (q === st.q) return;
          st.q = q;
          st.items = [];
          st.next = null;
          st.done = false;
          if (!q) { const blk = blocks().find((x) => x.id === b.id); if (blk) mergeFirst(blk); paintList(b, host); return; }
          page(b, host, true);
        }, 300);
      });
      box.appendChild(input);
      return box;
    }
    function paintList(b, host) {
      const st = stateOf(b);
      let list = host.querySelector(':scope > .lex-agent-screen-items');
      if (!list) return;
      const M = global.LexMessage;
      const rows = [];
      let lastDay = '';
      for (const item of st.items) {
        if (b.group === 'day' && M && M.dayOf) {
          const day = M.dayOf(item.at);
          if (day && day !== lastDay) { rows.push(M.dayLine(item.at)); lastDay = day; }
        }
        rows.push(itemRow(b, item, host));
      }
      if (!rows.length && !st.reading) {
        rows.push(make('div', 'lex-section-empty', st.q ? 'Nothing found.' : 'Nothing yet.'));
      }
      list.replaceChildren(...rows);
      const end = host.querySelector(':scope > .lex-agents-runs-end');
      if (end && !st.done && st.next && end.getBoundingClientRect().top < global.innerHeight) page(b, host, false);
    }
    function listBlock(b) {
      const host = make('div', 'lex-agent-screen-list');
      if (b.search) host.appendChild(searchBox(b, host));
      host.appendChild(make('div', 'lex-section-list lex-agent-screen-items'));
      const end = make('div', 'lex-agents-runs-end');
      host.appendChild(end);
      if (typeof IntersectionObserver !== 'undefined') {
        const seen = new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) page(stateOf(b).block || b, host, false); }, { root: null, rootMargin: '400px' });
        seen.observe(end);
      }
      // Drawn once it stands in the document (the end of the list is measured).
      requestAnimationFrame(() => paintList(stateOf(b).block || b, host));
      return host;
    }

    // ── the blocks ──────────────────────────────────────────────────────────────────────────────────────────────
    function draw(b) {
      if (!KINDS.has(b.kind)) return unknownRow();
      if (b.kind === 'settings') return settings(b);
      if (b.kind === 'totals') return totals(b);
      return listBlock(b);
    }
    const cardBlocks = () => blocks().filter((b) => b.place === 'card').map(draw);
    function paintMain(host) {
      hosts = hosts.filter((h) => h.isConnected && h !== host);
      hosts.push(host);
      const main = blocks().filter((b) => b.place === 'main');
      if (!main.length) { host.replaceChildren(); return; }
      host.replaceChildren(...main.map((b) => { const n = draw(b); n.dataset.block = b.id; return n; }));
    }
    function changed() {
      for (const h of hosts) if (h.isConnected) paintMain(h);
      if (deps.onChange) deps.onChange();
    }
    // A signal or a press elsewhere: the screen once more (the first page and the totals); a search reads itself.
    async function refresh() {
      await read();
      for (const h of hosts) {
        if (!h.isConnected) continue;
        for (const b of blocks().filter((x) => x.place === 'main')) {
          const old = h.querySelector(`:scope > [data-block="${b.id}"]`);
          if (!old) { paintMain(h); break; }
          if (b.kind === 'list') {
            const st = stateOf(b);
            if (st.q) page(b, old, true); else paintList(b, old);
          } else {
            const n = draw(b);
            n.dataset.block = b.id;
            old.replaceWith(n);
          }
        }
      }
      if (deps.onChange) deps.onChange();
    }
    // The Mac's switch changed (`__lexShell.dictation.keysHere`): the card draws itself again.
    const sh = shell();
    if (sh && typeof sh.onShell === 'function') sh.onShell(() => { if (deps.onChange) deps.onChange(); });

    return { read, cardBlocks, paintMain, refresh, blocks, get rev() { return screen ? screen.rev : null; } };
  }

  global.LexAgentScreen = { create };
})(typeof window !== 'undefined' ? window : globalThis);
