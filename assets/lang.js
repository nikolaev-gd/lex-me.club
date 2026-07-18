/* lang.js — send the visitor to their language, by BROWSER LANGUAGE.
 *
 * Rule (Gennady, 2026-07-18):
 *   browser language Russian   -> /ru/
 *   browser language Romanian  -> /ro/
 *   anything else              -> / (English)
 *
 * navigator.languages is the language the person set in their own browser or
 * system. No country lookup, no external service, no IP involved.
 *
 * Runs only on the English root, only when the visitor has not already picked
 * a language by hand. A manual choice always wins and is remembered.
 */
(function () {
  'use strict';

  var KEY = 'lexLang';
  var PATH = { en: '/', ro: '/ro/', ru: '/ru/' };

  function stored() {
    try {
      var v = localStorage.getItem(KEY);
      return PATH[v] ? v : null;
    } catch (_) { return null; }
  }

  function remember(lang) {
    try { localStorage.setItem(KEY, lang); } catch (_) { /* private mode */ }
  }

  function fromBrowser() {
    var list;
    try {
      list = (navigator.languages && navigator.languages.length)
        ? navigator.languages
        : [navigator.language || ''];
    } catch (_) { return 'en'; }

    for (var i = 0; i < list.length; i++) {
      var tag = String(list[i] || '').toLowerCase();
      if (tag === 'ru' || tag.indexOf('ru-') === 0) return 'ru';
      // "mo" is the retired tag for Moldovan, still emitted by some systems.
      if (tag === 'ro' || tag.indexOf('ro-') === 0 || tag === 'mo' || tag.indexOf('mo-') === 0) return 'ro';
      if (tag === 'en' || tag.indexOf('en-') === 0) return 'en';
    }
    return 'en';
  }

  // Remember whichever language the visitor clicks in the switcher.
  function wireSwitcher() {
    var opts = document.querySelectorAll('.lang-opt[hreflang]');
    for (var i = 0; i < opts.length; i++) {
      (function (el) {
        el.addEventListener('click', function () {
          remember(el.getAttribute('hreflang'));
        });
      })(opts[i]);
    }
  }

  var current = (document.documentElement.getAttribute('lang') || 'en').slice(0, 2);
  var atRoot = location.pathname === '/' || /\/index\.html$/.test(location.pathname);

  if (current === 'en' && atRoot && !stored()) {
    var want = fromBrowser();
    if (want !== 'en') {
      remember(want);
      location.replace(PATH[want]);
      return;
    }
    remember('en');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireSwitcher);
  } else {
    wireSwitcher();
  }
})();
