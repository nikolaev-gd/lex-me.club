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

const BUILD = "1795377587";
const FILES = ["./","wc-log.js?v=1795377587","wc-store.js?v=1795377587","wc-bus.js?v=1795377587","wc-haptics.js?v=1795377587","lex-links.js?v=1795377587","wc-markdown.js?v=1795377587","lex-open-markers.js?v=1795377587","wc-ui.js?v=1795377587","model-registry.js?v=1795377587","lex-draft-box.js?v=1795377587","lex-answer-row.js?v=1795377587","lex-account-events.js?v=1795377587","lex-back.js?v=1795377587","lex-section.js?v=1795377587","lex-reads.js?v=1795377587","lex-message.js?v=1795377587","lex-file-attach.js?v=1795377587","lex-news.js?v=1795377587","lex-send-later.js?v=1795377587","lex-chat-menu.js?v=1795377587","lex-person.js?v=1795377587","lex-profi.js?v=1795377587","lex-folders.js?v=1795377587","lex-people.js?v=1795377587","wc-agents.js?v=1795377587","wc-calendar.js?v=1795377587","lex-checklist.js?v=1795377587","wc-shopping.js?v=1795377587","lex-chat-money.js?v=1795377587","lex-step-popup.js?v=1795377587","model-picker-dropdown.js?v=1795377587","lex-dictation-catalog.js?v=1795377587","lex-dictation-limit.js?v=1795377587","lex-dictation-wav.js?v=1795377587","lex-dictation-live.js?v=1795377587","lex-dictation-grow.js?v=1795377587","lex-teacher-core.js?v=1795377587","lex-composer-input.js?v=1795377587","lex-composer-box.js?v=1795377587","lex-dictation-bar.js?v=1795377587","lex-drafts.js?v=1795377587","lex-long-press.js?v=1795377587","lex-brand-mark.js?v=1795377587","lex-settings-fields.js?v=1795377587","lex-billing-gate.js?v=1795377587","lex-error-text.js?v=1795377587","lex-voice-events.js?v=1795377587","lex-pulse.js?v=1795377587","lex-mic-watch.js?v=1795377587","lex-word-pick.js?v=1795377587","lex-edge-call.js?v=1795377587","lex-settings-cells.js?v=1795377587","lex-action-presets.js?v=1795377587","lex-turn-id.js?v=1795377587","lex-turn-follow.js?v=1795377587","lex-apart.js?v=1795377587","lex-web-config.js?v=1795377587","lex-web-auth.js?v=1795377587","wc-history.js?v=1795377587","lex-dictation-relay.js?v=1795377587","lex-direct-mode.js?v=1795377587","lex-direct-providers.js?v=1795377587","wc-backend.js?v=1795377587","wc-attach.js?v=1795377587","wc-wipe.js?v=1795377587","wc-topup.js?v=1795377587","microphone.js?v=1795377587","history-injector.js?v=1795377587","thread-writer.js?v=1795377587","feed-check.js?v=1795377587","telemetry.js?v=1795377587","call-server.js?v=1795377587","voice-tools.js?v=1795377587","gemini-live.js?v=1795377587","wc-voice-config.js?v=1795377587","wc-voice.js?v=1795377587","wc-voice-screen.js?v=1795377587","wc-sidebar.js?v=1795377587","wc-word-pick.js?v=1795377587","wc-thread.js?v=1795377587","wc-composer.js?v=1795377587","wc-quick.js?v=1795377587","wc-header.js?v=1795377587","wc-settings.js?v=1795377587","wc-app.js?v=1795377587","lex-palette.css?v=1795377587","lex-settings-fields.css?v=1795377587","lex-answer-row.css?v=1795377587","lex-links.css?v=1795377587","lex-section.css?v=1795377587","lex-message.css?v=1795377587","lex-checklist.css?v=1795377587","lex-news.css?v=1795377587","lex-profi.css?v=1795377587","lex-person.css?v=1795377587","lex-composer-box.css?v=1795377587","lex-dictation-bar.css?v=1795377587","lex-send-later.css?v=1795377587","model-picker-dropdown.css?v=1795377587","wc-app.css?v=1795377587","wc-calendar.css?v=1795377587"];

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
