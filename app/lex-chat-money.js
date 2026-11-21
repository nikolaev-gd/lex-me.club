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
//   normalize(body)    — ответ двери в удобную форму (уид → ответ, итог;
//                        marks — пометки под ответами в чатах с базой);
//   breakdown(total)   — строки разбивки итога по видам, в одном порядке;
//   stepView(), lastStep(), createLiveStep(), formatTokens() — цена шага по
//                        ценам API и слова окна разбивки шага (lex-step-popup.js
//                        рисует их на странице и в расширении);
//   createRefresher()  — когда перечитывать деньги беседы после платного
//                        события: строка расхода появляется на сервере не сразу
//                        (ответ дочитывается, слушатель голоса пишет после хода,
//                        название беседы считается позже), поэтому перечитываем
//                        по сигналу базы, пока не пришло ожидаемое или не вышел
//                        срок; без канала сигналов — по расписанию.
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
    // The answers in the order of the door (time order): the last one is the step on top.
    const list = [];
    for (const a of (Array.isArray(b.answers) ? b.answers : [])) {
      if (a && a.uid) { answers.set(String(a.uid), a); list.push(a); }
    }
    const t = (b.total && typeof b.total === 'object') ? b.total : null;
    const byKind = {};
    if (t && t.by_kind && typeof t.by_kind === 'object') {
      for (const k of Object.keys(t.by_kind)) {
        const v = num(t.by_kind[k]);
        if (v != null) byKind[k] = v;
      }
    }
    // Пометки под ответами в чатах с базой (lex_chat_marks): уид → [пометки].
    const marks = new Map();
    for (const m of (Array.isArray(b.marks) ? b.marks : [])) {
      if (!m || !m.uid) continue;
      const k = String(m.uid);
      if (!marks.has(k)) marks.set(k, []);
      marks.get(k).push(m);
    }
    // The door of after 21.11.2026 prices every step by the API prices (answers[i].api_usd,
    // answers[i].step, total.api_usd, week). A door of before has none of them: then the number
    // on top stays the billed total of the chat, as it was (stepPriced false).
    const stepPriced = !!(t && Object.prototype.hasOwnProperty.call(t, 'api_usd'))
      || list.some((a) => Object.prototype.hasOwnProperty.call(a, 'api_usd'));
    const w = (b.week && typeof b.week === 'object') ? b.week : null;
    return {
      showMoney: b.show_money === true,
      answers,
      list,
      marks,
      entries: Array.isArray(b.entries) ? b.entries : [],
      total: t ? { usd: num(t.usd) || 0, byKind, apiUsd: num(t.api_usd) } : null,
      stepPriced,
      week: (w && num(w.used) != null) ? { used: num(w.used), resetsAt: w.resets_at || null } : null,
    };
  }

  // ── The price of a step by the API prices (21.11.2026) ─────────────────────
  //
  // A step is the owner's message and the whole answer to it: every request to the model and
  // every tool call. Its price by the API prices of the model that answered — api_usd of the
  // answer — stands under the answer and on top of the chat, whatever way it was paid. The
  // server counts it and sends it ready (list_chat_money; for a Claude Code turn while it goes —
  // the stream frame lex_proxy_cost). Here only what both browser surfaces show the same: which
  // step is on top, how a number of tokens is written and the words of the window of a step
  // (lex-step-popup.js draws them). The iPhone keeps the same rules in Swift (ChatMoney.swift).

  // The price of an answer by the API prices, or null (no price: do not show one).
  function stepUsd(a) {
    return a ? num(a.api_usd) : null;
  }

  // The step on top of the chat: the last answer of the door that has a price. null — none
  // (the number shows «$0», as with no answers at all).
  function lastStep(money) {
    const list = money && Array.isArray(money.list) ? money.list : [];
    for (let i = list.length - 1; i >= 0; i--) {
      if (stepUsd(list[i]) != null) return list[i];
    }
    return null;
  }

  // Tokens grouped by threes with a thin space (U+2009): 31 232, 613 408.
  const THIN = ' ';
  function formatTokens(n) {
    const v = num(n);
    if (v == null) return '';
    const s = String(Math.round(Math.abs(v)));
    const grouped = s.replace(/\B(?=(\d{3})+(?!\d))/g, THIN);
    return (v < 0 ? '-' : '') + grouped;
  }

  // The markup of a step paid from the balance: billed / usd to one decimal, «2» and not «2.0».
  function formatMarkup(billed, usd) {
    const b = num(billed);
    const u = num(usd);
    if (b == null || u == null || u <= 0) return '';
    const m = Math.round((b / u) * 10) / 10;
    if (!Number.isFinite(m) || m <= 0) return '';
    return '×' + (Number.isInteger(m) ? String(m) : m.toFixed(1));
  }

  // The way the step was paid, in words.
  function payLine(step) {
    const s = step || {};
    if (s.pay === 'subscription') return 'по подписке';
    if (s.pay === 'api') return 'токены API';
    if (s.pay === 'balance') {
      const b = num(s.billed);
      if (b == null) return 'списано с баланса';
      const mk = formatMarkup(b, s.usd);
      return 'списано с баланса ' + format(b) + (mk ? ' (наценка ' + mk + ')' : '');
    }
    return '';
  }

  // «Прочитано 613 408 · написано 22 942 токенов · обращений к модели 10»; what is missing is left out.
  function statsLine(step) {
    const s = step || {};
    const tok = [];
    if (num(s.read_tokens) != null) tok.push('прочитано ' + formatTokens(s.read_tokens));
    if (num(s.written_tokens) != null) tok.push('написано ' + formatTokens(s.written_tokens));
    const out = [];
    if (tok.length) out.push(tok.join(' · ') + ' токенов');
    if (num(s.calls) != null) out.push('обращений к модели ' + formatTokens(s.calls));
    const line = out.join(' · ');
    return line ? line.charAt(0).toUpperCase() + line.slice(1) : '';
  }

  // A pause in minutes: under an hour — «25 мин», under three days — whole hours «25 ч», longer —
  // whole days «4 дн». The time a cache lives — always in minutes («60 мин»), as the server keeps it.
  function formatPause(min) {
    const m = num(min);
    if (m == null || m < 0) return '';
    if (m < 60) return Math.max(1, Math.round(m)) + ' мин';
    if (m < 72 * 60) return Math.round(m / 60) + ' ч';
    return Math.round(m / (24 * 60)) + ' дн';
  }
  function cacheLostNote(cl) {
    if (!cl) return '';
    const bits = [];
    const p = formatPause(cl.pause_min);
    if (p) bits.push('пауза ' + p);
    const ttl = num(cl.ttl_min);
    if (ttl != null) bits.push('кэш живёт ' + Math.round(ttl) + ' мин');
    return bits.join(', ');
  }

  // The day a week of the subscription is reset, by the Moscow clock (UTC+3 all year since 2014):
  // «26 ноября».
  const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа',
    'сентября', 'октября', 'ноября', 'декабря'];
  function moscowDay(iso) {
    const ms = typeof iso === 'number' ? iso : Date.parse(iso || '');
    if (!Number.isFinite(ms)) return '';
    const d = new Date(ms + 3 * 3600 * 1000);
    return d.getUTCDate() + ' ' + MONTHS_GEN[d.getUTCMonth()];
  }
  // «Неделя подписки: 55%, обнулится 26 ноября»; no week — ''.
  function weekLine(week) {
    if (!week) return '';
    const used = num(week.used);
    if (used == null) return '';
    const day = moscowDay(week.resetsAt != null ? week.resetsAt : week.resets_at);
    return 'Неделя подписки: ' + Math.round(used * 100) + '%' + (day ? ', обнулится ' + day : '');
  }

  const CACHE_LOST_LABEL = 'Кэш пропал: переписка записана в кэш заново';
  const TOOLS_TITLE = 'Ответы инструментов';
  const OLD_NOTE = 'Разбивки нет: шаг до 21.11.2026';
  const LIVE_NOTE = 'идёт шаг…';

  function partRow(p, note) {
    const tokens = num(p.tokens);
    return {
      key: String(p.key || ''),
      label: String(p.label || p.key || ''),
      tokens: tokens ? formatTokens(tokens) : '',
      usd: format(num(p.usd) == null ? 0 : num(p.usd)),
      note: note || '',
    };
  }

  // The words of the window of a step — one view for the page, the extension and (by the same
  // rules in Swift) the iPhone. Nothing here is counted: every number comes from the server.
  //
  //   a     — the answer of the door (api_usd, step, model, effort) or null;
  //   money — LexChatMoney.normalize (the whole chat, the week) or null;
  //   live  — { usd, calls } while the step goes (the stream frame lex_proxy_cost) or null.
  //
  // → { live, price, model, pay, stats, note, items, chat, week }; items — in the order of the
  //   server: { kind: 'row', row } and one { kind: 'group', title, rows } at the place of the
  //   first part of the tools, with every part of the tools in it. row — { key, label, tokens,
  //   usd, note }; tokens '' — a part of no tokens: only its dollars are shown.
  function stepView(a, money, live) {
    const step = (a && a.step && typeof a.step === 'object') ? a.step : null;
    const items = [];
    let note = '';
    const liveUsd = live ? num(live.usd) : null;
    if (live) {
      note = LIVE_NOTE;
    } else if (step && step.old === true) {
      note = OLD_NOTE;
    } else if (step) {
      let group = null;
      let lostShown = false;
      const lost = (step.cache_lost && typeof step.cache_lost === 'object') ? step.cache_lost : null;
      for (const p of (Array.isArray(step.parts) ? step.parts : [])) {
        if (!p) continue;
        if (p.key === 'cache_lost') {
          if (lostShown) continue;
          lostShown = true;
          items.push({ kind: 'row', row: partRow(Object.assign({}, p, { label: p.label || CACHE_LOST_LABEL }), cacheLostNote(lost)) });
          continue;
        }
        const row = partRow(p);
        if (p.group === 'tools') {
          if (!group) { group = { kind: 'group', title: TOOLS_TITLE, rows: [] }; items.push(group); }
          group.rows.push(row);
        } else {
          items.push({ kind: 'row', row });
        }
      }
      // A lost cache the server told of without its own part: its row all the same, once.
      if (lost && !lostShown) {
        items.push({ kind: 'row', row: partRow({ key: 'cache_lost', label: CACHE_LOST_LABEL, tokens: lost.tokens, usd: lost.usd }, cacheLostNote(lost)) });
      }
    }
    const usd = live ? liveUsd : (step && num(step.usd) != null ? num(step.usd) : stepUsd(a));
    const modelName = (step && step.model) || (a && a.model) || '';
    const effort = step ? (step.effort || null) : ((a && a.effort) || null);
    const chatUsd = money && money.total ? money.total.apiUsd : null;
    return {
      live: !!live,
      price: format(usd),
      model: [modelName, effort].filter(Boolean).join(' · '),
      pay: live ? '' : payLine(step),
      stats: live
        ? (num(live.calls) ? 'Обращений к модели ' + formatTokens(live.calls) : '')
        : statsLine(step),
      note,
      items,
      chat: chatUsd != null ? 'Весь чат по ценам API: ' + format(chatUsd) : '',
      week: weekLine(money ? money.week : null),
    };
  }

  // The live step of a Claude Code turn: the stream frame lex_proxy_cost ({ usd, calls }) and, at
  // its end, apiUsd of lex_proxy_done. One small state per window; the number on top reads it.
  //   onFrame({ requestId, usd, calls }) — while the turn of this chat goes;
  //   onDone({ requestId, apiUsd, uid }) — the end: the final number holds on top until the
  //     money read anew has the step of that answer (uid), so the first read, made before the
  //     server wrote the row, does not take the number back to the step before;
  //   top(money) → { usd, live, answer } — what the number on top shows now;
  //   reset() — another chat opened.
  const HOLD_MS = 60000;
  function createLiveStep() {
    let live = null;      // { requestId, usd, calls }
    let held = null;      // { usd, uid }
    return {
      onFrame(f) {
        const usd = f ? num(f.usd) : null;
        if (usd == null) return false;
        live = { requestId: f.requestId || null, usd, calls: num(f.calls) };
        return true;
      },
      onDone(d) {
        const rid = d && d.requestId;
        if (live && rid && live.requestId && rid !== live.requestId) return false;
        const final = d ? num(d.apiUsd) : null;
        const was = live;
        live = null;
        const at = Date.now();
        if (final != null) held = { usd: final, uid: d.uid ? String(d.uid) : null, at };
        else if (was) held = { usd: was.usd, uid: d && d.uid ? String(d.uid) : null, at };
        return true;
      },
      setUid(uid) { if (held && uid && !held.uid) held.uid = String(uid); },
      live() { return live ? { usd: live.usd, calls: live.calls } : null; },
      top(money) {
        if (live) return { usd: live.usd, live: { usd: live.usd, calls: live.calls }, answer: null };
        const a = lastStep(money);
        if (held) {
          // The uid of the answer is not known (a turn without one): the number holds a minute at most.
          const landed = held.uid
            ? !!(money && money.answers && stepUsd(money.answers.get(held.uid)) != null)
            : Date.now() - held.at > HOLD_MS;
          if (landed) held = null;
          else return { usd: held.usd, live: null, answer: null, held: true };
        }
        return { usd: a ? stepUsd(a) : 0, live: null, answer: a };
      },
      reset() { live = null; held = null; },
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
  //                беседы не рисуется;
  // signals()  — канал сигналов базы (lex-account-events.js) или null. С ним
  //              деньги перечитываются по сигналу «money» этой беседы (записан
  //              или оплачен вызов: строка расхода и списание — одна операция
  //              lex_settle) из supabase/migrations/account_signals.sql и один
  //              раз, когда канал открылся снова, — а не по расписанию (решение
  //              Геннадия 2026-11-13: ничего не спрашивать по таймеру). Без
  //              канала — прежнее расписание DELAYS_MS.
  // chatKey()  — ключ открытой беседы: сигнал другой беседы (очистка субтитров
  //              другого ролика) не перечитывает эту.
  //
  // request({ key, expectUid, settleMs }):
  //   expectUid — уид реплики, под которой ждём цену (или список: годится
  //               любой из них — ответ, остановленный до первого слова, сервер
  //               ставит под вопрос): перечитываем, пока он не появится в
  //               ответах двери. Ответ, остановленный «стопом»,
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
    const signalsOf = typeof opts.signals === 'function' ? opts.signals : () => opts.signals || null;
    const chatKeyOf = opts.chatKey || (() => null);
    const waits = new Map();          // key → { groups:[[uid…]], until, settleUntil }
    let timer = null;
    let deadline = null;
    let follower = null;
    let step = 0;
    let running = false;
    let again = false;

    function schedule(delay) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(tick, delay);
    }

    // С каналом: следующее чтение придёт с сигналом, ожидание кончится само в свой срок.
    function follow() {
      if (follower) return;
      const ch = signalsOf();
      if (ch && typeof ch.follow === 'function') {
        follower = ch.follow(['money'], (signal) => {
          const chat = signal && signal.payload && signal.payload.chat;
          const mine = chatKeyOf();
          if (chat && mine && chat !== mine) return undefined;
          return tick();
        });
      }
    }
    function unfollow() {
      if (follower) follower.stop();
      follower = null;
      if (deadline) clearTimeout(deadline);
      deadline = null;
    }
    function armDeadline(ms) {
      if (deadline) clearTimeout(deadline);
      deadline = setTimeout(() => { deadline = null; tick(); }, Math.max(0, ms) + 50);
    }

    async function tick() {
      timer = null;
      if (running) { again = true; return; }
      const key = currentKey();
      const w = key ? waits.get(key) : null;
      if (!key || !w) { waits.clear(); step = 0; unfollow(); return; }
      running = true;
      again = false;
      let money = null;
      try {
        const body = await load(key);
        if (body) money = normalize(body);
      } catch (_) { /* сеть — следующий сигнал или следующий срок прочитают снова */ }
      running = false;
      if (currentKey() !== key) { waits.clear(); step = 0; unfollow(); return; }
      if (money) {
        try { apply(key, money); } catch (e) { console.warn('[lex-money] apply failed', e && e.message); }
        w.groups = w.groups.filter((g) => !g.some((uid) => money.answers.has(uid)));
      }
      const now = Date.now();
      if ((w.groups.length || now < w.settleUntil) && now < w.until) {
        if (follower) {
          armDeadline(w.until - now);
          if (again) { again = false; await tick(); }
        } else {
          const d = DELAYS_MS[Math.min(step, DELAYS_MS.length - 1)];
          step++;
          schedule(d);
        }
      } else {
        waits.delete(key);
        step = 0;
        if (!waits.size) unfollow();
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
      follow();
      schedule(r.immediate ? 0 : 400);
    }

    return {
      request,
      cancel() {
        if (timer) clearTimeout(timer);
        timer = null;
        waits.clear();
        unfollow();
      },
    };
  }

  root.LexChatMoney = {
    format, normalize, breakdown, createRefresher, KIND_ORDER,
    stepUsd, lastStep, formatTokens, formatMarkup, payLine, statsLine, formatPause, moscowDay,
    weekLine, stepView, createLiveStep,
  };
})(typeof window !== 'undefined' ? window : globalThis);
