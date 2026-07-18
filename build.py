#!/usr/bin/env python3
"""build.py — generate the three language pages from one template.

Copy lives in copy.json (one object per language, identical keys). Structure
lives here. Doing it this way means a layout change lands on all three pages at
once and the versions cannot silently drift apart — which is the thing that
actually goes wrong on multilingual sites.

    python3 build.py

Writes: index.html (en), ro/index.html, ru/index.html
"""

import html
import json
import pathlib

ROOT = pathlib.Path(__file__).parent
COPY = json.loads((ROOT / "copy.json").read_text(encoding="utf-8"))

STORE_URL = "https://chromewebstore.google.com/detail/lex/bfdbiphpcnjbofngcnjjdbnolcgaaidl"

# The demo subtitle line stays English in every version: it is a sample of the
# English subtitles Lex builds. Marked words are the phrasal verb being taught.
SUB_LINE = [
    ("She", 0), ("kept", 0), ("putting", 1), ("it", 1), ("off", 1),
    ("until", 0), ("the", 0), ("deadline", 0), ("was", 0),
    ("breathing", 0), ("down", 0), ("her", 0), ("neck", 0),
]

# Drawn mockups of Lex's own interface, in place of real screenshots. A real
# capture would put a frame of somebody else's YouTube video on a commercial
# page — every video in the test set is a copyrighted clip, most of them
# political. These are pure CSS, carry no third-party content, and get replaced
# with real captures once Gennady supplies a video we are free to show.
# Sample sentences below are invented for the mockup, not taken from any video.
WAVE = "".join(
    f'<i style="height:{h}%"></i>' for h in
    [28, 52, 88, 44, 70, 96, 36, 60, 82, 30, 48, 74, 92, 40, 26, 56, 78, 34]
)

MOCKS = {
    "en": [
        f"""<div class="mock-label">Subtitles by Lex</div>
        <div class="mock-line">And that is roughly where the whole idea came from.</div>
        <div class="mock-line on">She kept <span class="mark">putting it off</span> until the deadline was breathing down her neck.</div>
        <div class="mock-line">By then there was no clean way out of it.</div>
        <div class="mock-line">So we did the only thing that was left.</div>""",

        f"""<div class="mock-label">Lex</div>
        <div class="mock-bubble">What does “breathing down her neck” mean here?</div>
        <div class="mock-answer">It is pressure that is close and constant — the deadline is not far off any more, it is right behind her. Same shape as <span class="mark">running out of time</span>, but it puts a person or a date at your shoulder.</div>""",

        f"""<div class="mock-label">Voice</div>
        <div class="mock-answer">Try saying it back to me — when did you last put something off?</div>
        <div class="mock-spacer"></div>
        <div class="mock-voice"><span class="mock-dot"></span><span class="mock-wave">{WAVE}</span><span class="mock-live">LIVE</span></div>""",
    ],
}
# Romanian and Russian reuse the same drawn interface: the subtitles and the
# teacher's reply are English because that is what is being learned.
MOCKS["ro"] = MOCKS["en"]
MOCKS["ru"] = MOCKS["en"]

LANGS = ["en", "ro", "ru"]
OUT = {"en": "index.html", "ro": "ro/index.html", "ru": "ru/index.html"}
HREF = {"en": "/", "ro": "/ro/", "ru": "/ru/"}
LABEL = {"en": "EN", "ro": "RO", "ru": "RU"}
TITLE_ATTR = {"en": "English", "ro": "Română", "ru": "Русский"}


def e(s):
    """Escape for HTML text/attribute content, keeping typographic quotes."""
    return html.escape(str(s), quote=True)


def sub_line_html():
    parts = []
    for word, marked in SUB_LINE:
        cls = "w mark" if marked else "w plain"
        parts.append(f'<span class="{cls}">{e(word)}</span>')
    return " ".join(parts) + "."


def lang_switch(current):
    """Two options at most: this page's language and English. Never three.

    On /ro/ and /ru/ the pair is fixed, so it is rendered here. On the English
    page there is nothing to offer a genuinely English-speaking visitor, so an
    empty slot is left and lang.js fills it only for someone whose browser is
    Russian or Romanian (or who switched to English by hand).
    """
    if current == "en":
        return '<span data-lang-slot></span>'

    out = ['<nav class="lang-switch" aria-label="Language">']
    for lang in (current, "en"):
        active = " is-active" if lang == current else ""
        aria = ' aria-current="true"' if lang == current else ""
        out.append(
            f'<a class="lang-opt{active}" href="{HREF[lang]}" hreflang="{lang}" '
            f'title="{TITLE_ATTR[lang]}"{aria}>{LABEL[lang]}</a>'
        )
    out.append("</nav>")
    return "\n        ".join(out)


