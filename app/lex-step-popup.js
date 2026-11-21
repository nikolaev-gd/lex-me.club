// lex-step-popup.js — the window of the price of a step (В7.55 of ios/Lex/STANDARD.md): one part
// for the page lex-me.club/app (the Mac app shows the same page) and every window of the
// extension. The iPhone draws the same words as a sheet (ios/Lex/Lex/Parts/StepCostSheet.swift).
//
// What it shows comes ready from LexChatMoney.stepView (lex-chat-money.js): on top the price of
// the step, the model with its effort and the way of paying; under it the tokens read and
// written and the requests to the model; then the parts of the step, a row each with tokens
// and dollars, the parts of the tools under one small heading; at the bottom the whole chat by
// the API prices and the week of the subscription. Nothing is counted here.
//
//   LexStepPopup.build(view, { dark }) → Node — the card alone (dark: the extension's windows,
//     which have no light theme; the page takes the tokens of its theme);
//   LexStepPopup.attach(anchor, getView, { dark }) — the card opens when the mouse comes onto
//     the anchor (the number on top, the price under a step) and closes a moment after it
//     leaves the anchor and the card; getView() is asked at every opening, so the card is
//     always of the newest money. A finger does not open it: a tap on the number on top
//     shows and hides the prices, as before;
//   LexStepPopup.refresh(anchor) — the card is open on this anchor: draw it anew (the live
//     number of a step that goes).
//
// Its look — .lex-step-popup* in lex-message.css: that sheet is loaded by every place.
// No chrome.*: the extension and the page load the same file.
(function (root) {
  'use strict';

  const HIDE_DELAY_MS = 180;
  const GAP = 6;
  const EDGE = 8;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null && text !== '') n.textContent = text;
    return n;
  }

  function rowNode(r) {
    const row = el('div', 'lex-step-popup-row');
    const label = el('div', 'lex-step-popup-label');
    label.appendChild(el('span', 'lex-step-popup-name', r.label));
    if (r.note) label.appendChild(el('span', 'lex-step-popup-note', r.note));
    row.appendChild(label);
    row.appendChild(el('span', 'lex-step-popup-tokens', r.tokens || ''));
    row.appendChild(el('span', 'lex-step-popup-usd', r.usd));
    if (r.key) row.dataset.part = r.key;
    return row;
  }

  function build(view, opts) {
    const v = view || {};
    const o = opts || {};
    const card = el('div', 'lex-step-popup' + (o.dark ? ' is-dark' : '') + (v.live ? ' is-live' : ''));
    card.setAttribute('role', 'tooltip');

    const head = el('div', 'lex-step-popup-head');
    const top = el('div', 'lex-step-popup-top');
    top.appendChild(el('span', 'lex-step-popup-price', v.price || '$?'));
    if (v.live && v.note) top.appendChild(el('span', 'lex-step-popup-live', v.note));
    head.appendChild(top);
    if (v.model) head.appendChild(el('div', 'lex-step-popup-model', v.model));
    if (v.pay) head.appendChild(el('div', 'lex-step-popup-pay', v.pay));
    if (v.stats) head.appendChild(el('div', 'lex-step-popup-stats', v.stats));
    // The time of the answer (the extension's windows: the shared timing chip of «Как замеряется время ответа»),
    // which the old tip of the price carried: a node the window builds, put under the numbers as it is.
    if (typeof v.timing === 'function') {
      let t = null;
      try { t = v.timing(); } catch (_) { t = null; }
      if (t && t.nodeType === 1) { const row = el('div', 'lex-step-popup-stats'); row.appendChild(t); head.appendChild(row); }
    }
    card.appendChild(head);

    const items = Array.isArray(v.items) ? v.items : [];
    if (items.length) {
      const parts = el('div', 'lex-step-popup-parts');
      for (const it of items) {
        if (it.kind === 'group') {
          parts.appendChild(el('div', 'lex-step-popup-group', it.title));
          for (const r of it.rows) {
            const n = rowNode(r);
            n.classList.add('is-tool');
            parts.appendChild(n);
          }
        } else if (it.row) {
          parts.appendChild(rowNode(it.row));
        }
      }
      card.appendChild(parts);
    } else if (v.note && !v.live) {
      card.appendChild(el('div', 'lex-step-popup-empty', v.note));
    }

    if (v.chat || v.week) {
      const foot = el('div', 'lex-step-popup-foot');
      if (v.chat) foot.appendChild(el('div', 'lex-step-popup-chat', v.chat));
      if (v.week) foot.appendChild(el('div', 'lex-step-popup-week', v.week));
      card.appendChild(foot);
    }
    return card;
  }

  // ── The one open card of a document ───────────────────────────────────────
  let host = null;
  let anchorEl = null;
  let hideTimer = null;

  function hostNode() {
    if (host && host.isConnected) return host;
    host = el('div', 'lex-step-popup-host');
    host.addEventListener('pointerenter', () => { clearTimeout(hideTimer); hideTimer = null; });
    host.addEventListener('pointerleave', () => scheduleHide());
    (document.body || document.documentElement).appendChild(host);
    return host;
  }

  function place() {
    if (!host || !anchorEl) return;
    const card = host.firstElementChild;
    if (!card) return;
    const a = anchorEl.getBoundingClientRect();
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = document.documentElement.clientHeight || window.innerHeight;
    card.style.maxHeight = '';
    const w = card.offsetWidth;
    let h = card.offsetHeight;
    // Under the anchor when it fits, over it when it does not; fits neither — on the side with
    // more room, and the card scrolls inside: it never covers the number it was opened on. The
    // right edges together when the card would run out on the right (the number on top stands at
    // the right of the window).
    const below = vh - EDGE - (a.bottom + GAP);
    const above = a.top - GAP - EDGE;
    let under = true;
    if (h > below) {
      if (h <= above) under = false;
      else {
        under = below >= above;
        h = Math.max(80, Math.floor(under ? below : above));
        card.style.maxHeight = h + 'px';
      }
    }
    let top = under ? a.bottom + GAP : a.top - GAP - h;
    top = Math.max(EDGE, Math.min(top, vh - EDGE - h));
    let left = a.left;
    if (left + w > vw - EDGE) left = a.right - w;
    left = Math.max(EDGE, Math.min(left, vw - EDGE - w));
    host.style.left = Math.round(left) + 'px';
    host.style.top = Math.round(top) + 'px';
  }

  function show(anchor) {
    const spec = anchor && anchor._lexStepPopup;
    if (!spec) return;
    const view = spec.getView();
    if (!view) { hide(); return; }
    clearTimeout(hideTimer); hideTimer = null;
    const h = hostNode();
    h.replaceChildren(build(view, spec.opts));
    h.hidden = false;
    anchorEl = anchor;
    place();
  }

  function hide() {
    clearTimeout(hideTimer); hideTimer = null;
    anchorEl = null;
    if (host) { host.hidden = true; host.replaceChildren(); }
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, HIDE_DELAY_MS);
  }

  function attach(anchor, getView, opts) {
    if (!anchor || typeof getView !== 'function') return;
    const had = !!anchor._lexStepPopup;
    anchor._lexStepPopup = { getView, opts: opts || {} };
    if (had) { if (anchorEl === anchor) show(anchor); return; }
    anchor.addEventListener('pointerenter', (e) => {
      if (e.pointerType && e.pointerType !== 'mouse') return;
      show(anchor);
    });
    anchor.addEventListener('pointerleave', (e) => {
      if (e.pointerType && e.pointerType !== 'mouse') return;
      if (anchorEl === anchor) scheduleHide();
    });
  }

  function detach(anchor) {
    if (!anchor) return;
    if (anchorEl === anchor) hide();
    if (anchor._lexStepPopup) anchor._lexStepPopup = { getView: () => null, opts: {} };
  }

  function refresh(anchor) {
    if (anchorEl && (!anchor || anchor === anchorEl)) {
      if (!anchorEl.isConnected) { hide(); return; }
      show(anchorEl);
    }
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && anchorEl) hide(); }, true);
    document.addEventListener('scroll', (e) => {
      if (!anchorEl) return;
      // The card's own scroll (a long step on a low window) does not move it.
      if (host && e.target && host.contains(e.target)) return;
      if (!anchorEl.isConnected) { hide(); return; }
      place();
    }, true);
    window.addEventListener('resize', () => { if (anchorEl) hide(); });
  }

  root.LexStepPopup = { build, attach, detach, refresh, hide, isOpenOn: (a) => !!a && a === anchorEl };
})(typeof window !== 'undefined' ? window : globalThis);
