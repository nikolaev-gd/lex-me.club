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
      toast('Не удалось прочитать список бесед', { error: true });
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
      const ok = await WcUI.confirm('Ответ ещё пишется',
        'Если открыть другую беседу, этот ответ оборвётся.', { okText: 'Открыть', danger: true });
      if (!ok) return;
      stopStream();
    }
    let r;
    try {
      r = await WcBus.call('WC_LOAD_CONVERSATION', { id });
    } catch (err) {
      toast('Не удалось открыть беседу: ' + (err && err.message), { error: true });
      return;
    }
    if (!r || !r.ok) { toast('Беседа не открылась', { error: true }); return; }
    state.conversationId = id;
    WcThread.renderTurns(r.turns);
    WcSidebar.setActive(id);
    WcSidebar.closeOnNarrow();
    syncTitle();
    WcComposer.focus();
  }

  function newConversation() {
    if (WcThread.isStreaming()) stopStream();
    state.conversationId = null;
    WcThread.clear();
    WcSidebar.setActive(null);
    WcHeader.setTitle('');
    WcBus.call('WC_NEW_CONVERSATION').catch((err) => console.warn('[wc] new:', err && err.message));
    WcComposer.focus();
  }

  async function send(text) {
    const images = WcAttach.take();
    if (!text && !images.length) return;

    // The preview URL made for the strip is handed to the bubble rather than
    // revoked and remade: it points at the same Blob, and revoking it here
    // would blank the picture the reader just sent.
    WcThread.appendUser(text, images.map((i) => i.previewUrl).filter(Boolean));
    WcComposer.refresh();

    const requestId = nextRequestId();
    state.requestId = requestId;
    WcThread.beginAssistant(requestId);
    WcComposer.setStreaming(true, requestId);

    try {
      const r = await WcBus.call('WC_SEND', {
        requestId,
        conversationId: state.conversationId,
        text,
        images,
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

  function stopStream() {
    if (!state.requestId) return;
    WcBus.call('WC_STOP', { requestId: state.requestId })
      .catch((err) => console.warn('[wc] stop:', err && err.message));
  }

  async function renameConversation(id, title) {
    try {
      const r = await WcBus.call('WC_RENAME_CONVERSATION', { id, title });
      if (!r || !r.ok) throw new Error((r && r.error) || 'отказ');
    } catch (err) {
      toast('Не удалось переименовать: ' + (err && err.message), { error: true });
    }
    await refreshConversations();
  }

  async function deleteConversation(id) {
    try {
      const r = await WcBus.call('WC_DELETE_CONVERSATION', { id });
      if (!r || !r.ok) throw new Error((r && r.error) || 'отказ');
    } catch (err) {
      toast('Не удалось удалить: ' + (err && err.message), { error: true });
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
      onEnd: () => WcVoice.stop({ reason: 'manual' }),
      // Свернуть — это НЕ положить трубку. Разговор продолжается, экран
      // уходит, значок микрофона в поле ввода остаётся зажжённым и возвращает
      // обратно. Так у эталонов, и так человек может свериться с перепиской,
      // не обрывая учителя на полуслове.
      onCollapse: () => WcVoiceScreen.close(),
    });
    WcVoiceScreen.muted(WcVoice.muted());
    WcVoiceScreen.micHeld(WcVoice.micHeld());
  }

  async function toggleVoice() {
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
    WcComposer.setVoiceActive(true);

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
        toast('Не удалось начать разговор: ' + (err && err.message), { error: true });
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
        console.warn('[wc] не записал голосовой ход:', err && err.message);
        flushed.forEach((k) => { const v = said.get(k); if (v) v.saved = false; });
      }
    }

    try {
      await WcVoice.start({
        conversationId: convId,
        hooks: {
          onStage: (s) => WcVoiceScreen.stage(s),
          onConnected: () => WcVoiceScreen.stage('ready'),
          onRemoteStream: (s) => WcVoiceScreen.meterRemote(s),
          onLocalStream: (s) => WcVoiceScreen.meterLocal(s),
          onMicHeld: (held) => WcVoiceScreen.micHeld(held),
          onTeacherSpeaking: (on) => {
            WcVoiceScreen.speaking(on);
            if (!on && !WcVoice.micHeld()) WcVoiceScreen.status('Слушаю. Говорите.');
          },

          onUserStart: (id) => WcThread.beginVoiceUser(id),
          onUserDelta: (id, t) => { note(id, 'user', t); WcThread.voiceUserText(id, t); WcVoiceScreen.line('user', t); },
          onUserDone: (id, t) => { note(id, 'user', t); WcThread.voiceUserText(id, t); WcVoiceScreen.line('user', t); },
          onUserFailed: (id) => { said.delete(id); WcThread.dropVoiceUser(id); },

          onAssistantDelta: (id, t) => { note(id, 'assistant', t); WcThread.voiceAssistantText(id, t); WcVoiceScreen.line('assistant', t); },
          onAssistantDone: (id, t) => { note(id, 'assistant', t); WcThread.voiceAssistantText(id, t); WcVoiceScreen.line('assistant', t); },

          // response.done — весь ход завершён, можно записывать.
          onTurnDone: () => flushExchange(),

          onError: (msg) => WcVoiceScreen.status('Ошибка: ' + msg),
          onDisconnected: async ({ reason, turns }) => {
            // Whatever arrived and was not yet written down goes now, and the
            // caller waits for it. The account was charged for it either way.
            await flushExchange();
            WcVoiceScreen.close();
            WcComposer.setVoiceActive(false);
            WcThread.endVoice();
            if (reason && reason !== 'manual') toast('Разговор завершён: ' + reason);
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
      toast(String((err && err.message) || err), { error: true });
    }
  }

  function openSettings() {
    return WcSettings.open({
      account: state.account,
      onTopUp: () => WcTopup.open({ onPaid: refreshAccount }),
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
    const apply = () => {
      raf = 0;
      const h = Math.round(vv.height);
      const offset = Math.round(vv.offsetTop);
      if (h !== lastH) {
        lastH = h;
        document.documentElement.style.setProperty('--wc-vh', h + 'px');
        // A keyboard is "open" when the visual viewport is meaningfully shorter
        // than the window. 120px of slack keeps the browser's own collapsing
        // toolbars from counting as one.
        root.classList.toggle('is-keyboard', (global.innerHeight - h) > 120);
      }
      if (offset !== lastOffset) {
        lastOffset = offset;
        // Pin the shell to the visible rectangle rather than to the document.
        document.body.style.transform = offset ? `translateY(${offset}px)` : '';
      }
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(apply); };
    vv.addEventListener('resize', schedule);
    vv.addEventListener('scroll', schedule);
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
    const apply = () => {
      root.classList.toggle('is-narrow', mq.matches);
      // The sidebar starts closed on a phone and open on a desktop, because on
      // a phone it covers the thread it is supposed to be a way into.
      if (mq.matches) root.classList.add('is-sidebar-collapsed');
      else {
        root.classList.remove('is-sidebar-collapsed');
        document.getElementById('wc-scrim').hidden = true;
      }
    };
    apply();
    mq.addEventListener('change', apply);
  }

  // ── The gate ──────────────────────────────────────────────────────────────
  // A plain form on our own page. The extension wraps the same form in a nested
  // chrome-extension:// iframe purely because it renders over an arbitrary
  // site; here the page is ours and there is nobody to isolate the password
  // from.
  const GATE_ERRORS = {
    EMAIL_TAKEN: 'Этот адрес уже занят — войдите.',
    RATE_LIMITED: 'Слишком много попыток. Попробуйте через минуту.',
  };

  function gateStatus(text, isError) {
    const el = document.getElementById('wc-gate-status');
    el.textContent = text || '';
    el.classList.toggle('is-error', !!isError);
  }

  // Скелет первой загрузки снимается ровно тогда, когда решено, ЧТО показать —
  // форму входа или приложение. Раньше в этот промежуток был белый экран.
  function hideBoot() {
    const b = document.getElementById('wc-boot');
    if (b) b.hidden = true;
  }

  function showGate() {
    hideBoot();
    document.getElementById('wc-gate').hidden = false;
    document.getElementById('wc-root').hidden = true;
  }

  function wireGate() {
    const email = () => document.getElementById('wc-email').value.trim();
    const password = () => document.getElementById('wc-password').value;

    async function attempt(label, fn) {
      if (!email() || !password()) { gateStatus('Введите почту и пароль.', true); return; }
      gateStatus(label);
      try {
        await fn(email(), password());
        await enterApp();
      } catch (err) {
        gateStatus(GATE_ERRORS[err.message] || ('Не вышло: ' + err.message), true);
      }
    }

    document.getElementById('wc-gate-form').addEventListener('submit', (e) => {
      e.preventDefault();
      attempt('Вход…', (a, b) => WcAuth.signIn(a, b));
    });
    document.getElementById('wc-signup').addEventListener('click', () =>
      attempt('Создаём аккаунт…', (a, b) => WcAuth.signUp(a, b)));
    // В браузере это уход по адресу и сюда управление уже не вернётся. В
    // приложении открывается системный лист входа, и вернуться он обязан —
    // в том числе когда человек нажал «Отмена».
    document.getElementById('wc-google').addEventListener('click', async () => {
      const btn = document.getElementById('wc-google');
      btn.disabled = true;
      gateStatus('Переходим к Google…');
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
      gateStatus('Вход через Google не прошёл: ' + (r.error || 'неизвестно'), true);
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

    document.getElementById('wc-root').hidden = false;
    hideBoot();
    await Promise.all([refreshAccount(), refreshConversations()]);
    WcComposer.focus();
  }

  async function boot() {
    await WcSettings.applyStored();

    WcThread.init();
    WcAttach.init();
    WcSidebar.init({
      onOpen: openConversation,
      onNew: newConversation,
      onRename: renameConversation,
      onDelete: deleteConversation,
    });
    WcComposer.init({
      onSend: send,
      onStop: stopStream,
      onVoice: () => toggleVoice(),
      onAttach: () => WcAttach.pick(),
    });
    // Один вход в аккаунт на весь интерфейс — строка внизу шторки. Пополнение
    // и выход живут внутри листа настроек, а не рядом с ним: это и были дубли.
    WcHeader.init({
      onSettings: openSettings,
    });

    watchWidth();
    watchKeyboard();

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
      WcComposer.note('Шаг 1: каркас на заглушках — настоящего учителя за этим ответом нет.');
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
      gateStatus('Не удалось запустить: ' + (err && err.message), true);
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
    stopStream,
    toggleVoice,
  };
})(typeof self !== 'undefined' ? self : globalThis);
