// lex-skeleton.js — the skeleton of a part and the one ladder of loading (STANDARD.md, В7.87 «Скелет»; В7.74).
//
// The system of loading Gennady approved 27.11.2026 («Утверждаю»). A screen with the copy on the device stands in
// its first frame and shows no sign of loading at all (lex-reads.js; the update after the copy is no wait,
// LexBusy.settle). Only a screen with no copy climbs the ladder, one for the whole app, with no numbers of its own:
//
//   0–500 ms   nothing: the frame (the head, the name, the menu, the message box) stands in the next frame, the rest
//              is quiet;
//   500 ms     the skeleton: it comes in 200 ms ease-out, stays 200 ms at least, breathes 100 → 45 → 100 % in 1.6 s,
//              every shape of the screen in one phase;
//   3 s        the word of the head (LexBusy.slow → «Updating…», «Connecting…», «Waiting for network…»); the
//              skeleton stands still — one thing moves;
//   10 s or an error at once
//              the empty state of the section (В7.61) in the place of what is missing, «Retry» the second button;
//              what is shown already stays. No red.
//   The real thing in place of the skeleton — a fade of 120 ms, nothing moves.
//
// A skeleton is never a drawing of a whole screen: every common part that has data knows its own skeleton of its
// own size, and a screen builds its skeleton from the skeletons of its parts. Never a skeleton: the head, the name,
// the letter of the avatar, the menu, the message box — they are known at the press.
//
//   chatRow()            a line of a chat (В7.34): the circle 48, the bar of the name, the last line 60 %
//   bubble('in'|'out')   a bubble (В7.1): the person's grey, the one that went out of --lex-bubble-out
//   bubbles(n)           up to 8 bubbles, in and out by turns, the screen of a chat
//   plain()              a message without a bubble (В7.13): bars of text
//   settingRow()         a line of a setting (В7.59): the bar of its name and the short bar of its value
//   orderMessage()       a message of an order of Profi.ru (В7.29): the grey part of the client (bars 14 / 10 / 12)
//                        and the blue part of the answer 40 high
//   newsCard()           a card of News (В7.31): a bubble 18 18 18 6, bars 10 / 14 / 12
//   todayCard(height)    a card «Today» (В7.84): the place of its size (described; the screens take it later)
//   list(make, n)        n skeletons of one part in a column
//
//   ladder(place, o) → { done(paint), fail(err), stop(), phase() }
//     place          the element the loading goes in: it gets aria-busy from 500 ms while it loads
//     o.skeleton()   the skeleton of the screen, built of the parts above (aria-hidden)
//     o.put(node)    where the skeleton and the empty state stand (default: appended to place)
//     o.empty(why)   the empty state (why: 'slow' | 'error' | 'offline'); default — LexSection.emptyState with Retry
//     o.retry()      what Retry does
//     o.shown()      whether the screen is on the screen now: a screen read ahead puts no word in the head
//     done(paint)    the answer came: paint() runs at once if nothing showed, else when the skeleton has stood its
//                    200 ms; the skeleton goes, the real thing fades in 120 ms
//     fail(err)      the answer failed: the empty state now; the word goes
//     stop()         the screen went elsewhere: everything of the ladder goes, nothing is painted
//
// Loaded by the page (webchat/index.html, after lex-section.js). The iPhone has the same parts in
// Parts/Skeleton.swift and the ladder in Parts/Loading.swift.
(function (global) {
  'use strict';
  if (global.LexSkeleton || typeof document === 'undefined') return;

  const LADDER = Object.freeze({
    SKELETON_MS: 500, WORD_MS: 3000, FAIL_MS: 10000, MIN_MS: 200, FADE_MS: 200, SWAP_MS: 120, BREATH_MS: 1600,
  });
  const MAX_BUBBLES = 8;
  const now = () => (global.performance && performance.now) ? performance.now() : Date.now();

  function make(cls) {
    const n = document.createElement('div');
    n.className = cls;
    return n;
  }
  function bar(h, cls) { return make(`lex-skel-bar is-${h}${cls ? ' ' + cls : ''}`); }
  // The root of every skeleton: hidden from a screen reader, in the one phase of breathing of the screen.
  function root(cls) {
    const n = make(`lex-skel ${cls}`);
    n.setAttribute('aria-hidden', 'true');
    n.style.setProperty('--lex-skel-phase', `-${Math.round(now() % LADDER.BREATH_MS)}ms`);
    return n;
  }

  function chatRow() {
    const n = root('lex-skel-row');
    const text = make('lex-skel-lines');
    text.append(bar(14, 'is-name'), bar(12, 'is-last'));
    n.append(make('lex-skel-circle'), text);
    return n;
  }
  function bubble(side) {
    const out = side === 'out';
    const n = root(`lex-skel-msg ${out ? 'is-out' : 'is-in'}`);
    const b = make(`lex-skel-bubble ${out ? 'is-out' : 'is-in'}`);
    b.append(bar(14), bar(14, 'is-last'));
    n.append(b);
    return n;
  }
  function bubbles(n) {
    const box = root('lex-skel-feed');
    const count = Math.max(1, Math.min(MAX_BUBBLES, Number(n) || 4));
    for (let i = 0; i < count; i++) {
      const b = bubble(i % 2 ? 'out' : 'in');
      if (i % 3 === 2) b.classList.add('is-short');
      box.append(b);
    }
    return box;
  }
  function plain() {
    const n = root('lex-skel-plain');
    n.append(bar(14), bar(14), bar(12, 'is-last'));
    return n;
  }
  function settingRow() {
    const n = root('lex-skel-setting');
    n.append(bar(14, 'is-name'), bar(12, 'is-value'));
    return n;
  }
  function orderMessage() {
    const n = root('lex-skel-order');
    const client = make('lex-skel-bubble is-in lex-skel-order-client');
    client.append(bar(14), bar(10), bar(12, 'is-last'));
    const answer = make('lex-skel-order-answer');
    n.append(client, answer);
    return n;
  }
  function newsCard() {
    const n = root('lex-skel-news');
    const b = make('lex-skel-bubble is-in lex-skel-news-card');
    b.append(bar(10, 'is-kicker'), bar(14), bar(12, 'is-last'));
    n.append(b);
    return n;
  }
  function todayCard(height) {
    const n = root('lex-skel-today');
    n.style.height = `${Math.max(44, Number(height) || 88)}px`;
    return n;
  }
  function list(makeOne, n) {
    const box = root('lex-skel-list');
    for (let i = 0; i < Math.max(1, Number(n) || 1); i++) box.append(makeOne());
    return box;
  }

  // The empty state of a load that did not come (В7.61): the words by the reason, «Retry» the second button.
  function emptyOf(why, retry) {
    const S = global.LexSection;
    const words = why === 'offline'
      ? ['No network', 'It loads when the network is back.']
      : why === 'error' ? ['Not loaded', 'The server of Lex did not answer.'] : ['Not loaded yet', 'The server of Lex is slow.'];
    const action = retry ? { label: 'Retry', onClick: retry } : null;
    if (S && S.emptyState) return S.emptyState({ section: 'agents', title: words[0], line: words[1], action });
    const n = make('lex-empty');
    n.textContent = words[0];
    return n;
  }

  function ladder(place, o) {
    const opts = o || {};
    let phase = 'quiet';
    let skel = null;
    let shownAt = 0;
    let emptyNode = null;
    let slowStop = null;
    let over = false;
    const put = (node) => { if (opts.put) opts.put(node); else if (place) place.append(node); };
    const t1 = setTimeout(() => {
      if (over || !opts.skeleton) return;
      skel = opts.skeleton();
      if (!skel) return;
      skel.classList.add('is-coming');
      phase = 'skeleton';
      shownAt = now();
      // aria-busy with the skeleton: a load answered within 500 ms says nothing, to a screen reader either.
      if (place) place.setAttribute('aria-busy', 'true');
      put(skel);
    }, LADDER.SKELETON_MS);
    const t2 = setTimeout(() => {
      if (over) return;
      phase = phase === 'failed' ? phase : 'word';
      // A screen that is not on the screen (read ahead, hidden) puts no word in the head.
      if (opts.shown && !opts.shown()) return;
      if (global.LexBusy && global.LexBusy.slow) slowStop = global.LexBusy.slow();
    }, LADDER.WORD_MS);
    const t3 = setTimeout(() => { if (!over) showEmpty('slow'); }, LADDER.FAIL_MS);

    function clearTimers() { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); }
    function dropSkeleton() { if (skel) { skel.remove(); skel = null; } }
    function dropEmpty() { if (emptyNode) { emptyNode.remove(); emptyNode = null; } }
    function endWord() { if (slowStop) { slowStop(); slowStop = null; } }
    function showEmpty(why) {
      clearTimeout(t1);
      dropSkeleton();
      dropEmpty();
      phase = 'failed';
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      emptyNode = opts.empty ? opts.empty(offline ? 'offline' : why) : emptyOf(offline ? 'offline' : why, opts.retry);
      if (emptyNode) put(emptyNode);
    }
    function finish() {
      over = true;
      clearTimers();
      endWord();
      if (place) place.removeAttribute('aria-busy');
    }

    return {
      phase: () => phase,
      // Also after fail(): the answer came at last (a read tried again) — the empty state goes for the real thing.
      done(paint) {
        if (phase === 'done' || phase === 'stopped') return;
        const had = !!(skel || emptyNode);
        const left = skel ? LADDER.MIN_MS - (now() - shownAt) : 0;
        if (!over) finish();
        phase = 'done';
        const swap = () => {
          dropSkeleton();
          dropEmpty();
          if (typeof paint === 'function') paint();
          if (had && place) {
            place.classList.remove('lex-skel-swap');
            void place.offsetWidth;
            place.classList.add('lex-skel-swap');
            setTimeout(() => place.classList.remove('lex-skel-swap'), LADDER.SWAP_MS + 40);
          }
        };
        if (left > 0) setTimeout(swap, left); else swap();
      },
      fail() {
        if (over) return;
        finish();
        showEmpty('error');
      },
      // Also after fail(): Retry starts a new ladder, and the empty state of this one goes.
      stop() {
        if (!over) finish();
        if (phase !== 'done') phase = 'stopped';
        dropSkeleton();
        dropEmpty();
      },
    };
  }

  global.LexSkeleton = Object.freeze({
    LADDER, MAX_BUBBLES,
    chatRow, bubble, bubbles, plain, settingRow, orderMessage, newsCard, todayCard, list,
    ladder,
  });
})(typeof self !== 'undefined' ? self : globalThis);
