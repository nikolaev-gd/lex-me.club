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
//   topNumber(), answerPrice(), formatBalance() — what the number on top shows,
//                        the price under a message, how the balance is written:
//                        the rules are the server's (list_chat_money: top,
//                        answers[].priced), these only read them;
//   drawTop(), drawPrice() — the one drawing of the number on top and of the
//                        price under a message for the page and the Mac (DOM
//                        only when called);
//   createRefresher()  — когда перечитывать деньги беседы после платного
//                        события: строка расхода появляется на сервере не сразу
//                        (ответ дочитывается, слушатель голоса пишет после хода,
//                        название беседы считается позже), поэтому перечитываем
//                        по сигналу базы, пока не пришло ожидаемое или не вышел
//                        срок; без канала сигналов — по расписанию.
// Ленту страница рисует сама; число над чатом и цену под сообщением — drawTop и
// drawPrice отсюда (расширение отложено и рисует своё, chat-surface.js).
//
// Без chrome.* и без DOM при загрузке — файл грузят и контент-скрипты
// расширения, и обычная страница; DOM трогают только drawTop и drawPrice.
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

  // How the balance of the account is written (one rule on the page, the Mac and the iPhone, ChatMoney.formatBalance,
  // 25.11.2026): never more than there is — cut DOWN, not rounded: from a cent up two digits ($0.999 → «$0.99», not
  // «$1.00»); under a cent but not zero four digits, so that a few tenths of a cent do not read as an empty account
  // ($0.004 → «$0.0040»); zero — «$0.00»; unknown — «—». A small epsilon keeps $0.29 from turning into «$0.28».
  function formatBalance(usd) {
    if (usd === null || usd === undefined || usd === '') return '—';
    const n = typeof usd === 'number' ? usd : Number(usd);
    if (!Number.isFinite(n)) return '—';
    const abs = Math.abs(n);
    const digits = abs > 0 && abs < 0.01 ? 4 : 2;
    const f = Math.pow(10, digits);
    const cut = Math.floor(abs * f + 1e-6) / f;
    return (n < 0 && cut > 0 ? '-$' : '$') + cut.toFixed(digits);
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
    // Дело каждого ответа (lex_chat_branch_labels) и дела беседы (lex_chat_branches): уид ответа → метка.
    const branchLabels = new Map();
    for (const l of (Array.isArray(b.branch_labels) ? b.branch_labels : [])) {
      if (l && l.answer_uid && l.op_id) branchLabels.set(String(l.answer_uid), l);
    }
    const branchList = (Array.isArray(b.branches) ? b.branches : []).filter((x) => x && x.branch_id);
    // The door of after 21.11.2026 prices every step by the API prices (answers[i].api_usd,
    // answers[i].step, total.api_usd, week). A door of before has none of them: then the number
    // on top stays the billed total of the chat, as it was (stepPriced false).
    const stepPriced = !!(t && Object.prototype.hasOwnProperty.call(t, 'api_usd'))
      || list.some((a) => Object.prototype.hasOwnProperty.call(a, 'api_usd'));
    const w = (b.week && typeof b.week === 'object') ? b.week : null;
    // The number on top as the server decides it (chat_money_one_rule.sql, 25.11.2026): { usd, uid } or null — no number.
    // A door of before has no such field: undefined, and the rule is read from hasPaidSteps and the answers as it was.
    let top;
    if (Object.prototype.hasOwnProperty.call(b, 'top')) {
      top = (b.top && typeof b.top === 'object' && num(b.top.usd) != null)
        ? { usd: num(b.top.usd), uid: b.top.uid != null ? String(b.top.uid) : null } : null;
    }
    return {
      showMoney: b.show_money === true,
      answers,
      list,
      marks,
      branchLabels,
      branchList,
      entries: Array.isArray(b.entries) ? b.entries : [],
      total: t ? { usd: num(t.usd) || 0, byKind, apiUsd: num(t.api_usd) } : null,
      // false — the chat has no paid step: the number on top is not drawn (not «$0»); a real step of $0 stays «$0».
      // A door of before has no such field: undefined, the number stays.
      hasPaidSteps: (t && typeof t.has_paid_steps === 'boolean') ? t.has_paid_steps : undefined,
      stepPriced,
      top,
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

  // The step on top of the chat. The door names it (`top`, chat_money_one_rule.sql): its answer, or null — none. A door of
  // before: the last answer that has a price and is not marked as a kind with none.
  function lastStep(money) {
    if (money && money.top !== undefined) {
      const t = money.top;
      if (!t) return null;
      const a = t.uid && money.answers ? money.answers.get(t.uid) : null;
      return a || { uid: t.uid, api_usd: t.usd };
    }
    const list = money && Array.isArray(money.list) ? money.list : [];
    for (let i = list.length - 1; i >= 0; i--) {
      if (stepUsd(list[i]) != null && list[i].priced !== false) return list[i];
    }
    return null;
  }

  // Has the chat a number on top at all (no step going on)? The server's `top`; a door of before — its has_paid_steps
  // (no such field either — yes, as it was).
  function hasNumber(money) {
    if (!money || !money.showMoney) return false;
    if (money.top !== undefined) return money.top != null;
    return money.hasPaidSteps !== false;
  }

  // May a message carry a price under it: the server says it for every answer (`priced`); a door of before — the table
  // of kinds below by the origin of the message.
  function answerPriced(a, origin) {
    if (a && typeof a.priced === 'boolean') return a.priced;
    return kindPriced(origin);
  }

  // The price under a message: its uid and its origin → usd, or null (no price there). A door of before 21.11.2026: what
  // was charged, as it was.
  function answerPrice(money, uid, origin) {
    if (!money || !money.showMoney || !money.answers || uid == null) return null;
    const a = money.answers.get(String(uid));
    if (!a || !answerPriced(a, origin)) return null;
    return money.stepPriced ? stepUsd(a) : num(a.billed);
  }

  // What the number on top shows now: null — no number; { usd, live, answer, held, old }. live — the live step
  // (createLiveStep) or null. A door of before 21.11.2026: the charged total of the chat, no window (old).
  function topNumber(money, live) {
    if (!money || !money.showMoney) return null;
    if (!money.stepPriced) return { usd: money.total ? money.total.usd : 0, live: null, answer: null, old: true };
    if (live && typeof live.top === 'function') {
      const t = live.top(money);
      if (t.live || t.held) return t;
    }
    if (!hasNumber(money)) return null;
    const a = lastStep(money);
    return { usd: money.top ? money.top.usd : (a ? stepUsd(a) : 0), live: null, answer: a };
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

  // ── The kinds of messages: what a message of this origin is — its price and the controls under it ────────────
  //
  // The price of a message lives on the server (lex_message_priced, chat_money_one_rule.sql): every answer of
  // list_chat_money says `priced` itself, and the apps draw by it; the price column here (and the iPhone's,
  // ChatMoney.swift `MessageKinds`) is read only for a door of before that has no `priced`. What a message is — the
  // look — is read here always. dev-tools/test-message-kinds.mjs checks the copies against each other and against every
  // `origin` the code and the database know. The key is the origin of a turn of the chat (`video_chat_turns.origin`;
  // no origin is `text`). [price, why not, look]:
  //   price — the price stands under a message only where the server gives a paid step for its uid (list_chat_money);
  //   look  — 'answer': an answer of a model of this chat — the model button and Retry under the last one;
  //           'system': a word of the system (a service of the base, a summary, a task of development, a notice) —
  //           no model of this chat wrote it, so nothing asks it again: Copy in its row, Copy and Select in its
  //           menu, no model button, no Retry (docs/spec/21-chat-canvas.md, «Виды чатов и их части»);
  //           'own': drawn by a part of its own chat (a person, a client, a feed, a news, an agent) with that
  //           part's menu; never with the controls of a model.
  // An unknown origin is a word of the system: it has no price and no controls of a model. A new origin without
  // a row here fails the test: decide first what it is.
  //
  // The side of a message in a chat of a person, a group or an order (docs/spec/21-chat-canvas.md, «Что разговор с
  // моделью, а что переписка»): the origins of CONVERSATION are the conversation with the person — his messages, what
  // went to him, the notices of Profi.ru, a call, the agent «Кто это»; every other origin is the talk with the model
  // (the clean view takes it off the screen, the line «Discussion with Lex · N» counts it). The server holds the rule
  // (lex_turn_talk of chat_profile.sql, written from this list by dev-tools/chat-profile-sql.mjs) and gives it with every
  // turn (`talk`); this list is read for a turn that came without it. The iPhone: `MessageKinds.conversation`.
  const NO_MODEL = 'no model worked on it';
  const MESSAGE_KINDS = {
    text: [true, null, 'answer'],                        // the main chat
    voice: [true, null, 'answer'],                       // a talk by voice (no row under it)
    claude_code: [true, null, 'answer'],                 // a step of Claude Code (by the API prices)
    folder_whois: [true, null, 'own'],                   // «Кто это» in a chat of a person; an agent's word of before agent_word.sql
    agent_word: [true, null, 'own'],                     // a turn of a task chat of an agent (profi:editor:<n>; look.agent.by)
    news: [false, 'the feed of news is written by the base, not by a step of a chat', 'own'],
    folder_in: [false, NO_MODEL + ': the words of a person', 'own'],
    folder_out: [false, NO_MODEL + ': the words of Gennady to a person', 'own'],
    profi_client: [false, NO_MODEL + ': the words of a client of an order', 'own'],
    profi_sent: [true, null, 'own'],                     // the words that went to a client: the offer of the bot is written by a model (the price stands under it
                                                         // by its uid, profi_bridge_spend); the words of Gennady get no step from the server, so no price
    profi_draft: [false, 'a draft is not an answer of a step', 'own'],
    profi_call: [false, NO_MODEL + ': a call with a person', 'own'],
    profi_call_draft: [false, 'a draft is not an answer of a step', 'own'],
    profi_notice: [false, 'a line of the system', 'system'],
    profi_bot: [false, 'a line of the system: the Profi agent tells of itself', 'system'],
    profi_order: [false, 'an order of New orders: the monitor of Profi.ru brings it, no step of a chat', 'own'],
    call_summary: [false, 'the summary of a call is written by the base; its spend has no chat', 'system'],
    em_intake: [false, 'the feed of Extended Mind: the base writes it, its spend has no chat', 'own'],
    em_request: [false, 'the feed of Extended Mind: the base writes it, its spend has no chat', 'own'],
    em_question: [false, 'the feed of Extended Mind: the base writes it, its spend has no chat', 'own'],
    em_status: [false, 'the feed of Extended Mind: the base writes it, its spend has no chat', 'own'],
    digest: [false, 'the summary of the day is written by the base; its spend has no chat', 'system'],
    base_alert: [false, 'a line of the system', 'system'],
    base_ok: [false, 'a line of the system', 'system'],
    send_wait: [false, 'a line of the system', 'system'],
    send_failed: [false, 'a line of the system', 'system'],
    mac: [true, null, 'system'],                         // a step of Claude Code on the Mac (a code task): its price stands under its
                                                         // row; a word of the system all the same — no model of this chat wrote it
  };
  const kindRow = (origin) => MESSAGE_KINDS[origin == null || origin === '' ? 'text' : String(origin)] || null;
  // May a message of this origin carry a price? An unknown origin may not (and the test fails on it).
  function kindPriced(origin) {
    const k = kindRow(origin);
    return !!(k && k[0]);
  }
  // What a message of this origin is: 'answer', 'system' or 'own'. An unknown origin is 'system'.
  function kindLook(origin) {
    const k = kindRow(origin);
    return k ? k[2] : 'system';
  }
  // May a message of this origin carry the controls of a model — the model button, Retry? Only an answer of a model.
  const kindReasks = (origin) => kindLook(origin) === 'answer';
  // The conversation with the person; the rest of a chat of a person is the talk with the model (see above).
  const CONVERSATION = ['folder_in', 'folder_out', 'folder_whois', 'agent_word', 'profi_client', 'profi_sent', 'profi_notice', 'profi_call'];
  // Is this turn of a chat of a person the talk with the model? The server's word (`talk` of the turn) when it gave one.
  function kindTalk(origin, talk) {
    if (typeof talk === 'boolean') return talk;
    return CONVERSATION.indexOf(origin == null || origin === '' ? 'text' : String(origin)) < 0;
  }

  // ── The drawing of the page and the Mac: the number on top and the price under a message ────────────────────────────
  //
  // One drawing for every chat of the page — the main chat, a person, a group, an order, an agent, Claude Code: the
  // header calls drawTop, the feed calls drawPrice; what is drawn is what the server said (topNumber, answerPrice).
  // The window of a step on hover is lex-step-popup.js.

  // The number on top: el — its button (hidden when there is no number), sum — the place of the digits (el itself when
  // absent). money — normalize(), live — createLiveStep() or null. → what is shown (topNumber).
  function drawTop(el, sum, money, live) {
    if (!el) return null;
    const t = topNumber(money, live);
    const usd = t ? t.usd : 0;
    el.hidden = !t;
    (sum || el).textContent = format(usd);
    el.dataset.lexUsd = String(usd);
    el.classList.toggle('is-live', !!(t && t.live));
    el._lexTop = { money, live };
    const popup = root.LexStepPopup;
    if (popup) {
      popup.attach(el, () => {
        const s = el._lexTop;
        const now = !el.hidden && s ? topNumber(s.money, s.live) : null;
        if (!now || now.old) return null;
        return stepView(now.answer || { api_usd: now.usd }, s.money, now.live);
      });
      popup.refresh(el);
    }
    return t;
  }

  // The price under a message: turn — the element of the message (data-uid, data-origin); foot() — the row under its
  // words to put the price in (made when needed); cls — the class of the price («wc-price»). getMoney() — the money of
  // the chat now (the window of the step reads it on hover). No price → its node goes. → usd or null.
  function drawPrice(turn, money, opts) {
    const o = opts || {};
    const cls = o.cls || 'lex-price';
    const old = turn.querySelector(':scope > ' + (o.footSel || '*') + ' > .' + cls);
    const uid = turn.dataset.uid;
    const usd = answerPrice(money, uid, turn.dataset.origin);
    const popup = root.LexStepPopup;
    if (usd == null) {
      if (old) { if (popup) popup.detach(old); old.remove(); }
      return null;
    }
    const node = old || (() => { const n = turn.ownerDocument.createElement('span'); n.className = cls; return n; })();
    node.textContent = format(usd);
    node.dataset.lexUsd = String(usd);
    if (money.stepPriced && popup) {
      node.removeAttribute('title');
      const getMoney = typeof o.getMoney === 'function' ? o.getMoney : () => money;
      popup.attach(node, () => {
        const m = getMoney();
        const a = m && m.answers ? m.answers.get(uid) : null;
        return a && stepUsd(a) != null ? stepView(a, m, null) : null;
      });
    } else {
      if (popup) popup.detach(node);
      const a = money.answers.get(String(uid));
      node.title = [a && a.model, a && a.effort].filter(Boolean).join(' · ');
    }
    if (!old) (typeof o.foot === 'function' ? o.foot() : turn).append(node);
    return usd;
  }

  root.LexChatMoney = {
    MESSAGE_KINDS, CONVERSATION, kindPriced, kindLook, kindReasks, kindTalk, answerPriced, answerPrice, hasNumber, topNumber, drawTop, drawPrice, formatBalance,
    format, normalize, breakdown, createRefresher, KIND_ORDER,
    stepUsd, lastStep, formatTokens, formatMarkup, payLine, statsLine, formatPause, moscowDay,
    weekLine, stepView, createLiveStep,
  };
})(typeof window !== 'undefined' ? window : globalThis);
