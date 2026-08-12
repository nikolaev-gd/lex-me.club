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
assets/pay/       maib and card-scheme logos for the footer — see below
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

To see the dark theme, switch macOS between light and dark, or emulate it in
DevTools: ⌘⇧P → "Show Rendering" → *Emulate CSS media feature
prefers-color-scheme*.

## Dark theme follows the system

There is no switcher, deliberately: the browser already knows what the visitor
wants, a static host cannot remember a choice without shipping JavaScript to
every page, and one media query needs no markup at all — so the dark theme lives
entirely in `assets/site.css` and no generated page had to be rebuilt for it.

Every colour is a token in `:root`, and the block at the bottom of the file
swaps the tokens. **A new rule with a raw hex in it is the one thing that breaks
dark mode** — reach for a token, and add one if none fits.

Two things are not inverted, and should not be: the yellow highlighter keeps
dark text on it (`--ink-fixed`) because it is the brand mark rather than a
colour of the theme, and the ink bands become an elevated dark slab instead of
flipping to white mid-page.

The card-scheme marks in the footer are dark ink on transparency — the Visa
wordmark is `#1A1F71` — so in dark mode each one gets a small white chip. A CSS
filter would have been shorter, but it recolours a scheme-supplied mark, which
is exactly what a merchant review catches, and the marks have to stay visible:
they tell a visitor which cards will actually go through, and maib's own rules
require them if the bank is switched back on (see the footer section below).

Contrast was checked by walking every text node on all 25 pages in both themes
and comparing it against its effective background. That is what caught a live
bug nobody had noticed: `.doc a` outweighs `.btn-primary` on specificity, so the
"go to your account" button on the post-payment page was drawing `#3A2CE0` text
on its own `#4B3BFF` background, underlined. Hence `.doc a:not(.btn)`.

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

## The logos in the footer are a bank requirement

MAIB requires the maib logo and the logos of the international payment systems
to be shown on the site, and recommends the footer:
<https://docs.maibmerchants.md/main/en/integration/requirements>. The files in
`assets/pay/` come from the official archive linked on that page — replacing
them with images found elsewhere is what a review catches.

`assets/pay/amex.png` ships from the same archive but is deliberately not
displayed: the merchant contract has to actually accept American Express before
its logo goes up, because a logo in the footer reads as a promise that the card
will work. To show it, add it to `PAY_LOGOS` in `build.py` and rebuild.

## Romanian is not optional

Legea 284/2004 art. 12(1) requires a Moldovan seller to publish its identifying
details in Romanian, and Legea 105/2003 art. 33(7) requires contract terms in
Romanian. MAIB also reviews the site when processing the e-commerce merchant
application. English alone is not compliant.

## Deployment

GitHub Pages from `main`, custom domain via `CNAME`.
