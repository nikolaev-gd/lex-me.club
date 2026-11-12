// web/lex-web-config.js — where the web build points.
//
// Same project and same publishable key the site already ships in
// assets/config.js. That is not a copy by accident: /app, /account and
// /checkout are one origin talking to one Supabase project, and a second set of
// values would be a second thing to rotate. Nothing secret lives here — the key
// is the publishable one, and every table it can reach is behind RLS keyed on
// auth.uid().
//
// LEX_WEB_VERSION is stamped by dev-tools/build-web.sh at build time; the value
// below is only what a file opened straight out of the repo reports.
(function (global) {
  'use strict';

  global.LEX_WEB_CONFIG = {
    // Lex's own address (since 2026-11-12): the gateway on the server platforma,
    // platforma/gateway/main.ts. The site's assets/config.js carries the same one.
    supabaseUrl: 'https://api.lex-me.club',
    supabaseKey: 'sb_publishable_uFosC6xBOAeS0k9-G56bpQ_gylyq8st',
  };

  global.LEX_WEB_VERSION = global.LEX_WEB_VERSION || 'dev';
})(typeof self !== 'undefined' ? self : globalThis);
