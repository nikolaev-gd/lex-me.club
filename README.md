# lex-me.club

Marketing and billing site for [Lex](https://chromewebstore.google.com/detail/lex/bfdbiphpcnjbofngcnjjdbnolcgaaidl),
a Chrome extension that turns a YouTube video you already want to watch into an
English lesson.

Plan and status: `docs/PLAN-PAYMENT-SITE.md` in the extension repo.

## Layout

```
copy.json          all page text, one object per language, identical keys
build.py           generates every page below from one template each
index.html         English   (generated)
ro/index.html      Romanian  (generated)
ru/index.html      Russian   (generated)
account/           the signed-in account page, per language (generated)
checkout/          the top-up page, per language (generated)
assets/site.css    shared styles
assets/lang.js     sends a visitor to their language by BROWSER LANGUAGE
assets/balance.js  the decorative balance tick on the pricing card
assets/auth.js     Supabase session: sign-in, refresh, balance and ledger reads
assets/checkout.js the top-up form — amount, consent, Polar checkout handoff
CNAME              custom domain for GitHub Pages
```

**Do not hand-edit any generated `index.html`** — not the three landing pages,
and not `account/` or `checkout/` in any language. They are all written by
`build.py` and a rebuild silently reverts anything edited by hand. Edit
`copy.json` (landing text), the `CHECKOUT` / `ACCOUNT` dicts in `build.py`
(their text), or the templates in `build.py` (structure), then rebuild:

```sh
python3 build.py
```

`build.py` refuses to build if the three languages do not have exactly the same
set of keys, so a version cannot silently lose a section.

This rule was learned the hard way. The checkout sign-in block was added
straight to the three `checkout/index.html` files without touching `build.py`,
along with the `auth.js` script tag and the $10–$200 amount bounds. The
generator kept producing pages without any of it, so the next rebuild would
have quietly deleted a shipped feature. If you find yourself editing generated
HTML, the change belongs in `build.py`.

### Two forms on the checkout page

`#checkout-form` (amount + consent) and `#co-signin-form` (inline sign-in) are
**siblings**, and must stay that way. HTML forbids nested forms: put one inside
the other and the parser drops the inner `<form>` start tag and lets its
`</form>` close the *outer* form instead. That leaves `#co-submit` outside
`#checkout-form`, so the submit handler `checkout.js` binds never fires — the
pay button goes completely dead, with no request and no console error. It
shipped that way and is why this warning exists.

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
