# lex-me.club

Marketing and billing site for [Lex](https://chromewebstore.google.com/detail/lex/bfdbiphpcnjbofngcnjjdbnolcgaaidl),
a Chrome extension that turns a YouTube video you already want to watch into an
English lesson.

Plan and status: `docs/PLAN-PAYMENT-SITE.md` in the extension repo.

## Layout

```
copy.json          all page text, one object per language, identical keys
build.py           generates the three pages from one template
index.html         English   (generated)
ro/index.html      Romanian  (generated)
ru/index.html      Russian   (generated)
assets/site.css    shared styles
assets/lang.js     sends a visitor to their language by BROWSER LANGUAGE
assets/balance.js  the decorative balance tick on the pricing card
CNAME              custom domain for GitHub Pages
```

**Do not hand-edit `index.html`, `ro/index.html` or `ru/index.html`** — they are
generated and will be overwritten. Edit `copy.json` (text) or `build.py`
(structure), then rebuild:

```sh
python3 build.py
```

`build.py` refuses to build if the three languages do not have exactly the same
set of keys, so a version cannot silently lose a section.

## Preview locally

```sh
python3 -m http.server 4173
# http://127.0.0.1:4173
```

Paths are root-relative, so opening the files directly with `file://` will not
load the CSS — use the server.

## Language routing

`assets/lang.js`, on the English root only, on a first visit:

| Browser language | Goes to |
|---|---|
| Russian | `/ru/` |
| Romanian / Moldovan | `/ro/` |
| anything else | stays on `/` (English) |

No IP lookup and no country detection — a static host cannot do that, and the
rule is deliberately about the language the person set in their own browser. A
manual pick in the header switcher is remembered and always wins.

## Romanian is not optional

Legea 284/2004 art. 12(1) requires a Moldovan seller to publish its identifying
details in Romanian, and Legea 105/2003 art. 33(7) requires contract terms in
Romanian. MAIB also reviews the site when processing the e-commerce merchant
application. English alone is not compliant.

## Deployment

GitHub Pages from `main`, custom domain via `CNAME`.
