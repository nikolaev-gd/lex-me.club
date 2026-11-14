// lex-send-later.js — sending a text to the client of an order chat later, or at once without the
// model: the ready times, the words of the lines, the menu of a held button and the sheet of the
// time, one part for every window of the page (lex-profi.js, wc-app.js; styles —
// lex-send-later.css). The iPhone has the same times and words in Swift
// (ios/Lex/Lex/SendLater.swift); its menu is the system's (Gennady, 2026-11-14).
//
// What decides lives on the server (supabase/migrations/profi_send_later.sql): a box waits in the
// state `scheduled` with its time `sendAt`, the watchman of the database sends it when the time
// comes, by the same path as Send, to the place where the client wrote last at that moment. This
// file only offers times and names them.
//
// The look is the standard of Lex (ios/Lex/STANDARD.md, В7.9 and В7.10; the canvas of the
// Profi.ru pages, «Чат заказа», screens 5–8, version 20): the menu of a held button is the common
// menu В7.8 with the chat dimmed (--scrim) around what will leave; the sheet of the time is the
// common sheet В7.15 with the text as a bubble «went to the client», the ready times, a day and
// an hour, and the main button that names the chosen time.
//
// Gives global.LexSendLater:
//   quick(now)            the ready times: [{ label, at: Date, side }] — side is the grey word on
//                         the right of a row: the hour for «In 1 hour», the day for the rest
//   when(at, now)         a time for a line: «today at 18:30», «tomorrow at 09:00», «Thu 19 Nov at 18:00»
//   stamp(at, now)        the time under a waiting message: «Today, 18:30», «Thu 19 Nov, 18:00»
//   scheduledLine(at)     the line of a scheduled box: «Scheduled: tomorrow at 09:00.»
//   menu(o)               the menu of a held button: { anchor, align: 'right'|'left', head, lit,
//                         ring, items: [{ label, icon: 'clock'|'pencil'|Node, run() }] }
//   pick(o)               the sheet of the time: { text, client } → Promise<Date|null>
(function (global) {
  'use strict';

  const HOUR = 60 * 60 * 1000;
  // The server refuses further (lex_profi_schedule_box): such a date is a slip, not a plan.
  const MAX_DAYS = 60;

  const pad = (n) => String(n).padStart(2, '0');
  const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const at = (base, days, h, m) => new Date(base.getFullYear(), base.getMonth(), base.getDate() + days, h, m || 0, 0, 0);
  const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const dayName = (d) => d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '');
  const daysFrom = (n, d) => Math.round((dayStart(d) - dayStart(n)) / (24 * HOUR));

  function quick(now) {
    const n = now ? new Date(now) : new Date();
    const inHour = new Date(Math.ceil((n.getTime() + HOUR) / 60000) * 60000);
    const out = [{ label: 'In 1 hour', at: inHour, side: hm(inHour) }];
    // Today at 19:00 only while it is still ahead by half an hour.
    const evening = at(n, 0, 19);
    if (evening.getTime() - n.getTime() >= HOUR / 2) out.push({ label: 'Today at 19:00', at: evening, side: dayName(evening) });
    const tomorrow = at(n, 1, 9);
    out.push({ label: 'Tomorrow at 09:00', at: tomorrow, side: dayName(tomorrow) });
    // Monday morning from Friday, Saturday and Sunday: the day a working week starts.
    const wd = n.getDay();
    if (wd === 5 || wd === 6 || wd === 0) {
      const monday = at(n, ((8 - wd) % 7) || 7, 9);
      out.push({ label: 'Monday at 09:00', at: monday, side: dayName(monday) });
    }
    return out;
  }

  function when(t, now) {
    const d = new Date(t);
    if (Number.isNaN(d.getTime())) return '';
    const days = daysFrom(now ? new Date(now) : new Date(), d);
    if (days === 0) return `today at ${hm(d)}`;
    if (days === 1) return `tomorrow at ${hm(d)}`;
    return `${dayName(d)} at ${hm(d)}`;
  }

  function stamp(t, now) {
    const d = new Date(t);
    if (Number.isNaN(d.getTime())) return '';
    const days = daysFrom(now ? new Date(now) : new Date(), d);
    if (days === 0) return `Today, ${hm(d)}`;
    if (days === 1) return `Tomorrow, ${hm(d)}`;
    return `${dayName(d)}, ${hm(d)}`;
  }

  const scheduledLine = (t, now) => `Scheduled: ${when(t, now)}.`;

  // ── parts ───────────────────────────────────────────────────────────────────
  const NS = 'http://www.w3.org/2000/svg';
  function make(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  const PATHS = {
    clock: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 7v5l3 2'],
    pencil: ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z'],
    send: ['M22 2L11 13', 'M22 2l-7 20-4-9-9-4z'],
    close: ['M6 6l12 12', 'M18 6L6 18'],
    calendar: ['M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z', 'M16 3v4', 'M8 3v4', 'M3 10h18'],
  };
  function icon(name, size) {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', String(size || 20));
    s.setAttribute('height', String(size || 20));
    s.setAttribute('aria-hidden', 'true');
    for (const d of PATHS[name] || []) {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', 'currentColor');
      p.setAttribute('stroke-width', '2');
      p.setAttribute('stroke-linecap', 'round');
      p.setAttribute('stroke-linejoin', 'round');
      s.appendChild(p);
    }
    return s;
  }

  // ── the menu of a held button ───────────────────────────────────────────────
  // Everything around is dimmed except `lit` (what will leave: the field with its arrow, or the
  // answer of the model); `ring` gets a light ring. The dim is a hole cut by a shadow over the real
  // element, so nothing moves and nothing is copied. A press anywhere else, Escape, a scroll or a
  // resize closes it.
  let closeOpen = null;
  function menu(o) {
    if (closeOpen) closeOpen();
    const host = document.body;
    const catcher = make('div', 'lex-sl-catcher');
    const hole = make('div', 'lex-sl-hole');
    const box = make('div', 'lex-sl-menu');
    box.setAttribute('role', 'menu');
    if (o.head) box.appendChild(make('div', 'lex-sl-menu-head', o.head));
    o.items.forEach((it) => {
      const b = make('button', 'lex-sl-menu-item');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      const ic = make('span', 'lex-sl-menu-icon');
      ic.appendChild(typeof it.icon === 'string' ? icon(it.icon, 16) : (it.icon || icon('send', 16)));
      b.append(ic, make('span', '', it.label));
      b.addEventListener('click', () => { close(); it.run(); });
      box.appendChild(b);
    });
    const lit = o.lit || o.anchor;
    const r = lit.getBoundingClientRect();
    const radius = getComputedStyle(lit).borderRadius || '14px';
    Object.assign(hole.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, borderRadius: radius });
    if (o.ring) o.ring.classList.add('lex-sl-ring');
    host.append(catcher, hole, box);
    const a = o.anchor.getBoundingClientRect();
    const m = box.getBoundingClientRect();
    const pad = 8;
    let top = a.top - m.height - 8;
    if (top < pad) top = a.bottom + 8;
    let left = o.align === 'left' ? a.left : a.right - m.width;
    left = Math.max(pad, Math.min(left, window.innerWidth - m.width - pad));
    Object.assign(box.style, { left: `${left}px`, top: `${top}px` });
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    function close() {
      if (closeOpen !== close) return;
      closeOpen = null;
      catcher.remove();
      hole.remove();
      box.remove();
      if (o.ring) o.ring.classList.remove('lex-sl-ring');
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    }
    closeOpen = close;
    catcher.addEventListener('pointerdown', (e) => { e.preventDefault(); close(); });
    setTimeout(() => {
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('resize', close);
      window.addEventListener('scroll', close, true);
    }, 0);
    const first = box.querySelector('.lex-sl-menu-item');
    if (first) first.focus({ preventScroll: true });
    return close;
  }

  // ── the sheet of the time ───────────────────────────────────────────────────
  const toDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  function fromFields(day, time) {
    const a = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
    const b = /^(\d{2}):(\d{2})/.exec(String(time || ''));
    if (!a || !b) return null;
    const d = new Date(+a[1], +a[2] - 1, +a[3], +b[1], +b[2], 0, 0);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // The sheet comes from below on the page and in the Mac app too. A ready time sends at once;
  // the day and the hour below are one choice, and the white button names it.
  function pick(o) {
    if (closeOpen) closeOpen();
    const opts = o || {};
    return new Promise((resolve) => {
      const n = new Date();
      const back = document.activeElement;
      const scrim = make('div', 'lex-sl-scrim');
      const sheet = make('section', 'lex-sl-sheet');
      sheet.setAttribute('role', 'dialog');
      sheet.setAttribute('aria-label', 'Schedule message');
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        scrim.remove();
        sheet.remove();
        document.removeEventListener('keydown', onKey, true);
        try { if (back && back.focus) back.focus({ preventScroll: true }); } catch (_) {}
        resolve(v);
      };
      const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); finish(null); } };

      sheet.appendChild(make('div', 'lex-sl-grip'));
      const top = make('div', 'lex-sl-top');
      const words = make('div', 'lex-sl-words');
      words.append(make('div', 'lex-sl-title', 'Schedule message'),
        make('div', 'lex-sl-sub', `It leaves by itself at this time, to where ${opts.client || 'the client'} wrote last.`));
      const x = make('button', 'lex-sl-close');
      x.type = 'button';
      x.setAttribute('aria-label', 'Close');
      x.appendChild(icon('close', 16));
      x.addEventListener('click', () => finish(null));
      top.append(words, x);
      sheet.appendChild(top);
      // The text that will leave: the common bubble «went to the client» (В7.1), on the right.
      if (opts.text) {
        const wrap = make('div', 'lex-sl-text lex-bubbles');
        wrap.appendChild(global.LexMessage
          ? global.LexMessage.bubble({ side: 'out', text: opts.text })
          : make('div', 'lex-bubble is-out', opts.text));
        sheet.appendChild(wrap);
      }

      const list = make('div', 'lex-sl-quick');
      quick(n).forEach((q, i) => {
        if (i) list.appendChild(make('div', 'lex-sl-sep'));
        const b = make('button', 'lex-sl-row');
        b.type = 'button';
        b.append(make('span', '', q.label), make('span', 'lex-sl-side', q.side));
        b.addEventListener('click', () => finish(q.at));
        list.appendChild(b);
      });
      sheet.appendChild(list);

      sheet.appendChild(make('div', 'lex-sl-label', 'Other time'));
      const first = quick(n)[0].at;
      const fields = make('div', 'lex-sl-fields');
      const field = (type, value, ic, label) => {
        const wrap = make('label', 'lex-sl-field');
        const inp = make('input');
        inp.type = type;
        inp.value = value;
        inp.setAttribute('aria-label', label);
        wrap.append(icon(ic, 16), inp);
        // A press on the field opens the browser's picker of the day or the hour.
        wrap.addEventListener('click', () => { try { inp.showPicker(); } catch (_) { inp.focus(); } });
        return { wrap, inp };
      };
      const day = field('date', toDay(first), 'calendar', 'Day');
      day.inp.min = toDay(n);
      day.inp.max = toDay(new Date(n.getTime() + MAX_DAYS * 24 * HOUR));
      const time = field('time', hm(first), 'clock', 'Time');
      fields.append(day.wrap, time.wrap);
      sheet.appendChild(fields);

      const go = make('button', 'lex-sl-go');
      go.type = 'button';
      const goText = make('span', '', '');
      go.append(icon('clock', 16), goText);
      const chosen = () => fromFields(day.inp.value, time.inp.value);
      const paint = () => {
        const d = chosen();
        const ok = !!d && d.getTime() > Date.now() && d.getTime() <= Date.now() + MAX_DAYS * 24 * HOUR;
        go.disabled = !ok;
        goText.textContent = d ? `Schedule: ${when(d)}` : 'Schedule';
      };
      day.inp.addEventListener('input', paint);
      time.inp.addEventListener('input', paint);
      go.addEventListener('click', () => { const d = chosen(); if (d) finish(d); });
      paint();
      sheet.appendChild(go);

      scrim.addEventListener('pointerdown', (e) => { if (e.target === scrim) finish(null); });
      document.body.append(scrim, sheet);
      document.addEventListener('keydown', onKey, true);
      x.focus({ preventScroll: true });
    });
  }

  global.LexSendLater = { quick, when, stamp, scheduledLine, menu, pick, icon, MAX_DAYS };
})(typeof self !== 'undefined' ? self : globalThis);
