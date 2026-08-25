// lex-teacher-core.js — the teacher itself: every provider adapter, the
// streaming call, and the assembly of what goes to the model. No chrome.*
// inside, by construction.
//
// WHY IT IS OUT OF background.js. Lex now has two surfaces, the extension and
// the web page, and this is the part they must not have two copies of. It is
// also the part that would drift fastest if they did: every line of the three
// adapters below is a provider quirk bought with a live request (Anthropic
// wants effort and thinking as two separate top-level fields; Opus refuses
// thinking:enabled; Gemini has no thinking level below "low"; the Responses
// API rejects seed outright and temperature whenever reasoning is on). A
// second copy of that knowledge goes stale silently — the request keeps
// returning 200 and the answer is quietly worse.
//
// WHAT THE HOST SUPPLIES. create(deps) takes everything platform-shaped, so
// the module can be identical on both sides of the seam. The one that matters:
//
//   emit(target, msg)  where the token stream goes. `target` is whatever the
//               host handed streamExplainWord as its stream target — a tab id
//               in the extension, a connection id in the web. The core never
//               looks inside it; it only hands it back. In the extension emit
//               is chrome.tabs.sendMessage, the worker pushing into the tab
//               that asked; in the web it writes straight into the page. That
//               single substitution is what "the core is not a worker" means
//               in practice; the other deps are plumbing.
//
//   keepAlive() a no-op call the host makes periodically. In MV3 it is an
//               extension API call, which resets the worker's 30-second idle
//               timer — without it a long reasoning answer dies mid-stream
//               with the worker. The web has nothing to keep alive and passes
//               a function that does nothing.
//
// Every dep is REQUIRED and checked at create() time. A missing one is a
// wiring mistake in a host, and it must surface as one line naming it — not
// as a TypeError two thousand lines in, halfway through a paid call.
//
// Loaded by: background.js (importScripts, after model-registry.js) and the
// web build (a <script> tag, same position).
(function (global) {
  'use strict';

  if (global.LexTeacherCore) return;

  const REQUIRED = ["TAG", "LXT", "emit", "keepAlive", "hasSecrets", "inflightStreams", "lastClickByTab", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "DEFAULT_API_KEY", "getApiKey", "lexSbUrl", "lexAnonKey", "OPENAI_URL", "OPENAI_RESPONSES_URL", "OPENAI_CONVERSATIONS_URL", "ANTHROPIC_URL", "GOOGLE_URL_TMPL", "GOOGLE_INTERACTIONS_URL", "MODEL_REGISTRY", "authValidToken", "getActiveChatPrompt", "upsertPrompt", "addWordClick", "updateWordClick", "recordAnyCall", "logTextCallRequest", "logTextCallResponse", "buildIoResponse", "computeCost", "extractEffectiveCallParams", "lexNotifyBalanceMaybeChanged", "logContextTrace", "resolvePageType", "resolveCallSessionId", "ensureSessionForTab", "ensureStandaloneSessionForTab", "forgetSessionId", "forgetStandaloneSessionId", "extractRealVideoId"];

  function create(deps) {
    const missing = REQUIRED.filter((n) => deps[n] === undefined);
    if (missing.length) {
      throw new Error('LexTeacherCore.create: host did not supply ' + missing.join(', '));
    }

    // Aliased to the names the code below already uses. Deliberately a flat
    // list and not deps.something.foo: the bodies moved out of background.js
    // verbatim, and rewriting two thousand references would have been the one
    // place in this move where a typo could hide.
    const {
      TAG,
      LXT,
      emit,
      keepAlive,
      hasSecrets,
      inflightStreams,
      lastClickByTab,
      ANTHROPIC_API_KEY,
      GOOGLE_API_KEY,
      DEFAULT_API_KEY,
      getApiKey,
      lexSbUrl,
      lexAnonKey,
      OPENAI_URL,
      OPENAI_RESPONSES_URL,
      OPENAI_CONVERSATIONS_URL,
      ANTHROPIC_URL,
      GOOGLE_URL_TMPL,
      GOOGLE_INTERACTIONS_URL,
      MODEL_REGISTRY,
      authValidToken,
      getActiveChatPrompt,
      upsertPrompt,
      addWordClick,
      updateWordClick,
      recordAnyCall,
      logTextCallRequest,
      logTextCallResponse,
      buildIoResponse,
      computeCost,
      extractEffectiveCallParams,
      lexNotifyBalanceMaybeChanged,
      logContextTrace,
      resolvePageType,
      resolveCallSessionId,
      ensureSessionForTab,
      ensureStandaloneSessionForTab,
      forgetSessionId,
      forgetStandaloneSessionId,
      extractRealVideoId,
    } = deps;

    // Registry facts live in model-registry.js, which loads in both realms —
    // there is nothing platform-shaped about them, so they are read here
    // rather than injected. Same for the routing sets below: which OpenAI ids
    // go through the Responses API is a fact about the provider, not about the
    // host, and injecting it would have given the web a second copy to drift.
    const USES_RESPONSES_API = new Set([
      'gpt-5-5-off', 'gpt-5-5-hi',
      'gpt-5-5-pro-off',
      'gpt-5-4-m-off', 'gpt-5-4-m-hi',
      'gpt-5-4-n-off',
      // Hidden legacy slots (CSS-suppressed in the model bar) — migrated for
      // consistency so no live OpenAI text path remains on Chat Completions.
      'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano',
    ]);
    const OPENAI_TEXT_API_MODELS = global.LexModelRegistry.openaiTextApiModels;
    const MODEL_PRICING = global.LexModelRegistry.pricing;
    const GOOGLE_TEXT_API_MODELS = global.LexModelRegistry.googleTextApiModels;
    const USES_GOOGLE_INTERACTIONS = global.LexModelRegistry.googleInteractions;

    // --- Generic SSE parser ---
    // Splits an HTTP response body into Server-Sent Events. Each event has an
    // optional `event:` name and one or more `data:` lines joined by \n. Blank
    // lines are event boundaries (per SSE spec). Works for OpenAI (data-only),
    // Anthropic (event + data) and Google (data-only with alt=sse).
    async function readSSEStream(response, onEvent, onRawFrame) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split(/\r?\n\r?\n/);
        buffer = parts.pop();
        for (const part of parts) {
          if (!part.trim()) continue;
          let eventName = null;
          const dataParts = [];
          for (const rawLine of part.split(/\r?\n/)) {
            if (rawLine.startsWith('event:')) {
              eventName = rawLine.slice(6).trim();
            } else if (rawLine.startsWith('data:')) {
              // SSE spec: strip single leading space after `data:`.
              dataParts.push(rawLine.slice(5).replace(/^ /, ''));
            }
          }
          const dataStr = dataParts.join('\n');
          // Lossless raw-frame tap for the text_call_io log. Fires for EVERY frame
          // (incl. data-less keepalives) so nothing slips past the JSON parse.
          // Fire-and-forget — a collector fault must never break streaming.
          if (onRawFrame) { try { onRawFrame({ event: eventName, data: dataStr }); } catch (e) {} }
          if (dataParts.length === 0) continue;
          onEvent({ event: eventName, data: dataStr });
        }
      }
    }

    // --- Server proxy (llm-proxy Edge Function) ------------------------------
    // Wave 1: text model calls route through the Lex server proxy instead of
    // hitting the provider directly. The proxy holds the provider key server-side,
    // gates on the caller's account, and streams the provider's SSE bytes back
    // UNCHANGED (plus one trailing `lex_proxy_done` frame) — so the SW's existing
    // readSSEStream + onChunk/onModel/onUsage parsing is untouched; only the fetch
    // target and auth headers change. See docs/SERVER-PROXY-DESIGN.md.
    //   proxy = { kind: 'openai-chat'|'openai-responses'|'anthropic'|'google',
    //             token: <user JWT>, meta: {...Lex-domain fields for the calls row} }
    function proxyFetch(proxy, providerBody, signal) {
      const url = `${lexSbUrl()}/functions/v1/llm-proxy/${proxy.kind}`;
      return fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${proxy.token}`,
          apikey: lexAnonKey(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ meta: proxy.meta || {}, providerRequestBody: providerBody }),
        signal,
      });
    }

    // visual денег и настроек (заход 3): llm-proxy отвечает 402 на zero_balance
    // (см. lex_precall gate; подписку убрали 2026-07-06) — единая точка, чтобы все
    // текстовые адаптеры показывали ОДНО и то же дружелюбное сообщение вместо сырого
    // "OpenAI 402: {...}". Возвращает Error с флагом .lexBillingGate=true, если
    // status===402 — вызыватель throw'ает его ВМЕСТО генерик-ошибки; иначе null,
    // генерик-путь не тронут (401/5xx и т.п. остаются подробными для отладки).
    function lexBillingGateError(status) {
      if (status !== 402) return null;
      const e = new Error('LEX_BILLING_GATE');
      e.lexBillingGate = true;
      return e;
    }

    // ── «Этот чат заполнен» ────────────────────────────────────────────────
    // Своего потолка на переписку у нас нет (снят 2026-08-14) — границу
    // назначает окно модели. Упор в неё приходит ДВУМЯ разными путями, и оба
    // обязаны выглядеть для человека одинаково:
    //
    //   1. 413 + stage 'context_overflow'  — провайдер отказал, llm-proxy свёл
    //      три разные формы отказа к одному коду. Генерации не было, резерв
    //      денег снят сервером.
    //   2. 413 + stage 'body_too_large'    — упёрлись в НАШ потолок тела (5 МБ)
    //      РАНЬШЕ провайдера. Для моделей с окном в миллион токенов это как раз
    //      та стена, которая срабатывает первой (сверено вживую 2026-08-14:
    //      gpt-5.4-nano и gemini-3.1-flash-lite приняли 900k токенов).
    //
    // Гейтимся по СТАДИИ, а не по голому 413: чужой 413 не должен превращаться
    // в «чат заполнен».
    function lexContextOverflowError(response) {
      if (!response || response.status !== 413) return null;
      const stage = (response.headers && typeof response.headers.get === 'function')
        ? String(response.headers.get('x-lex-proxy-stage') || '') : '';
      if (stage !== 'context_overflow' && stage !== 'body_too_large') return null;
      const e = new Error('LEX_CONTEXT_OVERFLOW');
      e.lexContextOverflow = true;
      return e;
    }

    // Третий путь: провайдер ответил 200, но пустым — места хватило на вход и
    // не хватило на выход. Сервер помечает это полем в терминальном кадре.
    // Бросаем ТОТ ЖЕ маркер: человеку это ровно то же событие.
    function throwIfContextOverflow(done) {
      if (done && done.contextOverflow) {
        const e = new Error('LEX_CONTEXT_OVERFLOW');
        e.lexContextOverflow = true;
        throw e;
      }
    }

    // Session gate (block session_gate): llm-proxy answers 409 + header
    // x-lex-proxy-stage: session when a paid text call carried no valid session (race
    // after activation, or an SPA nav dropped it — see lex_precall p_require_session).
    // Returns a RETRYABLE marker (.lexNoSession=true); streamExplainWord catches it,
    // awaits ensureSessionForTab, and retries once. Keyed on the stage header, not the
    // bare 409, so an unrelated 409 (e.g. voice_busy) is NOT mistaken for it.
    function lexNoSessionError(response) {
      if (!response || response.status !== 409) return null;
      const stage = (response.headers && typeof response.headers.get === 'function')
        ? response.headers.get('x-lex-proxy-stage') : null;
      if (stage !== 'session') return null;
      const e = new Error('LEX_NO_SESSION_RETRY');
      e.lexNoSession = true;
      return e;
    }

    // Wave 2a: multipart variant for the audio kinds (ASR / SpeechAce). The caller
    // builds the exact provider FormData and appends a `meta` field (JSON string);
    // the proxy forwards everything except `meta` to the provider with a server-held
    // key, returns the provider JSON unchanged, and writes the calls row. Do NOT set
    // Content-Type — fetch derives the multipart boundary from the FormData body.
    function proxyFetchMultipart(kind, formData, token, signal) {
      const url = `${lexSbUrl()}/functions/v1/llm-proxy/${kind}`;
      return fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, apikey: lexAnonKey() },
        body: formData,
        signal,
      });
    }

    // Wave 2c: plain-JSON proxy POST for the voice kinds (voice-token-openai /
    // voice-token-gemini / voice-usage-report) — body is the raw object, not the
    // {meta, providerRequestBody} text envelope.
    function proxyPostJson(kind, bodyObj, token, signal) {
      const url = `${lexSbUrl()}/functions/v1/llm-proxy/${kind}`;
      return fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, apikey: lexAnonKey(), 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyObj || {}),
        signal,
      });
    }

    // Wave 2b: ytjar step 1 (mp3-link resolution) via the proxy. The server holds
    // RAPIDAPI_KEY and runs the GET + poll loop; we get back { status:'ok', link }.
    // The caller then downloads the mp3 from that CDN link directly (step 2 stays
    // client-side — the 123tokyo.xyz CDN 404s the server's datacentre IP). JSON
    // in/out, no provider-body envelope. Throws on any non-ok / missing link.
    async function proxyFetchYtjarLink(videoId, proxyToken, signal) {
      const url = `${lexSbUrl()}/functions/v1/llm-proxy/ytjar-dl`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${proxyToken}`,
          apikey: lexAnonKey(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ videoId }),
        signal,
      });
      let j = null;
      try { j = await resp.json(); } catch { /* handled below */ }
      if (!resp.ok || !j || !j.link) {
        // Денег нет — общий маркер: на видео без субтитров это ПЕРВЫЙ платный шаг,
        // и без него отказ приезжал в панель строкой «ytjar link resolution failed:
        // balance depleted».
        if (resp.status === 402) throw new Error('LEX_BILLING_GATE');
        const msg = (j && (j.error || j.status)) || `ytjar proxy HTTP ${resp.status}`;
        throw new Error(`ytjar link resolution failed: ${msg}`);
      }
      return j.link;
    }

    // --- Provider adapters ---------------------------------------------------
    // Common signature:
    //   ({ model, systemPrompt, userMessage?, messages?, onChunk, onModel, onUsage,
    //      signal, ...providerOpts }) => Promise<void>
    // onChunk(text)   — called for each delta text token
    // onModel(name)   — called once with the actual model string reported by the API
    // onUsage({input, output}) — called once when usage data lands
    //
    // `messages` (optional) is a chat-style array [{role:'user'|'assistant', content}, …]
    // used by the chat MVP to send full history. When `messages` is provided it
    // fully replaces userMessage. Backward compatibility for preprocess /
    // single-shot callers is preserved via `userMessage`.

    // --- Neutral content form (attachments) ------------------------------------
    // A message's `content` is EITHER a plain string — every message without an
    // attachment, and every client shipped before attachments existed — OR an array
    // of neutral blocks:
    //
    //   [ { type: 'text',  text: '…' },
    //     { type: 'image', mime: 'image/jpeg', data: '<base64>' } ]
    //
    // Contract (documented in docs/UNIFIED-CONTEXT.md §7):
    //   - The text block comes FIRST. llm-proxy's word-card prefix injector writes
    //     into the leading text-bearing block, and reading order matters to models.
    //   - `data` is BARE base64 with no `data:<mime>;base64,` prefix — the same
    //     thing blobToBase64 already produces for the bench audio channel.
    //   - One image per message. Nothing needs more yet.
    //
    // The string form is passed through untouched by every converter below, so a
    // request from a client that has never heard of blocks is byte-identical to
    // what it was before this code existed. That is the backward-compatibility
    // guarantee, and it is why each converter tests for the array and returns
    // early rather than rebuilding the string case.
    const NEUTRAL_IMAGE_MIME_DEFAULT = 'image/jpeg';

    function neutralBlockIsImage(b) {
      return !!(b && b.type === 'image' && typeof b.data === 'string' && b.data);
    }
    function neutralBlockMime(b) {
      return (b && typeof b.mime === 'string' && b.mime) ? b.mime : NEUTRAL_IMAGE_MIME_DEFAULT;
    }
    function neutralBlockText(b) {
      return String((b && b.text) || '');
    }
    // Collapse blocks to their text. Used for roles/fields that cannot carry an
    // image at all — an image is dropped, the words survive. Never used on the
    // user turn of a provider that understands images.
    function neutralBlocksToText(content) {
      if (!Array.isArray(content)) return String(content ?? '');
      return content.filter((b) => b && b.type === 'text').map(neutralBlockText).join('\n\n');
    }

    // Translate one neutral content value into a provider dialect. Non-array
    // content (the string case) is returned by identity — see the guarantee above.
    //
    // Images ride on the user turn only. An assistant turn never has one in this
    // product, so if a stored assistant turn ever arrives in block form it is
    // flattened to text rather than sent in a shape the API would reject.
    function contentToDialect(role, content, dialect) {
      if (!Array.isArray(content)) return content;
      if (role !== 'user') return neutralBlocksToText(content);
      switch (dialect) {
        case 'openai-responses':
          return content.map((b) => (neutralBlockIsImage(b)
            ? { type: 'input_image', image_url: `data:${neutralBlockMime(b)};base64,${b.data}` }
            : { type: 'input_text', text: neutralBlockText(b) }));
        case 'openai-chat':
          return content.map((b) => (neutralBlockIsImage(b)
            ? { type: 'image_url', image_url: { url: `data:${neutralBlockMime(b)};base64,${b.data}` } }
            : { type: 'text', text: neutralBlockText(b) }));
        case 'anthropic':
          return content.map((b) => (neutralBlockIsImage(b)
            ? { type: 'image', source: { type: 'base64', media_type: neutralBlockMime(b), data: b.data } }
            : { type: 'text', text: neutralBlockText(b) }));
        default:
          // Unknown dialect: degrade to text rather than hand the provider a shape
          // it will reject. Loud, because it means a caller was not updated.
          console.warn(TAG, 'contentToDialect: unknown dialect', dialect, '— attachment dropped, text kept');
          return neutralBlocksToText(content);
      }
    }

    // Convert a universal chat-history array (roles 'user'|'assistant') into the
    // shape each provider expects. `dialect` picks the attachment form: the three
    // callers below use incompatible block shapes for the same picture, so the
    // normalizer cannot stay provider-agnostic once content can be an array.
    // For Google it remaps role 'assistant' → 'model' and wraps content in
    // {parts:[…]}.
    function normalizeMessagesForOpenAIAnthropic(messages, userMessage, dialect) {
      if (Array.isArray(messages) && messages.length) {
        return messages.map((m) => ({ role: m.role, content: contentToDialect(m.role, m.content, dialect) }));
      }
      return [{ role: 'user', content: contentToDialect('user', userMessage, dialect) }];
    }

    function normalizeMessagesForGoogle(messages, userMessage) {
      // Google's part shape is `inline_data` in snake_case, mirroring the one REST
      // precedent in this file (runBenchGeminiText, the pronunciation bench, which
      // sends WAV the same way). The camelCase `inlineData` seen elsewhere in the
      // repo belongs to the Live/BidiGenerateContent WebSocket API — a different
      // endpoint, do not copy its casing here.
      const toParts = (role, content) => {
        if (!Array.isArray(content)) return [{ text: content }];
        if (role !== 'user') return [{ text: neutralBlocksToText(content) }];
        return content.map((b) => (neutralBlockIsImage(b)
          ? { inline_data: { mime_type: neutralBlockMime(b), data: b.data } }
          : { text: neutralBlockText(b) }));
      };
      if (Array.isArray(messages) && messages.length) {
        const filtered = [];
        for (const m of messages) {
          // Google encodes the system prompt separately in `systemInstruction` —
          // there's no place for role:'system' inside `contents`. Defensive drop
          // (with a warning) so a stray system message in chat history never
          // leaks past the boundary.
          if (m.role === 'system') {
            console.warn(TAG, 'normalizeMessagesForGoogle: dropping role:system message — system goes in systemInstruction');
            continue;
          }
          filtered.push({
            role: m.role === 'assistant' ? 'model' : m.role,
            parts: toParts(m.role, m.content),
          });
        }
        return filtered;
      }
      return [{ role: 'user', parts: toParts('user', userMessage) }];
    }

    // Settings-knobs application (1.4.1). The chat-panel gear popover collects
    // 7 knobs; shared.js sends them as `message.knobs = {temperature, maxTokens,
    // seed, verbosity, serviceTier, voiceName, voiceSpeed}`. Each adapter pulls
    // what its API understands and skips the rest. Capability matrix mirrors
    // shared.js knobSupports — sending unsupported params returns 400 from
    // reasoning models, so we gate carefully.
    //
    // Empirical findings (verified against production endpoints):
    //   - OpenAI Responses API: temperature accepted on effort='none' models
    //     (gpt-5.4-nano, gpt-5-5-off), rejected on effort='high'/'medium'.
    //   - OpenAI Responses API: seed rejected with "Unknown parameter: 'seed'"
    //     on all models. seed only works on Chat Completions endpoint.
    //   - OpenAI Responses API: service_tier accepted top-level.
    //   - text.verbosity: Responses API only.
    function isActivelyReasoning(entry) {
      if (!entry) return false;
      if (entry.thinkingDefault) return true;       // Anthropic adaptive thinking baked in
      if (entry.thinkingLevel) return true;         // Gemini thinking-level variants
      // OpenAI reasoning_effort: 'none'/'minimal' = practically off, temperature OK.
      // 'low'/'medium'/'high'/'max' = active reasoning, temperature rejected.
      if (entry.provider === 'openai' && entry.effort && entry.effort !== 'none' && entry.effort !== 'minimal') return true;
      return false;
    }
    function knobNumberOrNull(v) {
      if (v == null || v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }

    // The Creativity slider's UI range (0..2, settings-popover.js) is shared
    // across all three providers. Anthropic's Messages API rejects temperature
    // outside 0..1 (empirically verified live, 2026-07-01: 400 "temperature:
    // range: 0..1") — narrower than the shared slider, unlike OpenAI/Google.
    // Clamp per-provider here rather than lowering the shared markup for every
    // provider.
    function clampTemperatureForProvider(provider, t) {
      if (provider === 'anthropic') return Math.max(0, Math.min(1, t));
      return t;
    }

    async function callOpenAIStream({ model, systemPrompt, userMessage, messages, onChunk, onModel, onUsage, onBilled, onRequestBody, signal, effort, knobs, modelId, proxy }) {
      const apiKey = proxy ? null : await getApiKey();
      if (!proxy && !apiKey) throw new Error('OpenAI API key not set. Open extension settings.');

      const body = {
        model,
        stream: true,
        // Emits a final chunk with `usage: { prompt_tokens, completion_tokens, ... }`.
        stream_options: { include_usage: true },
        // No systemPrompt + proxy = the server owns it (docs/PLAN-PROMPTS-SERVER.md):
        // llm-proxy unshifts the system message itself. The field must be ABSENT,
        // not empty — an empty system message is a real message the model reads as
        // "your instructions are: nothing".
        messages: [
          ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
          ...normalizeMessagesForOpenAIAnthropic(messages, userMessage, 'openai-chat'),
        ],
      };
      // OpenAI reasoning_effort: 'none' | 'low' | 'medium' | 'high'. Passed through
      // when the registry entry sets it; older non-reasoning models don't accept
      // the parameter, so we omit it when effort is null/undefined.
      if (effort) body.reasoning_effort = effort;
      // Knobs (1.4.1). Chat Completions accepts temperature, max_completion_tokens,
      // seed, service_tier on non-actively-reasoning models. Skip temperature
      // on active reasoning (effort > 'none').
      if (knobs) {
        const entry = modelId ? resolveModelEntry(modelId) : null;
        const tempN = knobNumberOrNull(knobs.temperature);
        if (tempN != null && !isActivelyReasoning(entry)) body.temperature = tempN;
        const maxN = knobNumberOrNull(knobs.maxTokens);
        if (maxN != null) body.max_completion_tokens = maxN;
        const seedN = knobNumberOrNull(knobs.seed);
        if (seedN != null) body.seed = seedN;
        if (knobs.serviceTier && knobs.serviceTier !== 'auto') body.service_tier = knobs.serviceTier;
      }

      logContextTrace({
        provider: 'openai-chat',
        model,
        mode: 'continue-thread', // Chat Completions has no server-side thread; full history each call
        sent_messages: body.messages?.length ?? null,
        hydration: null,
      }, body);
      onRequestBody?.(body, OPENAI_URL);

      const response = proxy
        ? await proxyFetch(proxy, body, signal)
        : await fetch(OPENAI_URL, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal,
        });
      if (!response.ok) {
        const gateErr = lexBillingGateError(response.status);
        if (gateErr) throw gateErr;
        const overflow = lexContextOverflowError(response);
        if (overflow) throw overflow;
        const noSess = lexNoSessionError(response);
        if (noSess) throw noSess;
        const errText = await response.text();
        throw new Error(`OpenAI ${response.status}: ${errText.substring(0, 200)}`);
      }

      let modelEmitted = false;
      let proxyDoneSeen = false;
      await readSSEStream(response, ({ event, data }) => {
        if (event === 'lex_proxy_done') {
          proxyDoneSeen = true;
          // Server-authoritative marked-up price (raw × price_multiplier = the
          // exact balance_ledger debit). Split preserved for the two chat pills.
          // The client only DISPLAYS these; it never sees the multiplier itself.
          // ⚠ Флаг ставится ВНУТРИ try, а бросок стоит СНАРУЖИ. Этот catch
          // существует, чтобы кривой кадр не ронял ответ, — и он проглотил бы
          // наш маркер переполнения вместе с ним.
          let overflowFrame = false;
          try {
            const d = JSON.parse(data);
            onBilled?.({ inputCost: d.billedInputCostUsd, outputCost: d.billedOutputCostUsd });
            overflowFrame = !!(d && d.contextOverflow);
          } catch { /* frame parse failure → fall back to local computeCost */ }
          if (overflowFrame) throwIfContextOverflow({ contextOverflow: true });
          return;
        }
        if (!data || data === '[DONE]') return;
        let parsed;
        try { parsed = JSON.parse(data); } catch { return; }
        if (!modelEmitted && parsed.model) {
          onModel?.(parsed.model);
          modelEmitted = true;
        }
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) onChunk(delta);
        if (parsed.usage) {
          onUsage?.({ input: parsed.usage.prompt_tokens ?? null, output: parsed.usage.completion_tokens ?? null });
        }
      });
      if (proxy && !proxyDoneSeen) throw new Error('Ответ оборван: соединение с сервером прервалось до конца ответа.');
    }

    // OpenAI Responses API — newer transport with server-side conversation state.
    // Same role as callOpenAIStream but instructions live at the top level (not
    // in the messages array) and chat-turn continuity flows through
    // previous_response_id rather than re-sending the full history each turn.
    //
    // Two paths:
    //   (1) `previousResponseId` is set → chain to that prior response. We send
    //       only the new user message in `input`. OpenAI fetches the prior
    //       context server-side. This is the fast path.
    //   (2) Fallback / first turn → send the full message array as `input`
    //       (Responses also accepts the message-array form). This is what we
    //       use when the prior responseId expired or doesn't exist yet.
    //
    // `effort` ('none'|'low'|'medium'|'high'|'xhigh') goes into the nested form
    // `reasoning: { effort }`. The top-level `reasoning_effort` shape used by
    // Chat Completions is rejected here ("Unsupported parameter").
    // POST /v1/conversations — create a new server-side conversation container.
    // Returns { id: 'conv_...' }. Body always carries metadata (empty {} accepted
    // by the API but we always send something for traceability via the OpenAI
    // dashboard). When developerPromptText is non-empty, a developer-role
    // message is seeded as the first item of the thread — this is how the
    // system prompt is persisted in the conversation (instead of being
    // repeated via body.instructions on every turn). One retry with 1s
    // backoff on network error / 5xx. 4xx fails immediately.
    async function createOpenAIConversation(metadata = {}, developerInput) {
      const apiKey = await getApiKey();
      if (!apiKey) throw new Error('OpenAI API key not set. Open extension settings.');
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      };
      const payload = { metadata };
      // 1.5.10: developerInput accepts either a string (legacy: one developer
      // item with the chat-prompt) or an array of {role, text} (silent seed:
      // chat-prompt + video transcript as separate developer items).
      const itemsRaw = Array.isArray(developerInput)
        ? developerInput
        : (developerInput && developerInput.trim() ? [{ role: 'developer', text: developerInput }] : []);
      const items = itemsRaw
        .filter((it) => it && typeof it.text === 'string' && it.text.length > 0)
        .map((it) => ({
          type: 'message',
          role: it.role || 'developer',
          content: [{ type: 'input_text', text: it.text }],
        }));
      if (items.length > 0) payload.items = items;
      const body = JSON.stringify(payload);
      let lastErr = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const resp = await fetch(OPENAI_CONVERSATIONS_URL, { method: 'POST', headers, body });
          if (resp.ok) {
            const json = await resp.json();
            if (!json?.id) throw new Error('Conversations API: response missing id');
            return json.id;
          }
          const errText = await resp.text();
          // 4xx — non-retryable (bad key, malformed request, etc.)
          if (resp.status >= 400 && resp.status < 500) {
            throw new Error(`Conversations API ${resp.status}: ${errText.slice(0, 200)}`);
          }
          // 5xx — retryable
          lastErr = new Error(`Conversations API ${resp.status}: ${errText.slice(0, 200)}`);
        } catch (e) {
          // network errors and the throws above (4xx already re-thrown via throw, not lastErr)
          if (e.message?.startsWith('Conversations API 4')) throw e;
          lastErr = e;
        }
        if (attempt === 0) await new Promise(r => setTimeout(r, 1000));
      }
      throw new Error(`createOpenAIConversation failed after retry: ${lastErr?.message || 'unknown'}`);
    }

    // POST /v1/conversations/{id}/items — append finalized turns into an
    // existing conversation. Used by the realtime voice/PTT flow after a
    // session closes: spoken transcripts are mirrored into the per-video
    // thread so the text-mode model sees what was discussed by voice.
    //
    // `items` is the buffer shape from shared.js flushTranscriptBuffer:
    // [{role: 'user'|'assistant', text, item_id}]. We translate to the
    // REST Conversations API shape here:
    //   user      → { type:'message', role:'user',      content:[{type:'input_text',  text}] }
    //   assistant → { type:'message', role:'assistant', content:[{type:'output_text', text}] }
    // (Note: REST format differs from realtime DataChannel format — assistant
    // content type is 'output_text' for REST, 'output_text' for WebRTC realtime,
    // 'text' for WebSocket realtime. Confirmed by previous probes.)
    // OpenAI Conversations API caps `items` at 20 per POST. Longer payloads
    // (typically cross-provider hydration after long Realtime voice sessions)
    // must be split into sequential batches — a single POST > 20 returns 400
    // "Invalid 'items': array too long" and drops the whole hydration.
    const OPENAI_CONVERSATION_ITEMS_BATCH = 20;

    async function appendConversationItems(conversationId, items) {
      if (!conversationId) throw new Error('appendConversationItems: conversationId required');
      if (!Array.isArray(items) || items.length === 0) return { appended: 0 };
      const apiKey = await getApiKey();
      if (!apiKey) throw new Error('OpenAI API key not set.');
      // 1.5.10: support 'developer' role too (silent context seeding).
      const restItems = items
        .filter((it) => it && (it.role === 'user' || it.role === 'assistant' || it.role === 'developer') && typeof it.text === 'string' && it.text.length > 0)
        .map((it) => ({
          type: 'message',
          role: it.role,
          content: [{
            type: it.role === 'assistant' ? 'output_text' : 'input_text',
            text: it.text,
          }],
        }));
      if (restItems.length === 0) return { appended: 0 };
      const url = `${OPENAI_CONVERSATIONS_URL}/${encodeURIComponent(conversationId)}/items`;
      const headers = {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      };
      let appended = 0;
      for (let offset = 0; offset < restItems.length; offset += OPENAI_CONVERSATION_ITEMS_BATCH) {
        const batch = restItems.slice(offset, offset + OPENAI_CONVERSATION_ITEMS_BATCH);
        const body = JSON.stringify({ items: batch });
        const resp = await fetch(url, { method: 'POST', headers, body });
        if (!resp.ok) {
          const errText = await resp.text();
          throw new Error(`appendConversationItems ${resp.status} (batch ${offset}-${offset + batch.length}/${restItems.length}, ${appended} already appended): ${errText.slice(0, 200)}`);
        }
        appended += batch.length;
      }
      return { appended };
    }

    // In-flight deduplication. If two callers race ensureConversation for the same
    // new videoId, only one will actually hit the API; the second awaits the same
    // promise. JS single-threaded sync windows make the read+set sequence safe.
    const ensureConversationInFlight = new Map(); // videoId → Promise<conversationId>

    // Get-or-create a server-side conversation for a video. Idempotent: if a
    // thread already exists with a conversationId, returns it without a network
    // hit. If the thread exists but lacks conversationId (prior creation crashed
    // after createVideoThread but before updateConversationId), tops it up.
    // Concurrent calls for the same videoId share one in-flight promise.

    async function ensureConversation(videoId, modelId) {
      if (!videoId) throw new Error('ensureConversation: videoId required');
      const existing = await videoThreads.getVideoThread(videoId);
      if (existing?.conversationId) return existing.conversationId;
      const inFlight = ensureConversationInFlight.get(videoId);
      if (inFlight) return inFlight;
      const promise = (async () => {
        try {
          let thread = existing;
          if (!thread) {
            thread = await videoThreads.createVideoThread(videoId, modelId);
          }
          // Read the active teacher prompt from storage and seed it as the
          // first developer-role item of the new conversation. Empty text is
          // not a blocker: createOpenAIConversation will simply skip the
          // items field and the thread will start without a system prompt
          // (degraded quality, but the extension still works).
          const { text: developerPromptText } = await getActiveChatPrompt();
          // 1.5.6: cross-model note removed — role labels suffice.
          const conversationId = await createOpenAIConversation({
            videoId,
            modelId,
            source: 'lex-extension',
            createdBy: 'ensureConversation',
          }, developerPromptText || '');
          await videoThreads.updateConversationId(videoId, conversationId);
          // 1.5.40 (B2): freeze the developer-item snapshot. From here on every
          // OpenAI call on this video sees this text — even if the user later
          // edits the active chat-prompt slot, the OpenAI container keeps the
          // original. recordCall reads this back to populate prompts.text
          // accurately for OpenAI calls.
          try {
            await videoThreads.setDeveloperPromptText(videoId, developerPromptText || '');
          } catch (err) {
            console.warn(TAG, 'setDeveloperPromptText failed (non-fatal):', err.message);
          }
          return conversationId;
        } finally {
          ensureConversationInFlight.delete(videoId);
        }
      })();
      ensureConversationInFlight.set(videoId, promise);
      return promise;
    }

    async function callOpenAIResponsesStream({
      model, systemPrompt, userMessage, messages, previousResponseId,
      onChunk, onModel, onUsage, onBilled, onResponseId, onServerTiming, onRequestBody, onResponseMeta, onRawFrame, signal, effort,
      conversation, videoId, knobs, modelId, __diagMark, proxy,
    }) {
      const apiKey = proxy ? null : await getApiKey();
      if (!proxy && !apiKey) throw new Error('OpenAI API key not set. Open extension settings.');

      // Build the input. With previousResponseId we send only the new user turn —
      // OpenAI joins it to the prior context. Without it, we send the full
      // history (or the synthetic "Word: …" payload for first-click word flow).
      let input;
      if (previousResponseId) {
        input = userMessage;
      } else if (Array.isArray(messages) && messages.length > 0) {
        // Reuse the same OpenAI/Anthropic message normalization helper. The
        // Responses API accepts the same {role, content} shape in input.
        input = normalizeMessagesForOpenAIAnthropic(messages, userMessage, 'openai-responses');
      } else {
        input = userMessage;
      }

      // text.verbosity defaults to 'medium' but the gear popover can override
      // it (low / medium / high). Read from knobs first.
      const verbosity = (knobs && ['low', 'medium', 'high'].includes(knobs.verbosity))
        ? knobs.verbosity
        : 'medium';

      const body = {
        model,
        // Omitted when the server owns the prompt — llm-proxy then puts it into
        // `input` as a leading developer message, NOT into `instructions`, because
        // the Responses API echoes `instructions` back in every response frame.
        ...(systemPrompt ? { instructions: systemPrompt } : {}),
        input,
        stream: true,
        store: true,
        text: { verbosity },
        context_management: [{ type: 'compaction', compact_threshold: 200000 }],
      };
      if (videoId) body.prompt_cache_key = videoId;
      if (previousResponseId) body.previous_response_id = previousResponseId;
      // `conversation` is OpenAI Conversations API: when set, items (user input +
      // assistant output) are persisted server-side under that conversation. Used
      // by the teacher-intro stream so subsequent word-click / chat turns can
      // share continuity. Mutually exclusive with previousResponseId in our usage
      // (caller picks one).
      if (conversation) body.conversation = conversation;
      if (effort) body.reasoning = { effort };
      // Knobs (1.4.1). Responses API:
      //   - temperature: accepted on effort='none' models (gpt-5.4-nano,
      //     gpt-5-5-off), rejected on active reasoning. Empirically verified.
      //   - max_output_tokens: always accepted.
      //   - seed: REJECTED with "Unknown parameter: 'seed'" — Responses API
      //     doesn't support it. Don't send.
      //   - service_tier: accepted top-level.
      if (knobs) {
        const entry = modelId ? resolveModelEntry(modelId) : null;
        const tempN = knobNumberOrNull(knobs.temperature);
        if (tempN != null && !isActivelyReasoning(entry)) body.temperature = tempN;
        const maxN = knobNumberOrNull(knobs.maxTokens);
        if (maxN != null) body.max_output_tokens = maxN;
        if (knobs.serviceTier && knobs.serviceTier !== 'auto') body.service_tier = knobs.serviceTier;
      }
      // Молчаливое обрезание — ЗАПРЕЩЕНО, и это сказано явно.
      // У Responses API есть `truncation`, и в режиме 'auto' он на переполнении
      // сам ВЫБРАСЫВАЕТ часть сообщений из середины разговора и отвечает как ни
      // в чём не бывало. Для нас это худший исход: потолка на переписку больше
      // нет, человек видит на экране весь чат, а учитель молча получил бы не
      // весь — без единого следа. Умолчание API и так 'disabled' (сверено
      // 2026-08-14: параметр не ставился нигде), но умолчание провайдера может
      // смениться, а строчка здесь — нет. У Anthropic и Google аналога нет
      // вовсе: оба на переполнении отказывают, ничего не выбрасывая.
      body.truncation = 'disabled';

      logContextTrace({
        provider: 'openai-responses',
        model,
        mode: body.previous_response_id ? 'continue-thread'
            : body.conversation ? 'conversation-attached'
            : 'new-thread',
        sent_messages: Array.isArray(body.input) ? body.input.length : 1,
        hydration: null,
      }, body);
      onRequestBody?.(body, OPENAI_RESPONSES_URL);

      __diagMark?.('openai:body_built');
      const response = proxy
        ? await proxyFetch(proxy, body, signal)
        : await fetch(OPENAI_RESPONSES_URL, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal,
        });
      __diagMark?.('openai:fetch_returned');
      if (!response.ok) {
        const gateErr = lexBillingGateError(response.status);
        if (gateErr) throw gateErr;
        const overflow = lexContextOverflowError(response);
        if (overflow) throw overflow;
        const noSess = lexNoSessionError(response);
        if (noSess) throw noSess;
        const errText = await response.text();
        // Bubble up the raw status + body — the dispatcher inspects this to
        // decide whether to retry without previous_response_id (e.g. the
        // chained response expired or was deleted).
        const err = new Error(`OpenAI Responses ${response.status}: ${errText.substring(0, 300)}`);
        err.status = response.status;
        err.responseBody = errText;
        throw err;
      }

      let modelEmitted = false;
      let respIdEmitted = false;
      let fullUsage = null;
      let finishReason = null;
      let reasoningText = '';
      let proxyDoneSeen = false;
      await readSSEStream(response, ({ event, data }) => {
        // Server-proxy terminal marker: the ONLY signal of a clean end when
        // proxied. Its absence (stream just closed) means the proxy/provider was
        // cut off (timeout/kill) → treated as an error below, never a false DONE.
        if (event === 'lex_proxy_done') {
          proxyDoneSeen = true;
          // Server-authoritative marked-up price (raw × price_multiplier = the
          // exact balance_ledger debit). Split preserved for the two chat pills.
          // The client only DISPLAYS these; it never sees the multiplier itself.
          // ⚠ Флаг ставится ВНУТРИ try, а бросок стоит СНАРУЖИ. Этот catch
          // существует, чтобы кривой кадр не ронял ответ, — и он проглотил бы
          // наш маркер переполнения вместе с ним.
          let overflowFrame = false;
          try {
            const d = JSON.parse(data);
            onBilled?.({ inputCost: d.billedInputCostUsd, outputCost: d.billedOutputCostUsd });
            overflowFrame = !!(d && d.contextOverflow);
          } catch { /* frame parse failure → fall back to local computeCost */ }
          if (overflowFrame) throwIfContextOverflow({ contextOverflow: true });
          return;
        }
        if (!data) return;
        let parsed;
        try { parsed = JSON.parse(data); } catch { return; }
        const evType = event || parsed.type;
        if (evType === 'response.created') {
          const id = parsed.response?.id || parsed.id;
          if (id && !respIdEmitted) {
            onResponseId?.(id);
            respIdEmitted = true;
          }
          const actualModel = parsed.response?.model;
          if (actualModel && !modelEmitted) {
            onModel?.(actualModel);
            modelEmitted = true;
          }
          return;
        }
        if (evType === 'response.output_text.delta') {
          const delta = parsed.delta;
          if (delta) onChunk(delta);
          return;
        }
        if (evType === 'response.reasoning_summary_text.delta' || evType === 'response.reasoning_text.delta') {
          if (typeof parsed.delta === 'string') reasoningText += parsed.delta;
          return;
        }
        if (evType === 'response.completed') {
          __diagMark?.('openai:response.completed');
          fullUsage = parsed.response?.usage || fullUsage;
          {
            const st = parsed.response?.status;
            const inc = parsed.response?.incomplete_details?.reason;
            if (st) finishReason = inc ? `${st} (${inc})` : st;
          }
          // response.completed is the only event with authoritative usage.
          // input_tokens is the TOTAL prompt count; the cached portion is a
          // SUBSET reported under input_tokens_details.cached_tokens
          // (OpenAI cookbook 2026-05-07: "indicating how many of the prompt
          // tokens were a cache hit"). cacheCreation = 0 — OpenAI has no
          // separate write tariff.
          const usage = parsed.response?.usage;
          if (usage) {
            onUsage?.({
              input: usage.input_tokens ?? null,
              cachedInput: usage.input_tokens_details?.cached_tokens ?? 0,
              cacheCreation: 0,
              output: usage.output_tokens ?? null,
            });
          }
          // 1.5.13 server-side processing time. created_at + completed_at are
          // UNIX seconds — the diff is whole seconds (no sub-second precision
          // from OpenAI). Short answers will report 0s; that is the actual
          // resolution OpenAI publishes here.
          const createdAt = parsed.response?.created_at;
          const completedAt = parsed.response?.completed_at;
          if (typeof createdAt === 'number' && typeof completedAt === 'number') {
            // DIAG: log raw integer-second diff to detect quantisation noise
            // separately from the *1000 conversion.
            __diagMark?.(`openai:created_at=${createdAt} completed_at=${completedAt} diff_sec=${completedAt - createdAt}`);
            onServerTiming?.((completedAt - createdAt) * 1000);
          }
          // Late onResponseId / onModel safety nets — usually already fired
          // on response.created, but some streams have surfaced the id only
          // here in early Responses API rollouts.
          const id = parsed.response?.id;
          if (id && !respIdEmitted) {
            onResponseId?.(id);
            respIdEmitted = true;
          }
          const actualModel = parsed.response?.model;
          if (actualModel && !modelEmitted) {
            onModel?.(actualModel);
            modelEmitted = true;
          }
          return;
        }
        if (evType === 'response.failed' || evType === 'error') {
          const errMsg = parsed.response?.error?.message || parsed.message || 'Responses stream failed';
          const err = new Error(`OpenAI Responses event ${evType}: ${errMsg}`);
          err.responsesEvent = evType;
          throw err;
        }
      }, onRawFrame);
      // Proxied stream that ended without the terminal marker = truncation
      // (Edge Function wall-clock kill / dropped connection). Surface as an error
      // rather than a silently-short "success".
      if (proxy && !proxyDoneSeen) {
        const err = new Error('Ответ оборван: соединение с сервером прервалось до конца ответа.');
        err.proxyIncomplete = true;
        throw err;
      }
      try {
        const oaiReasoningTokens = fullUsage?.output_tokens_details?.reasoning_tokens ?? null;
        onResponseMeta?.({
          finish_reason: finishReason,
          usage: fullUsage,
          reasoning: (reasoningText || oaiReasoningTokens != null)
            ? { text: reasoningText || null, tokens: oaiReasoningTokens }
            : null,
        });
      } catch (e) { /* log collection must never break the call */ }
    }

    async function callAnthropicStream({ model, systemPrompt, userMessage, messages, onChunk, onModel, onUsage, onBilled, onServerTiming, onRequestBody, onResponseMeta, onRawFrame, signal, effort, thinking, knobs, modelId, __diagMark, proxy }) {
      // `!proxy &&` — как у соседних адаптеров (OpenAI, Google). Ключ читается
      // ТОЛЬКО в прямой ветке ниже (`x-api-key`); на прокси-пути его ставит
      // сервер. Без этого условия любой host, который провайдерских ключей не
      // держит, получал отказ ещё до запроса — веб-версия ключей не возит и
      // падала на Anthropic, хотя все её вызовы идут через прокси.
      if (!proxy && !ANTHROPIC_API_KEY) throw new Error('Anthropic API key not set.');

      // With thinking enabled or high-effort, max_tokens must cover both reasoning
      // and visible output. Bump the cap for those paths.
      //
      // `thinking` is the flag WE set, and for a synthetic provider:apiModel:effort
      // id it is always false — resolveModelEntry never sets thinkingDefault. That
      // used to be the whole truth: on Opus 4.8 and earlier, omitting the field
      // really did mean the model would not reason. It stopped being true with
      // Opus 5 (thinking on by default when the field is omitted) and Fable 5
      // (thinking cannot be turned off at all). On those two the model reasons on
      // every turn while `thinking` reads false here, and reasoning tokens come
      // out of max_tokens — so the 1024 branch would cut the visible answer off
      // mid-sentence, with no error anywhere to say why. The registry marks those
      // models `thinkingAlwaysOn`; ask it rather than the flag.
      const alwaysThinks = modelId ? LexModelRegistry.thinkingAlwaysOn(modelId) : false;
      const defaultMaxTokens = (thinking || alwaysThinks || effort === 'max' || effort === 'xhigh') ? 4096 : 1024;
      const knobMax = knobs ? knobNumberOrNull(knobs.maxTokens) : null;
      const body = {
        model,
        max_tokens: knobMax ?? defaultMaxTokens,
        stream: true,
        // Absent when the server owns the prompt — llm-proxy writes body.system in
        // the cache_control block form. Sending an empty string here would both
        // waste the cache breakpoint and risk a 400.
        ...(systemPrompt ? { system: systemPrompt } : {}),
        messages: normalizeMessagesForOpenAIAnthropic(messages, userMessage, 'anthropic'),
      };
      // 1.5.30: prompt caching. Two cache_control breakpoints (limit is 4 per
      // request — well under). One on the system prompt (stable across every
      // turn for a given chat-prompt slot), one on the LAST stable message of
      // the history (the penultimate item — the one BEFORE the brand-new user
      // input the caller is asking us to send). Default TTL = 5 minutes
      // (no `ttl` field needed); matches the cacheCreation rate already in
      // MODEL_PRICING (1.25× base input).
      //
      // Cache fires only when the prefix exceeds the per-model minimum
      // (Sonnet 4.6: 2048 tokens; Opus 4.8 / Haiku 4.5: 4096). Below that
      // Anthropic silently processes without caching — no error, just a
      // 0% hit rate.
      //
      // cache_control attaches at the content-block level, so for caching we
      // promote the marked content from a plain string to an array of one
      // text block. Form change is API-equivalent on Anthropic's side.
      if (systemPrompt && String(systemPrompt).length > 0) {
        body.system = [
          { type: 'text', text: String(systemPrompt), cache_control: { type: 'ephemeral' } },
        ];
      }
      //
      // The breakpoint index is fixed at length-2, so an attachment on the NEW user
      // turn (the last message) never disturbs it — the picture simply sits after
      // the breakpoint and is cached from the next turn on. The case that used to
      // break is the mirror one: a message that is ALREADY in block form landing on
      // length-2 (a turn whose assistant half never got written — a cancelled or
      // failed answer — followed by another send). The old `typeof === 'string'`
      // test made the whole branch a no-op there, which does not fail loudly: it
      // silently drops the only message-level breakpoint and re-bills the entire
      // prefix at the full input rate on every subsequent turn. Block content now
      // takes the breakpoint on its LAST block, which is where Anthropic wants it.
      if (Array.isArray(body.messages) && body.messages.length >= 2) {
        const lastStableIdx = body.messages.length - 2;
        const stable = body.messages[lastStableIdx];
        if (stable && typeof stable.content === 'string') {
          body.messages[lastStableIdx] = {
            role: stable.role,
            content: [
              { type: 'text', text: stable.content, cache_control: { type: 'ephemeral' } },
            ],
          };
        } else if (stable && Array.isArray(stable.content) && stable.content.length) {
          const blocks = stable.content.map((b) => Object.assign({}, b));
          const last = blocks.length - 1;
          blocks[last] = Object.assign({}, blocks[last], { cache_control: { type: 'ephemeral' } });
          body.messages[lastStableIdx] = { role: stable.role, content: blocks };
        }
      }
      // Empirically verified: effort goes into a top-level output_config, and
      // thinking is a separate top-level `thinking: {type: 'adaptive'}`. The old
      // combined form `thinking:{type:'adaptive', effort:'low'}` returns 400.
      // 'none' is a UI placeholder for "no effort axis" (Haiku 4.5 — accepts no
      // output_config.effort at all) and must NOT be forwarded to Anthropic;
      // the API rejects 'none' with a 400 ("Input should be 'low', 'medium',
      // 'high', 'xhigh' or 'max'"). Treat it as "skip the field".
      if (effort && effort !== 'none') body.output_config = { effort };
      if (thinking) body.thinking = { type: 'adaptive' };
      // Knob: temperature. Empirically verified:
      //   - thinking active (adaptive) → rejected unless temperature===1.
      //   - Opus 4.8 / Sonnet 5 (any effort) → sampling params removed from the
      //     API entirely, always rejected.
      //   - Sonnet 4.6/Haiku without thinking → accepted on any effort, but only
      //     in 0..1 — the shared UI slider goes to 2 (see clampTemperatureForProvider).
      // Gating is registry-driven (LexModelRegistry.textKnobSupported reads each
      // model's knobQuirks in model-registry.js) so a future model that also
      // drops temperature only needs a registry entry, not a code change here.
      // seed is not supported by the Messages API on any model — silently skipped.
      if (knobs && !thinking) {
        const tempN = knobNumberOrNull(knobs.temperature);
        if (tempN != null && LexModelRegistry.textKnobSupported('temperature', modelId)) {
          body.temperature = clampTemperatureForProvider('anthropic', tempN);
        }
      }

      logContextTrace({
        provider: 'anthropic',
        model,
        // Anthropic has no server-side thread — every call replays full history.
        // mode='continue-thread' when caller passed >1 messages (prior turns
        // reapplied), 'new-thread' for the very first turn.
        mode: (body.messages?.length || 0) > 1 ? 'continue-thread' : 'new-thread',
        sent_messages: body.messages?.length ?? null,
        hydration: null,
      }, body);
      onRequestBody?.(body, ANTHROPIC_URL);

      __diagMark?.('anthropic:body_built');
      const response = proxy
        ? await proxyFetch(proxy, body, signal)
        : await fetch(ANTHROPIC_URL, {
          method: 'POST',
          headers: {
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            // Direct-from-browser opt-in; not sent server-to-server via the proxy.
            'anthropic-dangerous-direct-browser-access': 'true',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal,
        });
      __diagMark?.('anthropic:fetch_returned');
      if (!response.ok) {
        const gateErr = lexBillingGateError(response.status);
        if (gateErr) throw gateErr;
        const overflow = lexContextOverflowError(response);
        if (overflow) throw overflow;
        const noSess = lexNoSessionError(response);
        if (noSess) throw noSess;
        const errText = await response.text();
        throw new Error(`Anthropic ${response.status}: ${errText.substring(0, 200)}`);
      }
      // 1.5.13: Anthropic returns server-side processing time as the
      // `x-envoy-upstream-service-time` HTTP header (milliseconds, integer).
      // Not in the public docs but consistently present on every response.
      const envoyTimeStr = response.headers.get('x-envoy-upstream-service-time');
      if (envoyTimeStr) {
        const ms = parseInt(envoyTimeStr, 10);
        if (Number.isFinite(ms)) onServerTiming?.(ms);
      }

      let modelEmitted = false;
      // Anthropic exposes three DISJOINT input counters (verified against
      // platform.claude.com/docs/.../prompt-caching, 2026-05-07):
      //   input_tokens                — only tokens AFTER the last cache breakpoint
      //   cache_read_input_tokens     — cache hits
      //   cache_creation_input_tokens — cache writes (5-min TTL by default)
      // total input = sum of three. We forward all three so cost can be
      // priced honestly (writes 1.25x base, reads 0.1x base).
      let inputTokensPostBreakpoint = null;
      let cacheReadTokens = null;
      let cacheCreationTokens = null;
      let outputTokens = null;
      let fullUsage = null;
      let finishReason = null;
      let stopSequence = null;
      let thinkingText = '';
      let proxyDoneSeen = false;
      await readSSEStream(response, ({ event, data }) => {
        if (event === 'lex_proxy_done') {
          proxyDoneSeen = true;
          // Server-authoritative marked-up price (raw × price_multiplier = the
          // exact balance_ledger debit). Split preserved for the two chat pills.
          // The client only DISPLAYS these; it never sees the multiplier itself.
          // ⚠ Флаг ставится ВНУТРИ try, а бросок стоит СНАРУЖИ. Этот catch
          // существует, чтобы кривой кадр не ронял ответ, — и он проглотил бы
          // наш маркер переполнения вместе с ним.
          let overflowFrame = false;
          try {
            const d = JSON.parse(data);
            onBilled?.({ inputCost: d.billedInputCostUsd, outputCost: d.billedOutputCostUsd });
            overflowFrame = !!(d && d.contextOverflow);
          } catch { /* frame parse failure → fall back to local computeCost */ }
          if (overflowFrame) throwIfContextOverflow({ contextOverflow: true });
          return;
        }
        if (!data) return;
        let parsed;
        try { parsed = JSON.parse(data); } catch { return; }
        if (!modelEmitted && event === 'message_start' && parsed.message?.model) {
          onModel?.(parsed.message.model);
          modelEmitted = true;
        }
        if (event === 'message_start' && parsed.message?.usage) {
          const u = parsed.message.usage;
          fullUsage = Object.assign({}, fullUsage, u);
          if (typeof u.input_tokens === 'number')               inputTokensPostBreakpoint = u.input_tokens;
          if (typeof u.cache_read_input_tokens === 'number')    cacheReadTokens           = u.cache_read_input_tokens;
          if (typeof u.cache_creation_input_tokens === 'number') cacheCreationTokens      = u.cache_creation_input_tokens;
          if (typeof u.output_tokens === 'number')              outputTokens              = u.output_tokens;
        }
        if (event === 'content_block_delta' && parsed.delta?.text) {
          onChunk(parsed.delta.text);
        }
        if (event === 'content_block_delta' && parsed.delta?.type === 'thinking_delta'
            && typeof parsed.delta.thinking === 'string') {
          thinkingText += parsed.delta.thinking;
        }
        if (event === 'message_delta') {
          __diagMark?.('anthropic:message_delta');
          if (parsed.delta?.stop_reason) finishReason = parsed.delta.stop_reason;
          if (parsed.delta?.stop_sequence) stopSequence = parsed.delta.stop_sequence;
        }
        if (event === 'message_stop') {
          __diagMark?.('anthropic:message_stop');
        }
        if (event === 'message_delta' && parsed.usage) {
          // Final counts land here — message_start values may be partial.
          const u = parsed.usage;
          fullUsage = Object.assign({}, fullUsage, u);
          if (typeof u.output_tokens === 'number')              outputTokens              = u.output_tokens;
          if (typeof u.input_tokens === 'number')               inputTokensPostBreakpoint = u.input_tokens;
          if (typeof u.cache_read_input_tokens === 'number')    cacheReadTokens           = u.cache_read_input_tokens;
          if (typeof u.cache_creation_input_tokens === 'number') cacheCreationTokens      = u.cache_creation_input_tokens;
        }
      }, onRawFrame);
      __diagMark?.('anthropic:readSSE_done');
      if (proxy && !proxyDoneSeen) throw new Error('Ответ оборван: соединение с сервером прервалось до конца ответа.');
      // Compose total input from the three disjoint counters. cachedInput /
      // cacheCreation forwarded raw so the cost calculator can apply the
      // separate tariffs.
      const cachedRaw  = cacheReadTokens || 0;
      const createdRaw = cacheCreationTokens || 0;
      const totalInput = (inputTokensPostBreakpoint != null)
        ? inputTokensPostBreakpoint + cachedRaw + createdRaw
        : null;
      if (totalInput !== null || outputTokens !== null) {
        onUsage?.({
          input: totalInput,
          cachedInput: cacheReadTokens,
          cacheCreation: cacheCreationTokens,
          output: outputTokens,
        });
      }
      try {
        onResponseMeta?.({
          finish_reason: finishReason ? (stopSequence ? `${finishReason} (${stopSequence})` : finishReason) : null,
          usage: fullUsage,
          reasoning: thinkingText ? { text: thinkingText, tokens: null } : null,
        });
      } catch (e) { /* log collection must never break the call */ }
    }

    // 1.5.13: parse Google's `server-timing` HTTP header into milliseconds.
    // Format examples seen live: `gfet4t7; dur=657`, `name; dur=123, other; dur=45`.
    // We pick the first `dur=NNN` we see (single Google upstream metric).
    function emitGoogleServerTiming(response, onServerTiming) {
      if (!onServerTiming) return;
      const header = response.headers.get('server-timing');
      if (!header) return;
      const m = header.match(/dur=([\d.]+)/);
      if (!m) return;
      const ms = parseFloat(m[1]);
      if (Number.isFinite(ms)) onServerTiming(ms);
    }

    async function callGoogleStream({ model, systemPrompt, userMessage, messages, onChunk, onModel, onUsage, onBilled, onServerTiming, onRequestBody, onResponseMeta, onRawFrame, signal, thinkingLevel, knobs, modelId, __diagMark, proxy }) {
      if (!proxy && !GOOGLE_API_KEY) throw new Error('Google API key not set.');

      const url = `${GOOGLE_URL_TMPL}${model}:streamGenerateContent?alt=sse&key=${GOOGLE_API_KEY}`;
      const body = {
        // Absent when the server owns the prompt — llm-proxy writes
        // systemInstruction itself. Google rejects an empty parts[].text.
        ...(systemPrompt ? { systemInstruction: { parts: [{ text: systemPrompt }] } } : {}),
        contents: normalizeMessagesForGoogle(messages, userMessage),
      };
      // generationConfig holds both thinking + the knobs. Build incrementally so
      // an empty knobs payload doesn't add an empty object next to thinkingConfig.
      const genCfg = {};
      if (thinkingLevel) genCfg.thinkingConfig = { thinkingLevel };
      if (knobs) {
        const tempN = knobNumberOrNull(knobs.temperature);
        // Older Gemini text models accept temperature on every variant,
        // thinking included, and this used to send it unconditionally. Gemini
        // 3.7 Flash ended that: its migration page says in as many words
        // "Strip temperature, top_p, and top_k from generation configs"
        // (checked 2026-08-25). Gating is registry-driven — the same
        // textKnobSupported call the Anthropic adapter already makes — so the
        // next Gemini that drops a sampling param needs a knobQuirks line in
        // model-registry.js and nothing here.
        if (tempN != null && LexModelRegistry.textKnobSupported('temperature', modelId)) {
          genCfg.temperature = tempN;
        }
        const maxN = knobNumberOrNull(knobs.maxTokens);
        if (maxN != null) genCfg.maxOutputTokens = maxN;
        const seedN = knobNumberOrNull(knobs.seed);
        if (seedN != null && LexModelRegistry.textKnobSupported('seed', modelId)) {
          genCfg.seed = seedN;
        }
      }
      if (Object.keys(genCfg).length > 0) body.generationConfig = genCfg;

      logContextTrace({
        provider: 'google-generate',
        model,
        // streamGenerateContent has no server-side thread — full history each call.
        mode: (body.contents?.length || 0) > 1 ? 'continue-thread' : 'new-thread',
        sent_messages: body.contents?.length ?? null,
        hydration: null,
      }, body);
      onRequestBody?.(body, url);

      __diagMark?.('google:body_built');
      const response = proxy
        ? await proxyFetch({ ...proxy, meta: { ...proxy.meta, google: { path: `${model}:streamGenerateContent?alt=sse` } } }, body, signal)
        : await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        });
      __diagMark?.('google:fetch_returned');
      if (!response.ok) {
        const gateErr = lexBillingGateError(response.status);
        if (gateErr) throw gateErr;
        const overflow = lexContextOverflowError(response);
        if (overflow) throw overflow;
        const noSess = lexNoSessionError(response);
        if (noSess) throw noSess;
        const errText = await response.text();
        throw new Error(`Google ${response.status}: ${errText.substring(0, 200)}`);
      }
      // 1.5.13: Gemini returns W3C Server-Timing header (`server-timing:
      // gfet4t7; dur=657`). Parse the `dur=` token in milliseconds.
      emitGoogleServerTiming(response, onServerTiming);
      // DIAG: log raw header value (not just parsed)
      const rawServerTiming = response.headers.get('server-timing');
      if (rawServerTiming) __diagMark?.(`google:raw_server-timing="${rawServerTiming}"`);

      let modelEmitted = false;
      let lastUsage = null;
      let finishReason = null;
      let thoughtText = '';
      let proxyDoneSeen = false;
      await readSSEStream(response, ({ event, data }) => {
        if (event === 'lex_proxy_done') {
          proxyDoneSeen = true;
          // Server-authoritative marked-up price (raw × price_multiplier = the
          // exact balance_ledger debit). Split preserved for the two chat pills.
          // The client only DISPLAYS these; it never sees the multiplier itself.
          // ⚠ Флаг ставится ВНУТРИ try, а бросок стоит СНАРУЖИ. Этот catch
          // существует, чтобы кривой кадр не ронял ответ, — и он проглотил бы
          // наш маркер переполнения вместе с ним.
          let overflowFrame = false;
          try {
            const d = JSON.parse(data);
            onBilled?.({ inputCost: d.billedInputCostUsd, outputCost: d.billedOutputCostUsd });
            overflowFrame = !!(d && d.contextOverflow);
          } catch { /* frame parse failure → fall back to local computeCost */ }
          if (overflowFrame) throwIfContextOverflow({ contextOverflow: true });
          return;
        }
        if (!data) return;
        let parsed;
        try { parsed = JSON.parse(data); } catch { return; }
        if (!modelEmitted) {
          // Google sometimes puts `modelVersion` on each chunk; fall back to the
          // requested apiModel if it's missing.
          onModel?.(parsed.modelVersion || model);
          modelEmitted = true;
        }
        const parts = parsed.candidates?.[0]?.content?.parts;
        if (Array.isArray(parts)) {
          for (const p of parts) {
            if (p.thought && p.text) thoughtText += p.text;   // reasoning text (only when includeThoughts is on)
            if (p.text) onChunk(p.text);
          }
        }
        const fr = parsed.candidates?.[0]?.finishReason;
        if (fr) finishReason = fr;
        if (parsed.usageMetadata) lastUsage = parsed.usageMetadata;
      }, onRawFrame);
      __diagMark?.('google:readSSE_done');
      if (proxy && !proxyDoneSeen) throw new Error('Ответ оборван: соединение с сервером прервалось до конца ответа.');
      if (lastUsage) {
        // promptTokenCount is the TOTAL input (cachedContentTokenCount is a
        // SUBSET — Google docs 2026-05-07: "this is still the total effective
        // prompt size meaning this includes the number of tokens in the cached
        // content"). thoughtsTokenCount is DISJOINT from candidatesTokenCount
        // and billed at the output rate ("response pricing is the sum of
        // output tokens and thinking tokens") — sum them for total billable
        // output. cacheCreation = 0 — Google has no write tariff for runtime
        // generateContent (context-cache resource pricing is separate, not
        // surfaced here).
        const candidates = lastUsage.candidatesTokenCount ?? null;
        const thoughts   = lastUsage.thoughtsTokenCount   ?? 0;
        onUsage?.({
          input: lastUsage.promptTokenCount ?? null,
          cachedInput: lastUsage.cachedContentTokenCount ?? 0,
          cacheCreation: 0,
          output: (candidates != null) ? candidates + thoughts : null,
        });
      }
      try {
        onResponseMeta?.({
          finish_reason: finishReason,
          usage: lastUsage,
          reasoning: (thoughtText || lastUsage?.thoughtsTokenCount)
            ? { text: thoughtText || null, tokens: lastUsage?.thoughtsTokenCount ?? null }
            : null,
        });
      } catch (e) { /* log collection must never break the call */ }
    }

    // Google Interactions API (Beta) — server-side conversation state via
    // previous_interaction_id (analogous to OpenAI Responses API previous_response_id).
    // system_instruction and generation_config are interaction-scoped (per official
    // docs + verified empirically): callers must re-send them on every turn. Only
    // conversation history persists server-side.
    //
    // SSE event sequence (verified by curl):
    //   interaction.start         → data.interaction.id (full id available immediately)
    //   interaction.status_update → in_progress
    //   content.start             → {index, content:{type:"thought"|"text"}}
    //   content.delta             → {index, delta:{text|signature, type}} (multiple)
    //   content.stop
    //   interaction.complete      → data.interaction.{id, usage{...}, model}
    //   done                      → [DONE]
    //
    // We only emit text deltas to onChunk (skip thought_signature). onResponseId
    // fires from interaction.start so callers can persist the new id ASAP for
    // chain continuity.
    // May 2026 Interactions API breaking change: the `input` array switched from
    // the legacy "turn_list" shape ([{role:'user'|'model', content}]) to the
    // steps-based "step_list" shape ([{type:'user_input'|'model_output',
    // content:[{type:'text', text}]}]). The old shape now 400s with
    // "When using the steps-based API version, use step_list input format instead
    // of turn_list". A bare-string single turn is wrapped into one user_input step
    // for uniformity. Already-shaped steps (type + content array) pass through
    // untouched so thought/function_call steps keep their signatures.
    // https://ai.google.dev/gemini-api/docs/interactions-breaking-changes-may-2026
    function toInteractionSteps(input) {
      const wrap = (role, text) => ({
        type: (role === 'model' || role === 'assistant') ? 'model_output' : 'user_input',
        content: [{ type: 'text', text: String(text ?? '') }],
      });
      if (typeof input === 'string') return [wrap('user', input)];
      if (Array.isArray(input)) {
        return input.map((turn) => {
          if (turn && typeof turn.type === 'string' && Array.isArray(turn.content)) return turn;
          return wrap(turn?.role, turn?.content);
        });
      }
      return input;
    }

    async function callGoogleInteractionsStream({
      model, systemInstruction, input, previousInteractionId,
      onChunk, onModel, onUsage, onResponseId, onServerTiming, onRequestBody, onResponseMeta, onRawFrame, signal, thinkingLevel,
      knobs, modelId, __diagMark, proxy,
    }) {
      // ⚠️ THE ONLY ADAPTER HERE THAT COULD GO AROUND THE SERVER.
      //
      // Its three siblings all open with `if (!proxy && !KEY)` and post to
      // llm-proxy when `proxy` is present; this one had neither, so it went
      // straight to the provider with a client-held key — past the balance
      // gate, past the debit, past the calls row. It is unreachable today
      // (not in PROVIDER_ADAPTERS, not returned from create), so nothing is
      // leaking now. That is exactly why the guard belongs here and not in a
      // ticket: the day somebody wires it up, the money hole arrives silently
      // and works perfectly.
      //
      // On this page the key is the empty string by construction, so without
      // the guard the failure would at least be loud. In the extension the key
      // is real, and it would not be.
      if (proxy) {
        throw new Error('callGoogleInteractionsStream: proxied mode not implemented — '
          + 'refusing to call the provider directly, which would bypass the balance gate and the debit.');
      }
      if (!GOOGLE_API_KEY) throw new Error('Google API key not set.');

      const url = `${GOOGLE_INTERACTIONS_URL}?key=${GOOGLE_API_KEY}`;
      const body = {
        model,
        input: toInteractionSteps(input),    // May 2026: steps-based input (was turn_list)
        stream: true,
      };
      if (systemInstruction != null && String(systemInstruction).trim()) {
        body.system_instruction = systemInstruction;
      }
      if (previousInteractionId) {
        body.previous_interaction_id = previousInteractionId;
      }
      // Verified shape: generation_config.thinking_level (flat). Not
      // generation_config.thinking_config.thinking_level (rejected with 400
      // "Unknown parameter 'thinking_config'"). Pro rejects "minimal" — use
      // "low" as the floor for that model. Caller (registry entry) must
      // already encode the right level. Snake_case fields here (Interactions API
      // diverges from the JSON-camelCase generationConfig used by streamGenerateContent).
      const genCfg = {};
      if (thinkingLevel) genCfg.thinking_level = thinkingLevel;
      if (knobs) {
        const tempN = knobNumberOrNull(knobs.temperature);
        if (tempN != null) genCfg.temperature = tempN;
        const maxN = knobNumberOrNull(knobs.maxTokens);
        if (maxN != null) genCfg.max_output_tokens = maxN;
        const seedN = knobNumberOrNull(knobs.seed);
        if (seedN != null) genCfg.seed = seedN;
      }
      if (Object.keys(genCfg).length > 0) body.generation_config = genCfg;

      // input is either a string (single user turn) or an array of {role, content}
      // pairs (when caller inlined hydration tail before the new user message).
      const inputCount = Array.isArray(body.input) ? body.input.length : 1;
      logContextTrace({
        provider: 'google-interactions',
        model,
        mode: previousInteractionId ? 'continue-thread' : 'new-thread',
        sent_messages: inputCount,
        hydration: null,
      }, body);
      onRequestBody?.(body, url);

      __diagMark?.('google-int:body_built');
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
      __diagMark?.('google-int:fetch_returned');
      if (!response.ok) {
        const errText = await response.text();
        const err = new Error(`Google Interactions ${response.status}: ${errText.substring(0, 200)}`);
        err.status = response.status;
        err.responseBody = errText;
        throw err;
      }
      // 1.5.13: same `server-timing` header as streamGenerateContent.
      emitGoogleServerTiming(response, onServerTiming);

      let modelEmitted = false;
      let responseIdEmitted = false;
      let lastUsage = null;
      let finishReason = null;
      let thoughtText = '';
      await readSSEStream(response, ({ event, data }) => {
        if (!data || data === '[DONE]') return;
        let parsed;
        try { parsed = JSON.parse(data); } catch { return; }
        // May 2026: the event type may arrive in the SSE `event:` line (legacy)
        // OR inside the JSON payload as `event_type` (steps-based). Match both,
        // and accept both old + new event names during the migration window:
        //   interaction.start  → interaction.created
        //   content.delta      → step.delta
        //   interaction.complete → interaction.completed
        // Inner payload shapes (delta.text, interaction.id/model/usage) are
        // unchanged.
        const ev = event || parsed.event_type;

        // interaction.created (was interaction.start) carries the full id of THIS
        // new interaction — the one that callers chain from on the next turn.
        if (ev === 'interaction.created' || ev === 'interaction.start') {
          const id = parsed?.interaction?.id;
          if (id && !responseIdEmitted) {
            responseIdEmitted = true;
            onResponseId?.(id);
          }
          const m = parsed?.interaction?.model;
          if (m && !modelEmitted) {
            modelEmitted = true;
            onModel?.(m);
          }
          return;
        }

        // Text deltas. step.delta (was content.delta). Skip non-text deltas
        // (thought_signature etc — reasoning bookkeeping, not user-visible).
        if (ev === 'step.delta' || ev === 'content.delta') {
          const delta = parsed?.delta;
          if (delta && delta.type === 'text' && typeof delta.text === 'string') {
            onChunk(delta.text);
          } else if (delta && delta.type === 'thought' && typeof delta.text === 'string') {
            thoughtText += delta.text;   // reasoning text (skip 'signature' bookkeeping)
          }
          return;
        }

        // Final usage payload + last chance to emit model name if start event
        // somehow missed it. interaction.completed (was interaction.complete).
        if (ev === 'interaction.completed' || ev === 'interaction.complete') {
          __diagMark?.('google-int:interaction.complete');
          const u = parsed?.interaction?.usage;
          if (u) lastUsage = u;
          const fr = parsed?.interaction?.status ?? parsed?.interaction?.finish_reason;
          if (fr) finishReason = fr;
          const m = parsed?.interaction?.model;
          if (m && !modelEmitted) {
            modelEmitted = true;
            onModel?.(m);
          }
          return;
        }
      }, onRawFrame);
      __diagMark?.('google-int:readSSE_done');

      if (!modelEmitted) onModel?.(model);
      if (lastUsage) {
        // Interactions API usage shape (snake_case, captured from live sw_logs
        // 2026-05-07, no public schema doc):
        //   { total_tokens, total_input_tokens, input_tokens_by_modality[],
        //     total_cached_tokens, total_output_tokens, total_tool_use_tokens,
        //     total_thought_tokens }
        // total_input_tokens / total_output_tokens / total_thought_tokens /
        // total_cached_tokens are all DISJOINT counters that sum to
        // total_tokens — same as the legacy streamGenerateContent split.
        // total_cached_tokens is the cache-hit subset of input (0 when the
        // turn missed the cache). Thoughts are billed at the output rate but
        // reported separately, so total billable output = output + thoughts.
        // TODO: confirm cached-token reporting on a real cache HIT (every
        // sample so far has total_cached_tokens=0; need a turn long enough
        // to trigger Google's prefix cache to validate the field carries a
        // positive value the same way).
        const thoughts = lastUsage.total_thought_tokens ?? 0;
        const totalOut = lastUsage.total_output_tokens ?? null;
        onUsage?.({
          input: lastUsage.total_input_tokens ?? null,
          cachedInput: lastUsage.total_cached_tokens ?? 0,
          cacheCreation: 0,
          output: (totalOut != null) ? totalOut + thoughts : null,
        });
      }
      try {
        onResponseMeta?.({
          finish_reason: finishReason,
          usage: lastUsage,
          reasoning: (thoughtText || lastUsage?.total_thought_tokens)
            ? { text: thoughtText || null, tokens: lastUsage?.total_thought_tokens ?? null }
            : null,
        });
      } catch (e) { /* log collection must never break the call */ }
    }

    const PROVIDER_ADAPTERS = {
      openai: callOpenAIStream,
      anthropic: callAnthropicStream,
      google: callGoogleStream,
    };

    // 1.4.2: resolve a modelId (legacy registry id OR synthetic provider:apiModel:effort)
    // into a usable entry. Synthetic IDs are built by shared.js when the user picks an
    // apiModel + effort pair that isn't present in MODEL_REGISTRY (e.g. 5.5+medium).
    // Returns the same shape MODEL_REGISTRY entries have so downstream code can read
    // .provider/.apiModel/.effort/.thinkingLevel uniformly.
    function resolveModelEntry(modelId) {
      if (!modelId) return null;
      if (MODEL_REGISTRY[modelId]) return MODEL_REGISTRY[modelId];
      const parts = String(modelId).split(':');
      if (parts.length !== 3) return null;
      const [provider, apiModel, effortRaw] = parts;
      if (!['openai', 'google', 'anthropic'].includes(provider)) return null;
      if (!apiModel) return null;
      const effort = effortRaw && effortRaw !== '' ? effortRaw : null;
      const entry = { provider, apiModel };
      if (provider === 'google') {
        // For Gemini, effort slot in the synthetic ID maps to thinkingLevel.
        // 'none' is treated as null (no thinking).
        entry.thinkingLevel = (effort && effort !== 'none') ? effort : null;
      } else {
        // OpenAI / Anthropic: effort is `output_config.effort` / `reasoning.effort`.
        entry.effort = effort;
      }
      return entry;
    }

    // Single entry point for both first-click word explanation AND chat follow-up
    // turns. `chatOptions` (optional) carries the chat-mode payload; when present,
    // the function uses the supplied messages array + caller-provided systemPrompt
    // instead of constructing a `Word: …` user message and reading the prompt
    // from storage. `turnIndex` (0 for the first answer, 1+ for follow-ups) is
    // recorded in the per-call modelCall record so transcripts are reconstructable
    // from telemetry without parsing messages content.
    async function streamExplainWord(word, context, videoTitle, videoUrl, tabId, requestId, providerId, modelId, inboundClickId, chatOptions, videoId, knobs, wordPromptOverride) {
      // For chat turns the caller supplies the snapshotted system prompt (so
      // editing the prompt mid-conversation doesn't change tone partway through).
      // For first-click EXPLAIN_WORD we still read storage as before.
      let prompt;
      let promptId;
      // wordUserMessage ends up in the user-role slot for the word-flow
      // request. Anthropic rejects empty user content with a 400 ("messages.0:
      // user messages must have non-empty content"), so we always send
      // something non-empty here. Two cases:
      //   (a) template has {word}/{context} placeholders → all data is
      //       already inside the system prompt, user gets a minimal "."
      //       placeholder (the model treats it as no input);
      //   (b) template has no placeholders → user gets the canonical
      //       Word/Context payload, which doubles as the data carrier.
      let wordUserMessage = '.';
      // Which flow this is used to be inferred from "did the caller supply a system
      // prompt" — fine while the client always carried the text, wrong the moment
      // the server owns it (docs/PLAN-PROMPTS-SERVER.md §4 step 4): a chat turn with
      // no local text would silently fall into the word-click branch below and read
      // a prompt back out of storage, with nothing in the console to show for it.
      // `isChatTurn` states it outright; the systemPrompt check stays for callers
      // that still send text.
      if (chatOptions && (chatOptions.isChatTurn === true || chatOptions.systemPrompt != null)) {
        // Chat-turn flow: client supplies the message history, and — until its
        // surface migrates — the prompt text. `?? ''` because a migrated surface
        // omits the field entirely, and an undefined would travel on into
        // promptTextSnapshot (addWordClick → IndexedDB) as a literal undefined.
        prompt = chatOptions.systemPrompt ?? '';
        promptId = chatOptions.promptId ?? null;
      } else {
        // Word-click flow. Two sources for the system prompt:
        //   - wordPromptOverride present → the standalone word-click popup
        //     (1.5.57) drove this request; use its own prompt group
        //     (wordClickPrompts) instead of the chat prompt.
        //   - otherwise → legacy path: the active chat-prompt from storage,
        //     the same teacher prompt that drives the chat conversation.
        // Placeholder handling + wordUserMessage are identical either way.
        let tpl;
        if (wordPromptOverride && typeof wordPromptOverride.text === 'string') {
          tpl = wordPromptOverride.text;
          promptId = wordPromptOverride.promptId ?? null;
        } else {
          const wp = await getActiveChatPrompt();
          promptId = wp.promptId;
          tpl = wp.text || '';
        }
        const hasPlaceholders = tpl.includes('{word}') || tpl.includes('{context}');
        if (hasPlaceholders) {
          prompt = tpl
            .replaceAll('{word}', word ?? '')
            .replaceAll('{context}', context ?? '');
          wordUserMessage = '.';
        } else {
          prompt = tpl;
          wordUserMessage = `Word: "${word ?? ''}"\nContext: "${context ?? ''}"`;
        }
      }

      // No model selected — fail loudly instead of silently routing through a
      // default. shared.js gates the UI so this should rarely fire.
      if (!modelId) {
        emit(tabId, {
          type: 'STREAM_ERROR',
          error: LXT('error.noModel'),
          requestId,
        });
        return;
      }
      const resolvedModelId = modelId;
      const entry = resolveModelEntry(resolvedModelId);
      if (!entry) {
        emit(tabId, {
          type: 'STREAM_ERROR',
          error: LXT('error.unknownModelId', { id: resolvedModelId }),
          requestId,
        });
        return;
      }
      // providerId is accepted for symmetry with the future UI but the registry
      // is the source of truth. Warn if the caller disagrees — then use registry.
      if (providerId && providerId !== entry.provider) {
        console.warn(TAG, `providerId=${providerId} does not match registry (${entry.provider}) for modelId=${resolvedModelId}; using registry.`);
      }
      const provider = entry.provider;
      const adapter = PROVIDER_ADAPTERS[provider];
      if (!adapter) {
        emit(tabId, {
          type: 'STREAM_ERROR',
          error: LXT('error.unknownProvider', { provider }),
          requestId,
        });
        return;
      }

      // Thinking is now baked into the registry entry (e.g. opus-4-7-low-thinking
      // sets thinkingDefault:true). Anthropic-only — for other providers the field
      // is undefined and adapter ignores the param.
      const thinkingEnabled = !!entry.thinkingDefault;

      // 1.3.2.c/d: word-click + chat-message on OpenAI models route through the
      // per-video conversation thread. Defensive ensureConversation — teacher
      // should have created it already after preprocess+teacher both finished,
      // but in edge cases (teacher errored) we top up here. Non-OpenAI models
      // keep the legacy non-thread path (chat-flow with responseCache + chained
      // previous_response_id, word-flow with substituted prompt as system).
      //
      // Step-1 Gemini-thread (Interactions API): if active model is in
      // USES_GOOGLE_INTERACTIONS AND the videoThreads row already has a
      // googleInteractionId (i.e. teacher created the chain), route through the
      // Interactions API with previous_interaction_id. If the chain doesn't
      // exist (teacher errored or hasn't run yet), fall through to the legacy
      // callGoogleStream path with messages[] — the chat still works, just
      // without server-side memory.
      const isChat = !!(chatOptions && (Array.isArray(chatOptions.messages) || typeof chatOptions.text === 'string'));
      // 1.5.61: the word-click popup is a cheap one-shot lookup — keep it
      // OUT of the per-video conversation thread. When wordPromptOverride is
      // present (= a word-click popup request) force the non-thread path:
      // the request then carries only the word-click prompt (as system) +
      // the Word/Context user message — NOT the teacher prompt, the full
      // transcript, or the accumulated interaction history. Drops a typical
      // word-click from ~3000-3700 input tokens to ~80-150, flat (doesn't
      // grow with session depth).
      const wordPopupStandalone = !isChat && !!wordPromptOverride;
      // Commit 2: the per-provider server-state thread machinery (OpenAI
      // Conversations / Google Interactions / Anthropic replay-from-videoThreads)
      // has been removed. Every text surface now ships the whole conversation
      // inline (commit 1), so streamExplainWord has a single inline path: OpenAI
      // text → Responses with inline input; everything else → the generic adapter
      // with chatOptions.messages. The thread strategy flags, thread setup,
      // runAdapter branches 1/3/4, the hydration trace, and the server-state
      // post-success calls that used to live here are gone. History is owned by
      // videoThreads.turns, persisted client-side in chat-surface.js finalize().
      // One DB record per word click. A follow-up request with a different model
      // OR a chat-turn on the same model passes the existing clickId back in →
      // append modelCall instead of creating a new record.
      // ── Mandatory login (wave 1) ────────────────────────────────────────────
      // Every text model call now requires a valid account session. Resolve the
      // token up front (authValidToken refreshes when <60s from expiry, so routine
      // expiry never surfaces mid-call); no session → refuse before any work.
      const proxyToken = await authValidToken();
      if (!proxyToken) {
        emit(tabId, {
          type: 'STREAM_ERROR',
          error: 'Войдите в аккаунт Lex, чтобы пользоваться учителем.',
          requestId,
          clickId: inboundClickId ?? null,
        });
        return;
      }

      let clickId = inboundClickId ?? null;
      if (clickId == null) {
        try {
          clickId = await addWordClick({
            timestamp: Date.now(),
            word,
            context,
            videoTitle,
            videoUrl: videoUrl || '',
            promptId,
            promptTextSnapshot: prompt,
            conversationId: null,        // server-state threads removed (commit 2)
            googleInteractionId: null,   // server-state threads removed (commit 2)
            modelCalls: [],
            saved: false,
            savedAt: null,
          });
          lastClickByTab.set(tabId, clickId);
        } catch (err) {
          console.error(TAG, 'telemetry addWordClick failed:', err);
        }
      }

      // First-click path: see word-flow construction above (wordUserMessage
      // is always non-empty so Anthropic accepts the request).
      // Chat path: caller passes the full messages[] history; userMessage is
      // unused (adapter prefers `messages` when present, see normalize helpers).
      const userMessage = wordUserMessage;
      const turnIndex = chatOptions?.turnIndex ?? 0;
      // Responses API path: if the OpenAI model is in USES_RESPONSES_API, route
      // through callOpenAIResponsesStream with previous_response_id chaining.
      // Anthropic / Gemini / non-listed OpenAI models keep their existing
      // adapters and full-history transport.
      const useResponsesApi = (provider === 'openai') && (
        USES_RESPONSES_API.has(resolvedModelId) || OPENAI_TEXT_API_MODELS.has(entry.apiModel)
      );

      // ── Server proxy routing (wave 1) ─────────────────────────────────────────
      // Text calls whose kind is live on llm-proxy go through the Edge Function
      // (server key + account gate + server-written calls row). Kinds not yet in
      // PROXY_ENABLED_KINDS fall back to the direct-to-provider path unchanged.
      const isMiniChatTurn = !!(chatOptions && chatOptions.miniChat);
      const proxyKind = useResponsesApi ? 'openai-responses'
        : (provider === 'openai' ? 'openai-chat'
        : (provider === 'anthropic' ? 'anthropic'
        : (provider === 'google' ? 'google' : null)));
      const PROXY_ENABLED_KINDS = new Set(['openai-responses', 'openai-chat', 'anthropic', 'google']);
      const useProxy = !!proxyKind && PROXY_ENABLED_KINDS.has(proxyKind);
      // Session gate (block session_gate): the FIRST paid call after activation waits
      // for this tab's video session so meta.sessionId below is real, not null. Only
      // this first call blocks (~createSession); later calls read the map synchronously.
      // Standalone (superchat) is skipped from this video-session ensure — it manages
      // its own session via CREATE_STANDALONE_SESSION, awaited client-side in
      // standalone-chat.js's ensureStandaloneSession() before the send, so
      // standaloneSessionIdByTab is populated by the time we read it below.
      const surfaceForProxy = (chatOptions && chatOptions.surface) || null;
      // Корзину выбирает ЧАТ: поверхность сообщает, в какой разговор легли реплики
      // этого хода ('standalone' — чат маленького окна, 'video' — урок видео).
      // Не сообщила — прежнее правило по поверхности (голос, легаси-пути).
      const bucketForProxy = (chatOptions && chatOptions.sessionBucket)
        || (surfaceForProxy === 'standalone' ? 'standalone' : 'video');
      if (useProxy && bucketForProxy !== 'standalone' && typeof tabId === 'number') {
        await ensureSessionForTab(tabId);
      }
      const proxy = useProxy ? {
        kind: proxyKind,
        token: proxyToken,
        meta: {
          // Surface-aware resolve (P3 fix; was a raw sessionIdByTab read). 'standalone'
          // → standaloneSessionIdByTab, everything else → the tab's video session. The
          // old raw read misattributed a superchat call on a video tab to the video
          // session, and sent null off-video → finalizeCall dropped it unbilled
          // (calls.session_id is NOT NULL). See docs/BILLING-METERING-DESIGN.md §2.4.
          sessionId: resolveCallSessionId(tabId, surfaceForProxy, bucketForProxy),
          videoId: extractRealVideoId(videoId),
          surface: (chatOptions && chatOptions.surface) || null,
          source: (chatOptions && chatOptions.source) || null,
          callType: isChat ? (isMiniChatTurn ? 'tutor' : 'chat') : 'word',
          // Parity with one-door promptType: action turns use their own category.
          promptType: (chatOptions && chatOptions.actionId)
            ? 'action'
            : (wordPopupStandalone ? 'word' : (isMiniChatTurn ? 'tutor' : 'chat')),
          promptText: prompt || '',
          promptSlot: wordPopupStandalone ? (wordPromptOverride.promptId || null) : null,
          // Pointer to the prompt the SERVER should inject (docs/PLAN-PROMPTS-SERVER.md).
          // Set only by surfaces that have migrated; until then the field is absent
          // and llm-proxy forwards the body untouched. It carries no text — scope,
          // cell and slot are identifiers, and the server validates them against its
          // own whitelist before resolving.
          //
          // The ref is computed by whoever picked the prompt cell, NOT derived from
          // `surface` here: the superchat continuing a video conversation reads the
          // main chat's cell, and surface alone cannot express that (surface 'main'
          // is also not the same string as scope 'shorts-main').
          ...(chatOptions && chatOptions.promptRef ? {
            promptSource: 'server',
            promptScope: chatOptions.promptRef.scope,
            promptCell: chatOptions.promptRef.cell,
            promptSlot: chatOptions.promptRef.slot || '',
            // true only where an unprompted call is worse than no call (preprocess —
            // its output is cached per video forever).
            promptRequired: chatOptions.promptRef.required === true,
          } : {}),
          // Второй, независимый указатель: инструкция, которая едет ВНУТРИ реплики
          // пользователя, а не отдельной ролью (карточка лексики). Сервер допишет её
          // перед текстом последнего user-сообщения.
          ...(chatOptions && chatOptions.promptPrefixRef ? {
            promptPrefixScope: chatOptions.promptPrefixRef.scope,
            promptPrefixCell: chatOptions.promptPrefixRef.cell,
            promptPrefixSlot: chatOptions.promptPrefixRef.slot || '',
          } : {}),
          // Третий указатель, ВТОРОЙ УРОВЕНЬ инструкции: добавка под тип контента.
          // Сервер резолвит её вместе с общим текстом и приставляет ПОСЛЕ него —
          // одна системная роль, две части. Ячейку выбирает не человек, а
          // страница (слот 'youtube' | 'text'), поэтому «активного слота» в
          // настройках нет. Пришло из main вместе с двухуровневым промптом.
          ...(chatOptions && chatOptions.promptContentRef ? {
            promptContentScope: chatOptions.promptContentRef.scope,
            promptContentCell: chatOptions.promptContentRef.cell,
            promptContentSlot: chatOptions.promptContentRef.slot || '',
          } : {}),
          word: isChat ? null : (word || null),
          turnIndex: isChat ? (Number.isFinite(turnIndex) ? turnIndex : null) : null,
          actionId: (chatOptions && chatOptions.actionId) || null,
          modelInternalId: `${provider}:${entry.apiModel}`,
          // ALWAYS a string. It lands in calls.input_text, a text column, and a
          // failed insert there is not loud: recordCall logs and returns, skipping
          // the debit — the provider call is paid for and no row records it. The
          // fallback branch reads a message's content, which can now be a block
          // array, so it is flattened to its text rather than handed over raw.
          inputText: isChat
            ? (chatOptions.text != null
              ? chatOptions.text
              : neutralBlocksToText(chatOptions.messages?.[chatOptions.messages.length - 1]?.content ?? ''))
            : (userMessage || ''),
          pageType: resolvePageType(chatOptions && chatOptions.pageType, isChat ? 'chat turn' : 'word lookup'),
        },
      } : null;
      // Caller passes the chained id from the previous successful turn on the
      // same (modelId, promptId) pair; null on first turn or when the cache
      // entry doesn't have one yet.
      const initialResponseId = chatOptions?.previousResponseId ?? null;
      // For chat-turns under Responses API: when chained via previous_response_id,
      // we send only the last user message. Otherwise (no chain) we fall back
      // to sending the full history through the `input` field.
      const lastUserMessage = (isChat && Array.isArray(chatOptions.messages) && chatOptions.messages.length)
        ? (chatOptions.messages[chatOptions.messages.length - 1]?.content ?? userMessage)
        : userMessage;
      lexLog(
        TAG,
        `${isChat ? `Chat turn #${turnIndex} for` : 'Explain word'} "${word}" via ${provider}/${entry.apiModel}` +
          (useResponsesApi ? ` [Responses API${initialResponseId ? ', chained' : ''}]` : '')
      );

      const requestedAt = Date.now();
      // DIAG (1.5.14+): per-call wall-clock breakdown for the Anthropic latency
      // investigation. Records {step, ms} at every checkpoint relative to the
      // dispatcher entry; dumped right before STREAM_DONE in console.log.
      // To be removed once root cause identified.
      const __diag = { provider, model: entry.apiModel, t0: performance.now(), points: [] };
      const diagMark = (step) => { __diag.points.push({ step, ms: Math.round(performance.now() - __diag.t0) }); };
      diagMark('streamExplainWord:entry');
      let ttft_ms = null;
      // 1.5.16: token counters extended for the per-message cost pill.
      //   tokens_in           — TOTAL input (sum-of-three for Anthropic;
      //                         total-with-subset-cached for OpenAI/Google).
      //   tokens_cached_in    — cache hits (subset of tokens_in).
      //   tokens_cache_creation — Anthropic cache writes (subset of tokens_in).
      //                         0 for OpenAI/Google.
      //   tokens_out          — total billable output (Gemini: candidates +
      //                         thoughts; others: as reported).
      let tokens_in = null;
      let tokens_cached_in = null;
      let tokens_cache_creation = null;
      let tokens_out = null;
      // Server-authoritative marked-up display price (raw × price_multiplier),
      // captured from the proxy's lex_proxy_done frame via onBilled. When present,
      // STREAM_DONE shows THESE (so the pill == the balance debit); null on the
      // direct/non-proxy path → fall back to local raw computeCost.
      let billedInputCost = null;
      let billedOutputCost = null;
      // 1.5.13: server-side processing time reported by the provider, in
      // milliseconds. Anthropic / Gemini ship a precise value via HTTP header;
      // OpenAI Responses computes it from response.completed (whole seconds).
      // null = adapter didn't report (e.g. legacy Chat Completions path).
      let server_ms = null;
      let responseText = '';
      let actualModelStr = entry.apiModel;
      let streamResponseId = null;
      // text_call_io (v3): which in-scope text surface produced this turn. Only the
      // product surfaces are logged — окна чата → 'chat', попап по слову
      // (live wordchat + legacy standalone) → 'word-click'. lab and
      // pronunciation-tutor text turns are out of scope → null → not logged.
      //
      // 'standalone' добавлен 2026-08-14. Суперчата как отдельной сущности нет
      // с 2026-08-13: маленькое окно и развёрнутый вид — ОДНО окно основного
      // чата, и лог, знавший только 'main', молча терял половину ходов этого
      // чата. «Лог показывает ровно что ушло» (docs/AI-EXCHANGE-LOG.md) с такой
      // дырой не выполнялось: ход со статьи не попадал в него вовсе.
      const ioSurface = wordPopupStandalone ? 'word-click'
        : (chatOptions && chatOptions.surface === 'wordchat') ? 'word-click'
        : (chatOptions && (chatOptions.surface === 'main' || chatOptions.surface === 'standalone')) ? 'chat'
        : null;
      // Id of the most-recent fetch's request snapshot — finishCall stitches the
      // response onto it. A chained-id retry mints a second id (one record/fetch);
      // the response lands on whichever fetch actually produced it.
      let lastIoLogId = null;
      let lastIoMeta = null;       // adapter's structured response fields (finish_reason/usage/reasoning) for the last fetch
      let lastIoRawFrames = [];    // raw SSE frames of the last fetch (lossless); dispatcher-owned → survives a throw

      // AbortController + first-token watchdog. The 15-second budget is
      // for the FIRST chunk only — catches "model never responded" cases
      // (queued / dead TCP / 4xx before stream / etc.). Once a chunk lands,
      // adapterCallbacks.onChunk below clears this timer so a thinking
      // model can continue streaming as long as it needs. After the first
      // token there is no upper bound on response length anymore.
      let streamTimer = null;
      const controller = new AbortController();
      const STREAM_TIMEOUT_MS = 15_000;
      const TIMEOUT_TEXT = LXT('error.timeout', { sec: STREAM_TIMEOUT_MS / 1000 });
      streamTimer = setTimeout(() => {
        controller.abort(new DOMException(TIMEOUT_TEXT, 'TimeoutError'));
      }, STREAM_TIMEOUT_MS);
      // MV3 keepalive — without this, if the fetch stalls (Pro reasoning
      // queue, dead TCP) the service worker can be evicted by Chrome around
      // the 30-second idle mark and our setTimeout silently dies with it.
      // keepAlive() is the host's no-op call that
      // resets the SW idle timer. 20 s interval is comfortably under the
      // 30 s eviction threshold and dirt-cheap. Cleared in the finally
      // along with streamTimer so it doesn't outlive the request.
      const keepaliveTimer = setInterval(() => {
        keepAlive();
      }, 20_000);
      inflightStreams.set(requestId, {
        abort: (reason) => controller.abort(reason),
        tabId,
        requestId,
      });

      const finishCall = async (status, errorMessage, httpStatus = null) => {
        const total_ms = Date.now() - requestedAt;
        // text_call_io (v3): freeze the FULL response onto this turn's last request
        // snapshot — assembled text + structured fields (finish_reason / response_id
        // / actual_model / usage / reasoning / timing) + lossless raw SSE frames.
        // Fire-and-forget; independent of the clickId / Supabase / login gates below.
        try {
          logTextCallResponse(lastIoLogId, buildIoResponse({
            text: responseText,
            meta: lastIoMeta,
            rawFrames: lastIoRawFrames,
            responseId: streamResponseId,
            actualModel: actualModelStr,
            timingMs: server_ms,
          }));
        } catch (e) { /* log collection must never break the call */ }
        if (clickId != null) {
          const call = {
            modelId: resolvedModelId,
            provider,
            actualModel: actualModelStr,
            effort: entry.effort ?? null,
            thinkingLevel: entry.thinkingLevel ?? null,
            thinkingEnabled,
            turnIndex,
            requestedAt,
            ttft_ms,
            total_ms,
            // 1.5.13: provider-reported server-side processing time. null when
            // the adapter doesn't expose it (Chat Completions legacy, voice/PTT).
            server_ms,
            tokens_in,
            tokens_cached_in,
            tokens_cache_creation,
            tokens_out,
            responseText,
            status,
            errorMessage,
            // Server-side response id (Responses API only). null for Chat
            // Completions / Anthropic / Gemini. Useful for debugging — not
            // re-used for chaining (in-memory cache in shared.js owns that).
            responseId: streamResponseId,
          };
          try {
            await updateWordClick(clickId, (rec) => { rec.modelCalls.push(call); });
          } catch (err) {
            console.error(TAG, 'telemetry updateWordClick failed:', err);
          }
        }
        // Mirror to Supabase public.calls. Awaited — earlier we kicked this off
        // fire-and-forget, but the SW occasionally got evicted between the
        // streamExplainWord finally-block and the background POST completing,
        // costing us error-row telemetry. Awaiting keeps the SW alive (the
        // outer keepalive interval is still running until streamExplainWord's
        // own finally) and the user-visible STREAM_DONE/STREAM_ERROR is sent
        // a hundred-or-so ms later, which is fine.
        // llm-proxy path: the SERVER writes the calls row (account_id + server cost);
        // skip the client mirror to avoid a duplicate. Non-proxied surfaces (if any)
        // fall through to the one-door recordAnyCall below.
        if (hasSecrets() && !useProxy) {
          // Standalone (superchat) calls read their OWN session map, never
          // sessionIdByTab (video sessions) — a superchat call on a tab that
          // ALSO has an active video session must neither borrow nor clobber
          // that video's session id.
          const sessionId = resolveCallSessionId(tabId, chatOptions && chatOptions.surface);
          if (sessionId != null) {
            try {
              // Inline path only (commit 2): the model saw the `prompt` var
              // populated above — chatOptions.systemPrompt for chat/tutor, the
              // word-flow prompt for word-click.
              const promptTextForCall = prompt || '';
              // 1.5.62: word-click prompts go under their own prompt_type so
              // they don't pollute the chat-prompt catalog. wordPopupStandalone
              // = the standalone word-click popup drove this request (isChat
              // false + a wordPromptOverride was supplied). The prompts table
              // CHECK already reserves 'word' for exactly this — using it keeps
              // prompt_type consistent with calls.call_type ('word').
              // Teacher popup text turn (chatOptions.miniChat): prompt_type
              // 'tutor' so the teacher prompt stays out of the chat catalog.
              const isMiniChatTurn = !!(chatOptions && chatOptions.miniChat);
              // Action-mode turn (chatOptions.actionId, e.g. 'native' — see
              // chat-surface.js sendMessage's action.id): own prompt_type
              // category, generic across every current/future action button —
              // NOT folded into 'chat'/'word'. The SPECIFIC action lives on the
              // calls row itself (action_id below), not on the prompt category.
              const actionId = (chatOptions && chatOptions.actionId) || null;
              const promptType = actionId
                ? 'action'
                : (wordPopupStandalone ? 'word' : (isMiniChatTurn ? 'tutor' : 'chat'));
              const promptId = await upsertPrompt(promptType, promptTextForCall);
              // input_text = the literal last user turn that went to the model.
              // Chat/tutor: the typed text (chatOptions.text; falls back to the
              // last user message in chatOptions.messages — both equal what was
              // sent inline). Word-click: the Word/Context payload (userMessage).
              // Fixes the inline-switch regression where chat turns logged the
              // '.' placeholder (wordUserMessage) instead of the real user text.
              const inputTextForCall = isChat
                ? (chatOptions.text != null
                    ? chatOptions.text
                    : (chatOptions.messages?.[chatOptions.messages.length - 1]?.content ?? ''))
                : (userMessage || '');
              const eff = extractEffectiveCallParams(entry, knobs, resolvedModelId);
              const cost = computeCost(
                entry.apiModel,
                tokens_in,
                tokens_cached_in,
                tokens_cache_creation,
                tokens_out,
              );
              const cost_usd = cost ? Number(cost.inputCost || 0) + Number(cost.outputCost || 0) : null;
              // network_ms = local-side latency (network round-trip + extension
              // overhead). Computable only when both ttft_ms and server_ms are
              // present; greatest(0, …) guards against the rare case where the
              // server-reported number lands marginally above ttft_ms (e.g.
              // OpenAI's whole-second resolution rounding).
              const network_ms = (ttft_ms != null && server_ms != null)
                ? Math.max(0, ttft_ms - server_ms)
                : null;
              // The one door (recordAnyCall): callType is the mandatory,
              // registry-checked activity id; surface + actionId are declared here;
              // the rest of the row is `columns`. Teacher popup text turn → 'tutor';
              // main-chat turn → 'chat'; word-click popup → 'word'.
              await recordAnyCall({
                tabId,
                callType: isChat ? (isMiniChatTurn ? 'tutor' : 'chat') : 'word',
                // v1.13.x Этап1: метка поверхности (main / wordchat / pronunciation)
                // для текстовых turn'ов — единая с голосом.
                surface: (chatOptions && chatOptions.surface) || null,
                // Which action-mode button (if any) drove this turn — 'native', or
                // any future config.actionButtons id; null for a plain typed turn.
                // Distinguishes native from ordinary chat independently of
                // surface/call_type (both stay whatever the surface would get).
                actionId,
                columns: {
                model_internal_id: `${entry.provider}:${entry.apiModel}`,
                prompt_id: promptId,
                turn_index: isChat ? (Number.isFinite(turnIndex) ? turnIndex : null) : null,
                // 1.5.62: word-click identity columns. word = the clicked word
                // itself (bare — no quotes, no Context wrapper); prompt_slot =
                // which word-click prompt slot was active (wordClick1 /
                // wordClick2). Both null on chat turns.
                word: isChat ? null : (word || null),
                prompt_slot: wordPopupStandalone ? (wordPromptOverride.promptId || null) : null,
                input_text: inputTextForCall || null,
                output_text: responseText || null,
                ttft_ms,
                total_ms,
                network_ms,
                server_ms,
                input_tokens: tokens_in,
                cached_input_tokens: tokens_cached_in,
                cache_creation_tokens: tokens_cache_creation,
                output_tokens: tokens_out,
                cost_usd,
                effort: eff.effort,
                temperature: eff.temperature,
                max_tokens: eff.max_tokens,
                verbosity: eff.verbosity,
                service_tier: eff.service_tier,
                seed: eff.seed,
                error_message: status === 'error' ? (errorMessage || null) : null,
                http_status: httpStatus,
                provider_response_id: streamResponseId || null,
                // Word-lookup origin (zone / page / video). source is set only for
                // lookups routed with chatOptions.source; video_id is the real
                // YouTube id (un-synthesised for word-chat). page_type больше не
                // литерал: суперчат открывается на любой странице (resolvePageType).
                source: (chatOptions && chatOptions.source) || null,
                page_type: resolvePageType(chatOptions && chatOptions.pageType, 'client call row'),
                video_id: extractRealVideoId(videoId),
              } });
            } catch (err) {
              // Telemetry must never break the stream-finalisation path.
              console.warn(TAG, 'Supabase calls mirror failed:', err.message);
            }
          }
        }
      };

      // Common callbacks shared between the initial attempt and the optional
      // Responses-API fallback (without previous_response_id). Defined once
      // so retry doesn't double-stream chunks: the fallback path only runs
      // when the first attempt failed at request-time (4xx before any chunk
      // could have been delivered).
      let lastChunkAtMs = null;
      const adapterCallbacks = {
        // text_call_io (v3): freeze the verbatim outgoing body the instant it
        // leaves for the network, before any response exists, so it survives a
        // failed / aborted call or an SW eviction. One record per real fetch (a
        // chained-id retry re-enters the adapter → a second record). No-op for
        // out-of-scope surfaces (ioSurface === null).
        onRequestBody: (body, endpoint) => {
          if (ioSurface == null) return;
          lastIoRawFrames = [];   // new fetch → fresh frame buffer + meta (one record per fetch)
          lastIoMeta = null;
          lastIoLogId = logTextCallRequest({
            surface: ioSurface,
            videoId: extractRealVideoId(videoId),
            provider: entry.provider,
            endpoint,
            model: entry.apiModel,
            requestBody: body,
            tabId,
            reaskKind: (chatOptions && chatOptions.reaskKind) || null,
            prevModel: (chatOptions && chatOptions.prevModel) || null,
          });
        },
        // text_call_io (v3): lossless raw SSE frames + the adapter's structured
        // response fields (finish_reason / full usage / reasoning), both frozen by
        // finishCall. Dispatcher-owned buffers so partial frames survive a throw.
        onRawFrame: (frame) => { if (ioSurface != null) lastIoRawFrames.push(frame); },
        onResponseMeta: (meta) => { if (ioSurface != null) lastIoMeta = meta; },
        onChunk: (text) => {
          if (ttft_ms === null) {
            ttft_ms = Date.now() - requestedAt;
            diagMark('first_text_chunk');
            // First-token watchdog disarmed — the model has begun streaming.
            // Whatever it does from here (long thinking, slow tail) is fine;
            // the user already sees output flowing.
            if (streamTimer != null) {
              clearTimeout(streamTimer);
              streamTimer = null;
            }
          }
          lastChunkAtMs = Math.round(performance.now() - __diag.t0);
          responseText += text;
          emit(tabId, { type: 'STREAM_CHUNK', text, requestId });
        },
        onModel: (actualModel) => {
          actualModelStr = actualModel;
          lexLog(TAG, '>>> ACTUAL MODEL USED:', actualModel);
          emit(tabId, {
            type: 'STREAM_CHUNK',
            text: '',
            requestId,
            _debug_model: actualModel,
          });
        },
        onUsage: ({ input, cachedInput, cacheCreation, output }) => {
          if (input != null) tokens_in = input;
          if (cachedInput != null) tokens_cached_in = cachedInput;
          if (cacheCreation != null) tokens_cache_creation = cacheCreation;
          if (output != null) tokens_out = output;
        },
        // Marked-up display price from the proxy (lex_proxy_done frame). Stored raw
        // as received — the client neither knows nor applies the multiplier.
        onBilled: ({ inputCost, outputCost }) => {
          if (Number.isFinite(inputCost)) billedInputCost = inputCost;
          if (Number.isFinite(outputCost)) billedOutputCost = outputCost;
        },
        // Responses API only — propagated back to content so the in-memory
        // cache can chain the next chat-turn via previous_response_id.
        onResponseId: (id) => {
          streamResponseId = id;
          emit(tabId, { type: 'STREAM_RESPONSE_ID', responseId: id, requestId });
        },
        // 1.5.13: server-side processing time. Anthropic/Gemini fire this on
        // the very first byte (header arrival); OpenAI Responses fires it on
        // response.completed.
        onServerTiming: (ms) => {
          if (typeof ms === 'number' && Number.isFinite(ms)) {
            server_ms = ms;
            diagMark('onServerTiming');
          }
        },
      };

      // Run the chosen adapter once. Factored out so the Responses-API path
      // can re-invoke without `previous_response_id` if the chained id
      // expired (4xx). `previousResponseIdToUse` only matters for Responses;
      // ignored by Chat Completions and other providers.
      async function runAdapter(previousResponseIdToUse) {
        if (useResponsesApi) {
          await callOpenAIResponsesStream({
            model: entry.apiModel,
            systemPrompt: prompt,
            // When chained, send only the new user turn; when not chained,
            // the adapter falls back to the full messages array (or the
            // word-flow synthetic userMessage for first-click).
            userMessage: previousResponseIdToUse ? lastUserMessage : userMessage,
            messages: isChat ? chatOptions.messages : null,
            previousResponseId: previousResponseIdToUse,
            videoId,
            effort: entry.effort ?? null,
            signal: controller.signal,
            knobs,
            modelId: resolvedModelId,
            proxy,
            ...adapterCallbacks,
          });
          return;
        }
        await adapter({
          model: entry.apiModel,
          systemPrompt: prompt,
          userMessage,
          messages: isChat ? chatOptions.messages : null,
          effort: entry.effort ?? null,
          thinking: thinkingEnabled,
          thinkingLevel: entry.thinkingLevel ?? null,
          signal: controller.signal,
          knobs,
          modelId: resolvedModelId,
          __diagMark: diagMark,
          proxy,
          ...adapterCallbacks,
        });
      }

      // Session-gate retry wrapper (block session_gate): if the proxy refused with
      // 409 no_session (adapter threw the lexNoSession marker), ensure this tab's
      // session and retry the SAME adapter call ONCE. If the session still can't be
      // created, throw a normalized LEX_NO_SESSION so finalizeError shows a visible
      // message instead of silence. Any other error propagates unchanged — including
      // the Responses previous_response_id retry, which keys on err.status; the marker
      // carries none, so it never masquerades as a chain failure.
      let sessionGateRetried = false;
      async function runAdapterWithGate(previousResponseIdToUse) {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            await runAdapter(previousResponseIdToUse);
            return;
          } catch (err) {
            if (err && err.lexNoSession && !sessionGateRetried && typeof tabId === 'number') {
              sessionGateRetried = true;
              // Surface-aware re-ensure: a standalone (superchat) call must re-bind to
              // its OWN standalone session. ensureSessionForTab mints/binds a VIDEO
              // session — using it for a standalone surface would attribute superchat
              // spend to a video lesson (or mint a spurious video row). See
              // docs/BILLING-METERING-DESIGN.md §6 step 3.
              // Drop the refused id FIRST (docs/PLAN-SECURITY-MIGRATION.md шаг 15).
              // ensureSessionForTab returns the cached id when there is one, so without
              // this the retry hands the server back the exact id it just refused and the
              // call fails twice for the same reason. Harmless while the gate accepted
              // ownerless sessions; mandatory once the predicate is tightened (шаг 16),
              // which is why it lands first.
              if (bucketForProxy === 'standalone') forgetStandaloneSessionId(tabId);
              else forgetSessionId(tabId);
              const sid = bucketForProxy === 'standalone'
                ? await ensureStandaloneSessionForTab(tabId)
                : await ensureSessionForTab(tabId);
              if (sid != null) {
                if (proxy && proxy.meta) proxy.meta.sessionId = sid;
                // Reset partial telemetry from the refused attempt.
                ttft_ms = null;
                tokens_in = null;
                tokens_out = null;
                server_ms = null;
                responseText = '';
                streamResponseId = null;
                continue; // retry once with the now-ensured session
              }
            }
            if (err && err.lexNoSession) {
              const e = new Error('LEX_NO_SESSION');
              e.lexNoSession = true;
              throw e;
            }
            throw err;
          }
        }
      }

      try {
        try {
          try {
            diagMark('before_runAdapter');
            await runAdapterWithGate(initialResponseId);
            diagMark('after_runAdapter');
          } catch (err) {
            // Expired / unknown previous_response_id symptoms — retry once
            // without the chain, sending the full history instead. Only
            // applies to Responses API and only when we actually used a
            // chained id on the first attempt. 5xx is propagated (transient
            // server issue, retry won't help). The first attempt failed at
            // request time before any chunk was streamed, so the fallback
            // doesn't double-up the assistant bubble. Aborts are NOT
            // retried — they're either a user cancel or a watchdog firing
            // and re-running would just re-arm the same problem.
            const isPreviousIdFailure = useResponsesApi && initialResponseId
              && typeof err.status === 'number' && err.status >= 400 && err.status < 500
              && !controller.signal.aborted;
            if (!isPreviousIdFailure) throw err;
            console.warn(
              TAG,
              `Responses API previous_response_id chain failed (${err.status}); falling back to full history.`,
              err.responseBody?.substring(0, 200) || ''
            );
            // Reset partial telemetry from the failed attempt — we want the
            // fallback's metrics, not the failed first hit.
            ttft_ms = null;
            tokens_in = null;
            tokens_out = null;
            server_ms = null;
            responseText = '';
            streamResponseId = null;
            await runAdapterWithGate(null);
          }
          await finishCall('ok', null, 200);
          lexLog(TAG, `${isChat ? 'Chat turn' : 'Stream'} complete for:`, word);
          // Commit 2: the SW no longer mirrors the turn into videoThreads or
          // advances any server-state watermark/interaction id — history is owned
          // by videoThreads.turns, persisted client-side in chat-surface.js
          // finalize(). Voice still persists via the APPEND_CONVERSATION_ITEMS
          // handler (unchanged).
          // 1.5.15: pill now shows time-until-first-token only. ttft_ms was
          // set on the first text chunk inside adapterCallbacks.onChunk;
          // serverMs is what the provider self-reported. network = ttft_ms -
          // serverMs (the round-trip to the model's first byte). Anything
          // that happens AFTER the first token (more chunks, hangover,
          // post-stream mirror) is no longer in the pill.
          const totalMs = Date.now() - requestedAt;
          diagMark('before_STREAM_DONE');
          lexLog('[lex-timing-diag]', JSON.stringify({
            ...__diag, totalMs, server_ms, ttft_ms, lastChunkAtMs,
          }));
          // 1.5.16: cost pill payload — pre-computed in SW so the content
          // script doesn't need a copy of MODEL_PRICING. cost = null when
          // apiModel is missing from the table → UI renders '$?'. Raw token
          // counts forwarded too in case future UI wants tooltips with the
          // breakdown.
          // Use the canonical registry apiModel as the pricing key, NOT the
          // server-echoed actualModelStr. OpenAI echoes a dated variant
          // (e.g. gpt-5.5-2026-04-23) that is absent from MODEL_PRICING by
          // design — pricing is keyed by registry name (per spec: "у одной
          // apiModel несколько внутренних ID, цена одна").
          const cost = computeCost(
            entry.apiModel,
            tokens_in,
            tokens_cached_in,
            tokens_cache_creation,
            tokens_out
          );
          // Prefer the server's marked-up split (billed*) — that's what the balance
          // is charged, so the pill matches the debit. Local computeCost (raw, no
          // multiplier) is only the fallback for the direct/non-proxy path, which
          // isn't billed anyway. `billed*` are already the full displayed values
          // (input under the question, output under the answer); their sum == debit.
          const useBilled = billedInputCost != null || billedOutputCost != null;
          const dispInputCost = useBilled ? billedInputCost : (cost ? cost.inputCost : null);
          const dispOutputCost = useBilled ? billedOutputCost : (cost ? cost.outputCost : null);
          emit(tabId, {
            type: 'STREAM_DONE', requestId, clickId,
            ttftMs: ttft_ms,
            serverMs: server_ms,
            inputTokens: tokens_in,
            cachedInputTokens: tokens_cached_in,
            cacheCreationTokens: tokens_cache_creation,
            outputTokens: tokens_out,
            inputCost: dispInputCost,
            outputCost: dispOutputCost,
          });
          // Part 3: a proxied text turn just debited the balance server-side —
          // refresh the icon/bucket and any open account card. Only proxied calls
          // are billed; the direct/non-proxy path changes no balance.
          if (useProxy) lexNotifyBalanceMaybeChanged();
        } catch (err) {
          // Two terminal categories:
          //   (a) watchdog timeout — controller aborted with a TimeoutError
          //       reason carrying a human-readable message. Surface as a
          //       STREAM_ERROR so the chat shows a clear "model didn't
          //       respond" bubble and the model bar unlocks.
          //   (b) anything else — network / 4xx / 5xx / adapter throw.
          const aborted = controller.signal.aborted;
          const reason = aborted ? controller.signal.reason : null;
          const isTimeout = aborted && reason?.name === 'TimeoutError';
          const errorMessage = isTimeout ? (reason.message || 'Timeout') : err.message;
          // HTTP status: prefer the explicit field set by adapters that bubble
          // it up (Responses API). Otherwise scan the message for a leading
          // "<Provider> <NNN>: ..." which is what callOpenAIStream /
          // callAnthropicStream / callGoogleStream throw on non-OK responses.
          let httpStatus = (typeof err?.status === 'number') ? err.status : null;
          if (httpStatus == null && !isTimeout) {
            const m = /\b(\d{3})\b/.exec(err.message || '');
            if (m) {
              const n = Number(m[1]);
              if (n >= 100 && n < 600) httpStatus = n;
            }
          }
          await finishCall('error', errorMessage, httpStatus);
          console.error(TAG, `${provider} ${isTimeout ? 'timeout' : 'error'} for "${word}":`, errorMessage);
          emit(tabId, {
            type: 'STREAM_ERROR',
            error: errorMessage,
            requestId,
            clickId,
          });
        }
      } finally {
        // Always release the watchdog and the inflight slot — terminal
        // path is the same whether we resolved, errored, timed out, or
        // were cancelled. Without this an aborted stream would leak the
        // timer for the rest of the SW lifetime.
        clearTimeout(streamTimer);
        clearInterval(keepaliveTimer);
        inflightStreams.delete(requestId);
      }
    }
    return {
      readSSEStream,
      proxyFetch,
      proxyFetchMultipart,
      proxyPostJson,
      proxyFetchYtjarLink,
      isActivelyReasoning,
      clampTemperatureForProvider,
      appendConversationItems,
      resolveModelEntry,
      streamExplainWord,
    };
  }

  global.LexTeacherCore = { create };
})(typeof self !== 'undefined' ? self : globalThis);
