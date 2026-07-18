#!/usr/bin/env python3
"""fill.py — one-off: resolve the {{PLACEHOLDERS}} in the drafted legal pages.

The drafts were written to emit a literal placeholder wherever a fact was not
established, rather than invent one. This fills every placeholder that can be
answered from what Gennady has confirmed or from a safe, customer-favourable
default, strips the drafts' "NOTES FOR GENNADY" sections into notes.md, and
reports anything still unresolved instead of publishing a page with {{...}} in it.

    python3 legal/fill.py            # writes legal/*.md from /tmp/lex-legal/*.md
"""

import pathlib
import re
import sys

SRC = pathlib.Path("/tmp/lex-legal")
DST = pathlib.Path(__file__).parent

ADDRESS = "s. Congaz, str. Pionierii 5, Republica Moldova"
HOURS = "Monday to Friday, 09:00–18:00 (Chișinău time)"
DATE = "18 July 2026"

VAT = (
    "A.I. Ghenadi Nicolaev is **not registered as a VAT payer** in the Republic of "
    "Moldova. Turnover is below the registration threshold set by art. 112 of the "
    "Fiscal Code, so no VAT is charged and prices carry no VAT."
)

FILL = {
    # dates
    "EFFECTIVE_DATE": DATE,
    "LAST_UPDATED": DATE,
    "LAST_UPDATED_DATE": DATE,

    # seller
    "BUSINESS_ADDRESS": ADDRESS,
    "PHYSICAL_ADDRESS": ADDRESS,
    "VAT_CODE": "not applicable — not registered for VAT",
    "VAT_STATUS": VAT,
    "VAT_STATEMENT": VAT,
    "SUPPORT_HOURS": HOURS,
    "SUPPORT_LANGUAGES": "English, Romanian and Russian",
    "CONTRACT_LANGUAGES": "English, Romanian and Russian",

    # urls
    "TERMS_URL": "https://lex-me.club/terms/",
    "TERMS_EN_URL": "https://lex-me.club/terms/",
    "TERMS_RO_URL": "https://lex-me.club/ro/terms/",
    "PRIVACY_PAGE_URL": "https://lex-me.club/privacy/",
    "PRIVACY_POLICY_URL": "https://lex-me.club/privacy/",
    "RO_CONTACT_URL": "https://lex-me.club/ro/contact/",
    "TARIFF_PAGE_LINK": "https://lex-me.club/#install",
    "WITHDRAWAL_FORM_URL": "by email to nikolaev.gd@gmail.com",

    "LANGUAGE_STATEMENT": (
        "These Terms are published in Romanian at https://lex-me.club/ro/terms/ and in "
        "English at https://lex-me.club/terms/, and each version links to the other. The "
        "Romanian version is the one relied on in the Republic of Moldova. The contract "
        "can be concluded in either language (Legea nr. 284/2004 art. 12 alin. (1); Legea "
        "nr. 105/2003 art. 33 alin. (7); Civil Code art. 1015 alin. (7))."
    ),

    # payment — no provider connected yet, so nothing is named
    "PAYMENT_PROVIDER_NAME": "our payment provider",
    "ACCEPTED_CARD_TYPES": "the card types shown at checkout",
    "ACCEPTED_PAYMENT_METHODS": "payment card, on the payment provider's secure page",
    "PROVIDER_REFUND_TIMELINE": (
        "how quickly it then appears on your statement is up to your bank — usually a few "
        "business days"
    ),

    # commitments (chosen in the customer's favour; see notes.md)
    "REFUND_PROCESSING_DAYS": "14 days",
    "COMPLAINT_RESPONSE_DAYS": "3 business days",
    "BALANCE_VALIDITY": (
        "Your balance does not expire. It stays on your account until you spend it or ask "
        "for it back."
    ),
    "BALANCE_EXPIRY_STATEMENT": "The balance does not expire.",
    "BALANCE_ON_DELETION": (
        "If you ask us to delete your account while you still have an unspent balance, tell "
        "us and we will refund it before the account is deleted."
    ),
    "OFFER_VALIDITY_PERIOD": (
        "Prices are those shown on this site at the moment you place an order, and stay "
        "valid until we change them here."
    ),
    "TRANSFER_SAFEGUARD": (
        "The transfer is made because it is necessary in order to perform this contract with "
        "you, and with your consent (Legea nr. 133/2011 art. 32 alin. (5) lit. b) and lit. a))."
    ),
}

# Clauses the law only requires "where applicable", and which cannot be asserted
# without a fact nobody has established. Dropping the sentence is correct; making
# a claim about licensing or regulated professions is not.
DROP_LINE = ["AUTHORISATION_STATUS", "REGULATED_PROFESSION_STATUS", "EU_REPRESENTATIVE", "LEGAL_FORM_IN_FULL"]

NOTES_HEADING = re.compile(r"^##\s*NOTES FOR GENNADY.*$", re.I | re.M)


def main():
    if not SRC.exists():
        sys.exit(f"source drafts not found at {SRC}")

    notes = ["# Notes on the legal pages\n",
             f"Generated {DATE}. Everything below is either a decision taken on Gennady's",
             "behalf (say so if you disagree) or a fact still missing.\n"]
    unresolved = {}

    for f in sorted(SRC.glob("*.md")):
        text = f.read_text(encoding="utf-8")

        # Split off the drafts' own notes section — it is not for publication.
        m = NOTES_HEADING.search(text)
        if m:
            notes.append(f"\n## From the {f.stem} draft\n")
            notes.append(text[m.end():].strip())
            text = text[: m.start()].rstrip() + "\n"

        for key, value in FILL.items():
            text = text.replace("{{%s}}" % key, value)

        # Remove whole lines still carrying an unfillable placeholder.
        kept = []
        for line in text.split("\n"):
            if any(("{{%s}}" % k) in line for k in DROP_LINE):
                continue
            kept.append(line)
        text = "\n".join(kept)

        left = sorted(set(re.findall(r"\{\{[A-Z0-9_]+\}\}", text)))
        if left:
            unresolved[f.stem] = left

        (DST / f.name).write_text(text, encoding="utf-8")
        print(f"{f.stem:10} {len(text):>7} chars  unresolved: {', '.join(left) or 'none'}")

    (DST / "notes.md").write_text("\n".join(notes), encoding="utf-8")

    if unresolved:
        print("\nSTILL UNRESOLVED — do not publish until these are answered:")
        for k, v in unresolved.items():
            print(f"  {k}: {', '.join(v)}")
        sys.exit(1)
    print("\nall placeholders resolved")


if __name__ == "__main__":
    main()
