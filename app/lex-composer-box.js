// lex-composer-box.js — the composer's text and its layout rule, the same on
// every surface: the hint in the empty field, and which of the two layouts the
// box takes for what is typed in it. The composer's sizes and the two layouts
// themselves live next door in lex-composer-box.css; the two files are one
// module.
//
// Loaded by the extension (both content_scripts in manifest.json and
// LexSurfaceDeps.scripts — the side panel and the small window) and by the web
// page (webchat/index.html; the Mac app shows that page). The iPhone app gets
// the English text at build time: dev-tools/ios-composer-box.mjs runs this
// file and writes it into the app bundle, so no surface keeps its own copy;
// the layout rule is written again in Swift (ChatScreen.swift, ComposerLayout),
// because SwiftUI lays the box out itself.
//
// The hint follows the Mac app (owner's decision 2026-09-25): «Message…». The
// web page and the iPhone are English only; the extension also has a Russian
// UI, and for it the same hint is written here in Russian.
//
// The layout follows Gemini's composer (owner's decision 2026-11-13): one line
// — a pill with «+», the text and the microphone inside — while the field is
// empty and while what is typed fits on that line; text above a row of buttons
// once it does not. See fit() below.
(function (root) {
  'use strict';

  const PLACEHOLDER = Object.freeze({
    en: 'Message…',
    ru: 'Сообщение…',
  });

  // The hint for a UI language ('en' | 'ru'); anything else gets English.
  function placeholder(lang) {
    return PLACEHOLDER[lang] || PLACEHOLDER.en;
  }

  const BOX = '.ytvocab-chat-input-wrapper, .wc-composer';
  const PRESETS = '.ytvocab-chat-modesplit, .wc-mode-split';
  const MULTI = 'is-multiline';

  function num(style, name, fallback) {
    const v = parseFloat(style.getPropertyValue(name));
    return Number.isFinite(v) ? v : fallback;
  }

  // Are action presets part of this chat? The row is in the box and has pills,
  // and the window has not switched it off (an order chat of Profi.ru and the
  // feeds of Extended Mind hide it with display:none). In the one-line layout
  // the row is only tucked away (lex-composer-box.css), never display:none, so
  // this answer does not depend on the layout it decides.
  function presetsOn(box) {
    const row = box.querySelector(PRESETS);
    if (!row || !row.children.length) return false;
    return getComputedStyle(row).display !== 'none';
  }

  // The extension's windows: the feed is the flex sibling the composer takes
  // its height from, so the field may grow by as much as the feed still has.
  // The feed ends under the window's header, which is what "no taller than the
  // room above the keyboard less the header" means there.
  function defaultRoom(field) {
    const main = field.closest('.ytvocab-popup-main');
    const feed = main && main.querySelector(':scope > .ytvocab-chat-history');
    if (!feed) return Infinity;
    return field.offsetHeight + feed.clientHeight;
  }

  // Lay the box out for what is in the field and size the field. Called on
  // every change of the field, of what can be sent and of the window's size.
  //
  //   field        the textarea;
  //   opts.canSend there is something to send (text, a picture, chosen words) —
  //                with action presets in the chat that alone opens the row of
  //                buttons, because the presets live there; default: text;
  //   opts.room    () => px the field may take at most (the room above the
  //                keyboard less the header and the box's own chrome);
  //                default: the extension's feed, see defaultRoom.
  //
  // Which layout fits is decided by laying the text out on one line and
  // measuring: everything happens in one task, before the browser paints, so
  // the box never shows a wrong layout for a frame.
  function fit(field, opts) {
    if (!field) return;
    const box = field.closest(BOX);
    if (!box) return;
    const o = opts || {};
    const text = field.value || '';
    const fs = getComputedStyle(field);
    const line = parseFloat(fs.lineHeight) || 22;
    const pad = (parseFloat(fs.paddingTop) || 0) + (parseFloat(fs.paddingBottom) || 0);
    const canSend = (typeof o.canSend === 'boolean') ? o.canSend : text.trim().length > 0;

    let multi;
    if (canSend && presetsOn(box)) multi = true;
    else if (!text) multi = false;
    else if (text.indexOf('\n') !== -1) multi = true;
    else {
      box.classList.remove(MULTI);
      field.style.height = 'auto';
      multi = field.scrollHeight - pad > line * 1.5;
    }
    box.classList.toggle(MULTI, multi);

    const maxLines = num(getComputedStyle(box), '--lex-composer-max-lines', 15);
    let cap = line * maxLines + pad;
    const room = (typeof o.room === 'function') ? o.room() : defaultRoom(field);
    if (Number.isFinite(room)) cap = Math.min(cap, Math.max(line + pad, room));

    field.style.height = 'auto';
    const natural = field.scrollHeight;
    if (!natural) { field.style.height = ''; return; }   // not laid out yet (hidden window)
    field.style.height = Math.min(natural, cap) + 'px';
    field.style.overflowY = natural > cap + 1 ? 'auto' : 'hidden';
  }

  root.LexComposerBox = Object.freeze({ PLACEHOLDER, placeholder, fit });
})(typeof self !== 'undefined' ? self : globalThis);
