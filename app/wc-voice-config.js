// webchat/wc-voice-config.js — как собирается звуковая часть голосовой сессии.
//
// ── Почему это отдельный файл, а не строчка в wc-voice.js ────────────────────
//
// Это ПОРТ функции `buildOpenAIRealtimeAudioConfig` из `chat-knobs.js`. Там
// живут пороги, которыми расширение защищается от того, что учитель слышит
// себя через динамик, и они выстраданы: порог срабатывания 0.75 вместо
// умолчания OpenAI 0.5, тишина 1500 мс вместо 500. Новый чат до сих пор не
// применял НИ ОДНОГО из них — он не посылал `turn_detection` вовсе, то есть
// работал на умолчаниях. На телефоне, где динамик в паре сантиметров от
// микрофона, этого хватает, чтобы учитель оборвал сам себя.
//
// ── Почему копия, а не общий файл ───────────────────────────────────────────
//
// Правильно было бы грузить `chat-knobs.js` обоими поверхностями. Нельзя:
// он читает `LexSettingsCells.KNOB_DEFAULTS` на загрузке, а
// `lex-settings-cells.js` обращается к `chrome.storage.local`
// (`lex-settings-cells.js:287`). У нового чата требование — НОЛЬ `chrome.*` во
// всём графе зависимостей, и его проверяет машина
// (`dev-tools/check-webchat-clean.sh`). Вынести функцию в третий общий файл
// значило бы править расширение, а его в этой задаче трогать запрещено.
//
// Поэтому копия — но копия, которая не может разойтись молча:
// `dev-tools/check-voice-config-parity.mjs` гоняет ОБЕ реализации на матрице
// наборов ручек и падает на первом расхождении. Обещание «не забыть
// синхронизировать» здесь заменено проверкой.
//
// ── Одно отличие от расширения, и оно намеренное ─────────────────────────────
//
// `noise_reduction`. В расширении поле берётся из ручки и по умолчанию
// выключено — там разговаривают в наушниках или у ноутбука. Здесь поверхность
// телефонная, и умолчание `far_field` включено НАРОЧНО: это единственный
// серверный рычаг, прямо нацеленный на эхо из громкой связи, и именно им
// (вместе с порогом 0.75) вылечен документированный случай «агент перебивает
// сам себя» на iPhone. Ручка по-прежнему сильнее умолчания: явное 'off'
// выключит поле совсем.
(function (global) {
  'use strict';

  // Умолчания расширения, значение в значение (`chat-knobs.js:234-236`).
  const VAD_THRESHOLD = 0.75;
  const VAD_PREFIX_PADDING_MS = 300;
  const VAD_SILENCE_MS = 1500;

  // На телефоне динамик и микрофон в одном корпусе — это дальнее поле.
  const DEFAULT_NOISE_REDUCTION = 'far_field';

  function clampNum(v, lo, hi) {
    const n = Number(v);
    if (!Number.isFinite(n)) return lo;
    return Math.min(hi, Math.max(lo, n));
  }

  // knobs → { audio, maxResponseOutputTokens, reasoning }
  //
  // Форма ответа та же, что у расширения, чтобы проверка на расхождение могла
  // сравнивать их напрямую.
  function buildAudioConfig(knobs, opts) {
    const k = knobs || {};
    const o = opts || {};

    // 'off' от ручки — это осознанное «выключить», и оно сильнее умолчания
    // поверхности. Пусто/не задано — берём телефонное умолчание.
    const reductionType = (k.voiceNoiseReduction === undefined || k.voiceNoiseReduction === null || k.voiceNoiseReduction === '')
      ? (o.defaultNoiseReduction || DEFAULT_NOISE_REDUCTION)
      : k.voiceNoiseReduction;
    const reduction = (reductionType && reductionType !== 'off') ? { type: reductionType } : null;

    // Режим вне полосы (out_of_band) новый чат не поддерживает: он гасит
    // встроенную расшифровку, а именно из неё здесь строятся пузыри.
    const transcription = {
      model: k.voiceTranscriptionModel || 'gpt-4o-mini-transcribe',
    };
    // Язык НЕ прибивается к 'en'. Ученик русскоязычный и вправе спросить
    // учителя по-русски; жёсткий английский превратил бы такую фразу в кашу.
    // 'auto' (и пусто) means «пусть определяет сам» — поле просто не уходит.
    if (k.voiceTranscriptionLanguage && k.voiceTranscriptionLanguage !== 'auto') {
      transcription.language = k.voiceTranscriptionLanguage;
    }
    if (k.voiceTranscriptionPrompt) {
      transcription.prompt = k.voiceTranscriptionPrompt;
    }

    // Ветка semantic_vad — как в расширении: любое значение чувствительности,
    // кроме ровно 0.5, переключает тип, и тогда числовые пороги не действуют.
    const endSens = (typeof k.voiceEndSensitivity === 'number') ? k.voiceEndSensitivity : 0.5;
    const useSemantic = endSens !== 0.5;
    let turnDetection;
    if (useSemantic) {
      let eagerness = 'medium';
      if (endSens < 0.4) eagerness = 'low';
      else if (endSens > 0.7) eagerness = 'high';
      turnDetection = { type: 'semantic_vad', eagerness };
    } else {
      turnDetection = {
        type: 'server_vad',
        threshold: (typeof k.voiceVadThreshold === 'number') ? k.voiceVadThreshold : VAD_THRESHOLD,
        prefix_padding_ms: (typeof k.voicePrefixPaddingMs === 'number') ? k.voicePrefixPaddingMs : VAD_PREFIX_PADDING_MS,
        silence_duration_ms: (typeof k.voiceSilenceDurationMs === 'number') ? k.voiceSilenceDurationMs : VAD_SILENCE_MS,
      };
      if (typeof k.voiceIdleTimeoutSec === 'number' && k.voiceIdleTimeoutSec > 0) {
        turnDetection.idle_timeout_ms = clampNum(k.voiceIdleTimeoutSec, 5, 30) * 1000;
      }
    }
    // ⚠️ `interrupt_response` остаётся ИСТИНОЙ по умолчанию, и это осознанно.
    // Разбор, пришедший в задании, советовал выключить его вместе с
    // `create_response` — так делать нельзя по двум независимым причинам:
    //   · схема OpenAI прямым текстом говорит, что при обоих `false` модель
    //     не отвечает автоматически ВООБЩЕ, и каждый ответ пришлось бы
    //     заводить руками через `response.create`; голос просто замолчал бы;
    //   · разработчики с декабря 2025 по июль 2026 сообщают, что
    //     `interrupt_response: false` провайдером не соблюдается.
    // Перебивать учителя человек должен мочь — это и есть живой разговор.
    turnDetection.interrupt_response = (k.voiceInterruptResponse !== 'no_interrupt');

    const audio = { input: { turn_detection: turnDetection } };
    if (transcription) audio.input.transcription = transcription;
    // Поле опускается целиком, когда выключено: явный null провайдер отвергает.
    if (reduction) audio.input.noise_reduction = reduction;
    if (typeof k.voiceSpeed === 'number' && k.voiceSpeed !== 1) {
      audio.output = { speed: clampNum(k.voiceSpeed, 0.25, 1.5) };
    }

    const maxResponseOutputTokens = (typeof k.voiceMaxResponseTokens === 'number' && k.voiceMaxResponseTokens > 0)
      ? clampNum(k.voiceMaxResponseTokens, 1, 4096)
      : null;

    const reasoning = (k.voiceReasoningEffort && k.voiceReasoningEffort !== 'none')
      ? { effort: k.voiceReasoningEffort }
      : null;

    return { audio, maxResponseOutputTokens, reasoning };
  }

  global.WcVoiceConfig = {
    buildAudioConfig,
    DEFAULT_NOISE_REDUCTION,
    VAD_THRESHOLD,
    VAD_SILENCE_MS,
    VAD_PREFIX_PADDING_MS,
  };
})(typeof self !== 'undefined' ? self : globalThis);
