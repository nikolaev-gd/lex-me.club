// sw.js — the page of Lex kept on the device (a service worker): the page and its own files open
// from here, with no question to the network, from the second opening on. lex-reads.js keeps the
// screens' data on the device; this keeps the code. docs/spec/90-release.md.
//
// The build (dev-tools/build-webchat.mjs) writes BUILD and FILES below: the stamp of this version
// and every file index.html loads, under the very address it loads it by, the page itself first.
// Installed, the worker takes the whole version into a cache of its own; then the page and its
// files come from that cache. A new version is a new sw.js: the browser asks the server for it at
// every opening of the page and whenever the page shows again (the page calls update), past every
// cache. The new worker takes its whole version while the page works on, then takes over, and the
// page opens with it the next time. Two versions are kept, so an old page still running finds a
// file it asks for late. A version that failed to come whole is not installed: the old one stays.
//
// Without a build — the stand of a helper (webchat-serve.mjs) — FILES is empty and the worker
// stands aside: a stand always serves its files as they are on the disk.
'use strict';

const BUILD = "1795037212";
const FILES = ["./","wc-log.js?v=1795037212","wc-store.js?v=1795037212","wc-bus.js?v=1795037212","wc-haptics.js?v=1795037212","wc-markdown.js?v=1795037212","lex-open-markers.js?v=1795037212","wc-ui.js?v=1795037212","model-registry.js?v=1795037212","lex-answer-row.js?v=1795037212","lex-account-events.js?v=1795037212","lex-back.js?v=1795037212","lex-section.js?v=1795037212","lex-reads.js?v=1795037212","lex-message.js?v=1795037212","lex-file-attach.js?v=1795037212","lex-news.js?v=1795037212","lex-send-later.js?v=1795037212","lex-chat-menu.js?v=1795037212","lex-person.js?v=1795037212","lex-profi.js?v=1795037212","lex-folders.js?v=1795037212","lex-people.js?v=1795037212","lex-chat-money.js?v=1795037212","model-picker-dropdown.js?v=1795037212","lex-dictation-catalog.js?v=1795037212","lex-dictation-limit.js?v=1795037212","lex-dictation-wav.js?v=1795037212","lex-dictation-live.js?v=1795037212","lex-dictation-grow.js?v=1795037212","lex-teacher-core.js?v=1795037212","lex-composer-input.js?v=1795037212","lex-composer-box.js?v=1795037212","lex-drafts.js?v=1795037212","lex-long-press.js?v=1795037212","lex-brand-mark.js?v=1795037212","lex-settings-fields.js?v=1795037212","lex-billing-gate.js?v=1795037212","lex-error-text.js?v=1795037212","lex-voice-events.js?v=1795037212","lex-pulse.js?v=1795037212","lex-mic-watch.js?v=1795037212","lex-word-pick.js?v=1795037212","lex-edge-call.js?v=1795037212","lex-settings-cells.js?v=1795037212","lex-action-presets.js?v=1795037212","lex-turn-id.js?v=1795037212","lex-apart.js?v=1795037212","lex-web-config.js?v=1795037212","lex-web-auth.js?v=1795037212","wc-history.js?v=1795037212","lex-dictation-relay.js?v=1795037212","wc-backend.js?v=1795037212","wc-attach.js?v=1795037212","wc-wipe.js?v=1795037212","wc-topup.js?v=1795037212","microphone.js?v=1795037212","history-injector.js?v=1795037212","thread-writer.js?v=1795037212","feed-check.js?v=1795037212","telemetry.js?v=1795037212","call-server.js?v=1795037212","gemini-live.js?v=1795037212","wc-voice-config.js?v=1795037212","wc-voice.js?v=1795037212","wc-voice-screen.js?v=1795037212","wc-sidebar.js?v=1795037212","wc-word-pick.js?v=1795037212","wc-thread.js?v=1795037212","wc-composer.js?v=1795037212","wc-header.js?v=1795037212","wc-settings.js?v=1795037212","wc-app.js?v=1795037212","lex-palette.css?v=1795037212","lex-settings-fields.css?v=1795037212","lex-answer-row.css?v=1795037212","lex-links.css?v=1795037212","lex-section.css?v=1795037212","lex-message.css?v=1795037212","lex-news.css?v=1795037212","lex-profi.css?v=1795037212","lex-person.css?v=1795037212","lex-composer-box.css?v=1795037212","lex-send-later.css?v=1795037212","model-picker-dropdown.css?v=1795037212","wc-app.css?v=1795037212"];

const PREFIX = 'lex-app-';
const CACHE = PREFIX + BUILD;
const KEEP = 2;
// What is taken into the cache when asked for late: code and pictures, never data.
const CODE = /\.(?:js|css|wasm|svg|png|woff2?)$/;

self.addEventListener('install', (e) => {
  if (!FILES.length) { self.skipWaiting(); return; }
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // The caches come in the order they were made: this version and the one before it stay.
    const ours = (await caches.keys()).filter((n) => n.startsWith(PREFIX));
    const keep = FILES.length ? ours.slice(-KEEP) : [];
    if (FILES.length && !keep.includes(CACHE)) keep.push(CACHE);
    await Promise.all(ours.filter((n) => !keep.includes(n)).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  if (!FILES.length) return;
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  if (url.pathname === new URL('sw.js', scope).pathname) return;
  if (req.mode === 'navigate') {
    // The page itself, of this version, from the device.
    e.respondWith(caches.open(CACHE)
      .then((c) => c.match(FILES[0]))
      .then((hit) => hit || fetch(req)));
    return;
  }
  if (!CODE.test(url.pathname)) return;
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((resp) => {
    if (resp.ok && resp.type === 'basic') {
      const copy = resp.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
    }
    return resp;
  })));
});
