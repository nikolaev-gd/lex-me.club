# Notes on the legal pages

Generated 18 July 2026. Everything below is either a decision taken on Gennady's
behalf (say so if you disagree) or a fact still missing.


## From the contact draft

**Placeholders — every one of them must be replaced before this page goes live.**

1. **`{{LEGAL_FORM_IN_FULL}}`** — copy the legal form exactly as it appears on your state registration certificate and spell it out, e.g. "Întreprinzător Individual (Î.I.)". Do not publish the bare abbreviation "A.I." — neither a customer nor a regulator can tell what legal form it denotes, and I would not guess it.

2. **`{{PHYSICAL_ADDRESS}}`** — the address where you actually carry on the activity, and to which complaints can be sent. Civil Code art. 1015 alin. (1) lit. d) requires it as a separate item from the legal address, and MAIB's Contact template lists "Adresa juridică" and "Adresa fizică" as two distinct fields. Write it out in full even if it is identical to the legal address.

3. **`{{VAT_CODE}}` and `{{VAT_STATEMENT}}`** — your TVA registration code, required by Legea 284/2004 art. 12(1) lit. f). If you are not VAT-registered, do not leave the row empty and do not delete it: write "Not registered for VAT". Then set `{{VAT_STATEMENT}}` to exactly one of: "we are registered for VAT in the Republic of Moldova and the applicable VAT is included in the amounts shown" / "we are not registered for VAT, so no Moldovan VAT is charged or added". Check with your accountant first — this must match what your invoices say.

4. **`{{AUTHORISATION_STATUS}}`** — art. 12(1) lit. d): number and validity of any licence your activity requires, plus the issuing authority. If none is required, write "None required for this activity".

5. **`{{REGULATED_PROFESSION_STATUS}}`** — art. 12(1) lit. e), same logic. If not applicable, write "Not a regulated profession".

6. **`{{SUPPORT_HOURS}}`** — e.g. "Monday to Friday, 09:00–18:00 (Chișinău time)". MAIB's e-commerce conditions (Anexa nr.1, pct. 1.8) require support to run **at least five days a week** and the hours to be published. Pick a window you will honour — the 3-business-day reply promise on the page is the Chrome Web Store requirement and you must be able to meet it.

7. **`{{SUPPORT_LANGUAGES}}`** — I removed the flat "English, Romanian or Russian" claim because I could not verify you will answer in Romanian. List only languages you will actually reply in. Note that if you list Romanian you should also have the Romanian Terms live.

8. **`{{TARIFF_PAGE_LINK}}`** — the page with current usage rates. The law does not let you stay silent on price just because it is variable: Civil Code art. 1015(1)(e) and Legea 284/2004 art. 12(1) lit. g)/h) require the method of calculation and the tariffs where a total cannot be pre-computed. The extension already shows a running balance and a per-call cost, so the mechanism is real — the missing piece is a published rates page.

9. **`{{BALANCE_EXPIRY_STATEMENT}}`** — either "Your balance does not expire." or the exact expiry rule you choose. Decide before publishing, and decide at the same time what happens to a positive balance when an account is deleted; the refund promise on this page has to match reality.

10. **`{{OFFER_VALIDITY_PERIOD}}`** — a real, measurable period (e.g. "30 days"), because art. 12(1) lit. l) asks for a validity period. I removed the old wording ("apply while they are displayed here") — it was circular — and I also removed the promise that a change "never affects a balance you have already paid for". That promise is not true as stated: raising usage rates does reduce what an already-paid balance buys. The replacement text commits you instead to advance notice by email plus a refund option. Confirm you accept that commitment.

11. **`{{ACCEPTED_PAYMENT_METHODS}}`** — the exact card schemes and methods your provider enables. Civil Code art. 1017 alin. (5) requires accepted payment means and any delivery restriction to be stated at the latest at the start of the order process; if you contract with maib, pct. 3.2.5 requires the same.

12. **`{{REFUND_PROCESSING_DAYS}}`** — MAIB's T&C template has a mandatory field "Termenul de procesare a cererii de retur: X zile". Pick a number you will honour. Note the statutory 14-day reimbursement deadline for withdrawal is already stated separately and is not negotiable.

13. **`{{PRIVACY_POLICY_URL}}`, `{{TERMS_URL}}`, `{{RO_CONTACT_URL}}`** — do not publish those sentences until the pages exist at stable URLs. They are compliance claims; making them while the document is missing is worse than omitting them.