def alternates():
    rows = [
        f'<link rel="alternate" hreflang="{lang}" href="https://lex-me.club{HREF[lang]}">'
        for lang in LANGS
    ]
    rows.append('<link rel="alternate" hreflang="x-default" href="https://lex-me.club/">')
    return "\n".join(rows)


def page(lang):
    c = {k: e(v) for k, v in COPY[lang].items()}
    return f"""<!DOCTYPE html>
<html lang="{lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{c['page_title']}</title>
<meta name="description" content="{c['meta_description']}">
{alternates()}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700;12..96,800&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/site.css">
</head>
<body>

<header>
  <div class="wrap nav">
    <div class="brand"><span class="dot"></span>Lex</div>
    <div class="nav-actions">
      {lang_switch(lang)}
      <a href="#login" class="btn btn-ghost">{c['nav_login']}</a>
      <a href="{STORE_URL}" class="btn btn-primary" target="_blank" rel="noopener">{c['nav_install']}</a>
    </div>
  </div>
</header>

<div class="hero">
  <div class="wrap hero-grid">
    <div class="hero-copy">
      <span class="eyebrow">{c['hero_eyebrow']}</span>
      <h1>{c['hero_h1_plain']}<span class="hl">{c['hero_h1_highlight']}</span></h1>
      <p class="lead">{c['hero_lead']}</p>
      <div class="hero-cta">
        <a href="{STORE_URL}" class="btn btn-primary btn-lg" target="_blank" rel="noopener">{c['hero_cta_primary']}</a>
        <a href="#how" class="btn btn-ghost btn-lg">{c['hero_cta_ghost']}</a>
      </div>
      <div class="note"><span class="chrome-dot"></span>{c['hero_note']}</div>
    </div>

    <div class="demo">
      <div class="browser">
        <div class="browser-bar">
          <div class="dots"><i></i><i></i><i></i></div>
          <div class="url"><span class="lock"></span>youtube.com/watch</div>
          <div class="lex-chip"><span class="dot"></span>Lex</div>
        </div>
        <div class="screen">
          <div class="play"></div>
          <div class="frame-glow"></div>
        </div>
        <div class="subs">
          <div class="popover">
            <div class="pw">{c['demo_pop_word']} <span class="tag">{c['demo_pop_tag']}</span></div>
            <div class="tr">{c['demo_pop_gloss']}</div>
            <div class="ex">{c['demo_pop_example']}</div>
          </div>
          <div class="sub-label">{c['demo_sub_label']}</div>
          <div class="sub-line">{sub_line_html()}</div>
        </div>
      </div>
    </div>
  </div>
</div>

<div class="band">
  <div class="wrap">
    <h2>{c['band_h2_plain']}<span class="hl">{c['band_h2_highlight']}</span></h2>
    <p class="sub">{c['band_sub']}</p>
  </div>
</div>

<section id="how">
  <div class="wrap">
    <div class="kicker">{c['how_kicker']}</div>
    <h2 class="sec-title">{c['how_title']}</h2>
    <div class="steps">
      <div class="step">
        <span class="num">01</span>
        <h3>{c['how_s1_h']}</h3>
        <p>{c['how_s1_p']}</p>
      </div>
      <div class="step">
        <span class="num">02</span>
        <h3>{c['how_s2_h']}</h3>
        <p>{c['how_s2_p']}</p>
      </div>
      <div class="step">
        <span class="num">03</span>
        <h3>{c['how_s3_h']}</h3>
        <p>{c['how_s3_p']}</p>
      </div>
    </div>
  </div>
</section>

<section style="padding-top:0">
  <div class="wrap">
    <div class="kicker">{c['shots_kicker']}</div>
    <h2 class="sec-title">{c['shots_title']}</h2>
    <div class="shots">
      <div class="shot">
        <div class="mock">{MOCKS[lang][0]}</div>
        <div class="cap"><h3>{c['shot1_h']}</h3><p>{c['shot1_p']}</p></div>
      </div>
      <div class="shot">
        <div class="mock">{MOCKS[lang][1]}</div>
        <div class="cap"><h3>{c['shot2_h']}</h3><p>{c['shot2_p']}</p></div>
      </div>
      <div class="shot">
        <div class="mock">{MOCKS[lang][2]}</div>
        <div class="cap"><h3>{c['shot3_h']}</h3><p>{c['shot3_p']}</p></div>
      </div>
    </div>
  </div>
</section>

<section class="teacher">
  <div class="wrap">
    <div class="kicker">{c['teacher_kicker']}</div>
    <h2 class="sec-title">{c['teacher_title']}</h2>
    <div class="compare">
      <div class="col-lex-wrap">
        <div class="col-head col-lex"><span class="dot"></span>{c['cmp_head_lex']}</div>
        <div class="crow"><div class="rl">{c['cmp_l1_label']}</div>{c['cmp_l1_lex']}</div>
        <div class="crow"><div class="rl">{c['cmp_l2_label']}</div>{c['cmp_l2_lex']}</div>
        <div class="crow"><div class="rl">{c['cmp_l3_label']}</div>{c['cmp_l3_lex']}</div>
        <div class="crow"><div class="rl">{c['cmp_l4_label']}</div>{c['cmp_l4_lex']}</div>
      </div>
      <div class="col-tut-wrap">
        <div class="col-head col-tut">{c['cmp_head_tutor']}</div>
        <div class="crow">{c['cmp_l1_tutor']}</div>
        <div class="crow">{c['cmp_l2_tutor']}</div>
        <div class="crow">{c['cmp_l3_tutor']}</div>
        <div class="crow">{c['cmp_l4_tutor']}</div>
      </div>
    </div>
    <p class="caveat">{c['teacher_caveat']}</p>
  </div>
</section>

<section class="money" id="install">
  <div class="wrap money-grid">
    <div>
      <div class="kicker">{c['money_kicker']}</div>
      <h2>{c['money_h2']}</h2>
      <p class="mlead">{c['money_lead']}</p>
      <ul>
        <li><span class="ck">&#10003;</span> {c['money_li1']}</li>
        <li><span class="ck">&#10003;</span> {c['money_li2']}</li>
        <li><span class="ck">&#10003;</span> {c['money_li3']}</li>
        <li><span class="ck">&#10003;</span> {c['money_li4']}</li>
      </ul>
    </div>
    <div class="balance-card">
      <div class="bl">{c['balance_label']}</div>
      <div class="balance-amt"><span class="cur">$</span><span id="bal">10.00</span></div>
      <div class="balance-sub">{c['balance_sub']}</div>
      <div class="bctas">
        <a href="#topup" class="btn btn-topup">{c['balance_cta_topup']}</a>
        <a href="#login" class="btn btn-ghost" style="color:var(--video-text);border-color:var(--video-line)">{c['balance_cta_login']}</a>
      </div>
    </div>
  </div>
</section>

<section class="final" id="login">
  <div class="wrap">
    <h2>{c['final_h2_plain']}<span class="hl">{c['final_h2_highlight']}</span></h2>
    <p class="fsub">{c['final_sub']}</p>
    <div class="final-cta">
      <a href="{STORE_URL}" class="btn btn-onink btn-lg" target="_blank" rel="noopener">{c['final_cta_primary']}</a>
      <a href="#login" class="btn btn-onink-ghost btn-lg">{c['final_cta_ghost']}</a>
    </div>
  </div>
</section>

<footer>
  <div class="wrap foot">
    <div class="brand"><span class="dot"></span>Lex</div>
    <div class="foot-links">
      <a href="#">{c['foot_support']}</a>
      <a href="#">{c['foot_privacy']}</a>
      <a href="#">{c['foot_terms']}</a>
    </div>
    <div class="foot-copy">{c['foot_copy']}</div>
  </div>
</footer>

<script src="/assets/lang.js"></script>
<script src="/assets/balance.js"></script>
</body>
</html>
"""


def main():
    keys = set(COPY["en"])
    for lang in LANGS:
        missing = keys - set(COPY[lang])
        extra = set(COPY[lang]) - keys
        if missing or extra:
            raise SystemExit(f"copy.json[{lang}] key mismatch: missing={sorted(missing)} extra={sorted(extra)}")

    for lang in LANGS:
        out = ROOT / OUT[lang]
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(page(lang), encoding="utf-8")
        print(f"wrote {OUT[lang]} ({len(COPY[lang])} slots)")


if __name__ == "__main__":
    main()
