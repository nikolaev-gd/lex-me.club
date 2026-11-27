// lex-file-attach.js — LexFileAttach: any file attached to a message in the composer of Lex
// (2026-11-17): a PDF, a document, a video, an archive — in any chat of Lex, so that the person can
// later send it on to people (WhatsApp, Telegram, Max). One set of rules for the extension, the page
// lex-me.club/app and the Mac app; the iPhone keeps the same numbers and words in
// ios/Lex/Lex/FileAttachment.swift.
//
// THE WAY OF A FILE. Picked («+» → «File», a paste, a drag) → checked here → uploaded AT ONCE to
// attach-upload (kind 'file') into the bucket user-attachments: the path is known before the message
// goes → the card stands over the field (LexMessage.fileChip, В7.49) → the message goes with
// meta.attachments = how many attachments it carries → the full list is reported on the person's turn
// (attach_to_turn) right after the press, again and again until the server has the row (attachEarly):
// the server waits for the paths on the turn before it tells the model about the files.
//
// A picture picked as a file goes the old way of a picture (shrunk to 1600 px, sent to the model as a
// picture block) when the model reads pictures and the message has no picture yet; otherwise it is a
// file like any other.
//
// The record on the turn — what the program that sends a file to a person reads:
//   { kind: 'file', path: 'user-attachments/<account>/<chat>/file_<ts>_<rand>.<ext>',
//     mime: 'application/pdf', bytes: 182344, name: 'Report.pdf' }
//
// Loaded by the pages (webchat/index.html), the surfaces of the extension (lex-surface-deps.js,
// manifest.json) and its service worker (importScripts): nothing here touches the DOM on load.
(function (global) {
  'use strict';

  // What the server's storage takes in one file (attach-upload, user_attachments_any_file.sql).
  const MAX_BYTES = 50 * 1024 * 1024;
  // Attachments of one message: the picture and the files together.
  const MAX_COUNT = 10;
  // How long the turn's row is waited for after the press, and how often it is asked.
  const ATTACH_WAIT_MS = 30 * 1000;
  const ATTACH_EVERY_MS = 500;

  // The pictures the picture path takes (composer-attach.js, wc-attach.js).
  const PICTURE = /^image\/(png|jpeg|webp|gif|heic|heif|heic-sequence|heif-sequence)$/i;
  function isPicture(file) {
    if (!file) return false;
    if (PICTURE.test(String(file.type || ''))) return true;
    return !file.type && /\.(png|jpe?g|webp|gif|hei[cf])$/i.test(String(file.name || ''));
  }

  const TEXT = {
    too_large: 'This file is larger than 50 MB — Lex takes files up to 50 MB.',
    quota: 'The file did not upload: the file space of your account is full.',
    count: 'Up to 10 files in one message.',
    empty: 'This file is empty.',
    auth: 'Please sign in first.',
    busy: 'Wait until the file has uploaded.',
    folder: 'Only text goes to a person from Lex.',
    failed: 'The file did not upload. Check the connection and try again.',
  };
  function refusal(reason) {
    return TEXT[reason] || TEXT.failed;
  }

  // Before the upload: a reason to refuse, or null. `count` — attachments already on the field.
  function check(file, count) {
    if (!file) return 'failed';
    if (!file.size) return 'empty';
    if (file.size > MAX_BYTES) return 'too_large';
    if ((Number(count) || 0) >= MAX_COUNT) return 'count';
    return null;
  }

  // The record of an uploaded file, as it lies on the turn.
  function record(up, file) {
    return {
      kind: 'file',
      path: String(up.path),
      mime: String(up.mime || (file && file.type) || 'application/octet-stream'),
      bytes: Number(up.bytes) || (file && file.size) || 0,
      name: String(up.name || (file && file.name) || 'file'),
    };
  }

  // One upload to attach-upload. Never throws: { ok:true, path, bytes, mime, name } or
  // { ok:false, reason } — reason 'too_large' | 'quota' | 'auth' | 'offline' | http_<n> | …
  async function post({ url, anonKey, token, blob, name, chatKey }) {
    try {
      if (!token) return { ok: false, reason: 'auth' };
      const fd = new FormData();
      fd.append('file', blob, name || 'file');
      fd.append('meta', JSON.stringify({ kind: 'file', chat_key: chatKey || null, name: name || '' }));
      const resp = await fetch(`${url}/functions/v1/attach-upload`, {
        method: 'POST',
        headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
        body: fd,
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => null);
        return { ok: false, reason: (body && body.error) || `http_${resp.status}`, status: resp.status };
      }
      const j = await resp.json().catch(() => null);
      return (j && typeof j.path === 'string' && j.path)
        ? { ok: true, path: j.path, bytes: Number(j.bytes) || 0, mime: j.mime || '', name: j.name || name || '' }
        : { ok: false, reason: 'bad_response' };
    } catch (_) {
      return { ok: false, reason: 'offline' };
    }
  }

  // Take an uploaded file back out of the bucket (the cross on its card, a new conversation).
  async function drop({ url, anonKey, token, path }) {
    try {
      if (!token || !path) return false;
      const r = await fetch(`${url}/functions/v1/attach-upload`, {
        method: 'DELETE',
        headers: { apikey: anonKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      return r.ok;
    } catch (_) {
      return false;
    }
  }

  // The list of the turn, reported right after the press: `attach()` → Promise<true when the row
  // took it, false when there is no row yet>. Asked every 0,5 s for at most 30 s — the server writes
  // the row once the provider took the request, and waits for the paths before it tells the model.
  async function attachEarly(attach, opts) {
    const o = opts || {};
    const until = Date.now() + (o.waitMs || ATTACH_WAIT_MS);
    for (;;) {
      let done = false;
      try { done = (await attach()) === true; } catch (_) { done = false; }
      if (done) return true;
      if (Date.now() >= until || (typeof o.stop === 'function' && o.stop())) return false;
      await new Promise((r) => setTimeout(r, o.everyMs || ATTACH_EVERY_MS));
    }
  }

  // ── The page and the Mac app: the person's pass is on the page (LexWebAuth) ────────────────────
  const A = () => global.LexWebAuth;
  async function webPost(file, chatKey) {
    const auth = A();
    const token = auth && await auth.validToken().catch(() => null);
    if (!token) return { ok: false, reason: 'auth' };
    return post({ url: auth.supabaseUrl(), anonKey: auth.anonKey(), token, blob: file, name: file.name || '', chatKey });
  }
  async function webDrop(path) {
    const auth = A();
    const token = auth && await auth.validToken().catch(() => null);
    return drop({ url: auth && auth.supabaseUrl(), anonKey: auth && auth.anonKey(), token, path });
  }

  // What the parts need to show the stored files (LexMessage.files): the page fetches a file with the
  // person's pass, and asks the storage for an address of it that lives an hour — to open the file in
  // a new tab (in the Mac app — in the system browser; `expiresIn` — longer, the recording of a call streams by it 6 hours,
  // В7.42). The bytes and the addresses are kept for the
  // life of the page. One for the order chats (lex-profi.js) and the chats of Lex (webchat/).
  const FILE_LINK_S = 3600;
  const webIo = (() => {
    const blobs = new Map();
    const objectPath = (path) => String(path).split('/').map(encodeURIComponent).join('/');
    function blob(path) {
      if (!blobs.has(path)) {
        blobs.set(path, (async () => {
          const auth = A();
          const token = auth && (await auth.validToken());
          if (!token) return null;
          const r = await fetch(`${auth.supabaseUrl()}/storage/v1/object/authenticated/${objectPath(path)}`, {
            headers: { apikey: auth.anonKey(), Authorization: `Bearer ${token}` },
          });
          if (!r.ok) return null;
          return URL.createObjectURL(await r.blob());
        })().catch(() => null).then((url) => { if (!url) blobs.delete(path); return url; }));
      }
      return blobs.get(path);
    }
    async function link(path, o) {
      const auth = A();
      const token = auth && (await auth.validToken());
      if (!token) return null;
      const r = await fetch(`${auth.supabaseUrl()}/storage/v1/object/sign/${objectPath(path)}`, {
        method: 'POST',
        headers: { apikey: auth.anonKey(), Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn: o && Number(o.expiresIn) > 0 ? Math.round(Number(o.expiresIn)) : FILE_LINK_S }),
      }).catch(() => null);
      if (!r || !r.ok) return null;
      const j = await r.json().catch(() => null);
      const signed = j && (j.signedURL || j.signedUrl);
      if (typeof signed !== 'string' || !signed) return null;
      const url = `${auth.supabaseUrl()}/storage/v1${signed.startsWith('/') ? '' : '/'}${signed}`;
      return o && o.download ? `${url}${url.includes('?') ? '&' : '?'}download=${encodeURIComponent(o.download)}` : url;
    }
    return { blob, link };
  })();

  // The files of a turn as the server keeps them (attachments of list_turns): the records of kind
  // 'file' in their order.
  function filesOf(attachments) {
    return (Array.isArray(attachments) ? attachments : [])
      .filter((a) => a && a.kind === 'file' && typeof a.path === 'string' && a.path)
      .map((a) => ({ kind: 'file', path: a.path, mime: a.mime || '', bytes: Number(a.bytes) || 0, name: a.name || '' }));
  }

  global.LexFileAttach = {
    MAX_BYTES, MAX_COUNT, ATTACH_WAIT_MS, TEXT,
    isPicture, refusal, check, record, post, drop, attachEarly, filesOf,
    webPost, webDrop, webIo,
  };
})(typeof self !== 'undefined' ? self : globalThis);
