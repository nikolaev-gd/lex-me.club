// wc-shopping.js — the section «Shopping list» of the page and the Mac app (22.11.2026, docs/spec/28-shopping.md).
//
// Gennady, 22.11.2026: the shopping list is built on the page too, the same screen as on the iPhone in the column of
// 720. One list of the base, a plain checklist: the ones to buy with empty circles, the row of a new item after them,
// the bought ones under «Bought · N» with «Clear». The list lives in the base; the page asks the server's function
// `shopping` (supabase/functions/shopping), as the iPhone does, and follows its signal «shopping».
//
// Every change acts on the screen at once and goes to the server in a queue, in its order, each with the number of
// its command (sent again after a break it changes nothing twice). A change the server refused for good leaves the
// queue; one that did not reach it waits and goes with the next look.
//
// The row of a new item (the board ShopF1, «вариант 1»): the first letter makes the item — the row is a line of the
// list with its circle, the cursor stays in it, a new empty row stands under it. The item goes to the server after a
// pause in the typing of about a second, on Return or when the person leaves the row; the typing after that goes as
// a new text of the same item. So the widget and the history of the base never see «С» for «Сметана». A twin is found
// when the line is finished, not on the first letter: one that waits to be bought takes the new line in, a bought one
// comes back instead of it.
//
// createSection(deps) — deps:
//   back                 the arrow of the window (lex-back.js)
//   signals              the channel of the database's signals (lex-account-events.js)
//   call(body)           the edge function shopping: null — read the list, { op, … } — a change
//   kept()               the copy of the list this device kept (lex-reads.js, `shopping`), or null
//   confirm(title, text, o)   the common question (WcUI.confirm)
(function (global) {
  'use strict';

  // The pause in the typing after which a new line goes to the server.
  const PAUSE_MS = 1000;

  // The text as the list keeps it: no spaces at the ends, one inside, not longer than 200 (the base's rule).
  const clean = (t) => String(t || '').split(/\s+/).filter(Boolean).join(' ').slice(0, 200);
  const key = (t) => clean(t).toLowerCase();
  function newId() {
    if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID().toLowerCase();
    return 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
  }

  // The list as the server gave it: the ones to buy in their order, then the bought ones, the freshest first.
  function listOf(j) {
    const items = (j && Array.isArray(j.items) ? j.items : [])
      .filter((x) => x && typeof x.id === 'string' && typeof x.text === 'string')
      .map((x) => ({ id: x.id.toLowerCase(), text: x.text, done: !!x.done }));
    return {
      version: Number(j && j.version) || 0,
      mode: (j && j.mode) || 'base',
      todo: items.filter((x) => !x.done),
      bought: items.filter((x) => x.done),
    };
  }
  const copyList = (l) => ({ version: l.version, mode: l.mode, todo: l.todo.map((x) => ({ ...x })), bought: l.bought.map((x) => ({ ...x })) });

  // What a change does to the list on this page at once, before the server's answer takes its place — the same rules
  // as the base's (and ShopRules of the iPhone). `homes` — where a bought item stood: the item after it.
  // A held `add` (a line still typed) stands as it is, twins or not: twins are looked at when the line is finished.
  function apply(o, l, homes) {
    const all = () => l.todo.concat(l.bought);
    switch (o.op) {
      case 'add':
        for (const it of o.items || []) {
          const k = key(it.text);
          if (!k) continue;
          if (o.hold) {
            if (!all().some((x) => x.id === it.id)) l.todo.push({ id: it.id, text: clean(it.text), done: false });
            continue;
          }
          if (l.todo.some((x) => key(x.text) === k || x.id === it.id)) continue;
          const i = l.bought.findIndex((x) => key(x.text) === k);
          if (i >= 0) {
            const back = l.bought.splice(i, 1)[0];
            back.done = false;
            l.todo.push(back);
          } else if (!l.bought.some((x) => x.id === it.id)) {
            l.todo.push({ id: it.id, text: clean(it.text), done: false });
          }
        }
        break;
      case 'check': {
        if (o.done !== false) {
          const i = l.todo.findIndex((x) => x.id === o.id);
          if (i < 0) break;
          homes[o.id] = i + 1 < l.todo.length ? l.todo[i + 1].id : null;
          const it = l.todo.splice(i, 1)[0];
          it.done = true;
          l.bought.unshift(it);
        } else {
          const i = l.bought.findIndex((x) => x.id === o.id);
          if (i < 0) break;
          const it = l.bought.splice(i, 1)[0];
          it.done = false;
          const next = homes[o.id];
          const at = next ? l.todo.findIndex((x) => x.id === next) : -1;
          if (at >= 0) l.todo.splice(at, 0, it); else l.todo.push(it);
        }
        break;
      }
      case 'edit': {
        const t = clean(o.to);
        if (!t) { l.todo = l.todo.filter((x) => x.id !== o.id); l.bought = l.bought.filter((x) => x.id !== o.id); break; }
        const it = all().find((x) => x.id === o.id);
        if (it) it.text = t;
        break;
      }
      case 'remove':
        l.todo = l.todo.filter((x) => x.id !== o.id);
        l.bought = l.bought.filter((x) => x.id !== o.id);
        break;
      case 'clear_done':
        l.bought = [];
        break;
      default:
        break;
    }
  }

  // The body of a change as the server takes it.
  function bodyOf(o) {
    const b = { op: o.op, lex: { command: o.command } };
    if (o.items) b.items = o.items.map((x) => ({ id: x.id, text: clean(x.text) }));
    if (o.id) b.id = o.id;
    if (o.done != null) b.done = o.done;
    if (o.to != null) b.to = clean(o.to);
    return b;
  }

  function createSection(deps) {
    const S = global.LexSection;
    const C = global.LexChecklist;

    const frame = S.createFrame({
      title: 'Shopping list',
      cls: 'lex-shopping',
      back: deps.back,
      signals: deps.signals,
      // Words in a chat, the widget, the iPhone changed the list.
      events: ['shopping'],
      check: () => look(),
    });

    let server = null;      // the server's last answer
    let ops = [];           // the changes on their way, in their order
    const homes = {};
    let sending = false;
    let offline = false;
    let list = { version: 0, mode: 'base', todo: [], bought: [] };

    // The line typed now (a new item): its id, its pause timer.
    let line = null;
    // The item whose text is a field now (a press on its text).
    let editing = null;

    // ── the screen ────────────────────────────────────────────────────────────
    const box = document.createElement('div');
    box.className = 'lex-check';
    const todoHost = document.createElement('div');
    todoHost.className = 'lex-check-todo';
    const fresh = C.newRow({
      prompt: 'New item',
      onInput: (v) => { if (clean(v) || v.trim()) startLine(v); },
      onEnter: () => { fresh.input.blur(); },
      onEscape: () => { fresh.input.blur(); },
    });
    const boughtHost = document.createElement('div');
    boughtHost.className = 'lex-check-done';
    const head = document.createElement('div');
    head.className = 'lex-check-head';
    const labelBox = document.createElement('div');
    labelBox.className = 'lex-check-head-label';
    let label = S.groupLabel('Bought', 0);
    labelBox.appendChild(label);
    const clear = global.LexMessage.button({ label: 'Clear' });
    clear.addEventListener('click', () => { askClear(); });
    head.append(labelBox, clear);
    const empty = S.emptyState({ section: 'shopping', title: 'Nothing to buy', line: 'Add an item here or tell Lex: «добавь в покупки молоко»' });
    box.append(todoHost, fresh.el, boughtHost, empty);
    frame.body.appendChild(box);
    frame.body.classList.add('lex-shopping-body');
    // A press on the empty place under the list puts the cursor in the row of a new item (as Reminders on the Mac).
    frame.body.addEventListener('click', (e) => {
      if (e.target === frame.body || e.target === box || e.target === empty || empty.contains(e.target)) fresh.focus();
    });

    const rows = new Map();   // id → the row of the part
    function rowFor(it) {
      let r = rows.get(it.id);
      if (!r) {
        r = C.row({
          text: it.text,
          done: it.done,
          onCircle: () => {
            const now = itemOf(it.id);
            if (!now) return;
            if (line && line.id === it.id) endLine();
            if (editing === it.id) endEdit(true);
            change({ op: 'check', id: it.id, done: !now.done });
          },
          onText: () => beginEdit(it.id),
        });
        r.el.dataset.id = it.id;
        rows.set(it.id, r);
      }
      return r;
    }

    // A row taken off the screen may hold the cursor: its blur runs a change, and that change paints again — after
    // this painting, not inside it.
    let painting = false;
    let again = false;
    function paint() {
      if (painting) { again = true; return; }
      painting = true;
      try {
        do { again = false; paintNow(); } while (again);
      } finally {
        painting = false;
      }
    }
    function paintNow() {
      const l = copyList(server || { version: 0, mode: 'base', todo: [], bought: [] });
      for (const o of ops) apply(o, l, homes);
      list = l;
      const seen = new Set();
      const place = (host, items) => {
        let at = 0;
        for (const it of items) {
          seen.add(it.id);
          const r = rowFor(it);
          r.set(it);
          if (host.children[at] !== r.el) host.insertBefore(r.el, host.children[at] || null);
          at += 1;
        }
        for (const n of [...host.children].slice(at)) n.remove();
      };
      place(todoHost, l.todo);
      place(boughtHost, l.bought);
      for (const id of [...rows.keys()]) if (!seen.has(id)) rows.delete(id);
      if (l.bought.length) {
        const next = S.groupLabel('Bought', l.bought.length);
        if (next.textContent !== label.textContent) { label.replaceWith(next); label = next; }
        if (head.parentNode !== boughtHost.parentNode || head.nextSibling !== boughtHost) box.insertBefore(head, boughtHost);
      } else head.remove();
      // Nothing known yet (no copy, no answer): no «Nothing to buy» — the ladder of loading holds the place.
      empty.hidden = !server || l.todo.length > 0 || l.bought.length > 0;
      const waiting = ops.filter((o) => !o.hold).length;
      if (offline && waiting) frame.say(waiting === 1 ? 'No network: 1 change waits to be sent.' : `No network: ${waiting} changes wait to be sent.`);
      else frame.say(l.mode === 'sample' ? 'Test list of a stand.' : '');
    }

    const itemOf = (id) => list.todo.concat(list.bought).find((x) => x.id === id) || null;

    // ── changes ───────────────────────────────────────────────────────────────
    function change(o) {
      ops.push(Object.assign({ command: newId() }, o));
      paint();
      send();
    }

    async function send() {
      if (sending) return;
      sending = true;
      try {
        while (ops.length && !ops[0].hold) {
          const o = ops[0];
          try {
            const j = await deps.call(bodyOf(o));
            if (j && j.list) server = Object.assign(listOf(j.list), { mode: j.mode || (server && server.mode) || 'base' });
          } catch (e) {
            if (!(e && e.status && [400, 403, 404, 422].includes(e.status))) {
              offline = true;
              paint();
              return;
            }
            // Refused for good: sent again it would be refused again.
            console.warn('[shopping]', o.op, 'refused:', e && e.message);
          }
          ops = ops.filter((x) => x.command !== o.command);
          offline = false;
          paint();
        }
      } finally {
        sending = false;
      }
    }

    // The copy this device kept draws the list at once (lex-reads.js, `shopping`; the update after it is never a wait,
    // LexBusy.settle); no copy — the one ladder of loading (lex-skeleton.js, В7.87): nothing for 500 ms, then the
    // skeleton of its lines, the word of the head at 3 s, at 10 s the empty state with Retry.
    async function read() {
      if (!server && deps.kept) {
        const c = await deps.kept().catch(() => null);
        if (c && typeof c === 'object' && !server) {
          server = listOf(c);
          paint();
          if (frame.isShown() && global.LexBusy && global.LexBusy.settle) global.LexBusy.settle();
        }
      }
      const K = global.LexSkeleton;
      const wait = !server && K ? K.ladder(box, {
        skeleton: () => K.list(K.settingRow, 4),
        put: (n) => box.insertBefore(n, fresh.el),
        shown: () => frame.isShown(),
        retry: () => { look().catch(() => {}); },
      }) : null;
      let j;
      try { j = await deps.call(null); } catch (e) { if (wait) wait.fail(e); throw e; }
      const take = () => { server = listOf(j); paint(); };
      if (wait) wait.done(take); else take();
    }

    // The look of the open section and its signal: what waits goes, then the list is read.
    async function look() {
      await send();
      await read();
    }

    // ── the line of a new item ───────────────────────────────────────────────
    function startLine(v) {
      if (line) endLine();
      const id = newId();
      fresh.input.value = '';
      line = { id, timer: 0 };
      change({ op: 'add', items: [{ id, text: v }], hold: true });
      const r = rows.get(id);
      if (!r) return;
      r.edit({
        value: v,
        enterKey: 'next',
        onInput: (t) => typeLine(id, t),
        onEnter: () => { endLine(); fresh.focus(); },
        onEscape: () => { endLine(); },
        onBlur: () => { if (line && line.id === id) endLine(); },
      });
      pauseLine();
    }

    function pauseLine() {
      if (!line) return;
      clearTimeout(line.timer);
      const id = line.id;
      line.timer = setTimeout(() => { if (line && line.id === id) releaseLine(id, false); }, PAUSE_MS);
    }

    // The typing of the line: the held change takes the new text; nothing goes to the server until the pause.
    function typeLine(id, t) {
      if (!line || line.id !== id) return;
      if (!clean(t)) {
        // Erased to nothing: the item is gone, the row is the empty row of a new item again, with the cursor.
        const unsent = ops.find((o) => o.op === 'add' && o.items[0].id === id);
        ops = ops.filter((o) => !((o.op === 'add' && o.items[0].id === id) || (o.op === 'edit' && o.id === id && o.hold)));
        clearTimeout(line.timer);
        line = null;
        const r = rows.get(id);
        if (r) r.endEdit();
        if (!unsent) change({ op: 'remove', id }); else paint();
        fresh.focus();
        return;
      }
      const add = ops.find((o) => o.op === 'add' && o.items[0].id === id);
      if (add) add.items[0].text = t;
      else {
        const last = ops[ops.length - 1];
        if (last && last.op === 'edit' && last.id === id && last.hold) last.to = t;
        else ops.push({ command: newId(), op: 'edit', id, to: t, hold: true });
      }
      paint();
      pauseLine();
    }

    // A twin of the line: an item of another id with the same text.
    function twinOf(id) {
      const it = itemOf(id);
      if (!it) return null;
      const k = key(it.text);
      return list.todo.concat(list.bought).find((x) => x.id !== id && key(x.text) === k) || null;
    }

    // The held changes of the line go. A pause sends only a line without a twin: a twin is settled when it is finished.
    function releaseLine(id, finished) {
      const twin = twinOf(id);
      if (twin && !finished) return;
      if (twin) {
        const unsent = ops.some((o) => o.op === 'add' && o.items[0].id === id);
        ops = ops.filter((o) => !((o.op === 'add' && o.items[0].id === id) || (o.op === 'edit' && o.id === id)));
        if (!unsent) ops.push({ command: newId(), op: 'remove', id });
        if (twin.done) ops.push({ command: newId(), op: 'check', id: twin.id, done: false });
      } else {
        for (const o of ops) if ((o.op === 'add' && o.items[0].id === id) || (o.op === 'edit' && o.id === id)) o.hold = false;
      }
      paint();
      send();
    }

    // The line is finished: Return, Esc, the cursor went elsewhere, the section left the screen.
    function endLine() {
      if (!line) return;
      // Taken first: the field leaving the screen fires its blur, which must find the line finished.
      const { id, timer } = line;
      line = null;
      clearTimeout(timer);
      const r = rows.get(id);
      if (r) r.endEdit();
      releaseLine(id, true);
    }

    // ── a press on the text of an item ───────────────────────────────────────
    function beginEdit(id) {
      if (line) endLine();
      if (editing && editing !== id) endEdit(true);
      const r = rows.get(id);
      const it = itemOf(id);
      if (!r || !it) return;
      editing = id;
      r.edit({
        value: it.text,
        enterKey: 'done',
        onEnter: () => endEdit(true),
        onEscape: () => endEdit(false),
        onBlur: () => { if (editing === id) endEdit(true); },
      });
    }

    // Return or leaving the field keeps the new text; an empty one takes the item away; Esc keeps the old one.
    function endEdit(keep) {
      const id = editing;
      if (!id) return;
      editing = null;
      const r = rows.get(id);
      const it = itemOf(id);
      const field = r && r.el.querySelector('.lex-check-input');
      const t = field ? field.value : '';
      if (r) r.endEdit();
      if (keep && it && clean(t) !== it.text) change({ op: 'edit', id, to: t });
      else paint();
    }

    async function askClear() {
      const n = list.bought.length;
      if (!n) return;
      const yes = await deps.confirm(n === 1 ? 'Remove 1 bought item?' : `Remove ${n} bought items?`, '', { okText: 'Remove', danger: true });
      if (yes) change({ op: 'clear_done' });
    }

    // The network came back: what waits goes.
    global.addEventListener('online', () => { if (ops.length) send(); });

    paint();
    let first = null;
    return {
      el: frame.el,
      // Read ahead of the first showing: the first press shows the list as it is.
      warm() {
        if (!first) first = look().catch((e) => { first = null; throw e; });
        return first;
      },
      async show() {
        frame.enter();
        frame.watch();
        try { await look(); } catch (e) {
          // The screen keeps what it has; the frame tries again on the next signal (Gennady, 20.11.2026).
          console.warn('[shopping] look:', e && e.message);
          frame.lookNow();
        }
      },
      hide() {
        endLine();
        endEdit(true);
        frame.unwatch();
      },
      stopOpening() { frame.stopOpening(); },
      focusNew() { fresh.focus(); },
      // The board «Today» (lex-today.js) marks a purchase bought, or takes the mark back: the same change as the circle
      // of its row here, in the same queue, with the number of its command. The section need not be on the screen nor
      // have read the list: the change goes as it is, and the server's answer is the list.
      check(id, done) {
        const key = String(id || '').toLowerCase();
        if (!key) return Promise.resolve();
        ops.push({ command: newId(), op: 'check', id: key, done: done !== false });
        paint();
        return send();
      },
    };
  }

  global.WcShopping = { createSection, _apply: apply, _listOf: listOf };
})(typeof self !== 'undefined' ? self : globalThis);
