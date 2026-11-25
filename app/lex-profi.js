// lex-profi.js — the Profi.ru section of the page lex-me.club/app (the Mac app shows that
// page). The frame around it is lex-section.js; here is what is Profi.ru's own: chats and
// orders, the screens of the bot's menu, the head of an order. The iPhone has the same
// screens in Swift, on the same server calls. The extension does not load this file: the
// server does not name the section to it.
//
// The section has no list of its own (20.11.2026): the chats of Profi.ru stand on the main page of the people (lex-people.js)
// as lines this file draws (`line`), and a press opens a chat over that page. What is left of the section are the screens
// the main page opens over itself — the chat of new orders, the bot's service chat, the settings and what they open (a
// report) — and the first screen of the frame under them, which is never on the screen: `enter` puts one of them over it
// before the section is shown, and the arrow of the first two screens leads out, to the main page (`root`).
//
// Everything that decides lives on the server: which chat stands where, which buttons an
// order has, what a box holds and whether it went. This file draws what it is told.
//
// A window gives:
//   back                   the arrow of the window, see lex-back.js
//   root()                 where the arrow of the first two screens leads, { title, go }: the main page of the
//                          people, over which the feed of new orders, the bot's chat and the settings are
//                          shown (lex-section.js, root)
//   showFeed(order)        show New orders at that order (or at its top) over the main page: the window shows the
//                          section on that screen. A reply that waits there is not opened as a chat
//   signals                the channel of the database's signals (lex-account-events.js): the
//                          section and an open order chat read again at the signal «profi», a
//                          press of the bot's menu gets its answer at «profi_cmd»
//   rpc(name, args)        a call of a database function under the person's pass
//   openOrder(order, wanted, held, keep, opts)
//                          open the chat of this order where chats open; held — the order chat
//                          as the window holds it (profi_item), or null; keep(item) — hold a
//                          fresher answer; opts.replySelf — opened by Reply yourself: with the
//                          discussion shown (the draft of the bot), not in the clean view
//   copy(text)             put text on the clipboard, returns true when it worked
//   notify(text)           a failed press the person has to see
//   onChange()             the server changed something: read the open order chat, a promise
//   head(nodes)            what the bar of the window shows in place of the section's own bar: the
//                          head of New orders (the mark of Профи.ру and its words), null — the bar
//                          as it was
//   read(name, args, show, empty)
//                          the window's way to read what a screen shows (lex-reads.js, twice):
//                          the copy this device kept in the first frame, the server's answer after
(function (global) {
  'use strict';

  const COMMAND_WAIT_S = 20;
  // Cancel: this long without the monitor's answer — the order counts down again with Cancel and
  // the screen says the monitor did not answer; the order's copy takes over after CANCEL_HOLD_S.
  const CANCEL_WAIT_S = 5;
  const CANCEL_HOLD_S = 30;
  // How many of the bot's last messages its chat shows (profi_bot_chat): a service chat is read from its end.
  const BOT_LIMIT = 200;
  const BOT_TITLE = 'Бот Профи';
  // The channels where «Edit» of a message that went to a person works (19.11.2026; Gennady: in every channel — WhatsApp,
  // Telegram, Max, Profi.ru). One row per channel: the uid of its messages begins with `prefix`; `windowMs` — how long
  // the messenger lets a message be edited after the send (null — no term); `personal(uid)` — the chat is a person's,
  // not a group. The iPhone holds the same table (`editChannels`, ios/Lex/Lex/EditSent.swift), the server of Lex the
  // same patterns (`lex_message_edit_patterns`, supabase/migrations/message_edit.sql) and the database of Gennady the
  // same channels (`brain.edit_channels`, modules/actions/message_edits.sql): a channel is added in all four, and only
  // when its executor is proven on the live messenger — a row without one is an empty place in the menu (lesson
  // 2026-11-19). The database says the term again and has the last word: this only keeps «Edit» out of the menu of a
  // message it would refuse.
  const EDIT_CHANNELS = {
    whatsapp: { prefix: 'profi:wa:', windowMs: 15 * 60 * 1000, personal: (uid) => !/@g\.us:/.test(uid) },
    telegram: { prefix: 'profi:telegram:', windowMs: 48 * 60 * 60 * 1000, personal: (uid) => !uid.startsWith('profi:telegram:-') },
    max: { prefix: 'profi:max:', windowMs: 7 * 24 * 60 * 60 * 1000, personal: (uid) => !uid.startsWith('profi:max:-') },
  };
  const editChannelOf = (uid) => Object.values(EDIT_CHANNELS).find((c) => uid.startsWith(c.prefix)) || null;
  // A reaction on a message at a person's messenger (the edge function message-react; Gennady, 24.11.2026): a personal
  // chat of Telegram or WhatsApp (Max waits for its executor on the server), a message of the person or Gennady's own that has gone; not a group, not Profi.ru.
  // The same patterns as the server's (message-react) and the iPhone's: a channel is added in all of them at once.
  const REACT_CHANNELS = {
    whatsapp: { name: 'whatsapp', prefix: 'profi:wa:', personal: (uid) => !/@g\.us:/.test(uid) },
    telegram: { name: 'telegram', prefix: 'profi:telegram:', personal: (uid) => !uid.startsWith('profi:telegram:-') },
  };
  const reactChannelOf = (uid) => Object.values(REACT_CHANNELS).find((c) => uid.startsWith(c.prefix)) || null;
  const emojiKey = (e) => String(e == null ? '' : e).replace(/\uFE0F/g, '').trim();
  const CHAT_KEY_RE = /^__lex_profi__[0-9]{1,18}$/;

  const { make, button, newOpId } = global.LexSection;

  const isChatKey = (key) => typeof key === 'string' && CHAT_KEY_RE.test(key);

  // ── a box with text for the client inside an answer ─────────────────────────
  // What the model marked: <client_text>…</client_text>. An answer still being written has
  // an opening tag and no end: its text is already the box, and it has no buttons yet. A box that
  // answers one message of the client names it in its tag, <client_text reply_to="3fa9c1"> (the short
  // number of the message, profi_message_looks.sql): `replyTo` of the part — the number, '' — no quote,
  // undefined — the tag says nothing.
  function replyAttr(tag) {
    const m = /\breply_to\s*=\s*"([^"]*)"/.exec(tag || '');
    return m ? m[1].trim().toLowerCase() : undefined;
  }
  function splitAnswer(text) {
    const parts = [];
    let rest = String(text || '');
    for (;;) {
      const at = rest.indexOf('<client_text');
      if (at < 0) break;
      if (at > 0) parts.push({ kind: 'text', text: rest.slice(0, at) });
      const gt = rest.indexOf('>', at);
      if (gt < 0) { rest = ''; parts.push({ kind: 'box', text: '', open: true }); break; }
      const replyTo = replyAttr(rest.slice(at, gt));
      const after = rest.slice(gt + 1);
      const end = after.indexOf('</client_text>');
      if (end < 0) { parts.push({ kind: 'box', text: after, open: true, replyTo }); rest = ''; break; }
      parts.push({ kind: 'box', text: after.slice(0, end).trim(), open: false, replyTo });
      rest = after.slice(end + '</client_text>'.length);
    }
    if (rest) {
      // A tag that has only begun to arrive stays off the screen.
      const cut = rest.search(/<(c(l(i(e(n(t(_(t(e(x(t)?)?)?)?)?)?)?)?)?)?)?$/);
      parts.push({ kind: 'text', text: cut >= 0 ? rest.slice(0, cut) : rest });
    }
    return parts.filter((p) => p.kind === 'box' || p.text.trim());
  }

  // The addresses in a message are links (lex-links.js, one rule for every text of Lex): a link of Profi
  // the bot writes as «[caption](https://…)» (2026-11-11) — the caption opens the same page of Profi — and
  // a bare address a person pasted («https://zoom.us/j/…»). Everything else is plain text, as it came.
  function linkedText(node, text) {
    return global.LexLinks.into(node, text);
  }

  // A link of Profi in a text («[фото](https://…)», «[caption](https://…)») as its caption: the line under
  // the title of a chat in the list shows words, not addresses (the iPhone does the same, ProfiStore).
  function plainLinks(text) {
    return String(text || '').replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1');
  }

  // The photos of a client's turn: attachments with an address of Profi's picture server (the server
  // lets through no other, profi_client_photos.sql; the same check here keeps an old row honest).
  const PHOTO_HOST = /^https:\/\/cdn\.profi\.ru\//;
  // A file of an order is linked only on the site of Profi (its picture server or the site itself).
  const PROFI_FILE = /^https:\/\/([a-z0-9-]+\.)*profi\.ru\//;
  function photosOf(attachments) {
    return (Array.isArray(attachments) ? attachments : [])
      .filter((a) => a && a.kind === 'image' && typeof a.url === 'string' && PHOTO_HOST.test(a.url))
      .map((a) => ({ url: a.url, width: a.width, height: a.height }));
  }
  // «[[фото](address)]», «[[фото 1](a), [фото 2](b)]» or a caption with «[фото](address)» under it: the
  // links to the photos drawn over the text go, the rest of the words stay.
  function withoutPhotoLinks(text, shots) {
    let s = String(text || '');
    for (const p of shots) {
      const at = s.indexOf(`](${p.url})`);
      if (at < 0) continue;
      const open = s.lastIndexOf('[', at);
      if (open < 0) continue;
      s = s.slice(0, open) + s.slice(at + p.url.length + 3);
    }
    return s.replace(/\[(\s*,\s*)*\]/g, '').replace(/\n{2,}/g, '\n').trim();
  }

  // The stored files of a turn (chat_files.sql): a photo, a voice message, a video, a document the
  // client sent in a messenger or on Profi, or what went to him there. Only objects of chat-files
  // (the server lets no other through) and the files that did not come, with their reason.
  function storedFilesOf(attachments) {
    return (Array.isArray(attachments) ? attachments : [])
      .filter((a) => a && typeof a === 'object'
        && ((typeof a.path === 'string' && a.path.indexOf('chat-files/') === 0) || typeof a.missing === 'string'));
  }

  // The words the database put into the text for a file the bubble now shows itself: «Голосовое, 0:26»
  // over the words of a voice message, «[фото]», «[файл: …]», «[видео …]» and the like. The words the
  // database read off the file (what the voice said, the text on a photo or in a document) stay.
  function withoutFileMarks(text, files) {
    const has = (kinds) => files.some((f) => kinds.includes(f.kind));
    let s = String(text || '');
    if (has(['voice', 'audio'])) {
      s = s.replace(/^Голосовое, \d+:\d{2}[ \t]*(\n|$)/, '')
        .replace(/\[(голосовое|кружок)(, [^\]\n]*| без расшифровки)?\][ \t]*/g, '');
    }
    if (has(['image'])) {
      // a link of Profi to the photo whose stored copy now stands over the text («[[фото](https://cdn…)]»)
      s = s.replace(/\[фото(?: \d+)?\]\(https?:\/\/[^\s)]+\)/g, '').replace(/\[(\s*,\s*)*\]/g, '');
      s = s.replace(/\[фото(, текста на нём нет|, текст с картинки не прочитан)?\][ \t]*/g, '');
    }
    if (has(['video'])) s = s.replace(/\[(видео|кружок)(, [^\]\n]*)?\][ \t]*/g, '');
    if (has(['file', 'video', 'audio'])) s = s.replace(/^\[файл: [^\]\n]*\][ \t]*/gm, '');
    return s.replace(/\n{3,}/g, '\n\n').trim();
  }

  // The digest of the file of a message (21.11.2026, the agent «Разбор вложений» of the database): `look.attachment`
  // {state, text, kind, media, reason, main, at}. `ready` — its Markdown stands under the file instead of what the
  // database read off the file; `merged` — the message was read together with `main` (an album): it shows only its
  // own words; `working`, `failed`, `silent` and no field — the message as before. → { text, media } or null.
  function digestOf(look) {
    const a = look && typeof look.attachment === 'object' ? look.attachment : null;
    if (!a) return null;
    const media = typeof a.media === 'string' ? a.media : '';
    if (a.state === 'ready' && typeof a.text === 'string' && a.text.trim()) return { text: a.text.trim(), media };
    if (a.state === 'merged') return { text: '', media };
    return null;
  }

  // The person's own words of a message whose file the digest reads (as `ownWords` in ProfiView.swift): what the
  // database put there about the file goes — the marks of the file, the text read off a photo (it stands at the end,
  // «[фото, текст на нём: …]», as the agent cuts it), the text of a document, and all of a voice message, a video note
  // or a video (its words are what was said in it). What is left is the caption the person wrote.
  function ownWords(text, digest, files) {
    if (/^(voice|audio|video)$/.test(digest.media) || files.some((f) => /^(voice|audio|video)$/.test(f.kind))) return '';
    let s = String(text || '')
      .replace(/\[фото, текст на нём: [\s\S]*$/, '')
      .replace(/\[(текст файла|полный текст документа[^\]\n]*)\][\s\S]*$/, '')
      .replace(/\[документ к сообщению №[^\]\n]*\][\s\S]*$/, '');
    s = withoutFileMarks(s, files.length ? files : [{ kind: digest.media === 'image' ? 'image' : 'file' }]);
    return s.replace(/\[фото(, текста на нём нет|, текст с картинки не прочитан)?\][ \t]*/g, '')
      .replace(/^\[(файл|текста в файле нет|текста нет)[^\]\n]*\][ \t]*/gm, '')
      .replace(/\n{3,}/g, '\n\n').trim();
  }

  // What the parts need to show the stored files (LexMessage.files): one for the order chats and the
  // chats of Lex — LexFileAttach.webIo (lex-file-attach.js).
  const fileIo = global.LexFileAttach.webIo;
  // The Russian form of a word by its number: 1 участник, 3 участника, 5 участников.
  function plural(n, one, few, many) {
    const a = Math.abs(n) % 100;
    const b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b === 1) return one;
    return b >= 2 && b <= 4 ? few : many;
  }

  // ── the ticks under what went to the client ─────────────────────────────────
  // The tick of Profi's list of chats, the same drawing, colours and size: one grey stroke, the
  // client has not read it yet; the second stroke and both blue, he has. The server says which. It is
  // the common part of the stamp now (LexMessage.ticks, В7.2): under what went in every channel.
  const TICK_NS = 'http://www.w3.org/2000/svg';
  const tickNode = (read) => global.LexMessage.ticks(read);

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

  // One box: the draft for the client (В7.20) — a bubble on the right with a dashed edge and Copy in its
  // top right corner (В7.22), no line under the text; the price under it, then the row that sends it
  // (В7.23): «Hold to send to <client>» with the mark of the place, and «⋯». window is the row of the
  // server; none yet while the answer is being written (paler, no Copy, no row). A box that went shows
  // no copy of itself: what went stands in the chat as a message with its ticks.
  // A draft that answers one message of the client carries its quote (В7.35), as the client will see it.
  // The text is the window's: the person may have changed it (Edit → Save, below).
  function boxNode(text, win, deps, quote) {
    const M = global.LexMessage;
    const root = make('div', 'lex-profi-box');
    if (win && win.state === 'sent') {
      root.classList.add('is-sent');
      const { note } = boxControls(win, deps);
      root.appendChild(note);
      return root;
    }
    if (!win) {
      root.classList.add('is-writing');
      const q = quote && M.quote ? M.quote(quote, { io: fileIo, onPress: deps.openQuote || null }) : null;
      root.appendChild(M.bubble({ side: 'out', tone: 'draft', text, quote: q }));
      return root;
    }
    // What the person is typing into a box (Edit, not yet saved) lives in `deps.edits` (window → { text }),
    // kept by the chat: a signal of the database redraws the answer, and the typed words must survive it.
    const edits = deps.edits || new Map();
    if (!canEdit(win)) edits.delete(win.id);
    let shown = win.text != null ? win.text : text;
    let line = '';
    const quoteNode = () => (quote && M.quote ? M.quote(quote, { io: fileIo, onPress: deps.openQuote || null }) : null);

    function paintView() {
      let note = null;
      const copy = async () => {
        const ok = await deps.copy(shown);
        if (!ok && note) note.textContent = 'The browser refused the clipboard.';
        return ok;
      };
      const kids = [M.bubble({ side: 'out', tone: 'draft', text: shown, copy, quote: quoteNode() })];
      const price = priceLine(win.price);
      if (price) kids.push(make('div', 'lex-profi-box-price', `Price: ${price}`));
      const controls = boxControls(Object.assign({}, win, { text: shown }), deps, canEdit(win) ? startEdit : null);
      note = controls.note;
      if (line) note.textContent = line;
      kids.push(controls.foot, note);
      root.classList.remove('is-editing');
      root.replaceChildren(...kids);
    }

    function startEdit() {
      edits.set(win.id, { text: shown, fresh: true });
      paintEdit();
    }

    // Edit → Save (Gennady, 2026-11-18): the bubble is the same, its words are a field; under it «Cancel» and
    // «Save» stand in place of the row that sends. A tap on them sends nothing to anyone, so they are taps.
    // Save writes the text into the box on the server (profi_box_text): Send, the time and every app read it
    // from there. Escape cancels, Ctrl or Cmd with Enter saves.
    function paintEdit() {
      const entry = edits.get(win.id);
      const old = entry.field;
      const keep = !!entry.fresh || !!(old && old.isConnected && global.document.activeElement === old);
      const caret = old && old.isConnected ? [old.selectionStart, old.selectionEnd] : null;
      const note = make('div', 'lex-profi-box-note');
      note.setAttribute('role', 'status');
      const changed = () => {
        const words = entry.text.trim();
        return words !== '' && words !== shown.trim();
      };
      let busy = false;
      const leave = () => {
        edits.delete(win.id);
        paintView();
      };
      const save = async () => {
        if (busy || !changed()) return;
        busy = true;
        saveBtn.disabled = true;
        cancelBtn.disabled = true;
        note.textContent = 'Saving…';
        let r = null;
        try {
          r = await deps.rpc('profi_box_text', { p_window: win.id, p_text: entry.text });
        } catch (e) {
          busy = false;
          cancelBtn.disabled = false;
          saveBtn.disabled = !changed();
          note.textContent = 'Not saved. ' + ((e && e.message) || '');
          return;
        }
        if (r && typeof r.text === 'string') shown = r.text;
        line = r && r.saved === false ? 'Not saved: the text has already gone.' : '';
        leave();
        deps.refresh();
      };
      const ed = M.editField({
        value: entry.text,
        label: deps.folder ? 'Message to the person' : 'Message to the client',
        onInput: (v) => {
          entry.text = v;
          saveBtn.disabled = busy || !changed();
          if (note.textContent) note.textContent = '';
        },
        onKey: (e) => {
          if (e.key === 'Escape') { e.preventDefault(); if (!busy) leave(); }
          else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
        },
      });
      entry.field = ed.field;
      const bubble = M.bubble({ side: 'out', tone: 'draft', body: ed.body, quote: quoteNode() });
      bubble.classList.add('is-editing');
      const cancelBtn = button('lex-profi-btn', 'Cancel', () => { if (!busy) leave(); });
      cancelBtn.dataset.role = 'edit-cancel';
      const saveBtn = button('lex-profi-btn is-main', 'Save', save);
      saveBtn.dataset.role = 'edit-save';
      saveBtn.disabled = !changed();
      const foot = make('div', 'lex-profi-box-foot');
      foot.append(cancelBtn, saveBtn);
      const kids = [bubble];
      const price = priceLine(win.price);
      if (price) kids.push(make('div', 'lex-profi-box-price', `Price: ${price}`));
      kids.push(foot, note);
      root.classList.add('is-editing');
      root.replaceChildren(...kids);
      if (keep) ed.focus();
      if (caret && !entry.fresh) {
        global.requestAnimationFrame(() => {
          if (ed.field.isConnected) { try { ed.field.setSelectionRange(caret[0], caret[1]); } catch (_) { /* no selection */ } }
        });
      }
      entry.fresh = false;
    }

    if (edits.has(win.id)) paintEdit(); else paintView();
    return root;
  }

  // A box whose text may still change: nothing has gone out of it. The person's own text has its own Edit
  // (when it did not go); the server says the same (profi_box_text).
  function canEdit(win) {
    return !!win && !win.direct && (win.state === 'ready' || win.state === 'scheduled' || (win.state === 'failed' && !!win.retry));
  }

  // What a box says under it about where it stands: the server's state of the box in words.
  // who — whom the text went to: the client of an order, the person of a folder chat.
  // group — the title of the group of a folder chat: the lines name it («Sent to the group <title> in Telegram.»).
  function stateLine(win, who = 'the client', group = null) {
    const g = group != null ? `the group ${group}`.trim() : null;
    switch (win.state) {
      case 'scheduled': return global.LexSendLater.scheduledLine(win.sendAt);
      case 'queued': return sendingLine(win.channel, group);
      case 'sent': return win.channel ? `Sent to ${who} in ${placeName(win.channel)}.` : `Sent to ${who}.`;
      case 'failed': return g
        ? `Not sent to ${g}${win.channel ? ` in ${placeName(win.channel)}` : ''}. ${win.error || ''}`.trim()
        : `Not sent${win.channel ? ` to ${placeName(win.channel)}` : ''}. ${win.error || ''}`.trim();
      case 'unknown':
        return win.channel
          ? `${placeName(win.channel)} did not confirm it. Look at the chat there: Lex will not send it again. ${win.error || ''}`
          : `The site did not confirm it. Look at the chat on Profi: Lex will not send it again. ${win.error || ''}`;
      // A box whose tag named a time the server did not take (profi_box_at.sql): why it waits for a hold.
      default: return win.state === 'ready' && win.atNote ? win.atNote : '';
    }
  }

  // The buttons of a box and its line, from its state on the server. One set for the box in an
  // answer of the model and for the person's own text at the end of the chat (outboxNode). What sends
  // to the client goes by a hold only (В7.23, Gennady 16.11.2026: a tap sends nothing anywhere):
  //   may leave (ready) — «Hold to send to <client>»; failed with a retry — «Hold to send again»;
  //     a box of the model has «⋯» by it (and the right button on the send): «Schedule…» — the same
  //     text at a time (lex-send-later.js) — and «Edit in the field» — the text into the field, to
  //     change by hand and send by holding the arrow;
  //   scheduled — «Hold to send now» and «Cancel»: the box of the model waits for a send again, the
  //     person's own text leaves the chat and comes back into the field (deps.putBack). A box of the
  //     model keeps its «⋯» while it waits (Gennady, 20.11.2026): «Schedule…» changes the time, «Edit»
  //     the words, the time stays; it may have been born scheduled by the time of its tag
  //     (<client_text at="…">, profi_box_at.sql);
  //   the person's own text that did not leave — «Delete» as well.
  // «Cancel» and «Delete» work by a tap, as before: nothing goes to a person by them.
  function boxControls(win, deps, onEdit) {
    const foot = make('div', 'lex-profi-box-foot');
    const note = make('div', 'lex-profi-box-note');
    note.setAttribute('role', 'status');
    const open = win.state === 'ready' || (win.state === 'failed' && win.retry);
    const scheduled = win.state === 'scheduled';
    const call = async (name, args, busy) => {
      note.textContent = busy;
      try {
        const r = await deps.rpc(name, args);
        deps.refresh();
        return r || {};
      } catch (e) {
        note.textContent = 'Not done. ' + ((e && e.message) || '');
        return null;
      }
    };
    const cancel = async () => {
      const r = await call('profi_send_cancel', { p_window: win.id }, 'Cancelling…');
      if (r && r.state === 'removed' && r.text && deps.putBack) deps.putBack(r.text);
    };
    if (open || scheduled) {
      // Where it goes: the window says (`to`, a reply goes to the channel of the message it quotes);
      // an older server — the place of the client's latest message.
      const to = win.to || deps.replyTo || null;
      const name = firstName(deps.client);
      const again = open && win.state === 'failed';
      // The chat of a group names the whole group, the same words as the menu of the held arrow (2026-11-21).
      const group = deps.group != null ? `the group ${deps.group}`.trim() : null;
      const words = scheduled ? 'Hold to send now' : again ? 'Hold to send again' : group ? `Hold to send to ${group}` : name ? `Hold to send to ${name}` : 'Hold to send';
      const label = `Send${scheduled ? ' now' : again ? ' again' : ''} to ${group || name || (deps.folder ? 'the person' : 'the client')} on ${placeName(to)}. Hold to send`;
      // «⋯» of a box of the model: the same box at a time, or its words changed in the box (Edit). A box of a
      // folder chat goes at once (the queue of the database sends at once): Edit only.
      const editItem = onEdit ? { label: 'Edit', icon: 'pencil', run: () => onEdit() } : null;
      const items = open && !win.direct && deps.folder ? (editItem ? () => [editItem] : null) : (open || scheduled) && !win.direct ? () => {
        const list = [{
          label: 'Schedule…',
          icon: 'clock',
          run: async () => {
            // A box that waits opens the sheet on its own time.
            const at = await global.LexSendLater.pick({ text: win.text, client: deps.client, at: scheduled ? win.sendAt : null });
            if (!at) return;
            await call('profi_send_at', { p_op_id: newOpId(), p_window: win.id, p_at: at.toISOString() }, 'Scheduling…');
          },
        }];
        if (editItem) list.push(editItem);
        return list;
      } : null;
      // A box of a folder chat: its text goes by the Send of the chat (folder-send), tied to the box.
      const sendFolderBox = async (send) => {
        note.textContent = 'Sending…';
        const r = typeof deps.sendBox === 'function' ? await deps.sendBox(win) : null;
        if (!r) { send.disabled = false; note.textContent = stateLine(win, boxWho(deps), deps.group); return; }
        deps.refresh();
        note.textContent = r.state === 'queued' || r.state === 'sending' ? sendingLine(r.channel, deps.group) : '';
      };
      const { send, more } = global.LexMessage.sendHold({
        channel: to || 'profi', words, label, fit: !!win.direct, items,
        onSend: async () => {
          send.disabled = true;
          if (deps.folder) return sendFolderBox(send);
          const r = await call('profi_send', { p_op_id: newOpId(), p_window: win.id }, 'Going to the monitor…');
          if (!r) { send.disabled = false; return; }
          note.textContent = r.state === 'queued' ? sendingLine(r.channel) : '';
        },
      });
      // The person's own text waiting for its time: «Cancel», then «Hold to send now» (the design).
      if (scheduled && win.direct) foot.appendChild(button('lex-profi-btn', 'Cancel', cancel));
      foot.appendChild(send);
      // A waiting box of the model: «Hold to send now», «Cancel», then «⋯» at the edge, where it stands by any box.
      if (scheduled && !win.direct) foot.appendChild(button('lex-profi-btn', 'Cancel', cancel));
      if (more) foot.appendChild(more);
    }
    if (win.direct && (win.state === 'failed' || win.state === 'ready')) foot.appendChild(button('lex-profi-btn', 'Delete', cancel));
    note.textContent = stateLine(win, boxWho(deps), deps.group);
    if (!foot.childElementCount) foot.hidden = true;
    return { foot, note };
  }

  // The client as the button names him: the first word of his name («Дмитрий Петров» → «Дмитрий»).
  // The words of a turn of the model as one plain line for a line over the field and for Copy: the Markdown links
  // are their words, the marks of emphasis are gone, the paragraphs go through a space; cut at `max` signs.
  function plainLine(text, max) {
    const plain = String(text || '')
      .replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, '$1')
      .replace(/(\*\*|__|~~|`)/g, '')
      .replace(/\s*\n\s*/g, ' ').trim();
    return plain.length > max ? plain.slice(0, Math.max(0, max - 1)).trimEnd() + '…' : plain;
  }

  function firstName(client) {
    return String(client || '').trim().split(/\s+/)[0] || '';
  }

  // The person's own text to the client, sent without the model (profi_send_text): it has no
  // answer of the model to stand in, so it stands at the end of the chat as an outgoing message
  // with its line and buttons, until what went to the client comes back into the chat. Which
  // ones stand here the server says (`outbox`, profi_send_later.sql).
  function outboxNode(win, deps) {
    const M = global.LexMessage;
    const root = make('div', 'lex-profi-msg is-sent lex-profi-outbox-item');
    root.dataset.window = String(win.id);
    const body = make('div', '', '');
    body.textContent = win.text;
    // Waiting for its time: paler, a dashed frame, a clock and the time where the ticks stand.
    // No channel: the place is chosen at the moment it leaves.
    let stamp = null;
    if (win.state === 'scheduled' && win.sendAt) {
      stamp = make('div', 'lex-stamp');
      const t = make('span', 'lex-stamp-time lex-sl-when', '');
      t.append(global.LexSendLater.icon('clock', 12), document.createTextNode(global.LexSendLater.stamp(win.sendAt)));
      stamp.appendChild(t);
    }
    const bubble = M.bubble({ side: 'out', body, stamp });
    if (win.state === 'scheduled') bubble.classList.add('is-scheduled');
    root.appendChild(bubble);
    // Not sent (17.11.2026): the common part of a message that did not go (LexMessage.unsent, the same as
    // under a word to Lex in the main chat) — «Not sent» and why, «Hold to retry» (a tap sends nothing to
    // the client, В7.23) when the monitor said a second sending is safe, «⋯» with Edit and Delete. It
    // stands until the person sends it again or deletes it (the server keeps it in `outbox`).
    if (win.state === 'failed' && M.unsent) {
      root.classList.add('lex-unsent');
      const cancel = async () => {
        try { await deps.rpc('profi_send_cancel', { p_window: win.id }); } catch (e) {
          if (deps.notify) deps.notify('Not done. ' + ((e && e.message) || ''));
          return false;
        }
        deps.refresh();
        return true;
      };
      let part = null;
      part = M.unsent({
        note: [win.channel ? `to ${placeName(win.channel)}` : '', win.error || ''].filter(Boolean).join(' · '),
        retryHold: true,
        onRetry: win.retry ? async () => {
          part.update({ sending: true });
          try {
            await deps.rpc('profi_send', { p_op_id: newOpId(), p_window: win.id });
          } catch (e) {
            part.update({ sending: false, note: 'Not sent again. ' + ((e && e.message) || '') });
            return;
          }
          deps.refresh();
        } : null,
        onEdit: deps.putBack ? async () => {
          if (!deps.putBack(win.text)) return;
          await cancel();
        } : null,
        onDelete: () => { cancel(); },
      });
      root.appendChild(part);
      return root;
    }
    const { foot, note } = boxControls(win, deps);
    root.append(note, foot);
    return root;
  }

  // ── «While you're busy» (profi_busy.sql, 2026-11-19) ──────────────────────────────────────────────────
  // The bot's short message to the client while Gennady is busy stands at the end of the chat as a text that
  // has not gone yet, like his own text on its way (outboxNode): until it goes (then it is the message in the
  // chat), is cancelled, or is taken into a box. `busy` of profi_open says the state and what it holds:
  //   waiting    the countdown: «Goes at 14:05», Cancel with the seconds on it (В7.29) and Edit; at zero —
  //              «Sending now…», the buttons gone (the bot has the text);
  //   rewriting  the client wrote more, the bot writes the text again: Cancel;
  //   cancelled, not_sent   the text stays and Edit; what the bot says about it (`reason`) is its own words,
  //              Russian, shown as they are.
  // Edit takes the text into a box of the chat (the same box as the draft after a call): the bot stops the
  // countdown and the chat shows the box, to change by hand and send by holding (В7.23). Both buttons go to the
  // bot (profi_busy_command) with the job they were pressed on; the bot's word comes back as the result of the
  // command, a refusal stands under the text.
  // d: rpc, order, refresh() — read the chat again, edited() — the box came, show it.
  const BUSY_WAIT_S = 8;
  const clockOf = (sec) => new Date(sec * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  const BUSY_REFUSED = {
    changed: 'The text has just changed. Look at it again.',
    closed: 'It is not waiting any more.',
  };
  const busyRefusal = (code) => BUSY_REFUSED[code] || 'It did not go.';
  async function busyResult(rpc, id, seconds) {
    const until = Date.now() + seconds * 1000;
    for (;;) {
      let r = null;
      try { r = await rpc('profi_command_result', { p_id: id }); } catch (_) { /* once more below */ }
      if (r && r.done) return r.result || {};
      if (Date.now() >= until) return { ok: false, error: 'The monitor did not answer. Is the working Mac awake?' };
      await new Promise((res) => setTimeout(res, 500));
    }
  }
  // A press on Cancel or Edit, from the card or from a button of a notification: the command goes to the bot with
  // the job it was pressed on, the bot's word is waited for. → { ok, error? } (error — words to show as they are).
  async function busyCommand(rpc, order, kind, job) {
    try {
      const r = await rpc('profi_busy_command', { p_op_id: newOpId(), p_order: String(order), p_kind: kind, p_job: job || '' });
      if (!r || !r.ok) return { ok: false, error: busyRefusal(r && r.error) };
      const res = await busyResult(rpc, r.id, BUSY_WAIT_S);
      return res.ok ? { ok: true } : { ok: false, error: res.error || 'The bot did not take it.' };
    } catch (e) {
      return { ok: false, error: (e && e.message) || 'The command did not go.' };
    }
  }
  // What a press said, kept by the order and the job it was made on: while the bot answers, the chat is drawn again at
  // the database's signal (a command in the queue changes the section — the live check, 19.11.2026: the card made then
  // forgot «Cancelling…» and its buttons were on again), and the card made then must still say the words of the press
  // — or the bot's refusal, the card standing as it was. `paint` is the newest card's: the one a press repaints.
  const busyTalk = new Map();
  function talkOf(key) {
    let t = busyTalk.get(key);
    if (!t) {
      t = { pending: '', refused: '', paint: null };
      busyTalk.set(key, t);
      if (busyTalk.size > 40) busyTalk.delete(busyTalk.keys().next().value);
    }
    return t;
  }
  function busyNode(b, d) {
    const M = global.LexMessage;
    const root = make('div', 'lex-profi-msg is-sent lex-profi-outbox-item lex-profi-busy');
    root.dataset.busy = b.state;
    // The seconds are counted on the server's clock (`now`), not on the page's.
    const skew = Number.isFinite(b.now) ? b.now - Date.now() / 1000 : 0;
    const secondsLeft = () => (b.sendAt || 0) - (Date.now() / 1000 + skew);
    const span = b.sendAt && b.at && b.sendAt > b.at ? b.sendAt - b.at : 0;
    // pending — the words of a press under way; refused — what the bot or the server answered to the last press.
    const talk = talkOf(`${d.order}|${b.job}`);
    let cd = null;
    let seen = false;

    const press = (kind) => async () => {
      talk.pending = kind === 'cancel' ? 'Cancelling…' : 'Opening the text…';
      talk.refused = '';
      if (talk.paint) talk.paint();
      const res = await busyCommand(d.rpc, d.order, kind, b.job);
      talk.pending = '';
      if (!res.ok) talk.refused = res.error;
      else if (kind === 'edit' && d.edited) d.edited();
      if (talk.paint) talk.paint();
      if (d.refresh) d.refresh();
    };

    function paint() {
      const going = b.state === 'waiting' && secondsLeft() <= 0;
      const body = make('div', '', '');
      body.textContent = b.text || '';
      let stamp = null;
      if (b.state === 'waiting' && b.sendAt) {
        stamp = make('div', 'lex-stamp');
        const t = make('span', 'lex-stamp-time lex-sl-when', '');
        t.append(global.LexSendLater.icon('clock', 12), document.createTextNode(`Goes at ${clockOf(b.sendAt)}`));
        stamp.appendChild(t);
      }
      const bubble = M.bubble({ side: 'out', body, stamp });
      if (b.state === 'waiting' || b.state === 'rewriting') bubble.classList.add('is-scheduled');
      const line = talk.pending || talk.refused || (
        going ? 'Sending now…'
          : b.state === 'waiting' ? (b.retry ? `It did not go${b.reason ? `: ${b.reason}` : ''}. Trying again.` : '')
          : b.state === 'rewriting' ? 'The client wrote more: the bot writes the text again.'
          : b.state === 'cancelled' ? 'Cancelled: it will not go.'
          : b.reason || 'The bot did not send it.');
      const note = make('div', 'lex-profi-box-note', line);
      note.setAttribute('role', 'status');
      const foot = make('div', 'lex-profi-box-foot');
      cd = null;
      const can = (b.state === 'waiting' && !going) || b.state === 'rewriting' || b.state === 'cancelled' || b.state === 'not_sent';
      if (can) {
        if (b.state === 'waiting' || b.state === 'rewriting') {
          const cancel = button('lex-profi-btn is-danger', 'Cancel', press('cancel'));
          cancel.dataset.role = 'busy-cancel';
          if (talk.pending) cancel.disabled = true;
          foot.appendChild(cancel);
          if (b.state === 'waiting' && !talk.pending) cd = M.countdown(cancel);
        }
        if (b.state !== 'rewriting') {
          const edit = button('lex-profi-btn', 'Edit', press('edit'));
          edit.dataset.role = 'busy-edit';
          if (talk.pending) edit.disabled = true;
          foot.appendChild(edit);
        }
      }
      foot.hidden = !foot.childElementCount;
      root.replaceChildren(bubble, note, foot);
      if (cd) {
        const left = Math.max(0, secondsLeft());
        cd.set(left, span > 0 ? left / span : 0);
      }
    }
    talk.paint = paint;
    paint();

    // The seconds go on by themselves between the server's words; at zero the buttons go (the bot has the text).
    if (b.state === 'waiting' && b.sendAt) {
      const timer = setInterval(() => {
        if (!root.isConnected) { if (seen) clearInterval(timer); return; }
        seen = true;
        const left = secondsLeft();
        if (left <= 0) { clearInterval(timer); paint(); return; }
        if (cd) cd.set(left, span > 0 ? left / span : 0);
      }, 1000);
    }
    return root;
  }

  function sendingLine(ch, group = null) {
    if (group != null) return `Sending to the group ${group}`.trim() + (ch ? ` in ${placeName(ch)}` : '') + '…';
    return ch ? `Sending to ${placeName(ch)}…` : 'The monitor is sending it.';
  }

  // Whom a box of a chat sends to, as its lines name it: the client of an order, the person or the group of a folder.
  function boxWho(deps) {
    if (deps.group != null) return `the group ${deps.group}`.trim();
    return deps.folder ? 'the person' : 'the client';
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
  // The arrow out of the window: the order on the site of Profi.
  const outIcon = () => strokeIcon([['path', { d: 'M14 4h6v6' }], ['path', { d: 'M20 4l-9 9' }],
    ['path', { d: 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5' }]], 20);

  // ── an order chat ───────────────────────────────────────────────────────────
  // The channel of a message of an order chat that the server does not name otherwise: the site
  // of Profi. Messages of the client from Max, Telegram or WhatsApp come named (`channels`).
  const CHANNEL = 'profi';


  // The words of a message of the monitor as its bubble shows them: the links to its photos and the marks
  // of its files the bubble draws itself are out (the quote of it and Copy take the same words).
  function wordsOf(t) {
    const out = t.origin === 'profi_sent' || t.origin === 'folder_out';
    const shots = !out ? photosOf(t.attachments) : [];
    const stored = storedFilesOf(t.attachments);
    let words = shots.length ? withoutPhotoLinks(t.text, shots) : String(t.text || '');
    if (stored.length) words = withoutFileMarks(words, stored);
    return words;
  }

  // The words of a message with the digest of its file (digestOf): { own, digest } — the person's own words and the
  // Markdown of the digest ('' — none); without a digest `own` is wordsOf(t). The quote and Copy take both.
  function partsOf(t, look) {
    const digest = digestOf(look);
    if (!digest) return { own: wordsOf(t), digest: '' };
    const out = t.origin === 'profi_sent' || t.origin === 'folder_out';
    const shots = !out ? photosOf(t.attachments) : [];
    const text = shots.length ? withoutPhotoLinks(t.text, shots) : String(t.text || '');
    return { own: ownWords(text, digest, storedFilesOf(t.attachments)), digest: digest.text };
  }
  const shownWords = (t, look) => {
    const p = partsOf(t, look);
    return [p.own, p.digest].filter(Boolean).join('\n\n');
  };

  // What a quote says of a message the screen has (В7.35), while the server has not said it yet: the
  // draft of an answer still being written names the message it answers by its short number (the
  // attribute `reply_to` of <client_text>, profi_message_looks.sql); the window of the box brings the
  // server's quote when the answer is done.
  function quoteOfTurn(t, look, client) {
    const files = storedFilesOf(t.attachments);
    const voice = files.find((f) => f.kind === 'voice' || f.kind === 'audio');
    const photo = files.find((f) => f.kind === 'image' && f.path) || photosOf(t.attachments)[0] || null;
    const video = files.find((f) => f.kind === 'video');
    const kind = look.sticker ? 'sticker' : voice ? 'voice' : video ? 'video' : photo ? 'photo' : files.length ? 'file' : 'text';
    // The person of a chat of a folder writes as folder_in; in a group his name rides in the look (author).
    const mine = t.origin !== 'profi_client' && t.origin !== 'folder_in';
    const author = typeof look.author === 'string' && look.author.trim() ? look.author.trim() : null;
    return {
      uid: String(t.uid || ''), who: mine ? 'me' : 'client', name: mine ? null : (author || client || null),
      text: look.sticker ? (look.sticker.emoji || '') : shownWords(t, look), kind,
      seconds: (voice || video || {}).duration || null,
      photo: photo ? (photo.path ? { path: photo.path } : { url: photo.url }) : null,
    };
  }

  // The short number of a message in what the model reads (profi_message_looks.sql): the first 6 hex of
  // SHA-256 of its uid. The page counts it for the messages it shows, to find the one a draft answers.
  function shortNumber(uid) {
    const subtle = global.crypto && global.crypto.subtle;
    if (!subtle || typeof TextEncoder !== 'function') return Promise.resolve(null);
    return subtle.digest('SHA-256', new TextEncoder().encode(uid))
      .then((buf) => [...new Uint8Array(buf).slice(0, 3)].map((b) => b.toString(16).padStart(2, '0')).join(''))
      .catch(() => null);
  }

  // deps: rpc, copy, order, reload(), putBack(text) — a text taken back from the way to the
  // client, or a box to edit by hand, goes into the field; onClean(on) — the clean view
  // changed; clean — false: the chat opens with the discussion shown (Reply yourself);
  // the look of a message (В7.35–В7.40): sheet({ title, body, onClose }) → { close } — the common sheet
  // of the window; showInChat(uid) — the chat goes to a message and lights it; reply({ quoteUid, head,
  // text }) — the line of a reply over the field (В7.26); replyQuote() — the uid of the message the line
  // of a reply answers now, or null; replyDone() — the text left with it, the line goes.
  // the agent «Кто это» (В7.50, В7.54) — deps also gives: go(place) — a press on a link of Lex inside its words or on a
  // line of its message («chat/p:<person>», «order/<number>»): the screen opens that chat; armReply({ quoteUid, head,
  // text }) — the line «Reply to Lex» over the field put by the chat itself, only where no line stands. A word of Gennady
  // with that line goes to the agent (the page: wc-app.js sendWhois); there are no buttons.
// folder — the chat of a person or a group of a folder of chats (Kolya, Other; folder_chats.sql): the same
  // messages, with no order over them. The person's chat has the model, the assistant in correspondence
  // (assistant_folder_chats.sql): a tap gives the text to the model, its boxes go by sendBox(win) → { state,
  // channel } | null; holding the arrow, sendText(text, quoteUid) → true once the server took the text for the
  // person (the edge function folder-send). The chat of a group is the same (Gennady, 21.11.2026): a tap goes to
  // the model, its boxes and holding the arrow send into the group itself, where the database of Gennady sends to
  // the groups of that messenger (data.send, folder_group_send.sql) — the menu, the box and the lines under the text
  // name the group, for every member of it reads the text (Gennady, 20.11.2026). Where it does not send, the model
  // still works and a send into the group answers why (webchat/wc-app.js, sendToFolder, sendFolderBox).
  // A task chat of an agent works now (its mirror says so; a mark without a state is a working one, as its head says
  // «Working»): the live stage is the last line of its feed and the field's button is Stop (wc-app.js, 22.11.2026). The empty
  // chat of «New chat» (no chatKey) never works.
  function agentWorks(data) {
    return !!(data && data.kind === 'agent' && data.chatKey && data.agent && (data.agent.state || 'working') === 'working');
  }

  function createChat(deps) {
    const folder = !!deps.folder;
    let data = null;
    // The clean view of the chat (the button in the bar), while the chat is open. A chat opens
    // with it on (Gennady, 2026-11-14): an order chat is first of all the conversation with
    // the client; a word to Lex from the field turns it off, so that the answer is seen. A chat
    // opened by Reply yourself opens with it off: the person came for the bot's draft in its box
    // and the talk with the model about it, and the clean view hides both.
    let clean = deps.clean !== false;
    // The words being typed into the boxes of the chat (Edit, not yet saved), by window: they stay while the
    // answer is drawn again.
    const edits = new Map();
    const boxDeps = () => ({ rpc: deps.rpc, copy: deps.copy, refresh: deps.reload, notify: deps.notify,
      putBack: deps.putBack, replyTo: (data && data.replyTo) || null, client: (data && data.client) || null,
      openQuote: (q) => self.openQuote(q), folder, sendBox: deps.sendBox, edits,
      // the chat of a group: its whole title names where a box goes (every member reads it)
      group: folder && data && data.kind === 'group' ? String(data.title || data.client || '').trim() : null });
    // The runs of the hidden discussion the person brought back with Show, while the chat is open.
    const revealed = new Set();
    // The look of a message (В7.35–В7.40). The messages of the monitor the screen drew, by uid (the sheet
    // of a quote shows one with its neighbours, a toggle draws one again); their short numbers; the edited
    // ones whose earlier text is open; the message the last word to Lex answered (its draft carries its
    // quote while it is being written); the list of turns the screen draws into.
    const drawn = new Map();
    const numbers = new Map();
    const counted = new Set();
    const earlierOpen = new Set();
    let sentQuote = null;
    // What each answer with drafts was drawn from (paintAnswer): the same is not drawn again.
    const painted = new WeakMap();
    let lane = null;
    // My reactions the chat shows before the server has them (the press is Gennady's «yes»): uid → { emoji | null (taken
    // off), at }. They are mixed into the look of the message (lookOf) and into what the message is drawn from (sigOf);
    // an entry goes when a reading brings the same reaction (the `data` setter) or the server refuses (react).
    const reactMine = new Map();
    const lookOf = (uid) => {
      const l = data && data.looks && uid ? data.looks[uid] : null;
      const base = l && typeof l === 'object' ? l : {};
      const m = reactMine.get(uid);
      if (!m) return base;
      const others = (Array.isArray(base.reactions) ? base.reactions : []).filter((r) => !(r && r.who === 'me'));
      return Object.assign({}, base, { reactions: m.emoji ? [...others, { emoji: m.emoji, who: 'me', at: m.at }] : others });
    };
    // The branch «who is this» (19.11.2026, В7.50; no buttons since 21.11.2026, В7.54): a turn of it is drawn from its
    // look {case, turn, by, kind, headline, writer, rows, ask, open} and from which word of the model is the one that
    // waits for a word of Gennady — that word says «нужен твой ответ», and the line «Reply to Lex» stands over the field
    // by itself (whoisArm). A task chat of an agent of the base (a:, the section «Agents», 21.11.2026) is made of such
    // turns alone (`editor:<n>`): the agent's words, Gennady's, the system's; Gennady just writes words.
    const WHOIS_UID = /^profi:(?:whois|editor):[0-9]{1,18}$/;
    const agent = () => !!(data && data.kind === 'agent');
    const whoisOf = (uid) => {
      const w = lookOf(uid).whois;
      return w && typeof w === 'object' ? w : null;
    };
    const lastWhois = () => {
      let last = 0;
      for (const l of Object.values((data && data.looks) || {})) {
        const w = l && typeof l === 'object' ? l.whois : null;
        if (w && w.by === 'model' && w.open && Number(w.turn) > last) last = Number(w.turn);
      }
      return last;
    };
    // The last turn of a case, whoever wrote it: what Lex has not answered yet is a word of Gennady that is the last.
    const lastOfCase = (id) => {
      let last = 0;
      for (const l of Object.values((data && data.looks) || {})) {
        const w = l && typeof l === 'object' ? l.whois : null;
        if (w && w.case === id && Number(w.turn) > last) last = Number(w.turn);
      }
      return last;
    };
    // The turn of a case under that number, if the chat holds it.
    const whoisTurn = (id, n) => {
      for (const l of Object.values((data && data.looks) || {})) {
        const w = l && typeof l === 'object' ? l.whois : null;
        if (w && w.case === id && Number(w.turn) === n) return w;
      }
      return null;
    };
    // The word of the model that waits for Gennady: the last open word of the model, the last turn of its case, not an
    // attach the agent made by itself (it asks nothing), never in a task chat of an agent. A line of the system without
    // a kind after it («Не получилось применить решение: … Напиши ещё раз, кто это.») changed nothing: the case is still
    // open, so that word waits again.
    const whoisWaits = (uid) => {
      const w = whoisOf(uid);
      if (!w || agent() || w.by !== 'model' || !w.open || w.kind === 'attached' || w.kind === 'undone') return false;
      const n = Number(w.turn);
      if (!(n > 0) || lastWhois() !== n) return false;
      const last = lastOfCase(w.case);
      if (last === n) return true;
      const after = whoisTurn(w.case, last);
      return !!(after && after.by === 'system' && !after.kind && after.open);
    };
    // A word of Gennady the server refused, by the uid of the turn it answered: { error } — «Не отправлено: …» stands in
    // red under that message until the next word goes.
    const whoisNote = new Map();
    // The waits whose line «Reply to Lex» this chat put over the field by itself (whoisArm), `<uid>@<last turn of the
    // case>`: once each — × keeps it off until a newer word of the agent waits, or the same word waits anew.
    const whoisArmed = new Set();
    // The word of Gennady to Lex that the database has not shown yet (a press of Send with the line «Reply to Lex», the
    // page: wc-app.js sendWhois). At the press it stands at the end of the chat «Sending…»; once the server took it Lex
    // «thinks» under it; it goes the moment the chat draws the word itself, or in 8 s if that does not come.
    // { text, at, state: 'sending' | 'taken', before: the uids of his words the chat had, quoteUid }.
    let whoisWord = null;
    let whoisWordTimer = 0;
    // The host of the outbox the chat painted last (the timer and the word repaint it themselves).
    let outboxHost = null;
    // What a message is drawn from: its look, its open earlier text, what Profi said the client read. A turn of the branch
    // also from the state of its case: the last word of the model, the last turn, a refused word under it.
    const sigOf = (uid) => JSON.stringify([lookOf(uid), earlierOpen.has(uid), ((data && data.readTurns) || []).includes(uid),
      WHOIS_UID.test(uid)
        ? [lastWhois(), lastOfCase((whoisOf(uid) || {}).case), whoisNote.get(uid) || null] : null]);
    // One message drawn again where it stands (a reaction put or taken off before the server has it).
    const redraw = (uid) => {
      const t = drawn.get(uid);
      const n = lane && lane.isConnected ? [...lane.querySelectorAll(':scope > .lex-profi-msg[data-uid]')].find((x) => x.dataset.uid === uid) : null;
      if (t && n) n.replaceWith(self.messageNode(t));
    };
    // The uids of the words of Gennady to Lex the chat has (his turns of the branch), to know which one is new.
    const whoisHisWords = () => Object.entries((data && data.looks) || {})
      .filter(([, l]) => l && typeof l === 'object' && l.whois && l.whois.by === 'gennady').map(([u]) => u);
    const remember = (t) => {
      const uid = String(t.uid || '');
      if (!uid) return;
      drawn.set(uid, t);
      if (counted.has(uid)) return;
      counted.add(uid);
      shortNumber(uid).then((n) => { if (n) numbers.set(n, uid); });
    };
    // Who said a message, for the line of a reply: the client by his first name, mine «You».
    const replyHead = (q) => `Reply to ${q.who === 'client' ? (firstName(q.name) || 'the client') : global.LexMessage.quoteName(q)}`;
    // The calls the person opened, and their whole transcripts once loaded, while the chat is open: a repaint of the
    // chat keeps a call open (В7.42).
    const calls = new Map();
    const self = {
      order: deps.order,
      get data() { return data; },
      set data(v) {
        data = v;
        for (const [uid, m] of [...reactMine]) {
          const l = v && v.looks ? v.looks[uid] : null;
          const mine = (l && Array.isArray(l.reactions) ? l.reactions : []).filter((r) => r && r.who === 'me');
          if (m.emoji ? mine.some((r) => emojiKey(r.emoji) === emojiKey(m.emoji)) : !mine.length) reactMine.delete(uid);
        }
      },

      // The order the way Profi shows it. On top what matters at a glance, then its blocks,
      // below what is seen less often. What stands where is the monitor's and the server's word.
      head() {
        // A chat of a folder has no order: nothing stands over its messages.
        if (folder) return document.createDocumentFragment();
        const root = make('header', 'lex-profi-head');
        if (!data) return root;
        // The title opens the order on the site of Profi (the arrow of the bar moved here,
        // 2026-11-14): a link with a small arrow on its right.
        if (data.orderUrl) {
          const a = make('a', 'lex-profi-head-title lex-profi-head-order', data.title || '');
          a.href = data.orderUrl;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.setAttribute('aria-label', `${data.title || 'The order'}. Open the order on Profi`);
          a.appendChild(strokeIcon([['path', { d: 'M7 17L17 7' }], ['path', { d: 'M8 7h9v9' }]], 14));
          root.appendChild(a);
        } else {
          root.appendChild(make('div', 'lex-profi-head-title', data.title || ''));
        }
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
          // The files the client attached to the order (the block «Файлы», 2026-11-14): each name is a
          // link to the file itself on the site of Profi, the same link as «Chat on Profi».
          const links = (Array.isArray(s.links) ? s.links : [])
            .filter((l) => l && typeof l.url === 'string' && PROFI_FILE.test(l.url));
          if (!links.length) {
            root.appendChild(make('div', 'lex-profi-head-text', s.text));
            continue;
          }
          const box = make('div', 'lex-profi-head-text');
          links.forEach((l, i) => {
            if (i) box.appendChild(document.createElement('br'));
            const a = make('a', 'lex-profi-link', String(l.name || 'File'));
            a.href = l.url;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            box.appendChild(a);
          });
          root.appendChild(box);
        }
        if ((data.foot || []).length) root.appendChild(make('div', 'lex-profi-head-foot', data.foot.join(' · ')));
        return root;
      },

      // What the monitor writes into the chat, as in Telegram (2026-11-13): the client on the
      // left, what went to him on the right with the mark of Profi, a notice of Profi as a plate
      // in the middle. Every message says the channel it came by beside its time: the server
      // names the turns that came from elsewhere (`channels`, profi_open), the rest came from
      // Profi.ru. The parts know every channel (lex-message.js).
      // The look of a message (В7.35–В7.40, `looks` of profi_open by uid): «Forwarded from …», the quote of
      // the message it answers, emoji alone at 22, a sticker without a bubble, reactions left of the stamp,
      // «edited» and the earlier text, a deleted one paler; the ticks under what went, in every channel.
      // A press on the right button of a mouse, or a finger held 480 ms, opens its menu (В7.36).
      // o.still — a copy for the sheet of a message: no menu, a quote that does not open.
      messageNode(t, o) {
        // The branch «who is this» in the chat of a new person: the question of Lex, the word of Gennady to it, a line of the system.
        if (t.origin === 'folder_whois') return self.whoisNode(t, o);
        const M = global.LexMessage;
        // A chat of a folder: what the person wrote on the left (folder_in), Gennady's on the right
        // (folder_out), whichever messenger it went by.
        const out = t.origin === 'profi_sent' || t.origin === 'folder_out';
        const notice = t.origin === 'profi_notice';
        const uid = String(t.uid || '');
        const named = data && data.channels && data.channels[uid];
        const ch = !notice && named && M.CHANNELS[named] ? named : folder ? null : CHANNEL;
        const look = lookOf(uid);
        const still = !!(o && o.still);
        if (!still) remember(t);
        let node;
        if (notice) {
          node = M.notice({ channel: ch, at: t.authoredAt, body: linkedText(make('span', 'lex-notice-text', ''), t.text) });
        } else {
          // The ticks under everything that went, in every channel (В7.2): the server's `delivery`; an
          // older server — what Profi said it read (`readTurns`).
          const read = look.delivery ? look.delivery === 'read' : new Set((data && data.readTurns) || []).has(uid);
          const tail = out ? tickNode(read) : null;
          // An edited message says when its text was written (`editedAt`), as the canvas has it.
          const at = look.editedAt && !look.deletedAt ? look.editedAt : t.authoredAt;
          if (look.sticker && typeof look.sticker === 'object') {
            // The picture of a sticker of Telegram comes as the turn's stored image too: it is drawn as the
            // sticker, never as a photo in a bubble, and its words («[стикер 👍]») are not shown.
            const pic = storedFilesOf(t.attachments).find((f) => f.kind === 'image' && f.path);
            const sticker = look.sticker.path || look.sticker.url || !pic ? look.sticker
              : Object.assign({}, look.sticker, { path: pic.path, mime: pic.mime || look.sticker.mime });
            node = M.sticker({ side: out ? 'out' : 'in', sticker, at, tail, io: fileIo,
              reactions: M.reactions(look.reactions, { client: data && data.client, onMine: self.canReact(t) ? () => self.react(uid, '') : null }) });
          } else {
            // A photo of the client (profi_client_photos.sql): the picture over the text; its link «[фото](…)»
            // the monitor put into the text is not repeated under it. The stored files of the turn
            // (chat_files.sql) stand there too: a photo, a voice message, a video, a document.
            const shots = !out ? photosOf(t.attachments) : [];
            const stored = M.files ? storedFilesOf(t.attachments) : [];
            // The digest of the file (look.attachment, digestOf): under the file the person's own words, then the
            // digest in Markdown, instead of what the database read off the file.
            const said = partsOf(t, look);
            const words = said.own;
            const parts = [shots.length && M.photos ? M.photos(shots) : null, stored.length ? M.files(stored, fileIo) : null]
              .filter(Boolean);
            let media = parts[0] || null;
            if (parts.length > 1) {
              media = make('div', 'lex-files');
              media.append(...parts);
            }
            const quote = look.quote && typeof look.quote === 'object'
              ? M.quote(look.quote, { io: fileIo, onPress: still ? null : (q) => self.openQuote(q) }) : null;
            const edited = Array.isArray(look.edits) && look.edits.length > 0;
            node = M.bubble({ side: out ? 'out' : 'in', media,
              // A group of a folder: the name of who wrote over his message, as Telegram has it.
              label: folder && !out && typeof look.author === 'string' && look.author.trim() ? look.author.trim() : null,
              body: said.digest ? M.digest(words, said.digest) : linkedText(make('div', '', ''), words),
              // «Forwarded from <name>»; `forwarded` alone — the author is not known (WhatsApp): «Forwarded».
              forwarded: typeof look.forwardedFrom === 'string' && look.forwardedFrom.trim() ? look.forwardedFrom.trim()
                : look.forwarded === true ? true : null,
              quote,
              big: !media && !said.digest && M.emojiOnly(words),
              reactions: M.reactions(look.reactions, { client: data && data.client, onMine: self.canReact(t) ? () => self.react(uid, '') : null }),
              after: edited && earlierOpen.has(uid) ? M.earlier(look.edits) : null,
              faded: !!look.deletedAt,
              stamp: M.stamp({ channel: ch, at, tail, edited: edited || !!look.editedAt, deleted: !!look.deletedAt }) });
          }
        }
        const root = make('div', `wc-turn lex-profi-msg ${notice ? 'is-notice' : out ? 'is-sent' : 'is-client'}`);
        root.appendChild(node);
        if (t.uid) root.dataset.uid = uid;
        if (t.origin) root.dataset.origin = String(t.origin);
        if (t.authoredAt) root.dataset.at = t.authoredAt;
        // What the look was drawn from: a fresh reading that says otherwise draws the message again
        // (paintHidden), a reaction or an edit comes without a new turn.
        root.dataset.look = sigOf(uid);
        // The client's words and Profi's notices come without the person: they can be new.
        if (!out) root.dataset.in = '1';
        if (!notice && !still) self.attachMenu(root, node, t);
        return root;
      },

      // The branch «who is this» (19.11.2026, В7.50; no buttons since 21.11.2026, В7.54). A turn of the model is the
      // message of the agent «Кто это»: the mark, the conclusion, the lines of who writes and whom the agent takes him
      // for (a press opens that chat or that card), the reason (Markdown with links: a site opens in a new tab, a place
      // of Lex — in Lex), what the agent waits for under a line. Gennady answers in words: the line «Reply to Lex» over
      // the field (whoisArm for a waiting word, Reply in the menu for an attach). A word of Gennady in the branch is his
      // bubble to Lex; a line of the system («Отменено: …») is a plate. The look of a turn is `look.whois`; the person
      // never gets any of it, and the assistant in correspondence never reads it.
      whoisNode(t, o) {
        const M = global.LexMessage;
        const uid = String(t.uid || '');
        const w = whoisOf(uid) || {};
        const by = w.by === 'gennady' ? 'gennady' : w.by === 'system' ? 'system' : 'model';
        const still = !!(o && o.still);
        if (!still) remember(t);
        // The chat draws the word the press put at its end: the word of the press goes, this one takes its place.
        if (!still && by === 'gennady' && whoisWord && !whoisWord.before.includes(uid)) self.whoisSettle();
        const row = make('div', `wc-turn lex-profi-msg is-whois is-${by}`);
        if (uid) row.dataset.uid = uid;
        row.dataset.origin = 'folder_whois';
        if (t.authoredAt) row.dataset.at = t.authoredAt;
        row.dataset.look = sigOf(uid);
        let words = String(t.text || '');
        const kind = ['attached', 'guess', 'question', 'reply', 'undone'].includes(w.kind) ? w.kind : null;
        if (by === 'system' || kind === 'undone') {
          row.classList.add('is-notice');
          row.appendChild(M.notice({ text: words, at: t.authoredAt }));
          return row;
        }
        if (by === 'gennady') {
          // His word to the model about this question: the bubble of the person's word to Lex, «To Lex» over it (in a task
          // chat of an agent the bubble alone: every word there goes to the agent).
          const bubble = self.whoisWordBubble(words, t.authoredAt, { plain: agent() });
          row.appendChild(bubble);
          if (!still) self.attachWhoisMenu(row, bubble, t, 'out', false);
          // Lex has not answered yet: Lex «thinks» under the word (the dots of the assistant), for a minute and a half
          // at most — the agent writes in seconds; dots that stayed would say what is not true.
          const waited = Date.now() - (Date.parse(t.authoredAt || '') || 0);
          if (!still && !agent() && w.open && Number(w.turn) === lastOfCase(w.case) && waited >= 0 && waited < 90000) {
            const thinking = self.thinking();
            row.appendChild(thinking);
            setTimeout(() => thinking.remove(), 90000 - waited);
          }
          return row;
        }
        // The conclusion stands bold on top and what the agent waits for under a line: the words between are the reason.
        const headline = typeof w.headline === 'string' ? w.headline.trim() : '';
        const ask = typeof w.ask === 'string' ? w.ask.trim() : '';
        words = words.trim();
        if (headline && words.startsWith(headline)) words = words.slice(headline.length).trim();
        if (ask && words.endsWith(ask)) words = words.slice(0, words.length - ask.length).trim();
        const body = make('div', '', '');
        const md = global.WcMarkdown;
        if (md && typeof md.into === 'function') md.into(body, words, { lex: true }); else body.textContent = words;
        const onGo = (place) => { if (typeof deps.go === 'function') deps.go(place); };
        // A task chat of an agent: its word under the agent's name with no bubble (boards AgChat, AgChatWaiting).
        if (agent()) {
          const ag = (data && data.agent) || {};
          const part = M.whois({ task: true, author: ag.name || ag.key || '', body, at: t.authoredAt, onGo });
          row.appendChild(part);
          row.dataset.in = '1';
          if (!still) self.attachWhoisMenu(row, part, t, null, false);
          return row;
        }
        const wait = whoisWaits(uid);
        const rows = self.whoisRows(w);
        const tied = (w.writer && w.writer.kind === 'group') || (Array.isArray(w.rows) && w.rows.some((r) => r && r.kind === 'deal'));
        const mark = wait ? 'нужен твой ответ' : kind === 'attached' ? (tied ? 'привязал сам' : 'присоединил сам') : '';
        // An attach of the agent that still stands (`undo`: the database can still undo it; an undone one loses it) is
        // yellow, «look here» (25.11.2026: Gennady sees at once whom the agent joined here, and says «не он» if not).
        const attention = kind === 'attached' && w.undo === true;
        const part = M.whois({
          message: true, mark, wait, headline, rows, body, ask, at: t.authoredAt, onGo,
          note: whoisNote.get(uid) || null, attention,
        });
        row.appendChild(part);
        // The message comes without the person: it can be new (the «Новые» line, the unread of the chat).
        row.dataset.in = '1';
        // Reply in its menu: on a word that waits and on an attach (a word about it goes to the agent with its turn).
        if (!still) self.attachWhoisMenu(row, part, t, null, wait || kind === 'attached' || !!w.open);
        return row;
      },

      // The lines of the message (В7.54): who writes (`writer`: a person or a group, the channel and the address or the
      // members), then whom the agent takes him for (`rows`: «Это», «Дело», «Думаю, это»). A line opens what Lex can open:
      // the person's chat (`chat/p:<id>`), the order chat (`order/<n>`), the card of the person when it is this order
      // chat; a writer with a site (`url`) opens it in a new tab. The chat on the screen itself is no link.
      whoisRows(w) {
        const out = [];
        const M = global.LexMessage;
        // The channel comes as a word («Telegram», «WhatsApp», «Max»); an id of a channel is named by its part.
        const channelName = (c) => {
          const word = String(c || '').trim();
          const known = M.CHANNELS && M.CHANNELS[word.toLowerCase()];
          return (known && known.name) || word;
        };
        const wr = w.writer && typeof w.writer === 'object' ? w.writer : null;
        if (wr && String(wr.name || '').trim()) {
          const group = wr.kind === 'group';
          const n = Number(wr.members);
          const members = Number.isFinite(n) && n > 0 ? `${n} ${plural(n, 'участник', 'участника', 'участников')}`
            : (typeof wr.members === 'string' ? wr.members.trim() : '');
          const sub = [channelName(wr.channel), group ? members : String(wr.address || '').trim()].filter(Boolean).join(' · ');
          const url = typeof wr.url === 'string' && /^https:\/\/\S+$/.test(wr.url) ? wr.url : '';
          out.push({ caption: group ? 'Группа' : 'Пишет', name: String(wr.name).trim(), sub,
            face: { name: String(wr.name).trim() }, ...(url ? { href: url } : {}) });
        }
        for (const r of Array.isArray(w.rows) ? w.rows : []) {
          if (!r || typeof r !== 'object' || !String(r.name || '').trim()) continue;
          const deal = r.kind === 'deal';
          const caption = r.role === 'maybe' ? 'Думаю, это' : deal ? 'Дело' : 'Это';
          const press = self.whoisPress(r.go);
          out.push({ caption, name: String(r.name).trim(), sub: String(r.sub || '').trim(),
            face: { name: String(r.name).trim(), deal }, ...(press ? { onPress: press } : {}) });
        }
        return out;
      },

      // What a press on a line opens: null — nothing, the line is no link.
      whoisPress(go) {
        const place = String(go || '');
        const p = /^chat\/(p:[0-9a-f-]{36})$/.exec(place);
        if (p) {
          if (folder && data && data.ref === p[1]) return null;
          return typeof deps.go === 'function' ? () => deps.go(place) : null;
        }
        const n = /^order\/([A-Za-z0-9_-]{1,40})$/.exec(place);
        if (!n) return null;
        if (!folder && String(deps.order || '') === n[1]) {
          // This very order chat: the line opens the card of the person, as the bar over the chat does (В7.41).
          return global.LexPerson && deps.person && data && data.chatKey
            ? () => global.LexPerson.open({ chatKey: data.chatKey, name: (data && data.client) || 'Client', call: deps.person,
              onGone: deps.onPersonGone, io: fileIo })
            : null;
        }
        return typeof deps.go === 'function' ? () => deps.go(place) : null;
      },

      // The menu of a turn of the branch: Copy and Select as of every message; Reply on a word the agent waits an answer to
      // or on an attach of it.
      attachWhoisMenu(row, face, t, side, canReply) {
        const M = global.LexMessage;
        if (!M || !M.attachMenu) return;
        const uid = String(t.uid || '');
        M.attachMenu(face, {
          ...(side ? { side } : {}),
          body: face.querySelector('.lex-q-text, .lex-bubble-text') || face,
          who: () => (side === 'out' ? '' : 'Lex'),
          at: () => t.authoredAt || null,
          host: () => row.parentElement,
          reply: canReply && typeof deps.reply === 'function' ? () => self.whoisReply(uid) : null,
        });
      },

      // The line «Reply to Lex» over the field with the first words of the message; the next word of the field goes to the
      // agent of this case (the page: send() in wc-app.js), not to the person, not to the assistant.
      whoisLine(uid) {
        const t = drawn.get(uid);
        if (!t) return null;
        const w = whoisOf(uid) || {};
        return { quoteUid: uid, head: 'Reply to Lex', text: plainLine(String(w.headline || '').trim() || t.text, 160) };
      },
      whoisReply(uid) {
        const line = self.whoisLine(uid);
        if (line && typeof deps.reply === 'function') deps.reply(line);
      },

      // The word of the agent that waits for Gennady puts the line «Reply to Lex» over the field by itself, once per word:
      // never over a line that stands (a Reply, an edit), and × keeps it off until a newer word waits. The line it put goes
      // when that word stops waiting (Gennady answered it, the case closed).
      whoisArm() {
        if (agent() || !data) return;
        const quote = typeof deps.replyQuote === 'function' ? deps.replyQuote() : null;
        const armedQuote = quote && [...whoisArmed].some((k) => k.split('@')[0] === quote);
        if (armedQuote && !whoisWaits(quote) && typeof deps.replyDone === 'function') deps.replyDone();
        if (typeof deps.armReply !== 'function') return;
        const uid = Object.keys(data.looks || {}).find((u) => WHOIS_UID.test(u) && whoisWaits(u));
        if (!uid || !drawn.has(uid)) return;
        // Once per wait: the word and the last turn of its case (a failed «да» makes the same word wait anew).
        const w = whoisOf(uid) || {};
        const key = `${uid}@${lastOfCase(w.case)}`;
        if (whoisArmed.has(key)) return;
        whoisArmed.add(key);
        const line = self.whoisLine(uid);
        if (line) deps.armReply(line);
      },

      // The turn `uid` of the branch drawn again in its place (a refused word under it).
      redrawWhois(uid) {
        const n = lane ? [...lane.querySelectorAll(':scope > .lex-profi-msg[data-uid]')].find((x) => x.dataset.uid === uid) : null;
        if (n && drawn.has(uid)) n.replaceWith(self.whoisNode(drawn.get(uid)));
      },

      // The word of Gennady to Lex: the bubble «To Lex» of the person's word, the same in the chat and at its end.
      // o.plain — the same grey bubble without «To Lex» (a task chat of an agent, board AgChat).
      whoisWordBubble(words, at, o) {
        const M = global.LexMessage;
        let label = null;
        if (!(o && o.plain)) {
          label = make('div', 'lex-bubble-label', '');
          label.append(M.sparkle(12), document.createTextNode('To Lex'));
        }
        return M.bubble({ side: 'out', tone: 'self', label, text: words, stamp: M.stamp({ at }) });
      },

      // Lex «thinks»: the assistant waiting for its first word — its head and the three dots, drawn by the rule of the
      // assistant (wc-app.css), not by a new one.
      thinking() {
        const box = make('div', 'lex-msg lex-profi-answer lex-whois-thinking', '');
        box.setAttribute('role', 'status');
        box.setAttribute('aria-label', 'Lex is thinking');
        box.append(self.lexHead(new Date().toISOString()), make('div', 'wc-bubble', ''));
        return box;
      },

      // A press of Send with the line «Reply to Lex» over the field (the page: wc-app.js sendWhois). false — a word of this
      // chat is on its way: the second press does nothing, the caller keeps the words in the field. Otherwise the word
      // stands at the end of the chat at once, «Sending…», and an earlier refusal under a message goes.
      whoisSending(text, quoteUid) {
        if (whoisWord) return false;
        for (const u of [...whoisNote.keys()]) { whoisNote.delete(u); self.redrawWhois(u); }
        whoisWord = { text: String(text || ''), at: new Date().toISOString(), state: 'sending', before: whoisHisWords(), quoteUid: quoteUid || null };
        self.repaintOutbox();
        return true;
      },

      // The server took the word: Lex thinks under it until the chat draws the word itself (8 s at most).
      whoisTaken() {
        if (!whoisWord) return;
        whoisWord.state = 'taken';
        clearTimeout(whoisWordTimer);
        whoisWordTimer = setTimeout(() => self.whoisSettle(), 8000);
        self.repaintOutbox();
      },

      // The server refused the word: it leaves the end of the chat, and the refusal stands in red under the message of the
      // question it answered. false — the chat has drawn the word already: it went, nothing to take back.
      whoisRefused(why) {
        const w = whoisWord;
        if (!w) return false;
        whoisWord = null;
        clearTimeout(whoisWordTimer);
        if (w.quoteUid) {
          whoisNote.set(w.quoteUid, { error: String(why || 'Try again.') });
          self.redrawWhois(w.quoteUid);
        }
        self.repaintOutbox();
        return true;
      },

      // The word of the press is not at the end of the chat any more: the chat draws it, or the time is out.
      whoisSettle() {
        if (!whoisWord) return;
        clearTimeout(whoisWordTimer);
        whoisWord = null;
        self.repaintOutbox();
      },

      // The word of the press as it stands at the end of the chat: as the chat will draw it, «Sending…» or Lex thinking under it.
      whoisWordItem() {
        const w = whoisWord;
        const root = make('div', 'wc-turn lex-profi-msg is-whois is-gennady is-pending');
        root.appendChild(self.whoisWordBubble(w.text, w.at, { plain: agent() }));
        if (w.state === 'sending') {
          const note = make('div', 'lex-profi-box-note', 'Sending…');
          note.setAttribute('role', 'status');
          root.appendChild(note);
        } else if (agent() && global.LexSection) root.appendChild(global.LexSection.liveStage({ stage: 'taken' }));
        else root.appendChild(self.thinking());
        return root;
      },

      // The outbox painted again where the chat painted it last, if that is still the outbox of this chat.
      repaintOutbox() {
        if (outboxHost && outboxHost.__profiChat === self && outboxHost.isConnected) self.paintOutbox(outboxHost);
      },

      // The menu of a message (В7.36): the common menu of a message (LexMessage.attachMenu, block 2 of 2026-11-18)
      // — Reply (with the words selected in it, if any), Copy, Select, Show the earlier text of an edited one. The
      // right button of a mouse, a finger held 480 ms, the key of the menu, «⋯» over the bubble for a mouse; over
      // a photo, a link or a file the right button gives the browser's own menu.
      attachMenu(root, face, t) {
        const M = global.LexMessage;
        if (!M || !M.attachMenu) return;
        const uid = String(t.uid || '');
        const out = t.origin === 'profi_sent' || t.origin === 'folder_out';
        M.attachMenu(face, {
          side: out ? 'out' : 'in',
          text: () => {
            const look = lookOf(uid);
            return look.sticker ? (look.sticker.emoji || 'Sticker') : shownWords(t, look);
          },
          body: face.querySelector('.lex-bubble-text') || face,
          who: () => {
            if (out) return '';
            const look = lookOf(uid);
            return (folder && typeof look.author === 'string' && look.author.trim()) || (data && data.client) || 'Client';
          },
          at: () => t.authoredAt || null,
          host: () => root.parentElement,
          reply: (part) => self.replyTo(uid, part),
          // Edit of a message that went to a person (19.11.2026): read when the menu opens, as the window of WhatsApp
          // for editing closes 15 minutes after the send.
          get editSent() { return self.canEditSent(t) ? () => self.editSent(t) : null; },
          // The bar of reactions over the items (24.11.2026): the emoji of the channel of this message; mine is marked.
          get react() { return self.canReact(t) ? () => self.reactSpec(t) : null; },
          earlier: () => {
            const look = lookOf(uid);
            if (!Array.isArray(look.edits) || !look.edits.length) return null;
            return {
              open: earlierOpen.has(uid),
              toggle: () => {
                if (earlierOpen.has(uid)) earlierOpen.delete(uid); else earlierOpen.add(uid);
                if (root.isConnected) root.replaceWith(self.messageNode(t));
              },
            };
          },
        });
      },

      // Reply to a message (В7.26): the line of a reply over the field; the next word to Lex, or one's own
      // text to the client, goes as the answer to it (`quoteUid`).
      // part — the words selected in the message (block 2): the line shows them. The messenger gets the answer to
      // the whole message: the door of the base (/folders/send) takes no quote of a part yet.
      replyTo(uid, part) {
        const t = drawn.get(uid);
        if (!t || typeof deps.reply !== 'function') return;
        const q = quoteOfTurn(t, lookOf(uid), data && data.client);
        const words = String(part || '').replace(/\s+/g, ' ').trim();
        deps.reply({ quoteUid: uid, head: replyHead(q), text: words ? `«${words}»` : global.LexMessage.quoteWords(q) });
      },

      // A word to Lex went with the line of a reply: the draft being written for it carries the quote of
      // that message until the server's window brings its own (see boxQuote).
      quoteSent(uid) { sentQuote = uid || null; },

      // The quote over a draft (В7.35): the server's (`quote` of its window), or, while the answer is
      // being written, the message its tag names (`reply_to`, a short number) or the one the word to Lex
      // answered; `reply_to=""` — no quote.
      boxQuote(part, win) {
        if (win && Object.prototype.hasOwnProperty.call(win, 'quote')) return win.quote && typeof win.quote === 'object' ? win.quote : null;
        if (part.replyTo === '') return null;
        const uid = part.replyTo ? numbers.get(part.replyTo) : sentQuote;
        const t = uid ? drawn.get(uid) : null;
        return t ? quoteOfTurn(t, lookOf(uid), data && data.client) : null;
      },

      // A press on a quote (В7.37): the sheet of that message over the chat, which does not move — when it
      // was, the message in a frame with one message before it and two after, «Show in chat» and «Reply».
      // A message this chat does not have — the quote's own words, «Show in chat» off.
      // A press on a quote (block 2, 2026-11-18): the chat goes to the message itself and lights it, the button
      // «down» brings the reader back (WcThread.showTurn); a message the chat does not have — its sheet.
      openQuote(q) {
        const M = global.LexMessage;
        if (!q) return;
        const uid = String(q.uid || '');
        if (uid && drawn.has(uid) && typeof deps.showInChat === 'function' && deps.showInChat(uid, { back: true })) return;
        if (typeof deps.sheet !== 'function') return;
        const t = uid ? drawn.get(uid) : null;
        let nodes;
        let lit;
        let title = 'Message';
        if (t) {
          const order = lane ? [...lane.querySelectorAll(':scope > .lex-profi-msg[data-uid]')].map((n) => n.dataset.uid) : [uid];
          const at = Math.max(0, order.indexOf(uid));
          const near = order.slice(Math.max(0, at - 1), at + 3).filter((u) => drawn.has(u));
          nodes = near.map((u) => self.messageNode(drawn.get(u), { still: true }));
          const own = nodes[near.indexOf(uid)];
          lit = own ? own.querySelector('.lex-bubble, .lex-sticker-pic') : null;
          title = M.newsWhen(t.authoredAt) || title;
        } else {
          const bubble = M.bubble({ side: q.who === 'client' ? 'in' : 'out', text: q.text || M.quoteWords(q) });
          const root = make('div', `wc-turn lex-profi-msg ${q.who === 'client' ? 'is-client' : 'is-sent'}`);
          root.appendChild(bubble);
          nodes = [root];
          lit = bubble;
        }
        let sheet = null;
        const body = M.messageSheet({
          nodes, lit,
          onShow: t && typeof deps.showInChat === 'function' ? () => { if (sheet) sheet.close(); deps.showInChat(uid); } : null,
          onReply: () => {
            if (sheet) sheet.close();
            if (t) { self.replyTo(uid); return; }
            if (typeof deps.reply === 'function') deps.reply({ quoteUid: uid, head: replyHead(q), text: M.quoteWords(q) });
          },
        });
        M.mark(body.querySelector('.lex-msgsheet-lane'), null);
        sheet = deps.sheet({ title, body });
      },

      // The person's word to the model: on the right, grey, «To Lex» over it, the time under it.
      // The head of a word of Lex in the chat: the sparkle, «Lex», the time, «only you see this» — one for the answer of the
      // assistant being drawn (dress) and for the assistant waiting for its first word (thinking).
      lexHead(at) {
        const M = global.LexMessage;
        const head = make('div', 'lex-msg-head lex-profi-lex-head', '');
        const mark = make('span', 'lex-profi-lex-mark', '');
        mark.appendChild(M.sparkle(14));
        const only = make('span', 'lex-profi-only', '');
        only.append(M.eyeOff(12), document.createTextNode('only you see this'));
        head.append(mark, make('span', 'lex-msg-name', 'Lex'), make('span', 'lex-msg-time', at ? M.timeOf(at) : ''), only);
        return head;
      },

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
          // The time of the word is not in the bubble: it stands in the row of actions under it (В7.78, wc-thread.js).
        }
        // The model's word: a message without a bubble (В7.13) across the whole lane — the sparkle
        // of Lex, «Lex», the time, «only you see this»; its text under it, its drafts on the right.
        for (const t of thread.querySelectorAll(':scope > .wc-turn-assistant')) {
          if (t.classList.contains('wc-turn-news') || t.classList.contains('wc-turn-error')) continue;
          let head = t.querySelector(':scope > .lex-profi-lex-head');
          if (!head) {
            t.classList.add('lex-msg', 'lex-profi-answer');
            head = self.lexHead();
            t.prepend(head);
          }
          const time = head.querySelector('.lex-msg-time');
          const at = t.dataset.at ? M.timeOf(t.dataset.at) : '';
          if (time.textContent !== at) time.textContent = at;
        }
      },

      // The parts of an answer in the order the model wrote them: its words without a bubble, each
      // draft for the client on the right with its own row of buttons (В7.20).
      paintAnswer(turn, bubble, raw, md, streaming) {
        const parts = splitAnswer(raw);
        const boxes = parts.filter((p) => p.kind === 'box');
        if (!boxes.length) {
          bubble.classList.remove('lex-profi-boxes');
          md.into(bubble, parts.map((p) => p.text.trim()).join('\n\n'));
          bubble.hidden = !parts.length;
          return;
        }
        bubble.classList.add('lex-profi-boxes');
        bubble.hidden = false;
        const uid = turn.dataset.uid || '';
        const wins = ((data && data.windows) || []).filter((w) => w.turn === uid);
        // The same answer with the same windows is not drawn again (block 2, 2026-11-18): a signal of any
        // order came here every 1–3 s and took away what the person was selecting in it.
        const sig = streaming ? null : JSON.stringify([raw, wins, sentQuote, data && data.client]);
        if (sig && painted.get(bubble) === sig) return;
        if (sig) painted.set(bubble, sig); else painted.delete(bubble);
        let i = 0;
        bubble.replaceChildren(...parts.map((p) => {
          if (p.kind === 'text') {
            const words = make('div', 'lex-profi-words', '');
            md.into(words, p.text.trim());
            return words;
          }
          const idx = i++;
          const win = streaming || p.open ? null : wins.find((w) => w.idx === idx) || null;
          return boxNode(p.text, win, boxDeps(), self.boxQuote(p, win));
        }));
      },

      // A call with the client (В7.42, profi_calls.sql): the block with its summaries at the time of the call, or a
      // plate for a missed call and a call without a recording (В7.3). Its view rides in the turn ({kind: 'call'});
      // the whole transcript comes from the server when the person asks for it. It is the conversation with the
      // client, so the clean view keeps it (lex-profi-msg).
      callNode(t) {
        const M = global.LexMessage;
        const v = ((Array.isArray(t.attachments) ? t.attachments : []).find((a) => a && a.kind === 'call') || {}).call || {};
        const root = make('div', 'wc-turn lex-profi-msg is-call');
        if (t.uid) root.dataset.uid = String(t.uid);
        if (t.authoredAt) root.dataset.at = t.authoredAt;
        const ch = M.CHANNELS[v.channel] ? v.channel : null;
        // The call stands at its start, but the message comes when the call is over: its stamp says the end.
        const start = Date.parse(v.at || t.authoredAt || '');
        const at = v.seconds > 0 && start ? new Date(start + v.seconds * 1000).toISOString() : (v.at || t.authoredAt);
        if (v.kind && v.kind !== 'call') {
          root.classList.add('is-notice');
          const who = firstName(data && data.client) || 'the client';
          const text = v.kind === 'missed' ? `Missed call from ${who}`
            : v.kind === 'noanswer' ? `Call to ${who}, no answer`
            : v.kind === 'unrecorded' ? `Call, ${M.callLength(v.seconds)}, not recorded`
            : v.direction === 'out' ? `Call to ${who}` : `Call from ${who}`;
          root.appendChild(M.notice({ channel: ch, text, at }));
          return root;
        }
        const key = String(v.key || '');
        const st = calls.get(key) || { open: false, all: false, lines: null, loading: false };
        calls.set(key, st);
        const paint = () => root.replaceChildren(M.call({
          channel: ch, at, seconds: v.seconds, state: v.state, short: v.short, sections: v.sections, lines: v.lines,
          head: v.head, transcript: st.lines, open: st.open, all: st.all, loading: st.loading,
          onToggle: (open) => {
            st.open = open;
            if (!open) st.all = false;
            paint();
          },
          onAll: async () => {
            if (!st.lines) {
              st.loading = true;
              paint();
              try {
                const r = await deps.rpc('profi_call_transcript', { p_order: deps.order, p_key: key });
                st.lines = Array.isArray(r) ? r : null;
              } catch (_) {
                st.lines = null;
              }
              st.loading = false;
            }
            if (st.lines && st.lines.length) st.all = true;
            paint();
          },
        }));
        paint();
        return root;
      },

      // The person's own texts on their way to the client, at the end of the chat (outboxNode).
      paintOutbox(host) {
        if (!host) return;
        outboxHost = host;
        host.__profiChat = self;
        // A chat of a folder: what Gennady sent and the database has not sent yet, and what it could not
        // send (until he sends it again or deletes it). A sent one stands in the chat as his message once the
        // database has it.
        if (folder) {
          const M = global.LexMessage;
          // A group: the line under the text names it — «Sending to the group <title> in Telegram…».
          const sendPlace = (s) => {
            const ch = s.channel ? placeName(s.channel) : '';
            if (!data || data.kind !== 'group') return ch;
            return `the group ${data.title || data.client || ''}`.trim() + (ch ? ` in ${ch}` : '');
          };
          // A stand account (not an account of the database) sends to nobody: its text says so.
          const sends = ((data && data.sends) || []).filter((s) => s && s.state !== 'sent' && s.state !== 'dropped');
          const items = sends.map((s) => {
            const root = make('div', 'lex-profi-msg is-sent lex-profi-outbox-item');
            const body = make('div', '', '');
            body.textContent = s.text || '';
            root.appendChild(M.bubble({ side: 'out', body }));
            // Not sent (17.11.2026): the common part, the same as under a word to Lex in the main chat. It
            // stands until the person sends it again (Retry — the same words anew, then the failed one goes
            // from the chat) or deletes it (folder_send_drop); before, it went ten minutes after the failure.
            if (s.state === 'failed' && M.unsent) {
              root.classList.add('lex-unsent');
              const drop = async () => {
                try { await deps.rpc('folder_send_drop', { p_id: s.id }); } catch (e) {
                  if (deps.notify) deps.notify('Not done. ' + ((e && e.message) || ''));
                  return false;
                }
                deps.reload();
                return true;
              };
              let part = null;
              part = M.unsent({
                note: [sendPlace(s) ? `to ${sendPlace(s)}` : '', s.error || ''].filter(Boolean).join(' · '),
                onRetry: typeof deps.sendText === 'function' ? async () => {
                  part.update({ sending: true });
                  const ok = await deps.sendText(s.text || '', s.quoteUid || null, { again: true });
                  if (!ok) { part.update({ sending: false }); return; }
                  await drop();
                } : null,
                onEdit: deps.putBack ? async () => {
                  if (!deps.putBack(s.text || '')) return;
                  await drop();
                } : null,
                onDelete: () => { drop(); },
              });
              root.appendChild(part);
              return root;
            }
            const note = make('div', 'lex-profi-box-note');
            note.setAttribute('role', 'status');
            note.textContent = s.state === 'failed'
              ? `Not sent. ${s.error || ''}`.trim()
              : s.state === 'stand' ? 'A stand account: this text goes to nobody.'
              : `${sendPlace(s) ? `Sending to ${sendPlace(s)}` : 'Sending'}${s.test ? ' (test chat)' : ''}…`;
            root.appendChild(note);
            return root;
          });
          // The word to Lex of the branch «who is this» the press put here, until the chat draws it.
          if (whoisWord) items.push(self.whoisWordItem());
          // A task chat of an agent that works (board AgChat): the last line of the feed is the live stage (В7.63).
          else if (agent() && agentWorks(data) && global.LexSection) {
            const live = make('div', 'wc-turn lex-profi-msg lex-agent-stage');
            live.appendChild(global.LexSection.liveStage({ stage: data.agent.stage || null }));
            items.push(live);
          } else if (agent() && data.agent && data.agent.state === 'closed' && M && M.notice) {
            // A closed task chat ends with the plate «Closed · HH:MM» (board AgChatWaiting, В7.3), as on the iPhone
            // (FolderOutboxView): the mirror keeps no time of the closing, so the time is the last message's — the agent
            // closes a chat with its last word. A word of Gennady after it opens the chat again (the state moves).
            let last = '';
            drawn.forEach((t) => {
              const at = t && t.authoredAt;
              if (at && (!last || Date.parse(at) > Date.parse(last))) last = at;
            });
            const plate = make('div', 'wc-turn lex-profi-msg lex-agent-closed');
            plate.appendChild(M.notice({ text: 'Closed', at: last || null }));
            items.push(plate);
          }
          host.replaceChildren(...items);
          host.hidden = !items.length;
          return;
        }
        const wins = ((data && data.windows) || []).filter((w) => w.outbox);
        const nodes = wins.map((w) => outboxNode(w, boxDeps()));
        // The bot's short message while Gennady is busy (busyNode) comes last: it is the newest.
        const busy = data && data.busy && typeof data.busy === 'object' ? data.busy : null;
        if (busy) {
          nodes.push(busyNode(busy, { rpc: deps.rpc, order: deps.order, refresh: deps.reload,
            // The box Edit made is a model's box: the clean view would hide it, so the chat shows the discussion.
            edited: () => self.setClean(false) }));
        }
        host.replaceChildren(...nodes);
        host.hidden = !nodes.length;
      },

      // Does the field of this chat take text (LexComposerBox.hint, .locked). An order chat, the chat of a person
      // and the chat of a group in a folder do (a tap goes to Lex, a hold to the client, the person or the group —
      // the rule of sendMenu below). A chat in no folder does not.
      addressee() {
        // A task chat of an agent: no Send to a person (the server says send: false), but the field is open — its words
        // go to the agent (wc-app.js sendToAgent). A group in a folder takes text too (2026-11-21): its words go to the
        // model, only the send into it may be closed.
        if (folder && data && !data.send && data.kind !== 'agent' && !(data.kind === 'group' && data.folder)) {
          return { to: data.kind === 'group' ? 'group' : 'closed' };
        }
        return { to: 'order' };
      },

      // Holding the arrow of the field (wc-composer.js): the text to the client at once, without
      // the model, or at a time. Both go to the server as the person's own box (profi_send_text);
      // where it goes is the server's rule, the same as for Send of a box. run → true once the
      // server took the text (the field is cleared then). The composer draws it with
      // LexSendLater.menu: a grey line on top, the mark of the place by the first item.
      // The address of a chat the agent «Кто это» attached without a «yes» (В7.54, the mark `whois.attached` of the chat):
      // while it stands, the menu of the arrow names where the text goes — «Telegram @ник» — not only the messenger.
      attachedAddress(place) {
        const list = data && data.whois && Array.isArray(data.whois.attached) ? data.whois.attached : [];
        const name = place ? String(placeName(place) || '').toLowerCase() : '';
        const hit = list.find((a) => a && a.address && (a.channel ? a.channel === place
          : name && String(a.address).toLowerCase().startsWith(name)));
        return hit ? String(hit.address) : '';
      },

      sendMenu(text, opts) {
        if (!data || !data.chatKey || !String(text || '').trim()) return null;
        // The line of a reply over the field (В7.26): the text goes as the answer to that message, and
        // the line leaves with it. Without a line the call is as it was. opts.plain — the text of a message
        // already in the chat (sendNow): the line over the field is not its business, no quote.
        const quoteUid = !(opts && opts.plain) && typeof deps.replyQuote === 'function' ? deps.replyQuote() : null;
        // A word in the branch «who is this» goes to the model of that question and nowhere else: no way to send it
        // to the person (the line «Reply to Lex» is over the field).
        if (quoteUid && WHOIS_UID.test(quoteUid)) return null;
        // A chat of a folder: the text goes to the person now, without the assistant, where he wrote last, or to
        // the messenger of the message it answers; no time to pick (the queue of the database sends at once). A
        // group the database does not send to — none. A group it sends to: the head and the item name the group,
        // every member of it reads the text.
        if (folder) {
          // A group Lex does not send into keeps the menu: its item answers why (sendText refuses, 2026-11-21).
          if (typeof deps.sendText !== 'function' || (!data.send && data.kind !== 'group')) return null;
          const where = (quoteUid && data.channels && data.channels[quoteUid]) || data.replyTo || null;
          const sign = where && global.LexMessage ? global.LexMessage.channel(where) : null;
          if (data.kind === 'group') {
            return {
              group: true,
              head: `To the group ${data.title || data.client || ''}`.trim() + ': everyone in it will read this',
              items: [{ label: `Send to the ${where ? placeName(where) + ' ' : ''}group now`, icon: sign || 'send', run: () => deps.sendText(text, quoteUid) }],
            };
          }
          const at = self.attachedAddress(where);
          return {
            head: `To ${data.client || data.title || 'the person'}, without Lex`,
            items: [{ label: `Send to ${at || (where ? placeName(where) : 'the person')} now`, icon: sign || 'send', run: () => deps.sendText(text, quoteUid) }],
          };
        }
        const send = async (at) => {
          const r = await deps.rpc('profi_send_text', {
            p_op_id: newOpId(), p_order: deps.order, p_text: text, p_at: at ? at.toISOString() : null,
            ...(quoteUid ? { p_quote_uid: quoteUid } : {}),
          });
          deps.reload();
          if (r && quoteUid && typeof deps.replyDone === 'function') deps.replyDone();
          return !!r;
        };
        // A reply goes to the channel of the message it answers (profi_message_looks.sql); without a line of
        // a reply — where the client wrote last.
        const place = quoteUid ? ((data.channels && data.channels[quoteUid]) || 'profi') : (data.replyTo || null);
        const mark = global.LexMessage && global.LexMessage.channel(place || 'profi');
        return {
          head: `To ${data.client || 'the client'}, without Lex`,
          items: [
            { label: `Send to ${self.attachedAddress(place) || placeName(place)} now`, icon: mark || 'send', run: () => send(null) },
            {
              label: 'Schedule…',
              icon: 'clock',
              run: async () => {
                const at = await global.LexSendLater.pick({ text, client: data.client });
                return at ? send(at) : false;
              },
            },
          ],
        };
      },

      // «Send now» in the menu of one's own word to Lex (19.11.2026): the text of that message goes to the client
      // or the person as it stands, at once, without the model — the first item of sendMenu, with no quote. null
      // — this chat sends to nobody (a group, a chat in no folder) or the message has no words.
      sendNow(text) {
        const menu = self.sendMenu(text, { plain: true });
        return menu && menu.items && menu.items[0] ? menu.items[0] : null;
      },

      // «Edit» of a message that went to a person (19.11.2026): Gennady's own text, by a channel of EDIT_CHANNELS, in the
      // window of that channel, not a photo, a voice message, a file or a sticker, not deleted, in a chat that has the
      // person behind it. The chat draws the menu from this each time it opens (the window closes while the chat stands).
      canEditSent(t) {
        if (!data || typeof deps.edit !== 'function' || typeof deps.editText !== 'function') return false;
        const uid = String((t && t.uid) || '');
        const channel = editChannelOf(uid);
        if (!channel || !channel.personal(uid)) return false;
        if (t.origin !== 'profi_sent' && t.origin !== 'folder_out') return false;
        if (folder && !data.send) return false;
        const look = lookOf(uid);
        if (look.deletedAt || look.sticker) return false;
        if (storedFilesOf(t.attachments).length || photosOf(t.attachments).length) return false;
        const sentAt = Date.parse(t.authoredAt || '');
        if (!Number.isFinite(sentAt) || (channel.windowMs !== null && Date.now() - sentAt >= channel.windowMs)) return false;
        return !!wordsOf(t).trim();
      },

      // Edit begins: the words of the message go into the field and the line over it says what is being edited; the
      // arrow of the field edits the message at the person (deps.edit → the page, wc-app.js).
      editSent(t) {
        const uid = String((t && t.uid) || '');
        if (!uid || typeof deps.edit !== 'function') return;
        deps.edit({ uid, head: 'Edit message', text: wordsOf(t) });
      },

      // The edit goes to the server (the edge function message-edit): → { state: 'edited' | 'waiting' | 'stand' }; the
      // words of a refusal («too late», «not a text») are the error.
      editText(uid, text) {
        if (typeof deps.editText !== 'function') return Promise.reject(new Error('This chat does not edit messages.'));
        return deps.editText(uid, text);
      },

      // The reaction on a message at a person (24.11.2026): a channel of REACT_CHANNELS, a message of the person or Gennady's
      // own that has gone, not deleted (a sticker may be reacted to), in a chat that has the person behind it. Not in a
      // group, not on Profi.ru, not on a message that has not gone yet (it has no uid of a messenger).
      canReact(t) {
        if (!data || typeof deps.react !== 'function') return false;
        const uid = String((t && t.uid) || '');
        const channel = reactChannelOf(uid);
        if (!channel || !channel.personal(uid)) return false;
        if (!['profi_sent', 'folder_out', 'profi_client', 'folder_in'].includes(t.origin)) return false;
        if (folder && !data.send) return false;
        return !lookOf(uid).deletedAt;
      },

      // What the bar of reactions in the menu needs (LexMessage.reactBar): the channel, the emoji I have put on this message
      // (the screen's, with the one the press has just put) and what a press does.
      reactSpec(t) {
        const uid = String((t && t.uid) || '');
        const channel = reactChannelOf(uid);
        const mine = (lookOf(uid).reactions || []).find((r) => r && r.who === 'me');
        return { channel: channel ? channel.name : '', mine: mine ? mine.emoji : null, pick: (emoji) => self.react(uid, emoji) };
      },

      // A press on an emoji of the bar (or on my pill): the message shows it at once, the server sends it (the edge
      // function message-react); '' takes it off. The server says { status: 'reacted' | 'removed' | 'waiting' | 'stand' }:
      // the first three keep the mark until the reading brings the reaction (waiting — the pill stands with its mark), a
      // stand sent nothing. A refusal (422, 502) puts the screen back and says why.
      react(uid, emoji) {
        if (!uid || typeof deps.react !== 'function') return Promise.resolve(null);
        const had = reactMine.get(uid);
        const back = () => {
          if (reactMine.get(uid) !== mark) return;
          if (had) reactMine.set(uid, had); else reactMine.delete(uid);
          redraw(uid);
        };
        const mark = { emoji: emoji || null, at: new Date().toISOString() };
        reactMine.set(uid, mark);
        redraw(uid);
        return Promise.resolve(deps.react(uid, emoji || '')).then((out) => {
          if (out && out.status === 'stand') { back(); if (deps.notify) deps.notify('This is a stand: nothing was reacted.'); return out; }
          if (typeof self.reload === 'function') self.reload();
          return out;
        }, (err) => {
          back();
          if (deps.notify) deps.notify('Not reacted. ' + ((err && err.message) || ''));
          return null;
        });
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
        // A message whose look the fresh reading says otherwise — a reaction, an edit, a deletion, the
        // client read it — is drawn again in its place (the ticks turn blue so too).
        lane = thread;
        for (const n of thread.querySelectorAll(':scope > .lex-profi-msg[data-uid]')) {
          const t = drawn.get(n.dataset.uid);
          if (!t) continue;
          if (n.dataset.look !== sigOf(n.dataset.uid)) n.replaceWith(self.messageNode(t));
        }
        // The word of the agent «Кто это» that waits for Gennady puts the line «Reply to Lex» over the field (В7.54).
        self.whoisArm();
      },

      // The bar over the chat: the client's photo or letter (В7.12), name and channel, and on the right the
      // button of the clean view (2026-11-14): pressed, only the conversation with the client
      // stays on the screen — the card of the order, the client's messages, what went to him and
      // the notices of Profi. The order on the site of Profi is the title of the card now.
      bar() {
        const M = global.LexMessage;
        const person = make('div', 'lex-profi-person', '');
        // The button of the clean view: pressed, the discussion with Lex up to the last message that went is
        // off the screen (the server says which, hiddenDiscussion).
        const cleanButton = () => {
          const link = make('button', 'wc-icon-btn lex-profi-clean', '');
          link.type = 'button';
          const paint = () => {
            link.classList.toggle('is-on', clean);
            link.setAttribute('aria-pressed', clean ? 'true' : 'false');
            link.title = clean ? 'Show the discussion with Lex' : 'Hide the discussion with Lex';
            link.setAttribute('aria-label', link.title);
            const paths = [['path', { d: 'M11 3l1.9 5.1L18 10l-5.1 1.9L11 17l-1.9-5.1L4 10l5.1-1.9z' }],
              ['path', { d: 'M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8z' }]];
            if (clean) paths.push(['path', { d: 'M3 3l18 18' }]);
            link.replaceChildren(strokeIcon(paths, 20));
          };
          paint();
          link.addEventListener('click', () => { self.setClean(!clean); paint(); });
          return link;
        };
        // A chat of a folder: the person (his photo, folder_photos.sql) or the group, and the messenger he
        // wrote by last (a group: its own); the clean view (the talk with the assistant) for both; no card yet
        // (it opens from an order chat).
        // A task chat of an agent (board AgChat, 22.11.2026): the face of the agent 40 (В7.56), the title of the chat, under it
        // «<the agent> · Working | Waiting for you | Closed» («Waiting for you» in yellow); a press opens the passport of
        // the agent (deps.agentPassport); no clean view.
        if (folder && agent() && global.LexSection && global.LexSection.agentFace) {
          const ag = (data && data.agent) || {};
          const name = (data && (data.title || data.client)) || 'Chat';
          const STATE = { waiting: 'Waiting for you', working: 'Working', closed: 'Closed' };
          const words = make('div', 'lex-profi-person-words', '');
          const line = make('div', 'lex-profi-person-channel', '');
          line.appendChild(document.createTextNode(ag.name || ag.key || ''));
          const st = data && data.chatKey ? STATE[ag.state] || STATE.working : '';
          if (st) line.append(' · ', make('span', ag.state === 'waiting' ? 'lex-profi-agent-wait' : '', st));
          words.append(make('div', 'lex-profi-person-name', name), line);
          person.append(global.LexSection.agentFace(ag.key || '', { size: 40 }), words);
          const open = ag.key && typeof deps.agentPassport === 'function' ? () => deps.agentPassport(ag.key) : null;
          return { person, link: null, open, who: ag.name || name, brief: null };
        }
        if (folder) {
          const name = (data && (data.client || data.title)) || 'Chat';
          const where = data && data.replyTo && M.CHANNELS[data.replyTo] ? M.CHANNELS[data.replyTo].name : '';
          const line = agent() ? ((data.agent && data.agent.name) || '')
            : data && data.kind === 'group' ? (where ? `Group · ${where}` : 'Group') : where;
          const words = make('div', 'lex-profi-person-words', '');
          words.append(make('div', 'lex-profi-person-name', name), make('div', 'lex-profi-person-channel', line));
          person.append(M.avatar(name, { photo: data && data.photo, io: fileIo }), words);
          // «Who is this» (В7.52): the words the entry of the database brought (folder_open `brief`); no card to
          // open from a chat of a folder yet, so the line is not pressed.
          return { person, link: data && (data.kind === 'person' || data.kind === 'group') ? cleanButton() : null, open: null, who: name,
            brief: M.brief(data && data.brief) };
        }
        const who = (data && data.client) || 'Client';
        const words = make('div', 'lex-profi-person-words', '');
        words.append(make('div', 'lex-profi-person-name', who), make('div', 'lex-profi-person-channel', M.CHANNELS[CHANNEL].name));
        person.append(M.avatar(who, { photo: data && data.photo, io: fileIo }), words);
        // The photo and the name are one button of the window: it opens the card of the person
        // (lex-person.js, В7.41). null — the window gives no door of the card.
        const open = global.LexPerson && deps.person && data && data.chatKey
          ? () => global.LexPerson.open({ chatKey: data.chatKey, name: who, call: deps.person,
            onGone: deps.onPersonGone, io: fileIo })
          : null;
        // «Who is this» (В7.52): the words kept on the order (profi_open `brief`); a press opens the card, as the name.
        return { person, link: cleanButton(), open, who, brief: M.brief(data && data.brief, { onOpen: open }) };
      },

      // «Who is this» of an order chat comes with the card of the person (the server asks the database and keeps
      // the words on the order, chat_brief.sql): the chat asks the card once it is open, and when the words are
      // not the ones on the screen, reads the order again — they come with it and the device keeps them
      // (profi_item, lex-reads.js), so the next opening has them at once. A chat of a folder gets its words
      // with its entry. A card that did not come changes nothing.
      async askBrief() {
        if (folder || !deps.person || !data || !data.chatKey) return;
        const key = data.chatKey;
        let card = null;
        try {
          card = (await deps.person({ op: 'card', chatKey: key })).card;
        } catch (e) {
          console.warn('[profi] who is this:', e && e.message);
          return;
        }
        if (!card || !data || data.chatKey !== key) return;
        const words = (card.brief && card.brief.text) || null;
        if (words !== (data.brief || null) && deps.reload) deps.reload();
      },

      // The clean view: only the screen, the model reads the whole chat and the server is not
      // told. A new opening of a chat makes a new object, so it starts with it on again.
      get clean() { return clean; },
      setClean(on) {
        clean = !!on;
        if (deps.onClean) deps.onClean(clean);
      },
    };
    return self;
  }

  // ── the section ─────────────────────────────────────────────────────────────
  function createSection(deps) {
    // What a screen of the section shows is read the window's way (lex-reads.js): the copy first.
    // A window that gives no such way reads the server alone.
    const readKept = deps.read || ((name, args, show) => deps.rpc(name, args).then((v) => { show(v, true, false); return v; }));
    const frame = global.LexSection.createFrame({
      title: 'Clients',
      cls: 'lex-profi',
      back: deps.back,
      root: deps.root,
      signals: deps.signals,
      events: ['profi'],
      check: (signal) => poll(signal),
      onBack: () => { syncHead(); return paint(); },
    });
    const { say } = frame;
    // A reading of a screen that failed says nothing on it (Gennady, 20.11.2026): what the screen has stays, and the
    // bot's alert tells what is broken. Only a press that did not go says so on the line.
    const quiet = (where) => (e) => { console.warn(`[profi] ${where}:`, e && e.message); };

    let rev = null;
    let ticker = null;
    // What the monitor says of itself (profi_home): the status for the settings, the title of New orders, the clients of
    // the order chats for the Mac app. The chats in it are the main page's business (people_home), not drawn here.
    let home = null;
    let feedEls = new Map();
    let clockOffset = 0;
    let report = null;

    function go(id, title) {
      frame.push({ id, title });
      syncHead();
      paint();
    }

    async function command(kind, order, args) {
      const r = await deps.rpc('profi_command', { p_op_id: newOpId(), p_kind: kind, p_order: order || null, p_args: args || {} });
      return r;
    }

    // The answer of a command comes with the signal «profi_cmd»: one look at once, in case it
    // came before the signal was followed, then a look at every signal of this command and
    // after the channel opens again. waitS (twenty seconds by default) without an answer — one
    // last look, since the channel may have been down, and then the monitor is away.
    function waitResult(id, waitS = COMMAND_WAIT_S) {
      return new Promise((resolve) => {
        let over = false;
        let follower = null;
        const finish = (v) => {
          if (over) return;
          over = true;
          clearTimeout(timer);
          if (follower) follower.stop();
          resolve(v);
        };
        const timer = setTimeout(async () => {
          try {
            const r = await deps.rpc('profi_command_result', { p_id: id });
            if (r && r.done) { finish(r.result || {}); return; }
          } catch (_) { /* the answer below */ }
          finish({ ok: false, error: 'The monitor did not answer. Is the working Mac awake?' });
        }, waitS * 1000);
        const look = async (signal) => {
          if (over || (signal && signal.payload && String(signal.payload.id) !== String(id))) return;
          const r = await deps.rpc('profi_command_result', { p_id: id });
          if (r && r.done) finish(r.result || {});
        };
        if (deps.signals) follower = deps.signals.follow(['profi_cmd'], look);
        if (follower) follower.now(); else look(null).catch(() => {});
      });
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
    // the photo too: a new photo of the client is read again for the bar over the chat
    const stampOf = (c) => [c.at, c.last, c.tick, c.unread, c.closed, c.photo || ''].join('|');
    const keepOf = (order) => (item) => held.put(order, remember(order, item));

    // opts.showLex — the chat opens with the discussion shown: the notification of a draft after a call brings the
    // person to that draft (В7.42), which the clean view would hide.
    // opts.from — where the press came from: the tabs of the people open the chat with no way back to this
    // section's list (wc-app.js, the arrow stays out). fail(text) — where a failure is told then (the status line of
    // the section is not on the screen).
    const openOrder = (order, opts, fail) => frame.open(
      (wanted) => deps.openOrder(order, wanted, held.get(order), keepOf(order), opts), 'The chat did not open.', fail);

    // A press on an order outside the feed. While its reply still waits there (Cancel or
    // Send), the order opens in the feed, the way Telegram shows it: opening a chat for it
    // would stop the sending (Reply yourself), and a look at an order stops nothing. The line
    // of the main page says so (feed); the section's last reading of its chats (profi_home)
    // says it for an order the page has no line for, and the feed itself for one that has no
    // line there. opts.fresh — a notification: only the feed itself is asked, what the section
    // read a while ago may be old. A failed read counts as waiting, so that a bad network never
    // stops a reply either. The feed is a screen of this section: while the section is on the
    // screen it is pushed in place, otherwise the window shows the section on it (deps.showFeed).
    let focusOrder = null;
    async function openOrderOrFeed(order, opts, fail) {
      const line = opts && opts.fresh ? null : ((home && home.chats) || []).find((c) => c.order === order);
      let waits = true;
      if (line && typeof line.feed === 'boolean') waits = line.feed;
      else {
        try {
          const r = await deps.rpc('profi_feed', { p_limit: 60 });
          const it = (r.items || []).find((x) => x.order === order);
          waits = !!it && (it.actions || []).some((a) => a === 'cancel' || a === 'send');
        } catch (_) { waits = true; }
      }
      if (!waits) { openOrder(order, opts, fail); return; }
      if (!frame.isShown() && typeof deps.showFeed === 'function') { await deps.showFeed(order); return; }
      focusOrder = order;
      if (frame.screen === 'feed') await paintFeed();
      else go('feed', feedTitle());
    }
    const feedTitle = () => (home && home.feed && home.feed.title) || 'New orders';

    // The menu of a chat (lex-chat-menu.js, В7.33): Pin or Unpin, Mark as read or unread, Delete
    // chat. The server decides what the press means for the list (chat_states.sql); the list is read
    // anew at once, and every other window reads it by the signal of the change.
    const DELETE_TEXT = 'It disappears from Lex. Nothing changes on Profi.ru or in the messengers. '
      + 'A new message of the client brings it back.';
    async function chatAct(c, act, o) {
      try {
        // The mark is not a line of the list: the numbers of the unread carry it, and the signal «unread»
        // brings them to every device (important_chats.sql).
        if (act === 'important' || act === 'unimportant') global.LexSection.markImportant(c.chatKey, act === 'important');
        await deps.rpc('chat_act', { p_op_id: newOpId(), p_chat_key: c.chatKey, p_act: act });
      } catch (e) {
        if (act === 'important' || act === 'unimportant') global.LexSection.markImportant(c.chatKey, act !== 'important');
        const text = (e && e.message) || 'It did not work.';
        if (o && o.fail) o.fail(text); else say(text, true);
        return;
      }
      if (act === 'important' || act === 'unimportant') return;
      if (o && o.after) o.after();
    }

    // A line of a chat (В7.34): the photo or the letter of the client 48 (В7.12), the name and the
    // order, the time, the pin of a pinned one; the last message, «Bot:» before the bot's; the tick of
    // Profi when Gennady or the bot wrote last.
    // o — the main page of the people draws the line (lex-people.js): { from, fail, after, feed(order) }. A reply that
    // waits in the feed opens the feed, and the feed is a screen of this section: feed() shows it.
    function chatLine(c, o) {
      const line = global.LexSection.row({
        lead: global.LexMessage.avatar(c.client || c.title, { photo: c.photo, io: fileIo, size: 48 }),
        title: c.title, sub: plainLinks(c.last || ''), dot: c.unread,
        onClick: () => (o && o.feed && c.feed ? o.feed(c.order)
          : openOrderOrFeed(c.order, o && o.from ? { from: o.from } : undefined, o && o.fail)),
        end: c.tick ? tickNode(c.tick === 'read') : null,
        time: global.LexSection.listTime(c.at), pinned: !!c.pinned, bot: c.by === 'bot', muted: !!c.muted,
        unread: { order: c.order, number: true },
        // the agent «Кто это» attached the client's messenger (В7.54): «Lex: <its headline>» in place of the last message
        lex: c.whois && c.whois.wait ? c.whois.wait : null,
        // The draft of the order chat, while it has one: «Draft: …» in place of the last message.
        draft: c.chatKey && !c.feed ? c.chatKey : null,
      });
      if (c.chatKey && global.LexChatMenu) {
        const act = (name) => chatAct(c, name, o);
        global.LexChatMenu.attach(line, () => ({
          title: c.title, pinned: !!c.pinned, unread: !!c.unread, act,
          // Archive or Unarchive: the server's word of the line (chat_archive.sql); a server without it — no item
          archived: typeof c.archived === 'boolean' ? c.archived : undefined,
          // Open in new window (В7.79): the order chat itself, also when a reply waits for it in New orders.
          window: c.order ? { kind: 'profi_message', chatKey: c.chatKey, order: String(c.order) } : null,
          important: global.LexSection.isImportant(c.chatKey),
          remove: () => global.LexChatMenu.remove({ confirm: deps.confirm, text: DELETE_TEXT, act }),
        }));
      }
      // A reply that waits in the feed opens the feed, not the chat: nothing to read ahead.
      if (!c.feed) held.watch(line, c.order, stampOf(c));
      return line;
    }

    // ── new orders ───────────────────────────────────────────────────────────
    // Cancel answers the press at once (2026-11-14, Gennady: the button stood as it was while the
    // monitor worked). The order shows «Cancelling…» with its buttons grey; the monitor's answer
    // brings what the order shows after — its own view of the order, the same the next copy of the
    // order will say; the server's copy takes over as soon as it moved on from the countdown. Before,
    // the screen waited for that copy: 1.4–3.1 s after the press, while the sending was off in 0.4 s.
    // «Cancelled» stands only by the monitor's word: a reply already gone is said so. A cancelled order
    // then folds as every done one (В7.29).
    const cancels = new Map();   // order → { at, view: the monitor's view of the order or null }

    function shown(it) {
      const c = cancels.get(it.order);
      if (!c) return it;
      if ((it.state !== 'countdown' && it.state !== 'sending') || Date.now() - c.at > CANCEL_HOLD_S * 1000) {
        cancels.delete(it.order);
        return it;
      }
      if (!c.view) return Object.assign({}, it, { state: 'cancelling', stateLine: null, busy: true });
      return Object.assign({}, it, { state: c.view.state, stateLine: c.view.state_line || null,
        actions: c.view.actions || [], sendAt: c.view.send_at || null });
    }

    async function cancelOrder(order) {
      cancels.set(order, { at: Date.now(), view: null });
      say('');   // a line left by an earlier press is not about this one
      repaintOrder(order);
      let res;
      try {
        const r = await command('cancel', order, { pressed_at: Date.now() / 1000 });
        res = await waitResult(r.id, CANCEL_WAIT_S);
      } catch (err) {
        res = { ok: false, error: (err && err.message) || 'The command did not go.' };
      }
      const c = cancels.get(order);
      if (!c) return;   // the server's copy of the order came first and said it all
      const view = res.ok ? res.order : null;
      if (view && view.state !== 'countdown' && view.state !== 'sending') c.view = view;
      else if (!res.ok) {
        cancels.delete(order);
        if (res.state === 'pozdno') say('Too late: the reply had already gone.', true);
        else if (res.state !== 'net') say(res.error || 'It did not cancel.', true);
      }
      // An answer with nothing to show yet (a sending being cut off, a monitor without the view):
      // «Cancelling…» stays until the server's copy of the order moves on.
      repaintOrder(order);
    }

    // Every order one message (В7.29, the design Gennady chose on 14.11.2026): what waits for a
    // decision stands whole with its buttons; what is done (sent, cancelled, stopped) stands folded in
    // three lines and opens in place. The words of the states and the buttons are the monitor's word
    // on the server; this draws them.
    const DONE = new Set(['sent', 'cancelled', 'stopped']);
    // Done orders opened by a press on their three lines, and the order the screen was opened at.
    const opened = new Set();
    // Reply yourself pressed: the order folds at once, «Stopped: you reply yourself.», until the
    // server says anything else of it than it said at the press (the monitor took the command, or the
    // reply had gone already). order → the server's word at the press.
    const replied = new Map();
    // How long a countdown runs, when the server does not say when it began (a server before
    // countdown_at): the seconds left when the screen first saw it.
    const spans = new Map();
    const wordOf = (it) => `${it.state}|${(it.actions || []).join(',')}`;
    function stateOf(it) {
      const at = replied.get(it.order);
      if (at === undefined) return it.state;
      if (at === wordOf(it)) return 'stopped';
      replied.delete(it.order);
      return it.state;
    }

    // What stands on the right above the reply: the price before the reply leaves, how it ended after.
    function stateWords(it, state) {
      const line = it.stateLine ? ` ${it.stateLine}` : '';
      switch (state) {
        case 'countdown':
        case 'ready': {
          const price = priceLine(it.price);
          const words = [price ? `Price: ${price}` : '', state === 'ready' ? it.stateLine || '' : ''].filter(Boolean);
          return { text: words.join(' · ') };
        }
        case 'sending': return { text: 'Sending now…' };
        case 'cancelling': return { text: 'Cancelling…' };
        case 'queued': return { text: 'In the queue.' };
        case 'sent': return { text: it.paid ? `Sent. Paid ${Math.round(it.paid)} ₽.` : 'Sent.', icon: 'tick' };
        case 'cancelled': return { text: 'Cancelled: nothing went.', icon: 'cross' };
        case 'stopped': return { text: 'Stopped: you reply yourself.', icon: 'reply' };
        case 'failed': return { text: `Not sent.${line}`, danger: true };
        case 'unknown': return { text: `The site did not confirm it. Look at the order on Profi.${line}`, danger: true };
        default: return { text: it.stateLine || '' };
      }
    }

    // The seconds left and the share of the countdown left, on the server's clock.
    function countdownOf(it) {
      const left = Math.max(0, (it.sendAt || 0) - (Date.now() / 1000 + clockOffset));
      let span = it.countdownAt && it.sendAt ? it.sendAt - it.countdownAt : 0;
      if (!(span > 0)) {
        if (!spans.has(it.order)) spans.set(it.order, left);
        span = spans.get(it.order);
      }
      return { left, share: span > 0 ? left / span : 0 };
    }

    function orderNode(it) {
      const M = global.LexMessage;
      // While its Cancel is under way: «Cancelling…» with the buttons grey, then the monitor's view.
      it = shown(it);
      const state = stateOf(it);
      const actions = state === it.state ? (it.actions || []) : [];
      const hasChat = it.hasChat || state !== it.state;
      const done = DONE.has(state);
      const base = { order: it.order, title: it.title, url: it.orderUrl, at: it.at, client: it.client, budget: it.budget,
        pay: it.pay, state: stateWords(it, state) };
      if (done && !opened.has(it.order)) {
        return { node: M.order({ ...base, folded: true, onOpen: () => { opened.add(it.order); repaintOrder(it.order); } }) };
      }
      let cd = null;
      const foot = make('div', 'lex-profi-box-foot');
      const act = (label, cls, fn) => {
        const b = button(`lex-profi-btn${cls ? ` ${cls}` : ''}`, label, async (e) => {
          e.currentTarget.disabled = true;
          try { await fn(); } catch (err) { say((err && err.message) || 'The command did not go.', true); }
        });
        if (it.busy) b.disabled = true;
        foot.appendChild(b);
        return b;
      };
      for (const a of actions) {
        if (a === 'cancel') {
          const b = act('Cancel', 'is-danger', () => cancelOrder(it.order));
          if (state === 'countdown') cd = M.countdown(b);
        }
        if (a === 'send') act('Send', 'is-main', () => command('send_draft', it.order));
        if (a === 'reply_self') act('Reply yourself', '', () => replySelf(it));
      }
      if (hasChat && !actions.includes('reply_self')) foot.appendChild(button('lex-profi-btn', 'Open chat', () => openOrder(it.order)));
      // The band in Russian with the monitor's reason right under it (Gennady, 18.11.2026); a monitor
      // that gave no reason — what to do.
      const ask = it.uncertain && !done && actions.length && !it.busy ? {
        title: 'Не уверен, что заказ подходит',
        text: it.why || (state === 'countdown' ? 'Отмени, если заказ не подходит.' : 'Отклик не отправлен: отправь или ответь сам.'),
      } : null;
      const node = M.order({ ...base, text: it.description, reply: it.draft, ask,
        foot: foot.childElementCount ? foot : null,
        onFold: done ? () => { opened.delete(it.order); repaintOrder(it.order); } : null });
      if (cd) {
        const c = countdownOf(it);
        cd.set(c.left, c.share);
      }
      return { node, cd };
    }

    // One order drawn again in its place: opened, folded, pressed.
    function repaintOrder(order) {
      const el = feedEls.get(order);
      if (!el || !el.n.isConnected) return;
      const { node, cd } = orderNode(el.it);
      node.dataset.at = el.it.at || '';
      el.n.replaceWith(node);
      feedEls.set(order, { it: el.it, n: node, cd });
    }

    // Reply yourself: the reply stops, the chat of the order is made with the bot's draft in it, and
    // it opens (Gennady, 14.11.2026). The order folds in the same frame; the chat comes with the one
    // answer of the server (profi_command gives the chat, `item`; a server before that — one more
    // reading, profi_item).
    function replySelf(it) {
      replied.set(it.order, wordOf(it));
      opened.delete(it.order);
      repaintOrder(it.order);
      const going = command('reply_self', it.order, { pressed_at: Date.now() / 1000 });
      frame.open(async (wanted) => {
        let r;
        try {
          r = await going;
        } catch (e) {
          replied.delete(it.order);
          repaintOrder(it.order);
          throw e;
        }
        const item = r && r.item;
        if (item && item.chatKey && item.chat) held.put(it.order, remember(it.order, item));
        if (!wanted()) return;
        await deps.openOrder(it.order, wanted, held.get(it.order), keepOf(it.order), { replySelf: true });
      }, 'The chat did not open.');
    }

    function feedAtEnd(body) {
      return body.scrollTop + body.clientHeight >= body.scrollHeight - 80;
    }

    // The feed as it was read the last time: drawn at once when the feed opens, the server's
    // answer comes after and takes its place.
    let lastFeed = null;
    async function paintFeed() {
      if (frame.screen !== 'feed') return;
      // A feed screen just opened is empty: what this window read the last time goes on it at
      // once; with nothing read yet — the copy this device kept. The server's answer comes after.
      if (lastFeed && !frame.body.childElementCount) drawFeed(lastFeed, false);
      await readKept('profi_feed', { p_limit: 60 }, (r, fresh) => {
        if (!r) return;
        lastFeed = r;
        if (fresh || !frame.body.childElementCount) drawFeed(r, fresh);
      }, () => !lastFeed);
    }

    // fresh — the server's answer just now: the clock of the countdowns is taken from it, and the
    // order to bring into view is let go once the fresh feed is drawn. The orders stand in a lane of
    // messages (`lex-bubbles`), a plate with the day between two days (В7.14).
    function drawFeed(r, fresh) {
      const { body } = frame;
      if (frame.screen !== 'feed') return;
      const stick = !body.childElementCount || feedAtEnd(body);
      if (fresh) clockOffset = (r.now || Date.now() / 1000) - Date.now() / 1000;
      if (focusOrder) opened.add(focusOrder);
      feedEls = new Map();
      body.replaceChildren();
      const items = r.items || [];
      if (!items.length) { body.appendChild(make('div', 'lex-profi-empty', 'No orders yet.')); return; }
      const lane = make('div', 'lex-bubbles lex-profi-lane');
      for (const it of items) {
        const { node, cd } = orderNode(it);
        node.dataset.at = it.at || '';
        feedEls.set(it.order, { it, n: node, cd });
        lane.appendChild(node);
      }
      global.LexMessage.mark(lane);
      body.appendChild(lane);
      const focus = focusOrder && feedEls.get(focusOrder);
      if (focus || fresh) focusOrder = null;
      if (focus) focus.n.scrollIntoView({ block: 'center' });
      else if (stick) body.scrollTop = body.scrollHeight;
    }

    // The countdowns go on by themselves, between the server's words: the seconds on Cancel and the
    // ground under them.
    function tick() {
      if (frame.screen !== 'feed') return;
      for (const { it, cd } of feedEls.values()) {
        if (!cd) continue;
        const c = countdownOf(it);
        cd.set(c.left, c.share);
      }
    }

    // The head of New orders, as over an order chat (2026-11-14): the mark of Профи.ру, «New
    // orders», «Профи.ру» under it. The window shows it in its bar while the screen is on.
    function feedHead() {
      const M = global.LexMessage;
      const mark = M.channel('profi');
      mark.classList.add('lex-profi-mark');
      const words = make('div', 'lex-profi-person-words');
      words.append(make('div', 'lex-profi-person-name', feedTitle()),
        make('div', 'lex-profi-person-channel', M.CHANNELS.profi.name));
      return [mark, words];
    }
    function syncHead() {
      if (deps.head) deps.head(frame.isShown() && frame.screen === 'feed' ? feedHead() : null);
    }

    // ── the bot's service chat ───────────────────────────────────────────────
    // What the bot tells Gennady about itself — it stopped, a captcha, money is low, a Mac took over — in order, the
    // last at the bottom (profi_bot_chat.sql, 19.11.2026). Nothing is written here: the bot reads no answers, so
    // the screen has no field, as the chat of new orders has none. A message is a bubble of the other side with the
    // time under it; the day stands between two days (В7.14). The chat the person has open is read — the number of
    // its unread goes by itself (the page tells the server which screen is open, webchat/wc-app.js, presenceKey).
    let lastBot = null;
    async function paintBot() {
      if (frame.screen !== 'bot') return;
      if (lastBot && !frame.body.childElementCount) drawBot(lastBot);
      await readKept('profi_bot_chat', { p_limit: BOT_LIMIT }, (r) => {
        if (!r) return;
        lastBot = r;
        drawBot(r);
      }, () => !lastBot);
    }

    function drawBot(r) {
      const { body } = frame;
      if (frame.screen !== 'bot') return;
      // A chat opens on its end and a message that comes sets it there again; a reader who has scrolled up to the old lines
      // stays where they were.
      const stick = !body.childElementCount || feedAtEnd(body);
      const was = body.scrollTop;
      body.replaceChildren();
      const items = (r && r.messages) || [];
      if (!items.length) { body.appendChild(make('div', 'lex-profi-empty', 'The bot has not written yet.')); return; }
      const M = global.LexMessage;
      const lane = make('div', 'lex-bubbles lex-profi-lane');
      for (const m of items) {
        const node = M.bubble({ side: 'in', text: m.text || '', stamp: M.stamp({ at: m.at }) });
        node.dataset.at = m.at || '';
        lane.appendChild(node);
      }
      M.mark(lane);
      body.appendChild(lane);
      body.scrollTop = stick ? body.scrollHeight : was;
    }

    // ── settings: the rest of the bot's menu ─────────────────────────────────
    let kinds = null;
    let focusBlock = null;
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

      // Every kind of the group Profi.ru, one row with the menu of four positions: the same rows as Settings →
      // Notifications (LexSection.kindsList; the kinds come from the server). Painted once per visit, so that a
      // repaint of the screen does not read them again.
      const notes = block('Notifications');
      notes.dataset.block = 'notifications';
      if (!kinds) {
        kinds = global.LexSection.kindsList({
          rpc: deps.rpc, only: 'profi', menu: (anchor, items) => global.WcUI.menu(anchor, items),
          tell: (text, error) => say(text, error),
        });
        kinds.load();
      }
      notes.appendChild(kinds.node);

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
      if (focusBlock) {
        const b = body.querySelector(`[data-block="${focusBlock}"]`);
        focusBlock = null;
        if (b && b.scrollIntoView) b.scrollIntoView({ block: 'start' });
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

    // The screen the section stands on (never its first one: see `enter`).
    function paint() {
      const { screen } = frame;
      if (screen === 'feed') return paintFeed().catch(quiet('feed'));
      if (screen === 'bot') return paintBot().catch(quiet('bot'));
      if (screen === 'settings') paintSettings();
      else if (screen === 'report') return paintReport();
      return null;
    }

    // What the monitor says of itself and of the chats (profi_home): the copy this device kept while the section holds
    // nothing yet, then the server's answer. Only the answer carries the number of change that is the server's of now.
    async function reloadHome() {
      await readKept('profi_home', { p_groups: true }, (h, fresh) => {
        if (!h) return;
        home = h;
        // The clients of the order chats (the line's title is «client | order»), for whoever names buttons by them.
        if (fresh && typeof deps.clients === 'function') {
          const names = (Array.isArray(h.chats) ? h.chats : []).map((c) => {
            const parts = String((c && c.title) || '').split(' | ');
            return parts.length > 1 ? parts[0] : '';
          }).filter(Boolean);
          try { deps.clients(names); } catch (_) { /* a hook must not stop the screen */ }
        }
        if (fresh) rev = h.rev;
      }, () => !home);
    }

    // A change counts as seen only when it reached the screen and the open order chat: after
    // a failed read the frame tries again. An error goes up to the watch of the frame. The
    // signal carries the new number of the change, so no question about it goes first; a
    // look to catch up (no signal) asks the number. The list and the open order chat are
    // read at once, side by side: the two answers do not wait for each other.
    async function poll(signal) {
      const told = signal && signal.payload && signal.payload.rev != null ? Number(signal.payload.rev) : null;
      if (told != null && rev != null && told <= rev) return;
      const r = told != null ? told : await deps.rpc('profi_rev', {});
      if (r === rev) return;
      const seen = rev;
      try {
        const reads = [];
        if (frame.isShown()) {
          reads.push((async () => {
            await reloadHome();
            const { screen } = frame;
            if (screen === 'settings') paint();
            else if (screen === 'feed') await paintFeed();
            else if (screen === 'bot') await paintBot();
          })());
        }
        if (deps.onChange) reads.push(deps.onChange());
        await Promise.all(reads);
        rev = Math.max(r, rev || 0);
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
      // The section is on the screen, on the screen `enter` chose (or on the one it was left on).
      async show() {
        frame.enter();
        syncHead();
        // The signals are followed before the first reading: a change during it is not lost.
        // The person may leave during the reading: hide() stops the watch, and an order chat
        // starts its own.
        this.watch();
        // The screen as this device saw it the last time, in the first frame; the server's answer takes its place. What the
        // monitor says of itself (the status of the settings, the title of New orders) is read beside it.
        const drawing = paint();
        try {
          await reloadHome();
          syncHead();
          if (frame.screen === 'settings') paint();
          await drawing;
        } catch (e) {
          quiet('show')(e);
          // The frame looks again after a pause until one look goes, so the copy of the last time does not stay for good.
          frame.lookNow();
        }
      },
      // The app started and has the section: what the monitor says of itself is read while the section is not on the
      // screen yet, so that its first showing has the status, the title and the clients of the order chats.
      async warm() {
        if (frame.isShown()) return;
        try {
          await reloadHome();
        } catch (e) {
          console.warn('[profi] warm:', e && e.message);
        }
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
      hide() {
        this.unwatch();
        if (deps.head) deps.head(null);
      },
      // The screen of the section now ('feed', 'bot', …): the page tells the server which screen is open, the list of
      // new orders and the bot's chat have a number of unread of their own (webchat/wc-app.js, presenceKey).
      get screen() { return frame.screen; },
      // A press on an order outside the feed, or a notification about a message of an order chat (opts.fresh): the chat of
      // the order, or New orders at it while its reply waits there. The chat opens over the main page when opts.from is
      // 'people'.
      openOrder: openOrderOrFeed,
      // The line of an order chat as the main page of the people draws it.
      line: chatLine,
      // The ways in from outside (the line of New orders or of the bot's chat on the main page, its gear, a notification):
      // the screens of the section start over on the one asked for — 'feed' (at `order`, or at its top), 'bot' or
      // 'settings' — so that the arrow leads out of the section, to the main page (lex-section.js, root). It is said
      // before the section is on the screen, and the first screen of the section is never seen on the way.
      enter(screen, order) {
        frame.reset();
        if (screen === 'feed') {
          focusOrder = order || null;
          frame.push({ id: 'feed', title: feedTitle() });
        } else if (screen === 'bot') frame.push({ id: 'bot', title: BOT_TITLE });
        else {
          // order — here the block to stand at («notifications»: the row Profi.ru of Settings → Notifications).
          kinds = null;
          focusBlock = order || null;
          frame.push({ id: 'settings', title: 'Settings' });
        }
      },
    };
  }

  // boxNode — also for the check of a box on a page of its own (dev-tools/check-profi-box.mjs).
  global.LexProfi = { isChatKey, splitAnswer, createSection, createChat, newOpId, boxNode, outboxNode, busyNode, busyCommand,
    storedFilesOf, withoutFileMarks, digestOf, ownWords, agentWorks, EDIT_CHANNELS, REACT_CHANNELS };
})(typeof window !== 'undefined' ? window : globalThis);
