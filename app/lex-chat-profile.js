// lex-chat-profile.js — the profile of a chat: one table for the server and both surfaces (docs/spec/21-chat-canvas.md,
// «Профиль чата»; plan PLAN-CHAT-UNIFY, stage 3).
//
// What it says. A chat of Lex is one canvas; its KIND switches its parts on and off. Every kind is one row of KINDS:
// the field and its buttons, where a send goes, whose Stop, the price, the items of a message's menu, the ticks, the talk
// with the model inside, the card from the head, the fold of the talk. The channels a person is reached by (CHANNELS)
// say what a message there may do: Edit (its window and the most characters), a reaction, a personal chat or a group.
// KEYS is the fallback only: the kind of a chat comes from the server with the chat (`profile` of folder_item and
// profi_item, supabase/migrations/chat_profile.sql); a key is read only when an older server sent none.
//
// One file of truth, read as it is by every place that needs it:
//   - the page and the program for the Mac: a script of webchat/index.html (global LexChatProfile);
//   - the edge functions: `import "./lex-chat-profile.js"` through chat-profile.ts (globalThis.LexChatProfile);
//   - the database of the app: dev-tools/chat-profile-sql.mjs writes TABLE into supabase/migrations/chat_profile.sql
//     (lex_chat_profile_table), with the column «side» of MESSAGE_KINDS (lex-chat-money.js) as `conversation`;
//   - the iPhone: dev-tools/ios-composer-box.mjs puts TABLE into composer-box.json at every build (ChatProfile.swift).
// dev-tools/test-chat-profile.mjs checks the copies the build makes and runs the same examples (EXAMPLES) the iPhone's
// reader runs in a debug build. A row is changed here and nowhere else; then `node dev-tools/chat-profile-sql.mjs` and the
// migration is applied again.
//
// No dependencies, no DOM, no chrome.*: the extension may load it too.
(function (root) {
  'use strict';

  // ── The kinds of chats ──────────────────────────────────────────────────────────────────────────────────────────────
  //
  // field   — the field under the chat; null — none (a service chat is read, not written in):
  //           presets  — the row of presets (the teacher's actions; the server refuses them elsewhere),
  //           plus     — the items of «+»: material (the page or video of the conversation), image, file, model («Text
  //                      model»; in a chat of an agent — the agent's own model),
  //           mic      — the dictation, voice — the button of a talk by voice, newChat — the button «new chat» on top.
  // send    — where the arrow sends: model | person | agent | none; hold — what a held arrow offers: person (send now,
  //           schedule) | null.
  // stop    — whose Stop the round button is while it works: turn (the answer of the model) | agent | null.
  // price   — step: the price of a step under its answer and the number over the chat; none.
  // menu    — the items of the menu of a message beyond Copy and Select (always there): reply, edit (a message that went
  //           to a person, by its channel), react (by its channel), sendNow (one's own word to Lex goes to the person).
  // ticks   — what went to the person carries one or two ticks.
  // talk    — the talk with the model lives inside the chat of a person: the clean view and the line «Discussion with
  //           Lex · N» (the side of a message says which is which, MESSAGE_KINDS of lex-chat-money.js).
  // card    — what a press on the head opens: person (the card of the person) | agent (the passport) | null.
  // fold    — the server folds the talk up to the last message that went to the person (lex_*_hidden_discussion).
  const KINDS = {
    main: {
      field: { presets: true, plus: ['material', 'image', 'file', 'model'], mic: true, voice: true, newChat: true },
      send: 'model', hold: null, stop: 'turn', price: 'step', menu: [], ticks: false, talk: false, card: null, fold: false,
    },
    video: {
      field: { presets: true, plus: ['material', 'image', 'file', 'model'], mic: true, voice: true, newChat: true },
      send: 'model', hold: null, stop: 'turn', price: 'step', menu: [], ticks: false, talk: false, card: null, fold: false,
    },
    news: {
      field: { presets: true, plus: ['material', 'image', 'file', 'model'], mic: true, voice: true, newChat: false },
      send: 'model', hold: null, stop: 'turn', price: 'step', menu: [], ticks: false, talk: false, card: null, fold: false,
    },
    // A person from every messenger (a chat of the folders). No talk by voice with Lex here yet (18.11.2026: text only).
    person: {
      field: { presets: false, plus: ['image', 'file', 'model'], mic: true, voice: false, newChat: false },
      send: 'model', hold: 'person', stop: 'turn', price: 'step', menu: ['reply', 'edit', 'react', 'sendNow'],
      ticks: true, talk: true, card: 'person', fold: true,
    },
    // A group of a deal: the same, its messages carry their authors; a reaction and an edit — never (CHANNELS: personal).
    group: {
      field: { presets: false, plus: ['image', 'file', 'model'], mic: true, voice: false, newChat: false },
      send: 'model', hold: 'person', stop: 'turn', price: 'step', menu: ['reply', 'sendNow'],
      ticks: true, talk: true, card: null, fold: true,
    },
    // An order of Profi.ru: the client, the boxes of the bot, the talk by voice with the order's instruction. Edit and a
    // reaction work on what came and went by a messenger (its channel), never on the site of Profi.ru.
    order: {
      field: { presets: false, plus: ['image', 'file', 'model'], mic: true, voice: true, newChat: false },
      send: 'model', hold: 'person', stop: 'turn', price: 'step', menu: ['reply', 'edit', 'react', 'sendNow'],
      ticks: true, talk: true, card: 'person', fold: true,
    },
    // A task chat of an agent: it takes only words (no picture, no file, no presets, no live voice); «+» — its model.
    agent: {
      field: { presets: false, plus: ['model'], mic: true, voice: false, newChat: false },
      send: 'agent', hold: null, stop: 'agent', price: 'step', menu: [], ticks: false, talk: false, card: 'agent', fold: false,
    },
    // A chat that is read only: the service chat of the bot of Profi.ru, New orders. Copy and Select, nothing else.
    service: {
      field: null,
      send: 'none', hold: null, stop: null, price: 'none', menu: [], ticks: false, talk: false, card: null, fold: false,
    },
    // A feed of the base (Разбор, Обращения): entries of the base, the field goes to the model with the base.
    feed: {
      field: { presets: false, plus: ['image', 'file', 'model'], mic: true, voice: true, newChat: false },
      send: 'model', hold: null, stop: 'turn', price: 'step', menu: [], ticks: false, talk: false, card: null, fold: false,
    },
    // The questions of the base: as a feed, and a Reply on a question.
    questions: {
      field: { presets: false, plus: ['image', 'file', 'model'], mic: true, voice: true, newChat: false },
      send: 'model', hold: null, stop: 'turn', price: 'step', menu: ['reply'], ticks: false, talk: false, card: null, fold: false,
    },
    // A talk by voice: the voice is the field.
    voice: {
      field: { presets: false, plus: [], mic: false, voice: true, newChat: false },
      send: 'model', hold: null, stop: 'turn', price: 'step', menu: [], ticks: false, talk: false, card: null, fold: false,
    },
  };

  // ── The channels a person is reached by ─────────────────────────────────────────────────────────────────────────────
  //
  // prefix — the uid of a message of the channel begins so (`profi:<key of its line in the journal of the database>`);
  //          null — the channel has no messages of its own here (Profi.ru: the order chat's).
  // group  — a uid that holds these characters is of a group, not of a person.
  // edit   — «Edit» of a message that went to a person: windowS — how long after the send the messenger lets it be edited
  //          (null — no term), max — the most characters, uid — the pattern of a message the server lets edit (not a version
  //          of an edit); null — no Edit here.
  // react  — a reaction on a message of a personal chat: uid — the pattern of a message the server lets react on; null —
  //          none here.
  // A channel gets Edit or a reaction only when its executor is proven on the live messenger (the lesson of 2026-11-19);
  // the database of Gennady says the rest again at its door and has the last word (brain.edit_channels, its table).
  const CHANNELS = {
    whatsapp: {
      prefix: 'profi:wa:', group: '@g.us:',
      edit: { windowS: 15 * 60, max: 4096, uid: '^profi:wa:.+:[A-Za-z0-9]+$' },
      react: { uid: '^profi:wa:[0-9]+@(s\\.whatsapp\\.net|lid):[A-Za-z0-9]+$' },
    },
    telegram: {
      prefix: 'profi:telegram:', group: 'profi:telegram:-',
      edit: { windowS: 48 * 60 * 60, max: 4096, uid: '^profi:telegram:[0-9]+:[0-9]+$' },
      react: { uid: '^profi:telegram:[0-9]+:[0-9]+$' },
    },
    // Max: no reaction yet — its executor has none on the server.
    max: {
      prefix: 'profi:max:', group: 'profi:max:-',
      edit: { windowS: 7 * 24 * 60 * 60, max: 4096, uid: '^profi:max:[0-9]+:[0-9]+$' },
      react: null,
    },
    // Profi.ru: the site lets nothing be edited or reacted on from outside.
    profi: { prefix: null, group: null, edit: null, react: null },
  };

  // ── The fallback: the kind by the key of the chat ──────────────────────────────────────────────────────────────────
  // Read only when the chat came without `profile` (an older server, a copy kept before it). A chat of the folders is a
  // person until its item says group or agent (`kind` of folder_open). Any other key is the main chat.
  const KEYS = [
    { kind: 'order', key: '^__lex_profi__[0-9]{1,18}$' },
    { kind: 'person', key: '^__lex_folder__[0-9]{1,18}$' },
    { kind: 'feed', key: '^__lex_em_(intake|request)__$' },
    { kind: 'questions', key: '^__lex_em_question(_-?[0-9]+)?__$' },
  ];

  // The examples every reader runs: this file (dev-tools/test-chat-profile.mjs) and the iPhone (ChatProfile.selfCheck in a
  // debug build). [what, argument, expected].
  const EXAMPLES = [
    ['kindOfKey', '__lex_profi__12', 'order'],
    ['kindOfKey', '__lex_profi__12x', 'main'],
    ['kindOfKey', '__lex_folder__7', 'person'],
    ['kindOfKey', '__lex_em_intake__', 'feed'],
    ['kindOfKey', '__lex_em_request__', 'feed'],
    ['kindOfKey', '__lex_em_question__', 'questions'],
    ['kindOfKey', '__lex_em_question_-5__', 'questions'],
    ['kindOfKey', 'dQw4w9WgXcQ', 'main'],
    ['channelOfUid', 'profi:telegram:77:11', 'telegram'],
    ['channelOfUid', 'profi:wa:5:4', 'whatsapp'],
    ['channelOfUid', 'profi:max:1:2', 'max'],
    ['channelOfUid', 'profi:12345:9', ''],
    ['personalUid', 'profi:telegram:77:11', true],
    ['personalUid', 'profi:telegram:-1001:5', false],
    ['personalUid', 'profi:wa:123@g.us:AB12', false],
    ['personalUid', 'profi:max:-9:1', false],
    ['editableUid', 'profi:telegram:77:11', true],
    ['editableUid', 'profi:telegram:-1001:5', false],
    ['editableUid', 'profi:12345:9', false],
    ['reactableUid', 'profi:telegram:77:11', true],
    ['reactableUid', 'profi:max:1:2', false],
    ['reactableUid', 'profi:wa:79001234567@s.whatsapp.net:3EB0', true],
    ['doorOfKind', 'order', 'profi'],
    ['doorOfKind', 'person', 'folder'],
    ['doorOfKind', 'group', 'folder'],
    ['doorOfKind', 'main', 'brain'],
    ['doorOfKind', 'agent', 'brain'],
    ['doorOfKind', 'service', 'brain'],
  ];

  const TABLE = { kinds: KINDS, channels: CHANNELS, keys: KEYS, examples: EXAMPLES };

  const kindRe = KEYS.map((k) => ({ kind: k.kind, re: new RegExp(k.key) }));

  // The kind a key says when nothing else does: 'main' for every key no row names.
  function kindOfKey(key) {
    if (typeof key !== 'string' || !key) return 'main';
    const hit = kindRe.find((k) => k.re.test(key));
    return hit ? hit.kind : 'main';
  }

  // The kind of a chat: what the server said with it (item.profile.kind, then the folder's kind), else the key's.
  function kindOf(key, item) {
    const p = item && item.profile;
    if (p && typeof p.kind === 'string' && KINDS[p.kind]) return p.kind;
    const k = item && typeof item.kind === 'string' ? item.kind : null;
    if (k && KINDS[k] && kindOfKey(key) === 'person') return k;   // folder_open: person, group, agent
    return kindOfKey(key);
  }

  // The row of a kind with its name and the channels: a chat no server item stands behind (the main chat, a feed, the
  // field over a screen of an agent). An unknown kind is the main chat.
  function profileOfKind(kind) {
    const k = KINDS[kind] ? kind : 'main';
    return Object.assign({}, KINDS[k], { kind: k, channels: CHANNELS });
  }

  // The profile of a chat: the server's when it sent one (its channels too), else the row of its kind here.
  function profileOf(key, item) {
    const kind = kindOf(key, item);
    const server = item && item.profile && typeof item.profile === 'object' ? item.profile : null;
    const row = server && server.kind === kind && server.send ? server : KINDS[kind];
    const channels = server && server.channels && typeof server.channels === 'object' ? server.channels : CHANNELS;
    return Object.assign({}, row, { kind, channels });
  }

  // The channel of a message by its uid: its name, '' — no channel of a person (Profi.ru, a word to Lex).
  function channelOfUid(uid, channels) {
    const list = channels || CHANNELS;
    const u = String(uid || '');
    for (const name of Object.keys(list)) {
      const c = list[name];
      if (c && typeof c.prefix === 'string' && c.prefix && u.startsWith(c.prefix)) return name;
    }
    return '';
  }
  const channelRow = (uid, channels) => {
    const name = channelOfUid(uid, channels);
    return name ? (channels || CHANNELS)[name] : null;
  };
  // A message of a chat of one person, not of a group.
  function personalUid(uid, channels) {
    const c = channelRow(uid, channels);
    return !!c && !(c.group && String(uid).indexOf(c.group) >= 0);
  }
  // What the channel of this message lets Edit: { windowS, max, uid } or null — no Edit (no channel, a group, none there).
  function editOf(uid, channels) {
    const c = channelRow(uid, channels);
    return c && c.edit && personalUid(uid, channels) ? c.edit : null;
  }
  const editableUid = (uid, channels) => !!editOf(uid, channels);
  // May a reaction go on this message by its channel (a personal chat of a channel that has one)?
  function reactableUid(uid, channels) {
    const c = channelRow(uid, channels);
    return !!(c && c.react && personalUid(uid, channels));
  }
  // The server's word on the shape of the uid (message-edit, message-react): the pattern of the channel matches.
  function serverEditable(uid) {
    const e = editOf(uid);
    return !!(e && new RegExp(e.uid).test(String(uid)));
  }
  function serverReactable(uid) {
    const c = channelRow(uid);
    return !!(c && c.react && personalUid(uid) && new RegExp(c.react.uid).test(String(uid)));
  }

  // Does a chat of this profile offer this item of the menu of a message (reply, edit, react, sendNow)?
  const offers = (profile, item) => !!(profile && Array.isArray(profile.menu) && profile.menu.indexOf(item) >= 0);
  // Does its field have this part (presets, mic, voice, newChat) or this item of «+» (material, image, file, model)?
  function fieldHas(profile, part) {
    const f = profile && profile.field;
    if (!f) return false;
    if (Array.isArray(f.plus) && ['material', 'image', 'file', 'model'].indexOf(part) >= 0) return f.plus.indexOf(part) >= 0;
    return f[part] === true;
  }

  // Where a message to a person from a chat of this profile goes — the door of its windows and of its held arrow
  // (lex-draft-box.js `door`, the iPhone's `ChatProfile.door` and `WindowDoor`): 'profi' — an order chat of Profi.ru (the database
  // functions of its boxes), 'folder' — a person or a group of the folders (the edge function folder-send), 'brain' — any
  // other chat (a window of the base under an answer, brain-action). A chat whose arrow sends to nobody without the model
  // (hold null) has only the windows of the base.
  function doorOf(profile) {
    if (!profile || profile.hold !== 'person') return 'brain';
    return profile.kind === 'order' ? 'profi' : 'folder';
  }
  // The door of the row of a kind (the examples run it, here and on the iPhone: ChatProfile.door).
  const doorOfKind = (kind) => doorOf(profileOfKind(kind));

  root.LexChatProfile = {
    KINDS, CHANNELS, KEYS, EXAMPLES, TABLE,
    kindOfKey, kindOf, profileOf, profileOfKind, channelOfUid, personalUid, editOf, editableUid, reactableUid,
    serverEditable, serverReactable, offers, fieldHas, doorOf, doorOfKind,
  };
})(typeof window !== 'undefined' ? window : globalThis);
