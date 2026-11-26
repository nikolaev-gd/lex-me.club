// lex-composer.js — the field under a chat: which of its parts stand and what its buttons offer, ONE rule for every
// chat of Lex (docs/spec/21-chat-canvas.md, «Поле ввода и отправка»; plan PLAN-CHAT-UNIFY, stage 3, part «б»).
//
// What stands in the field is the profile of the chat (LexChatProfile, supabase/functions/_shared/lex-chat-profile.js:
// `field`, `send`, `hold`, `stop`), never a class of the page, a computed style or a check of the kind of the chat in
// place: the row of presets, the microphone, the button of a talk by voice, «new chat» over the chat, the items of «+»
// (the material of the conversation, a picture, a file, the model), the held arrow (to a person now, or at a time where
// the door of the chat has one), the round button that is Send or Stop. The page's field (webchat/wc-composer.js) asks
// this; the iPhone reads the same table (ChatProfile.swift, ChatScreen's field). The markup and the sizes of the box are
// lex-composer-box.*; Enter and the caret — lex-composer-input.js; the dictation engine — lex-dictation-*.js.
//
// No chrome.*, no ids of a page: the elements come from the caller, so that the extension's windows (chat-surface.js)
// may take it too. LexComposer gives:
//   parts(profile) → { kind, field, presets, mic, voice, newChat, material, image, file, model, files, hold, send, stop }
//       what the field of a chat of this profile has; no profile (the table did not load) — the main chat's.
//   paint(els, parts) → parts — every part the profile does not give is off (data-profile-off), the rest on:
//       els = { root (data-chat-kind), presets, mic, voice, newChat (an element or a list) }
//   plusItems(parts, o) → the items of «+» in their order: o = { attached: { url, label, iconUrl } | null, image(),
//       file(), model: { label, open(anchor) } | null, anchor, open(url) }
//   holdWays(parts, ways, o) → the ways the held arrow offers, or null: only where the profile has a hold; o.files —
//       how many files lie in the field: the text goes to a person without the model, its files do not (folder-send and
//       profi_send_text carry words only), and the head of the menu says so
//   sendFace(el, { streaming, can }) → the round button: an arrow (Send) or a square (Stop), its title and its words
//   folded(parts, sending) → the slot of the voice folds: nothing to send and no voice button in this chat
(function (root) {
  'use strict';

  const PLUS = ['material', 'image', 'file', 'model'];
  const table = () => root.LexChatProfile || null;

  function parts(profile) {
    const P = table();
    const p = profile || (P ? P.profileOfKind('main') : null);
    const has = (part) => !!(P && p && P.fieldHas(p, part));
    const out = { kind: (p && p.kind) || 'main', field: !!(p && p.field) };
    for (const part of ['presets', 'mic', 'voice', 'newChat']) out[part] = has(part);
    for (const part of PLUS) out[part] = has(part);
    // A picture and a file are one door of the field (the attachment strip): a chat that takes neither takes no file.
    out.files = out.image || out.file;
    out.hold = !!(p && p.hold);
    out.send = (p && p.send) || 'model';
    out.stop = (p && p.stop) || null;
    out.door = P && typeof P.doorOf === 'function' ? P.doorOf(p) : 'brain';
    return out;
  }

  function each(x, fn) {
    if (!x) return;
    if (typeof x.length === 'number' && !x.nodeType) { for (const el of Array.from(x)) if (el) fn(el); return; }
    fn(x);
  }
  // A part the profile does not give carries `data-profile-off` (lex-composer-box.css: not drawn). Not `hidden`: other
  // code shows and hides some of these for reasons of its own (the head hides «new chat» on the main page), and the
  // profile must not undo them. Only a change is written: a node laid out again for nothing makes the field jump.
  const show = (el, on) => {
    if (on && el.hasAttribute('data-profile-off')) el.removeAttribute('data-profile-off');
    else if (!on && !el.hasAttribute('data-profile-off')) el.setAttribute('data-profile-off', '');
  };

  function paint(els, ps) {
    const e = els || {};
    if (e.root && e.root.dataset && e.root.dataset.chatKind !== ps.kind) e.root.dataset.chatKind = ps.kind;
    each(e.presets, (el) => show(el, ps.presets));
    each(e.mic, (el) => show(el, ps.mic));
    each(e.voice, (el) => show(el, ps.voice));
    each(e.newChat, (el) => show(el, ps.newChat));
    return ps;
  }

  function plusItems(ps, o) {
    const x = o || {};
    const items = [];
    // What the conversation is bound to — first, and only when there is a binding (a page or a video of the talk).
    const att = ps.material ? x.attached : null;
    if (att && att.url) {
      items.push({
        label: att.label,
        icon: 'link',
        iconUrl: att.iconUrl || null,
        onSelect: () => { if (typeof x.open === 'function') x.open(att.url); },
      });
    }
    // A chat that takes only words (a chat with an agent) has no picture and no file: the items that would only refuse
    // are not drawn (docs/spec/21-chat-canvas.md, «Виды чатов и их части»).
    if (ps.image && typeof x.image === 'function') items.push({ label: 'Attach image', icon: 'image', onSelect: () => x.image() });
    // Any file (2026-11-17): a PDF, a document, a video, an archive — to the message, so that it can go on to people.
    if (ps.file && typeof x.file === 'function') items.push({ label: 'File', icon: 'file', onSelect: () => x.file() });
    // The default model for the next questions (in a chat of an agent — the agent's own): just the model and its level,
    // «Opus 5.5 · high» (Gennady, 23.11.2026).
    const tm = ps.model ? x.model : null;
    if (tm) items.push({ label: tm.label || 'Text model', icon: 'spark', onSelect: () => tm.open(x.anchor) });
    return items;
  }

  // The words of the head when files lie in the field: what goes without the model is the text alone.
  const FILES_STAY = 'only the words go: a file goes with Lex';
  function holdWays(ps, ways, o) {
    if (!ps.hold || !ways || !Array.isArray(ways.items) || !ways.items.length) return null;
    const files = Number(o && o.files) || 0;
    if (!files) return ways;
    return Object.assign({}, ways, { head: `${ways.head || ''}`.trim() ? `${ways.head} · ${FILES_STAY}` : FILES_STAY, files: true });
  }

  function sendFace(el, s) {
    if (!el) return;
    const streaming = !!(s && s.streaming);
    el.classList.toggle('is-stop', streaming);
    el.title = streaming ? 'Stop' : 'Send';
    el.setAttribute('aria-label', el.title);
    const path = el.querySelector('path');
    if (path) {
      path.setAttribute('d', streaming
        ? 'M7 7h10v10H7z'                 // a square: stop
        : 'M12 19V5M5 12l7-7 7 7');       // an arrow: send
    }
  }

  const folded = (ps, sending) => !sending && !ps.voice;

  root.LexComposer = { PLUS, FILES_STAY, parts, paint, plusItems, holdWays, sendFace, folded };
})(typeof window !== 'undefined' ? window : globalThis);
