// wc-calendar.js — the section «Calendar» of the page and the Mac app (22.11.2026, supabase/functions/calendar).
//
// The calendar of the base, as the iPhone has it (ios/Lex/Lex/CalendarView.swift, CalendarStore.swift,
// ios/Lex/LexLive/CalendarModel.swift): the same data, the same words (the common words of the calendar), the same
// parts drawn by this page. The boards: the canvas «Calendar: варианты» (CalV01, CalV09, CalV12, CalV17, CalV21, CalV25,
// CalV27) and «Calendar» (CalEvent, CalForm).
//
// A narrow window (the iPhone's size, under 760 wide) has the row of the views on top — Day · 3 days · Week · Month ·
// Year (В7.27) — the line of the date with its arrows, and the view. A wide window (the Mac) has «Calendars» and the
// grid of the month on the left, the week in the middle, and Day · Week · Month · Year, the arrows, «Today» and «New»
// on top. The whole working day 08:00–22:00 stands on the screen without scrolling (Gennady): the height of an hour
// is the height of the hours' box divided by 14; the night is above and below it, the box opens on 08:00.
//
// A meeting opens in the common sheet (В7.15) with the decision on top when a message did not go; «New» and «Edit»
// open the form in the same sheet. What the server says comes on the signal «calendar» of the base (the frame's watch);
// nothing is asked on a timer. The line «now» moves by itself once a minute — that is the clock of this page, not
// a question to the server.
//
// The parts of the calendar (ios/Lex/STANDARD.md В7.43–В7.46) are drawn here and styled in wc-calendar.css:
//   В7.43 an event on the hours   eventCard() — .wc-cal-event (.is-pill, .is-google, .is-allday, .is-short, .is-past)
//   В7.44 the hours and «now»     hoursGrid() — .wc-cal-hours, .wc-cal-hour, .wc-cal-now
//   В7.45 the days of a week      dayButton() — .wc-cal-day
//   В7.46 the grid of a month     monthGrid() — .wc-cal-grid, .wc-cal-date
//
// createSection(deps) — deps:
//   back                 the arrow of the window (lex-back.js)
//   signals              the channel of the database's signals (lex-account-events.js)
//   call(sub, query, body)   the edge function calendar: sub '', '/item', '/people', '/settings'; body — a POST
//   head(spec)           the head in the bar of the window (wc-app.js paintCalendarHead): { title, nodes } — «Calendar» and
//                        the section's own nodes; null — the bar as it was. Without it the frame's own bar holds them.
(function (global) {
  'use strict';

  const S = () => global.LexSection;
  const UI = () => global.WcUI;
  const M = () => global.LexMessage;

  // ── Words and days ───────────────────────────────────────────────────────────────────────────────────────────
  // The dates are Russian (the common words of the calendar), written here and not by Intl: the Mac app shows this
  // page in WebKit, whose «ru-RU» differs from Chrome's («21 нояб. 2026 г.»).
  const WD = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
  const MONTH_OF = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const MONTH = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
  const MONTH_SHORT = ['янв.', 'февр.', 'мар.', 'апр.', 'мая', 'июня', 'июля', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.'];
  const DAY_MS = 86400000;
  const pad = (n) => String(n).padStart(2, '0');
  const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);
  const sameDay = (a, b) => !!a && !!b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  // 0 Monday … 6 Sunday; the contract's numbers are 1 Monday … 7 Sunday.
  const wdOf = (d) => (d.getDay() + 6) % 7;
  const weekStart = (d) => addDays(dayStart(d), -wdOf(d));
  const monthGridStart = (d) => weekStart(new Date(d.getFullYear(), d.getMonth(), 1));
  const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  function fromKey(k) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(k || ''));
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  }
  // «сб, 21 ноября»
  const dayWords = (d) => `${WD[wdOf(d)]}, ${d.getDate()} ${MONTH_OF[d.getMonth()]}`;
  // «сб, 21 нояб.»
  const dayShortWords = (d) => `${WD[wdOf(d)]}, ${d.getDate()} ${MONTH_SHORT[d.getMonth()]}`;
  // «чт 19 ноября» — where a thing was found.
  const dayPlain = (d) => `${WD[wdOf(d)]} ${d.getDate()} ${MONTH_OF[d.getMonth()]}`;
  // The head of a list of a day: «Today, сб 21 ноября», «Tomorrow, вс 22 ноября», «Yesterday, пт 20 ноября», «пн, 23 ноября».
  function dayTitle(d, now) {
    const n = now || new Date();
    if (sameDay(d, n)) return `Today, ${dayPlain(d)}`;
    if (sameDay(d, addDays(n, 1))) return `Tomorrow, ${dayPlain(d)}`;
    if (sameDay(d, addDays(n, -1))) return `Yesterday, ${dayPlain(d)}`;
    return dayWords(d);
  }
  // The day of an open record: «Today, 21 ноября», else «сб, 21 ноября».
  const sheetDay = (d, now) => (sameDay(d, now || new Date()) ? `Today, ${d.getDate()} ${MONTH_OF[d.getMonth()]}` : dayWords(d));
  // «16–22 ноября», «30 ноября – 6 декабря»; with the year on the Mac: «16–22 ноября 2026».
  function spanWords(a, b, year) {
    const y = year ? ` ${b.getFullYear()}` : '';
    if (sameDay(a, b)) return `${a.getDate()} ${MONTH_OF[a.getMonth()]}${y}`;
    if (a.getMonth() === b.getMonth()) return `${a.getDate()}–${b.getDate()} ${MONTH_OF[b.getMonth()]}${y}`;
    return `${a.getDate()} ${MONTH_OF[a.getMonth()]} – ${b.getDate()} ${MONTH_OF[b.getMonth()]}${y}`;
  }
  const monthWords = (d) => `${MONTH[d.getMonth()]} ${d.getFullYear()}`;
  // «1 hour», «30 minutes», «1 h 30 min»
  function lengthWords(min) {
    const m = Math.max(0, Math.round(min));
    if (m < 60) return `${m} minutes`;
    if (m % 60 === 0) return m === 60 ? '1 hour' : `${m / 60} hours`;
    return `${Math.floor(m / 60)} h ${m % 60} min`;
  }

  // ── The data of the contract (CalendarModel.swift) ─────────────────────────────────────────────────────────
  function msOf(v) {
    if (v == null) return NaN;
    if (typeof v === 'number') return v;
    if (typeof v === 'string') return Date.parse(v);
    if (typeof v === 'object') return Number.isFinite(Number(v.ms)) ? Number(v.ms) : msOf(v.at);
    return NaN;
  }
  const dateOf = (v) => { const ms = msOf(v); return Number.isFinite(ms) ? new Date(ms) : null; };
  const str = (v) => (v == null || v === '' ? null : String(v));
  function personOf(j) {
    if (!j || typeof j !== 'object' || str(j.id) == null || typeof j.name !== 'string') return null;
    return { id: String(j.id), name: j.name, line: j.line || null, channel: j.channel || null,
      hasChat: j.has_chat !== false, personal: j.personal === true };
  }
  function stepOf(j) {
    if (!j || typeof j !== 'object') return null;
    return { at: dateOf(j.at), state: String(j.state || ''), reason: j.reason || null };
  }
  function eventOf(j) {
    if (!j || typeof j !== 'object') return null;
    const id = str(j.id);
    const start = dateOf(j.start);
    if (!id || !start) return null;
    const source = j.source || 'own';
    const kind = j.kind || (source === 'google' ? 'google' : 'meeting');
    const m = j.messages && typeof j.messages === 'object' ? j.messages : null;
    const o = j.origin && typeof j.origin === 'object' && j.origin.kind ? j.origin : null;
    const rep = j.repeat && typeof j.repeat === 'object' ? j.repeat : null;
    return {
      id, source, kind, start,
      readonly: j.readonly != null ? !!j.readonly : source === 'google',
      item: str(j.item), occurrence: str(j.occurrence),
      title: typeof j.title === 'string' ? j.title : '',
      end: dateOf(j.end), allDay: j.all_day === true,
      person: personOf(j.person),
      deal: j.deal && typeof j.deal === 'object' ? (j.deal.title || null) : null,
      place: j.place || null, link: j.link || null,
      repeatDays: rep && Array.isArray(rep.days) ? rep.days.map(Number).filter((n) => n >= 1 && n <= 7).sort() : [],
      repeatUntil: rep && rep.until ? String(rep.until) : null,
      remindMinutes: Number.isFinite(Number(j.remind_minutes)) && j.remind_minutes != null ? Number(j.remind_minutes) : null,
      notifyPerson: typeof j.notify_person === 'boolean' ? j.notify_person : null,
      loud: kind === 'alarm' || j.loud === true,
      messages: m ? { willSend: m.will_send === true, whyNot: m.why_not || null, test: m.test === true, channel: m.channel || null,
        reminder: stepOf(m.reminder), link: stepOf(m.link) } : null,
      origin: o ? { kind: String(o.kind), channel: o.channel || null, at: dateOf(o.at), quote: o.quote || null, url: o.url || null } : null,
      googleURL: j.google && typeof j.google === 'object' ? (j.google.url || null) : null,
      twin: str(j.twin),
      version: j.version != null ? Number(j.version) : null,
    };
  }
  const isGoogle = (e) => e.source === 'google' || e.kind === 'google';
  const isPill = (e) => e.kind === 'reminder' || e.kind === 'alarm';
  const placedByBase = (e) => !!(e.origin && (e.origin.kind === 'message' || e.origin.kind === 'call'));
  const endOf = (e) => (e.end && e.end > e.start ? e.end : new Date(e.start.getTime() + (isPill(e) ? 30 : 15) * 60000));
  function headline(e) {
    if (e.kind === 'reminder') return e.title || 'Reminder';
    if (e.kind === 'alarm') return e.title || 'Alarm';
    const parts = [e.person && e.person.name, e.title || null].filter(Boolean);
    return parts.length ? parts.join(' · ') : (isGoogle(e) ? 'Event' : 'Meeting');
  }
  // The name of a column of three days: the person's name, else the title; of a column of the iPhone's week: the first name.
  const whom = (e) => (e.person && e.person.name) || headline(e);
  const shortName = (e) => (e.person && e.person.name ? e.person.name.split(/\s+/)[0] : headline(e));
  const span = (e) => (e.allDay ? 'all day' : (e.end && e.end > e.start ? `${hm(e.start)}–${hm(e.end)}` : hm(e.start)));
  const PLACES = ['zoom', 'telemost', 'meet', 'link'];
  const PLACE_NAMES = { zoom: 'Zoom', telemost: 'Телемост', meet: 'Google Meet', link: 'Own link' };
  // The form has one place more: nothing agreed yet (`unknown`, the base's own word, and its default since 27.11.2026).
  const FORM_PLACES = ['unknown'].concat(PLACES);
  const FORM_PLACE_NAMES = Object.assign({ unknown: 'Not agreed' }, PLACE_NAMES);
  const CHANNEL_NAMES = { telegram: 'Telegram', whatsapp: 'WhatsApp', max: 'Max', profi: 'Профи.ру' };
  const KIND_TITLES = { meeting: 'Meeting', reminder: 'Reminder', alarm: 'Alarm', google: 'Google Calendar' };
  const kindTitle = (e) => (isGoogle(e) ? KIND_TITLES.google : KIND_TITLES[e.kind] || 'Meeting');
  // The messages to the person on a card: all went — «Sent»; one did not — «Not sent»; else nothing.
  function sentWord(e) {
    const m = e.kind === 'meeting' && e.messages;
    if (!m || !m.willSend) return null;
    const steps = [m.reminder, m.link].filter(Boolean);
    if (steps.some((s) => s.state === 'failed')) return { text: 'Not sent', failed: true };
    if (steps.length && steps.every((s) => s.state === 'sent')) return { text: 'Sent', failed: false };
    return null;
  }
  const WHY_NOT = {
    personal: 'a personal meeting', no_chat: 'no chat with the person', off: 'turned off', no_person: 'no person',
    no_link: 'the place has no link', manual: 'the base does not send in this channel itself: it sends you the text in time',
    test: 'a check, and you have no test chat in this channel',
  };
  const whyNot = (w) => WHY_NOT[w] || 'the base does not send';
  function stepWords(name, s, channel) {
    const at = s.at ? hm(s.at) : '';
    const via = channel ? ` · ${channel}` : '';
    switch (s.state) {
      case 'planned': return `${name} — goes${at ? ` at ${at}` : ''}${via}`;
      case 'queued': return `${name} — queued`;
      case 'sending': return `${name} — sending now`;
      case 'sent': return `${name} — sent${at ? ` at ${at}` : ''}${via}`;
      case 'failed': return `${name} — not sent${s.reason ? `: ${s.reason}` : ''}`;
      case 'cancelled': return `${name} — cancelled`;
      case 'skipped': return `${name} — skipped: the time has passed`;
      default: return name;
    }
  }
  function repeatWords(days, until) {
    const set = [...new Set(days || [])].sort();
    if (!set.length) return null;
    const names = set.map((n) => WD[n - 1]);
    let out;
    if (set.length === 7) out = 'Every day';
    else if (set.join() === '1,2,3,4,5') out = 'Weekdays';
    else if (names.length === 1) out = `Every week, ${names[0]}`;
    else out = `${names.slice(0, -1).join(', ')} и ${names[names.length - 1]}`;
    const u = fromKey(until);
    if (u) out += ` until ${u.getDate()} ${MONTH_OF[u.getMonth()]}`;
    return out;
  }
  const remindWords = (m) => (m <= 0 ? 'No reminder, only the message 5 minutes before'
    : m >= 60 ? 'Reminds an hour before' : `Reminds ${m} minutes before`);
  // The row «Remind» of the form: null — the base counts it by how soon the meeting is (Auto).
  const remindLabel = (m) => (m == null ? 'Auto' : m <= 0 ? 'No reminder' : m >= 60 ? '1 hour before' : `${m} minutes before`);
  function originWords(o) {
    const when = o.at ? `, ${dayPlain(o.at)}` : '';
    if (o.kind === 'message') return `The base found the agreement in ${CHANNEL_NAMES[o.channel] || 'a chat'}${when}`;
    if (o.kind === 'call') return `The base found it in a call${when}`;
    if (o.kind === 'chat') return `You asked in a chat${when}`;
    return null;
  }
  const shortLink = (l) => String(l || '').replace(/^https?:\/\//, '').replace(/^www\./, '');

  // ── Marks ────────────────────────────────────────────────────────────────────────────────────────────────────
  // Lines of the common marks (LexSection.markSvg); the bell and the page of a calendar are the drawings of
  // lex-send-later.js, the spark of the base is LexMessage.sparkle.
  const PATHS = {
    video: ['M5 7h8a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z', 'M15 10.5l5-3v9l-5-3'],
    link: ['M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1', 'M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1'],
    calendar: ['M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z', 'M16 3v4', 'M8 3v4', 'M3 10h18'],
    bell: ['M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9', 'M10.3 21a1.94 1.94 0 0 0 3.4 0'],
    clock: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 7v5l3 2'],
    left: ['M15 18l-6-6 6-6'],
    right: ['M9 6l6 6-6 6'],
    plus: ['M12 5v14', 'M5 12h14'],
    alert: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 8v5', 'M12 16h.01'],
    check: ['M5 12l5 5L20 7'],
    copy: ['M9 9h10v10H9z', 'M5 15V5h10'],
    pencil: ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z'],
    trash: ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 13h10l1-13', 'M9 7V4h6v3'],
    repeat: ['M17 2l4 4-4 4', 'M3 11V9a3 3 0 0 1 3-3h15', 'M7 22l-4-4 4-4', 'M21 13v2a3 3 0 0 1-3 3H3'],
    deal: ['M4 8h16v11H4z', 'M9 8V5h6v3'],
    open: ['M7 17L17 7', 'M8 7h9v9'],
  };
  const mark = (name, size) => S().markSvg(PATHS[name] || PATHS.calendar, size || 16, 2);
  const svgText = (name) => mark(name, 20).outerHTML;
  const placeMark = (p, size) => mark(p === 'link' ? 'link' : 'video', size || 12);
  const kindMark = (e, size) => (e.kind === 'alarm' ? mark('clock', size) : e.kind === 'reminder' ? mark('bell', size)
    : isGoogle(e) ? mark('calendar', size) : e.place ? placeMark(e.place, size) : mark('calendar', size));
  const make = (tag, cls, text) => S().make(tag, cls, text);

  // ── В7.43 an event on the hours ──────────────────────────────────────────────────────────────────────────────
  // o: { density: 'full' | 'mid' | 'tight', height, now, onOpen(e), wide } (wide — the Mac's week: the whole name and its time).
  //   full — a column of a day: «Анна Смирнова · Английский» and «19:00–20:00 · Zoom · Sent»;
  //   mid  — a column of three days or of the Mac's week: the name, and the time with the mark of the place;
  //   tight — a column of the iPhone's week: the first name, the start under it.
  function eventCard(e, o) {
    o = o || {};
    const density = o.density || 'full';
    const now = o.now || new Date();
    const pill = isPill(e);
    const past = (pill ? e.start : endOf(e)) < now;
    const b = make('button', `wc-cal-event${pill ? ' is-pill' : ''}${isGoogle(e) ? ' is-google' : ''}${past ? ' is-past' : ''} is-${density}`);
    b.type = 'button';
    b.dataset.id = e.id;
    b.setAttribute('aria-label', `${headline(e)}, ${span(e)}`);
    b.addEventListener('click', () => o.onOpen && o.onOpen(e));
    if (pill) {
      const icon = make('span', 'wc-cal-event-mark');
      icon.appendChild(e.kind === 'alarm' ? mark('clock', 12) : mark('bell', 12));
      // A column of three days or of the iPhone's week: the bell and the hour («08»); a day and the Mac's week: the
      // time and the words.
      const whole = density === 'full' || !!o.wide;
      b.classList.toggle('is-bare', !whole);
      b.append(icon, make('span', 'wc-cal-event-time', whole ? hm(e.start) : pad(e.start.getHours())));
      if (whole) b.appendChild(make('span', 'wc-cal-event-name', headline(e)));
      return b;
    }
    const h = o.height || 60;
    const sent = sentWord(e);
    const name = make('span', 'wc-cal-event-name');
    if (placedByBase(e) && density === 'full') {
      const sp = make('span', 'wc-cal-event-spark');
      sp.appendChild(M().sparkle(12));
      name.appendChild(sp);
    }
    if ((h < 40 && density === 'full') || (h < 44 && o.wide && density === 'mid')) {
      // A short one: the time and the name on one line (the Mac's week: two lines need 44).
      b.classList.add('is-short');
      const line = make('span', 'wc-cal-event-line');
      line.append(make('span', 'wc-cal-event-time', hm(e.start)));
      name.appendChild(document.createTextNode(headline(e)));
      line.appendChild(name);
      if (sent && sent.failed) line.appendChild(make('span', 'wc-cal-event-bad', 'Not sent'));
      b.appendChild(line);
      return b;
    }
    name.appendChild(document.createTextNode(density === 'full' || o.wide ? headline(e) : density === 'mid' ? whom(e) : shortName(e)));
    b.appendChild(name);
    if (density === 'tight') {
      // The first name, red when a message did not go; the start under it on a card high enough.
      if (sent && sent.failed) b.classList.add('is-failed');
      if (h >= 64) b.appendChild(make('span', 'wc-cal-event-meta', hm(e.start)));
      return b;
    }
    if (density === 'mid' && !o.wide) {
      // A column of three days: whom (two lines when the card has room), under it the start or, red, «Not sent».
      if (h >= 52) b.classList.add('is-two');
      if (sent && sent.failed) b.appendChild(make('span', 'wc-cal-event-bad', 'Not sent'));
      else if (h >= 34) b.appendChild(make('span', 'wc-cal-event-meta', hm(e.start)));
      return b;
    }
    const meta = make('span', 'wc-cal-event-meta');
    meta.appendChild(make('span', 'wc-cal-event-time', span(e)));
    const place = isGoogle(e) ? 'Google' : PLACE_NAMES[e.place] || null;
    if (place) {
      meta.appendChild(isGoogle(e) ? mark('calendar', 12) : placeMark(e.place, 12));
      meta.appendChild(make('span', 'wc-cal-event-place', place));
    }
    if (sent && density === 'full') {
      meta.appendChild(make('span', 'wc-cal-event-dot', '·'));
      meta.appendChild(make('span', sent.failed ? 'wc-cal-event-bad' : 'wc-cal-event-sent', sent.text));
    }
    b.appendChild(meta);
    // The Mac's week: the name and the time; a message that did not go — the red word under them.
    if (density !== 'full' && sent && sent.failed) b.appendChild(make('span', 'wc-cal-event-bad', 'Not sent'));
    return b;
  }
  // An event of the whole day: a line in a frame, the page of a calendar and the title; «all day» at the right (Day).
  function allDayLine(e, o) {
    o = o || {};
    const b = make('button', `wc-cal-event is-allday${o.compact ? ' is-compact' : ''}`);
    b.type = 'button';
    b.setAttribute('aria-label', `${headline(e)}, all day`);
    const icon = make('span', 'wc-cal-event-mark');
    icon.appendChild(mark('calendar', 12));
    if (!o.compact) b.appendChild(icon);
    b.appendChild(make('span', 'wc-cal-event-name', headline(e)));
    if (!o.compact) b.appendChild(make('span', 'wc-cal-event-allday', 'all day'));
    b.addEventListener('click', () => o.onOpen && o.onOpen(e));
    return b;
  }

  // ── В7.44 the hours of the days and the line «now» ───────────────────────────────────────────────────────────
  // The places of a day: what overlaps stands side by side, each in its column (CalLayout of the iPhone, by the pixels
  // the parts take: a meeting from its start to its end and not less than 30, a reminder centred on its time).
  const PAD = 10;
  const MIN_CARD = 30;
  const PILL = 28;
  function placesOf(events, day, hourH) {
    const y = (d) => PAD + ((d.getTime() - day.getTime()) / 3600000) * hourH;
    const bottom = PAD + 24 * hourH;
    const items = events.filter((e) => !e.allDay).map((e) => {
      if (isPill(e)) {
        const c = y(e.start);
        return { e, top: Math.max(0, c - PILL / 2), bottom: Math.max(0, c - PILL / 2) + PILL };
      }
      const top = Math.max(PAD, y(e.start));
      return { e, top, bottom: Math.min(bottom, Math.max(top + MIN_CARD, y(endOf(e)))) };
    }).sort((a, b) => a.top - b.top || b.bottom - a.bottom);
    const out = [];
    let group = [];
    let ends = [];
    let groupEnd = -Infinity;
    const flush = () => {
      const n = Math.max(1, ends.length);
      for (const g of group) out.push(Object.assign(g, { columns: n }));
      group = [];
      ends = [];
    };
    for (const it of items) {
      if (it.top >= groupEnd && group.length) flush();
      let col = ends.findIndex((end) => end <= it.top + 0.5);
      if (col < 0) { col = ends.length; ends.push(it.bottom); } else ends[col] = it.bottom;
      it.column = col;
      group.push(it);
      groupEnd = Math.max(groupEnd === -Infinity ? it.bottom : groupEnd, it.bottom);
    }
    if (group.length) flush();
    return out;
  }
  // o: { days: [Date], eventsOn(day) → [], hourH, now, density, wide, onOpen }. The box is 24 hours high plus PAD above
  // and below: 08:00 stands PAD under the top of the view when the box is scrolled to 8 hours.
  function hoursGrid(o) {
    const now = o.now || new Date();
    const hourH = o.hourH;
    const grid = make('div', 'wc-cal-grid-hours');
    grid.style.height = `${Math.round(24 * hourH + 2 * PAD)}px`;
    for (let h = 0; h <= 24; h++) {
      const top = Math.round(PAD + h * hourH);
      const line = make('div', 'wc-cal-hour');
      line.style.top = `${top}px`;
      if (h < 24) line.appendChild(make('span', 'wc-cal-hour-time', `${pad(h)}:00`));
      grid.appendChild(line);
    }
    const cols = make('div', `wc-cal-cols is-${o.days.length}`);
    o.days.forEach((day, i) => {
      const col = make('div', 'wc-cal-col');
      col.style.left = `${(i / o.days.length) * 100}%`;
      col.style.width = `${100 / o.days.length}%`;
      for (const p of placesOf(o.eventsOn(day), day, hourH)) {
        const card = eventCard(p.e, { density: o.density, height: p.bottom - p.top, now, onOpen: o.onOpen, wide: o.wide });
        card.style.top = `${Math.round(p.top)}px`;
        if (!isPill(p.e)) card.style.height = `${Math.max(MIN_CARD, Math.round(p.bottom - p.top) - 2)}px`;
        card.style.left = `calc(${(p.column / p.columns) * 100}% + 2px)`;
        if (isPill(p.e)) card.style.maxWidth = `calc(${100 / p.columns}% - 4px)`;
        else card.style.width = `calc(${100 / p.columns}% - 4px)`;
        col.appendChild(card);
      }
      // «Now»: a line 2 of the yellow with a dot 8 at its start, on today only, by the minute.
      if (sameDay(day, now)) {
        const line = make('div', 'wc-cal-now');
        line.style.top = `${Math.round(PAD + ((now.getTime() - day.getTime()) / 3600000) * hourH) - 1}px`;
        line.setAttribute('aria-hidden', 'true');
        col.appendChild(line);
      }
      cols.appendChild(col);
    });
    grid.appendChild(cols);
    return grid;
  }

  // ── В7.45 a day of a week ────────────────────────────────────────────────────────────────────────────────────
  // The head of a day over its column (CalendarView.swift dayHead): the weekday 12 in grey and the number 15/600 in a circle
  // 28, 52 high, the whole share of the width is the button; today — the weekday in `--attention` and the circle of the
  // main button; `chosen` — the circle of the chosen ground; `dot` — a dot 4 under the number (a day that has something).
  // o: { now, chosen, dot, onPick(day) }.
  function dayButton(d, o) {
    o = o || {};
    const now = o.now || new Date();
    const chosen = !!o.chosen;
    const today = sameDay(d, now);
    const b = make('button', `wc-cal-day${chosen ? ' is-chosen' : ''}${today ? ' is-today' : ''}`);
    b.type = 'button';
    b.setAttribute('aria-label', dayWords(d));
    if (chosen) b.setAttribute('aria-current', 'date');
    b.append(make('span', 'wc-cal-day-name', WD[wdOf(d)]), make('span', 'wc-cal-day-num', String(d.getDate())));
    if (o.dot) b.appendChild(make('span', 'wc-cal-dot'));
    b.addEventListener('click', () => o.onPick && o.onPick(d));
    return b;
  }

  // ── В7.46 the grid of a month ────────────────────────────────────────────────────────────────────────────────
  // o: { size: 'big' (the view Month: numbers 15/600 in a circle 28, rows of 44) | 'small' (the Mac's left column:
  //      numbers 12 in cells of 22) | 'year' (a month of the year: the name 15/650, numbers 12 alone in rows of 18),
  //      chosen (big: the chosen day has the circle of the chosen ground), week: [from, to] (small: the days of the week
  //      shown stand on a band), now, busy(key) → bool, onPick(day), head (the name over the grid) }.
  // Days of other months are not shown (CalMonthGrid of the iPhone); the past days are faint; today — the circle of the
  // main button; a day that has something — the dot 4 under its number.
  function monthGrid(month, o) {
    o = o || {};
    const now = o.now || new Date();
    const size = o.size || 'small';
    const root = make('div', `wc-cal-grid is-${size}`);
    if (o.head) root.appendChild(make('div', 'wc-cal-grid-head', o.head));
    const cells = make('div', 'wc-cal-grid-cells');
    if (size !== 'year') for (const w of WD) cells.appendChild(make('span', 'wc-cal-grid-wd', w));
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    for (let i = 0; i < wdOf(first); i++) cells.appendChild(make('span', 'wc-cal-grid-gap'));
    for (let d = first; d.getMonth() === first.getMonth(); d = addDays(d, 1)) {
      const day = d;
      const today = sameDay(day, now);
      const chosen = size === 'big' && !today && sameDay(day, o.chosen);
      const past = day < dayStart(now);
      const inWeek = size === 'small' && o.week && day >= o.week[0] && day <= o.week[1];
      const cls = `wc-cal-date${chosen ? ' is-chosen' : ''}${today ? ' is-today' : ''}${past ? ' is-past' : ''}${inWeek ? ' is-week' : ''}`;
      const n = make(size === 'year' ? 'span' : 'button', cls);
      if (size !== 'year') {
        n.type = 'button';
        n.setAttribute('aria-label', dayWords(day));
        n.addEventListener('click', () => o.onPick && o.onPick(day));
      }
      n.appendChild(make('span', 'wc-cal-date-num', String(day.getDate())));
      if (size !== 'year' && !today && o.busy && o.busy(dayKey(day))) n.appendChild(make('span', 'wc-cal-dot'));
      cells.appendChild(n);
    }
    root.appendChild(cells);
    return root;
  }

  // ── The section ──────────────────────────────────────────────────────────────────────────────────────────────
  const WIDE = 760;
  const VIEWS_NARROW = [['day', 'Day'], ['three', '3 days'], ['week', 'Week'], ['month', 'Month'], ['year', 'Year']];
  const VIEWS_WIDE = [['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['year', 'Year']];
  const SAMPLE_WORDS = 'Test data: the base does not give the calendar yet.';
  const SHOWN_KEY = 'lexCalendarShown';
  const SHEET = 'wc-cal-sheet';

  function createSection(deps) {
    let view = 'day';
    let selected = dayStart(new Date());
    let wide = false;
    let data = null;          // { mode, version, events }
    let readSpan = null;      // { from, to } of what was read
    let settings = null;
    let hourH = 0;
    let scrollAt = null;      // the hour at the top of the hours, kept for the next painting; null — the working day's start
    let pendingReveal = null; // a notification that opened the section before it was on the screen
    const manual = new Map(); // «Send it yourself»: the text of a notification, by meeting (memory only)
    let shown = { meeting: true, reminder: true, alarm: true, google: true };
    try { shown = Object.assign(shown, JSON.parse(localStorage.getItem(SHOWN_KEY) || '{}')); } catch (_) { /* defaults */ }

    // The tools of the head: «+» on a narrow window; the words of the period, the views, the arrows, «Today» and «New» on
    // the Mac's (CalV27). They stand in the bar of the window (deps.head), else in the frame's own bar.
    const plus = S().iconButton('lex-section-icon', svgText('plus'), 'New', () => openForm(newDraft('meeting'), true));
    const barPrev = S().iconButton('lex-section-icon', svgText('left'), 'Previous', () => move(-1));
    const barNext = S().iconButton('lex-section-icon', svgText('right'), 'Next', () => move(1));
    const barToday = M().button({ label: 'Today' });
    barToday.addEventListener('click', () => goToday());
    const barNew = M().button({ label: 'New', main: true, icon: mark('plus', 16) });
    barNew.addEventListener('click', () => openForm(newDraft('meeting'), true));
    const headWords = make('div', 'wc-cal-head-words');
    const tabs = UI().tabs({ label: 'Views', items: [], selected: view, onSelect: (id) => setView(id) });
    tabs.classList.add('wc-cal-tabs');
    const headTools = make('div', 'wc-cal-head-tools');
    headTools.append(barPrev, barNext, barToday, barNew);

    const frame = S().createFrame({
      title: 'Calendar',
      cls: 'wc-cal',
      back: deps.back,
      signals: deps.signals,
      // The base (or another device) changed the calendar: calendar.sql gives the open Lex its signal «calendar».
      events: ['calendar'],
      check: () => read(true),
      tools: deps.head ? [] : [plus],
    });
    const { say } = frame;

    // The body is one root of this section; the frame's first screen holds it.
    const root = make('div', 'wc-cal-root');
    const side = make('aside', 'wc-cal-side');
    const main = make('div', 'wc-cal-main');
    const top = make('div', 'wc-cal-top');
    const dateRow = make('div', 'wc-cal-daterow');
    const viewHost = make('div', 'wc-cal-view');
    main.append(top, dateRow, viewHost);
    root.append(side, main);
    frame.body.appendChild(root);

    const dateWords = make('div', 'wc-cal-date-words');
    const todayMark = make('span', 'wc-cal-today', 'Today');
    const toToday = M().button({ label: 'Today' });
    toToday.classList.add('wc-cal-to-today');
    toToday.addEventListener('click', () => goToday());
    const prev = S().iconButton('lex-section-icon', svgText('left'), 'Previous', () => move(-1));
    const next = S().iconButton('lex-section-icon', svgText('right'), 'Next', () => move(1));
    dateRow.append(dateWords, toToday, prev, next);

    // The head: narrow — «Calendar» and «+», the views on a row of their own under it (CalV25); wide — the words of the
    // period and the views by the title, the arrows, Today and New at the right (CalV27).
    let headSaid = null;
    function syncHead() {
      if (!deps.head) {
        if (wide) top.replaceChildren(headWords, tabs, headTools);
        else top.replaceChildren(tabs);
        return;
      }
      const on = frame.isShown();
      const shape = on ? (wide ? 'wide' : 'narrow') : null;
      if (shape === 'narrow' && tabs.parentNode !== top) top.replaceChildren(tabs);
      if (shape === headSaid) return;
      headSaid = shape;
      if (!shape) { deps.head(null); return; }
      deps.head({ title: 'Calendar', nodes: wide ? [headWords, tabs, headTools] : [plus] });
      if (!wide) top.replaceChildren(tabs);
      else top.replaceChildren();
    }

    // ── reading ───────────────────────────────────────────────────────────────────────────────────────────────
    // The window a day needs: from a week before the grid of its month, eight weeks (the base gives 62 days at most).
    function spanOf(d) {
      const from = addDays(monthGridStart(d), -7);
      return { from, to: addDays(from, 56) };
    }
    // The days a view shows lie inside what was read.
    function inside() {
      if (!readSpan) return false;
      const want = view === 'year' ? null : view === 'month' ? [monthGridStart(selected), addDays(monthGridStart(selected), 42)]
        : [daysOf()[0], addDays(daysOf()[daysOf().length - 1], 1)];
      return !!want && want[0] >= readSpan.from && want[1] <= readSpan.to;
    }
    function sampleLine() { say(data && data.mode === 'sample' ? SAMPLE_WORDS : ''); }
    let reading = 0;
    async function read(force) {
      const want = spanOf(selected);
      if (!force && readSpan && readSpan.from.getTime() === want.from.getTime()) return;
      const mine = ++reading;
      let j;
      try {
        j = await deps.call('', { from: want.from.toISOString(), to: want.to.toISOString(), alarms: '1' });
      } catch (e) {
        // A refusal of the server stands in the status line with its words; a call that did not go says nothing
        // (the screen keeps what it has, the frame tries again on the next signal).
        if (e && e.status) { say(String(e.message || ''), true); return; }
        throw e;
      }
      // A later read (another period) was asked meanwhile: its answer is the one the screen shows.
      if (mine !== reading) return;
      const events = (Array.isArray(j && j.events) ? j.events : []).map(eventOf).filter((e) => e && !e.twin)
        .sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1));
      data = { mode: (j && j.mode) || 'base', version: j && j.version, events };
      readSpan = want;
      sampleLine();
      paint();
      if (!settings) {
        deps.call('/settings').then((s) => { settings = s || {}; }).catch(() => {});
      }
    }
    const filtered = (e) => !wide || (isGoogle(e) ? shown.google : shown[e.kind] !== false);
    function eventsOn(day) {
      if (!data) return [];
      const nextDay = addDays(day, 1);
      return data.events.filter((e) => {
        if (!filtered(e)) return false;
        if (e.allDay) return e.start < nextDay && (e.end || new Date(e.start.getTime() + DAY_MS)) > day;
        return e.start >= day && e.start < nextDay;
      });
    }
    const busy = (key) => { const d = fromKey(key); return !!d && eventsOn(d).length > 0; };

    // ── what is shown ─────────────────────────────────────────────────────────────────────────────────────────
    function setView(id) {
      view = id;
      scrollAt = null;
      changed();
    }
    function step() {
      if (view === 'day') return { days: 1 };
      if (view === 'three') return { days: 3 };
      if (view === 'week') return { days: 7 };
      if (view === 'month') return { months: 1 };
      return { months: 12 };
    }
    function move(dir) {
      const s = step();
      selected = s.days ? addDays(selected, dir * s.days) : new Date(selected.getFullYear(), selected.getMonth() + dir * s.months,
        Math.min(selected.getDate(), 28));
      changed();
    }
    function goToday() {
      selected = dayStart(new Date());
      scrollAt = null;
      changed();
    }
    function pick(day, to) {
      selected = dayStart(day);
      if (to && to !== view) { view = to; scrollAt = null; }
      changed();
    }
    function changed() {
      paint();
      if (!inside()) read(false).catch((e) => console.warn('[calendar] read:', e && e.message));
    }
    // The days a view of hours shows: three — yesterday, the day, tomorrow; the week — from its Monday.
    function daysOf() {
      if (view === 'three') return [addDays(selected, -1), selected, addDays(selected, 1)];
      if (view === 'week') { const m = weekStart(selected); return [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(m, i)); }
      return [selected];
    }

    function paintTop() {
      const now = new Date();
      const items = (wide ? VIEWS_WIDE : VIEWS_NARROW).map(([id, label]) => ({ id, label }));
      tabs.update(items, view);
      let words;
      if (view === 'day') words = dayWords(selected);
      else if (view === 'three') words = spanWords(addDays(selected, -1), addDays(selected, 1), wide);
      else if (view === 'week') words = spanWords(weekStart(selected), addDays(weekStart(selected), 6), wide);
      else if (view === 'month') words = monthWords(selected);
      else words = String(selected.getFullYear());
      // Narrow: the line of the date under the views; wide: the words by the title, the arrows in the head.
      headWords.textContent = words;
      dateRow.hidden = wide;
      dateRow.classList.toggle('is-big', view === 'month' || view === 'year');
      dateWords.replaceChildren(document.createTextNode(words));
      const onToday = view === 'day' ? sameDay(selected, now)
        : view === 'three' || view === 'week' ? daysOf().some((d) => sameDay(d, now))
          : view === 'month' ? selected.getFullYear() === now.getFullYear() && selected.getMonth() === now.getMonth()
            : selected.getFullYear() === now.getFullYear();
      if (view === 'day' && onToday) dateWords.appendChild(todayMark);
      toToday.hidden = onToday;
      syncHead();
    }

    function paint() {
      root.classList.toggle('is-wide', wide);
      paintTop();
      paintSide();
      const keep = viewHost.querySelector('.wc-cal-hours');
      if (keep && scrollAt !== null && hourH) scrollAt = keep.scrollTop / hourH;
      viewHost.replaceChildren();
      viewHost.dataset.view = view;
      if (view === 'month') return paintMonth();
      if (view === 'year') return paintYear();
      return paintHours();
    }

    // Day, 3 days, Week: the head of the days (several), the events of the whole day, the hours.
    function paintHours() {
      const now = new Date();
      const days = daysOf();
      const many = days.length > 1;
      viewHost.classList.toggle('is-week', view === 'week');
      if (many) {
        const row = make('div', 'wc-cal-days');
        row.appendChild(make('span', 'wc-cal-days-gap'));
        for (const d of days) row.appendChild(dayButton(d, { now, onPick: (x) => pick(x, 'day') }));
        viewHost.appendChild(row);
      }
      const allDay = days.map((d) => eventsOn(d).filter((e) => e.allDay));
      if (allDay.some((a) => a.length)) {
        if (many) {
          const row = make('div', 'wc-cal-allday');
          row.appendChild(make('span', 'wc-cal-allday-label', 'all day'));
          for (const list of allDay) {
            const cell = make('div', 'wc-cal-allday-cell');
            for (const e of list) cell.appendChild(allDayLine(e, { compact: true, onOpen: openEvent }));
            row.appendChild(cell);
          }
          viewHost.appendChild(row);
        } else {
          const box = make('div', 'wc-cal-allday-one');
          for (const e of allDay[0]) box.appendChild(allDayLine(e, { onOpen: openEvent }));
          viewHost.appendChild(box);
        }
      } else if (many) {
        viewHost.lastChild.classList.add('is-last');
      }
      const scroller = make('div', 'wc-cal-hours');
      viewHost.appendChild(scroller);
      // Nothing on the day: one line over the hours.
      if (!many && data && !days.some((d) => eventsOn(d).length)) viewHost.appendChild(make('div', 'wc-cal-nothing', 'Nothing here'));
      // The height of an hour: the whole working day 08:00–22:00 in the box, not lower than 40 (a small window scrolls).
      const h = scroller.clientHeight;
      if (!h) return;   // not on the screen yet (warm): painted when shown
      hourH = Math.max(40, Math.floor((h - 2 * PAD) / 14));
      const label = view === 'week' && !wide ? 40 : 44;
      const colW = (scroller.clientWidth - 16 - label - 8) / days.length;
      const density = !many ? 'full' : colW >= 200 ? 'full' : colW >= 90 ? 'mid' : 'tight';
      scroller.appendChild(hoursGrid({ days, eventsOn: (d) => eventsOn(d), hourH, now, density, wide, onOpen: openEvent }));
      // Opens on 08:00; when now is outside the working day of a day shown — an hour before now.
      let first = 8;
      if (days.some((d) => sameDay(d, now)) && (now.getHours() < 8 || now.getHours() >= 22)) first = Math.max(0, Math.min(now.getHours() - 1, 10));
      // The place is kept as an hour, not as pixels: the height of an hour changes with the box (a line «all day» came).
      scroller.scrollTop = Math.round((scrollAt === null ? first : scrollAt) * hourH);
      if (scrollAt !== null) scrollAt = scroller.scrollTop / hourH;
      const hh = hourH;
      scroller.addEventListener('scroll', () => { if (scrollAt !== null || scroller.scrollTop !== Math.round(first * hh)) scrollAt = scroller.scrollTop / hh; }, { passive: true });
    }

    // Month: the grid of the month, the list of the chosen day under it. A press on a number — its day under the grid; on
    // the chosen one again — that day by the hours.
    function paintMonth() {
      const now = new Date();
      const box = make('div', 'wc-cal-month');
      box.appendChild(monthGrid(selected, {
        size: 'big', chosen: selected, now, busy,
        onPick: (d) => (sameDay(d, selected) ? pick(d, 'day') : pick(d)),
      }));
      const list = make('div', 'wc-cal-list');
      list.appendChild(make('div', 'wc-cal-list-head', dayTitle(selected, now)));
      const events = eventsOn(selected);
      if (data && !events.length) list.appendChild(make('div', 'wc-cal-nothing', 'Nothing here'));
      for (const e of events) {
        const past = (isPill(e) ? e.start : endOf(e)) < now && !e.allDay;
        const row = make('button', `wc-cal-row${past ? ' is-past' : ''}${isPill(e) || isGoogle(e) ? ' is-plate' : ''}`);
        row.type = 'button';
        row.setAttribute('aria-label', `${span(e)}, ${headline(e)}`);
        const icon = make('span', 'wc-cal-row-mark');
        icon.appendChild(kindMark(e, 12));
        row.append(make('span', 'wc-cal-row-time', e.allDay ? 'all day' : hm(e.start)), icon, make('span', 'wc-cal-row-name', headline(e)));
        const sent = sentWord(e);
        if (sent && sent.failed) row.appendChild(make('span', 'wc-cal-row-bad', 'Not sent'));
        row.addEventListener('click', () => openEvent(e));
        list.appendChild(row);
      }
      box.appendChild(list);
      viewHost.appendChild(box);
    }

    // Year: twelve months, three in a row; the current month's name in `--attention`, today in the circle. A press on a
    // month — its grid.
    function paintYear() {
      const now = new Date();
      const box = make('div', 'wc-cal-year');
      for (let m = 0; m < 12; m++) {
        const month = new Date(selected.getFullYear(), m, 1);
        const current = now.getFullYear() === month.getFullYear() && now.getMonth() === m;
        const b = make('button', `wc-cal-year-month${current ? ' is-now' : ''}`);
        b.type = 'button';
        b.setAttribute('aria-label', monthWords(month));
        b.appendChild(monthGrid(month, { size: 'year', now, head: MONTH[m] }));
        b.addEventListener('click', () => pick(current ? now : month, 'month'));
        box.appendChild(b);
      }
      viewHost.appendChild(box);
    }

    // The Mac's left column: what to show, and the grid of the month — a press on a number shows its week.
    function paintSide() {
      side.replaceChildren();
      side.hidden = !wide;
      if (!wide) return;
      const toggle = (key, title) => S().settingRow({
        title, id: key,
        toggle: { on: shown[key] !== false, onChange: (on) => {
          shown[key] = on;
          try { localStorage.setItem(SHOWN_KEY, JSON.stringify(shown)); } catch (_) { /* this device only */ }
          paint();
        } },
      });
      const block = make('div', 'wc-cal-side-top');
      block.append(S().groupLabel('Calendars'), S().settingsBlock([
        toggle('meeting', 'Meetings'), toggle('reminder', 'Reminders'), toggle('alarm', 'Alarms'), toggle('google', 'Google · read only'),
      ]));
      const ws = view === 'week' ? [weekStart(selected), addDays(weekStart(selected), 6)] : null;
      const grid = monthGrid(selected, { size: 'small', now: new Date(), busy, week: ws, head: monthWords(selected), onPick: (d) => pick(d, 'week') });
      side.append(block, grid);
    }

    // ── the sheet of a record (CalEvent) ──────────────────────────────────────────────────────────────────────
    let sheet = null;
    const closeSheet = () => { if (sheet) { const s = sheet; sheet = null; s.close(); } };
    function copyButton(label, text, icon) {
      const b = M().button({ label, icon: mark(icon || 'copy', 16) });
      b.addEventListener('click', async () => {
        let ok = false;
        try { await navigator.clipboard.writeText(text); ok = true; } catch (_) { ok = false; }
        if (!ok) return;
        const words = b.querySelector('.lex-btn-words');
        words.textContent = 'Copied';
        setTimeout(() => { words.textContent = label; }, 1500);
      });
      return b;
    }
    const label = (text) => make('div', 'wc-cal-sheet-label', text);
    function eventBody(e, cancelled) {
      const out = [];
      const now = new Date();
      // The decision on top: a message to the person did not go.
      const m = e.kind === 'meeting' && e.messages && e.messages.willSend ? e.messages : null;
      const failedLink = m && m.link && m.link.state === 'failed' ? m.link : null;
      const failedRem = m && m.reminder && m.reminder.state === 'failed' ? m.reminder : null;
      const failed = failedLink || failedRem;
      if (failed) {
        const band = make('div', 'wc-cal-band');
        const t = make('div', 'wc-cal-band-title');
        t.append(mark('alert', 16), document.createTextNode(failedLink ? 'The link did not go' : 'The reminder did not go'));
        const reason = failed.reason ? String(failed.reason).replace(/[.\s]+$/, '') : '';
        band.append(t, make('div', 'wc-cal-band-line', reason ? `${reason}. Send it yourself.` : 'Send it yourself.'));
        out.push(band);
      }
      const top = make('div', 'wc-cal-sheet-top');
      if (placedByBase(e)) {
        const p = make('div', 'wc-cal-placed');
        p.append(M().sparkle(12), document.createTextNode('Placed by the base'));
        top.appendChild(p);
      }
      if (cancelled) top.appendChild(make('div', 'wc-cal-cancelled', 'The meeting was cancelled'));
      top.appendChild(make('div', 'wc-cal-sheet-title', headline(e)));
      top.appendChild(make('div', 'wc-cal-sheet-when', `${sheetDay(e.start, now)} · ${span(e)}`));
      const fact = (icon, text) => { const n = make('div', 'wc-cal-fact'); n.append(mark(icon, 14), document.createTextNode(text)); return n; };
      const rep = repeatWords(e.repeatDays, e.repeatUntil);
      if (rep) top.appendChild(fact('repeat', rep));
      if (e.kind === 'meeting' && e.remindMinutes != null) top.appendChild(fact('bell', remindWords(e.remindMinutes)));
      if (e.loud) top.appendChild(fact('bell', 'Rings like an alarm, even in silent mode'));
      if (e.deal) top.appendChild(fact('deal', `Deal: ${e.deal}`));
      out.push(top);
      // Join and Copy link; a meeting with no link says why.
      if (e.kind === 'meeting' || (isGoogle(e) && e.link)) {
        if (e.link && /^https?:\/\//i.test(e.link)) {
          const row = make('div', 'wc-cal-sheet-buttons');
          const join = M().button({ label: 'Join', main: true, icon: placeMark(e.place, 16) });
          join.addEventListener('click', () => { try { global.open(e.link, '_blank', 'noopener'); } catch (_) { /* the shell */ } });
          row.append(join, copyButton('Copy link', e.link));
          out.push(row);
        } else if (e.kind === 'meeting') {
          out.push(make('div', 'wc-cal-sheet-note', !e.place ? 'No place chosen.' : e.place === 'unknown' ? 'Place not agreed — no link will be sent.' : 'This place has no link in the base settings: only the reminder goes to the person.'));
        }
      }
      // «Send it yourself»: the text of a message the base does not send itself, from the tap on its notification.
      const own = e.item && manual.get(e.item);
      if (own) {
        out.push(label('Send it yourself'));
        const box = make('div', 'wc-cal-sheet-card');
        box.append(make('div', 'wc-cal-quote', own), copyButton('Copy', own));
        out.push(box);
      }
      // What goes to the person.
      if (e.kind === 'meeting' && (e.person || e.messages)) {
        out.push(label('Messages to the person'));
        const ms = e.messages;
        const ch = ms && CHANNEL_NAMES[ms.channel];
        if (ms && ms.willSend && ms.test) out.push(make('div', 'wc-cal-sheet-note', `Check: the messages go to your test chat${ch ? ` in ${ch}` : ''}, not to the person.`));
        const block = make('div', 'wc-cal-steps');
        if (!ms) block.appendChild(make('div', 'wc-cal-step is-quiet', e.notifyPerson === false ? `Not sent: ${whyNot('off')}` : 'Reminder — queued'));
        else if (!ms.willSend) block.appendChild(make('div', 'wc-cal-step is-quiet', `Not sent: ${whyNot(ms.whyNot)}`));
        else {
          for (const [name, s] of [['Reminder', ms.reminder], ['Link', ms.link]]) {
            if (!s) continue;
            const bad = s.state === 'failed';
            const n = make('div', `wc-cal-step${bad ? ' is-bad' : ''}`);
            n.append(mark(bad ? 'alert' : 'check', 16), make('span', '', stepWords(name, s, ch)));
            block.appendChild(n);
          }
        }
        out.push(block);
      }
      // Where it came from.
      const words = e.origin && originWords(e.origin);
      if (words) {
        out.push(label('From'));
        const box = make('div', 'wc-cal-sheet-card');
        box.appendChild(make('div', 'wc-cal-origin', words));
        if (e.origin.quote) box.appendChild(make('div', 'wc-cal-quote', `«${e.origin.quote}»`));
        if (e.origin.url) {
          const icon = (e.origin.channel && M().channel(e.origin.channel)) || mark('open', 16);
          const b = M().button({ label: 'Open the chat', icon });
          b.addEventListener('click', () => { try { global.open(e.origin.url, '_blank', 'noopener'); } catch (_) { /* the shell */ } });
          box.appendChild(b);
        }
        out.push(box);
      }
      if (isGoogle(e)) {
        out.push(make('div', 'wc-cal-sheet-note', 'A Google Calendar event: view only here.'));
        if (e.googleURL) {
          const b = M().button({ label: 'Open in Google Calendar', icon: mark('calendar', 16) });
          b.addEventListener('click', () => { try { global.open(e.googleURL, '_blank', 'noopener'); } catch (_) { /* the shell */ } });
          out.push(b);
        }
      }
      return out;
    }
    const DELETE = { meeting: ['Delete meeting', 'Delete the meeting?'], reminder: ['Delete reminder', 'Delete the reminder?'], alarm: ['Delete alarm', 'Delete the alarm?'] };
    function openEvent(e, opts) {
      opts = opts || {};
      closeSheet();
      const nodes = eventBody(e, opts.cancelled);
      const error = make('div', 'wc-cal-error');
      error.hidden = true;
      nodes.push(error);
      if (!e.readonly && e.item && !opts.cancelled) {
        const foot = make('div', 'wc-cal-sheet-foot');
        const edit = M().button({ label: 'Edit', icon: mark('pencil', 16) });
        edit.addEventListener('click', () => openForm(draftOf(e), false));
        const [delWord, ask] = DELETE[e.kind] || DELETE.meeting;
        const del = M().button({ label: delWord, icon: mark('trash', 16) });
        del.classList.add('wc-cal-danger');
        del.addEventListener('click', async () => {
          const repeating = e.repeatDays.length && e.occurrence && e.occurrence !== 'once';
          if (repeating) {
            UI().menu(del, [
              { head: ask },
              { label: 'Only this day', danger: true, onSelect: () => remove(e, e.occurrence, error) },
              { label: 'All days', danger: true, onSelect: () => remove(e, null, error) },
            ]);
            return;
          }
          const yes = await UI().confirm(ask, e.kind === 'meeting' ? 'Unsent messages to the person will be cancelled.' : '',
            { okText: 'Delete', cancelText: 'Cancel', danger: true });
          if (yes) remove(e, null, error);
        });
        foot.append(edit, del);
        nodes.push(foot);
      }
      const s = UI().sheet(SHEET, kindTitle(e), nodes, () => { if (sheet === s) sheet = null; });
      s.body.classList.add('wc-cal-sheet');
      sheet = s;
    }
    async function remove(e, occurrence, error) {
      const body = { op: 'delete', item: e.item, lex: { command: S().newOpId() } };
      if (occurrence && occurrence !== 'once') body.occurrence = occurrence;
      try {
        await deps.call('', null, body);
      } catch (err) {
        error.textContent = refusalWords(err);
        error.hidden = false;
        return;
      }
      closeSheet();
      await read(true).catch(() => {});
    }
    const refusalWords = (err) => (err && err.status ? String(err.message || '') : 'No connection to the Lex server.');

    // ── the form (CalForm) ────────────────────────────────────────────────────────────────────────────────────
    function newDraft(kind) {
      const now = new Date();
      let start;
      if (sameDay(selected, now)) start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.min(now.getHours() + 1, 23), 0);
      else start = new Date(selected.getFullYear(), selected.getMonth(), selected.getDate(), 10, 0);
      if (start < now) start = new Date(now.getTime() + 3600000);
      const st = settings || {};
      const minutes = Math.max(15, Number(st.minutes) || 60);
      return {
        kind, item: null, before: null, title: '', person: null, start, end: new Date(start.getTime() + minutes * 60000),
        repeatDays: [], repeatUntil: null,
        place: FORM_PLACES.includes(st.place) ? st.place : 'unknown', link: '',
        remindMinutes: null, notifyPerson: null, loud: false,
        command: S().newOpId(),
      };
    }
    function draftOf(e) {
      return {
        kind: e.kind, item: e.item, before: e, title: e.title, person: e.person, start: e.start,
        end: e.end || new Date(e.start.getTime() + 3600000), repeatDays: e.repeatDays.slice(), repeatUntil: e.repeatUntil,
        place: e.place || 'unknown', link: e.place === 'link' ? (e.link || '') : '', remindMinutes: e.remindMinutes == null ? null : e.remindMinutes,
        notifyPerson: e.notifyPerson, loud: e.loud, command: S().newOpId(),
      };
    }
    const iso = (d) => d.toISOString();
    const repeatField = (d) => (d.repeatDays.length ? (d.repeatUntil ? { days: d.repeatDays.slice().sort(), until: d.repeatUntil } : { days: d.repeatDays.slice().sort() }) : null);
    // The fields of a new one, by the contract's names (CalDraft.fields).
    function fieldsOf(d) {
      const f = { kind: d.kind, title: d.title.trim(), start: iso(d.start), repeat: repeatField(d) };
      if (d.kind === 'meeting') {
        f.end = iso(d.end);
        f.person = d.person ? d.person.id : null;
        f.place = d.place || null;
        if (d.place === 'link') f.link = d.link.trim();
        // Only Gennady's own choice goes: without it the base counts the time by how soon the meeting is.
        if (d.remindMinutes != null) f.remind_minutes = d.remindMinutes;
        if (d.person && d.notifyPerson != null) f.notify_person = d.notifyPerson;
      }
      if (d.kind !== 'alarm') f.loud = !!d.loud;
      return f;
    }
    // Only what changed since the form was opened (CalDraft.changes).
    function changesOf(d) {
      const e = d.before;
      const all = fieldsOf(d);
      const out = {};
      if (d.title.trim() !== e.title) out.title = all.title;
      if (Math.abs(d.start - e.start) >= 1000) out.start = all.start;
      if (d.repeatDays.slice().sort().join() !== e.repeatDays.slice().sort().join()) out.repeat = all.repeat;
      if (d.kind === 'meeting') {
        if (Math.abs(d.end - (e.end || e.start)) >= 1000) out.end = all.end;
        if ((d.person && d.person.id) !== (e.person && e.person.id)) out.person = all.person;
        if (d.place !== e.place) out.place = all.place;
        if (d.place === 'link' && d.link.trim() !== (e.link || '')) out.link = all.link;
        if (d.remindMinutes != null && d.remindMinutes !== e.remindMinutes) out.remind_minutes = d.remindMinutes;
        if (d.notifyPerson != null && d.notifyPerson !== e.notifyPerson) out.notify_person = d.notifyPerson;
      }
      if (d.kind !== 'alarm' && !!d.loud !== !!e.loud) out.loud = !!d.loud;
      return out;
    }
    function problemOf(d) {
      if (d.kind === 'reminder' && !d.title.trim()) return 'Write the text of the reminder.';
      if (d.kind === 'meeting' && d.end <= d.start) return 'The end is before the start.';
      if (d.kind === 'meeting' && d.place === 'link') {
        const l = d.link.trim();
        if (!l) return 'Paste the link of the call.';
        if (!/^https?:\/\//i.test(l)) return 'The link starts with https://';
      }
      return null;
    }
    const snapshot = (d) => JSON.stringify(Object.assign({}, d, { before: null, command: null }));
    const notifyOn = (d) => !!d.person && (d.notifyPerson == null ? true : d.notifyPerson);
    function notifyNote(d) {
      const p = d.person;
      if (!p) return 'Without a person no messages go: only you are reminded.';
      if (p.personal) return 'The base marks this person as personal: no messages go.';
      if (!p.hasChat) return 'There is no chat with this person: the messages have nowhere to go.';
      if (!notifyOn(d)) return 'Only you are reminded.';
      if (p.channel === 'profi') return 'The reminder comes to you; on Профи.ру the base does not send itself — it sends you the text for the person in time.';
      const ch = CHANNEL_NAMES[p.channel];
      const test = settings && settings.base_mode === 'test' ? ' Now a check: it goes to your test chat, not to the person.' : '';
      return `The reminder goes to you and to the person${ch ? ` in ${ch}` : ''}; the link — before the start.${test}`;
    }
    function placeNote(d) {
      if (d.place === 'unknown') return 'Nothing agreed yet: the person gets only the short message 5 minutes before; if there is a chat with them, Lex offers you a question to send.';
      if (d.place === 'link') return 'The link goes to the person before the start.';
      const link = settings && settings.places && settings.places[d.place];
      if (link) return `Permanent link from the base: ${shortLink(link)}`;
      return `No permanent ${PLACE_NAMES[d.place] || ''} link in the base: only the reminder goes to the person.`;
    }
    // What «Auto» of the row «Remind» means: the base counts the time by how soon the meeting is (its ladder, `remind_rule`).
    function remindLadderNote() {
      const r = (settings && settings.remind_rule) || {};
      const hours = (m) => (m % 60 === 0 ? `${m / 60} h` : `${m} min`);
      const over = Number(r.long_over) || 300, from = Number(r.short_from) || 120;
      const long = Number(r.long) || 60, short = Number(r.short) || 30;
      return `The base counts it by how soon the meeting is: more than ${hours(over)} ahead — ${hours(long)} before; ${hours(from)} to ${hours(over)} — ${hours(short)} before; closer — only the short message 5 minutes before.`;
    }
    function loudNote(d) {
      if (!d.loud) return 'Rings like an alarm even in silent mode.';
      const when = d.kind === 'reminder' ? 'at the set time'
        : d.remindMinutes == null ? 'at the time of the reminder'
        : d.remindMinutes <= 0 ? 'at the start'
        : (d.remindMinutes >= 60 ? 'an hour before the start' : `${d.remindMinutes} minutes before the start`);
      return `The iPhone rings like an alarm ${when}, even in silent mode or Focus.`;
    }
    // A text field in the place of the value of a row of a setting (the common row has none: В7.59 menu, toggle, go).
    function fieldRow(title, value, hint, onInput, o) {
      const row = S().settingRow({ title });
      const f = make(o && o.multi ? 'textarea' : 'input', 'wc-cal-input');
      if (!(o && o.multi)) f.type = o && o.url ? 'url' : 'text';
      else f.rows = 1;
      f.value = value || '';
      f.placeholder = hint || '';
      f.setAttribute('aria-label', title);
      f.addEventListener('input', () => {
        onInput(f.value);
        if (o && o.multi) {
          // The row keeps its height while the field falls to one line to be measured: else the sheet loses that
          // height for a moment and its scroll jumps on every letter.
          const was = row.style.minHeight;
          row.style.minHeight = `${row.offsetHeight}px`;
          f.style.height = 'auto';
          f.style.height = `${Math.min(f.scrollHeight, 5 * 20 + 4)}px`;
          row.style.minHeight = was;
        }
      });
      row.appendChild(f);
      row.classList.add('has-field');
      return row;
    }
    // The day and the time (CalendarForm.swift): a row whose value opens the choice under it — the browser's own day or
    // hour, as the iPhone opens the system's month or wheel. Another day keeps the hours; a new start moves the end with
    // it, keeping the length; the end earlier than the start is the next morning.
    const dateValue = (t) => `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
    const atTime = (day, value) => { const [h, m] = String(value).split(':').map(Number); return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h || 0, m || 0); };
    function moveDay(d, value) {
      const day = fromKey(value);
      if (!day) return;
      const length = d.end - d.start;
      d.start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), d.start.getHours(), d.start.getMinutes());
      d.end = new Date(d.start.getTime() + length);
    }
    function setStart(d, value) {
      const length = d.end - d.start;
      d.start = atTime(d.start, value);
      d.end = new Date(d.start.getTime() + Math.max(15 * 60000, length));
    }
    function setEnd(d, value) {
      let end = atTime(d.start, value);
      if (end <= d.start) end = addDays(end, 1);
      d.end = end;
    }
    // first — what the form held when it was opened by the person: a form opened again (Stay, back from «With») still
    // asks before its changes are lost.
    function openForm(d, isNew, first) {
      closeSheet();
      const start = first || snapshot(d);
      const error = make('div', 'wc-cal-error');
      error.hidden = true;
      let saving = false;
      let leaving = false;
      let open = null;          // the choice open under its row: 'date' | 'start' | 'time'
      const body = make('div', 'wc-cal-form');
      const repaint = () => { body.replaceChildren(...rows()); };
      const menuRow = (title, value, note, onOpen) => S().settingRow({ title, note, menu: { value, onOpen } });
      const len = () => Math.round((d.end - d.start) / 60000);
      const endNote = () => `Ends at ${hm(d.end)} · ${lengthWords(len())}`;
      // The words of the rows of the day and the time as the choice under them changes, without drawing the form anew
      // (the browser's choice stays open).
      const shownRows = {};
      // The fields of the open picker, to keep them in step with each other.
      let shownPick = [];
      function refresh() {
        const put = (row, value, note) => {
          if (!row) return;
          const v = row.querySelector('.lex-setting-value-words');
          if (v) v.textContent = value;
          const n = row.querySelector('.lex-setting-note');
          if (n && note != null) n.textContent = note;
        };
        put(shownRows.date, dayShortWords(d.start));
        put(shownRows.start, hm(d.start), endNote());
        put(shownRows.time, hm(d.start));
        // The other field of the open picker follows (a new start moves the end); the one being typed in keeps its value.
        for (const f of shownPick) {
          if (f.el !== document.activeElement) f.el.value = f.get();
        }
      }
      function pickRow(which, title, value, note) {
        const row = S().settingRow({ title, note, go: { value, onClick: () => { open = open === which ? null : which; repaint(); } } });
        row.classList.toggle('is-open', open === which);
        shownRows[which] = row;
        return row;
      }
      function picker(which) {
        if (open !== which) return null;
        shownPick = [];
        const box = make('div', 'wc-cal-pick');
        const field = (type, value, label, onSet) => {
          const f = make('input', 'wc-cal-input wc-cal-native');
          f.type = type;
          f.value = value;
          f.setAttribute('aria-label', label);
          f.addEventListener('input', () => { if (f.value) { onSet(f.value); refresh(); } });
          shownPick.push({ el: f, get: () => (type === 'date' ? dateValue(d.start) : label === 'Ends' ? hm(d.end) : hm(d.start)) });
          return f;
        };
        const line = (label, f) => { const n = make('label', 'wc-cal-pick-line'); n.append(make('span', 'wc-cal-pick-label', label), f); return n; };
        if (which === 'date') box.appendChild(line('Date', field('date', dateValue(d.start), 'Date', (v) => moveDay(d, v))));
        else if (which === 'start') {
          box.append(line('Starts', field('time', hm(d.start), 'Starts', (v) => setStart(d, v))),
            line('Ends', field('time', hm(d.end), 'Ends', (v) => setEnd(d, v))));
        } else {
          box.appendChild(line('Time', field('time', hm(d.start), 'Time', (v) => { d.start = atTime(d.start, v); d.end = d.start; })));
        }
        return box;
      }
      function repeatMenu(anchor) {
        const wd = WD[wdOf(d.start)];
        const now = d.repeatDays.slice().sort().join();
        const one = String(wdOf(d.start) + 1);
        UI().menu(anchor, [
          { label: 'Never', checked: now === '', onSelect: () => { d.repeatDays = []; d.repeatUntil = null; repaint(); } },
          { label: 'Every day', checked: now === '1,2,3,4,5,6,7', onSelect: () => { d.repeatDays = [1, 2, 3, 4, 5, 6, 7]; repaint(); } },
          { label: 'Weekdays', checked: now === '1,2,3,4,5', onSelect: () => { d.repeatDays = [1, 2, 3, 4, 5]; repaint(); } },
          { label: `Every week, ${wd}`, checked: now === one, onSelect: () => { d.repeatDays = [Number(one)]; repaint(); } },
        ]);
      }
      const repeatRow = () => menuRow('Repeat', repeatWords(d.repeatDays, d.repeatUntil) || 'Never', null, repeatMenu);
      const dateRows = () => [pickRow('date', 'Date', dayShortWords(d.start)), picker('date')];
      const timeRows = () => [pickRow('time', 'Time', hm(d.start)), picker('time')];
      function rows() {
        const out = [];
        if (isNew) {
          out.push(UI().tabs({
            label: 'Kind', selected: d.kind,
            items: [{ id: 'meeting', label: 'Meeting' }, { id: 'reminder', label: 'Reminder' }, { id: 'alarm', label: 'Alarm' }],
            onSelect: (k) => { d.kind = k; open = null; if (k !== 'meeting') d.end = d.start; else if (d.end <= d.start) d.end = new Date(d.start.getTime() + 3600000); repaint(); },
          }));
        }
        if (d.kind === 'meeting') {
          out.push(S().settingsBlock([
            S().settingRow({ title: 'With', go: { value: d.person ? d.person.name : 'No person', onClick: () => openPeople() } }),
            fieldRow('About', d.title, d.person ? d.person.name : 'Topic', (v) => { d.title = v; }),
          ]));
          out.push(S().settingsBlock([
            ...dateRows(),
            pickRow('start', 'Starts', hm(d.start), endNote()), picker('start'),
            repeatRow(),
          ]));
          const where = [menuRow('Where', FORM_PLACE_NAMES[d.place] || 'Not agreed', placeNote(d), (anchor) => {
            UI().menu(anchor, FORM_PLACES.map((p) => ({
              label: FORM_PLACE_NAMES[p], checked: d.place === p,
              note: p === 'unknown' ? 'Ask the person later' : p === 'link' ? 'Paste the link of the call' : (settings && settings.places && settings.places[p] ? shortLink(settings.places[p]) : 'No permanent link in the base'),
              svg: p === 'unknown' ? mark('calendar', 18) : placeMark(p, 18),
              onSelect: () => { d.place = p; repaint(); },
            })));
          })];
          if (d.place === 'link') where.push(fieldRow('Link', d.link, 'https://…', (v) => { d.link = v; }, { url: true }));
          out.push(S().settingsBlock(where));
          const notify = S().settingRow({ title: 'Messages to the person', note: notifyNote(d),
            toggle: { on: notifyOn(d), onChange: (on) => { d.notifyPerson = on; repaint(); } } });
          if (!d.person || d.person.personal || !d.person.hasChat) notify.input.disabled = true;
          out.push(S().settingsBlock([
            menuRow('Remind', remindLabel(d.remindMinutes), d.remindMinutes == null ? remindLadderNote() : null, (anchor) => {
              // Auto only for a new meeting: a saved one cannot go back to the base's count. The value it holds stays in the list.
              const list = isNew ? [null] : [];
              if (d.remindMinutes != null && d.remindMinutes !== 30 && d.remindMinutes !== 60) list.push(d.remindMinutes);
              UI().menu(anchor, list.concat([30, 60]).map((m) => ({
                label: remindLabel(m), checked: d.remindMinutes === m, onSelect: () => { d.remindMinutes = m; repaint(); },
              })));
            }),
            notify,
            S().settingRow({ title: 'Break through silent mode', note: loudNote(d), toggle: { on: d.loud, onChange: (on) => { d.loud = on; repaint(); } } }),
          ]));
        } else if (d.kind === 'reminder') {
          out.push(S().settingsBlock([fieldRow('Text', d.title, 'Reminder', (v) => { d.title = v; }, { multi: true })]));
          out.push(S().settingsBlock([...dateRows(), ...timeRows(), repeatRow()]));
          out.push(S().settingsBlock([
            S().settingRow({ title: 'Break through silent mode', note: loudNote(d), toggle: { on: d.loud, onChange: (on) => { d.loud = on; repaint(); } } }),
          ]));
        } else {
          out.push(S().settingsBlock([fieldRow('Label', d.title, 'Optional', (v) => { d.title = v; })]));
          out.push(S().settingsBlock([...dateRows(), ...timeRows(), repeatRow()]));
          out.push(make('div', 'wc-cal-sheet-note', 'Rings like an alarm — even in silent mode or Focus. Turn it off for all alarms: Settings → Notifications → Alarms.'));
        }
        out.push(error);
        return out;
      }
      async function save() {
        if (saving) return;
        const problem = problemOf(d);
        if (problem) { error.textContent = problem; error.hidden = false; return; }
        error.hidden = true;
        let body2;
        if (d.item && d.before) {
          const ch = changesOf(d);
          if (!Object.keys(ch).length) { leaving = true; closeSheet(); return; }
          body2 = Object.assign({ op: 'update', item: d.item, lex: { command: d.command } }, ch);
        } else {
          body2 = Object.assign({ op: 'create', lex: { command: d.command } }, fieldsOf(d));
        }
        saving = true;
        go.disabled = true;
        try {
          await deps.call('', null, body2);
        } catch (err) {
          // The same press again is the same command: a second meeting does not come of it.
          error.textContent = refusalWords(err);
          error.hidden = false;
          return;
        } finally {
          saving = false;
          go.disabled = false;
        }
        leaving = true;
        closeSheet();
        await read(true).catch(() => {});
      }
      // People of the base: «With» opens the list in the same sheet; a pick comes back to the form.
      function openPeople() {
        leaving = true;
        closeSheet();
        const search = make('input', 'wc-cal-input wc-cal-search');
        search.type = 'search';
        search.placeholder = 'Search';
        search.setAttribute('aria-label', 'Search');
        const list = make('div', 'lex-section-list wc-cal-people');
        const back = (p) => { if (p !== undefined) { d.person = p; d.notifyPerson = null; } leaving = true; closeSheet(); openForm(d, isNew, start); };
        let asked = 0;
        async function find() {
          const mine = ++asked;
          let people = [];
          try {
            const r = await deps.call('/people', { q: search.value.trim(), limit: '12' });
            people = Array.isArray(r && r.people) ? r.people.map(personOf).filter(Boolean) : [];
          } catch (_) { people = []; }
          if (mine !== asked) return;
          const rowsOut = [S().row({ id: 'none', title: 'No person', onClick: () => back(null) })];
          for (const p of people) {
            const marks = [p.personal ? 'personal' : null, !p.hasChat ? 'no chat' : null].filter(Boolean).join(' · ');
            rowsOut.push(S().row({ id: p.id, title: p.name, sub: [p.line, marks].filter(Boolean).join(' · ') || null, onClick: () => back(p) }));
          }
          list.replaceChildren(...rowsOut);
        }
        let timer = null;
        search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(find, 250); });
        const s = UI().sheet(SHEET, 'With', [search, list], () => { if (sheet === s) { sheet = null; if (!leaving) back(); } leaving = false; });
        s.body.classList.add('wc-cal-sheet');
        sheet = s;
        leaving = false;
        find();
        search.focus();
      }
      const go = M().button({ label: 'Save', main: true });
      go.classList.add('wc-cal-save');
      go.addEventListener('click', save);
      repaint();
      const foot = make('div', 'wc-cal-sheet-foot is-save');
      foot.appendChild(go);
      const title = isNew ? 'New' : (KIND_TITLES[d.kind] || 'Meeting');
      const s = UI().sheet(SHEET, title, [body, foot], async () => {
        if (sheet === s) sheet = null;
        if (leaving) { leaving = false; return; }
        // Closed with changes: asked first; Stay brings the form back as it was.
        if (snapshot(d) !== start) {
          const yes = await UI().confirm('Discard the changes?', '', { okText: 'Discard', cancelText: 'Stay', danger: true });
          if (!yes) openForm(d, isNew, start);
        }
      });
      s.body.classList.add('wc-cal-sheet', 'is-form');
      sheet = s;
    }

    // ── the size of the window ────────────────────────────────────────────────────────────────────────────────
    let lastW = 0;
    let lastH = 0;
    const ro = new ResizeObserver(() => {
      const w = frame.el.clientWidth;
      const h = frame.el.clientHeight;
      if (!w || !h || (w === lastW && h === lastH)) return;
      lastW = w;
      lastH = h;
      const nowWide = w >= WIDE;
      if (nowWide !== wide) {
        wide = nowWide;
        // The Mac has no «3 days»: its week is wide enough.
        if (wide && view === 'three') view = 'week';
      }
      paint();
    });
    ro.observe(frame.el);
    // «Now» moves by itself while the section is on the screen.
    let clock = null;
    const tick = () => { if (frame.isShown() && view !== 'month' && view !== 'year') paint(); };

    return {
      el: frame.el,
      stopOpening: frame.stopOpening,
      async show(opts) {
        if (!(opts && opts.back)) { frame.reset(); }
        frame.enter();
        if (!clock) clock = setInterval(tick, 60000);
        paint();
        const lex = pendingReveal;
        pendingReveal = null;
        if (lex) await revealNow(lex);
        else {
          try { await read(true); } catch (e) { console.warn('[calendar] show:', e && e.message); }
        }
        if (frame.isShown()) frame.watch();
      },
      async warm() { if (!frame.isShown()) await read(false); },
      hide() {
        frame.unwatch();
        closeSheet();
        if (clock) { clearInterval(clock); clock = null; }
        if (deps.head && headSaid) { headSaid = null; deps.head(null); }
      },
      // A notification of the calendar: its day, the record open on it. Said before the section is on the screen (the page
      // enters the section with it), it waits for show().
      reveal(lex) {
        if (!frame.isShown()) { pendingReveal = lex || {}; return Promise.resolve(); }
        return revealNow(lex || {});
      },
    };

    // A notification of the calendar (push-decide.ts: lex.item, lex.occurrence, lex.start, lex.manual, lex.text): its
    // day, and the record open on it. A record far from the window, or one the base has just cancelled, is read whole.
    async function revealNow(lex) {
      const item = lex && lex.item != null ? String(lex.item) : '';
      const at = lex && Number.isFinite(Number(lex.start)) && lex.start != null ? new Date(Number(lex.start)) : null;
      if (at) selected = dayStart(at);
      view = 'day';
      scrollAt = null;
      if (item && lex.manual === true && typeof lex.text === 'string' && lex.text.trim()) manual.set(item, lex.text.trim());
      await read(true).catch((e) => console.warn('[calendar] reveal:', e && e.message));
      if (!item) return;
      const occ = lex.occurrence != null ? String(lex.occurrence) : null;
      const all = (data && data.events) || [];
      const onDay = eventsOn(selected).filter((e) => e.item === item);
      const e = onDay.find((x) => !occ || x.occurrence === occ) || onDay[0] || all.find((x) => x.item === item);
      if (e) {
        if (!sameDay(e.start, selected)) { selected = dayStart(e.start); paint(); }
        openEvent(e);
        return;
      }
      try {
        const j = await deps.call('/item', { id: item });
        const it = j && j.item;
        if (!it) return;
        const first = Object.assign({}, it);
        const o = Array.isArray(it.occurrences) ? it.occurrences[0] : null;
        if (o) { first.start = o.start; first.end = o.end; first.messages = o.messages; }
        first.id = `own:${item}:once`;
        first.source = first.source || 'own';
        const ev = eventOf(first);
        if (!ev) return;
        selected = dayStart(ev.start);
        paint();
        read(false).catch(() => {});
        openEvent(ev, { cancelled: it.cancelled === true });
      } catch (err) {
        console.warn('[calendar] item:', err && err.message);
      }
    }
  }

  global.WcCalendar = {
    createSection, eventCard, allDayLine, hoursGrid, dayButton, monthGrid, eventOf, headline, dayWords, dayTitle, spanWords,
    repeatWords, stepWords, sentWord, placesOf,
  };
})(typeof window !== 'undefined' ? window : globalThis);
