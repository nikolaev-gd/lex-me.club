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

import md

ROOT = pathlib.Path(__file__).parent
COPY = json.loads((ROOT / "copy.json").read_text(encoding="utf-8"))

# Legal pages. Sources are markdown under legal/ (English) and legal/<lang>/ for
# translations; each becomes its own directory so the URL has no .html in it.
LEGAL = [
    ("terms", "terms"),
    ("privacy", "privacy"),
    ("refunds", "refunds"),
    ("contact", "contact"),
]
LEGAL_TITLES = {
    "en": {"terms": "Terms and Conditions", "privacy": "Privacy Policy",
           "refunds": "Refund Policy", "contact": "Contact and company details"},
    "ro": {"terms": "Termeni și Condiții", "privacy": "Politica de confidențialitate",
           "refunds": "Politica de returnare", "contact": "Contacte și date de identificare"},
    "ru": {"terms": "Условия использования", "privacy": "Политика конфиденциальности",
           "refunds": "Условия возврата", "contact": "Контакты и реквизиты"},
}
LEGAL_NAV = {
    "en": {"terms": "Terms", "privacy": "Privacy", "refunds": "Refunds",
           "contact": "Contact", "home": "Home"},
    "ro": {"terms": "Termeni", "privacy": "Confidențialitate", "refunds": "Returnări",
           "contact": "Contacte", "home": "Acasă"},
    "ru": {"terms": "Условия", "privacy": "Конфиденциальность", "refunds": "Возвраты",
           "contact": "Контакты", "home": "На главную"},
}

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

# Redirect decision, inlined in <head> and synchronous, so it runs BEFORE the
# browser paints anything. With the script at the end of <body> a Russian
# visitor saw the whole English page render and only then get thrown to /ru/ —
# visible, slow and silly. Blocking here costs a fraction of a millisecond (no
# network, no parsing) and the wrong language is never painted at all.
# Only the English page carries it: /ro/ and /ru/ are deliberate destinations.
REDIRECT_HEAD = """<script>
(function(){try{
  if(localStorage.getItem('lexLangPick'))return;
  var l=(navigator.languages&&navigator.languages.length)?navigator.languages:[navigator.language||''];
  for(var i=0;i<l.length;i++){var t=String(l[i]||'').toLowerCase();
    if(t==='ru'||t.indexOf('ru-')===0){location.replace('/ru/');return;}
    if(t==='ro'||t.indexOf('ro-')===0||t==='mo'||t.indexOf('mo-')===0){location.replace('/ro/');return;}
    if(t==='en'||t.indexOf('en-')===0)return;
  }
}catch(e){}})();
</script>"""

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


# Account page. Short UI labels only — no legal prose — so they live here rather
# than in copy.json, which is the landing page's text.
ACCOUNT = {
    "en": {
        "title": "Your account", "signin": "Sign in", "signin_lead":
        "Sign in with the same account you use in the extension.",
        "email": "Email", "password": "Password", "submit": "Sign in",
        "bad": "Wrong email or password.",
        "no_account": "No account yet? Install the extension and create one there.",
        "install": "Get Lex for Chrome",
        "balance": "Balance", "topup": "Top up", "topup_soon":
        "Card payment is not connected yet. It is being set up.",
        "signout": "Sign out", "history": "History",
        "date": "Date", "what": "What", "amount": "Amount",
        "row_topup": "Top-up", "row_lesson": "Lessons", "empty": "Nothing yet.",
        "loading": "Loading…",
    },
    "ro": {
        "title": "Contul dumneavoastră", "signin": "Autentificare", "signin_lead":
        "Autentificați-vă cu același cont pe care îl folosiți în extensie.",
        "email": "E-mail", "password": "Parola", "submit": "Intră",
        "bad": "E-mail sau parolă greșită.",
        "no_account": "Nu aveți încă un cont? Instalați extensia și creați-l acolo.",
        "install": "Instalați Lex pentru Chrome",
        "balance": "Sold", "topup": "Alimentează", "topup_soon":
        "Plata cu cardul nu este încă activată. Este în curs de configurare.",
        "signout": "Ieșire", "history": "Istoric",
        "date": "Data", "what": "Operațiune", "amount": "Sumă",
        "row_topup": "Alimentare", "row_lesson": "Lecții", "empty": "Încă nimic.",
        "loading": "Se încarcă…",
    },
    "ru": {
        "title": "Ваш аккаунт", "signin": "Вход", "signin_lead":
        "Войдите тем же аккаунтом, которым пользуетесь в расширении.",
        "email": "Почта", "password": "Пароль", "submit": "Войти",
        "bad": "Неверная почта или пароль.",
        "no_account": "Ещё нет аккаунта? Установите расширение и создайте его там.",
        "install": "Установить Lex для Chrome",
        "balance": "Баланс", "topup": "Пополнить", "topup_soon":
        "Оплата картой пока не подключена, идёт настройка.",
        "signout": "Выйти", "history": "История",
        "date": "Дата", "what": "Операция", "amount": "Сумма",
        "row_topup": "Пополнение", "row_lesson": "Занятия", "empty": "Пока пусто.",
        "loading": "Загрузка…",
    },
}


