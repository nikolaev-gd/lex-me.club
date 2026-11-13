// lex-profi.js — the Profi.ru section of the page lex-me.club/app (the Mac app shows that
// page). The frame around it is lex-section.js; here is what is Profi.ru's own: chats and
// orders, the screens of the bot's menu, the head of an order. The iPhone has the same
// screens in Swift, on the same server calls. The extension does not load this file: the
// server does not name the section to it.
//
// Everything that decides lives on the server: which chat stands where, which buttons an
// order has, what a box holds and whether it went. This file draws what it is told.
//
// A window gives:
//   back                   the arrow of the window, see lex-back.js
//   rpc(name, args)        a call of a database function under the person's pass
//   openOrder(order, wanted, held, keep)
//                          open the chat of this order where chats open; held — the order chat
//                          as the window holds it (profi_item), or null; keep(item) — hold a
//                          fresher answer
//   copy(text)             put text on the clipboard, returns true when it worked
//   notify(text)           the server is lost while an order chat stands over the section
//   onChange()             the server changed something: read the open order chat, a promise
(function (global) {
  'use strict';

  const POLL_MS = 2000;
  const WAIT_MS = 500;
  const COMMAND_WAIT_S = 20;
  const STALE_S = 120;
  const CHAT_KEY_RE = /^__lex_profi__[0-9]{1,18}$/;

  const { make, button, newOpId } = global.LexSection;

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

  // A link of Profi in a message (the bot writes it as «[caption](https://…)», 2026-11-11): the caption
  // opens the same page of Profi in the browser. Everything else is plain text, as it came.
  function linkedText(node, text) {
    const src = String(text || '');
    const re = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
    let at = 0;
    for (let m; (m = re.exec(src));) {
      if (m.index > at) node.appendChild(document.createTextNode(src.slice(at, m.index)));
      const a = document.createElement('a');
      a.href = m[2];
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = m[1];
      node.appendChild(a);
      at = re.lastIndex;
    }
    if (at < src.length) node.appendChild(document.createTextNode(src.slice(at)));
    return node;
  }

  // ── the mark of Profi under what went to the client ─────────────────────────
  // The tick of Profi's list of chats, the same drawing, colours and size: one grey stroke, the
  // client has not read it yet; the second stroke and both blue, he has. The server says which.
  const TICK_NS = 'http://www.w3.org/2000/svg';
  const TICK_GREY = '#838398';
  const TICK_BLUE = '#617EF8';

  function tickNode(read) {
    const svg = document.createElementNS(TICK_NS, 'svg');
    svg.setAttribute('viewBox', '0 -1 13 13');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('class', 'lex-profi-tick');
    for (const d of ['m.62 7.18 2.5 2.74L9.3 3.08', 'm6.21 9.92 6.17-6.84']) {
      const p = document.createElementNS(TICK_NS, 'path');
      p.setAttribute('stroke-width', '1.2');
      p.setAttribute('stroke-linecap', 'round');
      p.setAttribute('stroke-linejoin', 'round');
      p.setAttribute('d', d);
      svg.appendChild(p);
    }
    setTick(svg, read);
    return svg;
  }

  function setTick(svg, read) {
    const [first, second] = svg.querySelectorAll('path');
    first.setAttribute('stroke', read ? TICK_BLUE : TICK_GREY);
    if (read) second.setAttribute('stroke', TICK_BLUE); else second.removeAttribute('stroke');
    second.setAttribute('stroke-dasharray', '10');
    second.setAttribute('stroke-dashoffset', read ? '0' : '10');
    svg.dataset.read = read ? '1' : '0';
    svg.setAttribute('aria-label', read ? 'Read by the client' : 'Not read yet');
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

  // Where a box goes: the server decides (profi_reply_where.sql) — the place of the client's latest
  // message: Profi, Max, Telegram or WhatsApp. The box only names it: on Send before the press (a new
  // message from another place changes it with the next reading of the chat), in the line under it
  // after. null is Profi.
  function placeName(ch) {
    const c = global.LexMessage && global.LexMessage.CHANNELS[ch || 'profi'];
    return c ? c.name : 'Профи.ру';
  }

  // One box. window is the row of the server; none yet while the answer is being written.
  // The text stands on the colour of what goes to the client; Send and Copy under it.
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
    const open = win.state === 'ready' || (win.state === 'failed' && win.retry);
    if (open) {
      const to = deps.replyTo || null;
      const send = button('lex-profi-btn is-main', `Send to ${placeName(to)}`, async () => {
        send.disabled = true;
        note.textContent = 'Going to the monitor…';
        try {
          const r = await deps.rpc('profi_send', { p_op_id: newOpId(), p_window: win.id });
          note.textContent = r && r.state === 'queued' ? sendingLine(r.channel) : '';
          deps.refresh();
        } catch (e) {
          send.disabled = false;
          note.textContent = 'Not sent. ' + ((e && e.message) || '');
        }
      });
      send.prepend(sendIcon());
      foot.appendChild(send);
    }
    const copy = button('lex-profi-btn', 'Copy', async () => {
      const ok = await deps.copy(win.text);
      note.textContent = ok ? 'Copied.' : 'The browser refused the clipboard.';
    });
    copy.prepend(copyIcon());
    foot.appendChild(copy);
    root.appendChild(foot);
    root.appendChild(note);
    if (win.state === 'queued') note.textContent = sendingLine(win.channel);
    if (win.state === 'sent') {
      root.classList.add('is-sent');
      note.textContent = win.channel ? `Sent to the client in ${placeName(win.channel)}.` : 'Sent to the client.';
    }
    if (win.state === 'failed') note.textContent = `Not sent${win.channel ? ` to ${placeName(win.channel)}` : ''}. ${win.error || ''}`;
    if (win.state === 'unknown') {
      note.textContent = win.channel
        ? `${placeName(win.channel)} did not confirm it. Look at the chat there: Lex will not send it again. ${win.error || ''}`
        : `The site did not confirm it. Look at the chat on Profi: Lex will not send it again. ${win.error || ''}`;
    }
    return root;
  }

  function sendingLine(ch) {
    return ch ? `Sending to ${placeName(ch)}…` : 'The monitor is sending it.';
  }

  function strokeIcon(paths, size) {
    const svg = document.createElementNS(TICK_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('aria-hidden', 'true');
    for (const [tag, attrs] of paths) {
      const n = document.createElementNS(TICK_NS, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      n.setAttribute('fill', 'none');
      n.setAttribute('stroke', 'currentColor');
      n.setAttribute('stroke-width', '2');
      n.setAttribute('stroke-linecap', 'round');
      n.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(n);
    }
    return svg;
  }
  const sendIcon = () => strokeIcon([['path', { d: 'M22 2L11 13' }], ['path', { d: 'M22 2l-7 20-4-9-9-4z' }]], 16);
  const copyIcon = () => strokeIcon([['rect', { x: '9', y: '9', width: '12', height: '12', rx: '2' }],
    ['path', { d: 'M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1' }]], 16);
  // The arrow out of the window: the order on the site of Profi.
  const outIcon = () => strokeIcon([['path', { d: 'M14 4h6v6' }], ['path', { d: 'M20 4l-9 9' }],
    ['path', { d: 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5' }]], 20);

  // ── an order chat ───────────────────────────────────────────────────────────
  // The channel of a message of an order chat that the server does not name otherwise: the site
  // of Profi. Messages of the client from Max, Telegram or WhatsApp come named (`channels`).
  const CHANNEL = 'profi';

  // The time under a bubble the thread made: one line, made once, kept last before `before`.
  function stampOf(host, at, before) {
    let line = host.querySelector(':scope > .lex-stamp');
    if (!line) {
      line = global.LexMessage.stamp({ at });
      if (!line.childElementCount) return;
    }
    if (before) host.insertBefore(line, before); else host.appendChild(line);
  }

  // deps: rpc, copy, order, reload()
  function createChat(deps) {
    let data = null;
    // The runs of the hidden discussion the person brought back with Show, while the chat is open.
    const revealed = new Set();
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
        // The client's name stands in the bar over the chat (2026-11-13), not here.
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

      // What the monitor writes into the chat, as in Telegram (2026-11-13): the client on the
      // left, what went to him on the right with the mark of Profi, a notice of Profi as a plate
      // in the middle. Every message says the channel it came by beside its time: the server
      // names the turns that came from elsewhere (`channels`, profi_open), the rest came from
      // Profi.ru. The parts know every channel (lex-message.js).
      messageNode(t) {
        const M = global.LexMessage;
        const out = t.origin === 'profi_sent';
        const notice = t.origin === 'profi_notice';
        const named = data && data.channels && data.channels[String(t.uid || '')];
        const ch = !notice && named && M.CHANNELS[named] ? named : CHANNEL;
        let node;
        if (notice) {
          node = M.notice({ channel: ch, at: t.authoredAt, body: linkedText(make('span', 'lex-notice-text', ''), t.text) });
        } else {
          // The ticks are Profi's: a message that went by another channel has none.
          const tail = out && ch === CHANNEL ? tickNode(new Set((data && data.readTurns) || []).has(String(t.uid || ''))) : null;
          node = M.bubble({ side: out ? 'out' : 'in', body: linkedText(make('div', '', ''), t.text),
            stamp: M.stamp({ channel: ch, at: t.authoredAt, tail }) });
        }
        const root = make('div', `wc-turn lex-profi-msg ${notice ? 'is-notice' : out ? 'is-sent' : 'is-client'}`);
        root.appendChild(node);
        if (t.uid) root.dataset.uid = String(t.uid);
        if (t.authoredAt) root.dataset.at = t.authoredAt;
        // The client's words and Profi's notices come without the person: they can be new.
        if (!out) root.dataset.in = '1';
        return root;
      },

      // The person's word to the model: on the right, grey, «To Lex» over it, the time under it.
      // The answer of the model: on the left in a dashed frame, «Lex · only you see this» over
      // it, the mark of the model beside it. Both are the bubbles of lex-message.js laid over
      // the turns the thread made; dressing twice changes nothing.
      dress(thread) {
        const M = global.LexMessage;
        for (const t of thread.querySelectorAll(':scope > .wc-turn-user')) {
          const box = t.querySelector(':scope > div');
          if (!box) continue;
          if (!box.classList.contains('lex-bubble')) {
            box.classList.add('lex-bubble', 'is-out', 'is-self');
            const label = make('div', 'lex-bubble-label', '');
            label.append(M.sparkle(12), document.createTextNode('To Lex'));
            box.prepend(label);
          }
          stampOf(box, t.dataset.at);
        }
        for (const t of thread.querySelectorAll(':scope > .wc-turn-assistant')) {
          if (t.classList.contains('wc-turn-news') || t.classList.contains('wc-turn-error')) continue;
          if (!t.classList.contains('lex-bubble')) {
            t.classList.add('lex-bubble', 'is-in', 'is-bot', 'lex-profi-answer');
            const av = make('span', 'lex-profi-lex-avatar', '');
            av.appendChild(M.sparkle(16));
            const label = make('div', 'lex-bubble-label lex-profi-lex-head', '');
            const only = make('span', 'lex-profi-only', '');
            only.append(M.eyeOff(13), document.createTextNode('only you see this'));
            label.append(make('span', 'lex-profi-lex-name', 'Lex'), only);
            t.prepend(av, label);
          }
          if (!t.classList.contains('is-streaming')) stampOf(t, t.dataset.at, t.querySelector(':scope > .wc-turn-foot'));
        }
      },

      // The words of an answer into its bubble, its boxes under them.
      // The words of an answer into its bubble, its boxes under them.
      paintAnswer(turn, bubble, raw, md, streaming) {
        const parts = splitAnswer(raw);
        md.into(bubble, parts.filter((p) => p.kind === 'text').map((p) => p.text.trim()).join('\n\n'));
        bubble.hidden = !parts.some((p) => p.kind === 'text');
        let host = turn.querySelector('.lex-profi-boxes');
        const boxes = parts.filter((p) => p.kind === 'box');
        if (!boxes.length) { if (host) host.remove(); return; }
        if (!host) {
          host = make('div', 'lex-profi-boxes');
          bubble.after(host);
        }
        const uid = turn.dataset.uid || '';
        const wins = ((data && data.windows) || []).filter((w) => w.turn === uid);
        host.replaceChildren(...boxes.map((b, i) => boxNode(b.text, streaming ? null : wins.find((w) => w.idx === i) || null,
          { rpc: deps.rpc, copy: deps.copy, refresh: deps.reload, replyTo: (data && data.replyTo) || null })));
      },

      // What the server keeps off the screen (profi_discussion_hides_itself.sql): the discussion
      // with the model up to the last message that went to the client, from Lex, Telegram or the
      // site. Every run of it becomes one line «Discussion with Lex is hidden · Show»; Show
      // brings that run back until the chat is left. The model still reads it all.
      // The marks of Profi follow the server with it: what the client has read turns blue.
      paintHidden(thread) {
        self.dress(thread);
        const hidden = new Set((data && data.hiddenDiscussion) || []);
        for (const f of thread.querySelectorAll(':scope > .lex-fold')) f.remove();
        let run = [];
        const flush = () => {
          if (!run.length) return;
          const uids = run.map((t) => t.dataset.uid);
          const shown = uids.every((u) => revealed.has(u));
          for (const t of run) t.classList.toggle('lex-profi-hidden', !shown);
          const line = global.LexMessage.fold({
            text: shown ? 'Discussion with Lex' : 'Discussion with Lex is hidden',
            action: shown ? 'Hide' : 'Show',
            onClick: () => {
              for (const u of uids) { if (shown) revealed.delete(u); else revealed.add(u); }
              self.paintHidden(thread);
            },
          });
          line.classList.add('lex-profi-fold');
          run[0].before(line);
          run = [];
        };
        for (const n of [...thread.children]) {
          if (n.classList.contains('lex-fold')) continue;
          if (n.classList.contains('wc-turn') && n.dataset.uid && hidden.has(n.dataset.uid)) { run.push(n); continue; }
          flush();
          if (n.classList.contains('lex-profi-hidden')) n.classList.remove('lex-profi-hidden');
        }
        flush();
        const read = new Set((data && data.readTurns) || []);
        for (const svg of thread.querySelectorAll('.lex-profi-msg.is-sent[data-uid] .lex-profi-tick')) {
          const uid = svg.closest('[data-uid]').dataset.uid;
          if ((svg.dataset.read === '1') !== read.has(uid)) setTick(svg, read.has(uid));
        }
      },

      // The bar over the chat: the client's letter and name, the channel under the name, and
      // the order on the site of Profi behind the arrow (lex-profi.css, wc-app.js).
      bar() {
        const M = global.LexMessage;
        const person = make('div', 'lex-profi-person', '');
        const who = (data && data.client) || 'Client';
        const words = make('div', 'lex-profi-person-words', '');
        words.append(make('div', 'lex-profi-person-name', who), make('div', 'lex-profi-person-channel', M.CHANNELS[CHANNEL].name));
        person.append(M.avatar(who), words);
        let link = null;
        if (data && data.orderUrl) {
          link = make('a', 'wc-icon-btn lex-profi-order-link', '');
          link.href = data.orderUrl;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.title = 'Open the order on Profi';
          link.setAttribute('aria-label', link.title);
          link.appendChild(outIcon());
        }
        return { person, link };
      },
    };
    return self;
  }

  // ── the section ─────────────────────────────────────────────────────────────
  function createSection(deps) {
    const frame = global.LexSection.createFrame({
      title: 'Profi.ru',
      cls: 'lex-profi',
      back: deps.back,
      gear: () => go('settings', 'Settings'),
      every: POLL_MS,
      check: () => poll(),
      notify: deps.notify,
      onBack: () => paint(),
    });
    const { say } = frame;

    let rev = null;
    let ticker = null;
    let home = null;
    let feedEls = new Map();
    let clockOffset = 0;
    let report = null;

    function go(id, title) {
      frame.push({ id, title });
      paint();
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

    // The order chats the window holds (the frame's keep): every chat whose line comes on the
    // screen is read ahead, one answer each (profi_item, nothing read or written by it), and a
    // press shows the chat from it at once. A line that looks different now is read again.
    const orderOfKey = new Map();
    const remember = (order, item) => {
      if (item && item.chatKey) orderOfKey.set(item.chatKey, order);
      return item;
    };
    const held = global.LexSection.keep({
      load: (order) => deps.rpc('profi_item', { p_order: order }).then((item) => remember(order, item)),
    });
    const stampOf = (c) => [c.at, c.last, c.tick, c.unread, c.closed].join('|');
    const keepOf = (order) => (item) => held.put(order, remember(order, item));

    const openOrder = (order) => frame.open(
      (wanted) => deps.openOrder(order, wanted, held.get(order), keepOf(order)), 'The chat did not open.');

    // A press on an order outside the feed. While its reply still waits there (Cancel or
    // Send), the order opens in the feed, the way Telegram shows it: opening a chat for it
    // would stop the sending (Reply yourself), and a look at an order stops nothing. The line
    // of the list says so (feed); an order that has no line in the list asks the feed itself.
    // A failed read counts as waiting, so that a bad network never stops a reply either.
    let focusOrder = null;
    async function openOrderOrFeed(order) {
      const line = ((home && home.chats) || []).find((c) => c.order === order);
      let waits = true;
      if (line && typeof line.feed === 'boolean') waits = line.feed;
      else {
        try {
          const r = await deps.rpc('profi_feed', { p_limit: 60 });
          const it = (r.items || []).find((x) => x.order === order);
          waits = !!it && (it.actions || []).some((a) => a === 'cancel' || a === 'send');
        } catch (_) { waits = true; }
      }
      if (!waits) { openOrder(order); return; }
      focusOrder = order;
      if (frame.screen === 'feed') await paintFeed();
      else go('feed', (home && home.feed && home.feed.title) || 'New orders');
    }

    // ── home ─────────────────────────────────────────────────────────────────
    function monitorSilent() {
      if (!home) return false;
      const at = home.statusAt ? new Date(home.statusAt).getTime() : 0;
      return !at || Date.now() - at > STALE_S * 1000;
    }

    function paintHome() {
      const { body } = frame;
      held.unwatch();
      body.replaceChildren();
      if (!home) return;
      const st = home.status || {};
      if (monitorSilent()) say('The monitor is not on line: nothing new will come until a Mac wakes up.', true);
      else if (st.stopped) say(`The monitor is stopped: ${st.stopped}`, true);
      else say('');
      const list = make('div', 'lex-section-list');
      const feed = home.feed || {};
      list.appendChild(global.LexSection.row({
        title: feed.title || 'New orders', sub: feed.last || 'Nothing yet.', strong: true,
        mark: feed.active ? `${feed.active} sending` : '', onClick: () => go('feed', 'New orders'),
      }));
      for (const c of home.chats || []) {
        const line = global.LexSection.row({
          title: c.title, sub: c.last || '', dot: c.unread, onClick: () => openOrderOrFeed(c.order),
          // Gennady wrote last: the tick of Profi at the last message, as in Profi's list.
          end: c.tick ? tickNode(c.tick === 'read') : null,
        });
        list.appendChild(line);
        // A reply that waits in the feed opens the feed, not the chat: nothing to read ahead.
        if (!c.feed) held.watch(line, c.order, stampOf(c));
      }
      body.appendChild(list);
      // «Only unanswered» left no chat: the server says so in its words.
      if (!(home.chats || []).length && home.empty) body.appendChild(make('div', 'lex-profi-empty', home.empty));
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
            await command('reply_self', it.order, { pressed_at: Date.now() / 1000 });
            openOrder(it.order);
          });
        }
      }
      if (it.hasChat && !(it.actions || []).includes('reply_self')) {
        foot.appendChild(button('lex-profi-btn', 'Open chat', () => openOrder(it.order)));
      }
      if (foot.childElementCount) root.appendChild(foot);
      return root;
    }

    function feedAtEnd(body) {
      return body.scrollTop + body.clientHeight >= body.scrollHeight - 80;
    }

    async function paintFeed() {
      const { body } = frame;
      const stick = !feedEls.size || feedAtEnd(body);
      const r = await deps.rpc('profi_feed', { p_limit: 60 });
      if (frame.screen !== 'feed') return;
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
      const focus = focusOrder && feedEls.get(focusOrder);
      focusOrder = null;
      if (focus) focus.n.scrollIntoView({ block: 'center' });
      else if (stick) body.scrollTop = body.scrollHeight;
    }

    function tick() {
      if (frame.screen !== 'feed') return;
      for (const { it, n } of feedEls.values()) {
        if (it.state !== 'countdown') continue;
        const st = n.querySelector('.lex-profi-order-state');
        if (st) st.textContent = stateText(it);
      }
    }

    // ── settings: the rest of the bot's menu ─────────────────────────────────
    function paintSettings() {
      const { body } = frame;
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

      // The first item: which chats the list keeps. The server keeps the switch, one for all
      // devices, and makes the list by it; a press is a command with its operation number.
      const chats = block('Chats');
      const only = make('label', 'lex-profi-switch-row');
      only.appendChild(make('span', '', 'Only unanswered'));
      const input = make('input');
      input.type = 'checkbox';
      input.checked = !!(home && home.onlyUnanswered);
      const sw = make('span', 'wc-switch');
      const track = make('span', 'wc-switch-track');
      track.appendChild(make('span', 'wc-switch-knob'));
      sw.append(input, track);
      only.appendChild(sw);
      input.addEventListener('change', async () => {
        const on = input.checked;
        input.disabled = true;
        try {
          const r = await deps.rpc('profi_show_only_unanswered', { p_op_id: newOpId(), p_on: on });
          await reloadHome();
          input.checked = !!(r && r.onlyUnanswered);
          say('');
        } catch (e) {
          input.checked = !on;
          say((e && e.message) || 'It did not work.', true);
        }
        input.disabled = false;
      });
      chats.appendChild(only);
      chats.appendChild(make('div', 'lex-profi-line is-muted',
        'The list keeps only the chats where the client wrote last and you have not answered yet.'));

      const macs = block('Working Mac');
      for (const m of st.macs || []) {
        const row = make('div', 'lex-profi-mac');
        row.appendChild(make('span', '', m.name));
        if (m.working) row.appendChild(make('span', 'lex-section-mark', 'Working'));
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
        rep.appendChild(button('lex-profi-btn', label, () => { report = { name, label }; go('report', label); }));
      }
    }

    async function paintReport() {
      const { body } = frame;
      body.replaceChildren(make('div', 'lex-profi-empty', 'Asking the monitor…'));
      try {
        const r = await command('report', null, { name: report.name });
        const res = await waitResult(r.id);
        if (frame.screen !== 'report') return;
        body.replaceChildren();
        if (res.ok === false) { say(res.error || 'It did not work.', true); return; }
        if (res.text) { body.appendChild(make('div', 'lex-profi-text', res.text)); return; }
        body.appendChild(make('div', 'lex-profi-block-title', res.title || ''));
        const list = make('div', 'lex-section-list');
        held.unwatch();
        for (const it of res.items || []) {
          const line = global.LexSection.row({
            title: it.title, sub: it.paid ? `${Math.round(it.paid)} ₽` : (it.noText ? 'No text' : ''),
            onClick: () => openOrderOrFeed(it.order),
          });
          list.appendChild(line);
          held.watch(line, it.order, `report|${it.paid || ''}`);
        }
        body.appendChild(list);
        if (report.name === 'answered') {
          body.appendChild(button('lex-profi-btn', 'Open all on the Mac', async () => { await command('open_answered'); }));
        }
      } catch (e) {
        if (frame.screen === 'report') say((e && e.message) || 'It did not work.', true);
      }
    }

    function paint() {
      const { screen } = frame;
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

    // A change counts as seen only when it reached the screen and the open order chat: after
    // a failed read the next look tries again. An error goes up to the watch of the frame.
    async function poll() {
      const r = await deps.rpc('profi_rev', {});
      if (r === rev) return;
      const seen = rev;
      try {
        if (frame.isShown()) {
          await reloadHome();
          const { screen } = frame;
          if (screen === 'home' || screen === 'settings') paint();
          else if (screen === 'feed') await paintFeed();
        }
        if (deps.onChange) await deps.onChange();
        rev = r;
      } catch (e) {
        rev = seen;
        throw e;
      }
    }

    return {
      el: frame.el,
      stopOpening: frame.stopOpening,
      // The person left an order chat and its visit ended (what came is read): the chat is read
      // again, so the next press shows it as it is now, with the «Новые» line from this visit.
      visited(chatKey) {
        const order = orderOfKey.get(chatKey);
        if (order) held.ahead(order, null);
      },
      async show() {
        frame.enter();
        try {
          await reloadHome();
          await paint();
        } catch (e) {
          say('The section did not load. ' + ((e && e.message) || ''), true);
        }
        // The person may have left during the first reading: an order chat starts its own watch.
        if (frame.isShown()) this.watch();
      },
      // The screen follows the server while the section or an order chat is open.
      watch() {
        frame.watch();
        if (!ticker) ticker = setInterval(tick, 500);
      },
      unwatch() {
        frame.unwatch();
        clearInterval(ticker);
        ticker = null;
      },
      hide() { this.unwatch(); },
      // A notification of the Mac app was clicked (webchat/wc-app.js): a message of an order
      // chat opens the order the way a press on it outside the feed does; a notification
      // about an order (new, reply sent, not sent) — the feed of new orders at that order.
      // The screen of the section now ('home', 'feed', …): the page tells the server the list
      // of new orders is on the screen (webchat/wc-app.js, presenceKey).
      get screen() { return frame.screen; },
      openOrder: openOrderOrFeed,
      openFeed() { go('feed', (home && home.feed && home.feed.title) || 'New orders'); },
      async openFeedAt(order) {
        focusOrder = order;
        if (frame.screen === 'feed') await paintFeed();
        else go('feed', (home && home.feed && home.feed.title) || 'New orders');
      },
    };
  }

  // boxNode — also for the check of a box on a page of its own (dev-tools/check-profi-box.mjs).
  global.LexProfi = { isChatKey, splitAnswer, createSection, createChat, newOpId, boxNode };
})(typeof window !== 'undefined' ? window : globalThis);
