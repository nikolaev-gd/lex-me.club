// webchat/wc-bus.js — the message bus between the interface and the backend.
//
// There is no service worker here, so `call` is a lookup and an await. The
// interface still goes through a bus rather than calling the backend directly,
// for one reason: the same call has to work later from inside a native shell,
// where the backend may not be in this document at all. Keeping the seam means
// the shell replaces one file instead of every caller.
//
// ── AN UNKNOWN TYPE THROWS ───────────────────────────────────────────────────
// The extension's worker answers `undefined` for a message nobody handles, and
// the web shim copied that. It is the wrong default and it has already cost
// this project a bug: dictation reads the empty answer as "not signed in" and
// tells a signed-in person to log in. A missing handler is a programming error,
// not a state of the world, so it is raised where it happens instead of being
// laundered into a plausible-looking negative answer.
//
// `broadcast` is the other direction — the backend pushing into the interface
// (stream deltas, balance hints). Every subscriber receives every message and
// sorts out its own; that is how the thread view and the sidebar can watch the
// same STREAM_* traffic without knowing about each other.
(function (global) {
  'use strict';

  const handlers = new Map();
  const subs = new Set();

  const WcBus = {
    on(type, handler) {
      if (typeof type !== 'string' || !type) throw new TypeError('WcBus.on: type must be a non-empty string');
      if (typeof handler !== 'function') throw new TypeError('WcBus.on: handler must be a function');
      if (handlers.has(type)) {
        // Two handlers for one type means one of them is dead and nobody knows
        // which. Refuse rather than let the later registration win silently.
        throw new Error('WcBus.on: a handler for "' + type + '" is already registered.');
      }
      handlers.set(type, handler);
      return () => { handlers.delete(type); };
    },

    has(type) { return handlers.has(type); },

    // The list is for diagnostics and for the scenario runner, which asserts
    // that every type the interface sends has somebody behind it.
    types() { return Array.from(handlers.keys()).sort(); },

    async call(type, payload) {
      const handler = handlers.get(type);
      if (!handler) {
        throw new Error('WcBus: no handler for "' + type + '". '
          + 'Registered: ' + WcBus.types().join(', '));
      }
      return handler(Object.assign({ type }, payload || {}));
    },

    subscribe(fn) {
      if (typeof fn !== 'function') return () => {};
      subs.add(fn);
      return () => { subs.delete(fn); };
    },

    broadcast(msg) {
      // Snapshot: a subscriber that unsubscribes itself mid-delivery (the
      // thread view does exactly that when a conversation is replaced) would
      // otherwise make the iterator skip the next one.
      Array.from(subs).forEach((fn) => {
        try { fn(msg); } catch (err) { console.warn('[wc-bus] subscriber threw:', err && err.message); }
      });
    },
  };

  global.WcBus = WcBus;
})(typeof self !== 'undefined' ? self : globalThis);