def account_page(lang):
    a = {k: e(v) for k, v in ACCOUNT[lang].items()}
    c = {k: e(v) for k, v in COPY[lang].items()}
    nav = LEGAL_NAV[lang]

    # Only the strings auth.js needs at runtime, as JSON.
    runtime = json.dumps({
        "badLogin": ACCOUNT[lang]["bad"], "date": ACCOUNT[lang]["date"],
        "what": ACCOUNT[lang]["what"], "amount": ACCOUNT[lang]["amount"],
        "topup": ACCOUNT[lang]["row_topup"], "lesson": ACCOUNT[lang]["row_lesson"],
        "empty": ACCOUNT[lang]["empty"],
    }, ensure_ascii=False)

    return f"""<!DOCTYPE html>
<html lang="{lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{a['title']} — Lex</title>
<meta name="robots" content="noindex">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700;12..96,800&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/site.css">
</head>
<body>

<header>
  <div class="wrap nav">
    <a class="brand" href="{HREF[lang]}"><span class="dot"></span>Lex</a>
    <div class="nav-actions">
      <a href="{HREF[lang]}" class="btn btn-ghost">{nav['home']}</a>
      <button id="signout" class="btn btn-ghost" type="button">{a['signout']}</button>
    </div>
  </div>
</header>

<main class="doc">
  <div class="wrap acct-wrap">

    <div id="view-loading" class="acct-loading">{a['loading']}</div>

    <section id="view-signin" hidden>
      <h1>{a['signin']}</h1>
      <p class="acct-lead">{a['signin_lead']}</p>
      <form id="signin-form" class="acct-form" novalidate>
        <label for="signin-email">{a['email']}</label>
        <input id="signin-email" type="email" autocomplete="email" required>
        <label for="signin-password">{a['password']}</label>
        <input id="signin-password" type="password" autocomplete="current-password" required>
        <p id="signin-error" class="acct-error" hidden></p>
        <button id="signin-submit" class="btn btn-primary btn-lg" type="submit">{a['submit']}</button>
      </form>
      <p class="acct-note">{a['no_account']}
        <a href="{STORE_URL}" target="_blank" rel="noopener">{a['install']}</a>
      </p>
    </section>

    <section id="view-account" hidden>
      <h1>{a['title']}</h1>
      <p class="acct-lead" id="acct-email"></p>

      <div class="balance-card acct-card">
        <div class="bl">{a['balance']}</div>
        <div class="balance-amt" id="acct-balance">—</div>
        <div class="bctas">
          <a class="btn btn-topup" href="{HREF[lang]}checkout/">{a['topup']}</a>
        </div>
        <p class="acct-soon">{a['topup_soon']}</p>
      </div>

      <h2>{a['history']}</h2>
      <div id="ledger"></div>
    </section>

  </div>
</main>

<footer>
  <div class="wrap foot">
    <a class="brand" href="{HREF[lang]}"><span class="dot"></span>Lex</a>
    <div class="foot-links">{foot_links(lang)}</div>
    <div class="foot-copy">{c['foot_copy']}</div>
  </div>
</footer>

<script>window.LEX_ACCOUNT_TEXT = {runtime};</script>
<script src="/assets/config.js"></script>
<script src="/assets/auth.js"></script>
</body>
</html>
"""


