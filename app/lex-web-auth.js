// web/lex-web-auth.js — the session for the web teacher.
//
// ONE KEY, THREE PAGES. The session lives in localStorage under 'lexSession',
// which is the key lex-me.club/account and /checkout already read and write
// (their assets/auth.js). /app is the same origin, so signing in here signs you
// in there and vice versa — one login for the site and the teacher, with no
// hand-off code to write.
//
// That shared key is also a contract: the shape below is the site's shape,
// field for field, including the 60-second safety margin baked into
// expires_at. The extension stores a DIFFERENT shape under a different key
// (chrome.storage.local 'lexAuthSession', with `user` trimmed to id + email) —
// the two never meet, and nothing should try to copy one into the other.
//
// ⚠️ THE EXTENSION DOES NOT HAND ITS SESSION OVER ANY MORE. There used to be
// openCheckoutWithSession, which injected the extension's tokens into this very
// key before opening the checkout page; it was deleted on 2026-08-12 together
// with the extension's host permission for lex-me.club, because a long-lived
// refresh_token sitting in the localStorage of an ordinary page is readable by
// anything that gets a script onto it. The web teacher signs in on its own.
//
// REFRESH POLICY IS THE EXTENSION'S, NOT THE SITE'S. The site drops the
// session whenever a refresh fails; the extension keeps it when the failure
// looks transient (5xx, 429, a dead network) and only clears on a real auth
// rejection. Copied here deliberately: this page is meant to stay open through
// a laptop suspend, and a signed-out chat that lost its conversation because
// the wifi blinked is a much worse failure than one stale token.
(function (global) {
  'use strict';

  const CFG = global.LEX_WEB_CONFIG;
  if (!CFG || !CFG.supabaseUrl || !CFG.supabaseKey) {
    throw new Error('lex-web-auth.js: LEX_WEB_CONFIG with supabaseUrl + supabaseKey must be loaded first.');
  }

  const STORE = 'lexSession';
  const URL_BASE = CFG.supabaseUrl.replace(/\/+$/, '');
  const KEY = CFG.supabaseKey;

  // Same regex the extension uses. A refresh that fails for one of these
  // reasons leaves the stored session alone and simply reports "no token now".
  const TRANSIENT = /HTTP\s*5\d\d|HTTP\s*429|Failed to fetch|NetworkError|network|timeout|ECONN|ETIMEDOUT|load failed/i;

  function read() {
    try { return JSON.parse(localStorage.getItem(STORE) || 'null'); } catch (_) { return null; }
  }
  function write(s) {
    try {
      if (s) localStorage.setItem(STORE, JSON.stringify(s));
      else localStorage.removeItem(STORE);
    } catch (_) { /* private mode — the page still works for this visit */ }
  }

  // The site's shape, field for field. `user` is the FULL GoTrue user object,
  // not a trimmed one: /account reads user.email off it and would break on a
  // narrower copy.
  function fromToken(json) {
    return {
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      // 60s of margin, exactly as the site computes it — so both pages agree on
      // when the token is "about to expire" and neither hands the other a token
      // the server is about to refuse.
      expires_at: Date.now() + (((json.expires_in || 3600) - 60) * 1000),
      user: json.user || null,
    };
  }

  async function gotrue(path, body, bearer) {
    const resp = await fetch(URL_BASE + '/auth/v1' + path, {
      method: 'POST',
      headers: {
        apikey: KEY,
        'Content-Type': 'application/json',
        ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(json.msg || json.error_description || json.error_code
        || json.error || json.message || ('HTTP ' + resp.status));
    }
    return json;
  }

  async function signIn(email, password) {
    const json = await gotrue('/token?grant_type=password', { email, password });
    const s = fromToken(json);
    write(s);
    return s;
  }

  // Registration goes through our own edge function, not GoTrue /signup: it
  // sets email_confirm inside, so there is no confirmation mail and no pending
  // state. Same endpoint and same two error strings the extension surfaces.
  async function signUp(email, password) {
    const resp = await fetch(URL_BASE + '/functions/v1/signup', {
      method: 'POST',
      headers: { apikey: KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const json = await resp.json().catch(() => ({}));
    if (resp.status === 409 || json.error === 'EMAIL_TAKEN') throw new Error('EMAIL_TAKEN');
    if (resp.status === 429) throw new Error('RATE_LIMITED');
    if (!resp.ok) throw new Error(json.error || ('HTTP ' + resp.status));
    return signIn(email, password);
  }

  // Google goes by ordinary redirect. The extension needs
  // chrome.identity.launchWebAuthFlow and a chromiumapp.org redirect URL
  // because it has no page of its own to come back to; a web page does, so
  // this is just a navigation. The return URL has to be in the project's
  // redirect allow-list (Supabase Auth → URL Configuration) — see docs.
  function signInWithGoogle() {
    const back = global.location.origin + global.location.pathname;
    global.location.href = URL_BASE + '/auth/v1/authorize?provider=google&redirect_to='
      + encodeURIComponent(back);
  }

  // Supabase returns the tokens in the URL FRAGMENT on this flow. Consume them
  // and strip the fragment immediately: an access token in a visible address
  // bar ends up in screenshots, shoulder-surfing and pasted bug reports.
  function adoptRedirectSession() {
    const hash = (global.location.hash || '').replace(/^#/, '');
    if (!hash) return null;
    const p = new URLSearchParams(hash);
    const access = p.get('access_token');
    if (!access) return null;
    const expAtSec = parseInt(p.get('expires_at') || '', 10);
    const s = {
      access_token: access,
      refresh_token: p.get('refresh_token') || null,
      expires_at: Number.isFinite(expAtSec)
        ? (expAtSec * 1000) - 60000
        : Date.now() + (((parseInt(p.get('expires_in') || '', 10) || 3600) - 60) * 1000),
      user: null,
    };
    write(s);
    try { history.replaceState(null, '', global.location.pathname + global.location.search); } catch (_) {}
    return s;
  }

  // The fragment carries no user object, so fetch it once. Failure is not
  // fatal — the token is valid either way; the account row just renders
  // without an address until the next load.
  async function fillUser() {
    const s = read();
    if (!s || !s.access_token || s.user) return s;
    try {
      const resp = await fetch(URL_BASE + '/auth/v1/user', {
        headers: { apikey: KEY, Authorization: 'Bearer ' + s.access_token },
      });
      if (resp.ok) { s.user = await resp.json(); write(s); }
    } catch (_) { /* leave it */ }
    return s;
  }

  async function refresh() {
    const s = read();
    if (!s || !s.refresh_token) return null;
    try {
      const json = await gotrue('/token?grant_type=refresh_token', { refresh_token: s.refresh_token });
      const next = fromToken(json);
      write(next);
      return next;
    } catch (err) {
      const msg = String((err && err.message) || err);
      if (TRANSIENT.test(msg)) return null;   // keep the session, report "no token now"
      write(null);
      return null;
    }
  }

  // The single place a working token comes from. Everything that talks to
  // Supabase goes through here, so the refresh threshold lives in one spot.
  async function validToken() {
    const s = read();
    if (!s || !s.access_token) return null;
    if (s.expires_at && (s.expires_at - Date.now()) > 0) return s.access_token;
    const next = await refresh();
    return next ? next.access_token : null;
  }

  async function signOut() {
    const s = read();
    // scope=local, exactly as the extension does it: the default is global and
    // would sign the user out of every device they own, which is not what
    // "выйти" on one page means.
    if (s && s.access_token) {
      try { await gotrue('/logout?scope=local', null, s.access_token); } catch (_) {}
    }
    write(null);
  }

  global.LexWebAuth = {
    session: read,
    signIn,
    signUp,
    signInWithGoogle,
    adoptRedirectSession,
    fillUser,
    validToken,
    signOut,
    supabaseUrl: () => URL_BASE,
    anonKey: () => KEY,
  };
})(typeof self !== 'undefined' ? self : globalThis);
