// lex-draft-box.js — the window with a message to a person: ONE drawing and ONE door for every chat of Lex that has
// one (docs/spec/21-chat-canvas.md, «Окошко с текстом для человека»; plan PLAN-CHAT-UNIFY, stage 3, part «б»). One file
// for the page lex-me.club/app (the Mac app shows that page) and for the extension: the side panel and the standalone
// chat draw the windows of the base with it. The iPhone has the same window in Swift (ios/Lex/Lex/Parts/DraftWindow.swift,
// LexDraftWindow) on the same server calls.
//
// Where a window stands: under an answer of the model that prepared a message to a person —
//   - in an order chat of Profi.ru and a chat of the folders: a box of the chat (`windows` of profi_open and
//     folder_open), and the person's own text on its way (`outbox`) — lex-profi.js draws them through `windows` below;
//   - in the ordinary chat: a mark of the kind `box:<n>` of the base (supabase/functions/_shared/brain-boxes.ts) — the
//     text word for word, whom and where it goes, when, and the state of the task — drawn by `create` below (В7.51,
//     2026-11-20; Gennady: «отправка сообщения только в двух сценариях: либо когда я заранее предупредил, либо при
//     долгом нажатии»).
// The look is one (В7.20, В7.23): the draft bubble with Copy, 6 under it the row «Hold to send to <name>» + «⋯» (Edit),
// the line under the row. A tap sends nothing: only the hold of the button (480 ms, LexLongPress through
// LexMessage.sendHold) asks the server to send. Several windows may stand under one answer: they go by `data.seq`, 12
// apart. Where a press goes is the door (`door` below), chosen by the profile of the chat.
//
// The states of a window of the base:
//   state of the mark      what is drawn
//   черновик               the bubble; over the row small lines (when it goes, a new person, files); the row: hold
//                          button + «⋯» (Edit); the line: the note of the last failure, red
//   отправляется, идёт     the bubble; no row; «Sending to <Messenger>…»
//   ждёт                   the bubble; «Cancel» (a tap — nothing goes to a person by it); «Scheduled for <when>
//                          (Moscow).» if it has a time, else «Sending to <Messenger>…»
//   ушло, отправлено       the bubble stays; no Edit, no hold; «Sent to <name> in <Messenger>.»
//   отменено               the bubble paler; «Cancelled — it will not be sent.»
//   не отправлено          the bubble; «Hold to send again» + «⋯» (Edit); «Not sent to <Messenger>. <note>»
//   any other              as «черновик» without the row, and «State: <state>» in the line
// The states of a box of a chat (ready, scheduled, queued, sent, failed, unknown) are lex-profi.js's (boxView).
//
// LexDraftBox gives:
//   windows(deps) → { draw(view, acts), reset() } — the drawing of any window (below, «one window»)
//   create(deps) → controller { node(mark), reset() }
//       The windows of the base of one chat view, by `uid|kind` of the mark. node(mark) → the element of one window;
//       brainMarksNode (lex-answer-row.js, `boxes`) puts the nodes of an answer in its container.
//       deps = {
//         send(mark)         the hold of the button           → Promise of the answer of brain-action, or throws
//         text(mark, text)   Save in Edit                     → the same
//         cancel(mark)       «Cancel» of a task that waits    → the same
//         apply(marks)       the whole list of marks the server gave: the caller replaces what the chat holds and
//                            draws it again (here, once — nobody else applies the answer of these three calls)
//         copy(text)         Copy of the bubble → Promise<bool> (default: LexAnswerRow.copyText)
//         layer              a class the menu of «⋯» gets in the <body> (the windows of the extension: ytvocab-sl-portal)
//       }
//       The answer of brain-action: { ok, state, text, busy, marks }. A call resolves with it, whatever `ok` says, or
//       throws Error(reason) when the server was not reached (an HTTP error, no network): the adapters of the four
//       places give that one shape.
//   door(o) → the one way a window sends (below, «the door»); again(call) — a call tried again while it gets no answer
//   isBox(mark), boxesOf(list) → the windows of an answer, by data.seq
//   aliveIn(marks) → is a window on its way (отправляется, ждёт, идёт) or an old mark «send» (ждёт, идёт);
//       marks — an array, or a Map of uid → array
//   sameMarks(a, b) → the two lists say the same: a reading that brought nothing new must not draw the answer again
//       (a button under a held finger would be replaced)
//   look({ open, alive, ask }) → { now(read), stop() } — the readings of a chat with windows, one at a time, and the
//       repeat of a reading that failed (below, «the look at the queue»). No timer asks anything while a window is on
//       its way: every change of its task comes by the signal «marks» (Gennady, 21.11.2026).
//
// The hooks of the check pages and the live checks: the root of a window has data-kind (box:<n>) or data-window (the
// box of a chat) and data-state; the buttons have data-role: hold (the button that sends), more («⋯»), cancel (the task
// that waits), delete, edit-save, edit-cancel; the line under the row is .lex-draft-box-note (role=status).
(function (global) {
  'use strict';

  // The states of a window as the database says them (brain-boxes.ts): the words are the data's, not the screen's.
  const DRAFT = 'черновик';
  const SENDING = 'отправляется';
  const WAITS = 'ждёт';
  const RUNNING = 'идёт';
  const SENT = ['ушло', 'отправлено'];
  const CANCELLED = 'отменено';
  const NOT_SENT = 'не отправлено';
  const KNOWN = new Set([DRAFT, SENDING, WAITS, RUNNING, CANCELLED, NOT_SENT, ...SENT]);
  const BOX_KIND = /^box:\d+$/;
  const ALIVE_BOX = new Set([SENDING, WAITS, RUNNING]);
  const ALIVE_OLD = new Set([WAITS, RUNNING]);

  function make(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // ── the marks ───────────────────────────────────────────────────────────────
  const isBox = (m) => !!m && BOX_KIND.test(String(m.kind || ''));
  const seqOf = (m) => {
    const n = Number(m && m.data && m.data.seq);
    return Number.isFinite(n) ? n : 0;
  };
  const numOf = (m) => Number(String(m.kind).slice(4)) || 0;
  // The server sorts by kind as text (box:10 before box:9): the order of the windows is data.seq.
  function boxesOf(list) {
    return (Array.isArray(list) ? list : []).filter(isBox).sort((a, b) => (seqOf(a) - seqOf(b)) || (numOf(a) - numOf(b)));
  }
  function flat(marks) {
    if (!marks) return [];
    if (marks instanceof Map) return [...marks.values()].flat();
    return Array.isArray(marks) ? marks : [];
  }
  function aliveMark(m) {
    if (!m) return false;
    const s = String(m.state || '');
    if (isBox(m)) return ALIVE_BOX.has(s);
    return m.kind === 'send' && ALIVE_OLD.has(s);
  }
  const aliveIn = (marks) => flat(marks).some(aliveMark);
  function sameMarks(a, b) {
    const x = flat(a);
    const y = flat(b);
    if (x.length !== y.length) return false;
    const sig = (list) => list.map((m) => JSON.stringify([m.uid, m.kind, m.state || null, m.note || '', m.data || null])).sort();
    const p = sig(x);
    const q = sig(y);
    return p.every((s, i) => s === q[i]);
  }

  // ── the words ───────────────────────────────────────────────────────────────
  const firstWord = (name) => String(name || '').trim().split(/\s+/)[0] || '';
  function messengerOf(ch) {
    const c = global.LexMessage && global.LexMessage.CHANNELS && global.LexMessage.CHANNELS[ch];
    return c ? c.name : '';
  }
  const sendingWords = (messenger) => (messenger ? `Sending to ${messenger}…` : 'Sending…');

  // The line under the row, from the mark alone: { text, error } or null.
  function lineOf(m) {
    const d = m.data || {};
    const s = String(m.state || DRAFT);
    const note = String(m.note || '').trim();
    const messenger = messengerOf(d.channel);
    if (s === DRAFT) return note ? { text: note, error: true } : null;
    if (s === SENDING || s === RUNNING) return { text: sendingWords(messenger) };
    if (s === WAITS) return { text: d.when && !d.now ? `Scheduled for ${d.when} (Moscow).` : sendingWords(messenger) };
    if (SENT.includes(s)) {
      const who = String(d.name || '').trim();
      return { text: `Sent${who ? ` to ${who}` : ''}${messenger ? ` in ${messenger}` : ''}.` };
    }
    if (s === CANCELLED) return { text: 'Cancelled — it will not be sent.' };
    if (s === NOT_SENT) return { text: `Not sent${messenger ? ` to ${messenger}` : ''}. ${note}`.trim() };
    return { text: `State: ${s}` };
  }

  // Over the row of a draft: when it goes, a person the database does not know yet, the files that go with it.
  function infoOf(m) {
    const d = m.data || {};
    const out = [];
    if (d.when && !d.now) out.push(`Goes at ${d.when}, Moscow time.`);
    const who = String(d.name || '').trim();
    if (d.fresh && who) out.push(`New person: “${who}” will be added when it goes.`);
    const files = (Array.isArray(d.files) ? d.files : []).map((f) => String((f && f.name) || '')).filter(Boolean);
    if (files.length) out.push(`Files: ${files.join(', ')}`);
    return out;
  }

  // ── one window, whatever it holds ───────────────────────────────────────────
  // windows(deps) → { draw(view, acts), reset() } — the one drawing of a window with a message to a person, for every
  // chat that has one: a box of an order chat of Profi.ru and of a chat of the folders (lex-profi.js boxNode, the
  // person's own text on its way — outboxNode), a window of the base under an answer of the ordinary chat (create
  // below). One controller per chat view: it keeps what must survive a drawing of the chat again — the words typed in
  // Edit, the line of the last refusal, a press on its way — by view.key.
  //   deps = {
  //     apply(marks)   the marks an answer brought (a window of the base): the caller replaces what the chat holds
  //     refresh()      an answer without marks (a box of a chat): the caller reads the chat again → Promise
  //     putBack(text)  the person's own text came back from its way (Cancel of one that waited): into the field
  //     copy(text)     Copy of the bubble → Promise<bool> (default: LexAnswerRow.copyText)
  //     layer          a class the menu of «⋯» gets in the <body> (the windows of the extension: ytvocab-sl-portal)
  //   }
  //   view = {
  //     key       what survives a drawing again; root — the classes of the root (default lex-draft-box); data — its
  //               dataset (kind, state, window: the hooks of the checks); label — what a screen reader names it
  //     words, quote() → node | null, files — the bubble: the words (the names of the files when no words go), the
  //               message it answers; body — a node of the caller's own in place of the draft bubble (the person's
  //               own text on its way), none — no bubble at all (a box that went: only its line)
  //     writing   no window yet (the answer is being written): paler, no Copy, no row
  //     faded     the bubble paler (cancelled)
  //     info      small lines over the row (when it goes, a new person, the files); price — «Price: …» under the bubble
  //     hold      the row that sends: { channel, words, label, fit, busy (the words while the press is on its way),
  //               items(press) → the items of «⋯» beyond Edit } | null — no row
  //     editable  «Edit» in «⋯» (and the words of the bubble become a field, Save, Cancel); editLabel — its name
  //     taps      buttons a tap presses, nothing goes to a person by them: [{ label, role, act, busy, before }] —
  //               act names a call of acts; before — left of the hold
  //     line      { text, error } the line of the state; noteFirst — the line over the row (the person's own text)
  //   }
  //   acts = { send(), text(words), cancel(), …, any call a tap or an item names } → Promise of the answer of the door;
  //          an answer may carry `after` — the words that stand under the row, off, until the chat draws the new state;
  //          `words` — the words of the window as the server keeps them now; `note` — a line of the answer
  //     (below): { ok, text, busy, marks, putBack }; throws Error(why) when the server was not reached.
  function windows(deps) {
    const d0 = deps || {};
    // What the person typed or was told, by window:
    //   edit — { text, field, fresh } while Edit is open
    //   line — { text, error, sig } what the last press left (a refusal, a failure); it belongs to the state the window
    //          is first drawn in after the answer of the press (an answer may bring the window's new state with it: «Not
    //          saved. It has already gone.» stands under the window that went) — another state later is another story
    //   busy — the words said while a press is on its way, or null
    //   after — { text, sig } a press the server took whose new state the chat has not drawn yet (the answer's `after`:
    //          «Sending to Telegram…»): the row stays off with these words until a drawing brings another state
    const ui = new Map();
    const drawn = new Map();
    const uiOf = (k) => {
      if (!ui.has(k)) ui.set(k, { edit: null, line: null, busy: null, after: null });
      return ui.get(k);
    };
    const sigOf = (view) => JSON.stringify([(view.data && view.data.state) || '', view.line ? view.line.text : '']);

    // The window drawn again where it stands, from the view it was drawn with last.
    function repaint(k) {
      const d = drawn.get(k);
      if (!d || !d.node.isConnected) return;
      d.node.replaceWith(build(d.view, d.acts));
    }

    // One press on a window: the call, what to say about it, what the answer brought applied once.
    async function act(view, saving, call) {
      const k = view.key;
      const u = uiOf(k);
      let r = null;
      let why = '';
      try { r = await call(); } catch (e) { why = (e && e.message) ? String(e.message) : 'No connection.'; }
      const before = drawn.get(k);
      // The line takes the state of the first drawing after the answer (`build`): sig null until then.
      const keyed = { sig: null };
      u.after = null;
      if (!r || typeof r !== 'object') {
        u.line = Object.assign({ text: `${saving ? 'Not saved' : 'Not done'}. ${why}`.trim(), error: true }, keyed);
      } else if (r.ok === false && !r.busy) {
        const reason = String(r.text || '').trim();
        u.line = Object.assign({ text: saving ? `Not saved. ${reason}`.trim() : (reason || 'Not done.'), error: true }, keyed);
      } else {
        // Done, or another press is being handled (busy): what the answer says is the window.
        // The answer may say the words the server keeps now (Save: its text; it has already gone: the text as it went)
        // and a line of its own («Not saved: the text has already gone.»): the window shows them until the chat
        // draws it anew.
        u.line = r.note ? Object.assign({ text: String(r.note), error: false }, keyed) : null;
        if (typeof r.words === 'string') {
          const d = drawn.get(k);
          if (d) d.view = Object.assign({}, d.view, { words: r.words });
        }
        if (r.after && !r.busy) u.after = { text: String(r.after), sig: sigOf((before && before.view) || view) };
        if (saving && r.ok !== false) u.edit = null;
        if (r.putBack && typeof d0.putBack === 'function') { try { d0.putBack(String(r.putBack)); } catch (_) { /* the field is not there */ } }
      }
      // The field of Edit is still open (the call failed, the server refused): the caret goes back into it, where the
      // words are to be mended — the button that was pressed is drawn anew and the focus would be lost.
      if (u.edit) u.edit.fresh = true;
      const marks = r && Array.isArray(r.marks) ? r.marks : null;
      if (marks && typeof d0.apply === 'function') {
        // The answer brings the window as it is now: drawn from it, with no «Sending…».
        u.busy = null;
        try { d0.apply(marks); } catch (_) { /* the caller could not draw: the window is drawn again below */ }
      } else if (r && typeof d0.refresh === 'function') {
        // A box of a chat: the chat is read again while the words of the press still stand under the row.
        try { await d0.refresh(); } catch (_) { /* the next reading of the chat brings it */ }
      }
      u.busy = null;
      // The caller draws the chat again when the answer changed it; when it did not (a refusal, the same list) the
      // window is still the old node — and a node drawn while the press was on its way still says so: drawn again
      // here with what the press left in `ui`.
      const now = drawn.get(k);
      if (!before || now === before || (now && now.busy)) repaint(k);
      // Nothing more is asked after a press: what a task of the base does next comes by the signal «marks», what a box
      // of a chat does — by the signal of its section (profi, folders).
    }

    function build(view, acts) {
      const M = global.LexMessage;
      const k = view.key;
      const u = uiOf(k);
      const a = acts || {};
      const words = typeof view.words === 'string' ? view.words : '';
      const files = Array.isArray(view.files) ? view.files : [];
      const editable = !!view.editable && typeof a.text === 'function';
      // A window that cannot change any more has no Edit open; a line made under another state is not this window's.
      if (!editable) u.edit = null;
      if (u.line && u.line.sig === null) u.line.sig = sigOf(view);
      else if (u.line && u.line.sig !== sigOf(view)) u.line = null;
      if (u.after && u.after.sig !== sigOf(view)) u.after = null;

      const root = make('div', view.root || 'lex-draft-box');
      if (view.faded) root.classList.add('is-cancelled');
      if (view.writing) root.classList.add('is-writing');
      for (const [name, value] of Object.entries(view.data || {})) if (value != null) root.dataset[name] = String(value);
      if (view.label) {
        root.setAttribute('role', 'group');
        root.setAttribute('aria-label', view.label);
      }
      drawn.set(k, { view, acts, node: root, busy: !!u.busy });
      // The window stands inside the turn of the answer, and the turn has a menu of its own (Copy, Select: a right
      // button, the menu key or a held finger on the whole turn — lex-message.js attachMenu). The words of the
      // window are not the answer's: a finger held on it sends (the hold of the common part) and opens no second
      // menu, a right button or the menu key asks for the «⋯» of the window or the browser's own, not the answer's.
      // What the window does not fill (its empty side) stays the turn's.
      const own = (e) => e.target !== root;
      root.addEventListener('pointerdown', (e) => {
        if (own(e) && (e.pointerType === 'touch' || e.pointerType === 'pen')) e.stopPropagation();
      });
      root.addEventListener('contextmenu', (e) => { if (own(e)) e.stopPropagation(); });
      root.addEventListener('keydown', (e) => {
        if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) e.stopPropagation();
      });

      const putNote = (note, line) => {
        note.textContent = line ? line.text : '';
        note.classList.toggle('is-error', !!(line && line.error));
      };
      const newNote = () => {
        const note = make('div', 'lex-draft-box-note');
        note.setAttribute('role', 'status');
        return note;
      };
      const copyFn = typeof d0.copy === 'function' ? d0.copy
        : (global.LexAnswerRow && global.LexAnswerRow.copyText ? global.LexAnswerRow.copyText : null);
      const quoteNode = () => (typeof view.quote === 'function' ? view.quote() : null);
      const priceNode = () => (view.price ? make('div', 'lex-draft-box-info', `Price: ${view.price}`) : null);
      // A press: the words it says while it is on its way, every button of the window off, the call.
      const press = (busy, saving, call) => {
        if (u.busy) return;
        u.busy = busy;
        u.line = null;
        for (const b of root.querySelectorAll('button')) b.disabled = true;
        const note = root.querySelector('.lex-draft-box-note');
        if (note) putNote(note, { text: busy });
        act(view, saving, call);
      };

      function paintView() {
        const note = newNote();
        // A press on its way, or one the server took whose new state is not drawn yet: the row is off, its words stand.
        const held = u.busy || (u.after ? u.after.text : null);
        const kids = [];
        if (view.body) {
          kids.push(view.body);
        } else if (!view.none) {
          const copy = copyFn && words && !view.writing ? async () => {
            const ok = await copyFn(words);
            if (!ok) putNote(note, { text: 'The browser refused the clipboard.', error: true });
            return ok;
          } : undefined;
          // With no words (only files go) the bubble names the files, so that it is not an empty one.
          kids.push(M.bubble({ side: 'out', tone: 'draft', text: words || files.join('\n'), copy, quote: quoteNode() }));
        }
        const price = priceNode();
        if (price) kids.push(price);
        for (const text of view.info || []) kids.push(make('div', 'lex-draft-box-info', text));

        const foot = make('div', 'lex-draft-box-foot');
        const tap = (t) => {
          const b = M.button({ label: t.label });
          if (t.role) b.dataset.role = t.role;
          b.disabled = !!held;
          b.addEventListener('click', () => press(t.busy || 'Working…', false, () => a[t.act]()));
          return b;
        };
        const taps = Array.isArray(view.taps) ? view.taps.filter((t) => typeof a[t.act] === 'function') : [];
        for (const t of taps) if (t.before) foot.append(tap(t));
        if (view.hold && typeof a.send === 'function') {
          const h = view.hold;
          const startEdit = () => {
            u.edit = { text: words, field: null, fresh: true };
            u.line = null;
            // An item of a menu opened before the window was drawn again: the window as it stands now opens Edit.
            if (!root.isConnected) { repaint(k); return; }
            paintEdit();
          };
          const items = () => {
            const list = typeof h.items === 'function' ? (h.items((busy, call) => press(busy, false, call)) || []) : [];
            return editable ? list.concat([{ label: 'Edit', icon: 'pencil', run: startEdit }]) : list;
          };
          const hasItems = editable || typeof h.items === 'function';
          const { send, more } = M.sendHold({
            channel: h.channel,
            words: h.words,
            label: h.label,
            fit: !!h.fit,
            items: hasItems ? items : null,
            onSend: () => press(h.busy || 'Sending…', false, () => a.send()),
          });
          send.dataset.role = 'hold';
          if (more) more.dataset.role = 'more';
          if (held) { send.disabled = true; if (more) more.disabled = true; }
          // The menu of «⋯» opens in the <body> of the page: a window of the extension asks for its layer there,
          // right after the common part opened it (the part's own listener runs first).
          if (d0.layer) {
            const layered = () => {
              for (const el of document.querySelectorAll('body > .lex-sl-menu, body > .lex-sl-catcher')) el.classList.add(d0.layer);
            };
            if (more) more.addEventListener('click', layered);
            send.addEventListener('contextmenu', layered);
          }
          foot.append(send);
          for (const t of taps) if (!t.before && !t.last) foot.append(tap(t));
          if (more) foot.append(more);
        } else {
          for (const t of taps) if (!t.before && !t.last) foot.append(tap(t));
        }
        for (const t of taps) if (!t.before && t.last) foot.append(tap(t));
        // The line: what a press says now, else what it left, else what the state says.
        putNote(note, held ? { text: held } : (u.line || view.line || null));
        if (view.noteFirst) kids.push(note);
        if (foot.childElementCount) kids.push(foot);
        if (!view.noteFirst) kids.push(note);
        root.classList.remove('is-editing');
        root.replaceChildren(...kids);
      }

      // Edit → Save (В7.20): the words of the bubble become a field in the same bubble; under it «Cancel» and «Save»
      // stand in place of the row that sends. A tap on them sends nothing to anyone. Save asks the server (acts.text);
      // Escape and Cancel throw away what was typed; Ctrl or Cmd with Enter saves. What was typed lives in `ui`, so a
      // drawing of the chat again does not lose it.
      function paintEdit() {
        const entry = u.edit;
        const old = entry.field;
        const keep = !!entry.fresh || !!(old && old.isConnected && global.document.activeElement === old);
        const caret = old && old.isConnected ? [old.selectionStart, old.selectionEnd] : null;
        const note = newNote();
        putNote(note, u.busy ? { text: u.busy } : u.line);
        const changed = () => {
          const typed = entry.text.trim();
          return typed !== '' && typed !== words.trim();
        };
        const leave = () => {
          if (u.busy) return;
          u.edit = null;
          u.line = null;
          paintView();
        };
        const save = () => {
          if (u.busy || !changed()) return;
          press('Saving…', true, () => a.text(entry.text));
        };
        const ed = M.editField({
          value: entry.text,
          label: view.editLabel || 'Message to the person',
          onInput: (v) => {
            entry.text = v;
            saveBtn.disabled = !!u.busy || !changed();
            if (note.textContent) putNote(note, null);
            u.line = null;
          },
          onKey: (e) => {
            if (e.key === 'Escape') { e.preventDefault(); leave(); }
            else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
          },
        });
        entry.field = ed.field;
        const bubble = M.bubble({ side: 'out', tone: 'draft', body: ed.body, quote: quoteNode() });
        bubble.classList.add('is-editing');
        const cancelBtn = M.button({ label: 'Cancel' });
        cancelBtn.dataset.role = 'edit-cancel';
        cancelBtn.disabled = !!u.busy;
        cancelBtn.addEventListener('click', leave);
        const saveBtn = M.button({ label: 'Save', main: true });
        saveBtn.dataset.role = 'edit-save';
        saveBtn.disabled = !!u.busy || !changed();
        saveBtn.addEventListener('click', save);
        const foot = make('div', 'lex-draft-box-foot');
        foot.append(cancelBtn, saveBtn);
        const kids = [bubble];
        const price = priceNode();
        if (price) kids.push(price);
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

      if (u.edit && editable) paintEdit(); else paintView();
      return root;
    }

    return {
      draw: build,
      reset() { ui.clear(); drawn.clear(); },
    };
  }

  // ── a window of the base under an answer ────────────────────────────────────
  // The view of a mark `box:<n>` (the states of the table at the top of this file).
  function viewOfMark(m) {
    const d = m.data || {};
    const s = String(m.state || DRAFT);
    const known = KNOWN.has(s);
    const editable = s === DRAFT || s === NOT_SENT;
    const messenger = messengerOf(d.channel);
    const name = String(d.name || '').trim();
    const first = firstWord(name);
    const again = s === NOT_SENT;
    return {
      key: `${m.uid}|${m.kind}`,
      data: { kind: m.kind, state: s },
      label: `Message to ${name || 'the person'}${messenger ? ` in ${messenger}` : ''}`,
      words: typeof d.text === 'string' ? d.text : '',
      files: (Array.isArray(d.files) ? d.files : []).map((f) => String((f && f.name) || '')).filter(Boolean),
      faded: s === CANCELLED,
      info: s === DRAFT || !known ? infoOf(m) : [],
      editable,
      editLabel: `Message to ${name || 'the person'}`,
      hold: editable ? {
        channel: d.channel,
        words: again ? 'Hold to send again' : first ? `Hold to send to ${first}` : 'Hold to send',
        label: `Send${again ? ' again' : ''} to ${name || 'the person'}${messenger ? ` on ${messenger}` : ''}. Hold to send`,
        busy: sendingWords(messenger),
      } : null,
      taps: s === WAITS ? [{ label: 'Cancel', role: 'cancel', act: 'cancel', busy: 'Cancelling…' }] : [],
      line: lineOf(m),
    };
  }

  // create(deps) → { node(mark), reset() } — the windows of the base of one chat view (the contract at the top). The
  // calls go to deps.send, deps.text, deps.cancel (or a door of the base: door({ brain }) below).
  function create(deps) {
    const o = deps || {};
    const ctl = windows({ apply: o.apply, copy: o.copy, layer: o.layer });
    return {
      node(m) {
        return ctl.draw(viewOfMark(m), {
          send: () => o.send(m),
          text: (words) => o.text(m, words),
          cancel: () => o.cancel(m),
        });
      },
      reset: ctl.reset,
    };
  }

  // ── the door ────────────────────────────────────────────────────────────────
  // door(o) → the one way a window (and the field's held arrow) sends to a person; where it goes is the profile of the
  // chat (LexChatProfile.doorOf): 'profi' — the database functions of an order chat (profi_send, profi_send_at,
  // profi_send_cancel, profi_box_text, profi_send_text), 'folder' — the edge function folder-send with the number of
  // the press of the box (win:<id>, a new try win:<id>:<n>; o.folderSend tries a lost answer again itself), 'brain' —
  // brain-action with the kind of the mark.
  //   o = { profile, kind (the door itself, when the table of profiles is not loaded: a page of a check), rpc(name, args), folderSend(body), brain(body), chatKey(), order(), closed() → the words why this
  //         chat takes no messages now | '' }
  //   → { kind, schedules (a time can be picked: the order chats), send(w), at(w, date), cancel(w), text(w, words),
  //       direct(text, { quote, at }) }
  // Every call answers as brain-action does — { ok, text, state, channel, busy, marks, putBack, test } — or throws
  // Error(why) when the server was not reached. A call that got no answer at all (the connection dropped, a gateway
  // in front of the server) is tried again by itself with the SAME number of the press, after 1, 3 and 6 s: the server
  // keeps one send per number, so a press that did reach it is not sent twice; the number of a press lives until the
  // server answered it. A refusal of the server is final.
  const AGAIN_WAITS = [1000, 3000, 6000];
  const noAnswer = (err) => !!err && (err.network === true
    || /Failed to fetch|Load failed|NetworkError|network connection was lost/i.test(String(err.message || ''))
    || /^HTTP 50[234]\b/.test(String(err.message || '')));
  const NO_CONNECTION = 'No connection to the server of Lex. Press again: it will not go twice.';
  async function again(call, waits) {
    const list = Array.isArray(waits) ? waits : AGAIN_WAITS;
    for (let i = 0; ; i++) {
      try {
        return await call();
      } catch (err) {
        if (!noAnswer(err)) throw err;
        if (i >= list.length) {
          const out = new Error(err && err.network ? String(err.message || NO_CONNECTION) : NO_CONNECTION);
          out.network = true;
          throw out;
        }
        await new Promise((r) => setTimeout(r, list[i]));
      }
    }
  }
  function newOp() {
    const c = global.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function door(o) {
    const P = global.LexChatProfile;
    const kind = P && typeof P.doorOf === 'function' ? P.doorOf(o.profile) : (o.kind || 'brain');
    // The number of a press, by what it is: the same until the server answered it.
    const ops = new Map();
    const opOf = (what) => { if (!ops.has(what)) ops.set(what, newOp()); return ops.get(what); };
    // One call with its number: the number goes when the server answered (a refusal too), stays when it did not.
    async function numbered(what, call) {
      const op = opOf(what);
      try {
        const r = await again(() => call(op), kind === 'folder' ? [] : null);
        ops.delete(what);
        return r;
      } catch (err) {
        if (!noAnswer(err) && !(err && err.network)) ops.delete(what);
        throw err;
      }
    }
    const closed = () => (typeof o.closed === 'function' ? String(o.closed() || '') : '');
    const refused = (text) => ({ ok: false, text });
    const answered = (r, extra) => Object.assign({ ok: true }, r && typeof r === 'object' ? r : {}, extra || {});

    if (kind === 'brain') {
      const call = (body) => again(async () => {
        const r = await o.brain(body);
        if (!r) throw new Error('No answer.');
        return r;
      });
      return {
        kind,
        schedules: false,
        send: (m) => call({ op: 'send', turnUid: m.uid, kind: m.kind }),
        text: (m, words) => call({ op: 'text', turnUid: m.uid, kind: m.kind, text: words }),
        cancel: (m) => call({ op: 'cancel', turnUid: m.uid, kind: m.kind }),
        at: async () => refused('This window has no time to pick: the base knows when it goes.'),
        direct: async () => refused('This chat sends to nobody without Lex.'),
      };
    }

    // The boxes of a chat of Profi.ru or of the folders: their words, their time and Cancel are the database's own
    // calls; only the send of a box of the folders goes by the Send of the chat (folder-send).
    const text = async (w, words) => {
      const r = await again(() => o.rpc('profi_box_text', { p_window: w.id, p_text: words }));
      const kept = r && typeof r.text === 'string' ? { words: r.text } : {};
      // It went (or is going) while it was being changed: the server keeps the text that went, Edit closes on it.
      if (r && r.saved === false) return answered(r, Object.assign(kept, { note: 'Not saved: the text has already gone.' }));
      return answered(r, kept);
    };
    const cancel = async (w) => {
      const r = await again(() => o.rpc('profi_send_cancel', { p_window: w.id }));
      return answered(r, { putBack: r && r.state === 'removed' && r.text ? r.text : null });
    };

    if (kind === 'folder') {
      // A box of the assistant: its text word for word, with the number of the press that ties the send to the box
      // (the box shows the state of its send, lex_folder_windows_json).
      const send = async (w) => {
        const why = closed();
        if (why) return refused(why);
        if (!w || !w.id || !String(w.text || '').trim()) return refused('The box has no words.');
        const tries = w.press ? (Number(String(w.press).split(':')[2]) || 1) + 1 : 1;
        const out = await o.folderSend({
          chatKey: o.chatKey(), text: w.text, opId: tries > 1 ? `win:${w.id}:${tries}` : `win:${w.id}`,
          ...(w.quote && w.quote.uid ? { quoteUid: w.quote.uid } : {}),
        });
        const s = out && out.send ? out.send : { state: 'queued' };
        return answered(s, { test: !!s.test });
      };
      // The person's own text, now: one number for these words and this quote until the server answered them.
      const direct = async (words, opts) => {
        const why = closed();
        if (why) return refused(why);
        const t = String(words || '').trim();
        const quote = (opts && opts.quote) || null;
        if (!t) return refused('Nothing to send.');
        if (opts && opts.at) return refused('A chat of the folders sends at once: no time to pick.');
        return numbered(`direct|${o.chatKey()}|${quote || ''}|${t}`, async (op) => {
          const out = await o.folderSend({ chatKey: o.chatKey(), text: t, opId: op, ...(quote ? { quoteUid: quote } : {}) });
          const s = out && out.send ? out.send : { state: 'queued' };
          return answered(s, { test: !!s.test });
        });
      };
      return {
        kind, schedules: false, send, text, cancel, direct,
        at: async () => refused('A chat of the folders sends at once: no time to pick.'),
      };
    }

    // An order chat of Profi.ru: the box goes to the monitor, which sends it where the window says.
    return {
      kind,
      schedules: true,
      text,
      cancel,
      send: (w) => numbered(`send|${w.id}`, async (op) => answered(await o.rpc('profi_send', { p_op_id: op, p_window: w.id }))),
      at: (w, when) => numbered(`at|${w.id}|${when.toISOString()}`, async (op) =>
        answered(await o.rpc('profi_send_at', { p_op_id: op, p_window: w.id, p_at: when.toISOString() }))),
      direct: (words, opts) => {
        const t = String(words || '');
        const quote = (opts && opts.quote) || null;
        const at = (opts && opts.at) || null;
        return numbered(`direct|${o.order()}|${quote || ''}|${at ? at.toISOString() : ''}|${t}`, async (op) => answered(await o.rpc('profi_send_text', {
          p_op_id: op, p_order: o.order(), p_text: t, p_at: at ? at.toISOString() : null,
          ...(quote ? { p_quote_uid: quote } : {}),
        })));
      },
    };
  }

  // ── the look at the queue ───────────────────────────────────────────────────
  // What a window on its way does is told by the database itself: every change of its task — the hold of this or of
  // another device, the executor that took it, the message that went or did not, the time of a scheduled one, a
  // cancel — is a signal «marks», and the chat reads its marks then (now(read)). The queue of the database (`status`)
  // is asked only to catch up, once: when the chat opens and when the channel of signals is open again after a break
  // and its journal could not say what was missed (the follower of the signal gets null) — never on a timer (Gennady,
  // 21.11.2026: «по часам идут только сроки, где время и есть событие; новость приходит сигналом»).
  //   open()   the chat is still the open one
  //   alive()  a window of it is on its way (отправляется, ждёт, идёт; an old mark send in ждёт, идёт): only then is
  //            the queue asked; a draft that waits for the hold never is
  //   ask()    one `status` call, applying the marks it brings → Promise; rejects when it did not get through
  //   now()      the queue, once, now
  //   now(read)  a reading of the caller's own, now (the marks a signal names) → Promise, rejects when it failed;
  //              pass the same function every time: asked again while it runs, it runs once more after it
  //   stop()     the chat closed or changed: nothing waits, nothing is tried again
  // Never two readings at once. A reading that did not get through is tried again after the pauses of a failed read
  // of the sections (LexSection.AGAIN_MS: 1, 2, 5, 10, 20, 30 s, then 30 s again) while the chat is open — the repeat
  // of a failure, not a poll for news; any now() starts the ladder over.
  function look(o) {
    let gen = 0;
    let busy = -1;
    let timer = 0;
    let fails = 0;
    const queue = new Set();
    const failed = new Set();
    const open = () => (typeof o.open === 'function' ? !!o.open() : true);
    const status = () => o.ask();
    const pauses = () => (global.LexSection && Array.isArray(global.LexSection.AGAIN_MS) ? global.LexSection.AGAIN_MS : []);
    const unwait = () => {
      if (!timer) return;
      clearTimeout(timer);
      timer = 0;
      for (const r of failed) queue.add(r);
      failed.clear();
    };
    function again() {
      const list = pauses();
      if (timer || !list.length) return;
      fails += 1;
      timer = setTimeout(() => { timer = 0; for (const r of failed) queue.add(r); failed.clear(); pump(); },
        list[Math.min(fails - 1, list.length - 1)]);
    }
    function pump() {
      if (busy === gen) return;
      const read = queue.values().next().value;
      if (!read) { if (failed.size) again(); else fails = 0; return; }
      queue.delete(read);
      if (!open() || (read === status && !o.alive())) { pump(); return; }
      const g = gen;
      busy = g;
      Promise.resolve()
        .then(read)
        .then(() => { if (g === gen) failed.delete(read); }, () => { if (g === gen) failed.add(read); })
        .then(() => {
          if (busy === g) busy = -1;
          if (g === gen) pump();
        });
    }
    return {
      now(read) {
        unwait();
        fails = 0;
        queue.add(typeof read === 'function' ? read : status);
        pump();
      },
      stop() {
        gen += 1;
        busy = -1;
        clearTimeout(timer);
        timer = 0;
        fails = 0;
        queue.clear();
        failed.clear();
      },
    };
  }

  global.LexDraftBox = { create, windows, door, again, isBox, boxesOf, aliveIn, sameMarks, look };
})(typeof window !== 'undefined' ? window : globalThis);
