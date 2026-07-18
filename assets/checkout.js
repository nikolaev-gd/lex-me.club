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
 */
(function () {
  'use strict';

  var CFG = window.LEX_CONFIG || {};
  var T = window.LEX_CHECKOUT_TEXT || {};
  var el = function (id) { return document.getElementById(id); };

  function session() {
    try { return JSON.parse(localStorage.getItem('lexSession') || 'null'); } catch (_) { return null; }
  }

  function fail(msg) {
    var e = el('co-error');
    if (e) { e.textContent = msg; e.hidden = false; }
  }

  var form = el('checkout-form');
  if (!form) return;

  form.addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var e = el('co-error');
    if (e) { e.textContent = ''; e.hidden = true; }

    var amount = Number(el('co-amount').value);
    if (!Number.isFinite(amount) || amount < 1 || amount > 1000) return fail(T.err_amount);
    if (!el('co-terms').checked || !el('co-now').checked) return fail(T.err_agree);

    var s = session();
    if (!s || !s.access_token) return fail(T.err_auth);

    var btn = el('co-submit');
    if (btn) btn.disabled = true;

    try {
      var r = await fetch(CFG.supabaseUrl + '/functions/v1/payments-webhook/create', {
        method: 'POST',
        headers: {
          apikey: CFG.supabaseKey,
          Authorization: 'Bearer ' + s.access_token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount: amount }),
      });
      var j = await r.json().catch(function () { return null; });

      if (!r.ok) {
        return fail((j && j.error && j.error.message) || T.err_amount);
      }
      if (j && j.checkout_url) {
        location.href = j.checkout_url;
        return;
      }
      // Order opened, but there is nowhere to send the customer yet. Say exactly
      // that — a spinner or a fake success would be worse than the truth.
      fail(T.no_provider);
    } catch (_) {
      fail(T.no_provider);
    } finally {
      if (btn) btn.disabled = false;
    }
  });
})();