14. **`{{CONTRACT_LANGUAGES}}`** — required by art. 21(3) lit. d). Don't list a language you don't have a Terms page in.

15. **`{{LAST_UPDATED_DATE}}`** — the date you publish.

**Substantive changes I made, and why they need your decision:**

- **The 14-day right of withdrawal was missing entirely and is now on the page.** This is not optional. Lex is digital content supplied without a tangible medium under a distance contract, so Civil Code art. 1059 and art. 1060 alin. (1) lit. f) give the buyer 14 days from the day the contract is concluded. The sanction for not disclosing it is severe: art. 1061 alin. (1) extends the window to 12 months plus 14 days for every customer. The previous page offered only your commercial refund of unspent balance, which is narrower and does not substitute.

- **The checkout must be built to match.** Your policy (spent balance is not refundable) is only enforceable if the checkout takes (a) express consent to start the service immediately and (b) a separate confirmation that the buyer thereby loses the withdrawal right for the part performed — art. 1065 alin. (1) lit. m). Neither may be a pre-ticked box (art. 1065 alin. (2)), and the confirmation must be repeated in the confirmation email (art. 1017 alin. (9) lit. b)). **Until the checkout does this, a customer can take lessons for 13 days and still demand a full refund.** This is the single most important item on this list.

- **"The amount you pay is the amount credited to your balance" was removed.** It was invented. A Merchant of Record (Polar.sh) adds the buyer's local consumption tax on top of the selected amount at checkout, and on the MAIB path the issuing bank's conversion terms apply when the card currency is not USD. Either way the charged amount can exceed the credited amount. The new wording is provider-neutral and honest about both.

- **"Whether VAT applies is shown by the VAT code above" was removed.** Your own TVA registration status does not tell a buyer whether tax is included in a price, and art. 12(1) lit. h) requires an express statement of whether taxes are included. Under art. 1015(6), tax and additional costs you fail to disclose cannot be charged to the consumer.

- **The claim that the table covers "lit. a) to m)" was corrected to a)–f).** The table only ever carried a)–f); the rest lives further down. Asserting fuller compliance than you have is exactly what art. 12 alin. (3) makes you liable for, and it invites a regulator to check.

- **Added:** the ISSPNPC postal address (Legea 105/2003 art. 33(13) requires the address, not just the phone); a data-protection section naming the CNPDCP (Lex sends chat text, subtitle transcripts, microphone audio and pronunciation recordings to OpenAI, Anthropic, Google, Groq and SpeechAce, so a large share of realistic complaints are data complaints, and ISSPNPC is not the authority for those); a complaints procedure and complaints address (art. 1015(1) lit. d) and g)); contract duration and how to end it (lit. o) and p)); the durable-medium confirmation and contract-storage statements (art. 21(3) lit. a)–d), Civil Code art. 1017(9)); accepted payment means (art. 1017(5)); the negative statement on codes of conduct (lit. n)); the negative statement on out-of-court dispute resolution (lit. t)); the in-extension paid-actions disclosure (art. 1017(13)); the advance-payment disclosure (lit. q)); fax and contact-person rows (lit. c)); and a "last updated" date.

- **Verify the in-extension paragraph against actual behaviour before publishing.** I wrote that no amount leaves the balance without an action you take yourself. If any debit happens without an explicit user action, that sentence has to change.

**Two things this page cannot fix on its own:**

- **A Romanian version is legally mandatory.** Legea 284/2004 art. 12(1) requires this information to be accessible in Romanian, with other languages allowed only in addition; Legea 105/2003 art. 33(7) and Civil Code art. 1015(7) say the same about consumer information and the contract. This English page is the "in addition" one. The Romanian version must be live at the same time and should be what a Moldovan visitor and a regulator land on by default. Browser auto-translation does not satisfy the requirement. I have put the cross-link line at the top of the page — add the mirror line on the Romanian page.

- **Payment provider is not connected yet.** The payment section is deliberately provider-neutral: it does not name Polar.sh or maib and does not claim any provider is live. Revisit it once one is connected. If you go with MAIB, their documents additionally require: maib and international payment scheme logos on the site (docs checklist item "Afișare logo-uri maib și SIP" — required; footer placement only recommended); display of the 3-D Secure programme marks Verified by Visa, MasterCard SecureCode and American Express SafeKey, coordinated with the bank beforehand (pct. 3.2.4 — note this clause is about the 3-D Secure marks, *not* the maib logo); express listing of accepted card types (pct. 3.2.5); a mandatory T&C acceptance checkbox at checkout; a physical address as a field separate from the legal address (their Contact template, section 7); and prior coordination with the bank on the checkout design (pct. 3.2.25).

