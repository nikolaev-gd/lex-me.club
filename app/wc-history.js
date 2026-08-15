// webchat/wc-history.js — conversations: what counts as one, how they are read
// from the account, and how they are written back.
//
// ⚠️ THIS FILE IS THE SECOND IMPLEMENTATION OF A CONTRACT.
// The first is chat-history-server.js, which the extension's service worker
// loads. They must agree, because they read and write the same rows of
// public.video_chat_turns under the same account — a conversation started in
// one surface has to open in the other.
//
// It is a copy and not a shared module for one reason: chat-history-server.js
// reaches for chrome.storage in six places, and this page has no chrome. The
// alternatives were both worse — injecting a storage adapter means editing
// background.js (the extension is out of scope for this work), and a
// `typeof chrome` fallback leaves chrome in this page's dependency graph.
//
// WHAT KEEPS THE COPY HONEST is not discipline, it is a test: the scenario set
// creates a conversation in the extension and asserts it appears here, creates
// one here and asserts it appears there, and — the case that actually catches
// drift — asserts that an internal thread the extension hides does NOT appear
// here.
//
// ── One deliberate divergence: titles and hiding are on the server ──────────
// The extension computes a conversation's name locally from its first message
// and keeps its hidden set in chrome.storage. Both are per-device: a name does
// not survive to a second machine, and a conversation "deleted" in the
// extension is still listed elsewhere (docs/PLAN-WEB-VERSION.md §13). This
// surface needs a real rename, so it has real storage for one —
// public.conversation_meta, added by supabase/migrations/conversation_meta.sql.
// A stored title wins over the computed one; with no row, both surfaces fall
// back to the first message and agree.
(function (global) {
  'use strict';

  const TAG = '[wc-history]';
  const A = () => global.LexWebAuth;

  // ── Conversation identity ────────────────────────────────────────────────

  // A conversation started by the main chat. The number after the prefix is
  // public.sessions.id — the billing session — which is why the key cannot be
  // minted before the first message.
  const STANDALONE_PREFIX = '__lex_standalone__';

  // Every OTHER '__lex_*' key is internal plumbing: the word popup, the action
  // buttons, the pronunciation surface. They live in the same table and must
  // never be listed as conversations.
  const LEX_PREFIX = '__lex_';

  // A video conversation is a real-looking YouTube id, optionally with a
  // lesson suffix. Kept as a shape test and not as a catch-all: when this was
  // `return 'video'` for anything unrecognised, a page-address key became a
  // "video conversation" and the interface fabricated a youtube.com/watch URL
  // for it. There is no YouTube on this surface, so nothing here CREATES such a
  // key — but the extension does, under the same account, and this page lists
  // what it finds.
  const VIDEO_KEY_RE = /^[A-Za-z0-9_-]{11}(?:__\d+)?$/;

  // 'standalone' | 'video' | null (do not list)
  function classifyKey(id) {
    if (typeof id !== 'string' || !id) return null;
    if (id.indexOf(STANDALONE_PREFIX) === 0) return 'standalone';
    if (id.indexOf(LEX_PREFIX) === 0) return null;
    if (VIDEO_KEY_RE.test(id)) return 'video';
    return null;
  }

  const isListable = (id) => classifyKey(id) !== null;

  // The legacy key with no session number. It collects everything sent before
  // a session existed (offline, a failed insert, voice before the first typed
  // turn), so it is a bag, not a conversation, and it is not listed.
  const isLegacyStandalone = (id) => id === STANDALONE_PREFIX;

  const keyForSession = (sessionId) => STANDALONE_PREFIX + sessionId;

  function sessionIdOfKey(id) {
    if (classifyKey(id) !== 'standalone') return null;
    const tail = id.slice(STANDALONE_PREFIX.length);
    return /^\d+$/.test(tail) ? Number(tail) : null;
  }

  // A turn the interface planted to give the model context, not something the
  // person said. It must never become a conversation's name.
  const SEED_MARKERS = ['[lex-context]', '[lex-page]', '[lex-transcript]', '[lex-seed]'];
  function isSeedContent(text) {
    const s = String(text || '').trimStart();
    return SEED_MARKERS.some((m) => s.indexOf(m) === 0);
  }

  // ── REST ─────────────────────────────────────────────────────────────────

  function accountId() {
    const s = A().session();
    return (s && s.user && s.user.id) || null;
  }

  async function rest(path, init) {
    const token = await A().validToken();
    if (!token) throw new Error('нет действующего входа');
    const resp = await fetch(A().supabaseUrl() + path, Object.assign({}, init, {
      headers: Object.assign({
        apikey: A().anonKey(),
        Authorization: 'Bearer ' + token,
      }, (init && init.headers) || {}),
    }));
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error('HTTP ' + resp.status + ' ' + path.split('?')[0] + ' ' + body.slice(0, 160));
    }
    if (resp.status === 204) return null;
    const text = await resp.text();
    return text ? JSON.parse(text) : null;
  }

  const get = (path) => rest(path);

  function post(path, body, prefer) {
    return rest(path, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, prefer ? { Prefer: prefer } : {}),
      body: JSON.stringify(body),
    });
  }

  // ── Sessions ─────────────────────────────────────────────────────────────
  // Not optional bookkeeping: llm-proxy refuses a paid call whose meta carries
  // no session id ('no_session'), so a conversation without a row here cannot
  // talk to the teacher at all. Same insert the extension makes, with
  // session_kind 'standalone' — this page IS the standalone chat.
  async function createSession() {
    const account = accountId();
    if (!account) throw new Error('createSession: не выполнен вход');
    const rows = await post('/rest/v1/sessions', [{
      account_id: account,
      // NOT the account: `user_id` is the DEVICE, a text column holding a uuid,
      // minted once per browser and NOT NULL. The extension keeps the same
      // notion under storage key 'user_id' (user-id.js). Leaving it out is a
      // 23502 from Postgres, which is how this was found.
      user_id: await deviceIdOnce(),
      session_kind: 'standalone',
      // The column is named extension_version and now carries a web build
      // stamp too. Renaming it would break every already-installed extension
      // writing to the same table.
      extension_version: global.WC_VERSION || 'webchat-dev',
    }], 'return=representation');
    const id = Array.isArray(rows) ? (rows[0] && rows[0].id) : null;
    if (id == null) throw new Error('createSession: строка сессии не вернулась');
    return id;
  }

  // ── conversation_meta: the name and the hidden mark ──────────────────────

  async function readMeta() {
    const account = accountId();
    if (!account) return {};
    const rows = await get('/rest/v1/conversation_meta?select=video_id,title,hidden_at'
      + '&account_id=eq.' + encodeURIComponent(account));
    const out = {};
    (rows || []).forEach((r) => { out[r.video_id] = r; });
    return out;
  }

  function upsertMeta(videoId, patch) {
    const account = accountId();
    if (!account) throw new Error('upsertMeta: не выполнен вход');
    // merge-duplicates on the primary key, so renaming an already-hidden
    // conversation does not silently unhide it and vice versa.
    return post('/rest/v1/conversation_meta?on_conflict=account_id,video_id',
      [Object.assign({ account_id: account, video_id: videoId, updated_at: new Date().toISOString() }, patch)],
      'resolution=merge-duplicates,return=minimal');
  }

  const rename = (videoId, title) => upsertMeta(videoId, { title: title === '' ? null : title });
  const hide = (videoId) => upsertMeta(videoId, { hidden_at: new Date().toISOString() });
  const unhide = (videoId) => upsertMeta(videoId, { hidden_at: null });

  // ── The list ─────────────────────────────────────────────────────────────
  // Two passes, and they are deliberately NOT awaited together.
  //
  // Pass 1 (`list`) asks for no message text at all — only the columns needed
  // to group rows into conversations and sort them. It is one request and it is
  // what the sidebar paints from.
  //
  // Pass 2 (`fillPreviews`) fetches a first-human-turn for the conversations
  // that have no stored name, and it is a separate call so the interface can
  // paint before it runs. That ordering is the whole point: on an account with
  // 73 conversations the preview pass takes seconds, and folding it into
  // `list` left the sidebar empty for all of them — the data was there and the
  // reader could not see it.
  const PREVIEW_CACHE_KEY = 'wcPreviewCache';
  const PREVIEW_PAGE = 30;

  async function list() {
    const rows = await get('/rest/v1/video_chat_turns'
      + '?select=video_id,role,authored_at,created_at,deleted_at&order=created_at.asc');

    const byId = new Map();
    (rows || []).forEach((r) => {
      const id = r.video_id;
      if (!isListable(id) || isLegacyStandalone(id)) return;
      if (r.deleted_at) return;
      let e = byId.get(id);
      if (!e) { e = { id, kind: classifyKey(id), turnCount: 0, lastAt: 0 }; byId.set(id, e); }
      e.turnCount++;
      const t = Date.parse(r.authored_at || r.created_at || 0) || 0;
      if (t > e.lastAt) e.lastAt = t;
    });

    const meta = await readMeta();
    const cache = await WcStore.one(PREVIEW_CACHE_KEY, {});

    return Array.from(byId.values())
      .filter((e) => !(meta[e.id] && meta[e.id].hidden_at))
      .sort((a, b) => b.lastAt - a.lastAt)
      .map((e) => {
        const m = meta[e.id] || {};
        return {
          id: e.id,
          kind: e.kind,
          title: m.title || '',
          preview: cache[e.id] || '',
          updatedAt: e.lastAt,
          turnCount: e.turnCount,
        };
      });
  }

  // Fills in the names of unnamed conversations, top of the list first, and
  // reports back as each batch lands so the sidebar can repaint progressively.
  // Cached in the page's own store, so this happens once per conversation ever
  // rather than on every load.
  async function fillPreviews(items, onBatch) {
    const cache = await WcStore.one(PREVIEW_CACHE_KEY, {});
    const need = items.slice(0, PREVIEW_PAGE)
      .filter((e) => !e.title && !e.preview && cache[e.id] === undefined);
    if (!need.length) return items;

    // Six at a time: thirty parallel requests to PostgREST on a cold load is a
    // burst for no benefit, and one at a time would take too long to watch.
    for (let i = 0; i < need.length; i += 6) {
      const slice = need.slice(i, i + 6);
      await Promise.all(slice.map(async (e) => {
        try { cache[e.id] = await firstHumanTurn(e.id); } catch (_) { cache[e.id] = ''; }
        e.preview = cache[e.id];
      }));
      if (onBatch) { try { onBatch(items); } catch (_) { /* a bad painter ≠ no data */ } }
    }
    await WcStore.set({ [PREVIEW_CACHE_KEY]: cache });
    return items;
  }

  // The earliest user turn that is not a context seed. Asked with limit=4 and
  // filtered here rather than limit=1: the first row is often the seed the
  // interface planted, and a conversation named "[lex-context] …" is a bug the
  // reader sees.
  async function firstHumanTurn(videoId) {
    const rows = await get('/rest/v1/video_chat_turns?select=content,authored_at'
      + '&video_id=eq.' + encodeURIComponent(videoId)
      + '&role=eq.user&deleted_at=is.null&order=authored_at.asc&limit=4');
    const hit = (rows || []).find((r) => r.content && !isSeedContent(r.content));
    return hit ? String(hit.content).replace(/\s+/g, ' ').trim().slice(0, 120) : '';
  }

  // ── One conversation ─────────────────────────────────────────────────────
  // Ordered by authored_at then turn_uid — NOT by seq. The client stopped
  // writing seq (its NOT NULL was dropped in a migration), so ordering by it
  // would put every recent turn in an arbitrary place.
  async function turns(videoId) {
    const rows = await get('/rest/v1/video_chat_turns'
      + '?select=role,content,turn_uid,authored_at,created_at,deleted_at'
      + '&video_id=eq.' + encodeURIComponent(videoId)
      + '&order=authored_at.asc,turn_uid.asc');
    return (rows || [])
      .filter((r) => !r.deleted_at)
      .filter((r) => !(r.role === 'user' && isSeedContent(r.content)))
      .map((r) => ({ role: r.role, text: r.content || '', uid: r.turn_uid || null }));
  }

  // ── Writing turns back ───────────────────────────────────────────────────
  // Same row shape and same conflict target as the extension, which is what
  // makes a turn written here visible there. `seq` is deliberately absent: the
  // new client does not write it and the column's NOT NULL was dropped for
  // exactly this.
  const BATCH = 100;

  async function push(videoId, rows) {
    const account = accountId();
    if (!account || !rows.length) return { ok: false };
    const deviceId = await deviceIdOnce();
    const payload = rows.map((t) => ({
      account_id: account,
      video_id: videoId,
      turn_uid: t.uid,
      authored_at: t.authoredAt || new Date().toISOString(),
      device_id: deviceId,
      role: t.role,
      content: t.text,
    }));
    for (let i = 0; i < payload.length; i += BATCH) {
      await post('/rest/v1/video_chat_turns?on_conflict=account_id,video_id,turn_uid',
        payload.slice(i, i + BATCH), 'resolution=merge-duplicates,return=minimal');
    }
    return { ok: true, pushed: payload.length };
  }

  // A stable id for this browser, minted once. The extension keeps the same
  // notion under 'user_id'; the column exists so a turn can be traced to where
  // it was typed.
  let deviceIdCache = null;
  async function deviceIdOnce() {
    if (deviceIdCache) return deviceIdCache;
    const stored = await WcStore.one('wcDeviceId', null);
    if (stored) { deviceIdCache = stored; return stored; }
    const fresh = (global.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'wc-' + Date.now() + '-' + Math.floor(Math.random() * 1e9);
    await WcStore.set({ wcDeviceId: fresh });
    deviceIdCache = fresh;
    return fresh;
  }

  function newUid() {
    return (global.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'u' + Date.now() + Math.floor(Math.random() * 1e6);
  }

  // Dropping a preview when a conversation is renamed or gains its first turn
  // keeps the cache from outliving the thing it describes.
  async function forgetPreview(videoId) {
    const cache = await WcStore.one(PREVIEW_CACHE_KEY, {});
    if (cache[videoId] === undefined) return;
    delete cache[videoId];
    await WcStore.set({ [PREVIEW_CACHE_KEY]: cache });
  }

  global.WcHistory = {
    STANDALONE_PREFIX,
    VIDEO_KEY_RE,
    classifyKey,
    isListable,
    isLegacyStandalone,
    isSeedContent,
    keyForSession,
    sessionIdOfKey,
    createSession,
    list,
    fillPreviews,
    turns,
    push,
    rename,
    hide,
    unhide,
    readMeta,
    forgetPreview,
    newUid,
    TAG,
  };
})(typeof self !== 'undefined' ? self : globalThis);
