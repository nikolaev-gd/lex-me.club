// voice/call-server.js — связь голосового разговора с нашим сервером, одна на
// оба голоса расширения (OpenAI — voice/openai-realtime.js, Gemini —
// voice/gemini-live.js). 2026-09-25.
//
// Звук у обоих идёт к поставщику мимо сервера. Сервер ведёт разговор по его
// номеру (voice_sessions.call_id) и слышит от устройства пять вещей — все
// здесь, у обоих голосов одинаково:
//   • связь окна с воркером (lex-voice-call-link.js): окно исчезло без своего
//     отбоя — трубку на сервере кладёт воркер;
//   • пульс «я на линии» раз в 3 с (voice-cmd ping). 404 на пульс — сервер
//     разговор уже закрыл, и в том же ответе причина;
//   • отбой (voice-cmd end) — строка разговора закрывается в миг нажатия;
//   • реплики, которые знает только устройство: у OpenAI — реплика человека,
//     которую писала служба расшифровки (voice-cmd said); у Gemini — вся пара
//     реплик хода с расходом (voice-cmd turn), линии к его звонку у сервера нет;
//   • команды в звонок OpenAI (voice-cmd commands) — у Gemini их нет, свой
//     сокет к Google держит само устройство.
//
// Реплики уходят по очереди, одна за другой: родителя новой реплике ставит
// голова беседы на сервере в миг записи, и пара, обогнавшая предыдущую,
// встала бы в дереве не на своё место. Не дошла — повтор (номер операции тот
// же, сервер запишет её один раз). Не дошла и после повторов — это не
// проходит молча: поверхность получает onTurnNotSaved и говорит человеку.
//
// Строгий разговор (strict: true — голос Gemini, 2026-09-29). Правило
// Геннадия: не работает сервер — не работает Lex. У разговора Gemini сервер
// узнаёт о ходах и деньгах только от устройства, поэтому разговор, который
// сервер перестал подтверждать, дальше не идёт — он кончается, и человек
// видит почему (onServerFailure → причина server_silent или signed_out):
//   • пульс не подтверждён дольше PRESENCE_DEAD_MS (нет ответа, сбой сервера,
//     вышел из аккаунта) — столько же сервер ждёт пульса сам, прежде чем
//     закрыть строку разговора;
//   • пара реплик не принята и после повторов (не записана, не списана,
//     отказ по сути).
// У голоса OpenAI модуль прежний: там ходы пишет и списывает слушатель на
// сервере, и эта страховка не включена (docs/BACKLOG.md).
//
// Модуль без DOM и без состояния на уровне файла: у каждого разговора свой
// экземпляр. К Chrome он не обращается: всё уходит через «розетку»
// `LexVoiceHost` (voice/host-chrome.js в расширении, pageHost в webchat/wc-voice.js
// на странице) — поэтому тот же файл работает и в расширении, и на странице.
// Связи окна с воркером у страницы нет (там нет воркера): розетка отвечает
// на connect пустотой, и окно, закрытое без отбоя, сервер закрывает по сроку
// присутствия.