**Before publishing, re-verify the article numbers.** Only art. 12 alin. (1) lit. j) was checked against the currently in-force consolidated text of Legea nr. 284/2004 (14.02.2026 version, which is why ISSPNPC and the new title are correct here). The a)–m) list and all of art. 21 were verified against the 2018 republication only, and the law has been amended and renamed twice since (LP60/2023, which reportedly added an art. 25^1 on acknowledging receipt of orders, and LP252/2025). Open legis.md doc_id=150486 in a real browser — it sits behind a bot challenge and will not fetch — and confirm: that the identification list is still art. 12 alin. (1) lit. a)–m); that storability is still art. 21 alin. (4) and the pre-order duties still art. 21 alin. (3); and whether art. 25^1 adds anything relevant. A wrong pin-cite on a legal page undoes the point of having one.

## From the privacy draft

### Blockers — the page must not go live until these are done

1. **The Romanian version does not exist yet.** The page now says the authoritative version is at lex-me.club/confidentialitate. Publishing the English page without it makes that sentence false and leaves you in breach of three statutes at once (Legea 284/2004 art. 12(1), Legea 105/2003 art. 33(2) and (7), Civil Code art. 1015(7); under art. 1015(9) the burden of proving compliance is yours). Translate this page to Romanian, publish it as the authoritative version, point the extension's `/privacy` endpoint at it, and keep the English one as the courtesy translation.

2. **Gemini API tier.** The page no longer states what Google may do with your content, because it was never verified. If the key is on the unpaid tier, Google uses submitted content to improve its products and human reviewers may read it — which contradicts the Chrome Web Store Limited Use rule against humans reading user data, and therefore contradicts the affirmative compliance statement on this page. Enforcement of the July 2026 policy update starts 1 August 2026. Move the key to billing rather than rewording the page.

3. **Consent is no longer claimed anywhere, because nothing in the code captures it.** There is no consent step, no consent flag in storage, no consent column in any table. Do not reintroduce consent as a legal basis or as the art. 32(5)(b) transfer ground until the extension actually asks — a distinct, un-pre-ticked, withdrawable step shown before the first voice session and before content first goes to a provider outside the EU, with the risk warning shown at that moment. Until then, the honest art. 32(5) grounds are (c) necessity for the contract or (i) the standard contract approved by the Centre (Order No. 33 of 22 April 2022). That is what {{TRANSFER_SAFEGUARD}} has to resolve to.

4. **Deletion must actually cover what the page promises.** PLAN-SECURITY-MIGRATION.md steps 21/22 are open. The cascade covers only sessions, calls, subtitle_fetches and pronunciation_assessments. The page promises hand-deletion of video_chat_turns, video_subtitles, user_settings, voice_sessions, signup_attempts and the `user-audio/<account_id>/` storage prefix — a database FK cascade does not touch storage objects. Either build `lex_purge_account` to cover all of them, or shorten the promise. Deliverable manually today; not at volume.

5. **Pronunciation in the store build.** `dev-tools/build-store.sh` blanks constants whose names contain KEY/TOKEN/SECRET/PASSWORD over 24 characters — which matches `PRON_SPEECH_KEY` and `SPEECHACE_API_KEY`. Run a store build and test pronunciation in the resulting artefact. If both channels are dead there, delete the "Pronunciation scoring" section, both names from the third-party list, and the pronunciation paragraphs under "Voice" — do not name processors that never receive anything.

6. **The Terms page does not exist.** This page links to lex-me.club/termeni and declares itself part of it. maib's checklist requires seven sections in template order: 1. Dispoziții generale, 2. Protecția datelor cu caracter personal, 3. Înregistrarea și achitarea comenzii, 4. Livrarea produselor/serviciilor, 5. Dreptul la retur, 6. Politica de confidențialitate, 7. Datele de contact. Section 3 must carry the total price with taxes stated as included or not, payment terms, accepted payment means and the validity of the price — that is Legea 284/2004 art. 12(1) lit. g), h), i), k), l), and none of it has a home today. A T&C acceptance checkbox at checkout is mandatory for maib.

