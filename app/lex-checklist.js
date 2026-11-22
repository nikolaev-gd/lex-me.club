// lex-checklist.js — the row of a checklist on the page and in the Mac app (ios/Lex/STANDARD.md, В7.53, 22.11.2026).
//
// One drawing of a checklist: the circle on the left, the text on the right, no separators. The shopping list is made
// of it (webchat/wc-shopping.js); the iPhone draws the same part in ios/Lex/Lex/Parts/ChecklistRow.swift.
//
//   circle(done)           the circle 22: empty — to do, filled with a check — done
//   row(o)                 a row: o = { text, done, onCircle(), onText() } →
//                            { el, set({ text, done }), edit(o) → the field, endEdit(), get editing }
//                          edit(o): the text becomes a field in place — o = { value, onInput(v), onEnter(v), onBlur(v),
//                          onEscape() }; the field keeps the cursor at its end.
//   newRow(o)              the row a new item is typed in (the board ShopF1: a dashed frame, a dashed circle, the grey
//                          prompt): o = { prompt, onInput(v), onEnter(v), onEscape() } → { el, input, focus() }
(function (global) {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';

  function make(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function svg(children, label) {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', '22');
    s.setAttribute('height', '22');
    s.setAttribute('fill', 'none');
    if (label) { s.setAttribute('role', 'img'); s.setAttribute('aria-label', label); } else s.setAttribute('aria-hidden', 'true');
    for (const [tag, attrs] of children) {
      const c = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) c.setAttribute(k, v);
      s.appendChild(c);
    }
    return s;
  }

  // The circle: the line of the faint colour — to do; filled with the muted colour and a check of the ground — done.
  function circle(done, dashed) {
    if (done) {
      return svg([['circle', { cx: 12, cy: 12, r: 10, class: 'lex-check-fill' }],
        ['path', { d: 'M7.5 12.5l3 3 6-6.5', class: 'lex-check-tick' }]], 'Done');
    }
    return svg([['circle', { cx: 12, cy: 12, r: 10, class: dashed ? 'lex-check-ring is-dashed' : 'lex-check-ring' }]], dashed ? null : 'Not done');
  }

  // A field of a row: Return and Esc are the row's, the rest is typing.
  function field(o) {
    const input = make('input', 'lex-check-input');
    input.type = 'text';
    input.autocomplete = 'off';
    input.spellcheck = true;
    input.maxLength = 200;
    if (o.prompt) input.placeholder = o.prompt;
    if (o.enterKey) input.enterKeyHint = o.enterKey;
    input.addEventListener('input', () => { if (o.onInput) o.onInput(input.value); });
    input.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'Enter') { e.preventDefault(); if (o.onEnter) o.onEnter(input.value); }
      else if (e.key === 'Escape') { e.preventDefault(); if (o.onEscape) o.onEscape(); }
    });
    input.addEventListener('blur', () => { if (o.onBlur) o.onBlur(input.value); });
    return input;
  }

  function row(o) {
    const el = make('div', 'lex-check-row');
    const btn = make('button', 'lex-check-circle');
    btn.type = 'button';
    btn.addEventListener('click', () => { if (o.onCircle) o.onCircle(); });
    const textBox = make('div', 'lex-check-text');
    const span = make('span', 'lex-check-words');
    textBox.appendChild(span);
    textBox.addEventListener('click', (e) => { if (!input && o.onText) { e.stopPropagation(); o.onText(); } });
    el.append(btn, textBox);
    let input = null;
    let now = { text: '', done: false };

    function set(v) {
      if (v.done !== now.done || !btn.firstChild) {
        btn.replaceChildren(circle(!!v.done));
        btn.setAttribute('aria-label', v.done ? 'Back to the list' : 'Mark as done');
        el.classList.toggle('is-done', !!v.done);
      }
      if (!input) span.textContent = v.text;
      now = { text: v.text, done: !!v.done };
    }
    set({ text: o.text, done: o.done });

    return {
      el,
      set,
      get editing() { return !!input; },
      edit(e) {
        if (input) return input;
        input = field(Object.assign({ enterKey: e.enterKey || 'done' }, e));
        input.value = e.value != null ? e.value : now.text;
        span.hidden = true;
        textBox.appendChild(input);
        input.focus();
        const end = input.value.length;
        try { input.setSelectionRange(end, end); } catch (_) { /* a field without selection */ }
        return input;
      },
      endEdit() {
        if (!input) return;
        const was = input;
        input = null;
        was.remove();
        span.hidden = false;
        span.textContent = now.text;
      },
    };
  }

  function newRow(o) {
    const el = make('label', 'lex-check-new');
    const mark = make('span', 'lex-check-new-mark');
    mark.appendChild(circle(false, true));
    const input = field(Object.assign({ enterKey: 'next' }, o));
    input.setAttribute('aria-label', o.prompt || 'New item');
    el.append(mark, input);
    return { el, input, focus() { input.focus(); } };
  }

  global.LexChecklist = { circle, row, newRow };
})(typeof self !== 'undefined' ? self : globalThis);
