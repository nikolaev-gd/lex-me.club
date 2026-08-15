// model-registry.js — single source of truth for every model Lex uses.
//
// Loaded into the service worker via importScripts() and into content
// scripts via the manifest content_scripts list (must come before
// shared.js / content.js). Exposes globalThis.LexModelRegistry.
//
// No DOM, no chrome.* — pure data + derivation, valid in SW, content
// world and plain Node (used by syntax/equivalence tests).
//
// ─────────────────────────────────────────────────────────────────────
// HOW TO ADD A MODEL: add one entry to LEX_MODELS below. A text model
// then shows up in every model bar (chat / tutor / future surfaces),
// gets its effort dropdown, pricing pill and routing automatically —
// no other file needs editing. registryEntries is back-compat only:
// the legacy named MODEL_REGISTRY ids + preprocess presets. New models
// do NOT need registryEntries — the UI drives them via synthetic
// `provider:apiModel:effort` ids.
// ─────────────────────────────────────────────────────────────────────
//
// Descriptor fields:
//   apiModel        exact string sent to the provider API
//   id              voice/asr only — the id used in storage/UI when it
//                   differs from apiModel (text models are keyed by apiModel)
//   provider        'openai' | 'google' | 'anthropic' | 'groq'
//   type            'text' | 'voice' | 'asr'
//   label           human-readable UI label
//   efforts         text only — accepted reasoning-effort / thinkingLevel values
//   defaultEffort   text only — default effort
//   pricing         USD per 1M tokens (text/voice) or per audio-hour (asr)
//   hidden          text only — kept for pricing/compat, not shown in the bar
//   vision          text only, ОБЯЗАТЕЛЬНОЕ — принимает ли модель картинку на
//                   входе. Умолчания нет намеренно: новая модель без этого
//                   поля роняет реестр на загрузке (см. assertVisionDeclared
//                   ниже), потому что молчаливое «наверное, не умеет» человек
//                   увидел бы как недоступный пункт «прикрепить файл» и
//                   списал бы на баг интерфейса. Сегодня true у всех
//                   восемнадцати: у каждого из трёх провайдеров картинку на
//                   входе принимает всё текстовое семейство. Живьём (одна
//                   картинка 1600 px через сервер, 2026-08-06) проверено по
//                   одной модели на провайдера — см. docs/UNIFIED-CONTEXT.md §7;
//                   остальные унаследовали утверждение по семейству.
//   role            asr only — 'primary' | 'fallback'
//   dictationDefault asr only — marks the default mic-dictation model
//   registryEntries text only — legacy MODEL_REGISTRY ids this model expands
//                   into. { id, fields, preprocess?, googleInteractions?, legacy? }
//   knobQuirks      text only — per-model overrides of the provider knob
//                   baseline (PROVIDER_TEXT_KNOBS). Each value: true | false |
//                   'openaiReasoning' | 'anthropicThinking'.