(function (global) {
  'use strict';

  // Имя порта — LexVoiceCallLink.PORT_PREFIX в воркере.
  const CALL_LINK_PREFIX = 'lex-voice-call:';
  const CALL_LINK_RECONNECTS = 5;
  // Раз в 3 с при пороге 10 с на сервере: три пропущенных удара. Скрытая
  // вкладка не беда: обычное придушивание таймеров в Chrome — один будильник в
  // секунду, а «интенсивное» включается только после пяти минут в фоне, то есть
  // позже, чем разговор упирается в свой пятиминутный предел.
  const PRESENCE_BEAT_MS = 3000;
  // Повторы реплики: сразу, через 1 с, через 3 с. Сервер держит дверь для
  // реплик закрытого разговора две минуты — повторы укладываются с запасом.
  const TURN_RETRY_DELAYS_MS = [1000, 3000];
  // Строгий разговор: сколько пульс может не подтверждаться, прежде чем
  // разговор кончится. Столько же (voice_presence_grace_sec) сервер ждёт пульса
  // сам. Перезапуск воркера расширения (MV3) — доля секунды, один-два
  // пропущенных удара сюда не дотягивают.
  const PRESENCE_DEAD_MS = 10000;

  function create(opts) {
    const o = opts || {};
    const log = o.log || (() => {});
    const warn = o.warn || (() => {});
    const isClosed = typeof o.isClosed === 'function' ? o.isClosed : () => false;
    const host = o.host || global.LexVoiceHost;
    const strict = o.strict === true;

    let callId = null;

    // ── Строгий разговор: сервер перестал подтверждать ────────────────────
    // Один раз за разговор. signed_out — ответ «не вошёл» (пропуск не
    // продлился): тогда и надпись другая.
    let failTold = false;
    // true — разговор кончен по этой причине; false — нечего кончать (уже
    // закрыт или не строгий), и о потерянной паре говорит onTurnNotSaved.
    function serverFailed(kind, r) {
      if (!strict || isClosed()) return false;
      if (failTold) return true;
      failTold = true;
      const reason = (r && r.__gate === 'login') ? 'signed_out' : 'server_silent';
      warn(`the server does not confirm the conversation (${kind}: ${(r && (r.status || r.error || r.__gate)) || 'no response'}) — ending it`);
      try { o.onServerFailure && o.onServerFailure({ kind, reason, status: r ? r.status : null }); } catch (_) {}
      return true;
    }

    // ── Связь с воркером на время звонка ──────────────────────────────────
    // Окно, которое исчезло без своего кода — крестик Chrome в шапке боковой
    // панели, закрытая вкладка или окно браузера, перезагрузка, уход на другой
    // сайт, упавшая вкладка, — отбоя не пошлёт, и сервер узнавал бы о конце
    // только по пропаже пульса, через 10–14 с («разговор уже идёт» всё это
    // время). Порт к воркеру Chrome рвёт сам, когда документа не стало, и по
    // разрыву трубку кладёт воркер.
    //
    // Открывается ДО запроса звонка, и номер связи едет в запросе звонка: окно,
    // закрытое посреди подключения, тоже ловится.
    let link = null;
    let linkId = null;
    let linkReconnects = 0;
    function openLink() {
      if (link || isClosed()) return;
      if (!linkId) linkId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
      let port = null;
      const onGone = () => {
        if (link !== port) return;
        link = null;
        // Порт порвал воркер: он перезапустился (MV3) и всё забыл. Звонок ещё
        // идёт — подключиться снова и напомнить номер. Расширение
        // перезагрузили — connect бросит, и стеречь больше нечем.
        if (!isClosed() && linkReconnects < CALL_LINK_RECONNECTS) {
          linkReconnects++;
          setTimeout(openLink, 250);
        }
      };
      try { port = host.connect(CALL_LINK_PREFIX + linkId, onGone); }
      catch (e) { warn('call link not opened:', e && e.message); return; }
      if (!port) return;   // у поверхности нет воркера — стеречь окно некому
      link = port;
      if (callId) { try { port.postMessage({ callId }); } catch (_) {} }
    }
    // endSent — отбой этого звонка окно отправило само: воркеру класть трубку
    // незачем. Без него разрыв значит «звонок брошен» — например, стоп посреди
    // подключения, когда номера звонка здесь ещё нет.
    function closeLink(endSent) {
      const port = link;
      link = null;
      if (!port) return;
      try { if (endSent) port.postMessage({ done: true }); } catch (_) {}
      try { port.disconnect(); } catch (_) {}
    }

    // Номер звонка пришёл от сервера: связь его запоминает, пульс заводится
    // СРАЗУ — срок на сервере взводится первым ударом, и дыра между ним и
    // вторым не должна быть длиннее порога.
    function setCallId(id) {
      callId = id || null;
      if (link && callId) { try { link.postMessage({ callId }); } catch (_) {} }
      if (callId) startPresence();
    }

    // ── Пульс присутствия ─────────────────────────────────────────────────
    // Сам таймер — общий LexPulse (lex-pulse.js). Здесь — частота и то, что и
    // куда несёт удар. 404 — у сервера этого разговора больше нет: причину он
    // кладёт в тот же ответ, и окно говорит человеку то же, что сказало бы по
    // событию сервера.
    let presence = null;
    // Строгий разговор: миг последнего подтверждённого пульса (или начала).
    // Время, а не счёт отказов: запрос к повисшему серверу не отвечает вовсе,
    // и отказов было бы не насчитать.
    let lastConfirmedAt = 0;
    let lastFailure = null;
    function startPresence() {
      if (presence || !callId) return;
      lastConfirmedAt = Date.now();
      presence = global.LexPulse.start({
        everyMs: PRESENCE_BEAT_MS,
        beat: () => {
          if (isClosed() || !callId) return;
          if (strict && Date.now() - lastConfirmedAt > PRESENCE_DEAD_MS) { serverFailed('presence', lastFailure); return; }
          const beatCallId = callId;
          host.send({ type: 'VOICE_CMD', callId: beatCallId, ping: true }).then((r) => {
            if (r && r.status === 404 && !isClosed() && callId === beatCallId) {
              log('presence beat: 404 — the server has no live conversation;', r.reason || 'no reason');
              try { o.onServerEnded && o.onServerEnded(r.reason || 'server-ended'); } catch (_) {}
              return;
            }
            if (r && r.ok) { lastConfirmedAt = Date.now(); lastFailure = null; }
            else lastFailure = r;
          });
        },
      });
    }
    function stopPresence() {
      if (presence) { presence.stop(); presence = null; }
    }

    // ── Отбой ─────────────────────────────────────────────────────────────
    // Серверу СРАЗУ, отдельной короткой командой: строка разговора
    // закрывается в миг нажатия, и следующее нажатие не упирается в «разговор
    // уже идёт». reason — только то, что заметило само устройство (у Gemini —
    // тишина и предел времени); без него сервер пишет «человек».
    // Возвращает, ушёл ли отбой (его ждёт closeLink).
    function hangup(reason) {
      stopPresence();
      if (!callId) return false;
      try {
        host.post(Object.assign({ type: 'VOICE_CMD', callId, end: true }, reason ? { reason } : {}));
        return true;
      } catch (_) { return false; }
    }

    // ── Команды в звонок (только OpenAI) ──────────────────────────────────
    // Пачка разрешённых событий Realtime: окно → воркер (VOICE_CMD) →
    // voice-cmd (подпись + «звонок твой») → боковой сокет звонка. Не прошла —
    // страдает одно действие, а не разговор.
    function sendCommands(commands) {
      return host.send({ type: 'VOICE_CMD', callId, commands }).then((r) => {
        if (!r || !r.ok) warn('voice-cmd relay failed:', (r && (r.error || r.status)) || 'no response');
        return r || null;
      });
    }

    // ── Реплики, которые знает только устройство ──────────────────────────
    let queue = Promise.resolve();
    let notSavedTold = false;
    function sendOnce(body) {
      return host.send(Object.assign({ type: 'VOICE_CMD' }, body));
    }
    // Повторять имеет смысл то, что могло пройти со второго раза: ответа нет,
    // сервер или база не ответили (5xx). Отказ по сути (404 — разговора нет
    // дольше двух минут, 400 — тело не по форме, 409 — эту реплику пишет не
    // устройство) повтором не лечится.
    const retryable = (r) => !r || (!r.ok && (!r.status || r.status >= 500));
    function deliver(kind, id, makeBody) {
      const job = queue.then(async () => {
        let r = null;
        for (let attempt = 0; attempt <= TURN_RETRY_DELAYS_MS.length; attempt++) {
          if (attempt > 0) await new Promise((res) => setTimeout(res, TURN_RETRY_DELAYS_MS[attempt - 1]));
          r = await sendOnce(makeBody());
          if (r && r.ok) break;
          if (!retryable(r)) break;
          warn(`${kind} ${id} not saved on the server (attempt ${attempt + 1}):`, (r && (r.error || r.status)) || 'no response');
        }
        if (r && r.ok) {
          if (r.end) { try { o.onServerEnded && o.onServerEnded(r.end); } catch (_) {} }
          return r;
        }
        // 409 у реплики человека OpenAI — её пишет слушатель: это не потеря.
        if (r && r.status === 409 && kind === 'said') { log('said', id, 'is the listener\'s to write'); return r; }
        warn(`${kind} ${id} NOT saved on the server:`, (r && (r.error || r.status)) || 'no response');
        // Строгий разговор: пара не принята (не записана, не списана, отказ) —
        // разговор дальше не идёт. 404 — разговора на сервере уже нет: это
        // конец по серверу, причину скажет пульс или событие.
        // Пара, досланная после отбоя (ход, досчитанный при отбое), разговор уже
        // не кончает — о ней, как и раньше, говорит onTurnNotSaved.
        if (strict && !(r && r.status === 404) && serverFailed(kind, r)) return r;
        if (!notSavedTold) {
          notSavedTold = true;
          try { o.onTurnNotSaved && o.onTurnNotSaved({ kind, id, status: r ? r.status : null }); } catch (_) {}
        }
        return r;
      });
      queue = job.catch(() => {});
      return job;
    }

    // OpenAI: реплика человека, которую на экране писала служба расшифровки.
    // agoMs — «сколько назад человек договорил», а не время: часы устройства в
    // ленту не попадают. Считается в миг отправки, а не постановки в очередь.
    function sendSaid(itemId, text, endedAtPerf) {
      if (!callId || !itemId || !text) return Promise.resolve(null);
      const id = callId;
      return deliver('said', itemId, () => ({
        callId: id,
        said: { itemId, text, agoMs: endedAtPerf != null ? Math.max(0, Math.round(performance.now() - endedAtPerf)) : 0 },
      }));
    }

    // Gemini: пара реплик хода с расходом. pair = {id, user:{text, endedAt},
    // teacher:{text, endedAt}, usage, answered}; endedAt — performance.now()
    // конца реплики. Пустая сторона не шлётся. answered — ответ у Google
    // начался (без расхода сервер спишет минимум за ход).
    function sendTurn(pair) {
      if (!callId || !pair || !pair.id) return Promise.resolve(null);
      const id = callId;
      const side = (s) => (s && s.text
        ? { text: s.text, agoMs: s.endedAt != null ? Math.max(0, Math.round(performance.now() - s.endedAt)) : 0 }
        : null);
      return deliver('turn', pair.id, () => ({
        callId: id,
        turn: { id: pair.id, user: side(pair.user), teacher: side(pair.teacher), usage: pair.usage || null, answered: !!pair.answered },
      }));
    }

    // Всё, что стоит в очереди, ушло (или сдалось). Отчёт о конце разговора
    // ждёт этого, но не дольше, чем ему дают.
    function drained() { return queue; }

    return {
      openLink, closeLink, setCallId, startPresence, stopPresence, hangup,
      sendCommands, sendSaid, sendTurn, drained,
      get linkId() { return linkId; },
      get callId() { return callId; },
      get linkOpen() { return !!link; },
    };
  }

  global.LexVoiceCallServer = { create, CALL_LINK_PREFIX };
})(typeof self !== 'undefined' ? self : globalThis);
