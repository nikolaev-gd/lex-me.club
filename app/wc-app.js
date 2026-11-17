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

    // Имена для безымянных доезжают ПОСЛЕ того, как список уже на экране —
    // см. врезку про два прохода в wc-backend.js. Не ждём их: шторка годна с
    // той секунды, как пришла порция, а ожидание имён убрало бы с экрана весь
    // список ради подписей к нему.
    WcBus.call('WC_FILL_TITLES', { items: state.conversations })
      .catch((err) => console.warn('[wc] titles:', err && err.message));
    if (state.convsAgain) { state.convsAgain = false; await loadConversations(true); }
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
  const isIncomingKey = (key) => !!key && (WcHistory.isEmFeedKey(key) || WcHistory.isFolderKey(key) || /^__lex_profi__\d/.test(key));
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
    });
    // Деньги беседы пришли тем же заходом — цены под ответами и итог.
    if (r.money && global.LexChatMoney) WcThread.paintMoney(global.LexChatMoney.normalize(r.money));
    // A message on its way: its state as the queue of the database has it now, once.
    brainAsked = state.conversationId;
    brainLook();
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
      paintConversation(r, { keepPlace: true });
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
    const stand = (r, again) => {
      if (!stood) {
        leaveSection();
        state.conversationId = id;
        if (opts && opts.back) sectionBack.cameFrom(opts.back);
      }
      if (opts && opts.profi) {
        if (!stood) enterProfiChat(opts.profi);
        opts.profi.words = monitorWords(r.turns);
      }
      paintConversation(r, again ? Object.assign({}, opts, { keepPlace: true }) : opts);
      if (!stood) {
        WcSidebar.setActive(id);
        WcSidebar.close();
      }
      syncTitle();
      syncAttachment();
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
      copy = await Promise.race([
        WcBus.call('WC_LOAD_CONVERSATION', { id, kept: true }).catch(() => null),
        answer.then(() => null, () => null),
      ]);
      if (copy && copy.ok && current()) stand(copy, false);
      else copy = null;
    }
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
    // The answer is the copy, unchanged: what stands is right as it is.
    if (copy && JSON.stringify(copy.turns) === JSON.stringify(r.turns) && !incomingOpts()) {
      if (r.money && global.LexChatMoney) WcThread.paintMoney(global.LexChatMoney.normalize(r.money));
      return;
    }
    stand(r, !!copy);
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
      // way; after that its state comes with the signal «marks».
      if (brainAsked !== state.conversationId) { brainAsked = state.conversationId; brainLook(); }
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
  // перечитывает пометки беседы (lex_chat_marks). Очередь базы страница спрашивает сама
  // (brain-action status) только при открытии беседы и после обрыва канала.
  let brainLooking = false;
  function liveSend() {
    for (const list of WcThread.brainMarks().values()) {
      if (list.some((m) => m.kind === 'send' && (m.state === 'ждёт' || m.state === 'идёт'))) return true;
    }
    return false;
  }
  async function brainLook() {
    const key = state.conversationId;
    if (!key || brainLooking || !liveSend()) return;
    brainLooking = true;
    try {
      const r = await newsPost('brain-action', { op: 'status', chatKey: key });
      if (state.conversationId === key && r && Array.isArray(r.marks)) WcThread.setBrainMarks(r.marks);
    } catch (e) {
      console.warn('[wc] brain status:', e && e.message);
    } finally {
      brainLooking = false;
    }
  }
  signals.follow(['marks'], async (signal) => {
    const key = state.conversationId;
    if (!key) return;
    if (!signal) { await brainLook(); return; }
    if (!signal.payload || signal.payload.chat !== key) return;
    const marks = await newsRpc('lex_chat_marks', { p_chat_key: key });
    if (state.conversationId === key && Array.isArray(marks)) WcThread.setBrainMarks(marks);
  });
  WcThread.setBrainHooks({
    onYes: () => { send('Да'); },
    onCancel: async (uid) => {
      const key = state.conversationId;
      const r = await newsPost('brain-action', { op: 'cancel', chatKey: key, turnUid: uid });
      if (state.conversationId === key && r && Array.isArray(r.marks)) WcThread.setBrainMarks(r.marks);
      return r;
    },
  });

  function resetMoney() {
    brainAsked = null;
    moneyEpoch++;
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
  const SECTIONS = {
    em: { title: 'Extended Mind', build: buildEm, leave: leaveEmFeed },
    news: { title: 'News', build: buildNews },
    profi: { title: 'Profi.ru', build: buildProfi, dropsStream: true, leave: leaveProfiChat },
    // Questions: a button of its own (2026-11-17), it opens the feed of questions of the database
    // itself, the one Extended Mind held before; no list of its own.
    questions: { title: 'Questions', opens: () => openQuestions() },
  };
  // A folder of chats (Kolya, Other; lex-folders.js) is a section the server names 'folder:<id>' with
  // its title (lex_home_sections): its entry here is made when the server names it.
  function folderSection(id, title) {
    if (!/^folder:[a-z][a-z0-9_]{0,30}$/.test(String(id || ''))) return null;
    if (!SECTIONS[id]) {
      SECTIONS[id] = { title: title || id.slice(7), build: () => buildFolder(id), dropsStream: true, leave: leaveFolderChat, folder: id.slice(7) };
    } else if (title) SECTIONS[id].title = title;
    return SECTIONS[id];
  }
  const sectionTarget = (id) => ({ title: SECTIONS[id].title, go: () => showSection(id, { back: true }) });
  let sectionOn = null;
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
    host.hidden = true;
    sectionBack.clear();
    main.classList.remove('is-section', 'is-news-opening');
    paintNewsBar(null);
    for (const s of Object.values(SECTIONS)) if (s.leave) s.leave();
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
  async function showSection(id, opts) {
    const { main, host } = sectionEls();
    const section = SECTIONS[id];
    await endVoiceOnLeave('news');
    if (section.dropsStream && WcThread.isStreaming()) leaveStream();
    leaveSection();
    ensureSection(id);
    for (const el of host.children) el.hidden = el !== section.live.el;
    sectionOn = id;
    host.hidden = false;
    main.classList.add('is-section');
    WcSidebar.close();
    await section.live.show({ back: !!(opts && opts.back) });
  }
  // The buttons of the sections: from what this device kept, then as the server names them.
  // Every section the server names is then built and its list read (warm), so its first
  // showing waits for nothing. News reads its own feed when shown (it keeps it itself).
  async function loadSections() {
    const draw = (list) => {
      for (const s of Array.isArray(list) ? list : []) if (s && String(s.id || '').startsWith('folder:')) folderSection(s.id, s.title);
      global.LexNews.renderEntries(document.getElementById('wc-sections'), list, (id) => {
        if (SECTIONS[id] && SECTIONS[id].opens) SECTIONS[id].opens();
        else if (SECTIONS[id]) showSection(id);
      });
    };
    let drawn = null;
    let sections = null;
    // The sections this page knows: the server names no other. The copy this device kept in the
    // first frame, the server's answer after it (lex-reads.js).
    try {
      sections = await read('lex_home_sections', { p_surface: 'web', p_known: ['em', 'profi', 'news', 'folders', 'questions'] }, (list, fresh, same) => {
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
    if (sectionOn) return null;
    return state.conversationId || null;
  }
  function reportPresence() {
    const key = presenceKey();
    const due = key && Date.now() - presenceAt > 30000;
    if (key === presenceSent && !due) return;
    presenceSent = key;
    presenceAt = Date.now();
    // The answer brings the numbers of the unread after the chat on the screen took its own (В7.48).
    newsRpc('lex_chat_presence', { p_device: presenceDevice, p_chat_key: key, p_surface: 'web' })
      .then((r) => { if (r && r.unread && global.LexSection) global.LexSection.setUnread(r.unread); })
      .catch(() => {});
  }
  // The numbers of the unread (supabase/migrations/unread_counts.sql): at the start, at every signal
  // «unread» of the account (a message came or was seen on any device) and after the channel opens again.
  async function readUnread() {
    try {
      const r = await newsRpc('lex_missed_summary', {});
      if (r && r.unread && global.LexSection) global.LexSection.setUnread(r.unread);
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
  function shellPush(p) {
    if (!p || !p.token || !p.env) return;
    const said = `${p.token}|${p.env}|${p.bundle || ''}`;
    if (said === shellPushSaid) return;
    newsRpc('lex_push_register', { p_token: p.token, p_env: p.env, p_bundle: p.bundle || '' }).then(() => {
      shellPushToken = p.token;
      shellPushSaid = said;
    }, (e) => console.warn('[wc] push address:', e && e.message));
  }
  // What a notification is about (the `lex` part push-send puts in it) → the screen.
  async function openFromNotification(lex) {
    if (!lex) return;
    const mine = ++notificationOpens;
    const wanted = () => mine === notificationOpens;
    const kind = String(lex.kind || '');
    const key = typeof lex.chatKey === 'string' ? lex.chatKey : '';
    const order = lex.order ? String(lex.order) : '';
    // About an order (new, reply sent, not sent): the feed of new orders at it, as on the
    // iPhone. A message in an order chat: that order.
    if (kind === 'profi_order' || (key.startsWith('__lex_profi__') && order)) {
      await showSection('profi');
      if (!wanted()) return;
      // A draft after a call (В7.42): the chat opens with the discussion shown, on the draft.
      if (kind !== 'profi_order') await SECTIONS.profi.live.openOrder(order, kind === 'profi_call_draft' ? { showLex: true } : undefined);
      else if (order) await SECTIONS.profi.live.openFeedAt(order);
      else SECTIONS.profi.live.openFeed();
      return;
    }
    if (WcHistory.isEmFeedKey(key)) {
      // A question — the feed of questions on it (the chat of one question of a notification from
      // before the one feed is that question there too).
      const item = (key.match(/^__lex_em_question_(-?\d+)__$/) || [])[1];
      const ref = typeof lex.ref === 'string' && lex.ref ? lex.ref : null;
      // Questions have a button of their own: their feed opens straight, not through Extended Mind.
      const kind = item ? 'question' : key.replace(/^__lex_em_|__$/g, '');
      if (kind !== 'question') await showSection('em');
      if (!wanted()) return;
      if (item) await openEmFeed('question', wanted, ref || `em:${item}`);
      else await openEmFeed(kind, wanted, ref);
      return;
    }
    if (key) await openConversation(key, { wanted });
  }
  global.__lexShellPush = shellPush;
  global.__lexShellOpen = (lex) => { openFromNotification(lex).catch((e) => console.warn('[wc] notification:', e && e.message)); };
  // Signed in: ask the Mac app for its address and for a click that came before the page.
  function askShellForPush() { tellShell('push'); }
  async function forgetShellPush() {
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
      onBack: (id) => { if (id === 'home') frame.open(() => readHome(), 'The feeds did not load.'); },
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
        try {
          await readHome();
        } catch (e) {
          frame.say('The feeds did not load. ' + ((e && e.message) || ''), true);
        }
        if (frame.isShown()) frame.watch();
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
  async function openEmFeed(kind, wanted, focusUid) {
    const id = `feed:${kind}`;
    const held = await heldOrKept(id, 'lex_em_feed_item', { p_kind: kind });
    if (!wanted()) return;
    if (held && held.chat) { await openEmChat(held, wanted, true, focusUid); return; }
    const info = await newsRpc('lex_em_feed_item', { p_kind: kind, p_take: true, p_limit: WcHistory.emLimit(emKeyOf(kind)) });
    if (!wanted() || !info || !info.chatKey) return;
    emHeld.put(id, emRemember(id, info));
    await openEmChat(info, wanted, false, focusUid);
  }
  async function openEmChat(info, wanted, fromHeld, focusUid) {
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
    if (!questions) setReply(null);
    // The feed of requests: its records stand as tasks, one message a task (LexMessage.task, В7.30).
    const requests = key === EM_REQUESTS_KEY;
    WcThread.setRequestsFeed(requests);
    // The title stands before the chat is drawn: drawn after, it would push the end of the chat
    // under the message box.
    paintChatTitle(questions ? { title: 'Questions', sub: waitingSub(info.waiting) }
      : requests ? { title: 'Обращения к базе', sub: daySub(emRequestsDay) } : null);
    sectionEls().main.classList.add('is-em-feed');
    await WcBus.call('WC_EM_FEED', { key, sessionId: info.sessionId });
    await openConversation(key, { back: questions ? null : sectionTarget('em'), wanted, loaded: info.chat || null, focusUid });
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
    setReply(null);
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
    const main = document.querySelector('.wc-main');
    if (!box) return;
    box.hidden = !t;
    if (main) main.classList.toggle('is-em-titled', !!t);
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
  let reply = null;
  function setReply(r) {
    const uids = r && Array.isArray(r.uids) ? r.uids.slice(0, 30) : [];
    const quoteUid = r && typeof r.quoteUid === 'string' && r.quoteUid ? r.quoteUid : null;
    reply = uids.length || quoteUid
      ? { uids, quoteUid, text: r.text || '', head: r.head || 'Reply to Extended Mind' } : null;
    const slot = document.getElementById('wc-reply');
    if (!slot) return;
    slot.hidden = !reply;
    slot.replaceChildren(...(reply ? [global.LexMessage.replyBar({
      head: reply.head, text: reply.text, onClose: () => setReply(null),
    })] : []));
    if (reply) WcComposer.focus();
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
        WcThread.renderTurns(again.turns, { newsHead, keepPlace: true, emEarlier: emEarlierOf(again), incoming: incomingOpts() });
      };
      more.label = 'Earlier messages';
      return more;
    }
    if (!r || !r.emMore || !WcHistory.isEmFeedKey(key)) return null;
    return async () => {
      await WcBus.call('WC_EM_EARLIER', { key });
      const again = await WcBus.call('WC_LOAD_CONVERSATION', { id: key });
      if (again && again.ok && state.conversationId === key) {
        WcThread.renderTurns(again.turns, { newsHead, keepPlace: true, emEarlier: emEarlierOf(again), incoming: incomingOpts() });
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
    };
  }
  function leaveProfiChat() {
    const { main, person, link } = profiEls();
    person.hidden = true;
    person.replaceChildren();
    link.replaceChildren();
    main.classList.remove('is-profi-chat', 'is-profi-clean');
    paintProfiOutbox(null);
    // The line of a reply on a message of this chat does not go to another chat.
    if (reply && reply.quoteUid) setReply(null);
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
      signals,
      rpc: newsRpc,
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
    profiChat = chat;
    WcThread.setProfiChat(chat);
    main.classList.add('is-profi-chat');
    // The clean view the chat starts with (on, lex-profi.js createChat).
    main.classList.toggle('is-profi-clean', !!chat.clean);
    paintProfiBar();
    paintProfiOutbox(chat);
    // The section the chat came from follows the server while it is open: Profi.ru, or its folder.
    const from = SECTIONS[chat.sectionId || 'profi'];
    if (from && from.live) from.live.watch();
    // The label of «Text model» in this chat: the model of order chats, the monitor's of
    // this chat by default — known once WC_PROFI_CHAT told it.
    refreshTextModelLabel();
  }
  // The bar over an order chat, as in Telegram: the client's letter, name and channel, and the
  // button of the clean view (lex-profi.js bar(); the order on Profi is the title of the card).
  function paintProfiBar() {
    const { person, link } = profiEls();
    if (!profiChat || !profiChat.data) return;
    const bar = profiChat.bar();
    person.replaceChildren(...bar.person.childNodes);
    // The photo and the name are one button: the card of the person (lex-person.js, В7.41).
    person.onclick = bar.open || null;
    person.disabled = !bar.open;
    person.setAttribute('aria-label', (bar.who || 'Client') + '. Open the card of the person');
    person.hidden = false;
    link.replaceChildren(...(bar.link ? [bar.link] : []));
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
  function putBackIntoField(text) {
    const cur = (document.getElementById('wc-input') || {}).value || '';
    if (cur.trim()) { toast('The field is not empty: the text was not put there.'); return; }
    WcComposer.setText(text);
    WcComposer.focus();
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
      onClean: (on) => { const { main } = profiEls(); main.classList.toggle('is-profi-clean', on); },
      // Reply yourself, and a notification of a draft after a call: the chat opens with the draft and the
      // discussion shown.
      clean: !(opts && (opts.replySelf || opts.showLex)),
      order,
      // The look of a message (В7.35–В7.40): the sheet of a quoted message (the common sheet В7.15), the
      // way to it in the chat, and the line of a reply over the field (В7.26).
      sheet: (o) => WcUI.sheet('wc-msg-sheet', o.title, [o.body], o.onClose),
      showInChat: (uid) => WcThread.showTurn(uid),
      reply: (r) => setReply(r),
      replyQuote: () => (reply && reply.quoteUid) || null,
      replyDone: () => { if (reply && reply.quoteUid) setReply(null); },
      reload: () => { refreshProfiChat().catch((e) => console.warn('[wc] order chat:', e && e.message)); },
      // The card of the person (lex-person.js, В7.41): its server door; a new name re-reads the chat;
      // a person deleted from Lex takes his chat off the list — the list of the section is shown.
      person: (body) => WcBus.call('WC_PERSON', { body }),
      onPersonGone: () => showSection('profi', { back: true }),
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
      await openConversation(held.chatKey, { profi: chat, back: sectionTarget('profi'), wanted, loaded: held.chat });
      // The chat is on screen: a lost answer is not «the chat did not open». The watch of the
      // section reads it again with the next change, and the visit's moment is written on leaving.
      if (profiChat === chat) await refreshProfiChat({ take: true }).catch((e) => console.warn('[wc] order chat:', e && e.message));
      return;
    }
    const read = () => newsRpc('profi_item', { p_order: order, p_on_screen: true, p_take: true });
    let data = await read();
    if (!wanted()) return;
    if (!data || !data.chatKey) {
      // An order from a list of the day has no chat yet: it opens the way Reply yourself does.
      await newsRpc('profi_command', { p_op_id: global.LexProfi.newOpId(), p_kind: 'reply_self', p_order: order, p_args: {} });
      data = await read();
      if (!wanted()) return;
    }
    if (!data || !data.chatKey) { toast('The chat did not open', { error: true }); return; }
    if (keep) keep(data);
    const chat = makeProfiChat(order, data, keep, opts);
    await WcBus.call('WC_PROFI_CHAT', { key: data.chatKey, modelId: data.modelId });
    await openConversation(data.chatKey, { profi: chat, back: sectionTarget('profi'), wanted, loaded: data.chat });
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
    if (WcThread.isStreaming() || (global.WcVoice && (WcVoice.active || WcVoice.connecting))) { WcThread.paintProfiBoxes(); return; }
    if (state.conversationId !== data.chatKey) return;
    const r = data.chat
      ? await WcBus.call('WC_ADOPT_CONVERSATION', { id: data.chatKey, conversation: data.chat.conversation, money: data.chat.money, marks: data.chat.marks })
      : await WcBus.call('WC_LOAD_CONVERSATION', { id: state.conversationId });
    if (!r || !r.ok || profiChat !== chat || WcThread.isStreaming() || state.conversationId !== data.chatKey) return;
    const shown = new Set(WcThread.shownUids());
    const words = monitorWords(r.turns);
    const before = chat.words || new Map();
    const same = r.turns.every((t) => !t.uid || shown.has(t.uid)) && [...words].every(([uid, w]) => before.get(uid) === w);
    if (!moved && same) { WcThread.paintProfiBoxes(); return; }
    chat.words = words;
    WcThread.repaintKeepingPlace(r.turns, { newsHead, incoming: incomingOpts() });
    if (r.money && global.LexChatMoney) WcThread.paintMoney(global.LexChatMoney.normalize(r.money));
    restoreUnsent(r).catch((err) => console.warn('[wc] unsent:', err && err.message));
  }

  // ── Folders of chats: Kolya, Other ────────────────────────────────────────
  // The list of a folder is lex-folders.js; a chat of it is drawn by the order chat object of
  // lex-profi.js (createChat with folder): the person's messages from every messenger, Gennady's,
  // the marks of the messengers, files. There is no model in it: Send gives the text to the
  // database, which sends it where the person wrote last (the edge function folder-send). A group
  // has no Send. The chat lives in the same place as an order chat (profiChat).
  function buildFolder(id) {
    return global.LexFolders.createSection({
      folder: SECTIONS[id].folder,
      title: SECTIONS[id].title,
      back: sectionBack,
      signals,
      rpc: newsRpc,
      read,
      openChat: (key, wanted, held, keepIt) => openFolderChat(id, key, wanted, held, keepIt),
      notify: (text) => toast(text, { error: true }),
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
      clean: false,
      sheet: (o) => WcUI.sheet('wc-msg-sheet', o.title, [o.body], o.onClose),
      showInChat: (uid) => WcThread.showTurn(uid),
      reply: (r) => setReply(r),
      replyQuote: () => (reply && reply.quoteUid) || null,
      replyDone: () => { if (reply && reply.quoteUid) setReply(null); },
      reload: () => { refreshFolderChat().catch((e) => console.warn('[wc] folder chat:', e && e.message)); },
      sendText: (text, quoteUid) => sendToFolder(chat, text, quoteUid),
    });
    chat.folder = true;
    chat.sectionId = sectionId;
    chat.data = data;
    chat.keep = keepIt || null;
    return chat;
  }
  // A press on a chat of a folder: what the section holds (or this device kept) is on screen at once,
  // and the press then reads it and takes the moment of the visit; nothing held — one answer.
  async function openFolderChat(sectionId, key, wanted, heldNow, keepIt) {
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
      await openConversation(held.chatKey, { profi: chat, back: sectionTarget(sectionId), wanted, loaded: held.chat });
      if (profiChat === chat) await refreshFolderChat({ take: true }).catch((e) => console.warn('[wc] folder chat:', e && e.message));
      return;
    }
    const data = await newsRpc('folder_item', { p_chat_key: key, p_on_screen: true, p_take: true });
    if (!wanted()) return;
    if (!data || !data.chatKey || !data.chat) { toast('The chat did not open', { error: true }); return; }
    if (keepIt) keepIt(data);
    const chat = makeFolderChat(sectionId, data, keepIt);
    await openConversation(data.chatKey, { profi: chat, back: sectionTarget(sectionId), wanted, loaded: data.chat });
  }
  // The database changed something: a message came, one changed (a reaction, an edit, its file), a
  // text went or did not. A signal about another chat is not read. take — the press that showed the
  // chat from what was held: it is read and the visit's moment taken.
  async function refreshFolderChat(opts) {
    const chat = profiChat;
    if (!chat || !chat.folder || !chat.data) return;
    const told = opts && opts.payload && opts.payload.chatKey;
    if (told && told !== chat.data.chatKey) return;
    const take = !!(opts && opts.take);
    const data = await newsRpc('folder_item', {
      p_chat_key: chat.data.chatKey, p_on_screen: take || document.visibilityState === 'visible', p_take: take,
      p_limit: WcHistory.folderLimit(chat.data.chatKey),
    });
    if (!data || !data.chatKey || profiChat !== chat) return;
    if (chat.keep) chat.keep(data);
    let moved = false;
    if (take && data.chat && visit && visit.key === data.chatKey && (data.chat.since || null) !== (visit.since || null)) {
      visit.since = data.chat.since || null;
      moved = true;
    }
    chat.data = data;
    paintProfiBar();
    paintProfiOutbox(chat);
    if (!data.chat || state.conversationId !== data.chatKey) return;
    const r = await WcBus.call('WC_ADOPT_CONVERSATION', { id: data.chatKey, conversation: data.chat.conversation, money: data.chat.money, marks: data.chat.marks });
    if (!r || !r.ok || profiChat !== chat || state.conversationId !== data.chatKey) return;
    const shown = new Set(WcThread.shownUids());
    const words = monitorWords(r.turns);
    const before = chat.words || new Map();
    const same = r.turns.every((t) => !t.uid || shown.has(t.uid)) && [...words].every(([uid, w]) => before.get(uid) === w);
    if (!moved && same) { WcThread.paintProfiBoxes(); return; }
    chat.words = words;
    WcThread.repaintKeepingPlace(r.turns, { newsHead, incoming: incomingOpts(), emEarlier: emEarlierOf(r) });
  }
  // Send in a chat of a folder: the text goes to the database for the person (folder-send), which
  // sends it where he wrote last, or to the messenger of the message it answers; it stands under the
  // last message until it went. true — the server took it.
  async function sendToFolder(chat, text, quoteUid) {
    const words = String(text || '').trim();
    if (!words || !chat || !chat.data) return false;
    if (!chat.data.send) {
      toast(chat.data.kind === 'group' ? 'Lex does not write to groups: answer in the messenger.' : 'This chat takes no messages now.', { error: true });
      return false;
    }
    let out;
    try {
      out = await WcBus.call('WC_FOLDER_SEND', {
        body: { chatKey: chat.data.chatKey, text: words, opId: global.LexFolders.newOpId(), ...(quoteUid ? { quoteUid } : {}) },
      });
    } catch (err) {
      toast('Not sent. ' + ((err && err.message) || ''), { error: true });
      return false;
    }
    if (quoteUid && reply && reply.quoteUid === quoteUid) setReply(null);
    if (out && out.send && out.send.test) toast('The folder is in the test mode: the text went to your test chat.');
    refreshFolderChat().catch((e) => console.warn('[wc] folder chat:', e && e.message));
    return true;
  }

  // A chat left open behind other windows gets read when the person comes back to it.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshProfiChat().catch(() => {});
  });

  async function newConversation() {
    if (WcThread.isStreaming()) leaveStream();
    refreshPublished();
    // «Новая беседа» — уход из прежней: голос гасим до сброса состояния (то же
    // решение, что в openConversation). Карандаш во время звонка спрятан, но
    // сюда же ведёт удаление открытой беседы из панели (deleteConversation).
    await endVoiceOnLeave('new-chat');
    stopSectionOpening();
    leaveSection();
    endVisit();
    state.conversationId = null;
    WcThread.clear();
    resetMoney();
    paintNewsBar(null);
    WcSidebar.setActive(null);
    WcHeader.setTitle('');
    syncAttachment();
    WcBus.call('WC_NEW_CONVERSATION').catch((err) => console.warn('[wc] new:', err && err.message));
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
  function onSidebarToggle(open) {
    if (open) { WcComposer.blur(); return; }
    if (WcThread.isEmpty()) WcComposer.focus({ raiseKeyboard: true });
  }

  async function send(text, opts) {
    await settingsReady;
    // A chat of a folder has no model: the text is for the person. A preset talks to the model, a
    // picture is not sent to people (only text): both stay as they were.
    if (profiChat && profiChat.folder) {
      const chat = profiChat;
      if ((opts && opts.mode) || WcAttach.count() > 0) {
        if (!(opts && opts.mode)) WcComposer.setText(text || '');
        toast('Only text goes to a person from Lex.', { error: true });
        return;
      }
      const ok = await sendToFolder(chat, text, (reply && reply.quoteUid) || null);
      if (!ok && profiChat === chat) WcComposer.setText(text || '');
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
        WcComposer.setText(text || '');
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
    const opId = global.LexTurnId.newOpId();
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
  function openModelMenu(anchor, selectedId, efforts, onPick) {
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
  // каждом чате (2026-11-13): в чате заказа — модель чатов заказов (свой выбор, по
  // умолчанию модель монитора), в остальных — модель чатов Lex. Какая из двух, решает
  // открытый чат; хранит и отправляет wc-backend.js (WC_TEXT_MODEL, WC_SET_TEXT_MODEL).
  async function pickDefaultModel(anchor) {
    const profi = !!profiChat && !profiChat.folder;
    let cur = { modelId: null, efforts: {} };
    try { cur = await WcBus.call('WC_TEXT_MODEL', { profi }); } catch (_) { /* пусто — без галочки */ }
    openModelMenu(anchor, cur.modelId, cur.efforts, async (modelId) => {
      try {
        await WcBus.call('WC_SET_TEXT_MODEL', { modelId, profi });
        WcUI.toast('Text model: ' + global.LexAnswerRow.modelLabel(modelId));
        refreshTextModelLabel();
      } catch (err) {
        WcUI.toast(String((err && err.message) || err), { error: true });
      }
    });
  }

  // Подпись пункта «Text model» — нынешняя модель по умолчанию, у чатов Lex и у чатов
  // заказов своя. Меню «+» открывается синхронно, поэтому обе подписи держатся наготове.
  let textModelLabel = '';
  let profiModelLabel = '';
  // Whether those models read pictures: a picture picked as «File» goes the picture's way only
  // then (WcAttach.accept). Not known yet — it does, as before.
  let textModelSees = true;
  let profiModelSees = true;
  async function refreshTextModelLabel() {
    const label = async (profi) => {
      try {
        const cur = await WcBus.call('WC_TEXT_MODEL', { profi });
        if (!cur || !cur.modelId) return ['', true];
        const R = global.LexModelRegistry;
        return [global.LexAnswerRow.modelLabel(cur.modelId), !R || R.visionSupported(cur.modelId)];
      } catch (_) { return ['', true]; }
    };
    [[textModelLabel, textModelSees], [profiModelLabel, profiModelSees]] = await Promise.all([label(false), label(true)]);
  }

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
  function editTurn(text, presetSlot, sourceUid) {
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
    leftChats.set(state.requestId, state.conversationId || null);
    WcThread.detach(state.requestId);
    state.requestId = null;
    WcComposer.setStreaming(false);
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
        send(item.text, item.opts || {});
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
      if (item.state !== 'failed') {
        if (now - Date.parse(item.at) < UNSENT_LOST_MS) continue;
        item.state = 'failed';
        item.note = UNSENT_LOST_NOTE;
        unsentPut(item);
      }
      show.push(item);
    }
    if (state.conversationId !== key || !show.length) return;
    // A word to Lex in an order chat is part of the discussion: the clean view would hide it.
    if (profiChat && profiChat.clean) { profiChat.setClean(false); paintProfiBar(); }
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
    try {
      const r = await WcBus.call('WC_CHAT_ACT', { id, act });
      if (!r || !r.ok) throw new Error((r && r.error) || 'refused');
    } catch (err) {
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
    // A chat of a folder is the conversation with a person: Lex does not talk in it.
    if (profiChat && profiChat.folder && !(global.WcVoice && (WcVoice.active || WcVoice.connecting))) {
      toast('Voice talk with Lex is not in the chats of folders.');
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
        turns.push({ role: v.role, text: v.text, uid: 'voice:' + k });
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

          onUserStart: (id) => WcThread.beginVoiceUser(id),
          onUserDelta: (id, t) => { note(id, 'user', t); WcThread.voiceUserText(id, t); WcVoiceScreen.line('user', t); },
          onUserDone: (id, t) => { note(id, 'user', t); WcThread.voiceUserText(id, t); WcVoiceScreen.line('user', t); },
          onUserFailed: (id) => { said.delete(id); WcThread.dropVoiceUser(id); },

          onAssistantDelta: (id, t) => { note(id, 'assistant', t); WcThread.voiceAssistantText(id, t); WcVoiceScreen.line('assistant', t); },
          onAssistantDone: (id, t) => { note(id, 'assistant', t); WcThread.voiceAssistantText(id, t); WcVoiceScreen.line('assistant', t); },
          // Голос Google: из ответа не прозвучало ничего — ни пузыря, ни
          // строки в памяти беседы (сервер её тоже не записал).
          onAssistantDrop: (id) => { said.delete(id); WcThread.dropVoiceAssistant(id); },

          // response.done — весь ход завершён, можно записывать. Строку хода
          // слушатель сервера пишет вслед за ответом — деньги перечитываются.
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
      if (!key || key !== state.conversationId || key.startsWith('__lex_profi__')) return;
      clearTimeout(ccRowTimer);
      ccRowTimer = setTimeout(() => {
        if (state.conversationId === key && !WcThread.isStreaming()) openConversation(key).catch(() => {});
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
      WcComposer.focus({ raiseKeyboard: true });
      caretThenReveal();
      askShellForPush();
    }
  }

  // The first frame of a reading: done when it called onFirst (its copy is on the screen) or when
  // it ended, whichever is sooner.
  function firstFrameOf(start) {
    return new Promise((done) => {
      Promise.resolve().then(() => start(done)).then(done, done);
    });
  }

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

  async function boot() {
    keepPageOnDevice();
    await WcSettings.applyStored();

    WcThread.setUnsentHook(onUnsent);
    WcThread.init({
      onPickModel: pickModelForAnswer,
      onEdit: editTurn,
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
    WcAttach.readsImages = () => (profiChat && !profiChat.folder ? profiModelSees : textModelSees);
    WcAttach.chatKey = () => state.conversationId || null;
    WcSidebar.init({
      onOpen: openConversation,
      onNew: newConversation,
      onRename: renameConversation,
      onDelete: deleteConversation,
      onAct: actConversation,
      onToggle: onSidebarToggle,
      onLoadMore: loadMoreConversations,
      onRetry: refreshConversations,
    });
    await WcComposer.init({
      onSend: send,
      onStop: stopStream,
      onVoice: (o) => toggleVoice(o),
      onAttach: () => WcAttach.pick(),
      onAttachFile: () => WcAttach.pickFile(),
      // Первый пункт меню «+»: к чему привязана беседа. Читается синхронно —
      // значение уже лежит наготове (syncAttachment выше).
      attachedPage: () => attachedPage,
      // Пункт «Text model» меню «+»: подпись — модель по умолчанию этого чата, нажатие
      // открывает меню моделей. Видят все, в каждом чате.
      textModel: () => ({ label: profiChat && !profiChat.folder ? profiModelLabel : textModelLabel, open: pickDefaultModel }),
      // Holding the arrow: in an order chat the text goes to the client at once, without the
      // model, or at a time (lex-profi.js sendMenu); other chats have no such ways.
      sendMenu: (text) => (profiChat ? profiChat.sendMenu(text) : null),
    });
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
      } else if (msg.type === 'WC_CONVERSATION_OPENED') {
        // Беседа заведена до первого сообщения (диктовка): она и открыта.
        if (!state.conversationId && msg.id) {
          state.conversationId = msg.id;
          WcSidebar.setActive(msg.id);
        }
      }
      if (msg.type === 'STREAM_DONE' || msg.type === 'STREAM_ERROR') {
        if (msg.requestId === state.requestId) {
          state.requestId = null;
          WcComposer.setStreaming(false);
        }
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
        if (msg.type === 'STREAM_DONE' && profiChat) refreshProfiChat().catch(() => {});
        // A feed's entries that came while the answer was written go in now.
        setTimeout(lookEmFeedIfDue, 0);
        // Цена хода встанет, когда сервер запишет строку расхода: под ответом,
        // а у пустого ответа — под вопросом. Остановленный ответ сервер
        // дочитывает до конца и пишет позже; после первого хода беседы ещё
        // считается платное название.
        const u = turnUids.get(msg.requestId) || {};
        turnUids.delete(msg.requestId);
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
  };
})(typeof self !== 'undefined' ? self : globalThis);
