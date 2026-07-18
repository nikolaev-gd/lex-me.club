#!/usr/bin/env python3
"""md.py — the small slice of Markdown the legal pages actually use.

Deliberately not a general Markdown implementation and not a dependency: the
site ships as plain files with no build chain, and pulling in a library for four
documents would be the tail wagging the dog. Supported, because a survey of the
drafts says that is all they contain: ## / ### headings, paragraphs, - and 1.
lists, tables, ---, **bold**, *italic*, `code`, [links](...), and HTML comments
(which are dropped — the drafts use them for internal notes that must never be
published).

Anything outside that list is escaped and shown as plain text rather than
silently mangled.
"""

import html
import re

_COMMENT = re.compile(r"(?:&lt;|<)!--.*?--(?:&gt;|>)", re.S)


def _inline(s):
    """Escape, then re-introduce the few inline constructs, in a safe order."""
    s = html.escape(s, quote=False)
    # links first, so their text can still carry bold/code
    s = re.sub(
        r"\[([^\]]+)\]\((https?://[^\s)]+|/[^\s)]*)\)",
        lambda m: f'<a href="{html.escape(m.group(2), quote=True)}">{m.group(1)}</a>',
        s,
    )
    # bare urls that were not already turned into links
    s = re.sub(
        r"(?<!href=\")(?<!>)(https?://[^\s<>\"]+)(?![^<]*</a>)",
        lambda m: f'<a href="{html.escape(m.group(1), quote=True)}">{m.group(1)}</a>',
        s,
    )
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    s = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"(?<!\*)\*([^*\n]+)\*(?!\*)", r"<em>\1</em>", s)
    return s


def _table(rows):
    """rows: list of raw '| a | b |' lines, second one being the ---|--- rule."""
    def cells(line):
        line = line.strip()
        if line.startswith("|"):
            line = line[1:]
        if line.endswith("|"):
            line = line[:-1]
        return [c.strip() for c in line.split("|")]

    head = cells(rows[0])
    body = [cells(r) for r in rows[2:]] if len(rows) > 2 else []

    out = ['<div class="table-scroll"><table>', "<thead><tr>"]
    out += [f"<th>{_inline(c)}</th>" for c in head]
    out.append("</tr></thead><tbody>")
    for r in body:
        out.append("<tr>" + "".join(f"<td>{_inline(c)}</td>" for c in r) + "</tr>")
    out.append("</tbody></table></div>")
    return "".join(out)


def render(text):
    text = _COMMENT.sub("", text)
    lines = text.split("\n")
    out = []
    para = []
    list_items = []
    list_kind = None
    table = []

    def flush_para():
        if para:
            out.append(f"<p>{_inline(' '.join(para).strip())}</p>")
            para.clear()

    def flush_list():
        nonlocal list_kind
        if list_items:
            tag = "ol" if list_kind == "ol" else "ul"
            out.append(f"<{tag}>" + "".join(f"<li>{_inline(i)}</li>" for i in list_items) + f"</{tag}>")
            list_items.clear()
        list_kind = None

    def flush_table():
        if table:
            out.append(_table(table))
            table.clear()

    def flush_all():
        flush_para()
        flush_list()
        flush_table()

    for raw in lines:
        line = raw.rstrip()

        if line.lstrip().startswith("|"):
            flush_para()
            flush_list()
            table.append(line)
            continue
        flush_table()

        if not line.strip():
            flush_para()
            flush_list()
            continue

        m = re.match(r"^(#{2,4})\s+(.*)$", line)
        if m:
            flush_all()
            level = len(m.group(1))
            out.append(f"<h{level}>{_inline(m.group(2))}</h{level}>")
            continue

        if re.match(r"^-{3,}\s*$", line):
            flush_all()
            out.append("<hr>")
            continue

        m = re.match(r"^[-*]\s+(.*)$", line)
        if m:
            flush_para()
            if list_kind == "ol":
                flush_list()
            list_kind = "ul"
            list_items.append(m.group(1))
            continue

        m = re.match(r"^\d+\.\s+(.*)$", line)
        if m:
            flush_para()
            if list_kind == "ul":
                flush_list()
            list_kind = "ol"
            list_items.append(m.group(1))
            continue

        flush_list()
        para.append(line.strip())

    flush_all()
    return "\n".join(out)
