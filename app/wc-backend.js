// webchat/wc-backend.js — what background.js is to the extension.
//
// It answers the interface's questions and pushes the token stream back. On
// this surface both happen in the same document, so there is no worker to fall
// asleep, no port to close and no Blob turning into {} on the way across. The
// one thing the extension gets for free and this does not: close the tab and
// the answer stops. The account is still charged for what the provider already
// produced, which is why a partial answer is kept rather than discarded.
//
// ── The message contract ─────────────────────────────────────────────────────
// Asked (WcBus.call):
//   WC_ACCOUNT_STATE      → {signedIn, email, balanceUsd, status}
//   WC_LIST_CONVERSATIONS → {ok, items:[{id, title, updatedAt, preview}]}
//   WC_LOAD_CONVERSATION  {id} → {ok, turns:[{role, text, uid, images}]}
//   WC_RENAME_CONVERSATION{id, title} → {ok}
//   WC_DELETE_CONVERSATION{id} → {ok}
//   WC_SEND               {requestId, conversationId, text, images} → {ok, conversationId}
//   WC_STOP               {requestId} → {ok}
//   WC_MODELS             → {items, activeId}
//   WC_TOPUP / WC_SIGN_OUT → {ok}
//
// Pushed (WcBus.broadcast). The STREAM_* names are NOT ours to choose: they are
// what lex-teacher-core.js emits, and the core is shared with the extension
// byte for byte.
//   STREAM_CHUNK {requestId, text, _debug_model?}
//   STREAM_DONE  {requestId, inputTokens, outputTokens, inputCost, outputCost, …}
//   STREAM_ERROR {requestId, error}
//   WC_BALANCE_CHANGED / WC_CONVERSATIONS_CHANGED
(function (global) {
  'use strict';

  const TAG = '[wc]';
  const A = global.LexWebAuth;

  // The core's session helpers require a NUMBER as the stream target
  // (resolveCallSessionId returns null for anything else, and llm-proxy then
  // refuses the call as 'no_session'). There is one conversation open per page,
  // so one id is enough — and keeping it a number keeps the core untouched.
  const CONNECTION_ID = 1;

  // The settings bucket. The same one the extension's main chat uses: one
  // account must not answer with a different model depending on which surface
  // it was asked from.
  const SCOPE = 'shorts-main';

  // ── Wiring the teacher ────────────────────────────────────────────────────
  const inflightStreams = new Map();
  const lastClickByTab = new Map();
  let wordClickSeq = 0;

  // The conversation the page is currently talking in. Held here rather than in
  // the interface because the core asks for it through a callback, at a moment
  // the interface is not on the stack.
  let sessionId = null;
  let sessionInFlight = null;

  function ensureSession() {
    if (sessionId != null) return Promise.resolve(sessionId);
    if (!sessionInFlight) {
      sessionInFlight = WcHistory.createSession()
        .then((id) => { sessionId = id; return id; })
        .finally(() => { sessionInFlight = null; });
    }
    return sessionInFlight;
  }

  // Requests the reader stopped on purpose.
  //
  // WHY THIS EXISTS. Stopping aborts the fetch, and the core cannot tell an
  // abort the reader asked for from a connection that died: it turns both into
  // STREAM_ERROR carrying whatever the platform said. So pressing "stop" put a
  // red bubble reading "BodyStreamBuffer was aborted" under a perfectly good
  // half-answer — the product reporting a crash for something the reader chose.
  //
  // The intent is known HERE, one line before the abort, and nowhere else. So
  // it is recorded here and the outgoing failure is translated back into a
  // normal ending on the way out.
  const stoppedByUser = new Set();

  const core = LexTeacherCore.create({
    TAG,
    // No translation layer on this surface yet: the core only calls LXT for a
    // handful of error strings, and they are shown as-is.
    LXT: (key) => key,
    // The stream goes straight into the page — with one translation on the way.
    emit: (_target, msg) => {
      if (msg && msg.type === 'STREAM_ERROR' && stoppedByUser.has(msg.requestId)) {
        stoppedByUser.delete(msg.requestId);
        // Everything that had arrived stays on screen: the provider produced
        // those tokens and the account was billed for them either way (the
        // server does not propagate the abort — it reads the answer to the end
        // and charges the real total).
        WcBus.broadcast({ type: 'STREAM_DONE', requestId: msg.requestId, stopped: true });
        return;
      }
      if (msg && (msg.type === 'STREAM_DONE' || msg.type === 'STREAM_ERROR')) {
        stoppedByUser.delete(msg.requestId);
      }
      WcBus.broadcast(msg);
    },
    // Nothing to keep alive: a page is not evicted mid-answer the way an MV3
    // worker is.
    keepAlive: () => {},
    hasSecrets: () => true,
    inflightStreams,
    lastClickByTab,
    // Provider keys are NOT in this bundle and must never be. Every text call
    // goes through llm-proxy, so these are never read; if a future change
    // routed around the proxy the provider would answer 401 — loud, and far
    // better than shipping live keys to a public page.
    ANTHROPIC_API_KEY: '',
    GOOGLE_API_KEY: '',
    DEFAULT_API_KEY: '',
    getApiKey: () => Promise.resolve(''),
    lexSbUrl: () => A.supabaseUrl(),
    lexAnonKey: () => A.anonKey(),
    OPENAI_URL: 'https://api.openai.com/v1/chat/completions',
    OPENAI_RESPONSES_URL: 'https://api.openai.com/v1/responses',
    OPENAI_CONVERSATIONS_URL: 'https://api.openai.com/v1/conversations',
    ANTHROPIC_URL: 'https://api.anthropic.com/v1/messages',
    GOOGLE_URL_TMPL: 'https://generativelanguage.googleapis.com/v1beta/models/',
    GOOGLE_INTERACTIONS_URL: 'https://generativelanguage.googleapis.com/v1beta/interactions',
    MODEL_REGISTRY: global.LexModelRegistry.modelRegistry,
    authValidToken: () => A.validToken(),
    getActiveChatPrompt: async () => {
      // The text lives in the server prompt catalogue and is injected by
      // llm-proxy; the local cell only holds the slot pointer. Same read the
      // worker does, so both surfaces name the same slot.
      const r = await WcStore.get(['chatPrompts', 'activeChatPromptId']);
      const id = r.activeChatPromptId || 'chatB1';
      const cell = r.chatPrompts || {};
      return { id, promptId: id, text: (cell[id] && cell[id].text) || '' };
    },
    upsertPrompt: async () => null,
    // Word-click telemetry is an IndexedDB store in the worker that nothing on
    // this surface reads. The id still has to be unique and non-null: it ties a
    // bubble to its answer.
    addWordClick: async () => (++wordClickSeq),
    updateWordClick: async () => {},
    // public.calls is the extension's own analytics. MONEY IS UNAFFECTED — the
    // debit happens inside llm-proxy, not here — only the analytics row is
    // missing. Listed as an open tail rather than faked.
    recordAnyCall: async () => null,
    logTextCallRequest: () => null,
    logTextCallResponse: () => {},
    buildIoResponse: () => null,
    computeCost: (...args) => (global.LexModelRegistry.computeCost
      ? global.LexModelRegistry.computeCost(...args) : null),
    extractEffectiveCallParams: () => ({}),
    lexNotifyBalanceMaybeChanged: () => {
      // The debit commits in the edge function's waitUntil, a fraction of a
      // second AFTER the response stream closes — so asking once, immediately,
      // reads the old number. Same two delays the worker uses, for the same
      // reason.
      setTimeout(() => WcBus.broadcast({ type: 'WC_BALANCE_CHANGED' }), 1200);
      setTimeout(() => WcBus.broadcast({ type: 'WC_BALANCE_CHANGED' }), 3500);
    },
    // There is no YouTube on this surface, so there is only one kind of content
    // a conversation can be about.
    resolvePageType: (declared) => {
      const T = global.LexPageType;
      const TEXT = T ? T.TEXT : 'text';
      return declared === TEXT ? declared : TEXT;
    },
    logContextTrace: (meta, body) => {
      if (global.lexDebug && global.lexDebug.enabled) console.log(TAG, 'context', meta, body);
    },
    resolveCallSessionId: (tabId, surface) => (
      typeof tabId !== 'number' ? null : (surface === 'standalone' ? sessionId : null)
    ),
    ensureSessionForTab: async () => null,
    ensureStandaloneSessionForTab: async () => ensureSession(),
    forgetSessionId: () => {},
    forgetStandaloneSessionId: () => { sessionId = null; },
    extractRealVideoId: (vid) => {
      const s = String(vid || '');
      const i = s.indexOf('__');
      return i > 0 ? s.slice(0, i) : s;
    },
  });

  // ── Knobs ─────────────────────────────────────────────────────────────────
  // Every knob is its OWN key, named knob<Name>_<scope> — there is no `knobs`
  // object anywhere. Reading one would return {} forever, which is what this
  // code did until the published set was actually inspected: temperature,
  // token ceiling and verbosity were silently never applied.
  //
  // The names and the shape below are the extension's (chat-knobs.js
  // getChatKnobs), because the receiving end is the same shared core.
  const KNOB_KEYS = [
    'knobTemperature', 'knobMaxTokens', 'knobSeed', 'knobVerbosity', 'knobServiceTier',
    'knobVoiceSpeed', 'knobVoiceMaxResponseTokens', 'knobVoiceNoiseReduction',
    'knobVoiceVadThreshold', 'knobVoicePrefixPaddingMs', 'knobVoiceSilenceDurationMs',
    'knobVoiceEndSensitivity', 'knobVoiceInterruptResponse', 'knobVoiceIdleTimeoutSec',
    'knobVoiceIdleDisconnectSec', 'knobVoiceLongSessions', 'knobVoiceOutputLanguage',
    'knobVoiceTranscriptionModel', 'knobVoiceTranscriptionLanguage', 'knobVoiceTranscriptionPrompt',
    'knobVoiceReasoningEffort', 'knobVoiceThinkingLevel',
  ];

  const scoped = (k) => k + '_' + SCOPE;

  async function readKnobs() {
    const wanted = KNOB_KEYS.map(scoped).concat(['voiceNamesByProvider_' + SCOPE, 'activeVoiceModelId_' + SCOPE]);
    const res = await WcStore.get(wanted);
    const tk = (k) => res[scoped(k)];
    // The voice name is not a knob but a map keyed by provider: one account
    // can prefer a different voice on each, and a flat value would overwrite
    // the other provider's choice on every switch.
    const voiceMap = res['voiceNamesByProvider_' + SCOPE] || {};
    return {
      temperature: tk('knobTemperature'),
      maxTokens: tk('knobMaxTokens'),
      seed: tk('knobSeed'),
      verbosity: tk('knobVerbosity'),
      serviceTier: tk('knobServiceTier'),
      voiceName: voiceMap.openai || 'marin',
      voiceSpeed: tk('knobVoiceSpeed'),
      voiceMaxResponseTokens: tk('knobVoiceMaxResponseTokens'),
      voiceNoiseReduction: tk('knobVoiceNoiseReduction'),
      voiceVadThreshold: tk('knobVoiceVadThreshold'),
      voicePrefixPaddingMs: tk('knobVoicePrefixPaddingMs'),
      voiceSilenceDurationMs: tk('knobVoiceSilenceDurationMs'),
      voiceEndSensitivity: tk('knobVoiceEndSensitivity'),
      voiceInterruptResponse: tk('knobVoiceInterruptResponse'),
      voiceIdleTimeoutSec: tk('knobVoiceIdleTimeoutSec'),
      voiceIdleDisconnectSec: tk('knobVoiceIdleDisconnectSec'),
      voiceLongSessions: tk('knobVoiceLongSessions'),
      voiceOutputLanguage: tk('knobVoiceOutputLanguage'),
      voiceTranscriptionModel: tk('knobVoiceTranscriptionModel'),
      voiceTranscriptionLanguage: tk('knobVoiceTranscriptionLanguage'),
      voiceTranscriptionPrompt: tk('knobVoiceTranscriptionPrompt'),
      voiceReasoningEffort: tk('knobVoiceReasoningEffort'),
      voiceThinkingLevel: tk('knobVoiceThinkingLevel'),
    };
  }

  // ── Curated defaults ──────────────────────────────────────────────────────
  // The owner edits models and prompts in the extension, publishes them, and
  // every surface picks the same set up from here. This page has no editor for
  // any of it, by decision.
  async function adoptPublished() {
    const account = (A.session() || {}).user;
    if (!account) return { ok: false };
    const token = await A.validToken();
    if (!token) return { ok: false };
    const resp = await fetch(A.supabaseUrl()
      + '/rest/v1/published_settings?select=id,data&scope=eq.' + encodeURIComponent(SCOPE)
      + '&order=id.desc&limit=1', {
      headers: { apikey: A.anonKey(), Authorization: 'Bearer ' + token },
    });
    if (!resp.ok) return { ok: false };
    const rows = await resp.json();
    if (!Array.isArray(rows) || !rows.length) return { ok: false };
    const row = rows[0];
    const wmKey = 'wcPublishedApplied_' + SCOPE;
    const cur = await WcStore.one(wmKey, 0);
    // Monotonic watermark, same as the extension's: an adopt that already ran
    // must not run again, or a local edit would be reverted on every load.
    if (Number(cur) >= Number(row.id)) return { ok: true, skipped: true };
    const data = row.data || {};
    // ── What a published set is allowed to set here ──────────────────────
    // The extension filters on the way OUT (pickPublishable, background.js),
    // and the web router had no filter on the way IN at all — it wrote every
    // key it was handed straight into local storage. A published row today is
    // clean, so this is defence in depth rather than a live leak; the cost of
    // being wrong is that a machine-local or personal key arrives as a
    // "curated default" and overwrites what this browser chose.
    //
    // An ALLOWLIST, not a copy of the extension's denylist: a copy of a
    // denylist drifts silently and fails open, while a list of what this
    // surface actually consumes fails closed. And an unrecognised key is
    // REPORTED, not dropped in silence — silence is how "the owner published
    // it and nothing happened" becomes a mystery.
    const ADOPTABLE = /^(activeModelId_|activeChatPromptId$|activeVoiceModelId_|activeVoicePromptId$|activeNativePromptId_|activeActionModelId_|activeTranscriptionPromptId$|activePreprocessModelId$|activePreprocessPromptId$|knob[A-Z]|effortByApiModel_|voiceNamesByProvider_|speechEngine$|speechRate$|speechVoiceName$|voiceModeChoice_|chatPrompts$|voicePrompts$|contentTypePrompts$|nativePrompts$)/;
    const patch = {};
    const skipped = [];
    Object.keys(data).forEach((k) => {
      if (data[k] === undefined) return;
      if (ADOPTABLE.test(k)) { patch[k] = data[k]; return; }
      skipped.push(k);
    });
    if (skipped.length) {
      console.warn(TAG, 'в опубликованном наборе ключи, которые новый чат не применяет:', skipped.join(', '));
    }
    patch[wmKey] = row.id;
    await WcStore.set(patch);
    return { ok: true, adopted: Object.keys(patch).length - 1, skipped };
  }

  async function activeModelId() {
    const key = 'activeModelId_' + SCOPE;
    const id = await WcStore.one(key, null);
    if (id) return id;
    // No published model is a real, reportable state — not something to paper
    // over with a hardcoded default that would then bill a model nobody chose.
    throw new Error('Учитель не настроен: в опубликованных настройках нет модели ('
      + key + '). Опубликуйте набор из расширения.');
  }

  // ── Handlers ──────────────────────────────────────────────────────────────

  WcBus.on('WC_ACCOUNT_STATE', async () => {
    const token = await A.validToken();
    const s = A.session();
    if (!token || !s || !s.user || !s.user.id) return { signedIn: false };
    const resp = await fetch(A.supabaseUrl() + '/rest/v1/account_billing?account_id=eq.'
      + encodeURIComponent(s.user.id) + '&select=status,balance_usd', {
      headers: { apikey: A.anonKey(), Authorization: 'Bearer ' + token },
    });
    // Auth is fine and the billing read failed: that is a DIFFERENT state from
    // signed-out, and the interface must not blank a good screen over it.
    if (!resp.ok) return { signedIn: true, error: 'account_billing ' + resp.status, email: s.user.email || null };
    const rows = await resp.json();
    const r = Array.isArray(rows) ? rows[0] : null;
    return {
      signedIn: true,
      hasRow: !!r,
      status: r ? r.status : null,
      balanceUsd: (r && r.balance_usd != null) ? Number(r.balance_usd) : null,
      email: s.user.email || null,
    };
  });

  WcBus.on('WC_LIST_CONVERSATIONS', async () => ({ ok: true, items: await WcHistory.list() }));

  // Names for the unnamed, asked for separately so the sidebar can paint from
  // the cheap pass first. Each batch broadcasts, and the interface repaints.
  WcBus.on('WC_FILL_PREVIEWS', async (m) => {
    await WcHistory.fillPreviews(m.items || [], (items) => {
      WcBus.broadcast({ type: 'WC_PREVIEWS_FILLED', items });
    });
    return { ok: true };
  });

  WcBus.on('WC_LOAD_CONVERSATION', async (m) => {
    const turns = await WcHistory.turns(m.id);
    // Re-attach the pictures this browser still holds for these turns.
    const imgs = await turnImages();
    for (const t of turns) {
      const ref = t.uid && imgs[t.uid];
      if (!ref) continue;
      const url = await WcAttach.url(ref.key);
      // No url means the picture was evicted or this is a different machine.
      // The turn keeps its text and says nothing about a picture it cannot
      // show, which beats a broken image box.
      if (url) t.images = [url];
    }
    // Reopening PINS the conversation's own session: minting a fresh one for an
    // existing thread would split it in two, and the second half would not be
    // findable from the extension.
    const sid = WcHistory.sessionIdOfKey(m.id);
    if (sid != null) sessionId = sid;
    setOpen(m.id, turns);
    return { ok: true, turns };
  });

  // Starting over. The session is dropped so the NEXT message mints a new one —
  // and with it a new conversation key. Doing it here rather than in the
  // interface keeps "which conversation am I in" in one place.
  WcBus.on('WC_NEW_CONVERSATION', async () => {
    sessionId = null;
    setOpen(null, []);
    return { ok: true };
  });

  WcBus.on('WC_RENAME_CONVERSATION', async (m) => {
    await WcHistory.rename(m.id, String(m.title || '').slice(0, 120));
    WcBus.broadcast({ type: 'WC_CONVERSATIONS_CHANGED' });
    return { ok: true };
  });

  // Hiding, not deleting — the same rule as everywhere else in Lex. The rows in
  // public.video_chat_turns are never touched; that table keeps everything.
  WcBus.on('WC_DELETE_CONVERSATION', async (m) => {
    await WcHistory.hide(m.id);
    WcBus.broadcast({ type: 'WC_CONVERSATIONS_CHANGED' });
    return { ok: true };
  });

  // ── Pictures attached to turns ────────────────────────────────────────────
  // The reference lives LOCALLY, keyed by turn uid, exactly as it does in the
  // extension: public.video_chat_turns.content is a string column, and the
  // picture itself is in this browser's IndexedDB. So a picture survives a
  // reload on this machine and does not follow the conversation to another —
  // the same promise the extension makes, and the honest one, because the
  // pixels never left this device.
  const TURN_IMAGES_KEY = 'wcTurnImages';

  async function rememberTurnImage(uid, att) {
    const map = await WcStore.one(TURN_IMAGES_KEY, {});
    map[uid] = { key: att.key, mime: att.mime, width: att.width, height: att.height };
    await WcStore.set({ [TURN_IMAGES_KEY]: map });
  }

  async function turnImages() {
    return WcStore.one(TURN_IMAGES_KEY, {});
  }

  // ── Sending ───────────────────────────────────────────────────────────────
  // The turns of the open conversation, held in memory so a follow-up question
  // carries the history without a round trip. Replaced wholesale when a
  // conversation is opened.
  let openId = null;
  let openTurns = [];

  function setOpen(id, turns) {
    openId = id;
    openTurns = (turns || []).map((t) => ({ role: t.role, text: t.text, uid: t.uid || WcHistory.newUid() }));
  }

  WcBus.on('WC_SEND', async (m) => {
    const modelId = await activeModelId();

    // The key is minted on the FIRST message, from the session row id. Before
    // that the conversation is not a row anywhere — which is why a brand-new
    // chat has no id for the sidebar to show.
    let convId = m.conversationId;
    if (!convId) {
      sessionId = null;
      const sid = await ensureSession();
      convId = WcHistory.keyForSession(sid);
      setOpen(convId, []);
    } else if (openId !== convId) {
      // Opened from history in another tab, or the page reloaded mid-thread.
      setOpen(convId, await WcHistory.turns(convId));
    }

    const prompt = await WcStore.get(['activeChatPromptId']);
    const slot = prompt.activeChatPromptId || 'chatB1';
    const knobs = await readKnobs();

    const userUid = WcHistory.newUid();
    const authoredAt = new Date().toISOString();
    const attachment = (m.images && m.images[0]) || null;

    if (attachment && !global.LexModelRegistry.visionSupported(modelId)) {
      // Loud, before any money moves. Sending a picture to a model that cannot
      // see it costs the same as sending it to one that can, and the answer
      // would just be about the text.
      throw new Error('Эта модель не читает картинки. Уберите вложение или дождитесь смены модели.');
    }

    openTurns.push({ role: 'user', text: m.text, uid: userUid });

    // Everything the model sees, inline. There is no server-side thread to
    // chain onto — every text surface ships the whole conversation now.
    //
    // The picture rides as a neutral block beside the text, and ONLY on the
    // turn that carries it: the text block must come first (the server writes
    // its prompt prefix into it), the data is bare base64 with no `data:`
    // prefix, and one image per message. Older turns keep their text only —
    // re-sending every picture of a long conversation on every turn would
    // multiply the bill by the number of pictures in it.
    const messages = openTurns.map((t) => ({ role: t.role, content: t.text }));
    if (attachment) {
      messages[messages.length - 1] = {
        role: 'user',
        content: [
          { type: 'text', text: m.text },
          { type: 'image', mime: attachment.mime, data: attachment.base64 },
        ],
      };
      await rememberTurnImage(userUid, attachment);
    }

    // Collect the answer as it streams so it can be written back on DONE. The
    // subscription is torn down by the terminal event, never left behind.
    let answer = '';
    const unsubscribe = WcBus.subscribe(async (msg) => {
      if (msg.requestId !== m.requestId) return;
      if (msg.type === 'STREAM_CHUNK' && msg.text) { answer += msg.text; return; }
      if (msg.type !== 'STREAM_DONE' && msg.type !== 'STREAM_ERROR') return;
      unsubscribe();
      // A partial answer is kept: the provider produced those tokens and the
      // account was billed for them, so throwing them away would be throwing
      // away something already paid for.
      const rows = [{ role: 'user', text: m.text, uid: userUid, authoredAt }];
      if (answer) rows.push({ role: 'assistant', text: answer, uid: WcHistory.newUid(), authoredAt: new Date().toISOString() });
      if (answer) openTurns.push({ role: 'assistant', text: answer, uid: rows[1].uid });
      try {
        await WcHistory.push(convId, rows);
        await WcHistory.forgetPreview(convId);
        WcBus.broadcast({ type: 'WC_CONVERSATIONS_CHANGED' });
      } catch (err) {
        console.warn(TAG, 'не записал ход в аккаунт:', err && err.message);
      }
    });

    core.streamExplainWord(
      '',                       // word — a chat turn has none
      null, null, null,
      CONNECTION_ID,
      m.requestId,
      null,                     // providerId — the registry is the authority
      modelId,
      null,                     // clickId
      {
        isChatTurn: true,
        // A pointer, not text: the prompt itself lives in the server catalogue
        // and llm-proxy injects it. Sending an empty systemPrompt instead would
        // be worse than sending nothing — the adapters gate on truthiness and
        // providers reject an empty system role.
        promptRef: { scope: SCOPE, cell: 'chatPrompts', slot },
        // The lower half of the instruction, chosen by content type. Same pair
        // the extension's main chat sends.
        promptContentRef: { scope: SCOPE, cell: 'contentTypePrompts', slot: 'text' },
        promptId: slot,
        pageType: 'text',
        messages,
        text: m.text,
        surface: 'standalone',
        source: 'webchat',
        turnIndex: openTurns.length - 1,
      },
      convId,
      knobs
    );

    return { ok: true, conversationId: convId };
  });

  // Voice needs a bound session BEFORE the call is minted: llm-proxy refuses a
  // voice SDP whose meta carries no session id, because voice_sessions.session_id
  // must never be null — that is exactly what keeps the billing listener able to
  // charge. Same session as the text conversation, so a spoken turn and a typed
  // one land in one thread.
  WcBus.on('WC_ENSURE_SESSION', async () => {
    const id = await ensureSession();
    return { ok: id != null, sessionId: id, conversationId: id != null ? WcHistory.keyForSession(id) : null };
  });

  // A spoken turn is a turn. It goes to the same table with the same shape, so
  // the extension lists a voice conversation exactly as it lists a typed one.
  WcBus.on('WC_APPEND_TURNS', async (m) => {
    if (!m.conversationId || !Array.isArray(m.turns) || !m.turns.length) return { ok: false };
    if (openId !== m.conversationId) setOpen(m.conversationId, openTurns);
    const rows = m.turns.map((t) => {
      const uid = WcHistory.newUid();
      openTurns.push({ role: t.role, text: t.text, uid });
      return { role: t.role, text: t.text, uid, authoredAt: new Date().toISOString() };
    });
    await WcHistory.push(m.conversationId, rows);
    await WcHistory.forgetPreview(m.conversationId);
    WcBus.broadcast({ type: 'WC_CONVERSATIONS_CHANGED' });
    return { ok: true, appended: rows.length };
  });

  WcBus.on('WC_STOP', async (m) => {
    const entry = inflightStreams.get(m.requestId);
    if (!entry || !entry.abort) return { ok: false, error: 'нечего останавливать' };
    // Marked BEFORE the abort: the abort is what produces the error, and a
    // mark set afterwards would lose the race with it.
    stoppedByUser.add(m.requestId);
    entry.abort(new DOMException('Stopped by user', 'AbortError'));
    return { ok: true };
  });

  WcBus.on('WC_MODELS', async () => {
    const reg = (global.LexModelRegistry && global.LexModelRegistry.modelRegistry) || {};
    const items = Object.keys(reg).map((id) => ({ id, label: reg[id].label || id, provider: reg[id].provider }));
    let active = null;
    try { active = await activeModelId(); } catch (_) { active = null; }
    return { ok: true, items, activeId: active };
  });

  // Top-up is the checkout page of the same site. The extension opens it with
  // chrome.tabs.create; on a page this is a plain window.open, which is also
  // the only form a native shell can intercept.
  // ── Пополнение ────────────────────────────────────────────────────────────
  //
  // ⚠️ НА САЙТ ЗА ДЕНЬГАМИ БОЛЬШЕ НЕ ХОДИМ. Раньше здесь был
  // `window.open('https://lex-me.club/checkout/')`, и внутри приложения это
  // приводило к тому, на что жаловался владелец: страница открывалась в Safari,
  // а Safari — отдельная программа со своим хранилищем, и вход туда не
  // доезжает. Человек, вошедший в чат, читал «Please sign in first».
  //
  // Расширение эту развилку прошло 2026-08-12 (коммит 6762a1b) и ушло от неё
  // совсем: сумма выбирается на месте, сервер зовётся напрямую, и открывается
  // касса ПРОВАЙДЕРА, а не наша страница. Здесь то же самое, и это заодно
  // закрывает вопрос безопасности: передавать сессию некуда, потому что
  // передавать её больше некому.
  //
  // Границы (10…200) — вежливость: настоящую проверку делает сервер и отвечает
  // 400 и на 9.99, и на 250, что бы ни прислал клиент.
  WcBus.on('WC_CREATE_PAYMENT', async (m) => {
    const token = await A.validToken();
    if (!token) return { ok: false, error: 'not_signed_in' };
    const resp = await fetch(A.supabaseUrl() + '/functions/v1/payments-webhook/create', {
      method: 'POST',
      headers: {
        apikey: A.anonKey(),
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ amount: Number(m.amount), lang: 'ru' }),
    });
    const j = await resp.json().catch(() => ({}));
    if (!resp.ok || !j.checkout_url) {
      return { ok: false, error: (j && j.error) || ('HTTP ' + resp.status) };
    }
    return { ok: true, checkoutUrl: j.checkout_url, orderId: j.order_id || null };
  });

  // Единственный источник правды о зачислении — вебхук провайдера: /status
  // отвечает paid только после того, как вебхук записал credited_at. Возврат
  // человека на страницу «оплата прошла» подтверждением НЕ считается.
  WcBus.on('WC_PAYMENT_STATUS', async (m) => {
    const token = await A.validToken();
    if (!token) return { ok: false, paid: false };
    const resp = await fetch(A.supabaseUrl() + '/functions/v1/payments-webhook/status', {
      method: 'POST',
      headers: {
        apikey: A.anonKey(),
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ order: m.orderId }),
    });
    const j = await resp.json().catch(() => ({}));
    return { ok: resp.ok, paid: !!(resp.ok && j && j.paid) };
  });

  WcBus.on('WC_SIGN_OUT', async () => {
    await A.signOut();
    sessionId = null;
    setOpen(null, []);
    return { ok: true };
  });

  global.WcBackend = {
    stubbed: false,
    turnImages,
    readKnobs,
    adoptPublished,
    activeModelId,
    setOpen,
    currentSessionId: () => sessionId,
    TAG,
  };
})(typeof self !== 'undefined' ? self : globalThis);
