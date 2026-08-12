/* checkout.js — open a top-up order.
 *
 * This page never touches money. It asks the server to open an order and then
 * hands the customer to whatever the provider says. The balance only ever moves
 * when the provider's webhook reaches payments-webhook, which is the only place
 * that calls lex_topup.
 *
 * There used to be two consent checkboxes here and a special order-button
 * label, required of a seller by Moldovan law. Removed 2026-08-13: the seller
 * of record is Creem, and those duties are discharged on their checkout. What
 * we owe Creem is this public site — product description, prices, terms,
 * privacy policy, support email — and that is all still here.
 *
 * Who arrives here: someone who found the site on their own. The extension no
 * longer sends anyone this way — it opens its own top-up window and goes
 * straight to the checkout (2026-08-12). Nor does it hand this page a session
 * any more, which is why the sign-in block below matters: it appears at the
 * moment the order actually needs it, and the order continues by itself once
 * they are through.
 */
(function () {
  'use strict';

  var CFG = window.LEX_CONFIG || {};
  var T = window.LEX_CHECKOUT_TEXT || {};
  var el = function (id) { return document.getElementById(id); };

  // ВРЕМЕННО: 1 вместо 10 на время боевой проверки (2026-08-13).
  // Вернуть 10 сразу после неё; те же правки ждут в build.py (min/value поля и
  // тексты err_amount), в topup-window.js расширения и в MIN_USD функции
  // payments-webhook. Ниже доллара не опускается: Creem не принимает
  // custom_price меньше 100 центов.
  var MIN_USD = 1;
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

  var LANG = (document.documentElement.getAttribute('lang') || 'en').slice(0, 2);

  // ── what the card will actually be charged ────────────────────────────────
  // The balance is in dollars; the acquirer may only be able to charge another
  // currency (maib's profile takes MDL and refuses USD outright). Whenever the
  // two differ the customer sees both figures here, before committing — finding
  // out on the bank's page that the sum is not the one on ours is exactly the
  // sort of thing the acceptance rules are about. The rate comes from the
  // server so there is one source of truth for it.
  var conversion = null;

  function renderCharge() {
    var line = el('co-charge');
    if (!line) return;
    if (!conversion || !conversion.convert) { line.hidden = true; return; }
    var amount = Number(el('co-amount').value);
    if (!Number.isFinite(amount) || amount <= 0) { line.hidden = true; return; }
    var charged = (Math.round(amount * conversion.rate * 100) / 100).toFixed(2);
    line.textContent = (T.charge_note || '')
      .replace('{amount}', charged)
      .replace('{currency}', conversion.currency);
    line.hidden = false;
  }

  (async function loadRate() {
    try {
      var r = await fetch(CFG.supabaseUrl + '/functions/v1/payments-webhook/rate', {
        method: 'POST',
        headers: { apikey: CFG.supabaseKey, 'Content-Type': 'application/json' },
        body: '{}',
      });
      conversion = await r.json();
    } catch (_) {
      // No estimate is better than a wrong one: the line stays hidden and the
      // bank's own page still shows the sum before any card details are typed.
      conversion = null;
    }
    renderCharge();
  })();

  var amountInput = el('co-amount');
  if (amountInput) amountInput.addEventListener('input', renderCharge);

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
        // lang decides which language the bank's own page, the page they come
        // back to, and the receipt are written in.
        body: JSON.stringify({ amount: amount, lang: LANG }),
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