7. **The 14-day withdrawal waiver is not implemented.** Art. 1065(1) lit. m) needs two cumulative acts: supply began with your customer's prior express consent AND he confirmed that in giving it he loses the right of revocation. Neither exists. Until both do, the 14-day right applies in full to spent balance as well — and under art. 1061(1) an undisclosed withdrawal right extends the period to 12 months. The page states the right honestly; implement the double confirmation and record it in the order-confirmation email, then the "spent balance is not refunded" line becomes safe.

### Placeholders still to fill

- **{{LAST_UPDATED}}** — the date you actually publish.
- **{{VAT_CODE}}** — required by Legea 284/2004 art. 12(1) lit. f). If you are **not** VAT-registered, replace the line with an explicit "not registered for VAT" rather than deleting it.
- **{{SUPPORT_HOURS}}** — maib's General Conditions (Anexa nr.1, pct. 1.8) require you to publish support contact details **and** working hours, with support running at least five days a week. Chrome Web Store expects a reply within three business days; the page already commits to both.
- **{{EU_REPRESENTATIVE}}** — GDPR Art. 27 requires a written EU representative when Art. 3(2) applies, unless the Art. 27(2)(a) "occasional processing" exemption fits. A continuously running consumer service processing chat and voice content probably does not fit it. Appoint one and name it, or take advice and delete the line.
- **{{TRANSFER_SAFEGUARD}}** — see blocker 3. Also unverified: whether the US appears on the Centre's adequacy list under art. 32(2)(b) — I could not locate such a list, so do not assume it exists. And verify Moldova's own status against the European Commission's current adequacy list on the day you publish; if adequacy has been granted, the transfer paragraphs change materially.
- **{{BALANCE_ON_DELETION}}** — still undecided in PLAN-SECURITY-MIGRATION.md (burn / block deletion until spent or refunded / auto-refund). The page cannot be accurate until you choose.

### Things I removed from the page, deliberately

- **Provider retention claims.** The previous draft asserted specific durations for OpenAI (30 days), Anthropic (2 years) and Groq (30 days) and a paid/unpaid split for Google. None of that was verified anywhere in the audit or research — it was written from memory. Publishing another company's retention period as fact on your own policy makes you answerable for it. The page now points the reader at each provider's own terms and admits you have not signed DPAs. Sign them and enable zero-retention where offered — especially OpenAI and Google, which receive voice audio straight from the browser — then name the agreements here.
- **The self-hosted ASR endpoint** (`LEX_ASR_URL`, a raw IP under nip.io) is no longer named as a processor. The audit found it only as a config value and never traced it to a call site: whether the path is live, what audio reaches it, who runs the host and where it physically sits are all unknown. Either resolve all four and put it back, or delete the config value.
- **"Usage telemetry" as a stated purpose.** From 1 August 2026 the Chrome Web Store requires all collected data to be *strictly necessary* to the disclosed single purpose, and permits collecting browsing activity only for a user-facing feature described prominently on the listing and in the UI. "A history of every YouTube video you used Lex on" is browsing activity. The purpose lines are now billing and operations only — which means `video_description`, `hashtags` and `content_author` need either a user-facing feature to point at or to stop being collected. Same test applies to `signup_attempts`.

### Still open, not on the page

