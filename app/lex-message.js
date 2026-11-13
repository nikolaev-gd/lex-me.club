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
//   notice({ channel, body | text, at })   a notice of a service as a plate in the middle
//   fold({ text, action, onClick })   one line in the middle for what is kept off the screen
//   avatar(name)        a round letter of a person, its colour from the name
//   eyeOff(size), sparkle(size)   the crossed eye (seen by the person alone) and the mark of
//                       the model
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

  function entry(v, turnAt) {
    return message({ name: v.name, timeText: entryTime(v, turnAt), body: entryBody(v) });
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
    const time = o.timeText != null ? o.timeText : timeOf(o.at);
    if (time) root.appendChild(make('span', 'lex-stamp-time', time));
    if (o.tail) root.appendChild(o.tail);
    return root;
  }

  function bubble(o) {
    const root = make('div', `lex-bubble is-${o.side === 'out' ? 'out' : 'in'}${o.tone ? ` is-${o.tone}` : ''}`);
    if (o.label) root.appendChild(typeof o.label === 'string' ? make('div', 'lex-bubble-label', o.label) : o.label);
    let body = o.body;
    if (!body) {
      body = make('div', 'lex-bubble-text');
      body.textContent = o.text || '';
    } else body.classList.add('lex-bubble-text');
    root.appendChild(body);
    if (o.stamp) root.appendChild(o.stamp);
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

  function fold(o) {
    const b = make('button', 'lex-fold');
    b.type = 'button';
    b.append(eyeOff(14), make('span', '', `${o.text} · `), make('span', 'lex-fold-action', o.action));
    if (o.onClick) b.addEventListener('click', o.onClick);
    return b;
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

  global.LexMessage = { message, entry, dayLine, newLine, mark, timeOf, dayOf,
    CHANNELS, channel, channelName, stamp, bubble, notice, fold, eyeOff, sparkle, avatar };
})(typeof window !== 'undefined' ? window : globalThis);
