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

  global.LexMessage = { message, entry, dayLine, newLine, mark, timeOf, dayOf };
})(typeof window !== 'undefined' ? window : globalThis);