- **`downloads` permission.** The page now describes it as saving a copy of your local Lex data. Today it is a developer console helper with no UI. Either give it a visible "Export my data" button — which also serves your GDPR Art. 20 portability duty — or drop the permission from the store build and delete the bullet. A reviewer who finds a permission with no user-facing feature has a rejection ground.
- **Retention jobs.** The page states honestly that only the subtitle-raw job runs. That is legal-ish (criteria are stated) but weak: GDPR Art. 5(1)(e) wants storage limitation in fact, and the MAIB template's section 2 wording ("stocată doar pentru perioada necesară") cannot be truthfully written while everything is indefinite. Indefinitely retained full-session microphone recordings of consumers are the sharpest item and the first a regulator would object to. Add jobs — 30 days for voice audio, 24 months for calls/chat/sessions, 90 days for sign-up IPs — then replace the "no automatic expiry" sentence with the periods.
- **The full-session voice WAV.** The audit found no consumer of it: it is uploaded because it is uploaded. "We keep it because we always did" is not a purpose under Legea 133/2011 art. 12 or GDPR Art. 5(1)(b). If there is no concrete use, stop uploading it and cut the paragraph.
- **RLS claim in the Security section.** It says access is governed by row-level security tied to your token. Confirm the anon+RLS migration is complete for every table before publishing; if any table is still open, fix the table, not the sentence.
- **Cookies on lex-me.club.** The site section claims strictly-necessary cookies only and no analytics. Verify against the actual site before publishing; if analytics or any non-essential cookie is used, name it and add a consent banner.
- **`docs/SECURITY-AUDIT.md` is stale** — it says the audio bucket is public and that the client uses the master key. The live check says `public=false`, 50 MB cap, audio MIME types only, and `supabaseFetch`/`supabaseStorageUpload` are inert stubs. Fix the doc.
- **The old policy at nikolaev-gd.github.io/lex-privacy** promises deletion of "all associated data", which is now inaccurate (the ledger is deliberately retained). Redirect `/privacy` to the Romanian page once published, and make the Chrome Web Store dashboard privacy fields match this page exactly — a mismatch between dashboard, policy and behaviour is itself a violation and can take the whole publisher account down.
- **The anonymous install id** linking separate accounts on one machine is disclosed. If you would rather not disclose it, the fix is to remove the linkage, not the sentence.
- **maib-specific items not asserted here**, because no provider is connected: card-data field list, refund-to-original-card wording, the 3-D Secure programme marks, the maib/SIP logos in the footer, the electronic receipt's nine mandatory fields (incl. RRN and authorisation code), and the 5-year transaction-record retention under pct. 3.2.15. If maib becomes a channel, all of that goes on the Terms page and in the receipt email, not here.

## From the refunds draft

**{{VAT_CODE}}** — your TVA (VAT) code. Law 284/2004 requires it among the information published on the site (art. 12(1) lit. f) in the 2018 republication — re-check the article number against the consolidated text in force since 14.02.2026 before publishing). **If you are not VAT-registered, do not leave this blank and do not invent one** — replace the row with a plain sentence such as "Not registered for VAT (TVA)" so the disclosure is still made.

**{{PHYSICAL_ADDRESS}}** — the address you actually work from. MAIB's T&C template section 7 lists legal address and physical address as two separate required fields. If they are the same, write the same address rather than deleting the row.

**{{SUPPORT_HOURS}}** — the working hours of your customer support, e.g. "Monday to Friday, 09:00–18:00 (Chișinău time)". Two constraints: MAIB requires support to run **at least five days a week** and the hours to be published on the site; the Chrome Web Store expects a reply within 3 business days. Pick hours you can actually keep.

**{{REFUND_PROCESSING_DAYS}}** — a concrete term you can keep, e.g. "5 business days". MAIB template section 5 requires this term to be stated explicitly, and Civil Code art. 1015(1) lit. g) requires the complaint-handling procedure to be disclosed. Do not replace it with a vague word like "promptly".

**{{PROVIDER_REFUND_TIMELINE}}** — the refund timeline published by whichever payment provider you actually connect (Polar or MAIB). Copy their own wording, e.g. "usually 5–10 business days, depending on your bank". Do not put a number here until a provider is live and you have read their published figure. Until then, delete the sentence rather than guess.

**{{TERMS_URL}}** — the Terms and Conditions page. It does not exist yet. Publish it first (MAIB requires seven sections plus an acceptance checkbox at checkout); if there is no T&C page at launch, delete both references to it and the storability sentence rather than leave the claim standing.

**{{ANEXA_6_FORM_TEXT}}** — see the comment in the page body. Verbatim text only.

**{{LAST_UPDATED}}** — the date you publish the page. Update it every time you change the text.

**Five things this page does not yet settle, which are yours to decide:**

