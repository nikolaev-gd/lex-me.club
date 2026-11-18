// lex-reads.js — the one way the screens of Lex read the server: the copy kept on the device at
// once, the server's answer after it. The page and the Mac app (the same page) read this way; the
// iPhone has the same rules and the same names in KeptReads.swift. docs/spec/27-sections.md.
//
// Why. Apps that open at once all work like this (RFC 5861, «stale-while-revalidate», 2010;
// Android's guide to offline-first apps: «Present users with local data immediately instead of
// waiting for the first network call to complete or fail»). What a screen shows is kept on the
// device; the next opening, after a restart too, draws it in its first frame, and the server's
// answer takes its place quietly. The server stays the source: the device keeps its last answer
// as it came and computes nothing of its own.
//
// One place. The copy is written where the window calls the server (webchat/wc-history.js on the
// page, the background of the extension: chat-history-server.js and background.js): every answer
// to a name in KEPT is kept, whoever asked for it, and nothing else writes a copy. A screen shows a kept name through twice(): the copy first, the answer after. A new server
// function goes into KEPT or into CALLS on purpose: dev-tools/test-lex-reads.mjs fails on a name
// in neither list, on the page and on the iPhone alike, and on the two surfaces' lists differing.
//
// create({ storage, account, skip }) → copies
//   storage    { get(key) → Promise, set(key, value) → Promise, remove(keys) → Promise }
//              (idbStorage(name) below gives one in a database of its own)
//   account()  who is signed in now, or null — or a Promise of it. The account goes inside every
//              copy and a copy of another account is never read; a change of account wipes them
//              all (wc-wipe.js on the page, wipeAccountScopedData in the extension).
//   skip       names this window keeps by a rule of its own: the extension keeps its chats in its
//              store of threads (video-threads.js), and a second copy of them would be dead weight
// .kept(name, args)        → Promise of the copy, or null
// .keep(name, args, value) keep an answer: the call layer does it, and so does a window holding
//                          a newer state of the same answer (a feed brought up to date by its
//                          changes, the place in the News feed)
// twice(copy, answer, show, empty) → Promise of the answer
//   copy()     → Promise of the copy or null;  answer() → Promise of the server's answer
//   show(value, fresh, same)  the copy, when it comes before the answer (fresh false), then the
//              answer (fresh true; same — it is exactly the copy already on the screen)
//   empty()    optional: the copy goes on the screen only while the screen holds nothing yet,
//              so a copy never covers what the window read meanwhile
//   The answer failed: the copy, if it came, stays on the screen, and the error goes on.
(function (global) {
  'use strict';

  // The answers a screen shows, each kept. by — the arguments that tell one copy from another;
  // first — arguments that mean a further portion of a list (that answer is not kept); limit — how
  // many copies of the name are kept, the one written longest ago goes first (one when not named).
  const KEPT = {
    lex_home_sections: { by: ['p_surface'] },             // the buttons of the sections
    account_billing: {},                                  // the balance
    list_chats: { first: ['p_cursor_last_at'] },          // the first portion of the list of chats
    list_turns: { by: ['p_chat_key'], limit: 40 },        // a chat
    list_chat_money: { by: ['p_chat_key'], limit: 40 },   // its prices and its total
    lex_chat_marks: { by: ['p_chat_key'], limit: 40 },    // the marks under its answers
    profi_home: {},                                       // Profi.ru: the list
    profi_feed: {},                                       //   the new orders
    profi_item: { by: ['p_order'], limit: 60 },           //   an order with its chat
    lex_em_feed_home: {},                                 // Extended Mind: the feeds
    lex_em_questions: {},                                 //   the questions
    lex_em_feed_item: { by: ['p_kind'], limit: 10 },      //   a feed with its chat
    lex_em_question_item: { by: ['p_item'], limit: 60 },  //   a question with its chat
    lex_em_feed_turns: { by: ['p_chat_key'], limit: 10 }, //   a feed read as a chat
    folder_home: { by: ['p_folder'], limit: 10 },          // a folder of chats (Kolya, Other): its list
    folder_item: { by: ['p_chat_key'], limit: 60 },       //   a chat of it with its messages
    lex_folder_turns: { by: ['p_chat_key'], first: ['p_before_uid'], limit: 40 }, //   its messages
    news_feed: {},                                        // News: its first letters and the place in them
    news_settings: {},                                    //   its settings
    news_chat_head: { by: ['p_chat_key'], limit: 40 },    //   what stands over a news chat
    last_chat: {},  // the iPhone: the chat it was left on, ready for its first frame (LastChat.swift)
    page_chat: { by: ['url'], limit: 60 },  // the extension: which chat a page (or a video) opens on
  };

  // The server functions that are asked and not kept: commands, writes, stamps of change, and
  // the reads that a window keeps by its own rule (settings into its storage, News into
  // news_feed above, with the place in it).
  const CALLS = [
    // commands and writes
    'profi_command', 'profi_command_result', 'profi_send', 'profi_send_text', 'profi_send_at',
    'profi_send_cancel', 'folder_send_drop', 'open_news_item', 'save_news_position',
    'save_news_settings', 'rename_chat', 'set_chat_hidden', 'chat_act', 'lex_turn_stopped', 'attach_to_turn',
    'lex_push_register', 'lex_push_unregister', 'lex_push_badge_on', 'lex_chat_presence',
    'lex_live_register', 'lex_notification_set', 'lex_notification_mode_set', 'lex_patch_user_settings',
    // the moment a chat was last open: taken and written, never shown from a copy
    'lex_chat_seen',
    // what became of a message after a broken connection (chat_turn_fate.sql): asked live, never kept
    'lex_op_state',
    // the draft of every chat: lex-drafts.js keeps its own copy on the device, with its own rule
    'lex_draft_put', 'lex_drafts',
    // stamps and changes: is there something new, what changed since
    'profi_rev', 'lex_em_feed_rev', 'lex_em_feed_changes', 'folder_rev',
    // the journal of the account's changes: asked after a reconnect and when the window comes back
    'lex_changes_since',
    // the opening of an item on the server, the session of a feed or of a chat
    'profi_open', 'lex_em_feed_open', 'lex_em_question_open', 'folder_open', 'chats',
    // «Разбор»: the numbers of its tabs (the window keeps the last ones itself, with their day) and
    // the question a record asked, found at the press
    'lex_em_intake_today', 'lex_em_intake_question',
    // «Обращения к базе»: how many requests of the last 24 hours, under the title (asked on every new record)
    'lex_em_requests_day',
    // the whole transcript of a call of an order chat, asked when the person opens it (В7.42)
    'profi_call_transcript',
    // reads a window keeps by its own rule
    'list_news', 'lex_model_defaults', 'published_settings', 'news_settings_published',
    'lex_notification_settings', 'lex_notification_modes', 'lex_missed', 'lex_missed_summary', 'sessions',
    'models',   // the catalog of dictation, held by lex-dictation-catalog.js for the microphone
    // the extension: its lessons on a video and on a page, kept in its store of threads and its
    // cache of subtitles; its settings, kept in its own storage; what it writes
    'list_turns_since', 'open_video_chat', 'select_turn', 'hide_turns', 'lex_subtitles_variants',
    'video_subtitles', 'page_texts', 'subtitle_fetches', 'lex_save_video_subtitles',
    'lex_save_video_raw_cues', 'lex_save_video_author_track', 'lex_save_video_page',
    'lex_merge_video_raw_cues', 'lex_merge_asr_ranges', 'lex_asr_chunking', 'lex_asr_quote',
    'lex_full_video_quote', 'prompts', 'user_settings', 'lex_account_settings', 'lex_am_i_developer',
    'calls', 'word_taps', 'pronunciation_assessments', 'pronunciation_phonemes',
    'pronunciation_syllables', 'submit_phoneme_scores', 'submit_syllable_scores',
  ];

  const PREFIX = 'lexKept:';
  const INDEX = 'lexKept#';

  // The storage key of one copy, or null: a name outside KEPT, or a further portion of a list.
  function copyKey(name, args) {
    const spec = KEPT[name];
    if (!spec) return null;
    const a = args || {};
    if (spec.first && spec.first.some((k) => a[k] != null)) return null;
    const parts = (spec.by || []).map((k) => encodeURIComponent(a[k] == null ? '' : String(a[k])));
    return `${PREFIX}${name}:${parts.join('/')}`;
  }

  const warn = (e) => console.warn('[reads]', e && e.message);

  function create(opts) {
    const storage = opts.storage;
    const account = opts.account;
    const skip = new Set(opts.skip || []);
    // The index of a name with many copies is rewritten one write after another.
    const chains = new Map();

    async function kept(name, args) {
      const key = skip.has(name) ? null : copyKey(name, args);
      if (!key) return null;
      try {
        const who = await account();
        if (!who) return null;
        const rec = await storage.get(key);
        return rec && rec.account === who && rec.value != null ? rec.value : null;
      } catch (e) {
        warn(e);
        return null;
      }
    }

    function keep(name, args, value) {
      const key = skip.has(name) ? null : copyKey(name, args);
      if (!key || value == null) return Promise.resolve();
      // The account is the one that asked: taken now, not when the write comes.
      const whoNow = Promise.resolve().then(account);
      const write = async () => {
        const who = await whoNow;
        if (!who) return false;
        await storage.set(key, { account: who, at: Date.now(), value });
        return true;
      };
      const limit = KEPT[name].limit || 1;
      if (limit <= 1) return Promise.resolve().then(write).catch(warn);
      const indexKey = INDEX + name;
      const run = (chains.get(name) || Promise.resolve()).then(async () => {
        if (!(await write())) return;
        const list = await storage.get(indexKey);
        const next = (Array.isArray(list) ? list : []).filter((k) => k !== key).concat(key);
        const gone = next.length > limit ? next.splice(0, next.length - limit) : [];
        await storage.set(indexKey, next);
        if (gone.length) await storage.remove(gone);
      }).catch(warn);
      chains.set(name, run);
      return run;
    }

    function forget(name, args) {
      const key = copyKey(name, args);
      return key ? Promise.resolve().then(() => storage.remove([key])).catch(warn) : Promise.resolve();
    }

    return { kept, keep, forget };
  }

  async function twice(copy, answer, show, empty) {
    let answered = false;
    let shown;
    const fromDevice = Promise.resolve().then(copy).then((v) => {
      if (answered || v == null || (empty && !empty())) return;
      shown = v;
      show(v, false, false);
    }, warn);
    let r;
    try {
      r = await answer();
    } catch (e) {
      await fromDevice;
      throw e;
    }
    answered = true;
    let same = false;
    if (shown !== undefined) {
      try { same = JSON.stringify(shown) === JSON.stringify(r); } catch (_) { same = false; }
    }
    show(r, true, same);
    return r;
  }

  // A storage for the copies in an IndexedDB database of their own — the extension's background
  // keeps them so, apart from its other stores; .clear() is for the wipe of a change of account.
  function idbStorage(dbName) {
    let opened = null;
    const open = () => opened || (opened = new Promise((ok, no) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore('kept'); };
      req.onsuccess = () => ok(req.result);
      req.onerror = () => { opened = null; no(req.error); };
    }));
    const run = (mode, fn) => open().then((db) => new Promise((ok, no) => {
      const t = db.transaction('kept', mode);
      const req = fn(t.objectStore('kept'));
      t.oncomplete = () => ok(req ? req.result : undefined);
      t.onerror = () => no(t.error);
      t.onabort = () => no(t.error);
    }));
    return {
      get: (key) => run('readonly', (st) => st.get(key)),
      set: (key, value) => run('readwrite', (st) => { st.put(value, key); }),
      remove: (keys) => run('readwrite', (st) => { for (const k of keys) st.delete(k); }),
      clear: () => run('readwrite', (st) => { st.clear(); }),
    };
  }

  // The name of the server function in a REST path of the database: '/rest/v1/rpc/list_turns'
  // and '/rest/v1/account_billing?…' both name theirs.
  function nameOfPath(path) {
    const m = /\/rest\/v1\/(?:rpc\/)?([a-z_0-9]+)/.exec(String(path || ''));
    return m ? m[1] : null;
  }

  global.LexReads = { KEPT, CALLS, PREFIX, INDEX, copyKey, create, twice, nameOfPath, idbStorage };
})(typeof window !== 'undefined' ? window : globalThis);
