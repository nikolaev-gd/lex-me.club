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

  // ── Inline ───────────────────────────────────────────────────────────────
  // Order matters: code first, so that `**` inside a span of code stays
  // literal; links before emphasis, so a title with an asterisk survives.
  const INLINE = [
    { re: /`([^`\n]+)`/, make: (m) => el('code', m[1]) },
    {
      re: /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/,
      make: (m) => {
        const a = el('a', m[1]);
        a.href = m[2];
        a.target = '_blank';
        // noopener is the one that matters (the opened page must not get a
        // handle on ours); noreferrer follows it as a matter of course.
        a.rel = 'noopener noreferrer';
        return a;
      },
    },
    { re: /\*\*([^*\n]+)\*\*/, make: (m) => el('strong', m[1]) },
    { re: /__([^_\n]+)__/, make: (m) => el('strong', m[1]) },
    { re: /(?<![\w*])\*([^*\n]+)\*(?![\w*])/, make: (m) => el('em', m[1]) },
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

  function para(tag, text) {
    const n = el(tag);
    inline(text, n);
    return n;
  }

  // ── Block ────────────────────────────────────────────────────────────────
  function render(src) {
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
      const fence = /^\s*```+\s*([\w+-]*)\s*$/.exec(line);
      if (fence) {
        flushParagraph(buf);
        const body = [];
        i++;
        while (i < lines.length && !/^\s*```+\s*$/.test(lines[i])) { body.push(lines[i]); i++; }
        i++; // the closing fence, or past the end
        const pre = el('pre');
        const code = el('code', body.join('\n'));
        if (fence[1]) code.className = 'language-' + fence[1];
        pre.append(code);
        frag.append(pre);
        continue;
      }

      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        flushParagraph(buf);
        frag.append(para('h' + Math.min(3, heading[1].length), heading[2]));
        i++;
        continue;
      }

      if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(line) && line.trim().length >= 3) {
        flushParagraph(buf);
        frag.append(el('hr'));
        i++;
        continue;
      }

      if (/^\s*>\s?/.test(line)) {
        flushParagraph(buf);
        const body = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) { body.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
        const q = el('blockquote');
        q.append(...Array.from(render(body.join('\n')).childNodes));
        frag.append(q);
        continue;
      }

      const bullet = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
      if (bullet) {
        flushParagraph(buf);
        const ordered = /\d/.test(bullet[2]);
        const list = el(ordered ? 'ol' : 'ul');
        while (i < lines.length) {
          const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
          if (!m || (/\d/.test(m[2]) !== ordered)) break;
          const item = [m[3]];
          i++;
          // Continuation lines: indented, and not the start of the next item.
          while (i < lines.length && /^\s{2,}\S/.test(lines[i])
                 && !/^(\s*)([-*+]|\d+[.)])\s+/.test(lines[i])) {
            item.push(lines[i].trim());
            i++;
          }
          list.append(para('li', item.join(' ')));
        }
        frag.append(list);
        continue;
      }

      // Pipe table. Needs its separator row to be a table at all, so a lone
      // pipe line stays a paragraph.
      if (line.indexOf('|') >= 0 && i + 1 < lines.length
          && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1]) && lines[i + 1].indexOf('-') >= 0) {
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
  function into(node, src) {
    node.replaceChildren(render(src));
  }

  global.WcMarkdown = { render, into };
})(typeof self !== 'undefined' ? self : globalThis);
