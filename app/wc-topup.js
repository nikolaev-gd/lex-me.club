// webchat/wc-topup.js — пополнение баланса.
//
// ── Что здесь чинится ───────────────────────────────────────────────────────
//
// Внутри приложения кнопка «Пополнить» уводила в Safari на
// `lex-me.club/checkout/`, и там человек читал «Please sign in first» — хотя в
// чат он вошёл. Причина не в потерянном токене, а в том, что Safari это
// отдельная программа со своим хранилищем: вход, сделанный в веб-вью
// приложения, туда не доезжает и доезжать не должен.
//
// ── Почему НЕ «передать сессию в Safari» ────────────────────────────────────
//
// Ровно это и делали до 2026-08-12, и от этого ушли (коммит 6762a1b): в
// localStorage обычной страницы клался `refresh_token`, который не истекает, —
// то есть полный доступ к аккаунту, читаемый любым скриптом, который туда
// попадёт. Задание прямо просит не повторять этот способ.
//
// ── Как сделано ─────────────────────────────────────────────────────────────
//
// Так же, как в расширении после того же коммита: сумма выбирается ЗДЕСЬ,
// сервер зовётся напрямую токеном этой страницы, и открывается касса
// ПРОВАЙДЕРА, а не наша страница. Передавать сессию некуда, потому что
// передавать её больше некому — на кассе провайдера нашего входа нет и не
// требуется.
//
// В обеих оболочках `window.open` перехватывается и уходит в системный
// браузер — и для кассы провайдера это ПРАВИЛЬНО: там человек вводит карту, и
// он должен видеть адресную строку и настоящий сертификат, а не безымянное
// окно внутри чужого приложения. Банковское подтверждение платежа внутри
// стороннего окна к тому же часто не проходит вовсе.
//
// «В обеих» — с недавнего времени. На iPhone так было с самого начала
// (`UIApplication.shared.open`), а Мак грузил кассу В ТО ЖЕ ОКНО, подменяя ею
// чат: `createWebViewWith` в `macos/.../WebHost.swift` отдаёт ссылку
// `NSWorkspace` только теперь.
//
// ── Чего здесь нет ──────────────────────────────────────────────────────────
// Платёжной формы. Ни полей карты, ни чужого платёжного SDK: сумма едет на наш
// сервер, тот открывает заказ у провайдера и отдаёт ссылку. Карта вводится на
// стороне провайдера — он же merchant of record.
(function (global) {
  'use strict';

  const { el, toast } = WcUI;

  // Те же границы, что у сервера (payments-webhook: MIN_USD/MAX_USD) и что на
  // /checkout/ сайта. Здесь они — вежливость: сервер проверяет сам.
  const MIN_USD = 10;
  const MAX_USD = 200;
  const DEFAULT_USD = 10;

  // Опрос заказа до зачисления. Те же числа, что в расширении.
  const POLL_MS = 2500;
  const POLL_CAP_MS = 5 * 60 * 1000;

  let polling = false;

  async function pollUntilPaid(orderId, onState) {
    if (!orderId || polling) return;
    polling = true;
    const started = Date.now();
    try {
      while (Date.now() - started < POLL_CAP_MS) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        let paid = false;
        try {
          const r = await WcBus.call('WC_PAYMENT_STATUS', { orderId });
          paid = !!(r && r.paid);
        } catch (_) {
          continue;   // сеть моргнула — ещё круг
        }
        if (paid) { onState('paid'); return; }
      }
      // Потолок 5 минут: заказ, не оплаченный к этому времени, скорее всего
      // брошен. Если деньги придут позже (ретрай вебхука, медленный банк),
      // баланс всё равно обновится при ближайшем чтении аккаунта.
      onState('timeout');
    } finally {
      polling = false;
    }
  }

  const WcTopup = {
    open(ctx) {
      const opts = ctx || {};
      const host = document.getElementById('wc-modal');

      const amount = el('input', {
        type: 'number', inputmode: 'decimal',
        min: String(MIN_USD), max: String(MAX_USD), step: '1',
        value: String(DEFAULT_USD),
        'aria-label': 'Top-up amount in dollars',
      });
      const status = el('.wc-topup-status', { role: 'status', 'aria-live': 'polite' });
      const pay = el('button.wc-btn.wc-btn-primary', { type: 'button', text: 'Pay' });
      const cancel = el('button.wc-btn.wc-btn-ghost', { type: 'button', text: 'Cancel' });

      function close() { host.hidden = true; host.replaceChildren(); }
      cancel.addEventListener('click', close);

      pay.addEventListener('click', async () => {
        const v = Number(amount.value);
        if (!Number.isFinite(v) || v < MIN_USD || v > MAX_USD) {
          status.textContent = `Amount between $${MIN_USD} and $${MAX_USD}.`;
          status.classList.add('is-error');
          return;
        }
        status.classList.remove('is-error');
        status.textContent = 'Opening checkout…';
        pay.disabled = true;
        amount.disabled = true;

        // ⚠️ Окно открывается ДО ожидания ответа сервера и потом
        // перенаправляется. Открыть его после `await` значит открыть не по
        // жесту человека — и любой браузер такое окно заблокирует.
        //
        // ВНУТРИ ОБОЛОЧКИ так делать нельзя. Там `window.open` не открывает
        // окно, а отдаёт адрес системному браузеру — и пустой `about:blank`
        // ушёл бы туда отдельной вкладкой, до и помимо кассы. Блокировщика
        // всплывающих окон, ради которого нужен этот приём, внутри оболочки
        // нет вовсе, поэтому там просто ждём ответа сервера.
        const inShell = !!(global.LexComposerInput && LexComposerInput.shellPlatform());
        const win = inShell ? null : global.open('', '_blank');

        let r;
        try {
          r = await WcBus.call('WC_CREATE_PAYMENT', { amount: v });
        } catch (err) {
          r = { ok: false, error: String((err && err.message) || err) };
        }

        if (!r || !r.ok) {
          try { if (win) win.close(); } catch (_) {}
          pay.disabled = false;
          amount.disabled = false;
          status.classList.add('is-error');
          status.textContent = r && r.error === 'not_signed_in'
            ? 'Your session seems to have expired. Sign in again.'
            : 'Could not start the payment: ' + ((r && r.error) || 'no response');
          return;
        }

        if (win) win.location = r.checkoutUrl;
        else global.open(r.checkoutUrl, '_blank', 'noopener');   // окно заблокировали — пробуем прямо

        status.textContent = 'Waiting for the payment. You can close that window — the balance updates itself.';
        pollUntilPaid(r.orderId, (state) => {
          if (state === 'paid') {
            toast('Balance topped up');
            if (opts.onPaid) opts.onPaid();
            close();
          } else {
            // Не ошибка: заказ мог быть просто брошен, а мог и дозачислиться
            // позже. Врать «не оплачено» нельзя.
            status.textContent = 'No payment seen yet. If it went through, the balance will update itself.';
          }
        });
      });

      host.replaceChildren(el('.wc-modal-card', {}, [
        el('h3', { text: 'Top up balance' }),
        el('p', { text: `From $${MIN_USD} to $${MAX_USD}. Payment happens on the provider's page.` }),
        el('.wc-topup-row', {}, [el('span', { class: 'wc-topup-cur', text: '$' }), amount]),
        status,
        el('.wc-modal-actions', {}, [cancel, pay]),
      ]));
      host.hidden = false;
      try { amount.focus(); amount.select(); } catch (_) {}
    },

    MIN_USD,
    MAX_USD,
  };

  global.WcTopup = WcTopup;
})(typeof self !== 'undefined' ? self : globalThis);
