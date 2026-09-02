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
//   WC_LIST_CONVERSATIONS {cursor?} → {ok, items:[{id, kind, title, titlePending,
//                            attachmentUrl, updatedAt, turnCount}], cursor, done}
//   WC_FILL_TITLES        {items} → {ok}   (просит сервер назвать безымянные)
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
//   WC_BALANCE_CHANGED / WC_CONVERSATIONS_CHANGED / WC_TITLES_FILLED
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
    const ADOPTABLE = /^(activeModelId_|activeChatPromptId$|activeVoiceModelId_|activeVoicePromptId$|activeTranscriptionPromptId$|activePreprocessModelId$|activePreprocessPromptId$|knob[A-Z]|effortByApiModel_|voiceNamesByProvider_|speechEngine$|speechRate$|speechVoiceName$|voiceModeChoice_|chatPrompts$|voicePrompts$|contentTypePrompts$|nativePrompts$)/;
    const patch = {};
    const skipped = [];
    Object.keys(data).forEach((k) => {
      if (data[k] === undefined) return;
      if (ADOPTABLE.test(k)) { patch[k] = data[k]; return; }
      skipped.push(k);
    });
    if (skipped.length) {
      console.warn(TAG, 'published set carries keys the new chat does not apply:', skipped.join(', '));
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
    throw new Error('The teacher is not configured: the published settings name no model ('
      + key + '). Publish a set from the extension.');
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

  // Порция списка. Курсор приходит от интерфейса и уходит обратно как есть —
  // здесь его не разбирают (см. listChats в wc-history.js).
  WcBus.on('WC_LIST_CONVERSATIONS', async (m) => {
    const r = await WcHistory.listChats(m && m.cursor);
    return { ok: true, items: r.items, cursor: r.cursor, done: r.done };
  });

  // ── Имена для безымянных ──────────────────────────────────────────────────
  //
  // Второй проход, и он НАМЕРЕННО отдельный от первого: список рисуется, как
  // только пришла порция, а имена доезжают потом и перерисовывают строки. Так
  // же было устроено дозаполнение превью, и по той же причине — на аккаунте с
  // сотней бесед ожидание имён оставило бы шторку пустой на все эти секунды.
  //
  // ⚠ КАЖДЫЙ КЛЮЧ СПРАШИВАЕТСЯ НЕ БОЛЬШЕ ОДНОГО РАЗА ЗА ЗАГРУЗКУ СТРАНИЦЫ.
  // Предохранитель из трёх попыток на сервере стережёт ДЕНЬГИ, а не число
  // запросов: ответы 'busy' / 'exhausted' / 'no_source' / 'gate' денег не
  // стоят и попытку не жгут, поэтому без этой памяти каждая перерисовка
  // шторки посылала бы их заново — и так до бесконечности.
  const titleAsked = new Set();

  WcBus.on('WC_FILL_TITLES', async (m) => {
    const need = (m.items || []).filter((it) => it && it.id && it.titlePending && !titleAsked.has(it.id));
    if (!need.length) return { ok: true };
    need.forEach((it) => titleAsked.add(it.id));

    // По шесть за раз: тридцать одновременных вызовов модели — это всплеск без
    // выигрыша, а по одному слишком долго смотреть.
    for (let i = 0; i < need.length; i += 6) {
      const slice = need.slice(i, i + 6);
      const done = [];
      await Promise.all(slice.map(async (it) => {
        const r = await WcHistory.requestTitle(it.id);
        // `null` — беда сети или поставщика; 'done'/'titled' — имя есть. Всё
        // остальное ('busy', 'exhausted', 'gate', …) значит «пока нет», и
        // строка остаётся с заглушкой.
        const title = (r && r.title) ? String(r.title) : '';
        if (title) done.push({ id: it.id, title });
      }));
      if (done.length) WcBus.broadcast({ type: 'WC_TITLES_FILLED', titles: done });
    }
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

    // ── Ходы ЗАГОТОВОК подмешиваются В ЛЕНТУ, но не в контекст ───────────
    //
    // Ходов заготовок нет в переписке урока — у каждой своя ветка. Не покажи
    // мы их здесь, они появлялись бы живыми и исчезали при первой же
    // перезагрузке страницы, то есть человек терял бы сказанное. Расширение
    // сшивает ровно так же и в одной точке (chat-surface.js renderStoredTurns).
    //
    // ⚠️ ЛЕНТА И КОНТЕКСТ РАСХОДЯТСЯ ЗДЕСЬ, И ЭТО НАМЕРЕННО. `setOpen`
    // получает ТОЛЬКО реплики урока плюс ветки по отдельности; сшитый список
    // уходит наружу и живёт только на экране. Положи мы сшитое в openTurns —
    // учитель со следующего же вопроса увидел бы всё, что человек говорил
    // заготовкам, и изоляция кончилась бы молча, без единой ошибки.
    let branchTurns = [];
    try {
      const prefix = global.LexActionBranch.actionBranchPrefixOf(m.id);
      if (prefix) branchTurns = await WcHistory.actionBranchTurns(prefix);
    } catch (err) {
      // Ветки не прочитались — показываем один урок. Это хуже полного, но
      // лучше пустого экрана.
      console.warn(TAG, 'action branches not read:', err && err.message);
    }
    const byBranch = {};
    branchTurns.forEach((t) => {
      (byBranch[t.branchKey] || (byBranch[t.branchKey] = [])).push(t);
    });
    setOpen(m.id, turns, byBranch);
    return { ok: true, turns: mergeForDisplay(turns, branchTurns) };
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
    // Своей обрезки у этого обработчика нет: предел ставит сервер (rename_chat,
    // 200 знаков). Поле ввода в шторке при этом не пускает больше 120 — то есть
    // серверный предел на нашем пути недостижим и работает как страховка от
    // чужого клиента, а не как то, что видит человек здесь.
    // Пустая строка — это «сбросить имя», и она обязана доехать пустой.
    await WcHistory.renameChat(m.id, String(m.title || ''));
    WcBus.broadcast({ type: 'WC_CONVERSATIONS_CHANGED' });
    return { ok: true };
  });

  // Hiding, not deleting — the same rule as everywhere else in Lex. The rows in
  // public.video_chat_turns are never touched; that table keeps everything.
  // Отметка теперь на СЕРВЕРЕ, то есть скрытие видно на всех устройствах сразу.
  WcBus.on('WC_DELETE_CONVERSATION', async (m) => {
    await WcHistory.setChatHidden(m.id, true);
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
  // ── ПЕРЕПИСКИ ЗАГОТОВОК ХРАНЯТСЯ ОТДЕЛЬНО, ПО ОДНОЙ НА ЗАГОТОВКУ ─────────
  //
  // Это не кэш и не украшение, а сама изоляция. Учитель урока не должен видеть
  // ходы заготовки, а заготовка — историю урока и ходы СОСЕДНЕЙ заготовки: то,
  // что уходит модели, собирается из буфера СВОЕЙ ветки и только из него.
  // Ключ карты — ключ ветки (lex-action-branch.js), тот же, под которым реплики
  // лежат в базе и под которым их пишет расширение.
  const openBranches = new Map();      // branchKey → turns[]

  const normalizeTurns = (turns) => (turns || [])
    .map((t) => ({ role: t.role, text: t.text, uid: t.uid || WcHistory.newUid() }));

  function setOpen(id, turns, branches) {
    openId = id;
    openTurns = normalizeTurns(turns);
    openBranches.clear();
    if (branches) {
      Object.keys(branches).forEach((k) => openBranches.set(k, normalizeTurns(branches[k])));
    }
  }

  // Буфер ветки. Пусто в памяти — тянем из аккаунта: заготовку могли трогать с
  // другого устройства или в расширении, и её переписка обязана продолжиться, а
  // не начаться заново.
  async function branchBuffer(branchKey) {
    if (openBranches.has(branchKey)) return openBranches.get(branchKey);
    let loaded = [];
    try { loaded = normalizeTurns(await WcHistory.turns(branchKey)); } catch (err) {
      console.warn(TAG, 'action branch not read:', err && err.message);
    }
    // Пока читали, тот же ключ мог завести параллельный вызов — берём тот, что
    // уже лежит, иначе один из двух ходов потерялся бы из контекста.
    if (openBranches.has(branchKey)) return openBranches.get(branchKey);
    openBranches.set(branchKey, loaded);
    return loaded;
  }

  // Урок и все ветки заготовок этого чата — одной лентой, в порядке авторства.
  // Точка склейки ОДНА, как и в расширении (chat-surface.js renderStoredTurns):
  // зовущих у неё несколько, и вторая копия правила порядка разошлась бы.
  function mergeForDisplay(lesson, branchTurns) {
    const all = (lesson || []).concat(branchTurns || []);
    return all.sort((a, b) => {
      const at = String(a.authoredAt || '');
      const bt = String(b.authoredAt || '');
      if (at !== bt) return at < bt ? -1 : 1;
      const au = String(a.uid || '');
      const bu = String(b.uid || '');
      return au < bu ? -1 : au > bu ? 1 : 0;
    });
  }

  // ── Заготовки действий: ОДНА кнопка, много заготовок ─────────────────────
  //
  // Не второй учитель и не вторая беседа: ТОТ ЖЕ ход, отправленный с другой
  // инструкцией и, возможно, на другой модели. Заготовка — это СЛОТ ячейки
  // nativePrompts: своё имя, свой текст промпта, своя модель и своя переписка
  // (lex-action-presets.js).
  //
  // Scope — 'shorts-main' и для чата, и для заготовки, а не имя этого окна. Это
  // правило расширения (chat-surface.js actionModelKeyFor / getPromptGroupConfig,
  // отмена посурфейсного расщепления v1.74.1): одна конфигурация заготовки везде,
  // где живёт её кнопка. Адресуй каталог любым другим scope — сервер не найдёт
  // строки, и ход уйдёт вообще без инструкции, молча.
  //
  // ⚠️ ЧЕГО ЗДЕСЬ БОЛЬШЕ НЕТ (2026-09-02), и оба «нет» — про одно и то же:
  // страница перестала выводить у себя ИМЕНА КЛЮЧЕЙ.
  //   · NATIVE_SLOT_KEY ('activeNativePromptId_<scope>') — указатель активной
  //     заготовки. Слот приезжает С ХОДОМ с тех пор, как выбор заменили рядом
  //     пилюль; сам ключ снят с обращения везде.
  //   · nativeModelKeyFor — правило имени ключа модели. Его считает сервер и
  //     кладёт готовый id в строку публичного списка. Копия этого правила жила
  //     здесь и УЖЕ разошлась однажды (хвост остался 'native', когда расширение
  //     перешло на слот) — страница читала ключ, в который никто не пишет, и
  //     молча отвечала моделью основного чата, каким бы ни был выбор владельца.
  //
  // ЗАМЕЧАНИЕ, намеренное: ход заготовки НЕ несёт promptContentRef. В расширении
  // contentPromptRefFor() возвращает null для любой ячейки, кроме chatPrompts,
  // то есть нижний уровень инструкции — принадлежность обычного чата. Слать его
  // отсюда значило бы выдумать сочетание, которого расширение не производит.
  const NATIVE_CELL = 'nativePrompts';

  // Слот и модель приезжают С ХОДОМ — оба из строки публичного списка, которую
  // отдал сервер. Ни одного чтения хранилища здесь больше нет: читать было бы
  // нечего и незачем.
  function nativeTurnConfig(slotId, modelId) {
    if (!slotId) return null;             // без слота заготовки не бывает
    return {
      slot: slotId,
      // Пустая строка = «наследовать модель чата» — то же значение, что даёт ей
      // строка настроек в расширении. null здесь означает ровно это.
      model: modelId || null,
      promptRef: { scope: SCOPE, cell: NATIVE_CELL, slot: slotId },
      promptId: NATIVE_CELL,
    };
  }

  // ── Каталог заготовок ────────────────────────────────────────────────────
  //
  // Список заготовок общий с расширением по КОДУ (lex-action-presets.js), но
  // не по способу до него дотянуться: в расширении модуль ходит в service
  // worker сообщением LEX_PROMPT_ADMIN, а здесь никакого worker'а нет —
  // страница стучится в ту же edge-функцию сама, своим токеном. Хранилище так
  // же: там chrome.storage.local, здесь IndexedDB. Обе зависимости отданы
  // модулю впрыском, чтобы имён этой страницы внутри общего файла не было.
  //
  // Право проверяет СЕРВЕР. Не-редактор получает 403, список сворачивается в
  // одну заготовку Native, и кнопка на странице ведёт себя ровно как до этой
  // работы — меню не открывается, потому что выбирать не из чего. Отдельного
  // гейта под это не заводили: он получился сам.
  if (global.LexActionPresets) {
    LexActionPresets.configure({
      kv: { get: (keys) => WcStore.get(keys), set: (obj) => WcStore.set(obj) },
      // Транспорт общий с расширением (lex-edge-call.js) — раньше эта форма
      // лежала здесь третьей дословной копией.
      promptsAdmin: async (body) => {
        const token = await A.validToken();
        if (!token) return { error: 'login', status: 401 };
        return await LexEdgeCall.callEdgeJson('prompts-admin', body, {
          token, anonKey: A.anonKey(), baseUrl: A.supabaseUrl(),
        });
      },
      // Половина «ключ модели» у кнопки публикации заготовки. На странице
      // редактора заготовок нет (wc-settings.js объявляет это прямым текстом),
      // поэтому дверь нужна не ради кнопки здесь, а чтобы общий модуль вёл себя
      // на обеих поверхностях одинаково и не деградировал молча.
      publishKeys: async (scope, keys, note) => {
        const token = await A.validToken();
        if (!token) return { error: 'login', status: 401 };
        return await LexEdgeCall.callEdgeJson('settings-publish', {
          action: 'publishKeys', scope, keys, note: note || 'action preset published',
        }, { token, anonKey: A.anonKey(), baseUrl: A.supabaseUrl() });
      },
      // Последний опубликованный набор scope — читается прямо из
      // published_settings (RLS отдаёт его любому вошедшему), без edge-функции.
      publishedKeys: async (scope) => {
        const token = await A.validToken();
        if (!token) return null;
        try {
          const resp = await fetch(
            A.supabaseUrl() + '/rest/v1/published_settings'
            + '?select=data&scope=eq.' + encodeURIComponent(scope) + '&order=id.desc&limit=1',
            { headers: { apikey: A.anonKey(), Authorization: 'Bearer ' + token } },
          );
          if (!resp.ok) return null;
          const rows = await resp.json();
          const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
          return (row && row.data && typeof row.data === 'object') ? row.data : {};
        } catch (_) {
          return null;
        }
      },
    });
  }

  // ── Dictation ─────────────────────────────────────────────────────────────
  //
  // The SAME server route the extension uses (background.js
  // LEX_DICTATION_TRANSCRIBE → llm-proxy `openai-asr`), reached directly
  // because there is no service worker here to relay through. The server holds
  // the OpenAI key, prices the call from public.models.audio_hour, writes the
  // `dictation` row and debits the balance — so there is nothing to bill on
  // this side and nothing to write.
  WcBus.on('WC_DICTATE', async (m) => {
    const token = await A.validToken();
    if (!token) throw new Error('Sign in to dictate.');

    const bin = atob(m.base64 || '');
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const mime = m.mimeType || 'audio/webm';
    const apiModel = 'gpt-4o-mini-transcribe';

    // The extension can hardcode `recording.webm` because it only ever records
    // in Chrome. Here the recorder is whatever the platform gives us, and on
    // iOS that is audio/mp4 — MediaRecorder in WebKit does not produce WebM at
    // all. OpenAI picks the container from the FILENAME, so a .webm name on an
    // mp4 body is a rejected transcription on the one platform this page exists
    // for. The extension is derived from the mime type instead.
    const EXT = {
      'audio/webm': 'webm', 'audio/mp4': 'mp4', 'audio/m4a': 'm4a', 'audio/x-m4a': 'm4a',
      'audio/mpeg': 'mp3', 'audio/mpga': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
      'audio/ogg': 'ogg', 'audio/flac': 'flac',
    };
    const base = String(mime).split(';')[0].trim().toLowerCase();
    const ext = EXT[base] || 'webm';

    const form = new FormData();
    form.append('file', new File([bytes], 'recording.' + ext, { type: base }));
    form.append('model', apiModel);
    form.append('response_format', 'json');
    // The session is whatever conversation is already open — NOT a fresh one.
    // Minting a session here would give a brand-new empty chat a row before a
    // single message had been sent, which is the one thing the key rule
    // forbids (see the header of wc-app.js).
    form.append('meta', JSON.stringify({
      sessionId,
      callType: 'dictation',
      surface: 'standalone',
      modelInternalId: 'openai:' + apiModel,
      pageType: 'text',
      // Строка в balance_ledger получает ref вида `<call_type>:<videoId>`, и с
      // null здесь она читалась как «dictation:» — списание, привязанное ни к
      // чему. Расширение эту же грабку уже проходило. Видео тут нет вовсе, но
      // беседа есть, и назвать её — единственное осмысленное содержимое хвоста.
      // Пусто только до первого сообщения, когда беседы ещё не существует.
      videoId: openId || null,
      durationMs: m.durationMs,
    }));

    const resp = await core.proxyFetchMultipart('openai-asr', form, token);
    const bodyText = await resp.text();
    if (!resp.ok) {
      // 402 is "no money", not "could not hear you" — say the one the reader
      // can act on.
      if (resp.status === 402) throw new Error('Not enough balance for dictation.');
      throw new Error(bodyText.slice(0, 160) || ('HTTP ' + resp.status));
    }
    let text = '';
    try { const j = JSON.parse(bodyText); text = (j && typeof j.text === 'string') ? j.text : ''; } catch (_) {}
    // Dictation costs money, so the balance on screen is now stale.
    WcBus.broadcast({ type: 'WC_BALANCE_CHANGED' });
    return { ok: true, text };
  });

  async function runSend(m) {
    // Слот приезжает С ХОДОМ: имя на кнопке и то, что уходит модели, обязаны
    // относиться к одной и той же заготовке.
    const native = (m.mode === 'native') ? nativeTurnConfig(m.slotId, m.modelId) : null;
    // Порядок важен: у повтора модель уже назначена (та, которой отвечали в
    // прошлый раз), и она сильнее и режима, и текущей настройки.
    const modelId = m.modelOverride || (native && native.model) || await activeModelId();

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

    // ── Куда ляжет этот ход ──────────────────────────────────────────────
    // Ход заготовки живёт СВОЕЙ веткой чата, а не в переписке урока: ключ
    // '__lex_action__<ключ чата>__<слот>' (lex-action-branch.js), тот же самый,
    // что пишет расширение, — поэтому ход, отправленный там, продолжается
    // здесь. Ветка выводится ПОСЛЕ чеканки ключа чата: до неё ключа ещё нет, и
    // ветка привязалась бы к пустому месту.
    const branchKey = native ? global.LexActionBranch.actionBranchKeyOf(convId, native.slot) : null;
    // Куда пишем строки в базу и из чего собираем контекст для модели. Для
    // обычного хода это переписка урока, для хода заготовки — только её ветка.
    const writeKey = branchKey || convId;
    const buf = branchKey ? await branchBuffer(branchKey) : openTurns;

    const prompt = await WcStore.get(['activeChatPromptId']);
    const slot = prompt.activeChatPromptId || 'chatB1';
    const knobs = await readKnobs();

    const userUid = m.assistantUid ? m.userUid : WcHistory.newUid();
    // Чеканится ЗАРАНЕЕ, а не в момент записи: «заново» переписывает ответ под
    // тем же uid (upsert on_conflict merge-duplicates), то есть заменяет
    // строку, а не добавляет вторую.
    const assistantUid = m.assistantUid || WcHistory.newUid();
    const authoredAt = new Date().toISOString();
    const attachment = (m.images && m.images[0]) || null;

    if (attachment && !global.LexModelRegistry.visionSupported(modelId)) {
      // Loud, before any money moves. Sending a picture to a model that cannot
      // see it costs the same as sending it to one that can, and the answer
      // would just be about the text.
      throw new Error('This model does not read images. Remove the attachment or switch models.');
    }

    buf.push({ role: 'user', text: m.text, uid: userUid });

    // Everything the model sees, inline. There is no server-side thread to
    // chain onto — every text surface ships the whole conversation now.
    //
    // The picture rides as a neutral block beside the text, and ONLY on the
    // turn that carries it: the text block must come first (the server writes
    // its prompt prefix into it), the data is bare base64 with no `data:`
    // prefix, and one image per message. Older turns keep their text only —
    // re-sending every picture of a long conversation on every turn would
    // multiply the bill by the number of pictures in it.
    const messages = buf.map((t) => ({ role: t.role, content: t.text }));
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
      if (answer) rows.push({ role: 'assistant', text: answer, uid: assistantUid, authoredAt: new Date().toISOString() });
      // modelId рядом с ходом — ТОЛЬКО в памяти. В `video_chat_turns` колонки
      // под модель нет, и заводить её ради «заново» — миграция рядом с
      // деньгами ради удобства. Следствие честное и записано в журнале: повтор
      // хода, ПЕРЕЖИВШЕГО перезагрузку, идёт текущей моделью, потому что чем
      // он был отвечен — не сохранено нигде.
      if (answer) buf.push({ role: 'assistant', text: answer, uid: assistantUid, model: modelId });
      try {
        // Ход заготовки ложится в СВОЮ ветку. Название беседы при этом не
        // меняется: ветка не беседа, в список она не идёт (триггер базы
        // сворачивает '__lex_action__…' в родителя), и трогать подпись беседы
        // ходом, которого в ней не видно, было бы враньём.
        await WcHistory.push(writeKey, rows);
        WcBus.broadcast({ type: 'WC_CONVERSATIONS_CHANGED' });
      } catch (err) {
        console.warn(TAG, 'turn not written to the account:', err && err.message);
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
        promptRef: native ? native.promptRef : { scope: SCOPE, cell: 'chatPrompts', slot },
        // The lower half of the instruction, chosen by content type. Same pair
        // the extension's main chat sends — and, like the extension, NOT sent
        // on an action turn: contentPromptRefFor() gives null for any cell
        // other than chatPrompts.
        ...(native ? {} : {
          promptContentRef: { scope: SCOPE, cell: 'contentTypePrompts', slot: 'text' },
        }),
        promptId: native ? native.promptId : slot,
        pageType: 'text',
        messages,
        text: m.text,
        surface: 'standalone',
        source: 'webchat',
        turnIndex: buf.length - 1,
      },
      convId,
      knobs
    );

    return { ok: true, conversationId: convId };
  }

  WcBus.on('WC_SEND', runSend);

  // К чему привязана беседа — страница или видео. null, если ни к чему.
  WcBus.on('WC_ATTACHMENT', async (m) => {
    if (!m || !m.id) return null;
    // Вид и адрес приходят СТРОКОЙ СПИСКА (list_chats), а не выводятся из формы
    // ключа: догадка здесь однажды уже сочиняла youtube-адрес для страницы.
    return WcHistory.attachmentOf(m.id, m.hint || null);
  });

  // ── «Заново» ──────────────────────────────────────────────────────────────
  //
  // Простой повтор ТОЙ ЖЕ моделью. В расширении есть только переспрос С ВЫБОРОМ
  // другой модели (ytvocab-reask-menu → runModelReask → sendReask), и его
  // reaskKind:'regenerate' — это пометка происхождения для лога, а модель
  // приходит аргументом. То есть повтор той же моделью — это тот же путь с
  // прежним аргументом, и здесь он собран так же: тот же вопрос, тот же
  // контекст без последней пары, тот же uid ответа.
  //
  // Повторяется ТОЛЬКО последний ответ. Повтор середины беседы осиротил бы всё,
  // что после него, — расширение вешает свои органы на последний обмен ровно
  // поэтому.
  WcBus.on('WC_REGENERATE', async (m) => {
    if (!openTurns.length) throw new Error('Nothing to retry.');
    const last = openTurns[openTurns.length - 1];
    if (!last || last.role !== 'assistant') throw new Error('The last turn is not an answer.');
    const prev = openTurns[openTurns.length - 2];
    if (!prev || prev.role !== 'user') throw new Error('No question to repeat.');

    // Ответ выкидывается из контекста, вопрос остаётся: модель должна увидеть
    // ровно то, что видела в прошлый раз. `dropLastPair` в расширении делает
    // то же самое.
    openTurns.pop();
    const userUid = prev.uid;
    const assistantUid = last.uid;
    // Модель того хода, если она известна. Известна она только пока страницу
    // не перезагрузили — см. комментарий у openTurns.push выше.
    const modelOverride = last.model || null;
    // Вопрос тоже выкидываем: runSend положит его обратно сам.
    openTurns.pop();

    return runSend({
      requestId: m.requestId,
      conversationId: openId,
      text: prev.text,
      images: [],
      mode: null,
      modelOverride,
      userUid,
      assistantUid,
    });
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
    WcBus.broadcast({ type: 'WC_CONVERSATIONS_CHANGED' });
    return { ok: true, appended: rows.length };
  });

  WcBus.on('WC_STOP', async (m) => {
    const entry = inflightStreams.get(m.requestId);
    if (!entry || !entry.abort) return { ok: false, error: 'nothing to stop' };
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

  // Выход уносит с этого устройства ВСЁ, что связано с аккаунтом: беседы и их
  // кэши, картинки сообщений, настройки, адоптированное с сервера. Иначе
  // следующий вошедший видит чужое — ровно то, что и происходило.
  // Пропуск снимается ПЕРВЫМ: чистка не зависит от сети, а вот запрос на выход
  // из GoTrue — да, и упасть он не должен оставить страницу и с данными, и без
  // выхода.
  WcBus.on('WC_SIGN_OUT', async () => {
    await A.signOut();
    try { await WcWipe.run('sign out'); } catch (err) { console.warn(TAG, 'wipe:', err && err.message); }
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
