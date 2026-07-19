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

  /* The money column on balance_ledger is delta_usd — negative for a charge,
   * positive for a top-up. It was selected as amount_usd here, which is not a
   * column on that table: PostgREST answers 400, rest() throws, and the caller's
   * catch quietly rendered an empty list. The transaction list had therefore
   * never shown a single row. */
  function ledger(s) {
    return rest(
      '/balance_ledger?account_id=eq.' + encodeURIComponent(s.user.id) +
      '&select=created_at,delta_usd,reason,ref&order=created_at.desc&limit=50',
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
      var amount = parseFloat(r.delta_usd || 0);
      var cls = amount < 0 ? 'neg' : 'pos';
      // 'adjust' is a manual correction (the owner zeroing a balance, a refund
      // settled by hand). Calling it "Lessons" like everything non-topup would be
      // a plain lie about where the money went.
      var label = r.reason === 'topup'
        ? (T.topup || 'Top-up')
        : (r.reason === 'adjust' ? (T.adjust || 'Adjustment') : (T.lesson || 'Lessons'));
      return '<tr><td>' + fmtDate(r.created_at) + '</td><td>' + label +
             '</td><td class="' + cls + '">' + money(amount) + '</td></tr>';
    }).join('');
    host.innerHTML =
      '<div class="table-scroll"><table><thead><tr>' +
      '<th>' + (T.date || 'Date') + '</th><th>' + (T.what || 'What') + '</th>' +
      '<th>' + (T.amount || 'Amount') + '</th>' +
      '</tr></thead><tbody>' + body + '</tbody></table></div>';
  }

  /* Read the balance and paint it. Returns the number shown, or null if the read
   * failed — the poller below needs to tell "no change yet" apart from "could not
   * ask", and would otherwise treat a dropped request as a settled balance. */
  async function paintBalance(s) {
    try {
      var b = await balance(s);
      var v = typeof b.balance_usd === 'number' ? b.balance_usd : parseFloat(b.balance_usd || 0);
      var amt = el('acct-balance');
      if (amt) {
        amt.textContent = money(v);
        amt.classList.toggle('is-zero', !(v > 0));
      }
      return v;
    } catch (_) {
      var a = el('acct-balance');
      if (a) a.textContent = '—';
      return null;
    }
  }

  /* Everything on the page that comes from the server. Safe to call repeatedly. */
  async function refresh(s) {
    var v = await paintBalance(s);
    try { renderLedger(await ledger(s)); } catch (_) { renderLedger([]); }
    return v;
  }

  async function renderAccount(s) {
    show('view-account');
    var mail = el('acct-email');
    if (mail) mail.textContent = (s.user && s.user.email) || '';
    return refresh(s);
  }

  /* The session the page is currently showing. Kept so the re-read handlers
   * below have something to ask with; null while signed out. */
  var current = null;

  /* Coming back from a Polar checkout.
   *
   * The credit does not happen in the browser. Polar sends its order.paid webhook
   * to payments-webhook, which is what moves the balance, and it redirects the
   * customer back here independently of that. Measured on the real payments, the
   * credit lands ~1.6-1.9s after the order exists — usually before the redirect
   * finishes, but not by a margin worth trusting: the webhook can be retried, and
   * a slow delivery would otherwise leave the customer looking at their old
   * balance with no reason given.
   *
   * So on a return marked by ?checkout_id, re-read the balance for a while until
   * it moves. Polling the payment row itself is not an option — public.payments
   * has RLS on with no policy, so the browser cannot see it. The balance and the
   * ledger are the only things this session is allowed to look at.
   *
   * The marker is stripped from the URL immediately: a reload or a bookmark
   * should not start the poll again. */
  var POLL_MS = 1200;
  var POLL_TRIES = 20;   // ~24s, comfortably past a retried webhook

  async function pollAfterCheckout(s, before) {
    for (var i = 0; i < POLL_TRIES; i++) {
      await new Promise(function (r) { setTimeout(r, POLL_MS); });
      // Tab hidden: the customer is elsewhere. Stop burning requests — the
      // visibilitychange handler re-reads the moment they come back.
      if (document.hidden) return;
      var v = await paintBalance(s);
      if (v != null && before != null && v !== before) {
        try { renderLedger(await ledger(s)); } catch (_) { /* balance is the point */ }
        return;
      }
    }
  }

  function checkoutIdFromUrl() {
    try {
      var id = new URLSearchParams(location.search).get('checkout_id');
      if (!id) return null;
      var u = new URL(location.href);
      u.searchParams.delete('checkout_id');
      history.replaceState(null, '', u.pathname + (u.search || '') + u.hash);
      return id;
    } catch (_) { return null; }
  }

  async function boot() {
    show('view-loading');
    var s = await session();
    current = s && s.user ? s : null;
    if (!current) { show('view-signin'); return; }
    var justPaid = checkoutIdFromUrl();
    var before = await renderAccount(current);
    if (justPaid) await pollAfterCheckout(current, before);
  }

  /* Re-read on the ways back to this page that are not a fresh load.
   *
   * boot() runs on DOMContentLoaded and nothing else, so every one of these
   * showed a stale number until now:
   *   - Back / forward into the page — restored from bfcache, no DOMContentLoaded
   *   - the tab was already open and the customer switched to it (the extension
   *     opens the checkout in a NEW tab, so this is the normal case)
   *   - the window regained focus after the payment finished elsewhere
   * A read is one small GET, so firing on all three is cheaper than reasoning
   * about which one the customer took. */
  function wireRereads() {
    window.addEventListener('pageshow', function (e) {
      if (e.persisted && current) refresh(current);
    });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && current) refresh(current);
    });
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
          current = s;
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
        // Drop the session the re-read handlers hold, or a tab switch after
        // signing out would fetch with a dead token and repaint the account view.
        current = null;
        show('view-signin');
      });
    }
  }

  // Exposed so the checkout page can reuse the session handling rather than
  // re-implementing it. It needs the refreshing version in particular: reading
  // localStorage directly hands an expired token to the server and the customer
  // sees "please sign in" while looking at a page that says they are signed in.
  window.LexAuth = { session: session, signIn: signIn, signOut: signOut };

  // The account view only exists on the account page. Everything below is a
  // no-op elsewhere, so the same file can be loaded on both.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { wire(); wireRereads(); boot(); });
  } else {
    wire();
    wireRereads();
    boot();
  }
})();
