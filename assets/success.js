/* success.js — the page the customer lands on after paying.
 *
 * The bank's website rules require a confirmation page carrying the order
 * details and the date of the transaction, so this page has to show real data
 * about a real order, not a generic "thank you".
 *
 * Where the data comes from: payments has row-level security on with no
 * policies, so the browser cannot read the table even with the customer's own
 * token. payments-webhook/status is the only door, and it answers for one
 * order belonging to the caller's own account.
 *
 * Why it polls: the customer is redirected back the moment the bank finishes,
 * which can be a beat BEFORE the callback that credits the balance reaches us.
 * Showing "not paid" in that window would be wrong, so the page says it is
 * confirming and asks again for a while. Only after the window closes does it
 * say the confirmation has not arrived — with the order number, so the money is
 * traceable either way.
 */
(function () {
  'use strict';

  // Every label on this page is server-rendered in the customer's language;
  // this file only fills in the values.
  var CFG = window.LEX_CONFIG || {};
  var el = function (id) { return document.getElementById(id); };

  var POLL_MS = 2000;
  var POLL_LIMIT = 15; // ~30 seconds

  var order = new URLSearchParams(location.search).get('order') || '';

  function show(id, on) {
    var n = el(id);
    if (n) n.hidden = !on;
  }

  function setText(id, value) {
    var n = el(id);
    if (n) n.textContent = value;
  }

  async function currentSession() {
    if (window.LexAuth && window.LexAuth.session) {
      try { return await window.LexAuth.session(); } catch (_) { return null; }
    }
    try { return JSON.parse(localStorage.getItem('lexSession') || 'null'); } catch (_) { return null; }
  }

  /** dd.mm.yyyy hh:mm from whatever ISO shape the bank sent. Left as-is if it
   *  is not parseable — a raw timestamp beats an invented one. */
  function humanDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    var p = function (n) { return String(n).padStart(2, '0'); };
    return p(d.getDate()) + '.' + p(d.getMonth() + 1) + '.' + d.getFullYear() +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function render(info) {
    setText('su-order', info.order_id || order);
    setText('su-merchant', info.merchant || '');
    setText('su-description', info.description || '');
    setText('su-credited', '$' + Number(info.amount_usd).toFixed(2));
    if (info.charge_amount != null) {
      setText('su-charged', Number(info.charge_amount).toFixed(2) + ' ' + (info.charge_currency || ''));
    } else {
      show('su-charged-row', false);
    }
    setText('su-date', humanDate(info.paid_at));
  }

  async function fetchStatus(session) {
    var r = await fetch(CFG.supabaseUrl + '/functions/v1/payments-webhook/status', {
      method: 'POST',
      headers: {
        apikey: CFG.supabaseKey,
        Authorization: 'Bearer ' + session.access_token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ order: order }),
    });
    if (!r.ok) return null;
    return await r.json().catch(function () { return null; });
  }

  async function run() {
    if (!order) {
      show('su-waiting', false);
      show('su-unknown', true);
      return;
    }
    // Both fallback states show the order number, so neither dead-ends the
    // customer without something support can search for.
    setText('su-order-fallback', order);
    setText('su-order-fallback-2', order);

    var session = await currentSession();
    if (!session || !session.access_token) {
      // Signed out in another tab, or the session expired while they were on
      // the bank's page. The payment is unaffected; say so and point at sign-in.
      show('su-waiting', false);
      show('su-signedout', true);
      return;
    }

    for (var i = 0; i < POLL_LIMIT; i++) {
      var info = await fetchStatus(session);
      if (info && info.ok && info.paid) {
        render(info);
        show('su-waiting', false);
        show('su-paid', true);
        return;
      }
      await new Promise(function (r) { setTimeout(r, POLL_MS); });
    }

    // The window closed without a confirmation. Not the same as "it failed":
    // the bank may still be sending it, so the wording says pending and the
    // order number is on screen.
    show('su-waiting', false);
    show('su-pending', true);
  }

  run();
})();
