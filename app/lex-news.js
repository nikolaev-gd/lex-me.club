// lex-news.js — the News section for the two surfaces that share browser code: the
// extension and the page lex-me.club/app (the Mac app shows that page). One button,
// one feed, one card, one settings block; each window only hands over how to reach
// the server. No chrome.*, no window of its own, nothing about who may see News:
// that answer comes from the server (lex_home_sections). The iPhone has the same
// screens in Swift, on the same server calls.
//
// A window gives:
//   rpc(name, args)     a call of a database function under the person's pass
//   post(kind, body)    a call of llm-proxy/<kind>
//   openChat({ chatKey, title })   open this chat where chats open
//   copy(text)          put text on the clipboard, returns true when it worked
//   pickModel(anchor, modelId, onPick)   the common model menu
(function (global) {
  'use strict';

  const LINK_RE = /\[([^\]\n]+)\]\((https?:[^\s)]+)\)/g;

  function make(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  const ENTRY_ICON = '<svg class="lex-news-entry-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h13v14a2 2 0 0 0 2 2H6a2 2 0 0 1-2-2z"/><path d="M17 9h3v10a2 2 0 0 1-2 2"/><path d="M8 9h5M8 13h5M8 17h3"/></svg>';
  const ENTRY_CHEVRON = '<svg class="lex-news-entry-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';

  function newOpId() {
    if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
  }

  // The first message of a news chat: words of the letter, shown as they are. The
  // Markdown of teacher answers would eat an asterisk and turn a line into a list,
  // so this text takes only paragraphs and links, and builds nodes, never HTML.
  function renderText(host, text) {
    host.replaceChildren();
    for (const para of String(text || '').split(/\n{2,}/)) {
      if (!para.trim()) continue;
      const p = make('p', 'lex-news-text-para');
      para.split('\n').forEach((line, i) => {
        if (i) p.appendChild(document.createElement('br'));
        let at = 0;
        for (const m of line.matchAll(LINK_RE)) {
          if (m.index > at) p.appendChild(document.createTextNode(line.slice(at, m.index)));
          const a = make('a', 'lex-news-text-link', m[1]);
          a.href = m[2];
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          p.appendChild(a);
          at = m.index + m[0].length;
        }
        if (at < line.length) p.appendChild(document.createTextNode(line.slice(at)));
      });
      host.appendChild(p);
    }
  }

  // Words of the text without the addresses of its links: what word picking and
  // copying work on.
  function plainText(text) {
    return String(text || '').replace(LINK_RE, '$1');
  }

  // ── the line above Chats ────────────────────────────────────────────────────
  // sections is what the server said to show. An account without News gets an
  // empty list, so the host shows nothing.
  function renderEntries(host, sections, onPick) {
    host.replaceChildren();
    for (const s of Array.isArray(sections) ? sections : []) {
      const b = make('button', 'lex-news-entry');
      b.type = 'button';
      b.innerHTML = ENTRY_ICON;
      b.appendChild(make('span', 'lex-news-entry-title', s.title));
      b.insertAdjacentHTML('beforeend', ENTRY_CHEVRON);
      b.dataset.section = s.id;
      b.addEventListener('click', () => onPick(s.id));
      host.appendChild(b);
    }
    host.hidden = !host.childElementCount;
  }

  // ── the feed ────────────────────────────────────────────────────────────────
  function createFeed(deps) {
    const root = make('section', 'lex-news');
    const head = make('header', 'lex-news-head');
    const title = make('div', 'lex-news-title', 'News');
    const refreshBtn = make('button', 'lex-news-refresh', 'Refresh');
    refreshBtn.type = 'button';
    head.append(title, refreshBtn);
    const status = make('div', 'lex-news-status');
    status.setAttribute('role', 'status');
    status.hidden = true;
    const scroller = make('div', 'lex-news-scroll');
    const blocksEl = make('div', 'lex-news-blocks');
    const empty = make('div', 'lex-news-empty', 'No letters yet.');
    empty.hidden = true;
    scroller.append(blocksEl, empty);
    root.append(head, status, scroller);

    let more = null;
    let loading = false;
    let busy = false;
    let opened = false;
    let savedTop = 0;
    let saveTimer = null;
    let lastSaved = null;

    const setStatus = (text, isError) => {
      status.textContent = text || '';
      status.hidden = !text;
      status.classList.toggle('is-error', !!isError);
    };

    function cardNode(card) {
      const b = make('button', 'lex-news-card');
      b.type = 'button';
      b.dataset.id = card.id;
      b.classList.toggle('is-read', !!card.read);
      b.appendChild(make('span', 'lex-news-card-title', card.title));
      if (card.description) b.appendChild(make('span', 'lex-news-card-desc', card.description));
      b.addEventListener('click', () => openCard(card.id, b));
      return b;
    }

    function blockNode(block) {
      const art = make('article', 'lex-news-block');
      art.dataset.letter = String(block.id);
      const bar = make('header', 'lex-news-block-head');
      let name;
      if (block.webUrl) {
        name = make('a', 'lex-news-block-title', block.title);
        name.href = block.webUrl;
        name.target = '_blank';
        name.rel = 'noopener noreferrer';
      } else {
        name = make('div', 'lex-news-block-title', block.title);
      }
      const who = make('div', 'lex-news-block-who');
      who.append(name, make('div', 'lex-news-block-date', block.date));
      const again = make('button', 'lex-news-again', 'Process again');
      again.type = 'button';
      again.addEventListener('click', () => processAgain(block.id, block.title));
      bar.append(who, again);
      art.appendChild(bar);
      if (block.state === 'failed') {
        art.appendChild(make('div', 'lex-news-failed',
          `This letter was not processed. ${block.error || ''} Refresh tries it again.`));
      }
      for (const c of block.cards || []) art.appendChild(cardNode(c));
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
      return r;
    }

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

    // The first card of a letter stands with the header of its letter, the rest stand
    // at the top edge themselves.
    function standOn(itemId) {
      const node = itemId && blocksEl.querySelector(`.lex-news-card[data-id="${itemId}"]`);
      if (!node) return;
      const block = node.closest('.lex-news-block');
      const target = block.querySelector('.lex-news-card') === node ? block : node;
      scroller.scrollTop += target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
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
        deps.rpc('save_news_position', { p_item_id: id }).catch((e) => console.warn('[news] position:', e && e.message));
      }, 1200);
    }
    scroller.addEventListener('scroll', noteScroll, { passive: true });

    async function openCard(id, node) {
      savedTop = scroller.scrollTop;
      let r;
      try {
        r = await deps.rpc('open_news_item', { p_op_id: newOpId(), p_item_id: id });
      } catch (e) {
        setStatus('The news did not open. ' + ((e && e.message) || ''), true);
        return;
      }
      node.classList.add('is-read');
      lastSaved = id;
      deps.openChat({ chatKey: r.chatKey, title: r.title });
    }

    async function refresh() {
      if (busy) return;
      busy = true;
      refreshBtn.disabled = true;
      setStatus('Looking for new letters…');
      const round = newOpId();
      let done = 0;
      let failed = [];
      let stopped = null;
      try {
        for (let i = 0; i < 300; i++) {
          const r = await deps.post('news-refresh', { round });
          if (r.mailError && !i) console.warn('[news] mail:', r.mailError);
          if (r.status === 'processed') {
            done++;
            await load();
          } else if (r.status === 'failed') {
            await load();
          } else if (r.status === 'stopped') {
            stopped = r.error || 'The letters were not processed.';
            break;
          } else if (!r.more) {
            failed = r.failed || [];
            break;
          }
          setStatus(r.remaining > 0 ? `Processing letters… ${r.remaining} left` : 'Processing letters…');
        }
        await load();
        if (stopped) setStatus(stopped, true);
        else if (failed.length) setStatus(`Not processed: ${[...new Set(failed)].join(', ')}.`, true);
        else if (done) setStatus(done === 1 ? 'One new letter.' : `${done} new letters.`);
        else setStatus('No new letters.');
      } catch (e) {
        setStatus('Refresh failed. ' + ((e && e.message) || ''), true);
      } finally {
        busy = false;
        refreshBtn.disabled = false;
      }
    }
    refreshBtn.addEventListener('click', refresh);

    async function processAgain(letterId, name) {
      if (busy) return;
      busy = true;
      refreshBtn.disabled = true;
      setStatus(`Processing ${name} again…`);
      try {
        const r = await deps.post('news-refresh', { round: newOpId(), letterId, opId: newOpId() });
        await load();
        if (r.status === 'processed' && !r.cards) setStatus('The model found no cards. The cards stay as they were.');
        else if (r.status === 'processed') setStatus(r.cards === 1 ? 'Done: one card.' : `Done: ${r.cards} cards.`);
        else if (r.status === 'busy') setStatus('This letter is being processed.');
        else setStatus(r.error || 'The letter was not processed.', true);
      } catch (e) {
        setStatus('Process again failed. ' + ((e && e.message) || ''), true);
      } finally {
        busy = false;
        refreshBtn.disabled = false;
      }
    }

    return {
      el: root,
      refresh,
      // Show the feed. The first time it stands on the saved place; after a
      // chat it comes back to where it was, with the card marked.
      async show() {
        if (!opened) {
          opened = true;
          try {
            const r = await load({ toAnchor: true });
            standOn(r.anchor);
            lastSaved = r.anchor || null;
          } catch (e) {
            opened = false;
            setStatus('The feed did not load. ' + ((e && e.message) || ''), true);
          }
        } else {
          scroller.scrollTop = savedTop;
        }
      },
      hide() { savedTop = scroller.scrollTop; },
    };
  }

  // ── settings ────────────────────────────────────────────────────────────────
  // Everything is on the server and the same on every device; this block only
  // shows it and sends what changed.
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
      root.appendChild(make('div', 'lex-news-settings-title', 'News'));
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

      root.append(addr, model, senders, prompt, note);
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

  const api = { createFeed, createSettings, renderEntries, renderText, plainText, newOpId };
  global.LexNews = api;
})(typeof window !== 'undefined' ? window : globalThis);
