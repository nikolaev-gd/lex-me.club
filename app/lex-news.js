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
//   signals             the channel of the database's signals (lex-account-events.js): the
//                       feed looks for a new letter at the signal «news»; none — it does not
//   rpc(name, args)     a call of a database function under the person's pass
//   post(kind, body)    a call of llm-proxy/<kind>
//   showCard({ id, text, head, title })   put a card on screen now, from what the feed
//                       holds, or answer false when it cannot; no call may stand in between
//   openChat({ chatKey, title })   open this chat where chats open; a card on screen
//                       stays where the person is reading
//   keepFeed(blocks) / keptFeed()   what the device holds between launches, optional
//   read(name, args, show, empty)   the window's way to read what a screen shows (lex-reads.js,
//                       twice): the copy this device kept first; without it the server alone
//   reload(title)       read the open chat again after Process again in its head, unless
//                       the person left it or an answer is being written
//   onPaint()           the head came late and pushed the feed: stand where it stood
//   copy(text)          put text on the clipboard, returns true when it worked
//   pickModel(anchor, modelId, onPick)   the common model menu
//   head(spec)          optional: the window shows the head of the feed in its own bar (the page and
//                       the Mac app, where the three stripes stand): { title, busy, refresh(),
//                       settings() } while the feed is on the screen, null — the bar as it was. A window
//                       without it shows the section's own bar (the extension, whose bar is full)
//   tabs(o)             optional: the common tabs (В7.27, WcUI.tabs on the page) for the row of kinds of
//                       source over the feed; it shows only when the feed holds two kinds or more
//
// The look is the standard of Lex (ios/Lex/STANDARD.md): a card of the feed is В7.31, the head of a
// news and the line «Обсуждение с Lex» under its text — В7.32 (lex-message.js); Gennady's choice of
// 2026-11-15, the canvas «News: 3 + 3 варианта», boards «Лента 3» and «Новость 1».
(function (global) {
  'use strict';

  const LINK_RE = /\[([^\]\n]+)\]\((https?:[^\s)]+)\)/g;

  const { make, button, newOpId } = global.LexSection;
  const M = () => global.LexMessage;

  const REFRESH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 4v5h-5"/></svg>';
  const OPEN_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17L17 7"/><path d="M8 7h9v9"/></svg>';
  // The same circle arrow as a node, 16: the item «Process again» of the menu of a held card.
  function againIcon() {
    const box = make('span');
    box.innerHTML = REFRESH_ICON;
    const n = box.firstChild;
    n.setAttribute('width', '16');
    n.setAttribute('height', '16');
    return n;
  }

  // ── words of the reading time ───────────────────────────────────────────────
  // The minutes and the limit of a long read come from the server (lex_news_minutes,
  // news_cards_by_source.sql); a server without them says nothing, and nothing is shown.
  function minutesWord(n) {
    const a = n % 10;
    const b = n % 100;
    if (a === 1 && b !== 11) return `${n} минута`;
    if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return `${n} минуты`;
    return `${n} минут`;
  }
  // The line of a long read on a card: «Длинное чтение, 18 минут».
  const longLine = (card) => (card && card.long && card.minutes > 0 ? `Длинное чтение, ${minutesWord(card.minutes)}` : '');
  // The line under the title of a news: the author when the letter names one, and the reading time —
  // «Mike Taylor, 18 минут чтения».
  const readLine = (head) => [head && head.author, head && head.minutes > 0 ? `${minutesWord(head.minutes)} чтения` : '']
    .filter(Boolean).join(', ');
  // Under the text of a news: where the talk with the model starts.
  const talkLine = () => {
    const n = M().talkLine('Обсуждение с Lex');
    n.classList.add('lex-news-talk');
    return n;
  };

  // What a screen shows is read the window's way: the copy kept on the device first.
  const readOf = (deps) => deps.read
    || ((name, args, show) => deps.rpc(name, args).then((v) => { show(v, true, false); return v; }));

  // The pencil of «New chat» — the two paths the head of a chat draws (chat-surface.js, newChatBtn).
  const ENTRY_ICON_NEW = '<svg class="lex-news-entry-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4Z"/></svg>';

  // Heads of chats a card opened: the feed knows them, so no call is needed to show one.
  const knownHeads = new Map();

  // The first message of a news chat: words of the letter, shown as they are. The
  // Markdown of teacher answers would eat an asterisk and turn a line into a list,
  // so this text takes only paragraphs, bold words, points of a list and links, and
  // builds nodes, never HTML.
  function addLine(host, line) {
    line.split(/(?<!\\)\*\*/).forEach((piece, i) => {
      const into = i % 2 ? host.appendChild(make('strong', 'lex-news-text-bold')) : host;
      // Links — the one rule of Lex (lex-links.js): «[caption](address)» and a bare address.
      global.LexLinks.into(into, piece, (t) => t.replace(/\\\*/g, '*'));
    });
  }

  // A paragraph that is one bold run and nothing else is a subheading of the letter («**Why it
  // matters**»): 16/650 (ios/Lex/STANDARD.md В7.32).
  const HEAD_RE = /^\*\*(?:(?!\*\*)[^\n])+\*\*$/;

  function renderText(host, text) {
    host.replaceChildren();
    for (const para of String(text || '').split(/\n{2,}/)) {
      if (!para.trim()) continue;
      const p = make('p', 'lex-news-text-para');
      if (HEAD_RE.test(para.trim())) p.classList.add('is-head');
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

  // ── the entries of the sections ─────────────────────────────────────────────
  // sections is what the server said to show. The look, the order and the titles are the common part В7.62
  // (LexSection.entries): an account without sections gets an empty list, so the host shows nothing. Returns
  // { setActive(id) } — the line of the open section stands chosen.
  function renderEntries(host, sections, onPick) {
    return global.LexSection.entries(host, sections, onPick);
  }

  // The line «New chat» under the name of the menu of chats (Gennady, 2026-11-18): the look of the lines of
  // the sections, with a pencil and no chevron. A press opens the empty main chat, from a section too.
  function renderNewChat(host, label, onPick) {
    host.replaceChildren();
    const b = make('button', 'lex-news-entry lex-news-entry--new');
    b.type = 'button';
    b.innerHTML = ENTRY_ICON_NEW;
    b.appendChild(make('span', 'lex-news-entry-title', label));
    b.setAttribute('aria-label', label);
    b.addEventListener('click', () => onPick());
    host.appendChild(b);
    host.hidden = false;
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
  const KEPT_LETTERS = 50;

  function createFeed(deps) {
    // The bar of the section: «News», Refresh and the gear as buttons with an icon, a zone of 44
    // (В7.11). A window with a bar of its own (deps.head) shows them there instead.
    const refreshBtn = global.LexSection.iconButton('lex-news-refresh lex-section-icon', REFRESH_ICON, 'Refresh', null);
    const frame = global.LexSection.createFrame({
      title: 'News',
      cls: 'lex-news',
      back: deps.back,
      tools: [refreshBtn],
      gear: () => openSettings(),
      // A letter came or changed its state: the database's signal «news» (account_signals.sql).
      signals: deps.signals,
      events: ['news'],
      check: () => lookForNew(),
      onBack: () => backToFeed(),
    });
    const fresh = button('lex-news-fresh', 'New items');
    fresh.hidden = true;
    frame.el.appendChild(fresh);
    const scroller = frame.body;
    // The cards stand as bubbles: the day line between two days is a plate (lex-message.css).
    const blocksEl = make('div', 'lex-news-blocks lex-bubbles');
    // The one empty state of a section (В7.61): the face of News, one line.
    const empty = global.LexSection.emptyState({ section: 'news', title: 'Nothing here yet.' });
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
    // The kind of source the row of tabs shows, 'all' — every kind.
    let kind = 'all';
    let kindsRow = null;

    const setStatus = (text, isError) => frame.say(text, isError, busy);

    // The head in the window's own bar: on the first screen of the section, while it is shown.
    function syncHead() {
      if (!deps.head) return;
      deps.head(frame.isShown() && frame.screen === 'home'
        ? { title: 'News', busy, refresh, settings: openSettings }
        : null);
    }
    function setBusy(v) {
      busy = v;
      refreshBtn.disabled = v;
      syncHead();
    }

    // The menu of a held card (В7.9): the card is lit, «Process again» over it. The extension has
    // no common menu of a held button: there the menu of the section, the one its three dots had.
    function holdMenu(node, block) {
      if (busy) return;
      if (global.LexSendLater && global.LexSendLater.menu) {
        global.LexSendLater.menu({
          anchor: node, lit: node, align: 'left',
          items: [{ label: 'Process again', icon: againIcon(), run: () => processAgain(block) }],
        });
      } else {
        global.LexSection.openMenu(node, [{ label: 'Process again', onSelect: () => processAgain(block) }], frame.el);
      }
    }

    // One news — one card (В7.31): the whole card opens it, a hold (or the right button of the
    // mouse) gives «Process again».
    function cardNode(card, block) {
      const node = M().newsCard({
        kind: block.kind || 'email',
        source: block.title,
        author: card.author || null,
        at: block.at || null,
        // A server before 2026-11-15 gives no moment, only the day: the day stands for the time.
        timeText: block.at ? undefined : (block.date || ''),
        title: card.title,
        sub: card.description,
        foot: longLine(card),
        unread: !card.read,
      });
      node.dataset.id = card.id;
      // The common menu of a message (block 2, 2026-11-18): Copy (the title and the line under it), Select, Copy
      // link (the source of the news), Process again. A hold, the right button of a mouse, «⋯» for a mouse.
      if (M().attachMenu) {
        M().attachMenu(node, {
          text: () => [card.title, card.description].map((x) => String(x || '').trim()).filter(Boolean).join('\n'),
          who: () => block.title || 'News',
          at: () => block.at || null,
          host: () => frame.el,
          link: card.sourceUrl ? () => card.sourceUrl : null,
          items: () => (busy ? [] : [{ label: 'Process again', icon: againIcon(), run: () => processAgain(block) }]),
        });
      } else {
        const hold = global.LexLongPress ? global.LexLongPress.attach(node, () => holdMenu(node, block)) : null;
        node.addEventListener('contextmenu', (e) => { e.preventDefault(); holdMenu(node, block); });
        node.addEventListener('click', (e) => { if (hold && hold.didFire()) e.stopImmediatePropagation(); }, true);
      }
      node.addEventListener('click', () => openCard(card, block, node));
      return node;
    }

    // A letter has no header of its own: the feed is one list of cards, the newest letter on top,
    // its cards in the order of the letter. It stays a node only so that a next page does not bring
    // a letter twice, and for the day lines: its moment is the letter's.
    function blockNode(block) {
      const art = make('article', 'lex-news-block');
      art.dataset.letter = String(block.id);
      art.dataset.kind = block.kind || 'email';
      if (block.at) art.dataset.at = block.at;
      if (block.state === 'failed') {
        const row = make('div', 'lex-news-failed', `${block.title} was not processed. ${block.error || ''} `);
        row.appendChild(button('lex-news-failed-again', 'Process again', () => processAgain(block)));
        art.appendChild(row);
      }
      for (const c of block.cards || []) art.appendChild(cardNode(c, block));
      return art;
    }

    // The row of kinds of source over the feed: only when the feed holds two kinds or more, so with
    // the letters of newsletters alone there is no row. «Всё» and a tab per kind.
    function syncKinds() {
      const kinds = [...new Set([...blocksEl.querySelectorAll('.lex-news-block')].map((n) => n.dataset.kind))];
      if (kinds.length < 2 || !deps.tabs) {
        if (kindsRow) { kindsRow.remove(); kindsRow = null; }
        if (kind !== 'all') { kind = 'all'; showKind(); }
        return;
      }
      if (kind !== 'all' && !kinds.includes(kind)) kind = 'all';
      const items = [{ id: 'all', label: 'Всё' }, ...kinds.map((k) => ({ id: k, label: M().newsKindName(k) }))];
      if (kindsRow) { kindsRow.update(items, kind); return; }
      kindsRow = deps.tabs({
        label: 'Kind of source', items, selected: kind,
        onSelect: (id) => { kind = id; showKind(); scroller.scrollTop = 0; },
      });
      kindsRow.classList.add('lex-news-kinds');
      frame.el.insertBefore(kindsRow, frame.el.querySelector('.lex-section-body'));
    }
    // The cards of the other kinds leave the screen; the day lines stand over what is shown.
    function showKind() {
      for (const b of blocksEl.querySelectorAll('.lex-news-block')) b.hidden = kind !== 'all' && b.dataset.kind !== kind;
      M().mark(blocksEl, null);
    }

    function paint(blocks, append) {
      if (!append) blocksEl.replaceChildren();
      const have = new Set([...blocksEl.querySelectorAll('.lex-news-block')].map((n) => n.dataset.letter));
      for (const b of blocks) {
        if (!have.has(String(b.id))) blocksEl.appendChild(blockNode(b));
      }
      syncKinds();
      showKind();
      empty.hidden = !!blocksEl.querySelector('.lex-news-block');
    }

    async function load(opts) {
      const r = await deps.rpc('list_news', {
        p_limit: 20,
        p_to_anchor: !!(opts && opts.toAnchor),
      });
      // The ladder of a first opening without the copy (lex-skeleton.js): the cards come when the skeleton has stood.
      if (opts && opts.wait) await new Promise((resolve) => opts.wait.done(resolve));
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
      if (busy) return;
      const first = ((await deps.rpc('list_news', { p_limit: 1 })).blocks || [])[0];
      const top = blocksEl.querySelector('.lex-news-block');
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

    const cardNodeOf = (itemId) => (itemId ? blocksEl.querySelector(`.lex-ncard[data-id="${itemId}"]`) : null);

    function standOn(itemId) {
      const node = cardNodeOf(itemId);
      if (node) scroller.scrollTop += node.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    }

    // The place in the feed is a card, because pixels mean nothing on another
    // screen. The top card goes to the server when scrolling stops.
    function topCard() {
      const top = scroller.getBoundingClientRect().top;
      for (const c of blocksEl.querySelectorAll('.lex-ncard')) {
        if (c.offsetParent && c.getBoundingClientRect().bottom > top + 1) return c.dataset.id;
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
    function openCard(card, block, node) {
      savedTop = scroller.scrollTop;
      M().newsCardRead(node);
      card.read = true;
      lastSaved = card.id;
      return frame.open(async (wanted) => {
        const head = {
          letterId: block.id, title: card.title, newsletter: block.title, date: block.date,
          at: block.at || null, kind: block.kind || 'email', minutes: card.minutes || null,
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
      setBusy(true);
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
      setBusy(false);
      setStatus(...end);
    }

    async function refresh() {
      if (busy) return;
      setBusy(true);
      // «Updating…» only after 3 s, as every wait of Lex (STANDARD.md В7.74, the ladder of loading): a quick round says
      // nothing at all.
      const slowWord = setTimeout(() => { if (busy) setStatus('Updating…'); }, 3000);
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
      clearTimeout(slowWord);
      setBusy(false);
      setStatus(...end);
    }
    refreshBtn.addEventListener('click', refresh);

    // The settings are a screen of the section: the arrow leads back to the feed.
    async function openSettings() {
      savedTop = scroller.scrollTop;
      const block = createSettings(deps);
      const body = frame.push({ id: 'settings', title: 'Settings' });
      syncHead();
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
      syncHead();
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

    const feed = {
      el: frame.el,
      refresh,
      // The person went to another chat: the card being opened stays marked, nothing moves.
      stopOpening: frame.stopOpening,
      // Show the feed. Entering the section (its line, a notification) reads the feed anew
      // and stands on the newest item (Gennady, 2026-11-14 — before, it stood on the card the
      // person had stopped at, somewhere in the middle). The way back from a card or the
      // settings (opts.back) reads what came and keeps the place.
      async show(opts) {
        const back = !!(opts && opts.back);
        frame.stopOpening();
        frame.enter();
        syncHead();
        if (!opened) {
          opened = true;
          // What the device holds comes first, the server corrects it a moment later.
          const kept = deps.keptFeed ? await deps.keptFeed() : null;
          const fromCopy = !!(kept && kept.blocks && kept.blocks.length);
          if (fromCopy) {
            paint(kept.blocks, false);
            scroller.scrollTop = 0;
            // The feed stood from the copy: its update is no wait of the press (lex-busy.js, В7.74).
            if (global.LexBusy && global.LexBusy.settle) global.LexBusy.settle();
          }
          // No copy: the ladder of loading with the skeleton of the cards (lex-skeleton.js, В7.87).
          const S = global.LexSkeleton;
          const wait = !fromCopy && S ? S.ladder(blocksEl, {
            skeleton: () => S.list(S.newsCard, 4),
            shown: () => frame.isShown(),
            retry: () => { wait.stop(); feed.show(opts).catch(() => {}); },
          }) : null;
          try {
            await load({ wait });
            scroller.scrollTop = 0;
            lastSaved = topCard();
            if (frame.isShown()) frame.watch();
          } catch (e) {
            // Silent on the screen (Gennady, 20.11.2026): what the screen has stays, the next opening reads again;
            // with nothing on it — the empty state with Retry.
            opened = false;
            if (wait) wait.fail();
            console.warn('[news] show:', e && e.message);
          }
          return;
        }
        frame.watch();
        if (frame.screen !== 'home') return;
        if (back) { await backToFeed(); return; }
        if (busy) { scroller.scrollTop = 0; return; }
        try {
          await load();
        } catch (e) {
          console.warn('[news] feed:', e && e.message);
        }
        scroller.scrollTop = 0;
      },
      hide() {
        if (!scroller.hidden) savedTop = scroller.scrollTop;
        frame.unwatch();
        if (deps.head) deps.head(null);
      },
    };
    return feed;
  }

  // ── the head of a news ──────────────────────────────────────────────────────
  // The news is its text first, then the talk (В7.32). Over the first message and outside it: the
  // title 22/650, under it 13 in grey the author and the reading time («Mike Taylor, 18 минут
  // чтения»), and the line of a round of Process again. So the message stays the words of the letter,
  // and word picking counts them as ever. Where the news came from — the mark of the kind and the
  // name of the source, the date and the time, «Open in the browser» and the three dots with «Process
  // again» — stands in the head of the screen: a window with a bar of its own takes them through
  // deps.onHead({ head, processAgain, isBusy }) (the page, the Mac app); the extension's bar is full, so
  // there they stand here, over the title. The server answers null for a chat that is not news, and
  // then nothing shows. A window gives chatKey, rpc, post and reload.
  function createChatHead(deps) {
    const root = make('header', 'lex-news-chat-head');
    root.hidden = true;
    const top = deps.onHead ? null : make('div', 'lex-news-chat-top');
    const title = make('h2', 'lex-news-chat-title');
    const meta = make('div', 'lex-news-chat-meta');
    meta.hidden = true;
    const note = make('div', 'lex-news-chat-note');
    note.setAttribute('role', 'status');
    note.hidden = true;
    if (top) root.appendChild(top);
    root.append(title, meta, note);
    let busy = false;

    const say = (text, isError) => {
      note.textContent = text || '';
      note.hidden = !text;
      note.classList.toggle('is-error', !!isError);
      note.classList.toggle('is-busy', !!text && busy);
      if (text && busy && !isError) {
        // The common ring before the words (lex-busy.css, В7.74).
        const ring = document.createElement('span');
        ring.className = 'lex-busy-ring is-inline';
        ring.setAttribute('aria-hidden', 'true');
        note.prepend(ring);
      }
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

    // The source of the news, as the head of a screen: the extension draws it here.
    function paintTop(head) {
      top.replaceChildren(M().newsSource({
        kind: head.kind || 'email', source: head.newsletter, at: head.at || null,
        timeText: head.at ? undefined : (head.date || ''),
      }));
      if (head.webUrl) {
        const open = make('a', 'lex-section-icon lex-news-web');
        open.href = head.webUrl;
        open.target = '_blank';
        open.rel = 'noopener noreferrer';
        open.title = 'Open in the browser';
        open.setAttribute('aria-label', 'Open in the browser');
        open.innerHTML = OPEN_ICON;
        top.appendChild(open);
      }
      top.appendChild(global.LexSection.moreButton([
        { label: 'Process again', onSelect: () => processAgain(head.letterId) },
      ], root, 'lex-section-icon'));
    }

    function paint(head) {
      title.textContent = head.title || '';
      const words = readLine(head);
      meta.textContent = words;
      meta.hidden = !words;
      if (top) paintTop(head);
      root.hidden = false;
      if (deps.onHead) deps.onHead({ head, processAgain: () => processAgain(head.letterId), isBusy: () => busy });
    }

    const known = deps.head || knownHeads.get(deps.chatKey);
    if (known) {
      paint(known);
      return root;
    }
    let painted = false;
    readOf(deps)('news_chat_head', { p_chat_key: deps.chatKey }, (head, fresh, same) => {
      if (!head || same) return;
      painted = true;
      paint(head);
      if (deps.onPaint) deps.onPaint();
    }, () => !painted)
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
        await readOf(deps)('news_settings', {}, (v, fresh, same) => {
          if (!v || same) return;
          state = v;
          paint();
        }, () => !state);
        return !!state;
      },
    };
  }

  const api = { createFeed, createChatHead, renderEntries, renderNewChat, renderText, plainText, newOpId, talkLine, readLine, longLine, minutesWord };
  global.LexNews = api;
})(typeof window !== 'undefined' ? window : globalThis);
