// lex-news.js — the News section for the two surfaces that share browser code: the
// extension and the page lex-me.club/app (the Mac app shows that page). The frame around
// it is lex-section.js; here is what is News's own: letters and cards, the order of the
// feed, the mark of a read card, the head of a card. Each window only hands over how to
// reach the server. No chrome.*, no window of its own, nothing about who may see News:
// that answer comes from the server (lex_home_sections). The iPhone has the same
// screens in Swift, on the same server calls.
//
// A window gives:
//   back                the arrow of the window, see lex-back.js
//   rpc(name, args)     a call of a database function under the person's pass
//   post(kind, body)    a call of llm-proxy/<kind>
//   showCard({ id, text, head, title })   put a card on screen now, from what the feed
//                       holds, or answer false when it cannot; no call may stand in between
//   openChat({ chatKey, title })   open this chat where chats open; a card on screen
//                       stays where the person is reading
//   keepFeed(blocks) / keptFeed()   what the device holds between launches, optional
//   reload(title)       read the open chat again after Process again in its head, unless
//                       the person left it or an answer is being written
//   onPaint()           the head came late and pushed the feed: stand where it stood
//   copy(text)          put text on the clipboard, returns true when it worked
//   pickModel(anchor, modelId, onPick)   the common model menu
(function (global) {
  'use strict';

  const LINK_RE = /\[([^\]\n]+)\]\((https?:[^\s)]+)\)/g;

  const { make, button, newOpId } = global.LexSection;

  const ENTRY_ICON = '<svg class="lex-news-entry-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h13v14a2 2 0 0 0 2 2H6a2 2 0 0 1-2-2z"/><path d="M17 9h3v10a2 2 0 0 1-2 2"/><path d="M8 9h5M8 13h5M8 17h3"/></svg>';
  const ENTRY_ICON_PROFI = '<svg class="lex-news-entry-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-8 8H4l2.3-3A8 8 0 1 1 21 12z"/><path d="M9 11h6M9 14h4"/></svg>';
  const ENTRY_CHEVRON = '<svg class="lex-news-entry-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';

  // Heads of chats a card opened: the feed knows them, so no call is needed to show one.
  const knownHeads = new Map();

  // The first message of a news chat: words of the letter, shown as they are. The
  // Markdown of teacher answers would eat an asterisk and turn a line into a list,
  // so this text takes only paragraphs, bold words, points of a list and links, and
  // builds nodes, never HTML.
  function addLine(host, line) {
    line.split(/(?<!\\)\*\*/).forEach((piece, i) => {
      const into = i % 2 ? host.appendChild(make('strong', 'lex-news-text-bold')) : host;
      const words = (t) => document.createTextNode(t.replace(/\\\*/g, '*'));
      let at = 0;
      for (const m of piece.matchAll(LINK_RE)) {
        if (m.index > at) into.appendChild(words(piece.slice(at, m.index)));
        const a = make('a', 'lex-link', m[1].replace(/\\\*/g, '*'));
        a.href = m[2];
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        into.appendChild(a);
        at = m.index + m[0].length;
      }
      if (at < piece.length) into.appendChild(words(piece.slice(at)));
    });
  }

  function renderText(host, text) {
    host.replaceChildren();
    for (const para of String(text || '').split(/\n{2,}/)) {
      if (!para.trim()) continue;
      const p = make('p', 'lex-news-text-para');
      const point = para.startsWith('• ');
      if (point) {
        p.classList.add('is-point');
        p.appendChild(make('span', 'lex-news-point-mark', '• '));
      }
      (point ? para.slice(2) : para).split('\n').forEach((line, i) => {
        if (i) p.appendChild(document.createElement('br'));
        addLine(p, line);
      });
      host.appendChild(p);
    }
  }

  // Words of the text without the addresses of its links and without its marks: what
  // word picking and copying work on.
  function plainText(text) {
    return String(text || '').replace(LINK_RE, '$1').replace(/(?<!\\)\*\*/g, '').replace(/\\\*/g, '*');
  }

  // ── the line above Chats ────────────────────────────────────────────────────
  // sections is what the server said to show. An account without News gets an
  // empty list, so the host shows nothing.
  function renderEntries(host, sections, onPick) {
    host.replaceChildren();
    for (const s of Array.isArray(sections) ? sections : []) {
      const b = make('button', 'lex-news-entry');
      b.type = 'button';
      b.innerHTML = s.id === 'profi' ? ENTRY_ICON_PROFI : ENTRY_ICON;
      b.appendChild(make('span', 'lex-news-entry-title', s.title));
      b.insertAdjacentHTML('beforeend', ENTRY_CHEVRON);
      b.dataset.section = s.id;
      b.addEventListener('click', () => onPick(s.id));
      host.appendChild(b);
    }
    host.hidden = !host.childElementCount;
  }

  // ── Process again ───────────────────────────────────────────────────────────
  // One call for the three places of the button: the red line of a letter that failed,
  // the three dots of a card in the feed, the three dots in the head of a card. A press
  // pays again. Answers { changed, said }: said is [text, isError] for the person.
  async function processLetter(post, letterId) {
    const r = await post('news-refresh', { round: newOpId(), letterId, opId: newOpId() });
    if (r.status === 'processed' && r.cards) return { changed: true, said: [''] };
    if (r.status === 'processed') return { changed: false, said: ['The model found no cards. The cards stay as they were.'] };
    if (r.status === 'busy') return { changed: false, said: ['This letter is being processed.'] };
    return { changed: false, said: [r.error || 'The letter was not processed.', true] };
  }

  // ── the feed ────────────────────────────────────────────────────────────────
  const NEW_ITEMS_LOOK_MS = 30000;
  const KEPT_LETTERS = 50;

  function createFeed(deps) {
    const refreshBtn = button('lex-news-refresh', 'Refresh');
    const frame = global.LexSection.createFrame({
      title: 'News',
      cls: 'lex-news',
      back: deps.back,
      tools: [refreshBtn],
      gear: () => openSettings(),
      every: NEW_ITEMS_LOOK_MS,
      check: () => lookForNew(),
      onBack: () => backToFeed(),
    });
    const fresh = button('lex-news-fresh', 'New items');
    fresh.hidden = true;
    frame.el.appendChild(fresh);
    const scroller = frame.body;
    const blocksEl = make('div', 'lex-news-blocks lex-section-list');
    const empty = make('div', 'lex-news-empty', 'Nothing here yet.');
    empty.hidden = true;
    scroller.append(blocksEl, empty);

    let more = null;
    let loading = false;
    let busy = false;
    let opened = false;
    let savedTop = 0;
    let saveTimer = null;
    let lastSaved = null;
    let keptBlocks = null;

    const setStatus = (text, isError) => frame.say(text, isError, busy);

    function cardNode(card, block) {
      const row = global.LexSection.row({
        id: card.id,
        cls: 'lex-news-card',
        title: card.title,
        sub: card.description,
        dot: !card.read,
        wrap: true,
        more: [{ label: 'Process again', onSelect: () => processAgain(block) }],
        onClick: () => openCard(card, block, row),
      });
      return row;
    }

    // A letter has no header of its own: the feed is one list of cards. It stays a
    // node only so that a next page does not bring a letter twice.
    function blockNode(block) {
      const art = make('article', 'lex-news-block');
      art.dataset.letter = String(block.id);
      if (block.state === 'failed') {
        const row = make('div', 'lex-news-failed', `${block.title} was not processed. ${block.error || ''} `);
        row.appendChild(button('lex-news-failed-again', 'Process again', () => processAgain(block)));
        art.appendChild(row);
      }
      for (const c of block.cards || []) art.appendChild(cardNode(c, block));
      return art;
    }

    function paint(blocks, append) {
      if (!append) blocksEl.replaceChildren();
      const have = new Set([...blocksEl.children].map((n) => n.dataset.letter));
      for (const b of blocks) {
        if (!have.has(String(b.id))) blocksEl.appendChild(blockNode(b));
      }
      empty.hidden = !!blocksEl.childElementCount;
    }

    async function load(opts) {
      const r = await deps.rpc('list_news', {
        p_limit: 20,
        p_to_anchor: !!(opts && opts.toAnchor),
      });
      paint(r.blocks || [], false);
      more = r.more || null;
      fresh.hidden = true;
      keptBlocks = (r.blocks || []).slice(0, KEPT_LETTERS);
      keep(r.anchor || lastSaved);
      return r;
    }

    // What the device holds between openings: the feed and the place in it.
    function keep(anchor) {
      if (deps.keepFeed && keptBlocks) deps.keepFeed({ blocks: keptBlocks, anchor: anchor || null });
    }

    // Items come by themselves. While the feed is on screen it looks whether something
    // stands above its top item, and only then offers the button. Nothing new, nothing shown.
    async function lookForNew() {
      if (busy || document.hidden) return;
      const first = ((await deps.rpc('list_news', { p_limit: 1 })).blocks || [])[0];
      const top = blocksEl.firstElementChild;
      fresh.hidden = !first || (!!top && top.dataset.letter === String(first.id));
    }
    fresh.addEventListener('click', async () => {
      await load().catch((e) => setStatus('The feed did not load. ' + ((e && e.message) || ''), true));
      scroller.scrollTop = 0;
    });

    async function loadMore() {
      if (!more || loading) return;
      loading = true;
      try {
        const r = await deps.rpc('list_news', { p_limit: 20, p_before_at: more.beforeAt, p_before_id: more.beforeId });
        paint(r.blocks || [], true);
        more = r.more || null;
      } catch (e) {
        console.warn('[news] next page:', e && e.message);
      } finally {
        loading = false;
      }
    }

    const cardNodeOf = (itemId) => (itemId ? blocksEl.querySelector(`.lex-news-card[data-id="${itemId}"]`) : null);

    function standOn(itemId) {
      const node = cardNodeOf(itemId);
      if (node) scroller.scrollTop += node.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    }

    // The place in the feed is a card, because pixels mean nothing on another
    // screen. The top card goes to the server when scrolling stops.
    function topCard() {
      const top = scroller.getBoundingClientRect().top;
      for (const c of blocksEl.querySelectorAll('.lex-news-card')) {
        if (c.getBoundingClientRect().bottom > top + 1) return c.dataset.id;
      }
      return null;
    }

    function noteScroll() {
      if (scroller.scrollTop + scroller.clientHeight > scroller.scrollHeight - 400) loadMore();
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        const id = topCard();
        if (!id || id === lastSaved) return;
        lastSaved = id;
        keep(id);
        deps.rpc('save_news_position', { p_item_id: id }).catch((e) => console.warn('[news] position:', e && e.message));
      }, 1200);
    }
    scroller.addEventListener('scroll', noteScroll, { passive: true });

    // The text is on the device, so the card is on screen in the same moment. The chat
    // behind it comes after: it writes the mark and brings the field and earlier turns.
    function openCard(card, block, row) {
      savedTop = scroller.scrollTop;
      global.LexSection.markRead(row);
      lastSaved = card.id;
      return frame.open(async (wanted) => {
        const head = {
          letterId: block.id, title: card.title, newsletter: block.title, date: block.date,
          author: card.author || null, webUrl: block.webUrl || null,
        };
        const text = card.body ? card.body + (card.sourceUrl ? `\n\n[Source](${card.sourceUrl})` : '') : '';
        const shown = !!text && deps.showCard({ id: card.id, text, head, title: card.title }) !== false;
        let r;
        try {
          r = await deps.rpc('open_news_item', { p_op_id: newOpId(), p_item_id: card.id });
        } catch (e) {
          if (!shown) throw e;
          if (wanted()) deps.cardFailed((e && e.message) || '');
          return;
        }
        knownHeads.set(r.chatKey, head);
        // Back in the feed by now, or on another card: this one stays marked, nothing moves.
        if (wanted()) deps.openChat({ chatKey: r.chatKey, title: r.title, shown, wanted });
      }, 'The news did not open.');
    }

    // The letter stays where it stood, whatever new cards it got.
    async function processAgain(block) {
      if (busy) return;
      busy = true;
      setStatus(`Processing ${block.title} again…`);
      const letter = () => blocksEl.querySelector(`[data-letter="${block.id}"]`);
      let end;
      try {
        ({ said: end } = await processLetter(deps.post, block.id));
        const was = letter();
        const top = was ? was.getBoundingClientRect().top : 0;
        await load({ toAnchor: true });
        const now = letter();
        if (was && now) scroller.scrollTop += now.getBoundingClientRect().top - top;
      } catch (e) {
        end = ['Process again failed. ' + ((e && e.message) || ''), true];
      }
      busy = false;
      setStatus(...end);
    }

    async function refresh() {
      if (busy) return;
      busy = true;
      refreshBtn.disabled = true;
      setStatus('Updating…');
      const round = newOpId();
      let failed = [];
      let stopped = null;
      let end;
      try {
        for (let i = 0; i < 300; i++) {
          const r = await deps.post('news-refresh', { round });
          if (r.mailError && !i) console.warn('[news] mail:', r.mailError);
          if (r.status === 'processed' || r.status === 'failed') {
            await load();
          } else if (r.status === 'stopped') {
            stopped = r.error || 'Nothing was processed.';
            break;
          } else if (!r.more) {
            failed = r.failed || [];
            break;
          }
          setStatus(r.remaining > 0 ? `Processing… ${r.remaining} left` : 'Processing…');
        }
        await load();
        if (stopped) end = [stopped, true];
        else if (failed.length) end = [`Not processed: ${[...new Set(failed)].join(', ')}.`, true];
        else end = [''];
      } catch (e) {
        end = ['Refresh failed. ' + ((e && e.message) || ''), true];
      }
      busy = false;
      refreshBtn.disabled = false;
      setStatus(...end);
    }
    refreshBtn.addEventListener('click', refresh);

    // The settings are a screen of the section: the arrow leads back to the feed.
    async function openSettings() {
      savedTop = scroller.scrollTop;
      const block = createSettings(deps);
      const body = frame.push({ id: 'settings', title: 'Settings' });
      body.appendChild(block.el);
      try {
        if (!(await block.load())) frame.say('The settings did not load.', true);
      } catch (e) {
        frame.say('The settings did not load. ' + ((e && e.message) || ''), true);
      }
    }

    // Letters come by themselves, so the way back reads the feed again, and what was on
    // screen stays where it was even when new cards came above it.
    async function backToFeed() {
      scroller.scrollTop = savedTop;
      if (busy) return;
      const keep = cardNodeOf(topCard());
      const id = keep && keep.dataset.id;
      const was = keep ? keep.getBoundingClientRect().top : 0;
      try {
        const r = await load({ toAnchor: true });
        const now = cardNodeOf(id);
        if (now) scroller.scrollTop += now.getBoundingClientRect().top - was;
        else standOn(r.anchor); // Process again gave the cards new numbers
      } catch (e) {
        console.warn('[news] feed:', e && e.message);
      }
    }

    return {
      el: frame.el,
      refresh,
      // The person went to another chat: the card being opened stays marked, nothing moves.
      stopOpening: frame.stopOpening,
      // Show the feed. The first time it stands on the saved place.
      async show() {
        frame.stopOpening();
        frame.enter();
        if (!opened) {
          opened = true;
          // What the device holds comes first, the server corrects it a moment later.
          const kept = deps.keptFeed ? await deps.keptFeed() : null;
          if (kept && kept.blocks && kept.blocks.length) {
            paint(kept.blocks, false);
            standOn(kept.anchor);
          }
          try {
            const r = await load({ toAnchor: true });
            standOn(r.anchor);
            lastSaved = r.anchor || null;
            if (frame.isShown()) frame.watch();
          } catch (e) {
            opened = false;
            setStatus('The feed did not load. ' + ((e && e.message) || ''), true);
          }
          return;
        }
        frame.watch();
        if (frame.screen === 'home') await backToFeed();
      },
      hide() {
        if (!scroller.hidden) savedTop = scroller.scrollTop;
        frame.unwatch();
      },
    };
  }

  // ── the head of a news chat ────────────────────────────
  // Stands over the first message and outside it: the title of the card and a small
  // gray line of where it came from. So the message stays the words of the letter, and
  // word picking counts them as ever. The server answers null for a chat that is not
  // news, and then nothing shows. A window gives chatKey, rpc, post and reload.
  function createChatHead(deps) {
    const root = make('header', 'lex-news-chat-head');
    root.hidden = true;
    const title = make('h2', 'lex-news-chat-title');
    const line = make('div', 'lex-news-chat-source');
    const note = make('div', 'lex-news-chat-note');
    note.setAttribute('role', 'status');
    note.hidden = true;
    root.append(title, line, note);
    let busy = false;

    const say = (text, isError) => {
      note.textContent = text || '';
      note.hidden = !text;
      note.classList.toggle('is-error', !!isError);
      note.classList.toggle('is-busy', !!text && busy);
    };

    async function processAgain(letterId) {
      if (busy) return;
      busy = true;
      say('Processing the letter again…');
      let end;
      try {
        const r = await processLetter(deps.post, letterId);
        end = r.said;
        if (r.changed) {
          knownHeads.delete(deps.chatKey);
          await deps.reload(title.textContent);
        }
      } catch (e) {
        end = ['Process again failed. ' + ((e && e.message) || ''), true];
      }
      busy = false;
      say(...end);
    }

    function paint(head) {
      title.textContent = head.title || '';
      line.replaceChildren();
      let name;
      if (head.webUrl) {
        name = make('a', 'lex-news-chat-newsletter', `${head.newsletter} ↗`);
        name.href = head.webUrl;
        name.target = '_blank';
        name.rel = 'noopener noreferrer';
      } else {
        name = make('span', 'lex-news-chat-newsletter', head.newsletter);
      }
      line.append(name, make('span', '', head.date));
      if (head.author) line.appendChild(make('span', '', head.author));
      line.appendChild(global.LexSection.moreButton([
        { label: 'Process again', onSelect: () => processAgain(head.letterId) },
      ], root));
      root.hidden = false;
    }

    const known = deps.head || knownHeads.get(deps.chatKey);
    if (known) {
      paint(known);
      return root;
    }
    deps.rpc('news_chat_head', { p_chat_key: deps.chatKey })
      .then((head) => {
        if (!head) return;
        paint(head);
        if (deps.onPaint) deps.onPaint();
      })
      .catch((e) => console.warn('[news] head:', e && e.message));
    return root;
  }

  // ── settings ────────────────────────────────────────────────────────────────
  // Everything is on the server and the same on every device; this block only
  // shows it and sends what changed. It stands behind the gear of the feed.
  function createSettings(deps) {
    const root = make('div', 'lex-news-settings');
    let state = null;

    const save = async (patch) => {
      state = await deps.rpc('save_news_settings', { p_op_id: newOpId(), p_patch: patch });
      return state;
    };
    const field = (label) => {
      const f = make('div', 'lex-news-field');
      f.appendChild(make('div', 'lex-news-field-label', label));
      return f;
    };
    const note = make('div', 'lex-news-note');
    const say = (t, isError) => { note.textContent = t || ''; note.classList.toggle('is-error', !!isError); };

    function senderRow(s, list) {
      const row = make('div', 'lex-news-sender');
      const name = make('input', 'lex-news-input');
      name.placeholder = 'Name';
      name.value = s.name || '';
      const addr = make('input', 'lex-news-input');
      addr.placeholder = 'sender@example.com';
      addr.value = s.address || '';
      addr.type = 'email';
      const del = make('button', 'lex-news-mini', '×');
      del.type = 'button';
      del.setAttribute('aria-label', 'Remove');
      const push = () => saveSenders(list);
      name.addEventListener('change', push);
      addr.addEventListener('change', push);
      del.addEventListener('click', () => { row.remove(); push(); });
      row.append(name, addr, del);
      return row;
    }

    async function saveSenders(list) {
      const senders = [...list.querySelectorAll('.lex-news-sender')].map((r) => {
        const [n, a] = r.querySelectorAll('input');
        return { name: n.value.trim(), address: a.value.trim() };
      }).filter((s) => s.address);
      try {
        await save({ senders });
        say('Saved.');
      } catch (e) {
        say('Not saved. ' + ((e && e.message) || ''), true);
      }
    }

    function paint() {
      root.replaceChildren();
      const addr = field('Forwarding address');
      const line = make('div', 'lex-news-address');
      line.appendChild(make('code', 'lex-news-address-value', state.address));
      const copy = make('button', 'lex-news-mini', 'Copy');
      copy.type = 'button';
      copy.addEventListener('click', async () => {
        const ok = await deps.copy(state.address);
        say(ok ? 'Address copied.' : 'The browser refused the clipboard.', !ok);
      });
      line.appendChild(copy);
      addr.appendChild(line);

      const model = field('Processing model');
      const pick = make('button', 'lex-news-model', deps.modelLabel ? deps.modelLabel(state.modelId) : state.modelId);
      pick.type = 'button';
      pick.addEventListener('click', () => deps.pickModel(pick, state.modelId, async (id) => {
        try {
          await save({ modelId: id });
          pick.textContent = deps.modelLabel ? deps.modelLabel(state.modelId) : state.modelId;
          say('Saved.');
        } catch (e) {
          say('Not saved. ' + ((e && e.message) || ''), true);
        }
      }));
      model.appendChild(pick);

      // What the letters took from the balance in 30 days, the server counts it.
      const cost = field('Processing cost');
      const spent = state.cost || { usd: 0, letters: 0 };
      cost.appendChild(make('div', 'lex-news-cost',
        `Last 30 days: ${global.LexChatMoney.format(spent.usd)}, ${spent.letters} ${spent.letters === 1 ? 'letter' : 'letters'}`));

      const senders = field('Newsletters');
      const list = make('div', 'lex-news-senders');
      for (const s of state.senders || []) list.appendChild(senderRow(s, list));
      const add = make('button', 'lex-news-mini', 'Add newsletter');
      add.type = 'button';
      add.addEventListener('click', () => {
        const row = senderRow({}, list);
        list.appendChild(row);
        row.querySelector('input').focus();
      });
      senders.append(list, add);

      const prompt = field('Processing prompt');
      const area = make('textarea', 'lex-news-prompt');
      area.value = state.prompt || '';
      area.rows = 10;
      const savePrompt = make('button', 'lex-news-mini', 'Save prompt');
      savePrompt.type = 'button';
      savePrompt.addEventListener('click', async () => {
        try {
          await save({ prompt: area.value });
          say('Saved.');
        } catch (e) {
          say('Not saved. ' + ((e && e.message) || ''), true);
        }
      });
      prompt.append(area, savePrompt);

      root.append(addr, model, cost, senders, prompt, note);
    }

    return {
      el: root,
      async load() {
        state = await deps.rpc('news_settings', {});
        if (state) paint();
        return !!state;
      },
    };
  }

  const api = { createFeed, createChatHead, renderEntries, renderText, plainText, newOpId };
  global.LexNews = api;
})(typeof window !== 'undefined' ? window : globalThis);
