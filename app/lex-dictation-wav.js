// lex-dictation-wav.js — запись несжатого WAV для распознавалки, которая
// сжатых файлов приложений не читает.
//
// ── Зачем ───────────────────────────────────────────────────────────────────
//
// Обычная диктовка пишет звук MediaRecorder'ом: Chrome отдаёт webm (Opus),
// WebKit (программа для Мака, Safari) — mp4 (AAC). Microsoft MAI-Transcribe не
// читает ни то ни другое: оба — 400 «invalid_audio» (замерено живыми
// запросами 2026-09-11), а переложить AAC без перекодирования сервер не может.
// Поэтому для такой распознавалки браузер пишет WAV сам. Какая распознавалка
// этого требует и на какой частоте — строка базы (`sample_rate_hz` у файловой
// распознавалки), её отдаёт каталог (lex-dictation-catalog.js, route):
// заполнена — пишется WAV, пусто — обычный MediaRecorder.
//
// ── Как устроено ────────────────────────────────────────────────────────────
//
// Снаружи это MediaRecorder: `state`, `mimeType`, `start()`, `stop()`,
// `ondataavailable` и следом `onstop`. Хозяевам (dictation.js в расширении и
// wc-composer.js на странице, она же программа для Мака) меняется одна строка
// — чем записывать; вся остальная жизнь записи (потолок, порог промаха,
// отправка, рост текста) у них общая с обычной.
//
// Звук снимается на РОДНОЙ частоте устройства и пересчитывается в частоту
// распознавалки здесь же, при остановке. Не `AudioContext({sampleRate})`:
// частоту, которой нет у аппаратуры, устройство вправе не дать (живая
// диктовка на этот случай честно отказывает), а файлу отказ не нужен —
// пересчитать готовую запись ничего не стоит. Узел — ScriptProcessorNode по
// той же причине, что у живой диктовки: worklet грузится отдельным файлом, и
// на чужой странице его адрес проверяет CSP самой страницы.
//
// Отказ (нет AudioContext, микрофон не подключился) бросается при СОЗДАНИИ —
// там, где хозяева уже ловят отказ конструктора MediaRecorder и говорят
// человеку, что записать не выйдет.
//
// Обычный скрипт без export и без API расширения: его грузят и вкладки
// расширения, и страница (dev-tools/check-webchat-clean.sh).
(function (global) {
  'use strict';

  if (global.LexDictationWav) return;

  const FRAME_SAMPLES = 4096;

  // Частота устройства → частота распознавалки. Вниз — среднее по отрезку
  // исходных отсчётов на каждый новый (без него высокие частоты заворачиваются
  // в слышимый шум); вверх — линейно. Для речи и распознавания этого хватает.
  function resample(input, from, to) {
    if (!(from > 0) || !(to > 0) || from === to) return input;
    const ratio = from / to;
    const n = Math.floor(input.length / ratio);
    const out = new Float32Array(n);
    if (ratio > 1) {
      for (let i = 0; i < n; i++) {
        const a = Math.floor(i * ratio);
        const b = Math.min(input.length, Math.floor((i + 1) * ratio));
        let s = 0;
        for (let j = a; j < b; j++) s += input[j];
        out[i] = b > a ? s / (b - a) : 0;
      }
    } else {
      for (let i = 0; i < n; i++) {
        const x = i * ratio;
        const j = Math.floor(x);
        const a = input[j] || 0;
        const b = j + 1 < input.length ? input[j + 1] : a;
        out[i] = a + (b - a) * (x - j);
      }
    }
    return out;
  }

  // Float32 [-1, 1] → PCM16. Обрезка по краям обязательна: микрофон отдаёт
  // значения чуть за единицу, и без неё они переполняют разрядность.
  function toPcm16(f32) {
    const out = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      let s = f32[i];
      if (s > 1) s = 1; else if (s < -1) s = -1;
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  // PCM16 моно → байты WAV: 44 байта заголовка RIFF и данные.
  function encode(pcm16, rate) {
    const data = pcm16.length * 2;
    const buf = new ArrayBuffer(44 + data);
    const v = new DataView(buf);
    const tag = (off, s) => { for (let i = 0; i < 4; i++) v.setUint8(off + i, s.charCodeAt(i)); };
    tag(0, 'RIFF'); v.setUint32(4, 36 + data, true); tag(8, 'WAVE');
    tag(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    tag(36, 'data'); v.setUint32(40, data, true);
    new Int16Array(buf, 44).set(pcm16);
    return new Uint8Array(buf);
  }

  // Записанные куски на родной частоте → WAV на частоте распознавалки.
  function toWav(chunks, fromRate, toRate) {
    let len = 0;
    for (const c of chunks) len += c.length;
    const all = new Float32Array(len);
    let off = 0;
    for (const c of chunks) { all.set(c, off); off += c.length; }
    return encode(toPcm16(resample(all, fromRate, toRate)), toRate);
  }

  // stream — открытый микрофон; rate — частота WAV, Гц (из каталога).
  function create(stream, rate) {
    if (!(rate > 0)) throw new Error('no WAV sample rate for this recognizer');
    const Ctx = global.AudioContext || global.webkitAudioContext;
    if (!Ctx) throw new Error('AudioContext is not available');
    const ctx = new Ctx();
    let source = null;
    let processor = null;
    let sink = null;
    let chunks = [];
    const rec = {
      state: 'inactive',
      mimeType: 'audio/wav',
      ondataavailable: null,
      onstop: null,
      onerror: null,
      start,
      stop,
    };
    function teardown() {
      try { if (source) source.disconnect(); } catch (_) { /* noop */ }
      try { if (processor) { processor.onaudioprocess = null; processor.disconnect(); } } catch (_) { /* noop */ }
      try { if (sink) sink.disconnect(); } catch (_) { /* noop */ }
      try { if (ctx.state !== 'closed') ctx.close(); } catch (_) { /* noop */ }
    }
    try {
      source = ctx.createMediaStreamSource(stream);
      processor = ctx.createScriptProcessor(FRAME_SAMPLES, 1, 1);
      processor.onaudioprocess = (e) => {
        if (rec.state === 'recording') chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      source.connect(processor);
      // Узел обязан быть подключён к выходу, иначе Chrome его не вызывает; свой
      // голос человек слышать не должен — поэтому через заглушённое усиление.
      sink = ctx.createGain();
      sink.gain.value = 0;
      processor.connect(sink);
      sink.connect(ctx.destination);
    } catch (err) {
      teardown();
      throw err;
    }
    function start() {
      if (rec.state !== 'inactive') return;
      chunks = [];
      rec.state = 'recording';
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        ctx.resume().catch((err) => { if (typeof rec.onerror === 'function') rec.onerror({ error: err }); });
      }
    }
    // Повторная остановка — ничего, как у MediaRecorder. Файл и `onstop`
    // приходят следующим шагом цикла, тоже как у него.
    function stop() {
      if (rec.state === 'inactive') return;
      rec.state = 'inactive';
      const fromRate = ctx.sampleRate;
      const mine = chunks;
      chunks = [];
      teardown();
      setTimeout(() => {
        const blob = new Blob([toWav(mine, fromRate, rate)], { type: 'audio/wav' });
        if (typeof rec.ondataavailable === 'function') rec.ondataavailable({ data: blob });
        if (typeof rec.onstop === 'function') rec.onstop({});
      }, 0);
    }
    return rec;
  }

  global.LexDictationWav = Object.freeze({ create, toWav, resample });
})(typeof self !== 'undefined' ? self : globalThis);
