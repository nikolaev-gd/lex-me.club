// lex-direct-mode.js — direct mode on the device: the device calls the model
// provider itself, with the provider's own key, and tells the Lex server about
// the call afterwards (docs/spec/60-server.md, «Прямой режим»; the client side
// is docs/spec/30-voice.md, «Прямой режим на расширении и странице»).
//
// One module for the extension (its service worker, importScripts) and the
// page lex-me.club/app (a <script>; the Mac app is that page). Like
// lex-dictation-relay.js it never touches a browser-extension API: the surface
// hands it a host with what is its own — where the state is kept, how a door of
// the Lex server is called. dev-tools/check-webchat-clean.sh holds the page to
// that, comments stripped.
//
// What lives here, once for both surfaces:
//   • the answer of the key door (`direct-config`): fetched ahead of time, kept
//     with its term and its account, used past the term until a new one comes;
//     a `direct:false` or 403 wipes keys and recipes (a 403 is not asked again
//     until the next sign-in), a 401, 503 or a network failure wipes nothing;
//   • recipes (`direct-recipe`): one per kind of call and its exact request
//     body, fetched ahead of time. A miss on the press is the server path for
//     that press plus a fetch for the next one (the voice alone waits a little);
//   • placeholder filling (LEX_PROVIDER_KEY and the rest) and the provider
//     request a recipe describes;
//   • the queue of reports to the server — voice-cmd bodies (start, pairs,
//     end) and direct-report entries — written to the store the moment they
//     are made, sent in the background with a growing pause, also after a
//     restart; in order within one call, calls apart; it wakes only when
//     something in it can go. Nothing a person waits for goes through it.
//
// host:
//   store: { get(key) → Promise<value|undefined>, set(key, value) → Promise, remove(key) → Promise }
//   keyStore        (optional) the same shape, for the key-door answer alone (it holds the keys):
//                   the extension keeps it out of chrome.storage.local, which content scripts read
//   call(door, body, opts?) → Promise<{ status, json }>   a door of llm-proxy (direct-config, …); throws on a
//                                                   network failure, a timeout or no pass yet; opts.timeoutMs —
//                                                   a longer wait than the host's own (voice-ask)
//   voiceCmd(body)  → Promise<{ status, json }>    the voice-cmd door; throws like call()
//   signedIn()      → Promise<boolean>             (optional) nothing is asked while signed out — a
//                                                   stored session, not a valid pass (a pass being renewed
//                                                   is a network failure, retried)
//   account()       → Promise<string|null>         (optional) the account of the stored session: a held
//                                                   answer is its only; the host also calls seeAccount()
//                                                   with it, and only a real change reloads
//   warm()          → Promise<[{kind, body}]>      (optional) the calls a press on this device will
//                                                   make now (the dictation and video-audio settings):
//                                                   their recipes are fetched right after every key-door
//                                                   answer that says `direct`, and on warm()
//   lock(fn)        → Promise                      (optional) one queue writer across tabs (navigator.locks)
//   log(line)                                       (optional)
//   now()                                           (optional, tests)
(function (global) {
  'use strict';

  if (global.LexDirectMode) return;

  const CONFIG_KEY = 'lexDirectConfig';
  const RECIPES_KEY = 'lexDirectRecipes';
  const QUEUE_KEY = 'lexDirectQueue';
  // The voice starts the server accepted (callId → when): a report about a
  // call waits for its start (see the queue below).
  const STARTED_KEY = 'lexDirectStarted';
  // The voice bodies the windows announced ahead of a press (createVoiceCalls).
  const VOICE_WARM_KEY = 'lexDirectVoiceWarm';
  const STORE_KEYS = Object.freeze([CONFIG_KEY, RECIPES_KEY, QUEUE_KEY, STARTED_KEY, VOICE_WARM_KEY]);

  // The term of a key-door answer when the server names none.
  const DEFAULT_TTL_SEC = 600;
  // A failed ask (503, network) is not repeated sooner than this.
  const RETRY_ASK_MS = 30000;
  const MAX_RECIPES = 40;
  const REPORTS_PER_BATCH = 20;
  // Growing pause between attempts of one queued report: 1 s, 2 s, 4 s … 5 min.
  const BACKOFF_BASE_MS = 1000;
  const BACKOFF_MAX_MS = 5 * 60 * 1000;
  // A report older than this is dropped: the server takes pairs for a day after
  // the end of a conversation, and a week-old report is noise.
  const QUEUE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
  const QUEUE_MAX = 500;
  // An item taken for sending is not taken again for this long — longer than
  // one send takes at most: the hosts give the pass 10 s and the request 15 s,
  // and the calls and the batch of reports go in parallel. A sender that died
  // mid-send leaves its lease to run out.
  const LEASE_MS = 45000;
  // 4xx answers that are not a refusal on substance: the pass being renewed,
  // a timeout, too many requests — repeated later.
  const RETRY_4XX = new Set([401, 408, 429]);
  // A pair of a voice call the server keeps answering «the turn was not
  // written» (502 with `written`: its billing went, the rows did not) this many
  // times in a row, over at least this long, is skipped: the rest of its call
  // goes on. Any other 5xx (no price, billing failed, a gateway in front of a
  // server that is down) is repeated without a count, like a network failure —
  // a pair skipped there would be neither written nor billed.
  const PAIR_SKIP_FAILS = 6;
  const PAIR_SKIP_MS = 10 * 60 * 1000;
  // A transcription report about a call whose start this device never saw
  // accepted (and which is not in the queue either) waits this long, then goes
  // anyway. Other reports (a failure trace) never wait: the server takes them
  // without a call.
  const REPORT_WAITS_START_MS = 60 * 60 * 1000;
  const STARTED_KEEP_MS = 2 * 24 * 3600 * 1000;

  // ── Small pure helpers ────────────────────────────────────────────────────

  function stableStringify(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  }

  // FNV-1a, two lanes → 16 hex digits. A cache key, not a secret.
  function hash(str) {
    let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x5bd1e995;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ c, 0x0100019d) >>> 0;
    }
    return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
  }

  function recipeKey(kind, body) { return kind + ':' + hash(stableStringify(body || {})); }

  function uuid() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') return global.crypto.randomUUID();
    const b = new Uint8Array(16);
    if (global.crypto && global.crypto.getRandomValues) global.crypto.getRandomValues(b);
    else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  const newCallId = () => 'dv-' + uuid();
  const isDirectCallId = (id) => typeof id === 'string' && /^dv-/.test(id);

  // Placeholders in a recipe → the device's own strings. One pass per string
  // with one alternation, so a value put in (a key, a text) is never scanned
  // again: a person's text that happens to say «LEX_TEXT» stays as said.
  // A string that IS a placeholder is swapped whole — the base64 of a recording
  // is never copied through a regex.
  function fill(value, slots) {
    const names = Object.keys(slots || {}).filter((k) => slots[k] != null).sort((a, b) => b.length - a.length);
    if (!names.length) return clone(value);
    const re = new RegExp(names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
    const walk = (v) => {
      if (typeof v === 'string') {
        if (Object.prototype.hasOwnProperty.call(slots, v) && slots[v] != null) return String(slots[v]);
        return v.indexOf('LEX_') < 0 ? v : v.replace(re, (m) => String(slots[m]));
      }
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') {
        const out = {};
        for (const k of Object.keys(v)) out[k] = walk(v[k]);
        return out;
      }
      return v;
    };
    return walk(value);
  }
  function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

  // A provider key must not ride along in an error text (a socket that threw
  // names its address, and Google's address carries the key).
  function scrub(text) {
    return String(text == null ? '' : text)
      .replace(/([?&](?:key|api_key|access_token|token)=)[^&\s"'<>]+/gi, '$1…')
      .replace(/(openai-insecure-api-key\.)[^\s,"']+/gi, '$1…')
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/g, '$1…')
      .replace(/(sk-[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{20,})/g, '…');
  }

  // A recipe that still holds a placeholder the device could not fill must not
  // reach the provider (a literal «LEX_PROVIDER_KEY» in a header is a 401 at
  // best and a leak of the recipe shape at worst).
  function unfilled(v) {
    return /LEX_(PROVIDER_KEY|AZURE_ENDPOINT)/.test(typeof v === 'string' ? v : JSON.stringify(v || ''));
  }

  // The provider request a file-shaped recipe (dictation, subtitle-asr, speech)
  // describes. input: { blob, base64, mime, text, fileName }.
  function buildRequest(recipe, slots, input) {
    const req = recipe && recipe.request;
    if (!req || !req.url) throw new Error('recipe has no request');
    const inp = input || {};
    const content = Object.assign({}, slots, {
      LEX_AUDIO_BASE64: inp.base64 != null ? inp.base64 : null,
      LEX_AUDIO_MIME: inp.mime || null,
      LEX_TEXT: inp.text != null ? inp.text : null,
    });
    const url = fill(req.url, slots);
    const headers = fill(req.headers || {}, content);
    if (unfilled(url) || unfilled(headers)) throw new Error('recipe placeholder without a value');
    const init = { method: req.method || 'POST', headers };
    if (req.json) {
      init.body = JSON.stringify(fill(req.json, content));
    } else if (Array.isArray(req.form)) {
      const fd = new FormData();
      for (const pair of req.form) {
        if (Array.isArray(pair) && pair.length >= 2) fd.append(String(pair[0]), String(fill(pair[1], content)));
      }
      if (req.filePart && inp.blob) {
        const type = req.fileType || inp.mime || inp.blob.type || 'application/octet-stream';
        const name = req.fileName || inp.fileName || 'recording.webm';
        const file = typeof File === 'function' ? new File([inp.blob], name, { type }) : inp.blob;
        fd.append(req.filePart, file, name);
      }
      init.body = fd;
      // The boundary is the browser's to write.
      for (const k of Object.keys(headers)) if (/^content-type$/i.test(k)) delete headers[k];
    } else if (req.rawBody) {
      init.body = inp.blob;
    }
    return { url, init };
  }

  // ── The module with state ─────────────────────────────────────────────────

  function create(host) {
    const h = host || {};
    if (!h.store || typeof h.call !== 'function') throw new Error('LexDirectMode.create: store and call() are required');
    // The answer of the key door (it holds the provider keys) may live apart
    // from the recipes and the queue: in the extension the windows and the
    // content scripts read chrome.storage.local, so the keys go to the
    // worker's own IndexedDB (host.keyStore) and never to that store.
    const kstore = h.keyStore || h.store;
    const now = typeof h.now === 'function' ? h.now : () => Date.now();
    const log = (line) => { try { if (typeof h.log === 'function') h.log('[lex-direct] ' + line); } catch (_) {} };
    // One writer of the queue at a time — across the tabs of the page too
    // (host.lock: navigator.locks). Held only for a read-change-write of the
    // store, never across a request to the server.
    const withLock = (() => {
      let chain = Promise.resolve();
      return (fn) => {
        const run = () => (typeof h.lock === 'function' ? h.lock(fn) : fn());
        const p = chain.then(run, run);
        chain = p.catch(() => {});
        return p;
      };
    })();
    const account = async () => {
      if (typeof h.account !== 'function') return null;
      try { return (await h.account()) || null; } catch (_) { return null; }
    };

    let cfg = null;          // { direct, keys, speech, modelRoute, issuedAt, ttlSec, fetchedAt, account } | { direct:false, fetchedAt, ttlSec, why, account }
    let recipes = {};        // key → { route:'direct'|'server', recipe, version, reason, at }
    let loaded = null;
    let asking = null;
    let lastFailAt = 0;
    // The generation of what is held: a sign-out or another account bumps it,
    // and the tail of a request begun before that writes nothing back (the
    // next one signed in would otherwise send the last one's queue with its
    // own pass, or hold the last one's keys).
    let gen = 0;
    const fetching = new Map();   // gen|recipe key → promise
    // The account the host last named (seeAccount): undefined — not named yet.
    let seen;

    function load() {
      if (!loaded) {
        const g = gen;
        loaded = (async () => {
          try {
            const [c, r, who] = await Promise.all([kstore.get(CONFIG_KEY), h.store.get(RECIPES_KEY), account()]);
            if (g !== gen) return;
            // A held answer of another account (or of none) is not this one's.
            if (c && typeof c === 'object' && (!who || !c.account || c.account === who)) cfg = c;
            if (r && typeof r === 'object') recipes = r;
          } catch (e) { log('load failed: ' + (e && e.message)); }
        })();
      }
      return loaded;
    }

    const termMs = (c) => (Number(c && c.ttlSec) > 0 ? Number(c.ttlSec) : DEFAULT_TTL_SEC) * 1000;
    const fresh = (c) => !!c && Number.isFinite(c.fetchedAt) && now() - c.fetchedAt < termMs(c);
    // «Not the developer» holds until the next sign-in: no ask on every wake
    // of the worker or every return to the tab.
    const refusedForGood = (c) => !!c && c.why === 'http_403';

    async function saveConfig(g) { if (g !== gen) return; try { await kstore.set(CONFIG_KEY, cfg); } catch (_) {} }
    async function saveRecipes(g) { if (g !== gen) return; try { await h.store.set(RECIPES_KEY, recipes); } catch (_) {} }

    async function forgetKeys(why, g) {
      if (g !== gen) return;
      cfg = { direct: false, fetchedAt: now(), ttlSec: DEFAULT_TTL_SEC, why, account: await account() };
      recipes = {};
      await Promise.all([saveConfig(g), saveRecipes(g)]);
    }

    // Ask the key door. Never on a press: on sign-in, start, the window coming
    // back, a term running out (ensure below).
    // A promise «already running» is of its generation: after a sign-out or
    // another account a new call starts afresh instead of waiting for the old
    // tail, which writes nothing and would leave the new call with nothing.
    async function refresh() {
      await load();
      if (asking && asking.g === gen) return asking.p;
      const g = gen;
      const p = (async () => {
        try {
          if (typeof h.signedIn === 'function' && !(await h.signedIn())) return cfg;
          let r;
          try { r = await h.call('direct-config', {}); }
          catch (e) { lastFailAt = now(); log('config: network ' + (e && e.message)); return cfg; }
          if (g !== gen) return cfg;
          const j = (r && r.json) || {};
          if (r && r.status === 200 && j.ok) {
            const route = typeof j.modelRoute === 'string' ? j.modelRoute
              : (j.modelRoute && typeof j.modelRoute.route === 'string' ? j.modelRoute.route : null);
            if (j.direct === true && j.keys && typeof j.keys === 'object') {
              const before = cfg && cfg.direct ? stableStringify(cfg.keys) : null;
              const who = await account();
              if (g !== gen) return cfg;
              cfg = {
                direct: true, keys: j.keys, speech: j.speech || null, modelRoute: route || 'direct',
                issuedAt: j.issuedAt || null, ttlSec: Number(j.ttlSec) > 0 ? Number(j.ttlSec) : DEFAULT_TTL_SEC,
                fetchedAt: now(), account: who,
              };
              // New keys do not spoil recipes (a recipe never holds a key).
              if (before && before !== stableStringify(cfg.keys)) log('config: keys changed');
              await saveConfig(g);
              log('config: direct (' + (route || 'direct') + ')');
              // The recipes of this device's presses, ahead of the press —
              // the press itself never waits for a door (only the voice does,
              // briefly, see recipe()).
              setTimeout(() => { warm().catch(() => {}); }, 0);
            } else {
              await forgetKeys('route_' + (route || 'server'), g);
              log('config: server route');
            }
            return cfg;
          }
          // 403 — not the developer: no keys here, and no ask again until the
          // next sign-in. 404 — the door is not there (a server that does not
          // know direct mode): the server path for a term.
          if (r && (r.status === 403 || r.status === 404)) {
            await forgetKeys('http_' + r.status, g);
            log('config: ' + r.status + ' → server path');
            return cfg;
          }
          // 401 (the pass is being renewed), 503 (developer check did not
          // answer), 5xx — keep what we hold, ask again later.
          lastFailAt = now();
          log('config: HTTP ' + (r && r.status) + ' — kept');
          return cfg;
        } finally { if (asking && asking.p === p) asking = null; }
      })();
      asking = { g, p };
      return p;
    }

    // Held answer, and a background ask when its term is out. Never waits for
    // the network.
    async function ensure() {
      await load();
      if (!fresh(cfg) && !refusedForGood(cfg) && !(asking && asking.g === gen) && now() - lastFailAt > RETRY_ASK_MS) refresh().catch(() => {});
      return cfg;
    }

    function isDirect() { return !!(cfg && cfg.direct === true && cfg.keys); }

    function slotsFor(recipe) {
      if (!isDirect() || !recipe) return null;
      const k = cfg.keys || {};
      const p = recipe.provider;
      if (p === 'microsoft') {
        const az = k.azureSpeech;
        if (!az || !az.key || !az.endpoint) return null;
        return { LEX_PROVIDER_KEY: az.key, LEX_AZURE_ENDPOINT: String(az.endpoint).replace(/\/+$/, '') };
      }
      const key = k[p];
      if (typeof key !== 'string' || !key) return null;
      const out = { LEX_PROVIDER_KEY: key };
      if (k.azureSpeech && k.azureSpeech.endpoint) out.LEX_AZURE_ENDPOINT = k.azureSpeech.endpoint;
      return out;
    }

    // keyBody — what the recipe depends on, when the request carries more
    // (the voice: the chat's video id only says which kind of chat it is).
    async function fetchRecipe(kind, body, keyBody) {
      const key = recipeKey(kind, keyBody || body);
      const g = gen;
      const fkey = g + '|' + key;
      if (fetching.has(fkey)) return fetching.get(fkey);
      const p = (async () => {
        let r;
        try { r = await h.call('direct-recipe', Object.assign({ kind }, body)); }
        catch (e) { log('recipe ' + kind + ': network ' + (e && e.message)); return null; }
        if (g !== gen) return null;
        const j = (r && r.json) || {};
        if (r && r.status === 200 && j.ok && j.route === 'direct' && j.recipe) {
          recipes[key] = { route: 'direct', recipe: j.recipe, version: j.version || null, at: now() };
        } else if (r && r.status === 200 && j.ok && j.route === 'server') {
          // The server path for this call — section chat, gpt-live, database
          // tools, or the flag set to `server`.
          recipes[key] = { route: 'server', reason: j.reason || null, at: now() };
          if (j.reason === 'model_route_server') { await forgetKeys('route_server', g); return null; }
        } else if (r && r.status === 403) {
          await forgetKeys('http_403', g);
          return null;
        } else if (r && (r.status === 400 || r.status === 424 || r.status === 404)) {
          // No recipe for this call (unknown model, no price): the server path,
          // asked again after a term.
          recipes[key] = { route: 'server', reason: 'http_' + r.status + (j.stage ? ':' + j.stage : ''), at: now() };
          log('recipe ' + kind + ': ' + r.status + ' ' + (j.error || ''));
        } else {
          log('recipe ' + kind + ': HTTP ' + (r && r.status) + ' — not kept');
          return null;
        }
        const keys = Object.keys(recipes);
        if (keys.length > MAX_RECIPES) {
          keys.sort((a, b) => (recipes[a].at || 0) - (recipes[b].at || 0));
          for (const k of keys.slice(0, keys.length - MAX_RECIPES)) delete recipes[k];
        }
        await saveRecipes(g);
        return recipes[key] || null;
      })().finally(() => fetching.delete(fkey));
      fetching.set(fkey, p);
      return p;
    }

    // Fetch ahead (chat with the voice button open, model or knobs changed).
    async function prefetch(kind, body, keyBody) {
      await ensure();
      if (!isDirect()) return null;
      const key = recipeKey(kind, keyBody || body);
      const held = recipes[key];
      if (held && cfg && now() - (held.at || 0) < termMs(cfg)) return held;
      return fetchRecipe(kind, body, keyBody);
    }

    // Fetch ahead the recipes of what a press on this device will send now
    // (host.warm(): the dictation model and knobs, the video-audio recognizer,
    // the voice bodies the windows announced). Called after every key-door
    // answer that says `direct` and by the surface on start, sign-in and a
    // change of those settings. A held recipe within its term is not asked
    // again. A call made while one runs runs once more after it: the settings
    // may have changed in between.
    let warming = null;
    let warmAgain = false;
    function warm() {
      if (typeof h.warm !== 'function') return Promise.resolve([]);
      if (warming && warming.g === gen) { warmAgain = true; return warming.p; }
      const g = gen;
      const p = (async () => {
        const out = [];
        do {
          warmAgain = false;
          await ensure();
          if (g !== gen || !isDirect()) return out;
          let list = [];
          try { list = (await h.warm()) || []; } catch (e) { log('warm: ' + (e && e.message)); list = []; }
          for (const it of list) {
            if (!it || typeof it.kind !== 'string' || !it.body) continue;
            const held = await prefetch(it.kind, it.body, it.keyBody);
            const what = it.kind + ' ' + (it.body.model || '?');
            out.push(what + ' → ' + (held ? held.route + (held.reason ? ' ' + held.reason : '') : 'none'));
          }
        } while (warmAgain);
        if (out.length) log('warm: ' + out.join('; '));
        return out;
      })().finally(() => { if (warming && warming.p === p) warming = null; });
      warming = { g, p };
      return p;
    }

    // What the press uses: a held recipe for exactly this request, or null —
    // and then the server path for this press, and a fetch for the next one.
    // A held recipe past its term is still used (and fetched anew behind it).
    // opts.waitMs — on a miss, wait this long for the recipe door instead of
    // giving the press to the server path (the live voice: one short ask is
    // still faster than the call set up through the server).
    async function recipe(kind, body, keyBody, opts) {
      await ensure();
      if (!isDirect()) return null;
      const key = recipeKey(kind, keyBody || body);
      let held = recipes[key];
      let asked = null;
      if (!held || (cfg && now() - (held.at || 0) >= termMs(cfg))) {
        asked = fetchRecipe(kind, body, keyBody);
        asked.catch(() => {});
      }
      const waitMs = opts && Number(opts.waitMs) > 0 ? Number(opts.waitMs) : 0;
      if (!held && asked && waitMs) {
        held = await Promise.race([asked.catch(() => null), new Promise((r) => setTimeout(() => r(null), waitMs))]);
        if (!isDirect()) return null;
      }
      if (!held || held.route !== 'direct') return null;
      const slots = slotsFor(held.recipe);
      if (!slots) return null;
      return { key, recipe: held.recipe, version: held.version, slots };
    }

    // ── Queue ───────────────────────────────────────────────────────────────
    //
    // Every item is written to the store the moment it is made (enqueue does
    // not wait for anything being sent). A send takes a snapshot of what is
    // due under the lock, marks it leased, lets the lock go, sends, and merges
    // the outcome back under the lock by qid — what was added meanwhile stays.
    // A lease that its sender did not settle (the tab closed, the worker was
    // stopped mid-send) runs out after LEASE_MS and the item goes again; the
    // server takes a repeat of the same id once.
    //
    // voice-cmd bodies go in order within one call (start → pairs → end);
    // calls do not wait for each other. A transcription report of a call
    // (callId set) waits for the start of that call to be accepted: the server
    // refuses a transcription of a call it does not know, for good. A start
    // refused on substance takes its call's pairs and end with it, and the
    // call's reports go at once (the server decides on them).
    //
    // The queue wakes only when something in it can go: the head of a call at
    // its pause or the end of its lease, a report at its pause, a report
    // waiting for a start that is nowhere at the end of that wait. What stands
    // behind the head of its call, or waits for a start still in the queue, is
    // woken by that head going (a flush that sent something runs once more).

    // { g, p } — the flush running now, and of which generation.
    let flushing = null;
    let flushAgain = false;
    let timer = null;

    async function readQueue() {
      try { const q = await h.store.get(QUEUE_KEY); return Array.isArray(q) ? q : []; } catch (_) { return []; }
    }
    async function writeQueue(q) { try { await h.store.set(QUEUE_KEY, q); } catch (_) {} }
    async function readStarted() {
      try { const m = await h.store.get(STARTED_KEY); return (m && typeof m === 'object') ? m : {}; } catch (_) { return {}; }
    }
    async function writeStarted(m) { try { await h.store.set(STARTED_KEY, m); } catch (_) {} }

    function enqueue(item) {
      const it = Object.assign({ qid: uuid(), at: now(), tries: 0, nextAt: 0 }, item);
      const g = gen;
      const p = withLock(async () => {
        if (g !== gen) return;
        const q = await readQueue();
        q.push(it);
        while (q.length > QUEUE_MAX) {
          const dropped = q.shift();
          log('queue full — dropped ' + (dropped && dropped.lane));
        }
        await writeQueue(q);
      });
      p.then(() => flush()).catch(() => {});
      return it.qid;
    }

    function voice(body) { return enqueue({ lane: 'voice', body }); }
    function report(rep) {
      const r = Object.assign({ id: uuid() }, rep);
      enqueue({ lane: 'report', rep: r });
      return r.id;
    }
    function failure(of, info) {
      const i = info || {};
      return report(Object.assign({}, i, { kind: 'failure', of, error: scrub(String(i.error || 'no answer')).slice(0, 500) }));
    }

    const backoff = (tries) => Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, Math.max(0, tries - 1)))
      + Math.floor(Math.random() * 250);
    const callOf = (it) => (it.lane === 'voice' ? (it.body && it.body.callId) : (it.rep && it.rep.callId)) || null;
    const leased = (it, t) => Number(it.lease) > t;
    // When an item is free to go by its own pause and lease.
    const freeAt = (it, t) => Math.max(it.nextAt || 0, leased(it, t) ? Number(it.lease) : 0);
    const due = (it, t) => freeAt(it, t) <= t;

    // The heads of the calls' voice lines, the calls whose start is still in
    // the queue, and for every report the moment it may go (null — it waits
    // for an event, not for time).
    function lay(q, started, t) {
      const heads = new Map();
      const startPending = new Set();
      for (const it of q) {
        if (it.lane !== 'voice') continue;
        const id = callOf(it) || '?';
        if (!heads.has(id)) heads.set(id, it);
        if (it.body && it.body.start) startPending.add(id);
      }
      const reportAt = (it) => {
        const own = freeAt(it, t);
        const id = callOf(it);
        if (it.noWait || !it.rep || it.rep.kind !== 'transcription' || !id || !isDirectCallId(id) || started[id]) return own;
        // Its start is still in the queue — after it. No start anywhere: an
        // hour, then the server decides.
        if (startPending.has(id)) return null;
        return Math.max(own, (it.at || 0) + REPORT_WAITS_START_MS);
      };
      return { heads, reportAt };
    }

    // What goes now: the head of each call's voice line, and up to a batch of
    // reports free to go.
    function pick(q, started, t) {
      const { heads, reportAt } = lay(q, started, t);
      const voices = [...heads.values()].filter((it) => due(it, t));
      const reports = q.filter((it) => {
        if (it.lane !== 'report') return false;
        const at = reportAt(it);
        return at != null && at <= t;
      }).slice(0, REPORTS_PER_BATCH);
      return { voices, reports };
    }

    // The next wake: the earliest moment pick() can take something.
    function wakeAt(q, started, t) {
      const { heads, reportAt } = lay(q, started, t);
      let next = Infinity;
      for (const it of heads.values()) next = Math.min(next, freeAt(it, t));
      for (const it of q) {
        if (it.lane !== 'report') continue;
        const at = reportAt(it);
        if (at != null) next = Math.min(next, at);
      }
      return next;
    }

    function schedule(q, started) {
      if (timer) { clearTimeout(timer); timer = null; }
      if (!q.length) return;
      const t = now();
      const next = wakeAt(q, started || {}, t);
      if (!Number.isFinite(next)) return;
      const wait = Math.max(50, next - t);
      timer = setTimeout(() => { timer = null; flush().catch(() => {}); }, wait);
    }

    // The server's own word that a pair was billed and its rows not written
    // (voice-cmd, the pair branch: 502 {error:'the turn was not written',
    // written:{user,teacher}, chargedUsd}) — the only refusal a pair may be
    // skipped after.
    const notWritten = (status, j) => status === 502 && !!j && j.error === 'the turn was not written'
      && !!j.written && typeof j.written === 'object';

    // One voice-cmd body → its outcome.
    async function sendOneVoice(it) {
      let r = null, net = null;
      try { r = await h.voiceCmd(it.body); } catch (e) { net = e; }
      const status = r ? r.status : 0;
      if (r && status >= 200 && status < 300) return { qid: it.qid, outcome: 'done', ack: it.body && it.body.start ? callOf(it) : null };
      if (!net && status >= 400 && status < 500 && !RETRY_4XX.has(status)) {
        // Refused on substance — a repeat will not cure it.
        log('voice-cmd ' + status + ' dropped: ' + JSON.stringify((r && r.json) || {}).slice(0, 200));
        return { qid: it.qid, outcome: 'drop', refusedStart: it.body && it.body.start ? callOf(it) : null };
      }
      log('voice-cmd ' + (net ? 'network ' + ((net && net.message) || '') : status) + ' — retry');
      return { qid: it.qid, outcome: 'retry', notWritten: !net && notWritten(status, r && r.json) };
    }

    // A batch of reports → outcomes by qid.
    async function sendReportBatch(items) {
      if (!items.length) return [];
      let r = null, net = null;
      try { r = await h.call('direct-report', { reports: items.map((it) => it.rep) }); } catch (e) { net = e; }
      const status = r ? r.status : 0;
      if (r && status === 200 && r.json && Array.isArray(r.json.results)) {
        const byId = new Map(r.json.results.map((x) => [x && x.id, x]));
        return items.map((it) => {
          const res = byId.get(it.rep.id);
          if (!res || res.outcome === 'retry') return { qid: it.qid, outcome: 'retry' };
          if (res.outcome === 'rejected') log('report ' + it.rep.kind + ' rejected: ' + (res.why || ''));
          return { qid: it.qid, outcome: 'done' };
        });
      }
      if (!net && status >= 400 && status < 500 && !RETRY_4XX.has(status)) {
        log('direct-report ' + status + ' — ' + items.length + ' dropped: ' + JSON.stringify((r && r.json) || {}).slice(0, 200));
        return items.map((it) => ({ qid: it.qid, outcome: 'drop' }));
      }
      log('direct-report ' + (net ? 'network ' + ((net && net.message) || '') : status) + ' — retry later');
      return items.map((it) => ({ qid: it.qid, outcome: 'retry' }));
    }

    // The outcomes into the queue as it is now.
    function merge(q, started, results, t) {
      const byQid = new Map(q.map((it) => [it.qid, it]));
      let progressed = false;
      const gone = new Set();
      const refused = new Set();
      for (const res of results) {
        const it = byQid.get(res.qid);
        if (!it) continue;
        if (res.ack) started[res.ack] = t;
        if (res.refusedStart) refused.add(res.refusedStart);
        if (res.outcome === 'done' || res.outcome === 'drop') { gone.add(it.qid); progressed = true; continue; }
        it.lease = 0;
        it.tries = (it.tries || 0) + 1;
        it.nextAt = t + backoff(it.tries);
        if (res.notWritten) {
          it.httpFails = (it.httpFails || 0) + 1;
          if (!it.firstFailAt) it.firstFailAt = t;
        }
        // A pair the server keeps writing off (billed, rows not written — the
        // conversation was reset mid-call) must not hold the rest of its call
        // for ever: after PAIR_SKIP_FAILS such answers over at least
        // PAIR_SKIP_MS it is skipped, and the next pairs and the end go on.
        if (it.lane === 'voice' && it.body && it.body.turn && it.httpFails >= PAIR_SKIP_FAILS && t - it.firstFailAt >= PAIR_SKIP_MS) {
          log('voice-cmd pair ' + ((it.body.turn && it.body.turn.id) || '?') + ' skipped after ' + it.httpFails + ' «not written»');
          gone.add(it.qid);
          progressed = true;
        }
      }
      // A start refused on substance: the call is not the server's, its pairs
      // and end would be refused one by one — gone now; its reports go at once.
      if (refused.size) {
        for (const it of q) {
          const id = callOf(it);
          if (!id || !refused.has(id) || gone.has(it.qid)) continue;
          if (it.lane === 'voice') gone.add(it.qid);
          else it.noWait = true;
        }
        log('voice-cmd start refused — dropped the rest of ' + [...refused].join(','));
        progressed = true;
      }
      return { q: q.filter((it) => !gone.has(it.qid)), progressed };
    }

    function flush() {
      if (flushing && flushing.g === gen) { flushAgain = true; return flushing.p; }
      const g = gen;
      flushAgain = false;
      const p = (async () => {
        let q = [];
        let started = {};
        do {
          flushAgain = false;
          if (typeof h.signedIn === 'function' && !(await h.signedIn())) return;
          if (g !== gen) return;
          // 1. What goes now — under the lock, briefly.
          const taken = await withLock(async () => {
            if (g !== gen) return null;
            const all = await readQueue();
            if (!all.length) return { voices: [], reports: [], left: [], started: {} };
            const t = now();
            const cut = t - QUEUE_MAX_AGE_MS;
            const kept = all.filter((it) => (it.at || 0) >= cut);
            const st = await readStarted();
            const pk = pick(kept, st, t);
            for (const it of pk.voices.concat(pk.reports)) it.lease = t + LEASE_MS;
            if (kept.length !== all.length || pk.voices.length || pk.reports.length) await writeQueue(kept);
            return { voices: pk.voices.map(clone), reports: pk.reports.map(clone), left: kept, started: st };
          });
          if (!taken) return;
          q = taken.left;
          started = taken.started;
          if (!taken.voices.length && !taken.reports.length) continue;
          // 2. Send — without the lock. The calls and the batch of reports in
          // parallel: one send stays within one request's limit (LEASE_MS).
          const sent = await Promise.all([
            Promise.all(taken.voices.map((it) => sendOneVoice(it))),
            sendReportBatch(taken.reports),
          ]);
          const results = [].concat(sent[0], sent[1]);
          // 3. Merge by qid — under the lock, into the queue as it is now.
          const merged = await withLock(async () => {
            if (g !== gen) return null;
            const t = now();
            const st = await readStarted();
            const startedBefore = JSON.stringify(st);
            const m = merge(await readQueue(), st, results, t);
            // Starts the server accepted — for two days, so a report of the
            // call can follow its start also after a restart.
            for (const id of Object.keys(st)) if (t - st[id] > STARTED_KEEP_MS) delete st[id];
            if (JSON.stringify(st) !== startedBefore) await writeStarted(st);
            await writeQueue(m.q);
            m.started = st;
            return m;
          });
          if (!merged) return;
          q = merged.q;
          started = merged.started;
          if (merged.progressed) flushAgain = true;
        } while (flushAgain && g === gen);
        if (g === gen) schedule(q, started);
      })().finally(() => { if (flushing && flushing.p === p) flushing = null; });
      flushing = { g, p };
      return p;
    }

    async function pending() { return (await readQueue()).length; }

    // Sign-out: keys, recipes, the queue — gone. The generation moves first:
    // a refresh or a flush still in flight writes nothing back.
    async function wipe() {
      gen += 1;
      seen = null;
      cfg = null;
      recipes = {};
      loaded = Promise.resolve();
      lastFailAt = 0;
      if (timer) { clearTimeout(timer); timer = null; }
      await withLock(async () => {
        try { await Promise.all(STORE_KEYS.map((k) => (k === CONFIG_KEY ? kstore : h.store).remove(k))); } catch (_) {}
      }).catch(() => {});
    }

    // Another account signed in (its own storage was wiped): forget what is
    // held in memory and read the store again.
    function reload() {
      gen += 1; cfg = null; recipes = {}; loaded = null; lastFailAt = 0;
      if (timer) { clearTimeout(timer); timer = null; }
    }

    // The host names the account of its stored session (not of a valid pass:
    // a pass being renewed after a network failure is the same account). A
    // real change — another account, or none — is a reload; the same one
    // again changes nothing. → true when it reloaded.
    function seeAccount(who) {
      const w = who || null;
      const changed = seen !== undefined && w !== seen;
      seen = w;
      if (changed) reload();
      return changed;
    }
    // The door voice-ask (a call of ask_lex from the direct voice): a request of its own, not the queue — a person
    // waits for it — with a long wait (the strong model answers in tens of seconds; the iPhone waits 75 s too).
    const ASK_TIMEOUT_MS = 75000;
    function askLex(body) { return h.call('voice-ask', body, { timeoutMs: ASK_TIMEOUT_MS }); }
    return Object.freeze({
      reload, seeAccount, refresh, ensure, isDirect, prefetch, warm, recipe, slotsFor,
      voice, report, failure, flush, pending, wipe, askLex,
      config: () => cfg,
      speech: () => (cfg && cfg.speech) || null,
    });
  }

  // ── Direct voice calls: one set of rules for both surfaces ────────────────
  //
  // The service worker of the extension and the page both answer the same
  // messages of the shared voice modules (voice/gemini-live.js,
  // voice/openai-realtime.js on the extension, webchat/wc-voice.js on the
  // page): PREP (recipe and call id at the press), STARTED (the call is up —
  // its start goes to the server), FAILED (one try did not stand — a trace),
  // a pair, the end. The voice-cmd bodies of one call go strictly in order:
  // the start first, then pairs, then the end (the queue is FIFO; a pair waits
  // for its start to be queued).
  //
  // o: { direct (create() result), promptMeta(refs) → meta fields,
  //      sessionFor(ctx, surface) → Promise<sessionId|null>,
  //      store? (the same store as create()'s: the voice bodies kept warm), log? }
  function chatClass(key) {
    const k = typeof key === 'string' ? key : '';
    // A video's chat — also its per-visit key «<video id>__<n>».
    if (/^[A-Za-z0-9_-]{11}(__[0-9]+)?$/.test(k)) return 'video';
    if (/^__lex_standalone__[0-9]+$/.test(k)) return 'standalone';
    return k;
  }
  // The functions a voice recipe declares → {names, nonBlocking} or null. The server names them in `recipe.tools`
  // (the main chat's ask_lex, 2026-11-22); a recipe without it — read from Google's setup or OpenAI's session.
  function toolsOf(rc) {
    if (!rc || typeof rc !== 'object') return null;
    const names = [];
    let nonBlocking = false;
    const add = (n) => { if (typeof n === 'string' && n && !names.includes(n)) names.push(n); };
    if (rc.tools && Array.isArray(rc.tools.names)) {
      rc.tools.names.forEach(add);
      nonBlocking = rc.tools.nonBlocking === true;
    } else {
      const setup = rc.connect && rc.connect.firstFrame && rc.connect.firstFrame.setup;
      for (const t of (setup && Array.isArray(setup.tools)) ? setup.tools : []) {
        for (const fd of (t && Array.isArray(t.functionDeclarations)) ? t.functionDeclarations : []) {
          add(fd && fd.name);
          if (fd && fd.behavior === 'NON_BLOCKING') nonBlocking = true;
        }
      }
      const sess = rc.session || (rc.connect && rc.connect.session) || null;
      for (const t of (sess && Array.isArray(sess.tools)) ? sess.tools : []) if (t && t.type === 'function') add(t.name);
    }
    return names.length ? { names, nonBlocking } : null;
  }
  const PREP_WAIT_MS = 2500;
  const FORGET_MS = 5 * 60 * 1000;
  function createVoiceCalls(o) {
    const d = o.direct;
    const calls = new Map();
    const log = (l) => { try { o.log && o.log('[lex-direct] ' + l); } catch (_) {} };
    function of(callId) { return calls.get(callId) || null; }
    function forgetLater(callId) {
      const c = calls.get(callId);
      if (!c) return;
      if (c.forgetTimer) clearTimeout(c.forgetTimer);
      c.forgetTimer = setTimeout(() => calls.delete(callId), FORGET_MS);
    }
    // The recipe body of a press with this message, and what the recipe
    // depends on (the kind of chat, not the video itself).
    function bodiesOf(m) {
      const refs = (m && m.promptRefs && m.promptRefs.base) ? m.promptRefs : null;
      if (!refs || typeof m.model !== 'string' || !m.model) return null;
      const meta0 = m.meta || {};
      const surface = meta0.surface || null;
      const meta = Object.assign({ videoId: meta0.videoId || null, surface },
        meta0.newsChat === true ? { newsChat: true } : {}, o.promptMeta(refs) || {});
      const body = {
        model: m.model,
        knobs: (m.knobs && typeof m.knobs === 'object') ? m.knobs : null,
        voiceName: typeof m.voiceName === 'string' ? m.voiceName : null,
        ptt: m.ptt === true,
        meta,
      };
      if (m.session && typeof m.session === 'object') body.session = m.session;
      const keyBody = Object.assign({}, body, { meta: Object.assign({}, meta, { videoId: chatClass(meta.videoId) }) });
      return { body, keyBody, meta, surface };
    }
    // The voice bodies to keep warm: the ones the windows announced (a chat
    // with the voice button open, a change of the voice model, knobs, voice
    // or kind of chat) and the ones pressed — newest first, a few. Their
    // recipes are fetched again after every key-door answer (warmList below,
    // through the host's warm()).
    const VOICE_WARM_MAX = 12;
    async function remember(b) {
      if (!o.store) return;
      try {
        const k = recipeKey('voice', b.keyBody);
        const list = ((await o.store.get(VOICE_WARM_KEY)) || []).filter((x) => x && x.k !== k);
        list.unshift({ k, body: b.body, keyBody: b.keyBody, at: Date.now() });
        await o.store.set(VOICE_WARM_KEY, list.slice(0, VOICE_WARM_MAX));
      } catch (_) {}
    }
    async function warmList() {
      if (!o.store) return [];
      try {
        const list = (await o.store.get(VOICE_WARM_KEY)) || [];
        return list.filter((x) => x && x.body).map((x) => ({ kind: 'voice', body: x.body, keyBody: x.keyBody }));
      } catch (_) { return []; }
    }
    // A window announces what its press will send: the recipe now, not then.
    async function warmVoice(m) {
      const b = bodiesOf(m);
      if (!b) return null;
      // Nothing is kept for an account without direct mode.
      await d.ensure();
      if (!d.isDirect()) return null;
      await remember(b);
      const held = await d.prefetch('voice', b.body, b.keyBody);
      return held ? { route: held.route, reason: held.reason || null } : null;
    }
    async function prep(m, ctx) {
      const at = Date.now();
      const b = bodiesOf(m);
      if (!b) return { direct: false, why: 'no_prompt_refs' };
      const { body, keyBody, meta, surface } = b;
      const r = await d.recipe('voice', body, keyBody, { waitMs: PREP_WAIT_MS });
      if (d.isDirect()) remember(b);
      if (!r) return { direct: false, why: d.isDirect() ? 'no_recipe' : 'server_route' };
      const rc = r.recipe;
      const callId = newCallId();
      const tools = toolsOf(rc);
      calls.set(callId, {
        recipe: rc, slots: r.slots, surface, provider: rc.provider, ctx: ctx || null, tools,
        start: { model: m.model, surface, chatKey: meta.videoId || null, transcriptionModel: rc.transcriptionModel || null, startedAt: at },
        startQueued: null,
      });
      const sessionCap = rc.session && Number(rc.session.max_output_tokens);
      return {
        direct: true, callId, provider: rc.provider, transport: rc.transport, apiModel: rc.apiModel,
        maxOutputTokens: Number.isFinite(sessionCap) && sessionCap > 0 ? sessionCap : (rc.maxOutputTokens || null),
        transcriptionModel: rc.transcriptionModel || null,
        tools,
        prepMs: Date.now() - at,
      };
    }
    function started(callId, ctx) {
      const c = of(callId);
      // Hung up before it stood (a stop in the middle of setting the call up):
      // no start, or the server would hold an open conversation nobody ends.
      if (!c || c.ended) return null;
      if (c.startQueued) return c.startQueued;
      c.startQueued = (async () => {
        let sessionId = null;
        try { sessionId = await o.sessionFor(ctx || c.ctx, c.surface); } catch (_) {}
        d.voice({ callId, start: Object.assign({}, c.start, sessionId ? { sessionId } : {}) });
      })();
      return c.startQueued;
    }
    function failed(m) {
      const c = of(m.callId);
      d.failure('voice', {
        provider: (c && c.provider) || m.provider || null,
        model: (c && c.start && c.start.model) || m.model || null,
        error: m.error || 'no answer',
        httpStatus: Number.isInteger(m.httpStatus) ? m.httpStatus : null,
        totalMs: Number.isFinite(m.totalMs) ? m.totalMs : null,
        surface: (c && c.surface) || null,
        chatKey: (c && c.start && c.start.chatKey) || null,
        callId: m.callId || null,
      });
      calls.delete(m.callId);
    }
    async function enqueue(callId, body) {
      const c = of(callId);
      if (c && c.startQueued) { try { await c.startQueued; } catch (_) {} }
      d.voice(Object.assign({ callId }, body));
    }
    // The end: only of a call that stood (its start is queued) — or one this
    // instance does not know (woke up mid-call: its start went before).
    function end(callId, reason) {
      const c = of(callId);
      if (c && c.ended) return;
      if (c) c.ended = true;
      if (!c || c.startQueued) enqueue(callId, Object.assign({ end: true }, reason ? { reason } : {}));
      forgetLater(callId);
    }
    // The answer to a VOICE_CMD body of a direct call: a pair goes to the
    // queue, the rest (ping, commands) has nobody to go to.
    function voiceCmd(m) {
      if (m.end === true) { end(m.callId, m.reason || null); return { ok: true, queued: true }; }
      if (m.turn) { enqueue(m.callId, { turn: m.turn }); return { ok: true, queued: true }; }
      return { ok: true, direct: true };
    }
    // A call of ask_lex (LEX_DIRECT_VOICE_ASK {callId, question, id}): the door voice-ask with the chat of this
    // call → {text, isError}. A refusal or a broken line is an error output — the voice says so and does not hang
    // (askLexDoor on the iPhone, word for word).
    async function ask(m, ctx) {
      const c = of(m && m.callId);
      const question = String((m && m.question) || '').trim();
      if (!c || !c.tools) return { text: 'Lex cannot be asked from this conversation.', isError: true };
      if (!question) return { text: 'The question is empty: ask again with the question in words.', isError: true };
      const body = { question, callId: m.callId, id: (typeof m.id === 'string' && m.id) ? m.id : uuid(), chatKey: c.start.chatKey || '' };
      try {
        const sid = await o.sessionFor(ctx || c.ctx, c.surface);
        if (Number.isSafeInteger(Number(sid)) && Number(sid) > 0) body.sessionId = Number(sid);
      } catch (_) {}
      const at = Date.now();
      let r;
      try { r = await d.askLex(body); } catch (e) {
        log('voice-ask: broke ' + ((e && e.message) || e));
        return { text: 'Lex did not answer: the line broke.', isError: true };
      }
      const j = (r && r.json) || {};
      const ms = Date.now() - at;
      if (r && r.status >= 200 && r.status < 300 && typeof j.text === 'string' && j.text) {
        log('voice-ask: ' + (j.route || '?') + ' ' + (j.model || '?') + ' in ' + ms + ' ms (server ' + (j.ms != null ? j.ms : '-') + ' ms, router ' + (j.routerMs != null ? j.routerMs : '-') + ' ms), ' + j.text.length + ' chars');
        return { text: j.text, isError: false };
      }
      log('voice-ask: refused HTTP ' + (r && r.status) + ' ' + (j.stage || '') + ' in ' + ms + ' ms');
      return { text: 'Lex did not answer (HTTP ' + (r && r.status) + ').', isError: true };
    }
    return { of, prep, started, failed, enqueue, end, voiceCmd, forgetLater, warmVoice, warmList, ask, log };
  }

  global.LexDirectMode = Object.freeze({
    create, createVoiceCalls, toolsOf, chatClass, fill, buildRequest, recipeKey, stableStringify, uuid, newCallId, isDirectCallId, scrub, STORE_KEYS,
  });
})(typeof self !== 'undefined' ? self : globalThis);