CHECKOUT = {
    "en": {
        "title": "Top up your balance", "amount": "Amount, USD",
        "agree_terms": "I have read and accept the Terms and the Refund Policy.",
        # Civil Code art. 1065(1)(m): the withdrawal right is only lost if the
        # customer expressly consents to immediate performance AND acknowledges
        # losing it. Separate box, never pre-ticked (art. 1065(2)).
        "agree_now": "I ask you to start immediately and understand that I lose the 14-day right of withdrawal for the part of the balance I actually use.",
        # art. 1017(4): the order button must carry an unambiguous label.
        "pay": "Order with obligation to pay",
        "back": "Back to your account",
        "err_amount": "Enter an amount between $1 and $1000.",
        "err_agree": "Please tick both boxes.",
        "err_auth": "Please sign in first.",
        "no_provider": "Card payment is not connected yet. Your order was saved and nothing was charged.",
    },
    "ro": {
        "title": "Alimentați soldul", "amount": "Suma, USD",
        "agree_terms": "Am citit și accept Termenii și Politica de returnare.",
        "agree_now": "Solicit începerea imediată a prestării și înțeleg că pierd dreptul de revocare de 14 zile pentru partea din sold pe care o utilizez efectiv.",
        "pay": "Comandă cu obligație de plată",
        "back": "Înapoi la cont",
        "err_amount": "Introduceți o sumă între 1 și 1000 USD.",
        "err_agree": "Bifați ambele căsuțe.",
        "err_auth": "Autentificați-vă mai întâi.",
        "no_provider": "Plata cu cardul nu este încă activată. Comanda a fost salvată și nu s-a debitat nimic.",
    },
    "ru": {
        "title": "Пополнение баланса", "amount": "Сумма, USD",
        "agree_terms": "Я прочитал и принимаю Условия и Правила возврата.",
        "agree_now": "Прошу начать оказание услуги сразу и понимаю, что теряю право на отказ в течение 14 дней в части баланса, которую фактически израсходую.",
        "pay": "Заказ с обязательством оплаты",
        "back": "Вернуться в аккаунт",
        "err_amount": "Введите сумму от 1 до 1000 USD.",
        "err_agree": "Отметьте оба пункта.",
        "err_auth": "Сначала войдите в аккаунт.",
        "no_provider": "Оплата картой пока не подключена. Заказ сохранён, деньги не списаны.",
    },
}


def checkout_page(lang):
    k = {key: e(v) for key, v in CHECKOUT[lang].items()}
    c = {key: e(v) for key, v in COPY[lang].items()}
    nav = LEGAL_NAV[lang]
    runtime = json.dumps({
        key: CHECKOUT[lang][key]
        for key in ("err_amount", "err_agree", "err_auth", "no_provider")
    }, ensure_ascii=False)

    return f"""<!DOCTYPE html>
<html lang="{lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{k['title']} — Lex</title>
<meta name="robots" content="noindex">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700;12..96,800&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/site.css">
</head>
<body>

<header>
  <div class="wrap nav">
    <a class="brand" href="{HREF[lang]}"><span class="dot"></span>Lex</a>
    <div class="nav-actions">
      <a href="{HREF[lang]}account/" class="btn btn-ghost">{k['back']}</a>
    </div>
  </div>
</header>

<main class="doc">
  <div class="wrap acct-wrap">
    <h1>{k['title']}</h1>

    <form id="checkout-form" class="acct-form" novalidate>
      <label for="co-amount">{k['amount']}</label>
      <input id="co-amount" type="number" min="1" max="1000" step="1" value="10" inputmode="decimal" required>

      <label class="co-check">
        <input type="checkbox" id="co-terms">
        <span>{k['agree_terms']} <a href="{legal_href(lang, 'terms')}" target="_blank" rel="noopener">↗</a></span>
      </label>

      <label class="co-check">
        <input type="checkbox" id="co-now">
        <span>{k['agree_now']}</span>
      </label>

      <p id="co-error" class="acct-error" hidden></p>
      <button id="co-submit" class="btn btn-primary btn-lg" type="submit">{k['pay']}</button>
    </form>
  </div>
</main>

<footer>
  <div class="wrap foot">
    <a class="brand" href="{HREF[lang]}"><span class="dot"></span>Lex</a>
    <div class="foot-links">{foot_links(lang)}</div>
    <div class="foot-copy">{c['foot_copy']}</div>
  </div>
</footer>

<script>window.LEX_CHECKOUT_TEXT = {runtime};</script>
<script src="/assets/config.js"></script>
<script src="/assets/checkout.js"></script>
</body>
</html>
"""


