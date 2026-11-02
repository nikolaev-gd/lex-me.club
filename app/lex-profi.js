// lex-profi.js — the Profi.ru section of the page lex-me.club/app (the Mac app shows that
// page). The iPhone has the same screens in Swift, on the same server calls. The extension
// does not load this file: the server does not name the section to it.
//
// Everything that decides lives on the server: which chat stands where, which buttons an
// order has, what a box holds and whether it went. This file draws what it is told.
//
// A window gives:
//   rpc(name, args)        a call of a database function under the person's pass
//   openOrder(order)       open the chat of this order where chats open
//   copy(text)             put text on the clipboard, returns true when it worked
//   moreButton(onClick)    the three dots of a row, as at a chat in Chats
//   menu(anchor, items)    the menu they open: [{label, onSelect}]
(function (global) {
  'use strict';

  const POLL_MS = 2000;
  const WAIT_MS = 500;
  const COMMAND_WAIT_S = 20;
  const STALE_S = 120;
  const CHAT_KEY_RE = /^__lex_profi__[0-9]{1,18}$/;

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

  function newOpId() {
    if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
  }

  const isChatKey = (key) => typeof key === 'string' && CHAT_KEY_RE.test(key);

  // ── a box with text for the client inside an answer ─────────────────────────
  // What the model marked: <client_text>…</client_text>. An answer still being written has
  // an opening tag and no end: its text is already the box, and it has no buttons yet.
  function splitAnswer(text) {
    const parts = [];
    let rest = String(text || '');
    for (;;) {
      const at = rest.indexOf('<client_text');
      if (at < 0) break;
      if (at > 0) parts.push({ kind: 'text', text: rest.slice(0, at) });
      const gt = rest.indexOf('>', at);
      if (gt < 0) { rest = ''; parts.push({ kind: 'box', text: '', open: true }); break; }
      const after = rest.slice(gt + 1);
      const end = after.indexOf('</client_text>');
      if (end < 0) { parts.push({ kind: 'box', text: after, open: true }); rest = ''; break; }
      parts.push({ kind: 'box', text: after.slice(0, end).trim(), open: false });
      rest = after.slice(end + '</client_text>'.length);
    }
    if (rest) {
      // A tag that has only begun to arrive stays off the screen.
      const cut = rest.search(/<(c(l(i(e(n(t(_(t(e(x(t)?)?)?)?)?)?)?)?)?)?)?$/);
      parts.push({ kind: 'text', text: cut >= 0 ? rest.slice(0, cut) : rest });
    }
    return parts.filter((p) => p.kind === 'box' || p.text.trim());
  }

  function priceLine(price) {
    if (!price) return '';
    if (typeof price.summa === 'number') {
      const sum = String(price.summa).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
      const unit = price.edinica === 'час' ? 'per hour' : 'per job';
      return `${price.ot ? 'from ' : ''}${sum} ₽ ${unit}`;
    }
    return price.text || '';
  }

  // One box. window is the row of the server; none yet while the answer is being written.
  function boxNode(text, win, deps) {
    const root = make('div', 'lex-profi-box');
    root.appendChild(make('div', 'lex-profi-box-text', text));
    if (!win) {
      root.classList.add('is-writing');
      return root;
    }
    const price = priceLine(win.price);
    if (price) root.appendChild(make('div', 'lex-profi-box-price', `Price: ${price}`));
    const foot = make('div', 'lex-profi-box-foot');
    const note = make('div', 'lex-profi-box-note');
    note.setAttribute('role', 'status');
    const copy = button('lex-profi-btn', 'Copy', async () => {
      const ok = await deps.copy(win.text);
      note.textContent = ok ? 'Copied.' : 'The browser refused the clipboard.';
    });
    foot.appendChild(copy);
    const open = win.state === 'ready' || (win.state === 'failed' && win.retry);
    if (open) {
      const send = button('lex-profi-btn is-main', 'Send', async () => {
        send.disabled = true;
        note.textContent = 'Going to the monitor…';
        try {
          const r = await deps.rpc('profi_send', { p_op_id: newOpId(), p_window: win.id });
          note.textContent = r && r.state === 'queued' ? 'The monitor is sending it.' : '';
          deps.refresh();
        } catch (e) {
          send.disabled = false;
          note.textContent = 'Not sent. ' + ((e && e.message) || '');
        }
      });
      foot.appendChild(send);
    }
    root.appendChild(foot);
    root.appendChild(note);
    if (win.state === 'queued') note.textContent = 'The monitor is sending it.';
    if (win.state === 'sent') {
      root.classList.add('is-sent');
      note.textContent = 'Sent to the client.';
    }
    if (win.state === 'failed') note.textContent = `Not sent. ${win.error || ''}`;
    if (win.state === 'unknown') note.textContent = `The site did not confirm it. Look at the chat on Profi: Lex will not send it again. ${win.error || ''}`;
    return root;
  }

  // ── an order chat ───────────────────────────────────────────────────────────
  // deps: rpc, copy, order, reload()
  function createChat(deps) {
    let data = null;
    const self = {
      order: deps.order,
      get data() { return data; },
      set data(v) { data = v; },

      // The order the way Profi shows it. On top what matters at a glance, then its blocks,
      // below what is seen less often. What stands where is the monitor's and the server's word.
      head() {
        const root = make('header', 'lex-profi-head');
        if (!data) return root;
        root.appendChild(make('div', 'lex-profi-head-title', data.title || ''));
        const line = make('div', 'lex-profi-head-line');
        const add = (node) => {
          if (line.childElementCount) line.appendChild(make('span', '', '·'));
          line.appendChild(node);
        };
        if (data.client) add(make('span', '', data.client));
        if (data.budget) add(make('span', '', data.budget));
        if (data.chatUrl) {
          const a = make('a', 'lex-profi-link', 'Chat on Profi');
          a.href = data.chatUrl;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          add(a);
        }
        if (line.childElementCount) root.appendChild(line);
        if ((data.facts || []).length) root.appendChild(make('div', 'lex-profi-head-facts', data.facts.join(' · ')));
        for (const s of data.sections || []) {
          root.appendChild(make('div', 'lex-profi-head-block', s.title));
          root.appendChild(make('div', 'lex-profi-head-text', s.text));
        }
        if ((data.foot || []).length) root.appendChild(make('div', 'lex-profi-head-foot', data.foot.join(' · ')));
        return root;
      },

      // A message of the client or what went to him: the two kinds of turn the monitor writes.
      messageNode(t) {
        const out = t.origin === 'profi_sent';
        const root = make('div', `wc-turn lex-profi-msg ${out ? 'is-sent' : 'is-client'}`);
        if (t.uid) root.dataset.uid = String(t.uid);
        const when = t.authoredAt ? new Date(t.authoredAt) : null;
        const stamp = when && !Number.isNaN(when.getTime())
          ? when.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
        root.appendChild(make('div', 'lex-profi-msg-who', `${out ? 'Sent to the client' : (data && data.client) || 'Client'}${stamp ? ' · ' + stamp : ''}`));
        root.appendChild(make('div', 'lex-profi-msg-text', t.text));
        return root;
      },

      // The words of an answer into its bubble, its boxes under them.
      paintAnswer(turn, bubble, raw, md, streaming) {
        const parts = splitAnswer(raw);
        md.into(bubble, parts.filter((p) => p.kind === 'text').map((p) => p.text.trim()).join('\n\n'));
        bubble.hidden = !parts.some((p) => p.kind === 'text');
        let host = turn.querySelector(':scope > .lex-profi-boxes');
        const boxes = parts.filter((p) => p.kind === 'box');
        if (!boxes.length) { if (host) host.remove(); return; }
        if (!host) {
          host = make('div', 'lex-profi-boxes');
          bubble.after(host);
        }
        const uid = turn.dataset.uid || '';
        const wins = ((data && data.windows) || []).filter((w) => w.turn === uid);
        host.replaceChildren(...boxes.map((b, i) => boxNode(b.text, streaming ? null : wins.find((w) => w.idx === i) || null,
          { rpc: deps.rpc, copy: deps.copy, refresh: deps.reload })));
      },

      // What the server keeps off the screen: the discussion up to the last press of the
      // button in the corner. The model still reads it.
      paintHidden(thread) {
        const hidden = new Set((data && data.hiddenTurns) || []);
        for (const t of thread.querySelectorAll('.wc-turn[data-uid]')) {
          t.classList.toggle('lex-profi-hidden', hidden.has(t.dataset.uid));
        }
      },
    };
    return self;
  }

  // ── the section ─────────────────────────────────────────────────────────────
  function createSection(deps) {
    const root = make('section', 'lex-profi');
    const headEl = make('header', 'lex-profi-bar');
    const body = make('div', 'lex-profi-body');

    let screen = 'home';
    let rev = null;
    let timer = null;
    let ticker = null;
    let home = null;
    let feedEls = new Map();
    let clockOffset = 0;
    let report = null;

    // The note stands in the bar's shadow, outside the list: a repaint of a screen keeps it.
    const noteEl = make('div', 'lex-profi-note');
    noteEl.setAttribute('role', 'status');
    noteEl.hidden = true;
    const say = (text, isError) => {
      noteEl.textContent = text || '';
      noteEl.classList.toggle('is-error', !!isError);
      noteEl.hidden = !text;
    };

    root.append(headEl, noteEl, body);

    function bar(title, back, right) {
      headEl.replaceChildren();
      if (back) headEl.appendChild(button('lex-profi-back', '‹ Back', () => { say(''); screen = back; paint(); }));
      headEl.appendChild(make('div', 'lex-profi-title', title));
      if (right) headEl.appendChild(right);
    }

    async function command(kind, order, args) {
      const r = await deps.rpc('profi_command', { p_op_id: newOpId(), p_kind: kind, p_order: order || null, p_args: args || {} });
      return r;
    }

    async function waitResult(id) {
      for (let i = 0; i < (COMMAND_WAIT_S * 1000) / WAIT_MS; i++) {
        const r = await deps.rpc('profi_command_result', { p_id: id });
        if (r && r.done) return r.result || {};
        await new Promise((ok) => setTimeout(ok, WAIT_MS));
      }
      return { ok: false, error: 'The monitor did not answer. Is the working Mac awake?' };
    }

    // ── home ─────────────────────────────────────────────────────────────────
    function rowNode(title, sub, opts) {
      const row = make('div', 'lex-profi-row');
      if (opts.first) row.classList.add('is-first');
      if (opts.dot) row.classList.add('is-unread');
      const b = button('lex-profi-row-main', null, opts.onClick);
      const top = make('div', 'lex-profi-row-top');
      top.appendChild(make('span', 'lex-profi-row-title', title));
      if (opts.mark) top.appendChild(make('span', 'lex-profi-mark', opts.mark));
      b.appendChild(top);
      if (sub) b.appendChild(make('span', 'lex-profi-row-sub', sub));
      row.appendChild(b);
      if (opts.more) row.appendChild(deps.moreButton((e) => deps.menu(e.currentTarget, opts.more)));
      return row;
    }

    async function lower(order) {
      try {
        await deps.rpc('profi_lower', { p_order: order });
        await reloadHome();
        paint();
      } catch (e) {
        say((e && e.message) || 'It did not work.', true);
      }
    }

    function monitorSilent() {
      if (!home) return false;
      const at = home.statusAt ? new Date(home.statusAt).getTime() : 0;
      return !at || Date.now() - at > STALE_S * 1000;
    }

    function paintHome() {
      bar('Profi.ru', null, button('lex-profi-gear', 'Settings', () => { screen = 'settings'; paint(); }));
      body.replaceChildren();
      if (!home) return;
      const st = home.status || {};
      if (monitorSilent()) say('The monitor is not on line: nothing new will come until a Mac wakes up.', true);
      else if (st.stopped) say(`The monitor is stopped: ${st.stopped}`, true);
      else say('');
      const list = make('div', 'lex-profi-list');
      const feed = home.feed || {};
      const active = feed.active ? `${feed.active} sending` : '';
      list.appendChild(rowNode(feed.title || 'New orders', feed.last || 'Nothing yet.', {
        first: true, mark: active, onClick: () => { screen = 'feed'; paint(); },
      }));
      for (const c of home.chats || []) {
        list.appendChild(rowNode(c.title, c.last || '', {
          dot: c.unread, onClick: () => deps.openOrder(c.order),
          more: [{ label: 'Nothing to answer', onSelect: () => lower(c.order) }],
        }));
      }
      body.appendChild(list);
    }

    // ── new orders ───────────────────────────────────────────────────────────
    const STATE_WORDS = {
      sending: 'Sending now…', queued: 'In the queue.', sent: 'Sent.', cancelled: 'Cancelled: nothing went.',
      stopped: 'Stopped: you reply yourself.', ready: 'Not sent: press Send to send it.', failed: 'Not sent.',
      unknown: 'The site did not confirm it. Look at the order on Profi.',
    };

    function stateText(it) {
      if (it.state === 'countdown') {
        const left = Math.max(0, Math.ceil((it.sendAt || 0) - (Date.now() / 1000 + clockOffset)));
        return `Sending in ${left} s`;
      }
      const base = STATE_WORDS[it.state] || '';
      if (it.state === 'sent' && it.paid) return `Sent. Paid ${Math.round(it.paid)} ₽.`;
      return it.stateLine ? `${base} ${it.stateLine}`.trim() : base;
    }

    function orderNode(it) {
      const root = make('article', 'lex-profi-order');
      root.dataset.order = it.order;
      if (it.uncertain) root.appendChild(make('div', 'lex-profi-order-flag', 'Not sure'));
      const title = make('a', 'lex-profi-order-title', it.title + (it.budget ? ` — ${it.budget}` : ''));
      title.href = it.orderUrl || '#';
      title.target = '_blank';
      title.rel = 'noopener noreferrer';
      root.appendChild(title);
      if (it.description) root.appendChild(make('div', 'lex-profi-order-desc', it.description));
      if (it.draft) root.appendChild(make('div', 'lex-profi-order-draft', it.draft));
      const price = priceLine(it.price);
      if (price) root.appendChild(make('div', 'lex-profi-order-price', `Price: ${price}`));
      const st = make('div', 'lex-profi-order-state');
      st.dataset.state = it.state;
      st.textContent = stateText(it);
      root.appendChild(st);
      const foot = make('div', 'lex-profi-order-foot');
      const act = (label, cls, fn) => foot.appendChild(button(`lex-profi-btn ${cls}`, label, async (e) => {
        e.currentTarget.disabled = true;
        try { await fn(); } catch (err) { say((err && err.message) || 'The command did not go.', true); }
      }));
      for (const a of it.actions || []) {
        if (a === 'cancel') act('Cancel', 'is-danger', () => command('cancel', it.order, { pressed_at: Date.now() / 1000 }));
        if (a === 'send') act('Send', 'is-main', () => command('send_draft', it.order));
        if (a === 'reply_self') {
          act('Reply yourself', '', async () => {
            const r = await command('reply_self', it.order, { pressed_at: Date.now() / 1000 });
            deps.openOrder(it.order, r && r.chatKey);
          });
        }
      }
      if (it.hasChat && !(it.actions || []).includes('reply_self')) {
        foot.appendChild(button('lex-profi-btn', 'Open chat', () => deps.openOrder(it.order)));
      }
      if (foot.childElementCount) root.appendChild(foot);
      return root;
    }

    function feedAtEnd() {
      return body.scrollTop + body.clientHeight >= body.scrollHeight - 80;
    }

    async function paintFeed() {
      bar('New orders', 'home');
      const stick = !feedEls.size || feedAtEnd();
      const r = await deps.rpc('profi_feed', { p_limit: 60 });
      if (screen !== 'feed') return;
      clockOffset = (r.now || Date.now() / 1000) - Date.now() / 1000;
      feedEls = new Map();
      body.replaceChildren();
      const items = r.items || [];
      if (!items.length) body.appendChild(make('div', 'lex-profi-empty', 'No orders yet.'));
      for (const it of items) {
        const n = orderNode(it);
        feedEls.set(it.order, { it, n });
        body.appendChild(n);
      }
      if (stick) body.scrollTop = body.scrollHeight;
    }

    function tick() {
      if (screen !== 'feed') return;
      for (const { it, n } of feedEls.values()) {
        if (it.state !== 'countdown') continue;
        const st = n.querySelector('.lex-profi-order-state');
        if (st) st.textContent = stateText(it);
      }
    }

    // ── settings: the rest of the bot's menu ─────────────────────────────────
    function paintSettings() {
      bar('Settings', 'home');
      body.replaceChildren();
      const st = (home && home.status) || {};
      const block = (title) => {
        const b = make('div', 'lex-profi-block');
        b.appendChild(make('div', 'lex-profi-block-title', title));
        body.appendChild(b);
        return b;
      };
      const run = (kind, args, doneText) => async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        say('Going to the monitor…');
        try {
          const r = await command(kind, null, args);
          const res = await waitResult(r.id);
          say(res.ok === false ? (res.error || 'It did not work.') : doneText, res.ok === false);
        } catch (err) {
          say((err && err.message) || 'The command did not go.', true);
        }
        btn.disabled = false;
      };

      const macs = block('Working Mac');
      for (const m of st.macs || []) {
        const row = make('div', 'lex-profi-mac');
        row.appendChild(make('span', '', m.name));
        if (m.working) row.appendChild(make('span', 'lex-profi-mark', 'Working'));
        else row.appendChild(button('lex-profi-btn', 'Switch here', run('switch_mac', { mac: m.id }, 'Switching: it takes about a minute.')));
        macs.appendChild(row);
      }
      if (!(st.macs || []).length) macs.appendChild(make('div', 'lex-profi-empty', 'The monitor has not said yet.'));
      if (st.switching) macs.appendChild(make('div', 'lex-profi-empty', 'A switch is going on.'));

      const auto = block('Sending');
      auto.appendChild(make('div', 'lex-profi-line', st.auto
        ? 'The bot sends a reply by itself when it is sure.' : 'A reply goes only when you press Send.'));
      auto.appendChild(button('lex-profi-btn', st.auto ? 'Turn auto-send off' : 'Turn auto-send on',
        run(st.auto ? 'auto_off' : 'auto_on', {}, 'Done.')));
      if (st.noMoney) {
        auto.appendChild(make('div', 'lex-profi-line is-error', 'Paid replies are on pause: the card has no money.'));
        auto.appendChild(button('lex-profi-btn', 'Card topped up', run('card_topped_up', {}, 'Paid replies go again.')));
      }

      const all = block('Monitor');
      if (st.stopped) all.appendChild(make('div', 'lex-profi-line is-error', st.stopped));
      all.appendChild(button('lex-profi-btn', 'Stop everything', run('stop_all', {}, 'Stopped.')));
      all.appendChild(button('lex-profi-btn', 'Start everything', run('start_all', {}, 'Started.')));
      all.appendChild(button('lex-profi-btn', 'Update both Macs', run('update_macs', {}, 'The Macs are updating.')));

      const rep = block('Today');
      for (const [name, label] of [['answered', 'Answered today'], ['unanswered', 'Unanswered today'], ['question', 'In question today'],
        ['summary', 'Summary of the day'], ['stats', 'Statistics']]) {
        rep.appendChild(button('lex-profi-btn', label, () => { report = { name, label }; screen = 'report'; paint(); }));
      }
    }

    async function paintReport() {
      bar(report.label, 'settings');
      body.replaceChildren(make('div', 'lex-profi-empty', 'Asking the monitor…'));
      try {
        const r = await command('report', null, { name: report.name });
        const res = await waitResult(r.id);
        if (screen !== 'report') return;
        body.replaceChildren();
        if (res.ok === false) { say(res.error || 'It did not work.', true); return; }
        if (res.text) { body.appendChild(make('div', 'lex-profi-text', res.text)); return; }
        body.appendChild(make('div', 'lex-profi-block-title', res.title || ''));
        const list = make('div', 'lex-profi-list');
        for (const it of res.items || []) {
          list.appendChild(rowNode(it.title, it.paid ? `${Math.round(it.paid)} ₽` : (it.noText ? 'No text' : ''), {
            onClick: () => deps.openOrder(it.order),
          }));
        }
        body.appendChild(list);
        if (report.name === 'answered') {
          body.appendChild(button('lex-profi-btn', 'Open all on the Mac', async () => { await command('open_answered'); }));
        }
      } catch (e) {
        if (screen === 'report') say((e && e.message) || 'It did not work.', true);
      }
    }

    function paint() {
      if (screen === 'home') paintHome();
      else if (screen === 'feed') return paintFeed().catch((e) => say((e && e.message) || 'The orders did not load.', true));
      else if (screen === 'settings') paintSettings();
      else if (screen === 'report') return paintReport();
      return null;
    }

    async function reloadHome() {
      home = await deps.rpc('profi_home', {});
      rev = home.rev;
    }

    async function poll() {
      try {
        const r = await deps.rpc('profi_rev', {});
        if (r === rev) return;
        rev = r;
        if (root.isConnected && !root.closest('[hidden]')) {
          if (screen === 'home' || screen === 'settings') { await reloadHome(); paint(); } else if (screen === 'feed') await paint();
        }
        if (deps.onChange) deps.onChange();
      } catch (e) {
        console.warn('[profi] rev:', e && e.message);
      }
    }

    return {
      el: root,
      async show(target) {
        if (target) screen = target;
        try {
          await reloadHome();
          await paint();
        } catch (e) {
          say('The section did not load. ' + ((e && e.message) || ''), true);
        }
        this.watch();
      },
      // The screen follows the server while the section or an order chat is open.
      watch() {
        if (!timer) timer = setInterval(poll, POLL_MS);
        if (!ticker) ticker = setInterval(tick, 500);
      },
      unwatch() {
        clearInterval(timer);
        clearInterval(ticker);
        timer = ticker = null;
      },
    };
  }

  global.LexProfi = { isChatKey, splitAnswer, createSection, createChat, newOpId };
})(typeof window !== 'undefined' ? window : globalThis);
