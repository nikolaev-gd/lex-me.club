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
    account: { signedIn: false },
    requestId: null,
  };

  let reqSeq = 0;
  const nextRequestId = () => 'wc-' + Date.now() + '-' + (++reqSeq);

  // ── Data ──────────────────────────────────────────────────────────────────

  async function refreshAccount() {
    try {
      state.account = await WcBus.call('WC_ACCOUNT_STATE');
    } catch (err) {
      // A failure to READ the balance is not a failure to be signed in. Saying
      // "signed out" here would throw the person back to the login form over a
      // blinked wifi connection.
      console.warn('[wc] account state:', err && err.message);
      state.account = Object.assign({}, state.account, { error: String(err && err.message) });
    }
    WcHeader.setAccount(state.account);
  }

  async function refreshConversations() {
    try {
      const r = await WcBus.call('WC_LIST_CONVERSATIONS');
      state.conversations = (r && r.ok && r.items) ? r.items : [];
    } catch (err) {
      console.warn('[wc] conversations:', err && err.message);
      toast('Could not load your chats', { error: true });
      state.conversations = [];
    }
    WcSidebar.setItems(state.conversations, state.conversationId);
    syncTitle();

    // Names for the unnamed arrive after the list is already on screen — see
    // the two-pass note in wc-history.js. Not awaited: the sidebar is usable
    // the moment the cheap pass lands, and waiting for the names would put the
    // whole list behind them.
    WcBus.call('WC_FILL_PREVIEWS', { items: state.conversations })
      .catch((err) => console.warn('[wc] previews:', err && err.message));
  }

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

  async function openConversation(id) {
    if (WcThread.isStreaming()) {
      // Leaving a conversation mid-answer would orphan the stream — the tokens
      // keep arriving for a turn that is no longer on screen, and the account
      // is charged for them either way.
      const ok = await WcUI.confirm('The answer is still being written',
        'Opening another chat will cut it off.', { okText: 'Open', danger: true });
      if (!ok) return;
      stopStream();
    }
    let r;
    try {
      r = await WcBus.call('WC_LOAD_CONVERSATION', { id });
    } catch (err) {
      toast('Could not open the chat: ' + (err && err.message), { error: true });
      return;
    }
    if (!r || !r.ok) { toast('The chat did not open', { error: true }); return; }
    state.conversationId = id;
    WcThread.renderTurns(r.turns);
    WcSidebar.setActive(id);
    WcSidebar.close();
    syncTitle();
    syncAttachment();
  }

  function newConversation() {
    if (WcThread.isStreaming()) stopStream();
    state.conversationId = null;
    WcThread.clear();
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
    const images = WcAttach.take();
    // Слова, выбранные нажатием в ленте, забираются ЗДЕСЬ — в единственный
    // момент, когда набор перестаёт быть состоянием и становится репликой.
    // Наружу выходят две разные строки: `visible` — то, что человек увидит в
    // своём пузыре (слова плюс дописанное), `sent` — то же самое со скрытой
    // частью впереди (отрывок вокруг каждого слова, форма общая с расширением
    // — LexWordPick.sendPrefix). Набор при этом опустошается: иначе он уехал
    // бы вторым экземпляром со следующей репликой.
    const turn = global.WcWordPick
      ? WcWordPick.takeTurn(text)
      : { visible: String(text || '').trim(), sent: String(text || '').trim() };
    if (!turn.visible && !images.length) return;
    // 'native' or nothing. The mode rides with the turn rather than living as
    // page state: it is chosen per message (by which button was pressed), not
    // switched on and left on.
    const mode = (opts && opts.mode) || null;
    // Какой ЗАГОТОВКОЙ. Кнопка одна, заготовок много (lex-action-presets.js):
    // слот едет с ходом, а не читается на месте, — человек мог выбрать другую
    // между нажатием и отправкой, а промпт, модель и ветка переписки обязаны
    // относиться к той, чьё имя он видел на кнопке.
    const slotId = (opts && opts.slotId) || null;

    // The preview URL made for the strip is handed to the bubble rather than
    // revoked and remade: it points at the same Blob, and revoking it here
    // would blank the picture the reader just sent.
    WcThread.appendUser(turn.visible, images.map((i) => i.previewUrl).filter(Boolean), { action: !!mode });
    WcComposer.refresh();

    const requestId = nextRequestId();
    state.requestId = requestId;
    WcThread.beginAssistant(requestId, { action: !!mode });
    WcComposer.setStreaming(true, requestId);

    try {
      const r = await WcBus.call('WC_SEND', {
        requestId,
        conversationId: state.conversationId,
        // Со скрытой частью — учителю нужен отрывок, в котором стоят выбранные
        // слова. Она же ложится в беседу: повтор хода и следующие реплики
        // обязаны видеть ровно то, что видела модель. В ленте её не показывает
        // ни живой пузырь, ни перечитывание (WcWordPick.visibleText).
        text: turn.sent,
        images,
        mode,
        slotId,
      });
      // The first message is what mints the key. Adopt it so the next message
      // in this conversation lands in the same thread.
      if (r && r.conversationId && !state.conversationId) {
        state.conversationId = r.conversationId;
        WcSidebar.setActive(r.conversationId);
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
    try {
      att = await WcBus.call('WC_ATTACHMENT', { id: want });
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

  // ── «Заново» и «изменить» ────────────────────────────────────────────────
  async function regenerate() {
    if (WcThread.isStreaming()) return;
    const requestId = nextRequestId();
    // Пузырь очищается ДО запроса: между нажатием и первым словом проходит
    // секунда-другая, и всё это время старый ответ на экране означал бы, что
    // нажатие не сработало.
    if (!WcThread.beginRetry(requestId)) return;
    state.requestId = requestId;
    WcComposer.setStreaming(true, requestId);
    WcHaptics.tap();
    try {
      await WcBus.call('WC_REGENERATE', { requestId });
    } catch (err) {
      WcBus.broadcast({ type: 'STREAM_ERROR', requestId, error: String((err && err.message) || err) });
    }
  }

  // «Изменить» кладёт вопрос обратно в поле. Свой ход при этом НЕ удаляется:
  // человек ещё не решил отправлять, а исчезнувшее сообщение при передумывании
  // не вернуть. Отправка обычная — она добавит новый ход.
  function editTurn(text) {
    WcComposer.setText(text || '');
    WcComposer.focus();
  }

  function stopStream() {
    if (!state.requestId) return;
    WcBus.call('WC_STOP', { requestId: state.requestId })
      .catch((err) => console.warn('[wc] stop:', err && err.message));
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

  async function deleteConversation(id) {
    try {
      const r = await WcBus.call('WC_DELETE_CONVERSATION', { id });
      if (!r || !r.ok) throw new Error((r && r.error) || 'refused');
    } catch (err) {
      toast('Could not delete: ' + (err && err.message), { error: true });
      return;
    }
    if (state.conversationId === id) newConversation();
    await refreshConversations();
  }

  // ── Voice ─────────────────────────────────────────────────────────────────
  // The mic button is a toggle over one live session. Everything the reader
  // hears and says lands in the same thread as typing, through the same
  // bubbles — a spoken conversation is a conversation, not a separate mode
  // with its own transcript window.
  function openVoiceScreen() {
    WcVoiceScreen.open({
      onToggleMute: () => { WcVoice.mute(!WcVoice.muted()); WcVoiceScreen.muted(WcVoice.muted()); },
      // «Держи и говори»: дорожка открыта ровно пока палец на кнопке.
      onHoldStart: () => { WcVoice.mute(false); WcVoiceScreen.muted(false); WcHaptics.tap(); },
      onHoldEnd: () => { WcVoice.mute(true); WcVoiceScreen.muted(true); },
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

  async function toggleVoice(opts) {
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
        WcVoiceScreen.close();
        WcComposer.setVoiceActive(false);
        WcHeader.setVoiceActive(false);
        toast('Could not start the conversation: ' + (err && err.message), { error: true });
        return;
      }
    }

    // What has been said so far, KEYED BY item_id and in the order the server
    // opened the items — a Map keeps insertion order, which is what makes the
    // saved transcript match what was on screen.
    //
    // WHY A FLUSH AND NOT JUST "SAVE ON response.done". Hanging up right after
    // the teacher finishes speaking is the NORMAL way to end a voice
    // conversation, and response.done arrives after the last audio — so saving
    // only there loses the final exchange every time somebody stops when they
    // are done. Measured, not guessed: a session whose money the server had
    // already billed ($0.0176 in balance_ledger) left zero turns in the
    // conversation. The extension has a settle window for the same reason.
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
        turns.push({ role: v.role, text: v.text });
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
        console.warn('[wc] voice turn not saved:', err && err.message);
        flushed.forEach((k) => { const v = said.get(k); if (v) v.saved = false; });
      }
    }

    try {
      await WcVoice.start({
        conversationId: convId,
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

          // response.done — весь ход завершён, можно записывать.
          onTurnDone: () => flushExchange(),

          // Toasted directly — same path as every other voice-start failure
          // in this function — rather than through WcVoiceScreen.status(),
          // which is now a no-op: the call screen no longer has a status
          // line to write an error into (2026-08-19, the call screen looks
          // like the ordinary chat now).
          onError: (msg) => toast('Error: ' + msg, { error: true }),
          onDisconnected: async ({ reason, turns }) => {
            // ЭКРАН УХОДИТ ПЕРВЫМ, до записи в историю. Раньше здесь сначала
            // ждали flushExchange() — сетевой заход, — и всё это время крестик
            // выглядел ненажатым: человек жал, ничего не происходило, он жал
            // ещё раз. Порядок обратный: сначала снимается разговорный вид,
            // потом дописывается то, что не успело записаться. На бухгалтерию
            // это не влияет — деньги считает серверный слушатель, а не эта
            // функция, и await ниже по-прежнему держит вызывающего.
            WcVoiceScreen.close();
            WcComposer.setVoiceActive(false);
            WcHeader.setVoiceActive(false);
            WcThread.endVoice();
            await flushExchange();
            if (reason && reason !== 'manual') toast('Conversation ended: ' + reason);
            // The debit is made by the server-side listener after the call
            // closes, so ask for the balance twice, like a text turn does.
            refreshAccount();
            setTimeout(refreshAccount, 3000);
            if (turns) refreshConversations();
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
      if (c !== lastBottom) { lastBottom = c; root.style.setProperty('--wc-composer-h', c + 'px'); }
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
  }

  function wireGate() {
    const email = () => document.getElementById('wc-email').value.trim();
    const password = () => document.getElementById('wc-password').value;

    async function attempt(label, fn) {
      if (!email() || !password()) { gateStatus('Enter your email and password.', true); return; }
      gateStatus(label);
      try {
        await fn(email(), password());
        await enterApp();
      } catch (err) {
        gateStatus(gateErrorText(err), true);
      }
    }

    document.getElementById('wc-gate-form').addEventListener('submit', (e) => {
      e.preventDefault();
      attempt('Signing in…', (a, b) => WcAuth.signIn(a, b));
    });
    document.getElementById('wc-signup').addEventListener('click', () =>
      attempt('Creating your account…', (a, b) => WcAuth.signUp(a, b)));
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
  }

  // ── Boot ──────────────────────────────────────────────────────────────────

  async function enterApp() {
    document.getElementById('wc-gate').hidden = true;
    gateStatus('');

    // The curated defaults the owner publishes from the extension — models,
    // prompts, knobs. Adopted BEFORE the first question can be asked, so a turn
    // never goes out on a default this page was about to replace.
    try {
      await WcBackend.adoptPublished();
    } catch (err) {
      console.warn('[wc] published settings:', err && err.message);
    }
    // Список ЗАГОТОВОК ДЕЙСТВИЙ — здесь же и по той же причине, что настройки
    // выше: каталог промптов отвечает только по токену, а на сборке композера
    // токена ещё нет. Не ждём — кнопка живая и с одной заготовкой, а подпись и
    // меню доедут сами.
    WcComposer.loadPresets();

    document.getElementById('wc-root').hidden = false;
    // Скелет держится, пока не приехали баланс и список бесед: заставка
    // оболочки снимается по нему, и снять её раньше значит показать наполовину
    // собранный экран — ровно то, от чего уходим.
    //
    // `finally`, а не просто по порядку: не доехало — всё равно показываем, что
    // есть. Запертый навсегда скелет хуже неполного экрана.
    try {
      await Promise.all([refreshAccount(), refreshConversations()]);
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
    }
  }

  async function boot() {
    await WcSettings.applyStored();

    WcThread.init({
      onRetry: regenerate,
      onEdit: editTurn,
    });
    // Клик по словам в ленте. Поднимается ДО первой отрисовки беседы: иначе
    // первые пузыри пришли бы без исходника на узле и включить режим на них
    // было бы нечем. Значение переключателя — из настроек этой поверхности
    // (WcStore, своё в браузере, на Маке и на телефоне); подписка нужна для
    // второй вкладки того же браузера, где переключатель могли тронуть.
    WcWordPick.init({ onChipsChanged: () => WcComposer.refresh() });
    WcWordPick.setEnabled(await WcStore.one(WcWordPick.STORAGE_KEY, false));
    WcStore.subscribe((changes) => {
      if (!changes || !changes[WcWordPick.STORAGE_KEY]) return;
      WcWordPick.setEnabled(changes[WcWordPick.STORAGE_KEY].newValue === true);
    });
    WcAttach.init();
    WcSidebar.init({
      onOpen: openConversation,
      onNew: newConversation,
      onRename: renameConversation,
      onDelete: deleteConversation,
      onToggle: onSidebarToggle,
    });
    await WcComposer.init({
      onSend: send,
      onStop: stopStream,
      onVoice: (o) => toggleVoice(o),
      onAttach: () => WcAttach.pick(),
      // Первый пункт меню «+»: к чему привязана беседа. Читается синхронно —
      // значение уже лежит наготове (syncAttachment выше).
      attachedPage: () => attachedPage,
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
      if (msg.type === 'STREAM_DONE' || msg.type === 'STREAM_ERROR') {
        if (msg.requestId === state.requestId) {
          state.requestId = null;
          WcComposer.setStreaming(false);
        }
        if (msg.type === 'STREAM_DONE') refreshAccount();
      } else if (msg.type === 'WC_PREVIEWS_FILLED') {
        state.conversations = msg.items;
        WcSidebar.setItems(state.conversations, state.conversationId);
      } else if (msg.type === 'WC_CONVERSATIONS_CHANGED') {
        refreshConversations();
      } else if (msg.type === 'WC_BALANCE_CHANGED') {
        refreshAccount();
      }
    });

    wireGate();

    if (WcBackend.stubbed) {
      WcComposer.note('Stubbed build — there is no real teacher behind these answers.');
    }

    // A Google redirect comes back with the tokens in the URL fragment; take
    // them before anything asks whether we are signed in.
    WcAuth.adoptRedirectSession();

    const token = await WcAuth.validToken();
    if (!token) { showGate(); return; }
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
