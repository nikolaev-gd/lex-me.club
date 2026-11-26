// lex-message.js — the common parts of every chat where messages come without the person:
// the feeds of Extended Mind, the chats of its questions, the order chats of Profi.ru, the
// letter of a news chat. One file for the extension and the page lex-me.club/app (the Mac
// app shows that page); the iPhone has the same parts in ios/Lex/Lex/Parts/.
//
//   message({ name, at | timeText, body | text, tail, cls })   a message of a person or a
//                       program: no bubble, no frame; the sender's name in bold and the time
//                       beside it, the text under them. `body` is a ready node, `text` plain text.
//   dayLine(at)         the date in the middle, between two days
//   newLine()           one line «Новые» over the first unread message
//   mark(host, since)   put the day lines and the «Новые» line among the turns of a chat:
//                       every turn with data-at counts for the days; a turn with data-in
//                       (it came without the person) newer than `since` is unread
//   entry(view, turnAt) a record of «Разбор» or «Обращения к базе» as a message, from the
//                       view the server built of its data (em_entry, lex_em_entry_view)
//   entry(view, turnAt, o)   a record of «Разбор» whose view has its look (`lane`, 2026-11-14,
//                       ios/Lex/STANDARD.md В7.28) is one bubble — intake() below
//   intake(view, o)     a record of «Разбор» as one message: the mark of the channel and who it is
//                       about, the time; the line of sense; the facts as plain lines, more than
//                       three folded under «Ещё N фактов»; yellow lines for a number over its limit;
//                       the numbers of an unfolded record; what the database dropped; «База задала
//                       тебе вопрос». No facts — one thin line. o = { timeText, open, onToggle(),
//                       onQuestion(texts) }
//   task(look, o)       a task of «Обращения к базе» as one message (В7.30, 2026-11-15): who asked, the
//                       time of the last request, the task, what was not right in words (yellow, soft,
//                       red), how many requests; a press shows them in words, five and «Ещё N». The look
//                       comes from the server (the key `task` of em_entry). o = { open, all, onToggle(),
//                       onMore() }; taskWords(text, at) — a text of the look with the device's times
//
// A chat drawn as in Telegram (2026-11-13, the order chats of Profi.ru first; its list of turns
// carries the class `lex-bubbles`, which also turns the day line into a plate in the middle):
//   bubble({ side, tone, label, body | text, stamp })   a message in a bubble: side 'in' on the
//                       left (the other person), 'out' on the right (what went to them); tone
//                       'self' (a word of the person to the model) and 'bot' (the model's
//                       answer, a dashed frame) change only the colour
//   stamp({ channel, at | timeText, tail })   the line under the text: the icon and the name
//                       of the channel the message came by, «·», the time, then `tail` (ticks)
//   channel(id)         the icon of a channel, 14 px: profi, max, telegram, whatsapp,
//                       instagram, facebook, threads, linkedin, x (CHANNELS has their names)
//   photos(list)        the photos of a message (2026-11-14, a photo the client sent on Profi.ru):
//                       [{ url, width, height }] → a node for `media` of bubble(); a press opens the
//                       photo whole in a new tab. Only https addresses; the server lets through only
//                       Profi's picture server (profi_client_photos.sql). None — null
//   files(list, io)     the stored files of a message (2026-11-14, files a client sent in Telegram,
//                       Max, WhatsApp or on Profi.ru, supabase/migrations/chat_files.sql):
//                       [{ kind, path, mime, bytes, name, duration, width, height, missing }] → a node
//                       for `media` of bubble(): photos as photos() draws them, a voice message as a
//                       row with a play button and its speed (1×–2.5×, one for the device; a press —
//                       the next one, a hold — the menu), a video as a tile that plays in place, a document as a
//                       card that opens it; a file that did not come — the card with the reason. The
//                       parts know no server: io = { blob(path) → Promise<object URL | null>,
//                       link(path, { download }) → Promise<address | null> } comes from the page. None — null
//   files(list, io, { free: true })   the same files outside a bubble: the person's own message in a
//                       chat of Lex (2026-11-17), over his bubble at the right edge
//   fileChip({ name, mime, bytes }, { busy, onRemove })   a file over the composer before the
//                       message goes (В7.49): the card of a document, «Uploading…» while busy, a cross 44
//   bubble({ …, media })   `media` (photos, files) stands over the text, as in Telegram; a bubble of
//                       photos without words has no line of text
//   bubble({ …, copy })   `copy` → Promise<bool>: a Copy mark inside, top right, the text flows
//                       round it (В7.22); a tick for 1,5 s once it copied
//   digest(words, markdown)   the text of a bubble whose file the database read (В7.21, 21.11.2026, the
//                       agent «Разбор вложений»): the person's own words as any text, then the digest in
//                       Markdown (WcMarkdown: lists, tables, bold, strikethrough); a wide table scrolls
//                       sideways inside the bubble. → a node for `body` of bubble()
//   bubble({ side: 'out', tone: 'draft', text, copy })   a draft for the client (В7.20): what went
//                       to the client with a dashed edge inside; no line under the text
//   editField({ value, label, onInput, onKey })   the words of a bubble as a field in the same bubble
//                       (В7.20, Edit → Save of a draft): body for bubble(), the field, grow(), focus()
//   sendHold({ channel, words, label, onSend, items, fit })   the button that sends a text to a
//                       person (В7.23): a second button with the mark of the place and «Hold to send
//                       to Dmitry»; a tap sends nothing, a hold of 480 ms sends; «⋯» by it opens
//                       items() → { send, more }
//   notice({ channel, body | text, at })   a notice of a service as a plate in the middle
//   fold({ text, action, onClick, icon })   one line in the middle for what is kept off the screen;
//                       icon 'check' — a tick in place of the eye (tasks without remarks, В7.30)
//   discussionFold({ count, shown, onClick })   the line of the talk with Lex in a chat of a person (В7.4,
//                       25.11.2026): «Discussion with Lex · N · Show», shown — «… · Hide»; the same words on the iPhone
//                       (FoldLine.discussion)
//   avatar(name, { photo, io, size })   the photo or the letter of a person (В7.12): the stored
//                       photo (chat-files/…) in a circle, the letter on a colour from the name until it
//                       came and when there is none; io = { blob(path) } as files() takes; size 40
//                       (default), 48 (the line of a chat) or 96 (the card of a person)
//   avatarMark(channel, size)   the mark of a channel 28 on a round ground in place of a person
//                       (the line of New orders)
//   avatarBrand(size)   the Lex mark (lex-brand-mark.js) on the same round ground, in place of a person: the
//                       line of the bot's service chat «Бот Профи» (19.11.2026)
//   order({ … })        the message of an order in the chat of new orders of Profi.ru (В7.29): the grey
//                       part of the client, the blue part of the bot's reply with the buttons, a yellow
//                       band «Not sure» on top; a done order folded in three lines that open in place
//   countdown(button)   Cancel with the countdown on it: the seconds and a ground that melts → { set }
//   eyeOff(size), sparkle(size)   the crossed eye (seen by the person alone) and the mark of
//                       the model
//
// Buttons (В7.6, В7.7) and the questions of the database (2026-11-14, the feed «Questions» of
// Extended Mind, ios/Lex/STANDARD.md В7.24–В7.26):
//   button({ label, note, main, left })   the main button (main: true) or the second one, 44 high,
//                       radius 12, 15/650; `left` — the words at the left, the height grows with
//                       them (a variant of a question); `note` — a second line 12/400 under the words
//   unsent({ note, money, gateRaw, sending, onRetry, onTopUp, onEdit, onDelete })   under the
//                       person's bubble when Lex did not take the message (В7.47, 2026-11-16): the red
//                       «Not sent» and the reason, «Top up» (money only), «Retry», «⋯» with «Edit» and
//                       «Delete»; `sending` — a retry on its way. The person's row carries `lex-unsent`.
//   taskStop({ onStop })   Stop of a development task under its row mac:<N> while it runs (В7.77,
//                       2026-11-23): the second button of its own width, a square and «Stop»; a press turns the
//                       ring at once, onStop() → Promise: resolved — the button goes (the row comes back
//                       «остановлено» by the signal), rejected — it is back and the caller says why.
//                       devTaskOf(uid, state) — the number N of a row mac:<N> that is «streaming», else null
//                       el.update(o) redraws it in place
//   question(v, o)      a question of the database as one message: v is its view from the server
//                       (lex_em_question_view: text, choices, state, answer, reason). Waiting — the
//                       bubble with its variants inside and the quiet «Пропустить» under them;
//                       answered or withdrawn — one line, a press unfolds it. o = { at, pending,
//                       open, onChoice(i), onToggle() }
//   whois(o)            the message of the agent «Кто это» (В7.54, 21.11.2026, no buttons): o.message — the bubble of
//                       the other side, 86 %: the mark (sparkle, «Lex», o.mark, o.wait — `--attention`; o.attention —
//                       an attach that stands: the mark, the ground and a rim of `--attention`), o.headline,
//                       o.rows [{ caption, name, sub, face: { name, photo, io, deal }, href | onPress }] — the lines of
//                       who is who (a link where it opens something), the words (Markdown the caller drew into `body`,
//                       links of Lex go to onGo), o.ask under a line, o.note { error }, the time. Without o.message —
//                       a word of an agent in its task chat (В7.50): the mark of Lex over the words, the time; with
//                       o.task and o.author (the agent's name, boards AgChat, AgChatWaiting) — a word with no bubble:
//                       the sparkle and the name, the words, the time on the left.
//                       o = { message, task, author, mark, wait, headline, rows, body | text, ask, note, at, onGo(place) }
//   questionPack(p, o)  the waiting questions with the same variants as one message: a title, a row
//                       per question, one button for all and «One by one». p = { members:
//                       [{ uid, at, view }], all, openRow, recording, errors, pending }, o = { onAll(),
//                       onOneByOne(), onMore(), onRow(uid), onChoice(uid, i) }
//   packTitle(members), packRows(members)   the words of a pack: what all its questions share, and
//                       what each says of its own
//
// News (2026-11-15, ios/Lex/STANDARD.md В7.31–В7.32):
//   newsCard(o)         a card of the feed of News, one button: the dot of a news not read, the mark
//                       of the kind of source, its name, the author, the time; the title, the subtitle,
//                       the line of a long read. o = { kind, source, author, at | timeText, title, sub,
//                       foot, unread, onOpen }; newsCardRead(card) — read now
//   newsKind(id, size), newsKindName(id), NEWS_KINDS   the mark and the word of a kind of source
//   newsSource(o)       the source of a news in the head of its screen: the mark and the name, the date
//                       and the time under them. o = { kind, source, at | timeText }; newsWhen(at) — the
//                       words of that date
//   talkLine(text)      a line with words in the middle — «Обсуждение с Lex» under the text of a news
//   replyBar({ head, text, onClose })   the line over the message box: the message the next one
//                       answers (Reply)
//
// The look of a message as in Telegram (2026-11-16, ios/Lex/STANDARD.md В7.35–В7.40; what a message
// carries is `looks` of profi_open):
//   quote(q, o)         the quote of the message a reply answers, inside its bubble: a bar, the name and
//                       one line; a press opens its sheet. q = { uid, who, name, text, kind, seconds,
//                       photo }, o = { io, onPress(q) }
//   bubble({ …, forwarded, quote, big, reactions, after, faded })   «Forwarded from …» on top, the
//                       quote over the text, emoji alone at 22, the reactions left of the stamp, the
//                       earlier text under it, a deleted message paler
//   stamp({ …, edited, deleted })   «edited», or a bin and «deleted», before the time
//   emojiOnly(text)     the text is emoji alone
//   reactions(list, o), forwarded(name), earlier(edits)   the pills of reactions, the line of a
//                       forward, the earlier versions of an edited message
//   sticker(o)          a sticker without a bubble and the pill «Sticker · time» under it
//   ticks(read), setTicks(svg, read)   the ticks under what went, in every channel (В7.2)
//   messageSheet({ nodes, lit, onShow, onReply })   the insides of the sheet of a message: the
//                       message in a frame with its neighbours, «Show in chat» and «Reply»
//   messageIcon(name, size)   the marks of the menu of a message: 'reply', 'copy', 'earlier'
//
// A chat or a section is built only from these parts and from lex-section.js (CLAUDE.md,
// docs/spec/27-sections.md, «Сообщения»). What is missing becomes a part here, for all.
(function (global) {
  'use strict';

  const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа',
    'сентября', 'октября', 'ноября', 'декабря'];

  function make(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // A face that opens or folds on a press and whose words still select (block 2, 2026-11-18): a <button> lets no
  // selection begin in it, so a card of News, a record of a feed, a folded question are this instead — the role of a
  // button, Tab, Enter and Space; a click that ends a selection in it is the selection, not a press.
  function pressFace(tag, cls) {
    const n = make(tag || 'div', cls);
    n.setAttribute('role', 'button');
    n.tabIndex = 0;
    n.classList.add('lex-press');
    n.addEventListener('click', (e) => {
      const sel = global.getSelection && global.getSelection();
      if (sel && !sel.isCollapsed && sel.rangeCount && sel.getRangeAt(0).intersectsNode(n) && String(sel).trim()) {
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    }, true);
    n.addEventListener('keydown', (e) => {
      if (e.target !== n || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      n.click();
    });
    return n;
  }

  function toDate(at) {
    if (at == null || at === '') return null;
    const d = at instanceof Date ? at : new Date(at);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const pad = (n) => String(n).padStart(2, '0');
  function timeOf(at) {
    const d = toDate(at);
    return d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : '';
  }

  // A day of the device's calendar: «Сегодня», «Вчера», «12 ноября», «12 ноября 2025».
  function dayKey(d) { return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; }
  function dayOf(at, now) {
    const d = toDate(at);
    if (!d) return '';
    const today = now ? new Date(now) : new Date();
    if (dayKey(d) === dayKey(today)) return 'Сегодня';
    const y = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    if (dayKey(d) === dayKey(y)) return 'Вчера';
    const base = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
    return d.getFullYear() === today.getFullYear() ? base : `${base} ${d.getFullYear()}`;
  }

  function message(o) {
    const root = make('div', `lex-msg${o.cls ? ` ${o.cls}` : ''}`);
    const head = make('div', 'lex-msg-head');
    // A mark before the name (o.mark, a node): the sparkle of Lex at the model's word in an order chat.
    if (o.mark) head.appendChild(o.mark);
    head.appendChild(make('span', 'lex-msg-name', o.name || ''));
    const time = o.timeText != null ? o.timeText : timeOf(o.at);
    if (time) head.appendChild(make('span', 'lex-msg-time', time));
    if (o.tail) head.appendChild(o.tail);
    root.appendChild(head);
    let body = o.body;
    if (!body) {
      body = make('div', 'lex-msg-text');
      body.textContent = o.text || '';
    } else body.classList.add('lex-msg-body');
    root.appendChild(body);
    return root;
  }

  const dayLine = (at) => make('div', 'lex-msg-day', dayOf(at));
  const newLine = () => make('div', 'lex-msg-new', 'Новые');

  // Walk the turns in order. A day line goes over the first turn of every day; the «Новые»
  // line over the first turn that came without the person after `since`. Lines from an
  // earlier pass go first, so the pass is safe to repeat after every change of the chat.
  function mark(host, since) {
    if (!host) return;
    for (const n of host.querySelectorAll(':scope > .lex-msg-day, :scope > .lex-msg-new')) n.remove();
    const from = toDate(since);
    let day = null;
    let newDone = !from;
    for (const t of [...host.children]) {
      // A message off the screen (the other tab of «Разбор») gets no line over it.
      if (t.hidden) continue;
      const at = toDate(t.dataset ? t.dataset.at : null);
      if (!at) continue;
      if (!newDone && t.dataset.in === '1' && at > from) {
        host.insertBefore(newLine(), t);
        newDone = true;
      }
      const k = dayKey(at);
      if (k !== day) {
        host.insertBefore(dayLine(at), t.previousElementSibling && t.previousElementSibling.classList.contains('lex-msg-new')
          ? t.previousElementSibling : t);
        day = k;
      }
    }
  }

  // ── a record of the database as a message ──────────────────────────────────
  // The server builds it from the record's data (lex_em_entry_view): the sender line, small
  // lines under it, the facts or the task, one plain note, one grey line of numbers. Here it
  // is only drawn. A number over its limit is yellow, failures are red.
  function stats(list) {
    const line = make('div', 'lex-msg-stats');
    (list || []).forEach((x, i) => {
      if (i) line.appendChild(document.createTextNode(' · '));
      line.appendChild(make('span', x.failed ? 'is-failed' : x.heavy ? 'is-heavy' : '', x.t || ''));
    });
    return line;
  }

  function entryBody(v) {
    const body = make('div', 'lex-msg-entry');
    for (const l of v.lines || []) body.appendChild(make('div', 'lex-msg-line', l));
    if (v.text) body.appendChild(make('div', 'lex-msg-text', v.text));
    for (const f of v.facts || []) {
      const p = make('div', 'lex-msg-fact');
      const t = make('div', 'lex-msg-text');
      if (f.kind) t.appendChild(make('span', 'lex-msg-tag', f.kind));
      t.appendChild(document.createTextNode(f.text || ''));
      p.appendChild(t);
      if (f.about) p.appendChild(make('div', 'lex-msg-line', `Куда: ${f.about}`));
      body.appendChild(p);
    }
    if (v.note) body.appendChild(make('div', 'lex-msg-note', v.note));
    if (v.stats && v.stats.length) body.appendChild(stats(v.stats));
    return body;
  }

  // The time beside the name: the moment the message came; with its day when that is not
  // the day the record stands under.
  function entryTime(v, turnAt) {
    const at = toDate(v.at) || toDate(turnAt);
    const under = toDate(turnAt);
    if (!at) return '';
    if (under && dayKey(at) !== dayKey(under)) return `${dayOf(at)}, ${timeOf(at)}`;
    return timeOf(at);
  }

  function entry(v, turnAt, o) {
    if (v && v.lane) return intake(v, Object.assign({ timeText: entryTime(v, turnAt) }, o || {}));
    return message({ name: v.name, timeText: entryTime(v, turnAt), body: entryBody(v) });
  }

  // ── A record of «Разбор» (В7.28, 2026-11-14) ─────────────────────────────────
  // One record — one message: the bubble of the other side across the whole lane, the corner 6
  // bottom left. Everything in it comes ready from the server (lex_em_intake_look): who it is about,
  // the line of sense the database wrote, how many facts to show, the yellow lines, the numbers. The
  // facts are plain lines: no kind, no «Куда:», no dots. A record without facts, without a question
  // and with every number in the norm is one thin line; a press shows it whole.
  const INTAKE_MARKS = {
    code: [['path', { d: 'M4 17l6-5-6-5' }], ['path', { d: 'M12 19h8' }]],
    notion: [['rect', { x: 5, y: 3, width: 14, height: 18, rx: 2 }], ['path', { d: 'M9 8h6' }], ['path', { d: 'M9 12h6' }],
      ['path', { d: 'M9 16h4' }]],
    call: [['path', { d: 'M6.6 3h2.8l1.4 4.2-2 1.4a12 12 0 0 0 5.6 5.6l1.4-2 4.2 1.4v2.8a2 2 0 0 1-2.2 2A16.6 16.6 0 0 1 4.6 5.2 2 2 0 0 1 6.6 3z' }]],
    mail: [['rect', { x: 3, y: 5, width: 18, height: 14, rx: 2 }], ['path', { d: 'M3.5 7l8.5 6 8.5-6' }]],
    calendar: [['rect', { x: 3.5, y: 5, width: 17, height: 15.5, rx: 2 }], ['path', { d: 'M3.5 10h17' }], ['path', { d: 'M8 3v4' }],
      ['path', { d: 'M16 3v4' }]],
  };
  const INTAKE_CHEVRON = { down: 'M6 9l6 6 6-6', up: 'M6 15l6-6 6 6', right: 'M9 6l6 6-6 6' };

  // The mark at the name, 14: a service's own (CHANNELS), or a line icon in the soft colour.
  function intakeMark(id) {
    if (CHANNELS[id]) return channel(id);
    const parts = INTAKE_MARKS[id];
    if (!parts) return null;
    const n = svg('0 0 24 24', 14);
    n.setAttribute('class', `lex-intake-mark is-${id}`);
    for (const [tag, attrs] of parts) {
      n.appendChild(shape(tag, Object.assign({ fill: 'none', stroke: 'currentColor', 'stroke-width': 2.2,
        'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, attrs)));
    }
    return n;
  }

  function chevron(way) {
    const n = svg('0 0 24 24', 16);
    n.appendChild(shape('path', { d: INTAKE_CHEVRON[way], fill: 'none', stroke: 'currentColor', 'stroke-width': 2,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    return n;
  }

  // A quiet button of the record: 13/600, a chevron 16, a zone 44 high.
  function intakeAct(cls, words, way, label, onPress) {
    const b = make('button', `lex-intake-act ${cls}`);
    b.type = 'button';
    if (label) b.setAttribute('aria-label', label);
    b.append(make('span', '', words), chevron(way));
    b.addEventListener('click', (e) => {
      e.preventDefault();
      if (onPress) onPress();
    });
    return b;
  }

  function intakeHead(v, o) {
    const head = make('div', 'lex-intake-head');
    const mark = intakeMark(v.icon);
    if (mark) head.appendChild(mark);
    head.append(make('span', 'lex-intake-name', v.title || ''), make('span', 'lex-intake-time', o.timeText || ''));
    return head;
  }

  function intakeThin(v, o) {
    const b = pressFace('div', 'lex-intake-thin');
    const words = v.line || (v.summary ? `${v.title}: ${v.summary}` : (v.title || ''));
    b.setAttribute('aria-label', `${words}. Show the details`);
    b.setAttribute('aria-expanded', 'false');
    const mark = intakeMark(v.icon);
    if (mark) b.appendChild(mark);
    b.append(make('span', 'lex-intake-thin-text', words), make('span', 'lex-intake-time', o.timeText || ''));
    b.addEventListener('click', () => { if (o.onToggle) o.onToggle(); });
    return b;
  }

  function intake(v, o) {
    o = o || {};
    const open = !!o.open;
    if (v.thin && !open) return intakeThin(v, o);
    const root = make('div', `lex-intake${open ? ' is-open' : ''}`);
    root.appendChild(intakeHead(v, o));
    if (v.summary) root.appendChild(make('div', 'lex-intake-summary', v.summary));
    const facts = (v.facts || []).map((f) => (f && f.text) || '').filter(Boolean);
    if (facts.length && (v.show === 'all' || (v.show === 'fold' && open))) {
      const list = make('div', 'lex-intake-facts');
      for (const f of facts) list.appendChild(make('div', 'lex-intake-fact', f));
      root.appendChild(list);
    }
    if (v.aside) root.appendChild(make('div', 'lex-intake-aside', v.aside));
    for (const a of v.alerts || []) root.appendChild(make('div', 'lex-intake-alert', a));
    if (open && v.numbers) root.appendChild(make('div', 'lex-intake-numbers', v.numbers));
    let tail = false;
    if (v.ask) {
      root.appendChild(intakeAct('lex-intake-ask', v.ask, 'right', null, () => o.onQuestion && o.onQuestion(v.asked || [])));
      tail = true;
    }
    // Folded: «Ещё N фактов» and a chevron down; unfolded (a long record, or a thin line shown
    // whole): «Свернуть» and a chevron up.
    if (v.show === 'fold' || (v.thin && open)) {
      const b = open
        ? intakeAct('lex-intake-more', 'Свернуть', 'up', null, o.onToggle)
        : intakeAct('lex-intake-more', v.more || 'Ещё', 'down', `Show ${facts.length} facts`, o.onToggle);
      b.setAttribute('aria-expanded', String(open));
      root.appendChild(b);
      tail = true;
    }
    if (tail) root.classList.add('ends-with-act');
    return root;
  }

  // ── A task of «Обращения к базе» (В7.30, 2026-11-15) ─────────────────────────
  // One task — one message (Gennady, 15.11.2026, the canvas «Обращения к базе: 3 варианта», board 3
  // «Сначала то, что не так»): the records of the database with the same who and what for, gathered by the
  // server (lex_em_request_task). The bubble of the other side across the lane. The head 13 in the muted
  // colour — the mark 14 and who asked, the time of the last request 12 at the right; 2 under it the task in
  // the text of the chat; 6 under it what was not right, 14, a line each: yellow — too much at once or a
  // long wait, the soft colour — requests with an error, red — every request failed; the count 12 under
  // them. The whole face is the button that shows the requests in words: the first five, «Ещё N» the rest.
  // Words and thresholds come ready from the server; here only the times go in where a text says {0}.
  const TASK_MARKS = {
    code: INTAKE_MARKS.code,
    chat: [['path', { d: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l.9-5.4A8 8 0 1 1 21 12z' }]],
  };
  const TASK_SHOWN = 5;

  // A text of the look with its times: «в {0} и в {1}» → «в 20:15 и в 23:57», the device's time.
  function taskWords(text, at) {
    return String(text || '').replace(/\{(\d+)\}/g, (_, i) => timeOf((at || [])[Number(i)]));
  }

  // The mark at who asked, 14 in the soft colour: Claude Code — a terminal, a chat of Claude — a cloud of
  // talk, Lex — its sparkle.
  function taskMark(icon) {
    if (icon === 'lex') {
      const s = sparkle(14);
      s.classList.add('lex-task-mark');
      return s;
    }
    const parts = TASK_MARKS[icon];
    if (!parts) return null;
    const n = svg('0 0 24 24', 14);
    n.setAttribute('class', 'lex-task-mark');
    for (const [tag, attrs] of parts) {
      n.appendChild(shape(tag, Object.assign({ fill: 'none', stroke: 'currentColor', 'stroke-width': 2.2,
        'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, attrs)));
    }
    return n;
  }

  // task(look, { open, all, onToggle, onMore }) — open: the requests under the face; all: every one of
  // them, not the first five.
  function task(v, o) {
    o = o || {};
    const open = !!o.open;
    const root = make('article', `lex-task${open ? ' is-open' : ''}`);
    const face = pressFace('div', 'lex-task-face');
    face.setAttribute('aria-expanded', String(open));
    const head = make('span', 'lex-task-head');
    const mark = taskMark(v.icon);
    if (mark) head.appendChild(mark);
    head.append(make('span', 'lex-task-who', v.who || ''), make('span', 'lex-task-time', timeOf(v.last)));
    face.append(head, make('span', 'lex-task-why', v.why || ''));
    for (const n of v.notes || []) {
      face.appendChild(make('span', `lex-task-note is-${n.tone === 'danger' || n.tone === 'attention' ? n.tone : 'soft'}`,
        taskWords(n.t, v.at)));
    }
    if (v.count_line) face.appendChild(make('span', 'lex-task-count', taskWords(v.count_line, v.at)));
    face.addEventListener('click', (e) => {
      e.preventDefault();
      if (o.onToggle) o.onToggle();
    });
    root.appendChild(face);
    if (!open) return root;
    const calls = Array.isArray(v.calls) ? v.calls : [];
    const shown = o.all ? calls : calls.slice(0, TASK_SHOWN);
    const list = make('div', 'lex-task-calls');
    for (const c of shown) {
      const row = make('div', 'lex-task-call');
      row.append(make('span', 'lex-task-call-words', c.t || ''), make('span', 'lex-task-call-time', timeOf(c.at)));
      list.appendChild(row);
    }
    root.appendChild(list);
    const rest = calls.length - shown.length + (Number(v.more) || 0);
    if (!o.all && rest > 0) {
      const b = intakeAct('lex-intake-more', `Ещё ${rest}`, 'down', `Show ${rest} more requests`, o.onMore);
      b.setAttribute('aria-expanded', 'false');
      root.appendChild(b);
      root.classList.add('ends-with-act');
    } else if (o.all && calls.length > TASK_SHOWN) {
      if (Number(v.more) > 0) list.appendChild(make('div', 'lex-task-call-more', `Ещё ${v.more} — в базе`));
      const b = intakeAct('lex-intake-more', 'Свернуть', 'up', null, o.onToggle);
      b.setAttribute('aria-expanded', 'true');
      root.appendChild(b);
      root.classList.add('ends-with-act');
    }
    return root;
  }

  // ── a chat as in Telegram ───────────────────────────────────────────────────
  // Where a message came from: its name, the colour of the name (null — the main colour of the
  // text, readable in both themes) and the outline of its mark from Simple Icons (CC0); the
  // icons are drawn by channel() below.
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MAX_MARK = 'M50.76 .26C78.29 .26 99.89 22.6 99.89 50.15S77.61 99.49 51.02 99.49c-9.43 0-14-1.33-21.37-6.54-.51-.36-1.2-.27-1.63.19-5.66 6.05-20.17 10.29-20.84 2.04C7.19 80.79 0 71.45 0 49.88 0 21.55 23.22.26 50.76.26ZM51.53 24.81C38.46 24.13 28.26 33.2 26.01 47.38c-1.86 11.75 1.44 26.07 4.27 26.8 1.2.31 4.08-1.9 6.18-3.88.39-.37.99-.44 1.45-.15 3.27 2 6.97 3.5 11.05 3.71 13.41.7 25.3-9.8 26.01-23.21.7-13.41-10.02-25.14-23.44-25.84Z';
  const CHANNELS = {
    profi: { name: 'Профи.ру', color: null },
    max: { name: 'Max', color: 'gradient' },
    telegram: { name: 'Telegram', color: '#2AABEE',
      d: 'M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z' },
    whatsapp: { name: 'WhatsApp', color: '#25D366',
      d: 'M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z' },
    // The places of a call (В7.42, 2026-11-16): the mark of the service, the name plain. A call of the iPhone
    // through the Mac comes as FaceTime and is shown as Phone; FaceTime has no mark of its own (Gennady).
    zoom: { name: 'Zoom', color: null },
    meet: { name: 'Google Meet', color: null,
      d: 'M5.53 2.13 0 7.75h5.53zm.398 0v5.62h7.608v3.65l5.47-4.45c-.014-1.22.031-2.25-.025-3.46-.148-1.09-1.287-1.47-2.236-1.36zM23.1 4.32c-.802.295-1.358.995-2.047 1.49-2.506 2.05-4.982 4.12-7.468 6.19 3.025 2.59 6.04 5.18 9.065 7.76 1.218.671 1.428-.814 1.328-1.64v-13a.828.828 0 0 0-.877-.825zM.038 8.15v7.7h5.53v-7.7zm13.577 8.1H6.008v5.62c3.864-.006 7.737.011 11.58-.009 1.02-.07 1.618-1.12 1.468-2.07v-2.51l-5.47-4.68v3.65zm-13.577 0c.02 1.44-.041 2.88.033 4.31.162.948 1.158 1.43 2.047 1.31h3.464v-5.62z' },
    telemost: { name: 'Telemost', color: null },
    phone: { name: 'Phone', color: null,
      d: 'M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z' },
    instagram: { name: 'Instagram', color: '#FF6B9A',
      d: 'M7.0301.084c-1.2768.0602-2.1487.264-2.911.5634-.7888.3075-1.4575.72-2.1228 1.3877-.6652.6677-1.075 1.3368-1.3802 2.127-.2954.7638-.4956 1.6365-.552 2.914-.0564 1.2775-.0689 1.6882-.0626 4.947.0062 3.2586.0206 3.6671.0825 4.9473.061 1.2765.264 2.1482.5635 2.9107.308.7889.72 1.4573 1.388 2.1228.6679.6655 1.3365 1.0743 2.1285 1.38.7632.295 1.6361.4961 2.9134.552 1.2773.056 1.6884.069 4.9462.0627 3.2578-.0062 3.668-.0207 4.9478-.0814 1.28-.0607 2.147-.2652 2.9098-.5633.7889-.3086 1.4578-.72 2.1228-1.3881.665-.6682 1.0745-1.3378 1.3795-2.1284.2957-.7632.4966-1.636.552-2.9124.056-1.2809.0692-1.6898.063-4.948-.0063-3.2583-.021-3.6668-.0817-4.9465-.0607-1.2797-.264-2.1487-.5633-2.9117-.3084-.7889-.72-1.4568-1.3876-2.1228C21.2982 1.33 20.628.9208 19.8378.6165 19.074.321 18.2017.1197 16.9244.0645 15.6471.0093 15.236-.005 11.977.0014 8.718.0076 8.31.0215 7.0301.0839m.1402 21.6932c-1.17-.0509-1.8053-.2453-2.2287-.408-.5606-.216-.96-.4771-1.3819-.895-.422-.4178-.6811-.8186-.9-1.378-.1644-.4234-.3624-1.058-.4171-2.228-.0595-1.2645-.072-1.6442-.079-4.848-.007-3.2037.0053-3.583.0607-4.848.05-1.169.2456-1.805.408-2.2282.216-.5613.4762-.96.895-1.3816.4188-.4217.8184-.6814 1.3783-.9003.423-.1651 1.0575-.3614 2.227-.4171 1.2655-.06 1.6447-.072 4.848-.079 3.2033-.007 3.5835.005 4.8495.0608 1.169.0508 1.8053.2445 2.228.408.5608.216.96.4754 1.3816.895.4217.4194.6816.8176.9005 1.3787.1653.4217.3617 1.056.4169 2.2263.0602 1.2655.0739 1.645.0796 4.848.0058 3.203-.0055 3.5834-.061 4.848-.051 1.17-.245 1.8055-.408 2.2294-.216.5604-.4763.96-.8954 1.3814-.419.4215-.8181.6811-1.3783.9-.4224.1649-1.0577.3617-2.2262.4174-1.2656.0595-1.6448.072-4.8493.079-3.2045.007-3.5825-.006-4.848-.0608M16.953 5.5864A1.44 1.44 0 1 0 18.39 4.144a1.44 1.44 0 0 0-1.437 1.4424M5.8385 12.012c.0067 3.4032 2.7706 6.1557 6.173 6.1493 3.4026-.0065 6.157-2.7701 6.1506-6.1733-.0065-3.4032-2.771-6.1565-6.174-6.1498-3.403.0067-6.156 2.771-6.1496 6.1738M8 12.0077a4 4 0 1 1 4.008 3.9921A3.9996 3.9996 0 0 1 8 12.0077' },
    facebook: { name: 'Facebook', color: '#5B9DFF',
      d: 'M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647Z' },
    threads: { name: 'Threads', color: null,
      d: 'M12.186 24h-.007c-3.581-.024-6.334-1.205-8.184-3.509C2.35 18.44 1.5 15.586 1.472 12.01v-.017c.03-3.579.879-6.43 2.525-8.482C5.845 1.205 8.6.024 12.18 0h.014c2.746.02 5.043.725 6.826 2.098 1.677 1.29 2.858 3.13 3.509 5.467l-2.04.569c-1.104-3.96-3.898-5.984-8.304-6.015-2.91.022-5.11.936-6.54 2.717C4.307 6.504 3.616 8.914 3.589 12c.027 3.086.718 5.496 2.057 7.164 1.43 1.783 3.631 2.698 6.54 2.717 2.623-.02 4.358-.631 5.8-2.045 1.647-1.613 1.618-3.593 1.09-4.798-.31-.71-.873-1.3-1.634-1.75-.192 1.352-.622 2.446-1.284 3.272-.886 1.102-2.14 1.704-3.73 1.79-1.202.065-2.361-.218-3.259-.801-1.063-.689-1.685-1.74-1.752-2.964-.065-1.19.408-2.285 1.33-3.082.88-.76 2.119-1.207 3.583-1.291a13.853 13.853 0 0 1 3.02.142c-.126-.742-.375-1.332-.75-1.757-.513-.586-1.308-.883-2.359-.89h-.029c-.844 0-1.992.232-2.721 1.32L7.734 7.847c.98-1.454 2.568-2.256 4.478-2.256h.044c3.194.02 5.097 1.975 5.287 5.388.108.046.216.094.321.142 1.49.7 2.58 1.761 3.154 3.07.797 1.82.871 4.79-1.548 7.158-1.85 1.81-4.094 2.628-7.277 2.65Zm1.003-11.69c-.242 0-.487.007-.739.021-1.836.103-2.98.946-2.916 2.143.067 1.256 1.452 1.839 2.784 1.767 1.224-.065 2.818-.543 3.086-3.71a10.5 10.5 0 0 0-2.215-.221z' },
    linkedin: { name: 'LinkedIn', color: '#70B5F9',
      d: 'M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z' },
    x: { name: 'X', color: null,
      d: 'M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z' },
  };

  function svg(viewBox, size) {
    const n = document.createElementNS(SVG_NS, 'svg');
    n.setAttribute('viewBox', viewBox);
    n.setAttribute('width', String(size));
    n.setAttribute('height', String(size));
    n.setAttribute('aria-hidden', 'true');
    return n;
  }
  function shape(tag, attrs) {
    const n = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    return n;
  }

  // Every icon in a box of 24, the way the service's own app icon looks at this size: its
  // ground and its mark in white. Профи.ру is the app «Для профи», measured off its icon
  // (2026-11-13): a dark square, a white circle above with a trail fading to the left, a wide
  // white pill below. Max is the mark of max.ru in a dark square. A dark square gets a faint
  // rim, so that it does not melt into a dark bubble.
  let gradients = 0;
  const WHITE = '#F3F4F9';
  const RIM = { x: .5, y: .5, width: 23, height: 23, rx: 5.3, fill: 'none', stroke: '#FFFFFF', 'stroke-opacity': '.16', 'stroke-width': 1 };
  function gradient(stops, x1, y1, x2, y2, user) {
    const id = `lex-ch-g${++gradients}`;
    const g = shape('linearGradient', Object.assign({ id, x1, y1, x2, y2 }, user ? { gradientUnits: 'userSpaceOnUse' } : {}));
    for (const [offset, color, opacity] of stops) {
      g.appendChild(shape('stop', Object.assign({ offset, 'stop-color': color }, opacity != null ? { 'stop-opacity': opacity } : {})));
    }
    return { id, g };
  }
  const glyph = (d, scale, fill) => shape('path', { d, fill, transform: `translate(${(24 - 24 * scale) / 2} ${(24 - 24 * scale) / 2}) scale(${scale})` });

  function channel(id) {
    const c = CHANNELS[id];
    if (!c) return null;
    const n = svg('0 0 24 24', 14);
    n.setAttribute('class', `lex-channel-icon is-${id}`);
    const defs = shape('defs', {});
    n.appendChild(defs);
    const square = (fill) => shape('rect', { width: 24, height: 24, rx: 5.8, fill });
    if (id === 'profi') {
      const trail = gradient([[0, '#FFFFFF', 0], [1, '#FFFFFF', .5]], 1.9, 0, 11.9, 0, true);
      defs.appendChild(trail.g);
      n.append(square('#25272F'), shape('rect', RIM),
        shape('rect', { x: 1.9, y: 3.84, width: 10, height: 7.2, fill: `url(#${trail.id})` }),
        shape('circle', { cx: 11.88, cy: 7.44, r: 3.6, fill: WHITE }),
        shape('rect', { x: 5.04, y: 13.2, width: 13.92, height: 7.08, rx: 3.54, fill: WHITE }));
    } else if (id === 'max') {
      // The mark of max.ru: a ring of a speech bubble, cyan on the left to violet on the right.
      const g = gradient([[0, '#00C4FF'], [.5, '#1E52FF'], [1, '#8114FF']], 0, .7, 1, .3);
      defs.appendChild(g.g);
      const s = 17.14 / 104;
      n.append(square('#1C1D22'), shape('rect', RIM),
        shape('path', { d: MAX_MARK, fill: `url(#${g.id})`, 'fill-rule': 'evenodd',
          transform: `translate(${(24 - 17.14) / 2 + 2 * s} ${(24 - 17.14) / 2}) scale(${s})` }));
    } else if (id === 'telegram') {
      // The round logo: the plane is a hole in the blue, white shows through it.
      const g = gradient([[0, '#2AABEE'], [1, '#229ED9']], 0, 0, 0, 1);
      defs.appendChild(g.g);
      n.append(shape('circle', { cx: 12, cy: 12, r: 11.5, fill: '#FFFFFF' }), shape('path', { d: c.d, fill: `url(#${g.id})` }));
    } else if (id === 'facebook') {
      n.append(shape('circle', { cx: 12, cy: 12, r: 11.5, fill: '#FFFFFF' }), shape('path', { d: c.d, fill: '#0866FF' }));
    } else if (id === 'linkedin') {
      n.append(shape('rect', { x: 1.5, y: 1.5, width: 21, height: 21, fill: '#FFFFFF' }), shape('path', { d: c.d, fill: '#0A66C2' }));
    } else if (id === 'whatsapp') {
      n.append(square('#25D366'), glyph(c.d, .62, '#FFFFFF'));
    } else if (id === 'zoom') {
      // The icon of Zoom: a white camera on its blue.
      n.append(square('#0B5CFF'), shape('rect', { x: 4, y: 7.5, width: 11, height: 9, rx: 2.2, fill: '#FFFFFF' }),
        shape('path', { d: 'M16 10.6l3.1-2.1c.4-.3.9 0 .9.5v6c0 .5-.5.8-.9.5L16 13.4z', fill: '#FFFFFF' }));
    } else if (id === 'meet') {
      n.append(square('#FFFFFF'), glyph(c.d, .65, '#00897B'));
    } else if (id === 'telemost') {
      // The icon of Yandex Telemost (yastatic.net, 2020): a dark square, a white ring with its light, a green dot.
      const g = gradient([[0, '#000000'], [1, '#31404E']], -2.45, 26.73, 24, 0, true);
      defs.appendChild(g.g);
      n.append(square(`url(#${g.id})`), shape('rect', RIM),
        shape('circle', { cx: 10.63, cy: 10.13, r: 1.13, fill: '#FFFFFF', opacity: .6 }),
        shape('circle', { cx: 9, cy: 12, r: 5.25, fill: 'none', stroke: '#FFFFFF', 'stroke-width': 1.13 }),
        shape('circle', { cx: 18.75, cy: 12, r: 2.25, fill: '#00FF00' }));
    } else if (id === 'phone') {
      n.append(square('#34C759'), glyph(c.d, .55, '#FFFFFF'));
    } else if (id === 'instagram') {
      const g = gradient([[0, '#FEDA75'], [.25, '#FA7E1E'], [.5, '#D62976'], [.75, '#962FBF'], [1, '#4F5BD5']], 0, 1, 1, 0);
      defs.appendChild(g.g);
      n.append(square(`url(#${g.id})`), glyph(c.d, .6, '#FFFFFF'));
    } else if (id === 'threads') {
      n.append(square('#000000'), shape('rect', RIM), glyph(c.d, .56, '#FFFFFF'));
    } else if (id === 'x') {
      n.append(square('#000000'), shape('rect', RIM), glyph(c.d, .5, '#FFFFFF'));
    }
    return n;
  }

  function channelName(id) {
    const c = CHANNELS[id];
    const n = make('span', `lex-channel-name${c && !c.color ? ' is-plain' : ''}${c && c.color === 'gradient' ? ' is-max' : ''}`,
      c ? c.name : '');
    if (c && c.color && c.color !== 'gradient') n.style.color = c.color;
    return n;
  }

  function stamp(o) {
    const root = make('div', 'lex-stamp');
    if (o.channel && CHANNELS[o.channel]) {
      // `label` — the place with its own words: «WhatsApp call» of a call (В7.42).
      const name = channelName(o.channel);
      if (o.label) name.textContent = o.label;
      root.append(channel(o.channel), name, make('span', 'lex-stamp-dot', '·'));
    } else if (o.label) {
      root.append(make('span', 'lex-channel-name is-plain', o.label), make('span', 'lex-stamp-dot', '·'));
    }
    // В7.39: a message the person deleted at his side — a bin 12 and «deleted»; an edited one — «edited»;
    // both before the time.
    if (o.deleted) {
      const gone = make('span', 'lex-stamp-deleted');
      gone.append(strokes(TRASH_D, 12), make('span', '', 'deleted'));
      root.appendChild(gone);
    } else if (o.edited) root.appendChild(make('span', 'lex-stamp-edited', 'edited'));
    const time = o.timeText != null ? o.timeText : timeOf(o.at);
    if (time) root.appendChild(make('span', 'lex-stamp-time', time));
    if (o.tail) root.appendChild(o.tail);
    return root;
  }

  // The look of a message as in Telegram (В7.35–В7.40) rides on the same bubble:
  //   forwarded   «Forwarded from <name>» over everything (В7.39); true — «Forwarded», the author not known
  //   quote       the quote of the message it answers, over the text (В7.35, quote() below)
  //   big         the text is emoji alone: 22 (В7.40, emojiOnly())
  //   reactions   the pills of the reactions (reactions()): at the bottom left, the stamp right of them
  //   after       what opens under the stamp: the earlier text of an edited message (earlier())
  //   faded       the person deleted it at his side: paler (В7.39); its stamp says so (stamp({ deleted }))
  function bubble(o) {
    const corner = o.copy ? copyCorner(o.copy) : null;
    const root = make('div', `lex-bubble is-${o.side === 'out' ? 'out' : 'in'}${o.tone ? ` is-${o.tone}` : ''}${o.media ? ' has-media' : ''}${o.faded ? ' is-deleted' : ''}${corner && o.quote ? ' has-quote-copy' : ''}`);
    if (o.label) root.appendChild(typeof o.label === 'string' ? make('div', 'lex-bubble-label', o.label) : o.label);
    // Copy of a message (В7.22) stands in the top right corner of the bubble: over a quote it is the
    // first thing of the bubble and the quote stands beside it, as narrow as the corner leaves it; without
    // a quote it is in the text, which flows round it.
    if (corner && o.quote) root.appendChild(corner);
    if (o.forwarded) root.appendChild(forwarded(o.forwarded === true ? '' : o.forwarded));
    if (o.quote) root.appendChild(o.quote);
    if (o.media) root.appendChild(o.media);
    let body = o.body;
    if (!body) {
      // The addresses in the words are links (lex-links.js): «https://…» as a person pasted it, «[caption](https://…)».
      body = global.LexLinks.into(make('div', 'lex-bubble-text'), o.text || '');
    } else body.classList.add('lex-bubble-text');
    if (o.big) body.classList.add('is-emoji');
    // Copy of a message (В7.22): inside, top right; the text flows round it.
    if (corner && !o.quote) body.prepend(corner);
    if (!o.media || (body.textContent || '').trim()) root.appendChild(body);
    if (o.reactions) {
      const foot = make('div', 'lex-bubble-foot');
      foot.appendChild(o.reactions);
      if (o.stamp) foot.appendChild(o.stamp);
      root.appendChild(foot);
    } else if (o.stamp) root.appendChild(o.stamp);
    if (o.after) root.appendChild(o.after);
    return root;
  }

  // Copy inside a message (В7.22): a mark 16 in the colour of the bubble's line, in the top right
  // corner; the text flows round it, so only its first line is shorter. The zone of the press is 44
  // and unseen. run() → true once the text is on the clipboard: a tick then stands for 1,5 s.
  const COPY_D = ['M9 9h10v10H9z', 'M5 15V5h10'];
  const TICK_D = ['M4 12l5 5L20 6'];
  function strokes(ds, size) {
    const n = svg('0 0 24 24', size);
    for (const d of ds) {
      n.appendChild(shape('path', { d, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    }
    return n;
  }
  function copyCorner(run) {
    const b = make('button', 'lex-bubble-copy');
    b.type = 'button';
    b.title = 'Copy';
    b.setAttribute('aria-label', 'Copy');
    b.appendChild(strokes(COPY_D, 16));
    let timer = null;
    b.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      let ok = false;
      try { ok = !!(await run()); } catch (_) { ok = false; }
      if (!ok) return;
      b.replaceChildren(strokes(TICK_D, 16));
      b.classList.add('is-copied');
      clearTimeout(timer);
      timer = setTimeout(() => {
        b.replaceChildren(strokes(COPY_D, 16));
        b.classList.remove('is-copied');
      }, 1500);
    });
    return b;
  }

  // The words of a bubble changed in place (В7.20, Edit → Save, Gennady 2026-11-18): the text of the bubble
  // becomes a field inside the same bubble — the bubble's own edge is the only frame, no second one, the
  // letters and the colour are the bubble's — and the field grows with the words.
  //   editField({ value, label, onInput(value), onKey(event) }) → { body, field, grow, focus }
  //     body — for `body` of bubble(); label — what is read from the screen; focus() — the caret at the
  //     end, once the bubble stands in the page (it grows then, too).
  function editField(o) {
    const body = make('div', 'lex-edit-body');
    const field = make('textarea', 'lex-bubble-edit');
    field.value = (o && o.value) || '';
    field.rows = 1;
    if (o && o.label) field.setAttribute('aria-label', o.label);
    const grow = () => {
      field.style.height = 'auto';
      field.style.height = `${field.scrollHeight}px`;
    };
    field.addEventListener('input', () => {
      grow();
      if (o && o.onInput) o.onInput(field.value);
    });
    if (o && o.onKey) field.addEventListener('keydown', o.onKey);
    body.appendChild(field);
    // The bubble is built before it stands in the page, and a field out of the page has no height yet.
    const settle = (left) => {
      if (field.isConnected) { grow(); return; }
      if (left > 0) global.requestAnimationFrame(() => settle(left - 1));
    };
    settle(20);
    const focus = () => global.requestAnimationFrame(() => {
      if (!field.isConnected) return;
      grow();
      field.focus({ preventScroll: false });
      field.setSelectionRange(field.value.length, field.value.length);
    });
    return { body, field, grow, focus };
  }

  // The button that sends a text to a person (В7.23, Gennady's decision of 2026-11-16: «пусть это
  // просто будет обычное долгое нажатие … коснувшись, оно не уходило»). The second button (В7.7): 44
  // high, radius 12, --bg-hover, the words 15/650; in the middle the mark 18 of the place it goes to
  // and the words in one line («Hold to send to Dmitry»). A tap and a click send nothing — only the
  // press shows; a hold of 480 ms sends: the common hold of Lex (lex-long-press.js), a finger that went
  // more than 10 is a scroll. No hint, no countdown, no fill, no question. A white arrow is the send of
  // the field to the model only: this is not it.
  //
  // items() — the menu of «⋯» by it (the icon button В7.11, zone 44): the common menu of a held button
  // without the dim (lex-send-later.js, `plain`), nothing leaves by opening it; the right button of a
  // mouse on the send opens the same menu. A long touch is the hold, never the menu.
  //   sendHold({ channel, words, label, onSend, items, fit }) → { send, more }
  //     words — what the button says; label — what is read from the screen («Send to Dmitry on
  //     Профи.ру. Hold to send»); fit — its own width (one's own text at the end of the chat), else it
  //     takes what the row leaves; more — null without items. The caller disables send (0.5) while the
  //     text is on its way.
  const DOTS = [5, 12, 19];
  // «⋯» — the icon button В7.11 (a round zone 44, three dots 20) that opens the common menu of a held
  // button without the dim (`plain`): the menu of a draft's send (В7.23) and of a message that was
  // not sent (В7.47). items() → the items of LexSendLater.menu. → { more, open(), isOpen() }
  function moreMenu(items) {
    const more = make('button', 'lex-send-more');
    more.type = 'button';
    more.title = 'More';
    more.setAttribute('aria-label', 'More');
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', 'false');
    const dots = svg('0 0 24 24', 20);
    for (const cx of DOTS) dots.appendChild(shape('circle', { cx, cy: 12, r: 1.8, fill: 'currentColor' }));
    more.appendChild(dots);
    let shown = false;
    const open = () => {
      if (shown || more.disabled || !global.LexSendLater) return;
      const list = items();
      if (!list || !list.length) return;
      shown = true;
      more.classList.add('is-open');
      more.setAttribute('aria-expanded', 'true');
      global.LexSendLater.menu({
        anchor: more, align: 'right', plain: true, items: list,
        onClose: () => {
          shown = false;
          more.classList.remove('is-open');
          more.setAttribute('aria-expanded', 'false');
          // The focus was on an item of the menu, which is gone: back to «⋯», for the keyboard.
          const f = document.activeElement;
          if ((!f || f === document.body) && more.isConnected) more.focus({ preventScroll: true });
        },
      });
    };
    more.addEventListener('click', open);
    return { more, open, isOpen: () => shown };
  }

  function sendHold(o) {
    const id = CHANNELS[o && o.channel] ? o.channel : 'profi';
    const send = make('button', `lex-send-hold${o.fit ? ' is-fit' : ''}`);
    send.type = 'button';
    send.setAttribute('aria-label', o.label || o.words || 'Hold to send');
    send.append(channel(id), make('span', 'lex-send-hold-words', o.words || 'Hold to send'));
    const m = typeof o.items === 'function' ? moreMenu(o.items) : null;
    const more = m ? m.more : null;
    // Ctrl and the button of a Mac's mouse is its right button: the menu opens at once, and the hold
    // under it must not send while the button is still down.
    let ctrl = false;
    send.addEventListener('pointerdown', (e) => { ctrl = !!e.ctrlKey; });
    const hold = global.LexLongPress
      ? global.LexLongPress.attach(send, () => {
        if (send.disabled || (m && m.isOpen()) || typeof o.onSend !== 'function') return;
        if (global.WcHaptics) global.WcHaptics.press();
        o.onSend();
      }, { when: () => !ctrl && !send.disabled })
      : null;
    // A tap or a click: nothing goes. The press only shows (:active).
    send.addEventListener('click', (e) => { e.preventDefault(); });
    send.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (e.pointerType === 'touch' || e.pointerType === 'pen' || (hold && hold.didFire())) return;
      if (m) m.open();
    });
    return { send, more };
  }

  // One photo stands in its own proportions, up to 280 wide and 320 high (В7.19). Its frame is given
  // the width the picture will have: left to the browser, the frame took the width of the bubble and
  // the plate showed beside a picture narrower than the text under it. The size comes from the
  // message when it has one and again from the picture when it loads (it knows its turn).
  const PHOTO_W = 280;
  const PHOTO_H = 320;
  function fitPhoto(a, img, w, h) {
    const size = (pw, ph) => {
      if (!(pw > 0 && ph > 0)) return;
      const s = Math.min(1, PHOTO_W / pw, PHOTO_H / ph);
      a.style.width = `${Math.round(pw * s)}px`;
      a.classList.add('is-sized');
    };
    size(w, h);
    img.addEventListener('load', () => size(img.naturalWidth, img.naturalHeight), { once: true });
  }

  function photos(list) {
    const items = (Array.isArray(list) ? list : []).filter((p) => p && typeof p.url === 'string' && /^https:\/\//.test(p.url));
    if (!items.length) return null;
    const root = make('div', `lex-photos${items.length > 1 ? ' is-many' : ''}`);
    for (const p of items) {
      const a = make('a', 'lex-photo');
      a.href = p.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.setAttribute('aria-label', 'Photo');
      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      if (p.width > 0 && p.height > 0) { img.width = p.width; img.height = p.height; }
      if (items.length === 1) fitPhoto(a, img, p.width, p.height);
      img.src = p.url;
      a.appendChild(img);
      root.appendChild(a);
    }
    return root;
  }

  // ── The stored files of a message (В7.21) ────────────────────────────────────
  // The bytes come through `io` of the page: blob(path) gives an object URL fetched with the person's
  // pass (a photo, a voice message), link(path) — an address that opens the file in a new tab and
  // lives an hour (a video, a document, a photo whole). An address is asked before the press, so a
  // press opens it at once: in a browser a new tab, in the Mac app the system browser.
  const LINK_FRESH_MS = 40 * 60 * 1000;
  const MISSING = {
    too_big: 'Larger than 50 MB: it stayed where it was sent',
    no_file: 'The file did not come here',
  };

  // A file without a name of its own (a photo, a voice message) is called by what it is.
  const KIND_NAME = { voice: 'Voice message', audio: 'Audio', video: 'Video', image: 'Photo' };

  function sizeText(bytes) {
    const b = Number(bytes);
    if (!Number.isFinite(b) || b <= 0) return '';
    if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MB`;
    if (b >= 1024) return `${Math.round(b / 1024)} KB`;
    return `${b} B`;
  }
  function durationText(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    return `${Math.floor(s / 60)}:${pad(s % 60)}`;
  }
  // What a document is, in the words on its card: its extension, as people call files.
  function typeText(f) {
    const ext = (/\.([A-Za-z0-9]{1,6})$/.exec(String(f.name || ''))?.[1] || '').toUpperCase();
    if (ext) return ext;
    const m = String(f.mime || '');
    if (m === 'application/pdf') return 'PDF';
    return m.startsWith('video/') ? 'Video' : m.startsWith('audio/') ? 'Audio' : 'File';
  }

  // An <a> that holds a fresh address of the file: asked once when drawn, again when the address is
  // older than 40 minutes and the pointer comes near.
  function liveLink(a, f, io, opts) {
    if (!io || typeof io.link !== 'function' || !f.path) return;
    let at = 0;
    const ask = () => {
      if (Date.now() - at < LINK_FRESH_MS) return;
      at = Date.now();
      Promise.resolve(io.link(f.path, opts || {})).then((url) => {
        if (url) a.href = url;
        else at = 0;
      }, () => { at = 0; });
    };
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.addEventListener('pointerenter', ask);
    a.addEventListener('focus', ask);
    a.addEventListener('touchstart', ask, { passive: true });
    // No address yet: the press waits for it instead of opening nothing.
    a.addEventListener('click', (e) => {
      if (a.getAttribute('href')) return;
      e.preventDefault();
      at = 0;
      ask();
    });
    ask();
  }

  function storedPhotos(list, io) {
    const root = make('div', `lex-photos${list.length > 1 ? ' is-many' : ''}`);
    for (const f of list) {
      const a = make('a', 'lex-photo');
      a.setAttribute('aria-label', f.name ? `Photo ${f.name}` : 'Photo');
      const img = document.createElement('img');
      img.alt = '';
      img.decoding = 'async';
      if (f.width > 0 && f.height > 0) { img.width = f.width; img.height = f.height; }
      if (list.length === 1) fitPhoto(a, img, f.width, f.height);
      a.appendChild(img);
      if (io && typeof io.blob === 'function') {
        Promise.resolve(io.blob(f.path)).then((url) => { if (url) img.src = url; }, () => {});
      }
      liveLink(a, f, io);
      root.appendChild(a);
    }
    return root;
  }

  const PLAY = 'M8 5.5v13l11-6.5z';
  const PAUSE = 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z';
  function playIcon(d, size) {
    const n = svg('0 0 24 24', size);
    n.appendChild(shape('path', { d, fill: 'currentColor' }));
    return n;
  }

  // One voice message plays at a time, as in a messenger.
  let playing = null;

  // ── The speed of a voice message (В7.21) ──
  // One speed for every voice message and audio on this device: the browser keeps it (the Mac app
  // shows this page and keeps it the same way), so it stays after a restart and a new voice message
  // plays at it at once. A press takes the next speed round, as in Telegram and WhatsApp; a hold
  // opens the menu of the speeds — the common menu of a held button (lex-send-later.js, В7.9). The
  // speed changes under the playing sound without a pause, and the voice keeps its pitch. The
  // iPhone has the same speeds and words (LexVoiceSpeeds in ios/Lex/Lex/Parts/StoredFiles.swift).
  const SPEEDS = [1, 1.25, 1.5, 2, 2.5];
  const SPEED_KEY = 'lexVoiceSpeed';
  const speedText = (s) => `${s}×`;
  let speedNow = null;
  let speedHeard = false;
  function voiceSpeed() {
    if (speedNow == null) {
      let v = 1;
      try { v = Number(global.localStorage.getItem(SPEED_KEY)) || 1; } catch (_) { /* no storage: 1× */ }
      speedNow = SPEEDS.includes(v) ? v : 1;
    }
    // Another tab of the page changed it: the rows here show it too.
    if (!speedHeard) {
      speedHeard = true;
      try {
        global.addEventListener('storage', (e) => { if (e.key === SPEED_KEY) { speedNow = null; paintSpeed(); } });
      } catch (_) { /* not a window */ }
    }
    return speedNow;
  }
  // `preservesPitch` is on by itself; it is set here on purpose, so a faster voice never sounds higher.
  function playAt(audio, s) {
    audio.preservesPitch = true;
    if ('webkitPreservesPitch' in audio) audio.webkitPreservesPitch = true;
    audio.defaultPlaybackRate = s;
    audio.playbackRate = s;
  }
  function showSpeed(b, s) {
    b.firstChild.textContent = speedText(s);
    b.setAttribute('aria-label', `Playback speed ${speedText(s)}. Press for the next speed, hold to choose`);
  }
  function paintSpeed() {
    const s = voiceSpeed();
    for (const b of document.querySelectorAll('.lex-voice-speed')) showSpeed(b, s);
    if (playing) playAt(playing, s);
  }
  function setVoiceSpeed(s) {
    if (!SPEEDS.includes(s)) return;
    speedNow = s;
    try { global.localStorage.setItem(SPEED_KEY, String(s)); } catch (_) { /* kept for this page only */ }
    paintSpeed();
  }
  function speedMenu(b) {
    if (b.classList.contains('is-open') || !global.LexSendLater) return;
    if (global.WcHaptics) global.WcHaptics.press();
    const now = voiceSpeed();
    b.classList.add('is-open');
    b.setAttribute('aria-expanded', 'true');
    global.LexSendLater.menu({
      anchor: b, align: 'right', head: 'Playback speed', choice: true,
      items: SPEEDS.map((s) => ({ label: speedText(s), checked: s === now, run: () => setVoiceSpeed(s) })),
      onClose: () => {
        b.classList.remove('is-open');
        b.setAttribute('aria-expanded', 'false');
        // The focus was on an item of the menu, which is gone: back to the button, for the keyboard.
        const f = document.activeElement;
        if (!f || f === document.body) b.focus({ preventScroll: true });
      },
    });
  }
  function speedButton() {
    const b = make('button', 'lex-voice-speed');
    b.type = 'button';
    b.setAttribute('aria-haspopup', 'menu');
    b.setAttribute('aria-expanded', 'false');
    b.appendChild(make('span', 'lex-voice-speed-pill'));
    showSpeed(b, voiceSpeed());
    const hold = global.LexLongPress
      ? global.LexLongPress.attach(b, () => speedMenu(b), { when: () => !!global.LexSendLater })
      : null;
    b.addEventListener('click', () => {
      if (hold && hold.didFire()) return;
      const i = SPEEDS.indexOf(voiceSpeed());
      setVoiceSpeed(SPEEDS[(i + 1) % SPEEDS.length]);
    });
    // The right button of a mouse and the menu key of a keyboard choose too.
    b.addEventListener('contextmenu', (e) => {
      if (!global.LexSendLater) return;
      e.preventDefault();
      speedMenu(b);
    });
    return b;
  }

  function voice(f, io) {
    const root = make('div', 'lex-voice');
    const btn = make('button', 'lex-voice-play');
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Play the voice message');
    btn.appendChild(playIcon(PLAY, 18));
    const track = make('div', 'lex-voice-track');
    const fill = make('div', 'lex-voice-fill');
    track.appendChild(fill);
    const time = make('span', 'lex-voice-time', durationText(f.duration));
    root.append(btn, track, time, speedButton());
    let audio = null;
    let loading = false;
    const show = (on) => {
      btn.replaceChildren(playIcon(on ? PAUSE : PLAY, 18));
      btn.setAttribute('aria-label', on ? 'Pause' : 'Play the voice message');
      root.classList.toggle('is-playing', on);
    };
    const tick = () => {
      if (!audio) return;
      const total = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : Number(f.duration) || 0;
      fill.style.width = total > 0 ? `${Math.min(100, (audio.currentTime / total) * 100)}%` : '0%';
      time.textContent = durationText(audio.currentTime > 0 ? audio.currentTime : f.duration);
    };
    const start = () => {
      if (playing && playing !== audio) playing.pause();
      playing = audio;
      playAt(audio, voiceSpeed());
      audio.play().catch(() => show(false));
    };
    btn.addEventListener('click', () => {
      if (audio) {
        if (audio.paused) start(); else audio.pause();
        return;
      }
      if (loading || !io || typeof io.blob !== 'function') return;
      loading = true;
      root.classList.add('is-loading');
      Promise.resolve(io.blob(f.path)).then((url) => {
        loading = false;
        root.classList.remove('is-loading');
        if (!url) { root.classList.add('is-failed'); return; }
        audio = new Audio(url);
        audio.addEventListener('play', () => show(true));
        audio.addEventListener('pause', () => show(false));
        audio.addEventListener('timeupdate', tick);
        audio.addEventListener('ended', () => { show(false); fill.style.width = '0%'; time.textContent = durationText(f.duration); });
        start();
      }, () => { loading = false; root.classList.remove('is-loading'); root.classList.add('is-failed'); });
    });
    // A press on the line moves the sound to that place.
    track.addEventListener('click', (e) => {
      if (!audio || !Number.isFinite(audio.duration)) return;
      const r = track.getBoundingClientRect();
      if (r.width > 0) audio.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * audio.duration;
      tick();
    });
    return root;
  }

  function video(f, io) {
    const root = make('div', 'lex-video');
    if (f.width > 0 && f.height > 0) root.style.aspectRatio = `${f.width} / ${f.height}`;
    const btn = make('button', 'lex-video-play');
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Play the video');
    btn.appendChild(playIcon(PLAY, 22));
    root.appendChild(btn);
    const meta = [f.duration ? durationText(f.duration) : '', sizeText(f.bytes)].filter(Boolean).join(' · ');
    if (meta) root.appendChild(make('span', 'lex-video-meta', meta));
    let url = null;
    let at = 0;
    const ask = () => {
      if (!io || typeof io.link !== 'function' || Date.now() - at < LINK_FRESH_MS) return Promise.resolve(url);
      at = Date.now();
      return Promise.resolve(io.link(f.path, {})).then((u) => { url = u || url; if (!u) at = 0; return url; }, () => { at = 0; return url; });
    };
    ask();
    btn.addEventListener('click', () => {
      const play = (u) => {
        if (!u) { root.classList.add('is-failed'); return; }
        const v = document.createElement('video');
        v.controls = true;
        v.playsInline = true;
        v.preload = 'metadata';
        v.src = u;
        root.replaceChildren(v);
        root.classList.add('is-on');
        v.play().catch(() => {});
      };
      if (url && Date.now() - at < LINK_FRESH_MS) play(url);
      else ask().then(play);
    });
    return root;
  }

  function fileCard(f, io) {
    const missing = f.missing && MISSING[f.missing];
    const root = make(missing ? 'div' : 'a', `lex-file${missing ? ' is-missing' : ''}`);
    const icon = make('span', 'lex-file-icon');
    const doc = svg('0 0 24 24', 22);
    doc.appendChild(shape('path', { d: 'M6 2.5h8l4.5 4.5v14.5H6z', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linejoin': 'round' }));
    doc.appendChild(shape('path', { d: 'M14 2.5V7h4.5', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linejoin': 'round' }));
    icon.append(doc, make('span', 'lex-file-ext', typeText(f).slice(0, 4)));
    const body = make('span', 'lex-file-body');
    body.appendChild(make('span', 'lex-file-name', f.name || KIND_NAME[f.kind] || typeText(f)));
    body.appendChild(make('span', 'lex-file-meta', missing
      ? [sizeText(f.bytes), missing].filter(Boolean).join(' · ')
      : [typeText(f), sizeText(f.bytes)].filter(Boolean).join(' · ')));
    root.append(icon, body);
    if (!missing) {
      root.setAttribute('aria-label', `Open ${f.name || 'the file'}`);
      // A PDF, a picture and a video open in the browser; anything else is saved under its own name.
      const shows = /^(application\/pdf|image\/|video\/|audio\/|text\/plain)/.test(String(f.mime || ''));
      liveLink(root, f, io, shows ? {} : { download: f.name || '' });
    }
    return root;
  }

  function files(list, io, opts) {
    const items = (Array.isArray(list) ? list : []).filter((f) => f && typeof f === 'object'
      && ((typeof f.path === 'string' && f.path) || (f.missing && MISSING[f.missing])));
    if (!items.length) return null;
    // `free` — the files stand outside a bubble (the person's own message in a chat of Lex, over
    // his bubble at the right edge).
    const root = make('div', `lex-files${opts && opts.free ? ' lex-files-free' : ''}`);
    const shots = items.filter((f) => f.kind === 'image' && f.path && !f.missing);
    if (shots.length) root.appendChild(storedPhotos(shots, io));
    for (const f of items) {
      if (shots.includes(f)) continue;
      if (f.missing) root.appendChild(fileCard(f, io));
      else if (f.kind === 'voice' || f.kind === 'audio') root.appendChild(voice(f, io));
      else if (f.kind === 'video') root.appendChild(video(f, io));
      else root.appendChild(fileCard(f, io));
    }
    return root;
  }

  // ── A file over the composer (В7.49, 2026-11-17) ────────────────────────────
  // The card of a document (В7.21) on the plate of the field, before the message goes: the mark with
  // the extension, the name in one line, under it the type and size — or «Uploading…» while the file
  // goes to the server (the card paler) — and a cross 44 that takes it off. The bytes are not read
  // here: the card is drawn from { name, mime, bytes }.
  function fileChip(f, opts) {
    const o = opts || {};
    const root = make('div', `lex-file-chip${o.busy ? ' is-busy' : ''}`);
    const card = make('div', 'lex-file');
    const icon = make('span', 'lex-file-icon');
    const doc = svg('0 0 24 24', 22);
    doc.appendChild(shape('path', { d: 'M6 2.5h8l4.5 4.5v14.5H6z', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linejoin': 'round' }));
    doc.appendChild(shape('path', { d: 'M14 2.5V7h4.5', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linejoin': 'round' }));
    icon.append(doc, make('span', 'lex-file-ext', typeText(f).slice(0, 4)));
    const body = make('span', 'lex-file-body');
    body.appendChild(make('span', 'lex-file-name', f.name || typeText(f)));
    body.appendChild(make('span', 'lex-file-meta', o.busy
      ? ['Uploading…', sizeText(f.bytes)].filter(Boolean).join(' · ')
      : [typeText(f), sizeText(f.bytes)].filter(Boolean).join(' · ')));
    card.append(icon, body);
    root.appendChild(card);
    if (typeof o.onRemove === 'function') {
      const x = make('button', 'lex-file-chip-x');
      x.type = 'button';
      x.setAttribute('aria-label', `Remove ${f.name || 'the file'}`);
      x.title = 'Remove';
      const cross = svg('0 0 24 24', 18);
      cross.appendChild(shape('path', { d: 'M6 6l12 12M18 6L6 18', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round' }));
      x.appendChild(cross);
      x.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); o.onRemove(); });
      root.appendChild(x);
    }
    return root;
  }

  function notice(o) {
    const root = make('div', 'lex-notice');
    if (o.channel && CHANNELS[o.channel]) {
      const head = make('span', 'lex-notice-from');
      head.append(channel(o.channel), channelName(o.channel));
      root.append(head, document.createTextNode(' · '));
    }
    const body = o.body || global.LexLinks.into(document.createDocumentFragment(), o.text || '');
    root.appendChild(body);
    const time = o.timeText != null ? o.timeText : timeOf(o.at);
    if (time) root.appendChild(make('span', 'lex-notice-time', ` · ${time}`));
    return root;
  }

  // An eye crossed out: what stands here is kept off the screen, or seen by the person alone.
  function eyeOff(size) {
    const n = svg('0 0 24 24', size);
    n.setAttribute('class', 'lex-eye-off');
    for (const d of ['M3 3l18 18', 'M10.6 5.1A9.8 9.8 0 0 1 12 5c6 0 10 7 10 7a17.6 17.6 0 0 1-3.2 3.9',
      'M6.6 6.6C3.7 8.5 2 12 2 12s4 7 10 7a9.6 9.6 0 0 0 5.4-1.6', 'M9.9 9.9a3 3 0 0 0 4.2 4.2']) {
      n.appendChild(shape('path', { d, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    }
    return n;
  }

  // The mark of the model: two stars. It stands at what the person wrote to the model and at
  // the model's answers in a chat of bubbles.
  function sparkle(size) {
    const n = svg('0 0 24 24', size);
    n.setAttribute('class', 'lex-sparkle');
    for (const d of ['M11 3l1.9 5.1L18 10l-5.1 1.9L11 17l-1.9-5.1L4 10l5.1-1.9z', 'M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8z']) {
      n.appendChild(shape('path', { d, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    }
    return n;
  }

  // icon: 'check' — what is folded has nothing wrong (the tasks of «Обращения к базе» without remarks,
  // В7.30): a tick 14 in place of the crossed eye.
  function fold(o) {
    const b = make('button', 'lex-fold');
    b.type = 'button';
    let mark = eyeOff(14);
    if (o.icon === 'check') {
      mark = svg('0 0 24 24', 14);
      mark.setAttribute('class', 'lex-fold-check');
      mark.appendChild(shape('path', { d: CHECK_D[0], fill: 'none', stroke: 'currentColor', 'stroke-width': 2.4,
        'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    }
    b.append(mark, make('span', '', `${o.text} · `), make('span', 'lex-fold-action', o.action));
    if (o.onClick) b.addEventListener('click', o.onClick);
    return b;
  }

  // The talk with Lex in a chat of a person, an order or a group (docs/spec/21-chat-canvas.md, «Разговор с моделью в чате
  // человека»): where its turns are off the screen, one quiet line with how many — never nothing.
  function discussionFold(o) {
    const n = Math.max(0, Number(o && o.count) || 0);
    return fold({ text: `Discussion with Lex · ${n}`, action: o && o.shown ? 'Hide' : 'Show', onClick: o && o.onClick });
  }

  // ── Read more (В7.82, 25.11.2026) ───────────────────────────────────────────
  // A long text stands folded, as in WhatsApp (docs/PLAN-CHAT-UNIFY.md, «Read more»): the first lines, and «… Read more»
  // as a word at the end of the last of them; a press shows it whole, «Read less» at its end folds it back. How many
  // lines — only here (FOLD_LINES): the text of a message, 8; the line «who is this» in the bar over a chat, 3 (the bar
  // stays low). The same numbers on the iPhone: `LexReadMore.lines` (Parts/ReadMore.swift).
  //   readMore(body, { lines: 'text' | 'bar', key, open, onToggle(open), always, end }) → the element
  //   body      the text, a node; its own look stays (`pre-wrap`, Markdown, links)
  //   key       the message the state belongs to (its uid): an unfolded text stays so while the page lives — every
  //             repaint of the chat draws it unfolded again. No key — the node alone keeps it.
  //   open, onToggle — the caller keeps the state itself (a call, whose «Read more» opens the whole call): onToggle
  //             gets the new state and the caller draws again.
  //   always    there is more than these words even when they fit (a call: its detailed summary and transcript):
  //             «Read more» stands at the end of the text anyway.
  //   end       where an inline «Read less» goes (the end of the words; body by default).
  // The word is measured, not guessed: while folded the text is cut at its lines and the word floats into the last
  // of them (the words of that line wrap round it); a text that fits has no word. Without ResizeObserver (a page with
  // no layout) nothing is folded.
  const FOLD_LINES = { text: 8, bar: 3 };
  const unfolded = new Set();
  function readMore(body, o) {
    o = o || {};
    const lines = FOLD_LINES[o.lines] || FOLD_LINES.text;
    const root = make('div', 'lex-more');
    root.style.setProperty('--lex-more-lines', String(lines));
    const box = make('div', 'lex-more-text');
    box.appendChild(body);
    root.appendChild(box);
    const key = o.key != null && o.key !== '' ? String(o.key) : null;
    let open = o.open != null ? !!o.open : !!(key && unfolded.has(key));
    const btn = make('button', 'lex-more-btn');
    btn.type = 'button';
    const end = o.end || body;
    let over = false;
    // The space before an inline word: a line that breaks there starts with the word, not with a gap.
    const gap = document.createTextNode(' ');
    const paint = () => {
      btn.remove();
      gap.remove();
      btn.classList.remove('is-end');
      root.classList.toggle('is-folded', over && !open);
      root.classList.toggle('is-open', open);
      if (over && !open) {
        btn.replaceChildren(make('span', 'lex-more-dots', '…'), document.createTextNode(' Read more'));
        btn.setAttribute('aria-expanded', 'false');
        box.insertBefore(btn, box.firstChild);
      } else if ((over && open) || o.always) {
        btn.textContent = open ? 'Read less' : 'Read more';
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        btn.classList.add('is-end');
        if ((end.textContent || '').trim()) end.appendChild(gap);
        end.appendChild(btn);
      }
    };
    const fit = () => {
      if (!root.isConnected || !root.getClientRects().length) return;
      // Measured without the word and uncut: the text alone says whether it is longer than its lines.
      btn.remove();
      gap.remove();
      root.classList.remove('is-folded');
      const cs = getComputedStyle(body);
      const lh = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) || 15) * 1.35;
      root.style.setProperty('--lex-more-lh', `${lh}px`);
      const top = body.getBoundingClientRect().top;
      const cap = lh * lines;
      over = body.getBoundingClientRect().height > cap + 2;
      // A text of blocks (the digest: a list, a table, paragraphs with room between them) cuts at the bottom of the
      // last whole line under the cap, never through the letters of a line.
      let cut = cap;
      if (over && typeof document.createRange === 'function') {
        const range = document.createRange();
        range.selectNodeContents(body);
        let best = 0;
        for (const r of range.getClientRects()) {
          // A rect of text is its letters; its line is half the leading lower.
          const b = r.bottom - top + Math.max(0, (lh - r.height) / 2);
          if (r.height > 0 && b <= cap + 1 && b > best) best = b;
        }
        if (best > lh) cut = Math.ceil(best);
      }
      root.style.setProperty('--lex-more-max', `${cut}px`);
      paint();
    };
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      open = !open;
      if (key) { if (open) unfolded.add(key); else unfolded.delete(key); }
      if (o.onToggle) o.onToggle(open); else paint();
    });
    // A press on the word is not a press on what holds it (the line «who is this» opens the card).
    btn.addEventListener('pointerdown', (e) => e.stopPropagation());
    paint();
    // Fitted again when the width changes (the window, the text size); its own folding changes only the height.
    let width = -1;
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver((list) => {
        const w = Math.round(list[list.length - 1].contentRect.width);
        if (w === width) return;
        width = w;
        fit();
      }).observe(root);
    }
    return root;
  }

  // ── A call in a chat (В7.42, 2026-11-16) ────────────────────────────────────
  // Gennady's decision on the canvas «Разделы Lex по стандарту», page «Созвоны в чате: утверждено», changed by his word
  // of 24.11.2026: a call stands in the chat as an ordinary message of the other person — a bubble with the short summary
  // (its first sentence, «Созвон в 18:00, 32 минуты.», is written by the model: no duration of ours), folded as any
  // long text (В7.82, 25.11.2026): «Read more» at the end of its words opens it in place — the detailed summary under a
  // line, the transcript under another, «Show the whole transcript», and «Read less» at the end folds it back.
  // The line under the words is the stamp of any message: the mark of the place, «Zoom call», «·», the time the message came. While there
  // is no summary — a ring and «Lex is writing the summary…». A missed call and a call without a recording are a plate
  // (notice, В7.3).
  // o: { channel, at, seconds, state: writing | done | failed | none, short, sections: [{title, items | text}],
  //      lines — how many lines the transcript has, head — its first lines, transcript — all of them once loaded,
  //      open, all — the whole transcript shown, loading, onToggle(open), onAll() }
  function chevronIcon(d, size) {
    const n = svg('0 0 24 24', size);
    n.setAttribute('class', 'lex-call-chevron');
    n.appendChild(shape('path', { d, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round',
      'stroke-linejoin': 'round' }));
    return n;
  }
  // «42 min», «1 h 35 min»; a call shorter than a minute is «1 min».
  function callLength(sec) {
    const m = Math.max(1, Math.round((Number(sec) || 0) / 60));
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
  }
  function callName(id) {
    const c = CHANNELS[id];
    return c ? `${c.name} call` : 'Call';
  }
  function callLine(l) {
    const row = make('div', 'lex-call-tr');
    const top = make('div', 'lex-call-tr-head');
    top.append(make('span', 'lex-call-tr-time', String(l.t || '')), make('span', 'lex-call-tr-who', l.me ? 'You' : String(l.who || '')));
    row.append(top, make('div', 'lex-call-tr-text', String(l.text || '')));
    return row;
  }
  function call(o) {
    const body = make('div', 'lex-call-body');
    const finish = () => {
      const b = bubble({ side: 'in', body, stamp: bubbleStamp(o) });
      b.classList.add('lex-call');
      if (o.open) b.classList.add('is-open');
      b.setAttribute('role', 'article');
      return b;
    };
    if (o.state === 'writing' && !o.short) {
      // While the summary is written the block is only the ring (the board «Другие случаи»).
      const wait = make('div', 'lex-call-wait');
      wait.append(make('span', 'lex-call-ring'), document.createTextNode('Lex is writing the summary…'));
      body.appendChild(wait);
      return finish();
    }
    // The words, and when open the whole call under them, are one text of «Read more» (В7.82): folded — the short
    // summary at its lines with «Read more» at its end, which opens the whole call; open — «Read less» at its end.
    const text = make('div', 'lex-call-all');
    const words = make('div', 'lex-call-short');
    if (o.short) words.appendChild(document.createTextNode(o.short));
    else words.appendChild(make('span', 'lex-call-meta', 'Lex could not write the summary.'));
    text.appendChild(words);
    if (!o.open) {
      body.appendChild(readMore(text, { open: false, always: true, end: words,
        onToggle: (open) => { if (o.onToggle) o.onToggle(open); } }));
      return finish();
    }
    const sections = Array.isArray(o.sections) ? o.sections : [];
    if (sections.length) {
      text.appendChild(make('div', 'lex-call-rule'));
      for (const s of sections) {
        text.appendChild(make('div', 'lex-call-sec', String(s.title || '')));
        if (Array.isArray(s.items) && s.items.length) {
          for (const it of s.items) {
            const row = make('div', 'lex-call-item');
            const dot = make('span', 'lex-call-dot', '•');
            dot.setAttribute('aria-hidden', 'true');
            row.append(dot, make('span', '', String(it)));
            text.appendChild(row);
          }
        } else if (s.text) {
          text.appendChild(make('div', 'lex-call-text', String(s.text)));
        }
      }
    }
    const lines = Array.isArray(o.transcript) ? o.transcript : (Array.isArray(o.head) ? o.head : []);
    if (lines.length || o.lines) {
      text.appendChild(make('div', 'lex-call-rule is-tr'));
      text.appendChild(make('div', 'lex-call-sec is-tr', 'Transcript'));
      const shown = o.all ? lines : lines.slice(0, 3);
      for (const l of shown) text.appendChild(callLine(l));
      const total = Number(o.lines) || lines.length;
      if (!o.all && total > shown.length) {
        // A word as «Read more» is, on a line of its own: the rest of the transcript comes from the server.
        const row = make('div', 'lex-call-all-tr');
        const all = make('button', 'lex-more-btn', o.loading ? 'Loading the transcript…' : 'Show the whole transcript');
        all.type = 'button';
        all.disabled = !!o.loading;
        if (o.onAll) all.addEventListener('click', () => o.onAll());
        row.appendChild(all);
        text.appendChild(row);
      }
    }
    // «Read less» closes the whole call, on a line of its own at the end of it.
    const tail = make('div', 'lex-call-tail');
    text.appendChild(tail);
    body.appendChild(readMore(text, { open: true, always: true, end: tail,
      onToggle: (open) => { if (o.onToggle) o.onToggle(open); } }));
    return finish();
  }
  // The line under the words of a call: «WhatsApp call · 18:00» — the stamp of any message.
  function bubbleStamp(o) {
    return stamp({ channel: o.channel, label: callName(o.channel), at: o.at });
  }

  // ── The message of an order (В7.29) ─────────────────────────────────────────
  // One order — one message, as the bot of Profi writes it in Telegram (Gennady, 14.11.2026, the
  // canvas «New orders: 3 варианта», board 2). The grey part is what the client sent, the blue part
  // what the bot answers; a band in the yellow of «look here» on top when the order waits for a
  // decision the bot is not sure of. A done order stands folded in three lines; the whole of it is the
  // button that opens it. The lane around it is `lex-bubbles` (its colours). What the parts know is
  // given to them: the buttons come made (the main and the second button of the page, В7.6–В7.7), the
  // words of the states are the caller's.
  const ORDER_ICONS = {
    tick: ['M5 12l5 5L20 7'],
    cross: ['M6 6l12 12', 'M18 6L6 18'],
    reply: ['M9 17l-5-5 5-5', 'M20 18v-2a4 4 0 0 0-4-4H4'],
    out: ['M7 17L17 7', 'M8 7h9v9'],
    down: ['M6 9l6 6 6-6'],
    up: ['M18 15l-6-6-6 6'],
  };
  function orderIcon(name, size, width) {
    const n = svg('0 0 24 24', size);
    for (const d of ORDER_ICONS[name] || []) {
      n.appendChild(shape('path', { d, fill: 'none', stroke: 'currentColor', 'stroke-width': width || 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    }
    return n;
  }
  // The question in a circle of the band «Not sure».
  function askIcon() {
    const n = svg('0 0 24 24', 18);
    n.append(shape('circle', { cx: 12, cy: 12, r: 9, fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }));
    for (const d of ['M9.6 9.2a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.4v.6', 'M12 16.8h.01']) {
      n.appendChild(shape('path', { d, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    }
    return n;
  }
  // «<client> · <budget> · <what the reply costs>»: what is missing is left out (the cost — Gennady,
  // 18.11.2026: «Комиссия 130 ₽», «Оплата 31 ₽», «Цена отклика — в форме»).
  const orderWho = (o) => [o.client, o.budget, o.pay].map((x) => String(x || '').trim()).filter(Boolean).join(' · ');
  // What Copy of the menu of an order takes (the same o as order()): the title, «client · budget · what the reply costs»,
  // what the order is, its text and blocks, the line when it was left, the reply of the bot — an empty line between. The
  // iPhone takes the same (LexOrderMessage.copyWords).
  function orderWords(o) {
    const parts = [o.title, orderWho(o), o.facts, o.text];
    for (const sec of (Array.isArray(o.sections) ? o.sections : [])) {
      if (!sec || (Array.isArray(sec.links) && sec.links.some((l) => l && l.url))) continue;
      parts.push([sec.title, sec.text].map((x) => String(x || '').trim()).filter(Boolean).join('\n'));
    }
    parts.push(o.note, o.reply);
    return parts.map((x) => String(x || '').trim()).filter(Boolean).join('\n\n');
  }

  // order({ order, title, url, at | timeText, client, budget, pay, links, facts, text, sections, note, fold, side,
  //         reply, state, foot, ask, folded, onOpen, onFold })
  //   links   [{ text, url }] — after «client · budget» on the same line («Chat on Profi»), each a link of its own
  //   facts   one line 13 under it (what the order is: «Оплата 64 ₽ · Дистанционно · Санкт-Петербург»)
  //   sections [{ title, text, links: [{ name, url }] }] — the blocks of the order as Profi shows them: a title 13/600
  //           and its text (or its files, each name a link), after `text`
  //   note    the last line 12 (when the order was left, its reviews: the server's words)
  //   fold    a key: the text and the blocks fold at their lines (Read more, В7.82) under this key
  //   side    'in' — the first message of the client in an order chat (25.11.2026): as wide as a bubble of the
  //           other person, not the whole lane
  //   pay     what the reply costs, after the client and the budget
  //   state   { text, icon: 'tick' | 'cross' | 'reply' | null, danger } — on the right above the reply
  //           (no word «Reply» — Gennady, 18.11.2026): the price before the reply leaves, how it ended after
  //   foot    the row of buttons, made by the caller
  //   ask     { title, text } — the band on top
  //   folded  true — the three lines; onOpen() — a press on them; onFold() — the chevron up of a
  //           done order shown whole (none — no chevron)
  // A link inside the grey part of an order: «Chat on Profi», a file of the order — opens in a new tab.
  function orderLink(text, url) {
    const a = make('a', 'lex-order-link', text || '');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  }
  function order(o) {
    const time = o.timeText != null ? o.timeText : timeOf(o.at);
    const who = orderWho(o);
    const st = o.state || {};
    if (o.folded) {
      const b = make('button', 'lex-order is-folded');
      b.type = 'button';
      b.setAttribute('aria-expanded', 'false');
      b.setAttribute('aria-label', `${[o.title, o.client].filter(Boolean).join(', ')}. ${st.text || ''} Show the order`.replace(/\s+/g, ' ').trim());
      if (o.order != null) b.dataset.order = o.order;
      const head = make('span', 'lex-order-head');
      head.append(make('span', 'lex-order-title', o.title || ''), make('span', 'lex-order-time', time));
      b.appendChild(head);
      if (who) b.appendChild(make('span', 'lex-order-who', who));
      const end = make('span', 'lex-order-end');
      if (st.icon) end.appendChild(orderIcon(st.icon, 14, 2.4));
      end.append(make('span', '', st.text || ''), orderIcon('down', 16));
      b.appendChild(end);
      if (o.onOpen) b.addEventListener('click', o.onOpen);
      return b;
    }
    const root = make('article', `lex-order${o.side === 'in' ? ' is-in' : ''}`);
    if (o.order != null) root.dataset.order = o.order;
    if (o.ask) {
      const band = make('div', 'lex-order-ask');
      band.setAttribute('role', 'note');
      const words = make('div', '');
      words.append(make('div', 'lex-order-ask-title', o.ask.title || ''), make('div', 'lex-order-ask-text', o.ask.text || ''));
      band.append(askIcon(), words);
      root.appendChild(band);
    }
    const inPart = make('div', 'lex-order-in');
    const head = make('div', 'lex-order-head');
    let title;
    if (o.url) {
      title = make('a', 'lex-order-title', o.title || '');
      title.href = o.url;
      title.target = '_blank';
      title.rel = 'noopener noreferrer';
      title.setAttribute('aria-label', `${o.title || 'The order'}. Open the order on Profi`);
      title.appendChild(orderIcon('out', 14, 2.4));
    } else {
      title = make('span', 'lex-order-title', o.title || '');
    }
    head.append(title, make('span', 'lex-order-time', time));
    if (o.onFold) {
      const fold = make('button', 'lex-order-fold');
      fold.type = 'button';
      fold.setAttribute('aria-expanded', 'true');
      fold.setAttribute('aria-label', 'Fold the order');
      fold.title = 'Fold the order';
      fold.appendChild(orderIcon('up', 16));
      fold.addEventListener('click', o.onFold);
      head.appendChild(fold);
    }
    inPart.appendChild(head);
    const links = (Array.isArray(o.links) ? o.links : []).filter((l) => l && l.url);
    if (who || links.length) {
      const line = make('div', 'lex-order-who', who);
      for (const l of links) {
        if (line.childNodes.length) line.appendChild(document.createTextNode(' · '));
        line.appendChild(orderLink(l.text, l.url));
      }
      inPart.appendChild(line);
    }
    if (o.facts) inPart.appendChild(make('div', 'lex-order-facts', o.facts));
    const fold = o.fold != null && o.fold !== '' ? String(o.fold) : null;
    const folded = (node, i) => (fold ? readMore(node, { key: `${fold}:${i}` }) : node);
    if (o.text) inPart.appendChild(folded(make('div', 'lex-order-text', o.text), 'text'));
    (Array.isArray(o.sections) ? o.sections : []).forEach((sec, i) => {
      if (!sec) return;
      if (sec.title) inPart.appendChild(make('div', 'lex-order-sec', String(sec.title)));
      const files = (Array.isArray(sec.links) ? sec.links : []).filter((l) => l && l.url);
      if (files.length) {
        const box = make('div', 'lex-order-files');
        for (const l of files) box.appendChild(orderLink(String(l.name || 'File'), l.url));
        inPart.appendChild(box);
      } else if (sec.text) {
        inPart.appendChild(folded(make('div', 'lex-order-text is-sec', String(sec.text)), i));
      }
    });
    if (o.note) inPart.appendChild(make('div', 'lex-order-note', o.note));
    root.appendChild(inPart);
    if (o.reply || o.foot) {
      const out = make('div', 'lex-order-out');
      if (st.text || st.icon) {
        const meta = make('div', 'lex-order-meta');
        const state = make('span', `lex-order-meta-state${st.danger ? ' is-danger' : ''}`);
        if (st.icon) state.appendChild(orderIcon(st.icon, 14, 2.4));
        state.appendChild(make('span', '', st.text || ''));
        meta.appendChild(state);
        out.appendChild(meta);
      }
      if (o.reply) out.appendChild(make('div', 'lex-order-reply', o.reply));
      if (o.foot) out.appendChild(o.foot);
      root.appendChild(out);
    }
    return root;
  }

  // Cancel with the countdown on it (В7.29): «Cancel» on the left, the seconds on the right, under
  // them a ground of --danger that melts from the right as the time goes. button — a button of the
  // caller (the second button with the words in --danger); set(left, share) — the seconds left and
  // the share of the time left, 0…1.
  function countdown(button) {
    button.classList.add('lex-order-countdown');
    const fill = make('span', 'lex-order-countdown-fill');
    fill.setAttribute('aria-hidden', 'true');
    const word = make('span', '', button.textContent || 'Cancel');
    const left = make('span', 'lex-order-countdown-left', '');
    left.setAttribute('aria-hidden', 'true');
    button.replaceChildren(fill, word, left);
    const set = (secs, share) => {
      const s = Math.max(0, Math.ceil(secs));
      left.textContent = `${s} s`;
      fill.style.width = `${Math.round(Math.max(0, Math.min(1, share)) * 1000) / 10}%`;
      button.setAttribute('aria-label', `${word.textContent}. The reply leaves in ${s} s`);
    };
    return { set };
  }

  // The photo or the letter of a person (В7.12, 2026-11-16): the photo the server keeps of the person
  // (taken in Telegram, WhatsApp, Max or on Profi.ru; the database chooses one) in a circle; until it
  // came, and when there is none, the first letter of the name on one of seven colours — the same name
  // always gets the same colour. One part everywhere: the line of a chat 48, the bar over a chat 40,
  // a line of the message of «Кто это» 36, the card of a person 96. The photo is a stored file (chat-files/…), fetched by the page's io as the
  // files of a message are; a photo once fetched stands at once in every new copy of the part, so a
  // list painted anew does not blink through the letters.
  const AVATAR_COLORS = ['#A85F2C', '#2F7D6D', '#3F6CB3', '#8A4FA8', '#A8433F', '#4F8A3A', '#9A7A22'];
  const AVATAR_SIZES = [36, 40, 48, 96];
  const avatarUrls = new Map();   // path of a photo → its object URL, once fetched
  function avatarSize(n, size) {
    const s = Number(size) || 40;
    if (s !== 40 && AVATAR_SIZES.includes(s)) n.classList.add(`is-${s}`);
  }
  function avatar(name, o) {
    const opt = o || {};
    const s = String(name || '').trim();
    let h = 0;
    for (const ch of s) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    const n = make('span', 'lex-avatar', s ? [...s][0].toUpperCase() : '?');
    n.style.background = AVATAR_COLORS[h % AVATAR_COLORS.length];
    n.setAttribute('aria-hidden', 'true');
    avatarSize(n, opt.size);
    const path = typeof opt.photo === 'string' && opt.photo.indexOf('chat-files/') === 0 ? opt.photo : '';
    if (!path || !opt.io || typeof opt.io.blob !== 'function') return n;
    n.dataset.photo = path;
    const img = document.createElement('img');
    img.alt = '';
    img.decoding = 'async';
    img.addEventListener('load', () => n.classList.add('has-photo'));
    img.addEventListener('error', () => { n.classList.remove('has-photo'); img.remove(); });
    n.appendChild(img);
    const known = avatarUrls.get(path);
    if (known) {
      img.src = known;
      n.classList.add('has-photo');
      return n;
    }
    Promise.resolve(opt.io.blob(path)).then((url) => {
      if (!url) { img.remove(); return; }
      avatarUrls.set(path, url);
      img.src = url;
    }, () => img.remove());
    return n;
  }
  // A channel in place of a person (the line of New orders): the mark of the channel 28 on a round
  // ground --bg-hover, the same circle as a person's.
  function avatarMark(id, size) {
    const n = make('span', 'lex-avatar is-mark');
    n.setAttribute('aria-hidden', 'true');
    avatarSize(n, size);
    const m = channel(id);
    if (m) n.appendChild(m);
    return n;
  }

  // The Lex mark in place of a person (the line of the bot's service chat): the mark 26 high on the round
  // ground --bg-hover, as the mark of a channel is. The letter L stands in if the mark's file is not loaded.
  function avatarBrand(size) {
    const n = make('span', 'lex-avatar is-mark is-brand');
    n.setAttribute('aria-hidden', 'true');
    avatarSize(n, size);
    if (global.LexBrandMark && typeof global.LexBrandMark.svgMarkup === 'function') {
      n.insertAdjacentHTML('beforeend', global.LexBrandMark.svgMarkup(26));
    } else {
      n.textContent = 'L';
    }
    return n;
  }

  // ── Buttons (В7.6, В7.7) ─────────────────────────────────────────────────────
  // The main button — the colour of the main action (--accent), one in a row; the second — the
  // ground of a hover (--bg-hover). 44 high, radius 12, 15/650. `left` — the words at the left and
  // the height growing with them: a variant of a question. `note` — a second line 12/400 under the
  // words («Extended Mind thinks so»).
  function button(o) {
    const b = make('button', `lex-btn${o.main ? ' is-main' : ''}${o.left ? ' is-left' : ''}${o.icon || o.trail ? ' has-icon' : ''}`);
    b.type = 'button';
    // `icon` — a mark 16 before the words, through 8: the arrow of a reply on «Reply» (В7.37); `trail` — a
    // mark after the words (a chevron).
    if (o.icon) b.appendChild(o.icon);
    b.appendChild(make('span', 'lex-btn-words', o.label || ''));
    if (o.note) b.appendChild(make('span', 'lex-btn-note', o.note));
    if (o.trail) b.appendChild(o.trail);
    return b;
  }

  // ── Stop of a development task (В7.77, 2026-11-23) ───────────────────────────
  // A row mac:<N> of a chat of Lex is the work of Claude Code on a task from this chat — in the cloud or on the Mac
  // (supabase/migrations/dev_tasks.sql). While it runs (state «streaming») it has Stop under its words, on every
  // surface; the press asks the database (lex_dev_stop), and the cloud or the Mac stops before its next step.
  function devTaskOf(uid, state) {
    const m = /^mac:(\d+)$/.exec(String(uid || ''));
    return m && state === 'streaming' ? Number(m[1]) : null;
  }
  // Is a development task of these turns still running? A chat whose copy on the device equals the server's read stays
  // as the copy drew it — and a copy draws no Stop; such a chat is drawn again from the read (wc-app.js
  // openConversation; 24.11.2026: the second opening of a chat on the same device showed its running task without Stop).
  function devTaskRunning(turns) {
    return (Array.isArray(turns) ? turns : []).some((t) => !!t && devTaskOf(t.uid, t.state) !== null);
  }
  function taskStop(o) {
    const wrap = make('div', 'lex-task-stop');
    const mark = svg('0 0 24 24', 16);
    mark.appendChild(shape('path', { d: 'M7 7h10v10H7z', fill: 'currentColor' }));   // the square of Stop, as in the field
    const b = button({ label: 'Stop', icon: mark });
    b.classList.add('lex-task-stop-btn');
    b.setAttribute('aria-label', 'Stop the task');
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (b.disabled) return;
      b.disabled = true;
      b.classList.add('is-busy');
      why.hidden = true;
      Promise.resolve().then(() => o.onStop()).then(() => { wrap.hidden = true; }, (err) => {
        b.disabled = false;
        b.classList.remove('is-busy');
        // The refusal in words under the button: the same on every surface, no toast needed.
        const said = /"message"\s*:\s*"([^"]+)"/.exec(String((err && err.message) || ''));
        why.textContent = 'Not stopped. ' + (said ? said[1] : ((err && err.message) || 'no answer'));
        why.hidden = false;
      });
    });
    const why = make('div', 'lex-task-stop-why');
    why.hidden = true;
    wrap.append(b, why);
    return wrap;
  }

  // ── «Who is this» under the bar of a chat (В7.52, 2026-11-20) ────────────────
  // One or two phrases about the person the chat is with — his post, his company, what he does, where he came
  // from. The database of Lex writes them (the cards of people kept up to date after a message and a call); the
  // part shows them as they came: 13 `--fg-muted`, three lines, then «… Read more» (В7.82). It stands under the bar
  // of the chat on a line of its own, as wide as the thread, and does not scroll with it; no words — no line (the
  // caller draws nothing: null). `onOpen` — a press opens the card of the person (an order chat, В7.41): the line
  // is then a button with a zone of 44. The card shows the same words whole as its first block (lex-person.js).
  function brief(text, o) {
    const words = String(text == null ? '' : text).trim();
    if (!words) return null;
    const open = o && o.onOpen;
    // The words fold at three lines with «Read more» at their end (В7.82, 25.11.2026): a press on the word shows them
    // whole in the bar, anywhere else on the line — the card. The line is a press face then, not a <button>: the word
    // inside it is a button of its own.
    const n = open ? pressFace('div', 'lex-brief') : make('div', 'lex-brief');
    if (open) {
      n.setAttribute('aria-label', words + '. Open the card of the person');
      n.addEventListener('click', open);
    }
    n.title = words;
    n.appendChild(readMore(make('div', 'lex-brief-words', words), { lines: 'bar', key: `brief:${words}` }));
    return n;
  }

  // ── A message that was not sent (В7.47, 2026-11-16) ─────────────────────────
  // The person sent a word to Lex and Lex did not take it: no connection, not enough money, the server
  // busy, the model refused before its first word. As in ChatGPT and Telegram the message stays in the
  // chat as the person's own bubble; this note stands under it, at its right edge:
  //   - a line 13: the alert mark 14 and «Not sent» 600 in the red of errors, then «· <the reason>» in
  //     grey. With the numbers of a refusal for money the reason says what is needed and what there is
  //     (the words of lex-billing-gate.js); without them it is the caller's phrase;
  //   - 6 under it the buttons of their own width, 6 apart, at the right: «Top up» — the main button,
  //     only when the reason is money; «Retry» — the main button, the second one by «Top up»; «⋯» with
  //     «Edit» (the text back into the message box) and «Delete» (red, asks first).
  // While a retry is on its way the line says «Sending…» in grey, a ring turns on Retry, every button
  // is off (0.5). The caller puts the class `lex-unsent` on the person's row: the note goes under the
  // bubble, not beside it; the bubble keeps its look — the person's words stay as they were written.
  //   unsent({ note, money, gateRaw, sending, retryHold, onRetry, onTopUp, onEdit, onDelete }) → the element;
  //   el.update(o) redraws it in place (the options not given stay as they were). One part for every
  //   chat (17.11.2026): a word to Lex in the main chat, a text to a person in a chat of a folder (Retry)
  //   and in an order chat (retryHold: «Hold to retry»). No onEdit — no «Edit» in «⋯»; no onRetry — no
  //   Retry.
  const ALERT_D = ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 7.5v5', 'M12 16.5v.01'];
  function unsentWhy(o) {
    const gate = global.LexBillingGate;
    if (o.money && o.gateRaw && gate && typeof gate.message === 'function') {
      const words = gate.message(o.gateRaw);
      // No numbers in the refusal: the gate says only «Please top up», the caller's phrase says more.
      if (words && words !== gate.message(null)) return words;
    }
    return o.note || '';
  }
  function unsent(opts) {
    const root = make('div', 'lex-unsent-note');
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', 'Not sent');
    let o = Object.assign({}, opts);
    const run = (name) => () => { if (!o.sending && typeof o[name] === 'function') o[name](); };
    const ask = async () => {
      if (o.sending || typeof o.onDelete !== 'function') return;
      const ui = global.WcUI;
      if (ui && typeof ui.confirm === 'function') {
        const yes = await ui.confirm('Delete this message?', 'It was not sent. Its words will be gone from the chat.',
          { okText: 'Delete', danger: true });
        if (!yes) return;
      }
      o.onDelete();
    };
    const paint = () => {
      const line = make('div', `lex-unsent-line${o.sending ? ' is-sending' : ''}`);
      line.setAttribute('role', 'status');
      if (o.sending) line.textContent = 'Sending…';
      else {
        const mark = strokes(ALERT_D, 14);
        mark.setAttribute('class', 'lex-unsent-mark');
        mark.setAttribute('aria-hidden', 'true');
        line.append(mark, make('span', 'lex-unsent-word', 'Not sent'));
        const why = unsentWhy(o);
        if (why) line.append(make('span', 'lex-unsent-why', ` · ${why}`));
      }
      const acts = make('div', 'lex-unsent-acts');
      if (o.money) {
        const top = button({ label: 'Top up', main: true });
        top.disabled = !!o.sending;
        top.addEventListener('click', run('onTopUp'));
        acts.appendChild(top);
      }
      // retryHold — a text to a person in an order chat: there a tap sends nothing to the client (В7.23),
      // so «Hold to retry» goes by a hold only, as «Hold to send» does.
      const retry = button({ label: o.retryHold ? 'Hold to retry' : 'Retry', main: !o.money });
      retry.disabled = !!o.sending;
      if (o.sending) retry.classList.add('is-busy');
      const fire = () => {
        if (o.sending || typeof o.onRetry !== 'function') return;
        // A retry is a sending, as by the arrow of the field.
        if (global.WcHaptics) global.WcHaptics[o.retryHold ? 'press' : 'tap']();
        o.onRetry();
      };
      if (o.retryHold && global.LexLongPress) {
        global.LexLongPress.attach(retry, fire, { when: () => !retry.disabled });
        retry.addEventListener('click', (e) => { e.preventDefault(); });
      } else {
        retry.addEventListener('click', fire);
      }
      // No onRetry — no Retry: the place it went to did not say a second sending is safe.
      if (typeof o.onRetry === 'function') acts.appendChild(retry);
      const more = moreMenu(() => (o.sending ? [] : [
        ...(typeof o.onEdit === 'function' ? [{ label: 'Edit', icon: 'pencil', run: run('onEdit') }] : []),
        { label: 'Delete', icon: 'trash', danger: true, run: ask },
      ]));
      more.more.disabled = !!o.sending;
      acts.appendChild(more.more);
      root.replaceChildren(line, acts);
    };
    root.update = (next) => { o = Object.assign({}, o, next); paint(); };
    paint();
    return root;
  }

  // ── A question of the database (В7.24) ──────────────────────────────────────
  // One message: the bubble of the other side across the whole lane, the question's words, its
  // variants under them — the one the database thinks right is the main button with «Extended Mind
  // thinks so», the others are second buttons; the variant «Пропустить» is a quiet button at the left
  // of the bottom line, the time at its right. Answered or withdrawn — one line of the question, under
  // it what was answered; a press unfolds it in place.
  const CHECK_D = ['M5 12l5 5L20 7'];
  const DOWN_D = ['M6 9l6 6 6-6'];
  const UP_D = ['M6 15l6-6 6 6'];
  const REPLY_D = ['M9 14L4 9l5-5', 'M4 9h10.5a5.5 5.5 0 0 1 0 11H11'];
  const CLOSE_D = ['M6 6l12 12', 'M18 6L6 18'];

  function pendingNote(pending) {
    if (!pending) return null;
    const n = make('div', `lex-q-note${pending.error ? ' is-error' : ''}`,
      pending.error ? `Not recorded: ${pending.error}` : pending.sent ? 'Sent to Extended Mind. Waiting for it to record…' : 'Sending…');
    return n;
  }

  // The variants of a waiting question: a column of buttons; the quiet «Пропустить» goes apart.
  function choices(v, pending, onChoice) {
    const box = make('div', 'lex-q-choices');
    let quiet = null;
    const busy = !!(pending && !pending.error);
    (v.choices || []).forEach((c, i) => {
      if (c.quiet) { quiet = { c, i }; return; }
      const b = button({ label: c.label, note: c.suggested ? 'Extended Mind thinks so' : null, main: !!c.suggested, left: true });
      if (busy && pending.choice === i) b.classList.add('is-busy');
      b.disabled = busy;
      b.addEventListener('click', () => onChoice && onChoice(i));
      box.appendChild(b);
    });
    return { box, quiet, busy };
  }

  function questionFoot(at, quiet, busy, pending, onChoice) {
    const foot = make('div', `lex-q-foot${quiet ? ' has-quiet' : ''}`);
    if (quiet) {
      const q = make('button', 'lex-q-quiet', quiet.c.label);
      q.type = 'button';
      if (busy && pending.choice === quiet.i) q.classList.add('is-busy');
      q.disabled = busy;
      q.addEventListener('click', () => onChoice && onChoice(quiet.i));
      foot.appendChild(q);
    }
    foot.appendChild(make('span', 'lex-q-time', timeOf(at)));
    return foot;
  }

  function question(v, o) {
    o = o || {};
    if (!v || v.state !== 'open') return doneQuestion(v || {}, o);
    const root = make('div', 'lex-q is-open');
    const text = global.LexLinks.into(make('div', 'lex-q-text'), v.text || '');
    root.appendChild(text);
    const { box, quiet, busy } = choices(v, o.pending, o.onChoice);
    if (box.childElementCount) root.appendChild(box);
    const note = pendingNote(o.pending);
    if (note) root.appendChild(note);
    root.appendChild(questionFoot(o.at, quiet, busy, o.pending, o.onChoice));
    if (quiet) root.classList.add('has-quiet');
    return root;
  }

  // «Answered: <the answer in the words of its variant>», «Withdrawn: <why>».
  function doneLine(v) {
    if (v.state === 'withdrawn') return v.reason ? `Withdrawn: ${v.reason}` : 'Withdrawn';
    const c = (v.choices || []).find((x) => v.answer && String(x.answer).toLowerCase() === String(v.answer).toLowerCase());
    const said = c ? c.label : v.answer;
    return said ? `Answered: ${said}` : 'Answered';
  }

  function doneQuestion(v, o) {
    const open = !!o.open;
    const root = open ? make('div', `lex-q is-done is-unfolded`) : pressFace('div', 'lex-q is-done');
    if (!open) {
      root.setAttribute('aria-expanded', 'false');
      root.setAttribute('aria-label', `${v.state === 'withdrawn' ? 'Withdrawn' : 'Answered'} question. Show it`);
    }
    const head = make('span', 'lex-q-head');
    head.append(make('span', open ? 'lex-q-text' : 'lex-q-line', v.text || ''), make('span', 'lex-q-time', timeOf(o.at)));
    const state = make(open ? 'button' : 'span', 'lex-q-state');
    if (open) {
      state.type = 'button';
      state.setAttribute('aria-expanded', 'true');
    }
    state.append(strokes(CHECK_D, 14), make('span', 'lex-q-state-words', doneLine(v)), strokes(open ? UP_D : DOWN_D, 16));
    root.append(head, state);
    (open ? state : root).addEventListener('click', () => o.onToggle && o.onToggle());
    return root;
  }

  // ── The message of the agent «Кто это» (В7.50, В7.54) ──────────────────────────────────────────────────
  // Gennady's decision of 19.11.2026: the messages of a person the database does not know stand in his chat at once,
  // and the agent «Кто это» writes in that chat as Lex. Gennady's decision of 21.11.2026: no buttons under it — he tells
  // the agent in words; the message shows the whole situation — who writes, whom the agent takes him for (with a link),
  // what the agent waits for — and is an ordinary message of the other side, as in Telegram (boards WhoisW1, WhoisW2).
  //
  // whois({ message: true, …}) — the message of the agent in a chat of a person, a group, an order, a new person: the
  // bubble of the other side (`--lex-bubble-in`, 18 18 18 6, inside 8 12 6, 86 % of the lane), from top to bottom:
  //   the mark — the sparkle 14, «Lex», and through «·» what it is (`mark`: «присоединил сам», «привязал сам», «нужен
  //   твой ответ»), 12/600, `--attention` when it waits for a word of Gennady (`wait`), `--fg` else, 4 to the words;
  //   an attach of the agent that still stands (`attention`, 25.11.2026: «ярко, жёлтым — чтобы я увидел, что он
  //   соединил») — the mark `--attention`, the bubble on `--attention-wash` over `--lex-bubble-in` with a rim 2
  //   `--attention`;
  //   the conclusion (`headline`) 16/650; the lines (`rows`: [{ caption, name, sub, face: { name, photo, deal },
  //   href | onPress }]) through 6 at 8 — the face 36, the caption 12 `--fg-muted`, the name 15/600, the second line 13
  //   `--fg-muted`, a chevron 16 where the line opens something (`href` — a site in a new tab, `onPress` — a place of
  //   Lex), on `--bg-raised`, radius 12, at least 52 high; the words (`body`) at 8 — 15 `--fg-soft` under a conclusion,
  //   15 `--fg` without one (an old turn); over a line `--line`, at 8, the last — what the agent waits for (`ask`) 15
  //   `--fg`; a word the server refused (`note`: { error }) 13 `--danger`; the time 12 at the right foot.
  // An old turn (no headline, no lines) is the same bubble with «Lex» and its words. No buttons at all.
  // whois({ body | text, at, onGo }) without `message` — a word of an agent of the base in its task chat (the section
  // «Agents», 21.11.2026): the bubble of a question across the lane with the sparkle and «Lex» over the words.
  // whois({ task: true, author, body | text, at, onGo }) — the same word under the agent's name with no bubble (boards
  // AgChat, AgChatWaiting, 22.11.2026), as an answer of the model: no ground; the mark 12/600 `--fg-muted` — the sparkle
  // 14 and the name through 6; 4 below the words (Markdown, 15); 4 below them the time 12 `--fg-muted` on the left. A
  // blank `author` — the bubble with «Lex». Whether it waits for Gennady the head of the chat says, not the word.
  // onGo(place) — a press on a link of Lex inside the words (lex://…, drawn with data-lex-go): the screen opens it.
  function whoisGo(text, onGo) {
    if (typeof onGo !== 'function') return;
    text.addEventListener('click', (e) => {
      const a = e.target && e.target.closest ? e.target.closest('a[data-lex-go]') : null;
      if (!a || !text.contains(a)) return;
      e.preventDefault();
      onGo(a.dataset.lexGo);
    });
  }
  function whoisWords(o) {
    let text = o.body;
    if (!text) { text = make('div', '', ''); text.textContent = o.text || ''; }
    text.classList.add('lex-q-text');
    whoisGo(text, o.onGo);
    return text;
  }
  // One line of the message: the face, the caption, the name, the second line; a link where it opens something.
  function whoisRow(r) {
    const link = !!(r.href || typeof r.onPress === 'function');
    const row = make(link ? 'a' : 'div', `lex-whois-row${link ? ' is-link' : ''}`);
    if (r.href) {
      row.href = r.href;
      row.target = '_blank';
      row.rel = 'noopener noreferrer';
    } else if (link) {
      row.href = '#';
      row.addEventListener('click', (e) => { e.preventDefault(); r.onPress(); });
    }
    const f = r.face || {};
    const face = avatar(f.name || r.name, { size: 36, photo: f.photo, io: f.io });
    if (f.square) face.classList.add('is-square');
    if (f.deal) face.classList.add('is-square', 'is-deal');
    const words = make('span', 'lex-whois-row-words');
    words.appendChild(make('span', 'lex-whois-row-caption', r.caption || ''));
    words.appendChild(make('span', 'lex-whois-row-name', r.name || ''));
    if (r.sub) words.appendChild(make('span', 'lex-whois-row-sub', r.sub));
    row.append(face, words);
    if (link) {
      const go = chevronIcon('M9 6l6 6-6 6', 16);
      go.setAttribute('class', 'lex-whois-row-go');
      row.appendChild(go);
    }
    row.setAttribute('aria-label', [r.caption, r.name, r.sub].filter(Boolean).join(', '));
    return row;
  }
  function whois(o) {
    o = o || {};
    const author = String(o.author || '').trim();
    if (!o.message && o.task && author) {
      // a word of an agent in its task chat under its name: no bubble, the time on the left under the words
      const root = make('div', 'lex-whois-agent');
      root.setAttribute('role', 'article');
      const head = make('div', 'lex-whois-agent-head');
      head.append(sparkle(14), make('span', 'lex-whois-agent-name', author));
      const time = make('div', 'lex-whois-agent-time', timeOf(o.at));
      root.append(head, whoisWords(o), time);
      return root;
    }
    if (!o.message) {
      // a word of an agent in its task chat: the bubble of a question with the mark of Lex over the words
      const root = make('div', 'lex-q lex-whois is-open');
      const head = make('div', 'lex-whois-head');
      head.append(sparkle(14), make('span', 'lex-whois-name', 'Lex'));
      root.append(head, whoisWords(o), questionFoot(o.at, null, false, null, null));
      return root;
    }
    const lit = !o.wait && !!o.attention;
    const root = make('div', `lex-whois-msg${o.wait ? ' is-wait' : lit ? ' is-attention' : o.mark ? '' : ' is-plain'}`);
    root.setAttribute('role', 'article');
    const mark = make('div', 'lex-whois-mark');
    mark.append(sparkle(14), make('span', '', 'Lex'));
    if (o.mark) mark.append(make('span', '', '·'), make('span', '', String(o.mark)));
    root.appendChild(mark);
    const headline = String(o.headline || '').trim();
    if (headline) root.appendChild(make('div', 'lex-whois-headline', headline));
    const rows = (o.rows || []).filter((r) => r && r.name);
    if (rows.length) {
      const box = make('div', 'lex-whois-rows');
      for (const r of rows) box.appendChild(whoisRow(r));
      root.appendChild(box);
    }
    const text = whoisWords(o);
    if (String(text.textContent || '').trim()) {
      if (headline) text.classList.add('is-why');
      root.appendChild(text);
    }
    const ask = String(o.ask || '').trim();
    if (ask) root.appendChild(make('div', 'lex-whois-ask', ask));
    if (o.note && o.note.error) {
      const note = make('div', 'lex-whois-note', `Не отправлено: ${o.note.error}`);
      note.setAttribute('role', 'status');
      root.appendChild(note);
    }
    const foot = make('div', 'lex-whois-foot');
    foot.appendChild(make('span', 'lex-q-time', timeOf(o.at)));
    root.appendChild(foot);
    return root;
  }

  // ── A pack of questions (В7.25) ─────────────────────────────────────────────
  // The waiting questions the server put in one group (the same variants, the same one the database
  // thinks right) stand as one message: what they share as the title, a row per question with what it
  // says of its own, the first three rows and «N more», one button that answers every question with
  // its variant of the pack, and «One by one», which lays them out as single questions. The words
  // come from the questions themselves: the words all of them start and end with make the title, the
  // words between are the row.
  const words = (t) => String(t || '').split('\n')[0].trim().split(/\s+/).filter(Boolean);
  function packSplit(members) {
    const ws = members.map((m) => words(m.view && m.view.text));
    const min = Math.min(...ws.map((w) => w.length));
    let head = 0;
    while (head < min - 1 && ws.every((w) => w[head] === ws[0][head])) head++;
    let tail = 0;
    while (head + tail < min - 1 && ws.every((w) => w[w.length - 1 - tail] === ws[0][ws[0].length - 1 - tail])) tail++;
    return { ws, head, tail };
  }
  // The same words in every question (one question asked again): the title is the question, the rows
  // are what each says beyond its first line.
  const sameWords = (ws) => ws.every((w) => w.join(' ') === ws[0].join(' '));
  function packTitle(members) {
    const { ws, head, tail } = packSplit(members);
    if (sameWords(ws)) return `${members.length} questions: ${ws[0].join(' ')}`;
    const frame = [ws[0].slice(0, head).join(' '), '…', ws[0].slice(ws[0].length - tail).join(' ')].filter(Boolean).join(' ');
    return head || tail ? `${members.length} questions: ${frame}` : `${members.length} questions with the same answers`;
  }
  function packRows(members) {
    const { ws, head, tail } = packSplit(members);
    if (sameWords(ws)) {
      return members.map((m) => String((m.view && m.view.text) || '').split('\n').slice(1).join(' ').trim() || ws[0].join(' '));
    }
    return ws.map((w) => w.slice(head, w.length - tail).join(' '));
  }
  const ROWS_SHOWN = 3;

  function questionPack(p, o) {
    o = o || {};
    const members = p.members || [];
    const first = members[0] && members[0].view;
    const choice = first && first.choices && first.choices[first.packChoice];
    const root = make('div', 'lex-q is-pack');
    root.appendChild(make('div', 'lex-q-title', packTitle(members)));
    const rows = make('div', 'lex-q-rows');
    const said = packRows(members);
    const recording = !!p.recording;
    members.forEach((m, i) => {
      if (!p.all && i >= ROWS_SHOWN && members.length > ROWS_SHOWN + 1) return;
      const one = !/\s/.test(said[i]);
      const row = make('button', `lex-q-row${one ? ' is-one' : ''}${p.openRow === m.uid ? ' is-open' : ''}`);
      row.type = 'button';
      row.setAttribute('aria-expanded', p.openRow === m.uid ? 'true' : 'false');
      row.appendChild(make('span', 'lex-q-row-text', said[i] || (m.view && m.view.text) || ''));
      if (one && choice) row.appendChild(make('span', 'lex-q-pill', choice.label));
      row.disabled = recording;
      row.addEventListener('click', () => o.onRow && o.onRow(m.uid));
      rows.appendChild(row);
      const err = p.errors && p.errors.get(m.uid);
      if (err) rows.appendChild(make('div', 'lex-q-note is-error', `Not recorded: ${err}`));
      // The row pressed: the variants of this one question under it.
      if (p.openRow === m.uid && !recording) {
        const pending = p.pending ? p.pending.get(m.uid) : null;
        const inner = make('div', 'lex-q-row-open');
        inner.appendChild(global.LexLinks.into(make('div', 'lex-q-text'), (m.view && m.view.text) || ''));
        const { box, quiet, busy } = choices(m.view || {}, pending, (k) => o.onChoice && o.onChoice(m.uid, k));
        if (box.childElementCount) inner.appendChild(box);
        const note = pendingNote(pending);
        if (note) inner.appendChild(note);
        if (quiet) {
          const q = make('button', 'lex-q-quiet', quiet.c.label);
          q.type = 'button';
          q.disabled = busy;
          q.addEventListener('click', () => o.onChoice && o.onChoice(m.uid, quiet.i));
          inner.appendChild(q);
        }
        rows.appendChild(inner);
      }
    });
    if (!p.all && members.length > ROWS_SHOWN + 1) {
      const more = make('button', 'lex-q-more');
      more.type = 'button';
      more.append(make('span', '', `${members.length - ROWS_SHOWN} more`), strokes(DOWN_D, 16));
      more.addEventListener('click', () => o.onMore && o.onMore());
      rows.appendChild(more);
    }
    root.appendChild(rows);
    const pair = make('div', 'lex-q-pair');
    const all = button({ label: choice ? `${choice.label} — all ${members.length}` : `All ${members.length}`, main: true });
    const each = button({ label: 'One by one' });
    all.disabled = recording || !choice;
    each.disabled = recording;
    if (recording) all.classList.add('is-busy');
    all.addEventListener('click', () => o.onAll && o.onAll());
    each.addEventListener('click', () => o.onOneByOne && o.onOneByOne());
    pair.append(all, each);
    root.appendChild(pair);
    if (recording) root.appendChild(make('div', 'lex-q-note', `Recording ${p.recording.done + 1} of ${p.recording.total}…`));
    const foot = make('div', 'lex-q-foot');
    foot.appendChild(make('span', 'lex-q-time', timeOf(members.length ? members[members.length - 1].at : null)));
    root.appendChild(foot);
    return root;
  }

  // ── The line over the message box (В7.26) ───────────────────────────────────
  // Reply on a message: the next message answers it. The arrow of a reply, «Reply to …» and one line
  // of the message, the cross that takes the line away. o.edit — the line of Edit (19.11.2026): the message being
  // edited, the pencil instead of the arrow, the cross cancels the edit.
  function replyBar(o) {
    const root = make('div', o.edit ? 'lex-reply is-edit' : 'lex-reply');
    const icon = strokes(o.edit ? EDIT_D : REPLY_D, 16);
    icon.classList.add('lex-reply-icon');
    const words = make('span', 'lex-reply-words');
    words.append(make('span', 'lex-reply-head', o.head || (o.edit ? 'Edit message' : 'Reply')), make('span', 'lex-reply-text', String(o.text || '').split('\n')[0]));
    const close = make('button', 'lex-reply-close');
    close.type = 'button';
    close.title = o.edit ? 'Cancel the edit' : 'Cancel the reply';
    close.setAttribute('aria-label', o.edit ? 'Cancel the edit' : 'Cancel the reply');
    close.appendChild(strokes(CLOSE_D, 16));
    close.addEventListener('click', () => o.onClose && o.onClose());
    root.append(icon, words, close);
    return root;
  }

  // The arrow of a reply, 16: for the item «Reply» of a menu.
  const replyIcon = (size) => strokes(REPLY_D, size || 16);

  // ── The look of a message as in Telegram (В7.35–В7.40) ───────────────────────
  // Gennady's decision of 2026-11-16 (the canvas «Разделы Lex по стандарту», the page «Ответы на сообщения:
  // утверждено»): a reply carries the quote of the message it answers inside its bubble; a press on the
  // quote opens a sheet with that message and the chat does not move; every message has its menu by a long
  // press — Reply, Copy, and Show the earlier text of an edited one; reactions, the forwarded, both versions
  // of the edited, the deleted, a message of emoji alone, a sticker, the ticks of what went in every
  // channel. What a message carries comes from the server (`looks` of profi_open); these parts only draw.
  const FORWARD_D = ['M15 17l5-5-5-5', 'M4 18v-2a4 4 0 0 1 4-4h12'];
  const MIC_D = ['M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z', 'M19 11a7 7 0 0 1-14 0', 'M12 18v3'];
  const TRASH_D = ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 13h10l1-13', 'M9 7V4h6v3'];
  const EARLIER_D = ['M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8', 'M3 3v5h5', 'M12 7v5l4 2'];
  const MESSAGE_ICONS = { reply: REPLY_D, copy: COPY_D, earlier: EARLIER_D };
  // The marks of the items of a message's menu (В7.36): 'reply', 'copy', 'earlier'.
  const messageIcon = (name, size) => strokes(MESSAGE_ICONS[name] || COPY_D, size || 16);

  // Who said the quoted message: mine — «You» (Gennady's word on the canvas); the bot's — its name or «Bot»,
  // as «Bot:» in the line of a chat (В7.34); the other person — his name.
  function quoteName(q) {
    if (q.who === 'me') return 'You';
    const name = String(q.name || '').trim();
    return name || (q.who === 'bot' ? 'Bot' : 'Client');
  }
  // The second line of a quote: the start of the message in one line, or what it was.
  const QUOTE_KINDS = { voice: 'Voice message', photo: 'Photo', video: 'Video', file: 'File', sticker: 'Sticker' };
  function quoteWords(q) {
    const text = String(q.text || '').replace(/\s+/g, ' ').trim();
    const kind = q.kind || 'text';
    const long = Number(q.seconds) > 0 ? `, ${durationText(q.seconds)}` : '';
    if (kind === 'voice') return `Voice message${long}`;
    if (kind === 'sticker') return text ? `${text} Sticker` : 'Sticker';
    if (kind === 'video' && !text) return `Video${long}`;
    return text || QUOTE_KINDS[kind] || '';
  }
  // The photo of a quoted message, small, by its two lines: an address of Profi's picture server, or a
  // stored file the window fetches (io.blob, as files() does).
  function quotePhoto(p, io) {
    if (!p || typeof p !== 'object') return null;
    const img = make('img', 'lex-quote-photo');
    img.alt = '';
    img.decoding = 'async';
    if (typeof p.url === 'string' && /^https:\/\//.test(p.url)) img.src = p.url;
    else if (typeof p.path === 'string' && io && typeof io.blob === 'function') {
      io.blob(p.path).then((u) => { if (u) img.src = u; else img.remove(); }, () => img.remove());
    } else return null;
    return img;
  }

  // A quote (В7.35): over the text of a reply, the message it answers — a bar 2 (radius 1), through 8 the
  // name 600 and one line of the message with an ellipsis, 4 over the text; a voice message — the
  // microphone 16 and «Voice message, 0:42», a photo — the photo small. In a bubble that went to the client
  // and in a draft its colours are those of the bubble's line. The whole quote is one button with a zone of
  // 44: a press opens the sheet of that message (В7.37), the chat does not move.
  //   quote(q, o) — q as the server gives it: { uid, who: 'client'|'me'|'bot', name, text, kind, seconds,
  //   photo: { url } | { path } }; o = { io, onPress(q) }
  function quote(q, o) {
    const opts = o || {};
    const b = make('button', 'lex-quote');
    b.type = 'button';
    const name = quoteName(q);
    b.setAttribute('aria-label', `Quote: ${name}. Show the message`);
    b.appendChild(make('span', 'lex-quote-bar'));
    const pic = quotePhoto(q.photo, opts.io);
    if (pic) b.appendChild(pic);
    const words = make('span', 'lex-quote-words');
    const line = make('span', 'lex-quote-line');
    if (q.kind === 'voice') {
      const mic = strokes(MIC_D, 16);
      mic.classList.add('lex-quote-mark');
      line.appendChild(mic);
    }
    line.appendChild(make('span', 'lex-quote-text', quoteWords(q)));
    words.append(make('span', 'lex-quote-name', name), line);
    b.appendChild(words);
    // A quote that leads nowhere (a copy of a message in its sheet) is not pressed.
    if (typeof opts.onPress !== 'function') b.disabled = true;
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (typeof opts.onPress === 'function') opts.onPress(q);
    });
    return b;
  }

  // A message of emoji alone (В7.40) is 22 in its usual bubble. One rule with the iPhone (`LexEmoji.only`,
  // ios/Lex/Lex/Parts/): every letter of it, spaces aside, is a picture — its first sign is drawn as an
  // emoji by itself, or is an emoji followed by more signs (❤️, 1️⃣, 👍🏽, a flag, a family).
  const EMOJI_SELF = /\p{Emoji_Presentation}/u;
  const EMOJI_ANY = /\p{Emoji}/u;
  let graphemes = null;
  // The text of a bubble with the digest of its file (В7.21): the person's words over a hairline, the digest under it.
  // The digest is Markdown the database wrote; it is built into nodes, never into HTML (wc-markdown.js). Without the
  // Markdown module (the extension has no chats of people) the digest stands as plain text.
  function digest(words, markdown) {
    const body = make('div', 'lex-bubble-text has-digest');
    if (words) body.appendChild(global.LexLinks.into(make('div', 'lex-digest-words'), words));
    const md = make('div', `lex-digest${words ? ' is-after' : ''}`);
    // The digest is written in Russian: the language lets a narrow table cell break a long word at a syllable.
    md.lang = 'ru';
    const W = global.WcMarkdown;
    if (W && typeof W.into === 'function') W.into(md, markdown); else md.textContent = markdown;
    // A table wraps its words to the width of the bubble first; what is still wider scrolls in its own box.
    for (const table of md.querySelectorAll('table')) {
      const box = make('div', 'lex-digest-table');
      table.replaceWith(box);
      box.appendChild(table);
    }
    body.appendChild(md);
    return body;
  }

  function emojiOnly(text) {
    const s = String(text || '').replace(/\s+/g, '');
    if (!s) return false;
    if (graphemes === null) {
      graphemes = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
        ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : false;
    }
    const letters = graphemes ? Array.from(graphemes.segment(s), (g) => g.segment) : [...s];
    return letters.every((g) => {
      const signs = [...g];
      return EMOJI_SELF.test(signs[0]) || (signs.length > 1 && EMOJI_ANY.test(signs[0]));
    });
  }

  // Reactions (В7.38): a pill 24 (radius 12) on --bg-hover, the emoji 15, one a reaction, at the bottom left
  // of the bubble; the stamp stays at the right of the same row (bubble({ reactions })).
  //   reactions(list, o) — list [{ emoji, who: 'client'|'me', at }]; o = { client } — the other person's
  //   name for the words read from the screen; o.onMine(emoji) — pressing one's own pill takes the reaction off
  //   (a zone 44 round a pill 24); the pill of my reaction is marked: ground --bg-active and a ring --line-strong.
  //   None — null.
  function reactions(list, o) {
    const items = (Array.isArray(list) ? list : []).filter((r) => r && typeof r.emoji === 'string' && r.emoji.trim());
    if (!items.length) return null;
    const row = make('div', 'lex-reacts');
    for (const r of items) {
      const e = r.emoji.trim();
      const mine = r.who === 'me';
      const pill = make('span', mine ? 'lex-react is-mine' : 'lex-react', e);
      const said = `${mine ? 'You' : ((o && o.client) || 'The client')} reacted ${e}`;
      if (mine && o && typeof o.onMine === 'function') {
        const zone = make('button', 'lex-react-mine');
        zone.type = 'button';
        zone.setAttribute('data-lex-skip', '');
        zone.setAttribute('aria-label', `${said}. Press to take it off`);
        zone.setAttribute('aria-pressed', 'true');
        zone.appendChild(pill);
        zone.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); o.onMine(e); });
        zone.addEventListener('pointerdown', (ev) => ev.stopPropagation());
        row.appendChild(zone);
        continue;
      }
      pill.setAttribute('role', 'img');
      pill.setAttribute('aria-label', said);
      row.appendChild(pill);
    }
    return row;
  }

  // The bar of reactions in the menu of a message (В7.38, В7.36): over the items, one row of buttons 44 — 👍 ❤️ 🔥 😂 😮 😢 🙏
  // and «+» that opens the grid of emoji in the place of the items. A press on an emoji is Gennady's «yes» to it: it
  // goes to the messenger of the person at once (no hold, no preview); the same emoji again takes it off.
  //   reactBar({ channel: 'telegram'|'whatsapp'|'max', mine: emoji|null, pick(emoji|'') }) → the node, or null
  //   — '' means «take off». The menu (LexSendLater.menu) closes on a press of [data-lex-close].
  // One set for every channel: emoji that Telegram's standard reactions hold (WhatsApp and Max take any emoji, so these
  // pass there too). The bar is the first seven; «+» opens the sheet of 24.
  const REACT_QUICK = ['👍', '❤', '🔥', '🤣', '😱', '😢', '🙏'];
  const REACT_SHEET = [...REACT_QUICK, '👎', '🥰', '👏', '😁', '🤔', '🤯', '🎉', '🤩', '👌', '😍', '💯', '👀', '🤝', '😎', '😭', '😡', '🤗'];
  const canonEmoji = (e) => String(e == null ? '' : e).replace(/\uFE0F/g, '').trim();
  // A one-sign symbol shows as a picture, not as a letter, with the selector of emoji after it.
  const shownEmoji = (e) => { const c = canonEmoji(e); return /^[\u00A9\u00AE\u203C\u2049\u2122\u2139\u2190-\u2BFF]$/.test(c) ? `${c}\uFE0F` : c; };
  function reactSet(channel) {
    // What goes out: Telegram's own signs (without the selector), others — as shown.
    return { quick: REACT_QUICK.map(canonEmoji), grid: REACT_SHEET.map(canonEmoji), out: (c) => (channel === 'telegram' ? c : shownEmoji(c)) };
  }
  function reactBar(o) {
    if (!o || typeof o.pick !== 'function') return null;
    const set = reactSet(o.channel);
    const mine = canonEmoji(o.mine);
    const root = make('div', 'lex-reactbar');
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', 'React');
    const row = make('div', 'lex-reactbar-row');
    const emojiButton = (c) => {
      const b = make('button', 'lex-reactbar-btn', shownEmoji(c));
      b.type = 'button';
      b.setAttribute('data-lex-close', '');
      b.setAttribute('aria-label', mine === c ? `Take off ${shownEmoji(c)}` : `React ${shownEmoji(c)}`);
      b.setAttribute('aria-pressed', mine === c ? 'true' : 'false');
      if (mine === c) b.classList.add('is-mine');
      b.addEventListener('click', () => o.pick(mine === c ? '' : set.out(c)));
      return b;
    };
    for (const c of set.quick) row.appendChild(emojiButton(c));
    const more = make('button', 'lex-reactbar-btn lex-reactbar-more');
    more.type = 'button';
    more.title = 'More emoji';
    more.setAttribute('aria-label', 'More emoji');
    more.setAttribute('aria-expanded', 'false');
    more.appendChild(strokes(['M12 5v14', 'M5 12h14'], 16));
    row.appendChild(more);
    const grid = make('div', 'lex-reactbar-grid');
    grid.hidden = true;
    for (const c of set.grid) grid.appendChild(emojiButton(c));
    // «+» swaps the items under the bar for the grid and back; the card stays where it is and does not outgrow
    // the items it replaces.
    more.addEventListener('click', () => {
      const card = root.closest('.lex-sl-menu');
      const open = grid.hidden;
      if (open && card) {
        const h = [...card.querySelectorAll(':scope > .lex-sl-menu-item')].reduce((n, b) => n + b.offsetHeight, 0);
        grid.style.height = `${Math.max(132, Math.min(220, h))}px`;
      }
      grid.hidden = !open;
      more.setAttribute('aria-expanded', open ? 'true' : 'false');
      more.classList.toggle('is-open', open);
      if (card) {
        card.classList.toggle('is-react-grid', open);
        const r = card.getBoundingClientRect();
        if (r.bottom > window.innerHeight - 8) card.style.top = `${Math.max(8, window.innerHeight - 8 - r.height)}px`;
      }
    });
    // The arrows go along the row.
    row.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const list = [...row.querySelectorAll('button')];
      const at = list.indexOf(document.activeElement);
      if (at < 0) return;
      e.preventDefault();
      e.stopPropagation();
      list[(at + (e.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length].focus({ preventScroll: true });
    });
    root.append(row, grid);
    return root;
  }

  // Forwarded (В7.39): «Forwarded from <name>» over the text — the mark of a forward 16 --fg-muted and the
  // words 600 --fg-soft, through 6; the author not known (WhatsApp keeps no author of the original) —
  // «Forwarded» alone.
  function forwarded(name) {
    const n = make('div', 'lex-forward');
    const mark = strokes(FORWARD_D, 16);
    mark.classList.add('lex-forward-mark');
    n.append(mark, make('span', 'lex-forward-words', name ? `Forwarded from ${name}` : 'Forwarded'));
    return n;
  }

  // Both versions of an edited message (В7.39): Show the earlier text of its menu opens them in the bubble,
  // under a line --line across it: «Before the edit · 10:24» 12/600 --fg-muted and the earlier text
  // --fg-muted, the newest of them first. edits — [{ text, at }], the oldest first, as the server keeps
  // them; none — null.
  function earlier(edits) {
    const list = (Array.isArray(edits) ? edits : []).filter((e) => e && typeof e.text === 'string');
    if (!list.length) return null;
    const n = make('div', 'lex-earlier');
    n.appendChild(make('div', 'lex-earlier-line'));
    for (const e of list.slice().reverse()) {
      const time = timeOf(e.at);
      n.append(make('div', 'lex-earlier-head', time ? `Before the edit · ${time}` : 'Before the edit'),
        make('div', 'lex-earlier-text', e.text));
    }
    return n;
  }

  // A sticker (В7.40): the picture 120 (radius 10) without a bubble; under it, through 4, the pill «Sticker ·
  // 10:31» 12 on --bg-hover, the ticks after it under what went. A sticker with no picture to draw (an
  // animated one, a file that did not come) — its emoji large on the same plate.
  //   sticker({ side, sticker: { emoji, path, url, mime }, at | timeText, tail, io })
  function sticker(o) {
    const s = (o && o.sticker) || {};
    const root = make('div', `lex-sticker is-${o.side === 'out' ? 'out' : 'in'}`);
    root.setAttribute('role', 'img');
    root.setAttribute('aria-label', s.emoji ? `Sticker ${s.emoji}` : 'Sticker');
    const pic = make('div', 'lex-sticker-pic');
    // The emoji of the sticker drawn as its picture, 56 in the middle of the 120 (as on the canvas).
    const face = () => {
      const drawing = svg('0 0 120 120', 120);
      if (s.emoji) {
        const t = shape('text', { x: 60, y: 78, 'text-anchor': 'middle', 'font-size': 56, fill: 'currentColor', stroke: 'none' });
        t.textContent = s.emoji;
        drawing.appendChild(t);
      }
      pic.replaceChildren(drawing);
    };
    const mime = String(s.mime || '');
    const drawn = !mime || /^(image|video)\//.test(mime);
    const show = (src) => {
      if (!src) { face(); return; }
      const media = /^video\//.test(mime) ? make('video') : make('img');
      if (media.tagName === 'VIDEO') {
        media.muted = true;
        media.loop = true;
        media.autoplay = true;
        media.playsInline = true;
        media.setAttribute('muted', '');
        media.setAttribute('playsinline', '');
      } else {
        media.alt = '';
        media.decoding = 'async';
      }
      media.addEventListener('error', face);
      media.src = src;
      pic.replaceChildren(media);
    };
    if (drawn && typeof s.url === 'string' && /^https:\/\//.test(s.url)) show(s.url);
    else if (drawn && typeof s.path === 'string' && o.io && typeof o.io.blob === 'function') o.io.blob(s.path).then(show, face);
    else face();
    const pill = make('div', 'lex-sticker-stamp');
    const time = o.timeText != null ? o.timeText : timeOf(o.at);
    pill.appendChild(make('span', '', time ? `Sticker · ${time}` : 'Sticker'));
    if (o.tail) pill.appendChild(o.tail);
    root.append(pic, pill);
    // The reactions under the sticker (В7.38, as in Telegram): the pills in a row through 4 under the plate.
    if (o.reactions) { o.reactions.classList.add('is-under'); root.appendChild(o.reactions); }
    return root;
  }

  // The ticks of what went (В7.2): the tick of Profi's own list of chats — the same drawing, colours and
  // size — under everything that went, in every channel (2026-11-16): one grey stroke, it went; the second
  // stroke and both blue, read. The server says which (`delivery` of a message). setTicks(svg, read) —
  // the same ticks turn blue in place.
  const TICK_GREY = '#838398';
  const TICK_BLUE = '#617EF8';
  function ticks(read) {
    const n = svg('0 -1 13 13', 16);
    n.removeAttribute('aria-hidden');
    n.setAttribute('role', 'img');
    n.setAttribute('fill', 'none');
    n.setAttribute('class', 'lex-ticks');
    for (const d of ['m.62 7.18 2.5 2.74L9.3 3.08', 'm6.21 9.92 6.17-6.84']) {
      n.appendChild(shape('path', { d, 'stroke-width': 1.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    }
    setTicks(n, read);
    return n;
  }
  function setTicks(n, read) {
    const [first, second] = n.querySelectorAll('path');
    first.setAttribute('stroke', read ? TICK_BLUE : TICK_GREY);
    if (read) second.setAttribute('stroke', TICK_BLUE); else second.removeAttribute('stroke');
    second.setAttribute('stroke-dasharray', '10');
    second.setAttribute('stroke-dashoffset', read ? '0' : '10');
    n.dataset.read = read ? '1' : '0';
    n.setAttribute('aria-label', read ? 'Read by the client' : 'Not read yet');
  }

  // The sheet of a message (В7.37): a press on a quote opens the common sheet В7.15 over the chat, which does
  // not move; its title is when the message was («Вчера, 18:02», newsWhen). These are its insides: the
  // message itself in a frame 2 --line-strong and its neighbours, as bubbles; under them two buttons of
  // equal width through 6 — «Show in chat» (the second): the chat goes to the message and lights it for
  // 1,5 s; «Reply» (the main, with the arrow of a reply): the line of a reply over the field (В7.26).
  //   messageSheet({ nodes, lit, onShow, onReply }) — lit: the bubble of the message itself; no onShow —
  //   the message is not in this chat, «Show in chat» is off.
  function messageSheet(o) {
    const root = make('div', 'lex-msgsheet');
    const lane = make('div', 'lex-msgsheet-lane lex-bubbles');
    lane.append(...(o.nodes || []));
    if (o.lit) o.lit.classList.add('is-focus');
    const foot = make('div', 'lex-msgsheet-foot');
    const show = button({ label: 'Show in chat' });
    show.disabled = typeof o.onShow !== 'function';
    show.addEventListener('click', () => { if (typeof o.onShow === 'function') o.onShow(); });
    const reply = button({ label: 'Reply', main: true, icon: replyIcon(16) });
    reply.addEventListener('click', () => { if (typeof o.onReply === 'function') o.onReply(); });
    foot.append(show, reply);
    root.append(lane, foot);
    return root;
  }

  // ── News: a card of the feed and the head of a news (В7.31, В7.32) ──────────
  // Gennady's choice of 15.11.2026 on the canvas «News: 3 + 3 варианта»: the feed — board «Лента 3.
  // Карточки по виду источника», a news — board «Новость 1. Текст, потом разговор».
  //
  // A kind of source is its mark and its word: what the server says in `kind` (the letter's own
  // `source`). Only the letters of newsletters exist today ('email'). Reddit (its section and the
  // number of comments in the line under the title), a video (a frame 16:9 with the corners 10 over
  // the top line, the play button 52, the length on a plate) and sites come with their sources, not
  // before: nothing of them is drawn or made up here. A kind this file does not know yet gets the
  // mark of a page and its own id as the word.
  const NEWS_KINDS = {
    email: { name: 'Рассылки', mark: 'mail' },
  };
  const PAGE_MARK = [['path', { d: 'M7 3h7l5 5v13H7z' }], ['path', { d: 'M14 3v5h5' }]];
  function newsKind(id, size) {
    const k = NEWS_KINDS[id];
    const n = svg('0 0 24 24', size || 14);
    n.setAttribute('class', 'lex-nkind');
    for (const [tag, attrs] of (k ? INTAKE_MARKS[k.mark] : PAGE_MARK)) {
      n.appendChild(shape(tag, Object.assign({ fill: 'none', stroke: 'currentColor', 'stroke-width': 2,
        'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, attrs)));
    }
    return n;
  }
  const newsKindName = (id) => (NEWS_KINDS[id] ? NEWS_KINDS[id].name : String(id || ''));

  // A card of the feed: one news — one card, the bubble of the other side across the whole lane, the
  // corner 6 bottom left, 10 12 10 inside; the whole card is one button that opens the news. The top
  // line 12 in grey: the yellow dot 7 of a news not read yet, the mark of the kind 14, the name of the
  // source 600, the author when the letter names one, the time on the right in figures of one width;
  // 4 under it the title 16 (650 not read, 400 read); 2 under it the subtitle or the start of the text
  // 14 in the soft colour, two lines; 6 under it the line 12 in grey for a long read.
  //   o = { kind, source, author, at | timeText, title, sub, foot, unread, onOpen }
  function newsCard(o) {
    const b = pressFace('div', `lex-ncard${o.unread ? ' is-unread' : ''}`);
    const top = make('span', 'lex-ncard-top');
    if (o.unread) top.appendChild(make('span', 'lex-ncard-dot'));
    top.append(newsKind(o.kind, 14), make('span', 'lex-ncard-source', o.source || ''));
    if (o.author) top.appendChild(make('span', 'lex-ncard-author', o.author));
    top.appendChild(make('span', 'lex-ncard-time', o.timeText != null ? o.timeText : timeOf(o.at)));
    b.append(top, make('span', 'lex-ncard-title', o.title || ''));
    if (o.sub) b.appendChild(make('span', 'lex-ncard-sub', o.sub));
    if (o.foot) b.appendChild(make('span', 'lex-ncard-foot', o.foot));
    if (o.onOpen) b.addEventListener('click', o.onOpen);
    return b;
  }
  // Read: no dot, the title in the plain weight.
  function newsCardRead(card) {
    if (!card) return;
    card.classList.remove('is-unread');
    const dot = card.querySelector('.lex-ncard-dot');
    if (dot) dot.remove();
  }

  // The date and the time of a news in its head: «12 ноября, 18:31», «Сегодня, 18:31».
  const newsWhen = (at) => (toDate(at) ? `${dayOf(at)}, ${timeOf(at)}` : '');

  // The source of a news in the head of its screen: the mark of the kind 16 in the soft colour and the
  // name 16/650, under it the date and the time 13 in grey. The window puts it in the bar of its
  // screen (the page, the iPhone) or over the title where its bar is full (the extension).
  //   o = { kind, source, at | timeText }
  function newsSource(o) {
    const root = make('div', 'lex-nsrc');
    const main = make('div', 'lex-nsrc-main');
    main.append(newsKind(o.kind, 16), make('span', 'lex-nsrc-name', o.source || ''));
    root.appendChild(main);
    const when = o.timeText != null ? o.timeText : newsWhen(o.at);
    if (when) root.appendChild(make('div', 'lex-nsrc-time', when));
    return root;
  }

  // A line with words in the middle: lines on both sides, the words 12 in grey. Under the text of a
  // news it says where the talk with the model starts: «Обсуждение с Lex».
  function talkLine(text) {
    const n = make('div', 'lex-talk-line');
    n.setAttribute('role', 'separator');
    n.appendChild(make('span', 'lex-talk-line-text', text));
    return n;
  }

  // ── The one menu of a message, copy and selection (block 2, 2026-11-18) ─────────────────────
  // Gennady, 2026-11-17: «из чата нельзя скопировать вообще ничего» — every text of every chat is selected and
  // copied as in a messenger, and every message has one menu, the same on the page, in the Mac app and in the
  // extension (the iPhone has its own in ios/Lex/Lex/Parts/, item for item). docs/spec/20-chat.md, «Сообщения».
  //
  //   attachMenu(el, o)   the menu of the message `el` (a bubble, an answer, a record, a card). It opens by the
  //                       right button of a mouse (over a link, a picture or a video — the browser's own menu),
  //                       by a finger held 480 ms (lex-long-press.js), by the key of the menu or Shift+F10, and by
  //                       «⋯», which a mouse sees when it is over the message. A mouse held on the text selects.
  //     o = { text() — the plain text of the whole message; html() — its formatted text (a model's answer:
  //           Copy puts both kinds on the clipboard); body — the node of its text (default el); who(), at() —
  //           the name and the moment for a copy of several («Name, [17.11.2026 10:12]»); host — the list it
  //           stands in (Select); reply(part) — Reply, part: the words selected in it or null; edit() — Edit;
  //           earlier: { open, toggle() } — Show / Hide the earlier text; link() — Copy link; items() — the
  //           kind's own items after these (Process again); and the places the next block fills, in this
  //           order: react, editSent, deleteSent, forward (each a function; none — no item; react() →
  //           { channel, mine, pick(emoji|'') }: the bar of reactions over the items, В7.38); row — the row of
  //           actions under the message (В7.78, an element or a function that finds it): «⋯» is its last button,
  //           not a circle over the message }
  //   placeMore(el)       «⋯» of `el` back to the end of its row (after the window painted or changed the row)
  //   copyText(plain, html)   onto the clipboard: both kinds when html is given → Promise<bool>
  //   plainOf(node)       the words of a formatted text without its marks: lists with «• » and «1. »
  //   selectMode(host, first)   choose several messages of a list: a ring on each, the bar «N selected · Copy ·
  //                       Cancel»; Copy — «Name, [date time]» and the text, an empty line between
  //   isBusy(host)        a selection, a held mouse, an open menu or Select in the list: it is not drawn again
  //                       now (wc-thread.js waits for the end — a redraw would take the selection away)
  //   setSelfName(name)   the person's own name in a copy of several
  const MENU = new WeakMap();
  // The element → its «⋯» and how to put it back in place (attachMenu, placeMore, openMenu).
  const MORE = new WeakMap();
  // What is not the words of a message: the line of the channel and the time, Copy, reactions, the head of a
  // record, the quote of another message, «Forwarded from», «⋯» and the rings of Select, the row under an answer.
  const SKIP = '.lex-stamp, .lex-bubble-copy, .lex-reactions, .lex-bubble-foot, .lex-msg-head, .lex-msg-more, '
    + '.lex-quote, .lex-forwarded, .lex-bubble-label, .lex-answer-row, .wc-turn-foot, .lex-intake-head, .lex-intake-time, '
    + '.lex-intake-act, .lex-profi-lex-head, .lex-talk-line, button, [data-lex-skip]';
  const SELECT_D = ['M9 12l2 2 4-4', 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z'];
  const LINK_D = ['M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5', 'M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5'];
  const EDIT_D = ['M12 20h9', 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z'];
  const TEXT_D = ['M4 7V5h16v2', 'M12 5v14', 'M9 19h6'];
  Object.assign(MESSAGE_ICONS, { select: SELECT_D, link: LINK_D, edit: EDIT_D, text: TEXT_D, tick: TICK_D });
  let selfName = '';
  const setSelfName = (name) => { selfName = String(name || '').trim(); };
  const coarse = () => !!(global.matchMedia && global.matchMedia('(pointer: coarse)').matches);

  // The words of a node as they read, without what is not the message: a copy stands off the screen for its
  // line breaks (innerText needs a layout), list items get their marks back, the copy goes.
  function wordsOfFragment(frag) {
    const box = make('div', 'lex-copy-box');
    box.setAttribute('aria-hidden', 'true');
    box.appendChild(frag);
    for (const n of box.querySelectorAll(SKIP)) n.remove();
    for (const list of box.querySelectorAll('ol, ul')) {
      let i = Number(list.getAttribute('start')) || 1;
      for (const li of list.children) {
        if (li.tagName !== 'LI') continue;
        li.prepend(document.createTextNode(list.tagName === 'OL' ? `${i++}. ` : '• '));
      }
    }
    document.body.appendChild(box);
    const words = String(box.innerText || box.textContent || '').replace(/ /g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    box.remove();
    return words;
  }
  function plainOf(node) {
    if (!node) return '';
    const r = document.createRange();
    r.selectNodeContents(node);
    return wordsOfFragment(r.cloneContents());
  }
  // The formatted text of a node, without what is not the message: for the kind text/html of the clipboard.
  function htmlOf(node) {
    if (!node) return '';
    const box = make('div');
    const r = document.createRange();
    r.selectNodeContents(node);
    box.appendChild(r.cloneContents());
    for (const n of box.querySelectorAll(SKIP)) n.remove();
    // The spans of the words for the teacher are a tool of the screen, not the text.
    for (const n of box.querySelectorAll('.vocab-word, lex-w, lex-ln')) n.replaceWith(...n.childNodes);
    for (const n of box.querySelectorAll('[class]')) n.removeAttribute('class');
    for (const n of box.querySelectorAll('[data-lex-msg-id], [data-lex-src], [data-lex-kind]')) {
      n.removeAttribute('data-lex-msg-id'); n.removeAttribute('data-lex-src'); n.removeAttribute('data-lex-kind');
    }
    return box.innerHTML;
  }
  // The part of the range that falls in the message el, as words.
  function partIn(range, el) {
    const body = (MENU.get(el) && MENU.get(el).body) || el;
    const r = document.createRange();
    r.selectNodeContents(body);
    if (!range.intersectsNode(body)) return '';
    if (range.compareBoundaryPoints(Range.START_TO_START, r) > 0) r.setStart(range.startContainer, range.startOffset);
    if (range.compareBoundaryPoints(Range.END_TO_END, r) < 0) r.setEnd(range.endContainer, range.endOffset);
    return wordsOfFragment(r.cloneContents());
  }
  // The words selected in the message, or ''.
  function selectedIn(el) {
    const sel = global.getSelection && global.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return '';
    return partIn(sel.getRangeAt(0), el);
  }

  // Onto the clipboard. Both kinds (the formatted text pastes as it looks, the plain one without the marks of
  // Markdown) in one item; a browser without ClipboardItem, or a refusal — the command copy with its own
  // handler, which needs no permission inside a press.
  function copyByCommand(plain, html) {
    let ok = false;
    const on = (e) => {
      e.clipboardData.setData('text/plain', plain);
      if (html) e.clipboardData.setData('text/html', html);
      e.preventDefault();
      ok = true;
    };
    document.addEventListener('copy', on, true);
    try { document.execCommand('copy'); } catch (_) { ok = false; }
    document.removeEventListener('copy', on, true);
    return ok;
  }
  // WebKit (Safari, the app for the Mac) writes formatted text with the computed styles of a page of its own, in
  // the theme of the system: in the dark that is white letters, white on white in a light document it is pasted
  // into. A box of the light scheme with black letters keeps it readable there; Chrome writes the words as they
  // are, so they are left alone.
  const UA = (global.navigator && global.navigator.userAgent) || '';
  const WEBKIT_STYLES = /AppleWebKit/.test(UA) && !/(Chrome|Chromium|CriOS|Edg)\//.test(UA);
  async function copyText(plain, html) {
    const words = String(plain == null ? '' : plain);
    if (html && WEBKIT_STYLES) html = `<div style="color-scheme: light; color: #000">${html}</div>`;
    try {
      const C = global.navigator && global.navigator.clipboard;
      if (html && C && C.write && global.ClipboardItem) {
        await C.write([new global.ClipboardItem({
          'text/plain': new Blob([words], { type: 'text/plain' }),
          'text/html': new Blob([html], { type: 'text/html' }),
        })]);
        return true;
      }
      if (!html && C && C.writeText) { await C.writeText(words); return true; }
    } catch (_) { /* the command below */ }
    return copyByCommand(words, html || '');
  }

  // «Name, [17.11.2026 10:12]» over a message in a copy of several, as Telegram puts it.
  function copyHead(o) {
    const who = String((o.who && o.who()) || '').trim() || selfName || 'Me';
    const d = toDate(o.at && o.at());
    return d ? `${who}, [${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${timeOf(d)}]` : who;
  }
  const wholeText = (o, el) => String((o.text ? o.text() : plainOf(o.body || el)) || '').trim();
  // The words of a copy of several: the head over each message — and only when there are several of them. One
  // message copies as its words, as in Telegram (19.11.2026: «Me, [19.11.2026 14:15]» went to a client in a text
  // pasted from one selected message). parts: [{ o, w }] — the menu entry of the message and its words.
  function copyOfSeveral(parts) {
    const list = parts.filter((p) => p && p.w);
    if (list.length === 1) return list[0].w;
    return list.map((p) => `${copyHead(p.o)}\n${p.w}`).join('\n\n');
  }

  // The items of the menu, in the one order of every chat (docs/spec/20-chat.md, «Меню сообщения»).
  function menuItems(el, o, part) {
    const items = [];
    // The bar of reactions (В7.38) stands first, over the items; the channel of the message sets its emoji.
    const react = o.react ? o.react() : null;
    const bar = react ? reactBar(react) : null;
    if (bar) items.push({ bar });
    if (o.reply) items.push({ label: 'Reply', icon: messageIcon('reply', 16), run: () => o.reply(part || null) });
    items.push({
      label: 'Copy', icon: messageIcon('copy', 16), confirm: 'Copied',
      run: () => (part ? copyText(part) : copyText(wholeText(o, el), o.html ? o.html() : '')),
    });
    if (coarse()) items.push({ label: 'Select text', icon: messageIcon('text', 16), run: () => selectTextOf(el) });
    const host = typeof o.host === 'function' ? o.host() : o.host;
    if (host) items.push({ label: 'Select', icon: messageIcon('select', 16), run: () => selectMode(host, el) });
    if (o.link) {
      const url = o.link();
      if (url) items.push({ label: 'Copy link', icon: messageIcon('link', 16), confirm: 'Copied', run: () => copyText(url) });
    }
    if (o.edit) items.push({ label: 'Edit', icon: messageIcon('edit', 16), run: () => o.edit() });
    const earlier = typeof o.earlier === 'function' ? o.earlier() : o.earlier;
    if (earlier) {
      items.push({ label: earlier.open ? 'Hide the earlier text' : 'Show the earlier text', icon: messageIcon('earlier', 16), run: () => earlier.toggle() });
    }
    if (o.editSent) items.push({ label: 'Edit', icon: messageIcon('edit', 16), run: () => o.editSent() });
    if (o.forward) items.push({ label: 'Forward', icon: strokes(FORWARD_D, 16), run: () => o.forward() });
    for (const it of (o.items ? o.items() : []) || []) items.push(it);
    if (o.deleteSent) items.push({ label: 'Delete', icon: strokes(TRASH_D, 16), danger: true, run: () => o.deleteSent() });
    return items;
  }

  // The menu of the message, now. how: { at: {x, y} } — at the pointer; { anchor } — by a button or the message.
  // A finger: the chat dims, the message stays lit, the menu stands over or under it and does not cover its
  // words. A mouse: at the pointer, the message lit — in a narrow window too (the side panel of Chrome).
  function openMenu(el, how) {
    const o = MENU.get(el);
    if (!o || !global.LexSendLater || !el.isConnected) return;
    const part = selectedIn(el);
    const items = menuItems(el, o, part);
    // «⋯» over the message or in its row (В7.78): it stays lit, and its row seen, while the menu is open.
    const more = (MORE.get(el) || {}).more || el.querySelector(':scope > .lex-msg-more');
    if (more) more.classList.add('is-open');
    if (el.tabIndex < 0 && !el.hasAttribute('tabindex') && how && how.anchor === el) el.setAttribute('tabindex', '-1');
    el.classList.add('is-menu');
    const onClose = () => {
      if (more) more.classList.remove('is-open');
      el.classList.remove('is-menu');
      document.dispatchEvent(new CustomEvent('lexmessagefree'));
      const f = document.activeElement;
      if (how && how.anchor && (!f || f === document.body) && how.anchor.isConnected && how.anchor.focus) how.anchor.focus({ preventScroll: true });
    };
    const lit = o.lit || el;
    // o.layer: the class of a surface that stands over the page (the windows of the extension).
    const layer = o.layer || null;
    if (coarse() || (how && how.finger)) {
      global.LexSendLater.menu({ anchor: lit, lit, around: true, items, onClose, layer });
    } else if (how && how.at) {
      global.LexSendLater.menu({ plain: true, lit, at: how.at, items, onClose, layer });
    } else {
      global.LexSendLater.menu({ plain: true, lit, anchor: (how && how.anchor) || el, align: 'right', below: true, items, onClose, layer });
    }
  }

  // Select text (a finger): the words of the message become selectable and all of them are selected; the
  // handles of the system narrow it to a word. A finger elsewhere ends it.
  function selectTextOf(el) {
    const o = MENU.get(el) || {};
    const body = o.body || el;
    el.classList.add('is-text-select');
    const sel = global.getSelection && global.getSelection();
    if (sel) { sel.removeAllRanges(); const r = document.createRange(); r.selectNodeContents(body); sel.addRange(r); }
    const end = () => {
      const s = global.getSelection && global.getSelection();
      if (s && !s.isCollapsed && s.rangeCount && s.getRangeAt(0).intersectsNode(body)) return;
      el.classList.remove('is-text-select');
      document.removeEventListener('selectionchange', end);
    };
    setTimeout(() => document.addEventListener('selectionchange', end), 300);
  }

  function attachMenu(el, o) {
    if (!el || !o) return null;
    MENU.set(el, o);
    el.setAttribute('data-lex-menu', '');
    if (o.side) el.setAttribute('data-lex-side', o.side);
    let finger = false;
    // «⋯» over the message for a mouse (hidden for a finger: its menu is the hold), in the order of Tab.
    const more = make('button', 'lex-msg-more');
    more.type = 'button';
    more.title = 'More';
    more.setAttribute('aria-label', 'Message actions');
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('data-lex-skip', '');
    const dots = svg('0 0 24 24', 18);
    for (const cx of DOTS) dots.appendChild(shape('circle', { cx, cy: 12, r: 1.8, fill: 'currentColor' }));
    more.appendChild(dots);
    more.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openMenu(el, { anchor: more }); });
    more.addEventListener('pointerdown', (e) => e.stopPropagation());
    // o.row (23.11.2026, the row of actions under a message, В7.78): «⋯» is the last button of the message's own row
    // under it — an element or a function that finds it (null — no row yet: no «⋯» until it comes; the menu still
    // opens by the right button, a hold and the key). Without o.row — over the message, as before.
    const home = () => {
      if (!o.row) return el;
      const r = typeof o.row === 'function' ? o.row() : o.row;
      return r && r.isConnected !== false ? r : null;
    };
    if (o.row) more.classList.add('lex-answer-row-btn', 'is-in-row');
    // A message drawn again in place (a frame of an answer, the slicing into words) loses «⋯»: it comes back
    // when the mouse or the focus comes. In a row it stays the last button.
    const keepMore = () => {
      const h = home();
      if (!h) { if (more.parentNode) more.remove(); return; }
      if (more.parentNode !== h || h.lastElementChild !== more) h.appendChild(more);
    };
    keepMore();
    MORE.set(el, { keep: keepMore, more });
    el.addEventListener('pointerenter', keepMore);
    el.addEventListener('focusin', keepMore);
    el.addEventListener('pointerdown', (e) => { finger = e.pointerType === 'touch' || e.pointerType === 'pen'; }, true);
    el.addEventListener('contextmenu', (e) => {
      if (e.defaultPrevented) return;
      const host = el.closest('.lex-selecting');
      if (host) { e.preventDefault(); return; }
      const t = e.target;
      // A link, a picture, a video: the browser's own menu — Copy image, Copy link address, Save as.
      if (t && t.closest && t.closest('a[href], img, video, audio, input, textarea, [contenteditable="true"], [data-native-menu]')) return;
      e.preventDefault();
      // A long touch of a finger is the hold below, not this.
      if (finger || e.pointerType === 'touch' || e.pointerType === 'pen') return;
      e.stopPropagation();
      // The key of the menu (no pointer under it): by the message itself.
      if (!e.clientX && !e.clientY) openMenu(el, { anchor: more });
      else openMenu(el, { at: { x: e.clientX, y: e.clientY } });
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
        e.preventDefault();
        e.stopPropagation();
        openMenu(el, { anchor: more });
      }
    });
    let hold = null;
    if (global.LexLongPress) {
      hold = global.LexLongPress.attach(el, (e) => {
        if (el.closest('.lex-selecting') || el.classList.contains('is-text-select')) return;
        if (global.navigator && global.navigator.vibrate) { try { global.navigator.vibrate(8); } catch (_) {} }
        openMenu(el, { anchor: el, finger: true, at: { x: e.clientX, y: e.clientY } });
      }, { when: () => finger && !el.classList.contains('is-text-select') });
    }
    return { open: (how) => openMenu(el, how || { anchor: more }), more, detach: () => { if (hold) hold.detach(); MENU.delete(el); more.remove(); } };
  }

  // «⋯» of a message put in its row again (the window calls it after it painted the row: a row that came after the
  // message, a button that joined the row after «⋯»).
  function placeMore(el) {
    const m = el ? MORE.get(el) : null;
    if (m) m.keep();
  }

  // ── Select: several messages at once ──────────────────────────────────────────────────────
  let selecting = null;
  function selectMode(host, first) {
    if (!host) return;
    if (selecting) selecting.end();
    const chosen = new Set();
    const all = () => [...host.querySelectorAll('[data-lex-menu]')].filter((n) => MENU.has(n) && !n.closest('[hidden]'));
    host.classList.add('lex-selecting');
    const bar = make('div', 'lex-select-bar');
    const layer = first && MENU.get(first) && MENU.get(first).layer;
    if (layer) bar.classList.add(layer);
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Selected messages');
    const count = make('span', 'lex-select-count', '');
    const copy = make('button', 'lex-select-btn is-main');
    copy.type = 'button';
    const copyIcon = make('span', 'lex-select-icon');
    copyIcon.appendChild(messageIcon('copy', 16));
    const copyWords = make('span', '', 'Copy');
    copy.append(copyIcon, copyWords);
    const cancel = make('button', 'lex-select-btn', 'Cancel');
    cancel.type = 'button';
    bar.append(count, copy, cancel);
    document.body.appendChild(bar);
    const paint = () => {
      for (const n of all()) n.classList.toggle('is-picked', chosen.has(n));
      count.textContent = `${chosen.size} selected`;
      copy.disabled = !chosen.size;
    };
    const toggle = (n) => { if (chosen.has(n)) chosen.delete(n); else chosen.add(n); paint(); };
    const onClick = (e) => {
      const n = e.target && e.target.closest ? e.target.closest('[data-lex-menu]') : null;
      if (!n || !host.contains(n) || !MENU.has(n)) return;
      e.preventDefault();
      e.stopPropagation();
      toggle(n);
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); end(); } };
    host.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    let timer = null;
    copy.addEventListener('click', async () => {
      const list = all().filter((n) => chosen.has(n));
      const words = copyOfSeveral(list.map((n) => {
        const o = MENU.get(n);
        return { o, w: wholeText(o, n) };
      }));
      if (!words || !(await copyText(words))) return;
      copyIcon.replaceChildren(messageIcon('tick', 16));
      copyWords.textContent = 'Copied';
      clearTimeout(timer);
      timer = setTimeout(end, 900);
    });
    cancel.addEventListener('click', () => end());
    function end() {
      if (selecting !== api) return;
      selecting = null;
      clearTimeout(timer);
      host.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      host.classList.remove('lex-selecting');
      for (const n of host.querySelectorAll('[data-lex-menu].is-picked')) n.classList.remove('is-picked');
      bar.remove();
      document.dispatchEvent(new CustomEvent('lexmessagefree'));
    }
    const api = { end };
    selecting = api;
    if (first && MENU.has(first)) chosen.add(first);
    paint();
  }

  // A selection dragged across several messages copies as a copy of several (and one message without its
  // line of the channel and the time): what is not the words never reaches the clipboard.
  function onCopy(e) {
    if (e.defaultPrevented || !e.clipboardData) return;
    const sel = global.getSelection && global.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const t = range.commonAncestorContainer;
    const top = t.nodeType === 1 ? t : t.parentElement;
    if (top && top.closest && (top.closest('input, textarea, [contenteditable="true"]'))) return;
    const hit = [...document.querySelectorAll('[data-lex-menu]')]
      .filter((n) => MENU.has(n) && range.intersectsNode(n))
      .filter((n, i, a) => !a.some((m) => m !== n && m.contains(n)));
    if (!hit.length) return;
    // One message — its words alone, whatever else the selection touches (a triple click reaches the start of the
    // next block, a drag ends over a line of the date): the head belongs to a copy of several only.
    if (hit.length === 1) {
      const part = partIn(range, hit[0]);
      const raw = String(sel.toString() || '').replace(/\s+/g, ' ').trim();
      if (!part || part.replace(/\s+/g, ' ').trim() === raw) return;
      e.clipboardData.setData('text/plain', part);
      e.preventDefault();
      return;
    }
    const words = copyOfSeveral(hit.map((n) => ({ o: MENU.get(n), w: partIn(range, n) })));
    if (!words) return;
    e.clipboardData.setData('text/plain', words);
    e.preventDefault();
  }
  document.addEventListener('copy', onCopy);

  // A held mouse in a list: a selection is being made.
  let mouseDown = false;
  document.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse' && e.button === 0) mouseDown = true; }, true);
  document.addEventListener('pointerup', () => {
    if (!mouseDown) return;
    mouseDown = false;
    setTimeout(() => document.dispatchEvent(new CustomEvent('lexmessagefree')), 0);
  }, true);
  function isBusy(host) {
    if (!host) return false;
    if (host.classList.contains('lex-selecting') || host.querySelector('.is-menu, .is-text-select')) return true;
    const sel = global.getSelection && global.getSelection();
    if (sel && !sel.isCollapsed && sel.rangeCount && sel.getRangeAt(0).intersectsNode(host)) return true;
    return mouseDown && host.matches(':hover');
  }

  // ── One cell of a message (docs/spec/21-chat-canvas.md, «Одна ячейка сообщения», 26.11.2026) ─────────────────────
  // Every turn of every chat of the page is drawn here: the kind of the turn — its `origin` (none is `text`), one of the
  // table of the kinds of messages (MESSAGE_KINDS of lex-chat-money.js) — names its drawer. A drawer is given by the part
  // that holds what it draws from (a chat of a person, a group, an order, an agent — lex-profi.js; the feeds and the
  // main chat — webchat/wc-thread.js) and gets the turn and the context of the feed: draw(t, ctx) → a node to put at the
  // end of the feed, `null` (the turn has nothing to show, or the feed took it to lay out itself), or `undefined` (not
  // in this chat: the drawer of its look draws it — `look:answer`, `look:system`, `look:own`). A kind the table does not
  // know is a word of the system (`look:system`); with no drawer of that either — a plate with its words. The table is
  // read when a turn is drawn: lex-chat-money.js loads after this file, and the extension has no drawers at all.
  const cellDrawers = new Map();
  const cellKey = (origin) => (origin == null || origin === '' ? 'text' : String(origin));
  const cellKinds = () => (global.LexChatMoney && global.LexChatMoney.MESSAGE_KINDS) || null;
  const CELL_LOOKS = ['look:answer', 'look:system', 'look:own'];
  function registerCell(origins, draw) {
    for (const o of [].concat(origins)) cellDrawers.set(CELL_LOOKS.includes(o) ? o : cellKey(o), draw);
  }
  // The last word: a kind nobody draws is a plate of the system with its words, never lost.
  function cellPlate(t) {
    const root = make('div', 'wc-turn lex-cell-plate');
    root.appendChild(notice({ body: document.createTextNode(String((t && t.text) || '')), at: t && t.authoredAt }));
    if (t && t.uid) root.dataset.uid = String(t.uid);
    if (t && t.origin) root.dataset.origin = String(t.origin);
    if (t && t.authoredAt) root.dataset.at = t.authoredAt;
    return root;
  }
  function drawCell(t, ctx) {
    const key = cellKey(t && t.origin);
    const kinds = cellKinds();
    const known = !kinds || !!kinds[key];
    const c = ctx || {};
    const own = known ? cellDrawers.get(key) : null;
    if (own) {
      const node = own(t, c);
      if (node !== undefined) return node;
    }
    const look = known && global.LexChatMoney ? global.LexChatMoney.kindLook(key) : 'system';
    const byLook = cellDrawers.get(`look:${look}`) || cellDrawers.get('look:system');
    // An unknown kind is a word of the system whoever wrote it: never a bubble of the person, never an answer of a model.
    const node = byLook ? byLook(known ? t : Object.assign({}, t, { role: 'assistant' }), c) : undefined;
    return node === undefined ? cellPlate(t) : node;
  }
  // The origins of the table that nobody draws (a test reads it: every kind has its drawer).
  function missingCells() {
    const kinds = cellKinds();
    return kinds ? Object.keys(kinds).filter((k) => !cellDrawers.has(k)) : [];
  }
  // The origins drawn that the table does not know (the same test: a drawer only for a kind of the table).
  function strayCells() {
    const kinds = cellKinds();
    return kinds ? [...cellDrawers.keys()].filter((k) => !CELL_LOOKS.includes(k) && !kinds[k]) : [];
  }
  const cells = { register: registerCell, draw: drawCell, key: cellKey, has: (o) => cellDrawers.has(cellKey(o)),
    missing: missingCells, stray: strayCells };

  global.LexMessage = { cells, cell: drawCell, message, entry, intake, task, taskWords, dayLine, newLine, mark, timeOf, dayOf, call, callLength,
    NEWS_KINDS, newsKind, newsKindName, newsCard, newsCardRead, newsWhen, newsSource, talkLine,
    CHANNELS, channel, channelName, stamp, bubble, digest, photos, files, fileChip, sizeText, durationText, notice, fold, discussionFold, eyeOff, sparkle,
    sendHold, editField, avatar, avatarMark, avatarBrand, button, brief, readMore, FOLD_LINES, unsent, taskStop, devTaskOf, devTaskRunning, question, whois, questionPack, packTitle, packRows, replyBar, replyIcon, order, orderWords, countdown,
    quote, quoteName, quoteWords, emojiOnly, reactions, reactBar, forwarded, earlier, sticker, ticks, setTicks, messageSheet, messageIcon,
    attachMenu, placeMore, openMenu, copyText, plainOf, htmlOf, selectMode, isBusy, setSelfName, selectedIn };
})(typeof window !== 'undefined' ? window : globalThis);
