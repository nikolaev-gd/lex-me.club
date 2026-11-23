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

const BUILD = "1795469280";
const FILES = ["./","lex-busy.js?v=1795469280","wc-log.js?v=1795469280","wc-store.js?v=1795469280","wc-bus.js?v=1795469280","wc-haptics.js?v=1795469280","lex-links.js?v=1795469280","lex-tags.js?v=1795469280","wc-markdown.js?v=1795469280","lex-open-markers.js?v=1795469280","wc-ui.js?v=1795469280","model-registry.js?v=1795469280","lex-draft-box.js?v=1795469280","lex-answer-row.js?v=1795469280","lex-account-events.js?v=1795469280","lex-back.js?v=1795469280","lex-section.js?v=1795469280","lex-reads.js?v=1795469280","lex-message.js?v=1795469280","lex-file-attach.js?v=1795469280","lex-news.js?v=1795469280","lex-send-later.js?v=1795469280","lex-chat-menu.js?v=1795469280","lex-person.js?v=1795469280","lex-profi.js?v=1795469280","lex-folders.js?v=1795469280","lex-people.js?v=1795469280","lex-list-order.js?v=1795469280","wc-agents.js?v=1795469280","wc-calendar.js?v=1795469280","lex-checklist.js?v=1795469280","wc-shopping.js?v=1795469280","lex-chat-money.js?v=1795469280","lex-step-popup.js?v=1795469280","model-picker-dropdown.js?v=1795469280","lex-dictation-catalog.js?v=1795469280","lex-dictation-limit.js?v=1795469280","lex-dictation-wav.js?v=1795469280","lex-dictation-live.js?v=1795469280","lex-dictation-grow.js?v=1795469280","lex-teacher-core.js?v=1795469280","lex-composer-input.js?v=1795469280","lex-composer-box.js?v=1795469280","lex-dictation-bar.js?v=1795469280","lex-drafts.js?v=1795469280","lex-long-press.js?v=1795469280","lex-brand-mark.js?v=1795469280","lex-settings-fields.js?v=1795469280","lex-billing-gate.js?v=1795469280","lex-error-text.js?v=1795469280","lex-voice-events.js?v=1795469280","lex-pulse.js?v=1795469280","lex-mic-watch.js?v=1795469280","lex-word-pick.js?v=1795469280","lex-edge-call.js?v=1795469280","lex-settings-cells.js?v=1795469280","lex-action-presets.js?v=1795469280","lex-turn-id.js?v=1795469280","lex-turn-follow.js?v=1795469280","lex-apart.js?v=1795469280","lex-web-config.js?v=1795469280","lex-web-auth.js?v=1795469280","wc-history.js?v=1795469280","lex-dictation-relay.js?v=1795469280","lex-direct-mode.js?v=1795469280","lex-direct-providers.js?v=1795469280","wc-backend.js?v=1795469280","wc-attach.js?v=1795469280","wc-wipe.js?v=1795469280","wc-topup.js?v=1795469280","microphone.js?v=1795469280","history-injector.js?v=1795469280","thread-writer.js?v=1795469280","feed-check.js?v=1795469280","telemetry.js?v=1795469280","call-server.js?v=1795469280","voice-tools.js?v=1795469280","gemini-live.js?v=1795469280","wc-voice-config.js?v=1795469280","wc-voice.js?v=1795469280","wc-voice-screen.js?v=1795469280","wc-sidebar.js?v=1795469280","wc-word-pick.js?v=1795469280","wc-thread.js?v=1795469280","wc-composer.js?v=1795469280","wc-quick.js?v=1795469280","wc-header.js?v=1795469280","wc-settings.js?v=1795469280","wc-app.js?v=1795469280","lex-palette.css?v=1795469280","lex-busy.css?v=1795469280","lex-settings-fields.css?v=1795469280","lex-answer-row.css?v=1795469280","lex-links.css?v=1795469280","lex-section.css?v=1795469280","lex-message.css?v=1795469280","lex-checklist.css?v=1795469280","lex-news.css?v=1795469280","lex-profi.css?v=1795469280","lex-person.css?v=1795469280","lex-composer-box.css?v=1795469280","lex-dictation-bar.css?v=1795469280","lex-send-later.css?v=1795469280","model-picker-dropdown.css?v=1795469280","wc-app.css?v=1795469280","wc-calendar.css?v=1795469280"];

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
