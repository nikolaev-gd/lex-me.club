// wc-quick.js — the capsule of a new chat and the field over a dimmed screen (STANDARD.md В7.64), the page and the Mac app.
//
// Gennady, 22.11.2026 (boards Comp2*): out of a chat, at the bottom right, a capsule — the microphone, the live voice,
// «New chat». A press dims the screen the person is on (it stays seen under the dimming) and raises the one field of Lex
// over it, with «New chat · Lex» (or the agent's name) over the field; a new chat is made only when the words are sent —
// by the voice, when its first words went to the model. A press on the dimming closes the field: no chat is made. In an
// open chat there is no capsule: the field of that chat stands as always. What is on the screen is not given to the chat.
//
// This file is the look of the part only: the capsule, the dimming, the line over the field and the line of keys under
// it. The field is the page's one field (wc-composer.js), lifted over the dimming by the class `is-quick` on `.wc-main`;
// what a press starts and what sending does is wc-app.js's (openQuick, quickCommit, closeQuick).
//
//   WcQuick.init({ onCapsule(mode), onClose() })  mode: 'type' | 'dictate' | 'voice'
//   WcQuick.capsule(on, { voice })                 the capsule shows (out of a chat) or not; voice: false — no voice button
//   WcQuick.open({ to, agent })                    the dimming and the field; to — whose chat it will be («Lex», a name)
//   WcQuick.close()                                back to the screen as it was
//   WcQuick.isOpen()
(function (global) {
  'use strict';

  const SVG = (inner, size) => `<svg viewBox="0 0 24 24" width="${size || 20}" height="${size || 20}" aria-hidden="true">${inner}</svg>`;
  const ICON = {
    mic: SVG('<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/>'),
    wave: SVG('<path d="M4 10v4M8 6v12M12 3v18M16 6v12M20 10v4"/>'),
    pencil: SVG('<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.4 2.6a1 1 0 0 1 3 3l-9 9a2 2 0 0 1-.85.5l-2.9.85a.5.5 0 0 1-.62-.62l.85-2.9a2 2 0 0 1 .5-.85z"/>'),
    spark: SVG('<path d="M11 3l1.9 5.1L18 10l-5.1 1.9L11 17l-1.9-5.1L4 10l5.1-1.9z"/><path d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8z"/>', 14),
    pencilSmall: SVG('<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.4 2.6a1 1 0 0 1 3 3l-9 9a2 2 0 0 1-.85.5l-2.9.85a.5.5 0 0 1-.62-.62l.85-2.9a2 2 0 0 1 .5-.85z"/>', 14),
  };

  let hooks = { onCapsule: () => {}, onClose: () => {} };
  let els = null;
  let shown = false;

  function make(tag, cls, html) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (html) el.innerHTML = html;
    return el;
  }

  function build() {
    const main = document.querySelector('.wc-main');
    const wrap = document.querySelector('.wc-composer-wrap');
    if (!main || !wrap) return null;
    // The capsule: two round icon buttons and the main one, «New chat» (В7.6 look, a pill of 44).
    const capsule = make('div', 'wc-quick-capsule');
    capsule.hidden = true;
    const mic = make('button', 'wc-quick-btn', ICON.mic);
    mic.type = 'button'; mic.title = 'Dictate'; mic.setAttribute('aria-label', 'Dictate');
    const voice = make('button', 'wc-quick-btn wc-quick-voice', `<span class="wc-quick-dot">${ICON.wave}</span>`);
    voice.type = 'button'; voice.title = 'Voice conversation'; voice.setAttribute('aria-label', 'Voice conversation');
    const fresh = make('button', 'wc-quick-new', `${ICON.pencil}<span>New chat</span>`);
    fresh.type = 'button';
    capsule.append(mic, voice, fresh);
    mic.addEventListener('click', () => hooks.onCapsule('dictate'));
    voice.addEventListener('click', () => hooks.onCapsule('voice'));
    fresh.addEventListener('click', () => hooks.onCapsule('type'));
    // The dimming: the whole window, under the field; a press on it closes the field.
    const scrim = make('button', 'wc-quick-scrim');
    scrim.type = 'button';
    scrim.hidden = true;
    scrim.setAttribute('aria-label', 'Close');
    scrim.tabIndex = -1;
    scrim.addEventListener('click', () => hooks.onClose());
    // Whose chat it will be — over the field; the keys — under it (a wide window: the keyboard is on the desk).
    const to = make('div', 'wc-quick-to');
    to.hidden = true;
    const keys = make('div', 'wc-quick-keys', '<span>Return to send</span><span>Shift-Return for a new line</span><span>Esc to close</span>');
    keys.hidden = true;
    main.append(scrim, capsule);
    wrap.prepend(to);
    wrap.append(keys);
    document.addEventListener('keydown', (e) => {
      if (!shown || e.key !== 'Escape' || e.defaultPrevented) return;
      // A menu, a sheet or a dialog over the field (its «+», «Text model») takes its own Escape first.
      const menu = document.getElementById('wc-menu');
      if ((menu && !menu.hidden) || document.querySelector('.wc-sheet:not([hidden]), .wc-modal:not([hidden]), .lex-sl-scrim')) return;
      e.preventDefault();
      e.stopPropagation();
      hooks.onClose();
    }, true);
    return { main, capsule, voice, scrim, to, keys };
  }

  const WcQuick = {
    init(h) {
      hooks = Object.assign(hooks, h || {});
      els = build();
    },
    capsule(on, opts) {
      if (!els) return;
      els.capsule.hidden = !on || shown;
      els.voice.hidden = !!(opts && opts.voice === false);
    },
    open(opts) {
      if (!els) return;
      const agent = !!(opts && opts.agent);
      els.to.innerHTML = `<div class="wc-quick-to-pill">${agent ? ICON.pencilSmall : ICON.spark}<span></span></div>`;
      els.to.querySelector('span').textContent = 'New chat · ' + ((opts && opts.to) || 'Lex');
      shown = true;
      els.capsule.hidden = true;
      els.scrim.hidden = false;
      els.to.hidden = false;
      els.keys.hidden = false;
      els.main.classList.add('is-quick');
      els.main.classList.toggle('is-quick-agent', agent);
    },
    close() {
      if (!els || !shown) return;
      shown = false;
      els.scrim.hidden = true;
      els.to.hidden = true;
      els.keys.hidden = true;
      els.main.classList.remove('is-quick', 'is-quick-agent');
    },
    isOpen() { return shown; },
  };

  global.WcQuick = WcQuick;
})(typeof self !== 'undefined' ? self : globalThis);
