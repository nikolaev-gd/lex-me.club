// lex-person.js — the card of a person (ios/Lex/STANDARD.md В7.41, Gennady 16.11.2026).
//
// A press on the photo or the name in the bar of an order chat of Profi.ru opens the card of the
// person on the page and in the program for the Mac: the sheet in the middle (В7.15). The card is a
// text about the person (Gennady, 16.11.2026, after the first card): on top the photo or the letter 96
// (В7.12), the name 22/650 and who he is 15 `--fg-muted`; then «About» — his own text from his profile
// in Telegram or Max, read only, with its place («From Telegram»); then «Your notes» — Gennady's own
// text about him, with «Edit» (or «Add a note») in its head; then «Open the chat in» — second buttons
// (В7.7) of 44, of equal width, with the mark of the service 18: Telegram, WhatsApp, Profi.ru; the
// phone with a button that copies it; Mute with a switch and Delete contact in `--danger`. The iPhone
// draws the same card in PersonCard.swift by the same numbers.
//
// Everything the card shows comes from the server (supabase/functions/person-card): the server asks
// the database of Gennady who the person is and puts the card together. `extra` — the blocks the server
// adds later — is drawn as it comes, with no change here. Three questions go to the server: the card,
// the notes, Mute/Delete/Restore.
//
//   LexPerson.open({ chatKey, name, call, onGone, io })
//     call(body) → Promise<{ card }>, refuses with Error(<words of the server>)
//     io         — the files of the person's chats ({ blob(path) }, fileIo of lex-profi.js): the photo
//                  the server keeps (`card.photo`) comes through it; none — the letter alone
//     onGone()   — the sheet closed on a person deleted from Lex: his chat is off the list now
(function (global) {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const HOST = 'wc-person';
  const ICONS = {
    pencil: ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z'],
    bellOff: ['M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5', 'M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7',
      'M10.3 21a1.94 1.94 0 0 0 3.4 0', 'M2 2l20 20'],
    trash: ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 13h10l1-13', 'M9 7V4h6v3'],
    undo: ['M9 14L4 9l5-5', 'M4 9h10.5a5.5 5.5 0 0 1 0 11H11'],
    copy: ['M9 9h10v10H9z', 'M5 15V5h10'],
    check: ['M4 12l5 5L20 6'],
  };

  function make(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function icon(name, size) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'lex-person-icon');
    for (const d of ICONS[name]) {
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', d);
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', 'currentColor');
      p.setAttribute('stroke-width', '2');
      p.setAttribute('stroke-linecap', 'round');
      p.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(p);
    }
    return svg;
  }

  // The mark of a service: the same one as in the stamp of a message (В7.2), bigger.
  function mark(channel, size) {
    const M = global.LexMessage;
    const n = M && M.channel ? M.channel(channel) : null;
    if (!n) return null;
    n.setAttribute('width', String(size));
    n.setAttribute('height', String(size));
    n.classList.add('lex-person-mark');
    return n;
  }

  // The first word of the name: «Delete Dmitry from Lex?».
  const firstWord = (name) => (String(name || '').trim().split(/\s+/)[0] || 'this person');
  const newOp = () => (global.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());

  function action(o) {
    const n = make(o.tag || 'button', 'lex-person-act' + (o.danger ? ' is-danger' : ''));
    if (n.tagName === 'BUTTON') n.type = 'button';
    n.appendChild(icon(o.icon, 18));
    n.appendChild(make('span', 'lex-person-act-words', o.label));
    if (o.end) n.appendChild(o.end);
    if (o.onClick) n.addEventListener('click', o.onClick);
    return n;
  }

  // The switch of the page (the same `.wc-switch` as in the settings).
  function toggle(on, onChange) {
    const input = make('input');
    input.type = 'checkbox';
    input.checked = !!on;
    input.setAttribute('role', 'switch');
    input.setAttribute('aria-label', 'Mute');
    input.addEventListener('change', () => onChange(input.checked, input));
    const track = make('span', 'wc-switch-track');
    track.appendChild(make('span', 'wc-switch-knob'));
    const label = make('span', 'wc-switch');
    label.append(input, track);
    return { label, input };
  }

  // A block of the server added later (`extra`): rows of a label and a value, a link opens its place.
  function extraBlock(b) {
    const block = make('div', 'lex-person-block');
    block.dataset.block = b.id || '';
    for (const r of b.rows || []) {
      const row = make(r.url ? 'a' : 'div', 'lex-person-row' + (r.url ? ' is-link' : ''));
      if (r.url) {
        row.href = r.url;
        row.target = '_blank';
        row.rel = 'noopener';
      }
      const words = make('span', 'lex-person-words');
      words.append(make('span', 'lex-person-label', r.label || ''), make('span', 'lex-person-value', r.value || ''));
      row.appendChild(words);
      block.appendChild(row);
    }
    return block;
  }

  // ── the card ─────────────────────────────────────────────────────────────────
  function cardNode(card, act, io) {
    const M = global.LexMessage;
    const root = make('div', 'lex-person');
    const head = make('div', 'lex-person-head');
    const photo = make('div', 'lex-person-photo');
    photo.appendChild(M.avatar(card.name, { photo: card.photo || null, io, size: 96 }));
    head.append(photo, make('div', 'lex-person-name', card.name || ''));
    if (card.who) head.appendChild(make('div', 'lex-person-who', card.who));
    root.appendChild(head);

    // About: the person's own text from his profile.
    if (card.about && card.about.text) {
      const about = make('div', 'lex-person-block lex-person-text');
      const top = make('div', 'lex-person-text-head');
      top.appendChild(make('span', 'lex-person-text-title', 'About'));
      if (card.about.from) {
        const m = card.about.source ? mark(card.about.source, 14) : null;
        if (m) top.appendChild(m);
        top.appendChild(make('span', 'lex-person-from', card.about.from));
      }
      about.append(top, make('div', 'lex-person-text-body', card.about.text));
      root.appendChild(about);
    }

    // Your notes: Gennady's own text about the person.
    const notes = card.notes || {};
    if (notes.can) {
      const block = make('div', 'lex-person-block lex-person-text lex-person-notes');
      const top = make('div', 'lex-person-text-head');
      top.appendChild(make('span', 'lex-person-text-title', 'Your notes'));
      const edit = make('button', 'lex-person-edit-btn');
      edit.type = 'button';
      edit.append(icon('pencil', 16), make('span', '', notes.text ? 'Edit' : 'Add a note'));
      edit.addEventListener('click', () => act('notes'));
      top.appendChild(edit);
      block.appendChild(top);
      if (notes.text) block.appendChild(make('div', 'lex-person-text-body', notes.text));
      root.appendChild(block);
    }

    // Open the chat in: the places the person can be written to.
    if ((card.open || []).length) {
      const wrap = make('div', 'lex-person-open');
      wrap.appendChild(make('div', 'lex-person-label', 'Open the chat in'));
      const row = make('div', 'lex-person-open-row');
      for (const o of card.open) {
        const b = M.button({ label: o.label });
        const m = mark(o.channel, 18);
        if (m) b.prepend(m);
        b.setAttribute('aria-label', 'Open the chat in ' + o.label);
        b.dataset.channel = o.channel;
        b.addEventListener('click', () => global.open(o.url, '_blank', 'noopener'));
        row.appendChild(b);
      }
      wrap.appendChild(row);
      root.appendChild(wrap);
    }

    // The phone, with a button that copies it.
    if (card.phone) {
      const block = make('div', 'lex-person-block');
      const row = make('div', 'lex-person-row lex-person-phone');
      const words = make('span', 'lex-person-words');
      words.append(make('span', 'lex-person-label', 'Phone'), make('span', 'lex-person-value', card.phone));
      const copy = make('button', 'wc-icon-btn is-44 lex-person-copy');
      copy.type = 'button';
      copy.setAttribute('aria-label', 'Copy the phone');
      copy.title = 'Copy the phone';
      copy.appendChild(icon('copy', 18));
      copy.addEventListener('click', async () => {
        const ok = await navigator.clipboard.writeText(card.phone.replace(/[^\d+]/g, '')).then(() => true, () => false);
        if (!ok) return;
        copy.replaceChildren(icon('check', 18));
        setTimeout(() => copy.replaceChildren(icon('copy', 18)), 1500);
      });
      row.append(words, copy);
      block.appendChild(row);
      root.appendChild(block);
    }

    for (const b of card.extra || []) if ((b.rows || []).length) root.appendChild(extraBlock(b));

    const acts = make('div', 'lex-person-block lex-person-acts');
    if (card.deleted) {
      root.appendChild(make('div', 'lex-person-note', 'Deleted from Lex. Restore brings the card and the chat back.'));
      acts.appendChild(action({ icon: 'undo', label: 'Restore contact', onClick: () => act('restore') }));
    } else {
      const sw = toggle(card.muted, (on, input) => act(on ? 'mute' : 'unmute', input));
      acts.appendChild(action({ tag: 'label', icon: 'bellOff', label: 'Mute', end: sw.label }));
      acts.appendChild(action({ icon: 'trash', label: 'Delete contact', danger: true, onClick: () => act('delete') }));
    }
    root.appendChild(acts);
    return root;
  }

  // Your notes: a field of many lines, the words under it from the server, Cancel and Save.
  function notesNode(card, onSave, onCancel) {
    const form = make('form', 'lex-person-edit');
    form.noValidate = true;
    const field = make('textarea', 'lex-person-notes-field');
    field.value = (card.notes && card.notes.text) || '';
    field.maxLength = 4000;
    field.setAttribute('aria-label', 'Your notes');
    const err = make('div', 'lex-person-error');
    err.setAttribute('role', 'alert');
    err.hidden = true;
    const M = global.LexMessage;
    const cancel = M.button({ label: 'Cancel' });
    const save = M.button({ label: 'Save', main: true });
    save.type = 'submit';
    cancel.addEventListener('click', onCancel);
    const buttons = make('div', 'lex-person-buttons');
    buttons.append(cancel, save);
    form.append(field, make('div', 'lex-person-note', (card.notes && card.notes.hint) || 'Only you see this.'), err, buttons);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      save.disabled = true;
      err.hidden = true;
      try {
        await onSave(field.value);
      } catch (x) {
        err.textContent = (x && x.message) || 'Not saved. Try again.';
        err.hidden = false;
        save.disabled = false;
      }
    });
    setTimeout(() => field.focus(), 0);
    return form;
  }

  function open(o) {
    const UI = global.WcUI;
    let card = null;
    let sheet = null;
    let editing = false;
    const busy = make('div', 'lex-person-wait', 'Loading…');
    sheet = UI.sheet(HOST, 'Contact', [busy], () => {
      if (card && card.deleted && o.onGone) o.onGone(card);
    });

    const paint = () => {
      if (!sheet || editing) return;
      sheet.body.replaceChildren(cardNode(card, act, o.io));
    };
    const fail = (e) => UI.toast((e && e.message) || 'The server of Lex did not answer.', { error: true });

    async function mark(what, input) {
      try {
        const r = await o.call({ op: 'mark', chatKey: o.chatKey, act: what, opId: newOp() });
        card = r.card;
        paint();
      } catch (e) {
        if (input) input.checked = !input.checked;
        fail(e);
      }
    }

    async function act(what, input) {
      if (what === 'notes') {
        editing = true;
        const head = sheet.body.closest('.wc-sheet-card').querySelector('.wc-sheet-head h2');
        if (head) head.textContent = 'Your notes';
        const back = () => {
          editing = false;
          if (head) head.textContent = 'Contact';
          paint();
        };
        sheet.body.replaceChildren(notesNode(card, async (text) => {
          const r = await o.call({ op: 'note', chatKey: o.chatKey, text, opId: newOp() });
          card = r.card;
          back();
        }, back));
        return;
      }
      if (what === 'delete') {
        const yes = await UI.confirm('Delete ' + firstWord(card.name) + ' from Lex?',
          'The card and the chat leave Lex. Nothing changes in the messengers.', { okText: 'Delete', danger: true });
        if (yes) await mark('delete');
        return;
      }
      await mark(what, input);
    }

    o.call({ op: 'card', chatKey: o.chatKey }).then((r) => {
      card = r.card;
      paint();
    }, (e) => {
      busy.textContent = (e && e.message) || 'The server of Lex did not answer.';
    });
    return sheet;
  }

  global.LexPerson = { open, cardNode, notesNode, firstWord };
})(typeof window !== 'undefined' ? window : globalThis);
