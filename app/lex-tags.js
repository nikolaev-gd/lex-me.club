// lex-tags.js — HTML tags in the words a model writes. ONE rule for every surface that draws an answer of a
// model: the page and the program for the Mac (webchat/wc-markdown.js, which the chats of a person, a group and
// an order paint with too) and the extension (chat-surface.js, shared.js). The iPhone has the same rule in
// `LexTags.swift`; the examples of dev-tools/test-lex-tags.mjs hold for both.
//
// A model now and then writes HTML into Markdown: «1) …<br>2) …» inside a cell of a table, where Markdown has no
// way to break a line (23.11.2026, the chat of the group «внедрение ИИ Геннадий»: the cell showed «br» as words).
// So:
//   «<br>», «<br/>», «<br />», «</br>»  — a line break, in a paragraph, an item of a list and a cell of a table;
//   any other tag of the list TAGS     — taken away, its words stay («<b>да</b>» → «да»).
// Nothing is ever parsed as HTML: a surface builds a break node (or «<br>» of its own) and plain text, so a tag
// of a model can carry no attribute and no script into the page. A «<» that opens no tag of the list stays as it
// is («a < b», «<имя>», «<script>»: the last one is words, shown, never run). Code («`<br>`», a fenced block) is
// the renderer's own and stays literal: it is cut out before this rule reads the line.
(function (global) {
  'use strict';
  if (global.LexTags) return;

  // The tags of text a model writes. Latin names only, a whole name, then a space, «/» or «>».
  const TAGS = 'br|b|strong|i|em|u|s|strike|del|ins|mark|small|big|sub|sup|span|font|p|div|center|tt|kbd|nobr|wbr|hr|ul|ol|li';
  const RAW = new RegExp(`<\\/?(${TAGS})(?=[\\s/>])[^<>\\n]*>`, 'i');
  // The same tag in a line that was escaped already (chat-surface.js and shared.js escape first): «&lt;br /&gt;».
  const ESCAPED = new RegExp(`&lt;\\/?(${TAGS})(?=\\s|/|&gt;)(?:(?!&lt;|&gt;)[^<>\\n])*&gt;`, 'gi');

  // The first tag at `from` or after it: { index, length, br } or null.
  function find(text, from) {
    const src = String(text == null ? '' : text);
    const at = from > 0 ? from : 0;
    const m = RAW.exec(src.slice(at));
    if (!m) return null;
    return { index: at + m.index, length: m[0].length, br: m[1].toLowerCase() === 'br' };
  }

  // The text as pieces: { text } is words, { br: true } is a line break. Other tags are gone.
  function pieces(text) {
    const src = String(text == null ? '' : text);
    const out = [];
    let at = 0;
    for (let hit = find(src, 0); hit; hit = find(src, at)) {
      if (hit.index > at) out.push({ text: src.slice(at, hit.index) });
      if (hit.br) out.push({ br: true });
      at = hit.index + hit.length;
    }
    if (at < src.length) out.push({ text: src.slice(at) });
    return out;
  }

  // An escaped line of HTML with the tags turned: a break becomes «<br>», the others go.
  function escaped(line) {
    return String(line == null ? '' : line).replace(ESCAPED, (_m, name) => (name.toLowerCase() === 'br' ? '<br>' : ''));
  }

  global.LexTags = { find, pieces, escaped };
})(typeof self !== 'undefined' ? self : globalThis);
