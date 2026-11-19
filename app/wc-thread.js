// webchat/wc-thread.js — the message list.
//
// Two jobs that pull against each other: render Markdown as it arrives, and
// keep the scroll where the reader wants it. The second is the one that is
// easy to get wrong — a list that force-scrolls on every token makes it
// impossible to read back over an answer while it is still being written. So
// autoscroll is a mode, not an action: it stays on while the reader is at the
// bottom and switches off the moment they scroll away from it, and the jump
// button is how they opt back in.
(function (global) {
  'use strict';

  const { el, toast } = WcUI;

  let elThread, elTurns, elEmpty, elJump;
  // Where the reader was before a press on a quote took him to the message (showTurn with back), or null.
  let backTop = null;

  // ── A redraw waits while the reader selects (block 2, 2026-11-18) ─────────────────────────
  // The signals of Gennady's account come in bursts — «profi» every 1–3 s while the bot works — and every one
  // drew the answers of an open order chat again, which took a selection away before ⌘C: «из чата нельзя
  // скопировать вообще ничего». While the list holds a selection, a held mouse, an open menu of a message or
  // Select (LexMessage.isBusy), a redraw from a signal waits; the last one of each kind runs when that ends.
  const waiting = new Map();
  let freeTimer = null;
  function busy() { return !!(elThread && global.LexMessage && global.LexMessage.isBusy && global.LexMessage.isBusy(elThread)); }
  function flushWaiting() {
    clearTimeout(freeTimer);
    freeTimer = setTimeout(() => {
      if (!waiting.size || busy()) return;
      const list = [...waiting.values()];
      waiting.clear();
      for (const fn of list) { try { fn(); } catch (e) { console.warn('[wc] redraw:', e && e.message); } }
    }, 150);
  }
  document.addEventListener('selectionchange', () => { if (waiting.size) flushWaiting(); });
  document.addEventListener('lexmessagefree', () => { if (waiting.size) flushWaiting(); });
  let hooks = {};
  let stickToBottom = true;
  // The order chat of the Profi.ru section that is open, or null (lex-profi.js).
  let profiChat = null;
  // Who keeps a message Lex did not take (wc-app.js): called with the person's turn and why.
  let onUnsent = null;
  // Requests whose chat the person left mid-answer: still read by the page, no longer shown.
  const left = new Set();
  // The streaming turn, keyed by requestId: {node, bubble, text}. A map rather
  // than one variable because a stopped stream can still deliver a trailing
  // frame after the next one has started.
  const live = new Map();
  // Every bubble a live voice conversation is writing into, keyed by the
  // server's item_id. A Map and not two variables — see the Voice section.
  const voiceBubbles = new Map();

  function nearBottom() {
    return elThread.scrollHeight - elThread.scrollTop - elThread.clientHeight < 60;
  }

  function scrollToBottom(smooth) {
    elThread.scrollTo({ top: elThread.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }

  // Прилипание к низу — НЕ на каждый токен.
  //
  // Было: `scrollTo` прямо в обработчике каждого куска потока. Быстрая модель
  // шлёт куски десятками в секунду, и каждый вызов — это принудительный расчёт
  // раскладки плюс прокрутка, то есть ровно то, что на телефоне ощущается как
  // дёрганье. Сводим к одному разу за кадр: чаще кадра экран всё равно не
  // обновляется, а лишние расчёты между кадрами не видны никому, кроме
  // расходуемой батареи.
  let stickRaf = 0;
  function maybeStick() {
    if (!stickToBottom || stickRaf) return;
    stickRaf = requestAnimationFrame(() => {
      stickRaf = 0;
      if (stickToBottom) scrollToBottom(false);
    });
  }

  // The one place "is this chat empty?" is decided — so it is also the one
  // place that tells the header, whose new-chat handle only exists while the
  // current chat has something in it. Anything that adds or clears turns goes
  // through here, which is why the handle cannot drift out of step.
  function setEmpty(isEmpty) {
    elEmpty.hidden = !isEmpty;
    if (global.WcHeader && WcHeader.setHasContent) WcHeader.setHasContent(!isEmpty);
    // The main page of the people stands in place of an empty thread (wc-app.js paintHome): it gives way to the first
    // word and comes back with the empty one.
    if (hooks && typeof hooks.onEmpty === 'function') hooks.onEmpty(isEmpty);
  }

  // ── The menu of a message ────────────────────────────────────────────────
  // One for every chat and every surface (lex-message.js, attachMenu, block 2 of 2026-11-18): the right
  // button of a mouse, a finger held 480 ms, the key of the menu, «⋯» over the message for a mouse. A mouse
  // held on the words selects them — in one's own message too.

  // Текст ЭТОГО хода как его написал человек. Нарезка на слова кладёт на
  // пузырь исходник (`lexSrc`) и дальше спрашивать надо его, а не то, что
  // читается из узлов: между кусками нарезка ставит РОВНО один пробел, и
  // сообщение с двойным пробелом или отступом вернулось бы из textContent
  // подправленным. Пузырь без нарезки исходника не несёт — тогда textContent и
  // есть исходник.
  function userText(bubble) {
    const src = bubble && bubble.dataset ? bubble.dataset.lexSrc : null;
    return (src != null) ? src : ((bubble && bubble.textContent) || '');
  }

  // ── Ход ЗАГОТОВКИ в ленте ────────────────────────────────────────────────
  // Вопрос, заданный заготовкой, — обычный вопрос беседы. «Edit» у него есть:
  // текст ложится в поле, а пилюля той же заготовки подсвечивается, и
  // отправка уходит через неё (wc-app.js editTurn). Слот заготовки — на узле.
  // Под ОТВЕТОМ заготовки строка та же, что под любым ответом: переспрос
  // сервер отправит той же заготовкой сам.
  // The menu of one's own message (block 2, 2026-11-18): the common menu of a message (LexMessage.attachMenu) —
  // Copy, Select, and Edit where it was before (an order chat has no second version of a message).
  function userMessageMenu(bubble, opts) {
    const turnOf = () => bubble.closest('.wc-turn-user');
    global.LexMessage.attachMenu(bubble, {
      side: 'out',
      text: () => userText(bubble),
      at: () => { const t = turnOf(); return (t && t.dataset.at) || null; },
      host: elTurns,
      // У хода заготовки правится только фраза: строку заготовки править
      // нельзя, она встаёт сама при отправке через ту же пилюлю.
      // In a chat of a person (19.11.2026) too: the words go back into the field and the next send is a new word to Lex or,
      // by a hold of the arrow, to the person. A chat of a person has no presets and no chosen words: no slot, no source.
      edit: () => {
        const turn = turnOf();
        return hooks.onEdit && hooks.onEdit(
          (bubble.dataset.editText != null) ? bubble.dataset.editText : userText(bubble),
          profiChat ? null : ((opts && opts.presetSlot) || null),
          profiChat ? null : ((turn && turn.dataset.uid) || null));
      },
      // «Send to … now» (19.11.2026): in a chat with a person behind it (an order, a person of a folder) a word to
      // Lex that was meant for him goes to him as it stands, at once, without the model — the first item of the
      // menu of the arrow of the field (profiChat.sendNow). The answer of Lex to it, still being written, stops.
      items: () => {
        const go = profiChat && typeof profiChat.sendNow === 'function' ? profiChat.sendNow(userText(bubble)) : null;
        if (!go) return [];
        return [{
          label: go.label,
          icon: go.icon,
          run: () => {
            const next = (turnOf() || {}).nextElementSibling;
            if (next && next.classList.contains('is-streaming') && hooks.onStopCurrent) hooks.onStopCurrent();
            return go.run();
          },
        }];
      },
    });
  }

  // Пузырь хода заготовки: строка, пустая строка, фраза — так, как вопрос видит
  // учитель на следующих ходах (решение владельца 2026-09-22). Замену
  // присылает сервер; правило разбора общее с расширением (lex-word-pick.js).
  function presetParts(later) {
    const WP = global.LexWordPick;
    return (later && WP && typeof WP.splitPresetLater === 'function') ? WP.splitPresetLater(later) : null;
  }

  // ── Отдельный разговор заготовки: подпись над вопросом ──────────────────
  // Ход заготовки в режиме «отдельный разговор» учитель не видит никогда. Над
  // вопросом — строка «The teacher doesn't see this» с перечёркнутым глазом, на
  // узлах вопроса и ответа — ключ беседы заготовки (по нему «заново» идёт в её
  // беседу). Тот же вид, что в расширении (chat-surface.js markApartBubble).
  const APART_EYE = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" fill="none" '
    + 'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M3 3l18 18"/><path d="M10.6 10.6a2 2 0 0 0 2.8 2.8"/>'
    + '<path d="M9.9 5.1A9.8 9.8 0 0 1 12 5c5 0 9 4.5 10 7a13 13 0 0 1-3.2 4.3"/>'
    + '<path d="M6.6 6.6C4.2 8 2.6 10.2 2 12c1 2.5 5 7 10 7a9.6 9.6 0 0 0 5.4-1.6"/></svg>';
  function markApart(turn, key) {
    if (!turn) return;
    turn.classList.add('wc-turn-apart');
    if (key) turn.dataset.threadKey = String(key);
    if (!turn.classList.contains('wc-turn-user')) return;
    const box = turn.firstElementChild || turn;
    if (box.querySelector(':scope > .wc-apart-note')) return;
    const note = el('.wc-apart-note');
    note.setAttribute('role', 'note');
    note.title = 'A separate conversation with this preset: its own history in this chat. The teacher never sees it — neither in text nor in voice.';
    note.innerHTML = APART_EYE;
    note.append(el('span', { text: "The teacher doesn't see this" }));
    box.prepend(note);
  }
  function unmarkApart(turn) {
    if (!turn) return;
    turn.classList.remove('wc-turn-apart');
    delete turn.dataset.threadKey;
    const note = turn.querySelector('.wc-apart-note');
    if (note) note.remove();
  }
  // Пузырь вопроса перерисовывается заменой узла (строка заготовки, материал)
  // — подпись и ключ переезжают на новый узел.
  function carryApart(from, to) {
    if (from && to && from.classList.contains('wc-turn-apart')) markApart(to, from.dataset.threadKey || null);
  }

  // The files a drawn turn carries (userTurn keeps them on its node).
  function filesOfNode(node) {
    const f = node && node.querySelector('.lex-files[data-files]');
    try { return f ? JSON.parse(f.dataset.files) : null; } catch (_) { return null; }
  }

  function userTurn(text, images, opts) {
    const bubble = el('.wc-bubble', { text });
    if (opts && typeof opts.editText === 'string') bubble.dataset.editText = opts.editText;
    // Пузырь «translate» из выбранного материала (решение владельца
    // 2026-09-25): материал красным, пустая строка, допечатанное — без строки
    // заготовки. Части присылает сервер; «Edit» правит допечатанное.
    const pick = (opts && typeof opts.pick === 'string' && opts.pick && global.LexWordPick) ? opts.pick : '';
    if (pick) {
      const rest = typeof opts.rest === 'string' ? opts.rest : '';
      global.LexWordPick.paintPickBubble(bubble, pick, rest);
      bubble.dataset.lexPick = pick;
      bubble.dataset.lexRest = rest;
      bubble.dataset.editText = rest;
    }
    // Ход человека приходит текстом целиком, поэтому режется сразу — ждать
    // тут нечего. `ready` кладёт на пузырь исходник даже при выключенном
    // режиме: включение посреди беседы иначе нашло бы пузыри без исходника и
    // не смогло бы потом снять с них нарезку.
    if (global.WcWordPick && !profiChat) WcWordPick.ready(bubble, text, pick ? 'pick' : 'text');
    const parts = [];
    if (images && images.length) {
      parts.push(el('.wc-turn-images', {}, images.map((src) => el('img', { src, alt: '' }))));
    }
    // Files of the message (2026-11-17): the cards of В7.21 over the bubble, at the right edge; a
    // press opens the file (an address of an hour from the storage, LexFileAttach.webIo).
    const fileList = (opts && Array.isArray(opts.files)) ? opts.files : [];
    const filesNode = fileList.length && global.LexMessage && global.LexFileAttach
      ? global.LexMessage.files(fileList, global.LexFileAttach.webIo, { free: true }) : null;
    if (filesNode) {
      parts.push(filesNode);
      // Kept on the node: a bubble drawn again (a preset's line, a pick) keeps its files.
      try { parts[parts.length - 1].dataset.files = JSON.stringify(fileList); } catch (_) {}
    }
    // A picture or a file without words is a message without a bubble (as in Telegram).
    if (String(text || '').trim() || !parts.length) parts.push(bubble);
    // Меню висит на ПУЗЫРЕ, а не на всей строке: строка тянется во всю ширину
    // ленты, и удержание в пустоте справа от короткого «hi» открывало бы меню
    // ниоткуда.
    userMessageMenu(bubble, opts);
    const turn = el('.wc-turn.wc-turn-user', {}, [el('div', {}, parts)]);
    if (opts && opts.presetSlot) turn.dataset.presetSlot = String(opts.presetSlot);
    return turn;
  }

  // Строка под ответом — общий модуль с расширением (lex-answer-row.js):
  // копирование под каждым ответом, правее переключатель версий, последней —
  // кнопка модели (под последним ответом). Какой ответ
  // последний, решает он же (syncFeet ниже).
  function answerRow(getText, bubbleOf) {
    return global.LexAnswerRow.create({
      getText,
      // The formatted answer and the plain one without the marks of Markdown (block 2, 2026-11-18).
      copy: bubbleOf ? () => copyAnswer(bubbleOf()) : null,
      copyLabel: 'Copy',
      onCopied: (ok) => {
        // The tick stands on the button itself. Clipboard is permissioned and can simply refuse (an insecure
        // origin, a shell that has not granted it): say so instead of failing mutely.
        if (!ok) toast('The browser refused clipboard access', { error: true });
      },
    });
  }
  const copyAnswer = (bubble) => global.LexMessage.copyText(global.LexMessage.plainOf(bubble), global.LexMessage.htmlOf(bubble));
  // The menu of a model's answer, of a news and of a record (block 2): on the turn, the words are its bubble — a
  // bubble is drawn again on every frame of an answer, the turn stays.
  function answerMenu(turn, bubble, o) {
    global.LexMessage.attachMenu(turn, Object.assign({
      body: bubble,
      text: () => global.LexMessage.plainOf(bubble),
      html: () => global.LexMessage.htmlOf(bubble),
      who: () => 'Lex',
      at: () => turn.dataset.at || null,
      host: elTurns,
    }, o || {}));
  }

  // The first message of a news chat: words of the letter, not a teacher's
  // answer. No Markdown (it would restyle them) and no row under it: no model
  // wrote it, so there is nothing to copy-and-repeat with another model. Under it
  // «Обсуждение с Lex»: the talk with the model starts there (ios/Lex/STANDARD.md В7.32).
  function newsTurn(text, head) {
    const bubble = el('.wc-bubble');
    global.LexNews.renderText(bubble, text);
    const talk = global.LexNews.talkLine ? global.LexNews.talkLine() : null;
    const turn = el('.wc-turn.wc-turn-assistant.wc-turn-news', {}, [head, bubble, talk]);
    turn.dataset.raw = text || '';
    // A news: its words without the line of its source; Copy link — the address of the source.
    const source = /\[Source\]\((https?:[^)\s]+)\)/.exec(text || '');
    answerMenu(turn, bubble, { html: null, who: () => 'News', link: source ? () => source[1] : null });
    if (text && global.WcWordPick) WcWordPick.ready(bubble, text, 'news');
    return { turn, bubble };
  }

  function assistantTurn(text) {
    const bubble = el('.wc-bubble');
    if (text) WcMarkdown.into(bubble, text);
    const foot = el('.wc-turn-foot', {}, [answerRow(() => turn.dataset.raw || '', () => turn.querySelector('.wc-bubble'))]);
    const turn = el('.wc-turn.wc-turn-assistant', {}, [bubble, foot]);
    turn.dataset.raw = text || '';
    answerMenu(turn, bubble);
    // Готовый ответ (история, реплей) режется сразу; пустой — это открытый
    // поток, его режет done() по концу. Резать во время потока бессмысленно по
    // построению: WcMarkdown.into на каждом кадре делает replaceChildren, то
    // есть стирает нарезку предыдущего кадра вместе со всей разметкой.
    if (text && global.WcWordPick && !profiChat) WcWordPick.ready(bubble, text, 'markdown');
    return { turn, bubble, foot };
  }

  // An entry of a feed of Extended Mind: the common message of lex-message.js — the name
  // in bold and the time, the text under them. A record of «Разбор» and «Обращения к базе»
  // is drawn from the view the server built of its data (em_entry). A question of the database
  // is drawn by the feed of questions (paintQuestions below); here it would stand as its words.
  // The feed «Разбор» (2026-11-14): its tab — 'people', 'work' or 'all' (null — another chat), the
  // records unfolded by a press (they stay so when the database extends them), the newest data of
  // every record by its uid (a press repaints from it), the press on «База задала тебе вопрос».
  let emLane = null;
  const emOpenUids = new Set();
  const emTurnsByUid = new Map();
  let emQuestionHook = null;
  const laneShows = (lane) => !emLane || emLane === 'all' || !lane || lane === emLane;
  // A record of «Разбор» drawn again in its place: a press folded or unfolded it.
  function repaintEm(t) {
    const old = [...elTurns.querySelectorAll('.wc-turn-em[data-uid]')].find((n) => n.dataset.uid === String(t.uid));
    if (old) old.replaceWith(emEntryTurn(t));
  }
  function emEntryTurn(t) {
    if (t.origin === 'em_status') {
      const line = el('.wc-em-status', {}, []);
      line.textContent = t.text || '';
      const turn = el('.wc-turn.wc-turn-em.wc-turn-em-status', {}, [line]);
      if (t.uid) turn.dataset.uid = String(t.uid);
      if (t.authoredAt) turn.dataset.at = t.authoredAt;
      return turn;
    }
    const v = t.origin === 'em_question' ? t.emView : null;
    let msg;
    const look = t.emEntry && t.origin !== 'em_question' && t.emEntry.lane ? t.emEntry : null;
    if (look) {
      const uid = String(t.uid || '');
      if (uid) emTurnsByUid.set(uid, t);
      msg = global.LexMessage.entry(look, t.authoredAt, {
        open: emOpenUids.has(uid),
        onToggle: () => {
          if (emOpenUids.has(uid)) emOpenUids.delete(uid); else emOpenUids.add(uid);
          repaintEm(emTurnsByUid.get(uid) || t);
        },
        onQuestion: (asked) => { if (emQuestionHook) emQuestionHook(asked); },
      });
    } else if (t.emEntry && t.origin !== 'em_question') {
      msg = global.LexMessage.entry(t.emEntry, t.authoredAt);
      msg.classList.add('wc-em-text');
    } else {
      msg = global.LexMessage.message({ name: 'Extended Mind', at: t.authoredAt, text: (v && v.text) || t.text || '', cls: 'wc-em-text' });
    }
    const turn = el('.wc-turn.wc-turn-em', {}, [msg]);
    if (t.uid) turn.dataset.uid = String(t.uid);
    if (t.authoredAt) turn.dataset.at = t.authoredAt;
    turn.dataset.in = '1';
    global.LexMessage.attachMenu(msg, {
      text: () => global.LexMessage.plainOf(msg),
      who: () => (look && look.title) || 'Extended Mind',
      at: () => t.authoredAt || null,
      host: elTurns,
    });
    if (look) {
      turn.dataset.lane = look.lane;
      turn.hidden = !laneShows(look.lane);
    }
    return turn;
  }

  // A chat where messages come without the person (a feed, a question, an order chat): day
  // lines and the «Новые» line over the first message that came after `since` — the moment
  // the chat was last open (lex_chat_seen). null — an ordinary chat, no lines.
  let incoming = null;
  function remark() {
    if (incoming && global.LexMessage) global.LexMessage.mark(elTurns, incoming.since);
  }
  // ── The feed of questions (2026-11-14, supabase/migrations/em_questions_feed.sql) ──────────
  // Every question of the database is one message (LexMessage.question, ios/Lex/STANDARD.md В7.24):
  // waiting — with its variants inside; answered or withdrawn — one line that unfolds. The waiting
  // questions the server put in one group stand as one message (LexMessage.questionPack, В7.25) at
  // the place of the newest of them; «One by one» lays them out there as single questions. The
  // server's line after an answer is not drawn: the line of the question says it. A hold on a question
  // or a pack opens the menu with Reply (В7.9): the next message is about it.
  let qFeed = null;            // { onAnswer(uid, choice) → Promise<{ ok, text }>, onReply({ uids, text }) } while open
  const qTurns = new Map();    // uid → the turn of a question
  const qUi = {
    pending: new Map(),        // uid → { choice, sent, error }: a press on its way, sent, or refused
    open: new Set(),           // answered questions unfolded
    packs: new Map(),          // group → { all, each, openRow, recording: { done, total } | null }
  };
  const qTime = (t) => { const x = Date.parse((t && t.authoredAt) || ''); return Number.isFinite(x) ? x : 0; };
  const qOrder = (a, b) => (qTime(a) - qTime(b)) || String(a.uid).localeCompare(String(b.uid));

  // A hold on a question or a pack: the menu of a hold (В7.9) with Reply.
  function holdToReply(lit, uids, text, at) {
    global.LexMessage.attachMenu(lit, {
      text: () => global.LexMessage.plainOf(lit),
      who: () => 'Extended Mind',
      at: () => at || null,
      host: elTurns,
      reply: qFeed && qFeed.onReply ? () => qFeed && qFeed.onReply({ uids, text }) : null,
    });
  }

  function questionMessage(t) {
    const uid = String(t.uid);
    const v = t.emView || { text: t.text || '', state: 'open', choices: [] };
    const msg = global.LexMessage.question(v, {
      at: t.authoredAt,
      pending: qUi.pending.get(uid) || null,
      open: qUi.open.has(uid),
      onChoice: (i) => answerOne(uid, i),
      onToggle: () => {
        if (qUi.open.has(uid)) qUi.open.delete(uid); else qUi.open.add(uid);
        repaintQuestions();
      },
    });
    msg.dataset.uid = uid;
    holdToReply(msg, [uid], v.text || t.text || '', t.authoredAt);
    return msg;
  }

  function questionNode(t) {
    const node = el('.wc-turn.wc-turn-em.wc-turn-q', {}, [questionMessage(t)]);
    node.dataset.uid = String(t.uid);
    if (t.authoredAt) node.dataset.at = t.authoredAt;
    node.dataset.in = '1';
    return node;
  }

  function packNode(group, list) {
    const ui = qUi.packs.get(group) || { all: false, each: false, openRow: null, recording: null };
    qUi.packs.set(group, ui);
    const members = list.map((t) => ({ uid: String(t.uid), at: t.authoredAt, view: t.emView }));
    const node = el('.wc-turn.wc-turn-em.wc-turn-q.wc-turn-pack', {}, []);
    node.dataset.uid = members[members.length - 1].uid;
    node.dataset.uids = members.map((m) => m.uid).join(' ');
    if (list[list.length - 1].authoredAt) node.dataset.at = list[list.length - 1].authoredAt;
    node.dataset.in = '1';
    if (ui.each) {
      node.classList.add('is-each');
      for (const t of list) node.appendChild(questionMessage(t));
      return node;
    }
    const errors = new Map();
    for (const m of members) {
      const p = qUi.pending.get(m.uid);
      if (p && p.error) errors.set(m.uid, p.error);
    }
    const msg = global.LexMessage.questionPack({
      members, all: ui.all, openRow: ui.openRow, recording: ui.recording, errors, pending: qUi.pending,
    }, {
      onAll: () => answerPack(group),
      onOneByOne: () => { ui.each = true; repaintQuestions(); },
      onMore: () => { ui.all = true; repaintQuestions(); },
      onRow: (uid) => { ui.openRow = ui.openRow === uid ? null : uid; repaintQuestions(); },
      onChoice: (uid, i) => answerOne(uid, i),
    });
    msg.dataset.uids = node.dataset.uids;
    holdToReply(msg, members.map((m) => m.uid), global.LexMessage.packTitle(members), list[list.length - 1].authoredAt);
    node.appendChild(msg);
    return node;
  }

  // The questions in their places: a question by its time, a pack at the time of its newest question.
  function paintQuestions() {
    if (!qFeed) return;
    for (const n of elTurns.querySelectorAll(':scope > .wc-turn-q')) n.remove();
    const turns = [...qTurns.values()].sort(qOrder);
    const groups = new Map();
    for (const t of turns) {
      const v = t.emView;
      if (!v || v.state !== 'open' || !v.group) continue;
      if (!groups.has(v.group)) groups.set(v.group, []);
      groups.get(v.group).push(t);
    }
    const packOf = new Map();
    for (const [g, list] of groups) if (list.length > 1) for (const t of list) packOf.set(String(t.uid), g);
    for (const [g, ui] of [...qUi.packs]) if (!ui.recording && !(groups.get(g) && groups.get(g).length > 1)) qUi.packs.delete(g);
    for (const t of turns) {
      const g = packOf.get(String(t.uid));
      if (!g) { place(questionNode(t)); continue; }
      const list = groups.get(g);
      if (list[list.length - 1] === t) place(packNode(g, list));
    }
  }
  // Among the turns by time: before the first turn that came later.
  function place(node) {
    const at = Date.parse(node.dataset.at || '');
    const next = Number.isFinite(at)
      ? [...elTurns.children].find((n) => n.dataset && n.dataset.at && Date.parse(n.dataset.at) > at)
      : null;
    if (next) elTurns.insertBefore(node, next); else elTurns.append(node);
  }
  function repaintQuestions() {
    paintQuestions();
    remark();
    if (stickToBottom) requestAnimationFrame(() => scrollToBottom(false));
  }

  async function answerOne(uid, i) {
    if (!qFeed || !qFeed.onAnswer) return;
    const now = qUi.pending.get(uid);
    if (now && !now.error) return;
    qUi.pending.set(uid, { choice: i });
    repaintQuestions();
    let res;
    try {
      const out = await qFeed.onAnswer(uid, i);
      res = (!out || !out.ok) ? { choice: i, error: (out && out.text) || 'the database did not take it' } : { choice: i, sent: true };
    } catch (e) {
      res = { choice: i, error: (e && e.message) || 'no connection' };
    }
    const t = qTurns.get(uid);
    if (t && t.emView && t.emView.state !== 'open') qUi.pending.delete(uid);
    else qUi.pending.set(uid, res);
    repaintQuestions();
  }

  // The button of a pack: every question of it answered with its variant of the pack, one press of
  // em-answer after another; what was not recorded stays in the pack, red.
  async function answerPack(group) {
    const ui = qUi.packs.get(group);
    if (!ui || ui.recording || !qFeed || !qFeed.onAnswer) return;
    const list = [...qTurns.values()].filter((t) => t.emView && t.emView.state === 'open' && t.emView.group === group).sort(qOrder);
    if (list.length < 2) return;
    ui.recording = { done: 0, total: list.length };
    repaintQuestions();
    for (const t of list) {
      const uid = String(t.uid);
      const k = t.emView.packChoice;
      if (!Number.isInteger(k)) { qUi.pending.set(uid, { choice: -1, error: 'the database has no variant for all' }); continue; }
      try {
        const out = await qFeed.onAnswer(uid, k);
        qUi.pending.set(uid, (!out || !out.ok) ? { choice: k, error: (out && out.text) || 'the database did not take it' } : { choice: k, sent: true });
      } catch (e) {
        qUi.pending.set(uid, { choice: k, error: (e && e.message) || 'no connection' });
      }
      const now = qTurns.get(uid);
      if (now && now.emView && now.emView.state !== 'open') qUi.pending.delete(uid);
      ui.recording.done++;
      repaintQuestions();
    }
    ui.recording = null;
    repaintQuestions();
  }

  // ── The feed «Обращения к базе» (2026-11-15, supabase/migrations/em_request_tasks.sql) ─────────
  // One task — one message (LexMessage.task, ios/Lex/STANDARD.md В7.30). The records of one task carry the
  // same task id from the server; the newest of them carries the look, the others say `merged`. The message
  // stands at the time of the task's last request: a new request brings it down. A task with nothing wrong
  // (`clean`) is off the screen: one line a day at the place of the newest of them — «Ещё 5 задач без
  // замечаний · Show» (В7.4 with a tick); Show brings them back in their places, Hide takes them away.
  let rFeed = false;
  const rTurns = new Map();    // uid → the turn of a record that has its task
  const rUi = {
    open: new Set(),           // tasks whose requests are open
    all: new Set(),            // … with every request, not the first five
    days: new Set(),           // days whose tasks without remarks are shown
  };
  const bubblesOn = () => !!profiChat || !!qFeed || rFeed || emLane != null;
  const atOf = (s) => { const x = Date.parse(s || ''); return Number.isFinite(x) ? x : 0; };
  const dayOfAt = (s) => { const d = new Date(atOf(s)); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
  const plural = (n, one, few, many) => {
    const a = Math.abs(n) % 100;
    const b = a % 10;
    return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many;
  };

  // The tasks of the records on the screen: by id, the look of the newest one.
  function requestTasks() {
    const byId = new Map();
    for (const t of rTurns.values()) {
      const k = t.emEntry && t.emEntry.task;
      if (!k || !k.id) continue;
      const g = byId.get(k.id) || { members: [], look: null, rep: null };
      g.members.push(String(t.uid));
      if (!k.merged && (!g.look || atOf(k.last) >= atOf(g.look.last))) { g.look = k; g.rep = t; }
      byId.set(k.id, g);
    }
    return [...byId.values()].filter((g) => g.look).sort((a, b) => atOf(a.look.last) - atOf(b.look.last));
  }

  function taskNode(g) {
    const id = g.look.id;
    const msg = global.LexMessage.task(g.look, {
      open: rUi.open.has(id),
      all: rUi.all.has(id),
      onToggle: () => {
        if (rUi.open.has(id)) { rUi.open.delete(id); rUi.all.delete(id); } else rUi.open.add(id);
        repaintRequests();
      },
      onMore: () => { rUi.all.add(id); repaintRequests(); },
    });
    const node = el('.wc-turn.wc-turn-em.wc-turn-rq', {}, [msg]);
    node.dataset.uid = String(g.rep.uid);
    node.dataset.uids = g.members.join(' ');
    node.dataset.at = g.look.last;
    node.dataset.in = '1';
    return node;
  }

  // The line of a day's tasks without remarks: «Ещё 5 задач без замечаний · Show» («5 задач без замечаний»
  // when the day has nothing else), shown — «5 задач без замечаний · Hide».
  function cleanLine(day, n, more, shown, at) {
    const words = `${n} ${plural(n, 'задача', 'задачи', 'задач')} без замечаний`;
    const b = global.LexMessage.fold({
      icon: 'check',
      text: !shown && more ? `Ещё ${words}` : words,
      action: shown ? 'Hide' : 'Show',
      onClick: () => {
        if (rUi.days.has(day)) rUi.days.delete(day); else rUi.days.add(day);
        repaintRequests();
      },
    });
    b.setAttribute('aria-expanded', String(shown));
    const node = el('.wc-turn.wc-turn-rq.wc-turn-rq-clean', {}, [b]);
    node.dataset.at = at;
    node.dataset.in = '1';
    return node;
  }

  // The tasks in their places: a task at the time of its last request; a day's line of the tasks without
  // remarks at the place of the newest of them.
  function paintRequests() {
    if (!rFeed) return;
    for (const n of elTurns.querySelectorAll(':scope > .wc-turn-rq')) n.remove();
    const days = new Map();
    for (const g of requestTasks()) {
      const day = dayOfAt(g.look.last);
      const d = days.get(day) || { clean: [], other: 0 };
      if (g.look.clean) d.clean.push(g); else { d.other++; place(taskNode(g)); }
      days.set(day, d);
    }
    for (const [day, d] of days) {
      if (!d.clean.length) continue;
      const shown = rUi.days.has(day);
      if (shown) for (const g of d.clean) place(taskNode(g));
      place(cleanLine(day, d.clean.length, d.other > 0, shown, d.clean[d.clean.length - 1].look.last));
    }
  }
  function repaintRequests() {
    paintRequests();
    remark();
    setEmpty(!elTurns.childElementCount);
    if (stickToBottom) requestAnimationFrame(() => scrollToBottom(false));
  }

  let lastMoney = null;
  let brainHooks = null;
  function paintBrainMarks() {
    const marks = (lastMoney && lastMoney.marks) || new Map();
    const answers = [...elTurns.querySelectorAll('.wc-turn-assistant[data-uid]')];
    const last = answers[answers.length - 1] || null;
    const lastIsEnd = last && !last.classList.contains('is-streaming') && !last.nextElementSibling;
    for (const t of answers) {
      const old = t.querySelector(':scope > .lex-brain-marks');
      if (old) old.remove();
      const list = marks.get(t.dataset.uid);
      if (!list || !global.LexAnswerRow || !global.LexAnswerRow.brainMarksNode) continue;
      const node = global.LexAnswerRow.brainMarksNode(list, {
        isLast: t === last && lastIsEnd,
        onYes: () => brainHooks && brainHooks.onYes && brainHooks.onYes(),
        onCancel: (uid) => (brainHooks && brainHooks.onCancel ? brainHooks.onCancel(uid) : Promise.resolve(null)),
      });
      if (!node) continue;
      const foot = t.querySelector(':scope > .wc-turn-foot');
      if (foot) t.insertBefore(node, foot); else t.append(node);
    }
  }

  // Перерисовать строки под ответами: кнопка модели живёт только под
  // последним ответом, и после каждого добавления, загрузки и отказа её надо
  // перевесить. Под голосовым ответом строки нет вовсе. Правило «какой
  // последний» — общее с расширением (LexAnswerRow.sync).
  // Чья беседа у ответа: '' — урок; иначе ключ отдельного разговора заготовки
  // (у ответа, чей кадр ещё не пришёл, — общий знак «отдельный»).
  function threadOfTurn(t) {
    if (!t) return '';
    return t.dataset.threadKey || (t.classList.contains('wc-turn-apart') ? '?apart' : '');
  }
  function syncFeet() {
    const entries = [];
    const turns = [...elTurns.querySelectorAll('.wc-turn-assistant')];
    // «Последний ответ» — последний В СВОЕЙ беседе: обмены отдельного разговора
    // стоят в той же ленте и могут оказаться ниже последнего ответа урока, но
    // переспрос у урока и у каждой беседы заготовки свой (страница переспрашивает
    // последний ход беседы). В ленте без отдельных разговоров это тот же самый
    // последний ответ, что и раньше.
    const lastOf = new Map();
    for (const t of turns) lastOf.set(threadOfTurn(t), t);
    for (const t of turns) {
      const foot = t.querySelector('.wc-turn-foot');
      if (t.classList.contains('wc-turn-news')) { entries.push({ row: null, eligible: false }); continue; }
      if (t.classList.contains('wc-turn-voice')) {
        // Строки с моделью и копированием под голосовым ответом нет; цена хода
        // (разработчику) встаёт в свой подвал — paintMoney.
        const row = foot ? foot.querySelector('.lex-answer-row') : null;
        if (row) row.remove();
        entries.push({ row: null, eligible: false });
        continue;
      }
      const row = foot ? foot.querySelector('.lex-answer-row') : null;
      entries.push({
        row,
        eligible: !!row && lastOf.get(threadOfTurn(t)) === t
          && !t.classList.contains('is-streaming')
          && !t.classList.contains('wc-turn-error')
          && !t.classList.contains('wc-turn-gate'),
        model: {
          label: global.LexAnswerRow.modelLabel(t.dataset.model || '') || 'Model',
          title: 'Choose a model and re-ask',
          onClick: (btn) => hooks.onPickModel && hooks.onPickModel(btn, t),
        },
      });
    }
    // Отбор «последний» сделан выше, по беседам; общее правило ленты — только
    // «готовый текстовый».
    global.LexAnswerRow.sync(entries, { everyAnswer: true });
  }

  // Прежний ответ вернуть на место: переспрос не дал ни слова (отказ, «стоп»
  // до первого слова). На сервере он не заменён — значит и на экране должен
  // остаться он, а не пустой пузырь.
  function restorePrevious(entry) {
    const prev = entry.retry;
    entry.turn.classList.remove('is-streaming', 'wc-turn-error', 'wc-turn-gate');
    entry.turn.dataset.raw = prev.raw;
    entry.turn.dataset.model = prev.model || '';
    entry.bubble.textContent = '';
    if (prev.raw) WcMarkdown.into(entry.bubble, prev.raw);
    if (prev.raw && global.WcWordPick) WcWordPick.ready(entry.bubble, prev.raw, 'markdown');
  }

  // The line of the work with the database leaves when the answer starts: the words
  // themselves say the model is done looking.
  function clearBrainWork(entry) {
    const line = entry && entry.turn && entry.turn.querySelector(':scope > .wc-brain-work');
    if (line) line.remove();
  }

  const WcThread = {
    init(h) {
      hooks = h || {};
      elThread = document.getElementById('wc-thread');
      elTurns = document.getElementById('wc-turns');
      elEmpty = document.getElementById('wc-empty');
      elJump = document.getElementById('wc-jump');
      // Знак Lex на пустом экране. Приходит из общего с расширением
      // lex-brand-mark.js — одна копия буквы на обе поверхности; в разметке
      // остаётся пустой контейнер.
      const logo = document.getElementById('wc-empty-logo');
      if (logo && global.LexBrandMark) logo.innerHTML = LexBrandMark.svgMarkup(48);

      elThread.addEventListener('scroll', () => {
        stickToBottom = nearBottom();
        elJump.hidden = stickToBottom && backTop === null;
      }, { passive: true });

      // After a press on a quote the button «down» first brings the reader back to where he pressed it (as in
      // Telegram), the next press — to the end.
      elJump.addEventListener('click', () => {
        if (backTop !== null) {
          const top = backTop;
          backTop = null;
          stickToBottom = false;
          elThread.scrollTo({ top, behavior: 'smooth' });
          elJump.hidden = nearBottom();
          return;
        }
        stickToBottom = true;
        elJump.hidden = true;
        scrollToBottom(true);
      });

      WcBus.subscribe((msg) => {
        if (msg.type === 'STREAM_CHUNK') WcThread.chunk(msg);
        else if (msg.type === 'STREAM_DONE') WcThread.done(msg);
        else if (msg.type === 'STREAM_ERROR') WcThread.error(msg);
        else if (msg.type === 'STREAM_TOOL') WcThread.tool(msg);
        else if (msg.type === 'WC_TURN_MODEL') WcThread.setTurnModel(msg);
        else if (msg.type === 'WC_TURN_UIDS') WcThread.setTurnUids(msg);
        else if (msg.type === 'STREAM_USER_TEXT' && msg.bubblePick) WcThread.setLastUserPick(msg.bubblePick, msg.bubbleRest || '');
        else if (msg.type === 'STREAM_USER_TEXT' && msg.laterText) WcThread.setLastUserPreset(msg.laterText);
        // После перерисовки пузыря: куда лёг ход — в урок или в отдельный
        // разговор заготовки (msg.apartKey).
        if (msg.type === 'STREAM_USER_TEXT') WcThread.settleApart(msg.requestId, msg.apartKey || null);
      });
    },

    clear() {
      if (global.WcWordPick) WcWordPick.forgetAll();
      live.clear();
      incoming = null;
      backTop = null;
      elTurns.replaceChildren();
      stickToBottom = true;
      elJump.hidden = true;
      setEmpty(true);
    },

    // The order chat that is open, or null (lex-profi.js createChat). Its turns are bubbles,
    // as in Telegram: the list carries the class of the common parts (lex-message.css).
    setProfiChat(chat) {
      profiChat = chat;
      elTurns.classList.toggle('lex-bubbles', bubblesOn());
    },

    // The feed «Разбор»: which tab is on the screen — 'people', 'work', 'all'; null — not this
    // feed. A record of another tab is off the screen, the day lines and «Новые» stand only over
    // what is shown, and the feed stands on its end, as a chat that just opened.
    setEmLane(lane) {
      const was = emLane;
      emLane = lane || null;
      elTurns.classList.toggle('is-intake', emLane != null);
      elTurns.classList.toggle('lex-bubbles', bubblesOn());
      if (emLane == null) { emOpenUids.clear(); emTurnsByUid.clear(); }
      for (const n of elTurns.querySelectorAll('.wc-turn-em[data-lane]')) n.hidden = !laneShows(n.dataset.lane);
      remark();
      if (emLane != null && was != null && was !== emLane) {
        stickToBottom = true;
        elJump.hidden = true;
        requestAnimationFrame(() => scrollToBottom(false));
      }
    },

    // The press on «База задала тебе вопрос» of a record: (the words of its questions) → the page
    // opens the question.
    setEmQuestion(fn) { emQuestionHook = fn; },

    // The boxes of an order chat, from what the server says now.
    paintProfiBoxes() {
      if (!profiChat) return;
      for (const t of elTurns.querySelectorAll('.wc-turn-assistant[data-uid]')) {
        if (t.classList.contains('is-streaming') || !t.dataset.raw) continue;
        const bubble = t.querySelector('.wc-bubble');
        if (bubble && t.querySelector('.lex-profi-boxes')) profiChat.paintAnswer(t, bubble, t.dataset.raw, WcMarkdown, false);
      }
      profiChat.paintHidden(elTurns);
      // The time under a finished answer and a line of a hidden discussion change the height:
      // a reader at the end stays at the end.
      if (stickToBottom) requestAnimationFrame(() => scrollToBottom(false));
    },


    // Turns came while the chat is open: the screen stays where the person reads.
    repaintKeepingPlace(turns, opts) {
      const atEnd = elThread.scrollTop + elThread.clientHeight >= elThread.scrollHeight - 80;
      const top = elThread.scrollTop;
      WcThread.renderTurns(turns, opts);
      if (!atEnd) {
        stickToBottom = false;
        requestAnimationFrame(() => { elThread.scrollTop = top; });
      }
    },

    shownUids() { return [...elTurns.querySelectorAll('.wc-turn[data-uid]')].map((t) => t.dataset.uid); },

    // «Show in chat» of the sheet of a message (В7.37): the chat goes to the message — it stands in the
    // middle of the screen — and its bubble is lit for 1,5 s (a frame 2 --line-strong). The whole chat is
    // on the screen already (an order chat reads all its turns); a message it does not have — false.
    // opts.back — a press on a quote (block 2): the place the reader was is kept for the button «down».
    showTurn(uid, opts) {
      const node = [...elTurns.querySelectorAll('.wc-turn[data-uid]')].find((n) => n.dataset.uid === String(uid));
      if (!node) return false;
      const was = elThread.scrollTop;
      elThread.scrollTop = Math.max(0, node.offsetTop - (elThread.clientHeight - node.offsetHeight) / 2);
      // The chat did not move (the message was on the screen): there is no place to come back to.
      const moved = Math.abs(elThread.scrollTop - was) > 8;
      if (opts && opts.back && moved) backTop = was;
      stickToBottom = nearBottom();
      elJump.hidden = stickToBottom && backTop === null;
      const lit = node.querySelector('.lex-bubble, .lex-sticker-pic') || node;
      lit.classList.add('is-focus');
      setTimeout(() => lit.classList.remove('is-focus'), 1500);
      return true;
    },

    // A new or extended entry of the open feed: an extended one takes the place of the old,
    // a new one comes at the end. Nothing else of the chat is touched — an answer of the
    // model stays as the stream left it (its text reaches the server a moment later).
    // fn now, or when the reader stops selecting; key — one waiting redraw of a kind, the last one wins.
    whenFree(key, fn) {
      if (!busy()) { fn(); return; }
      waiting.set(key, fn);
    },
    isBusy: () => busy(),

    upsertEmEntry(t) {
      if (busy()) {
        waiting.set(`em:${t && t.uid}`, () => WcThread.upsertEmEntry(t));
        return;
      }
      if (!t || !t.uid) return;
      // The feed of questions: the question changes in its place, a pack gathers again.
      if (qFeed && (t.origin === 'em_question' || t.origin === 'em_status')) {
        if (t.origin === 'em_question') {
          const uid = String(t.uid);
          if (t.deleted) qTurns.delete(uid); else qTurns.set(uid, t);
          if (t.emView && t.emView.state !== 'open') qUi.pending.delete(uid);
        }
        repaintQuestions();
        setEmpty(!elTurns.childElementCount);
        return;
      }
      // The feed of requests: the record joins its task (or leaves it), the tasks stand again.
      if (rFeed && t.origin === 'em_request') {
        const uid = String(t.uid);
        if (!t.deleted && t.emEntry && t.emEntry.task) { rTurns.set(uid, t); repaintRequests(); return; }
        if (rTurns.delete(uid)) { repaintRequests(); if (t.deleted) return; }
      }
      const old = [...elTurns.querySelectorAll('.wc-turn-em[data-uid]')].find((n) => n.dataset.uid === String(t.uid));
      if (t.deleted) { if (old) old.remove(); }
      else if (old) old.replaceWith(emEntryTurn(t));
      else elTurns.append(emEntryTurn(t));
      remark();
      setEmpty(!elTurns.childElementCount);
      if (stickToBottom) requestAnimationFrame(() => scrollToBottom(false));
    },

    // The feed of questions is open: { onAnswer(uid, choice), onReply({ uids, text }) }; null — it is
    // not. Its turns are bubbles: the list carries the class of the common parts (lex-message.css).
    setQuestionsFeed(hooks) {
      qFeed = hooks || null;
      if (!qFeed) { qTurns.clear(); qUi.pending.clear(); qUi.open.clear(); qUi.packs.clear(); }
      elTurns.classList.toggle('lex-bubbles', bubblesOn());
    },

    // The feed «Обращения к базе» is open (true) or not: its records stand as tasks (paintRequests). Its
    // turns are bubbles: the list carries the class of the common parts (lex-message.css).
    setRequestsFeed(on) {
      rFeed = !!on;
      if (!rFeed) { rTurns.clear(); rUi.open.clear(); rUi.all.clear(); rUi.days.clear(); }
      elTurns.classList.toggle('lex-bubbles', bubblesOn());
    },

    // Is this a news chat? The server wrote its first message.
    hasNewsTurn() { return !!elTurns.querySelector('.wc-turn-news'); },

    // ⚠️ THE ONE PLACE WHERE A CHAT DECIDES WHERE IT STANDS WHEN IT IS DRAWN — every chat of the
    // page and of the Mac app comes through here, a new section's chats too. A chat opens at its
    // end (Gennady, 2026-11-14: before, a chat with unread messages opened at the «Новые» line,
    // and an order chat seen for the first time stood at its top or in its middle). The «Новые»
    // line stays as a mark of what came. Two exceptions: a chat that is only the news starts at
    // its first line, and a repaint (keepPlace) keeps the place of a reader who is not at the
    // end — a reader at the end, or on the way there, stays at the end.
    renderTurns(turns, opts) {
      // Read before the old turns go: the frame that brings a chat just opened to its end may
      // not have run yet, and the place of that moment is not where the person reads.
      const keptTop = opts && opts.keepPlace && !stickToBottom && !nearBottom() ? elThread.scrollTop : null;
      if (!(opts && opts.keepPlace)) backTop = null;
      incoming = (opts && opts.incoming) || null;
      // Прежние пузыри сейчас исчезнут — набор выбранных слов держится за них
      // и обязан уйти вместе с ними.
      if (global.WcWordPick) WcWordPick.forgetAll();
      live.clear();
      elTurns.replaceChildren();
      if (profiChat) elTurns.append(profiChat.head());
      // A feed shows its latest entries; the earlier ones come by this button.
      if (opts && opts.emEarlier) {
        const b = el('button.wc-em-earlier', { type: 'button' }, []);
        b.textContent = opts.emEarlier.label || 'Earlier entries';
        b.addEventListener('click', () => opts.emEarlier());
        elTurns.append(b);
      }
      if (qFeed) qTurns.clear();
      if (rFeed) rTurns.clear();
      (turns || []).forEach((t) => {
        // The feed of questions: a question takes its place after the loop (paintQuestions), the
        // server's line after an answer is said by the line of its question.
        if (qFeed && t.origin === 'em_question' && t.uid) { qTurns.set(String(t.uid), t); return; }
        if (qFeed && t.origin === 'em_status') return;
        // The feed of requests: a record with its task takes its place after the loop (paintRequests).
        if (rFeed && t.origin === 'em_request' && t.uid && t.emEntry && t.emEntry.task) { rTurns.set(String(t.uid), t); return; }
        if (t.origin && String(t.origin).indexOf('em_') === 0) {
          elTurns.append(emEntryTurn(t));
          return;
        }
        // The monitor's turns of an order chat: a message of the client, what went to him, a
        // notice of Profi.
        // A chat of a folder: the person's messages and Gennady's, from every messenger; in the chat of a new person
        // also the branch «who is this» — the question of Lex, Gennady's word to it, a line of the system (folder_whois).
        if (profiChat && (t.origin === 'profi_client' || t.origin === 'profi_sent' || t.origin === 'profi_notice'
          || t.origin === 'folder_in' || t.origin === 'folder_out' || t.origin === 'folder_whois')) {
          elTurns.append(profiChat.messageNode(t));
          return;
        }
        // A call with the client of an order (В7.42): the block with its summaries, or a plate.
        if (profiChat && t.origin === 'profi_call' && profiChat.callNode) {
          elTurns.append(profiChat.callNode(t));
          return;
        }
        // t.images is a list of ready object URLs — the backend resolved them
        // from this browser's picture store while loading the conversation.
        if (t.role === 'user') {
          // Скрытая часть хода со словами («Word: "…"\nContext: "…"») уезжает
          // учителю и лежит в беседе, но человеку показывать её нельзя: в
          // живой ленте он видел только напечатанное, и перечитывание обязано
          // вести себя так же. Правило общее с расширением (лента одна и та
          // же: беседа из расширения читается здесь и наоборот).
          let visible = global.WcWordPick ? WcWordPick.visibleText(t.text) : t.text;
          let editText;
          const bub = (t.bubble && t.bubble.pick) ? t.bubble : null;
          const pp = (!bub && t.presetSlot) ? presetParts(t.later) : null;
          if (bub) {
            visible = global.LexWordPick.pickBubbleText(bub.pick, bub.rest);
            editText = bub.rest;
          } else if (pp && pp.line) {
            visible = global.LexWordPick.presetBubbleText(pp);
            editText = pp.phrase;
          }
          // Ход, от которого после этого ничего не осталось, — служебная
          // инструкция выключенного лексического попапа, а не реплика
          // человека. Пустой пузырь на её месте читался бы как «он ничего не
          // сказал». Но картинка без слов — законный вопрос (см.
          // ImageAttachment на iOS), и её дропать нельзя вместе с пустым
          // текстом: без этой оговорки такой ход пропадал из ленты целиком —
          // ни пузыря, ни картинки.
          const hasImage = (Array.isArray(t.images) && t.images.length > 0)
            || (Array.isArray(t.files) && t.files.length > 0);
          if (!hasImage && global.WcWordPick && WcWordPick.isHiddenOnly(visible)) return;
          const node = userTurn(visible, t.images, {
            presetSlot: t.presetSlot || null, editText, files: t.files || null,
            ...(bub ? { pick: bub.pick, rest: bub.rest } : {}),
          });
          if (t.uid) node.dataset.uid = String(t.uid);
          if (t.authoredAt) node.dataset.at = t.authoredAt;
          elTurns.append(node);
          if (t.threadKey) markApart(node, t.threadKey);
        } else {
          // An answer with no word (stopped before the first one, the model said nothing) is not drawn: the
          // question stands alone (docs/spec/20-chat.md, «Остановка хода»).
          if (!String(t.text || '').trim() && t.origin !== 'news' && t.origin !== 'voice') return;
          const { turn } = t.origin === 'news'
            ? newsTurn(t.text, opts && opts.newsHead ? opts.newsHead() : null)
            : assistantTurn(t.text);
          // Сказанное голосом — под ним строки нет (syncFeet).
          if (t.origin === 'voice') turn.classList.add('wc-turn-voice');
          // Модель ответа (из денег беседы) — подпись кнопки модели.
          if (t.model) turn.dataset.model = t.model;
          // Уид реплики: по нему встаёт цена хода (paintMoney).
          if (t.uid) turn.dataset.uid = String(t.uid);
          if (t.authoredAt) turn.dataset.at = t.authoredAt;
          if (t.threadKey) markApart(turn, t.threadKey);
          if (profiChat) profiChat.paintAnswer(turn, turn.querySelector('.wc-bubble'), t.text, WcMarkdown, false);
          elTurns.append(turn);
        }
      });
      paintQuestions();
      paintRequests();
      remark();
      // After the day lines: the line of a hidden discussion stands right over its turns.
      if (profiChat) profiChat.paintHidden(elTurns);
      setEmpty(!elTurns.childElementCount);
      syncFeet();
      // A chat that is only the news starts at its first line. A card that was on
      // screen before its chat came stays where the person is reading.
      const newsOnly = !!(turns && turns.length === 1 && turns[0].origin === 'news');
      // The third exception: a tapped notification of an entry of a feed leads to that entry — a
      // question, or the pack that holds it.
      const focus = opts && opts.focusUid ? [...elTurns.querySelectorAll('.wc-turn[data-uid]')]
        .find((n) => n.dataset.uid === String(opts.focusUid) || (n.dataset.uids || '').split(' ').includes(String(opts.focusUid))) : null;
      const where = keptTop !== null ? keptTop
        : (newsOnly && opts && opts.keepPlace ? elThread.scrollTop : null);
      stickToBottom = !newsOnly && where === null && !focus;
      elJump.hidden = true;
      // After layout, not during: the images have no height yet on this frame.
      requestAnimationFrame(() => {
        if (focus) {
          elThread.scrollTop = Math.max(0, focus.offsetTop - (elThread.clientHeight - focus.offsetHeight) / 2);
          const lit = focus.querySelector('.lex-q') || focus;
          lit.classList.add('is-focus');
          setTimeout(() => lit.classList.remove('is-focus'), 1200);
          elJump.hidden = nearBottom();
        } else if (where !== null) elThread.scrollTop = where;
        else if (newsOnly) elThread.scrollTop = 0;
        else scrollToBottom(false);
      });
    },

    // Something above the turns came late and pushed them: the bottom is where it was.
    keepAtBottom() {
      if (stickToBottom) scrollToBottom(false);
    },

    // Замена хода заготовки пришла первым кадром — последний свой пузырь
    // заготовки перерисовывается строкой и фразой, до первого слова учителя.
    setLastUserPreset(later) {
      const all = [...elTurns.querySelectorAll('.wc-turn-user')];
      const old = all.pop();
      if (!old || !old.dataset.presetSlot) return;
      const pp = presetParts(later);
      if (!pp || !pp.line) return;
      const imgs = [...old.querySelectorAll('.wc-turn-images img')].map((i) => i.src).filter(Boolean);
      const node = userTurn(global.LexWordPick.presetBubbleText(pp), imgs,
        { presetSlot: old.dataset.presetSlot, editText: pp.phrase, files: filesOfNode(old) });
      if (old.dataset.uid) node.dataset.uid = old.dataset.uid;
      old.replaceWith(node);
      carryApart(old, node);
    },

    // Пузырь «translate» из выбранного материала — материалом и допечатанным:
    // сразу при нажатии (wc-app.js) и первым кадром ответа от сервера.
    setLastUserPick(pick, rest) {
      const all = [...elTurns.querySelectorAll('.wc-turn-user')];
      const old = all.pop();
      if (!old || !old.dataset.presetSlot || !pick) return;
      const imgs = [...old.querySelectorAll('.wc-turn-images img')].map((i) => i.src).filter(Boolean);
      const node = userTurn(global.LexWordPick.pickBubbleText(pick, rest), imgs,
        { presetSlot: old.dataset.presetSlot, editText: rest, pick, rest, files: filesOfNode(old) });
      if (old.dataset.uid) node.dataset.uid = old.dataset.uid;
      old.replaceWith(node);
      carryApart(old, node);
    },

    // Отдельный разговор заготовки. При нажатии пилюли (режим из списка) —
    // подпись над последним вопросом сразу (key null); первым кадром сервер
    // говорит, куда ход лёг на самом деле: ключ его беседы — подпись остаётся и
    // ключ ложится на вопрос и на ответ этого хода; кадр без ключа — ход ушёл
    // учителю, подпись снимается.
    markLastUserApart(key) {
      const old = [...elTurns.querySelectorAll('.wc-turn-user')].pop();
      if (old) markApart(old, key || null);
    },
    settleApart(requestId, key) {
      const old = [...elTurns.querySelectorAll('.wc-turn-user')].pop();
      const entry = live.get(requestId);
      if (key) {
        if (old) markApart(old, key);
        if (entry && entry.turn) markApart(entry.turn, key);
      } else if (old && old.classList.contains('wc-turn-apart') && !old.dataset.threadKey) {
        unmarkApart(old);
      }
    },

    appendUser(text, images, opts) {
      setEmpty(false);
      const node = userTurn(text, images, opts);
      node.dataset.at = new Date().toISOString();
      elTurns.append(node);
      remark();
      if (profiChat) profiChat.paintHidden(elTurns);
      stickToBottom = true;
      elJump.hidden = true;
      scrollToBottom(false);
    },

    // ── A message Lex did not take ──────────────────────────────────────────
    // The person's bubble stays in the chat, marked by the common part of messages
    // (LexMessage.unsent): why it did not go and what can be done — Retry, Top up, Edit, Delete.
    setUnsentHook(fn) { onUnsent = typeof fn === 'function' ? fn : null; },

    // The person left the chat while this answer was on its way. Its words are no longer shown,
    // but the request goes on: the server writes the answer, and a refusal still reaches onUnsent.
    detach(requestId) {
      if (!requestId) return;
      live.delete(requestId);
      left.add(requestId);
    },
    // The answer of a left chat ended without a refusal.
    settled(requestId) { left.delete(requestId); },

    // Mark a person's turn as not sent. o — the part's options (lex-message.js, unsent).
    paintUnsent(turn, o) {
      if (!turn) return;
      turn.classList.add('lex-unsent');
      // The part goes into the row AFTER its `> div`, not into it: in an order chat that div is
      // the bubble itself (lex-profi.js, dress), and the part would stand inside the bubble. The
      // class of the row lays the part out under the bubble in both chats (lex-message.css).
      for (const old of turn.querySelectorAll(':scope > .lex-unsent-note, :scope > div > .lex-unsent-note')) old.remove();
      const part = global.LexMessage && typeof global.LexMessage.unsent === 'function'
        ? global.LexMessage.unsent(o)
        : null;
      if (part) { part.classList.add('lex-unsent-note'); turn.append(part); }
      syncFeet();
    },

    // A message kept on this device, put back at the end of the chat when it opens.
    appendUnsent(text, opts, o) {
      setEmpty(false);
      const node = userTurn(text, [], opts);
      node.dataset.at = (opts && opts.at) || new Date().toISOString();
      elTurns.append(node);
      if (o) this.paintUnsent(node, o);
      return node;
    },

    removeTurn(turn) {
      if (!turn || !turn.parentNode) return;
      turn.remove();
      if (!elTurns.querySelector('.wc-turn')) setEmpty(true);
      syncFeet();
    },

    // Переспрос пишется В ТОТ ЖЕ пузырь, а не добавляет второй ответ: это
    // замена ответа, а не ещё один. Прежний текст и модель запоминаются —
    // переспрос без единого слова возвращает их на место (restorePrevious).
    // false — переспрашивать нечего (не последний ответ, голосовой); иначе узел ответа.
    beginRetry(requestId, turn) {
      // Последний ответ ТОЙ ЖЕ беседы (урок или отдельный разговор заготовки):
      // обмен другой беседы ниже него переспросу не мешает.
      const all = [...elTurns.querySelectorAll('.wc-turn-assistant')];
      const own = turn ? threadOfTurn(turn) : null;
      const last = (own === null ? all : all.filter((t) => threadOfTurn(t) === own)).pop();
      if (!last || (turn && turn !== last) || last.classList.contains('wc-turn-voice')) return false;
      const bubble = last.querySelector('.wc-bubble');
      if (!bubble) return false;
      const retry = { raw: last.dataset.raw || '', model: last.dataset.model || '' };
      // Пузырь переписывается — его слова в наборе указывали бы на текст,
      // которого больше нет.
      if (global.WcWordPick) WcWordPick.forgetBubble(bubble);
      bubble.innerHTML = '';
      last.dataset.raw = '';
      last.classList.remove('wc-turn-error');
      last.classList.add('is-streaming');
      live.set(requestId, { turn: last, bubble, text: '', retry });
      syncFeet();
      maybeStick();
      // Сам узел ответа (истинное значение): по его ключу беседы «заново»
      // отдельного разговора заготовки уходит в её беседу.
      return last;
    },

    // Opened before the first token so the reader sees the answer start.
    beginAssistant(requestId, opts) {
      setEmpty(false);
      const { turn, bubble } = assistantTurn('');
      turn.classList.add('is-streaming');
      turn.dataset.at = new Date().toISOString();
      elTurns.append(turn);
      if (profiChat) profiChat.dress(elTurns);
      live.set(requestId, { turn, bubble, text: '' });
      // Пока ответ пишется, «заново» под ним не место — и под предыдущим тоже,
      // он больше не последний.
      syncFeet();
      maybeStick();
    },

    // The model works with the database (Extended Mind): one grey line above the answer
    // says what it asked, until the answer starts or the turn ends.
    tool(msg) {
      const entry = live.get(msg.requestId);
      if (!entry) return;
      let line = entry.turn.querySelector(':scope > .wc-brain-work');
      if (msg.phase === 'start') {
        // A turn of Claude Code by the subscription (msg.cc) says the whole line itself and
        // works on after its first words: the line stands under the growing answer and stays
        // until the turn ends (done / error), changed by every next action.
        if (msg.cc) entry.cc = true;
        if (!line) {
          line = el('.wc-brain-work');
          if (entry.cc) entry.bubble.after(line);
          else entry.turn.insertBefore(line, entry.bubble);
        }
        line.textContent = msg.line || ('Extended Mind: ' + (msg.label || msg.name || 'working'));
        maybeStick();
      }
    },

    chunk(msg) {
      const entry = live.get(msg.requestId);
      if (!entry) return;
      // A frame with no text is how the core reports the model it actually
      // used — it carries _debug_model and nothing else. Rendering it would
      // re-parse the document for no change.
      if (!msg.text) return;
      if (!entry.cc) clearBrainWork(entry);
      entry.text += msg.text;
      entry.turn.dataset.raw = entry.text;
      if (profiChat) profiChat.paintAnswer(entry.turn, entry.bubble, entry.text, WcMarkdown, true);
      else WcMarkdown.into(entry.bubble, entry.text);
      maybeStick();
    },

    // Модель хода — от серверной части в начале хода (WC_TURN_MODEL).
    setTurnModel(msg) {
      const entry = live.get(msg.requestId);
      if (!entry || !msg.modelId) return;
      entry.turn.dataset.model = String(msg.modelId);
    },

    // Уиды пары — от серверной части в начале хода (WC_TURN_UIDS). Ответ —
    // живой пузырь этого хода; вопрос — последний вопрос перед ним (при
    // переспросе вопрос тот же, и уид у него прежний).
    setTurnUids(msg) {
      const entry = live.get(msg.requestId);
      if (!entry) return;
      if (msg.assistantUid) entry.turn.dataset.uid = String(msg.assistantUid);
      if (msg.userUid) {
        let prev = entry.turn.previousElementSibling;
        while (prev && !prev.classList.contains('wc-turn-user')) prev = prev.previousElementSibling;
        if (prev && !prev.dataset.uid) prev.dataset.uid = String(msg.userUid);
      }
    },

    // Деньги беседы на экране: цена под репликой — по готовому уиду, который
    // отдал сервер (list_chat_money, разбор — lex-chat-money.js), и итог
    // беседы в шапке (WcHeader.setMoney). Что показывать и кому, решил сервер
    // (show_money); своего счёта у страницы нет. money === null — беседы нет
    // или денег не показывают: все цены снимаются.
    paintMoney(money) {
      const show = !!(money && money.showMoney);
      for (const t of elTurns.querySelectorAll('.wc-turn[data-uid]')) {
        const old = t.querySelector(':scope > .wc-turn-foot > .wc-price, :scope > div > .wc-turn-foot > .wc-price');
        // An answer of Claude Code by the owner's subscription (claude_code_chats.sql): no
        // price, the words «по подписке» in its place — shown whether prices are or not.
        const any = money && money.answers ? money.answers.get(t.dataset.uid) : null;
        const sub = !!(any && any.subscription === true);
        // «по подписке» under a question is the mark of an empty answer (stopped before the first word, no
        // word at all): there is no answer to put it under and nothing was paid — no mark at all.
        if (sub && t.classList.contains('wc-turn-user')) { if (old) old.remove(); continue; }
        const a = show || sub ? any : null;
        const usd = sub ? 0 : (a && a.billed != null && Number.isFinite(Number(a.billed))) ? Number(a.billed) : null;
        if (usd == null) { if (old) old.remove(); continue; }
        let foot = t.classList.contains('wc-turn-user')
          ? t.querySelector(':scope > div > .wc-turn-foot')
          : t.querySelector(':scope > .wc-turn-foot');
        if (!foot) {
          foot = el('.wc-turn-foot');
          if (t.classList.contains('wc-turn-user')) {
            foot.classList.add('wc-turn-foot-question');
            (t.firstElementChild || t).append(foot);
          } else {
            t.append(foot);
          }
        }
        const node = old || el('span.wc-price');
        // route 'api' — the owner chose API tokens in «+» (claude_route.sql).
        node.textContent = sub ? (any.route === 'api' ? 'токены API' : 'по подписке') : global.LexChatMoney.format(usd);
        node.classList.toggle('wc-price-sub', sub);
        node.dataset.lexUsd = String(usd);
        node.title = [a.model, a.effort].filter(Boolean).join(' · ');
        if (!old) foot.append(node);
      }
      if (global.WcHeader && WcHeader.setMoney) WcHeader.setMoney(show ? money.total : null, show);
      lastMoney = money;
      paintBrainMarks();
    },

    // Пометки под ответами в чатах с базой (lex-answer-row.js, brainMarksNode): «Да» под
    // последним дописанным ответом, сообщения в очереди базы с «Отменить». hooks:
    // onYes() и onCancel(uid) → Promise. setBrainMarks — новые пометки беседы без денег
    // (ответ проверки очереди).
    setBrainHooks(hooks) { brainHooks = hooks || null; },
    setBrainMarks(list) {
      if (!lastMoney) return;
      const marks = new Map();
      for (const m of (Array.isArray(list) ? list : [])) {
        if (!m || !m.uid) continue;
        if (!marks.has(String(m.uid))) marks.set(String(m.uid), []);
        marks.get(String(m.uid)).push(m);
      }
      lastMoney = Object.assign({}, lastMoney, { marks });
      paintBrainMarks();
    },
    brainMarks() { return lastMoney && lastMoney.marks ? lastMoney.marks : new Map(); },

    done(msg) {
      const entry = live.get(msg.requestId);
      if (!entry) return;
      live.delete(msg.requestId);
      clearBrainWork(entry);
      // Переспрос, который не дал ни слова, — прежний ответ остаётся.
      if (entry.retry && !entry.text) {
        restorePrevious(entry);
        syncFeet();
        maybeStick();
        return;
      }
      entry.turn.classList.remove('is-streaming');
      syncFeet();
      // Ответ дописан — вот теперь его можно резать на слова. Раньше нельзя:
      // каждый кадр потока перерисовывает пузырь целиком.
      if (entry.text && global.WcWordPick && !profiChat) WcWordPick.ready(entry.bubble, entry.text, 'markdown');
      // The person pressed «stop» before the first word: the question stays, the empty answer goes and no
      // plaque comes in its place — the press is the explanation (19.11.2026: a red frame with «Stopped
      // before the first word.» under his own «stop» read as a failure). The iPhone drops it the same way
      // (`dropAnswerIfEmpty`); docs/spec/20-chat.md, «Остановка хода».
      if (!entry.text && msg.stopped) {
        entry.turn.remove();
        syncFeet();
        maybeStick();
        return;
      }
      // An answer that ended without a single token is a failure the reader
      // must see; an empty bubble reads as "the model had nothing to say".
      if (!entry.text) {
        entry.turn.classList.add('wc-turn-error');
        entry.bubble.textContent = 'The teacher sent no answer.';
      }
      maybeStick();
    },

    error(msg) {
      const entry = live.get(msg.requestId);
      if (entry) clearBrainWork(entry);
      const text = msg.error || 'Something went wrong.';

      // Кончились деньги — это не сбой, а следующий шаг, и человеку он должен
      // читаться так же, как в расширении: понятная строка и кнопка рядом.
      // Решается ДО развилок ниже: путей отрисовки три (пузырь пустой, ответ
      // начался, пузыря нет вовсе), а случай один.
      //
      // Служебный код (`LEX_BILLING_GATE`) с экрана уходит, но не пропадает:
      // без него в журнале не отличить отказ по деньгам от любого другого.
      const gate = LexBillingGate.isGateError(text);
      if (gate) lexLog('[wc-thread] billing gate:', text);

      // Ответ провайдера («Anthropic 529: {"type":"overloaded_error"}») человеку
      // тоже ничего не говорит — та же расшифровка, что в расширении, из общего
      // lex-error-text.js. Сырая строка уходит с экрана, но пишется в журнал.
      // Промпт не опубликован — сервер отказал ДО провайдера (424 + stage
      // 'prompt'). Не сбой и не перегрузка: заготовку не опубликовали, денег не
      // взяли. Текст берём из общего модуля — тот же, что показывает расширение.
      const promptMissing = !gate && LexErrorText.isPromptMissing(text);
      if (promptMissing) lexLog('[wc-thread] prompt missing:', text);
      // Разговор сброшен разработчиком, пока был открыт здесь (content-reset):
      // сервер отказал до денег, писать в него больше некуда — открыть заново.
      // Текст тот же, что в расширении, из общего модуля.
      // У модели нет цены — сервер отказал до провайдера (424 + stage
      // 'pricing'), денег не взяли. Текст с именем модели — из общего модуля.
      const modelUnpriced = !gate && !promptMissing
        && typeof LexErrorText.isModelUnpriced === 'function' && LexErrorText.isModelUnpriced(text);
      if (modelUnpriced) lexLog('[wc-thread] model unpriced:', text);
      // Чат заказа Profi.ru отказал до модели (424 + stage 'profi'): строку
      // для человека написал сервер, показываем её как есть.
      const profiRefused = !gate && !promptMissing && !modelUnpriced
        && typeof LexErrorText.isProfiRefused === 'function' && LexErrorText.isProfiRefused(text);
      if (profiRefused) lexLog('[wc-thread] profi refused:', text);
      const conversationReset = !gate && !promptMissing && !modelUnpriced && !profiRefused
        && typeof LexErrorText.isConversationReset === 'function' && LexErrorText.isConversationReset(text);
      if (conversationReset) lexLog('[wc-thread] conversation reset:', text);

      const providerText = !gate && !promptMissing && !modelUnpriced && !profiRefused && !conversationReset && LexErrorText.provider(text);
      if (providerText) lexLog('[wc-thread] provider error:', text);
      // Ответ, который переспрашивали, уже переспросили или сняли на другом
      // устройстве — сервер отказал до денег (409 regen_target_gone).
      const regenGone = !gate && typeof LexErrorText.isRegenTargetGone === 'function'
        && LexErrorText.isRegenTargetGone(text);
      // The chat changed under the screen on another device (409 chat_moved): nothing was sent.
      const chatMoved = !gate && !regenGone && typeof LexErrorText.isChatMoved === 'function'
        && LexErrorText.isChatMoved(text);
      const shown = regenGone ? LexErrorText.regenTargetGone()
        : chatMoved ? LexErrorText.chatMoved()
        : promptMissing ? LexErrorText.promptMissing(text)
        : profiRefused ? LexErrorText.profiRefused(text)
        : (modelUnpriced ? LexErrorText.modelUnpriced(text)
          : (conversationReset ? LexErrorText.conversationReset() : (providerText || text)));

      // The person left this chat while Lex was taking the message (WcThread.detach): nothing of
      // it is on the screen now, the page only keeps it (onUnsent without a turn).
      if (!entry && left.has(msg.requestId)) {
        left.delete(msg.requestId);
        if (onUnsent) {
          onUnsent({ requestId: msg.requestId, turn: null,
            note: gate ? global.LexBillingGate.message(text) : shown, money: !!gate, gateRaw: gate ? text : null });
        }
        return;
      }
      const paint = (turn, bubble) => {
        turn.classList.add(gate ? 'wc-turn-gate' : 'wc-turn-error');
        if (gate) {
          bubble.textContent = '';
          // Сырая строка едет в блок: если сервер прислал числа (на ЭТОТ запрос
          // не хватает), человек увидит сколько нужно и сколько есть.
          bubble.append(LexBillingGate.createElement({ raw: text }));
        } else {
          bubble.textContent = shown;
        }
      };

      if (entry) {
        live.delete(msg.requestId);
        entry.turn.classList.remove('is-streaming');
        if (entry.retry && !entry.text) {
          // Переспрос не удался: прежний ответ возвращается на место, а причина
          // (в том числе «пополните») встаёт заметкой под ним. Заметка — не
          // ответ: кнопка модели остаётся у прежнего ответа, и после пополнения
          // переспрашивают его же.
          restorePrevious(entry);
          const note = el('.wc-turn.wc-turn-notice', {}, [el('.wc-bubble')]);
          paint(note, note.firstChild);
          entry.turn.after(note);
          syncFeet();
          maybeStick();
          return;
        }
        if (!entry.text) {
          // Lex did not take the message (Gennady, 2026-11-16): the person's own bubble stays,
          // marked as not sent, with the reason and Retry, as in other chats; the empty answer
          // goes. The page keeps it on this device (wc-app.js, onUnsent), so it is there again
          // when the chat is opened later.
          let ask = entry.turn.previousElementSibling;
          while (ask && !ask.classList.contains('wc-turn-user')) ask = ask.previousElementSibling;
          if (onUnsent && ask) {
            entry.turn.remove();
            onUnsent({
              requestId: msg.requestId,
              turn: ask,
              note: gate ? global.LexBillingGate.message(text) : shown,
              money: !!gate,
              gateRaw: gate ? text : null,
            });
            syncFeet();
            maybeStick();
            return;
          }
          paint(entry.turn, entry.bubble);
          syncFeet();
          maybeStick();
          return;
        }
        // Partial answer already on screen — keep it (it was paid for) and put
        // the failure under it rather than replacing what arrived. Больше в
        // этот пузырь ничего не придёт — значит он дописан, и слова в нём
        // такие же нажимаемые, как в целом ответе.
        if (global.WcWordPick) WcWordPick.ready(entry.bubble, entry.text, 'markdown');
      }
      setEmpty(false);
      const turn = el('.wc-turn', {}, [el('.wc-bubble')]);
      paint(turn, turn.firstChild);
      elTurns.append(turn);
      maybeStick();
    },

    // ── Voice ────────────────────────────────────────────────────────────
    // A spoken exchange writes into the same list as a typed one.
    //
    // ⚠️ ONE BUBBLE PER item_id, and that is the whole fix. This used to be two
    // variables — one "current" user bubble and one "current" assistant bubble
    // — which silently assumed the conversation is strictly alternating. It is
    // not: the teacher hearing itself opens a second utterance while the first
    // answer is still streaming, and with one variable per role the second
    // question appended BELOW an answer whose remaining text kept flowing into
    // the bubble above it. That is exactly the "reply above the question" the
    // owner photographed.
    //
    // Keyed by item_id, a bubble is created once, at the first event that
    // mentions its id, and is filled thereafter no matter what else arrives in
    // between. Document order therefore follows the order the server actually
    // opened the items, which is the order they were spoken.
    //
    // The reader's bubble is opened when the voice detector confirms SPEECH,
    // not when the transcript arrives: transcription is slower than detection,
    // so a bubble created on the transcript would land under the reply to it.
    beginVoiceUser(itemId) {
      if (!itemId || voiceBubbles.has(itemId)) return;
      setEmpty(false);
      const bubble = el('.wc-bubble.is-awaiting', { text: '' });
      // .wc-turn-voice: italic, same as the extension's spoken bubbles
      // (styles.css .ytvocab-chat-msg-voice) — marks it as said, not typed.
      const turn = el('.wc-turn.wc-turn-user.wc-turn-voice', {}, [el('div', {}, [bubble])]);
      turn.dataset.uid = 'voice:' + itemId;
      elTurns.append(turn);
      voiceBubbles.set(itemId, { turn, bubble, role: 'user' });
      maybeStick();
    },

    voiceUserText(itemId, text) {
      if (!itemId) return;
      if (!voiceBubbles.has(itemId)) WcThread.beginVoiceUser(itemId);
      const entry = voiceBubbles.get(itemId);
      if (!entry) return;
      entry.bubble.textContent = text || '';
      // The dots are a placeholder for "heard you, still transcribing"; the
      // moment there are words, it is no longer waiting.
      entry.bubble.classList.toggle('is-awaiting', !text);
      maybeStick();
    },

    // A transcription that failed leaves nothing to show, and an empty bubble
    // reads as "they said nothing".
    dropVoiceUser(itemId) {
      const entry = itemId && voiceBubbles.get(itemId);
      if (!entry) return;
      entry.turn.remove();
      voiceBubbles.delete(itemId);
    },

    voiceAssistantText(itemId, text) {
      if (!itemId) return;
      let entry = voiceBubbles.get(itemId);
      if (!entry) {
        setEmpty(false);
        const made = assistantTurn('');
        made.turn.classList.add('wc-turn-voice');
        // Уид, под которым сервер записал реплику и отдаёт цену хода.
        made.turn.dataset.uid = 'voice:' + itemId;
        elTurns.append(made.turn);
        entry = { turn: made.turn, bubble: made.bubble, role: 'assistant' };
        voiceBubbles.set(itemId, entry);
      }
      entry.turn.dataset.raw = text;
      // С разметкой уже по ходу речи — так же, как эта реплика выглядит после
      // перезагрузки (WcMarkdown) и как в расширении: **give up** жирным,
      // звёздочки на экран не выходят. Пометка, у которой пара ещё не
      // доехала, не показывается (lex-open-markers.js — правило общее с
      // расширением), иначе полупришедший текст мигал бы звёздочками.
      WcMarkdown.into(entry.bubble, global.LexOpenMarkers ? global.LexOpenMarkers.hide(text) : text);
      syncFeet();
      maybeStick();
    },

    // Голос Google: ответ набежал на экран, а не прозвучало из него ничего
    // (обрыв раньше первого звука хода) — в беседу он не лёг, пузырь уходит.
    dropVoiceAssistant(itemId) {
      const entry = itemId && voiceBubbles.get(itemId);
      if (!entry || entry.role !== 'assistant') return;
      entry.turn.remove();
      voiceBubbles.delete(itemId);
      syncFeet();
    },

    // Called once when the whole conversation ends, not per turn: a bubble has
    // to stay addressable for as long as its item can still receive a late
    // final transcript.
    endVoice() {
      voiceBubbles.forEach((entry) => {
        // Anything still showing the waiting dots never got a transcript.
        if (entry.role === 'user' && !entry.bubble.textContent) entry.turn.remove();
        // Сказанное — тоже сообщение в этой ленте, и слова в нём нажимаются
        // так же. Режем ЗДЕСЬ, а не по ходу разговора: пока он идёт, обе
        // стороны переписывают свои пузыри на каждом кадре расшифровки.
        // Ответ учителя нарисован разметкой (voiceAssistantText) — источник
        // для слов тот же сырой текст и тот же вид, что у напечатанного
        // ответа: иначе выключенные слова склеили бы абзацы и сняли жирное.
        else if (global.WcWordPick) {
          if (entry.role === 'assistant' && entry.turn.dataset.raw) WcWordPick.ready(entry.bubble, entry.turn.dataset.raw, 'markdown');
          else WcWordPick.ready(entry.bubble, entry.bubble.textContent, 'text');
        }
      });
      voiceBubbles.clear();
    },

    // Used when the keyboard opens: the last thing said must stay in view.
    scrollToEnd() { scrollToBottom(false); stickToBottom = true; elJump.hidden = true; },

    // True while any stream is open — the composer asks before deciding
    // whether its button says "send" or "stop".
    isStreaming() { return live.size > 0; },
    // Текст реплики с этим уидом на экране — или null, если её там нет.
    // Сверка ленты с беседой после голосового разговора (voice/feed-check.js).
    shownTextOf(uid) {
      const turn = [...elTurns.querySelectorAll('.wc-turn[data-uid]')].find((t) => t.dataset.uid === String(uid));
      const bubble = turn && turn.querySelector('.wc-bubble');
      return bubble ? (bubble.textContent || '') : null;
    },

    // Сколько знаков ответа человек УЖЕ ВИДИТ на экране. Печатающего буфера у
    // страницы нет — пришедшее рисуется сразу, — поэтому увиденное и есть весь
    // накопленный текст пузыря. Спрашивает «стоп»: это число уезжает серверу,
    // и он режет по нему реплику учителя.
    seenChars(requestId) {
      const entry = live.get(requestId);
      return entry ? String(entry.text || '').length : 0;
    },

    // Ровно та же проверка, что setEmpty() уже использует внутри renderTurns():
    // есть ли в открытой сейчас беседе хоть одно сообщение. Единственный
    // источник правды для решения про клавиатуру у боковой панели (wc-app.js).
    isEmpty() { return !elTurns.childElementCount; },

    // Сколько ответов учителя в ленте — первый ход беседы узнаётся по этому.
    answerCount() { return elTurns.querySelectorAll('.wc-turn-assistant').length; },
  };

  global.WcThread = WcThread;
})(typeof self !== 'undefined' ? self : globalThis);
