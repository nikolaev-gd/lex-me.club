// webchat/wc-app.js — the boot file and the only place that holds state.
//
// Every other module renders or asks; this one decides. The rule that keeps
// them honest: a UI module never calls WcBus directly for anything that
// changes state — it calls a hook here, and this file is the single place
// where "which conversation is open" is written down.
//
// ── Conversation identity ────────────────────────────────────────────────────
// A conversation's key is '__lex_standalone__<sessions.id>', minted on the
// FIRST message. That is the same formula the extension uses, and it is the
// entire reason a conversation started here shows up there. Two consequences
// that are easy to get wrong:
//   · a brand-new, unsent conversation has NO id — it is not a row anywhere
//     yet, and the sidebar must not invent one for it;
//   · reopening a past conversation PINS its old key. Minting a fresh billing
//     session for an existing thread splits it in two.
(function (global) {
  'use strict';

  const { toast } = WcUI;

  // The one place the sign-in module is named. lex-web-auth.js is shared with
  // lex-me.club — same localStorage key, so /app, /account and /checkout are
  // one login — and aliasing it here means a native shell that authenticates
  // differently replaces one line rather than every call site.
  const WcAuth = global.LexWebAuth;

  // ── A window of one chat (2026-11-23, lex-chat-window.js, STANDARD.md В7.79) ──────────────────────
  // ?window=chat&key=… — this page is a window of that chat alone: its head, the feed, the field, alive as
  // every chat of the page. No panel, no main page, no ☰, no arrow back (wc-app.css, html[data-lex-window]);
  // the chat opens by the path of a notification (openFromNotification) instead of the place the Mac app keeps,
  // and this window keeps no place of its own: the main window of the Mac app does.
  const soloChat = global.LexChatWindow ? global.LexChatWindow.solo() : null;
  if (soloChat) {
    document.documentElement.dataset.lexWindow = 'chat';
    // The solo view of the corner of the bar (В7.76): neither the three lines nor the arrow back.
    document.documentElement.dataset.lexSolo = '1';
  }

  const state = {
    conversationId: null,    // null = a new, not yet sent conversation
    conversations: [],
    // Курсор следующей порции списка. null со `convsDone: false` — «ещё не
    // читали»; null со `convsDone: true` — «список кончился».
    convsCursor: null,
    convsDone: false,
    convsLoading: false,
    // Список не прочитался. ОТДЕЛЬНОЕ состояние от пустого списка: пустой
    // список — это правда про аккаунт, а отказ сети — это «мы не знаем», и
    // рисовать по нему «бесед нет» значит врать человеку про его собственные
    // беседы.
    convsError: null,
    account: { signedIn: false },
    requestId: null,
  };

  let reqSeq = 0;
  const nextRequestId = () => 'wc-' + Date.now() + '-' + (++reqSeq);

  // ── Data ──────────────────────────────────────────────────────────────────

  // The balance: in the first frame as this device kept it (lex-reads.js), until the server has
  // answered once; after that every reading is the server's alone.
  let accountRead = false;
  async function refreshAccount(onFirst) {
    try {
      await readBus('WC_ACCOUNT_STATE', {}, (acc, fresh) => {
        if (!acc) return;
        // The server refused the pass of this device for good (the session is gone): the page
        // starts again and shows the form. Its first frame came from the copy and the pass held.
        if (fresh && acc.signedIn === false) { global.location.reload(); return; }
        if (fresh) accountRead = true;
        state.account = acc;
        WcHeader.setAccount(state.account);
        if (typeof onFirst === 'function') onFirst();
      }, () => !accountRead);
    } catch (err) {
      // A failure to READ the balance is not a failure to be signed in. Saying
      // "signed out" here would throw the person back to the login form over a
      // blinked wifi connection.
      console.warn('[wc] account state:', err && err.message);
      state.account = Object.assign({}, state.account, { error: String(err && err.message) });
      WcHeader.setAccount(state.account);
    }
  }

  // ── Список бесед: порциями, а не целиком ──────────────────────────────────
  //
  // `reset` (умолчание) — перечитать с первой порции: так открывается страница
  // и так же отвечаем на WC_CONVERSATIONS_CHANGED. Именно ПЕРЕЧИТАТЬ, а не
  // дописать: беседа, получившая новую реплику, прыгает наверх, и дописывание
  // оставило бы её на старом месте вторым экземпляром.
  //
  // Без `reset` — дозагрузка следующей порции по прокрутке.
  // onFirst — the list stands in the panel: from the copy, or from the answer (the start waits
  // for this, not for the answer).
  async function loadConversations(reset, onFirst) {
    // Один запрос за раз. Без этого быстрая прокрутка посылает пять
    // перекрывающихся запросов с одним и тем же курсором — и в списке
    // появляются повторы.
    // A reading from the start asked while another is on its way (a signal «chats» during the
    // reading of the start) comes after it: the reading on its way may predate the change.
    if (state.convsLoading) { if (reset) state.convsAgain = true; return; }
    if (!reset && (state.convsDone || !state.convsCursor)) return;
    state.convsLoading = true;
    const adopt = (r) => {
      const items = (r && r.ok && r.items) ? r.items : [];
      if (reset) {
        state.conversations = items;
      } else {
        // Сервер отдаёт строго убывающую пару (last_at, id), но беседа могла
        // прыгнуть наверх между двумя запросами — тогда она приедет дважды.
        // Ключ у беседы один, поэтому повтор виден и отбрасывается здесь.
        const have = new Set(state.conversations.map((c) => c.id));
        state.conversations = state.conversations.concat(items.filter((it) => !have.has(it.id)));
      }
      state.convsCursor = (r && r.cursor) || null;
      // Конец — это ЛИБО слово сервера, ЛИБО отсутствие курсора. Без второго
      // условия пустая порция оставила бы прокрутку дёргать сервер вечно.
      state.convsDone = !!(r && r.done) || !state.convsCursor;
      state.convsError = null;
    };
    try {
      if (reset) {
        // The first portion as this device kept it (lex-reads.js) while the panel holds nothing
        // yet — the page has just opened: the list stands before the server answers, and the
        // answer takes its place. Further portions wait for the answer.
        await readBus('WC_LIST_CONVERSATIONS', { cursor: null }, (r, fresh) => {
          adopt(r);
          if (fresh) return;
          state.convsDone = true;
          WcSidebar.setItems(state.conversations, state.conversationId, { error: null, done: true });
          syncTitle();
          if (typeof onFirst === 'function') onFirst();
        }, () => !state.conversations.length);
      } else {
        adopt(await WcBus.call('WC_LIST_CONVERSATIONS', { cursor: state.convsCursor }));
      }
    } catch (err) {
      console.warn('[wc] conversations:', err && err.message);
      // Порция не пришла. Уже показанное НЕ стираем: половина списка лучше,
      // чем пустая шторка. А вот сказать, что случилось, обязаны — иначе
      // человек видит молчаливо оборванный список.
      state.convsError = String((err && err.message) || err);
      // The first portion failed too: what is on the screen — kept from the last time or read
      // before — stays, with the words and «Retry» under it. These are the person's own chats,
      // and an empty panel would say there are none. Another person's list is never here: the
      // page reloads on a sign-out (signOut).
      // Прокрутка не должна долбить сервер после отказа; кнопка «Retry» в
      // шторке зовёт loadConversations заново.
      state.convsDone = true;
    } finally {
      state.convsLoading = false;
    }

    WcSidebar.setItems(state.conversations, state.conversationId, {
      error: state.convsError,
      done: state.convsDone,
    });
    syncTitle();
    // The archive of the panel (chat_archive.sql) is read with the first portion: its row and its list.
    if (reset) loadArchived();

    // Имена для безымянных доезжают ПОСЛЕ того, как список уже на экране —
    // см. врезку про два прохода в wc-backend.js. Не ждём их: шторка годна с
    // той секунды, как пришла порция, а ожидание имён убрало бы с экрана весь
    // список ради подписей к нему.
    WcBus.call('WC_FILL_TITLES', { items: state.conversations })
      .catch((err) => console.warn('[wc] titles:', err && err.message));
    if (state.convsAgain) { state.convsAgain = false; await loadConversations(true); }
  }

  let archivedReading = null;
  function loadArchived() {
    if (archivedReading) return archivedReading;
    archivedReading = WcBus.call('WC_LIST_ARCHIVED', {})
      .then((r) => { if (r && r.ok && Array.isArray(r.items)) WcSidebar.setArchived(r.items); })
      .catch((err) => console.warn('[wc] archive:', err && err.message))
      .finally(() => { archivedReading = null; });
    return archivedReading;
  }
  const refreshConversations = (onFirst) => loadConversations(true, typeof onFirst === 'function' ? onFirst : null);
  const loadMoreConversations = () => loadConversations(false);

  function currentItem() {
    return state.conversations.find((c) => c.id === state.conversationId) || null;
  }

  function syncTitle() {
    const it = currentItem();
    // No conversation open = genuinely a new chat. An OPEN one always has a
    // name to show, even when nobody gave it one — see conversationTitle.
    if (!it) { WcHeader.setTitle(''); return; }
    WcHeader.setTitle(WcUI.conversationTitle(it).text);
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  // ── Опубликованный набор: перечитываем при открытии беседы ───────────────
  //
  // Владелец правит настройки в расширении и отправляет их кнопкой публикации
  // у полосы. `enterApp` забирает отправленное один раз, и другого повода
  // сходить за ним у страницы не было: окно, открытое раньше публикации,
  // работало прежними значениями до перезагрузки. У программы для Мака это же
  // окно живёт сутками, и «перезагрузить страницу» там означает перезапустить
  // программу.
  //
  // Повод — тот же, что у телефона (`ChatStore.openConversation` / `reset` в
  // `ios/Lex`): человек открыл беседу или начал новую. Одно правило на две
  // поверхности, и оттого их поведение сходится, а не расходится.
  //
  // Ответа не ждём: беседа открывается своим чередом, набор ложится в память
  // рядом. Перерисовывать нечего — всё, что приезжает набором (модель, слоты
  // промптов, ручки, распознавалка диктовки), читается в тот миг, когда
  // понадобилось: на отправке хода и на нажатии микрофона.
  function refreshPublished() {
    WcBackend.adoptPublished().catch((err) =>
      console.warn('[wc] published settings:', err && err.message));
    // Модель по умолчанию — отдельным вопросом к серверу: публикация её больше
    // не подменяет, решение «личная или рекомендуемая» принимает база.
    WcBackend.modelDefaults().catch((err) =>
      console.warn('[wc] model defaults:', err && err.message));
  }

  // ── Chats where messages come without the person ───────────────────────
  // The feeds and questions of Extended Mind and the order chats of Profi.ru. The server
  // keeps when each was last open (lex_chat_seen): opening one takes that moment and sets
  // a new one, and the «Новые» line stands over the first message that came after it. The
  // moment stays for the whole visit — a repaint does not move the line — and leaving the
  // chat, or the page going to the background, marks what came meanwhile as read.
  // The kind by the key is the table of the profiles of chats (lex-chat-profile.js): a feed, the questions, a chat of
  // the folders, an order chat.
  const INCOMING_KINDS = ['feed', 'questions', 'person', 'order'];
  const isIncomingKey = (key) => !!key && !!global.LexChatProfile && INCOMING_KINDS.includes(global.LexChatProfile.kindOfKey(key));
  let visit = null;   // { key, since }
  async function beginVisit(key) {
    if (visit && visit.key === key) return;
    endVisit();
    if (!isIncomingKey(key)) return;
    const v = { key, since: null };
    visit = v;
    try { v.since = await newsRpc('lex_chat_seen', { p_chat_key: key }); } catch (err) {
      console.warn('[wc] seen:', err && err.message);
    }
  }
  // A chat of a section that came with its item: the moment it was last open came with it,
  // and the press itself takes it on the server (profi_item, lex_em_feed_item with p_take).
  function beginVisitFrom(key, since) {
    if (visit && visit.key === key) return;
    endVisit();
    if (!isIncomingKey(key)) return;
    visit = { key, since: since || null };
  }
  function endVisit() {
    const v = visit;
    visit = null;
    if (!v) return;
    // Once the moment is written, the sections read the chat again for their next press.
    newsRpc('lex_chat_seen', { p_chat_key: v.key })
      .then(() => { for (const s of Object.values(SECTIONS)) if (s.live && s.live.visited) s.live.visited(v.key); })
      .catch(() => {});
  }
  function incomingOpts() {
    return visit && visit.key === state.conversationId ? { since: visit.since } : null;
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && visit) newsRpc('lex_chat_seen', { p_chat_key: visit.key }).catch(() => {});
  });

  // Прочитанную беседу — на экран. Общий у открытия беседы и у сверки ленты
  // после голосового разговора.
  function paintConversation(r, opts) {
    resetMoney();
    // A news paints its source into the bar again as it is drawn (newsHead); any other chat has none.
    paintNewsBar(null);
    // The feed «Разбор» stands under its tabs from its first frame (syncIntakeTabs below).
    syncIntakeTabs(state.conversationId === INTAKE_KEY);
    WcThread.renderTurns(r.turns, {
      newsHead, keepPlace: !!(opts && opts.keepPlace), emEarlier: emEarlierOf(r), incoming: incomingOpts(),
      // A tapped notification of an entry of a feed: the chat stands on that entry.
      focusUid: (opts && !opts.keepPlace && opts.focusUid) || null,
      // An answer the server writes now stands as the stream — from the server's answer, not from
      // this device's copy (opts.kept).
      follow: !(opts && opts.kept),
    });
    followRunning();
    // Деньги беседы пришли тем же заходом — цены под ответами и итог.
    if (r.money && global.LexChatMoney) WcThread.paintMoney(global.LexChatMoney.normalize(r.money));
    // A message on its way: its state as the queue of the database has it now, once — when the marks are known (they
    // come with the money: without it here, the first money of the chat asks, moneyRefresher above).
    if (r.money) { brainAsked = state.conversationId; brainLook.now(); }
    // Messages Lex did not take stand at the end of the chat again.
    restoreUnsent(r).catch((err) => console.warn('[wc] unsent:', err && err.message));
  }

  // The open chat got a message on another device (the signal «chats»): it is read, and painted
  // again only if the screen lacks a message the server has (LexVoiceFeedCheck.missingTurns) —
  // the page's own answer, already on the screen, paints nothing. Not while an answer or a voice
  // conversation is drawn: its own end reads the chat.
  let catchUpTimer = null;
  function catchUpOpenChat(id) {
    if (!id || !global.LexVoiceFeedCheck || !global.LexVoiceFeedCheck.missingTurns) return;
    clearTimeout(catchUpTimer);
    catchUpTimer = setTimeout(async () => {
      const moved = () => state.conversationId !== id || WcThread.isStreaming()
        || !!(global.WcVoice && (WcVoice.active || WcVoice.connecting));
      if (moved()) return;
      const r = await WcBus.call('WC_LOAD_CONVERSATION', { id }).catch(() => null);
      if (!r || !r.ok || moved()) return;
      const missing = global.LexVoiceFeedCheck.missingTurns(r.turns, (uid) => WcThread.shownTextOf(uid));
      if (!missing.length) return;
      WcThread.whenFree('catch-up', () => { if (!moved()) paintConversation(r, { keepPlace: true }); });
    }, 300);
  }

  // Разговор голосом кончился — лента сверяется с беседой на сервере
  // (2026-10-14). Реплики разговора пишет в беседу серверный слушатель, а на
  // экран они едут событиями по каналу разговора, и событие может не доехать:
  // канал переподключался, слушатель встал на звонок поздно, рассылка стояла.
  // Не хватает реплик — беседа рисуется заново, как при открытии; всё сошлось
  // — не трогаем ничего. Правило сравнения — общее с расширением
  // (voice/feed-check.js).
  function reconcileAfterVoice(id) {
    if (!id || !global.LexVoiceFeedCheck) return;
    // Лента уже не про этот разговор: другая беседа, новый разговор или ответ
    // учителя текстом — их пузыри перерисовка снесла бы.
    const moved = () => state.conversationId !== id || WcThread.isStreaming()
      || !!(global.WcVoice && (WcVoice.active || WcVoice.connecting));
    const check = async () => {
      if (moved()) return;
      const r = await WcBus.call('WC_LOAD_CONVERSATION', { id }).catch(() => null);
      if (!r || !r.ok || moved()) return;
      const missing = global.LexVoiceFeedCheck.missingVoiceTurns(r.turns, (uid) => WcThread.shownTextOf(uid));
      if (!missing.length) return;
      console.warn(`[wc-voice] the feed lacked ${missing.length} voice turn(s) the server wrote — repainting from the conversation`, missing);
      paintConversation(r);
    };
    for (const ms of global.LexVoiceFeedCheck.DELAYS_MS) setTimeout(() => { check().catch(() => {}); }, ms);
  }

  // The openings of chats in order: only the last one moves the screen. openWait — the chat on
  // the screen came from this device's copy, and whether the server's answer is in.
  let openSeq = 0;
  let openWait = null;   // { id, done: Promise of true once the answer is in }
  // The settings of the start (enterApp): a turn waits for them, nothing on the screen does.
  let settingsReady = Promise.resolve();
  async function openConversation(id, opts) {
    // Leaving a conversation mid-answer does not cut the answer (Gennady, 2026-11-16: «нужно,
    // чтобы всегда отвечала»): the page stops showing it, the server writes it to its end, and
    // the chat shows it whole when opened again. No question asked: nothing is lost.
    if (WcThread.isStreaming()) leaveStream();
    refreshPublished();
    // Уход из беседы (решение владельца 2026-09-09, docs/spec/30-voice.md):
    // открыли ДРУГУЮ беседу — живой разговор кончился, микрофон закрыт. Именно
    // другую: повторный выбор той же строки уходом не считается. Дожидаемся ДО
    // загрузки: stop() дописывает последний обмен в память беседы, и лента
    // новой не должна рисоваться поверх ещё живого разговора.
    if (id !== state.conversationId) await endVoiceOnLeave('open-chat');
    if (!(opts && opts.wanted)) stopSectionOpening();
    // A chat of a section may come with everything already (opts.loaded: the item the section
    // holds or has just read, lex_chat_open): then nothing is asked of the server here.
    const loaded = opts && opts.loaded;
    const mine = ++openSeq;
    const current = () => openSeq === mine && !(opts && opts.wanted && !opts.wanted());
    // The chat stands on the screen: the first frame of it, from the copy or from the answer.
    let stood = false;
    const stand = (r, again, kept) => {
      if (!stood) {
        // The field is this chat's from now: the last chat's words go to its draft, this one's come.
        takeField(id);
        leaveSection();
        state.conversationId = id;
        paintHome();
        if (opts && opts.back) sectionBack.cameFrom(opts.back);
      }
      if (opts && opts.profi) {
        if (!stood) enterProfiChat(opts.profi);
        opts.profi.words = monitorWords(r.turns);
      }
      paintConversation(r, Object.assign({}, opts, again ? { keepPlace: true } : {}, kept ? { kept: true } : {}));
      if (!stood) {
        WcSidebar.setActive(id);
        WcSidebar.close();
      }
      syncTitle();
      syncAttachment();
      paintAddressee();
      stood = true;
    };
    let answer;
    let copy = null;
    if (loaded) {
      answer = WcBus.call('WC_ADOPT_CONVERSATION', { id, conversation: loaded.conversation, money: loaded.money, marks: loaded.marks });
    } else {
      // An ordinary chat: the copy this device kept goes on the screen at once (lex-reads.js),
      // and the server's answer takes its place. The person's next turn waits for the answer
      // (openWait in send): its context is the server's, not the copy's.
      answer = WcBus.call('WC_LOAD_CONVERSATION', { id });
      openWait = { id, done: answer.then((x) => !!(x && x.ok), () => false) };
      // The chat read anew where it stands (opts.again: a signal of its answers): the screen is newer
      // than any copy — an answer just ended stands whole on it, its copy still holds it cut — so the
      // copy is not drawn over it; the server's answer repaints it in its place.
      if (!(opts && opts.again)) copy = await Promise.race([
        WcBus.call('WC_LOAD_CONVERSATION', { id, kept: true }).catch(() => null),
        answer.then(() => null, () => null),
      ]);
      if (copy && copy.ok && current()) stand(copy, false, true);
      else copy = null;
    }
    const again = !!(opts && opts.again) && state.conversationId === id;
    let r;
    try {
      r = await answer;
    } catch (err) {
      if (current()) toast((copy ? 'The chat is shown as it was the last time: ' : 'Could not open the chat: ') + (err && err.message), { error: true });
      return;
    }
    if (!r || !r.ok) { if (current() && !copy) toast('The chat did not open', { error: true }); return; }
    if (!current()) return;
    if (loaded) beginVisitFrom(id, loaded.since);
    else await beginVisit(id);
    if (!current()) return;
    // The answer is the copy, unchanged: what stands is right as it is — unless it has an answer the
    // server writes now, which the copy never draws as the stream, or a development task still running,
    // whose Stop the copy never draws either (LexMessage.devTaskRunning).
    if (copy && JSON.stringify(copy.turns) === JSON.stringify(r.turns) && !incomingOpts()
      && !r.turns.some((t) => t && t.live && t.opId)
      && !(global.LexMessage && LexMessage.devTaskRunning && LexMessage.devTaskRunning(r.turns))) {
      if (r.money && global.LexChatMoney) WcThread.paintMoney(global.LexChatMoney.normalize(r.money));
      return;
    }
    stand(r, !!copy || again);
  }

  // ── The database's signals (2026-11-13) ─────────────────────────────────
  // One channel for the page (lex-account-events.js): the database tells it at once that
  // something of the account changed (supabase/migrations/account_signals.sql). The sections,
  // an open feed of Extended Mind, an order chat, the marks under an answer, the price under
  // an answer, the balance and a top-up read again at its signals and once when it opens
  // again after a break; nothing on this page asks the server on a timer whether there is
  // something new (Gennady, 2026-11-13). The channel opens with the app (enterApp).
  const signals = global.LexAccountEvents.create({
    url: WcAuth.supabaseUrl(),
    key: WcAuth.anonKey(),
    token: () => WcAuth.validToken(),
    log: (...a) => console.log('[wc] signals:', ...a),
  });
  global.WcSignals = signals;

  // ── Деньги беседы ───────────────────────────────────────────────────────
  // Всё, что лента знает о деньгах, приходит с сервера (list_chat_money):
  // цена под репликой по готовому уиду и итог беседы. После платного события
  // деньги перечитываются (lex-chat-money.js) по сигналам базы, пока строка
  // расхода не доехала. Смена беседы начинает новую эпоху: ответ для прежней
  // беседы на экран не попадёт.
  const turnUids = new Map();
  let moneyEpoch = 0;
  // Беседа, о сообщениях в пути которой база уже спрошена при открытии.
  let brainAsked = null;
  const moneyRefresher = global.LexChatMoney ? global.LexChatMoney.createRefresher({
    load: async () => {
      const ep = moneyEpoch;
      const r = await WcBus.call('WC_CHAT_MONEY', {}).catch(() => null);
      return (ep === moneyEpoch && r && r.ok) ? r.body : null;
    },
    apply: (_key, money) => {
      WcThread.paintMoney(money);
      // Once per open chat the queue of the database itself is asked about a message on its
      // way; after that its state comes with the signal «marks» (brainLook below), never by a timer.
      if (brainAsked !== state.conversationId) { brainAsked = state.conversationId; brainLook.now(); }
    },
    currentKey: () => 'open:' + moneyEpoch,
    signals,
    chatKey: () => state.conversationId,
  }) : null;
  function requestMoney(r) {
    if (moneyRefresher) moneyRefresher.request(Object.assign({ key: 'open:' + moneyEpoch }, r || {}));
  }
  // ── Согласие Геннадия в чатах с базой (supabase/migrations/brain_consent.sql) ──
  // «Да» под ответом отправляет «Да» следующим сообщением — то же «да» словами, что
  // просит база. «Отменить» отменяет сообщение в очереди базы (llm-proxy, brain-action).
  // Ушло ли сообщение, говорит сама база: каждая смена задачи в её очереди приходит лентой
  // Extended Mind, сервер ставит состояние пометки, и база шлёт сигнал «marks» — страница
  // перечитывает пометки беседы (lex_chat_marks).
  // С 20.11.2026 сообщение человеку, которое подготовила модель, стоит под ответом окошком
  // (lex-draft-box.js, В7.51): долгое нажатие отправляет, Edit меняет текст, Cancel снимает
  // ждущее. Каждое действие — один вызов brain-action с видом пометки окошка; ответ несёт список
  // пометок беседы целиком и ложится на экран сразу. Пока окошко в пути (отправляется, ждёт, идёт;
  // и старая пометка send в ждёт и идёт), каждая смена его задачи приходит сигналом «marks»; по
  // таймеру очередь базы не спрашивается (решение Геннадия 21.11.2026). Сама очередь — один раз при
  // открытии беседы и после обрыва канала (LexDraftBox.look); неудавшееся чтение повторяется по
  // лесенке разделов (LexSection.AGAIN_MS). Черновик, который ждёт долгого нажатия, не спрашивается.
  function applyBrainMarks(list) {
    if (!Array.isArray(list)) return;
    if (global.LexDraftBox && global.LexDraftBox.sameMarks(WcThread.brainMarks(), list)) return;
    WcThread.setBrainMarks(list);
  }
  const brainLook = global.LexDraftBox ? global.LexDraftBox.look({
    open: () => !!state.conversationId,
    alive: () => global.LexDraftBox.aliveIn(WcThread.brainMarks()),
    ask: async () => {
      const key = state.conversationId;
      if (!key) return;
      const r = await newsPost('brain-action', { op: 'status', chatKey: key });
      if (state.conversationId === key && r) applyBrainMarks(r.marks);
    },
  }) : { now() {}, stop() {} };
  // The marks of the open chat, read when the signal «marks» names it.
  async function readBrainMarks() {
    const key = state.conversationId;
    if (!key) return;
    const marks = await newsRpc('lex_chat_marks', { p_chat_key: key });
    if (state.conversationId === key) applyBrainMarks(marks);
  }
  signals.follow(['marks'], (signal) => {
    const key = state.conversationId;
    if (!key) return;
    if (!signal) { brainLook.now(); return; }
    if (!signal.payload || signal.payload.chat !== key) return;
    brainLook.now(readBrainMarks);
  });
  // Один вызов окошка: тот же brain-action, что у «Отменить», с видом пометки окошка. Ответ сервера —
  // как есть ({ ok, state, text, busy, marks }); не дошли до сервера — Error с причиной. Список пометок
  // ответа чужой беседы на экран не попадает.
  async function draftCall(body) {
    const key = state.conversationId;
    const r = await newsPost('brain-action', Object.assign({ chatKey: key }, body));
    if (!r) throw new Error('No answer.');
    return state.conversationId === key ? r : Object.assign({}, r, { marks: null });
  }
  // The windows of the base go by the one door of a message to a person (LexDraftBox.door, its kind 'brain'): the
  // same answer, errors and repeat on no answer as a box of an order chat or of a chat of the folders.
  const brainDoor = global.LexDraftBox && global.LexChatProfile
    ? global.LexDraftBox.door({ profile: global.LexChatProfile.profileOfKind('main'), brain: draftCall }) : null;
  const draftBoxes = brainDoor ? global.LexDraftBox.create({
    send: (m) => brainDoor.send(m),
    text: (m, text) => brainDoor.text(m, text),
    cancel: (m) => brainDoor.cancel(m),
    apply: applyBrainMarks,
    copy: (text) => copyText(text),
  }) : null;
  let draftChat = null;
  WcThread.setBrainHooks({
    onYes: () => { send('Да'); },
    onCancel: async (uid) => {
      const key = state.conversationId;
      const r = await newsPost('brain-action', { op: 'cancel', chatKey: key, turnUid: uid });
      if (state.conversationId === key && r) applyBrainMarks(r.marks);
      return r;
    },
    boxes: draftBoxes,
  });

  // Метка дела над ответом: перенести ход в другое дело беседы или в новое (lex_chat_branch_set).
  WcThread.setBranchHooks({
    onMove: async (opId, branchId, newTitle) => {
      const key = state.conversationId;
      if (!key) return false;
      const r = await newsRpc('lex_chat_branch_set', { p_chat_key: key, p_op_id: opId, p_branch_id: branchId, p_new_title: newTitle }).catch(() => null);
      const ok = !!(r && r.ok);
      if (ok && state.conversationId === key) requestMoney();
      return ok;
    },
  });

  function resetMoney() {
    brainAsked = null;
    moneyEpoch++;
    brainLook.stop();
    // Слова, набранные в окошке, и его строки живут, пока открыта та же беседа: перерисовка ленты их не трогает.
    if (draftBoxes && draftChat !== state.conversationId) { draftBoxes.reset(); draftChat = state.conversationId; }
    if (moneyRefresher) moneyRefresher.cancel();
    WcThread.paintMoney(null);
  }

  // ── Sections ─────────────────────────────────────────────────────────────
  // A section is a frame of lex-section.js. Here is only where it stands on this page: it
  // takes the place of the thread and the composer, an item opens as an ordinary chat, and
  // the arrow in the top bar comes back. A section stays alive under the chat, so it comes
  // back at the same place. A new section is one more line in SECTIONS.
  const newsRpc = (name, args) => WcBus.call('WC_NEWS_RPC', { name, args });
  const newsPost = (kind, body) => WcBus.call('WC_NEWS_POST', { kind, body });
  const copyText = (text) => navigator.clipboard.writeText(text).then(() => true, () => false);
  // ── What a screen shows: the copy on this device first (lex-reads.js) ──────
  // Every screen of this page shows the server's answers through read(): the copy this device
  // kept draws its first frame, after a restart too, and the server's answer takes its place.
  // The copies are written where the page calls the server (wc-history.js), for every name in
  // LexReads.KEPT, and nowhere else. readBus — the same for a read with a message of its own
  // (a chat, the list of chats, the balance): the message with «kept» answers from the copy.
  const kept = (name, args) => WcBus.call('WC_KEPT', { name, args }).catch(() => null);
  const keep = (name, args, value) => WcBus.call('WC_KEEP', { name, args, value }).catch(() => false);
  const read = (name, args, show, empty) => global.LexReads.twice(
    () => kept(name, args), () => newsRpc(name, args), show, empty);
  const readBus = (type, msg, show, empty) => global.LexReads.twice(
    () => WcBus.call(type, Object.assign({}, msg, { kept: true })).catch(() => null),
    () => WcBus.call(type, msg), show, empty);
  // The arrow in the top bar: one rule for every section, see lex-back.js.
  const sectionBack = global.LexBack.createBack(() => document.getElementById('wc-news-back'));
  // The corner of the bar (В7.76): the three lines, the arrow right of them.
  global.LexBack.corner(document.getElementById('wc-sidebar-open'), document.getElementById('wc-news-back'));
  const SECTIONS = {
    em: { title: 'Extended Mind', build: buildEm, leave: leaveEmFeed },
    news: { title: 'News', build: buildNews },
    profi: { title: 'Clients', build: buildProfi, dropsStream: true, leave: leaveProfiChat },
    // Questions: a button of its own (2026-11-17), it opens the feed of questions of the database
    // itself, the one Extended Mind held before; no list of its own.
    questions: { title: 'Questions', opens: () => openQuestions() },
    // Agents (21.11.2026): the agents of the base, a folder of task chats for each (wc-agents.js). A task chat of it
    // follows the signals through this section while it is open; left, it stops.
    agents: { title: 'Agents', build: buildAgents, leave: () => { if (SECTIONS.agents.live) SECTIONS.agents.live.unwatch(); } },
    // Calendar (22.11.2026): the calendar of the base, as the iPhone has it (wc-calendar.js); the server names it for 'web'
    // (lex_home_sections, calendar_on_page.sql). Its head stands in the bar of the window, as the head of News
    // (paintCalendarHead).
    calendar: { title: 'Calendar', build: buildCalendar },
    // Shopping list (22.11.2026): one list of the base, a checklist (wc-shopping.js).
    shopping: { title: 'Shopping list', build: buildShopping },
  };
  // A folder of chats (Kolya, Other; lex-folders.js) is a section the server names 'folder:<id>' with
  // its title (lex_home_sections): its entry here is made when the server names it. It has no screen of its own: its
  // chats stand on the main page, and the section is what keeps their lines and the open chat of the folder alive.
  function folderSection(id, title) {
    if (!/^folder:[a-z][a-z0-9_]{0,30}$/.test(String(id || ''))) return null;
    if (!SECTIONS[id]) {
      SECTIONS[id] = { title: title || id.slice(7), build: () => buildFolder(id), leave: leaveFolderChat, folder: id.slice(7) };
    } else if (title) SECTIONS[id].title = title;
    return SECTIONS[id];
  }
  const sectionTarget = (id) => ({ title: SECTIONS[id].title, go: () => showSection(id, { back: true }) });
  // The main page (paintHome) is the empty chat of Lex with the chats of the people on it: the way back from a chat of a
  // person, from the chat of new orders, the bot's chat and the settings of Profi.ru, and from whatever a notification opens
  // (20.11.2026: no notification leads to a list of a section).
  const mainTarget = () => ({ title: 'Chats', go: () => newConversation() });
  // The way back from an order chat: opened from the main page (opts.from) — to the main page; opened from the chat of new
  // orders or from a report — to that screen of Profi.ru, where it stands as it was left.
  const profiBack = (opts) => (opts && opts.from === 'people' ? mainTarget() : sectionTarget('profi'));
  let sectionOn = null;
  // The entries of the sections in the menu of chats (LexSection.entries): the open section's line stands chosen.
  let entries = { setActive() {} };
  function sectionEls() {
    return {
      main: document.querySelector('.wc-main'),
      host: document.getElementById('wc-section-host'),
    };
  }
  function stopSectionOpening() {
    for (const s of Object.values(SECTIONS)) if (s.live) s.live.stopOpening();
  }
  function leaveSection() {
    const { main, host } = sectionEls();
    if (sectionOn) SECTIONS[sectionOn].live.hide();
    sectionOn = null;
    entries.setActive(null);
    host.hidden = true;
    sectionBack.clear();
    main.classList.remove('is-section', 'is-news-opening');
    paintNewsBar(null);
    for (const s of Object.values(SECTIONS)) if (s.leave) s.leave();
    paintHome();
  }
  // A section is built once and stays: built ahead of its first showing it already holds its
  // list, and «Profi.ru» shows it with nothing to wait for.
  function ensureSection(id) {
    const section = SECTIONS[id];
    if (!section.live) {
      section.live = section.build();
      section.live.el.hidden = true;
      sectionEls().host.appendChild(section.live.el);
    }
    return section.live;
  }
  // opts.back — the way back from a chat of the section: it stands where it was left. Without
  // it the section is entered (its line, a notification), and News reads its feed anew.
  // opts.enter(live) — the screen the section is entered on (Profi.ru: its feed, its bot's chat, its settings): it is
  // said before the section is on the screen, so that the first screen of the section is never seen on the way.
  // opts.wanted() — turns false when the person went elsewhere meanwhile, and then nothing moves.
  async function showSection(id, opts) {
    const { main, host } = sectionEls();
    const section = SECTIONS[id];
    await endVoiceOnLeave('news');
    if (opts && opts.wanted && !opts.wanted()) return;
    if (section.dropsStream && WcThread.isStreaming()) leaveStream();
    // A section has no field: the words of the chat left go to its draft.
    takeField(null);
    leaveSection();
    ensureSection(id);
    if (opts && opts.enter) opts.enter(section.live);
    for (const el of host.children) el.hidden = el !== section.live.el;
    sectionOn = id;
    entries.setActive(id);
    host.hidden = false;
    main.classList.add('is-section');
    paintHome();
    WcSidebar.close();
    await section.live.show({ back: !!(opts && opts.back) });
  }
  // A screen of Profi.ru over the main page: 'feed' (at `order`, or at its top), 'bot' or 'settings'. The arrow leads back to
  // the main page (lex-profi.js, enter). wanted — see showSection.
  const showProfi = (screen, order, wanted) => showSection('profi', { enter: (live) => live.enter(screen, order), wanted });
  // ── The main page: the chats with people (lex-people.js) ───────────────────
  // An account that has chats with people starts on the empty chat of Lex with them on it: the tabs All, Clients, Kolya
  // in the bar and one list under them, in the place of the empty thread (paintHome). The sections of the people (Profi.ru
  // and the folders) the server names become the tabs and the list, and have no button in the panel on the left; the rest
  // of the sections (Questions, Extended Mind, News) stay buttons there. A line of the list is the line of its section,
  // and a press opens the chat the way that section does, with the arrow back to the main page.
  const people = global.LexPeople.create({
    tabsHost: document.getElementById('wc-people-tabs'),
    listHost: document.getElementById('wc-home'),
    tabs: (o) => WcUI.tabs(o),
    read,
    signals,
    live: (id) => (SECTIONS[id] && SECTIONS[id].build ? ensureSection(id) : null),
    // The chat of new orders, the bot's chat and the settings are screens of Profi.ru: they open over the main page, and the
    // arrow leads back to it.
    showFeed: (order) => showProfi('feed', order || null),
    showBot: () => showProfi('bot'),
    notify: (text) => toast(text, { error: true }),
    gear: (on) => { document.getElementById('wc-people-gear').hidden = !on; },
    // The archive of the main page: the arrow of the window leads back to the list (lex-people.js, chat_archive.sql).
    back: (target) => {
      if (target) sectionBack.cameFrom(target);
      else if (sectionBack.target && sectionBack.target.archive) sectionBack.clear();
    },
  });
  document.getElementById('wc-people-gear').addEventListener('click', () => { showProfi('settings'); });
  // The main page is on the screen: an account that has chats with people, a new empty chat of Lex, no section, no chat of
  // a person. The first message sent takes the page away (the thread is not empty then, WcThread.onEmpty).
  function homeOn() {
    // The field over a dimmed screen (В7.64) holds the screen it was opened on: a voice or a dictation that made the new
    // chat on the server before a word was sent does not take the main page away from under the dimming.
    if (quick) return quick.home;
    return people.hasTabs && !sectionOn && !state.conversationId && !profiChat && WcThread.isEmpty();
  }
  // What the main page changes on the screen: its list and its tabs show or hide, the list follows the server only while
  // it is on the screen, and it stands where it was left. Asked from every place that changes what the screen holds; the
  // asks of one turn of the page make one painting, after it.
  let homeAsked = false;
  let homeScroll = 0;
  // «New chat» and a notification: the main page is «All», at the top of its list (lex-people.js, toAll).
  function homeToAll() {
    homeScroll = 0;
    const listBody = document.querySelector('#wc-home .lex-section-body');
    if (listBody) listBody.scrollTop = 0;
    people.toAll();
  }
  function paintHome() {
    if (homeAsked) return;
    homeAsked = true;
    Promise.resolve().then(() => { homeAsked = false; applyHome(); });
  }
  function applyHome() {
    paintSplit();
    const main = document.querySelector('.wc-main');
    const bar = document.querySelector('.wc-topbar');
    const host = document.getElementById('wc-home');
    const tabsHost = document.getElementById('wc-people-tabs');
    if (!main || !bar || !host || !tabsHost) return;
    const on = homeOn();
    const was = main.classList.contains('is-home');
    const listBody = host.querySelector('.lex-section-body');
    if (was && !on && listBody) homeScroll = listBody.scrollTop;
    const showTabs = on && people.hasTabRow;
    main.classList.toggle('is-home', on);
    host.hidden = !on;
    tabsHost.hidden = !showTabs;
    // The bar has a line of tabs of its own under its buttons (the feed «Разбор» has one too).
    bar.classList.toggle('has-tabs', showTabs || !document.getElementById('wc-em-tabs').hidden);
    people.setActive(on);
    if (on && !was && listBody) listBody.scrollTop = homeScroll;
    paintCapsule();
  }

  // ── The capsule of a new chat and the field over a dimmed screen (В7.64; Gennady 22.11.2026, boards Comp2*) ──────
  // Out of a chat — the main page, a screen of a section — the capsule stands at the bottom right: the microphone, the
  // live voice, «New chat». A press dims the screen and lifts the one field of the page over it (wc-quick.js); a new chat
  // is made only when the words are sent (send → quickCommit), by the voice — when its first words went to the model
  // (quickLanded). A press on the dimming or Escape closes the field, and no chat is made (closeQuick). On every screen of
  // an agent — its folder, its journal, its passport (boards Comp2Agent, Comp2AgentOpen) — «New chat» and the microphone
  // start a chat with that agent; the voice — with Lex (an agent takes only words). Nothing of the screen goes to the
  // chat. In an open chat there is no capsule: its own field stands.
  let quick = null;   // { home, agent, section, before } while the field stands over a dimmed screen
  const outOfChat = () => !!(people.hasTabs && homeOnNow()) || (!!sectionOn && !profiChat);
  // The field over the dimming begins a chat with an agent: what the field offers is that agent's (its model in
  // «+ → Text model», words only — no voice, no picture, no file).
  const quickAgentOn = () => (quick && quick.agent) || null;

  // ── The profile of what is open (lex-chat-profile.js; docs/spec/21-chat-canvas.md, «Профиль чата») ───────────────
  // The field over a screen of an agent and a task chat of an agent — the agent's; an order chat and a chat of the
  // folders — the one the server brought with the chat (`profile` of profi_item, folder_item; the table by its key and
  // its folder's kind for an older server); a feed of the base, a news — their rows; everything else is the main chat.
  // What the profile does not give is not drawn: the field takes the profile (WcComposer.setProfile → LexComposer.paint:
  // the presets, the microphone, the voice button, «new chat», the items of «+», the held arrow).
  function openProfile() {
    const P = global.LexChatProfile;
    if (!P) return null;
    const main = document.querySelector('.wc-main');
    const has = (cls) => !!(main && main.classList.contains(cls));
    if (quickAgentOn()) return P.profileOfKind('agent');
    if (profiChat && profiChat.data) return P.profileOf(profiChat.data.chatKey, profiChat.data);
    if (has('is-em-feed')) return P.profileOfKind(P.kindOfKey(state.conversationId) === 'questions' ? 'questions' : 'feed');
    if (has('is-news-chat')) return P.profileOfKind('news');
    return P.profileOfKind('main');
  }
  function paintFieldProfile() {
    const p = openProfile();
    if (p) WcComposer.setProfile(p);
  }
  // Every way into and out of a chat changes a class of the main column (is-profi-chat, is-agent-chat, is-em-feed,
  // is-news-chat, is-quick-agent): the profile is painted again after each. Started by boot().
  function watchFieldProfile() {
    const main = document.querySelector('.wc-main');
    if (!main || !global.MutationObserver) return;
    new MutationObserver(paintFieldProfile).observe(main, { attributes: true, attributeFilter: ['class'] });
    paintFieldProfile();
  }
  function homeOnNow() {
    return people.hasTabs && !sectionOn && !state.conversationId && !profiChat && WcThread.isEmpty();
  }
  function quickAgent() {
    // The agent whose screens are open — `currentAgent()` of the section Agents ({ key, name } | null on the list).
    const live = sectionOn === 'agents' && SECTIONS.agents.live;
    return (live && typeof live.currentAgent === 'function' && live.currentAgent()) || null;
  }
  function paintCapsule() {
    if (global.WcQuick) WcQuick.capsule(!quick && outOfChat());
  }
  async function openQuick(mode) {
    if (quick || !outOfChat()) return;
    const agent = mode === 'voice' ? null : quickAgent();
    quick = { home: homeOnNow(), agent, section: sectionOn, before: null };
    if (agent) {
      takeField(agentDraftKey(agent.key));
    } else {
      // Under a section the page may still hold the chat left last: the new chat is made ready, the screen stays.
      if (state.conversationId || profiChat || !WcThread.isEmpty()) await newConversation({ stay: true });
      takeField(newChatKey());
    }
    if (!quick) return;
    // The field may have taken this key before the drafts were read (the page starts on the main page, whose field is
    // hidden): an empty field takes the draft now, so a draft kept over a reload is there.
    const kept = fieldKey && global.LexDrafts ? global.LexDrafts.get(fieldKey) : null;
    if (kept && (kept.text || kept.reply) && !WcComposer.text().trim()) fillField(kept);
    WcQuick.open({ to: agent ? (agent.name || agent.key) : 'Lex', agent: !!agent });
    WcComposer.refresh();   // an agent's field: no live voice, the slot folds (wc-app.css, .is-quick-agent)
    paintCapsule();
    if (mode === 'voice') { await toggleVoice(); return; }
    if (mode === 'dictate') { quick.before = WcComposer.text(); WcComposer.dictate(); return; }
    WcComposer.focus({ raiseKeyboard: true });
  }
  // The words are sent (or the voice's first words went): the screen becomes the new chat. Called before send() reads
  // whose words these are, so they go to the new chat, not to the one left. An agent's: its empty chat (newAgentChat) —
  // the same field, the same draft.
  async function quickCommit() {
    const q = quick;
    if (!q) return;
    quick = null;
    WcQuick.close();
    WcComposer.refresh();
    if (q.agent) { await newAgentChat(q.agent); return; }
    if (sectionOn) leaveSection();
    paintHome();
  }
  function quickLanded() { if (quick && !quick.agent) quickCommit().catch(() => {}); }
  // Closed without sending: a dictation going on is dropped with its words, a voice not yet heard ends, an empty chat a
  // voice or a dictation made on the server does not take the screen. The words typed stay the new chat's draft.
  async function closeQuick() {
    const q = quick;
    if (!q) return;
    if (WcComposer.isDictating()) {
      WcComposer.cancelDictation();
      if (q.before !== null) WcComposer.setText(q.before);
    }
    await endVoiceOnLeave('quick-closed');
    WcComposer.blur();
    quick = null;
    WcQuick.close();
    WcComposer.refresh();
    if (!q.agent && !profiChat && state.conversationId && WcThread.isEmpty()) {
      // A live dictation or the voice made its conversation at the press, and the field's draft went over to it
      // (`adoptFieldKey`). No chat was made: the words go back to the draft of the new chat, so the next «New chat» has
      // them — not to a conversation nobody can open (found by a live run on the Second Mac, 22.11.2026).
      if (fieldKey && String(fieldKey) === String(state.conversationId)) {
        saveField();
        if (global.LexDrafts) global.LexDrafts.rename(fieldKey, newChatKey());
        fieldKey = newChatKey();
      }
      await newConversation({ stay: true });
    }
    if (!q.home) takeField(null);
    paintHome();
  }
  // The buttons of the sections: from what this device kept, then as the server names them.
  // Every section the server names is then built and its list read (warm), so its first
  // showing waits for nothing. News reads its own feed when shown (it keeps it itself).
  // Settled when the sections are known (kept copy or the server's answer, or a failed read): a notification that
  // launched the page waits for it (`openFromNotification`), so it opens over the main page, on «All», in its section.
  let sectionsKnown = null;
  const sectionsKnownPromise = new Promise((resolve) => { sectionsKnown = resolve; });
  async function loadSections() {
    try { await loadSectionsNow(); } finally { sectionsKnown(); }
  }
  async function loadSectionsNow() {
    const draw = (list) => {
      for (const s of Array.isArray(list) ? list : []) if (s && String(s.id || '').startsWith('folder:')) folderSection(s.id, s.title);
      people.setSections(list);
      paintHome();
      // An entry only for a section this page opens: a section the server names before its screen is built here has none.
      const buttons = (Array.isArray(list) ? list : []).filter((s) => s && !people.isPeople(s.id) && SECTIONS[s.id]);
      entries = global.LexNews.renderEntries(document.getElementById('wc-sections'), buttons, (id) => {
        if (SECTIONS[id] && SECTIONS[id].opens) SECTIONS[id].opens();
        else if (SECTIONS[id]) showSection(id);
      });
      entries.setActive(sectionOn);
    };
    let drawn = null;
    let sections = null;
    // The sections this page knows: the server names no other. The copy this device kept in the
    // first frame, the server's answer after it (lex-reads.js).
    try {
      sections = await read('lex_home_sections', { p_surface: 'web', p_known: ['em', 'profi', 'news', 'folders', 'questions', 'agents', 'calendar', 'shopping'] }, (list, fresh, same) => {
        if (!Array.isArray(list) || same) return;
        drawn = list;
        draw(list);
      });
    } catch (err) {
      console.warn('[wc] sections:', err && err.message);
    }
    if (!drawn) draw([]);
    for (const s of (Array.isArray(sections) ? sections : (drawn || []))) {
      if (String(s.id || '').startsWith('folder:')) folderSection(s.id, s.title);
      if (!SECTIONS[s.id] || s.id === 'news' || !SECTIONS[s.id].build) continue;
      const live = ensureSection(s.id);
      if (live.warm) live.warm().catch((err) => console.warn('[wc] warm:', err && err.message));
    }
    // The one list of the people is read too, so that the first opening of the panel has it.
    if (people.hasTabs) people.warm();
  }

  // ── What is on the screen, for the iPhone's notifications (2026-11-11) ────
  // The server sends no notification about a chat that is open on some screen of the
  // account. This page (the browser and the Mac app) says which chat it shows while the
  // tab is visible: at once on a change, and every 30 s while it stays. The chat key of
  // an order chat is its conversation key; a section's own screen is no chat.
  const presenceDevice = (() => {
    try {
      let v = localStorage.getItem('lexDeviceId');
      if (!v) { v = 'web-' + (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())); localStorage.setItem('lexDeviceId', v); }
      return v;
    } catch (_) { return 'web-' + String(Date.now()); }
  })();
  let presenceSent;
  let presenceAt = 0;
  function presenceKey() {
    if (document.visibilityState !== 'visible') return null;
    // The list of new orders is a screen of its own for the server: open, it takes the
    // notifications about orders off every device (2026-11-13).
    if (sectionOn === 'profi' && SECTIONS.profi.live && SECTIONS.profi.live.screen === 'feed') return '__lex_profi_orders__';
    // The bot's service chat is a screen of its own for the server too: open, it reads the alerts (19.11.2026).
    if (sectionOn === 'profi' && SECTIONS.profi.live && SECTIONS.profi.live.screen === 'bot') return '__lex_profi_bot__';
    // The calendar on the screen takes its notifications as read on every device (unread_counts.sql: the key of the
    // calendar is the section «calendar»).
    if (sectionOn === 'calendar') return '__lex_calendar__';
    if (sectionOn) return null;
    return state.conversationId || null;
  }
  function reportPresence() {
    const key = presenceKey();
    // The screen is looked at here anyway: the place the Mac app opens at next time (keepScreenPlace). A hidden
    // window keeps the place it was hidden at.
    if (document.visibilityState === 'visible') keepScreenPlace();
    const due = key && Date.now() - presenceAt > 30000;
    if (key === presenceSent && !due) return;
    presenceSent = key;
    presenceAt = Date.now();
    // The answer brings the numbers of the unread after the chat on the screen took its own (В7.48).
    newsRpc('lex_chat_presence', { p_device: presenceDevice, p_chat_key: key, p_surface: 'web' })
      .then((r) => { if (r && r.unread) takeUnread(r.unread); })
      .catch(() => {});
  }
  // The numbers of the unread from the server: the rows and the section buttons, and the number on the icon of the
  // Mac app in the Dock — the same number as the iPhone's (`badge`, the calendar counted too: the page has the section
  // «Calendar» since 22.11.2026, calendar_on_page.sql; lex_push_badge_mac answers that number as well).
  const macBadgeOf = (u) => (u && u.badge != null ? u.badge : null);
  function takeUnread(u) {
    if (global.LexSection) global.LexSection.setUnread(u);
    people.repaintTabs();
    const n = macBadgeOf(u);
    if (n != null) shellBadge(Number(n) || 0);
  }
  // The numbers of the unread (supabase/migrations/unread_counts.sql): at the start, at every signal
  // «unread» of the account (a message came or was seen on any device) and after the channel opens again.
  async function readUnread() {
    try {
      const r = await newsRpc('lex_missed_summary', {});
      if (r && r.unread) takeUnread(r.unread);
    } catch (err) {
      console.warn('[wc] unread:', err && err.message);
    }
  }
  setInterval(reportPresence, 3000);
  document.addEventListener('visibilitychange', reportPresence);

  // ── Notifications of the Mac app (2026-11-13) ────────────────────────────
  // The Mac app (macos/Sources/LexShell/PushNotifications.swift) gets an address from
  // Apple; this page gives it to the server with its own sign-in (lex_push_register), and
  // the server sends the Mac the same notifications as the iPhone. A click on one comes
  // back here and opens what it is about, as a tap does on the iPhone. In a browser there
  // is no Mac app and nothing of this runs.
  let shellPushToken = null;
  let shellPushSaid = null;
  let notificationOpens = 0;
  function tellShell(word) {
    try {
      const h = global.webkit && global.webkit.messageHandlers && global.webkit.messageHandlers.lexshell;
      if (h && typeof h.postMessage === 'function') { h.postMessage(word); return true; }
    } catch (_) { /* no Mac app */ }
    return false;
  }
  // A Mac app of 2026-11-17 on (part 5 of «Уведомления и непрочитанное») shows the number of the unread on its icon in
  // the Dock and does the buttons of its notifications through this page (__lexShellAction): its mark says `badge`.
  const shellShowsBadge = () => !!(global.__lexShell && global.__lexShell.badge);
  let shellBadgeSaid = null;
  function shellBadge(n) {
    if (!shellShowsBadge() || n === shellBadgeSaid) return;
    if (tellShell({ word: 'badge', n })) shellBadgeSaid = n;
  }
  function shellPush(p) {
    if (!p || !p.token || !p.env) return;
    const said = `${p.token}|${p.env}|${p.bundle || ''}`;
    if (said === shellPushSaid) return;
    newsRpc('lex_push_register', { p_token: p.token, p_env: p.env, p_bundle: p.bundle || '' }).then(() => {
      shellPushToken = p.token;
      shellPushSaid = said;
      // This build shows the number: the notifications to its address carry it from now on, and a chat read on any
      // screen sends it the number alone (lex_push_badge_on, as the iPhone). The answer is the number now.
      if (!p.badge) return null;
      return newsRpc('lex_push_badge_on', { p_token: p.token }).then((r) => {
        const n = macBadgeOf(r);
        if (n != null) shellBadge(Number(n) || 0);
      });
    }).catch((e) => console.warn('[wc] push address:', e && e.message));
  }
  // The words of a refusal for a notification of the Mac: the server's own message, not its code.
  function refusalWords(err) {
    const raw = String((err && err.message) || '');
    const m = raw.match(/\{[\s\S]*\}\s*$/);
    if (m) {
      try {
        const o = JSON.parse(m[0]);
        const words = o && (o.message || o.error);
        if (words) return String(words).slice(0, 200);
      } catch (_) { /* below */ }
    }
    return /^HTTP \d/.test(raw) ? 'The server of Lex did not take it.' : raw.slice(0, 200);
  }
  // A button on a notification of the Mac app (PushNotifications.swift): the same calls as the same buttons of this
  // page, with its sign-in — Cancel and Send of a new order (profi_command, as New orders), Cancel of the bot's short
  // message while he is busy (profi_busy_command, as the card in the order chat), «Send to <name>» of a
  // draft after a call (profi_send, as holding the button under the draft), and the words typed into the field of a
  // message a person wrote (profi_send_text in an order chat, folder-send in a chat of a folder, as Send of the chat).
  // Pressing Send there is Gennady's «yes» to that text, as in the chat; the text goes through the queue of actions of
  // the server. The answer is { ok, why }: a press that did not reach the server comes back to the person as a
  // notification of its own.
  async function shellAction(a) {
    const what = String((a && a.do) || '');
    try {
      if (what === 'cancel' || what === 'send_draft') {
        if (!a.order) return { ok: false };
        await newsRpc('profi_command', {
          p_op_id: global.LexProfi.newOpId(), p_kind: what, p_order: String(a.order),
          p_args: what === 'cancel' ? { pressed_at: Date.now() / 1000 } : {},
        });
        return { ok: true };
      }
      if (what === 'busy_cancel') {
        // Cancel on «While you're busy» (the bot's short message to a client): the bot is told with the job the
        // button was made for and its word is waited for — a text that has gone meanwhile is not «cancelled».
        if (!a.order) return { ok: false };
        const r = await global.LexProfi.busyCommand(newsRpc, a.order, 'cancel', String(a.job || ''));
        return r.ok ? { ok: true } : { ok: false, why: String(r.error || '').slice(0, 200) };
      }
      // A box sent and a reply written from a notification go by the one door of a message to a person
      // (LexDraftBox.door) of the chat they belong to: an order chat — profi_*, a chat of the folders — folder-send.
      const doorFor = (kind, key, order) => global.LexDraftBox.door({
        profile: global.LexChatProfile.profileOfKind(kind), rpc: newsRpc,
        folderSend: (body) => WcBus.call('WC_FOLDER_SEND', { body }),
        chatKey: () => key || null, order: () => (order != null ? String(order) : null),
      });
      const done = (r) => (r && r.ok === false ? { ok: false, why: String(r.text || '').slice(0, 200) } : null);
      if (what === 'call_send') {
        if (!a.window) return { ok: false };
        const no = done(await doorFor('order', null, a.order).send({ id: String(a.window) }));
        return no || { ok: true };
      }
      if (what === 'reply') {
        const text = String(a.text || '').trim();
        const key = String(a.chatKey || '');
        if (!text) return { ok: false };
        let no = null;
        if (key.startsWith('__lex_profi__') && a.order) {
          no = done(await doorFor('order', key, a.order).direct(text, {}));
        } else if (WcHistory.isFolderKey(key)) {
          no = done(await doorFor('person', key, null).direct(text, {}));
        } else {
          return { ok: false, why: 'This chat takes no reply from a notification.' };
        }
        if (no) return no;
        // The chat on the screen shows its new message at once.
        if (key === state.conversationId) {
          if (key.startsWith('__lex_profi__')) refreshProfiChat().catch(() => {});
          else refreshFolderChat().catch(() => {});
        }
        return { ok: true };
      }
      return { ok: false, why: 'Lex does not know this button.' };
    } catch (err) {
      console.warn('[wc] notification button:', what, err && err.message);
      return { ok: false, why: refusalWords(err) };
    }
  }
  // What a notification is about (the `lex` part push-send puts in it) → the screen. ANY tap (Gennady, 20.11.2026) first puts
  // the main page on «All», at the top of its list (`homeToAll`; the tab pressed is not kept), then opens what the notification
  // is about over the main page, the way a row of «All» opens it, and the arrow back leads to the main page. No notification
  // leads to the list of a section (Profi.ru, a folder, Extended Mind): the screens of Profi.ru it opens come straight over the
  // main page, and a chat opens without any section on the way. An account without chats of people has no main page: there the
  // feeds and the conversations open as they did before it.
  // The arrow after a notification (Gennady, 24.11.2026: «стрелочка назад … возвращала меня на ту страницу, где я был до
  // этого»): whatever the notification opens, back leads to the screen the person stood on at the click — a section, a chat
  // (with its own arrow kept), or the main page. A chat of Profi.ru can't be stood on again from here: then the main page.
  function hereTarget() {
    if (sectionOn && SECTIONS[sectionOn]) return sectionTarget(sectionOn);
    const id = state.conversationId;
    if (id && !profiChat && !homeOn()) {
      const titleEl = document.querySelector('#wc-chat-title .wc-chat-title-main') || document.getElementById('wc-chat-title');
      const title = (titleEl && titleEl.textContent.trim()) || 'Chat';
      const before = sectionBack.target;
      const folder = folderOfChat && folderOfChat.key === id ? folderOfChat.sectionId : null;
      return {
        title,
        go: () => (folder && SECTIONS[folder]
          ? openFolderChat(folder, id, () => true, null, null, before || undefined)
          : openConversation(id, { back: before || undefined })),
      };
    }
    return people.hasTabs ? mainTarget() : null;
  }
  async function openFromNotification(lex) {
    if (!lex) return;
    const was = hereTarget();
    const wasKey = state.conversationId;
    const wasSection = sectionOn;
    await openFromNotificationTo(lex);
    // Opened something else than what stood: the arrow leads back there.
    if (was && (state.conversationId !== wasKey || sectionOn !== wasSection)) sectionBack.cameFrom(was);
  }
  async function openFromNotificationTo(lex) {
    const mine = ++notificationOpens;
    const wanted = () => mine === notificationOpens;
    const kind = String(lex.kind || '');
    const key = typeof lex.chatKey === 'string' ? lex.chatKey : '';
    homeToAll();
    const order = lex.order ? String(lex.order) : '';
    // A click that launched the page comes before the sections are known: the chat opens in its section, when they are (not
    // longer than a few seconds).
    await Promise.race([sectionsKnownPromise, new Promise((resolve) => setTimeout(resolve, 6000))]);
    if (!wanted()) return;
    // The calendar (calendar_placed, calendar_reminder, calendar_note, calendar_sent, calendar_failed): the section
    // «Calendar» on the day of the record, its sheet open (wc-calendar.js reveal), as a tap on the iPhone — never a chat of
    // its key.
    if (key === '__lex_calendar__' || kind.startsWith('calendar')) {
      await showSection('calendar', { enter: (live) => live.reveal(lex), wanted });
      return;
    }
    if (people.hasTabs) people.toAll();   // the sections are known now: «All» again, if a tab was pressed while they came
    const back = people.hasTabs ? mainTarget() : undefined;
    // About an order (new, reply sent, not sent): New orders at it, as on the iPhone; without the number — at its top.
    if (kind === 'profi_order') {
      await showProfi('feed', order || null, wanted);
      return;
    }
    // A message of an order chat, a draft after a call (В7.42: the chat opens with the discussion shown, on the draft): the
    // chat as a row of «All» opens it, or New orders at that order while its reply waits there. The section Profi.ru is
    // not shown for it: only what that opens is.
    if (key.startsWith('__lex_profi__') && order) {
      await ensureSection('profi').openOrder(order,
        kind === 'profi_call_draft' ? { from: 'people', fresh: true, showLex: true } : { from: 'people', fresh: true },
        (text) => toast(text, { error: true }));
      return;
    }
    // An alert of the Profi.ru bot: its service chat, over the main page.
    if (kind === 'profi_alert' || key === '__lex_profi_bot__') {
      await showProfi('bot', null, wanted);
      return;
    }
    if (WcHistory.isEmFeedKey(key)) {
      // A question — the feed of questions on it (the chat of one question of a notification from
      // before the one feed is that question there too).
      const item = (key.match(/^__lex_em_question_(-?\d+)__$/) || [])[1];
      const ref = typeof lex.ref === 'string' && lex.ref ? lex.ref : null;
      const feed = item ? 'question' : key.replace(/^__lex_em_|__$/g, '');
      // Over the main page the feed opens by itself and the arrow leads to that page. Without it: Extended Mind first and
      // the arrow to it; Questions have a button of their own, their feed opens straight.
      if (!back && feed !== 'question') await showSection('em', { wanted });
      if (!wanted()) return;
      if (item) await openEmFeed('question', wanted, ref || `em:${item}`, back);
      else await openEmFeed(feed, wanted, ref, back);
      return;
    }
    // A word of an agent (lex.agent, a task chat of the section «Agents»): the folder of that agent, the chat over it.
    if (lex.agent && WcHistory.isFolderKey(key)) {
      await openAgentFrom(String(lex.agent), key, wanted);
      return;
    }
    // The chat of a person not recognized yet (`whois`, push-decide.ts) may have gone out of the folders since: the person
    // was confirmed, and his messages go on in his own chat. The server says where the chat lies now, and the click goes
    // there. No answer within a moment, or nowhere to go — the chat as the notification had it.
    if (lex.whois === true && WcHistory.isFolderKey(key)) {
      const live = await Promise.race([newsRpc('folder_chat_live', { p_chat_key: key }).catch(() => null),
        new Promise((resolve) => setTimeout(() => resolve(null), 2500))]);
      if (!wanted()) return;
      if (live && live.chatKey && live.folder) {
        await openFromNotificationTo({ kind: 'folder_message', chatKey: live.chatKey, folder: live.folder });
        return;
      }
    }
    // A message of a folder (folder_message): its chat, as a press on its line on the main page opens it.
    const folderId = lex.folder ? `folder:${lex.folder}` : '';
    if (WcHistory.isFolderKey(key) && SECTIONS[folderId]) {
      ensureSection(folderId);
      await openFolderChat(folderId, key, wanted, null, null);
      return;
    }
    // Any other chat: a conversation with the model, with the arrow to the main page when there is one.
    if (key) await openConversation(key, { wanted, back });
  }
  global.__lexShellPush = shellPush;
  global.__lexShellAction = shellAction;
  global.__lexShellOpen = (lex) => { openFromNotification(lex).catch((e) => console.warn('[wc] notification:', e && e.message)); };
  // Signed in: ask the Mac app for its address and for a click that came before the page.
  function askShellForPush() { tellShell('push'); }
  async function forgetShellPush() {
    // Signed out: nothing of the account stays on the icon in the Dock.
    if (shellShowsBadge()) { tellShell({ word: 'signedOut' }); shellBadgeSaid = null; }
    if (!shellPushToken) return;
    try { await newsRpc('lex_push_unregister', { p_token: shellPushToken }); } catch (_) { /* the server forgets dead ones itself */ }
    shellPushToken = null;
    shellPushSaid = null;
  }

  // ── News ─────────────────────────────────────────────────────────────────
  // The feed, its cards and its settings are lex-news.js, the same code as in the extension.
  function buildNews() {
    return global.LexNews.createFeed({
      back: sectionBack,
      signals,
      rpc: newsRpc,
      post: newsPost,
      copy: copyText,
      modelLabel: (id) => global.LexAnswerRow.modelLabel(id),
      pickModel: (anchor, id, onPick) => openModelMenu(anchor, id, null, onPick),
      showCard: showNewsCard,
      // The field stays away until a chat stands behind the text, or a word would go to
      // the chat before. The arrow leads back, and a press on the card tries again.
      cardFailed: (why) => toast('The chat did not open: ' + why, { error: true }),
      openChat: async ({ chatKey, title, shown, wanted }) => {
        await openConversation(chatKey, { keepPlace: shown, wanted, back: sectionTarget('news') });
        if (wanted() && state.conversationId === chatKey) WcHeader.setTitle(title);
      },
      // The feed with the place in it, kept by the feed itself among the page's copies
      // (lex-reads.js, news_feed); its settings and the head of a news chat are read the way of
      // every screen, the copy first.
      keepFeed: (value) => { keep('news_feed', {}, value); },
      keptFeed: () => kept('news_feed', {}),
      read,
      // The head of the feed stands in this bar, by the three stripes (paintNewsHead); the row of
      // kinds of source is the common tabs (В7.27).
      head: paintNewsHead,
      tabs: (o) => WcUI.tabs(o),
    });
  }
  // The head of the feed of News in the bar (ios/Lex/STANDARD.md В7.18, 2026-11-15): «News» 18/650,
  // Refresh and the gear as buttons with an icon of 44; null — the bar as it was.
  function paintNewsHead(spec) {
    const main = document.querySelector('.wc-main');
    const slot = document.getElementById('wc-section-head');
    if (!main || !slot) return;
    // The slot is shared with the head of the calendar: a «no head» of News leaves a slot it does not hold as it is.
    if (!spec && !main.classList.contains('is-news-feed')) return;
    main.classList.toggle('is-news-feed', !!spec);
    if (!spec) { slot.replaceChildren(); slot.hidden = true; return; }
    const refresh = WcUI.iconBtn('refresh', 'Refresh', () => spec.refresh(), 'is-44');
    refresh.disabled = !!spec.busy;
    slot.replaceChildren(
      WcUI.el('.wc-section-head-title', {}, [spec.title]),
      refresh,
      WcUI.iconBtn('gear', 'Settings', () => spec.settings(), 'is-44'));
    slot.hidden = false;
  }
  // ── Calendar ─────────────────────────────────────────────────────────────
  // The section of the calendar of the base (wc-calendar.js, 22.11.2026): its reads and writes through the edge function
  // calendar (WC_CALENDAR), its watch on the signal «calendar» of the base. Its head stands in the bar of the window.
  const calendarCall = (sub, query, body) => WcBus.call('WC_CALENDAR', { sub, query: query || null, body: body || null });
  function buildCalendar() {
    return global.WcCalendar.createSection({
      back: sectionBack,
      signals,
      call: calendarCall,
      head: paintCalendarHead,
      tabs: (o) => WcUI.tabs(o),
    });
  }
  // The head of the calendar in the bar of the window, by the three stripes (В7.18, the way of News): «Calendar» 18/650 and
  // the section's own nodes — «+» on a narrow window; the words of the period, the views, the arrows, Today and New on the
  // Mac's (CalV27). null — the bar as it was. The section's own bar steps aside meanwhile (wc-calendar.css).
  let calendarHead = false;
  function paintCalendarHead(spec) {
    const main = document.querySelector('.wc-main');
    const slot = document.getElementById('wc-section-head');
    if (!main || !slot) return;
    if (!spec) {
      if (!calendarHead) return;
      calendarHead = false;
      main.classList.remove('is-cal-head');
      slot.classList.remove('is-cal');
      slot.replaceChildren();
      slot.hidden = true;
      return;
    }
    calendarHead = true;
    main.classList.add('is-cal-head');
    slot.classList.add('is-cal');
    slot.replaceChildren(WcUI.el('.wc-section-head-title', {}, [spec.title]), ...(spec.nodes || []));
    slot.hidden = false;
  }
  // The head of a news in the bar (В7.32): the source — the mark of its kind and its name, the date and
  // the time under them — in place of the title of a chat, «Open in the browser» (no web version — no
  // button) and the three dots with «Process again» on the right. null — the bar as it was.
  let newsBar = null;
  function paintNewsBar(x) {
    const main = document.querySelector('.wc-main');
    const box = document.getElementById('wc-chat-title');
    const tools = document.getElementById('wc-news-tools');
    if (!main || !box || !tools) return;
    if (!x) {
      if (!newsBar) return;
      newsBar = null;
      main.classList.remove('is-news-chat');
      box.replaceChildren();
      box.hidden = true;
      tools.replaceChildren();
      return;
    }
    const h = x.head;
    newsBar = { letterId: h.letterId };
    main.classList.add('is-news-chat');
    box.replaceChildren(global.LexMessage.newsSource({
      kind: h.kind || 'email', source: h.newsletter, at: h.at || null, timeText: h.at ? undefined : (h.date || ''),
    }));
    box.hidden = false;
    const btns = [];
    if (h.webUrl) {
      btns.push(WcUI.el('a.wc-icon-btn.is-44.wc-news-web', {
        href: h.webUrl, target: '_blank', rel: 'noopener noreferrer', title: 'Open in the browser', 'aria-label': 'Open in the browser',
      }, [WcUI.icon('open')]));
    }
    const more = WcUI.iconBtn('dots', 'More', () => {
      if (x.isBusy()) return;
      WcUI.menu(more, [{ label: 'Process again', icon: 'refresh', onSelect: () => x.processAgain() }]);
    }, 'is-44');
    more.setAttribute('aria-haspopup', 'menu');
    btns.push(more);
    tools.replaceChildren(...btns);
  }
  // What stands over the first message of a news chat. Reading the chat again leaves
  // the arrow back to the feed as it was.
  function newsHead(head) {
    const chatKey = state.conversationId;
    return global.LexNews.createChatHead({
      chatKey, head, rpc: newsRpc, post: newsPost, read,
      // The source of the news and its two buttons stand in this bar, while this chat is on the screen.
      onHead: (x) => { if (state.conversationId === chatKey) paintNewsBar(x); },
      onPaint: () => WcThread.keepAtBottom(),
      reload: async (title) => {
        if (state.conversationId !== chatKey || !sectionEls().host.hidden || WcThread.isStreaming()) return;
        await openConversation(chatKey, { back: sectionBack.target });
        WcHeader.setTitle(title);
      },
    });
  }
  // The text of a card is here already: it goes on screen in the moment of the press,
  // and the chat behind it comes after. Without a chat there is nowhere to send to, so
  // the field waits for it.
  function showNewsCard({ text, head, title }) {
    if (WcThread.isStreaming()) return false;
    leaveSection();
    resetMoney();
    WcThread.renderTurns([{ role: 'assistant', origin: 'news', text }], { newsHead: () => newsHead(head) });
    sectionEls().main.classList.add('is-news-opening');
    sectionBack.cameFrom(sectionTarget('news'));
    WcHeader.setTitle(title);
    return true;
  }

  // ── Extended Mind ────────────────────────────────────────────────────────
  // The feeds of the owner's database: what it did with every new incoming message, what
  // it did for every request, its questions to the owner. A feed is an ordinary
  // conversation the database writes its entries into (supabase/migrations/em_feeds.sql):
  // it opens here like any chat, and while it is open the page follows the server — a new
  // entry comes at the bottom, an extended one changes in place, at the database's signal
  // «em» (account_signals.sql), not on a timer.
  let emOpen = null;      // { key, rev }
  let emFollower = null;
  // ── The tabs of «Разбор» (2026-11-14, ios/Lex/STANDARD.md В7.27) ──
  // «Люди · N», «Работа · N», «Всё» over the feed: the work is Claude Code and Notion, the people
  // everything else (the server names the tab of every record, lex_em_intake_look). N — the
  // records of today, the device's day, as the server counts them (lex_em_intake_today); the
  // numbers this device saw last come first. The tab chosen stays on this device.
  const INTAKE_KEY = '__lex_em_intake__';
  const LANE_KEPT = 'lex.emIntakeLane';
  const COUNTS_KEPT = 'lex.emIntakeCounts';
  let intakeTabs = null;
  const localDay = () => {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  };
  function intakeLane() {
    try {
      const v = localStorage.getItem(LANE_KEPT);
      if (v === 'people' || v === 'work' || v === 'all') return v;
    } catch (_) { /* no storage: the first tab */ }
    return 'people';
  }
  function keptCounts() {
    try {
      const c = JSON.parse(localStorage.getItem(COUNTS_KEPT) || 'null');
      if (c && c.day === localDay()) return c;
    } catch (_) { /* nothing kept */ }
    return null;
  }
  function intakeItems(c) {
    return [
      { id: 'people', label: c ? `Люди · ${c.people}` : 'Люди' },
      { id: 'work', label: c ? `Работа · ${c.work}` : 'Работа' },
      { id: 'all', label: 'Всё' },
    ];
  }
  // The tabs are there while «Разбор» is the chat on the screen, and nowhere else.
  function syncIntakeTabs(on) {
    const host = document.getElementById('wc-em-tabs');
    const bar = document.querySelector('.wc-topbar');
    WcThread.setEmLane(on ? intakeLane() : null);
    WcThread.setEmQuestion(on ? (asked) => { openIntakeQuestion(asked).catch((e) => console.warn('[wc] question:', e && e.message)); } : null);
    if (!host || !bar) return;
    if (!on) {
      host.hidden = true;
      bar.classList.remove('has-tabs');
      return;
    }
    if (!intakeTabs) {
      intakeTabs = WcUI.tabs({
        label: 'Whose records',
        items: intakeItems(keptCounts()),
        selected: intakeLane(),
        onSelect: (id) => {
          try { localStorage.setItem(LANE_KEPT, id); } catch (_) { /* this time only */ }
          WcThread.setEmLane(id);
        },
      });
      host.replaceChildren(intakeTabs);
    } else intakeTabs.update(intakeItems(keptCounts()), intakeLane());
    host.hidden = false;
    bar.classList.add('has-tabs');
    countIntake().catch((e) => console.warn('[wc] tabs:', e && e.message));
  }
  async function countIntake() {
    const day = localDay();
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    const c = await newsRpc('lex_em_intake_today', { p_since: since.toISOString() });
    if (!c || !intakeTabs || state.conversationId !== INTAKE_KEY) return;
    const counts = { day, people: Number(c.people) || 0, work: Number(c.work) || 0 };
    try { localStorage.setItem(COUNTS_KEPT, JSON.stringify(counts)); } catch (_) { /* this time only */ }
    intakeTabs.update(intakeItems(counts));
  }
  // «База задала тебе вопрос»: the feed «Questions» on the question the record asked, found by its
  // words (lex_em_intake_question) — as a notification of that question opens it. Not in Lex yet
  // (it comes a second or two after the record): the feed of questions at its end.
  let questionPress = 0;
  async function openIntakeQuestion(asked) {
    const mine = ++questionPress;
    const wanted = () => mine === questionPress;
    const text = Array.isArray(asked) ? asked.find((x) => typeof x === 'string' && x.trim()) : null;
    let found = null;
    try {
      found = text ? await newsRpc('lex_em_intake_question', { p_text: text }) : null;
    } catch (e) {
      console.warn('[wc] question:', e && e.message);
    }
    if (!wanted()) return;
    const focus = found && found.item != null ? (found.turnUid || `em:${found.item}`) : null;
    await openEmFeed('question', wanted, focus);
  }
  // The button Questions: the feed of questions, the copy first as every feed.
  let questionsPress = 0;
  function openQuestions() {
    const mine = ++questionsPress;
    const wanted = () => mine === questionsPress;
    openEmFeed('question', wanted).catch((e) => toast('The feed did not open. ' + ((e && e.message) || ''), { error: true }));
  }
  // A look skipped while the page was hidden or an answer was written: it goes when that ends.
  let emLookDue = false;
  let emFrame = null;
  function buildEm() {
    let rows = [];
    const frame = global.LexSection.createFrame({
      title: 'Extended Mind',
      cls: 'lex-em',
      back: sectionBack,
      // An entry of a feed came or changed, a question came or got its answer: the signal «em».
      signals,
      events: ['em'],
      check: async () => { await readHome(); },
      // Back to the list: it is read again, and a reading that failed says nothing (Gennady, 20.11.2026).
      onBack: (id) => { if (id === 'home') readHome().catch((e) => console.warn('[em] back:', e && e.message)); },
    });
    emFrame = frame;
    function paint() {
      if (frame.screen !== 'home') return;
      const list = global.LexSection.make('div', 'lex-section-list');
      emHeld.unwatch();
      for (const r of rows) {
        const isQ = r.kind === 'question';
        const line = global.LexSection.row({
          id: r.kind, strong: true, cls: `lex-em-feed-${r.kind}`,
          title: r.title,
          // Questions: how many wait for an answer, and the newest of them.
          mark: isQ && r.open ? String(r.open) : null,
          sub: r.last || (r.count ? r.hint : 'Nothing yet.'),
          // How many entries are unread (В7.48); the feed of questions — the section Questions.
          unread: isQ ? { section: 'questions' } : { chat: `__lex_em_${r.kind}__` },
          onClick: () => frame.open((wanted) => openEmFeed(r.kind, wanted), 'The feed did not open.'),
        });
        list.appendChild(line);
        // A feed is read ahead while its line is on the screen: a press shows it at once.
        emHeld.watch(line, `feed:${r.kind}`, [r.count, r.lastAt, r.last, r.open].join('|'));
      }
      frame.body.replaceChildren(list);
    }
    // The feeds and the questions: the copy this device kept while the section holds none yet,
    // then the server's answer (lex-reads.js).
    async function readHome() {
      await read('lex_em_feed_home', { p_without: ['question'] }, (v) => { rows = v || []; paint(); }, () => !rows.length);
    }
    return {
      el: frame.el,
      stopOpening: frame.stopOpening,
      // A feed or a question was left and its moment written: read it again for the next press.
      visited(chatKey) {
        const id = emIdOfKey.get(chatKey);
        if (id) emHeld.ahead(id, null);
      },
      async show() {
        frame.enter();
        // What this device saw the last time, in the first frame; the server comes after.
        let read = true;
        try {
          await readHome();
        } catch (e) {
          // Silent on the screen: the copy of the last time stays, and the bot's alert tells what is broken.
          read = false;
          console.warn('[em] show:', e && e.message);
        }
        if (frame.isShown()) {
          frame.watch();
          // A reading that failed: the frame looks again after a pause until one look goes.
          if (!read) frame.lookNow();
        }
      },
      // The page started and the account has the section: its list is read and drawn before
      // the section is shown, so the first press shows what is there now.
      async warm() {
        if (frame.isShown()) return;
        await readHome();
      },
      hide() { frame.unwatch(); },
    };
  }
  // The feeds and the questions the window holds (the frame's keep, lex-section.js): read ahead
  // while their lines are on the screen, one answer each (lex_em_feed_item, lex_em_question_item;
  // nothing written by them). A feed held already is brought up to date with only what changed
  // in it since (lex_em_feed_changes): a feed is up to a megabyte, and reading it whole on every
  // new entry would be that again and again. A press shows what is held at once.
  const emKeyOf = (kind) => `__lex_em_${kind}__`;
  const emIdOfKey = new Map();
  const emRemember = (id, item) => {
    if (item && item.chatKey) emIdOfKey.set(item.chatKey, id);
    return item;
  };
  const emTime = (r) => {
    const t = Date.parse((r && r.authored_at) || '');
    return Number.isFinite(t) ? t : 0;
  };
  // A held feed with what changed since it was read: an extended entry in place of the old,
  // a new one at its time, a line the server took back gone.
  function emMerged(held, ch, since) {
    const conv = held.chat.conversation || {};
    const rows = (ch && Array.isArray(ch.turns)) ? ch.turns : [];
    const rev = Math.max((ch && ch.rev) || 0, conv.rev || 0);
    const byUid = new Map((conv.turns || []).map((r) => [r.turn_uid, r]));
    for (const r of rows) {
      if (!r || !r.turn_uid) continue;
      if (r.deleted) byUid.delete(r.turn_uid);
      else byUid.set(r.turn_uid, r);
    }
    const turns = [...byUid.values()].sort((a, b) => (emTime(a) - emTime(b)) || String(a.turn_uid).localeCompare(String(b.turn_uid)));
    return Object.assign({}, held, {
      rev,
      // The feed of questions: how many wait for an answer now.
      ...(ch && ch.waiting != null ? { waiting: ch.waiting } : {}),
      chat: Object.assign({}, held.chat, { since: since == null ? null : since, conversation: Object.assign({}, conv, { turns, rev }) }),
    });
  }
  async function loadEmItem(id, held) {
    const at = id.indexOf(':');
    const what = id.slice(0, at);
    const arg = id.slice(at + 1);
    if (held && held.chat && held.chat.conversation) {
      const key = held.chatKey;
      const [ch, since] = await Promise.all([
        newsRpc('lex_em_feed_changes', { p_chat_key: key, p_after: held.chat.conversation.rev || 0 }),
        newsRpc('lex_chat_seen', { p_chat_key: key, p_take: false }),
      ]);
      // The feed brought up to date is the newest state of its answer: the device keeps it so.
      const merged = emMerged(held, ch, since);
      keep('lex_em_feed_item', { p_kind: arg }, merged);
      return emRemember(id, merged);
    }
    return emRemember(id, await newsRpc('lex_em_feed_item', { p_kind: arg, p_limit: WcHistory.emLimit(emKeyOf(arg)) }));
  }
  const emHeld = global.LexSection.keep({ load: loadEmItem });

  // A press on a feed or a question. What the window holds is on screen at once; otherwise one
  // answer brings everything, and the press takes the visit's moment with it.
  // Nothing held — after a restart: the copy this device kept is held and shown the same way
  // (lex-reads.js), and the press brings it up to date as it does what was held.
  async function heldOrKept(id, name, args) {
    const held = emHeld.get(id);
    if (held && held.chat) return held;
    const copy = await kept(name, args);
    if (!copy || !copy.chat || !copy.chatKey || emHeld.get(id)) return emHeld.get(id);
    emHeld.put(id, emRemember(id, copy));
    return copy;
  }
  // back — the way back from the feed when it is not the section's own (a notification over the main page leads back to it).
  async function openEmFeed(kind, wanted, focusUid, back) {
    const id = `feed:${kind}`;
    const held = await heldOrKept(id, 'lex_em_feed_item', { p_kind: kind });
    if (!wanted()) return;
    if (held && held.chat) { await openEmChat(held, wanted, true, focusUid, back); return; }
    const info = await newsRpc('lex_em_feed_item', { p_kind: kind, p_take: true, p_limit: WcHistory.emLimit(emKeyOf(kind)) });
    if (!wanted() || !info || !info.chatKey) return;
    emHeld.put(id, emRemember(id, info));
    await openEmChat(info, wanted, false, focusUid, back);
  }
  async function openEmChat(info, wanted, fromHeld, focusUid, back) {
    const key = info.chatKey;
    // The feed that was open is left here, before the hooks of this one are set: leaving the section
    // on the way (leaveSection) would otherwise take them off after they are set.
    leaveEmFeed();
    // The feed of questions: a press names the question by its turn, a hold offers Reply.
    const questions = key === EM_QUESTIONS_KEY;
    WcThread.setQuestionsFeed(questions ? {
      onAnswer: (uid, choice) => newsPost('em-answer', { chatKey: key, choice, turnUid: uid }),
      onReply: (r) => setReply(r),
    } : null);
    // The feed of requests: its records stand as tasks, one message a task (LexMessage.task, В7.30).
    const requests = key === EM_REQUESTS_KEY;
    WcThread.setRequestsFeed(requests);
    // The title stands before the chat is drawn: drawn after, it would push the end of the chat
    // under the message box.
    paintChatTitle(questions ? { title: 'Questions', sub: waitingSub(info.waiting) }
      : requests ? { title: 'Обращения к базе', sub: daySub(emRequestsDay) } : null);
    sectionEls().main.classList.add('is-em-feed');
    await WcBus.call('WC_EM_FEED', { key, sessionId: info.sessionId });
    await openConversation(key, { back: back || (questions ? null : sectionTarget('em')), wanted, loaded: info.chat || null, focusUid });
    if (state.conversationId !== key) {
      if (!emOpen) { paintChatTitle(null); sectionEls().main.classList.remove('is-em-feed'); }
      return;
    }
    // Leaving the feed before forgot its session on the way: say it again.
    await WcBus.call('WC_EM_FEED', { key, sessionId: info.sessionId });
    const conv = info.chat && info.chat.conversation;
    emOpen = { key, rev: (conv && conv.rev) || info.rev || 0 };
    sectionEls().main.classList.add('is-em-feed');
    WcHeader.setTitle(info.title || 'Extended Mind');
    if (emFollower) emFollower.stop();
    emFollower = signals.follow(['em'], async (signal) => {
      const p = signal && signal.payload;
      // A signal of another feed is not this one's; a look to catch up reads it anyway.
      if (p && emOpen && p.chat !== emOpen.key && p.from !== emOpen.key) return;
      await lookEmFeed(p && p.chat === (emOpen && emOpen.key) ? p.rev : null);
    });
    if (requests) countRequests().catch((e) => console.warn('[wc] requests:', e && e.message));
    // Shown from what was held: the press takes the visit's moment on the server now, and
    // what came after the reading ahead comes at once, not in two seconds.
    if (fromHeld) {
      newsRpc('lex_chat_seen', { p_chat_key: key }).catch(() => {});
      lookEmFeed().catch((e) => console.warn('[wc] feed:', e && e.message));
    }
  }
  function leaveEmFeed() {
    if (!emOpen) return;
    emOpen = null;
    endVisit();
    WcThread.setQuestionsFeed(null);
    WcThread.setRequestsFeed(false);
    // The line of a Reply stays the draft of the feed (takeField puts it away with the field).
    paintChatTitle(null);
    if (emFollower) emFollower.stop();
    emFollower = null;
    emLookDue = false;
    sectionEls().main.classList.remove('is-em-feed');
    WcBus.call('WC_EM_FEED', {}).catch(() => {});
    syncIntakeTabs(false);
  }
  // At the signal of this feed only the new and extended entries come (lex_em_feed_changes)
  // and take their place; the signal carries the number of the change, so no question about
  // it goes first. A look to catch up asks the number. The conversation is not read again: an
  // answer just written reaches the server a moment after the screen, and reading it back
  // would cut it. Not while an answer is written, and not while the page is hidden: the look
  // goes when that ends (emLookDue).
  async function lookEmFeed(told) {
    const f = emOpen;
    if (!f || state.conversationId !== f.key) return;
    if (document.visibilityState !== 'visible' || WcThread.isStreaming()) { emLookDue = true; return; }
    emLookDue = false;
    const rev = told != null ? Number(told) : await newsRpc('lex_em_feed_rev', { p_chat_key: f.key });
    if (emOpen !== f || rev <= f.rev) return;
    const ch = await newsRpc('lex_em_feed_changes', { p_chat_key: f.key, p_after: f.rev });
    if (emOpen !== f || state.conversationId !== f.key) return;
    if (WcThread.isStreaming()) { emLookDue = true; return; }
    for (const row of (ch && Array.isArray(ch.turns)) ? ch.turns : []) WcThread.upsertEmEntry(WcHistory.turnOf(row));
    f.rev = Math.max(rev, (ch && ch.rev) || 0);
    // A new record of «Разбор» changes the numbers of its tabs.
    if (f.key === INTAKE_KEY) countIntake().catch((e) => console.warn('[wc] tabs:', e && e.message));
    if (ch && ch.waiting != null && f.key === EM_QUESTIONS_KEY) paintChatTitle({ title: 'Questions', sub: waitingSub(ch.waiting) });
    // A new request changes the number under the title of the feed of requests.
    if (f.key === EM_REQUESTS_KEY) countRequests().catch((e) => console.warn('[wc] requests:', e && e.message));
  }
  function lookEmFeedIfDue() {
    if (emLookDue && emOpen) lookEmFeed().catch((e) => console.warn('[wc] feed:', e && e.message));
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') lookEmFeedIfDue(); });
  // ── The feeds of questions and requests: their title and the line of a reply ──
  const EM_QUESTIONS_KEY = '__lex_em_question__';
  const EM_REQUESTS_KEY = '__lex_em_request__';
  // The title of the chat in the bar, two lines: «Questions» and under it «Extended Mind · N waiting»
  // (nothing waits — «Extended Mind»); «Обращения к базе» and «Extended Mind · N за сутки» — the requests
  // of the last 24 hours (lex_em_requests_day). null — no title (any other chat).
  const waitingSub = (w) => (Number(w) > 0 ? `Extended Mind · ${Number(w)} waiting` : 'Extended Mind');
  const daySub = (n) => (Number(n) > 0 ? `Extended Mind · ${Number(n)} за сутки` : 'Extended Mind');
  let emRequestsDay = null;
  async function countRequests() {
    const r = await newsRpc('lex_em_requests_day', {});
    if (!r || r.day == null) return;
    emRequestsDay = Number(r.day) || 0;
    if (emOpen && emOpen.key === EM_REQUESTS_KEY) paintChatTitle({ title: 'Обращения к базе', sub: daySub(emRequestsDay) });
  }
  function paintChatTitle(t) {
    const box = document.getElementById('wc-chat-title');
    if (!box) return;
    box.hidden = !t;
    if (!t) { box.replaceChildren(); return; }
    box.replaceChildren(
      WcUI.el('.wc-chat-title-main', {}, [t.title]),
      WcUI.el('.wc-chat-title-sub', {}, [t.sub || 'Extended Mind']),
    );
  }
  // Reply on a question or a pack: the line over the message box; the next message carries their
  // turns (emReply) and the model is told which questions it is about. Reply on a message of an order
  // chat (В7.26, 2026-11-16): the same line, «Reply to Dmitry»; the next word to Lex carries the message
  // (quoteUid), and so does one's own text to the client (profi_send_text). null — no line.
  // The line is the draft of the chat too (lex-drafts.js): it comes back with the chat. opts.quiet — the
  // window fills the field of a chat it opens: the draft is not told, the field gets no focus.
  let reply = null;
  function setReply(r, opts) {
    const quiet = !!(opts && opts.quiet);
    const uids = r && Array.isArray(r.uids) ? r.uids.slice(0, 30) : [];
    const quoteUid = r && typeof r.quoteUid === 'string' && r.quoteUid ? r.quoteUid : null;
    // Edit of a message that went to a person (19.11.2026): the same line over the field, with the pencil; it is no draft.
    const editUid = r && typeof r.editUid === 'string' && r.editUid ? r.editUid : null;
    // Edit in place of one's own word to Lex (23.11.2026): the same line; the arrow sends a new version of that message.
    const editTurn = !!(editUid && r.editTurn);
    // A question about a line of the journal of an agent (22.11.2026, board AgAskRun): «Log · HH:MM» and the line; the first
    // word of the new chat goes with the id of the line (sendToAgent, op chat with run).
    const run = r && typeof r.run === 'string' && r.run ? r.run : null;
    reply = uids.length || quoteUid || editUid || run
      ? { uids, quoteUid, editUid, editTurn, run, text: r.text || '', head: r.head || 'Reply to Extended Mind' } : null;
    const slot = document.getElementById('wc-reply');
    if (slot) {
      slot.hidden = !reply;
      slot.replaceChildren(...(reply ? [global.LexMessage.replyBar({
        head: reply.head, text: reply.text, edit: !!reply.editUid,
        onClose: () => (reply && reply.editUid ? endEdit() : setReply(null)),
      })] : []));
      if (reply && !quiet) WcComposer.focus();
    }
    if (!quiet) saveField();
    // A Reply in a chat of a folder goes to the messenger of the message it answers: the hint says it.
    paintAddressee();
  }

  // ── Edit of a message that went to a person (Gennady, 2026-11-19) ──────────
  // «Edit» in the menu of one's own message in a chat of a person: its words go into the field, the line over the field
  // says what is edited, and the arrow edits the message at the person (the edge function message-edit → the database →
  // the messenger) — the model is not asked, no new message goes. What stood in the field comes back when the edit ends or
  // is cancelled. The result comes into the chat as every edit does: «edited» with the earlier text.
  let editStash = null;
  function startEdit(e) {
    if (!e || !e.uid) return;
    // What stood in the field, with its Reply line, comes back when the edit ends: the edit is no draft.
    if (!(reply && reply.editUid)) editStash = { text: WcComposer.text(), reply: replyOfField() };
    setReply({ editUid: e.uid, editTurn: !!e.turn, head: e.head || 'Edit message', text: e.text || '' });
    WcComposer.setText(e.text || '');
    WcComposer.focus();
  }
  function endEdit() {
    const was = editStash;
    editStash = null;
    setReply((was && was.reply) || null, { quiet: true });
    WcComposer.setText((was && was.text) || '');
  }
  async function editSentText(uid, text) {
    const out = await WcBus.call('WC_MESSAGE_EDIT', { body: { uid, text, opId: global.LexFolders.newOpId() } });
    return (out && out.edit) || null;
  }
  // A reaction on a message at a person (Gennady, 2026-11-24): the press on an emoji of the bar in the menu of a message is his
  // «yes» to it; the edge function message-react puts it on the message in the messenger of the person ('' takes it off).
  // → { status: 'reacted' | 'removed' | 'waiting' | 'stand' }; a refusal (422, 502) is the error with the words of the server.
  async function reactSent(uid, emoji) {
    const out = await WcBus.call('WC_MESSAGE_REACT', { body: { uid, emoji: emoji || '', opId: global.LexFolders.newOpId() } });
    return (out && out.react) || out;
  }
  // ── Edit in place of one's own word to Lex (Gennady, 2026-11-23: «как это обычно принято») ─────────
  // The arrow under the line «Edit message» of a word to Lex: the message and what came after it leave the screen, the
  // new words stand in their place with the answer written anew under them, and the model reads the chat up to that
  // place (the server's chain, wc-backend.js isEdit). The old version stays on the server: ‹ 1 / 2 › under the message
  // goes back to it. Not a word came — the old message and its answer are back, the reason in a line (onEditBack).
  async function sendEdit(text) {
    const e = reply && reply.editUid && reply.editTurn ? reply : null;
    const words = String(text || '').trim();
    if (!e) return;
    const refuse = (why) => {
      if (words && !WcComposer.text().trim()) WcComposer.setText(words);
      toast(why, { error: true });
    };
    if (!words) { refuse('Write the new words, or cancel the edit.'); return; }
    if (global.WcAttach && WcAttach.count() > 0) { refuse('An edit takes words only. Take the file off the field first.'); return; }
    if (WcThread.isStreaming()) { refuse('Wait for the answer, or stop it, then edit.'); return; }
    const convId = state.conversationId;
    if (!convId) { refuse('This chat is not on the server yet.'); return; }
    const cut = WcThread.cutForEdit(e.editUid);
    if (!cut) { refuse('This message is not in the chat any more.'); return; }
    endEdit();
    if (profiChat && profiChat.clean) { profiChat.setClean(false); paintProfiBar(); }
    WcThread.appendUser(words, [], {});
    const requestId = nextRequestId();
    state.requestId = requestId;
    const opId = global.LexTurnId.newOpId();
    ownOps.add(opId);
    opOfRequest.set(requestId, opId);
    editRequests.set(requestId, convId);
    WcThread.beginAssistant(requestId);
    WcThread.markEdit(requestId, cut);
    WcComposer.setStreaming(true, requestId);
    try {
      await WcBus.call('WC_SEND', {
        requestId, opId, pressedAt: Date.now(), conversationId: convId,
        text: words, picks: null, images: [], files: [], mode: null, slotId: null, modelId: '',
        act: 'edit', replacesUid: e.editUid,
      });
    } catch (err) {
      WcBus.broadcast({ type: 'STREAM_ERROR', requestId, error: String((err && err.message) || err) });
    }
  }
  // requestId → the chat of an edit in place: its end reads the chat again (the counter of the versions comes with it).
  const editRequests = new Map();
  // ‹ 1 / 2 › under one's own message: the server selects that version (select_turn) and the chat is read again.
  async function switchVersion(uid) {
    const key = state.conversationId;
    if (!key || WcThread.isStreaming()) return;
    let r = null;
    try { r = await WcHistory.selectTurn(key, uid); } catch (err) {
      toast('Could not switch the version — the server did not answer. The previous one is back.', { error: true });
      return;
    }
    if (r && r.status === 'fixed') toast('This version stays: the chat went on with the person after it.', { error: true });
    if (r && r.status === 'gone') toast('That version is not in the chat any more.', { error: true });
    await reloadOpenChat(key, { force: true });
  }
  async function reloadOpenChat(key, opts) {
    if (!key || state.conversationId !== key) return;
    // A chat with a person draws itself again even when the same messages are on the screen: the counter of the
    // versions and the list of what is edited in place change with no new message.
    if (profiChat) { await refreshProfiChat({ force: true, ...(opts || {}) }).catch(() => {}); return; }
    try {
      const again = await WcBus.call('WC_LOAD_CONVERSATION', { id: key });
      if (again && again.ok && state.conversationId === key && !WcThread.isStreaming()) paintConversation(again, { keepPlace: true });
    } catch (err) { console.warn('[wc] chat again:', err && err.message); }
  }

  async function submitEdit(text) {
    const e = reply && reply.editUid ? reply : null;
    const chat = profiChat;
    const words = String(text || '').trim();
    if (!e || !chat) return;
    // The field was emptied by the press: what is wrong with the edit is said and the words go back under the line.
    const refuse = (why) => {
      if (words && !WcComposer.text().trim()) WcComposer.setText(words);
      toast(why, { error: true });
    };
    if (!words) { refuse('Write the new words, or cancel the edit.'); return; }
    if (global.WcAttach && WcAttach.count() > 0) { refuse('An edit takes words only. Take the file off the field first.'); return; }
    try {
      const out = await chat.editText(e.editUid, words);
      if (!reply || reply.editUid !== e.editUid) return;
      endEdit();
      if (out && out.state === 'waiting') toast('The edit is on its way.');
      if (out && out.state === 'stand') toast('This is a stand: nothing was edited.');
      if (typeof chat.reload === 'function') chat.reload();
    } catch (err) {
      // Not edited: the words stay in the field with the line over it, to be changed or sent once more.
      refuse('Not edited. ' + ((err && err.message) || ''));
    }
  }

  // ── The draft of every chat (lex-drafts.js, 2026-11-17) ────────────────
  // The field belongs to one chat at a time — fieldKey: the key of the chat on the screen,
  // LexDrafts.NEW_CHAT for a new one, null over a section (it has no field). Every change of the
  // field — a key, a dictation, a picture or a file, a Reply — is that chat's draft at once
  // (saveField); a chat opened puts the field of the last one away and fills it with its own draft
  // (takeField). Before, the field was one for every chat: words typed for Dmitry stood in Eduard's
  // chat, one tap from Eduard (Gennady's task 17.11.2026).
  const DRAFTS_KEY = 'lex_chat_drafts';
  let fieldKey = null;
  let restoring = 0;
  const newChatKey = () => (global.LexDrafts && global.LexDrafts.NEW_CHAT) || '__lex_new_chat__';
  function replyOfField() {
    return reply && !reply.editUid ? { uids: reply.uids, quoteUid: reply.quoteUid, text: reply.text, head: reply.head,
      ...(reply.run ? { run: reply.run } : {}) } : null;
  }
  function saveField() {
    const D = global.LexDrafts;
    if (restoring || !fieldKey || !D) return;
    if (reply && reply.editUid) return;
    D.put(fieldKey, { text: WcComposer.text(), reply: replyOfField(), attach: WcAttach.snapshot() });
  }
  function fillField(d) {
    restoring += 1;
    try {
      WcComposer.setText((d && d.text) || '', { quiet: true });
      setReply((d && d.reply) || null, { quiet: true });
    } finally { restoring -= 1; }
  }
  function takeField(next) {
    const D = global.LexDrafts;
    const key = next || null;
    if (key === fieldKey) return;
    // The chat left: its draft goes to the server now, not in a moment.
    if (fieldKey && D) D.flush();
    restoring += 1;
    try {
      WcAttach.detach();
      fieldKey = key;
      const d = key && D ? D.get(key) : null;
      fillField(d);
      if (d && d.attach) WcAttach.restore(d.attach);
    } finally { restoring -= 1; }
    paintAddressee();
  }
  // A new chat got its key from the server (its first message, the voice, the dictation): the draft
  // typed meanwhile is that chat's.
  function adoptFieldKey(id) {
    const D = global.LexDrafts;
    if (!id || fieldKey !== newChatKey()) return;
    if (D) D.rename(newChatKey(), id);
    fieldKey = id;
  }
  // A draft changed — here or on another device (the signal «drafts»): the lines of the lists say so
  // in place, and the field of the open chat takes the other device's words (words typed here and not
  // on the server yet are never overwritten: lex-drafts.js keeps them).
  function draftsChanged(keys, from) {
    if (global.LexSection && global.LexSection.paintDrafts) global.LexSection.paintDrafts(keys);
    if (from !== 'server' || !fieldKey || keys.indexOf(fieldKey) < 0) return;
    // An edit of a sent message stands in the field: it is no draft, and another device's draft does not take its place.
    if (reply && reply.editUid) return;
    const d = global.LexDrafts.get(fieldKey);
    const same = ((d && d.text) || '') === WcComposer.text()
      && JSON.stringify((d && d.reply) || null) === JSON.stringify(replyOfField());
    if (!same) fillField(d);
  }
  // The empty field has no words (LexComposerBox.hint), except where it takes no text: a chat in no folder
  // says so and takes no typing (a group in a folder takes text, 21.11.2026).
  function paintAddressee() {
    const B = global.LexComposerBox;
    if (!B || typeof WcComposer.setHint !== 'function') return;
    let to = { to: 'lex' };
    if (profiChat && typeof profiChat.addressee === 'function') {
      try { to = profiChat.addressee() || to; } catch (e) { console.warn('[wc] addressee:', e && e.message); }
    }
    WcComposer.setHint(B.hint(to), B.locked(to));
  }
  // The words of a turn that did not go go back where they were typed: into the field, when it is still
  // that chat's; into the draft of their chat when another one is on the screen now.
  function giveBack(key, text, rep) {
    if (!text) return;
    if (key === fieldKey) {
      if (!WcComposer.text().trim()) WcComposer.setText(text);
      return;
    }
    const D = global.LexDrafts;
    if (!D || !key) return;
    const d = D.get(key);
    if (d && d.text && d.text.trim()) return;
    D.put(key, { text, reply: (d && d.reply) || rep || null });
  }

  // «Earlier entries» on the top of a feed that has more on the server.
  function emEarlierOf(r) {
    const key = state.conversationId;
    // A chat of a folder: «Earlier messages» reads one page more of its past.
    if (r && r.folderMore && WcHistory.isFolderKey(key)) {
      const more = async () => {
        await WcBus.call('WC_FOLDER_EARLIER', { key });
        const again = await WcBus.call('WC_LOAD_CONVERSATION', { id: key });
        if (!again || !again.ok || state.conversationId !== key) return;
        if (profiChat) profiChat.words = monitorWords(again.turns);
        WcThread.renderTurns(again.turns, { newsHead, keepPlace: true, emEarlier: emEarlierOf(again), incoming: incomingOpts(), follow: true });
        followRunning();
      };
      more.label = 'Earlier messages';
      return more;
    }
    if (!r || !r.emMore || !WcHistory.isEmFeedKey(key)) return null;
    return async () => {
      await WcBus.call('WC_EM_EARLIER', { key });
      const again = await WcBus.call('WC_LOAD_CONVERSATION', { id: key });
      if (again && again.ok && state.conversationId === key) {
        WcThread.renderTurns(again.turns, { newsHead, keepPlace: true, emEarlier: emEarlierOf(again), incoming: incomingOpts(), follow: true });
        followRunning();
      }
    };
  }

  // ── Profi.ru ─────────────────────────────────────────────────────────────
  // The list, the chat of new orders and the settings are lex-profi.js. An order chat is
  // an ordinary conversation that opens here: the thread draws it through the object of
  // the chat, and the section keeps watching the server while it is open.
  let profiChat = null;
  function profiEls() {
    return {
      main: document.querySelector('.wc-main'),
      person: document.getElementById('wc-profi-person'),
      link: document.getElementById('wc-profi-link'),
      who: document.getElementById('wc-chat-who'),
    };
  }
  function leaveProfiChat() {
    const { main, person, link, who } = profiEls();
    person.hidden = true;
    person.replaceChildren();
    link.replaceChildren();
    who.replaceChildren();
    who.hidden = true;
    main.classList.remove('is-profi-chat', 'is-profi-clean', 'is-agent-chat');
    if (global.WcComposer && WcComposer.refresh) WcComposer.refresh();
    // profiChat goes below: the column is painted again when it has gone.
    setTimeout(paintFieldProfile, 0);
    paintProfiOutbox(null);
    paintAgentStop(null);
    // The line of a reply on a message of this chat does not go to another chat: it is this chat's
    // draft, and the next chat fills the field with its own (takeField).
    if (profiChat) {
      profiChat = null;
      endVisit();
      WcThread.setProfiChat(null);
      WcBus.call('WC_PROFI_CHAT', {}).catch(() => {});
    }
    if (SECTIONS.profi.live) SECTIONS.profi.live.unwatch();
  }
  function buildProfi() {
    return global.LexProfi.createSection({
      back: sectionBack,
      // The feed of new orders, the bot's chat and the settings open over the main page of the people: the arrow leads back
      // to it. showFeed — New orders over it from a press on an order whose reply waits there.
      root: mainTarget,
      showFeed: (order) => showProfi('feed', order || null),
      signals,
      rpc: newsRpc,
      // The clients of the order chats the list shows: the Mac app names «Send to <first name>» on the notification of
      // a draft after a call by them (PushNotifications.swift, as the iPhone's PushCenter.noteClients).
      clients: (names) => { if (shellShowsBadge() && names.length) tellShell({ word: 'clients', names }); },
      read,
      copy: copyText,
      openOrder: openProfiOrder,
      notify: (text) => toast(text, { error: true }),
      onChange: refreshProfiChat,
      head: paintProfiHead,
      // Delete chat asks first (the dialog В7.16).
      confirm: (title, text, o) => WcUI.confirm(title, text, o),
    });
  }
  // The head of New orders in the bar, where an order chat shows its client (lex-profi.js feedHead):
  // the mark of Профи.ру, «New orders», «Профи.ру»; null — the bar as it was.
  function paintProfiHead(nodes) {
    const { main, person } = profiEls();
    main.classList.toggle('is-profi-feed', !!nodes);
    if (nodes) {
      person.replaceChildren(...nodes);
      person.hidden = false;
    } else if (!profiChat) {
      person.replaceChildren();
      person.hidden = true;
    }
  }
  function enterProfiChat(chat) {
    const { main } = profiEls();
    if (isAgentChat(chat)) chat.data = withAgentStop(chat.data);
    profiChat = chat;
    WcThread.setProfiChat(chat);
    // The sending side is told this chat again here: the chat that was open before is left on the way in (leaveSection
    // → leaveProfiChat), and that leave tells it «no order chat» after the press already named this one. A chat opened
    // over another order or folder chat (a notification, the same chat pressed again) then sent its words as an
    // ordinary chat, with the page's chain, and the server refused every one: «a folder chat turn carries one message»
    // (23.11.2026, the live check of Stop).
    const told = chat.data && chat.data.chatKey;
    if (told) WcBus.call('WC_PROFI_CHAT', { key: told, modelId: chat.data.modelId || null }).catch(() => {});
    main.classList.add('is-profi-chat');
    // A task chat of an agent takes only words: its field has no presets, no live voice, no picture or file in «+»
    // (its profile: paintFieldProfile → WcComposer.setProfile). The slot of the voice folds again by what the field holds.
    main.classList.toggle('is-agent-chat', isAgentChat(chat));
    paintFieldProfile();
    if (WcComposer.refresh) WcComposer.refresh();
    // The clean view the chat starts with (on, lex-profi.js createChat).
    main.classList.toggle('is-profi-clean', !!chat.clean);
    paintProfiBar();
    paintProfiOutbox(chat);
    paintAgentStop();
    // «Who is this» of an order chat (В7.52): the card of the person brings the words (lex-profi.js askBrief).
    chat.askBrief();
    // The section the chat came from follows the server while it is open: Profi.ru, or its folder.
    const from = SECTIONS[chat.sectionId || 'profi'];
    if (from && from.live) from.live.watch();
    // The label of «Text model» in this chat: the model of order chats, the monitor's of
    // this chat by default — known once WC_PROFI_CHAT told it.
    refreshTextModelLabel();
  }
  // The clean view of the open chat changed — by its button, by Show on a line of the talk with Lex, by a word to Lex, or
  // by the server (another device): the page follows, the button in the bar too. A chat not open yet changes nothing.
  function profiCleanChanged(chat, on) {
    if (!chat || profiChat !== chat) return;
    profiEls().main.classList.toggle('is-profi-clean', !!on);
    paintProfiBar();
  }
  // The bar over an order chat, as in Telegram: the client's letter, name and channel, and the
  // button of the clean view (lex-profi.js bar(); the order on Profi is the title of the card).
  function paintProfiBar() {
    const { person, link, who } = profiEls();
    if (!profiChat || !profiChat.data) return;
    const bar = profiChat.bar();
    person.replaceChildren(...bar.person.childNodes);
    // The photo and the name are one button: the card of the person (lex-person.js, В7.41).
    person.onclick = bar.open || null;
    person.disabled = !bar.open;
    person.setAttribute('aria-label', (bar.who || 'Client') + '. Open the card of the person');
    person.hidden = false;
    link.replaceChildren(...(bar.link ? [bar.link] : []));
    // «Who is this» (В7.52): the words of the database under the buttons of the bar; none — no line and no room.
    who.replaceChildren(...(bar.brief ? [bar.brief] : []));
    who.hidden = !bar.brief;
    // The chat's data came: who gets the text (the name, where he wrote last).
    paintAddressee();
  }
  // The person's own texts on their way to the client stand under the last message
  // (lex-profi.js paintOutbox): drawn with every reading of the chat, gone with the chat.
  function paintProfiOutbox(chat) {
    const host = document.getElementById('wc-profi-outbox');
    if (!host) return;
    if (!chat) { host.replaceChildren(); host.hidden = true; return; }
    chat.paintOutbox(host);
  }
  // A text taken back from its way to the client, or a box of the model to edit by hand («Edit
  // in the field»), goes into the field, unless the person has typed something else there.
  // opts.taken — the server has already taken it off its way (Cancel of one that waited): it goes in all the same,
  // before the words that stand there, so that it is not lost. true — the text is in the field.
  function putBackIntoField(text, opts) {
    const cur = (document.getElementById('wc-input') || {}).value || '';
    if (cur.trim() && opts && opts.taken) {
      WcComposer.setText(`${text}\n${cur}`);
      WcComposer.focus();
      return true;
    }
    if (cur.trim()) { toast('The field is not empty: the text was not put there.'); return false; }
    WcComposer.setText(text);
    WcComposer.focus();
    return true;
  }
  // What the screen of an order chat drew of the turns that come without the person — a message
  // of the client, what went to him, a notice of Profi: their words by uid. A fresh answer that
  // says other words for one of them (the text of a voice message comes later) draws the chat
  // again. The person's own turns and the answers of the model count by uid only: an answer just
  // written reaches the server a few hundred milliseconds after the screen, and reading it back
  // then would cut its tail (docs/BACKLOG.md, «Чат заказа на странице может показать ответ модели
  // недописанным»).
  const monitorWords = (turns) => new Map((turns || [])
    .filter((t) => t.uid && /^(profi|folder)_/.test(t.origin || ''))
    // a call (В7.42) draws from its view in the turn: a summary or a transcript that came changes the view
    .map((t) => [String(t.uid), (t.text || '') + (t.origin === 'profi_call' ? JSON.stringify(t.attachments || null) : '')]));
  function makeProfiChat(order, data, keep, opts) {
    const chat = global.LexProfi.createChat({
      rpc: newsRpc,
      copy: copyText,
      putBack: putBackIntoField,
      onClean: (on) => profiCleanChanged(chat, on),
      // Reply yourself, and a notification of a draft after a call: the chat opens with the draft and the
      // discussion shown (and tells the server so: the chat's view, lex-profi.js setView).
      clean: !(opts && (opts.replySelf || opts.showLex)),
      order,
      // The look of a message (В7.35–В7.40): the sheet of a quoted message (the common sheet В7.15), the
      // way to it in the chat, and the line of a reply over the field (В7.26).
      sheet: (o) => WcUI.sheet('wc-msg-sheet', o.title, [o.body], o.onClose),
      showInChat: (uid, o) => WcThread.showTurn(uid, o),
      reply: (r) => setReply(r),
      replyQuote: () => (reply && reply.quoteUid) || null,
      replyDone: () => { if (reply && reply.quoteUid) setReply(null); },
      edit: (e) => startEdit(e),
      editText: (uid, text) => editSentText(uid, text),
      react: (uid, emoji) => reactSent(uid, emoji),
      notify: (text) => toast(text, { error: true }),
      reload: () => refreshProfiChat().catch((e) => console.warn('[wc] order chat:', e && e.message)),
      // The card of the person (lex-person.js, В7.41): its server door; a new name re-reads the chat;
      // a person deleted from Lex takes his chat off the list — the main page is shown.
      person: (body) => WcBus.call('WC_PERSON', { body }),
      onPersonGone: () => newConversation(),
      // The message of the agent «Кто это» that attached the client's messenger (В7.54): a line of it opens a chat of
      // Lex; the line «Reply to Lex» over the field takes a word to the agent (send(), sendWhois).
      go: (place) => { openLexLink(place).catch((e) => console.warn('[wc] link of Lex:', e && e.message)); },
      armReply: (r) => armReply(r),
    });
    chat.data = data;
    chat.keep = keep || null;
    return chat;
  }
  // A press on an order chat. When the section holds it (read ahead, or open before), the chat
  // is on screen at once from that, and the press then goes to the server: the order is read,
  // the moment of the visit taken, and the fresh answer takes the place of what is shown.
  // Without it one answer brings everything (profi_item).
  async function openProfiOrder(order, wanted, heldNow, keep, opts) {
    // Nothing held — after a restart: the copy this device kept of the order (lex-reads.js) is
    // held and shown the same way, and the press reads the order at once, as with what was held.
    let held = heldNow;
    if (!(held && held.chatKey && held.chat)) {
      const copy = await kept('profi_item', { p_order: order });
      if (!wanted()) return;
      if (copy && copy.chatKey && copy.chat) {
        held = copy;
        if (keep) keep(copy);
      }
    }
    if (held && held.chatKey && held.chat) {
      const chat = makeProfiChat(order, held, keep, opts);
      await WcBus.call('WC_PROFI_CHAT', { key: held.chatKey, modelId: held.modelId });
      await openConversation(held.chatKey, { profi: chat, back: profiBack(opts), wanted, loaded: held.chat });
      // The chat is on screen: a lost answer is not «the chat did not open». The watch of the
      // section reads it again with the next change, and the visit's moment is written on leaving.
      if (profiChat === chat) await refreshProfiChat({ take: true }).catch((e) => console.warn('[wc] order chat:', e && e.message));
      return;
    }
    const read = () => newsRpc('profi_item', { p_order: order, p_on_screen: true, p_take: true });
    let data = await read();
    if (!wanted()) return;
    // No answer at all: Lex has no such order. A row without a chat gives an answer with no `chatKey` (below).
    if (!data) { toast('This order is not in Lex', { error: true }); return; }
    if (!data.chatKey) {
      // An order from a list of the day has no chat yet: it opens the way Reply yourself does.
      await newsRpc('profi_command', { p_op_id: global.LexProfi.newOpId(), p_kind: 'reply_self', p_order: order, p_args: {} });
      data = await read();
      if (!wanted()) return;
    }
    if (!data || !data.chatKey) { toast('The chat did not open', { error: true }); return; }
    if (keep) keep(data);
    const chat = makeProfiChat(order, data, keep, opts);
    await WcBus.call('WC_PROFI_CHAT', { key: data.chatKey, modelId: data.modelId });
    await openConversation(data.chatKey, { profi: chat, back: profiBack(opts), wanted, loaded: data.chat });
  }
  // The server changed something: boxes, new turns, whether the client waits. The answer
  // being written stays as it is; its turn comes with the next change. take — the press that
  // opened the chat from what the section held: the order is read and the visit's moment taken.
  async function refreshProfiChat(opts) {
    const chat = profiChat;
    if (!chat) return;
    if (chat.folder) { await refreshFolderChat(opts); return; }
    const take = !!(opts && opts.take);
    const data = await newsRpc('profi_item', {
      p_order: chat.order, p_on_screen: take || document.visibilityState === 'visible', p_take: take,
    });
    if (!data || profiChat !== chat) return;
    if (chat.keep) chat.keep(data);
    if (data.modelId !== chat.data.modelId) {
      await WcBus.call('WC_PROFI_CHAT', { key: data.chatKey, modelId: data.modelId });
      refreshTextModelLabel();
    }
    // The moment the chat was open before, as the server has it: another device may have
    // opened it since the section read it ahead.
    let moved = false;
    if (take && data.chat && visit && visit.key === data.chatKey && (data.chat.since || null) !== (visit.since || null)) {
      visit.since = data.chat.since || null;
      moved = true;
    }
    chat.data = data;
    paintProfiBar();
    paintProfiOutbox(chat);
    // An answer being written or a voice conversation going on (its bubbles are not on the
    // server yet, a redraw would take them off): the boxes only; the chat is read again when
    // the conversation ends (toggleVoice, onDisconnected).
    if (WcThread.isStreaming() || (global.WcVoice && (WcVoice.active || WcVoice.connecting))) { WcThread.whenFree('profi-boxes', () => WcThread.paintProfiBoxes()); return; }
    if (state.conversationId !== data.chatKey) return;
    const r = data.chat
      ? await WcBus.call('WC_ADOPT_CONVERSATION', { id: data.chatKey, conversation: data.chat.conversation, money: data.chat.money, marks: data.chat.marks })
      : await WcBus.call('WC_LOAD_CONVERSATION', { id: state.conversationId });
    if (!r || !r.ok || profiChat !== chat || WcThread.isStreaming() || state.conversationId !== data.chatKey) return;
    const shown = new Set(WcThread.shownUids());
    const words = monitorWords(r.turns);
    const before = chat.words || new Map();
    const same = r.turns.every((t) => !t.uid || shown.has(t.uid)) && [...words].every(([uid, w]) => before.get(uid) === w);
    if (!moved && same && !(opts && opts.force)) { WcThread.whenFree('profi-boxes', () => WcThread.paintProfiBoxes()); return; }
    WcThread.whenFree('profi-chat', () => {
      if (profiChat !== chat || WcThread.isStreaming() || state.conversationId !== data.chatKey) return;
      chat.words = words;
      WcThread.repaintKeepingPlace(r.turns, { newsHead, incoming: incomingOpts(), follow: true });
      followRunning();
      if (r.money && global.LexChatMoney) WcThread.paintMoney(global.LexChatMoney.normalize(r.money));
      restoreUnsent(r).catch((err) => console.warn('[wc] unsent:', err && err.message));
    });
  }

  // ── Folders of chats: Kolya, Other ────────────────────────────────────────
  // The list of a folder is lex-folders.js; a chat of it is drawn by the order chat object of
  // lex-profi.js (createChat with folder): the person's messages from every messenger, Gennady's,
  // the marks of the messengers, files, and the assistant in correspondence: Send gives the text to the
  // database, which sends it where the person wrote last (the edge function folder-send). A group
  // talks with the model as a person's chat (21.11.2026); its boxes and a hold of the arrow send into it where the
  // database sends to the groups of its messenger. The chat lives in the same place as an order chat (profiChat).
  function buildFolder(id) {
    return global.LexFolders.createSection({
      folder: SECTIONS[id].folder,
      title: SECTIONS[id].title,
      signals,
      rpc: newsRpc,
      openChat: (key, wanted, held, keepIt) => openFolderChat(id, key, wanted, held, keepIt),
      onChange: (payload) => refreshFolderChat({ payload }),
      confirm: (title, text, o) => WcUI.confirm(title, text, o),
    });
  }
  function leaveFolderChat() {
    for (const s of Object.values(SECTIONS)) if (s.folder && s.live) s.live.unwatch();
  }
  function makeFolderChat(sectionId, data, keepIt) {
    const chat = global.LexProfi.createChat({
      folder: true,
      rpc: newsRpc,
      copy: copyText,
      putBack: putBackIntoField,
      // The chat of a person or a group talks with the assistant in correspondence: it opens in the view the server keeps
      // for it (`view` of folder_item; never touched — clean, as an order chat).
      onClean: (on) => profiCleanChanged(chat, on),
      clean: !!(data && global.LexChatProfile && global.LexChatProfile.profileOf(data.chatKey, data).talk),
      sheet: (o) => WcUI.sheet('wc-msg-sheet', o.title, [o.body], o.onClose),
      showInChat: (uid, o) => WcThread.showTurn(uid, o),
      reply: (r) => setReply(r),
      replyQuote: () => (reply && reply.quoteUid) || null,
      replyDone: () => { if (reply && reply.quoteUid) setReply(null); },
      edit: (e) => startEdit(e),
      editText: (uid, text) => editSentText(uid, text),
      react: (uid, emoji) => reactSent(uid, emoji),
      notify: (text) => toast(text, { error: true }),
      reload: () => refreshFolderChat().catch((e) => console.warn('[wc] folder chat:', e && e.message)),
      sendText: (text, quoteUid, opts) => sendToFolder(chat, text, quoteUid, opts && opts.at, opts && opts.files),
      // The door of the chat (LexDraftBox.door): its boxes and the held arrow go to the person by folder-send.
      folderSend: (body) => WcBus.call('WC_FOLDER_SEND', { body }),
      // The agent «Кто это» (В7.50, В7.54): a link of Lex in its words or a line of its message opens that chat; the
      // word that waits for Gennady puts the line «Reply to Lex» over the field (armReply), its word goes by send().
      go: (place) => { openLexLink(place).catch((e) => console.warn('[wc] link of Lex:', e && e.message)); },
      armReply: (r) => armReply(r),
      // A task chat of an agent (board AgChat): its head opens the passport of the agent.
      agentPassport: (key) => openAgentPassport(key),
      // A chat of a person (its profile: `card: 'person'`): the head opens the card of the person (lex-person.js, В7.41),
      // the same door as an order chat's; a person deleted from Lex takes his chat off the list — the main page is shown.
      person: (body) => WcBus.call('WC_PERSON', { body }),
      onPersonGone: () => newConversation(),
    });
    chat.folder = true;
    chat.sectionId = sectionId;
    chat.data = data;
    chat.keep = keepIt || null;
    return chat;
  }
  // A press on a chat of a folder: what the section holds (or this device kept) is on screen at once,
  // and the press then reads it and takes the moment of the visit; nothing held — one answer.
  // The section of the folder chat opened last (placeNow: the place the window comes back to).
  let folderOfChat = null;
  // back — the way back from the chat: the main page, or the folder of its agent (the section «Agents»).
  async function openFolderChat(sectionId, key, wanted, heldNow, keepIt, backTo) {
    folderOfChat = { key, sectionId };
    const back = backTo || mainTarget();
    let held = heldNow;
    if (!(held && held.chatKey && held.chat)) {
      const copy = await kept('folder_item', { p_chat_key: key });
      if (!wanted()) return;
      if (copy && copy.chatKey && copy.chat) {
        held = copy;
        if (keepIt) keepIt(copy);
      }
    }
    if (held && held.chatKey && held.chat) {
      const chat = makeFolderChat(sectionId, held, keepIt);
      await WcBus.call('WC_PROFI_CHAT', { key: held.chatKey, modelId: held.modelId || null });
      await openConversation(held.chatKey, { profi: chat, back, wanted, loaded: held.chat });
      if (profiChat === chat) await refreshFolderChat({ take: true }).catch((e) => console.warn('[wc] folder chat:', e && e.message));
      return;
    }
    const data = await newsRpc('folder_item', { p_chat_key: key, p_on_screen: true, p_take: true });
    if (!wanted()) return;
    if (!data || !data.chatKey || !data.chat) { toast('The chat did not open', { error: true }); return; }
    if (keepIt) keepIt(data);
    const chat = makeFolderChat(sectionId, data, keepIt);
    await WcBus.call('WC_PROFI_CHAT', { key: data.chatKey, modelId: data.modelId || null });
    await openConversation(data.chatKey, { profi: chat, back, wanted, loaded: data.chat });
  }
  // The database changed something: a message came, one changed (a reaction, an edit, its file), a
  // text went or did not. A signal about another chat is not read. take — the press that showed the
  // chat from what was held: it is read and the visit's moment taken.
  async function refreshFolderChat(opts) {
    const chat = profiChat;
    if (!chat || !chat.folder || !chat.data || !chat.data.chatKey) return;
    const told = opts && opts.payload && opts.payload.chatKey;
    if (told && told !== chat.data.chatKey) return;
    const take = !!(opts && opts.take);
    const data = await newsRpc('folder_item', {
      p_chat_key: chat.data.chatKey, p_on_screen: take || document.visibilityState === 'visible', p_take: take,
      p_limit: WcHistory.folderLimit(chat.data.chatKey),
    });
    if (!data || !data.chatKey || profiChat !== chat) return;
    if (chat.keep) chat.keep(data);
    if ((data.modelId || null) !== (chat.data.modelId || null)) {
      await WcBus.call('WC_PROFI_CHAT', { key: data.chatKey, modelId: data.modelId || null });
      refreshTextModelLabel();
    }
    let moved = false;
    if (take && data.chat && visit && visit.key === data.chatKey && (data.chat.since || null) !== (visit.since || null)) {
      visit.since = data.chat.since || null;
      moved = true;
    }
    chat.data = isAgentChat(chat) ? withAgentStop(data) : data;
    paintFieldProfile();
    paintProfiBar();
    paintProfiOutbox(chat);
    paintAgentStop();
    // An answer of the assistant being written: its bubble is not on the server yet, a redraw would take it off —
    // the boxes only; the chat is read again when the answer ends.
    if (WcThread.isStreaming()) { WcThread.paintProfiBoxes(); return; }
    if (!data.chat || state.conversationId !== data.chatKey) return;
    const r = await WcBus.call('WC_ADOPT_CONVERSATION', { id: data.chatKey, conversation: data.chat.conversation, money: data.chat.money, marks: data.chat.marks });
    if (!r || !r.ok || profiChat !== chat || WcThread.isStreaming() || state.conversationId !== data.chatKey) return;
    const shown = new Set(WcThread.shownUids());
    const words = monitorWords(r.turns);
    const before = chat.words || new Map();
    const same = r.turns.every((t) => !t.uid || shown.has(t.uid)) && [...words].every(([uid, w]) => before.get(uid) === w);
    // The prices stand under the answers and on top as the server has them (folder_item brings the money of the chat):
    // after a repaint, which draws the turns clean, and without one.
    const paintFolderMoney = () => { if (r.money && global.LexChatMoney) WcThread.paintMoney(global.LexChatMoney.normalize(r.money)); };
    if (!moved && same && !(opts && opts.force)) {
      WcThread.whenFree('profi-boxes', () => { WcThread.paintProfiBoxes(); paintFolderMoney(); });
      return;
    }
    WcThread.whenFree('profi-chat', () => {
      if (profiChat !== chat || state.conversationId !== data.chatKey) return;
      chat.words = words;
      WcThread.repaintKeepingPlace(r.turns, { newsHead, incoming: incomingOpts(), emEarlier: emEarlierOf(r), follow: true });
      followRunning();
      paintFolderMoney();
    });
  }
  // Send in a chat of a folder: the text goes to the database for the person (folder-send), which
  // sends it where he wrote last, or to the messenger of the message it answers; it stands under the
  // last message until it went. true — the server took it.
  const GROUP_REFUSAL = 'Lex does not write to groups: answer in the messenger.';
  // The held arrow of a chat of a folder: the text to the person or the group now, by the door of the chat
  // (LexDraftBox.door, folder-send): one number of the press for these words until the server answered them, so a press
  // that got no answer does not go twice. A refusal (a group the database does not send into) says why. → true once the
  // server took the text (the field is cleared then).
  // at — a Date: the text waits in Lex for that time and leaves by itself (folder-send with sendAt); it stands at the end
  // of the chat as scheduled, with Cancel (lex-profi.js paintOutbox). files — the pictures and files of the field, in the
  // bucket already (WcAttach.forPerson): they go with the words (LexChatProfile.filesOf).
  async function sendToFolder(chat, text, quoteUid, at, files) {
    const words = String(text || '').trim();
    if (!words || !chat || !chat.data) return false;
    let out;
    try {
      out = await chat.door().direct(words, { quote: quoteUid || null, at: at || null,
        ...(Array.isArray(files) && files.length ? { files } : {}) });
    } catch (err) {
      toast('Not sent. ' + ((err && err.message) || ''), { error: true });
      return false;
    }
    if (out && out.ok === false) {
      toast(out.text || 'Not sent.', { error: true });
      return false;
    }
    if (quoteUid && reply && reply.quoteUid === quoteUid) setReply(null);
    if (out && out.test) toast('The folder is in the test mode: the text went to your test chat.');
    refreshFolderChat().catch((e) => console.warn('[wc] folder chat:', e && e.message));
    return true;
  }

  // ── The agent «Кто это» (19.11.2026, В7.50; no buttons since 21.11.2026, В7.54) ─────────────────────────
  // Gennady answers the agent in words. The line «Reply to Lex» over the field (the same line as a Reply on a message,
  // В7.26, kept in the draft the same way) carries the uid of the agent's message, and the next word of the field goes
  // here — to the agent of that case (the edge function folder-whois), never to the person and never to the assistant.
  // The chat of a new person or of a group: the word goes by the chat (the base finds its case); a chat of a person or an
  // order chat, where an attach of the agent stands: the word goes with the turn it answers (`replyTo`).
  const WHOIS_TURN = /^profi:whois:[0-9]{1,18}$/;
  // The line the chat puts over the field by itself (a word of the agent waits): only where no line stands now, quiet —
  // the field gets no focus and the draft is not told.
  function armReply(r) {
    if (reply || !r || !WHOIS_TURN.test(String(r.quoteUid || ''))) return false;
    setReply(r, { quiet: true });
    return true;
  }
  async function sendWhois(chat, key, text, r) {
    const words = String(text || '').trim();
    if (!words || !chat || !chat.data) return;
    // One word at a time: while a word of this chat is on its way a second press does nothing — its words stay in the field
    // (the press emptied it), the server never gets the same word twice from here.
    if (!chat.whoisSending(words, r && r.quoteUid)) { giveBack(key, text, r); return; }
    // The word stands at the end of the chat now, «Sending…», and the line over the field goes with it; a refusal brings
    // both back (takeWordBack) and says why under the message it answered.
    if (reply && r && reply.quoteUid === r.quoteUid) setReply(null);
    WcThread.scrollToEnd();
    try {
      await WcBus.call('WC_FOLDER_WHOIS', { body: { chatKey: chat.data.chatKey, text: words, replyTo: (r && r.quoteUid) || null,
        opId: global.LexFolders.newOpId() } });
    } catch (err) {
      const why = (err && err.message) || 'Try again.';
      // false — the chat drew the word already: it went, there is nothing to take back.
      if (chat.whoisRefused(why)) takeWordBack(key, text, r);
      else console.warn('[wc] word to Lex:', why);
      return;
    }
    // The server has the word: Lex thinks under it until the chat draws it.
    chat.whoisTaken();
    const again = chat.folder ? refreshFolderChat() : refreshProfiChat();
    Promise.resolve(again).catch((e) => console.warn('[wc] chat after a word to Lex:', e && e.message));
  }
  // The word the server refused goes back where it was typed: into the field of its chat with the line «Reply to Lex» over
  // it, or into the draft of its chat when another one is on the screen now.
  function takeWordBack(key, text, r) {
    if (key !== fieldKey) { giveBack(key, text, r); return; }
    const cur = WcComposer.text();
    WcComposer.setText(cur.trim() ? `${text}\n${cur}` : text);
    if (r && !reply) setReply(r);
  }
  // A press on a link of Lex in the words of the question: lex://chat/<ref of a person> — his chat among the chats of a
  // folder; lex://order/<number> — the order chat of Profi.ru. The screen opens them as the press on a notification does.
  async function openLexLink(place) {
    const m = /^(chat|order)\/(.{1,100})$/.exec(String(place || ''));
    if (!m) return;
    if (m[1] === 'order') {
      await openFromNotification({ kind: 'profi_message', chatKey: `__lex_profi__${m[2]}`, order: m[2] });
      return;
    }
    // A task chat of an agent (a:<agent>-<n>): found among the chats of that agent, opened over its folder.
    const task = /^a:([a-z0-9-]{1,40})-[0-9]{1,18}$/.exec(m[2]);
    if (task) {
      // its archive too (chat_archive.sql): an archived task chat opens all the same
      const [chats, arch] = await Promise.all([newsRpc('lex_agent_chats', { p_agent: task[1] }),
        newsRpc('lex_agent_archived', { p_agent: task[1] }).catch(() => null)]);
      const c = [...(Array.isArray(chats) ? chats : []), ...(Array.isArray(arch) ? arch : [])].find((x) => x && x.ref === m[2]);
      if (!c || !c.chatKey) { toast('This chat is not in Lex.', { error: true }); return; }
      await openFromNotification({ kind: 'folder_message', chatKey: c.chatKey, agent: task[1] });
      return;
    }
    const found = await newsRpc('folder_chat_by_ref', { p_ref: m[2] });
    if (!found || !found.chatKey) { toast('This person has no chat in Lex.', { error: true }); return; }
    await openFromNotification({ kind: 'folder_message', chatKey: found.chatKey, folder: found.folder || '' });
  }

  // ── The section «Agents» (21.11.2026, wc-agents.js) ───────────────────────────────────────────────────
  // A folder for every agent of the base, a chat for every task of the agent. A task chat is a chat of a folder
  // (folder_item, kind 'agent'): its words are the turns of the branch (origin folder_whois) — the agent's words as the
  // word of Lex (В7.50) without buttons, Gennady's as his word «To Lex», the system's as a plate. Every word of the
  // field goes to the agent (folder-agents, op say), nothing to a person or to the assistant; no files, presets or voice.
  // The arrow of the chat leads to the folder of its agent, the arrow of the folder to the list of the agents.
  const isAgentChat = (chat) => !!(chat && chat.folder && chat.data && global.LexChatProfile
    && global.LexChatProfile.kindOf(chat.data.chatKey, chat.data) === 'agent');
  // The agent of a task chat (folder_open `agent`: { key, name, state, opened_by, n }).
  const agentKeyOf = (chat) => (isAgentChat(chat) && chat.data.agent && chat.data.agent.key) || '';
  const ONLY_WORDS = 'Agents take only words.';
  const agentsCall = (body) => WcBus.call('WC_FOLDER_AGENTS', { body: body || null });
  function buildAgents() {
    return global.WcAgents.createSection({
      back: sectionBack,
      signals,
      rpc: newsRpc,
      call: agentsCall,
      openChat: (agent, chatKey, wanted) => openAgentChat(agent, chatKey, wanted),
      ask: (agent, run) => { askAboutRun(agent, run).catch((e) => console.warn('[wc] ask about a run:', e && e.message)); },
      pickModel: (anchor, modelId, onPick) => openModelMenu(anchor, modelId, {}, onPick, null, 'anthropic'),
      menu: (anchor, items) => WcUI.menu(anchor, items),
      toast: (text, error) => toast(text, error ? { error: true } : undefined),
      markdown: (host, text) => {
        if (global.WcMarkdown && typeof global.WcMarkdown.into === 'function') global.WcMarkdown.into(host, text);
        else host.textContent = text;
      },
      chatOpen: () => !!(profiChat && profiChat.sectionId === 'agents'),
      openKey: () => (isAgentChat(profiChat) && profiChat.data.chatKey) || null,
      onScreen: (id, agent) => agentsScreen(id, agent),
      wide: () => splitOn,
      onChange: (payload) => refreshFolderChat({ payload }),
    });
  }
  // ── The folder beside the chat (boards AgF2Wide, Comp2Agent, Comp2Wide, 22.11.2026) ─────────────────────────────
  // The screens of an agent have no field: the capsule «New chat» stands at the bottom right and begins a chat with that
  // agent when the words are sent (openQuick → quickCommit → newAgentChat). On a window from SPLIT_WIDE the screens of an
  // agent stand on the left, 440; on the right — the chat picked in the folder, with its own field, or, while none is
  // picked, an empty place with the mark of Lex and the capsule at its bottom right (no chat is made before a word goes);
  // «Activity» puts the journal there. The arrow leads the folder back to the list.
  const SPLIT_WIDE = '(min-width: 1024px)';
  // A window of one chat has no folder beside it, however wide.
  const wideMq = global.matchMedia && !soloChat ? global.matchMedia(SPLIT_WIDE) : { matches: false, addEventListener() {} };
  wideMq.addEventListener('change', () => paintHome());
  let splitOn = false;
  // One row on a screen of the section (В7.18, boards AgF2HeadA, AgF2Log, AgF2Wide): the centred head of the screen stands
  // in the bar of the window, the arrow in its empty left slot; the window's own buttons (the pencil of a new chat) are
  // not on the screens of the agents.
  function paintAgentsBar() {
    const main = document.querySelector('.wc-main');
    if (!main) return;
    const live = SECTIONS.agents && SECTIONS.agents.live;
    const on = sectionOn === 'agents' || splitOn;
    main.classList.toggle('is-agents-on', on);
    main.classList.toggle('is-agents-head', on && !!live && live.screen !== 'home');
  }
  function agentsScreen(id, agent) {
    const main = document.querySelector('.wc-main');
    const live = SECTIONS.agents.live;
    paintAgentsBar();
    // The capsule follows the screen: on every screen of the section, for the agent of the screen.
    paintCapsule();
    if (id === 'log-aside') {
      main.classList.add('is-agents-log');
      if (live && live.aside && !live.aside.isConnected) main.appendChild(live.aside);
      // A chat on the right gives its place to the journal: the folder stands as the section again, with the capsule
      // (no chat is made under the journal).
      if (!sectionOn) showSection('agents', { back: true }).catch((e) => console.warn('[wc] agents:', e && e.message));
      return;
    }
    if (sectionOn === 'agents') {
      // A screen of the section has no field; the field over the dimming keeps the agent's draft while it stands.
      if (!quick) takeField(null);
      paintHome();
      return;
    }
    // The folder beside a chat went back to the list: the section stands alone again.
    if (splitOn && id === 'home') { showSection('agents', { back: true }).catch((e) => console.warn('[wc] agents:', e && e.message)); return; }
    paintHome();
  }
  // Asked from applyHome: every change of what the screen holds paints the split again. Two ways of it: a chat of the
  // agent on the right (the section has left, the folder stays on the left), or the section itself on a screen of an
  // agent with the right empty (the capsule stands there).
  function paintSplit() {
    const main = document.querySelector('.wc-main');
    const host = document.getElementById('wc-section-host');
    const live = SECTIONS.agents && SECTIONS.agents.live;
    let chat = false;
    let blank = false;
    if (wideMq.matches && live && live.screen !== 'home' && live.currentAgent()) {
      if (!sectionOn && isAgentChat(profiChat)) chat = live.currentAgent().key === agentKeyOf(profiChat);
      else if (sectionOn === 'agents') blank = true;
    }
    const on = chat || blank;
    if (!main || !host) return;
    main.classList.toggle('is-agents-split', on);
    main.classList.toggle('is-agents-blank', blank);
    if (blank) live.pick(null);
    if (chat) {
      host.hidden = false;
      for (const el of host.children) el.hidden = el !== live.el;
      entries.setActive('agents');
      live.pick((profiChat.data && profiChat.data.chatKey) || null);
      // The arrow acts on the folder (to the list), or on a passport over it.
      live.arrow();
      // The section stopped following the server when it left (leaveSection): the folder beside the chat follows it again.
      live.watch();
    } else if (splitOn && !on) {
      if (!sectionOn) host.hidden = true;
      if (live) { live.closeAside(); live.pick(null); }
      main.classList.remove('is-agents-log');
    }
    if (!on || !live || live.aside.hidden) main.classList.remove('is-agents-log');
    splitOn = on;
    paintAgentsBar();
  }
  // The bubble at a line of the journal (board AgAskRun): a new empty chat of the agent, the quote of the line over the
  // field (В7.26: «Log · HH:MM» and what the agent did, the cross); the first word goes with the id of the line (op chat, run).
  async function askAboutRun(agent, run) {
    const live = SECTIONS.agents.live;
    if (live) live.closeAside();
    await newAgentChat(agent);
    const d = new Date(run.at);
    const hhmm = Number.isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    setReply({ run: run.id, head: `Log${hhmm ? ` · ${hhmm}` : ''}`, text: run.title || '' });
  }
  // The section «Shopping list» (wc-shopping.js): the function shopping of the server, the common question.
  const shoppingCall = (body) => WcBus.call('WC_SHOPPING', { body: body || null });
  function buildShopping() {
    return global.WcShopping.createSection({
      back: sectionBack,
      signals,
      call: shoppingCall,
      confirm: (title, text, o) => WcUI.confirm(title, text, o),
    });
  }
  const agentTarget = (agent) => ({ title: agent.name || 'Agents', go: () => showSection('agents', { back: true }) });
  // A task chat opened: as a chat of a folder, the arrow to the folder of the agent; the base hears it was read.
  async function openAgentChat(agent, chatKey, wanted) {
    const live = SECTIONS.agents.live;
    if (live) live.closeAside();
    await openFolderChat('agents', chatKey, wanted || (() => true), null, null, agentTarget(agent));
    if (profiChat && profiChat.data && profiChat.data.chatKey === chatKey) {
      agentsCall({ op: 'read', chatKey }).catch((e) => console.warn('[wc] agent read:', e && e.message));
    }
  }
  // A press on the head of a task chat: the passport of its agent, over its folder. A wide window keeps the chat on the
  // right and puts the passport in the place of the folder; a narrow one shows the section.
  function openAgentPassport(key) {
    const live = ensureSection('agents');
    if (splitOn) { live.passport(key); return; }
    showSection('agents', { back: true, enter: (l) => l.passport(key) }).catch((e) => console.warn('[wc] passport:', e && e.message));
  }
  // A notification, a link, the place the Mac app comes back to: the section stands on the folder of the agent (not on
  // the screen), the chat opens over it.
  async function openAgentFrom(agentKey, chatKey, wanted) {
    const agent = await ensureSection('agents').enter(agentKey);
    if (wanted && !wanted()) return;
    await openAgentChat(agent, chatKey, wanted);
  }
  // A new chat with an agent (22.11.2026: a question about a line of its journal, the words sent from the capsule «New
  // chat» on its screens): an empty chat of that agent («New chat», the agent's name under it) with the field; the first
  // word makes the chat (op chat), and this screen becomes it. Its words wait in a draft of their own.
  const agentDraftKey = (key) => `__lex_agent_new__${key}`;
  async function newAgentChat(agent) {
    const live = SECTIONS.agents.live;
    if (live) live.closeAside();
    if (WcThread.isStreaming()) leaveStream();
    await endVoiceOnLeave('open-chat');
    stopSectionOpening();
    // profile.kind: the chat has no key yet, and a kind from a key would be the main chat — the word would not go to the
    // agent (isAgentChat), the field would refuse it as a chat of a folder that takes no messages.
    const chat = makeFolderChat('agents', {
      kind: 'agent', chatKey: null, title: 'New chat', client: 'New chat', send: false, profile: { kind: 'agent' },
      agent: { key: agent.key, name: agent.name || agent.key }, looks: {}, sends: [], channels: {},
    }, null);
    takeField(agentDraftKey(agent.key));
    leaveSection();
    endVisit();
    state.conversationId = null;
    WcThread.clear();
    resetMoney();
    paintNewsBar(null);
    WcSidebar.setActive(null);
    WcHeader.setTitle('');
    sectionBack.cameFrom(agentTarget(agent));
    enterProfiChat(chat);
    syncAttachment();
    paintAddressee();
    paintHome();
    WcSidebar.close();
    WcComposer.focus({ raiseKeyboard: true });
  }
  // A word to the agent: it stands at the end of the chat at once, «Sending…», and Lex «thinks» under it once the base
  // took it; a refusal brings it back into the field and says why. One word at a time, a fresh number every press.
  // rep — the line over the field at the press: a question about a line of the journal ({ run }) goes with its id.
  async function sendToAgent(chat, key, text, opts, rep) {
    const words = String(text || '').trim();
    const run = !chat.data.chatKey && rep && rep.run ? String(rep.run) : null;
    if ((opts && opts.mode) || WcAttach.count()) {
      giveBack(key, text || '', rep || null);
      toast(ONLY_WORDS, { error: true });
      return;
    }
    if (!words) return;
    if (!chat.whoisSending(words, null)) { giveBack(key, text, rep || null); return; }
    WcThread.scrollToEnd();
    const fresh = !chat.data.chatKey;
    const opId = global.LexFolders.newOpId();
    let out;
    try {
      out = await agentsCall(fresh
        ? { op: 'chat', agent: chat.data.agent.key, text: words, opId, ...(run ? { run } : {}) }
        : { op: 'say', chatKey: chat.data.chatKey, text: words, opId });
    } catch (err) {
      const why = (err && err.message) || 'Try again.';
      if (chat.whoisRefused(why)) takeWordBack(key, text, rep || null);
      toast('Not sent. ' + why, { error: true });
      return;
    }
    chat.whoisTaken();
    // A new word starts the agent anew: a Stop pressed a moment ago no longer draws this chat stopped.
    if (!fresh) stops.forget('agent', chat.data.chatKey);
    if (!fresh) { refreshFolderChat().catch((e) => console.warn('[wc] folder chat:', e && e.message)); return; }
    // The new chat has its key: its draft goes (and the quote of the line with it), and the screen becomes the chat (the
    // arrow still to the folder).
    if (reply && reply.run && key === fieldKey) setReply(null, { quiet: true });
    if (global.LexDrafts) global.LexDrafts.clear(key);
    if (out && out.chatKey && profiChat === chat) await openAgentChat(chat.data.agent, out.chatKey, () => profiChat === chat);
  }
  // ── One Stop (lex-stop.js; docs/spec/21-chat-canvas.md, «Стоп») ───────────────────────────────────────────────────
  // Whose the round button of the field stops is the profile of the chat (`stop`) and what goes on: the page's own answer
  // of the model (turn), the agent of the open task chat while its copy says «Working» (agent; Gennady, 22.11.2026: «Стоп
  // всегда виден, пока идёт ход, и реально останавливает»). The Stop under a running development task (task) is not the
  // field's: its button stands under its row (LexMessage.taskStop) and goes through the same controller. One refusal for
  // all: «Not stopped. <why>».
  // The agent's Stop stands after a return, a reload, a restart and on another device, for it is read from the chat's copy,
  // not from this page. A press asks the base (folder-agents, op stop): the chat flips at once — no «Working», no live
  // stage, no Stop — and the answer of the server and its signal «folders» confirm it; a refusal brings Stop back and says
  // why. The agent ending by itself takes Stop away by the same signal. The page's own answer holds the button over it.
  const stops = global.LexStop.create({
    doors: {
      turn: () => stopStream(),
      agent: (chatKey) => agentsCall({ op: 'stop', chatKey }),
      // lex_dev_stop (dev_tasks.sql): the row says «остановлено» by itself through the feed.
      task: (task) => WcHistory.rpc('lex_dev_stop', { p_task: task }),
    },
    changed: (who, key) => { if (who === 'agent') repaintAgentStop(key); },
  });
  let agentStopKey = null;   // the chat whose Stop the button shows
  // The copy of a task chat as it is drawn: while a Stop is held (on its way, and LexStop.AFTER_MS after: the relay of the
  // base a moment behind) a copy that still says «Working» is drawn stopped; the hold over, as its last read says.
  function withAgentStop(data) {
    if (!data || !data.chatKey) return data;
    const read = data.agentAsRead ? Object.assign({}, data, { agent: data.agentAsRead, agentAsRead: undefined }) : data;
    if (!stops.holding('agent', data.chatKey)) return read;
    if (!global.LexProfi.agentWorks(read)) {
      // The copy says it does not work: the hold is over (a press still in its way keeps it).
      stops.settle('agent', data.chatKey);
      return read;
    }
    const agent = Object.assign({}, read.agent, { state: 'waiting' });
    delete agent.stage;
    delete agent.stage_key;
    // the mark the copy came with, for the end of the hold to put back
    return Object.assign({}, read, { agent, agentAsRead: read.agent });
  }
  function repaintAgentStop(chatKey) {
    const chat = profiChat;
    if (!isAgentChat(chat) || chat.data.chatKey !== chatKey) return;
    chat.data = withAgentStop(chat.data);
    paintProfiBar();
    paintProfiOutbox(chat);
    paintAgentStop();
  }
  // chat — the chat on the screen (null: the screen is leaving it).
  function paintAgentStop(chat = profiChat) {
    const P = global.LexChatProfile;
    const profile = chat && chat.data && P ? P.profileOf(chat.data.chatKey, chat.data) : null;
    const who = global.LexStop.fieldWho(profile, {
      answering: !!state.requestId,
      agentWorks: isAgentChat(chat) && global.LexProfi.agentWorks(chat.data),
    });
    if (who === 'turn') { agentStopKey = null; return; }   // the answer's own Stop holds the button
    const key = who === 'agent' ? chat.data.chatKey : null;
    if (!key && !agentStopKey) return;
    agentStopKey = key;
    WcComposer.setStreaming(!!key, key ? global.LexStop.idOf('agent', key) : undefined);
  }
  // The round button of the field pressed while it is Stop: its number says whose (LexStop.parse).
  function stopFromField(id) {
    const { who, key } = global.LexStop.parse(id);
    const chat = profiChat;
    if (who === 'agent' && (!isAgentChat(chat) || chat.data.chatKey !== key)) return;
    stops.stop(who, key).then((ok) => {
      if (ok && who === 'agent' && profiChat === chat) {
        refreshFolderChat().catch((e) => console.warn('[wc] folder chat:', e && e.message));
      }
    }, (err) => toast(global.LexStop.refusal(err), { error: true }));
  }
  // The model of an agent (its folder, «+ → Text model» in its chats): the common menu of the models, Anthropic only;
  // the choice goes to the base (op settings), the list is read again and shows the new value.
  function pickAgentModel(anchor, agentKey) {
    const live = ensureSection('agents');
    const agent = live.agent(agentKey);
    if (!agent) {
      toast('The agents are not read yet. Try again.', { error: true });
      live.readList().catch(() => {});
      return;
    }
    openModelMenu(anchor, global.WcAgents.modelId(agent), {}, (modelId) => {
      const [, model, effort] = modelId.split(':');
      live.saveModel(agentKey, model, effort).catch((e) => console.warn('[wc] agent model:', e && e.message));
    }, null, 'anthropic');
  }


  // A chat left open behind other windows gets read when the person comes back to it.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshProfiChat().catch(() => {});
  });

  // opts.typing — the person pressed «New chat» to write: the field takes the cursor and the keyboard rises. The main
  // page shows the chats of people, and none of the other ways to it (the start, a chat deleted, the arrow back) raises
  // a keyboard over them. «New chat» also puts the main page on «All» at its top (Gennady, 20.11.2026); the arrow back
  // keeps the tab it left.
  async function newConversation(opts) {
    // opts.stay — the field over a dimmed screen makes the new chat ready under it: the section on the screen stays.
    const stay = !!(opts && opts.stay);
    if (opts && opts.typing && !stay) homeToAll();
    if (WcThread.isStreaming()) leaveStream();
    refreshPublished();
    // «Новая беседа» — уход из прежней: голос гасим до сброса состояния (то же
    // решение, что в openConversation). Карандаш во время звонка спрятан, но
    // сюда же ведёт удаление открытой беседы из панели (deleteConversation).
    await endVoiceOnLeave('new-chat');
    stopSectionOpening();
    takeField(newChatKey());
    if (!stay) leaveSection();
    endVisit();
    state.conversationId = null;
    WcThread.clear();
    resetMoney();
    if (!stay) paintNewsBar(null);
    WcSidebar.setActive(null);
    WcHeader.setTitle('');
    syncAttachment();
    paintAddressee();
    paintHome();
    WcBus.call('WC_NEW_CONVERSATION').catch((err) => console.warn('[wc] new:', err && err.message));
    // «New chat» and the pencil: where the main page has no field of its own (the chats of the people stand on it), the
    // field rises over it dimmed, as from the capsule (В7.64); elsewhere the empty chat takes the cursor.
    if (opts && opts.typing && !stay) {
      if (people.hasTabs) openQuick('type').catch((e) => console.warn('[wc] quick:', e && e.message));
      else WcComposer.focus({ raiseKeyboard: true });
    }
  }

  // ── Клавиатура и боковая панель ──────────────────────────────────────────
  //
  // Единственная точка, где решается судьба курсора/клавиатуры у поля ввода
  // по поводу панели бесед. Зовётся из WcSidebar.toggle() — а туда сходятся
  // ОБА пути: кнопка-гамбургер и протяжка пальцем от края (installDrag в
  // wc-sidebar.js), так что кнопка и жест решаются одинаково по построению,
  // не по двум спискам кода.
  //
  // Правило (решение владельца, 2026-08-21):
  //  · панель ОТКРЫВАЕТСЯ — курсор/клавиатура уходят ВСЕГДА, каким бы
  //    способом её ни открыли;
  //  · панель ЗАКРЫВАЕТСЯ — курсор/клавиатура возвращаются, только если в
  //    беседе, что сейчас открыта, ещё нет ни одного сообщения. Проверка одна
  //    и та же для всех путей закрытия (кнопка, протяжка, тап по скриму, клик
  //    по пункту списка, «новый чат»): WcThread.isEmpty().
  //
  // Ровно поэтому явный focus() убран из openConversation() и newConversation()
  // выше — оба заканчиваются вызовом WcSidebar.close(), и тем самым уже
  // проходят через эту точку. Раздельные вызовы плодили бы два места, которые
  // легко развести разными решениями (это и была причина дефекта: жест шёл в
  // обход единственного места, где клавиатура убиралась).
  //
  // The main page of the people (2026-11-19): over the chats of people no keyboard rises by itself — the screen one
  // would cover the list. The field takes the cursor there only where the keyboard is on the desk, or when the person
  // presses «New chat» or the field itself.
  function onSidebarToggle(open) {
    if (open) { WcComposer.blur(); return; }
    if (WcThread.isEmpty()) WcComposer.focus({ raiseKeyboard: !homeOn() });
  }

  async function send(text, opts) {
    // The line of Edit stands over the field: the arrow edits that message at the person (19.11.2026).
    if (reply && reply.editUid) { await (reply.editTurn ? sendEdit(text) : submitEdit(text)); return; }
    // Sent from the field over a dimmed screen (В7.64): the screen becomes the new chat first, then the words go to it.
    if (quick) await quickCommit();
    // Whose words these are is fixed at the press: the chat on the screen then. A turn that waits for
    // the start's settings and finds another chat on the screen does not go anywhere — its words go
    // back into the draft of their own chat (giveBack). Before, the chat was read after the wait, and
    // words typed for one person could go to the person whose chat was opened meanwhile.
    const key0 = fieldKey;
    const chat0 = profiChat;
    const conv0 = state.conversationId;
    const reply0 = replyOfField();
    await settingsReady;
    if (fieldKey !== key0 || profiChat !== chat0 || state.conversationId !== conv0) {
      giveBack(key0, text || '', reply0);
      toast('Not sent: another chat was opened. The words are in the draft of their chat.', { error: true });
      return;
    }
    // A task chat of an agent (the section «Agents»): every word of its field goes to the agent, and nothing else does.
    if (isAgentChat(chat0)) {
      await sendToAgent(chat0, key0, text, opts, reply0);
      return;
    }
    // The agent «Кто это»: with the line «Reply to Lex» of its message over the field the words go to the agent of that
    // case, nowhere else (a picture or a file of the field stays in it) — in a chat of a folder and in an order chat.
    if (chat0 && reply0 && WHOIS_TURN.test(reply0.quoteUid || '') && typeof chat0.whoisSending === 'function') {
      await sendWhois(chat0, key0, text, reply0);
      return;
    }
    // A chat of a folder: the chat of a person or of a group talks with the assistant in correspondence, as an order
    // chat (the text to the person or the group goes by a hold of the arrow, sendMenu, or from a box; Gennady,
    // 21.11.2026: a group too). A chat in no folder takes no text (the field is locked); a preset has no place here.
    if (profiChat && profiChat.folder && (opts && opts.mode)) {
      toast('Presets are not in the chats of folders.', { error: true });
      return;
    }
    // A group in a folder talks with the model even where the database does not send into it.
    if (profiChat && profiChat.folder && (!profiChat.data
        || (!profiChat.data.send && !(profiChat.data.kind === 'group' && profiChat.data.folder)))) {
      giveBack(key0, text || '', reply0);
      toast(profiChat.data && profiChat.data.kind === 'group' ? GROUP_REFUSAL : 'This chat takes no messages now.', { error: true });
      return;
    }
    // The chat on the screen came from this device's copy: the turn goes once the server's answer
    // is in, so its context is the server's. The answer did not come — once more now; failing
    // that, the turn does not go on a copy: the words go back into the field.
    const w = openWait;
    if (w && w.id === state.conversationId && !(await w.done) && w.id === state.conversationId) {
      let fresh = false;
      try {
        const again = await WcBus.call('WC_LOAD_CONVERSATION', { id: w.id });
        if (again && again.ok && state.conversationId === w.id) { paintConversation(again, { keepPlace: true }); fresh = true; }
      } catch (err) { console.warn('[wc] chat again before the turn:', err && err.message); }
      if (!fresh) {
        giveBack(key0, text || '', reply0);
        toast('No connection to the server: the message was not sent.', { error: true });
        return;
      }
    }
    if (openWait === w) openWait = null;
    // A word to Lex in an order chat brings the discussion back: its answer must be seen.
    if (profiChat && profiChat.clean) { profiChat.setClean(false); paintProfiBar(); }
    const images = WcAttach.take();
    // Files of this message (lex-file-attach.js): uploaded already, their records go with the turn.
    const files = WcAttach.takeFiles();
    // Слова, выбранные нажатием в ленте, забираются ЗДЕСЬ — в единственный
    // момент, когда набор перестаёт быть состоянием и становится репликой.
    // Наружу выходят две разные строки: `visible` — то, что человек увидит в
    // своём пузыре (слова плюс дописанное) и оно же уходит текстом реплики, а
    // `picks` — места выбранных слов. Строки Word/Context перед текстом ставит
    // сервер (supabase/functions/_shared/word-pick.ts), одинаково для всех
    // поверхностей. Набор при этом опустошается: иначе он уехал бы вторым
    // экземпляром со следующей репликой.
    const turn = global.WcWordPick
      ? WcWordPick.takeTurn(text)
      : { visible: String(text || '').trim(), sent: String(text || '').trim(), picks: null };
    if (!turn.visible && !images.length && !files.length) return;
    // 'native' or nothing. The mode rides with the turn rather than living as
    // page state: it is chosen per message (by which button was pressed), not
    // switched on and left on.
    const mode = (opts && opts.mode) || null;
    // Какой ЗАГОТОВКОЙ. Кнопка одна, заготовок много (lex-action-presets.js):
    // слот едет с ходом, а не читается на месте, — человек мог выбрать другую
    // между нажатием и отправкой, а промпт и модель обязаны относиться к той,
    // чьё имя он видел на кнопке.
    const slotId = (opts && opts.slotId) || null;
    // И на какой МОДЕЛИ. Тоже с ходом, и тоже готовым значением: имя ключа
    // модели заготовки считает сервер (см. handlePresets в prompts-admin), а
    // страница его больше не выводит — прежняя копия правила уже расходилась.
    // Пустая строка = «наследовать модель чата».
    const modelId = (opts && typeof opts.modelId === 'string') ? opts.modelId : '';

    // The preview URL made for the strip is handed to the bubble rather than
    // revoked and remade: it points at the same Blob, and revoking it here
    // would blank the picture the reader just sent.
    // Слот заготовки — на пузырь: «Edit» такого вопроса уйдёт той же заготовкой.
    WcThread.appendUser(turn.visible, images.map((i) => i.previewUrl).filter(Boolean), { presetSlot: mode ? slotId : null, files });
    // Заготовка в режиме «отдельный разговор» — подпись «учитель этого не
    // видит» сразу; кадр сервера её подтвердит или снимет (WcThread.settleApart).
    if (mode && opts && opts.presetMode === 'separate') WcThread.markLastUserApart(null);
    // Ход заготовки: пузырь сразу строкой и фразой, по строке из списка пилюль.
    // Первый кадр ответа (laterText) перерисует его серверной версией.
    // Заготовка выбранного материала («translate») со словами — пузырь сразу
    // словами и допечатанным, без строки; кадр сервера поставит свою версию.
    const P = global.LexActionPresets;
    const pickDefault = (turn.picks && mode && slotId && P && typeof P.pickDefaultOf === 'function' && opts && opts.presetScope)
      ? P.pickDefaultOf(opts.presetScope) : null;
    if (pickDefault && pickDefault.id === slotId && turn.words) {
      WcThread.setLastUserPick(turn.words, turn.typed || '');
    } else {
      const localLater = (mode && slotId && opts && typeof opts.laterOf === 'function')
        ? opts.laterOf(turn.visible) : '';
      if (localLater) WcThread.setLastUserPreset(localLater);
    }
    WcComposer.refresh();

    const requestId = nextRequestId();
    state.requestId = requestId;
    // The line of a reply goes with this message and leaves the box.
    const replyNow = state.conversationId === EM_QUESTIONS_KEY ? reply : null;
    // In an order chat — the message this word answers: its draft carries the quote while it is written.
    const quoteNow = profiChat && reply && reply.quoteUid ? reply.quoteUid : null;
    if (profiChat) profiChat.quoteSent(quoteNow);
    if (reply) setReply(null);
    // Номер операции — метка ОДНОГО нажатия. Из него считаются уиды обеих
    // реплик, и ровно то же правило применяет сервер: потому в базе на пузырь
    // одна строка, а не две. requestId рядом на эту роль не годится — он живёт
    // только внутри страницы и до сервера не доезжает вовсе.
    // Retry of a message that did not go keeps its number (opts.opId): a message that did reach
    // the server gets its answer, not a second one (lex_op_claim, chat_turn_fate.sql).
    const opId = (opts && typeof opts.opId === 'string' && opts.opId) || global.LexTurnId.newOpId();
    ownOps.add(opId);
    opOfRequest.set(requestId, opId);
    const pressedAt = Date.now();
    // Kept on this device from this moment, until the server has it (restoreUnsent). A message
    // with pictures is not kept: the pictures live only in this page.
    const kept = (images.length || files.length) ? null : {
      id: opId, chatKey: state.conversationId || null, text: turn.visible,
      at: new Date(pressedAt).toISOString(), state: 'sending',
      opts: { mode, slotId, modelId, presetMode: (mode && opts && opts.presetMode) || null },
    };
    if (kept) { outbox.set(requestId, kept); if (kept.chatKey) unsentPut(kept); }
    WcThread.beginAssistant(requestId);
    WcComposer.setStreaming(true, requestId);

    try {
      const r = await WcBus.call('WC_SEND', {
        requestId,
        opId,
        pressedAt,
        conversationId: state.conversationId,
        // Со скрытой частью — учителю нужен отрывок, в котором стоят выбранные
        // слова. Она же ложится в беседу: повтор хода и следующие реплики
        // обязаны видеть ровно то, что видела модель. В ленте её не показывает
        // ни живой пузырь, ни перечитывание (WcWordPick.visibleText).
        text: turn.sent,
        // Места выбранных слов; null — слов не выбирали.
        picks: turn.picks || null,
        // «Edit» вопроса без новых выбранных слов: из какого вопроса сервер
        // возьмёт скрытый блок (Word/Context/Source).
        pickFrom: (!turn.picks && opts && opts.pickFrom) ? String(opts.pickFrom) : null,
        images,
        files,
        mode,
        slotId,
        modelId,
        // Режим заготовки по списку пилюль: «отдельный разговор» страница не
        // кладёт в список урока до кадра сервера (wc-backend.js runSend).
        presetMode: (mode && opts && opts.presetMode) || null,
        // Reply in the feed of questions: the turns of the questions this message is about.
        emReply: (replyNow && replyNow.uids) || null,
        // Reply in an order chat: the message this word to Lex answers (В7.26).
        quoteUid: quoteNow,
      });
      // The first message is what mints the key. Adopt it so the next message
      // in this conversation lands in the same thread.
      if (r && r.conversationId && !state.conversationId) {
        state.conversationId = r.conversationId;
        WcSidebar.setActive(r.conversationId);
        adoptFieldKey(r.conversationId);
      }
      if (kept && !kept.chatKey && r && r.conversationId) {
        kept.chatKey = r.conversationId;
        if (outbox.get(requestId) === kept) unsentPut(kept);
      }
    } catch (err) {
      WcBus.broadcast({ type: 'STREAM_ERROR', requestId, error: String((err && err.message) || err) });
    }
  }

  // ── Привязанная страница ─────────────────────────────────────────────────
  // К чему привязана открытая беседа — страница или ролик, с которых её начали
  // в расширении. ПОКАЗЫВАЕТСЯ ПЕРВЫМ ПУНКТОМ МЕНЮ «+» (wc-composer.js), своей
  // строки над композером у неё больше нет.
  //
  // Полоска стояла здесь до 2026-08-28 и ушла вслед за расширением. Там она
  // осталась только у СВЕЖЕЙ беседы — той, где привязку ещё можно открепить
  // крестиком; здесь таких не бывает вовсе: привязку запечатывает сервер, а
  // прикрепить с телефона нечего — чужую вкладку он не читает. То есть полоска
  // показывалась ровно в том случае, который в расширении теперь живёт в меню,
  // и держать под него отдельную строку окна незачем.
  //
  // Читается по сети, поэтому лежит в переменной: меню открывается синхронно и
  // ждать ответа не может.
  //
  // Гонка, которую здесь легко проглядеть: чтение идёт по сети, а человек
  // успевает переключить беседу. Ответ, пришедший не для текущей, молча
  // выбрасывается — иначе меню показывало бы привязку предыдущей.
  let pageBarFor = null;
  let attachedPage = null;

  // Значок сайта, которому привязка ПРИНАДЛЕЖИТ. Свой документ здесь ни при
  // чём — мы на lex-me.club, а разговор про чужую страницу, — поэтому адрес
  // строится от её собственного происхождения. Не доедет — пункт меню сам
  // подставит обычный контур звена (wc-ui.js menuIcon).
  function faviconFor(url) {
    try { return new URL(url).origin + '/favicon.ico'; } catch (_) { return null; }
  }

  async function syncAttachment() {
    const want = state.conversationId;
    pageBarFor = want;
    if (!want) { attachedPage = null; return; }
    let att = null;
    // Вид беседы и адрес её контента берём из СТРОКИ СПИСКА — сервер уже их
    // прислал. Своего разбора ключа у страницы больше нет.
    const it = currentItem();
    const hint = it ? { kind: it.kind, url: it.attachmentUrl } : null;
    try {
      att = await WcBus.call('WC_ATTACHMENT', { id: want, hint });
    } catch (err) {
      console.warn('[wc] attachment:', err && err.message);
    }
    if (pageBarFor !== want) return;
    if (!att || !att.url) { attachedPage = null; return; }
    attachedPage = {
      url: att.url,
      label: att.title || att.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 80),
      iconUrl: faviconFor(att.url),
    };
  }

  // ── Выбор модели: под ответом и в меню «+» ───────────────────────────────
  //
  // Меню моделей — общее с расширением (model-picker-dropdown.js): все видимые
  // текстовые модели по поставщикам, у каждой подменю уровней размышления.
  // Отмечена модель, которую передали (модель ответа или модель по умолчанию).
  // choiceRow — строка под моделями с подменю выбора (у меню «Text model» — «Подписка или
  // токены API»), формат — model-picker-dropdown.js. provider — the models of one provider only (the model of an
  // agent of the base: Anthropic).
  function openModelMenu(anchor, selectedId, efforts, onPick, choiceRow, provider) {
    const D = global.LexModelPickerDropdown;
    if (!D) return;
    const parts = String(selectedId || '').split(':');
    D.open(anchor, {
      getSelected: async () => (parts.length >= 2 && parts[1] ? { provider: parts[0], apiModel: parts[1] } : null),
      getEffort: async (apiModel) => {
        // У выбранной модели — её уровень; у остальных — тот, что помнит
        // модель по умолчанию, иначе уровень реестра.
        if (parts[1] === apiModel && parts[2]) return parts[2];
        return (efforts && efforts[apiModel]) || null;
      },
      onPick: (provider, apiModel, effort) => onPick(provider + ':' + apiModel + ':' + effort),
      choiceRow: choiceRow || null,
      provider: provider || null,
    });
  }

  // Кнопка модели под последним ответом: переспросить этот ответ выбранной
  // моделью. Модель — только на этот ответ; модель по умолчанию не меняется.
  async function pickModelForAnswer(btn, turn) {
    if (WcThread.isStreaming()) return;
    let efforts = {};
    try { efforts = (await WcBus.call('WC_TEXT_MODEL', {})).efforts || {}; } catch (_) { efforts = {}; }
    openModelMenu(btn, turn.dataset.model || '', efforts, (modelId) => regenerate(turn, modelId));
  }

  // Пункт «Text model» в меню «+»: модель по умолчанию для следующих вопросов. Он есть в
  // каждом чате (2026-11-13), и модель у него одна на все чаты, где пишет Геннадий
  // (2026-11-25): главный, люди, группы, заказы, ленты. Своя — только у агента. Хранит и
  // отправляет wc-backend.js (WC_TEXT_MODEL, WC_SET_TEXT_MODEL).
  async function pickDefaultModel(anchor) {
    // A task chat of an agent: the model of that agent, not the model of the chats of orders.
    if (isAgentChat(profiChat)) { pickAgentModel(anchor, agentKeyOf(profiChat)); return; }
    // The field over the dimming of a screen of an agent: the model of that agent.
    if (quickAgentOn()) { pickAgentModel(anchor, quickAgentOn().key); return; }
    let cur = { modelId: null, efforts: {} };
    try { cur = await WcBus.call('WC_TEXT_MODEL', {}); } catch (_) { /* пусто — без галочки */ }
    openModelMenu(anchor, cur.modelId, cur.efforts, async (modelId) => {
      try {
        await WcBus.call('WC_SET_TEXT_MODEL', { modelId });
        WcUI.toast('Text model: ' + global.LexAnswerRow.modelLabel(modelId));
        refreshTextModelLabel();
      } catch (err) {
        WcUI.toast(String((err && err.message) || err), { error: true });
      }
    }, CLAUDE_ROUTE_ROW);
  }

  // Подпись пункта «Text model» — нынешняя модель по умолчанию, одна на все чаты. Меню «+»
  // открывается синхронно, поэтому подпись держится наготове.
  let textModelLabel = '';
  // The label of this chat: a task chat of an agent names the agent's model (the list of the section holds it).
  function textModelLabelNow() {
    if (quickAgentOn()) {
      const a = SECTIONS.agents.live.agent(quickAgentOn().key);
      return a ? global.WcAgents.modelLabel(a) : '';
    }
    if (!isAgentChat(profiChat)) return textModelLabel;
    const live = SECTIONS.agents.live;
    const agent = live && live.agent(agentKeyOf(profiChat));
    return agent ? global.WcAgents.modelLabel(agent) : '';
  }
  // Whether that model reads pictures: a picture picked as «File» goes the picture's way only
  // then (WcAttach.accept). Not known yet — it does, as before.
  let textModelSees = true;
  async function refreshTextModelLabel() {
    try {
      const cur = await WcBus.call('WC_TEXT_MODEL', {});
      if (!cur || !cur.modelId) { textModelLabel = ''; textModelSees = true; return; }
      const R = global.LexModelRegistry;
      textModelLabel = global.LexAnswerRow.modelLabel(cur.modelId);
      textModelSees = !R || R.visionSupported(cur.modelId);
    } catch (_) { textModelLabel = ''; textModelSees = true; }
  }

  // Подписка или токены API (claude_route.sql, 2026-11-18): как идут ходы Геннадия к модели
  // Claude. Один выбор на аккаунт, хранит сервер; строка «Подписка или токены API» внизу меню
  // «Text model» — только аккаунту с базой. Сервер спрашивается при каждом открытии меню —
  // выбор, сделанный на другом устройстве, виден сразу.
  async function claudeRouteCall(route) {
    try {
      const r = await WcBus.call('WC_CLAUDE_ROUTE', route ? { route } : {});
      return r && r.ok === true ? r : null;
    } catch (err) {
      if (route) WcUI.toast(String((err && err.message) || err), { error: true });
      return null;
    }
  }
  const CLAUDE_ROUTE_ROW = {
    label: 'Подписка или токены API',
    get: async () => {
      const r = await claudeRouteCall(null);
      if (!r || !r.available) return null;
      return {
        options: [{ value: 'subscription', label: 'Подписка' }, { value: 'api', label: 'Токены API' }],
        current: r.route === 'api' ? 'api' : 'subscription',
      };
    },
    onChoose: async (value) => {
      const r = await claudeRouteCall(value);
      if (r) WcUI.toast(r.route === 'api' ? 'Claude: токены API' : 'Claude: подписка');
    },
  };

  // ── Переспрос и «изменить» ───────────────────────────────────────────────
  async function regenerate(turn, modelId) {
    if (WcThread.isStreaming()) return;
    const requestId = nextRequestId();
    // Пузырь очищается ДО запроса: между нажатием и первым словом проходит
    // секунда-другая, и всё это время старый ответ на экране означал бы, что
    // нажатие не сработало. Не удастся — прежний ответ вернётся (wc-thread.js).
    const target = WcThread.beginRetry(requestId, turn || null);
    if (!target) return;
    state.requestId = requestId;
    WcComposer.setStreaming(true, requestId);
    WcHaptics.tap();
    try {
      await WcBus.call('WC_REGENERATE', {
        requestId,
        modelId: modelId || null,
        // Ответ отдельного разговора заготовки переспрашивается в её беседе.
        threadKey: (target && target.dataset && target.dataset.threadKey) || null,
      });
    } catch (err) {
      WcBus.broadcast({ type: 'STREAM_ERROR', requestId, error: String((err && err.message) || err) });
    }
  }

  // «Изменить» кладёт вопрос обратно в поле. Свой ход при этом НЕ удаляется:
  // человек ещё не решил отправлять, а исчезнувшее сообщение при передумывании
  // не вернуть. Отправка обычная — она добавит новый ход. Вопрос, заданный
  // заготовкой, уходит той же заготовкой: её пилюля подсвечивается, и
  // отправка идёт через неё (решение владельца 2026-09-21).
  function editTurn(text, presetSlot, sourceUid, how) {
    // In place (chat_edit_in_place.sql): the words into the field under the line «Edit message»; the arrow sends a
    // new version of that message, its answer written anew in its place (sendEdit). A question asked by a preset
    // goes by the same preset: the server takes it from the edited message.
    if (how && how.inPlace && how.uid && !WcThread.isStreaming()) {
      startEdit({ uid: how.uid, turn: true, text: text || '' });
      return;
    }
    WcComposer.setText(text || '');
    WcComposer.armPreset(presetSlot || null);
    // С какого вопроса правка: сервер возьмёт из него блок выбранного слова.
    WcComposer.armEditSource(sourceUid || null);
    WcComposer.focus();
  }

  function stopStream() {
    if (!state.requestId) return;
    // Вместе с «стопом» уезжает ЧИСЛО: сколько знаков ответа человек успел
    // увидеть. Считается ДО обрыва — после него лента уже закрыта и спрашивать
    // будет не у чего.
    const seenChars = WcThread.seenChars(state.requestId);
    WcBus.call('WC_STOP', { requestId: state.requestId, seenChars })
      .catch((err) => console.warn('[wc] stop:', err && err.message));
  }

  // The person left the chat mid-answer: another chat, a new one, a section. Leaving is not
  // Stop: no count of seen characters goes to the server, and the request is not cut. Its words
  // stop landing on the screen (WcThread.detach), the server writes the answer to its end
  // (llm-proxy), and the page still hears how it ended: a refusal keeps the message as not sent
  // (onUnsent), an answer done in the chat that is open again repaints it (STREAM_DONE below).
  const leftChats = new Map();   // requestId → the key of the chat it was sent in
  function leaveStream() {
    if (!state.requestId) return;
    if (isFollow(state.requestId)) {
      // An answer followed from the server's read: the page stops following it here (not Stop); the
      // chat open again follows it anew from the server's read.
      WcBus.call('WC_UNFOLLOW', { requestId: state.requestId }).catch(() => {});
      WcThread.detach(state.requestId);
      WcThread.settled(state.requestId);
      turnUids.delete(state.requestId);
      state.requestId = null;
      WcComposer.setStreaming(false);
      return;
    }
    leftChats.set(state.requestId, state.conversationId || null);
    // The database's signals of this answer are no longer this page's own stream: back in its chat,
    // the page reads them as any other answer the server writes (the follower of «chat» below).
    const op = opOfRequest.get(state.requestId);
    if (op) ownOps.delete(op);
    WcThread.detach(state.requestId);
    state.requestId = null;
    WcComposer.setStreaming(false);
  }

  // ── The answer the server writes, after a return to its chat (2026-11-20) ────────────────
  // Gennady sent a message, went to another chat and came back: only his question stood, while
  // Claude Code worked minutes without a word. Now the chat read gives such an answer with its
  // number and the step it is at (chat_turn_live.sql), the thread draws it as the stream
  // (WcThread.renderTurns), and the page follows it here: the composer is in Stop — Stop goes by
  // its number and the characters seen (WC_STOP) — and the answer is followed to its end through
  // the database's signal «chat» of that number and its fate between signals (wc-backend.js
  // WC_FOLLOW). The same after a reload, a restart of the Mac app and on another device.
  const isFollow = (requestId) => typeof requestId === 'string' && requestId.startsWith('follow:');
  // The request of this page whose chat the person left and whose stream still reads, by the number of its message.
  function leftRequestOf(opId) {
    if (!opId) return null;
    for (const [rid, op] of opOfRequest) if (op === String(opId) && leftChats.has(rid)) return rid;
    return null;
  }
  function followRunning() {
    const f = WcThread.followed();
    if (!f) {
      // The answer the page followed is not on the screen any more (the chat read anew shows its end).
      if (isFollow(state.requestId)) {
        WcBus.call('WC_UNFOLLOW', { requestId: state.requestId }).catch(() => {});
        turnUids.delete(state.requestId);
        state.requestId = null;
        WcComposer.setStreaming(false);
      }
      return;
    }
    // The page's own stream stands: its words come by the stream (a render drops streams, so this
    // is a guard, not a case).
    if (state.requestId && state.requestId !== f.requestId && !isFollow(state.requestId)) return;
    // One answer, one painter (22.11.2026, «ушёл из чата, вернулся — потерялось»): sent here, left,
    // came back while this page's own stream of it still reads (leaving never closes it) — that stream
    // is put back on its bubble, and nothing follows the answer in this page. A follow beside it left
    // the bubble to two sources, and the screen stood cut. A follow is for an answer this page does
    // not read: another tab or device, a reload.
    const own = leftRequestOf(f.opId);
    if (own && WcThread.reattach(own)) {
      if (isFollow(state.requestId)) {
        WcBus.call('WC_UNFOLLOW', { requestId: state.requestId }).catch(() => {});
        turnUids.delete(state.requestId);
      }
      leftChats.delete(own);
      // Its signals are this page's own stream again (the follower of «chat» below).
      ownOps.add(f.opId);
      state.requestId = own;
      WcComposer.setStreaming(true, own);
      return;
    }
    state.requestId = f.requestId;
    WcComposer.setStreaming(true, f.requestId);
    // The price under it when it ends (requestMoney by its uids, STREAM_DONE below).
    turnUids.set(f.requestId, {
      assistantUid: f.uid,
      userUid: global.LexTurnId ? global.LexTurnId.userTurnUid(f.opId) : null,
    });
    WcBus.call('WC_FOLLOW', { requestId: f.requestId, opId: f.opId, chatKey: state.conversationId, text: f.text, stepSeq: f.stepSeq })
      .catch((err) => console.warn('[wc] follow:', err && err.message));
  }

  // ── Messages Lex did not take (Gennady, 2026-11-16) ─────────────────────────────────────
  // As in other chats: a message that did not go stays in the chat, the person's own bubble with
  // why it did not go and Retry, Top up, Edit, Delete (the part LexMessage.unsent). The page
  // keeps such messages on this device, in its store (WcStore, wiped with the account), by the
  // key of the chat, and puts them back at the end of the chat when it opens. A message is kept
  // from the moment it goes («sending»): the app closed or the network gone before an answer, it
  // is still there. It leaves the store when the server has it (its question is in the chat) or
  // when the person retries, edits or deletes it. A message whose fate was never heard is shown as
  // not sent after UNSENT_LOST_MS without its question on the server.
  const UNSENT_KEY = 'lexUnsent';
  const UNSENT_LOST_MS = 120000;
  const UNSENT_LOST_NOTE = 'Lex did not get this message.';
  const outbox = new Map();      // requestId → the kept message of a request on its way
  // The numbers of messages sent from this page: the database's signal of their answers is this
  // page's own stream, not a change to read (the follower of «chat» below).
  const ownOps = new Set();
  // The number of every message this page sent, by its request: leaving its chat gives its signals back.
  const opOfRequest = new Map();
  let unsentChain = Promise.resolve();
  async function unsentAll() {
    try { const v = await WcStore.one(UNSENT_KEY, null); return Array.isArray(v) ? v : []; } catch (_) { return []; }
  }
  function unsentEdit(fn) {
    unsentChain = unsentChain
      .then(async () => { const next = fn(await unsentAll()); await WcStore.putQuiet({ [UNSENT_KEY]: next.slice(-50) }); })
      .catch((err) => console.warn('[wc] unsent not kept:', err && err.message));
    return unsentChain;
  }
  const unsentPut = (item) => unsentEdit((l) => l.filter((i) => i.id !== item.id).concat([item]));
  const unsentDrop = (id) => unsentEdit((l) => l.filter((i) => i.id !== id));

  // The options of the part for one kept message, with what its buttons do.
  function unsentPart(item, turn) {
    const forget = () => { if (item.id) unsentDrop(item.id); WcThread.removeTurn(turn); };
    return {
      note: item.note || UNSENT_LOST_NOTE,
      money: !!item.money,
      gateRaw: item.gateRaw || null,
      sending: false,
      onRetry: () => {
        if (state.requestId) { toast('Wait until the answer is written.'); return; }
        forget();
        send(item.text, Object.assign({}, item.opts || {}, item.id ? { opId: item.id } : {}));
      },
      onTopUp: item.money ? () => WcTopup.open({ onPaid: refreshAccount }) : null,
      onEdit: () => { forget(); WcComposer.setText(item.text || ''); WcComposer.focus(); },
      onDelete: forget,
    };
  }

  // The words under a message that did not go: what the browser says of a lost network is no
  // sentence for a person.
  const UNSENT_NO_NETWORK = 'No connection to Lex. Check the internet and try again.';
  function unsentNote(note) {
    const t = String(note || '').trim();
    if (!t) return null;
    if (/failed to fetch|networkerror|load failed|network connection was lost|internet connection appears to be offline/i.test(t)) return UNSENT_NO_NETWORK;
    return t;
  }

  // Lex refused a message (WcThread.error): kept as not sent, and marked if it is on the screen.
  function onUnsent(u) {
    const kept = outbox.get(u.requestId);
    outbox.delete(u.requestId);
    leftChats.delete(u.requestId);
    const bubble = u.turn && u.turn.querySelector('.wc-bubble');
    const item = Object.assign({}, kept || {
      id: null,
      text: bubble ? (bubble.dataset.editText || bubble.textContent || '') : '',
      at: new Date().toISOString(),
    }, { state: 'failed', note: unsentNote(u.note), money: !!u.money, gateRaw: u.gateRaw || null });
    if (item.id && item.chatKey) unsentPut(item);
    if (u.turn) WcThread.paintUnsent(u.turn, unsentPart(item, u.turn));
  }

  // The chat painted from the server: its kept messages go back at its end. One the server has
  // leaves the store; one still on its way in this page waits for its own end.
  async function restoreUnsent(r) {
    const key = state.conversationId;
    if (!key || !r || !Array.isArray(r.turns)) return;
    const have = new Set(r.turns.map((t) => t && t.uid).filter(Boolean));
    const going = new Set([...outbox.values()].map((i) => i.id));
    const now = Date.now();
    const show = [];
    // What this page has just written is read back, not an older state.
    await unsentChain;
    for (const item of (await unsentAll()).filter((i) => i.chatKey === key)) {
      if (have.has(global.LexTurnId.userTurnUid(item.id))) { unsentDrop(item.id); continue; }
      if (going.has(item.id)) continue;
      // The server's word on a message whose end this page did not hear (chat_turn_fate.sql):
      // written — it is in the chat, beyond the page read or in a conversation apart; still being
      // taken — it waits.
      const fate = await WcHistory.opState(item.id).catch(() => null);
      if (fate && fate.status === 'begun') { unsentDrop(item.id); continue; }
      if (fate && fate.status === 'pending') continue;
      if (item.state !== 'failed') {
        if (now - Date.parse(item.at) < UNSENT_LOST_MS) continue;
        item.state = 'failed';
        item.note = UNSENT_LOST_NOTE;
        unsentPut(item);
      }
      show.push(item);
    }
    if (state.conversationId !== key || !show.length) return;
    // A word Lex did not take stays on the screen in the clean view too, with why (lex-unsent, lex-profi.css): the view of
    // the chat is not changed for it.
    for (const item of show) {
      const turn = WcThread.appendUnsent(item.text, { at: item.at, presetSlot: (item.opts && item.opts.mode) ? item.opts.slotId : null }, null);
      WcThread.paintUnsent(turn, unsentPart(item, turn));
    }
  }

  async function renameConversation(id, title) {
    try {
      const r = await WcBus.call('WC_RENAME_CONVERSATION', { id, title });
      if (!r || !r.ok) throw new Error((r && r.error) || 'refused');
    } catch (err) {
      toast('Could not rename: ' + (err && err.message), { error: true });
    }
    await refreshConversations();
  }

  // The menu of a chat (lex-chat-menu.js): Pin, Unpin, Mark as read, Mark as unread. The list is read
  // anew: what the press means for it is the server's. A read on opening says nothing when it fails.
  async function actConversation(id, act) {
    // Mute shows in the menu at once; the numbers' next answer (the signal «unread») confirms it or puts it back.
    const mute = act === 'mute' || act === 'unmute';
    if (mute && global.LexSection) global.LexSection.markMuted(id, act === 'mute');
    try {
      const r = await WcBus.call('WC_CHAT_ACT', { id, act });
      if (!r || !r.ok) throw new Error((r && r.error) || 'refused');
    } catch (err) {
      if (mute && global.LexSection) global.LexSection.markMuted(id, act !== 'mute');
      if (act === 'read') console.warn('[wc] read:', err && err.message);
      else toast('Could not change the chat: ' + (err && err.message), { error: true });
      return;
    }
    await refreshConversations();
  }

  async function deleteConversation(id) {
    try {
      const r = await WcBus.call('WC_DELETE_CONVERSATION', { id });
      if (!r || !r.ok) throw new Error((r && r.error) || 'refused');
    } catch (err) {
      toast('Could not delete: ' + (err && err.message), { error: true });
      return;
    }
    if (state.conversationId === id) await newConversation();
    await refreshConversations();
  }

  // ── Voice ─────────────────────────────────────────────────────────────────
  // Уход из БЕСЕДЫ заканчивает живой разговор (решение владельца 2026-09-09,
  // docs/spec/30-voice.md): открыли другую беседу, завели новую — микрофон
  // закрыт, учитель замолчал. Одна точка на оба случая; делает ровно то, что
  // крестик экрана звонка (hooks.onEnd ниже): вид уходит по нажатию, а не по
  // ответу сервера, потом дожидаемся stop() — «вернулся» значит «шлюз свободен
  // и последний обмен лёг в память беседы». Единственный законный способ
  // погасить голос — WcVoice.stop(); teardown напрямую не зовём. Без живого
  // разговора — холостой ход; повторный stop() внутри WcVoice тоже холостой.
  // Уход из ПРИЛОЖЕНИЯ (вкладка, выход из аккаунта) — не отсюда, см. signOut.
  async function endVoiceOnLeave(reason) {
    if (!(WcVoice.active || WcVoice.connecting)) return;
    WcVoiceScreen.close();
    WcComposer.setVoiceActive(false);
    WcHeader.setVoiceActive(false);
    await WcVoice.stop({ reason });
  }
  // Концы разговора, которые выбрал сам человек: крестик и уход из беседы.
  // О них onDisconnected не сообщает — плашка нужна концам, которых человек
  // не нажимал (сервер, сеть, деньги).
  // 'window-closed' — программа для Мака закрыла или спрятала окно, а
  // крестика разговора на странице не нашла (WebHost.stopVoice): это уход из
  // приложения, надпись в спрятанное окно ни к чему.
  const VOICE_END_BY_READER = new Set(['manual', 'open-chat', 'new-chat', 'window-closed', 'news']);

  // The mic button is a toggle over one live session. Everything the reader
  // hears and says lands in the same thread as typing, through the same
  // bubbles — a spoken conversation is a conversation, not a separate mode
  // with its own transcript window.
  function openVoiceScreen() {
    WcVoiceScreen.open({
      onToggleMute: () => { WcVoice.mute(!WcVoice.muted()); WcVoiceScreen.muted(WcVoice.muted()); },
      // «Держи и говори»: палец на кнопке — реплика идёт, отпустил — реплика
      // закончена (у голоса Google — сразу ответ, WcVoice.holdEnd).
      onHoldStart: () => { WcVoice.holdStart(); WcVoiceScreen.muted(false); WcHaptics.tap(); },
      onHoldEnd: () => { WcVoice.holdEnd(); WcVoiceScreen.muted(true); },
      // Разговорный вид уходит ПО НАЖАТИЮ, а не по ответу сервера. Иначе
      // между нажатием и закрытием проходило больше полусекунды: WcVoice.stop()
      // сначала гасит сессию и отправляет её конец, и только потом зовёт
      // onDisconnected, где вид и убирался. Полсекунды «ничего не произошло» —
      // это когда человек жмёт второй раз. Уборка в onDisconnected остаётся:
      // она нужна тем случаям, где разговор кончился не крестиком, и повторный
      // вызов ничего не портит.
      onEnd: () => {
        WcVoiceScreen.close();
        WcComposer.setVoiceActive(false);
        WcHeader.setVoiceActive(false);
        WcVoice.stop({ reason: 'manual' });
      },
    });
    WcVoiceScreen.muted(WcVoice.muted());
    WcVoiceScreen.micHeld(WcVoice.micHeld());
  }

  // Номер нажатия голоса. Растёт синхронно в toggleVoice — раньше любого
  // ожидания (беседа, микрофон, сервер), — и конец разговора (onDisconnected)
  // по нему узнаёт, что экран и кнопки уже принадлежат следующему нажатию,
  // даже если то ещё заводит беседу и до WcVoice.start не дошло.
  let voiceSeq = 0;

  async function toggleVoice(opts) {
    await settingsReady;
    // A chat whose profile has no talk by voice (a person, a group, an agent) has no voice button (LexComposer.paint); a
    // way in from elsewhere is refused with the same words: an agent takes only words, a chat of a folder is the
    // conversation with a person. A talk going on is let end.
    const prof = openProfile();
    if (prof && !global.LexChatProfile.fieldHas(prof, 'voice') && !(global.WcVoice && (WcVoice.active || WcVoice.connecting))) {
      toast(prof.kind === 'agent' ? ONLY_WORDS : 'Voice talk with Lex is not in the chats of folders.');
      return;
    }
    // Push-to-talk is not a different transport — it is the same live session
    // started with the microphone closed, opened only while the reader holds
    // the button on the voice screen. Doing it any other way would mean a
    // second path to the same server for no gain.
    const ptt = !!(opts && opts.mode === 'ptt');
    // ⚠️ ПОВТОРНОЕ НАЖАТИЕ НЕ КЛАДЁТ ТРУБКУ И НЕ НАЧИНАЕТ ВТОРОЙ РАЗГОВОР.
    //
    // Раньше здесь был stop(), и это давало ровно ту жалобу, что записана в
    // задании: человек жмёт микрофон, подключение идёт долго и молча, он жмёт
    // ещё раз — сессия рвётся; жмёт третий — и получает «голосовой разговор
    // уже идёт в другом окне», потому что на сервере предыдущий вызов ещё не
    // закрылся. Внутренняя защита от двух сессий вылезала человеку как ошибка,
    // хотя он всего лишь нажал кнопку дважды.
    //
    // Теперь повторное нажатие просто возвращает на экран разговора — молча.
    if (WcVoice.active || WcVoice.connecting) {
      if (!WcVoiceScreen.isOpen()) openVoiceScreen();
      return;
    }
    const mySeq = ++voiceSeq;
    // Пузыри прошлого разговора дописываются здесь, если его конец этого не
    // сделал (человек нажал голос снова, пока уходил отчёт об отбое, — тот
    // конец экран не трогает). Прошлый разговор к этому мигу уже снесён, и
    // поздних расшифровок для его пузырей не будет: канал событий закрыт.
    WcThread.endVoice();

    openVoiceScreen();
    WcVoiceScreen.stage('mic');
    WcVoiceScreen.pushToTalk(ptt);
    WcComposer.setVoiceActive(true);
    WcHeader.setVoiceActive(true);
    WcHaptics.tap();

    // A spoken turn needs a conversation to belong to, exactly as a typed one
    // does — and it must be the SAME one, or the reader ends up with two.
    let convId = state.conversationId;
    if (!convId) {
      try {
        const r = await WcBus.call('WC_ENSURE_SESSION');
        convId = r && r.conversationId;
        if (convId) {
          state.conversationId = convId;
          WcSidebar.setActive(convId);
          adoptFieldKey(convId);
        }
      } catch (err) {
        // Экран уже принадлежит следующему нажатию — его не трогаем.
        if (mySeq !== voiceSeq) return;
        WcVoiceScreen.close();
        WcComposer.setVoiceActive(false);
        WcHeader.setVoiceActive(false);
        toast('Could not start the conversation: ' + (err && err.message), { error: true });
        return;
      }
      // Пока заводилась беседа, человек успел положить трубку и нажать голос
      // снова: разговор начинает последнее нажатие, со своим экраном. Это
      // выходит, ничего не начав, — иначе разговор пошёл бы под чужим экраном,
      // и его конец этот экран бы не убрал (mySeq !== voiceSeq ниже).
      if (mySeq !== voiceSeq) return;
    }

    // What has been said so far, KEYED BY item_id and in the order the server
    // opened the items — a Map keeps insertion order, which is what makes the
    // remembered transcript match what was on screen.
    //
    // КТО ЧТО ПИШЕТ (с 2026-09-09, docs/PLAN-SERVER-HISTORY.md шаг 8). Реплики
    // разговора в таблицу кладёт СЕРВЕРНЫЙ СЛУШАТЕЛЬ — он видит те же события
    // и живёт дольше вкладки. flushExchange ниже таблицу не трогает:
    // WC_APPEND_TURNS кормит только память открытой беседы (openTurns в
    // wc-backend.js), из которой собирается контекст СЛЕДУЮЩЕГО текстового
    // вопроса, — иначе после звонка учитель отвечал бы, не помня, о чём только
    // что говорили вслух, пока беседу не перезагрузят с сервера.
    //
    // WHY A FLUSH AND NOT JUST "REMEMBER ON response.done". Hanging up right
    // after the teacher finishes speaking is the NORMAL way to end a voice
    // conversation, and response.done arrives after the last audio — so
    // remembering only there loses the final exchange from the context every
    // time somebody stops when they are done. The same gap once lost the turns
    // from the table itself, back when this function wrote it (measured:
    // $0.0176 billed in balance_ledger, zero turns saved). The extension has a
    // settle window for the same reason.
    const said = new Map();   // itemId → { role, text, saved }
    // Прямой разговор OpenAI (docs/spec/30-voice.md, «Прямой режим на
    // устройстве»): реплики в таблицу пишет сервер по паре от страницы, под
    // уидами из номера пары, — память беседы берёт те же (onVoiceUid).
    const uidOf = new Map();  // itemId → 'voice:<pairId>-u|-a'

    function note(itemId, role, text) {
      const prev = said.get(itemId);
      said.set(itemId, { role, text, saved: prev ? prev.saved : false });
    }

    async function flushExchange() {
      const turns = [];
      const flushed = [];
      said.forEach((v, k) => {
        if (v.saved || !v.text) return;
        // Уид реплики — из идентификатора поставщика, а не случайный. То же
        // правило применяет серверный слушатель (он видит ровно эти события),
        // поэтому реплика в памяти беседы и строка, которую записал сервер, —
        // одна и та же, а не две при следующей загрузке беседы.
        turns.push({ role: v.role, text: v.text, uid: uidOf.get(k) || ('voice:' + k) });
        flushed.push(k);
      });
      if (!turns.length) return;
      // Marked BEFORE the await: a second flush racing this one (response.done
      // and hang-up land within milliseconds of each other) would otherwise
      // write the same turns twice.
      flushed.forEach((k) => { said.get(k).saved = true; });
      try {
        await WcBus.call('WC_APPEND_TURNS', { conversationId: convId, turns });
      } catch (err) {
        console.warn('[wc] voice turn not kept in memory:', err && err.message);
        flushed.forEach((k) => { const v = said.get(k); if (v) v.saved = false; });
      }
    }

    try {
      await WcVoice.start({
        conversationId: convId,
        newsChat: WcThread.hasNewsTurn(),
        // «Держи и говори» у голоса Google — свой режим разговора (слух Google
        // выключен, конец реплики отмечает кнопка); у OpenAI — та же живая
        // сессия с закрытым микрофоном.
        mode: ptt ? 'ptt' : 'live',
        hooks: {
          // 'ready' приходит СЮДА ЖЕ, вместе с остальными ступенями. Здесь
          // стоял отдельный onConnected со stage('ready') — и надпись
          // «Listening» опережала слышимость на ~790 мс: onConnected значит
          // «брокер ответил», а не «связь поднята». Теперь ступень чеканит
          // announceReady() в wc-voice.js, по второму из двух настоящих
          // событий. Обратно сюда её не возвращать.
          onStage: (s) => WcVoiceScreen.stage(s),
          onRemoteStream: (s) => WcVoiceScreen.meterRemote(s),
          onLocalStream: (s) => {
            WcVoiceScreen.meterLocal(s);
            // «Держи и говори» — дорожка закрыта С МОМЕНТА ЗАХВАТА, а не с
            // момента соединения. Раньше эти две строки стояли в onConnected и
            // работали правильно только по случайности: до соединения дорожку
            // держала закрытой защита первой реплики. Защиту сняли
            // (FIRST_TURN_GUARD в wc-voice.js) — и окно «связь уже поднялась,
            // а mute(true) ещё не позвали» стало открытым микрофоном на весь
            // обмен SDP. onLocalStream приходит ровно в тот кадр, в котором
            // раньше срабатывала защита: micTrack уже назначен, mute() его
            // видит.
            if (ptt) { WcVoice.mute(true); WcVoiceScreen.muted(true); }
          },
          onMicHeld: (held) => WcVoiceScreen.micHeld(held),
          onTeacherSpeaking: (on) => WcVoiceScreen.speaking(on),

          onUserStart: (id) => { quickLanded(); WcThread.beginVoiceUser(id); },
          onUserDelta: (id, t) => { note(id, 'user', t); WcThread.voiceUserText(id, t); WcVoiceScreen.line('user', t); },
          onUserDone: (id, t) => { note(id, 'user', t); WcThread.voiceUserText(id, t); WcVoiceScreen.line('user', t); },
          onUserFailed: (id) => { said.delete(id); WcThread.dropVoiceUser(id); },

          onAssistantDelta: (id, t) => { quickLanded(); note(id, 'assistant', t); WcThread.voiceAssistantText(id, t); WcVoiceScreen.line('assistant', t); },
          onAssistantDone: (id, t) => { note(id, 'assistant', t); WcThread.voiceAssistantText(id, t); WcVoiceScreen.line('assistant', t); },
          // Голос Google: из ответа не прозвучало ничего — ни пузыря, ни
          // строки в памяти беседы (сервер её тоже не записал).
          onAssistantDrop: (id) => { said.delete(id); WcThread.dropVoiceAssistant(id); },

          // response.done — весь ход завершён, можно записывать. Строку хода
          // слушатель сервера пишет вслед за ответом — деньги перечитываются.
          onVoiceUid: (id, uid) => { uidOf.set(id, uid); },
          onTurnDone: () => { flushExchange(); requestMoney({ settleMs: 10000 }); },

          // Toasted directly — same path as every other voice-start failure
          // in this function — rather than through WcVoiceScreen.status(),
          // which is now a no-op: the call screen no longer has a status
          // line to write an error into (2026-08-19, the call screen looks
          // like the ordinary chat now).
          onError: (msg) => toast('Error: ' + msg, { error: true }),
          // Спокойная надпись без ошибки: например, «реплика не записалась в
          // переписку» (голос Google, voice/call-server.js).
          onNotice: (msg) => toast(msg),
          onDisconnected: async ({ reason, turns, superseded }) => {
            // ЭКРАН УХОДИТ ПЕРВЫМ, до записи в историю. Раньше здесь сначала
            // ждали flushExchange() — сетевой заход, — и всё это время крестик
            // выглядел ненажатым: человек жал, ничего не происходило, он жал
            // ещё раз. Порядок обратный: сначала снимается разговорный вид,
            // потом дописывается то, что не успело записаться. На бухгалтерию
            // это не влияет — деньги считает серверный слушатель, а не эта
            // функция, и await ниже по-прежнему держит вызывающего.
            //
            // superseded — человек уже нажал голос снова, пока уходил отчёт
            // об отбое этого разговора (WcVoice.stop): экран, кнопки и пузыри
            // принадлежат новому разговору, и снимать их здесь нельзя —
            // крестик нажатия (onEnd) свой вид уже убрал.
            if (!superseded && mySeq === voiceSeq) {
              WcVoiceScreen.close();
              WcComposer.setVoiceActive(false);
              WcHeader.setVoiceActive(false);
              WcThread.endVoice();
            }
            await flushExchange();
            if (reason && !VOICE_END_BY_READER.has(reason)) toast(WcVoice.endedText(reason));
            // The debit is made by the server-side listener after the call
            // closes, so ask for the balance twice, like a text turn does.
            refreshAccount();
            setTimeout(refreshAccount, 3000);
            // Деньги разговора (последний ход, секунды Live 1, расшифровка
            // речи) слушатель дописывает после отбоя — перечитываем, пока
            // доезжают.
            requestMoney({ settleMs: 30000 });
            if (turns) refreshConversations();
            if (!superseded && !/^gate-/.test(String(reason || ''))) reconcileAfterVoice(convId);
            // An order chat drew nothing of the server while the conversation went on: now it
            // reads the chat — what the client wrote meanwhile, the spoken turns in its look.
            if (!superseded && profiChat && state.conversationId === convId) refreshProfiChat().catch(() => {});
            // The page that came out during the call is taken now (signal «page»).
            applyNewPage();
          },
        },
      });
    } catch (err) {
      WcVoiceScreen.close();
      WcComposer.setVoiceActive(false);
      WcHeader.setVoiceActive(false);
      toast(String((err && err.message) || err), { error: true });
    }
  }

  function openSettings() {
    return WcSettings.open({
      account: state.account,
      onSignOut: signOut,
      rpc: newsRpc,
      // The row «Profi.ru» of Settings → Notifications: the settings of the section, at the block «Notifications».
      openProfiSettings: () => showProfi('settings', 'notifications'),
    });
  }

  // ── Narrow-screen bookkeeping ─────────────────────────────────────────────
  // One class on the root, set from one media query, so every rule that needs
  // to know "are we on a phone?" reads the same answer. The real phone layout
  // is step 5; this is the switch it will hang off.
  // ── The keyboard ──────────────────────────────────────────────────────────
  // On iOS the on-screen keyboard does NOT shrink the layout viewport: the page
  // stays its full height and the keyboard is drawn over the bottom of it. So a
  // composer pinned to the bottom ends up underneath it, and the reader types
  // into something they cannot see. visualViewport is the only API that reports
  // what is actually visible, and its height is what the shell is sized to.
  //
  // The offsetTop term matters as much as the height: when iOS scrolls the page
  // itself to reveal a focused field, the visual viewport moves down the layout
  // viewport, and without accounting for that the top bar slides off.
  function watchKeyboard() {
    const vv = global.visualViewport;
    const root = document.getElementById('wc-root');
    if (!vv) {
      // No visualViewport (an old browser, or a shell that resizes properly on
      // its own): the dvh fallback in the stylesheet already handles it.
      return;
    }
    let raf = 0;
    // Последние применённые значения. Писать в стиль одно и то же — не
    // «безобидно»: каждая запись в `transform` на <body> заставляет заново
    // складывать всю страницу, а `visualViewport` во время инерционной
    // прокрутки на iOS шлёт события пачками. Это и было главным источником
    // дёрганья: не сама прокрутка, а перекладка страницы под ней.
    let lastH = -1;
    let lastOffset = -1;
    // Самое высокое, каким это окно бывало. Признак «клавиатура поднята»
    // считается ОТ НЕГО, а не от текущего `innerHeight`.
    //
    // Почему не от текущего: в приложении на iPhone экранная клавиатура
    // укорачивает и layout-окно тоже, и `innerHeight - vv.height` выходит
    // нулём при поднятой клавиатуре (замерено 2026-08-21: 539 и 539 при
    // клавиатуре во весь низ экрана). Признак не включался вовсе, и правила,
    // которые на него опираются, молчали. В браузере на столе разницы нет:
    // там окно не укорачивается, и оба способа дают одно и то же.
    let maxH = 0;
    // Печатает ли человек прямо сейчас. Без этой проверки признак включался бы
    // на обычном изменении размера окна на столе: сузили окно вдвое — «высота
    // упала», значит клавиатура. Клавиатура не появляется сама по себе: она
    // приходит только к полю в фокусе.
    const typing = () => {
      const el = document.activeElement;
      return !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT');
    };
    const apply = () => {
      raf = 0;
      const h = Math.round(vv.height);
      // Пока в поле не пишут, высота окна и есть «полная» — запоминаем её как
      // есть, в том числе когда окно уменьшили. Пока пишут — не трогаем:
      // именно от запомненной высоты и считается, поднялась ли клавиатура.
      if (!typing()) maxH = global.innerHeight;
      if (h !== lastH) {
        lastH = h;
        document.documentElement.style.setProperty('--wc-vh', h + 'px');
        // A keyboard is "open" when the visual viewport is meaningfully shorter
        // than the tallest this window has been. 120px of slack keeps the
        // browser's own collapsing toolbars from counting as one.
        root.classList.toggle('is-keyboard', typing() && (maxH - h) > 120);
      }
      // Смещение здесь больше не пишется: у него свой, синхронный путь
      // (`applyOffset` ниже). Две точки записи одного свойства — это два
      // разных срока для одного и того же, то есть ровно та рассинхронизация,
      // из-за которой кадр и уезжал.
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(apply); };

    // ⚠️ ДВЕ ЗАПИСИ — ДВА РАЗНЫХ СРОКА, И ПУТАТЬ ИХ НЕЛЬЗЯ.
    //
    // Когда каретка встаёт в поле, WebKit САМ прокручивает страницу, чтобы
    // показать поле над клавиатурой: `window.scrollY` становится равным
    // `vv.offsetTop`. Наша `translateY` — это ОТВЕТ на уже случившийся сдвиг,
    // и отложить его на кадр значит нарисовать кадр со сдвинутой страницей.
    // Ровно это и был рывок: «поставил курсор — переписка дёрнулась вверх,
    // убрал — дёрнулась обратно».
    //
    // Замерено покадрово на приложении (iPhone 17 Pro). Порядок не тот, каким
    // он кажется: `resize` приходит первым (61 мс после нажатия) и приносит
    // ТОЛЬКО высоту — `offsetTop` в этот момент ещё ноль, страница на месте.
    // Сдвиг приезжает ОТДЕЛЬНЫМ событием прокрутки ещё через 33 мс (94 мс):
    // `scrollY` 335, шапка на -335, первый ход на -195. Пока обе записи шли
    // через кадр, ответ появлялся на 110 мс — то есть один кадр страницы,
    // уехавшей на 335 px, человек видел. Чинить это по `resize` бесполезно:
    // на `resize` двигать ещё нечего.
    //
    // Поэтому делим не по событию, а по тому, ЧТО пишется:
    //
    //  · СМЕЩЕНИЕ (`transform` на <body>) — синхронно, в том же кадре, где
    //    сдвиг случился. Иначе оно не компенсация, а вторая анимация.
    //  · ВЫСОТА (`--wc-vh`, класс `is-keyboard`) — по-прежнему через кадр. Это
    //    она перекладывает всю страницу, и это её `visualViewport` шлёт
    //    пачками; ради неё кадр здесь и появился.
    //
    // Сама по себе синхронная запись смещения пачек не боится, и это тоже
    // замерено, а не предположено: `lastOffset` отсекает повтор того же
    // значения, а `offsetTop` меняется только когда страницу двигает
    // клавиатура. Своя прокрутка ленты идёт внутри `div`, и видимое окно от
    // неё не съезжает вовсе — на ленте из 80 ходов (7150 px при окне 539) с
    // поднятой клавиатурой три броска пальцем дали РОВНО НОЛЬ событий
    // прокрутки видимого окна.
    const applyOffset = () => {
      const offset = Math.round(vv.offsetTop);
      if (offset === lastOffset) return;
      lastOffset = offset;
      document.body.style.transform = offset ? `translateY(${offset}px)` : '';
    };
    vv.addEventListener('resize', () => { applyOffset(); schedule(); });
    vv.addEventListener('scroll', () => { applyOffset(); schedule(); });
    apply();

    // A field that gets focus while the keyboard is coming up must end up above
    // it. The delay is the animation; without it the scroll happens against the
    // pre-keyboard geometry and lands in the wrong place.
    document.getElementById('wc-input').addEventListener('focus', () => {
      setTimeout(() => { try { WcThread.scrollToEnd(); } catch (_) {} }, 300);
    });
  }

  function watchWidth() {
    const root = document.getElementById('wc-root');
    const mq = global.matchMedia('(max-width: 720px)');
    // The history is a drawer at every width now, so width no longer decides
    // whether it is open — it starts closed everywhere and only the hamburger
    // opens it. .is-narrow survives because other rules (gutters, sheet shape)
    // genuinely are width questions.
    root.classList.add('is-sidebar-collapsed');
    const apply = () => root.classList.toggle('is-narrow', mq.matches);
    apply();
    mq.addEventListener('change', apply);
  }

  // ── The two glass bars ────────────────────────────────────────────────────
  // The bar and the composer are laid OVER the thread so the conversation can
  // be seen through them (wc-app.css, "Glass"). That only works if the thread
  // reserves their heights as padding — otherwise the newest message is born
  // underneath the composer and the oldest under the bar.
  //
  // Measured rather than assumed: the composer grows with the typed text and
  // with attachment thumbnails, and a hardcoded number would be wrong the
  // moment somebody types a second line.
  function watchBarHeights() {
    const topbar = document.querySelector('.wc-topbar');
    const composer = document.querySelector('.wc-composer-wrap');
    if (!topbar || !composer) return;
    const root = document.documentElement;
    let raf = 0;
    // Same guard as the keyboard watcher: writing an unchanged value still
    // makes the browser lay the page out again, and ResizeObserver fires in
    // bursts while the textarea grows.
    let lastTop = -1;
    let lastBottom = -1;
    const apply = () => {
      raf = 0;
      const t = Math.round(topbar.getBoundingClientRect().height);
      const c = Math.round(composer.getBoundingClientRect().height);
      if (t !== lastTop) { lastTop = t; root.style.setProperty('--wc-topbar-h', t + 'px'); }
      // The box grew or shrank (lines of text, the line of a reply): a reader at the end stays at the end.
      if (c !== lastBottom) { lastBottom = c; root.style.setProperty('--wc-composer-h', c + 'px'); WcThread.keepAtBottom(); }
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(apply); };
    if (global.ResizeObserver) {
      const ro = new ResizeObserver(schedule);
      ro.observe(topbar);
      ro.observe(composer);
    }
    global.addEventListener('resize', schedule);
    apply();
  }

  // ── The gate ──────────────────────────────────────────────────────────────
  // A plain form on our own page. The extension wraps the same form in a nested
  // chrome-extension:// iframe purely because it renders over an arbitrary
  // site; here the page is ours and there is nobody to isolate the password
  // from.
  // Карта кодов отказа переехала в общий lex-error-text.js — тот же список
  // читает расширение (popup.js / login-frame.js), где до этого на экран
  // уходили EMAIL_TAKEN и «signup failed: 500». Служебный код остаётся в
  // журнале: по нему потом и разбирают, почему не пустило.
  function gateErrorText(err) {
    const raw = String((err && err.message) || err || '');
    if (raw) { try { if (typeof lexLog === 'function') lexLog('[wc-app] auth failed:', raw); } catch (_) {} }
    if (global.LexErrorText) return global.LexErrorText.auth(raw);
    return 'Did not work: ' + raw;
  }

  function gateStatus(text, isError) {
    const el = document.getElementById('wc-gate-status');
    el.textContent = text || '';
    el.classList.toggle('is-error', !!isError);
  }

  // ── Gate views: sign-in / email confirmation / password recovery ────────────
  // Three views share the one card; only one shows at a time.
  const CODE_TTL_MS = 60 * 60 * 1000;   // mailer_otp_exp = 1 hour
  const PENDING_EMAIL_KEY = 'lexPendingConfirmEmail';
  const PENDING_SENT_KEY = 'lexPendingConfirmSentAt';
  let confirmEmail = '';
  let codeSentAt = 0;
  let resendTimer = null;

  function gateShowView(which) {
    const map = { auth: 'wc-view-auth', confirm: 'wc-view-confirm', recover: 'wc-view-recover' };
    Object.keys(map).forEach((k) => {
      const el = document.getElementById(map[k]);
      if (el) el.hidden = (k !== which);
    });
    gateStatus('');
  }

  function rememberPending(email) {
    confirmEmail = email;
    codeSentAt = Date.now();
    try {
      localStorage.setItem(PENDING_EMAIL_KEY, email);
      localStorage.setItem(PENDING_SENT_KEY, String(codeSentAt));
    } catch (_) { /* private mode */ }
  }
  function clearPending() {
    confirmEmail = '';
    codeSentAt = 0;
    try { localStorage.removeItem(PENDING_EMAIL_KEY); localStorage.removeItem(PENDING_SENT_KEY); } catch (_) {}
  }
  // The server answers "wrong code" and "expired code" the same way, so which
  // message to show is decided here, by how old the code is.
  function codeErrorText() {
    const age = codeSentAt ? (Date.now() - codeSentAt) : 0;
    return age >= CODE_TTL_MS ? 'That code has expired. Request a new one.' : 'That code is wrong. Check it and try again.';
  }
  function isUnconfirmedError(err) {
    return /email.?not.?confirmed|email_not_confirmed/i.test(String((err && err.message) || err || ''));
  }
  function showConfirmView(email) {
    confirmEmail = email;
    gateShowView('confirm');
    const codeEl = document.getElementById('wc-confirm-code');
    if (codeEl) codeEl.value = '';
    const hint = document.getElementById('wc-confirm-hint');
    if (hint) hint.textContent = 'We sent a code to ' + email + '. Enter it to finish creating your account.';
    try { codeEl.focus(); } catch (_) {}
  }

  // Скелет первой загрузки снимается ровно тогда, когда решено, ЧТО показать —
  // форму входа или приложение. Раньше в этот промежуток был белый экран.
  //
  // Сигнал оболочке отсюда УБРАН и подаётся отдельно (`shellPageReady`): скелет
  // и заставка снимаются в разные моменты. Скелет — как только решено, что
  // показывать; заставка — когда каретка встала в поле, чтобы человек увидел
  // сразу конечный вид, а не подпрыгивающий от клавиатуры экран.
  function hideBoot() {
    const b = document.getElementById('wc-boot');
    if (b) b.hidden = true;
  }

  // ── Разговор с родной оболочкой ────────────────────────────────────────────
  //
  // Приложение на iPhone и программа для Мака держат поверх окна свою заставку
  // — чёрный экран с логотипом, — и снимают её ПО ЭТОМУ сигналу, а не по
  // «страница загрузилась». Разница видна глазом: `didFinish` приходит, когда
  // приехал документ, а вход, список бесед и первая беседа грузятся запросами
  // ПОСЛЕ него — то есть по нему заставка снялась бы над полупустым экраном,
  // ровно тем «подгружается по частям», от которого уходим.
  //
  // У оболочки есть и свой предохранитель по времени, так что старая страница
  // (или сеть, которая не доехала) её не запирает.
  //
  // Подаётся ОДИН раз: заставка снимается один раз, а поводов позвать несколько
  // (каретка встала, каретка не встала за срок, показана форма входа).
  let shellReadySent = false;
  function shellPageReady() {
    if (shellReadySent) return;
    shellReadySent = true;
    try {
      const h = global.webkit && global.webkit.messageHandlers && global.webkit.messageHandlers.lexshell;
      if (h && typeof h.postMessage === 'function') h.postMessage('ready');
    } catch (_) { /* в браузере моста нет — и не надо */ }
  }

  // Поставить курсор и, когда каретка встанет (или когда станет ясно, что за
  // отпущенный срок не встанет), отпустить заставку.
  //
  // Ответ «не встала» тоже снимает заставку: держать чёрный экран из-за
  // невставшего курсора — обмен плохого на худшее. Дальше вопрос закрывает
  // предохранитель оболочки, у него тот же срок.
  function caretThenReveal() {
    // The main page of the people has no field (the capsule of a new chat stands there, В7.64): nothing waits for a caret.
    if (homeOn()) { shellPageReady(); return; }
    let p;
    try { p = WcComposer.focusUntilCaret({ raiseKeyboard: true }); } catch (_) { p = null; }
    if (!p || typeof p.then !== 'function') { shellPageReady(); return; }
    p.then(shellPageReady, shellPageReady);
  }

  // Окно на Маке живёт дольше страницы: его прячут и показывают, а страница всё
  // это время загружена. Значит «человек открыл окно» приходит снаружи — этим
  // вызовом, из `AppDelegate.show()`. На iPhone его нет: там открытие окна и
  // есть запуск приложения.
  //
  // На iPhone он тоже нужен, и по той же причине с другой стороны: приложение
  // зовёт его КАЖДЫЙ раз, когда становится активным — и на запуске, и на
  // возврате из фона. До этого момента окно не может взять клавиатуру себе, и
  // курсор, поставленный раньше, каретки не даёт (замер 2026-08-21).
  //
  // Позвали раньше, чем собрался интерфейс, — вызов молча уходит в никуда, и
  // это не потеря: `enterApp` ставит курсор сам, когда дойдёт.
  global.__lexFocusComposer = function () {
    if (!composerReady) return;
    try { caretThenReveal(); } catch (_) { /* noop */ }
  };

  // Есть ли уже поле, в которое можно ставить курсор.
  let composerReady = false;

  function showGate() {
    hideBoot();
    // Форма входа — конечный вид сама по себе: ждать здесь нечего, каретки в
    // чате не будет, пока человек не вошёл.
    shellPageReady();
    document.getElementById('wc-gate').hidden = false;
    document.getElementById('wc-root').hidden = true;
    gateShowView('auth');
  }

  function wireGate() {
    const email = () => document.getElementById('wc-email').value.trim();
    const password = () => document.getElementById('wc-password').value;

    async function attempt(label, fn, isSignup) {
      if (!email() || !password()) { gateStatus('Enter your email and password.', true); return; }
      gateStatus(label);
      try {
        const r = await fn(email(), password());
        // Registration with email confirmation on: go to the code screen, not
        // the chat. The server already mailed a code.
        if (isSignup && r && r.needsConfirm) { rememberPending(email()); showConfirmView(email()); return; }
        await enterApp();
      } catch (err) {
        // An unconfirmed account can't sign in — route to the code screen and
        // get a fresh code on its way, instead of showing "wrong password".
        if (isUnconfirmedError(err)) { showConfirmView(email()); doResendConfirm(true); return; }
        gateStatus(gateErrorText(err), true);
      }
    }

    document.getElementById('wc-gate-form').addEventListener('submit', (e) => {
      e.preventDefault();
      attempt('Signing in…', (a, b) => WcAuth.signIn(a, b));
    });
    document.getElementById('wc-signup').addEventListener('click', () =>
      attempt('Creating your account…', (a, b) => WcAuth.signUp(a, b), true));
    // В браузере это уход по адресу и сюда управление уже не вернётся. В
    // приложении открывается системный лист входа, и вернуться он обязан —
    // в том числе когда человек нажал «Отмена».
    document.getElementById('wc-google').addEventListener('click', async () => {
      const btn = document.getElementById('wc-google');
      btn.disabled = true;
      gateStatus('Taking you to Google…');
      let r;
      try {
        r = await WcAuth.signInWithGoogle();
      } catch (err) {
        r = { ok: false, error: String((err && err.message) || err) };
      }
      btn.disabled = false;
      if (!r || r.redirected) return;          // браузер уже уходит со страницы
      if (r.ok) {
        await WcAuth.fillUser();
        await enterApp();
        return;
      }
      // Отмена — не ошибка. Красное сообщение на «я передумал» — это ровно то,
      // из-за чего люди решают, что приложение сломалось.
      if (r.cancelled) { gateStatus(''); return; }
      gateStatus('Google sign-in did not go through: ' + (r.error || 'unknown'), true);
    });

    // ── Email confirmation view ───────────────────────────────────────────────
    async function doConfirm() {
      const code = document.getElementById('wc-confirm-code').value.trim();
      if (!code) { gateStatus('Enter the code from the email.', true); return; }
      gateStatus('Confirming…');
      try {
        await WcAuth.confirmSignup(confirmEmail, code);
        clearPending();
        await enterApp();
      } catch (err) {
        // Wrong or expired — same server answer, decided by age. The field is
        // NOT cleared, so a typo can be fixed without retyping.
        try { if (typeof lexLog === 'function') lexLog('[wc-app] confirm failed:', String((err && err.message) || err)); } catch (_) {}
        gateStatus(codeErrorText(), true);
      }
    }

    async function doResendConfirm(silent) {
      if (!confirmEmail) return;
      if (!silent) gateStatus('Sending…');
      try {
        await WcAuth.resendConfirm(confirmEmail);
        rememberPending(confirmEmail);
        gateStatus('A new code is on its way to ' + confirmEmail + '.');
        startResendCooldown();
      } catch (err) {
        gateStatus(gateErrorText(err), true);
      }
    }

    function startResendCooldown() {
      const btn = document.getElementById('wc-confirm-resend');
      if (resendTimer) { clearInterval(resendTimer); resendTimer = null; }
      const until = Date.now() + 30 * 1000;
      btn.disabled = true;
      const tick = () => {
        const left = Math.ceil((until - Date.now()) / 1000);
        if (left <= 0) { clearInterval(resendTimer); resendTimer = null; btn.disabled = false; btn.textContent = 'Resend code'; return; }
        btn.textContent = 'Resend code (' + left + ')';
      };
      tick();
      resendTimer = setInterval(tick, 1000);
    }

    document.getElementById('wc-confirm-form').addEventListener('submit', (e) => { e.preventDefault(); doConfirm(); });
    document.getElementById('wc-confirm-resend').addEventListener('click', () => doResendConfirm(false));
    document.getElementById('wc-confirm-back').addEventListener('click', () => { clearPending(); gateShowView('auth'); });

    // ── Password recovery view ────────────────────────────────────────────────
    function resetRecoverView() {
      document.getElementById('wc-recover-step2').hidden = true;
      document.getElementById('wc-recover-send').hidden = false;
      document.getElementById('wc-recover-email').readOnly = false;
      document.getElementById('wc-recover-code').value = '';
      document.getElementById('wc-recover-password').value = '';
      document.getElementById('wc-recover-hint').textContent = 'Enter your email — we’ll send you a code.';
    }

    async function doSendRecover() {
      const em = document.getElementById('wc-recover-email').value.trim();
      if (!em) { gateStatus('Enter your email.', true); return; }
      gateStatus('Sending…');
      try {
        await WcAuth.recoverRequest(em);
        codeSentAt = Date.now();
        document.getElementById('wc-recover-email').readOnly = true;
        document.getElementById('wc-recover-send').hidden = true;
        document.getElementById('wc-recover-step2').hidden = false;
        document.getElementById('wc-recover-hint').textContent = 'We sent a code to ' + em + '. Enter it below with a new password.';
        gateStatus('');
        try { document.getElementById('wc-recover-code').focus(); } catch (_) {}
      } catch (err) {
        gateStatus(gateErrorText(err), true);
      }
    }

    async function doRecoverReset() {
      const em = document.getElementById('wc-recover-email').value.trim();
      const code = document.getElementById('wc-recover-code').value.trim();
      const pw = document.getElementById('wc-recover-password').value;
      if (!code || !pw) { gateStatus('Enter the code and a new password.', true); return; }
      if (pw.length < 6) { gateStatus('The password is too short — use at least 6 characters.', true); return; }
      gateStatus('Saving…');
      try {
        await WcAuth.recoverConfirm(em, code, pw);
        clearPending();
        await enterApp();
      } catch (err) {
        const raw = String((err && err.message) || err || '');
        if (/weak_password|at least \d|password is too short|should be at least/i.test(raw)) {
          gateStatus('The password is too short — use at least 6 characters.', true);
        } else if (/same_password|different from (the old|your)/i.test(raw)) {
          gateStatus('Choose a password different from your current one.', true);
        } else {
          gateStatus(codeErrorText(), true);
        }
      }
    }

    document.getElementById('wc-forgot').addEventListener('click', () => {
      resetRecoverView();
      document.getElementById('wc-recover-email').value = email(); // carry the typed email over
      gateShowView('recover');
      try { document.getElementById('wc-recover-email').focus(); } catch (_) {}
    });
    document.getElementById('wc-recover-back').addEventListener('click', () => gateShowView('auth'));
    document.getElementById('wc-recover-form').addEventListener('submit', (e) => {
      e.preventDefault();
      if (!document.getElementById('wc-recover-step2').hidden) doRecoverReset(); else doSendRecover();
    });
    document.getElementById('wc-recover-submit').addEventListener('click', () => doRecoverReset());
  }

  // ── Boot ──────────────────────────────────────────────────────────────────


  async function enterApp() {
    document.getElementById('wc-gate').hidden = true;
    gateStatus('');
    document.getElementById('wc-news-back').onclick = () => sectionBack.go();
    // The database's signals: one channel for the whole visit (sign-out reloads the page).
    // The balance in the header follows the signal «balance» — a debit, a top-up — and is
    // read again once after a break of the channel.
    signals.start();
    // The first opening of the channel is the start itself: the balance is read just below.
    let balanceFirst = true;
    signals.follow(['balance'], (signal) => {
      if (!signal && balanceFirst) { balanceFirst = false; return; }
      balanceFirst = false;
      WcBus.broadcast({ type: 'WC_BALANCE_CHANGED' });
    });
    // A new page is out (supabase/migrations/page_signal.sql): the release tells the server, the
    // server tells every open Lex. Only the Mac app takes it (its mark says `page`): it reloads the
    // window, and what was typed stays in the drafts. Nothing asks the server on a timer.
    let pageFirst = true;
    signals.follow(['page'], async (signal) => {
      if (!signal) {
        // The channel is open again and the journal could not say what was missed: the page itself
        // is asked once. The first opening is the start — the page just loaded is the newest.
        if (pageFirst) { pageFirst = false; return; }
        pageNewStamp = await liveStamp();
      } else {
        pageFirst = false;
        pageNewStamp = (signal.payload && signal.payload.stamp) ? String(signal.payload.stamp) : null;
      }
      applyNewPage();
    });
    // The list of chats changed on any device: a new chat, a new message, a title, a rename,
    // hiding (account_changes.sql), pinned, read, unread, deleted (chat_states.sql). The list Chats
    // is read anew, and the open chat if the screen lacks a message the server has; the list of
    // Profi.ru follows its own signal «profi». After a break the journal of changes hands over
    // what was missed; only when it cannot (signal null) the list is read on its own below.
    let chatsFirst = true;
    signals.follow(['chats'], async (signal) => {
      if (!signal) {
        if (chatsFirst) { chatsFirst = false; return; }
        await refreshConversations();
        catchUpOpenChat(state.conversationId);
        return;
      }
      chatsFirst = false;
      const key = String((signal.payload && signal.payload.chat) || '');
      if (key.startsWith('__lex_profi__')) return;
      await refreshConversations();
      if (key && key === state.conversationId) catchUpOpenChat(key);
    });
    // The unread of the account changed on any device (unread_counts.sql): the numbers of the
    // lines, the section buttons are read anew; after a break of the channel — once more.
    signals.follow(['unread'], () => readUnread());
    // A row of Claude Code that came without the owner's message — the Mac's work on a code
    // task from this chat, its progress and its Итог (lex_cc_row_put, claude_code_rows.sql): the
    // open chat is read anew, so the row appears and grows while the Mac works. Not while this
    // page draws its own answer: the next signal after it brings the row. An order chat of Profi
    // shows the row when opened again (its section reads it on its own signal).
    let ccRowTimer = null;
    signals.follow(['chat'], (signal) => {
      const key = signal && signal.payload && String(signal.payload.chat || '');
      if (!key || key !== state.conversationId || key.startsWith('__lex_profi__') || WcHistory.isFolderKey(key)) return;
      // An answer the server writes (chat_turn_fate.sql): this page's own is on the screen by its
      // stream; a let-go number has nothing to show. Another device's answer grows here.
      const op = signal.payload.op;
      if (op && (ownOps.has(op) || signal.payload.state === 'released')) return;
      clearTimeout(ccRowTimer);
      ccRowTimer = setTimeout(() => {
        WcThread.whenFree('cc-row', () => {
          if (state.conversationId === key && !WcThread.isStreaming()) openConversation(key, { again: true }).catch(() => {});
        });
      }, 300);
    });
    loadSections();

    // ВСЁ ОСТАЛЬНОЕ В ЭТОЙ ФУНКЦИИ ЧИТАЕТ ХРАНИЛИЩЕ, ПОЭТОМУ ПРОВЕРКА ПЕРВОЙ.
    // Единственная точка входа в приложение: сюда приходят и форма, и
    // регистрация, и возврат от Google, и уже лежавший пропуск. Значит, «вошёл
    // другим, ни разу не выйдя» ловится здесь наравне с обычным входом — не
    // полагаемся на то, что человек нажмёт «Выйти».
    let wiped = false;
    try {
      const s = WcAuth.session();
      wiped = await WcWipe.resetIfAccountChanged(s && s.user && s.user.id);
    } catch (err) { console.warn('[wc] account switch check:', err && err.message); }
    // Оформление и размер текста boot() применил ДО этой проверки — значит, из
    // настроек прошлого человека. Перечитать после чистки, иначе его тема
    // осталась бы на экране до перезагрузки страницы.
    if (wiped) { try { await WcSettings.applyStored(); } catch (_) { /* noop */ } }

    // The draft of every chat (lex-drafts.js): this device's copy at once, the server's after it, and
    // again at the signal «drafts» — a draft typed on the iPhone stands here in the same chat. The
    // lists of chats show «Draft: …» from it (LexSection.draft).
    if (global.LexDrafts) {
      let who = '';
      try { const s = WcAuth.session(); who = (s && s.user && s.user.id) || ''; } catch (_) { who = ''; }
      await global.LexDrafts.init({
        load: () => WcStore.one(DRAFTS_KEY, null),
        save: (copy) => WcStore.set({ [DRAFTS_KEY]: copy }),
        rpc: newsRpc,
        account: () => who,
      });
      global.LexSection.setDrafts((key) => global.LexDrafts.line(key));
      global.LexDrafts.onChange(draftsChanged);
      signals.follow(['drafts'], () => { global.LexDrafts.pull(); });
      global.LexDrafts.pull();
      // Hidden or closed: what was typed goes to the server now.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') global.LexDrafts.flush();
      });
      global.addEventListener('pagehide', () => { global.LexDrafts.flush(); });
    }

    // The curated defaults the owner publishes from the extension — models, prompts, knobs —
    // and the default model, side by side. Nothing on the screen waits for them: what they say
    // lies in this page's storage from the last time. The first question waits for them (send,
    // toggleVoice), so a turn never goes out on a default this page is about to replace.
    settingsReady = Promise.all([
      WcBackend.adoptPublished().catch((err) => console.warn('[wc] published settings:', err && err.message)),
      WcBackend.modelDefaults().catch((err) => console.warn('[wc] model defaults:', err && err.message)),
    ]);
    // Дальше набор перечитывается при открытии беседы — см. refreshPublished.
    // Список ЗАГОТОВОК ДЕЙСТВИЙ — здесь же и по той же причине, что настройки
    // выше: он отвечает только по токену, а на сборке композера токена ещё нет.
    // Эта функция и есть «открытие чата» на странице: через неё проходят оба
    // пути внутрь приложения — вход руками и возврат с живой сессией. Не ждём:
    // ряд появится сам, когда список доедет.
    WcComposer.loadPresets();

    document.getElementById('wc-root').hidden = false;
    // Скелет держится, пока на экране нет баланса и списка бесед: заставка
    // оболочки снимается по нему, и снять её раньше значит показать наполовину
    // собранный экран — ровно то, от чего уходим. Both stand from the copies this device kept
    // (lex-reads.js) in the first frame; the server is waited for only where there is no copy
    // yet — the first start on this device.
    //
    // `finally`, а не просто по порядку: не доехало — всё равно показываем, что
    // есть. Запертый навсегда скелет хуже неполного экрана.
    try {
      await Promise.all([firstFrameOf(refreshAccount), firstFrameOf(refreshConversations)]);
    } finally {
      hideBoot();
      composerReady = true;
      // Курсор ДО снятия заставки, а не после: на телефоне фокус поднимает
      // клавиатуру, и человек, увидевший экран раньше неё, увидел бы, как чат
      // подпрыгивает. Под заставкой это происходит невидимо, и открывается
      // сразу конечное состояние — поле, палочка, клавиатура.
      //
      // Один вызов здесь остаётся как был — на быстрых сценариях (стол, возврат
      // на уже загруженную страницу) он срабатывает первым и всё заканчивается
      // на нём. `caretThenReveal` рядом — для тех случаев, когда не сработал.
      WcComposer.focus({ raiseKeyboard: !homeOn() });
      caretThenReveal();
      askShellForPush();
      restoreScreenPlace();
    }
  }

  // The first frame of a reading: done when it called onFirst (its copy is on the screen) or when
  // it ended, whichever is sooner.
  function firstFrameOf(start) {
    return new Promise((done) => {
      Promise.resolve().then(() => start(done)).then(done, done);
    });
  }

  // ── A new page is out (2026-11-19) ────────────────────────────────────────
  // The stamp of the page this window loaded is `WC_BUILD.stamp` (dev-tools/build-webchat.mjs; a
  // stand serves files as they are and has none). The signal «page» names the stamp of the page
  // laid out now. Another stamp: tell the Mac app, which reloads the window. Not while an answer is
  // coming or a call goes on — then at their end (the end of the answer, the end of the call).
  let pageNewStamp = null;
  const builtStamp = () => (global.WC_BUILD && global.WC_BUILD.stamp ? String(global.WC_BUILD.stamp) : '');
  const shellTakesPage = () => !!(global.__lexShell && global.__lexShell.page);
  const callGoes = () => !!(global.WcVoice && (global.WcVoice.active || global.WcVoice.connecting));
  async function liveStamp() {
    try {
      const r = await fetch(String(location.href).split('#')[0], { cache: 'no-store' });
      const m = /WC_BUILD\s*=\s*\{[^}]*"stamp"\s*:\s*"([^"]+)"/.exec(await r.text());
      return m ? m[1] : null;
    } catch (_) { return null; }
  }
  function applyNewPage() {
    if (!pageNewStamp || !builtStamp() || pageNewStamp === builtStamp() || !shellTakesPage()) { pageNewStamp = null; return; }
    if (callGoes() || WcThread.isStreaming()) return;
    WcThread.whenFree('page', () => {
      if (!pageNewStamp || pageNewStamp === builtStamp() || callGoes() || WcThread.isStreaming()) return;
      const stamp = pageNewStamp;
      pageNewStamp = null;
      keepScreenPlace();
      tellShell({ word: 'page', stamp });
    });
  }

  // ── The Mac app opens where it was left (2026-11-20) ──────────────────────
  // Gennady, 20.11.2026: the reload for a new page is welcome and happens at once, but it threw him
  // out of his chat to the main page: «если я закрыл на одной странице, пусть на той же открывается».
  // The Mac app keeps the place of the screen on the device — a chat with the model, a chat of a
  // person, an order chat, a feed of Extended Mind, New orders, the bot's chat — and the page that
  // loads next opens it: after a reload for a new page, after his «Reload page», after the app was
  // quit and started (a release that replaces the app does that). Left on the main page or in
  // another section — the main page. The place is the account's: another account starts at the main
  // page. A press on a notification that started the app comes after and wins. The browser page
  // starts at the main page as before.
  const PLACE_KEY = 'lexPlaceKept';
  const keepsPlace = () => !!global.__lexShell && !soloChat;
  const placeAccount = () => { try { const x = WcAuth.session(); return (x && x.user && x.user.id) || ''; } catch (_) { return ''; } };
  function placeNow() {
    const live = sectionOn === 'profi' && SECTIONS.profi.live;
    if (live && live.screen === 'feed') return { kind: 'profi_order' };
    if (live && live.screen === 'bot') return { kind: 'profi_alert', chatKey: '__lex_profi_bot__' };
    if (sectionOn) return null;
    const key = state.conversationId;
    if (!key) return null;
    // The key of an order chat ends in the number of its session, not of the order: the order is the open chat's own.
    if (key.startsWith('__lex_profi__')) {
      const order = profiChat && !profiChat.folder && profiChat.data && profiChat.data.chatKey === key ? profiChat.order : '';
      return order ? { kind: 'profi_message', chatKey: key, order: String(order) } : null;
    }
    // A task chat of an agent comes back over the folder of its agent.
    if (WcHistory.isFolderKey(key) && agentKeyOf(profiChat) && profiChat.data.chatKey === key) {
      return { kind: 'folder_message', chatKey: key, agent: agentKeyOf(profiChat) };
    }
    if (WcHistory.isFolderKey(key)) {
      const sec = folderOfChat && folderOfChat.key === key ? String(folderOfChat.sectionId || '') : '';
      return { kind: 'folder_message', chatKey: key, folder: sec.replace(/^folder:/, '') };
    }
    return { chatKey: key };
  }
  let placeSaid;
  let placeReady = false;   // not before the kept place was read: the main page of the start would wipe it
  function keepScreenPlace() {
    if (!keepsPlace() || !placeReady) return;
    try {
      const place = placeNow();
      const said = place ? JSON.stringify({ place, account: placeAccount() }) : '';
      if (said === placeSaid) return;
      placeSaid = said;
      if (said) global.localStorage.setItem(PLACE_KEY, said);
      else global.localStorage.removeItem(PLACE_KEY);
    } catch (_) { /* no storage: the main page */ }
  }
  function restoreScreenPlace() {
    // A window of one chat: that chat, and nothing kept.
    if (soloChat) {
      openFromNotification(soloChat).catch((e) => console.warn('[wc] the chat of the window:', e && e.message));
      return;
    }
    let kept = null;
    try { kept = JSON.parse(global.localStorage.getItem(PLACE_KEY) || 'null'); } catch (_) { kept = null; }
    if (!keepsPlace() || !kept || !kept.place || kept.account !== placeAccount()) { placeReady = true; keepScreenPlace(); return; }
    // A place kept before 24.11.2026 names an order chat by the number of its session as the order: nothing to open by it.
    const old = kept.place;
    if (old.kind === 'profi_message' && String(old.chatKey || '') === `__lex_profi__${old.order}`) { placeReady = true; keepScreenPlace(); return; }
    placeSaid = JSON.stringify(kept);
    // Until the kept chat is on the screen the main page of the start is not the place.
    openFromNotification(kept.place)
      .catch((e) => console.warn('[wc] place:', e && e.message))
      .then(() => { placeReady = true; });
  }
  global.addEventListener('pagehide', keepScreenPlace);

  // The page's own code on the device (sw.js): from the second opening on, the page and its files
  // open with no question to the network. The browser looks for a new version at every opening
  // (updateViaCache 'none': it asks the server for sw.js itself, past every cache) and the page
  // asks again whenever it shows — a window of the Mac app lives for days. A new version works
  // from the next opening of the page. No worker in this browser — the page loads as before.
  function keepPageOnDevice() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    }).catch((err) => console.warn('[wc] the page on the device:', err && err.message));
  }

  // Stop of a development task: the one controller (stops, lex-stop.js); a refusal is said under the button
  // (LexMessage.taskStop), in the same words as the field's.
  const stopDevTask = (task) => stops.stop('task', task);

  async function boot() {
    keepPageOnDevice();
    await WcSettings.applyStored();

    WcThread.setUnsentHook(onUnsent);
    WcThread.init({
      onPickModel: pickModelForAnswer,
      // Retry under the last answer (23.11.2026, as in claude.ai): the same answer asked again by the model that wrote
      // it — no model given, the backend takes the one of that answer (wc-backend.js, WC_REGENERATE).
      onRetry: (turn) => regenerate(turn, null),
      onEdit: editTurn,
      // ‹ 1 / 2 › under one's own message: another version of it (select_turn).
      onSwitchVersion: (uid) => { switchVersion(uid); },
      // An edit in place that brought not a word: the old message is back on the screen; why — in a line.
      onEditBack: (why) => { if (why) toast(why, { error: true }); },
      // «Send to … now» in the menu of a word to Lex: the answer still being written to it stops.
      onStopCurrent: () => { stops.stop('turn', state.requestId); },
      // The thread got its first word or was cleared: the main page gives way or comes back.
      onEmpty: paintHome,
      // Stop under a running development task of Lex («mac:N»): the database stops it and rewrites its row.
      onDevStop: stopDevTask,
    });
    refreshTextModelLabel();
    WcStore.subscribe((changes) => {
      if (changes && Object.keys(changes).some((k) => k.indexOf('activeModelId_') === 0)) refreshTextModelLabel();
    });
    // Клик по словам в ленте. Поднимается ДО первой отрисовки беседы: иначе
    // первые пузыри пришли бы без исходника на узле и включить режим на них
    // было бы нечем. Значение переключателя — из настроек этой поверхности
    // (WcStore, своё в браузере, на Маке и на телефоне); подписка нужна для
    // второй вкладки того же браузера, где переключатель могли тронуть.
    WcWordPick.init({ onChipsChanged: () => WcComposer.refresh() });
    // По умолчанию ВКЛЮЧЕНО — как в расширении и на айфоне (решение владельца
    // 2026-09-06, «tap words is on out of the box»; spec 50-settings). Выключено
    // только то, что человек выключил сам.
    WcWordPick.setEnabled(await WcStore.one(WcWordPick.STORAGE_KEY, true) !== false);
    WcStore.subscribe((changes) => {
      if (!changes || !changes[WcWordPick.STORAGE_KEY]) return;
      WcWordPick.setEnabled(changes[WcWordPick.STORAGE_KEY].newValue !== false);
    });
    WcAttach.init();
    // A picture or a file put on the field or taken off it: the draft of the chat keeps it.
    WcAttach.onChange = () => saveField();
    WcAttach.readsImages = () => textModelSees;
    WcAttach.chatKey = () => state.conversationId || null;
    WcSidebar.init({
      onOpen: openConversation,
      onNew: () => newConversation({ typing: true }),
      onRename: renameConversation,
      onDelete: deleteConversation,
      onAct: actConversation,
      onToggle: onSidebarToggle,
      onLoadMore: loadMoreConversations,
      onRetry: refreshConversations,
    });
    await WcComposer.init({
      onSend: send,
      // Every change of the field is the draft of its chat (lex-drafts.js).
      onFieldChange: () => saveField(),
      // Stop of an answer, or of the agent of the open task chat: whose — by its number (LexStop.parse, stopFromField).
      onStop: stopFromField,
      onVoice: (o) => toggleVoice(o),
      // «+» offers a picture and a file only where the profile of the chat takes them (LexComposer.plusItems: a chat
      // with an agent takes only words; a file pasted into the field there stops at the send).
      onAttach: () => WcAttach.pick(),
      onAttachFile: () => WcAttach.pickFile(),
      // Первый пункт меню «+»: к чему привязана беседа. Читается синхронно —
      // значение уже лежит наготове (syncAttachment выше).
      attachedPage: () => attachedPage,
      // Пункт «Text model» меню «+»: подпись — модель по умолчанию этого чата, нажатие
      // открывает меню моделей. Видят все, в каждом чате.
      textModel: () => ({ label: textModelLabelNow(), open: pickDefaultModel }),
      // Holding the arrow: in an order chat the text goes to the client at once, without the
      // model, or at a time (lex-profi.js sendMenu); other chats have no such ways.
      sendMenu: (text) => (profiChat && !(reply && reply.editUid) ? profiChat.sendMenu(text) : null),
    });
    watchFieldProfile();
    WcQuick.init({
      onCapsule: (mode) => { openQuick(mode).catch((e) => console.warn('[wc] quick:', e && e.message)); },
      onClose: () => { closeQuick().catch((e) => console.warn('[wc] quick close:', e && e.message)); },
    });
    paintCapsule();
    // The mark of Lex in the empty place beside the folder of an agent (paintSplit): the one copy of the letter.
    const blankMark = document.getElementById('wc-agents-blank');
    if (blankMark && global.LexBrandMark) blankMark.innerHTML = LexBrandMark.svgMarkup(48);
    // The field of the chat the page starts on: a new chat, or the one already opened. Words typed
    // before the drafts were read stay in the field, as that chat's.
    if (fieldKey === null && !sectionOn) {
      const typed = WcComposer.text();
      takeField(state.conversationId || newChatKey());
      if (typed.trim() && !WcComposer.text().trim()) WcComposer.setText(typed);
    }
    paintAddressee();
    // Один вход в аккаунт на весь интерфейс — строка внизу шторки. Пополнение
    // и выход живут внутри листа настроек, а не рядом с ним: это и были дубли.
    //
    // Пополнение зовётся из ДВУХ мест — кнопки в подвале шторки и кнопки в
    // плашке «кончились деньги», которую строит общий с расширением модуль.
    // Поэтому оно тут одной функцией: у плашки обязан быть тот же `onPaid`,
    // иначе после оплаты баланс на экране останется старым.
    const topUp = () => WcTopup.open({ onPaid: refreshAccount });
    LexBillingGate.setTopupAction(topUp);

    WcHeader.init({
      onSettings: openSettings,
      // Пополнение теперь ровно ОДНО место — своя кнопка в подвале шторки.
      // Из листа настроек оно убрано (wc-settings.js): два входа в одно и то
      // же и были тем дублем, ради снятия которого подвал когда-то свели в
      // одну строку.
      onTopUp: topUp,
      // The call-only gear opens the SAME Live/Push-to-talk switcher the
      // composer's round button already opens on long-press — not a second
      // menu (2026-08-19 brief, "новых настроек внутрь не заводить").
      onVoiceSettings: (anchor) => WcComposer.openVoiceModeMenu(anchor),
    });

    watchWidth();
    watchKeyboard();
    watchBarHeights();

    WcBus.subscribe((msg) => {
      if (msg.type === 'WC_TURN_UIDS') {
        turnUids.set(msg.requestId, { userUid: msg.userUid, assistantUid: msg.assistantUid });
      } else if (msg.type === 'STREAM_SERVER_TURN') {
        // The number the server leads the turn by: a Retry's too (its number is minted there), for the
        // return to its chat while its stream still reads (leftRequestOf).
        if (msg.opId && !opOfRequest.has(msg.requestId)) opOfRequest.set(msg.requestId, String(msg.opId));
      } else if (msg.type === 'WC_TURN_LATE') {
        // A turn broken off without a word from the server turned out written there (wc-backend.js
        // followLate): the open chat is read anew — the server's answer takes the place of the cut one.
        const key = msg.chatKey;
        if (key && key === state.conversationId && !WcThread.isStreaming()) {
          WcBus.call('WC_LOAD_CONVERSATION', { id: key })
            .then((again) => {
              if (again && again.ok && state.conversationId === key && !WcThread.isStreaming()) {
                WcThread.whenFree('late-turn', () => paintConversation(again, { keepPlace: true }));
              }
            })
            .catch(() => {});
          refreshAccount();
        }
      } else if (msg.type === 'WC_CONVERSATION_OPENED') {
        // Беседа заведена до первого сообщения (диктовка): она и открыта.
        if (!state.conversationId && msg.id) {
          state.conversationId = msg.id;
          WcSidebar.setActive(msg.id);
          adoptFieldKey(msg.id);
        }
      }
      if (msg.type === 'STREAM_DONE' || msg.type === 'STREAM_ERROR') {
        if (msg.requestId === state.requestId) {
          state.requestId = null;
          WcComposer.setStreaming(false);
        }
        opOfRequest.delete(msg.requestId);
        // A page that came out while the answer went is taken a moment after its end.
        if (pageNewStamp) setTimeout(applyNewPage, 2000);
        // The message got its answer, or a part of one the server keeps: it leaves the store.
        // A refusal took it out of the outbox already (onUnsent, called by WcThread.error).
        // After the thread's own handling of the same event, whatever the order of the listeners.
        const rid = msg.requestId;
        setTimeout(() => {
          const kept = outbox.get(rid);
          if (kept) { outbox.delete(rid); unsentDrop(kept.id); }
        }, 0);
        // An answer of a chat the person left: the thread forgets it; that chat open again
        // now shows it as the server wrote it.
        if (leftChats.has(msg.requestId)) {
          const key = leftChats.get(msg.requestId);
          leftChats.delete(msg.requestId);
          WcThread.settled(msg.requestId);
          if (msg.type === 'STREAM_DONE' && key && key === state.conversationId && !profiChat && !WcThread.isStreaming()) {
            WcBus.call('WC_LOAD_CONVERSATION', { id: key })
              .then((again) => { if (again && again.ok && state.conversationId === key && !WcThread.isStreaming()) paintConversation(again, { keepPlace: true }); })
              .catch(() => {});
          }
        }
        if (msg.type === 'STREAM_DONE') refreshAccount();
        // An edit in place ended: the chat as the server keeps it now — the new version with ‹ 2 / 2 ›, or the old one.
        if (editRequests.has(msg.requestId)) {
          const key = editRequests.get(msg.requestId);
          editRequests.delete(msg.requestId);
          setTimeout(() => reloadOpenChat(key, { force: true }), 300);
        }
        // An answer followed on the server after a break (wc-backend.js followAfterBreak): what the
        // screen lacks of it comes from the chat as the server wrote it.
        if (msg.type === 'STREAM_DONE' && msg.followed && state.conversationId) catchUpOpenChat(state.conversationId);
        if (msg.type === 'STREAM_DONE' && profiChat) refreshProfiChat().catch(() => {});
        // A feed's entries that came while the answer was written go in now.
        setTimeout(lookEmFeedIfDue, 0);
        // Цена хода встанет, когда сервер запишет строку расхода: под ответом,
        // а у пустого ответа — под вопросом. Остановленный ответ сервер
        // дочитывает до конца и пишет позже; после первого хода беседы ещё
        // считается платное название.
        const u = turnUids.get(msg.requestId) || {};
        turnUids.delete(msg.requestId);
        // Its question is edited in place at once, not only after the chat is read again: a chat with a person repaints
        // itself after the answer (refreshProfiChat), a feed of Extended Mind has no versions.
        if (u.userUid && !profiChat && !WcHistory.isEmFeedKey(state.conversationId)) setTimeout(() => WcThread.markEditable(u.userUid), 0);
        requestMoney({
          expectUid: [u.assistantUid, u.userUid].filter(Boolean),
          patienceMs: msg.stopped ? 180000 : 30000,
          settleMs: WcThread.answerCount() <= 1 ? 90000 : 4000,
        });
      } else if (msg.type === 'WC_TITLES_FILLED') {
        // Приходят ТОЛЬКО имена, по ключу беседы, — не список целиком.
        // Прислали бы список, и он затёр бы порции, догруженные прокруткой,
        // пока считались имена.
        const byId = new Map((msg.titles || []).map((t) => [t.id, t.title]));
        state.conversations = state.conversations.map((c) =>
          (byId.has(c.id) ? Object.assign({}, c, { title: byId.get(c.id), titlePending: false }) : c));
        WcSidebar.setItems(state.conversations, state.conversationId,
          { error: state.convsError, done: state.convsDone });
        syncTitle();
        // Название беседы платное — его цена входит в итог.
        requestMoney({ settleMs: 5000 });
      } else if (msg.type === 'WC_CONVERSATIONS_CHANGED') {
        refreshConversations();
      } else if (msg.type === 'WC_BALANCE_CHANGED') {
        refreshAccount();
        // Диктовка и прочая платная работа — деньги беседы изменились.
        requestMoney({ settleMs: 5000 });
      }
    });

    wireGate();

    if (WcBackend.stubbed) {
      WcComposer.note('Stubbed build — there is no real teacher behind these answers.');
    }

    // A Google redirect comes back with the tokens in the URL fragment; take
    // them before anything asks whether we are signed in.
    WcAuth.adoptRedirectSession();

    // A pass on this device with its renewal: the app stands at once from what the device keeps,
    // and the pass is renewed by the first call to the server (validToken). Only the server's
    // refusal of it sends the person to the form, on its answer (refreshAccount), not before it.
    const held = WcAuth.session();
    const token = (held && held.access_token && held.refresh_token && held.user && held.user.id)
      ? held.access_token : await WcAuth.validToken();
    if (!token) {
      showGate();
      // If a confirmation was left pending (Create account, then the page was
      // closed on the code screen), come back to that screen, not the sign-in card.
      try {
        const pe = localStorage.getItem(PENDING_EMAIL_KEY);
        if (pe) { codeSentAt = Number(localStorage.getItem(PENDING_SENT_KEY)) || 0; showConfirmView(pe); }
      } catch (_) { /* private mode */ }
      return;
    }
    // The fragment carries no user object, so fetch it once. Failure is not
    // fatal — the token is valid either way, the account row just renders
    // without an address until the next load.
    await WcAuth.fillUser();
    await enterApp();
  }

  document.addEventListener('DOMContentLoaded', () => {
    boot().catch((err) => {
      console.error('[wc] boot failed:', err);
      showGate();
      gateStatus('Could not start: ' + (err && err.message), true);
    });
  });

  async function signOut() {
    // TODO: выход из аккаунта — уход из ПРИЛОЖЕНИЯ, не из беседы; живой голос
    // здесь рвёт reload без отчёта о конце. Вне задачи 2026-09-09, не трогать.
    await forgetShellPush();
    try { await WcBus.call('WC_SIGN_OUT'); } catch (_) {}
    global.location.reload();
  }

  global.WcApp = {
    state,
    refreshAccount,
    refreshConversations,
    openConversation,
    newConversation,
    send,
    regenerate,
    stopStream,
    toggleVoice,
    // The page's own piece for the live checks of dev-tools (check-message-edit.mjs, check-message-react.mjs): a chat of a person made as the page makes it.
    makeFolderChat,
    // For the live checks of the section «Agents» (dev-tools/check-agents-section.mjs): a section shown as its button does,
    // the screen on top of the section, the section itself.
    showSection,
    agentsScreen: () => (SECTIONS.agents.live ? SECTIONS.agents.live.screen : null),
    agentsSection: () => SECTIONS.agents.live || null,
  };
})(typeof self !== 'undefined' ? self : globalThis);
