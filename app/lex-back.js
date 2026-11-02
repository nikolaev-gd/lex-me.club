// lex-back.js — "back" in every section of Lex, on the page, the Mac app and the extension.
// One rule: back returns to the screen the person came from, at the same place. A section
// says where an item was opened from, and the arrow lives only here: a new section gets the
// rule by naming itself. Ordinary chats have no target, so no arrow. The iPhone has the
// same rule in one place of its own, `ChatStore.cameFrom`. docs/spec/20-chat.md, «Назад».
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

  global.LexBack = { createBack };
})(typeof window !== 'undefined' ? window : globalThis);