(function (global) {
  'use strict';

  const LEX_MODELS = [
    // ── OpenAI · text ────────────────────────────────────────────────
    {
      // Live-verified 2026-07-12 via the Responses API: 'minimal' rejected
      // (HTTP 400, unsupported_value — same quirk as 5.4/5.5 below), full
      // ['none','low','medium','high','xhigh'] range otherwise accepted.
      // Luna is NOT nano-like — it's a real reasoning model despite the
      // cheap tier.
      // 2026-07-30: OpenAI cut Luna by 80% (was 1.00 / 0.10 / 6.00). Mirror
      // row in Supabase public.models updated in the same commit — that table,
      // not this one, is what the server debits by.
      apiModel: 'gpt-5.6-luna', provider: 'openai', type: 'text', label: '5.6 Luna',
      vision: true,
      efforts: ['none', 'low', 'medium', 'high', 'xhigh'],
      defaultEffort: 'none',
      pricing: { input: 0.20, cachedInput: 0.02, output: 1.20 },
      registryEntries: [
        { id: 'preprocess-gpt-5-6-luna-off', fields: { effort: 'none' }, preprocess: true },
      ],
    },
    {
      // Live-verified 2026-07-12, same effort surface as Luna.
      // 2026-07-30: OpenAI cut Terra by 20% (was 2.50 / 0.25 / 15.00). Sol was
      // NOT part of that cut — it stays at 5.00 / 0.50 / 30.00.
      apiModel: 'gpt-5.6-terra', provider: 'openai', type: 'text', label: '5.6 Terra',
      vision: true,
      efforts: ['none', 'low', 'medium', 'high', 'xhigh'],
      defaultEffort: 'none',
      pricing: { input: 2.00, cachedInput: 0.20, output: 12.00 },
      registryEntries: [
        { id: 'preprocess-gpt-5-6-terra-off', fields: { effort: 'none' }, preprocess: true },
      ],
    },
    {
      // Live-verified 2026-07-12, same effort surface as Luna/Terra.
      apiModel: 'gpt-5.6-sol', provider: 'openai', type: 'text', label: '5.6 Sol',
      vision: true,
      efforts: ['none', 'low', 'medium', 'high', 'xhigh'],
      defaultEffort: 'none',
      pricing: { input: 5.00, cachedInput: 0.50, output: 30.00 },
      registryEntries: [
        { id: 'preprocess-gpt-5-6-sol-off', fields: { effort: 'none' }, preprocess: true },
      ],
    },
    {
      // Hidden 2026-07-12 — superseded by 5.6 Sol. Kept in the registry
      // (not deleted) so historical telemetry rows referencing it stay valid.
      hidden: true,
      apiModel: 'gpt-5.5', provider: 'openai', type: 'text', label: '5.5',
      vision: true,
      // 'minimal' rejected by the Responses API (HTTP 400, unsupported_value) —
      // verified live 2026-07-01, same for gpt-5.4 / gpt-5.4-mini below.
      efforts: ['none', 'low', 'medium', 'high', 'xhigh'],
      defaultEffort: 'none',
      pricing: { input: 5.00, cachedInput: 0.50, output: 30.00 },
      registryEntries: [
        { id: 'gpt-5-5-off', fields: { effort: 'none' } },
        { id: 'gpt-5-5-hi', fields: { effort: 'high' } },
        { id: 'preprocess-gpt-5-5-hi', fields: { effort: 'high' }, preprocess: true },
        { id: 'preprocess-gpt-5-5-off', fields: { effort: 'none' }, preprocess: true },
      ],
    },
    {
      // Hidden 2026-07-12 — superseded by 5.6 Sol. Kept in the registry
      // (not deleted) so historical telemetry rows referencing it stay valid.
      // Pro is reasoning-only — Responses API exclusive, min effort 'medium'.
      hidden: true,
      apiModel: 'gpt-5.5-pro', provider: 'openai', type: 'text', label: '5.5 Pro',
      vision: true,
      efforts: ['medium', 'high', 'xhigh'],
      defaultEffort: 'medium',
      pricing: { input: 30.00, cachedInput: 3.00, output: 180.00 },
      registryEntries: [
        { id: 'gpt-5-5-pro-off', fields: { effort: 'medium' } },
      ],
    },
    {
      // Hidden 2026-07-12 — superseded by 5.6 Terra. Kept in the registry
      // (not deleted) so historical telemetry rows referencing it stay valid.
      hidden: true,
      apiModel: 'gpt-5.4', provider: 'openai', type: 'text', label: '5.4',
      vision: true,
      efforts: ['none', 'low', 'medium', 'high', 'xhigh'],
      defaultEffort: 'none',
      pricing: { input: 2.50, cachedInput: 0.25, output: 15.00 },
      registryEntries: [
        { id: 'gpt-5.4', fields: { thinkingSupported: false }, legacy: true },
      ],
    },
    {
      // Hidden 2026-07-12 — superseded by 5.6 Luna. Kept in the registry
      // (not deleted) so historical telemetry rows referencing it stay valid.
      // registryEntries (incl. the preprocess-gpt-5-4-m-off preset) stay —
      // content.js PREPROCESS_MODELS still references that id.
      hidden: true,
      apiModel: 'gpt-5.4-mini', provider: 'openai', type: 'text', label: '5.4 mini',
      vision: true,
      efforts: ['none', 'low', 'medium', 'high', 'xhigh'],
      defaultEffort: 'none',
      pricing: { input: 0.75, cachedInput: 0.075, output: 4.50 },
      registryEntries: [
        { id: 'gpt-5.4-mini', fields: { thinkingSupported: false }, legacy: true },
        { id: 'gpt-5-4-m-off', fields: { effort: 'none' } },
        { id: 'gpt-5-4-m-hi', fields: { effort: 'high' } },
        { id: 'preprocess-gpt-5-4-m-off', fields: { effort: 'none' }, preprocess: true },
      ],
    },
    {
      // Hidden 2026-07-12 — superseded by 5.6 Luna. Kept in the registry
      // (not deleted) so historical telemetry rows referencing it stay valid.
      // registryEntries (incl. the preprocess-gpt-5-4-n-off preset) stay —
      // content.js PREPROCESS_MODELS still references that id.
      // nano ignores reasoning_effort — only the 'none' button is shipped.
      hidden: true,
      apiModel: 'gpt-5.4-nano', provider: 'openai', type: 'text', label: '5.4 nano',
      vision: true,
      efforts: ['none'],
      defaultEffort: 'none',
      pricing: { input: 0.20, cachedInput: 0.02, output: 1.25 },
      registryEntries: [
        { id: 'gpt-5.4-nano', fields: { thinkingSupported: false }, legacy: true },
        { id: 'gpt-5-4-n-off', fields: { effort: 'none' } },
        { id: 'preprocess-gpt-5-4-n-off', fields: { effort: 'none' }, preprocess: true },
      ],
    },

    // ── Google · text ────────────────────────────────────────────────
    {
      // Gemini 3.5 Flash — released 2026-05-19, the default Google model.
      // Best-effort fields, verify against Google docs once GA:
      //  · apiModel — 'gemini-3.5-flash'; Gemini text models
      //    often carry a '-preview' suffix until GA, so this may need a bump.
      //  · cachedInput — no separate cache tariff published; set to input/10,
      //    the ratio every other Google text model uses here.
      //  · efforts — assumed the Flash-family set (minimal..high); only Gemini
      //    Pro rejects 'minimal', not Flash.
      // Context window: 1M in / 65K out (informational — not a registry field).
      // Routing: non-hidden google text → GOOGLE_TEXT_API_MODELS → the same
      // Google Interactions path every Gemini text model already uses; no
      // adapter change needed.
      apiModel: 'gemini-3.5-flash', provider: 'google', type: 'text', label: '3.5 Flash',
      vision: true,
      efforts: ['minimal', 'low', 'medium', 'high'],
      defaultEffort: 'low',
      pricing: { input: 1.50, cachedInput: 0.15, output: 9.00 },
      // Preprocess (subtitle-cleanup) preset — thinkingLevel minimal for a
      // fast, cheap one-shot JSON pass.
      registryEntries: [
        { id: 'preprocess-gemini-35f-min', fields: { thinkingLevel: 'minimal' }, preprocess: true },
      ],
    },
    {
      // Hidden 2026-05-22 — superseded by 3.5 Flash. Kept in the registry
      // (not deleted) so historical telemetry rows referencing it stay valid.
      // Pro rejects thinkingLevel 'minimal' (HTTP 400) — lowest tier is 'low'.
      hidden: true,
      apiModel: 'gemini-3.1-pro-preview', provider: 'google', type: 'text', label: '3.1 Pro',
      vision: true,
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'low',
      pricing: { input: 2.00, cachedInput: 0.20, output: 12.00 },
      registryEntries: [
        { id: 'gemini-3-1-pro-low', fields: { thinkingLevel: 'low' }, googleInteractions: true },
        { id: 'gemini-3-1-pro-high', fields: { thinkingLevel: 'high' }, googleInteractions: true },
        { id: 'preprocess-gemini-pro-low', fields: { thinkingLevel: 'low' }, preprocess: true },
      ],
    },
    {
      // Hidden 2026-05-22 — superseded by 3.5 Flash. Kept in the registry
      // (not deleted) so historical telemetry rows referencing it stay valid.
      hidden: true,
      apiModel: 'gemini-3-flash-preview', provider: 'google', type: 'text', label: '3 Flash',
      vision: true,
      efforts: ['minimal', 'low', 'medium', 'high'],
      defaultEffort: 'minimal',
      pricing: { input: 0.50, cachedInput: 0.05, output: 3.00 },
      registryEntries: [
        { id: 'gemini-3-flash-min', fields: { thinkingLevel: 'minimal' }, googleInteractions: true },
        { id: 'gemini-3-flash-high', fields: { thinkingLevel: 'high' }, googleInteractions: true },
      ],
    },
    {
      apiModel: 'gemini-3.1-flash-lite', provider: 'google', type: 'text', label: '3.1 Flash-Lite',
      vision: true,
      efforts: ['minimal', 'low', 'medium', 'high'],
      defaultEffort: 'minimal',
      pricing: { input: 0.25, cachedInput: 0.025, output: 1.50 },
      registryEntries: [
        { id: 'gemini-3.1-flash-lite', fields: { thinkingSupported: false }, legacy: true },
        { id: 'gemini-3-1-fl-min', fields: { thinkingLevel: 'minimal' }, googleInteractions: true },
        { id: 'gemini-3-1-fl-high', fields: { thinkingLevel: 'high' }, googleInteractions: true },
        { id: 'preprocess-gemini-fl-min', fields: { thinkingLevel: 'minimal' }, preprocess: true },
      ],
    },

    // ── Anthropic · text ─────────────────────────────────────────────
    {
      apiModel: 'claude-opus-4-8', provider: 'anthropic', type: 'text', label: 'Opus 4.8',
      vision: true,
      efforts: ['low', 'medium', 'high', 'max', 'xhigh'],
      defaultEffort: 'low',
      pricing: { input: 5.00, cachedInput: 0.50, cacheCreation: 6.25, output: 25.00 },
      // Opus 4.8 keeps Opus 4.7's request surface: adaptive thinking only,
      // effort low..max (incl. xhigh), and `temperature` deprecated — rejected
      // on every effort level. Verified live 2026-06-22 via the Models API
      // (effort/thinking capabilities identical to 4.7) + a real Messages call
      // (`temperature` → 400 "deprecated for this model"). The two background.js
      // gates that hide/strip temperature key off startsWith('claude-opus'),
      // so they cover 4.8 unchanged.
      knobQuirks: { temperature: false },
    },
    {
      // Hidden 2026-06-22 — superseded by Opus 4.8 (same price, same surface).
      // Kept in the registry (not deleted) so historical telemetry rows
      // referencing it keep valid pricing and the legacy opus-4-7-* named ids
      // still resolve — same convention as the hidden Gemini entries above.
      hidden: true,
      apiModel: 'claude-opus-4-7', provider: 'anthropic', type: 'text', label: 'Opus 4.7',
      vision: true,
      efforts: ['low', 'medium', 'high', 'max', 'xhigh'],
      defaultEffort: 'low',
      pricing: { input: 5.00, cachedInput: 0.50, cacheCreation: 6.25, output: 25.00 },
      knobQuirks: { temperature: false },
      registryEntries: [
        { id: 'opus-4-7-low', fields: { effort: 'low', thinkingSupported: true } },
        { id: 'opus-4-7-low-thinking', fields: { effort: 'low', thinkingSupported: true, thinkingDefault: true } },
        { id: 'opus-4-7-max', fields: { effort: 'max', thinkingSupported: true } },
      ],
    },
    {
      apiModel: 'claude-sonnet-4-6', provider: 'anthropic', type: 'text', label: 'Sonnet 4.6',
      vision: true,
      efforts: ['low', 'medium', 'high', 'max', 'xhigh'],
      defaultEffort: 'low',
      pricing: { input: 3.00, cachedInput: 0.30, cacheCreation: 3.75, output: 15.00 },
      // Sonnet accepts `temperature` only while adaptive thinking is off.
      knobQuirks: { temperature: 'anthropicThinking' },
      registryEntries: [
        { id: 'sonnet-4-6-low', fields: { effort: 'low', thinkingSupported: true } },
        { id: 'sonnet-4-6-low-thinking', fields: { effort: 'low', thinkingSupported: true, thinkingDefault: true } },
        { id: 'sonnet-4-6-max', fields: { effort: 'max', thinkingSupported: true } },
        // Subtitle-cleanup preset. fields:{} — no effort, no thinking;
        // preprocess is a mechanical JSON task (see buildPreprocessRequest).
        { id: 'preprocess-sonnet-4-6', fields: {}, preprocess: true },
      ],
    },
    {
      // Sonnet 5 — released 2026-06. Full effort range incl. xhigh/max (first
      // Sonnet-tier model with them). Sampling params (temperature/top_p/top_k)
      // are rejected entirely regardless of thinking state — unlike Sonnet 4.6,
      // where temperature works while adaptive thinking is off. Matches Opus
      // 4.7/4.8's request surface, not Sonnet 4.6's.
      // Pricing: intro tariff $2/$10 per 1M tokens through 2026-08-31, then
      // standard $3/$15 — bump input/cachedInput/cacheCreation/output after
      // that date if this hasn't already been revisited.
      apiModel: 'claude-sonnet-5', provider: 'anthropic', type: 'text', label: 'Sonnet 5',
      vision: true,
      efforts: ['low', 'medium', 'high', 'max', 'xhigh'],
      defaultEffort: 'low',
      pricing: { input: 2.00, cachedInput: 0.20, cacheCreation: 2.50, output: 10.00 },
      knobQuirks: { temperature: false },
    },
    {
      // Haiku does not accept output_config.effort and has no adaptive thinking.
      apiModel: 'claude-haiku-4-5-20251001', provider: 'anthropic', type: 'text', label: 'Haiku 4.5',
      vision: true,
      efforts: ['none'],
      defaultEffort: 'none',
      pricing: { input: 1.00, cachedInput: 0.10, cacheCreation: 1.25, output: 5.00 },
      registryEntries: [
        { id: 'haiku-4-5', fields: { effort: null, thinkingSupported: false } },
        // Subtitle-cleanup preset. fields:{} — Haiku takes no effort, no
        // thinking; preprocess is a mechanical JSON task.
        { id: 'preprocess-haiku-4-5', fields: {}, preprocess: true },
      ],
    },

    // ── Hidden text models — pricing/compat only, not shown in the bar ──
    {
      apiModel: 'gemini-2.5-flash-lite', provider: 'google', type: 'text', label: '2.5 Flash-Lite',
      vision: true,
      hidden: true,
      pricing: { input: 0.10, cachedInput: 0.01, output: 0.40 },
      registryEntries: [
        { id: 'gemini-2.5-flash-lite', fields: { thinkingSupported: false }, legacy: true },
      ],
    },

    // ── Voice — Realtime / Live ──────────────────────────────────────
    {
      // 2026-07-12: apiModel bumped to realtime-2.1 (id/pricing unchanged —
      // same pattern as the v1.3.1 / v1.5.213 realtime migrations). Live-
      // verified: client_secrets mint accepts the model, session echoes it.
      id: 'gpt-realtime', apiModel: 'gpt-realtime-2.1', provider: 'openai', type: 'voice',
      label: 'RT (OpenAI full)',
      pricing: {
        textInput: 4.00, textCachedInput: 0.40, textOutput: 24.00,
        audioInput: 32.00, audioCachedInput: 0.40, audioOutput: 64.00,
      },
    },
    {
      // 2026-07-12: apiModel bumped to realtime-2.1-mini (id/pricing unchanged).
      id: 'gpt-realtime-mini', apiModel: 'gpt-realtime-2.1-mini', provider: 'openai', type: 'voice',
      label: 'RT m (OpenAI mini)',
      pricing: {
        textInput: 0.60, textCachedInput: 0.06, textOutput: 2.40,
        audioInput: 10.00, audioCachedInput: 0.30, audioOutput: 20.00,
      },
    },
    {
      id: 'gemini-3.1-flash-live-preview', apiModel: 'gemini-3.1-flash-live-preview',
      provider: 'google', type: 'voice', label: 'G3.1 ♪ (Gemini 3.1)',
      pricing: {
        textInput: 0.75, textCachedInput: null, textOutput: 4.50,
        audioInput: 3.00, audioCachedInput: null, audioOutput: 12.00,
      },
    },
    {
      id: 'gemini-live-2.5-flash-native-audio',
      apiModel: 'gemini-2.5-flash-native-audio-preview-09-2025',
      provider: 'google', type: 'voice', label: 'G2.5 ♪ (Gemini 2.5)',
      pricing: {
        textInput: 0.50, textCachedInput: null, textOutput: 2.00,
        audioInput: 3.00, audioCachedInput: null, audioOutput: 12.00,
      },
    },

    // ── ASR — caption-transcription fallback (billed per audio-hour) ──
    // Prices are the PROVIDER's list price (raw). The balance is debited
    // raw × server_config.price_multiplier, and the pill shows the marked-up
    // figure the proxy returns; these entries are the local fallback for when
    // that header is absent, plus the price source for old telemetry rows.
    {
      // Primary since v1.100.0. Nova-3 Monolingual, PRE-RECORDED, Pay As You Go
      // = $0.0043/min → $0.258/audio-hour, PLUS speaker diarization $0.0020/min
      // → $0.12/audio-hour, which Lex requests (deepgram.com/pricing,
      // 2026-08-06). $0.378 total.
      //   The $0.0077/min that used to sit here is Deepgram's STREAMING rate —
      // Lex calls the batch endpoint, so it never applied and this fallback was
      // ~80% too high.
      //   Authoritative prices are the public.models rows (`deepgram:nova-3` +
      // `deepgram:addon-diarize`), summed server-side per the switches actually
      // enabled in server_config.deepgram_asr. This number is only the fallback
      // for when the X-Lex-Billed-Cost-Usd header is missing; flipping a switch
      // server-side moves the real price and leaves this one behind.
      //   Multilingual is a different tier ($0.0092/min) — the proxy derives the
      // price row from the configured model+language, so the two can't drift.
      id: 'nova-3', apiModel: 'nova-3', provider: 'deepgram', type: 'asr',
      label: 'Deepgram nova-3', role: 'primary',
      pricing: { audioHour: 0.378 },
    },
    {
      // PARKED — was the primary until v1.100.0, kept for telemetry/pricing
      // lookups on existing rows and for a one-line switch back.
      id: 'whisper-large-v3', apiModel: 'whisper-large-v3', provider: 'groq', type: 'asr',
      label: 'Groq whisper-large-v3', role: 'parked',
      pricing: { audioHour: 0 },
    },
    {
      id: 'whisper-1', apiModel: 'whisper-1', provider: 'openai', type: 'asr',
      label: 'OpenAI whisper-1', role: 'fallback',
      pricing: { audioHour: 0.36 },
    },

    // ── ASR — voice dictation (mic → text into the chat box). Not a
    // caption fallback — separate from the whisper chain above. Billed
    // per audio-hour via computeAsrCost, from OpenAI's published
    // per-minute estimates ($0.003/min mini, $0.006/min full).
    // gpt-4o-mini-transcribe is the dictation default.
    {
      id: 'gpt-4o-mini-transcribe', apiModel: 'gpt-4o-mini-transcribe',
      provider: 'openai', type: 'asr', label: 'GPT-4o mini Transcribe',
      dictationDefault: true,
      pricing: { audioHour: 0.18 },
    },
    {
      id: 'gpt-4o-transcribe', apiModel: 'gpt-4o-transcribe',
      provider: 'openai', type: 'asr', label: 'GPT-4o Transcribe',
      pricing: { audioHour: 0.36 },
    },
  ];

  // ── Derivation ─────────────────────────────────────────────────────
  // Each builder reproduces a table the old code declared by hand. The
  // shapes are byte-identical to the originals (verified by the
  // equivalence test) so every existing consumer keeps working.

  function modelId(m) { return m.id || m.apiModel; }

  // background.js MODEL_REGISTRY: legacy named ids → entry. Text models
  // contribute their registryEntries; voice models contribute one entry
  // keyed by id; asr models are not part of MODEL_REGISTRY.
  function buildModelRegistry() {
    const reg = {};
    for (const m of LEX_MODELS) {
      if (m.type === 'voice') {
        reg[modelId(m)] = { provider: m.provider, apiModel: m.apiModel, kind: 'voice' };
      } else if (m.type === 'text') {
        for (const e of (m.registryEntries || [])) {
          reg[e.id] = Object.assign({ provider: m.provider, apiModel: m.apiModel }, e.fields || {});
        }
      }
    }
    return reg;
  }

  // background.js MODEL_PRICING: apiModel → tariff.
  function buildPricing() {
    const out = {};
    for (const m of LEX_MODELS) {
      if (m.pricing) out[m.apiModel] = m.pricing;
    }
    return out;
  }

  // shared.js PROVIDER_API_MODELS: provider → ordered list of bar apiModels.
  function buildProviderApiModels() {
    const out = { openai: [], google: [], anthropic: [] };
    for (const m of LEX_MODELS) {
      if (m.type === 'text' && !m.hidden && out[m.provider]) out[m.provider].push(m.apiModel);
    }
    return out;
  }

  // shared.js API_MODEL_LABEL: apiModel → UI label (bar text models only).
  function buildApiModelLabel() {
    const out = {};
    for (const m of LEX_MODELS) {
      if (m.type === 'text' && !m.hidden && m.label) out[m.apiModel] = m.label;
    }
    return out;
  }

  // shared.js EFFORT_SUPPORT: apiModel → accepted effort values.
  function buildEffortSupport() {
    const out = {};
    for (const m of LEX_MODELS) {
      if (m.type === 'text' && m.efforts) out[m.apiModel] = m.efforts;
    }
    return out;
  }

  // shared.js DEFAULT_EFFORT: apiModel → default effort.
  function buildDefaultEffort() {
    const out = {};
    for (const m of LEX_MODELS) {
      if (m.type === 'text' && m.defaultEffort != null) out[m.apiModel] = m.defaultEffort;
    }
    return out;
  }

  // shared.js VOICE_MODEL_API: voice id → apiModel.
  function buildVoiceModelApi() {
    const out = {};
    for (const m of LEX_MODELS) {
      if (m.type === 'voice') out[modelId(m)] = m.apiModel;
    }
    return out;
  }

  // shared.js VOICE_MODEL_PROVIDER: voice id → provider.
  function buildVoiceModelProvider() {
    const out = {};
    for (const m of LEX_MODELS) {
      if (m.type === 'voice') out[modelId(m)] = m.provider;
    }
    return out;
  }

  // dictation.js default transcription model — the asr entry flagged
  // dictationDefault. Centralizes the model identity so dictation.js
  // carries no hardcoded model string.
  function buildDefaultDictationModel() {
    for (const m of LEX_MODELS) {
      if (m.type === 'asr' && m.dictationDefault) return m.apiModel;
    }
    return null;
  }

  // background.js text-API-routing Sets. Deliberately NOT filtered by
  // `hidden` — hidden only controls bar visibility (see textModelOptionsHtml /
  // providerApiModels / apiModelLabel below, which DO filter it). Routing
  // must keep working for anyone already on a hidden model (incl. via the
  // synthetic provider:apiModel:effort id the bar persists to storage), or
  // their next turn silently falls through to the legacy Chat Completions
  // path. Found+fixed 2026-07-12 during the 5.6 migration.
  function buildTextApiModelSet(provider) {
    const ids = [];
    for (const m of LEX_MODELS) {
      if (m.type === 'text' && m.provider === provider) ids.push(m.apiModel);
    }
    return new Set(ids);
  }

  // background.js USES_GOOGLE_INTERACTIONS: legacy Gemini word-click ids.
  function buildGoogleInteractions() {
    const ids = [];
    for (const m of LEX_MODELS) {
      for (const e of (m.registryEntries || [])) {
        if (e.googleInteractions) ids.push(e.id);
      }
    }
    return new Set(ids);
  }

  // ── UI <select> rendering ──────────────────────────────────────────
  // Markup builders for the model dropdowns. String-only (no DOM) so the
  // file stays valid in the service worker; content.js interpolates the
  // result into its panel templates.

  const PROVIDER_GROUP_LABEL = { openai: 'ChatGPT', google: 'Gemini', anthropic: 'Claude' };

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // <optgroup>/<option> markup for the text-model <select>. Option value
  // is the synthetic `provider:apiModel` id the model bars expect. Hidden
  // models are skipped; order follows LEX_MODELS within each provider.
  function textModelOptionsHtml() {
    let html = '';
    for (const provider of ['openai', 'google', 'anthropic']) {
      const opts = LEX_MODELS.filter(
        (m) => m.type === 'text' && !m.hidden && m.provider === provider,
      );
      if (!opts.length) continue;
      html += '<optgroup label="' + esc(PROVIDER_GROUP_LABEL[provider] || provider) + '">';
      for (const m of opts) {
        html += '<option value="' + esc(provider + ':' + m.apiModel) + '">'
          + esc(m.label) + '</option>';
      }
      html += '</optgroup>';
    }
    return html;
  }

  // <optgroup>/<option> markup for an ACTION-MODE text-model <select>. Unlike the
  // bar (textModelOptionsHtml — 2-part id + a separate effort dropdown), each
  // option value is a FULL synthetic id `provider:apiModel:defaultEffort` (one
  // control, default effort, like the re-ask menu). A leading option (value="")
  // = inherit the host surface's model — `inheritLabel` is its i18n string.
  // Reuses PROVIDER_GROUP_LABEL so action selects can't drift from the main bar.
  function actionModelOptionsHtml(inheritLabel) {
    let html = '<option value="">' + esc(inheritLabel != null ? inheritLabel : '') + '</option>';
    for (const provider of ['openai', 'google', 'anthropic']) {
      const opts = LEX_MODELS.filter(
        (m) => m.type === 'text' && !m.hidden && m.provider === provider,
      );
      if (!opts.length) continue;
      html += '<optgroup label="' + esc(PROVIDER_GROUP_LABEL[provider] || provider) + '">';
      for (const m of opts) {
        const eff = (m.defaultEffort != null && m.defaultEffort !== '') ? m.defaultEffort : 'none';
        html += '<option value="' + esc(provider + ':' + m.apiModel + ':' + eff) + '">'
          + esc(m.label) + '</option>';
      }
      html += '</optgroup>';
    }
    return html;
  }

  // <option> markup for the voice-model <select> (flat, no optgroup).
  function voiceModelOptionsHtml() {
    let html = '';
    for (const m of LEX_MODELS) {
      if (m.type !== 'voice') continue;
      html += '<option value="' + esc(modelId(m)) + '">' + esc(m.label) + '</option>';
    }
    return html;
  }

  // ── Knob capability ────────────────────────────────────────────────
  // Which settings-knobs a model accepts. Empirically verified (1.4.1
  // audit). Replaces the hand-coded switch in shared.js knobSupports and
  // the inline VOICE_KNOB_AVAILABILITY matrix.

  // Per-provider baseline for the five text knobs. Per-model deviations
  // live in a model's knobQuirks field. Rule values:
  //   true / false        — always / never supported
  //   'openaiReasoning'   — temperature ok only when reasoning is off
  //                         (effort none / minimal / empty)
  //   'anthropicThinking' — temperature ok only when adaptive thinking is off
  const PROVIDER_TEXT_KNOBS = {
    openai:    { temperature: 'openaiReasoning', maxTokens: true, seed: false, verbosity: true,  serviceTier: true  },
    google:    { temperature: true,              maxTokens: true, seed: true,  verbosity: false, serviceTier: false },
    anthropic: { temperature: true,              maxTokens: true, seed: false, verbosity: false, serviceTier: false },
  };

  const MODELS_BY_API = {};
  for (const m of LEX_MODELS) MODELS_BY_API[m.apiModel] = m;

  const builtModelRegistry = buildModelRegistry();

  // Resolve a modelId — synthetic `provider:apiModel:effort` or a legacy
  // named id — into { provider, apiModel, effort, thinkingActive }.
  // Returns null when it matches neither form.
  function resolveModelFacts(modelId) {
    if (!modelId || typeof modelId !== 'string') return null;
    const parts = modelId.split(':');
    if (parts.length === 3 && ['openai', 'google', 'anthropic'].includes(parts[0]) && parts[1]) {
      return { provider: parts[0], apiModel: parts[1], effort: parts[2] || null, thinkingActive: false };
    }
    const entry = builtModelRegistry[modelId];
    if (entry) {
      return {
        provider: entry.provider,
        apiModel: entry.apiModel,
        effort: entry.effort != null ? entry.effort : null,
        thinkingActive: !!entry.thinkingDefault,
      };
    }
    return null;
  }

  // Каждая текстовая модель обязана объявить `vision` явно. Не забыл — значит
  // решил. Проверка стоит на загрузке модуля и БРОСАЕТ: реестр — статические
  // данные, так что упасть она может только у того, кто прямо сейчас добавляет
  // модель, и упадёт сразу, на первом же перезапуске расширения. Мягкий
  // console.warn тут не годится — он потонул бы в логе, а человек получил бы
  // навсегда недоступный пункт «прикрепить файл» без единого следа почему.
  function assertVisionDeclared(models) {
    const missing = models
      .filter((m) => m.type === 'text' && typeof m.vision !== 'boolean')
      .map((m) => m.apiModel);
    if (missing.length) {
      throw new Error('[LexModelRegistry] у текстовых моделей не объявлено поле vision: '
        + missing.join(', ') + '. Проставь true/false явно — умолчания нет по замыслу.');
    }
  }
  assertVisionDeclared(LEX_MODELS);

  // Умеет ли выбранная модель читать картинку. modelId — синтетический
  // `provider:apiModel:effort` или легаси-имя; неизвестный id → false
  // (прикладывать картинку в неизвестность нельзя).
  function visionSupported(modelId) {
    const facts = resolveModelFacts(modelId);
    if (!facts) return false;
    const model = MODELS_BY_API[facts.apiModel];
    return !!(model && model.vision);
  }

  // Is a text-mode knob (temperature / maxTokens / seed / verbosity /
  // serviceTier) supported for the given modelId?
  function textKnobSupported(knobName, modelId) {
    if (!modelId) return false;
    const facts = resolveModelFacts(modelId);
    if (!facts) return knobName === 'maxTokens';
    const base = PROVIDER_TEXT_KNOBS[facts.provider] || {};
    const model = MODELS_BY_API[facts.apiModel];
    const quirks = (model && model.knobQuirks) || {};
    const rule = (knobName in quirks) ? quirks[knobName] : base[knobName];
    if (rule === undefined) return true;
    if (rule === true || rule === false) return rule;
    if (rule === 'openaiReasoning') {
      return !facts.effort || facts.effort === 'none' || facts.effort === 'minimal';
    }
    if (rule === 'anthropicThinking') return !facts.thinkingActive;
    return true;
  }

  // Voice-knob capability — per knob, which providers (and optionally
  // which voice models) expose it. Read by applyKnobsToPanel in shared.js.
  // voiceThinkingLevel: only Gemini 3.1 Flash Live exposes the field; on
  // 2.5 native-audio it has no effect.
  const VOICE_PROVIDERS_ALL = ['openai', 'google'];
  const VOICE_KNOB_AVAILABILITY = {
    voiceName:                  { providers: VOICE_PROVIDERS_ALL },
    voiceSpeed:                 { providers: ['openai'] },
    voiceMaxResponseTokens:     { providers: VOICE_PROVIDERS_ALL },
    voiceNoiseReduction:        { providers: ['openai'] },
    voiceTranscriptionModel:    { providers: ['openai'] },
    voiceTranscriptionLanguage: { providers: ['openai'] },
    voiceTranscriptionPrompt:   { providers: ['openai'] },
    voiceVadThreshold:          { providers: VOICE_PROVIDERS_ALL },
    voicePrefixPaddingMs:       { providers: VOICE_PROVIDERS_ALL },
    voiceSilenceDurationMs:     { providers: VOICE_PROVIDERS_ALL },
    voiceIdleTimeoutSec:        { providers: ['openai'] },
    voiceInterruptResponse:     { providers: VOICE_PROVIDERS_ALL },
    voiceEndSensitivity:        { providers: VOICE_PROVIDERS_ALL },
    voiceLongSessions:          { providers: ['google'] },
    voiceOutputLanguage:        { providers: ['google'] },
    voiceThinkingLevel:         { providers: ['google'], models: ['gemini-3.1-flash-live-preview'] },
    // Live-verified 2026-07-12 against gpt-realtime-2.1/-mini AND the old
    // gpt-realtime-2 (not new to 2.1 — Lex just never exposed it): session
    // accepts `reasoning: {effort}` with the full none/minimal/low/medium/
    // high/xhigh range (unlike Responses API text models, 'minimal' is NOT
    // rejected here).
    voiceReasoningEffort:       { providers: ['openai'] },
  };

  // Response-length ceiling for voiceMaxResponseTokens, per voice model —
  // the ONE knob where OpenAI and Gemini limits genuinely diverge (a value
  // valid for one is rejected by the other, and the storage cell is shared
  // across provider switches). Keyed by BOTH the UI voice-model id
  // (LEX_MODELS[].id — what chat-surface.js's applyKnobsToPanelLocal has)
  // AND the resolved apiModel string (what chat-knobs.js's Gemini config
  // builder receives from voice/gemini-live.js) — id and apiModel differ
  // for gpt-realtime and for gemini-live-2.5-flash-native-audio, so both
  // forms are listed rather than making every caller resolve one to the
  // other first.
  // Sources (2026-07): OpenAI Realtime max_output_tokens — hard schema cap
  // 1–4096 (openai-openapi.yaml RealtimeSessionCreateRequestGA). Gemini
  // 3.1 Flash Live — 65536 (ai.google.dev model page, confirmed). Gemini
  // 2.5 native-audio — ~8192, INFERRED from the -12-2025 sibling model page;
  // no dedicated docs page exists for Lex's exact -09-2025 apiModel.
  const VOICE_MAX_RESPONSE_TOKENS_CEILING = {
    'gpt-realtime': 4096,
    'gpt-realtime-2': 4096,                                 // pre-2026-07-12 apiModel of 'gpt-realtime', kept for compat
    'gpt-realtime-2.1': 4096,                               // apiModel of 'gpt-realtime' since 2026-07-12
    'gpt-realtime-mini': 4096,
    'gpt-realtime-2.1-mini': 4096,                          // apiModel of 'gpt-realtime-mini' since 2026-07-12
    'gemini-3.1-flash-live-preview': 65536,                 // id === apiModel for this one
    'gemini-live-2.5-flash-native-audio': 8192,             // UI id
    'gemini-2.5-flash-native-audio-preview-09-2025': 8192,  // its apiModel
  };
  const VOICE_MAX_RESPONSE_TOKENS_CEILING_DEFAULT = 4096; // tightest of the three — safe fallback for an unknown/unresolved voice model.

  // Resolve a model string — a synthetic id ("provider:apiModel:effort"), a bare
  // apiModel, or a server-echoed dated actualModel ("gpt-5.5-2026-04-23") — to
  // its short UI label ("5.5", "3.5 Flash", "Opus 4.8"), the same label shown in
  // the model bar / re-ask menu. Falls back to the input string when unknown.
  function labelForModel(modelStr) {
    if (!modelStr) return '';
    let api = String(modelStr);
    if (api.indexOf(':') !== -1) {
      const parts = api.split(':');
      if (parts[1]) api = parts[1];
    }
    let m = LEX_MODELS.find((x) => x.apiModel === api);
    if (!m) {
      // Dated / suffixed actualModel → the longest apiModel that prefixes it
      // (so "gpt-5.5-pro-…" picks "gpt-5.5-pro", not "gpt-5.5").
      const cands = LEX_MODELS
        .filter((x) => x.apiModel && (api === x.apiModel || api.indexOf(x.apiModel + '-') === 0))
        .sort((a, b) => b.apiModel.length - a.apiModel.length);
      m = cands[0];
    }
    return (m && m.label) ? m.label : String(modelStr);
  }

  // Цена одного текстового вызова. Живёт здесь, а не в background.js: тарифы
  // уже здесь, функция чистая, и обеим поверхностям нужна одна и та же — веб-
  // версии модуль service worker'а недоступен в принципе, а вторая копия
  // тарифной арифметики разошлась бы с первой на первом же новом провайдере.
  const PRICING = buildPricing();

  function computeCost(apiModel, totalInputTokens, cachedInputTokens, cacheCreationTokens, outputTokens) {
    const price = PRICING[apiModel];
    if (!price || price.input == null) return null;
    const cached  = cachedInputTokens   || 0;
    const created = cacheCreationTokens || 0;
    const nonCached = Math.max(0, (totalInputTokens || 0) - cached - created);
    // Fallback to base input price when the provider has no separate cache-
    // creation tariff — for those providers `created` is always 0, so the
    // fallback never actually contributes.
    const cacheCreationPrice = (price.cacheCreation != null) ? price.cacheCreation : price.input;
    const cachedReadPrice    = (price.cachedInput   != null) ? price.cachedInput   : price.input;
    const inputCost =
      (nonCached / 1e6) * price.input +
      (cached    / 1e6) * cachedReadPrice +
      (created   / 1e6) * cacheCreationPrice;
    const outputCost = ((outputTokens || 0) / 1e6) * price.output;
    return { inputCost, outputCost };
  }

  global.LexModelRegistry = {
    models: LEX_MODELS,
    labelForModel,
    modelId,
    // pre-built derived tables (computed once at load)
    modelRegistry: builtModelRegistry,
    pricing: PRICING,
    computeCost,
    providerApiModels: buildProviderApiModels(),
    apiModelLabel: buildApiModelLabel(),
    effortSupport: buildEffortSupport(),
    defaultEffort: buildDefaultEffort(),
    voiceModelApi: buildVoiceModelApi(),
    voiceModelProvider: buildVoiceModelProvider(),
    defaultDictationModel: buildDefaultDictationModel(),
    openaiTextApiModels: buildTextApiModelSet('openai'),
    googleTextApiModels: buildTextApiModelSet('google'),
    googleInteractions: buildGoogleInteractions(),
    // UI <select> markup builders
    textModelOptionsHtml,
    actionModelOptionsHtml,
    voiceModelOptionsHtml,
    // knob capability
    textKnobSupported,
    // вложения: умеет ли модель читать картинку
    visionSupported,
    voiceKnobAvailability: VOICE_KNOB_AVAILABILITY,
    voiceMaxResponseTokensCeiling: VOICE_MAX_RESPONSE_TOKENS_CEILING,
    voiceMaxResponseTokensCeilingDefault: VOICE_MAX_RESPONSE_TOKENS_CEILING_DEFAULT,
  };
})(typeof self !== 'undefined' ? self : globalThis);
