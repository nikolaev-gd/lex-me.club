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
  // Ходы, которые ведёт сервер: requestId → номер операции. Нужен «стопу»: он
  // сообщает серверу, сколько знаков ответа человек успел увидеть, а адресуется
  // это номером операции. Запись живёт ровно от заголовка ответа до конца хода.
  const serverOps = new Map();

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
    'knobVoiceReasoningEffort', 'knobVoiceThinkingLevel', 'knobVoiceLiveTurnGapMs',
  ];

  const scoped = (k) => k + '_' + SCOPE;

  // Ручки диктовки — отдельно от остальных и КАК ЕСТЬ: что из них примет
  // распознавалка, решает сервер (_shared/dictation-fields.ts), один на все
  // поверхности. Список ручек — ячейки настроек (LexSettingsCells), общие с
  // расширением; своего перечня имён у страницы нет. Раньше страница отдавала
  // их «средними» именами (dictationLanguages…), а реестр ждал короткие — и на
  // живом пути на сервер уезжали одни умолчания.
  async function readDictationKnobs() {
    const C = global.LexSettingsCells;
    const keys = ['knobDictationModel'].concat((C && C.DICTATION_KNOB_KEYS) || []);
    const res = await WcStore.get(keys.map(scoped));
    const stored = {};
    keys.forEach((k) => { stored[k] = res[scoped(k)]; });
    return { model: stored.knobDictationModel, knobs: (C && C.dictationKnobs) ? C.dictationKnobs(stored) : {} };
  }

  async function readKnobs() {
    const wanted = KNOB_KEYS.map(scoped).concat(['voiceNamesByProvider_' + SCOPE, 'activeVoiceModelId_' + SCOPE, 'voiceThinkingModelId_' + SCOPE]);
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
      // gpt-live thinking model (synthetic text-model id); null — the server's default.
      voiceThinkingModel: res['voiceThinkingModelId_' + SCOPE] || null,
      // gpt-live: the pause before a new bubble (published by the owner); the
      // listener cuts turns by it. Missing — the server's default.
      voiceLiveTurnGapMs: tk('knobVoiceLiveTurnGapMs'),
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
    //
    // 2026-09-17: ключи выбора модели (activeModelId_, effortByApiModel_) из
    // этого списка УБРАНЫ. Опубликованное владельцем значение стало
    // РЕКОМЕНДУЕМОЙ моделью, а что взять на самом деле — решает одна функция
    // базы (lex_model_defaults): есть личный выбор человека — он, нет —
    // рекомендуемая. Её ответ приезжает отдельно (modelDefaults ниже), поэтому
    // публикация сюда больше не пишет и выбор человека не стирает.
    const ADOPTABLE = /^(activeChatPromptId$|activeVoiceModelId_|activeVoicePromptId$|voiceThinkingModelId_|activeVoiceThinkingPromptId$|activeTranscriptionPromptId$|activePreprocessModelId$|activePreprocessPromptId$|knob[A-Z]|voiceNamesByProvider_|speechEngine$|speechRate$|speechVoiceName$|voiceModeChoice_|chatPrompts$|voicePrompts$|contentTypePrompts$|nativePrompts$)/;
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

  // ── Модель по умолчанию: правило чтения живёт на сервере ──────────────────
  //
  // Одна функция базы отвечает на вопрос «какая у меня модель» для каждого
  // окна: есть личный выбор — он, нет — рекомендуемая (последняя
  // опубликованная владельцем). Страница это правило у себя не повторяет:
  // спрашивает и раскладывает ответ по тем же ячейкам, которые уже читает
  // отправка хода. Поэтому ни один читатель ячейки не менялся.
  async function modelDefaults() {
    const token = await A.validToken();
    if (!token) return { ok: false };
    let resp;
    try {
      resp = await fetch(A.supabaseUrl() + '/rest/v1/rpc/lex_model_defaults', {
        method: 'POST',
        headers: { apikey: A.anonKey(), Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: '{}',
      });
    } catch (e) { console.warn(TAG, 'model defaults network error:', e && e.message); return { ok: false }; }
    // Сервер ещё без этой функции (выложен раньше кода) — молча остаёмся на
    // том, что уже лежит в ячейке.
    if (!resp.ok) { console.warn(TAG, 'model defaults', resp.status); return { ok: false }; }
    const out = await resp.json().catch(() => null);
    if (!out || out.ok !== true || !out.scopes) return { ok: false };
    const mine = out.scopes[SCOPE];
    if (!mine || typeof mine !== 'object') return { ok: true, applied: 0 };
    const patch = {};
    if (typeof mine.model === 'string' && mine.model) patch['activeModelId_' + SCOPE] = mine.model;
    if (mine.effort && typeof mine.effort === 'object' && Object.keys(mine.effort).length) {
      patch['effortByApiModel_' + SCOPE] = mine.effort;
    }
    if (!Object.keys(patch).length) return { ok: true, applied: 0 };
    await WcStore.set(patch);
    return { ok: true, applied: Object.keys(patch).length, source: mine.source };
  }

  // Личный выбор модели уезжает человеку в аккаунт — той же функцией базы,
  // которой пишутся остальные личные настройки. Отсюда он виден расширению,
  // программе для Мака и айфону.
  async function pushModelChoice(patch) {
    const token = await A.validToken();
    if (!token) return false;
    try {
      const r = await fetch(A.supabaseUrl() + '/rest/v1/rpc/lex_patch_user_settings', {
        method: 'POST',
        headers: { apikey: A.anonKey(), Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_patch: patch }),
      });
      if (!r.ok) { console.warn(TAG, 'model choice push', r.status); return false; }
      return true;
    } catch (e) { console.warn(TAG, 'model choice push failed:', e && e.message); return false; }
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

  // ── Модель по умолчанию: пункт «Text model» в меню «+» ─────────────────────
  // Та же ячейка, что читает отправка (activeModelId) и что приносит публикация
  // настроек, — и те же имена, что у расширения (activeModelId_<scope>,
  // effortByApiModel_<scope>). Хранится в этом браузере; следующая публикация
  // настроек перепишет выбор, как и в расширении у обычного человека.
  WcBus.on('WC_TEXT_MODEL', async () => {
    const modelId = await WcStore.one('activeModelId_' + SCOPE, null);
    const efforts = await WcStore.one('effortByApiModel_' + SCOPE, null);
    return { modelId: modelId || null, efforts: (efforts && typeof efforts === 'object') ? efforts : {} };
  });
  WcBus.on('WC_SET_TEXT_MODEL', async (m) => {
    const parts = String((m && m.modelId) || '').split(':');
    if (parts.length < 3 || !parts[0] || !parts[1]) throw new Error('Unknown model.');
    const effKey = 'effortByApiModel_' + SCOPE;
    const cur = await WcStore.one(effKey, null);
    const efforts = (cur && typeof cur === 'object') ? { ...cur } : {};
    efforts[parts[1]] = parts[2];
    await WcStore.set({ ['activeModelId_' + SCOPE]: m.modelId, [effKey]: efforts });
    // И наверх, человеку в аккаунт: выбор принадлежит ему, а не этому браузеру.
    // Локальная ячейка при этом остаётся — она нужна, чтобы кнопка модели
    // перерисовалась сразу, не дожидаясь сети.
    await pushModelChoice({ ['activeModelId_' + SCOPE]: m.modelId, [effKey]: efforts });
    return { ok: true };
  });

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
    // Что показывать, решает сервер (list_turns). Ходы заготовок — обычные
    // реплики беседы.
    const conv = await WcHistory.conversation(m.id);
    const turns = conv.lesson;
    // Пути в бакете приезжают вместе с репликой, ключи блобов лежат здесь.
    // Берём и то и другое: ключ — быстрая местная дорожка, путь — то, что
    // работает на другом устройстве и после повторного входа.
    const imgs = await turnImages();
    for (const t of turns) {
      const ref = (t.uid && imgs[t.uid]) || null;
      const srv = (t.attachments || []).find((a) => a && a.kind === 'image' && a.path) || null;
      if (!ref && !srv) continue;
      const url = await WcAttach.url(ref && ref.key, (ref && ref.path) || (srv && srv.path));
      // Ни ключа, ни пути не хватило — картинки нет нигде. Реплика остаётся с
      // текстом и молчит про картинку, которую показать нечем: это лучше
      // сломанной рамки.
      if (url) t.images = [url];
    }
    // Старые картинки этой переписки довозим на сервер по нескольку за
    // открытие — тем же ленивым правилом, что и расширение, и по той же
    // причине: на устройстве их до сотни мегабайт, а на весь проект сейчас
    // выделен гигабайт. Разговор, в который человек не вернётся, места не
    // занимает. Fire-and-forget: показ ленты этого не ждёт.
    backfillTurnImages(m.id, turns, imgs).catch(() => {});
    // Reopening PINS the conversation's own session: minting a fresh one for an
    // existing thread would split it in two, and the second half would not be
    // findable from the extension.
    const sid = WcHistory.sessionIdOfKey(m.id);
    if (sid != null) sessionId = sid;

    // Деньги беседы (list_chat_money): модель каждого ответа — для подписи
    // кнопки модели под ответом (реплика её не несёт), и, разработчику, цены
    // и итог. Где стоит цена, решил сервер — по готовому уиду реплики; своего
    // правила «номер операции → реплика» у страницы нет. Не прочиталось —
    // подписи будут общим словом, денег на экране не будет.
    let money = null;
    try {
      money = await WcHistory.money(m.id);
      const byUid = new Map();
      for (const a of ((money && Array.isArray(money.answers)) ? money.answers : [])) {
        if (a && a.uid && a.anchor !== 'question') {
          byUid.set(String(a.uid), global.LexAnswerRow.modelIdOfCharge(a.model, a.effort));
        }
      }
      for (const t of turns) {
        if (t.role === 'assistant' && t.uid && byUid.has(t.uid)) t.model = byUid.get(t.uid);
      }
    } catch (err) {
      console.warn(TAG, 'chat money not read:', err && err.message);
    }
    setOpen(m.id, turns);
    return { ok: true, turns, money };
  });

  // Деньги открытой беседы — одни, без переписки: интерфейс перечитывает их
  // после каждого платного события (ход, разговор, диктовка, название).
  WcBus.on('WC_CHAT_MONEY', async () => {
    if (!openId) return { ok: true, body: null };
    const body = await WcHistory.money(openId);
    return { ok: !!body, body };
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
  // Две записи об одной картинке, и обе нужны. Ключ блоба живёт ЗДЕСЬ, по uid
  // хода: пока картинка в этом браузере, показ мгновенный и без сети. Путь в
  // бакете живёт НА СЕРВЕРЕ, в колонке `attachments` той же реплики: он и
  // делает так, что переписка, открытая на другом устройстве или после
  // повторного входа, показывает ту же картинку. Кладёт его туда страница —
  // командой attach_to_turn (WcHistory.attach), и это ЕДИНСТВЕННОЕ, что она о
  // реплике докладывает: саму реплику пишет сервер.
  const TURN_IMAGES_KEY = 'wcTurnImages';

  async function rememberTurnImage(uid, att, path) {
    const map = await WcStore.one(TURN_IMAGES_KEY, {});
    map[uid] = {
      key: att.key, mime: att.mime, width: att.width, height: att.height,
      ...(path ? { path } : {}),
    };
    await WcStore.set({ [TURN_IMAGES_KEY]: map });
  }

  async function turnImages() {
    return WcStore.one(TURN_IMAGES_KEY, {});
  }

  const BACKFILL_PER_OPEN = 5;
  const backfillBusy = new Set();

  async function backfillTurnImages(convId, turns, imgs) {
    if (!convId || backfillBusy.has(convId)) return;
    backfillBusy.add(convId);
    try {
      let done = 0;
      for (const t of turns) {
        if (done >= BACKFILL_PER_OPEN) break;
        const ref = t.uid && imgs[t.uid];
        if (!ref || !ref.key || ref.path) continue;
        const hasSrv = (t.attachments || []).some((a) => a && a.kind === 'image' && a.path);
        if (hasSrv) continue;
        const up = await WcAttach.upload(ref.key, convId);
        if (!up || !up.ok || !up.path) {
          // Место кончилось, вход протух, сети нет — дальше по этой переписке
          // упрёмся в то же самое. Следующее открытие попробует снова.
          if (up && (up.reason === 'quota' || up.reason === 'auth' || up.reason === 'offline')) break;
          continue;
        }
        // Путь докладывается на строку, которую сервер уже завёл: реплика
        // пришла из list_turns, значит, она там есть. Местная отметка о пути
        // ставится ТОЛЬКО после того, как сервер его принял: поставленная до
        // отказа, она вывела бы реплику из добора навсегда — с картинкой,
        // которой на сервере так и нет.
        const landed = await WcHistory.attach(convId, t.uid,
          [{ kind: 'image', path: up.path, mime: ref.mime, width: ref.width, height: ref.height }]);
        if (!landed) continue;
        await rememberTurnImage(t.uid, ref, up.path);
        done += 1;
      }
    } catch (_) { /* добор — не обязанность, показ уже состоялся */ }
    finally { backfillBusy.delete(convId); }
  }

  // ── Sending ───────────────────────────────────────────────────────────────
  // The turns of the open conversation, held in memory so a follow-up question
  // carries the history without a round trip. Replaced wholesale when a
  // conversation is opened.
  let openId = null;
  let openTurns = [];

  // В список для учителя вопрос, заданный заготовкой, ложится ЗАМЕНОЙ —
  // короткой строкой заготовки и фразой (её присылает сервер, поле later), а
  // не голой фразой: так его на следующих ходах видит и учитель расширения и
  // айфона, где переписку собирает сервер. Промпта заготовки здесь нет никогда.
  const normalizeTurns = (turns) => (turns || [])
    .map((t) => ({ role: t.role, text: (t.role === 'user' && t.later) || t.text, uid: t.uid || WcHistory.newUid(), model: t.model || null }));

  function setOpen(id, turns) {
    openId = id;
    openTurns = normalizeTurns(turns);
  }

  // ── Заготовки действий: ОДНА кнопка, много заготовок ─────────────────────
  //
  // Не второй учитель и не вторая беседа: ТОТ ЖЕ ход урока, с инструкцией на
  // этот ход и, возможно, на другой модели. Заготовка — это СЛОТ ячейки
  // nativePrompts: своё имя, свой текст промпта, короткая строка и модель
  // (lex-action-presets.js). Промпт едет указателем-приставкой: сервер вклеит
  // его внутрь вопроса только на этом ходу, а на следующих поставит на его
  // место короткую строку.
  //
  // Scope — 'shorts-main' и для чата, и для заготовки, а не имя этого окна. Это
  // правило расширения (chat-surface.js getPromptGroupConfig, отмена
  // посурфейсного расщепления v1.74.1): одна конфигурация заготовки везде,
  // где живёт её кнопка. Адресуй каталог любым другим scope — сервер не найдёт
  // строки, и ход уйдёт вообще без инструкции, молча.
  //
  // ⚠️ ЧЕГО ЗДЕСЬ БОЛЬШЕ НЕТ (2026-09-02), и оба «нет» — про одно и то же:
  // страница перестала выводить у себя ИМЕНА КЛЮЧЕЙ.
  //   · NATIVE_SLOT_KEY ('activeNativePromptId_<scope>') — указатель активной
  //     заготовки. Слот приезжает С ХОДОМ с тех пор, как выбор заменили рядом
  //     пилюль; сам ключ снят с обращения везде.
  //   · nativeModelKeyFor — правило имени ключа модели. Ключа больше нет вовсе:
  //     модель заготовки живёт в каталоге, в одной строке с её текстом, и
  //     приезжает готовым значением в строке списка. Копия правила жила здесь и
  //     УЖЕ разошлась однажды (хвост остался 'native', когда расширение перешло
  //     на слот) — страница читала ключ, в который никто не пишет, и молча
  //     отвечала моделью основного чата, каким бы ни был выбор владельца.
  //
  // Промпт учителя и нижний уровень инструкции у хода заготовки — те же, что у
  // обычного хода: начало запроса, общее с прошлыми ходами, от нажатия пилюли
  // не меняется (кэш поставщика).
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
      promptPrefixRef: { scope: SCOPE, cell: NATIVE_CELL, slot: slotId },
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
  // Право проверяет СЕРВЕР: публичный список пилюль (действие presets) отдаётся
  // любому вошедшему, редакторские действия — только редактору.
  if (global.LexActionPresets) {
    LexActionPresets.configure({
      kv: { get: (keys) => WcStore.get(keys), set: (obj) => WcStore.set(obj) },
      // Чей сохранённый список читать. У редактора в нём лежат ЧЕРНОВЫЕ
      // заготовки, поэтому список чужого аккаунта модуль не берёт вовсе.
      // Здесь сессия под рукой и сети не нужно — в расширении за тем же
      // отвечает сообщение LEX_ACCOUNT_ID в service worker.
      accountId: () => {
        const s = A.session();
        return (s && s.user && s.user.id) || null;
      },
      // Транспорт общий с расширением (lex-edge-call.js) — раньше эта форма
      // лежала здесь третьей дословной копией.
      promptsAdmin: async (body) => {
        const token = await A.validToken();
        if (!token) return { error: 'login', status: 401 };
        return await LexEdgeCall.callEdgeJson('prompts-admin', body, {
          token, anonKey: A.anonKey(), baseUrl: A.supabaseUrl(),
        });
      },
      // ⚠️ ЗДЕСЬ БЫЛИ `publishKeys` и `publishedKeys` — половина «ключ модели»
      // у кнопки публикации заготовки и чтение опубликованного набора ради
      // сверки. Обе сняты 2026-09-02: модель заготовки переехала в каталог, к
      // её тексту, и публикуется тем же действием, что и он. Серверное
      // действие settings-publish 'publishKeys' осталось на месте, просто его
      // больше никто не зовёт.
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
  // ── Живая диктовка ────────────────────────────────────────────────────────
  //
  // Тот же сервер и тот же разговор, что у расширения (`dictation-live`),
  // ТОЛЬКО без воркера посередине: держать сокет здесь некому, кроме самой
  // страницы. Реле — общий кусок с воркером расширения
  // (lex-dictation-relay.js): открыть, переложить, закрыть, прибрать за
  // неудачным стартом. Здесь только своё: пропуск, адрес и доставка кадров по
  // шине страницы.
  const liveRelay = global.LexDictationRelay.create({
    token: () => A.validToken(),
    baseUrl: () => A.supabaseUrl(),
    emit: (_ctx, msg) => WcBus.broadcast(msg),
    // Диктовка стоит денег — баланс на экране устарел.
    onFinal: () => WcBus.broadcast({ type: 'WC_BALANCE_CHANGED' }),
  });
  global.LexDictationRelay.TYPES.forEach((type) => {
    WcBus.on(type, async (m) => {
      // Живая диктовка тоже знает свою беседу: ключ открытой беседы уезжает в
      // настройках сессии, и сервер пишет его в строку расхода. Новой беседы
      // ещё нет — заводим её здесь (openForPaidWork), иначе деньги диктовки
      // не попали бы ни в одну беседу.
      if (type === 'LEX_DICTATION_LIVE_START' && m) {
        const key = await openForPaidWork();
        if (key) m = Object.assign({}, m, { config: Object.assign({}, m.config || {}, { chatKey: key }) });
      }
      return liveRelay.handle(type, m, {});
    });
  });

  // Платная работа до первого сообщения (диктовка) тоже принадлежит беседе:
  // её строка расхода несёт ключ беседы, и по нему деньги входят в итог. Ключа
  // до первого сообщения нет — заводим беседу сейчас, тем же путём, что голос
  // (WC_ENSURE_SESSION), и говорим интерфейсу, какая беседа открыта: первое
  // сообщение уйдёт в неё же, а не заведёт вторую.
  async function openForPaidWork() {
    if (openId) return openId;
    try {
      const sid = await ensureSession();
      if (sid == null) return null;
      const key = WcHistory.keyForSession(sid);
      setOpen(key, []);
      WcBus.broadcast({ type: 'WC_CONVERSATION_OPENED', id: key });
      return key;
    } catch (err) {
      console.warn(TAG, 'conversation for paid work not opened:', err && err.message);
      return null;
    }
  }

  // Каталог распознавалок диктовки — строки public.models
  // (lex-dictation-catalog.js). Пропуск здесь, поэтому и источник каталога для
  // микрофона страницы — здесь.
  global.LexDictationCatalog.setSource(async () => global.LexDictationCatalog.fetchRows({
    baseUrl: A.supabaseUrl(), apikey: A.anonKey(), token: await A.validToken(),
  }));
  // Заранее, при загрузке страницы: на нажатии микрофона каталог тогда уже в
  // памяти. Не вошёл ещё — не страшно, нажатие прочитает его само.
  global.LexDictationCatalog.load();

  WcBus.on('WC_DICTATE', async (m) => {
    const token = await A.validToken();
    if (!token) throw new Error('Sign in to dictate.');

    const bin = atob(m.base64 || '');
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const mime = m.mimeType || 'audio/webm';
    // Модель диктовки — ручка настроек ('Диктовка' в разделе Transcription),
    // одна на все поверхности. Своего окна настроек у страницы нет: значение
    // приезжает опубликованным набором владельца, как и остальные ручки.
    //
    // Ни списка допустимых имён, ни запасного имени здесь НЕТ намеренно:
    // список — каталог распознавалок в базе (lex-dictation-catalog.js),
    // запасное имя — реестр моделей. Своя копия разошлась бы с ними на первой
    // же смене модели, что уже случилось однажды с прошитым
    // 'gpt-4o-mini-transcribe'.
    const dict = await readDictationKnobs().catch(() => ({ model: null, knobs: {} }));
    const apiModel = global.LexDictationCatalog.normalize(dict.model, global.LexModelRegistry.defaultDictationModel);
    // Остальные ручки полосы «Диктовка» уезжают КАК ЕСТЬ, в meta: что из них
    // примет распознавалка, умолчания и несовместимые сочетания решает сервер.

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
    // Беседа — открытая; новой ещё нет — заводится здесь (openForPaidWork):
    // деньги диктовки принадлежат беседе, в которую уйдёт надиктованное.
    const convKey = await openForPaidWork();
    form.append('meta', JSON.stringify({
      sessionId,
      callType: 'dictation',
      surface: 'standalone',
      // В meta, а не полями формы: meta сервер снимает до пересылки
      // поставщику (и сервер прошлой версии тоже — незнакомое поле формы
      // OpenAI встретил бы отказом).
      knobs: dict.knobs,
      // Строку в базе, по которой считается цена, называет сервер: он же
      // выбирает поставщика по имени модели, а распознавалок теперь две разных
      // фирмы. Прошитый здесь префикс назвал бы Google строкой OpenAI.
      pageType: 'text',
      // Строка в balance_ledger получает ref вида `<call_type>:<videoId>`, и с
      // null здесь она читалась как «dictation:» — списание, привязанное ни к
      // чему. Расширение эту же грабку уже проходило. Видео тут нет вовсе, но
      // беседа есть, и назвать её — единственное осмысленное содержимое хвоста.
      videoId: convKey || null,
      // Та же беседа полным ключом: сервер пишет её в строку расхода
      // (calls.chat_key), как у расширения.
      chatKey: convKey || null,
      durationMs: m.durationMs,
    }));

    // Под-путь назван по действию человека: за ним и OpenAI, и Google, а
    // выбирает между ними сервер по имени модели.
    const resp = await core.proxyFetchMultipart('dictation', form, token);
    // Рост текста: сервер отдаёт поток провайдера и в конце свой кадр с ценой.
    // Куски уезжают в интерфейс через шину — тем же способом, каким туда
    // попадает ответ учителя, — а вернувшееся значение остаётся авторитетом:
    // провайдер по ходу потока правит уже сказанное.
    // Поток включает сервер (ручка «Рост текста» у модели, которая его умеет) —
    // смотрим на ответ, а не на то, что просили.
    if (/text\/event-stream/i.test(resp.headers.get('content-type') || '')) {
      let text = '';
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split(/\r?\n\r?\n/);
        buf = parts.pop() || '';
        for (const part of parts) {
          let evName = null;
          const dataLines = [];
          for (const line of part.split(/\r?\n/)) {
            if (line.startsWith('event:')) evName = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
          }
          const data = dataLines.join('\n');
          if (!data || data === '[DONE]' || evName === 'lex_proxy_done') continue;
          let j; try { j = JSON.parse(data); } catch (_) { continue; }
          if (j.type === 'transcript.text.delta' && typeof j.delta === 'string') text += j.delta;
          else if (j.type === 'transcript.text.done' && typeof j.text === 'string') text = j.text;
          else continue;
          WcBus.broadcast({ type: 'WC_DICTATE_DELTA', requestId: m.requestId || null, textSoFar: text });
        }
      }
      WcBus.broadcast({ type: 'WC_BALANCE_CHANGED' });
      return { ok: true, text: text.trim() };
    }
    const bodyText = await resp.text();
    if (!resp.ok) {
      // 402 is "no money", not "could not hear you" — say the one the reader
      // can act on.
      if (resp.status === 402) throw new Error('Not enough balance for dictation.');
      // 429 — места в очереди платных вызовов аккаунта сервер ждал до 30 с и
      // не дождался (или занят поставщик): человеку — общее «сервис занят»,
      // а не сырое тело ответа.
      if (resp.status === 429) {
        const busy = new Error((typeof LexErrorText !== 'undefined' && LexErrorText.busy)
          ? LexErrorText.busy() : 'The service is overloaded right now. Please try again in a minute.');
        busy.lexBusy = true;
        throw busy;
      }
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
    //
    // ⚠️ ОТКАЗ, А НЕ ТИХАЯ ПОДМЕНА. Ход, объявленный заготовкой, но приехавший
    // без слота, дальше по этой функции превратился бы в ОБЫЧНЫЙ вопрос: ниже
    // всюду стоит `native ? … : …`, и promptRef молча стал бы ячейкой чата.
    // Человек нажал бы «Лимерик», заплатил и получил ответ учителя — то есть
    // совсем не то, что просил. Ровно это запрещает правило «отказ вместо
    // ответа без инструкции», и на стороне расширения оно уже стоит.
    if (m.mode === 'native' && !m.slotId) {
      throw new Error('This action preset is no longer available. Reopen the chat and try again.');
    }
    const native = (m.mode === 'native') ? nativeTurnConfig(m.slotId, m.modelId) : null;
    // Порядок важен: у повтора модель уже назначена (та, которой отвечали в
    // прошлый раз), и она сильнее и режима, и текущей настройки.
    const modelId = m.modelOverride || (native && native.model) || await activeModelId();
    // Модель хода — ленте: ею подписана кнопка модели под ответом.
    WcBus.broadcast({ type: 'WC_TURN_MODEL', requestId: m.requestId, modelId });

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
      setOpen(convId, (await WcHistory.conversation(convId)).lesson);
    }

    // Ход заготовки — ход той же беседы: тот же ключ, тот же список для
    // учителя. Под этим ключом сервер ведёт строки хода, на него же
    // докладывается путь картинки.
    const writeKey = convId;
    const buf = openTurns;

    const prompt = await WcStore.get(['activeChatPromptId']);
    const slot = prompt.activeChatPromptId || 'chatB1';
    const knobs = await readKnobs();

    // Уиды пары. И отправка, и «заново» считают их из номера операции — из того
    // же числа и по тому же правилу их считает сервер, который эти строки и
    // пишет. Странице уиды нужны для ПАМЯТИ: под ними ход лежит в буфере
    // контекста, и оттуда их берёт следующее «заново» (replacesUid), — поэтому
    // в памяти обязан лежать тот же уид, что и в базе.
    const isRegen = m.act === 'regen';
    const opId = m.opId ? String(m.opId) : null;
    // Вопрос при переспросе НЕ трогается: он тот же, и уид у него тот же.
    const userUid = isRegen ? m.userUid : (opId ? global.LexTurnId.userTurnUid(opId) : WcHistory.newUid());
    // Ответ при переспросе — НОВЫЙ, со своим уидом: сервер заводит новую
    // строку, а прежнюю помечает заменённой. Оставь мы в памяти уид прежнего
    // ответа, следующее «заново» попросило бы заменить строку, которая уже
    // заменена. Без номера операции сервер ход не ведёт, строки не будет
    // нигде, и уид живёт только в памяти — тогда при переспросе он прежний.
    const assistantUid = opId
      ? global.LexTurnId.assistantTurnUid(opId)
      : ((isRegen && m.assistantUid) || WcHistory.newUid());
    // Время авторства вопроса — от НАЖАТИЯ, и оно уезжает серверу в meta;
    // время ответа считает сам сервер (lex_turn_begin), разводя пару по тому
    // же правилу, что turnAuthoredAt: при равной метке тайбрейк по уиду
    // поставил бы ':a' перед ':u' — ответ над вопросом.
    // Уиды пары — ленте: по ним встаёт цена хода, которую сервер отдаёт по
    // готовому уиду реплики (list_chat_money).
    WcBus.broadcast({ type: 'WC_TURN_UIDS', requestId: m.requestId, userUid: isRegen ? null : userUid, assistantUid });
    const opAt = opId ? global.LexTurnId.turnAuthoredAt(m.pressedAt) : null;
    const authoredAt = opAt ? new Date(opAt.userAt).toISOString() : new Date().toISOString();
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
    // Обещание загрузки картинки в бакет; null, когда картинки нет.
    let uploading = null;
    if (attachment) {
      messages[messages.length - 1] = {
        role: 'user',
        content: [
          { type: 'text', text: m.text },
          { type: 'image', mime: attachment.mime, data: attachment.base64 },
        ],
      };
      await rememberTurnImage(userUid, attachment);
      // Загрузка в бакет идёт ПАРАЛЛЕЛЬНО с запросом к учителю: ответ модели
      // всё равно дольше. Забираем её ниже, ровно в момент записи реплики.
      uploading = WcAttach.upload(attachment.key, writeKey);
    }

    // Ответ копится по ходу потока ради ПАМЯТИ: на DONE он ляжет в буфер
    // контекста, и следующий вопрос понесёт его без похода за ним. Строку в
    // аккаунте наполняет сервер из того же потока. Подписка снимается
    // завершающим событием и никогда не остаётся висеть.
    let answer = '';
    const unsubscribe = WcBus.subscribe(async (msg) => {
      if (msg.requestId !== m.requestId) return;
      // Ведёт ли сервер этот ход — заголовок ответа, то есть РАНЬШЕ первого
      // куска (proxyFetch в lex-teacher-core.js). Нужен ровно одному месту:
      // «стопу», который докладывает число увиденных знаков по номеру
      // операции. На то, что ляжет в память и на экран, он не влияет.
      if (msg.type === 'STREAM_SERVER_TURN') {
        if (msg.serverTurn && msg.opId) serverOps.set(m.requestId, String(msg.opId));
        return;
      }
      // Вопрос из выбранных слов в том виде, в каком его собрал сервер и
      // прочитал учитель. В память беседы ложится он, а не видимый текст:
      // следующий ход обязан прислать ровно то же начало беседы (кэш у
      // поставщика) и тот же вопрос. На экране по-прежнему видимый текст.
      //
      // У хода заготовки тем же кадром приходит замена (laterText) — как этот
      // вопрос прочтёт учитель на следующих ходах: короткая строка и фраза. В
      // список ложится она: промпта заготовки в нём не бывает.
      if (msg.type === 'STREAM_USER_TEXT' && (msg.laterText || msg.userText)) {
        const q = buf.find((t) => t.uid === userUid);
        if (q) q.text = msg.laterText || msg.userText;
        return;
      }
      if (msg.type === 'STREAM_CHUNK' && msg.text) { answer += msg.text; return; }
      if (msg.type !== 'STREAM_DONE' && msg.type !== 'STREAM_ERROR') return;
      serverOps.delete(m.requestId);
      unsubscribe();
      // Переспрос не дал ни слова (отказ, «стоп» до первого слова): прежний
      // ответ остался в беседе на сервере — возвращаем пару в контекст.
      if (!answer && Array.isArray(m.restoreOnFail)) {
        const i = buf.findIndex((t) => t.uid === userUid);
        if (i >= 0) buf.splice(i, 1);
        buf.push(...m.restoreOnFail);
        return;
      }
      // A partial answer is kept: the provider produced those tokens and the
      // account was billed for them, so throwing them away would be throwing
      // away something already paid for.
      //
      // В базу отсюда не пишется НИЧЕГО — ни вопрос, ни ответ. Обе строки
      // завёл и наполнил сервер по ходу того же потока; при «заново» он же
      // написал новый ответ своим уидом и пометил прежний заменённым; на
      // «стопе» урезал по числу увиденных знаков (WC_STOP ниже). Здесь
      // остаётся только ПАМЯТЬ — буфер контекста для следующего вопроса.
      //
      // modelId рядом с ходом — ТОЛЬКО в памяти: строку пишет сервер, и модели
      // в ней нет (list_turns её не отдаёт). Следствие честное и записано в
      // журнале: повтор хода, ПЕРЕЖИВШЕГО перезагрузку, идёт текущей моделью,
      // потому что чем он был отвечен — не сохранено нигде.
      if (answer) buf.push({ role: 'assistant', text: answer, uid: assistantUid, model: modelId });
      // Шторка бесед обновляется ВСЕГДА, как только поток закрыт: список ведёт
      // сервер, и у него беседа уже изменилась (новая строка списка, свежее
      // время последней реплики) — ждать картинку ниже ей незачем.
      WcBus.broadcast({ type: 'WC_CONVERSATIONS_CHANGED' });
      // Картинка — единственное, что страница о реплике докладывает. Пути в
      // бакете сервер не знает (файл ушёл в attach-upload мимо него), и путь
      // едет командой на строку вопроса — ту же, что завёл сервер.
      //
      // Отказ на любом шаге не отменяет ничего: сообщение уже ушло, ответ уже
      // на экране. Максимум, что теряется, — картинка останется только в этом
      // браузере. Местная отметка о пути ставится только после того, как
      // сервер его принял, — по той же причине, что в backfillTurnImages:
      // поставленная раньше, она вывела бы реплику из добора.
      if (!uploading) return;
      try {
        const up = await uploading;
        if (!(up && up.ok && up.path)) {
          WcUI.toast(up && up.reason === 'quota'
            ? 'Картинка осталась только на этом устройстве: место для файлов закончилось.'
            : 'Картинка осталась только на этом устройстве: не удалось сохранить её на сервере.');
          return;
        }
        const landed = await WcHistory.attach(writeKey, userUid,
          [{ kind: 'image', path: up.path, mime: attachment.mime, width: attachment.width, height: attachment.height }]);
        if (!landed) {
          // Строки нет — сервер этот ход не завёл (ход без номера операции или
          // оборван до того, как поставщик принял запрос). Тогда и вопроса в
          // беседе нет, и прикладывать путь не к чему.
          console.warn(TAG, 'picture path not attached: the server has no row for this turn');
          return;
        }
        await rememberTurnImage(userUid, attachment, up.path);
      } catch (err) {
        console.warn(TAG, 'picture path not reported:', err && err.message);
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
        // providers reject an empty system role. The same teacher prompt on a
        // preset turn: the preset rides as a one-turn prefix below.
        promptRef: { scope: SCOPE, cell: 'chatPrompts', slot },
        // The lower half of the instruction, chosen by content type. Same pair
        // the extension's main chat sends.
        promptContentRef: { scope: SCOPE, cell: 'contentTypePrompts', slot: 'text' },
        // Промпт заготовки — указателем-приставкой: сервер вклеит его внутрь
        // вопроса только на этом ходу.
        ...(native ? { promptPrefixRef: native.promptPrefixRef } : {}),
        promptId: slot,
        pageType: 'text',
        // МАТЕРИАЛ УРОКА. Ключ, по форме которого сервер решает, что за материал
        // у беседы. Поле уезжает всегда — в том числе на путях, где номера
        // операции нет.
        materialKey: writeKey,
        messages,
        text: m.text,
        // Места выбранных слов: вопрос из них собирает сервер.
        ...(m.picks ? { picks: m.picks } : {}),
        ...(!m.picks && m.pickFrom ? { pickBlockFrom: String(m.pickFrom) } : {}),
        surface: 'standalone',
        source: 'webchat',
        turnIndex: buf.length - 1,
        // Номер операции и всё, что серверу нужно, чтобы вести эту переписку
        // самому. chatKey — ключ, под которым строки реально ложатся (в
        // meta.videoId рядом уезжает обрезанный ключ, беседу он не адресует).
        // Пустой opId значит «этот ход сервер не ведёт».
        ...(opId ? {
          opId,
          chatKey: writeKey,
          act: isRegen ? 'regen' : 'send',
          authoredAt,
          // Какой ответ заменяет «заново». Без него сервер переспрос не ведёт:
          // «последняя реплика учителя» — не тот же ответ, когда открыто второе
          // устройство.
          ...(isRegen && m.replacesUid ? { replacesUid: String(m.replacesUid) } : {}),
        } : {}),
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

  // ── Переспрос последнего ответа выбранной моделью ──────────────────────────
  //
  // Кнопка модели под последним ответом (lex-answer-row.js). Тот же вопрос, тот
  // же контекст без последней пары, модель — выбранная в меню, и только на этот
  // ответ: activeModelId не трогается, следующий вопрос уйдёт моделью по
  // умолчанию. Ход ведёт сервер (act 'regen' + уид заменяемого ответа): он
  // проверяет, что ответ есть в беседе, заводит новый и помечает прежний
  // заменённым. Расширение и айфон делают то же самое.
  //
  // Переспрашивается ТОЛЬКО последний ответ. Повтор середины беседы осиротил бы
  // всё, что после него. Ответ заготовки — такой же: что вопрос задан
  // заготовкой, сервер знает сам (по заменяемому ответу) и отправит его снова с
  // её промптом, своим текстом вместо замены.
  WcBus.on('WC_REGENERATE', async (m) => {
    const buf = openTurns;
    if (!buf.length) throw new Error('Nothing to retry.');
    const last = buf[buf.length - 1];
    if (!last || last.role !== 'assistant') throw new Error('The last turn is not an answer.');
    const prev = buf[buf.length - 2];
    if (!prev || prev.role !== 'user') throw new Error('No question to repeat.');

    // Пара выкидывается из контекста: runSend положит вопрос обратно сам, а
    // ответ — когда придёт новый. Модель должна увидеть ровно то, что видела в
    // прошлый раз. `dropLastPair` в расширении делает то же самое.
    buf.pop();
    buf.pop();
    const userUid = prev.uid;
    const assistantUid = last.uid;
    // Модель: выбранная в меню; без выбора — та, которой отвечали (известна
    // из памяти или из расходов беседы).
    const modelOverride = m.modelId || last.model || null;
    const opId = (global.LexTurnId && assistantUid) ? global.LexTurnId.newOpId() : null;

    try {
      return await runSend({
        requestId: m.requestId,
        conversationId: openId,
        text: prev.text,
        images: [],
        modelOverride,
        userUid,
        assistantUid,
        act: 'regen',
        opId,
        pressedAt: Date.now(),
        replacesUid: assistantUid,
        // Не удалось — прежняя пара возвращается в контекст: на сервере она
        // осталась на месте, и следующий вопрос обязан её видеть.
        restoreOnFail: [prev, last],
      });
    } catch (err) {
      if (buf[buf.length - 1] && buf[buf.length - 1].uid === userUid) buf.pop();
      buf.push(prev, last);
      throw err;
    }
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

  // Голосовая реплика — тоже реплика, но в базу её кладёт не страница, а
  // слушатель voice-watch на сервере (docs/PLAN-SERVER-HISTORY.md §6): он сам
  // получает расшифровку от поставщика и пишет её под уидом 'voice:<item_id>'.
  // Здесь пачка ложится ТОЛЬКО В ПАМЯТЬ — в контекст следующего текстового
  // вопроса, чтобы учитель помнил, о чём только что говорили, не дожидаясь,
  // пока слушатель допишет, а страница перечитает беседу.
  WcBus.on('WC_APPEND_TURNS', async (m) => {
    if (!m.conversationId || !Array.isArray(m.turns) || !m.turns.length) return { ok: false };
    if (openId !== m.conversationId) setOpen(m.conversationId, openTurns);
    // Уид — тот же 'voice:<item_id>', что у ленты (wc-app.js) и у слушателя:
    // по нему реплика в памяти и строка на сервере — одна и та же, а не две.
    for (const t of m.turns) {
      openTurns.push({ role: t.role, text: t.text, uid: t.uid ? String(t.uid) : WcHistory.newUid() });
    }
    // Список бесед ведёт сервер. Слушатель мог ещё не дописать, но сообщить
    // сейчас дешевле, чем оставить беседу в шторке без свежего времени до
    // следующего события.
    WcBus.broadcast({ type: 'WC_CONVERSATIONS_CHANGED' });
    return { ok: true, appended: m.turns.length };
  });

  WcBus.on('WC_STOP', async (m) => {
    const entry = inflightStreams.get(m.requestId);
    if (!entry || !entry.abort) return { ok: false, error: 'nothing to stop' };
    // Marked BEFORE the abort: the abort is what produces the error, and a
    // mark set afterwards would lose the race with it.
    stoppedByUser.add(m.requestId);
    // СКОЛЬКО ЗНАКОВ ЧЕЛОВЕК УСПЕЛ УВИДЕТЬ — отдельным стуком, до обрыва.
    // Текста не шлём: ответ у сервера уже есть, мы сообщаем только длину. У
    // страницы печатающего буфера нет, поэтому увиденное — это весь пришедший
    // текст, и его длину считает лента (WcThread.seenChars).
    //
    // Только для хода, который ведёт сервер: на обычном аккаунте строки
    // операции нет, и вызов всё равно ничего бы не сделал.
    const stopOpId = serverOps.get(m.requestId) || null;
    if (stopOpId && Number.isFinite(Number(m.seenChars))) {
      WcHistory.reportStopped(stopOpId, Math.max(0, Math.round(Number(m.seenChars))))
        .catch((err) => console.warn(TAG, 'stop not reported:', err && err.message));
    }
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
    readDictationKnobs,
    adoptPublished,
    modelDefaults,
    activeModelId,
    setOpen,
    currentSessionId: () => sessionId,
    TAG,
  };
})(typeof self !== 'undefined' ? self : globalThis);
