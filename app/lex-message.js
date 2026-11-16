// lex-message.js — the common parts of every chat where messages come without the person:
// the feeds of Extended Mind, the chats of its questions, the order chats of Profi.ru, the
// letter of a news chat. One file for the extension and the page lex-me.club/app (the Mac
// app shows that page); the iPhone has the same parts in MessageParts.swift.
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
//   bubble({ …, media })   `media` (photos, files) stands over the text, as in Telegram; a bubble of
//                       photos without words has no line of text
//   bubble({ …, copy })   `copy` → Promise<bool>: a Copy mark inside, top right, the text flows
//                       round it (В7.22); a tick for 1,5 s once it copied
//   bubble({ side: 'out', tone: 'draft', text, copy })   a draft for the client (В7.20): what went
//                       to the client with a dashed edge inside; no line under the text
//   sendHold({ channel, words, label, onSend, items, fit })   the button that sends a text to a
//                       person (В7.23): a second button with the mark of the place and «Hold to send
//                       to Dmitry»; a tap sends nothing, a hold of 480 ms sends; «⋯» by it opens
//                       items() → { send, more }
//   notice({ channel, body | text, at })   a notice of a service as a plate in the middle
//   fold({ text, action, onClick, icon })   one line in the middle for what is kept off the screen;
//                       icon 'check' — a tick in place of the eye (tasks without remarks, В7.30)
//   avatar(name)        a round letter of a person, its colour from the name
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
//   question(v, o)      a question of the database as one message: v is its view from the server
//                       (lex_em_question_view: text, choices, state, answer, reason). Waiting — the
//                       bubble with its variants inside and the quiet «Пропустить» under them;
//                       answered or withdrawn — one line, a press unfolds it. o = { at, pending,
//                       open, onChoice(i), onToggle() }
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
    const b = make('button', 'lex-intake-thin');
    b.type = 'button';
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
    const face = make('button', 'lex-task-face');
    face.type = 'button';
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
      root.append(channel(o.channel), channelName(o.channel), make('span', 'lex-stamp-dot', '·'));
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
      body = make('div', 'lex-bubble-text');
      body.textContent = o.text || '';
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
  function sendHold(o) {
    const id = CHANNELS[o && o.channel] ? o.channel : 'profi';
    const send = make('button', `lex-send-hold${o.fit ? ' is-fit' : ''}`);
    send.type = 'button';
    send.setAttribute('aria-label', o.label || o.words || 'Hold to send');
    send.append(channel(id), make('span', 'lex-send-hold-words', o.words || 'Hold to send'));
    let more = null;
    let open = false;
    const menu = () => {
      if (open || !more || !global.LexSendLater) return;
      const items = o.items();
      if (!items || !items.length) return;
      open = true;
      more.classList.add('is-open');
      more.setAttribute('aria-expanded', 'true');
      global.LexSendLater.menu({
        anchor: more, align: 'right', plain: true, items,
        onClose: () => {
          open = false;
          more.classList.remove('is-open');
          more.setAttribute('aria-expanded', 'false');
          // The focus was on an item of the menu, which is gone: back to «⋯», for the keyboard.
          const f = document.activeElement;
          if (!f || f === document.body) more.focus({ preventScroll: true });
        },
      });
    };
    if (typeof o.items === 'function') {
      more = make('button', 'lex-send-more');
      more.type = 'button';
      more.title = 'More';
      more.setAttribute('aria-label', 'More');
      more.setAttribute('aria-haspopup', 'menu');
      more.setAttribute('aria-expanded', 'false');
      const dots = svg('0 0 24 24', 20);
      for (const cx of DOTS) dots.appendChild(shape('circle', { cx, cy: 12, r: 1.8, fill: 'currentColor' }));
      more.appendChild(dots);
      more.addEventListener('click', menu);
    }
    // Ctrl and the button of a Mac's mouse is its right button: the menu opens at once, and the hold
    // under it must not send while the button is still down.
    let ctrl = false;
    send.addEventListener('pointerdown', (e) => { ctrl = !!e.ctrlKey; });
    const hold = global.LexLongPress
      ? global.LexLongPress.attach(send, () => {
        if (send.disabled || open || typeof o.onSend !== 'function') return;
        if (global.WcHaptics) global.WcHaptics.press();
        o.onSend();
      }, { when: () => !ctrl && !send.disabled })
      : null;
    // A tap or a click: nothing goes. The press only shows (:active).
    send.addEventListener('click', (e) => { e.preventDefault(); });
    send.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (e.pointerType === 'touch' || e.pointerType === 'pen' || (hold && hold.didFire())) return;
      menu();
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
  // iPhone has the same speeds and words (LexVoiceSpeeds in MessageParts.swift).
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

  function files(list, io) {
    const items = (Array.isArray(list) ? list : []).filter((f) => f && typeof f === 'object'
      && ((typeof f.path === 'string' && f.path) || (f.missing && MISSING[f.missing])));
    if (!items.length) return null;
    const root = make('div', 'lex-files');
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

  function notice(o) {
    const root = make('div', 'lex-notice');
    if (o.channel && CHANNELS[o.channel]) {
      const head = make('span', 'lex-notice-from');
      head.append(channel(o.channel), channelName(o.channel));
      root.append(head, document.createTextNode(' · '));
    }
    const body = o.body || document.createTextNode(o.text || '');
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
  // «<client> · <budget>»: what is missing is left out.
  const orderWho = (o) => [o.client, o.budget].map((x) => String(x || '').trim()).filter(Boolean).join(' · ');

  // order({ order, title, url, at | timeText, client, budget, text, reply, state, foot, ask, folded,
  //         onOpen, onFold })
  //   state   { text, icon: 'tick' | 'cross' | 'reply' | null, danger } — on the right of «Reply»: the
  //           price before the reply leaves, how it ended after
  //   foot    the row of buttons, made by the caller
  //   ask     { title, text } — the band on top
  //   folded  true — the three lines; onOpen() — a press on them; onFold() — the chevron up of a
  //           done order shown whole (none — no chevron)
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
    const root = make('article', 'lex-order');
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
    if (who) inPart.appendChild(make('div', 'lex-order-who', who));
    if (o.text) inPart.appendChild(make('div', 'lex-order-text', o.text));
    root.appendChild(inPart);
    if (o.reply || o.foot) {
      const out = make('div', 'lex-order-out');
      const meta = make('div', 'lex-order-meta');
      const state = make('span', `lex-order-meta-state${st.danger ? ' is-danger' : ''}`);
      if (st.icon) state.appendChild(orderIcon(st.icon, 14, 2.4));
      state.appendChild(make('span', '', st.text || ''));
      meta.append(make('span', 'lex-order-meta-name', 'Reply'), state);
      out.appendChild(meta);
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

  // The letter of a person on a round ground; the same name always gets the same colour.
  const AVATAR_COLORS = ['#A85F2C', '#2F7D6D', '#3F6CB3', '#8A4FA8', '#A8433F', '#4F8A3A', '#9A7A22'];
  function avatar(name) {
    const s = String(name || '').trim();
    let h = 0;
    for (const ch of s) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    const n = make('span', 'lex-avatar', s ? [...s][0].toUpperCase() : '?');
    n.style.background = AVATAR_COLORS[h % AVATAR_COLORS.length];
    n.setAttribute('aria-hidden', 'true');
    return n;
  }

  // ── Buttons (В7.6, В7.7) ─────────────────────────────────────────────────────
  // The main button — the colour of the main action (--accent), one in a row; the second — the
  // ground of a hover (--bg-hover). 44 high, radius 12, 15/650. `left` — the words at the left and
  // the height growing with them: a variant of a question. `note` — a second line 12/400 under the
  // words («Extended Mind thinks so»).
  function button(o) {
    const b = make('button', `lex-btn${o.main ? ' is-main' : ''}${o.left ? ' is-left' : ''}${o.icon ? ' has-icon' : ''}`);
    b.type = 'button';
    // `icon` — a mark 16 before the words, through 8: the arrow of a reply on «Reply» (В7.37).
    if (o.icon) b.appendChild(o.icon);
    b.appendChild(make('span', 'lex-btn-words', o.label || ''));
    if (o.note) b.appendChild(make('span', 'lex-btn-note', o.note));
    return b;
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
    const text = make('div', 'lex-q-text', v.text || '');
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
    const root = make(open ? 'div' : 'button', `lex-q is-done${open ? ' is-unfolded' : ''}`);
    if (!open) {
      root.type = 'button';
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
        inner.appendChild(make('div', 'lex-q-text', (m.view && m.view.text) || ''));
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
  // of the message, the cross that takes the line away.
  function replyBar(o) {
    const root = make('div', 'lex-reply');
    const icon = strokes(REPLY_D, 16);
    icon.classList.add('lex-reply-icon');
    const words = make('span', 'lex-reply-words');
    words.append(make('span', 'lex-reply-head', o.head || 'Reply'), make('span', 'lex-reply-text', String(o.text || '').split('\n')[0]));
    const close = make('button', 'lex-reply-close');
    close.type = 'button';
    close.title = 'Cancel the reply';
    close.setAttribute('aria-label', 'Cancel the reply');
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
  // MessageParts.swift): every letter of it, spaces aside, is a picture — its first sign is drawn as an
  // emoji by itself, or is an emoji followed by more signs (❤️, 1️⃣, 👍🏽, a flag, a family).
  const EMOJI_SELF = /\p{Emoji_Presentation}/u;
  const EMOJI_ANY = /\p{Emoji}/u;
  let graphemes = null;
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
  //   name for the words read from the screen. None — null.
  function reactions(list, o) {
    const items = (Array.isArray(list) ? list : []).filter((r) => r && typeof r.emoji === 'string' && r.emoji.trim());
    if (!items.length) return null;
    const row = make('div', 'lex-reacts');
    for (const r of items) {
      const e = r.emoji.trim();
      const pill = make('span', 'lex-react', e);
      pill.setAttribute('role', 'img');
      pill.setAttribute('aria-label', `${r.who === 'me' ? 'You' : ((o && o.client) || 'The client')} reacted ${e}`);
      row.appendChild(pill);
    }
    return row;
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
    const b = make('button', `lex-ncard${o.unread ? ' is-unread' : ''}`);
    b.type = 'button';
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

  global.LexMessage = { message, entry, intake, task, taskWords, dayLine, newLine, mark, timeOf, dayOf,
    NEWS_KINDS, newsKind, newsKindName, newsCard, newsCardRead, newsWhen, newsSource, talkLine,
    CHANNELS, channel, channelName, stamp, bubble, photos, files, sizeText, durationText, notice, fold, eyeOff, sparkle,
    sendHold, avatar, button, question, questionPack, packTitle, packRows, replyBar, replyIcon, order, countdown,
    quote, quoteName, quoteWords, emojiOnly, reactions, forwarded, earlier, sticker, ticks, setTicks, messageSheet, messageIcon };
})(typeof window !== 'undefined' ? window : globalThis);
