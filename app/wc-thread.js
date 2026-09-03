// webchat/wc-thread.js — the message list.
//
// Two jobs that pull against each other: render Markdown as it arrives, and
// keep the scroll where the reader wants it. The second is the one that is
// easy to get wrong — a list that force-scrolls on every token makes it
// impossible to read back over an answer while it is still being written. So
// autoscroll is a mode, not an action: it stays on while the reader is at the
// bottom and switches off the moment they scroll away from it, and the jump
// button is how they opt back in.
(function (global) {
  'use strict';

  const { el, iconBtn, toast } = WcUI;

  let elThread, elTurns, elEmpty, elJump;
  let hooks = {};
  let stickToBottom = true;
  // The streaming turn, keyed by requestId: {node, bubble, text}. A map rather
  // than one variable because a stopped stream can still deliver a trailing
  // frame after the next one has started.
  const live = new Map();
  // Every bubble a live voice conversation is writing into, keyed by the
  // server's item_id. A Map and not two variables — see the Voice section.
  const voiceBubbles = new Map();

  function nearBottom() {
    return elThread.scrollHeight - elThread.scrollTop - elThread.clientHeight < 60;
  }

  function scrollToBottom(smooth) {
    elThread.scrollTo({ top: elThread.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }

  // Прилипание к низу — НЕ на каждый токен.
  //
  // Было: `scrollTo` прямо в обработчике каждого куска потока. Быстрая модель
  // шлёт куски десятками в секунду, и каждый вызов — это принудительный расчёт
  // раскладки плюс прокрутка, то есть ровно то, что на телефоне ощущается как
  // дёрганье. Сводим к одному разу за кадр: чаще кадра экран всё равно не
  // обновляется, а лишние расчёты между кадрами не видны никому, кроме
  // расходуемой батареи.
  let stickRaf = 0;
  function maybeStick() {
    if (!stickToBottom || stickRaf) return;
    stickRaf = requestAnimationFrame(() => {
      stickRaf = 0;
      if (stickToBottom) scrollToBottom(false);
    });
  }

  // The one place "is this chat empty?" is decided — so it is also the one
  // place that tells the header, whose new-chat handle only exists while the
  // current chat has something in it. Anything that adds or clears turns goes
  // through here, which is why the handle cannot drift out of step.
  function setEmpty(isEmpty) {
    elEmpty.hidden = !isEmpty;
    if (global.WcHeader && WcHeader.setHasContent) WcHeader.setHasContent(!isEmpty);
  }

  function copyButton(getText) {
    return iconBtn('copy', 'Copy', async (e) => {
      try {
        await navigator.clipboard.writeText(getText());
        toast('Copied');
      } catch (_) {
        // Clipboard is permissioned and can simply refuse (an insecure origin,
        // a shell that has not granted it). Say so instead of failing mutely.
        toast('The browser refused clipboard access', { error: true });
      }
      if (e && e.currentTarget) e.currentTarget.blur();
    });
  }

  // ── Долгое нажатие ───────────────────────────────────────────────────────
  // Тот же жест, что у композера, и он ещё должен ужиться с системным
  // выделением текста: на СВОИХ сообщениях выделение подавлено (wc-app.css),
  // поэтому удержание свободно и достаётся нам. Внутри ответа учителя
  // удержание принадлежит системе — там мы не слушаем вовсе.
  //
  // Сам жест — в общем с расширением модуле (lex-long-press.js), своей копии
  // таймера здесь больше нет. Сверх него тут два своих повода: отклик под
  // пальцем (в расширении родной оболочки нет) и правая кнопка мыши — тот же
  // жест для того, у кого нет пальца.
  function onHold(el_, fire) {
    LexLongPress.attach(el_, (e) => { WcHaptics.press(); fire(e); });
    el_.addEventListener('contextmenu', (e) => { e.preventDefault(); fire(e); });
  }

  // Текст ЭТОГО хода как его написал человек. Нарезка на слова кладёт на
  // пузырь исходник (`lexSrc`) и дальше спрашивать надо его, а не то, что
  // читается из узлов: между кусками нарезка ставит РОВНО один пробел, и
  // сообщение с двойным пробелом или отступом вернулось бы из textContent
  // подправленным. Пузырь без нарезки исходника не несёт — тогда textContent и
  // есть исходник.
  function userText(bubble) {
    const src = bubble && bubble.dataset ? bubble.dataset.lexSrc : null;
    return (src != null) ? src : ((bubble && bubble.textContent) || '');
  }

  // ── Ход ЗАГОТОВКИ в ленте ────────────────────────────────────────────────
  // Отличается ровно одним: под ним нет ни «заново», ни «изменить». Оба органа
  // отправляют заново, а отправить заново они умеют только в переписку учителя
  // — то есть ход заготовки уехал бы в чат, из которого его весь смысл был
  // исключить. Расширение поступает так же и по той же причине
  // (chat-surface.js: «Action turns never participate in ⟳ re-ask»).
  const ACTION_CLASS = 'wc-turn-action';
  const isActionTurn = (node) => !!(node && node.classList && node.classList.contains(ACTION_CLASS));

  function userMessageMenu(anchor, bubble, opts) {
    WcUI.menu(anchor, [
      {
        label: 'Copy',
        icon: 'copy',
        onSelect: async () => {
          try { await navigator.clipboard.writeText(userText(bubble)); toast('Copied'); }
          catch (_) { toast('The browser refused clipboard access', { error: true }); }
        },
      },
      (opts && opts.action) ? null : {
        label: 'Edit',
        icon: 'edit',
        onSelect: () => hooks.onEdit && hooks.onEdit(userText(bubble)),
      },
    ]);
  }

  function userTurn(text, images, opts) {
    const bubble = el('.wc-bubble', { text });
    // Ход человека приходит текстом целиком, поэтому режется сразу — ждать
    // тут нечего. `ready` кладёт на пузырь исходник даже при выключенном
    // режиме: включение посреди беседы иначе нашло бы пузыри без исходника и
    // не смогло бы потом снять с них нарезку.
    if (global.WcWordPick) WcWordPick.ready(bubble, text, 'text');
    const parts = [];
    if (images && images.length) {
      parts.push(el('.wc-turn-images', {}, images.map((src) => el('img', { src, alt: '' }))));
    }
    parts.push(bubble);
    // Меню висит на ПУЗЫРЕ, а не на всей строке: строка тянется во всю ширину
    // ленты, и удержание в пустоте справа от короткого «hi» открывало бы меню
    // ниоткуда.
    onHold(bubble, (e) => userMessageMenu(e.currentTarget || bubble, bubble, opts));
    const turn = el('.wc-turn.wc-turn-user', {}, [el('div', {}, parts)]);
    if (opts && opts.action) turn.classList.add(ACTION_CLASS);
    return turn;
  }

  // Кнопка «заново» под ответом. Стоит ТОЛЬКО под последним ответом: повтор
  // середины беседы осиротил бы всё, что после неё, — так же это устроено и в
  // расширении (decorateLastExchangeControls вешает органы на последний обмен).
  function retryButton() {
    return iconBtn('retry', 'Retry', () => hooks.onRetry && hooks.onRetry());
  }

  function assistantTurn(text) {
    const bubble = el('.wc-bubble');
    if (text) WcMarkdown.into(bubble, text);
    const foot = el('.wc-turn-foot', {}, [copyButton(() => turn.dataset.raw || '')]);
    const turn = el('.wc-turn.wc-turn-assistant', {}, [bubble, foot]);
    turn.dataset.raw = text || '';
    // Готовый ответ (история, реплей) режется сразу; пустой — это открытый
    // поток, его режет done() по концу. Резать во время потока бессмысленно по
    // построению: WcMarkdown.into на каждом кадре делает replaceChildren, то
    // есть стирает нарезку предыдущего кадра вместе со всей разметкой.
    if (text && global.WcWordPick) WcWordPick.ready(bubble, text, 'markdown');
    return { turn, bubble, foot };
  }

  // Перерисовать подвалы: «заново» живёт только под последним ответом, и после
  // каждого добавления/загрузки его надо перевесить.
  function syncFeet() {
    const assistants = [...elTurns.querySelectorAll('.wc-turn-assistant')];
    assistants.forEach((t, i) => {
      const foot = t.querySelector('.wc-turn-foot');
      if (!foot) return;
      const has = !!foot.querySelector('[data-retry]');
      const last = (i === assistants.length - 1) && !t.classList.contains('is-streaming')
        && !t.classList.contains('wc-turn-error')
        && !isActionTurn(t);
      if (last && !has) {
        const b = retryButton();
        b.dataset.retry = '1';
        foot.append(b);
      } else if (!last && has) {
        foot.querySelector('[data-retry]').remove();
      }
    });
  }

  const WcThread = {
    init(h) {
      hooks = h || {};
      elThread = document.getElementById('wc-thread');
      elTurns = document.getElementById('wc-turns');
      elEmpty = document.getElementById('wc-empty');
      elJump = document.getElementById('wc-jump');
      // Знак Lex на пустом экране. Приходит из общего с расширением
      // lex-brand-mark.js — одна копия буквы на обе поверхности; в разметке
      // остаётся пустой контейнер.
      const logo = document.getElementById('wc-empty-logo');
      if (logo && global.LexBrandMark) logo.innerHTML = LexBrandMark.svgMarkup(48);

      elThread.addEventListener('scroll', () => {
        stickToBottom = nearBottom();
        elJump.hidden = stickToBottom;
      }, { passive: true });

      elJump.addEventListener('click', () => {
        stickToBottom = true;
        elJump.hidden = true;
        scrollToBottom(true);
      });

      WcBus.subscribe((msg) => {
        if (msg.type === 'STREAM_CHUNK') WcThread.chunk(msg);
        else if (msg.type === 'STREAM_DONE') WcThread.done(msg);
        else if (msg.type === 'STREAM_ERROR') WcThread.error(msg);
      });
    },

    clear() {
      if (global.WcWordPick) WcWordPick.forgetAll();
      live.clear();
      elTurns.replaceChildren();
      stickToBottom = true;
      elJump.hidden = true;
      setEmpty(true);
    },

    renderTurns(turns) {
      // Прежние пузыри сейчас исчезнут — набор выбранных слов держится за них
      // и обязан уйти вместе с ними.
      if (global.WcWordPick) WcWordPick.forgetAll();
      live.clear();
      elTurns.replaceChildren();
      (turns || []).forEach((t) => {
        // t.images is a list of ready object URLs — the backend resolved them
        // from this browser's picture store while loading the conversation.
        if (t.role === 'user') {
          // Скрытая часть хода со словами («Word: "…"\nContext: "…"») уезжает
          // учителю и лежит в беседе, но человеку показывать её нельзя: в
          // живой ленте он видел только напечатанное, и перечитывание обязано
          // вести себя так же. Правило общее с расширением (лента одна и та
          // же: беседа из расширения читается здесь и наоборот).
          const visible = global.WcWordPick ? WcWordPick.visibleText(t.text) : t.text;
          // Ход, от которого после этого ничего не осталось, — служебная
          // инструкция выключенного лексического попапа, а не реплика
          // человека. Пустой пузырь на её месте читался бы как «он ничего не
          // сказал». Но картинка без слов — законный вопрос (см.
          // ImageAttachment на iOS), и её дропать нельзя вместе с пустым
          // текстом: без этой оговорки такой ход пропадал из ленты целиком —
          // ни пузыря, ни картинки.
          const hasImage = Array.isArray(t.images) && t.images.length > 0;
          if (!hasImage && global.WcWordPick && WcWordPick.isHiddenOnly(visible)) return;
          elTurns.append(userTurn(visible, t.images, { action: !!t.branchKey }));
        } else {
          const { turn } = assistantTurn(t.text);
          // Ход, пришедший из ветки заготовки, узнаётся по ключу ветки рядом с
          // репликой — его проставил тот, кто сшивал ленту (wc-backend.js).
          if (t.branchKey) turn.classList.add(ACTION_CLASS);
          elTurns.append(turn);
        }
      });
      setEmpty(!elTurns.childElementCount);
      syncFeet();
      stickToBottom = true;
      elJump.hidden = true;
      // After layout, not during: the images have no height yet on this frame.
      requestAnimationFrame(() => scrollToBottom(false));
    },

    appendUser(text, images, opts) {
      setEmpty(false);
      elTurns.append(userTurn(text, images, opts));
      stickToBottom = true;
      elJump.hidden = true;
      scrollToBottom(false);
    },

    // Повтор пишется В ТОТ ЖЕ пузырь, а не добавляет второй ответ: «заново»
    // — это замена ответа, а не ещё один. В хранилище он тоже заменяет строку,
    // потому что уходит под тем же turn_uid (upsert on_conflict).
    beginRetry(requestId) {
      const last = [...elTurns.querySelectorAll('.wc-turn-assistant')].pop();
      if (!last || isActionTurn(last)) return false;
      const bubble = last.querySelector('.wc-bubble');
      if (!bubble) return false;
      // Пузырь переписывается — его слова в наборе указывали бы на текст,
      // которого больше нет.
      if (global.WcWordPick) WcWordPick.forgetBubble(bubble);
      bubble.innerHTML = '';
      last.dataset.raw = '';
      last.classList.remove('wc-turn-error');
      last.classList.add('is-streaming');
      live.set(requestId, { turn: last, bubble, text: '' });
      syncFeet();
      maybeStick();
      return true;
    },

    // Opened before the first token so the reader sees the answer start.
    beginAssistant(requestId, opts) {
      setEmpty(false);
      const { turn, bubble } = assistantTurn('');
      turn.classList.add('is-streaming');
      if (opts && opts.action) turn.classList.add(ACTION_CLASS);
      elTurns.append(turn);
      live.set(requestId, { turn, bubble, text: '' });
      // Пока ответ пишется, «заново» под ним не место — и под предыдущим тоже,
      // он больше не последний.
      syncFeet();
      maybeStick();
    },

    chunk(msg) {
      const entry = live.get(msg.requestId);
      if (!entry) return;
      // A frame with no text is how the core reports the model it actually
      // used — it carries _debug_model and nothing else. Rendering it would
      // re-parse the document for no change.
      if (!msg.text) return;
      entry.text += msg.text;
      entry.turn.dataset.raw = entry.text;
      WcMarkdown.into(entry.bubble, entry.text);
      maybeStick();
    },

    done(msg) {
      const entry = live.get(msg.requestId);
      if (!entry) return;
      live.delete(msg.requestId);
      entry.turn.classList.remove('is-streaming');
      syncFeet();
      // Ответ дописан — вот теперь его можно резать на слова. Раньше нельзя:
      // каждый кадр потока перерисовывает пузырь целиком.
      if (entry.text && global.WcWordPick) WcWordPick.ready(entry.bubble, entry.text, 'markdown');
      // An answer that ended without a single token is a failure the reader
      // must see; an empty bubble reads as "the model had nothing to say".
      if (!entry.text) {
        entry.turn.classList.add('wc-turn-error');
        entry.bubble.textContent = msg.stopped
          ? 'Stopped before the first word.'
          : 'The teacher sent no answer.';
      }
      maybeStick();
    },

    error(msg) {
      const entry = live.get(msg.requestId);
      const text = msg.error || 'Something went wrong.';

      // Кончились деньги — это не сбой, а следующий шаг, и человеку он должен
      // читаться так же, как в расширении: понятная строка и кнопка рядом.
      // Решается ДО развилок ниже: путей отрисовки три (пузырь пустой, ответ
      // начался, пузыря нет вовсе), а случай один.
      //
      // Служебный код (`LEX_BILLING_GATE`) с экрана уходит, но не пропадает:
      // без него в журнале не отличить отказ по деньгам от любого другого.
      const gate = LexBillingGate.isGateError(text);
      if (gate) lexLog('[wc-thread] billing gate:', text);

      // Ответ провайдера («Anthropic 529: {"type":"overloaded_error"}») человеку
      // тоже ничего не говорит — та же расшифровка, что в расширении, из общего
      // lex-error-text.js. Сырая строка уходит с экрана, но пишется в журнал.
      // Промпт не опубликован — сервер отказал ДО провайдера (424 + stage
      // 'prompt'). Не сбой и не перегрузка: заготовку не опубликовали, денег не
      // взяли. Текст берём из общего модуля — тот же, что показывает расширение.
      const promptMissing = !gate && LexErrorText.isPromptMissing(text);
      if (promptMissing) lexLog('[wc-thread] prompt missing:', text);

      const providerText = !gate && !promptMissing && LexErrorText.provider(text);
      if (providerText) lexLog('[wc-thread] provider error:', text);
      const shown = promptMissing ? LexErrorText.promptMissing() : (providerText || text);

      const paint = (turn, bubble) => {
        turn.classList.add(gate ? 'wc-turn-gate' : 'wc-turn-error');
        if (gate) {
          bubble.textContent = '';
          bubble.append(LexBillingGate.createElement());
        } else {
          bubble.textContent = shown;
        }
      };

      if (entry) {
        live.delete(msg.requestId);
        entry.turn.classList.remove('is-streaming');
        if (!entry.text) {
          paint(entry.turn, entry.bubble);
          maybeStick();
          return;
        }
        // Partial answer already on screen — keep it (it was paid for) and put
        // the failure under it rather than replacing what arrived. Больше в
        // этот пузырь ничего не придёт — значит он дописан, и слова в нём
        // такие же нажимаемые, как в целом ответе.
        if (global.WcWordPick) WcWordPick.ready(entry.bubble, entry.text, 'markdown');
      }
      setEmpty(false);
      const turn = el('.wc-turn', {}, [el('.wc-bubble')]);
      paint(turn, turn.firstChild);
      elTurns.append(turn);
      maybeStick();
    },

    // ── Voice ────────────────────────────────────────────────────────────
    // A spoken exchange writes into the same list as a typed one.
    //
    // ⚠️ ONE BUBBLE PER item_id, and that is the whole fix. This used to be two
    // variables — one "current" user bubble and one "current" assistant bubble
    // — which silently assumed the conversation is strictly alternating. It is
    // not: the teacher hearing itself opens a second utterance while the first
    // answer is still streaming, and with one variable per role the second
    // question appended BELOW an answer whose remaining text kept flowing into
    // the bubble above it. That is exactly the "reply above the question" the
    // owner photographed.
    //
    // Keyed by item_id, a bubble is created once, at the first event that
    // mentions its id, and is filled thereafter no matter what else arrives in
    // between. Document order therefore follows the order the server actually
    // opened the items, which is the order they were spoken.
    //
    // The reader's bubble is opened when the voice detector confirms SPEECH,
    // not when the transcript arrives: transcription is slower than detection,
    // so a bubble created on the transcript would land under the reply to it.
    beginVoiceUser(itemId) {
      if (!itemId || voiceBubbles.has(itemId)) return;
      setEmpty(false);
      const bubble = el('.wc-bubble.is-awaiting', { text: '' });
      // .wc-turn-voice: italic, same as the extension's spoken bubbles
      // (styles.css .ytvocab-chat-msg-voice) — marks it as said, not typed.
      const turn = el('.wc-turn.wc-turn-user.wc-turn-voice', {}, [el('div', {}, [bubble])]);
      elTurns.append(turn);
      voiceBubbles.set(itemId, { turn, bubble, role: 'user' });
      maybeStick();
    },

    voiceUserText(itemId, text) {
      if (!itemId) return;
      if (!voiceBubbles.has(itemId)) WcThread.beginVoiceUser(itemId);
      const entry = voiceBubbles.get(itemId);
      if (!entry) return;
      entry.bubble.textContent = text || '';
      // The dots are a placeholder for "heard you, still transcribing"; the
      // moment there are words, it is no longer waiting.
      entry.bubble.classList.toggle('is-awaiting', !text);
      maybeStick();
    },

    // A transcription that failed leaves nothing to show, and an empty bubble
    // reads as "they said nothing".
    dropVoiceUser(itemId) {
      const entry = itemId && voiceBubbles.get(itemId);
      if (!entry) return;
      entry.turn.remove();
      voiceBubbles.delete(itemId);
    },

    voiceAssistantText(itemId, text) {
      if (!itemId) return;
      let entry = voiceBubbles.get(itemId);
      if (!entry) {
        setEmpty(false);
        const made = assistantTurn('');
        made.turn.classList.add('wc-turn-voice');
        elTurns.append(made.turn);
        entry = { turn: made.turn, bubble: made.bubble, role: 'assistant' };
        voiceBubbles.set(itemId, entry);
      }
      entry.turn.dataset.raw = text;
      // PLAIN TEXT, not Markdown — the same choice the extension makes on its
      // live voice path (chat-surface.js:6584 appends to a text node; the
      // Markdown pass exists only on the legacy lab surface). Speech has no
      // Markdown in it, and running a half-arrived transcript through a parser
      // makes stray asterisks and underscores flicker as formatting.
      entry.bubble.textContent = text;
      maybeStick();
    },

    // Called once when the whole conversation ends, not per turn: a bubble has
    // to stay addressable for as long as its item can still receive a late
    // final transcript.
    endVoice() {
      voiceBubbles.forEach((entry) => {
        // Anything still showing the waiting dots never got a transcript.
        if (entry.role === 'user' && !entry.bubble.textContent) entry.turn.remove();
        // Сказанное — тоже сообщение в этой ленте, и слова в нём нажимаются
        // так же. Режем ЗДЕСЬ, а не по ходу разговора: пока он идёт, обе
        // стороны переписывают свои пузыри на каждом кадре расшифровки.
        else if (global.WcWordPick) WcWordPick.ready(entry.bubble, entry.bubble.textContent, 'text');
      });
      voiceBubbles.clear();
    },

    // Used when the keyboard opens: the last thing said must stay in view.
    scrollToEnd() { scrollToBottom(false); stickToBottom = true; elJump.hidden = true; },

    // True while any stream is open — the composer asks before deciding
    // whether its button says "send" or "stop".
    isStreaming() { return live.size > 0; },

    // Ровно та же проверка, что setEmpty() уже использует внутри renderTurns():
    // есть ли в открытой сейчас беседе хоть одно сообщение. Единственный
    // источник правды для решения про клавиатуру у боковой панели (wc-app.js).
    isEmpty() { return !elTurns.childElementCount; },
  };

  global.WcThread = WcThread;
})(typeof self !== 'undefined' ? self : globalThis);
