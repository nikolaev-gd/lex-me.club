// lex-links.js — the addresses in a text of Lex become links. ONE module for every surface that
// draws words: a bubble of a message and a notice (lex-message.js), a chat of an order and of a
// person (lex-profi.js), a news (lex-news.js), an answer of the teacher on the page
// (webchat/wc-markdown.js) and in the extension (chat-surface.js). The look of a link is
// lex-links.css; the iPhone has the same rules in `LexLinks.swift`.
//
// Two things are a link:
//   «[caption](https://…)»  — the caption opens the address (the bot of Profi and the models write so);
//   a bare address          — «https://…», «http://…» or «www.site.tld…», as a person pastes it in
//                             Telegram. It is shown as it is written and opens itself.
//
// Where a bare address ends is the rule of GitHub's Markdown (GFM, «Autolinks (extension)»): it runs
// to a space or «<», then the punctuation of the sentence is taken off its end («.», «,», «?», «!»,
// «:», «;», «*», «_», «~», quotes, «…»), and a closing bracket with no opening one inside the address
// («(see https://a.b/c)»). An address without «http» or «www.» («site.ru») stays text: words with a
// dot («т.д», «file.txt») would turn into links.
//
// It builds nodes, never HTML, and has no need of a browser: `pieces` and `bare` are plain functions
// (dev-tools/test-lex-links.mjs).
(function (global) {
  'use strict';
  if (global.LexLinks) return;

  const LETTER = '\\p{L}\\p{N}';
  // Not after a letter, a digit or one of «_ @ . / : -»: «mail@www.site.ru» and «xhttps://» are no start.
  const BARE_SRC = `(?<![${LETTER}_@./:\\-])(?:https?:\\/\\/(?=[${LETTER}\\[])|www\\.(?=[${LETTER}\\-]+\\.[${LETTER}]))[^\\s<>]+`;
  const MD_SRC = '\\[([^\\]\\n]+)\\]\\((https?:\\/\\/[^\\s)]+)\\)';
  const BARE = new RegExp(BARE_SRC, 'u');
  const BOTH = new RegExp(`${MD_SRC}|${BARE_SRC}`, 'gu');

  const TAIL = /[?!.,:;*_~'"«»“”‘’…]$/;
  const ENTITY = /&[A-Za-z0-9]+;$/;
  const PAIRS = { ')': '(', ']': '[', '}': '{' };

  function count(s, ch) {
    let n = 0;
    for (let i = s.indexOf(ch); i >= 0; i = s.indexOf(ch, i + 1)) n++;
    return n;
  }

  // The address without the punctuation of the sentence at its end.
  function trim(raw) {
    let s = raw;
    for (;;) {
      const entity = ENTITY.exec(s);
      if (entity) { s = s.slice(0, entity.index); continue; }
      if (TAIL.test(s)) { s = s.slice(0, -1); continue; }
      const open = PAIRS[s[s.length - 1]];
      if (open && count(s, s[s.length - 1]) > count(s, open)) { s = s.slice(0, -1); continue; }
      return s;
    }
  }

  const hrefOf = (shown) => (/^www\./i.test(shown) ? `https://${shown}` : shown);

  function bareAt(m) {
    const text = trim(m[0]);
    // Nothing but the scheme is left («https://.»): not an address.
    if (!/^(?:https?:\/\/|www\.)[^\s]/i.test(text) || /^https?:\/\/$/i.test(text)) return null;
    return { index: m.index, text, href: hrefOf(text) };
  }

  // The first bare address of the text: { index, text, href } or null.
  function bare(text) {
    const src = String(text == null ? '' : text);
    let from = 0;
    while (from < src.length) {
      const m = BARE.exec(src.slice(from));
      if (!m) return null;
      const hit = bareAt(m);
      if (hit) return { index: from + hit.index, text: hit.text, href: hit.href };
      from += m.index + m[0].length;
    }
    return null;
  }

  // The text as pieces in their order: { text } is words, { text, href } is a link.
  function pieces(text) {
    const src = String(text == null ? '' : text);
    const out = [];
    let at = 0;
    const words = (to) => { if (to > at) out.push({ text: src.slice(at, to) }); };
    BOTH.lastIndex = 0;
    for (let m; (m = BOTH.exec(src));) {
      if (m[1] !== undefined) {
        words(m.index);
        out.push({ text: m[1], href: m[2] });
        at = m.index + m[0].length;
        continue;
      }
      const hit = bareAt(m);
      if (!hit) continue;
      words(m.index);
      out.push({ text: hit.text, href: hit.href });
      at = m.index + hit.text.length;
      BOTH.lastIndex = at;
    }
    words(src.length);
    return out;
  }

  // A link of Lex: opens in a new tab, the opened page gets no handle on ours.
  function anchor(text, href) {
    const a = document.createElement('a');
    a.className = 'lex-link';
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = text;
    return a;
  }

  // Puts the text into the node: words as text, addresses as links. words(t) may change the words
  // shown (a news takes the backslash off «\*»); the address itself is never changed.
  function into(node, text, words) {
    const shown = typeof words === 'function' ? words : (t) => t;
    for (const p of pieces(text)) {
      node.appendChild(p.href ? anchor(shown(p.text), p.href) : document.createTextNode(shown(p.text)));
    }
    return node;
  }

  global.LexLinks = { bare, pieces, anchor, into, trim };
})(typeof window !== 'undefined' ? window : globalThis);
