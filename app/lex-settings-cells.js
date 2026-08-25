// lex-settings-cells.js — ОДНО описание ячеек настроек, данными.
//
// До этого модуля одни и те же факты о ячейке (как называется ключ, какие у
// неё слоты, как они подписаны, что лежит по умолчанию, куда её адресовать в
// серверном каталоге промптов) были размазаны по четырём местам:
//
//   background.js        — двенадцать функций init*Storage, каждая со своей
//                          копией «get → чего нет, то досеять → set»;
//   chat-surface.js      — CHAT_PROMPT_IDS / DEFAULT_*_NAMES + реестр
//                          getPromptGroupConfig (имена ключей ещё раз);
//   settings-popover.js  — PROMPT_GROUPS (ячейки trans/preprocess/tutor
//                          статикой) + SERVER_PROMPT_REF_BY_KEY (адреса ещё раз);
//   chat-prompts.js      — имена ключей и id слотов литералами в четырёх
//                          читалках.
//
// Теперь факты живут здесь, а перечисленные файлы их спрашивают. Модуль
// намеренно ГРУЗИТСЯ В ОБА РЕАЛМА — в service worker (importScripts) и в
// страницу (manifest content_scripts + STANDALONE_CHAT_DEPS): именно поэтому
// он может закрыть расхождение, которое до него закрывалось руками, — см.
// «Ручки» ниже.
//
// ⚠️ ЧЕГО ЗДЕСЬ НЕТ И БЫТЬ НЕ ДОЛЖНО — классификация публикуемости.
// Она живёт в background.js (SETTINGS_MACHINE_LOCAL_EXACT / SCOPE_BY_DIRECT_KEY
// / isPublishableKey) и НЕ выводится из формы хранения. Пример, на котором это
// видно: текст публикуется у voicePrompts и wordClickVoicePrompts, но НЕ
// публикуется у chatPrompts / wordClickPrompts / preprocessPrompts /
// transcriptionPrompts — потому что тексты последних переехали в серверный
// каталог, а голосовые остались клиентскими. Это продуктовое решение, а не
// свойство ячейки. Сгенерируй классификацию по шаблону «у ячейки есть слоты →
// ячейка такая-то» — и это правило развалится молча, без единой ошибки.
// Новая ячейка по-прежнему обязана быть вписана в классификацию ВРУЧНУЮ, тем
// же коммитом (docs/LESSONS.md, запись 2026-07-30).
(function (global) {
  'use strict';

  // ── Тексты по умолчанию ─────────────────────────────────────────────────
  // Дословно те, что раньше лежали константами в background.js. Здесь они
  // потому, что здесь же описаны слоты, куда они садятся; background.js
  // продолжает звать их прежними именами через алиасы.

  // Verbatim-промпт внеполосной расшифровки: формулировка из примера
  // realtime_out_of_band_transcription в кукбуке OpenAI — ответ обязан быть
  // тем, что человек сказал, со всеми ошибками (ради этого OOB и берут вместо
  // mini-transcribe).
  const TRANSCRIPTION_PROMPT_1_DEFAULT =
    "Return verbatim transcript of the user's last speech turn. " +
    "Do not correct grammar. Do not add or remove articles. " +
    "Do not change verb tenses. Preserve every error exactly as said. " +
    "Return only the transcript, no commentary.";

  const PRONUNCIATION_TUTOR_PROMPT_DEFAULT = `Ты — учитель английского произношения. После каждой попытки ученика тебе приходит сообщение — обычно JSON с оценкой произношения от Microsoft Speech или SpeechAce, иногда короткая фраза о технической проблеме (микрофон не услышал речь, ошибка сервиса, нет доступа к микрофону).

Твоя задача:
- Если пришёл JSON: прочитай его, найди слабые места — фонемы с низкими score'ами или несовпадение «expected» vs «actual» (для SpeechAce — sound_most_like; для Microsoft — top-1 из NBestPhonemes). Голосом коротко и по-человечески объясни ученику что не так и как поправить. Например: «У тебя слабое 'th' — поставь язык между зубами, попробуй ещё раз». Или: «Ты сказал 'zer' вместо 'the' — это межзубный звук, не 'з'».
- Если попытка отличная (overall_score > 90) — коротко похвали и предложи переходить к следующему слову.
- Если пришла фраза «не услышал речь» — скажи коротко «не услышал тебя, попробуй ближе к микрофону» или похожее.
- Если пришла фраза о доступе к микрофону — попроси разрешить микрофон для youtube.com.
- Если пришла фраза о технической ошибке — скажи что это технический сбой и попроси попробовать ещё раз.
- НЕ зачитывай JSON. НЕ сыпь цифрами. НЕ повторяй контекст ошибки дословно — переформулируй коротко.
- Если ученик задаёт вопрос голосом — отвечай на него, потом возвращайся к разбору.
- Говори на русском, конкретные английские слова и фонемы называй на английском.`;

  // ── Ячейки со слотами {name, text} + указатель активного слота ───────────
  // Семь ячеек одной формы. Раньше — семь почти дословных копий одной функции
  // в background.js плюс их же имена в трёх читателях.
  //
  // `ref` — адрес строки в серверном каталоге промптов: ВЛАДЕЛЕЦ ячейки, а не
  // scope читающей поверхности. Суперчат, продолжающий беседу по видео, читает
  // chatPrompts, и её scope остаётся 'shorts-main' — иначе сервер не найдёт
  // строку и турн уйдёт без промпта, молча.
  //
  // Пустой text у слота — не «забыли заполнить»: тексты учителя переехали в
  // серверный каталог (PLAN-VOICE-PROMPT-SERVER Ш7), клиенту они больше не
  // нужны, и слот сеется пустым. Имена слотов остались — это подписи вкладок
  // в редакторе.
  const SLOT_CELLS = {
    chatPrompts: {
      key: 'chatPrompts',
      activeIdKey: 'activeChatPromptId',
      refScope: 'shorts-main',
      slots: [
        { id: 'chatB1', name: 'Чат 1', text: '' },
        { id: 'chatB2', name: 'Чат 2', text: '' },
      ],
    },
    voicePrompts: {
      key: 'voicePrompts',
      activeIdKey: 'activeVoicePromptId',
      refScope: 'shorts-main',
      slots: [
        { id: 'voice1', name: 'Voice 1', text: '' },
        { id: 'voice2', name: 'Voice 2', text: '' },
      ],
    },
    wordClickPrompts: {
      key: 'wordClickPrompts',
      activeIdKey: 'activeWordClickPromptId',
      refScope: 'wordchat',
      slots: [
        { id: 'wordClick1', name: 'Chunk', text: '' },
        { id: 'wordClick2', name: 'Слово', text: '' },
      ],
    },
    wordClickVoicePrompts: {
      key: 'wordClickVoicePrompts',
      activeIdKey: 'activeWordClickVoicePromptId',
      refScope: 'wordchat',
      slots: [
        { id: 'wcVoice1', name: 'Chunk-voice', text: '' },
        { id: 'wcVoice2', name: 'Слово-voice', text: '' },
      ],
    },
    transcriptionPrompts: {
      key: 'transcriptionPrompts',
      activeIdKey: 'activeTranscriptionPromptId',
      refScope: 'shorts-main',
      slots: [
        { id: 'transcription1', name: 'Verbatim', text: TRANSCRIPTION_PROMPT_1_DEFAULT },
        { id: 'transcription2', name: 'Custom', text: '' },
      ],
    },
    preprocessPrompts: {
      key: 'preprocessPrompts',
      activeIdKey: 'activePreprocessPromptId',
      refScope: 'shorts-main',
      slots: [
        { id: 'preprocessPrompt1', name: 'Лексический препроцесс', text: '' },
        { id: 'preprocessPrompt2', name: 'Только пунктуация', text: '' },
      ],
    },
    // Единственная ячейка с суффиксом scope в самом имени ключа. История:
    // одна голая ячейка на всех → сплит по поверхностям 2026-07-11 (v1.74.1) →
    // обратно ОДНА, но уже под именем nativePrompts_shorts-main, 2026-08-10.
    // К голому имени не возвращались намеренно: живая и правленая — именно
    // scoped-ячейка, а голая мертва и воскрешать её значит тихо поднять
    // месячной давности содержимое.
    nativePrompts: {
      key: 'nativePrompts',
      activeIdKey: 'activeNativePromptId',
      refScope: 'shorts-main',
      scopes: ['shorts-main'],       // ключи получают '_<scope>'
      migrateFromBare: true,         // голая ячейка = источник первого сева
      slots: [
        { id: 'chatB1', name: 'Native', text: '' },
        { id: 'chatB2', name: 'Чат 2', text: '' },
      ],
    },
  };

  // Ячейка-строка (без слотов) — редактор правит её как один текст.
  const STRING_CELLS = {
    pronunciationTutorPrompt: {
      key: 'pronunciationTutorPrompt',
      refScope: 'tutor',
      text: PRONUNCIATION_TUTOR_PROMPT_DEFAULT,
    },
  };

  // ── Ручки ────────────────────────────────────────────────────────────────
  // Ровно тот список, что раньше стоял двумя копиями: KNOB_KEYS/KNOB_DEFAULTS/
  // KNOB_SCOPES в chat-knobs.js (страница) и литеральный KNOB_DEFAULTS/SCOPES в
  // initKnobScopesStorage (service worker). Копий было две, потому что «SW не
  // может импортировать модуль страницы» — этот модуль грузится в оба реалма,
  // так что причина исчезла, и с ней исчезает обязательство «keep in sync»,
  // которое уже один раз не сдержали: knobVoiceReasoningEffort появился только
  // в одной из копий, ячейки не заводилось, и session.reasoning не уходил вовсе.
  // Порядок ключей здесь И ЕСТЬ список ручек: chat-knobs.js выводит свой
  // KNOB_KEYS из Object.keys(KNOB_DEFAULTS), поэтому «ключ есть, а дефолта
  // нет» (и наоборот) стало невозможно по построению. Пустое значение /
  // null означает «не передавать эту ручку в API».
  const KNOB_DEFAULTS = {
    // ── Текстовые ──
    knobTemperature: 1,
    knobMaxTokens: '',
    knobSeed: '',
    knobVerbosity: 'medium',
    knobServiceTier: 'auto',
    // ── Голос, база (1.4.1) ──
    // v1.5.100: knobVoiceName снят — имя голоса живёт в voiceNamesByProvider,
    // по провайдеру, и через этот список не ходит.
    knobVoiceSpeed: 1,
    // ── Голос, продвинутые (1.4.3) — только OpenAI Realtime ──
    // Каждая ложится в конкретное поле session.update (applyVoiceKnobsToSession).
    knobVoiceMaxResponseTokens: '',                    // session.max_response_output_tokens
    knobVoiceNoiseReduction: 'off',                    // audio.input.noise_reduction.type ('off'|'near_field'|'far_field')
    knobVoiceTranscriptionModel: 'gpt-4o-mini-transcribe', // audio.input.transcription.model
    knobVoiceTranscriptionLanguage: 'en',              // audio.input.transcription.language
    knobVoiceTranscriptionPrompt: '',                  // audio.input.transcription.prompt
    knobVoiceVadThreshold: 0.75,                       // audio.input.turn_detection.threshold
    knobVoicePrefixPaddingMs: 300,                     // audio.input.turn_detection.prefix_padding_ms
    knobVoiceSilenceDurationMs: 1500,                  // audio.input.turn_detection.silence_duration_ms
    knobVoiceIdleTimeoutSec: '',                       // → turn_detection.idle_timeout_ms (×1000)
    // ── Голос 1.4.5 — прерывание/чувствительность конца (оба провайдера),
    // длинные сессии / язык вывода / размышление (только Gemini) ──
    knobVoiceInterruptResponse: 'interrupt',           // OpenAI: turn_detection.interrupt_response; Gemini: realtimeInputConfig.activityHandling
    knobVoiceEndSensitivity: 0.5,                      // OpenAI: semantic_vad eagerness; Gemini: endOfSpeechSensitivity. 0.5 = оставить серверный дефолт
    knobVoiceLongSessions: false,                      // Gemini: contextWindowCompression
    knobVoiceOutputLanguage: 'auto',                   // Gemini: speechConfig.languageCode
    knobVoiceThinkingLevel: 'minimal',                 // Gemini 3.1 Flash Live: thinkingConfig.thinkingLevel
    // Эта ручка и есть тот случай, ради которого список свели в одно место:
    // она была в одной копии и отсутствовала в другой — ячейки не заводилось,
    // getChatKnobs отдавал undefined, и session.reasoning не уходил вовсе.
    knobVoiceReasoningEffort: 'none',                  // OpenAI Realtime: session.reasoning.effort ('none' = не слать вовсе)
  };
  // Текстовое подмножество — держится отдельно для справки (им пользуется
  // разметка ручек), но НЕ дублирует значения: только имена.
  const TEXT_KNOB_KEYS = ['knobTemperature', 'knobMaxTokens', 'knobSeed', 'knobVerbosity', 'knobServiceTier'];
  // 'standalone' здесь НЕТ намеренно: суперчат делит ручки с видео-чатом
  // (settingsScope='shorts-main'). Вернёшь его — сеятель на КАЖДОМ буте будет
  // пересоздавать мёртвые knob*_standalone сразу после их чистки.
  // (Классификатор публикации при этом слово 'standalone' всё ещё знает —
  // асимметрия словарей известная и осознанная.)
  const KNOB_SCOPES = ['shorts-main', 'wordchat', 'tutor'];

  // ── Модели по поверхностям ───────────────────────────────────────────────
  // Scoped-ячейки сеются ОДИН раз из текущего общего выбора, чтобы при первом
  // запуске ничего не прыгнуло. Общий ключ никогда не выставлялся (чистая
  // установка) → scoped тоже остаётся пустым, и резолверы падают на свои
  // фиксированные дефолты, а не на чужое окно.
  const MODEL_SCOPE_CELLS = {
    text:  { from: 'activeModelId',      cells: ['activeModelId_shorts-main', 'activeModelId_wordchat', 'tutorTextModelId'] },
    voice: { from: 'activeVoiceModelId', cells: ['activeVoiceModelId_shorts-main', 'activeVoiceModelId_wordchat', 'tutorVoiceModelId'] },
  };

  // ── Скаляры с проверкой значения ─────────────────────────────────────────
  const DEFAULT_VOICE_MODEL_ID = 'gpt-realtime';

  const VALID_SPEECH_ENGINES = [
    // Web Speech API — синтезирует сам браузер/система. Единственный движок,
    // который работает сегодня. КАКОЙ голос — отдельная настройка (speechVoiceName).
    'system-default',
    // Провайдерские. Есть и в списке, и в выпадашке, но путь выключен на
    // PROVIDER_TTS_ENABLED (content.js): ни серверного маршрута, ни оплаты у
    // него нет. В списке — чтобы сохранённое значение не переписывалось молча.
    'gemini-live', 'gemini-tts', 'openai-realtime', 'openai-tts',
    'elevenlabs-flash-us', 'elevenlabs-flash-uk',
  ];
  // Сняты 2026-08-07: это были не движки, а закреплённые имена голосов. Работу
  // делает настройка Voice, читающая реальный список машины. Держим их
  // отдельным набором, чтобы сохранённое значение нормализовалось ТИХО:
  // счётчик потерь здесь пометил бы НАШЕ переименование как потерю у человека.
  const RETIRED_SPEECH_ENGINES = [
    'system-allison-premium', 'system-daniel-enhanced',
    'google-us-network', 'google-uk-f-network', 'google-uk-m-network',
  ];
  const SPEECH_RATE_MIN = 0.5;
  const SPEECH_RATE_MAX = 1.5;
  const SPEECH_RATE_DEFAULT = 1.0;

  const PRONUNCIATION_SERVICES = ['microsoft', 'speechace'];
  const PRONUNCIATION_DIALECTS = ['us', 'gb'];

  // ── Резолв имён ключей ───────────────────────────────────────────────────
  function scopedKey(base, scope) { return scope ? (base + '_' + scope) : base; }

  // Ячейка → та же форма, которую исторически возвращал
  // chat-surface.js getPromptGroupConfig: {storageKey, activeIdStorageKey, ref,
  // slots:[{id, defaultName}]}. Неизвестное имя → null, и это НЕ мягкий откат
  // на чат: опечатка обязана падать громко, а не утекать промптом главного
  // чата на чужую поверхность.
  function cellFor(name) {
    const desc = SLOT_CELLS[name];
    if (!desc) return null;
    const scope = (desc.scopes && desc.scopes[0]) || null;
    return {
      storageKey: scopedKey(desc.key, scope),
      activeIdStorageKey: scopedKey(desc.activeIdKey, scope),
      ref: { scope: desc.refScope, cell: desc.key },
      slots: desc.slots.map((s) => ({ id: s.id, defaultName: s.name })),
      defaultActiveId: desc.slots[0].id,
    };
  }

  function stringCellFor(name) {
    const desc = STRING_CELLS[name];
    if (!desc) return null;
    return { storageKey: desc.key, ref: { scope: desc.refScope, cell: desc.key } };
  }

  // ── Сеяние ───────────────────────────────────────────────────────────────
  // Общая рамка: прочитать нужные ключи → собрать ТОЛЬКО недостающее →
  // записать, если есть что. Идемпотентно: заполненную ячейку сев не трогает.
  // Раньше эта рамка была переписана двенадцать раз.
  function seed(keys, computeUpdates, label, deps) {
    const log = (deps && deps.log) || function () {};
    return new Promise((resolve) => {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) { resolve(); return; }
      chrome.storage.local.get(keys, (result) => {
        let updates;
        try { updates = computeUpdates(result || {}) || {}; }
        catch (_) { resolve(); return; }
        const names = Object.keys(updates);
        if (!names.length) { resolve(); return; }
        chrome.storage.local.set(updates, () => {
          log(label + ':', names.join(', '));
          resolve();
        });
      });
    });
  }

  function seedSlotCell(name, deps) {
    const desc = SLOT_CELLS[name];
    if (!desc) return Promise.resolve();
    const scopes = desc.scopes || [null];
    const keys = [];
    if (desc.migrateFromBare) keys.push(desc.key, desc.activeIdKey);
    scopes.forEach((scope) => {
      keys.push(scopedKey(desc.key, scope), scopedKey(desc.activeIdKey, scope));
    });
    const slotObject = () => {
      const o = {};
      desc.slots.forEach((s) => { o[s.id] = { name: s.name, text: s.text }; });
      return o;
    };
    return seed(keys, (r) => {
      const updates = {};
      // Голая ячейка при первом севе scoped-ячейки: значение КОПИРУЕТСЯ, сама
      // голая остаётся лежать (мёртвый leftover — рантайм её не читает).
      const legacySlots = desc.migrateFromBare ? (r[desc.key] || null) : null;
      const legacyActiveId = desc.migrateFromBare ? (r[desc.activeIdKey] || null) : null;
      scopes.forEach((scope) => {
        const slotsKey = scopedKey(desc.key, scope);
        const activeKey = scopedKey(desc.activeIdKey, scope);
        if (!r[slotsKey]) updates[slotsKey] = legacySlots || slotObject();
        if (!r[activeKey]) updates[activeKey] = legacyActiveId || desc.slots[0].id;
      });
      return updates;
    }, 'Slot cell seeded (' + name + ')', deps);
  }

  function seedStringCell(name, deps) {
    const desc = STRING_CELLS[name];
    if (!desc) return Promise.resolve();
    // Пустая строка — законный выбор человека (он её осознанно стёр). Сеем
    // только когда ключа нет ВОВСЕ.
    return seed([desc.key], (r) => (
      typeof r[desc.key] === 'string' ? {} : { [desc.key]: desc.text }
    ), 'String cell seeded (' + name + ')', deps);
  }

  function seedKnobScopes(deps) {
    const globalKeys = Object.keys(KNOB_DEFAULTS);
    const scopedKeys = [];
    KNOB_SCOPES.forEach((s) => globalKeys.forEach((k) => scopedKeys.push(k + '_' + s)));
    return seed(globalKeys.concat(scopedKeys), (r) => {
      const updates = {};
      KNOB_SCOPES.forEach((s) => {
        globalKeys.forEach((k) => {
          const cell = k + '_' + s;
          if (r[cell] === undefined) updates[cell] = (r[k] !== undefined) ? r[k] : KNOB_DEFAULTS[k];
        });
      });
      return updates;
    }, 'Per-surface knob storage seeded', deps);
  }

  function seedModelScopes(deps) {
    const groups = Object.keys(MODEL_SCOPE_CELLS).map((k) => MODEL_SCOPE_CELLS[k]);
    const readKeys = groups.reduce((acc, g) => acc.concat([g.from], g.cells), []);
    return seed(readKeys, (r) => {
      const updates = {};
      groups.forEach((g) => {
        if (r[g.from] === undefined) return;    // общего выбора не было — scoped не трогаем
        g.cells.forEach((cell) => { if (r[cell] === undefined) updates[cell] = r[g.from]; });
      });
      return updates;
    }, 'Per-surface model storage seeded', deps);
  }

  function seedVoiceModel(deps) {
    return seed(['activeVoiceModelId'], (r) => (
      r.activeVoiceModelId ? {} : { activeVoiceModelId: DEFAULT_VOICE_MODEL_ID }
    ), 'Voice model storage initialized', deps);
  }

  function seedPronunciation(deps) {
    const keys = ['pronunciationService', 'pronunciationDialect', 'pronunciationSilenceTimeoutMs',
      'pronunciationStrictMode'];
    return seed(keys, (r) => {
      const updates = {};
      if (PRONUNCIATION_SERVICES.indexOf(r.pronunciationService) < 0) updates.pronunciationService = PRONUNCIATION_SERVICES[0];
      if (PRONUNCIATION_DIALECTS.indexOf(r.pronunciationDialect) < 0) updates.pronunciationDialect = PRONUNCIATION_DIALECTS[0];
      const s = Number(r.pronunciationSilenceTimeoutMs);
      if (!Number.isFinite(s) || s < 500 || s > 5000) updates.pronunciationSilenceTimeoutMs = 1500;
      if (typeof r.pronunciationStrictMode !== 'boolean') updates.pronunciationStrictMode = false;
      return updates;
    }, 'Pronunciation storage initialized', deps);
  }

  // Озвучка слова. Отличие от остальных сеятелей: отказ от сохранённого
  // значения здесь НЕ молчаливый. Отсутствие ключа — это сев (тихо), а
  // непонятное значение — потеря выбора человека, и о ней надо сказать: именно
  // на молчаливом сбросе движки ElevenLabs стояли сломанными незамеченными —
  // выпадашка их предлагала, белый список не знал, и выбор откатывался на
  // следующем пробуждении SW.
  function seedSpeech(deps) {
    const reportLoss = (deps && deps.reportLoss) || function () {};
    const log = (deps && deps.log) || function () {};
    return seed(['speechEngine', 'speechRate', 'speechVoiceName'], (r) => {
      const updates = {};
      if (typeof r.speechEngine !== 'string' || !r.speechEngine) {
        updates.speechEngine = 'system-default';
      } else if (RETIRED_SPEECH_ENGINES.indexOf(r.speechEngine) >= 0) {
        updates.speechEngine = 'system-default';
        log(`speechEngine: retired id '${r.speechEngine}' → 'system-default' (voice pinning moved to speechVoiceName)`);
      } else if (VALID_SPEECH_ENGINES.indexOf(r.speechEngine) < 0) {
        updates.speechEngine = 'system-default';
        reportLoss('settings_reset',
          `speechEngine: rejected stored value ${JSON.stringify(r.speechEngine)} — not in VALID_SPEECH_ENGINES; reset to 'system-default'`,
          { valid: VALID_SPEECH_ENGINES });
      }
      if (r.speechRate === undefined || r.speechRate === null) {
        updates.speechRate = SPEECH_RATE_DEFAULT;
      } else {
        const n = Number(r.speechRate);
        if (!Number.isFinite(n) || n < SPEECH_RATE_MIN || n > SPEECH_RATE_MAX) {
          updates.speechRate = SPEECH_RATE_DEFAULT;
          reportLoss('settings_reset',
            `speechRate: rejected stored value ${JSON.stringify(r.speechRate)} — outside [${SPEECH_RATE_MIN}, ${SPEECH_RATE_MAX}]; reset to ${SPEECH_RATE_DEFAULT}`);
        }
      }
      // Имя голоса НЕ сверяется с установленными голосами намеренно: в service
      // worker'е нет speechSynthesis вовсе, а на странице список свой у каждой
      // машины. Пропавшее сегодня имя обрабатывается там, где это важно
      // (shared.js speakEtalonViaSystem падает на голос браузера), а не
      // стиранием выбора.
      if (r.speechVoiceName !== undefined && typeof r.speechVoiceName !== 'string') {
        updates.speechVoiceName = '';
        reportLoss('settings_reset',
          `speechVoiceName: rejected stored value of type ${typeof r.speechVoiceName} — expected string; reset to '' (browser default)`);
      }
      return updates;
    }, 'Speech storage initialized', deps);
  }

  // Один вызов на буте service worker'а вместо двенадцати. Порядок внутри не
  // важен — ячейки независимы, каждая читает и пишет только свои ключи.
  //
  // Здесь был ещё один посев — `activePreprocessModelId` из дефолта, который
  // передавал background.js. Снят 2026-08-25 вместе с самим дефолтом: у очистки
  // субтитров зашитого умолчания нет, а посев записал бы его в storage, и
  // отличить «человек так выбрал» от «за него выбрал код» стало бы нельзя.
  function seedAll(deps) {
    const d = deps || {};
    const jobs = [
      seedKnobScopes(d),
      seedModelScopes(d),
      seedVoiceModel(d),
      seedPronunciation(d),
      seedSpeech(d),
      seedStringCell('pronunciationTutorPrompt', d),
    ];
    Object.keys(SLOT_CELLS).forEach((name) => { jobs.push(seedSlotCell(name, d)); });
    return Promise.all(jobs);
  }

  global.LexSettingsCells = {
    SLOT_CELLS,
    STRING_CELLS,
    KNOB_DEFAULTS,
    KNOB_SCOPES,
    TEXT_KNOB_KEYS,
    MODEL_SCOPE_CELLS,
    DEFAULT_VOICE_MODEL_ID,
    VALID_SPEECH_ENGINES,
    RETIRED_SPEECH_ENGINES,
    SPEECH_RATE_MIN,
    SPEECH_RATE_MAX,
    SPEECH_RATE_DEFAULT,
    TRANSCRIPTION_PROMPT_1_DEFAULT,
    PRONUNCIATION_TUTOR_PROMPT_DEFAULT,
    scopedKey,
    cellFor,
    stringCellFor,
    seed,
    seedAll,
  };
})(typeof self !== 'undefined' ? self : globalThis);
