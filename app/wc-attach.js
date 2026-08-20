// webchat/wc-attach.js — pictures in the composer.
//
// Three ways in — the paperclip, a paste, a drag — and one path out. The rules
// are the extension's, because the thing on the other end is the same server
// and the same providers: shrink anything wider than 1600 px, refuse anything
// over 3 MB of base64, and send the picture as a neutral block beside the text.
//
// ── Two things this surface does BETTER than the extension, not merely
// differently ───────────────────────────────────────────────────────────────
//
// 1. STORAGE IS LOCAL. In the extension the picture crosses into the service
//    worker and back through three messages, because the IndexedDB it wants
//    lives on chrome-extension:// and a content script's storage APIs belong
//    to whatever site it is standing on. That relay costs two base64
//    conversions of every image — sendMessage serialises through JSON and
//    turns a Blob into {} — so every picture crosses twice, as text, at 4/3
//    size. Here the database is on our own origin: the Blob is stored AS a
//    Blob and shown through URL.createObjectURL, with no encoding at all.
//
// 2. HEIC DECODES IN THE PAGE. The extension raises an invisible document for
//    it, for two reasons that are both gone here: the decoder is wasm and
//    needs a CSP that allows it (an extension has one; an arbitrary host page
//    is a coin-flip), and it needs a canvas, which a service worker has not.
//    This page is ours, so libheif loads straight into it. It is 1.4 MB, so it
//    loads ON DEMAND — the first HEIC pays, nothing else does.
//
// The teacher does not draw pictures, only reads them.
(function (global) {
  'use strict';

  const { el, icon, toast } = WcUI;

  const MAX_WIDTH = 1600;
  // The ceiling is on BASE64 CHARACTERS, not on image bytes: 3 MiB of base64 is
  // about 2.25 MB of picture. The server's body cap is 5 MB and the body also
  // carries the whole conversation, so refusing here beats eating a 413.
  const MAX_BASE64 = 3 * 1024 * 1024;
  const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  const HEIC_MIMES = ['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence'];

  const isHeic = (file) => HEIC_MIMES.indexOf(file.type) >= 0 || /\.hei[cf]$/i.test(file.name || '');
  const isAccepted = (file) => ACCEPTED.indexOf(file.type) >= 0;

  // ── The picture store ────────────────────────────────────────────────────
  // Its own database, not the key-value one: pixels and settings have nothing
  // to do with each other, and a store of megabyte blobs inside the settings DB
  // would be read every time anything asks for a setting.
  const DB_NAME = 'lex_webchat_images';
  const STORE = 'images';
  let dbPromise = null;

  function db() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE)) {
          const st = d.createObjectStore(STORE, { keyPath: 'key' });
          st.createIndex('ts', 'ts');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function put(record) {
    const d = await db();
    await new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(record);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    evict().catch(() => {});
    return record.key;
  }

  async function get(key) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, 'readonly');
      const r = tx.objectStore(STORE).get(key);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => reject(r.error);
    });
  }

  // Oldest out first, same two ceilings the extension uses. Reads only the
  // metadata it needs to decide — never the pixels.
  const MAX_COUNT = 300;
  const MAX_BYTES = 100 * 1024 * 1024;

  async function evict() {
    const d = await db();
    const rows = await new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, 'readonly');
      const out = [];
      const cur = tx.objectStore(STORE).index('ts').openCursor();
      cur.onsuccess = (e) => {
        const c = e.target.result;
        if (!c) { resolve(out); return; }
        out.push({ key: c.value.key, ts: c.value.ts, bytes: c.value.bytes || 0 });
        c.continue();
      };
      cur.onerror = () => reject(tx.error);
    });
    let total = rows.reduce((n, r) => n + r.bytes, 0);
    const doomed = [];
    let i = 0;
    while ((rows.length - doomed.length > MAX_COUNT || total > MAX_BYTES) && i < rows.length) {
      doomed.push(rows[i].key);
      total -= rows[i].bytes;
      i++;
    }
    if (!doomed.length) return;
    const w = await db();
    await new Promise((resolve) => {
      const tx = w.transaction(STORE, 'readwrite');
      doomed.forEach((k) => tx.objectStore(STORE).delete(k));
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
  }

  // ── HEIC, loaded only when one turns up ──────────────────────────────────
  //
  // Ищется в ДВУХ местах, и это не перестраховка, а две настоящие раскладки:
  //   · в выкладке всё сложено ПЛОСКО в один каталог `/app/` — библиотека
  //     лежит там же, рядом с этим файлом, и никакого `vendor/` там нет:
  //     сборщик копирует файлы по имени, без подкаталогов
  //     (dev-tools/build-webchat.mjs);
  //   · в разработке страница лежит в `webchat/`, а библиотека — общая с
  //     расширением, на уровень выше, в `vendor/`.
  // Путь считается от адреса ЭТОГО файла, а не от адреса страницы: иначе он
  // разъедется, как только чат откроют не с `/index.html`.
  //
  // ⚠ Здесь стояло `vendor/libheif-bundle.js` — адрес, которого нет НИ В ОДНОЙ
  // из двух раскладок: в выкладке подкаталога `vendor/` не существует, в
  // разработке его нет и подавно (`webchat/vendor/` не заводили). Из-за этого
  // фотография с айфона не открывалась на живой странице вообще — оба адреса
  // отдавали 404, и человек видел «could not load the heic decoder». Прожило
  // незамеченным, потому что сценарий гоняет чат с ЛОКАЛЬНОГО сервера, который
  // раздаёт весь чекаут: там второй адрес (`../vendor/…`) исправно работает, и
  // до первого дело не доходит. Ровно это теперь стережёт сборка — она
  // проверяет адреса ПО СОБРАННОМУ КАТАЛОГУ, а не по исходникам.
  const SELF_DIR = (document.currentScript && document.currentScript.src)
    ? document.currentScript.src.replace(/[^/]+$/, '')
    : './';
  const HEIF_CANDIDATES = ['libheif-bundle.js', '../vendor/libheif-bundle.js'];

  let heifPromise = null;
  function loadHeif() {
    if (heifPromise) return heifPromise;
    const tryOne = (i) => new Promise((resolve, reject) => {
      if (i >= HEIF_CANDIDATES.length) { reject(new Error('could not load the heic decoder')); return; }
      const el = document.createElement('script');
      el.src = new URL(HEIF_CANDIDATES[i], SELF_DIR).href;
      el.onload = () => (global.libheif ? resolve(global.libheif()) : reject(new Error('libheif did not come up')));
      el.onerror = () => { el.remove(); resolve(tryOne(i + 1)); };
      document.head.append(el);
    });
    heifPromise = tryOne(0).catch((err) => { heifPromise = null; throw err; });
    return heifPromise;
  }

  async function decodeHeic(file) {
    const mod = await loadHeif();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const images = new mod.HeifDecoder().decode(bytes);
    if (!images || !images.length) throw new Error('no images inside the heic file');
    const image = images[0];
    const width = image.get_width();
    const height = image.get_height();
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const data = ctx.createImageData(width, height);
    await new Promise((resolve, reject) => {
      image.display(data, (d) => (d ? resolve() : reject(new Error('heic: did not render'))));
    });
    ctx.putImageData(data, 0, 0);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
    if (!blob) throw new Error('heic: jpeg not produced');
    return blob;
  }

  // ── Normalising ──────────────────────────────────────────────────────────
  async function decodeBitmap(blob) {
    if (global.createImageBitmap) {
      try { return await createImageBitmap(blob); } catch (_) { /* fall through */ }
    }
    const url = URL.createObjectURL(blob);
    try {
      return await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('the image did not open'));
        img.src = url;
      });
    } finally { URL.revokeObjectURL(url); }
  }

  async function shrinkToWidth(blob, w, h) {
    const scale = MAX_WIDTH / w;
    const outW = MAX_WIDTH;
    const outH = Math.max(1, Math.round(h * scale));
    const canvas = global.OffscreenCanvas
      ? new OffscreenCanvas(outW, outH)
      : Object.assign(document.createElement('canvas'), { width: outW, height: outH });
    const ctx = canvas.getContext('2d');
    // JPEG has no alpha, so a transparent PNG would come out with black where
    // it was see-through. White underlay first.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, outW, outH);
    const bitmap = await decodeBitmap(blob);
    ctx.drawImage(bitmap, 0, 0, outW, outH);
    if (bitmap.close) bitmap.close();
    const out = canvas.convertToBlob
      ? await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })
      : await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
    // The extension's version falls back to the ORIGINAL blob here while still
    // reporting mime 'image/jpeg' and the shrunken dimensions — the attachment
    // then lies about its own format and size. Refusing is the honest answer:
    // an encoder that returned nothing produced nothing.
    if (!out) throw new Error('could not re-encode the image');
    return { blob: out, mime: 'image/jpeg', width: outW, height: outH };
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => {
        const s = String(fr.result || '');
        resolve(s.slice(s.indexOf(',') + 1));
      };
      fr.onerror = () => reject(fr.error || new Error('the file could not be read'));
      fr.readAsDataURL(blob);
    });
  }

  async function normalize(file) {
    if (!file || !file.size) throw new Error('the file is empty');

    let blob = file;
    let mime = file.type;
    if (isHeic(file)) {
      blob = await decodeHeic(file);
      mime = 'image/jpeg';
    } else if (!isAccepted(file)) {
      throw new Error('unsupported format: ' + (file.type || 'unknown'));
    }

    const bitmap = await decodeBitmap(blob);
    let width = bitmap.width;
    let height = bitmap.height;
    if (bitmap.close) bitmap.close();

    // Width is the ONLY trigger. Under 1600 px the original bytes go out
    // untouched — re-encoding a small picture only loses quality.
    if (width > MAX_WIDTH) {
      const shrunk = await shrinkToWidth(blob, width, height);
      blob = shrunk.blob;
      mime = shrunk.mime;
      width = shrunk.width;
      height = shrunk.height;
    }

    const base64 = await blobToBase64(blob);
    if (base64.length > MAX_BASE64) {
      // Terminal, with no second pass at lower quality — the same as the
      // extension. A tall narrow picture never enters compression at all, so
      // this is where it stops.
      throw new Error('image too large — ' + Math.round(blob.size / 1024 / 1024 * 10) / 10 + ' MB');
    }

    return { blob, mime, base64, width, height, bytes: blob.size };
  }

  // ── The strip above the composer ─────────────────────────────────────────
  const pending = [];     // {key, mime, width, height, base64, previewUrl, node}
  let elStrip, elForm, elInput, elFile;

  function paint() {
    elStrip.replaceChildren(...pending.map((a) => a.node));
    elStrip.hidden = !pending.length;
    WcComposer.refresh();
  }

  function chipFor(att) {
    const chip = el('.wc-chip', { style: { backgroundImage: `url("${att.previewUrl}")` } }, [
      el('button.wc-chip-x', {
        type: 'button', title: 'Remove', 'aria-label': 'Remove image',
        onclick: () => remove(att.key),
      }, [icon('x')]),
    ]);
    return chip;
  }

  function remove(key) {
    const i = pending.findIndex((a) => a.key === key);
    if (i < 0) return;
    URL.revokeObjectURL(pending[i].previewUrl);
    pending.splice(i, 1);
    paint();
  }

  // One at a time, like the extension: the wire format carries one image per
  // message, and a strip that accepts five and sends one is a lie.
  async function accept(file) {
    if (!file) return;
    if (pending.length) {
      toast('One image at a time for now — remove the previous one');
      return;
    }
    const busy = el('.wc-chip.is-busy');
    elStrip.replaceChildren(busy);
    elStrip.hidden = false;
    try {
      const n = await normalize(file);
      const key = 'img_' + ((global.crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now());
      await put({ key, blob: n.blob, mime: n.mime, width: n.width, height: n.height, bytes: n.bytes, ts: Date.now() });
      const att = {
        key, mime: n.mime, width: n.width, height: n.height, base64: n.base64,
        previewUrl: URL.createObjectURL(n.blob),
      };
      att.node = chipFor(att);
      pending.push(att);
      paint();
    } catch (err) {
      elStrip.replaceChildren();
      elStrip.hidden = true;
      toast(String((err && err.message) || err), { error: true });
    }
  }

  function firstImageFrom(dt) {
    if (!dt) return null;
    const files = dt.files ? Array.from(dt.files) : [];
    const hit = files.find((f) => /^image\//.test(f.type) || /\.hei[cf]$/i.test(f.name || ''));
    if (hit) return hit;
    const items = dt.items ? Array.from(dt.items) : [];
    const it = items.find((i) => i.kind === 'file');
    return it ? it.getAsFile() : null;
  }

  const WcAttach = {
    ready: true,
    MAX_WIDTH,
    MAX_BASE64,

    init() {
      elStrip = document.getElementById('wc-attachments');
      elForm = document.getElementById('wc-composer');
      elInput = document.getElementById('wc-input');
      elFile = document.getElementById('wc-file');

      elFile.addEventListener('change', () => {
        const f = elFile.files && elFile.files[0];
        elFile.value = '';       // same file twice in a row must fire again
        accept(f);
      });

      elInput.addEventListener('paste', (e) => {
        const f = firstImageFrom(e.clipboardData);
        if (!f) return;          // plain text paste is left alone
        e.preventDefault();
        accept(f);
      });

      // A depth counter, not a boolean: dragging over a child fires
      // dragleave on the parent, and a boolean makes the highlight flicker.
      let depth = 0;
      const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');

      document.addEventListener('dragenter', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth++;
        elForm.classList.add('is-dropping');
      });
      document.addEventListener('dragover', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        // Without this Chrome never fires `drop` at all.
        e.dataTransfer.dropEffect = 'copy';
      });
      document.addEventListener('dragleave', (e) => {
        if (!hasFiles(e)) return;
        depth = Math.max(0, depth - 1);
        if (!depth) elForm.classList.remove('is-dropping');
      });
      document.addEventListener('drop', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth = 0;
        elForm.classList.remove('is-dropping');
        accept(firstImageFrom(e.dataTransfer));
      });
    },

    pick() {
      // A model that cannot see is told about, not silently allowed to
      // receive a picture it will ignore.
      elFile.click();
    },

    count() { return pending.length; },

    // Handed to the sender and cleared: the strip's job ends where the turn
    // begins. previewUrl survives — the bubble shows it.
    take() {
      const out = pending.slice();
      pending.length = 0;
      elStrip.replaceChildren();
      elStrip.hidden = true;
      return out;
    },

    clear() {
      pending.forEach((a) => URL.revokeObjectURL(a.previewUrl));
      pending.length = 0;
      if (elStrip) { elStrip.replaceChildren(); elStrip.hidden = true; }
    },

    // Reading a stored picture back — this is what makes an image survive a
    // reload. Returns an object URL, or null when the picture is gone.
    async url(key) {
      try {
        const rec = await get(key);
        if (!rec || !rec.blob) return null;
        return URL.createObjectURL(rec.blob);
      } catch (_) { return null; }
    },

    async base64(key) {
      const rec = await get(key);
      if (!rec || !rec.blob) return null;
      return { mime: rec.mime, data: await blobToBase64(rec.blob) };
    },

    // Exposed for the scenario set, which feeds a file straight in rather than
    // driving a native file dialog.
    accept,
    normalize,
  };

  global.WcAttach = WcAttach;
})(typeof self !== 'undefined' ? self : globalThis);
