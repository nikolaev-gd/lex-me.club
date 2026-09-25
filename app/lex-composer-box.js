// lex-composer-box.js — the composer's text, the same on every surface: the
// hint in the empty field. The composer's sizes live next door in
// lex-composer-box.css; the two files are one module.
//
// Loaded by the extension (both content_scripts in manifest.json and
// LexSurfaceDeps.scripts — the side panel and the small window) and by the web
// page (webchat/index.html; the Mac app shows that page). The iPhone app gets
// the English text at build time: dev-tools/ios-composer-box.mjs runs this
// file and writes it into the app bundle, so no surface keeps its own copy.
//
// The model is the Mac app (owner's decision 2026-09-25): «Message…». The web
// page and the iPhone are English only; the extension also has a Russian UI,
// and for it the same hint is written here in Russian.
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

  root.LexComposerBox = Object.freeze({ PLACEHOLDER, placeholder });
})(typeof self !== 'undefined' ? self : globalThis);