def legal_href(lang, key):
    return f"{HREF[lang]}{key}/"


def foot_links(lang):
    nav = LEGAL_NAV[lang]
    parts = [
        f'<a href="{legal_href(lang, k)}">{nav[k]}</a>'
        for k in ("contact", "privacy", "terms", "refunds")
    ]
    return "\n      ".join(parts)


def legal_page(lang, key):
    """Render one legal document. Same shell as the landing, prose in the middle."""
    src = ROOT / "legal" / ("" if lang == "en" else lang) / f"{key}.md"
    if not src.exists():
        return None

    title = LEGAL_TITLES[lang][key]
    nav = LEGAL_NAV[lang]
    body = md.render(src.read_text(encoding="utf-8"))
    c = {k: e(v) for k, v in COPY[lang].items()}

    alts = "\n".join(
        f'<link rel="alternate" hreflang="{l}" href="https://lex-me.club{legal_href(l, key)}">'
        for l in LANGS
    )

    return f"""<!DOCTYPE html>
<html lang="{lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{e(title)} — Lex</title>
<meta name="robots" content="index, follow">
{alts}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700;12..96,800&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/site.css">
</head>
<body>

<header>
  <div class="wrap nav">
    <a class="brand" href="{HREF[lang]}"><span class="dot"></span>Lex</a>
    <div class="nav-actions">
      <a href="{HREF[lang]}" class="btn btn-ghost">{nav['home']}</a>
      <a href="{STORE_URL}" class="btn btn-primary" target="_blank" rel="noopener">{c['nav_install']}</a>
    </div>
  </div>
</header>

<main class="doc">
  <div class="wrap doc-wrap">
    <h1>{e(title)}</h1>
    {body}
  </div>
</main>

<footer>
  <div class="wrap foot">
    <a class="brand" href="{HREF[lang]}"><span class="dot"></span>Lex</a>
    <div class="foot-links">{foot_links(lang)}</div>
    <div class="foot-copy">{c['foot_copy']}</div>
  </div>
</footer>

</body>
</html>
"""


def page(lang):
    c = {k: e(v) for k, v in COPY[lang].items()}
    return f"""<!DOCTYPE html>
<html lang="{lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
{REDIRECT_HEAD if lang == 'en' else ''}
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
    <div class="foot-links">{foot_links(lang)}</div>
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

    missing = []
    for lang in LANGS:
        for key, _ in LEGAL:
            rendered = legal_page(lang, key)
            if rendered is None:
                missing.append(f"{lang}/{key}")
                continue
            d = ROOT / (legal_href(lang, key).strip("/"))
            d.mkdir(parents=True, exist_ok=True)
            (d / "index.html").write_text(rendered, encoding="utf-8")
            print(f"wrote {legal_href(lang, key)}index.html")

    for lang in LANGS:
        d = ROOT / (f"{HREF[lang].strip('/')}/account" if lang != "en" else "account")
        d.mkdir(parents=True, exist_ok=True)
        (d / "index.html").write_text(account_page(lang), encoding="utf-8")
        print(f"wrote {HREF[lang]}account/index.html")

        co = ROOT / (f"{HREF[lang].strip('/')}/checkout" if lang != "en" else "checkout")
        co.mkdir(parents=True, exist_ok=True)
        (co / "index.html").write_text(checkout_page(lang), encoding="utf-8")
        print(f"wrote {HREF[lang]}checkout/index.html")

    if missing:
        # Not fatal: the footer of every language links to these, so a missing
        # translation is a dead link and must be visible, not silent.
        print(f"\nMISSING legal sources (footer links will 404): {', '.join(missing)}")


if __name__ == "__main__":
    main()
