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

  const { el, toast } = WcUI;

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
  // Вопрос, заданный заготовкой, — обычный вопрос беседы. «Edit» у него есть:
  // текст ложится в поле, а пилюля той же заготовки подсвечивается, и
  // отправка уходит через неё (wc-app.js editTurn). Слот заготовки — на узле.
  // Под ОТВЕТОМ заготовки строка та же, что под любым ответом: переспрос
  // сервер отправит той же заготовкой сам.
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
      {
        label: 'Edit',
        icon: 'edit',
        // У хода заготовки правится только фраза: строку заготовки править
        // нельзя, она встаёт сама при отправке через ту же пилюлю.
        onSelect: () => {
          const turn = bubble.closest('.wc-turn-user');
          return hooks.onEdit && hooks.onEdit(
            (bubble.dataset.editText != null) ? bubble.dataset.editText : userText(bubble),
            (opts && opts.presetSlot) || null,
            (turn && turn.dataset.uid) || null);
        },
      },
    ]);
  }

  // Пузырь хода заготовки: строка, пустая строка, фраза — так, как вопрос видит
  // учитель на следующих ходах (решение владельца 2026-09-22). Замену
  // присылает сервер; правило разбора общее с расширением (lex-word-pick.js).
  function presetParts(later) {
    const WP = global.LexWordPick;
    return (later && WP && typeof WP.splitPresetLater === 'function') ? WP.splitPresetLater(later) : null;
  }

  function userTurn(text, images, opts) {
    const bubble = el('.wc-bubble', { text });
    if (opts && typeof opts.editText === 'string') bubble.dataset.editText = opts.editText;
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
    if (opts && opts.presetSlot) turn.dataset.presetSlot = String(opts.presetSlot);
    return turn;
  }

  // Строка под ответом — общий модуль с расширением (lex-answer-row.js):
  // копирование под каждым ответом, правее переключатель версий, последней —
  // кнопка модели (под последним ответом). Какой ответ
  // последний, решает он же (syncFeet ниже).
  function answerRow(getText) {
    return global.LexAnswerRow.create({
      getText,
      copyLabel: 'Copy',
      onCopied: (ok) => {
        // Clipboard is permissioned and can simply refuse (an insecure origin,
        // a shell that has not granted it). Say so instead of failing mutely.
        if (ok) toast('Copied');
        else toast('The browser refused clipboard access', { error: true });
      },
    });
  }

  function assistantTurn(text) {
    const bubble = el('.wc-bubble');
    if (text) WcMarkdown.into(bubble, text);
    const foot = el('.wc-turn-foot', {}, [answerRow(() => turn.dataset.raw || '')]);
    const turn = el('.wc-turn.wc-turn-assistant', {}, [bubble, foot]);
    turn.dataset.raw = text || '';
    // Готовый ответ (история, реплей) режется сразу; пустой — это открытый
    // поток, его режет done() по концу. Резать во время потока бессмысленно по
    // построению: WcMarkdown.into на каждом кадре делает replaceChildren, то
    // есть стирает нарезку предыдущего кадра вместе со всей разметкой.
    if (text && global.WcWordPick) WcWordPick.ready(bubble, text, 'markdown');
    return { turn, bubble, foot };
  }

  // Перерисовать строки под ответами: кнопка модели живёт только под
  // последним ответом, и после каждого добавления, загрузки и отказа её надо
  // перевесить. Под голосовым ответом строки нет вовсе. Правило «какой
  // последний» — общее с расширением (LexAnswerRow.sync).
  function syncFeet() {
    const entries = [];
    for (const t of elTurns.querySelectorAll('.wc-turn-assistant')) {
      const foot = t.querySelector('.wc-turn-foot');
      if (t.classList.contains('wc-turn-voice')) {
        // Строки с моделью и копированием под голосовым ответом нет; цена хода
        // (разработчику) встаёт в свой подвал — paintMoney.
        const row = foot ? foot.querySelector('.lex-answer-row') : null;
        if (row) row.remove();
        entries.push({ row: null, eligible: false });
        continue;
      }
      const row = foot ? foot.querySelector('.lex-answer-row') : null;
      entries.push({
        row,
        eligible: !!row && !t.classList.contains('is-streaming')
          && !t.classList.contains('wc-turn-error')
          && !t.classList.contains('wc-turn-gate'),
        model: {
          label: global.LexAnswerRow.modelLabel(t.dataset.model || '') || 'Model',
          title: 'Choose a model and re-ask',
          onClick: (btn) => hooks.onPickModel && hooks.onPickModel(btn, t),
        },
      });
    }
    global.LexAnswerRow.sync(entries);
  }

  // Прежний ответ вернуть на место: переспрос не дал ни слова (отказ, «стоп»
  // до первого слова). На сервере он не заменён — значит и на экране должен
  // остаться он, а не пустой пузырь.
  function restorePrevious(entry) {
    const prev = entry.retry;
    entry.turn.classList.remove('is-streaming', 'wc-turn-error', 'wc-turn-gate');
    entry.turn.dataset.raw = prev.raw;
    entry.turn.dataset.model = prev.model || '';
    entry.bubble.textContent = '';
    if (prev.raw) WcMarkdown.into(entry.bubble, prev.raw);
    if (prev.raw && global.WcWordPick) WcWordPick.ready(entry.bubble, prev.raw, 'markdown');
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
        else if (msg.type === 'WC_TURN_MODEL') WcThread.setTurnModel(msg);
        else if (msg.type === 'WC_TURN_UIDS') WcThread.setTurnUids(msg);
        else if (msg.type === 'STREAM_USER_TEXT' && msg.laterText) WcThread.setLastUserPreset(msg.laterText);
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
          let visible = global.WcWordPick ? WcWordPick.visibleText(t.text) : t.text;
          let editText;
          const pp = t.presetSlot ? presetParts(t.later) : null;
          if (pp && pp.line) {
            visible = global.LexWordPick.presetBubbleText(pp);
            editText = pp.phrase;
          }
          // Ход, от которого после этого ничего не осталось, — служебная
          // инструкция выключенного лексического попапа, а не реплика
          // человека. Пустой пузырь на её месте читался бы как «он ничего не
          // сказал». Но картинка без слов — законный вопрос (см.
          // ImageAttachment на iOS), и её дропать нельзя вместе с пустым
          // текстом: без этой оговорки такой ход пропадал из ленты целиком —
          // ни пузыря, ни картинки.
          const hasImage = Array.isArray(t.images) && t.images.length > 0;
          if (!hasImage && global.WcWordPick && WcWordPick.isHiddenOnly(visible)) return;
          const node = userTurn(visible, t.images, { presetSlot: t.presetSlot || null, editText });
          if (t.uid) node.dataset.uid = String(t.uid);
          elTurns.append(node);
        } else {
          const { turn } = assistantTurn(t.text);
          // Сказанное голосом — под ним строки нет (syncFeet).
          if (t.origin === 'voice') turn.classList.add('wc-turn-voice');
          // Модель ответа (из денег беседы) — подпись кнопки модели.
          if (t.model) turn.dataset.model = t.model;
          // Уид реплики: по нему встаёт цена хода (paintMoney).
          if (t.uid) turn.dataset.uid = String(t.uid);
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

    // Замена хода заготовки пришла первым кадром — последний свой пузырь
    // заготовки перерисовывается строкой и фразой, до первого слова учителя.
    setLastUserPreset(later) {
      const all = [...elTurns.querySelectorAll('.wc-turn-user')];
      const old = all.pop();
      if (!old || !old.dataset.presetSlot) return;
      const pp = presetParts(later);
      if (!pp || !pp.line) return;
      const imgs = [...old.querySelectorAll('.wc-turn-images img')].map((i) => i.src).filter(Boolean);
      const node = userTurn(global.LexWordPick.presetBubbleText(pp), imgs,
        { presetSlot: old.dataset.presetSlot, editText: pp.phrase });
      if (old.dataset.uid) node.dataset.uid = old.dataset.uid;
      old.replaceWith(node);
    },

    appendUser(text, images, opts) {
      setEmpty(false);
      elTurns.append(userTurn(text, images, opts));
      stickToBottom = true;
      elJump.hidden = true;
      scrollToBottom(false);
    },

    // Переспрос пишется В ТОТ ЖЕ пузырь, а не добавляет второй ответ: это
    // замена ответа, а не ещё один. Прежний текст и модель запоминаются —
    // переспрос без единого слова возвращает их на место (restorePrevious).
    // false — переспрашивать нечего (не последний ответ, голосовой).
    beginRetry(requestId, turn) {
      const all = [...elTurns.querySelectorAll('.wc-turn-assistant')];
      const last = all.pop();
      if (!last || (turn && turn !== last) || last.classList.contains('wc-turn-voice')) return false;
      const bubble = last.querySelector('.wc-bubble');
      if (!bubble) return false;
      const retry = { raw: last.dataset.raw || '', model: last.dataset.model || '' };
      // Пузырь переписывается — его слова в наборе указывали бы на текст,
      // которого больше нет.
      if (global.WcWordPick) WcWordPick.forgetBubble(bubble);
      bubble.innerHTML = '';
      last.dataset.raw = '';
      last.classList.remove('wc-turn-error');
      last.classList.add('is-streaming');
      live.set(requestId, { turn: last, bubble, text: '', retry });
      syncFeet();
      maybeStick();
      return true;
    },

    // Opened before the first token so the reader sees the answer start.
    beginAssistant(requestId, opts) {
      setEmpty(false);
      const { turn, bubble } = assistantTurn('');
      turn.classList.add('is-streaming');
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

    // Модель хода — от серверной части в начале хода (WC_TURN_MODEL).
    setTurnModel(msg) {
      const entry = live.get(msg.requestId);
      if (!entry || !msg.modelId) return;
      entry.turn.dataset.model = String(msg.modelId);
    },

    // Уиды пары — от серверной части в начале хода (WC_TURN_UIDS). Ответ —
    // живой пузырь этого хода; вопрос — последний вопрос перед ним (при
    // переспросе вопрос тот же, и уид у него прежний).
    setTurnUids(msg) {
      const entry = live.get(msg.requestId);
      if (!entry) return;
      if (msg.assistantUid) entry.turn.dataset.uid = String(msg.assistantUid);
      if (msg.userUid) {
        let prev = entry.turn.previousElementSibling;
        while (prev && !prev.classList.contains('wc-turn-user')) prev = prev.previousElementSibling;
        if (prev && !prev.dataset.uid) prev.dataset.uid = String(msg.userUid);
      }
    },

    // Деньги беседы на экране: цена под репликой — по готовому уиду, который
    // отдал сервер (list_chat_money, разбор — lex-chat-money.js), и итог
    // беседы в шапке (WcHeader.setMoney). Что показывать и кому, решил сервер
    // (show_money); своего счёта у страницы нет. money === null — беседы нет
    // или денег не показывают: все цены снимаются.
    paintMoney(money) {
      const show = !!(money && money.showMoney);
      for (const t of elTurns.querySelectorAll('.wc-turn[data-uid]')) {
        const old = t.querySelector(':scope > .wc-turn-foot > .wc-price, :scope > div > .wc-turn-foot > .wc-price');
        const a = show ? money.answers.get(t.dataset.uid) : null;
        const usd = (a && a.billed != null && Number.isFinite(Number(a.billed))) ? Number(a.billed) : null;
        if (usd == null) { if (old) old.remove(); continue; }
        let foot = t.classList.contains('wc-turn-user')
          ? t.querySelector(':scope > div > .wc-turn-foot')
          : t.querySelector(':scope > .wc-turn-foot');
        if (!foot) {
          foot = el('.wc-turn-foot');
          if (t.classList.contains('wc-turn-user')) {
            foot.classList.add('wc-turn-foot-question');
            (t.firstElementChild || t).append(foot);
          } else {
            t.append(foot);
          }
        }
        const node = old || el('span.wc-price');
        node.textContent = global.LexChatMoney.format(usd);
        node.dataset.lexUsd = String(usd);
        node.title = [a.model, a.effort].filter(Boolean).join(' · ');
        if (!old) foot.append(node);
      }
      if (global.WcHeader && WcHeader.setMoney) WcHeader.setMoney(show ? money.total : null, show);
    },

    done(msg) {
      const entry = live.get(msg.requestId);
      if (!entry) return;
      live.delete(msg.requestId);
      // Переспрос, который не дал ни слова, — прежний ответ остаётся.
      if (entry.retry && !entry.text) {
        restorePrevious(entry);
        syncFeet();
        maybeStick();
        return;
      }
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
      // Разговор сброшен разработчиком, пока был открыт здесь (content-reset):
      // сервер отказал до денег, писать в него больше некуда — открыть заново.
      // Текст тот же, что в расширении, из общего модуля.
      // У модели нет цены — сервер отказал до провайдера (424 + stage
      // 'pricing'), денег не взяли. Текст с именем модели — из общего модуля.
      const modelUnpriced = !gate && !promptMissing
        && typeof LexErrorText.isModelUnpriced === 'function' && LexErrorText.isModelUnpriced(text);
      if (modelUnpriced) lexLog('[wc-thread] model unpriced:', text);
      const conversationReset = !gate && !promptMissing && !modelUnpriced
        && typeof LexErrorText.isConversationReset === 'function' && LexErrorText.isConversationReset(text);
      if (conversationReset) lexLog('[wc-thread] conversation reset:', text);

      const providerText = !gate && !promptMissing && !modelUnpriced && !conversationReset && LexErrorText.provider(text);
      if (providerText) lexLog('[wc-thread] provider error:', text);
      // Ответ, который переспрашивали, уже переспросили или сняли на другом
      // устройстве — сервер отказал до денег (409 regen_target_gone).
      const regenGone = !gate && typeof LexErrorText.isRegenTargetGone === 'function'
        && LexErrorText.isRegenTargetGone(text);
      const shown = regenGone ? LexErrorText.regenTargetGone()
        : promptMissing ? LexErrorText.promptMissing(text)
        : (modelUnpriced ? LexErrorText.modelUnpriced(text)
          : (conversationReset ? LexErrorText.conversationReset() : (providerText || text)));

      const paint = (turn, bubble) => {
        turn.classList.add(gate ? 'wc-turn-gate' : 'wc-turn-error');
        if (gate) {
          bubble.textContent = '';
          // Сырая строка едет в блок: если сервер прислал числа (на ЭТОТ запрос
          // не хватает), человек увидит сколько нужно и сколько есть.
          bubble.append(LexBillingGate.createElement({ raw: text }));
        } else {
          bubble.textContent = shown;
        }
      };

      if (entry) {
        live.delete(msg.requestId);
        entry.turn.classList.remove('is-streaming');
        if (entry.retry && !entry.text) {
          // Переспрос не удался: прежний ответ возвращается на место, а причина
          // (в том числе «пополните») встаёт заметкой под ним. Заметка — не
          // ответ: кнопка модели остаётся у прежнего ответа, и после пополнения
          // переспрашивают его же.
          restorePrevious(entry);
          const note = el('.wc-turn.wc-turn-notice', {}, [el('.wc-bubble')]);
          paint(note, note.firstChild);
          entry.turn.after(note);
          syncFeet();
          maybeStick();
          return;
        }
        if (!entry.text) {
          paint(entry.turn, entry.bubble);
          syncFeet();
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
      turn.dataset.uid = 'voice:' + itemId;
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
        // Уид, под которым сервер записал реплику и отдаёт цену хода.
        made.turn.dataset.uid = 'voice:' + itemId;
        elTurns.append(made.turn);
        entry = { turn: made.turn, bubble: made.bubble, role: 'assistant' };
        voiceBubbles.set(itemId, entry);
      }
      entry.turn.dataset.raw = text;
      // PLAIN TEXT, not Markdown — the realtime models' live transcript
      // (gpt-live sends no live text to this page; its turns arrive from the
      // server and render through WcMarkdown). Running a half-arrived
      // transcript through a parser makes stray asterisks and underscores
      // flicker as formatting; the extension's gpt-live feed hides a marker
      // still waiting for its pair (chat-surface.js hideOpenMarkers).
      entry.bubble.textContent = text;
      syncFeet();
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

    // Сколько знаков ответа человек УЖЕ ВИДИТ на экране. Печатающего буфера у
    // страницы нет — пришедшее рисуется сразу, — поэтому увиденное и есть весь
    // накопленный текст пузыря. Спрашивает «стоп»: это число уезжает серверу,
    // и он режет по нему реплику учителя.
    seenChars(requestId) {
      const entry = live.get(requestId);
      return entry ? String(entry.text || '').length : 0;
    },

    // Ровно та же проверка, что setEmpty() уже использует внутри renderTurns():
    // есть ли в открытой сейчас беседе хоть одно сообщение. Единственный
    // источник правды для решения про клавиатуру у боковой панели (wc-app.js).
    isEmpty() { return !elTurns.childElementCount; },

    // Сколько ответов учителя в ленте — первый ход беседы узнаётся по этому.
    answerCount() { return elTurns.querySelectorAll('.wc-turn-assistant').length; },
  };

  global.WcThread = WcThread;
})(typeof self !== 'undefined' ? self : globalThis);
