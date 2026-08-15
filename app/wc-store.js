// webchat/wc-store.js — the page's key-value store.
//
// IndexedDB, not localStorage. localStorage gives ~5MB per origin and a
// synchronous API; the local copy of every conversation outgrows that, and a
// synchronous write in the middle of a streaming answer is a visible stutter.
//
// The API is promise-only and takes a string or an array of strings. There is
// deliberately no "object of defaults" form and no "null takes everything"
// form: a store that half-supports a shape hands back {} and the caller reads
// that as "nothing was ever set".
//
// Change notification has two audiences and they are not the same one.
// Subscribers in THIS tab must hear their own writes — that is how the sidebar
// repaints when the composer appends a turn. Other tabs hear through
// BroadcastChannel, which never echoes to its own sender, so local delivery is
// explicit rather than a side effect of the channel.
(function (global) {
  'use strict';

  const DB_NAME = 'lex_webchat';
  const DB_VERSION = 1;
  const STORE = 'kv';
  const CHANNEL = 'lex-webchat-kv';

  let dbPromise = null;
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(mode, fn) {
    return openDb().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const out = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(out && out.value !== undefined ? out.value : out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }

  function normalizeKeys(keys) {
    if (typeof keys === 'string') return [keys];
    if (Array.isArray(keys)) return keys.slice();
    throw new TypeError(
      'WcStore: keys must be a string or an array of strings, got '
      + Object.prototype.toString.call(keys)
      + '. The defaults-object and take-everything forms do not exist here.'
    );
  }

  // ── Notification ─────────────────────────────────────────────────────────
  const subs = new Set();
  let channel = null;
  try { channel = new BroadcastChannel(CHANNEL); } catch (_) { channel = null; }
  if (channel) {
    channel.onmessage = (e) => {
      const d = e && e.data;
      if (d && d.changes) deliver(d.changes, false);
    };
  }

  function deliver(changes, alsoRemote) {
    // Snapshot first: a subscriber that unsubscribes itself while being called
    // would otherwise make the iterator skip whoever came after it.
    Array.from(subs).forEach((fn) => {
      try { fn(changes); } catch (err) { console.warn('[wc-store] subscriber threw:', err && err.message); }
    });
    if (alsoRemote && channel) {
      try { channel.postMessage({ changes }); } catch (_) { /* channel closed */ }
    }
  }

  // Reported as {key: {newValue}} — the shape the readers expect. Old values
  // would need a read before every write and nothing here asks for one, so the
  // field is absent rather than invented.
  function changesFor(items) {
    const out = {};
    Object.keys(items).forEach((k) => { out[k] = { newValue: items[k] }; });
    return out;
  }

  const WcStore = {
    get(keys) {
      const list = normalizeKeys(keys);
      return openDb().then((db) => new Promise((resolve, reject) => {
        const out = {};
        const t = db.transaction(STORE, 'readonly');
        const st = t.objectStore(STORE);
        list.forEach((k) => {
          const r = st.get(k);
          r.onsuccess = () => { if (r.result !== undefined) out[k] = r.result; };
        });
        t.oncomplete = () => resolve(out);
        t.onerror = () => reject(t.error);
      }));
    },

    // Convenience for the overwhelmingly common one-key read. Returns the value
    // itself, not a wrapper — `await WcStore.one('theme')`.
    one(key, fallback) {
      return WcStore.get(key).then((o) => (o[key] === undefined ? fallback : o[key]));
    },

    set(items) {
      return tx('readwrite', (st) => {
        Object.keys(items).forEach((k) => st.put(items[k], k));
      }).then(() => { deliver(changesFor(items), true); });
    },

    remove(keys) {
      const list = normalizeKeys(keys);
      return tx('readwrite', (st) => { list.forEach((k) => st.delete(k)); })
        .then(() => {
          const out = {};
          list.forEach((k) => { out[k] = { newValue: undefined }; });
          deliver(out, true);
        });
    },

    subscribe(fn) {
      if (typeof fn !== 'function') return () => {};
      subs.add(fn);
      return () => { subs.delete(fn); };
    },
  };

  global.WcStore = WcStore;
})(typeof self !== 'undefined' ? self : globalThis);
