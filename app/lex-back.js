// lex-back.js — "back" in every section of Lex, on the page, the Mac app and the extension.
// One rule: back returns to the screen the person came from, at the same place. A section
// says where an item was opened from, and the arrow lives only here: a new section gets the
// rule by naming itself. Ordinary chats have no target, so no arrow. The iPhone has the
// same rule in one place of its own, `ChatStore.cameFrom`. docs/spec/20-chat.md, «Назад».
//
// The corner of the bar (ios/Lex/STANDARD.md В7.76, 23.11.2026): the three lines that open the
// panel stand at the left of EVERY screen, the arrow, when there is one, right of them. `corner`
// is the one place that makes the pair: it marks both buttons (`.lex-corner-lines`,
// `.lex-corner-back`, their look and the rule of the solo window — lex-section.css) and keeps
// the arrow right after the lines. The iPhone: `CornerButtons` (ios/Lex/Lex/Parts/CornerButtons.swift).
(function (global) {
  'use strict';

  // `button` gives the arrow; it may not exist yet, then there is nothing to paint.
  function createBack(button) {
    let target = null;

    function paint() {
      const arrow = button();
      if (!arrow) return;
      arrow.hidden = !target;
      if (!target) return;
      arrow.title = `Back to ${target.title}`;
      arrow.setAttribute('aria-label', arrow.title);
    }

    return {
      // An item of a section is open: { title, go }, go brings the section back.
      cameFrom(section) { target = section; paint(); },
      // The person stands in the section itself, or went somewhere else.
      clear() { target = null; paint(); },
      get target() { return target; },
      go() { return target ? target.go() : undefined; },
    };
  }

  // The corner of the bar: the lines first, the arrow right of them. Either may be missing.
  function corner(menu, back) {
    if (menu) menu.classList.add('lex-corner-lines');
    if (back) back.classList.add('lex-corner-back');
    if (menu && back && menu.nextElementSibling !== back && menu.parentNode) menu.after(back);
  }

  global.LexBack = { createBack, corner };
})(typeof window !== 'undefined' ? window : globalThis);
