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

const BUILD = "1795651016";
const FILES = ["./","lex-busy.js?v=1795651016","lex-chat-profile.js?v=1795651016","wc-log.js?v=1795651016","wc-store.js?v=1795651016","wc-bus.js?v=1795651016","wc-haptics.js?v=1795651016","lex-links.js?v=1795651016","lex-tags.js?v=1795651016","wc-markdown.js?v=1795651016","lex-open-markers.js?v=1795651016","wc-ui.js?v=1795651016","model-registry.js?v=1795651016","lex-draft-box.js?v=1795651016","lex-answer-row.js?v=1795651016","lex-account-events.js?v=1795651016","lex-back.js?v=1795651016","lex-section.js?v=1795651016","lex-reads.js?v=1795651016","lex-message.js?v=1795651016","lex-file-attach.js?v=1795651016","lex-news.js?v=1795651016","lex-send-later.js?v=1795651016","lex-chat-window.js?v=1795651016","lex-chat-menu.js?v=1795651016","lex-person.js?v=1795651016","lex-profi.js?v=1795651016","lex-folders.js?v=1795651016","lex-people.js?v=1795651016","lex-list-order.js?v=1795651016","wc-agents.js?v=1795651016","wc-calendar.js?v=1795651016","lex-checklist.js?v=1795651016","wc-shopping.js?v=1795651016","lex-chat-money.js?v=1795651016","lex-step-popup.js?v=1795651016","model-picker-dropdown.js?v=1795651016","lex-dictation-catalog.js?v=1795651016","lex-dictation-limit.js?v=1795651016","lex-dictation-wav.js?v=1795651016","lex-dictation-live.js?v=1795651016","lex-dictation-grow.js?v=1795651016","lex-teacher-core.js?v=1795651016","lex-composer-input.js?v=1795651016","lex-composer-box.js?v=1795651016","lex-dictation-bar.js?v=1795651016","lex-drafts.js?v=1795651016","lex-long-press.js?v=1795651016","lex-brand-mark.js?v=1795651016","lex-settings-fields.js?v=1795651016","lex-billing-gate.js?v=1795651016","lex-error-text.js?v=1795651016","lex-voice-events.js?v=1795651016","lex-pulse.js?v=1795651016","lex-mic-watch.js?v=1795651016","lex-word-pick.js?v=1795651016","lex-edge-call.js?v=1795651016","lex-settings-cells.js?v=1795651016","lex-action-presets.js?v=1795651016","lex-turn-id.js?v=1795651016","lex-turn-follow.js?v=1795651016","lex-apart.js?v=1795651016","lex-web-config.js?v=1795651016","lex-web-auth.js?v=1795651016","wc-history.js?v=1795651016","lex-dictation-relay.js?v=1795651016","lex-direct-mode.js?v=1795651016","lex-direct-providers.js?v=1795651016","wc-backend.js?v=1795651016","wc-attach.js?v=1795651016","wc-wipe.js?v=1795651016","wc-topup.js?v=1795651016","microphone.js?v=1795651016","history-injector.js?v=1795651016","thread-writer.js?v=1795651016","feed-check.js?v=1795651016","telemetry.js?v=1795651016","call-server.js?v=1795651016","voice-tools.js?v=1795651016","gemini-live.js?v=1795651016","wc-voice-config.js?v=1795651016","wc-voice.js?v=1795651016","wc-voice-screen.js?v=1795651016","wc-sidebar.js?v=1795651016","wc-word-pick.js?v=1795651016","wc-thread.js?v=1795651016","wc-composer.js?v=1795651016","wc-quick.js?v=1795651016","wc-header.js?v=1795651016","wc-settings.js?v=1795651016","wc-app.js?v=1795651016","lex-palette.css?v=1795651016","lex-busy.css?v=1795651016","lex-settings-fields.css?v=1795651016","lex-answer-row.css?v=1795651016","lex-links.css?v=1795651016","lex-section.css?v=1795651016","lex-message.css?v=1795651016","lex-checklist.css?v=1795651016","lex-news.css?v=1795651016","lex-profi.css?v=1795651016","lex-person.css?v=1795651016","lex-composer-box.css?v=1795651016","lex-dictation-bar.css?v=1795651016","lex-send-later.css?v=1795651016","model-picker-dropdown.css?v=1795651016","wc-app.css?v=1795651016","wc-calendar.css?v=1795651016"];

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
