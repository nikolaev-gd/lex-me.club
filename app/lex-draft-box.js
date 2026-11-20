// lex-draft-box.js — the window with a message to a person under an answer of the model, in the ordinary
// chat of Lex (В7.51, 2026-11-20; Gennady: «отправка сообщения только в двух сценариях: либо когда я заранее
// предупредил, либо при долгом нажатии»). One file for the page lex-me.club/app (the Mac app shows that page) and
// for the extension: the side panel and the standalone chat draw the same window with it. The iPhone has the same
// window in Swift (ios/Lex/Lex/Parts/DraftWindow.swift, LexDraftWindow) on the same server calls.
//
// What the server gives (supabase/functions/_shared/brain-boxes.ts): under the answer in which the model prepared a
// message to a person the chat holds a mark of the kind `box:<n>` — the text word for word, whom and where it goes,
// when, and the state of the task. The window is that mark drawn from the common parts, with the look of the box of
// an order chat of Profi.ru (lex-profi.js boxNode, В7.20 and В7.23): the draft bubble with Copy, 6 under it the row
// «Hold to send to <name>» + «⋯» (Edit), the line under the row. A tap sends nothing: only the hold of the button
// (480 ms, LexLongPress through LexMessage.sendHold) asks the server to send. Several windows may stand under one
// answer: they go by `data.seq`, 12 apart.
//
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
//
// LexDraftBox gives:
//   create(deps) → controller { node(mark), reset() }
//       One controller per chat view. It keeps what must survive the drawing of an answer again — the words typed in
//       Edit, the line of the last refusal, a press on its way — by `uid|kind` of the mark. node(mark) → the element
//       of one window; brainMarksNode (lex-answer-row.js, `boxes`) puts the nodes of an answer in its container.
//       deps = {
//         send(mark)         the hold of the button           → Promise of the answer of brain-action, or throws
//         text(mark, text)   Save in Edit                     → the same
//         cancel(mark)       «Cancel» of a task that waits    → the same
//         apply(marks)       the whole list of marks the server gave: the caller replaces what the chat holds and
//                            draws it again (here, once — nobody else applies the answer of these three calls)
//         follow(opts)       the window asks to follow the task: opts { fresh, once } of watch().kick
//         copy(text)         Copy of the bubble → Promise<bool> (default: LexAnswerRow.copyText)
//         layer              a class the menu of «⋯» gets in the <body> (the windows of the extension: ytvocab-sl-portal)
//       }
//       The answer of brain-action: { ok, state, text, busy, marks }. A call resolves with it, whatever `ok` says, or
//       throws Error(reason) when the server was not reached (an HTTP error, no network): the adapters of the four
//       places give that one shape.
//   isBox(mark), boxesOf(list) → the windows of an answer, by data.seq
//   aliveIn(marks) → is a window on its way (отправляется, ждёт, идёт) or an old mark «send» (ждёт, идёт);
//       marks — an array, or a Map of uid → array
//   sameMarks(a, b) → the two lists say the same: a poll that brought nothing new must not draw the answer again
//       (a button under a held finger would be replaced)
//   watch({ open, alive, ask }) → { kick(opts), stop() } — the follow-up: while a window is on its way, ask the
//       queue (`status`) every 3 s, one call at a time; stop when none is alive, after 10 minutes, or when the chat is
//       closed (open() false). The realtime signal «marks» goes on beside it. A draft that waits for a hold is not asked.
//
// The hooks of the check pages and the live checks: the root of a window has data-kind (box:<n>) and data-state;
// the buttons have data-role: hold (the button that sends), more («⋯»), cancel (the task that waits), edit-save,
// edit-cancel; the line under the row is .lex-draft-box-note (role=status).
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
  const EVERY_MS = 3000;
  const LIMIT_MS = 10 * 60 * 1000;

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

  // ── the controller ──────────────────────────────────────────────────────────
  function create(deps) {
    const d0 = deps || {};
    // What the person typed or was told, by window. The chat draws the answer again on a signal of the database,
    // and these must survive it.
    //   edit — { text, field, fresh } while Edit is open
    //   line — { text, error, state, note } what the last press left (a refusal, a failure); it belongs to the state
    //          and the note the window had when the answer of the press came
    //   busy — the words said while a press is on its way, or null
    const ui = new Map();
    const drawn = new Map();
    const keyOf = (m) => `${m.uid}|${m.kind}`;
    const uiOf = (k) => {
      if (!ui.has(k)) ui.set(k, { edit: null, line: null, busy: null });
      return ui.get(k);
    };

    // The window drawn again where it stands, from the mark it was drawn with last.
    function repaint(k) {
      const d = drawn.get(k);
      if (!d || !d.node.isConnected) return;
      d.node.replaceWith(build(d.mark));
    }

    // One press on a window: the call, what to say about it, the marks of the answer applied once.
    async function act(m, what, call) {
      const k = keyOf(m);
      const u = uiOf(k);
      const saving = what === 'text';
      let r = null;
      let why = '';
      try { r = await call(); } catch (e) { why = (e && e.message) ? String(e.message) : 'No connection.'; }
      u.busy = null;
      const marks = r && Array.isArray(r.marks) ? r.marks : null;
      // The line belongs to the state the window is in after the answer: another state is another story.
      const at = (marks && marks.find((x) => x && x.uid === m.uid && x.kind === m.kind)) || m;
      const keyed = { state: String(at.state || DRAFT), note: String(at.note || '') };
      if (!r || typeof r !== 'object') {
        u.line = Object.assign({ text: `${saving ? 'Not saved' : 'Not done'}. ${why}`.trim(), error: true }, keyed);
      } else if (r.ok === false && !r.busy) {
        const reason = String(r.text || '').trim();
        u.line = Object.assign({ text: saving ? `Not saved. ${reason}`.trim() : (reason || 'Not done.'), error: true }, keyed);
      } else {
        // Done, or another press is being handled (busy): what the marks say is the window.
        u.line = null;
        if (saving && r.ok !== false) u.edit = null;
      }
      // The field of Edit is still open (the call failed, the server refused): the caret goes back into it, where the
      // words are to be mended — the button that was pressed is drawn anew and the focus would be lost.
      if (u.edit) u.edit.fresh = true;
      const before = drawn.get(k);
      if (marks && typeof d0.apply === 'function') {
        try { d0.apply(marks); } catch (_) { /* the caller could not draw: the window is drawn again below */ }
      }
      // The caller draws the answer again when the marks changed; when they did not (a refusal, the same list) the
      // window is still the old node: drawn again here with what the press left in `ui`.
      if (!before || drawn.get(k) === before) repaint(k);
      if (typeof d0.follow === 'function') d0.follow({ fresh: true, once: !!(r && r.busy) });
    }

    function build(m) {
      const M = global.LexMessage;
      const d = m.data || {};
      const k = keyOf(m);
      const s = String(m.state || DRAFT);
      const u = uiOf(k);
      const known = KNOWN.has(s);
      const editable = s === DRAFT || s === NOT_SENT;
      const messenger = messengerOf(d.channel);
      const name = String(d.name || '').trim();
      const files = (Array.isArray(d.files) ? d.files : []).map((f) => String((f && f.name) || '')).filter(Boolean);
      const words = typeof d.text === 'string' ? d.text : '';
      // A window that cannot change any more (it went, it waits for its time) has no Edit open; a line made in
      // another state or under another note is not this window's any more (another device pressed meanwhile).
      if (!editable) u.edit = null;
      if (u.line && (u.line.state !== s || u.line.note !== String(m.note || ''))) u.line = null;

      const root = make('div', `lex-draft-box${s === CANCELLED ? ' is-cancelled' : ''}`);
      root.dataset.kind = String(m.kind);
      root.dataset.state = s;
      root.setAttribute('role', 'group');
      root.setAttribute('aria-label', `Message to ${name || 'the person'}${messenger ? ` in ${messenger}` : ''}`);
      drawn.set(k, { mark: m, node: root });
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

      function paintView() {
        const note = newNote();
        const copy = copyFn && words ? async () => {
          const ok = await copyFn(words);
          if (!ok) putNote(note, { text: 'The browser refused the clipboard.', error: true });
          return ok;
        } : undefined;
        // With no words (only files go) the bubble names the files, so that it is not an empty one.
        const kids = [M.bubble({ side: 'out', tone: 'draft', text: words || files.join('\n'), copy })];
        if (s === DRAFT || !known) for (const text of infoOf(m)) kids.push(make('div', 'lex-draft-box-info', text));

        const foot = make('div', 'lex-draft-box-foot');
        if (editable) {
          const again = s === NOT_SENT;
          const first = firstWord(name);
          const label = `Send${again ? ' again' : ''} to ${name || 'the person'}${messenger ? ` on ${messenger}` : ''}. Hold to send`;
          const startEdit = () => {
            u.edit = { text: words, field: null, fresh: true };
            u.line = null;
            paintEdit();
          };
          const { send, more } = M.sendHold({
            channel: d.channel,
            words: again ? 'Hold to send again' : first ? `Hold to send to ${first}` : 'Hold to send',
            label,
            items: () => [{ label: 'Edit', icon: 'pencil', run: startEdit }],
            onSend: () => {
              if (u.busy) return;
              u.busy = sendingWords(messenger);
              u.line = null;
              send.disabled = true;
              if (more) more.disabled = true;
              putNote(note, { text: u.busy });
              act(m, 'send', () => d0.send(m));
            },
          });
          send.dataset.role = 'hold';
          if (more) more.dataset.role = 'more';
          if (u.busy) { send.disabled = true; if (more) more.disabled = true; }
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
          if (more) foot.append(more);
        } else if (s === WAITS) {
          const cancel = M.button({ label: 'Cancel' });
          cancel.dataset.role = 'cancel';
          cancel.disabled = !!u.busy;
          cancel.addEventListener('click', () => {
            if (u.busy) return;
            u.busy = 'Cancelling…';
            u.line = null;
            cancel.disabled = true;
            putNote(note, { text: u.busy });
            act(m, 'cancel', () => d0.cancel(m));
          });
          foot.append(cancel);
        }
        // The line: what a press says now, else what it left, else what the state says.
        putNote(note, u.busy ? { text: u.busy } : (u.line || lineOf(m)));
        if (foot.childElementCount) kids.push(foot);
        kids.push(note);
        root.classList.remove('is-editing');
        root.replaceChildren(...kids);
      }

      // Edit → Save (the same as in the box of an order chat, В7.20): the words of the bubble become a field in the
      // same bubble; under it «Cancel» and «Save» stand in place of the row that sends. A tap on them sends nothing
      // to anyone. Save asks the server (op `text`); Escape and Cancel throw away what was typed; Ctrl or Cmd with
      // Enter saves. What was typed lives in `ui`, so a drawing of the answer again does not lose it.
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
          u.busy = 'Saving…';
          u.line = null;
          saveBtn.disabled = true;
          cancelBtn.disabled = true;
          putNote(note, { text: u.busy });
          act(m, 'text', () => d0.text(m, entry.text));
        };
        const ed = M.editField({
          value: entry.text,
          label: `Message to ${name || 'the person'}`,
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
        const bubble = M.bubble({ side: 'out', tone: 'draft', body: ed.body });
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
        root.classList.add('is-editing');
        root.replaceChildren(bubble, foot, note);
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
      node: build,
      reset() { ui.clear(); drawn.clear(); },
    };
  }

  // ── following the task ──────────────────────────────────────────────────────
  // While a window is on its way the queue of the database is asked every 3 s (`status`), one call at a time (the
  // next round is armed when the answer came), for 10 minutes at most from the start; none alive — it stops by
  // itself; the chat closed — it stops at the next round. Nothing is asked for a draft that waits for the hold.
  //   open()   the chat of the window is still the open one
  //   alive()  a window of it is on its way
  //   ask()    one `status` call, applying the marks it brings → Promise
  //   kick({ now, once, fresh })  something was drawn or answered: follow if a window is alive.
  //       once — ask one time even when none is alive (another device pressed: `busy`); now — ask at once (the
  //       chat was just opened); fresh — a press of this person: the ten minutes count from now.
  function watch(o) {
    let timer = 0;
    let since = 0;
    let asking = false;
    let want = false;
    const open = () => (typeof o.open === 'function' ? !!o.open() : true);
    const within = () => Date.now() - since <= LIMIT_MS;
    const arm = (ms) => { clearTimeout(timer); timer = setTimeout(tick, ms); };
    async function tick() {
      timer = 0;
      if (asking) return;
      const once = want;
      want = false;
      if (!open()) { since = 0; return; }
      if (!once && (!o.alive() || !within())) return;
      asking = true;
      try { await o.ask(); } catch (_) { /* the next round tries again */ } finally { asking = false; }
      if (!open()) { since = 0; return; }
      if (!timer && (want || (o.alive() && within()))) arm(want ? 0 : EVERY_MS);
    }
    return {
      kick(x) {
        const opts = x || {};
        if (!open()) return;
        if (opts.once) want = true;
        else if (!o.alive()) return;
        if (opts.fresh || !since) since = Date.now();
        else if (!within() && !opts.once) return;
        if (asking) return;
        if (timer) { if (opts.now || opts.once) arm(0); return; }
        arm(opts.now || opts.once ? 0 : EVERY_MS);
      },
      stop() { clearTimeout(timer); timer = 0; since = 0; want = false; },
    };
  }

  global.LexDraftBox = { create, isBox, boxesOf, aliveIn, sameMarks, watch, EVERY_MS, LIMIT_MS };
})(typeof window !== 'undefined' ? window : globalThis);
