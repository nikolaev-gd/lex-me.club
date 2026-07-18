/* lang.js — language by BROWSER LANGUAGE. Nothing else.
 *
 * Rule (Gennady):
 *   browser Russian            -> /ru/ , switcher offers RU + EN
 *   browser Romanian/Moldovan  -> /ro/ , switcher offers RO + EN
 *   anything else              -> /    , English, no switcher
 *
 * Never three options. Never a country lookup — a static host cannot see one,
 * and it was never asked for.
 *
 * Storage: `lexLangPick` is written ONLY when the visitor clicks the switcher.
 * Nothing else ever writes it. An earlier build auto-stored "en" on load, which
 * then looked like a manual choice and permanently suppressed the redirect;
 * the key is deliberately new so any value left by that build is ignored.
 */
(function () {
  'use strict';

  var KEY = 'lexLangPick';
  var PATH = { en: '/', ro: '/ro/', ru: '/ru/' };
  var LABEL = { en: 'EN', ro: 'RO', ru: 'RU' };
  var FULL = { en: 'English', ro: 'Română', ru: 'Русский' };

  function pick() {
    try {
      var v = localStorage.getItem(KEY);
      return PATH[v] ? v : null;
    } catch (_) { return null; }
  }

  function remember(lang) {
    try { localStorage.setItem(KEY, lang); } catch (_) { /* private mode */ }
  }

  /* The language the person set in their own browser. */
  function browserLang() {
    var list;
    try {
      list = (navigator.languages && navigator.languages.length)
        ? navigator.languages
        : [navigator.language || ''];
    } catch (_) { return 'en'; }

    for (var i = 0; i < list.length; i++) {
      var tag = String(list[i] || '').toLowerCase();
      if (tag === 'ru' || tag.indexOf('ru-') === 0) return 'ru';
      // "mo" is the retired tag for Moldovan; some systems still emit it.
      if (tag === 'ro' || tag.indexOf('ro-') === 0 || tag === 'mo' || tag.indexOf('mo-') === 0) return 'ro';
      if (tag === 'en' || tag.indexOf('en-') === 0) return 'en';
    }
    return 'en';
  }

  var current = (document.documentElement.getAttribute('lang') || 'en').slice(0, 2);
  if (!PATH[current]) current = 'en';

  /* ---- redirect ------------------------------------------------------- */
  /* Only from the English page, only when the visitor has never picked by
     hand. /ro/ and /ru/ are deliberate destinations and are left alone. */
  if (current === 'en' && !pick()) {
    var want = browserLang();
    if (want !== 'en') {
      location.replace(PATH[want]);
      return;
    }
  }

  /* ---- switcher -------------------------------------------------------- */
  /* Exactly two options, or none. On /ro/ and /ru/ the pair is already in the
     HTML. On the English page it depends on the visitor: someone whose browser
     is Russian or Romanian — or who switched to English by hand — gets a way
     back; an English-speaking visitor sees no switcher at all. */
  function buildEnglishSwitcher() {
    var host = document.querySelector('[data-lang-slot]');
    if (!host) return;

    var other = pick() && pick() !== 'en' ? pick() : browserLang();
    if (other === 'en' || !PATH[other]) return; // nothing to offer

    var nav = document.createElement('nav');
    nav.className = 'lang-switch';
    nav.setAttribute('aria-label', 'Language');

    [ 'en', other ].forEach(function (lang) {
      var a = document.createElement('a');
      a.className = 'lang-opt' + (lang === 'en' ? ' is-active' : '');
      a.href = PATH[lang];
      a.textContent = LABEL[lang];
      a.setAttribute('hreflang', lang);
      a.setAttribute('title', FULL[lang]);
      if (lang === 'en') a.setAttribute('aria-current', 'true');
      a.addEventListener('click', function () { remember(lang); });
      nav.appendChild(a);
    });

    host.appendChild(nav);
  }

  function wire() {
    /* Remember an explicit click on the pre-rendered switchers (/ro/, /ru/). */
    var opts = document.querySelectorAll('.lang-opt[hreflang]');
    for (var i = 0; i < opts.length; i++) {
      (function (el) {
        el.addEventListener('click', function () {
          remember(el.getAttribute('hreflang'));
        });
      })(opts[i]);
    }
    if (current === 'en') buildEnglishSwitcher();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();
