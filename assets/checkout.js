/* checkout.js — open a top-up order.
 *
 * This page never touches money. It asks the server to open an order and then
 * hands the customer to whatever the provider says. The balance only ever moves
 * when the provider's webhook reaches payments-webhook, which is the only place
 * that calls lex_topup.
 *
 * Both checkboxes are required by Moldovan law, not by taste: accepting the
 * terms, and — separately, never pre-ticked (Civil Code art. 1065(2)) —
 * consenting to immediate performance, which is the only way the 14-day
 * withdrawal right is validly lost for a digital service (art. 1065(1)(m)).
 * The submit button carries the wording art. 1017(4) demands; without it the
 * order does not bind the customer at all.
 *
 * Two ways in, and they need different things:
 *
 *   From the extension — the service worker has already written the signed-in
 *   session into localStorage by the time the customer can press anything, so
 *   the sign-in block below never appears. That handoff happens after this page
 *   loads, which is why the session is read inside the submit handler and not
 *   at load: reading it at load would race the handoff and show a sign-in form
 *   to someone who is already signed in.
 *
 *   From the site — "Top up" on the landing comes straight here, and a logged
 *   out visitor used to hit "please sign in" with nowhere to do it. Now the
 *   sign-in block appears at the moment it is actually needed, and the order
 *   continues by itself once they are through.
 */
(function () {
  'use strict';

  var CFG = window.LEX_CONFIG || {};
  var T = window.LEX_CHECKOUT_TEXT || {};
  var el = function (id) { return document.getElementById(id); };

  var MIN_USD = 10;
  var MAX_USD = 200;

  /** The signed-in session, refreshed if the token has expired. Falls back to a
   *  plain read only if auth.js is missing, so a stale token still beats none. */
  async function currentSession() {
    if (window.LexAuth && window.LexAuth.session) {
      try { return await window.LexAuth.session(); } catch (_) { return null; }
    }
    try { return JSON.parse(localStorage.getItem('lexSession') || 'null'); } catch (_) { return null; }
  }

  function fail(msg) {
    var e = el('co-error');
    if (e) { e.textContent = msg; e.hidden = false; }
  }

  function clearError() {
    var e = el('co-error');
    if (e) { e.textContent = ''; e.hidden = true; }
  }

  var form = el('checkout-form');
  if (!form) return;

  function showSignIn(on) {
    var box = el('co-signin');
    if (box) box.hidden = !on;
    if (on) {
      var mail = el('co-signin-email');
      if (mail) mail.focus();
    }
  }

  /** Ask the server to open the order, then hand the customer over. */
  async function placeOrder(amount, session) {
    var btn = el('co-submit');
    if (btn) btn.disabled = true;
    try {
      var r = await fetch(CFG.supabaseUrl + '/functions/v1/payments-webhook/create', {
        method: 'POST',
        headers: {
          apikey: CFG.supabaseKey,
          Authorization: 'Bearer ' + session.access_token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount: amount }),
      });
      var j = await r.json().catch(function () { return null; });

      if (!r.ok) return fail((j && j.error && j.error.message) || T.err_amount);
      if (j && j.checkout_url) {
        location.href = j.checkout_url;
        return;
      }
      // Nowhere to send the customer. Say exactly that — a spinner or a fake
      // success would be worse than the truth.
      fail(T.no_provider);
    } catch (_) {
      fail(T.no_provider);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function readAmount() {
    var amount = Number(el('co-amount').value);
    if (!Number.isFinite(amount) || amount < MIN_USD || amount > MAX_USD) return null;
    return amount;
  }

  form.addEventListener('submit', async function (ev) {
    ev.preventDefault();
    clearError();

    var amount = readAmount();
    if (amount === null) return fail(T.err_amount);
    if (!el('co-terms').checked || !el('co-now').checked) return fail(T.err_agree);

    var s = await currentSession();
    if (!s || !s.access_token) {
      // Not an error — just the step they have not done yet.
      showSignIn(true);
      return fail(T.err_auth);
    }
    showSignIn(false);
    await placeOrder(amount, s);
  });

  // ---- inline sign-in, shown only when the order actually needs it ---------
  var signinForm = el('co-signin-form');
  if (signinForm) {
    signinForm.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      clearError();
      var err = el('co-signin-error');
      if (err) { err.textContent = ''; err.hidden = true; }

      if (!window.LexAuth || !window.LexAuth.signIn) return fail(T.err_auth);

      var btn = el('co-signin-submit');
      if (btn) btn.disabled = true;
      try {
        var s = await window.LexAuth.signIn(
          el('co-signin-email').value.trim(),
          el('co-signin-password').value
        );
        showSignIn(false);
        // Carry straight on with the order they were already trying to place;
        // making them press the button a second time is a step for nothing.
        var amount = readAmount();
        if (amount === null) return fail(T.err_amount);
        await placeOrder(amount, s);
      } catch (_) {
        if (err) { err.textContent = T.err_badlogin || 'Wrong email or password.'; err.hidden = false; }
      } finally {
        if (btn) btn.disabled = false;
      }
    });
  }
})();