1. **Balance on account deletion.** The refund flow above assumes you send unspent money back. What happens to a positive balance when someone deletes their account entirely is still an open question in your migration plan (burn / block deletion / auto-refund). Once you decide, add a line here so the two policies agree.
2. **The checkout consent step must actually exist.** This page states that you ask for explicit consent to immediate supply and to losing the withdrawal right, in a separate step, never pre-ticked. That is what art. 1065(1)(m) and art. 1065(2) require. If the checkout does not do this yet, build it before publishing — otherwise the page describes something untrue and the withdrawal right stays alive in full.
3. **The order button wording.** Civil Code art. 1017(4) requires the pay button to be labelled unambiguously — "Order with obligation to pay", "Buy now", "Pay now", "Confirm purchase" or equivalent. If it is not, the customer has no obligation under the order at all. Check the top-up button before launch.
4. **The confirmation email must carry the consent record.** Art. 1017(9) requires you to send, on a durable medium and at the latest before the service starts, a confirmation of the concluded contract containing the art. 1015(1) information **and** the art. 1065(1)(m) confirmation that the customer accepted immediate supply and the loss of the withdrawal right. Art. 1015(9) puts the burden of proving that on you. Make the top-up confirmation email carry that sentence — otherwise the 12-month extension in art. 1061 is live no matter what the checkout box said. That same email is what this page calls the proof of purchase, so it must reach every customer.
5. **The free-credit carve-out.** The page says credit you granted yourself (trial or goodwill) is not paid out in cash. That is a commercial decision I wrote from how the balance ledger works, not one you confirmed — approve it or drop the bullet.

**Romanian version is mandatory.** This English page is not sufficient on its own. Law 105/2003 art. 33(7), Law 284/2004 art. 12(1) and Civil Code art. 1015(7) all require the information to be in Romanian; another language is allowed only in addition. Publish a Romanian translation and make it the primary one.

## From the terms draft

**Placeholders that must be filled in before this page goes live:**

1. **{{EFFECTIVE_DATE}}** — the date this version takes effect. Update it every time you change the text.
2. **{{VAT_CODE}}** — your TVA code. Legea 284/2004 art. 12 alin. (1) lit. f) requires it to be published. **If you are not VAT-registered, do not leave it blank** — replace the table row with an explicit line, e.g. "Not registered for VAT in the Republic of Moldova." Then make {{VAT_STATUS}} match.
3. **{{VAT_STATUS}}** — one sentence on whether prices include tax. Not registered: "Prices do not include VAT — the seller is not registered for VAT." Registered: "All prices include VAT at the rate applicable in the Republic of Moldova." Required by Legea 105/2003 art. 33, Civil Code art. 1015 alin. (1) lit. e), and MAIB pct. 3.2.2 if you go with bank acquiring.
4. **{{SUPPORT_HOURS}}** — support working hours, e.g. "Monday–Friday, 09:00–18:00 (Chișinău time)". MAIB requires support to run **at least five days a week** with the hours published.
5. **{{COMPLAINT_RESPONSE_DAYS}}** — how fast you answer a complaint, in business days. Chrome Web Store expects a reply within 3 business days, so make it 3 or fewer and make sure {{SUPPORT_HOURS}} lets you meet it. (This used to share the {{SUPPORT_HOURS}} placeholder in section 5, which produced nonsense — it is now separate.)
6. **{{PRIVACY_PAGE_URL}}** — the Privacy page URL (appears in sections 2 and 6). Should live on lex-me.club, and the same URL goes in the Chrome Web Store dashboard privacy-policy field. The old GitHub Pages policy promises deletion of "all associated data" — the new one must not, because the balance ledger is kept de-identified by design. Section 6 here already says so; the Privacy Policy must say the same thing.
7. **{{ACCEPTED_CARD_TYPES}}** — which cards you actually accept once the provider is connected (e.g. "Visa, Mastercard"). Civil Code art. 1017 alin. (5) requires accepted payment means to be stated at the latest at the start of the ordering process.
8. **{{PAYMENT_PROVIDER_NAME}}** — the provider's name once it is live. Delete the sentence entirely until then rather than guessing.
9. **{{BALANCE_VALIDITY}}** — decide and state whether the prepaid balance expires. If it never does: "Your balance does not expire." Also connected: you have not yet decided what happens to a positive balance when an account is deleted — that answer belongs here too, and section 6 promises deletion on request.
10. **{{REFUND_PROCESSING_DAYS}}** — how long you take to process a refund request, e.g. "5 business days". Keep it inside the 14-day statutory reimbursement deadline now cited in section 5. MAIB's return template requires this to be stated explicitly.
11. **{{WITHDRAWAL_FORM_URL}}** — where the standard withdrawal form (anexa nr. 6 la Legea nr. 1125/2002) is published. Civil Code art. 1015 alin. (1) lit. h) requires the form to be supplied; if it is missing, art. 1061 stretches the withdrawal period to 12 months.
12. **{{BUSINESS_ADDRESS}}** — the place of business and the address for written complaints. Do **not** just copy the legal address by assumption: Civil Code art. 1015 alin. (1) lit. d) and MAIB's template treat "adresa juridică" and "adresa fizică" as two separate fields. If they really are the same, write the address out explicitly.
13. **{{AUTHORISATION_STATUS}}** — Legea 284/2004 art. 12 alin. (1) lit. d) requires the number, validity term and issuing authority of any authorisation the activity needs. Check with your accountant whether selling this service requires one. If it does not, write: "The activity carried out through lex-me.club does not require an authorisation or licence under the law of the Republic of Moldova."
14. **{{LANGUAGE_STATEMENT}}** — see the HTML comment in section 1. Publish the "Romanian version in preparation" sentence until the Romanian page is actually live; do not claim a Romanian text exists before it does.

