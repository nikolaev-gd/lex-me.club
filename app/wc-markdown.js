// webchat/wc-markdown.js — the subset of Markdown a teacher's answer actually
// contains, rendered to DOM nodes.
//
// It builds nodes, never an HTML string, so there is no path from model output
// to the HTML parser at all. That is the whole security argument, and it is why
// this is 200 lines instead of a dependency: a sanitiser has to be right about
// every attribute in the language, while a builder only has to be right about
// the tags it decides to create.
//
// It also has to survive being called on a half-written document: during a
// stream the text ends mid-word, mid-fence and mid-list on every frame. So no
// rule may depend on seeing a closing token — an unterminated ``` renders as a
// code block in progress, an unterminated ** renders as literal asterisks.
(function (global) {
  'use strict';

  const el = (tag, text) => {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    return n;
  };

  // ── Copy of a block of code (В7.81) ───────────────────────────────────────
  // A bar of no height at the top of the block, inside it: the button Copy at its right corner appears when the pointer
  // is over the block and stays in view while a long block is scrolled (`position: sticky`, wc-app.css) — one press from
  // any part of it. The text is the words of the block as they stand at the press (a stream redraws the block on every
  // frame). The bar holds no words, so selecting or copying the block by hand takes nothing extra.
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const COPY_MARK = ['M9 9h10v10H9z', 'M5 15V5h10'];
  const TICK_MARK = ['M4 12l5 5L20 6'];
  function mark(paths) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    for (const d of paths) {
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', d);
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', 'currentColor');
      p.setAttribute('stroke-width', '2');
      p.setAttribute('stroke-linecap', 'round');
      p.setAttribute('stroke-linejoin', 'round');
      svg.append(p);
    }
    return svg;
  }
  async function toClipboard(words) {
    const M = global.LexMessage;
    if (M && typeof M.copyText === 'function') return !!(await M.copyText(words));
    try { await global.navigator.clipboard.writeText(words); return true; } catch (_) { return false; }
  }
  function codeCopy(code) {
    const bar = el('span');
    bar.className = 'lex-code-bar';
    const b = el('button');
    b.type = 'button';
    b.className = 'lex-code-copy';
    b.title = 'Copy';
    b.setAttribute('aria-label', 'Copy the code');
    b.append(mark(COPY_MARK));
    let timer = null;
    b.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!(await toClipboard(code.textContent))) return;
      b.replaceChildren(mark(TICK_MARK));
      b.classList.add('is-copied');
      clearTimeout(timer);
      timer = setTimeout(() => { b.replaceChildren(mark(COPY_MARK)); b.classList.remove('is-copied'); }, 1500);
    });
    bar.append(b);
    return bar;
  }

  // ── Inline ───────────────────────────────────────────────────────────────
  // A link inside Lex (19.11.2026, the question «who is this»): lex://chat/<ref of a person> and lex://order/<number>.
  // It is drawn only where the caller asks for it (render(src, { lex: true })): the words of the agent «Кто это»
  // are the one place that writes such links. The anchor carries the place in data-lex-go and leads nowhere by
  // itself — the part that holds the words opens the place (LexMessage.whois, onGo).
  const LEX_GO = /^lex:\/\/((?:chat\/(?:p:[0-9a-f-]{36}|[gn]:(?:telegram|max|whatsapp):[^\s)]{1,80}))|(?:order\/[0-9]{1,18}))$/;
  let lexLinks = false;

  // Order matters: code first, so that `**` inside a span of code stays
  // literal; links before emphasis, so a title with an asterisk survives.
  const INLINE = [
    { re: /`([^`\n]+)`/, make: (m) => el('code', m[1]) },
    // An HTML tag a model wrote (lex-tags.js, one rule for every surface): «<br>» is a line break — in a cell of a
    // table too, where Markdown has none — any other tag of its list goes and leaves its words. Right after the
    // code, so «`<br>`» stays literal; nothing here is parsed as HTML.
    {
      re: { exec: (rest) => {
        const hit = global.LexTags ? global.LexTags.find(rest, 0) : null;
        return hit ? Object.assign([rest.slice(hit.index, hit.index + hit.length)], { index: hit.index, br: hit.br }) : null;
      } },
      make: (m) => (m.br ? el('br') : document.createTextNode('')),
    },
    {
      re: /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|lex:\/\/[^\s)]+)\)/,
      make: (m) => {
        const a = el('a', m[1]);
        a.className = 'lex-link';
        const go = m[2].startsWith('lex://') ? LEX_GO.exec(m[2]) : null;
        if (m[2].startsWith('lex://')) {
          // A place of Lex: only where asked and only a place that exists; anything else stays as the words say.
          if (!lexLinks || !go) return document.createTextNode(m[1]);
          a.href = m[2];
          a.dataset.lexGo = go[1];
          return a;
        }
        a.href = m[2];
        a.target = '_blank';
        // noopener is the one that matters (the opened page must not get a
        // handle on ours); noreferrer follows it as a matter of course.
        a.rel = 'noopener noreferrer';
        return a;
      },
    },
    // A bare address («https://…», «www.site.tld»): a link shown as it is written. The rule of where it starts
    // and ends is lex-links.js, one for every text of Lex; it stands after the code and «[caption](address)»
    // and before the emphasis, so an underscore inside an address is no italic.
    {
      re: { exec: (rest) => {
        const hit = global.LexLinks ? global.LexLinks.bare(rest) : null;
        return hit ? Object.assign([hit.text], { index: hit.index, href: hit.href }) : null;
      } },
      make: (m) => global.LexLinks.anchor(m[0], m.href),
    },
    // Bold and italic may hold each other — the teacher writes `*I **made**
    // dinner*` — so each takes the other's pair inside and renders its
    // content through inline() again. Without that the italic never matched
    // (its content hit the inner `**`) and its two stars stayed on screen.
    { re: /\*\*((?:[^*\n]|\*[^*\n]+\*)+)\*\*/, make: (m) => nest('strong', m[1]) },
    { re: /__([^_\n]+)__/, make: (m) => el('strong', m[1]) },
    { re: /(?<![\w*])\*((?:[^*\n]|\*\*[^*\n]+\*\*)+)\*(?![\w*])/, make: (m) => nest('em', m[1]) },
    { re: /(?<![\w_])_([^_\n]+)_(?![\w_])/, make: (m) => el('em', m[1]) },
    { re: /~~([^~\n]+)~~/, make: (m) => el('del', m[1]) },
  ];

  function inline(text, into) {
    let rest = String(text);
    while (rest) {
      let best = null;
      for (const rule of INLINE) {
        const m = rule.re.exec(rest);
        if (m && (!best || m.index < best.m.index)) best = { m, rule };
      }
      if (!best) { into.append(document.createTextNode(rest)); return; }
      if (best.m.index > 0) into.append(document.createTextNode(rest.slice(0, best.m.index)));
      into.append(best.rule.make(best.m));
      rest = rest.slice(best.m.index + best.m[0].length);
    }
  }

  function nest(tag, text) {
    const n = el(tag);
    inline(text, n);
    return n;
  }

  function para(tag, text) {
    const n = el(tag);
    inline(text, n);
    return n;
  }

  // ── Block ────────────────────────────────────────────────────────────────
  const FENCE = /^\s*```+\s*([\w+-]*)\s*$/;
  const HEADING = /^(#{1,6})\s+(.*)$/;
  const QUOTE = /^\s*>\s?/;
  const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const isRule = (line) => /^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(line) && line.trim().length >= 3;
  // Pipe table: needs its separator row to be a table at all, so a lone pipe line stays a paragraph.
  const isTable = (lines, i) => lines[i].indexOf('|') >= 0 && i + 1 < lines.length
    && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1]) && lines[i + 1].indexOf('-') >= 0;
  // A line that opens a block of its own: it never continues a list item. The table counts twice — by the rule of
  // this file (a pipe line over a separator row) and, as on the iPhone, by a leading pipe, so that a table still
  // coming in a stream (its separator row not yet there) does not first glue onto the item above it.
  const opensBlock = (lines, i) => FENCE.test(lines[i]) || HEADING.test(lines[i]) || isRule(lines[i])
    || QUOTE.test(lines[i]) || ITEM.test(lines[i]) || isTable(lines, i) || /^\s*\|/.test(lines[i]);

  function render(src, opts) {
    // The nested renderings (a quote) keep what the first call asked: the flag is set for the whole call.
    const before = lexLinks;
    if (opts && typeof opts.lex === 'boolean') lexLinks = opts.lex;
    try { return renderBlocks(src); } finally { lexLinks = before; }
  }

  function renderBlocks(src) {
    const frag = document.createDocumentFragment();
    const lines = String(src == null ? '' : src).split('\n');
    let i = 0;

    const flushParagraph = (buf) => {
      if (!buf.length) return;
      frag.append(para('p', buf.join('\n')));
      buf.length = 0;
    };

    const buf = [];

    while (i < lines.length) {
      const line = lines[i];

      // Fenced code. An unclosed fence swallows the rest — correct, because
      // that is exactly what the finished document will look like.
      const fence = FENCE.exec(line);
      if (fence) {
        flushParagraph(buf);
        const body = [];
        i++;
        while (i < lines.length && !/^\s*```+\s*$/.test(lines[i])) { body.push(lines[i]); i++; }
        i++; // the closing fence, or past the end
        const pre = el('pre');
        const code = el('code', body.join('\n'));
        if (fence[1]) code.className = 'language-' + fence[1];
        pre.append(codeCopy(code), code);
        frag.append(pre);
        continue;
      }

      const heading = HEADING.exec(line);
      if (heading) {
        flushParagraph(buf);
        frag.append(para('h' + Math.min(3, heading[1].length), heading[2]));
        i++;
        continue;
      }

      if (isRule(line)) {
        flushParagraph(buf);
        frag.append(el('hr'));
        i++;
        continue;
      }

      if (QUOTE.test(line)) {
        flushParagraph(buf);
        const body = [];
        while (i < lines.length && QUOTE.test(lines[i])) { body.push(lines[i].replace(QUOTE, '')); i++; }
        const q = el('blockquote');
        q.append(...Array.from(render(body.join('\n')).childNodes));
        frag.append(q);
        continue;
      }

      // A list. The same two rules as the iPhone (ios/Lex/Lex/LexMarkdown.swift) and CommonMark, ported here on
      // 22.11.2026: without them every item that had a line under it closed its own list, and each new <ol>
      // counted from one again — «1. … 1. … 1. …» in a reply of Lex, while the iPhone showed 1, 2, 3.
      const bullet = ITEM.exec(line);
      if (bullet) {
        flushParagraph(buf);
        const ordered = /\d/.test(bullet[2]);
        const list = el(ordered ? 'ol' : 'ul');
        // An ordered list counts from the number of its first item: «1. …», a paragraph, «2. …» shows 1, then 2.
        const first = ordered ? parseInt(bullet[2], 10) : 1;
        if (first !== 1) list.setAttribute('start', String(first));
        while (i < lines.length) {
          // An empty line BETWEEN items does not end the list when the very next line is an item of the same kind
          // (models part long items with one); before an ordinary paragraph it does, as before.
          if (!lines[i].trim()) {
            const next = i + 1 < lines.length ? ITEM.exec(lines[i + 1]) : null;
            if (!next || /\d/.test(next[2]) !== ordered) break;
            i++;
            continue;
          }
          const m = ITEM.exec(lines[i]);
          if (!m || (/\d/.test(m[2]) !== ordered)) break;
          const item = [m[3]];
          i++;
          // Continuation lines: ANY non-empty line right under the item that opens no block of its own — indented
          // or not (the «lazy» line of CommonMark: «1. было: …» with «стало: …» under it). A heading, a fence, a
          // quote, a rule, a table or the next item stays its own block. The lines join as the lines of a
          // paragraph do here, by a newline: where a paragraph breaks its lines, the item breaks them too.
          while (i < lines.length && lines[i].trim() && !opensBlock(lines, i)) {
            item.push(lines[i].trim());
            i++;
          }
          list.append(para('li', item.join('\n')));
        }
        frag.append(list);
        continue;
      }

      if (isTable(lines, i)) {
        flushParagraph(buf);
        const cells = (row) => row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
        const table = el('table');
        const thead = el('thead');
        const hr = el('tr');
        cells(line).forEach((c) => hr.append(para('th', c)));
        thead.append(hr);
        table.append(thead);
        i += 2;
        const tbody = el('tbody');
        while (i < lines.length && lines[i].indexOf('|') >= 0 && lines[i].trim()) {
          const tr = el('tr');
          cells(lines[i]).forEach((c) => tr.append(para('td', c)));
          tbody.append(tr);
          i++;
        }
        table.append(tbody);
        frag.append(table);
        continue;
      }

      if (!line.trim()) { flushParagraph(buf); i++; continue; }

      buf.push(line);
      i++;
    }

    flushParagraph(buf);
    return frag;
  }

  // Replace a node's children with the rendering of `src`. Used on every
  // stream frame, so it is deliberately a full re-render: patching a partially
  // written document in place is where a diffing renderer goes wrong (a fence
  // that opens on frame 40 changes the meaning of frames 1–39).
  function into(node, src, opts) {
    node.replaceChildren(render(src, opts));
  }

  global.WcMarkdown = { render, into };
})(typeof self !== 'undefined' ? self : globalThis);
