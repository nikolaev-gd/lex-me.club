// webchat/wc-ui.js — the small pieces every other file needs: DOM building,
// the toast, the confirm/prompt modal and the popup menu.
//
// They live together because they are the ones that would otherwise be written
// three times — once in the sidebar, once in the settings sheet, once in the
// composer — and drift apart in exactly the details that matter (which key
// closes the thing, whether focus comes back).
//
// EVERYTHING BUILDS NODES, NOTHING BUILDS HTML STRINGS. A conversation title
// and an assistant's answer are both attacker-adjacent text — the first is
// typed by the user, the second comes off the network — and el()/text keep
// them out of the parser entirely.
(function (global) {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';

  // el('div.wc-conv', {title: 'x'}, [child, 'text'])
  function el(spec, props, kids) {
    const m = /^([a-z0-9-]+)?((?:[.#][^.#]+)*)$/i.exec(spec) || [];
    const node = document.createElement(m[1] || 'div');
    (m[2] || '').split(/(?=[.#])/).forEach((tok) => {
      if (tok[0] === '.') node.classList.add(tok.slice(1));
      else if (tok[0] === '#') node.id = tok.slice(1);
    });
    if (props) {
      Object.keys(props).forEach((k) => {
        const v = props[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'text') node.textContent = v;
        else if (k === 'html') throw new Error('wc-ui el(): html is not a property. Build nodes.');
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else node.setAttribute(k, v === true ? '' : v);
      });
    }
    (kids || []).forEach((c) => {
      if (c === null || c === undefined || c === false) return;
      node.append(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  // Icons are inline SVG path data so the page stays one HTTP request and works
  // from a file:// URL inside a native shell.
  const ICONS = {
    pencil: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
    trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6',
    dots: 'M12 5h.01M12 12h.01M12 19h.01',
    copy: 'M9 9h10v10H9zM5 15V5h10',
    retry: 'M3 12a9 9 0 1 0 3-6.7M3 4v5h5',
    check: 'M4 12l5 5L20 6',
    x: 'M6 6l12 12M18 6L6 18',
    logout: 'M15 17l5-5-5-5M20 12H9M12 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h6',
    plus: 'M12 5v14M5 12h14',
    wallet: 'M3 7h15a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 7l1-3h12M17 13h.01',
  };

  function icon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', ICONS[name] || ICONS.dots);
    svg.append(p);
    return svg;
  }

  function iconBtn(name, title, onclick, extraClass) {
    const b = el('button.wc-icon-btn' + (extraClass ? '.' + extraClass : ''), {
      type: 'button', title, 'aria-label': title, onclick,
    }, [icon(name)]);
    return b;
  }

  // ── Toast ────────────────────────────────────────────────────────────────
  let toastTimer = null;
  function toast(message, opts) {
    const node = document.getElementById('wc-toast');
    node.textContent = message;
    node.classList.toggle('is-error', !!(opts && opts.error));
    node.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; toastTimer = null; },
      (opts && opts.ms) || (opts && opts.error ? 5200 : 2600));
  }

  // ── Modal: confirm and prompt ────────────────────────────────────────────
  // One implementation for both, because the parts that are easy to get wrong
  // are the same in each: Escape closes, Enter accepts, the overlay click
  // cancels, and focus returns to whatever opened it. Resolves to the string
  // (prompt), true (confirm) or null (cancelled).
  function modal(opts) {
    const host = document.getElementById('wc-modal');
    const returnFocus = document.activeElement;

    return new Promise((resolve) => {
      let done = false;
      function close(value) {
        if (done) return;
        done = true;
        document.removeEventListener('keydown', onKey, true);
        host.hidden = true;
        host.replaceChildren();
        try { if (returnFocus && returnFocus.focus) returnFocus.focus(); } catch (_) {}
        resolve(value);
      }

      const input = opts.prompt
        ? el('input', { type: 'text', value: opts.value || '', maxlength: opts.maxlength || 200 })
        : null;

      const okBtn = el('button.wc-btn' + (opts.danger ? '' : '.wc-btn-primary'), {
        type: 'button',
        text: opts.okText || 'Ок',
        style: opts.danger ? { borderColor: 'var(--danger)', color: 'var(--danger)' } : null,
        onclick: () => close(input ? input.value.trim() : true),
      });

      const card = el('.wc-modal-card', { role: 'document' }, [
        el('h3', { text: opts.title || '' }),
        opts.body ? el('p', { text: opts.body }) : null,
        input,
        el('.wc-modal-actions', {}, [
          el('button.wc-btn.wc-btn-ghost', {
            type: 'button', text: opts.cancelText || 'Отмена', onclick: () => close(null),
          }),
          okBtn,
        ]),
      ]);

      function onKey(e) {
        if (e.key === 'Escape') { e.stopPropagation(); close(null); }
        else if (e.key === 'Enter' && (input || !opts.prompt)) {
          if (e.target && e.target.tagName === 'BUTTON') return;
          e.preventDefault(); e.stopPropagation();
          close(input ? input.value.trim() : true);
        }
      }

      host.replaceChildren(card);
      host.hidden = false;
      // Click on the backdrop only — a click that started inside the card and
      // ended outside (a drag-select of the input) must not cancel.
      host.onpointerdown = (e) => { if (e.target === host) close(null); };
      document.addEventListener('keydown', onKey, true);

      if (input) { input.focus(); input.select(); } else okBtn.focus();
    });
  }

  const confirm = (title, body, opts) => modal(Object.assign({ title, body }, opts));
  const prompt = (title, value, opts) => modal(Object.assign({ title, value, prompt: true }, opts));

  // ── Popup menu ───────────────────────────────────────────────────────────
  // Anchored to an element's box. Items: {label, icon, danger, onSelect} or
  // {separator: true} or {head: 'text'}.
  let menuCleanup = null;
  function closeMenu() {
    const host = document.getElementById('wc-menu');
    host.hidden = true;
    host.replaceChildren();
    if (menuCleanup) { menuCleanup(); menuCleanup = null; }
  }

  function menu(anchor, items) {
    closeMenu();
    const host = document.getElementById('wc-menu');

    host.replaceChildren(...items.filter(Boolean).map((it) => {
      if (it.separator) return el('.wc-menu-sep');
      if (it.head) return el('.wc-menu-head', { text: it.head });
      return el('button.wc-menu-item' + (it.danger ? '.is-danger' : ''), {
        type: 'button', role: 'menuitem',
        onclick: () => { closeMenu(); it.onSelect(); },
      }, [it.icon ? icon(it.icon) : null, el('span', { text: it.label })]);
    }));

    host.hidden = false;

    // Place it after it is measurable, and flip it when it would fall off.
    const r = anchor.getBoundingClientRect();
    const m = host.getBoundingClientRect();
    const pad = 8;
    let left = Math.min(r.left, window.innerWidth - m.width - pad);
    let top = r.bottom + 4;
    if (top + m.height > window.innerHeight - pad) top = Math.max(pad, r.top - m.height - 4);
    host.style.left = Math.max(pad, left) + 'px';
    host.style.top = top + 'px';

    const onDown = (e) => { if (!host.contains(e.target)) closeMenu(); };
    const onKey = (e) => { if (e.key === 'Escape') closeMenu(); };
    // Deferred: the very pointerdown that opened the menu would otherwise
    // close it again on the way back up the document.
    setTimeout(() => {
      document.addEventListener('pointerdown', onDown, true);
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('resize', closeMenu);
      window.addEventListener('scroll', closeMenu, true);
    }, 0);
    menuCleanup = () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', closeMenu);
      window.removeEventListener('scroll', closeMenu, true);
    };
    const first = host.querySelector('.wc-menu-item');
    if (first) first.focus();
  }

  // ── Sheet (settings and friends) ─────────────────────────────────────────
  function sheet(hostId, title, bodyNodes, onClose) {
    const host = document.getElementById(hostId);
    const returnFocus = document.activeElement;
    function close() {
      host.hidden = true;
      host.replaceChildren();
      document.removeEventListener('keydown', onKey, true);
      try { if (returnFocus && returnFocus.focus) returnFocus.focus(); } catch (_) {}
      if (onClose) onClose();
    }
    function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }

    const body = el('.wc-sheet-body', {}, bodyNodes);
    host.replaceChildren(el('.wc-sheet-card', {}, [
      el('.wc-sheet-head', {}, [el('h2', { text: title }), iconBtn('x', 'Закрыть', close)]),
      body,
    ]));
    host.hidden = false;
    host.onpointerdown = (e) => { if (e.target === host) close(); };
    document.addEventListener('keydown', onKey, true);
    return { close, body };
  }

  // What a conversation is called on screen, in ONE place.
  //
  // It was in two: the sidebar fell back to the first message, and the header
  // fell back to «Новый чат». So opening an existing but unnamed conversation
  // put «Новый чат» in the header over a thread with ten turns in it, and the
  // browser tab said just «Lex». The reader was looking at a real conversation
  // that the interface was calling a new one.
  //
  // `untitled` is deliberately reported separately: the fallback is a display
  // convenience, NOT a name. Renaming an unnamed conversation must open an
  // EMPTY field, not one pre-filled with a sentence the person never chose.
  function conversationTitle(item) {
    const t = ((item && item.title) || '').trim();
    if (t) return { text: t, untitled: false };
    const p = ((item && item.preview) || '').trim().replace(/\s+/g, ' ');
    return { text: p ? p.slice(0, 60) : 'Без названия', untitled: true };
  }

  function fmtMoney(usd) {
    if (usd === null || usd === undefined || !Number.isFinite(Number(usd))) return '—';
    const n = Number(usd);
    // Under a cent still has to read as money, not as zero: a balance of
    // $0.004 shown as "$0.00" looks like an empty account that still answers.
    return '$' + (Math.abs(n) < 0.01 && n !== 0 ? n.toFixed(4) : n.toFixed(2));
  }

  global.WcUI = {
    el, icon, iconBtn, toast, modal, confirm, prompt, menu, closeMenu, sheet, fmtMoney,
    conversationTitle,
  };
})(typeof self !== 'undefined' ? self : globalThis);