**Two things this page cannot fix on its own:**

- **A Romanian version is legally required.** Legea 284/2004 art. 12 alin. (1), Legea 105/2003 art. 33 alin. (7) and Civil Code art. 1015 alin. (7) all require this information in Romanian. English alone is not compliant. Publish both, link them from each other, and treat the Romanian one as the version relied on in Moldova.
- **Data protection law changes on 23 August 2026**, when Legea 195/2024 replaces Legea 133/2011. Section 2, section 6 and the Privacy page will need rewording then — the references to 133/2011 become obsolete, and the cross-border-transfer wording will have to be rebuilt on the new (GDPR-style) grounds.

**Legal form to confirm.** Section 1 and section 7 identify you by name and IDNO but deliberately do not state the legal form ("individual entrepreneur" was an inference from the "A.I." prefix, not a verified fact). Take the form verbatim from the extras din Registrul de stat and add it. Confirm at the same time whether the registration identifier is an IDNO or an IDNP — Civil Code art. 1015 alin. (1) lit. b) treats the two cases differently.

**Product claims to keep honest.** Two sentences in the old draft were factually wrong against the code and have been rewritten:

- "Lex does not download, copy or save video content" — false on the ASR fallback path, where the browser fetches an mp3 of the video's audio from a third-party CDN (manifest host permission `https://*.123tokyo.xyz/*`) and Lex stores the resulting subtitles. The page now says Lex is not a video downloader and gives you no file, and states plainly that it processes the audio when a video has no captions.
- "It does not work on other sites" — false: the manifest carries `*://*/*` so the chat window can be injected over any open page. The page now separates the YouTube-only lesson from the chat window that opens anywhere. This matters for Chrome Web Store review, which compares your disclosures to your permissions.
- The teacher is now described as software driven by third-party AI models that can be wrong. That is a main characteristic under Civil Code art. 1015 alin. (1) lit. a) and the most likely source of a "not as described" complaint.

**Checkout requirements this page assumes exist — verify before launch:**

- A T&C acceptance checkbox at checkout that blocks payment until ticked.
- A separate express-consent checkbox for immediate start + loss of the 14-day withdrawal right (Civil Code art. 1065 alin. (1) lit. m)). It must not be pre-ticked — art. 1065 alin. (2) invalidates the waiver if consent is inferred from a pre-ticked option.
- The order button labelled with one of the wordings allowed by art. 1017 alin. (4) ("Order with obligation to pay", "Buy now", "Pay now", "Confirm purchase" or equivalent). Wrong label = the consumer owes nothing.
- A pre-payment screen showing the seller's coordinates, the order number, main characteristics, contract duration and the total price (art. 1017 alin. (2); MAIB Anexa nr.1 pct. 1.3 and 1.5) — section 3 now describes exactly that screen, so it has to match.
- A way to go back and correct input errors before the order is placed (Legea 284/2004 art. 21 alin. (3) lit. c)) — also now described in section 3.
- A unique order number per order.
- A confirmation email containing everything listed in section 3 under "Confirmation". The four-field version is not enough for art. 1017 alin. (9); do not publish that paragraph until the email actually carries all of it.
- Storage of the concluded contract, retrievable on request, as promised under "Saving these Terms and your contract".
- A post-payment return page showing order number, order details and payment date.

**Deliberately not written into this page:** any per-minute price, hourly rate, lesson count or lesson duration; any named payment processor; any claim that a specific provider is live; any bank-specific 3-D Secure or logo wording (left as an HTML comment in section 3 for when acquiring is signed); pronunciation practice as a promised system requirement (see the comment in section 4 — verify the store build first).