// lex-person.js — the card of a person (ios/Lex/STANDARD.md В7.41, Gennady 16.11.2026).
//
// A press on the photo or the name in the bar of an order chat of Profi.ru opens the card of the
// person on the page and in the program for the Mac: the sheet in the middle (В7.15). On top the
// photo or the letter 96 (В7.12), the name 22/650 and who he is 15 `--fg-muted`; the blocks of the
// server — rows from 56 high, the label 13 `--fg-muted` and the value; a link has the mark of its
// service 24 on the left and a chevron 18 on the right; then the actions, rows of 44: Edit contact
// (a pencil), Mute with a switch, Delete contact in `--danger`. The iPhone draws the same card in
// PersonCard.swift by the same numbers.
//
// Everything the card shows comes from the server (supabase/functions/person-card): the server
// asks the database of Gennady who the person is and puts the rows together. The card only draws
// `blocks` as they come — a new block of the server is drawn with no change here — and sends three
// questions: the card, Edit, Mute/Delete/Restore.
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
    chevron: ['M9 18l6-6-6-6'],
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

  // The mark of a service 24: the same one as in the stamp of a message (В7.2), bigger.
  function mark(channel) {
    const M = global.LexMessage;
    const n = M && M.channel ? M.channel(channel) : null;
    if (!n) return null;
    n.setAttribute('width', '24');
    n.setAttribute('height', '24');
    n.classList.add('lex-person-mark');
    return n;
  }

  // The first word of the name: «Delete Dmitry from Lex?».
  const firstWord = (name) => (String(name || '').trim().split(/\s+/)[0] || 'this person');
  const newOp = () => (global.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());

  // ── the rows ─────────────────────────────────────────────────────────────────
  function row(r) {
    const link = !!r.url;
    const n = make(link ? 'a' : 'div', 'lex-person-row' + (link ? ' is-link' : ''));
    if (link) {
      n.href = r.url;
      n.target = '_blank';
      n.rel = 'noopener';
    }
    if (r.channel) {
      const m = mark(r.channel);
      if (m) n.appendChild(m);
    }
    const words = make('span', 'lex-person-words');
    words.append(make('span', 'lex-person-label', r.label || ''), make('span', 'lex-person-value', r.value || ''));
    n.appendChild(words);
    if (link) n.appendChild(icon('chevron', 18));
    if (r.kind) n.dataset.kind = r.kind;
    return n;
  }

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

    for (const b of card.blocks || []) {
      if (!(b.rows || []).length) continue;
      const block = make('div', 'lex-person-block');
      block.dataset.block = b.id || '';
      for (const r of b.rows) block.appendChild(row(r));
      root.appendChild(block);
    }

    const acts = make('div', 'lex-person-block lex-person-acts');
    if (card.deleted) {
      root.appendChild(make('div', 'lex-person-note', 'Deleted from Lex. Restore brings the card and the chat back.'));
      acts.appendChild(action({ icon: 'undo', label: 'Restore contact', onClick: () => act('restore') }));
    } else {
      if (card.edit && card.edit.can) acts.appendChild(action({ icon: 'pencil', label: 'Edit contact', onClick: () => act('edit') }));
      const sw = toggle(card.muted, (on, input) => act(on ? 'mute' : 'unmute', input));
      const mute = action({ tag: 'label', icon: 'bellOff', label: 'Mute', end: sw.label });
      acts.appendChild(mute);
      acts.appendChild(action({ icon: 'trash', label: 'Delete contact', danger: true, onClick: () => act('delete') }));
    }
    root.appendChild(acts);
    return root;
  }

  function editNode(card, onSave, onCancel) {
    const form = make('form', 'lex-person-edit');
    form.noValidate = true;
    const field = (label, value, type) => {
      const wrap = make('label', 'lex-person-field');
      const input = make('input');
      input.type = type;
      input.value = value || '';
      input.autocomplete = 'off';
      wrap.append(make('span', 'lex-person-label', label), input);
      return { wrap, input };
    };
    const name = field('Name', card.edit && card.edit.name, 'text');
    name.input.maxLength = 120;
    const phone = field('Phone', card.edit && card.edit.phone, 'tel');
    phone.input.maxLength = 40;
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
    form.append(name.wrap, phone.wrap,
      make('div', 'lex-person-note', 'Lex keeps the name and the phone in the card of this person. The chats in the messengers do not change.'),
      err, buttons);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      save.disabled = true;
      err.hidden = true;
      try {
        await onSave(name.input.value, phone.input.value);
      } catch (x) {
        err.textContent = (x && x.message) || 'Not saved. Try again.';
        err.hidden = false;
        save.disabled = false;
      }
    });
    setTimeout(() => name.input.focus(), 0);
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

    async function mark(act, input) {
      try {
        const r = await o.call({ op: 'mark', chatKey: o.chatKey, act, opId: newOp() });
        card = r.card;
        paint();
      } catch (e) {
        if (input) input.checked = !input.checked;
        fail(e);
      }
    }

    async function act(what, input) {
      if (what === 'edit') {
        editing = true;
        const head = sheet.body.closest('.wc-sheet-card').querySelector('.wc-sheet-head h2');
        if (head) head.textContent = 'Edit contact';
        const back = () => {
          editing = false;
          if (head) head.textContent = 'Contact';
          paint();
        };
        sheet.body.replaceChildren(editNode(card, async (name, phone) => {
          const r = await o.call({ op: 'edit', chatKey: o.chatKey, name, phone, opId: newOp() });
          card = r.card;
          back();
          if (o.onChanged) o.onChanged(card);
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

  global.LexPerson = { open, cardNode, editNode, firstWord };
})(typeof window !== 'undefined' ? window : globalThis);
