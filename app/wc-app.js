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
    syncPageBar();
    WcComposer.focus();
  }

  function newConversation() {
    if (WcThread.isStreaming()) stopStream();
    state.conversationId = null;
    WcThread.clear();
    WcSidebar.setActive(null);
    WcHeader.setTitle('');
    syncPageBar();
    WcBus.call('WC_NEW_CONVERSATION').catch((err) => console.warn('[wc] new:', err && err.message));
    WcComposer.focus();
  }

  async function send(text, opts) {
    const images = WcAttach.take();
    if (!text && !images.length) return;
    // 'native' or nothing. The mode rides with the turn rather than living as
    // page state: it is chosen per message (by which button was pressed), not
    // switched on and left on.
    const mode = (opts && opts.mode) || null;

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
        mode,
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
  // Полоска над полем: беседа, начатую в расширении со страницы или с видео,
  // на телефоне должно быть видно, к чему она привязана. Только на чтение —
  // ни прикрепить, ни открепить отсюда нельзя.
  //
  // Гонка, которую здесь легко проглядеть: чтение идёт по сети, а человек
  // успевает переключить беседу. Ответ, пришедший не для текущей, молча
  // выбрасывается — иначе полоска показывала бы страницу предыдущей.
  let pageBarFor = null;
  async function syncPageBar() {
    const bar = document.getElementById('wc-pagebar');
    const label = document.getElementById('wc-pagebar-label');
    if (!bar) return;
    const want = state.conversationId;
    pageBarFor = want;
    if (!want) { bar.hidden = true; return; }
    let att = null;
    try {
      att = await WcBus.call('WC_ATTACHMENT', { id: want });
    } catch (err) {
      console.warn('[wc] attachment:', err && err.message);
    }
    if (pageBarFor !== want) return;
    if (!att || !att.url) { bar.hidden = true; return; }
    bar.href = att.url;
    label.textContent = att.title || att.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 80);
    bar.title = att.kind === 'video' ? 'Open the video' : 'Open the page';
    bar.hidden = false;
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
          onStage: (s) => WcVoiceScreen.stage(s),
          onConnected: () => {
            WcVoiceScreen.stage('ready');
            // Closed until held. Done on connect rather than before start:
            // there is no track to mute until the session exists.
            if (ptt) { WcVoice.mute(true); WcVoiceScreen.muted(true); }
          },
          onRemoteStream: (s) => WcVoiceScreen.meterRemote(s),
          onLocalStream: (s) => WcVoiceScreen.meterLocal(s),
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
  const GATE_ERRORS = {
    EMAIL_TAKEN: 'That address is already taken — sign in instead.',
    RATE_LIMITED: 'Too many attempts. Try again in a minute.',
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
    shellPageReady();
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
  function shellPageReady() {
    try {
      const h = global.webkit && global.webkit.messageHandlers && global.webkit.messageHandlers.lexshell;
      if (h && typeof h.postMessage === 'function') h.postMessage('ready');
    } catch (_) { /* в браузере моста нет — и не надо */ }
  }

  // Окно на Маке живёт дольше страницы: его прячут и показывают, а страница всё
  // это время загружена. Значит «человек открыл окно» приходит снаружи — этим
  // вызовом, из `AppDelegate.show()`. На iPhone его нет: там открытие окна и
  // есть запуск приложения.
  global.__lexFocusComposer = function () {
    try { WcComposer.focus({ raiseKeyboard: true }); } catch (_) { /* noop */ }
  };

  function showGate() {
    hideBoot();
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
        gateStatus(GATE_ERRORS[err.message] || ('Did not work: ' + err.message), true);
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
      // Курсор ДО снятия заставки, а не после: на телефоне фокус поднимает
      // клавиатуру, и человек, увидевший экран раньше неё, увидел бы, как чат
      // подпрыгивает. Под заставкой это происходит невидимо, и открывается
      // сразу конечное состояние — поле, палочка, клавиатура.
      WcComposer.focus({ raiseKeyboard: true });
      hideBoot();
    }
  }

  async function boot() {
    await WcSettings.applyStored();

    WcThread.init({
      onRetry: regenerate,
      onEdit: editTurn,
    });
    WcAttach.init();
    WcSidebar.init({
      onOpen: openConversation,
      onNew: newConversation,
      onRename: renameConversation,
      onDelete: deleteConversation,
    });
    await WcComposer.init({
      onSend: send,
      onStop: stopStream,
      onVoice: (o) => toggleVoice(o),
      onAttach: () => WcAttach.pick(),
    });
    // Один вход в аккаунт на весь интерфейс — строка внизу шторки. Пополнение
    // и выход живут внутри листа настроек, а не рядом с ним: это и были дубли.
    WcHeader.init({
      onSettings: openSettings,
      // Пополнение теперь ровно ОДНО место — своя кнопка в подвале шторки.
      // Из листа настроек оно убрано (wc-settings.js): два входа в одно и то
      // же и были тем дублем, ради снятия которого подвал когда-то свели в
      // одну строку.
      onTopUp: () => WcTopup.open({ onPaid: refreshAccount }),
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
