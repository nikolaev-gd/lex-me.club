// voice/voice-tools.js — the functions of the direct voice (2026-11-22): the main chat's voice has one, `ask_lex`.
//
// The voice goes straight from the device to the provider and only talks; anything needing the database or thought
// is a call of `ask_lex`, which the device forwards to the door `voice-ask` of Lex (llm-proxy, _shared/voice-ask.ts)
// and answers with what Lex says. One set of rules for the extension, the page lex-me.club/app (the Mac app is that
// page) and the iPhone (ios/Lex/Lex/GeminiVoice+Tools.swift, rule for rule):
//   • a call is answered once, by its id (Google and OpenAI both may repeat one);
//   • a cancelled call (Google's toolCallCancellation) is not answered;
//   • a failure answers with an error output, so the model says so and never hangs;
//   • an answer longer than the server's VOICE_TOOL_TEXT_MAX is cut with the same tail;
//   • the filler («let me check») and the answer are one turn — the module of the voice holds the pair open.
//
// This file holds what both voices (voice/gemini-live.js and the OpenAI realtime paths: voice/openai-realtime.js in
// the extension, webchat/wc-voice.js on the page) share: the runner of the calls, the frames of the answers, the tail
// of the main chat the voice reads. Asking Lex itself is the surface's (the message LEX_DIRECT_VOICE_ASK, answered by
// LexDirectMode.createVoiceCalls().ask in the worker of the extension and on the page).
(function (global) {
  'use strict';
  if (global.LexVoiceTools) return;

  // The longest answer the voice reads at once (VOICE_TOOL_TEXT_MAX of the server, toolTextMax on the iPhone).
  const TEXT_MAX = 30000;
  const CUT_TAIL = '\n…(ответ обрезан для голоса)';
  // The tail of the main chat the voice reads (the server's BRAIN_VOICE_CHAIN_CHARS, voiceTail on the iPhone).
  const TAIL_CHARS = 40000;

  const ERR = {
    noFunction: (name) => `No function «${name}» in this conversation.`,
    empty: 'The question is empty: ask again with the question in words.',
    noAsk: 'Lex cannot be asked from this conversation.',
    broke: 'Lex did not answer: the line broke.',
  };

  function clip(text) {
    const s = String(text == null ? '' : text);
    return s.length > TEXT_MAX ? s.slice(0, TEXT_MAX) + CUT_TAIL : s;
  }

  // What the prep of a direct call says about its functions ({names, nonBlocking} — LexDirectMode toolsOf) →
  // {names: Set, nonBlocking}. Nothing declared — an empty set: a call is then answered with an error.
  function declared(tools) {
    const names = new Set();
    if (tools && Array.isArray(tools.names)) for (const n of tools.names) if (typeof n === 'string' && n) names.add(n);
    return { names, nonBlocking: !!(tools && tools.nonBlocking === true) };
  }

  // The frame of the answers to Google, the server's toolResponseFrame field for field.
  function geminiResponseFrame(answers, nonBlocking) {
    const functionResponses = answers.map((a) => {
      const text = clip(a.text);
      const response = a.isError ? { error: text } : { output: text };
      if (nonBlocking) response.scheduling = 'WHEN_IDLE';
      const r = { name: a.name, response };
      if (a.id) r.id = a.id;
      return r;
    });
    return { toolResponse: { functionResponses } };
  }

  // Google's toolCall frame → [{id, name, args}].
  function geminiCalls(frame) {
    const list = frame && frame.toolCall && Array.isArray(frame.toolCall.functionCalls) ? frame.toolCall.functionCalls : [];
    return list.filter((c) => c && typeof c.name === 'string' && c.name)
      .map((c) => ({ id: typeof c.id === 'string' ? c.id : '', name: c.name, args: (c.args && typeof c.args === 'object') ? c.args : {} }));
  }

  // An OpenAI realtime event that finishes a function call → {id, name, args} or null. Both
  // response.function_call_arguments.done and response.output_item.done (item.type function_call) carry it; the
  // runner answers the call once.
  function openaiCall(ev) {
    if (!ev) return null;
    let id = null, name = null, rawArgs = null;
    if (ev.type === 'response.function_call_arguments.done') {
      id = ev.call_id; name = ev.name; rawArgs = ev.arguments;
    } else if (ev.type === 'response.output_item.done' && ev.item && ev.item.type === 'function_call') {
      id = ev.item.call_id; name = ev.item.name; rawArgs = ev.item.arguments;
    } else return null;
    if (typeof id !== 'string' || !id) return null;
    let args = {};
    try { const a = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : rawArgs; if (a && typeof a === 'object') args = a; } catch (_) {}
    return { id, name: typeof name === 'string' ? name : '', args };
  }

  // The answer to OpenAI: the output of the call, then a new response (the model reads it out).
  function openaiAnswerEvents(answer) {
    const text = clip(answer.text);
    return [
      { type: 'conversation.item.create', item: { type: 'function_call_output', call_id: answer.id, output: answer.isError ? JSON.stringify({ error: text }) : text } },
      { type: 'response.create' },
    ];
  }

  // A response.done whose output holds a function call: the filler's response — the pair stays open for the answer.
  function responseHasCall(ev) {
    const out = ev && ev.response && Array.isArray(ev.response.output) ? ev.response.output : [];
    return out.some((o) => o && o.type === 'function_call');
  }

  // The usage of two OpenAI responses of one pair, summed field by field (numbers, nested details too).
  function sumUsage(a, b) {
    if (!a) return b || null;
    if (!b) return a;
    const out = {};
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const x = a[k], y = b[k];
      if (typeof x === 'number' || typeof y === 'number') out[k] = (Number(x) || 0) + (Number(y) || 0);
      else if ((x && typeof x === 'object') || (y && typeof y === 'object')) out[k] = sumUsage(x || null, y || null);
      else out[k] = x !== undefined ? x : y;
    }
    return out;
  }

  // The newest turns of the main chat up to TAIL_CHARS, starting with a turn of the person (voiceTail on the iPhone).
  function voiceTail(turns, maxChars) {
    const list = Array.isArray(turns) ? turns : [];
    const cap = Number.isFinite(maxChars) ? maxChars : TAIL_CHARS;
    let start = list.length;
    let chars = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      chars += String((list[i] && list[i].content) || '').length;
      if (chars > cap && start < list.length) break;
      start = i;
    }
    while (start < list.length && list[start] && list[start].role === 'assistant') start++;
    return list.slice(start);
  }

  // The calls of one conversation. o: { tools ({names, nonBlocking} from the prep), ask(question, id) →
  // Promise<{text, isError}> | null (no door — every call answers an error), log? }.
  function createRunner(o) {
    const opts = o || {};
    const t = declared(opts.tools);
    const seen = new Set();
    const cancelled = new Set();
    let inFlight = 0;
    const uuid = () => (global.crypto && typeof global.crypto.randomUUID === 'function')
      ? global.crypto.randomUUID() : 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    // The calls not answered yet: the same call twice is answered once.
    function take(calls) {
      const fresh = [];
      for (const c of calls || []) {
        if (!c || !c.name) continue;
        if (c.id && seen.has(c.id)) continue;
        if (c.id) seen.add(c.id);
        fresh.push(c);
      }
      return fresh;
    }
    function cancel(ids) { for (const id of ids || []) if (id) cancelled.add(id); }
    // Asks Lex the question of every fresh call → the answers, cancelled ones marked.
    async function run(fresh) {
      inFlight += 1;
      try {
        const answers = [];
        for (const f of fresh) {
          const question = String((f.args && f.args.question) || '').trim();
          let a;
          if (!t.names.has(f.name)) a = { text: ERR.noFunction(f.name), isError: true };
          else if (!question) a = { text: ERR.empty, isError: true };
          else if (typeof opts.ask === 'function') {
            try { a = (await opts.ask(question, uuid())) || { text: ERR.broke, isError: true }; }
            catch (_) { a = { text: ERR.broke, isError: true }; }
          } else a = { text: ERR.noAsk, isError: true };
          answers.push({ id: f.id, name: f.name, text: String(a.text || ''), isError: a.isError === true, cancelled: !!(f.id && cancelled.has(f.id)) });
        }
        // A cancel may come while Lex thinks.
        for (const a of answers) if (a.id && cancelled.has(a.id)) a.cancelled = true;
        return answers;
      } finally { inFlight -= 1; }
    }
    return {
      names: t.names, nonBlocking: t.nonBlocking, take, cancel, run,
      inFlight: () => inFlight,
      any: () => t.names.size > 0,
    };
  }

  global.LexVoiceTools = Object.freeze({
    TEXT_MAX, CUT_TAIL, TAIL_CHARS, ERR,
    clip, declared, geminiResponseFrame, geminiCalls, openaiCall, openaiAnswerEvents, responseHasCall, sumUsage, voiceTail,
    createRunner,
  });
})(typeof self !== 'undefined' ? self : globalThis);
