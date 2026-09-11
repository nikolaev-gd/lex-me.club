// lex-dictation-relay.js — реле живой диктовки: сокет к серверной функции
// `dictation-live` на одной стороне и вкладка (страница) с микрофоном на другой.
//
// ── Кто держит сокет ────────────────────────────────────────────────────────
//
// Не вкладка с микрофоном, а тот, у кого пропуск аккаунта: в расширении —
// фоновый воркер (пропуск не должен уезжать в контент-скрипт на чужой
// странице), на странице lex-me.club/app и в программе для Мака — фоновый слой
// самой страницы (wc-backend.js). Айфон говорит с сервером напрямую
// (LiveDictation.swift), реле ему не нужно.
//
// Раньше реле было написано слово в слово дважды — в воркере и на странице, — и
// копии уже разошлись: страница не прибирала за неудачным стартом (сокет и
// запись о сессии оставались жить, а сервер держал оплачиваемую сессию, пока
// её не закрывал сторож). Теперь реле одно, а поверхность даёт ему только то,
// что у неё своё: откуда пропуск, какой адрес сервера, как доставить кадр
// вкладке и что сделать с итогом (пилюля цены, баланс).
//
// ── Что реле делает ─────────────────────────────────────────────────────────
//
//   start   — открыть сокет, послать кадр начала с пропуском и ручками как
//             есть, дождаться «готов» (или отказа, или срока старта). Любой
//             исход, кроме «готов», прибирает за собой: сокет закрыт, запись
//             о сессии удалена.
//   audio   — переложить кусок звука в сокет.
//   ping    — переложить пульс «на связи»; сессии нет — ответить «её нет»
//             (с итогом сервера, если он успел закончить сам).
//   stop / abort — попросить сервер договорить и дождаться итога. Пока связь
//             ещё встаёт, разговора на сервере нет: сокет закрывается сразу,
//             иначе он открылся бы, послал «начало» и оставил сироту.
//   abortWhere — бросить сессии, чья вкладка ушла (воркер расширения).
//
// Кадры сервера (`closing`, `delta`, `final`, `error`) реле превращает в
// сообщения вкладке тех же имён, что и прежде: LEX_DICTATION_LIVE_CLOSING,
// …_DELTA, …_ENDED, …_ERROR. Их читает lex-dictation-live.js.
//
// Файл грузится и воркером расширения (importScripts), и страницей, у которой
// требование — ноль обращений к API расширения во всём графе зависимостей
// (dev-tools/check-webchat-clean.sh). Поэтому здесь обычный скрипт без export и
// без единого имени из API браузерного расширения.
(function (global) {
  'use strict';

  if (global.LexDictationRelay) return;

  // Сколько ждём «готов», прежде чем сказать «не дозвонились».
  const START_TIMEOUT_MS = 12000;
  // Сколько ждём итог после «договорил».
  const FINISH_TIMEOUT_MS = 15000;
  // Сервер закончил сам, а «стоп» ещё никто не нажимал: итог держится здесь
  // столько, чтобы «стоп», нажатый в тот же миг, получил его, а не «сессии нет».
  const ENDED_HOLD_MS = 30000;

  // Состояния сокета по стандарту — числами, чтобы не зависеть от того, чей
  // конструктор подставлен (проверки подставляют свой).
  const CONNECTING = 0;
  const OPEN = 1;

  const TYPES = Object.freeze([
    'LEX_DICTATION_LIVE_START', 'LEX_DICTATION_LIVE_AUDIO', 'LEX_DICTATION_LIVE_PING',
    'LEX_DICTATION_LIVE_STOP', 'LEX_DICTATION_LIVE_ABORT',
  ]);

  // host:
  //   token()     → Promise<string|null>  пропуск аккаунта; нет — «нужен вход»
  //   baseUrl()   → string                адрес проекта (https://…)
  //   emit(ctx, msg)                      доставить сообщение вкладке
  //   onFinal(ctx, frame, config)         итог пришёл: цена, баланс (необязательно)
  //   WebSocket                           конструктор (необязательно; для проверок)
  //   log(line)                           журнал (необязательно)
  function create(host) {
    const h = host || {};
    if (typeof h.token !== 'function' || typeof h.baseUrl !== 'function' || typeof h.emit !== 'function') {
      throw new Error('LexDictationRelay.create: token(), baseUrl() and emit() are required');
    }
    const log = (line) => { try { if (typeof h.log === 'function') h.log(line); } catch (_) {} };
    // Живых сессий может быть несколько разом — микрофонов на странице больше
    // одного, и вкладок тоже, — поэтому карта по номеру, а не одна переменная.
    // Запись живёт ровно столько, сколько сокет.
    const sessions = new Map();

    async function start(msg, ctx) {
      const requestId = msg && msg.requestId;
      const config = (msg && msg.config) || {};
      // live — сессия встала («готов» пришёл); over — её конец уже учтён (итог
      // забран «договорил», вкладка ушла); ended — сервер закончил сам, а
      // «договорил» никто не нажимал: итог ждёт здесь того, кто нажмёт «стоп» в
      // тот же миг; cancelled — «стоп» или уход вкладки пришли, пока связь ещё
      // вставала.
      //
      // Запись заводится ДО ожидания пропуска: пропуск бывает и сетевым походом
      // (продление входа), и «стоп» или закрытая вкладка в это время обязаны её
      // найти и отменить. Иначе сокет открылся бы позже, послал «начало», и на
      // сервере осталась бы сессия, которую некому закончить, кроме сторожа, —
      // и за которую человек заплатил бы.
      const entry = {
        ws: null, ctx: ctx || {}, config, finish: null,
        live: false, over: false, ended: null, cancelled: false, maxDurationMs: null,
      };
      sessions.set(requestId, entry);
      const forget = () => { if (sessions.get(requestId) === entry) sessions.delete(requestId); };
      let token = null;
      try { token = await h.token(); } catch (_) { token = null; }
      if (entry.cancelled) { forget(); return { ok: false, error: 'cancelled' }; }
      if (!token) { forget(); return { ok: false, __gate: 'login' }; }
      let ws;
      try {
        const Ctor = h.WebSocket || global.WebSocket;
        const base = String(h.baseUrl() || '').replace(/^http/, 'ws');
        ws = new Ctor(base + '/functions/v1/dictation-live');
      } catch (e) {
        forget();
        return { ok: false, error: String((e && e.message) || e) };
      }
      entry.ws = ws;
      const emit = (m) => { try { h.emit(entry.ctx, Object.assign({ requestId }, m)); } catch (_) {} };
      // Сессии не стало, а «договорил» никто не просил — вкладке надо сказать,
      // иначе кнопка горит, пока человек не нажмёт сам.
      const tellEnded = (text, reason) => {
        entry.ended = { text: text || '', reason: reason || 'lost', billedUsd: entry.ended && entry.ended.billedUsd };
        emit({ type: 'LEX_DICTATION_LIVE_ENDED', text: entry.ended.text, reason: entry.ended.reason, maxDurationMs: entry.maxDurationMs });
      };

      const opened = await new Promise((resolve) => {
        const giveUp = setTimeout(() => resolve({ ok: false, error: 'timeout' }), START_TIMEOUT_MS);
        ws.onopen = () => {
          if (entry.cancelled) { try { ws.close(); } catch (_) {} return; }
          try { ws.send(JSON.stringify({ type: 'start', token, config })); } catch (_) {}
        };
        ws.onmessage = (ev) => {
          let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
          // Потолок сессии называет сервер — своего числа у поверхностей нет.
          if (m.type === 'ready') {
            clearTimeout(giveUp);
            entry.live = true;
            entry.maxDurationMs = Number(m.maxDurationMs) > 0 ? Number(m.maxDurationMs) : null;
            resolve({ ok: true, maxDurationMs: m.maxDurationMs });
            return;
          }
          // Сервер заканчивает сам (потолок, сторож, остановка воркера): звук
          // вкладке больше не нужен, итог придёт следом.
          if (m.type === 'closing') {
            emit({ type: 'LEX_DICTATION_LIVE_CLOSING', reason: m.reason, maxDurationMs: m.maxDurationMs });
            return;
          }
          if (m.type === 'delta') {
            emit({ type: 'LEX_DICTATION_LIVE_DELTA', textSoFar: m.textSoFar });
            return;
          }
          if (m.type === 'error') {
            clearTimeout(giveUp);
            // До «готов» отказ — это ответ на старт; после — беда посреди речи,
            // и вкладке о ней говорят отдельным сообщением.
            resolve({ ok: false, error: m.message || m.stage, status: m.status });
            emit({ type: 'LEX_DICTATION_LIVE_ERROR', message: m.message, status: m.status });
            return;
          }
          if (m.type === 'final') {
            clearTimeout(giveUp);
            // Цена приезжает и когда человек договорил, и когда он исчез, —
            // сервер отвечает одинаково.
            if (typeof h.onFinal === 'function') {
              try { h.onFinal(entry.ctx, m, config); } catch (e) { log('[lex-dictation-relay] onFinal threw: ' + (e && e.message)); }
            }
            if (entry.finish) {
              const f = entry.finish; entry.finish = null; entry.over = true;
              f({ ok: true, text: m.text || '', billedUsd: m.billedCostUsd });
            } else if (!entry.over) {
              // Итог без «договорил» — сессию закончил сервер.
              entry.ended = { billedUsd: m.billedCostUsd };
              tellEnded(m.text || '', m.reason || 'server');
            }
            resolve({ ok: true });
          }
        };
        ws.onerror = () => { clearTimeout(giveUp); resolve({ ok: false, error: 'socket error' }); };
        ws.onclose = () => {
          clearTimeout(giveUp);
          if (entry.finish) {
            const f = entry.finish; entry.finish = null; entry.over = true;
            f({ ok: false, error: 'closed' });
          } else if (entry.live && !entry.over && !entry.ended) {
            // Связь пропала посреди записи без итога (воркер функции убит, сеть
            // оборвалась) — вкладка узнаёт об этом сразу.
            tellEnded('', 'lost');
          }
          if (entry.ended && !entry.over) setTimeout(forget, ENDED_HOLD_MS);
          else forget();
          resolve({ ok: false, error: 'closed' });
        };
      });
      // Старт не удался — прибрать за собой: закрыть сокет (иначе сервер держал
      // бы открытую оплачиваемую сессию, пока её не закроет сторож) и забыть
      // запись.
      if (!opened.ok) {
        try { ws.close(); } catch (_) {}
        forget();
      }
      return opened;
    }

    function audio(msg) {
      const e = sessions.get(msg && msg.requestId);
      if (e && e.ws && e.ws.readyState === OPEN) {
        try { e.ws.send(JSON.stringify({ type: 'audio', b64: msg.b64 })); return { ok: true }; } catch (_) {}
      }
      return { ok: false };
    }

    // Пульс «на связи». Шлёт его вкладка с микрофоном, а не реле само: реле
    // переживает закрытую вкладку, и пульс из него значил бы «жив воркер», а
    // не «человек здесь».
    function ping(msg) {
      const e = sessions.get(msg && msg.requestId);
      // Такой сессии нет (воркер перезапускался, сервер уже закончил) — вкладка
      // должна узнать, что пишет в пустоту. Сервер закончил сам — итог уже
      // здесь, и отдаём его вместе с «нет».
      if (!e || e.ended) {
        return e && e.ended ? { ok: false, gone: true, text: e.ended.text, reason: e.ended.reason } : { ok: false, gone: true };
      }
      if (e.ws && e.ws.readyState === OPEN) {
        try { e.ws.send(JSON.stringify({ type: 'ping' })); } catch (_) {}
      }
      return { ok: true };
    }

    async function finish(msg, verb) {
      const requestId = msg && msg.requestId;
      const e = sessions.get(requestId);
      // Сервер закончил сам за миг до этого нажатия — итог уже здесь.
      if (e && e.ended) {
        e.over = true;
        sessions.delete(requestId);
        return e.ended.reason === 'lost' ? { ok: false, error: 'closed' } : { ok: true, text: e.ended.text, billedUsd: e.ended.billedUsd };
      }
      // Связь ещё встаёт (ждём пропуск или сокет открывается) — разговора на
      // сервере нет, кадр начала не ушёл. Отменяем сразу: иначе сокет
      // откроется, пошлёт «начало», и сервер заведёт сессию, которую некому
      // закончить, кроме его сторожа, — и за которую человек заплатит.
      if (e && (!e.ws || e.ws.readyState === CONNECTING)) {
        e.cancelled = true;
        e.over = true;
        if (e.ws) { try { e.ws.close(); } catch (_) {} } else sessions.delete(requestId);
        return { ok: false, error: 'no live session' };
      }
      if (!e || !e.ws || e.ws.readyState !== OPEN) return { ok: false, error: 'no live session' };
      // Итог ждём даже у «бросил»: строка расхода за уже сказанное пишется на
      // сервере в обоих случаях, а закрыть сокет раньше времени значит не
      // дождаться ответа и не показать цену.
      const answer = await new Promise((resolve) => {
        let timer = null;
        const done = (r) => { if (timer) clearTimeout(timer); resolve(r); };
        e.finish = done;
        try { e.ws.send(JSON.stringify({ type: verb === 'abort' ? 'abort' : 'stop' })); }
        catch (_) { e.finish = null; done({ ok: false, error: 'send failed' }); return; }
        timer = setTimeout(() => { if (e.finish === done) { e.finish = null; done({ ok: false, error: 'timeout' }); } }, FINISH_TIMEOUT_MS);
      });
      e.over = true;
      try { e.ws.close(); } catch (_) {}
      if (sessions.get(requestId) === e) sessions.delete(requestId);
      return answer;
    }

    // Бросить сессии, которые выбрал `pred` по контексту (вкладку закрыли).
    // Сокет своей рукой НЕ закрываем: сервер должен успеть спросить у
    // поставщика, сколько тот услышал, записать строку и закрыться сам.
    // Закрыть здесь значит оборвать его на этом вопросе. Исключение — связь,
    // которая ещё встаёт: там разговора нет, и сокет просто закрывается.
    function abortWhere(pred) {
      let n = 0;
      for (const [id, e] of sessions) {
        let hit = false;
        try { hit = !!pred(e.ctx); } catch (_) {}
        if (!hit) continue;
        try {
          if (e.ws && e.ws.readyState === OPEN) e.ws.send(JSON.stringify({ type: 'abort' }));
          else if (!e.ws) e.cancelled = true;
          else if (e.ws.readyState === CONNECTING) { e.cancelled = true; e.ws.close(); }
        } catch (_) {}
        e.over = true;
        sessions.delete(id);
        n++;
      }
      return n;
    }

    // Одна точка входа для сообщений вкладки: тип → действие. Не наш тип —
    // undefined, и хозяин передаёт сообщение дальше своим обработчикам.
    function handle(type, payload, ctx) {
      switch (type) {
        case 'LEX_DICTATION_LIVE_START': return start(payload, ctx);
        case 'LEX_DICTATION_LIVE_AUDIO': return audio(payload);
        case 'LEX_DICTATION_LIVE_PING': return ping(payload);
        case 'LEX_DICTATION_LIVE_STOP': return finish(payload, 'stop');
        case 'LEX_DICTATION_LIVE_ABORT': return finish(payload, 'abort');
        default: return undefined;
      }
    }

    return Object.freeze({ start, audio, ping, finish, abortWhere, handle, size: () => sessions.size });
  }

  global.LexDictationRelay = Object.freeze({
    create, TYPES, START_TIMEOUT_MS, FINISH_TIMEOUT_MS, ENDED_HOLD_MS,
  });
})(typeof self !== 'undefined' ? self : globalThis);
