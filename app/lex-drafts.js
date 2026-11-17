// lex-drafts.js — the draft of every chat: what is typed in the field of a chat and not sent.
//
// Gennady's task 17.11.2026 («Черновик на каждый чат и адресат в поле»): the field was one for
// every chat of the page and of the program for the Mac, so words typed for Dmitry stood in the
// field of Eduard's chat, one tap away from Eduard; and a restart lost them. Now a draft belongs to
// its chat, on every surface, as in Telegram:
//   - the words and the line of a Reply live on the server (supabase/migrations/chat_drafts.sql:
//     lex_draft_put, lex_drafts, the signal `drafts`), so the draft typed on the iPhone stands in the
//     same chat on the page and in the program for the Mac, and every list of chats shows it;
//   - a copy lives on the device too: the field is filled at once, without waiting for the server,
//     and what was typed without a network is kept and goes to the server later;
//   - a picture or a file of a draft stays on the device that has it (`attach`, a description the
//     window makes and reads back itself): it is not the server's until it is sent.
// The words go to the server a moment after the last key, and at once when the chat is left or the
// window hidden (flush). A draft changed on another device comes by the signal `drafts` (pull): a
// chat whose words here were not changed since the last word with the server takes the server's.
//
// One part for the web page, the program for the Mac and the extension (no chrome.* here: the window
// gives the store and the door to the server). The iPhone has the same in ChatDrafts.swift.
//
//   LexDrafts.init({ load, save, rpc, account })   load() → the stored copy, save(copy) — the device;
//                                                   rpc(name, args) — the server; account() — whose
//   LexDrafts.ready                                 → Promise: the device copy is read
//   LexDrafts.get(key)                              → { text, reply, attach } | null
//   LexDrafts.put(key, { text, reply, attach })     the field of that chat as it is now
//   LexDrafts.clear(key)                            sent: the draft is gone
//   LexDrafts.rename(from, to)                      a new chat got its key
//   LexDrafts.pull()                                read the server's drafts (start, signal `drafts`)
//   LexDrafts.flush()                               → Promise: everything typed is on the server
//   LexDrafts.line(key)                             → the words a list shows after «Draft:», or null
//   LexDrafts.onChange(fn(keys, from))              → off(); from: 'local' | 'server'
//   LexDrafts.wipe()                                another account or a sign-out
//   LexDrafts.NEW_CHAT                              the key of a chat that has none yet
(function (global) {
  'use strict';

  // The same key on every surface (ChatDrafts.newChat on the iPhone): the draft of a new chat follows
  // the person from device to device too.
  const NEW_CHAT = '__lex_new_chat__';
  // The words go to the server this long after the last key: every write is a row in the journal of
  // changes and a signal to every open Lex of the account.
  const PUSH_MS = 1200;
  // The device copy is written a moment after a change, not on every key.
  const SAVE_MS = 300;
  // How many chats the device copy keeps; the oldest go first. The server keeps its own 500.
  const LIMIT = 200;

  let cfg = null;
  // key → { text, reply, attach, at, dirty }: dirty — the number of the change the server has not
  // taken yet (0 — the server has these words).
  let items = new Map();
  let ready = Promise.resolve();
  let seq = 0;
  let pushTimer = null;
  let saveTimer = null;
  let pushing = Promise.resolve();
  const listeners = new Set();

  const account = () => { try { return (cfg && cfg.account && cfg.account()) || ''; } catch (_) { return ''; } };
  const str = (v) => (typeof v === 'string' ? v : '');
  const cleanReply = (r) => (r && typeof r === 'object' && !Array.isArray(r)
    && ((typeof r.quoteUid === 'string' && r.quoteUid) || (Array.isArray(r.uids) && r.uids.length)) ? r : null);
  const hasAttach = (a) => !!(a && typeof a === 'object'
    && ((Array.isArray(a.images) && a.images.length) || (Array.isArray(a.files) && a.files.length)));
  const sameJson = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);

  function emit(keys, from) {
    if (!keys.length) return;
    for (const fn of listeners) { try { fn(keys, from); } catch (e) { console.warn('[drafts] listener:', e && e.message); } }
  }

  function saveSoon() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, SAVE_MS);
  }
  function saveNow() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (!cfg || typeof cfg.save !== 'function') return Promise.resolve();
    // The newest LIMIT: a draft not on the server yet is never the one to go.
    const list = [...items].sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
    const keep = list.filter(([, it], i) => i < LIMIT || it.dirty);
    const copy = { account: account(), items: Object.fromEntries(keep) };
    try { return Promise.resolve(cfg.save(copy)).catch((e) => console.warn('[drafts] not kept:', e && e.message)); } catch (e) {
      console.warn('[drafts] not kept:', e && e.message);
      return Promise.resolve();
    }
  }

  function init(o) {
    cfg = o || null;
    items = new Map();
    ready = (async () => {
      let stored = null;
      try { stored = cfg && typeof cfg.load === 'function' ? await cfg.load() : null; } catch (_) { stored = null; }
      // Words of whoever was signed in before are not this person's.
      if (stored && typeof stored === 'object' && stored.account && stored.account === account() && stored.items) {
        for (const [k, v] of Object.entries(stored.items)) {
          if (!v || typeof v !== 'object') continue;
          const it = { text: str(v.text), reply: cleanReply(v.reply), attach: hasAttach(v.attach) ? v.attach : null,
            at: Number(v.at) || 0, dirty: v.dirty ? ++seq : 0 };
          if (it.text || it.reply || it.attach || it.dirty) items.set(k, it);
        }
      }
    })();
    // Back on the network: what was typed without it goes now.
    if (global.addEventListener && !init.wired) {
      init.wired = true;
      global.addEventListener('online', () => { pushNow(); });
    }
    return ready;
  }

  function get(key) {
    const it = key ? items.get(key) : null;
    if (!it || (!it.text && !it.reply && !it.attach)) return null;
    return { text: it.text, reply: it.reply, attach: it.attach };
  }

  // The field of the chat `key` as it is now. The words and the reply go to the server; the attach
  // stays here.
  function put(key, d) {
    if (!key) return;
    const prev = items.get(key) || null;
    const text = str(d && d.text);
    const reply = cleanReply(d && d.reply);
    const attach = d && Object.prototype.hasOwnProperty.call(d, 'attach')
      ? (hasAttach(d.attach) ? d.attach : null) : (prev ? prev.attach : null);
    const wordsSame = prev ? (prev.text === text && sameJson(prev.reply, reply)) : (!text && !reply);
    if (wordsSame && sameJson(prev ? prev.attach : null, attach)) return;
    const dirty = wordsSame ? (prev ? prev.dirty : 0) : ++seq;
    if (!text && !reply && !attach && !dirty) items.delete(key);
    else items.set(key, { text, reply, attach, at: Date.now(), dirty });
    saveSoon();
    if (!wordsSame) pushSoon();
    emit([key], 'local');
  }

  function clear(key) { put(key, { text: '', reply: null, attach: null }); }

  function rename(from, to) {
    if (!from || !to || from === to) return;
    const it = items.get(from);
    if (!it) return;
    items.delete(from);
    if (it.text || it.reply) {
      // The words were on the server under the old key: it is told they are gone there.
      items.set(from, { text: '', reply: null, attach: null, at: Date.now(), dirty: ++seq });
    }
    items.set(to, Object.assign({}, it, { at: Date.now(), dirty: (it.text || it.reply) ? ++seq : 0 }));
    saveSoon();
    pushSoon();
    emit([from, to], 'local');
  }

  function pushSoon() {
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(pushNow, PUSH_MS);
  }

  // Every draft the server has not taken, one after another, in the order of the changes.
  function pushNow() {
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
    pushing = pushing.then(async () => {
      if (!cfg || typeof cfg.rpc !== 'function') return;
      await ready;
      const todo = [...items].filter(([, it]) => it.dirty).sort((a, b) => a[1].dirty - b[1].dirty);
      for (const [key, it] of todo) {
        const mark = it.dirty;
        try {
          await cfg.rpc('lex_draft_put', { p_chat_key: key, p_text: it.text || '', p_reply: it.reply || null });
        } catch (e) {
          // No network, no server: the copy keeps it dirty, and it goes with the next change, the
          // next flush or when the network is back.
          console.warn('[drafts] not on the server yet:', e && e.message);
          return;
        }
        const now = items.get(key);
        if (now && now.dirty === mark) {
          now.dirty = 0;
          if (!now.text && !now.reply && !now.attach) items.delete(key);
        }
      }
      saveSoon();
    }).catch((e) => console.warn('[drafts] push:', e && e.message));
    return pushing;
  }

  async function flush() {
    await pushNow();
    await saveNow();
  }

  // The server's drafts. A draft changed here and not on the server yet stays as it is (it goes up
  // with the next push); every other one takes the server's words. A reading goes in the same line as
  // the pushes, never beside one: an answer the server gave before a push of this device landed would
  // otherwise bring back the words the push replaced (17.11.2026, found on the stand: a chat left right
  // after typing came back without its last words).
  function pull() {
    pushing = pushing.then(readServer).catch((e) => console.warn('[drafts] read:', e && e.message));
    return pushing;
  }
  async function readServer() {
    if (!cfg || typeof cfg.rpc !== 'function') return;
    await ready;
    let srv;
    try { srv = await cfg.rpc('lex_drafts', {}); } catch (e) { console.warn('[drafts] read:', e && e.message); return; }
    if (!srv || typeof srv !== 'object' || Array.isArray(srv)) return;
    const changed = [];
    for (const [key, it] of [...items]) {
      if (it.dirty) continue;
      const s = srv[key];
      if (!s) {
        if (it.text || it.reply) {
          if (it.attach) { it.text = ''; it.reply = null; } else items.delete(key);
          changed.push(key);
        }
        continue;
      }
      const text = str(s.text);
      const reply = cleanReply(s.reply);
      if (text !== it.text || !sameJson(reply, it.reply)) {
        it.text = text;
        it.reply = reply;
        it.at = Date.parse(s.at) || Date.now();
        changed.push(key);
      }
    }
    for (const [key, s] of Object.entries(srv)) {
      if (items.has(key) || !s || typeof s !== 'object') continue;
      const text = str(s.text);
      const reply = cleanReply(s.reply);
      if (!text && !reply) continue;
      items.set(key, { text, reply, attach: null, at: Date.parse(s.at) || Date.now(), dirty: 0 });
      changed.push(key);
    }
    // What was typed without a network goes now.
    if ([...items.values()].some((it) => it.dirty)) pushSoon();
    if (changed.length) { saveSoon(); emit(changed, 'server'); }
  }

  // The words of a list's line after «Draft:»: the first words of the text; a draft of only a picture
  // or a file — «Photo» / «File»; of only a Reply — its head.
  function line(key) {
    const it = key ? items.get(key) : null;
    if (!it) return null;
    const text = it.text.replace(/\s+/g, ' ').trim();
    if (text) return text.length > 140 ? text.slice(0, 140) + '…' : text;
    if (it.attach) return (Array.isArray(it.attach.images) && it.attach.images.length) ? 'Photo' : 'File';
    if (it.reply) return String(it.reply.head || 'Reply');
    return null;
  }

  function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function wipe() {
    const keys = [...items.keys()];
    items = new Map();
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
    saveNow();
    emit(keys, 'local');
  }

  global.LexDrafts = {
    NEW_CHAT,
    init,
    get ready() { return ready; },
    get, put, clear, rename, pull, flush, line, onChange, wipe,
    // For the checks of the module (dev-tools/test-lex-drafts.mjs).
    _dirty: (key) => !!(items.get(key) && items.get(key).dirty),
  };
})(typeof self !== 'undefined' ? self : globalThis);
