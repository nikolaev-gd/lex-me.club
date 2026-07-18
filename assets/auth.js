/* auth.js — sign in with the same Lex account as the extension, and show the
 * balance.
 *
 * Talks to Supabase over plain fetch. No SDK: the site ships as static files
 * with no build step, and the three calls we need are three fetches.
 *
 * The key below is the PUBLISHABLE key. It is meant to be in client code — it
 * grants nothing by itself. Every read is authorised by the signed-in user's
 * own JWT against row-level security: account_billing and balance_ledger each
 * carry a SELECT policy of auth.uid() = account_id, so a session can only ever
 * see its own rows. Read it from window.LEX_CONFIG so a key rotation is a
 * one-line edit in config.js and never a hunt through the code.
 */
(function () {
  'use strict';

  var CFG = window.LEX_CONFIG || {};
  var URL_BASE = CFG.supabaseUrl;
  var KEY = CFG.supabaseKey;
  var STORE = 'lexSession';

  var el = function (id) { return document.getElementById(id); };

  // ---- session ----------------------------------------------------------
  function load() {
    try { return JSON.parse(localStorage.getItem(STORE) || 'null'); } catch (_) { return null; }
  }
  function save(s) {
    try { localStorage.setItem(STORE, JSON.stringify(s)); } catch (_) { /* private mode */ }
  }
  function clear() {
    try { localStorage.removeItem(STORE); } catch (_) { /* noop */ }
  }

  function store(json) {
    if (!json || !json.access_token) return null;
    var s = {
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      // 60s of slack so a request never goes out on a token about to expire
      expires_at: Date.now() + ((json.expires_in || 3600) - 60) * 1000,
      user: json.user || null,
    };
    save(s);
    return s;
  }

  function gotrue(path, body, bearer) {
    return fetch(URL_BASE + '/auth/v1' + path, {
      method: 'POST',
      headers: {
        apikey: KEY,
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + (bearer || KEY),
      },
      body: JSON.stringify(body || {}),
    });
  }

  /* Returns a usable session, refreshing it first if the token has expired.
     A refresh that fails means the session is gone for good — drop it rather
     than leave a dead token in storage. */
  async function session() {
    var s = load();
    if (!s) return null;
    if (s.expires_at && Date.now() < s.expires_at) return s;
    if (!s.refresh_token) { clear(); return null; }
    try {
      var r = await gotrue('/token?grant_type=refresh_token', { refresh_token: s.refresh_token });
      if (!r.ok) { clear(); return null; }
      return store(await r.json());
    } catch (_) { return null; }
  }

  async function signIn(email, password) {
    var r = await gotrue('/token?grant_type=password', { email: email, password: password });
    var j = await r.json().catch(function () { return null; });
    if (!r.ok) {
      var msg = (j && (j.error_description || j.msg || j.message)) || 'Sign-in failed';
      throw new Error(msg);
    }
    return store(j);
  }

  async function signOut() {
    var s = load();
    if (s && s.access_token) {
      try { await gotrue('/logout', {}, s.access_token); } catch (_) { /* local sign-out still applies */ }
    }
    clear();
  }

  // ---- data -------------------------------------------------------------
  async function rest(path, token) {
    var r = await fetch(URL_BASE + '/rest/v1' + path, {
      headers: { apikey: KEY, Authorization: 'Bearer ' + token },
    });
    if (!r.ok) throw new Error('rest ' + r.status);
    return r.json();
  }

  async function balance(s) {
    var rows = await rest(
      '/account_billing?account_id=eq.' + encodeURIComponent(s.user.id) + '&select=status,balance_usd',
      s.access_token
    );
    // No row yet means a brand-new account, which starts at zero — not an error.
    return rows && rows.length ? rows[0] : { status: null, balance_usd: 0 };
  }

  function ledger(s) {
    return rest(
      '/balance_ledger?account_id=eq.' + encodeURIComponent(s.user.id) +
      '&select=created_at,amount_usd,reason,ref&order=created_at.desc&limit=50',
      s.access_token
    );
  }

  // ---- view -------------------------------------------------------------
  var T = (window.LEX_ACCOUNT_TEXT || {});
  var money = function (n) {
    var v = typeof n === 'number' ? n : parseFloat(n || 0);
    return (v < 0 ? '-$' : '$') + Math.abs(v).toFixed(2);
  };

  function fmtDate(iso) {
    try {
      return new Date(iso).toLocaleDateString(document.documentElement.lang || 'en', {
        year: 'numeric', month: 'short', day: 'numeric',
      });
    } catch (_) { return iso; }
  }

  function show(which) {
    ['view-signin', 'view-account', 'view-loading'].forEach(function (id) {
      var n = el(id);
      if (n) n.hidden = id !== which;
    });
  }

  function renderLedger(rows) {
    var host = el('ledger');
    if (!host) return;
    if (!rows || !rows.length) {
      host.innerHTML = '<p class="ledger-empty">' + (T.empty || 'Nothing yet.') + '</p>';
      return;
    }
    var body = rows.map(function (r) {
      var amount = parseFloat(r.amount_usd || 0);
      var cls = amount < 0 ? 'neg' : 'pos';
      var label = r.reason === 'topup' ? (T.topup || 'Top-up') : (T.lesson || 'Lessons');
      return '<tr><td>' + fmtDate(r.created_at) + '</td><td>' + label +
             '</td><td class="' + cls + '">' + money(amount) + '</td></tr>';
    }).join('');
    host.innerHTML =
      '<div class="table-scroll"><table><thead><tr>' +
      '<th>' + (T.date || 'Date') + '</th><th>' + (T.what || 'What') + '</th>' +
      '<th>' + (T.amount || 'Amount') + '</th>' +
      '</tr></thead><tbody>' + body + '</tbody></table></div>';
  }

  async function renderAccount(s) {
    show('view-account');
    var mail = el('acct-email');
    if (mail) mail.textContent = (s.user && s.user.email) || '';

    try {
      var b = await balance(s);
      var amt = el('acct-balance');
      if (amt) {
        var v = typeof b.balance_usd === 'number' ? b.balance_usd : parseFloat(b.balance_usd || 0);
        amt.textContent = money(v);
        amt.classList.toggle('is-zero', !(v > 0));
      }
    } catch (_) {
      var a = el('acct-balance');
      if (a) a.textContent = '—';
    }

    try { renderLedger(await ledger(s)); } catch (_) { renderLedger([]); }
  }

  async function boot() {
    show('view-loading');
    var s = await session();
    if (s && s.user) return renderAccount(s);
    show('view-signin');
  }

  function wire() {
    var form = el('signin-form');
    if (form) {
      form.addEventListener('submit', async function (ev) {
        ev.preventDefault();
        var err = el('signin-error');
        var btn = el('signin-submit');
        if (err) { err.textContent = ''; err.hidden = true; }
        if (btn) btn.disabled = true;
        try {
          var s = await signIn(el('signin-email').value.trim(), el('signin-password').value);
          await renderAccount(s);
        } catch (e) {
          if (err) { err.textContent = T.badLogin || 'Wrong email or password.'; err.hidden = false; }
        } finally {
          if (btn) btn.disabled = false;
        }
      });
    }

    var out = el('signout');
    if (out) {
      out.addEventListener('click', async function () {
        await signOut();
        show('view-signin');
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { wire(); boot(); });
  } else {
    wire();
    boot();
  }
})();
