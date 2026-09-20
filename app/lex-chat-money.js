// lex-chat-money.js — деньги беседы на экране: одно правило для всех окон
// расширения и для страницы lex-me.club/app (её же показывает программа для
// Мака). Айфон держит то же правило в Swift (ios/Lex/Lex/ChatMoney.swift).
//
// Что здесь, а чего здесь нет.
//
// Сколько стоил ход, под какой репликой стоит цена и сколько всего списано по
// беседе — решает СЕРВЕР, дверь public.list_chat_money (миграция
// supabase/migrations/chat_money.sql). Приложение ничего не считает и не
// складывает: оно показывает то, что пришло, по готовому уиду реплики.
// Здесь живёт только то, что общее у всех браузерных поверхностей и не
// зависит от их разметки:
//   format(usd)        — как пишутся деньги;
//   normalize(body)    — ответ двери в удобную форму (уид → ответ, итог);
//   breakdown(total)   — строки разбивки итога по видам, в одном порядке;
//   createRefresher()  — когда перечитывать деньги беседы после платного
//                        события: строка расхода появляется на сервере не сразу
//                        (ответ дочитывается, слушатель голоса пишет после хода,
//                        название беседы считается позже), поэтому перечитываем
//                        с повтором, пока не пришло ожидаемое или не вышел срок.
// Рисуют окна сами: у расширения и страницы разная разметка ленты.
//
// Без chrome.* и без DOM — файл грузят и контент-скрипты расширения, и
// обычная страница.
(function (root) {
  'use strict';

  // Как пишутся деньги — одинаково под ответом, в служебной записи и в итоге
  // (docs/spec/80-devtools.md, «Как пишутся деньги»): ноль — «$0»; от десятой
  // цента — ТРИ знака после точки; мельче — столько знаков, чтобы была видна
  // первая значащая цифра; округление, дошедшее до десятой цента, пишется
  // тремя знаками; сервер цену не прислал — «$?».
  //
  // Три знака, а не два (решение владельца 2026-09-20). Работа учителя часто
  // стоит единицы десятых цента, и на двух знаках половина цен в ленте
  // сходилась к «$0.01» и «$0.00»: рядом стояли ход за $0.006 и ход за
  // $0.014, и на экране это было одно и то же число. Порог значащей цифры
  // съехал вместе с числом знаков — с цента на десятую цента, — чтобы правило
  // осталось одним: до этого порога знаков ровно три, ниже столько, сколько
  // нужно для первой значащей цифры.
  function format(usd) {
    if (usd == null) return '$?';
    const cost = typeof usd === 'number' ? usd : Number(usd);
    if (!Number.isFinite(cost)) return '$?';
    if (cost === 0) return '$0';
    const abs = Math.abs(cost);
    if (abs >= 0.001) return '$' + cost.toFixed(3);
    const digits = Math.ceil(-Math.log10(abs));
    const factor = Math.pow(10, digits);
    const rounded = Math.round(cost * factor) / factor;
    if (Math.abs(rounded) >= 0.001) return '$' + rounded.toFixed(3);
    return '$' + rounded.toFixed(digits);
  }

  function num(v) {
    if (v == null || v === '') return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  }

  // Ответ двери → { showMoney, answers: Map(uid → ответ), entries, total }.
  // total — { usd, byKind: {вид: usd} } или null (денег этому человеку не
  // показывают). Цена ответа — поле billed (списанное); null — не показывать.
  function normalize(body) {
    const b = (body && typeof body === 'object') ? body : {};
    const answers = new Map();
    for (const a of (Array.isArray(b.answers) ? b.answers : [])) {
      if (a && a.uid) answers.set(String(a.uid), a);
    }
    const t = (b.total && typeof b.total === 'object') ? b.total : null;
    const byKind = {};
    if (t && t.by_kind && typeof t.by_kind === 'object') {
      for (const k of Object.keys(t.by_kind)) {
        const v = num(t.by_kind[k]);
        if (v != null) byKind[k] = v;
      }
    }
    return {
      showMoney: b.show_money === true,
      answers,
      entries: Array.isArray(b.entries) ? b.entries : [],
      total: t ? { usd: num(t.usd) || 0, byKind } : null,
    };
  }

  // Порядок строк разбивки итога. Ключи — виды, которые отдаёт сервер;
  // незнакомый вид встаёт в конец своим именем.
  const KIND_ORDER = ['preprocess', 'chat', 'voice', 'transcription', 'dictation', 'title'];

  function breakdown(total) {
    if (!total || !total.byKind) return [];
    const rows = [];
    const seen = new Set();
    for (const k of KIND_ORDER) {
      const v = total.byKind[k];
      if (v != null && v > 0) rows.push({ kind: k, usd: v });
      seen.add(k);
    }
    for (const k of Object.keys(total.byKind).sort()) {
      if (seen.has(k)) continue;
      const v = total.byKind[k];
      if (v != null && v > 0) rows.push({ kind: k, usd: v });
    }
    return rows;
  }

  // Перечитывание денег беседы после платного события.
  //
  // load(key)  → Promise<body двери | null>;
  // apply(key, money) — нарисовать (money — результат normalize);
  // currentKey() — какая беседа открыта сейчас: перечитанное для другой
  //                беседы не рисуется.
  //
  // request({ key, expectUid, settleMs }):
  //   expectUid — уид реплики, под которой ждём цену (или список: годится
  //               любой из них — ответ, остановленный до первого слова, сервер
  //               ставит под вопрос): повторяем, пока он не появится в ответах
  //               двери. Ответ, остановленный «стопом»,
  //               сервер дочитывает до конца и пишет строку расхода только
  //               потом — это может быть и через полторы минуты, поэтому
  //               терпение у такого ожидания большое.
  //   settleMs  — ждать ничего конкретного не нужно, но строка может
  //               доехать позже (слушатель голоса, название беседы): несколько
  //               перечитываний в пределах срока.
  // Запросы за одну беседу сливаются: последнее ожидание не отменяет прежнее,
  // пока тот уид не нашёлся.
  const DELAYS_MS = [700, 1500, 3000, 5000, 8000, 12000, 16000, 20000];

  function createRefresher(opts) {
    const load = opts.load;
    const apply = opts.apply;
    const currentKey = opts.currentKey || (() => null);
    const waits = new Map();          // key → { groups:[[uid…]], until, settleUntil }
    let timer = null;
    let step = 0;
    let running = false;

    function schedule(delay) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(tick, delay);
    }

    async function tick() {
      timer = null;
      if (running) { schedule(300); return; }
      const key = currentKey();
      const w = key ? waits.get(key) : null;
      if (!key || !w) { waits.clear(); step = 0; return; }
      running = true;
      let money = null;
      try {
        const body = await load(key);
        if (body) money = normalize(body);
      } catch (_) { /* сеть — повторим по расписанию */ }
      running = false;
      if (currentKey() !== key) { waits.clear(); step = 0; return; }
      if (money) {
        try { apply(key, money); } catch (e) { console.warn('[lex-money] apply failed', e && e.message); }
        w.groups = w.groups.filter((g) => !g.some((uid) => money.answers.has(uid)));
      }
      const now = Date.now();
      if ((w.groups.length || now < w.settleUntil) && now < w.until) {
        const d = DELAYS_MS[Math.min(step, DELAYS_MS.length - 1)];
        step++;
        schedule(d);
      } else {
        waits.delete(key);
        step = 0;
      }
    }

    function request(r) {
      const key = r && r.key;
      if (!key) return;
      const now = Date.now();
      let w = waits.get(key);
      if (!w) { w = { groups: [], until: now, settleUntil: now }; waits.set(key, w); }
      const alts = (Array.isArray(r.expectUid) ? r.expectUid : [r.expectUid]).filter(Boolean).map(String);
      if (alts.length) {
        w.groups.push(alts);
        w.until = Math.max(w.until, now + (r.patienceMs || 30000));
      }
      if (r.settleMs) {
        w.settleUntil = Math.max(w.settleUntil, now + r.settleMs);
        w.until = Math.max(w.until, now + r.settleMs);
      }
      w.until = Math.max(w.until, now + 1000);
      step = 0;
      schedule(r.immediate ? 0 : 400);
    }

    return { request, cancel() { if (timer) clearTimeout(timer); timer = null; waits.clear(); } };
  }

  root.LexChatMoney = { format, normalize, breakdown, createRefresher, KIND_ORDER };
})(typeof window !== 'undefined' ? window : globalThis);
