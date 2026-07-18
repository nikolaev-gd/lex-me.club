# Privacy Policy

**Lex — English teacher for YouTube**

Last updated: 18 July 2026

This English text is a courtesy translation. The authoritative version of this policy is the Romanian one, published at [lex-me.club/confidentialitate](https://lex-me.club/confidentialitate) as required by art. 12 alin. (1) of Legea nr. 284/2004 privind serviciile societății informaționale, art. 33 alin. (7) of Legea nr. 105/2003 privind protecția consumatorilor and art. 1015 alin. (7) of the Civil Code. In case of any discrepancy, the Romanian version prevails.

This page explains what Lex collects, why, where it goes, and what you can do about it. It describes the actual behaviour of the code, not an idealised version of it. If something here is uncomfortable, it is here because it is true.

## Who is responsible for your data

The controller of your personal data is:

- **A.I. Ghenadi Nicolaev** (antreprenor individual / individual entrepreneur)
- Country of establishment: **Republic of Moldova**
- IDNO: **1026023035183**
- VAT (TVA) code: **not applicable — not registered for VAT**
- Legal address: s. Congaz, str. Pionierii 5, Republica Moldova
- Physical (operating) address: s. Congaz, str. Pionierii 5, Republica Moldova
- Email: **nikolaev.gd@gmail.com**
- Phone: **+373 60 220 120** (country code +373)
- Fax: none
- Contact person: Ghenadi Nicolaev
- Website: https://lex-me.club
- Chrome Web Store listing: https://chromewebstore.google.com/detail/lex/bfdbiphpcnjbofngcnjjdbnolcgaaidl
- Authorisation / licence: providing this service does not require an authorisation under Moldovan law, so no authorisation number is published (art. 12 alin. (1) lit. d) of Legea nr. 284/2004).

For privacy questions and for support, write to **nikolaev.gd@gmail.com** or call **+373 60 220 120**. Support is available **Monday to Friday, 09:00–18:00 (Chișinău time)**, at least five days a week, and we reply to email within three business days.


## What Lex is, in one paragraph

Lex is a Chrome extension. Its teaching works on YouTube: it takes the video you are already watching, produces readable subtitles for it, and lets you talk to an English teacher about that video — by text or by voice. Clicking a word is a shortcut for asking the teacher about that word. The chat window itself can also be opened on top of whatever page you have open, which is the only reason Lex asks for access to all sites. Lex has no download feature and never gives you a copy of video content.

## What Lex collects and why

### Your account

To use anything paid, you must be signed in. We store your email address and an authentication session (access token, refresh token, expiry, your user id and email). Your password is never stored by the extension — it is sent once to the sign-up or sign-in endpoint and handled by our authentication provider.

Purpose: identify your account, hold your prepaid balance, refuse paid model calls without a valid account.

### Sign-up attempts

When someone creates an account, we record the IP address of the attempt, whether it succeeded, and the time.

Purpose: rate-limiting. Sign-up is the only surface that works without being logged in, so it has to be protected against abuse.

Honest note: these IP records currently have **no automatic deletion rule**. They are kept until deleted manually.

### What you watch

Every time you activate Lex on a video, we store a snapshot of that video: URL, title, description, channel name, author, hashtags, duration, whether it is a Shorts or a regular video, subtitle language, and the extension version — together with your account id and an anonymous install id.

Be clear about what this amounts to: **it is a history of every YouTube video you used Lex on.**

Purpose: this record is what authorises and prices each billed model call — the teacher cannot answer about a video without knowing which video it is, and your balance cannot be charged correctly without it. We do not use it for general product analytics, advertising or profiling.

### Your conversations and the model's answers

For every call to a text model, we store the input and the output: your chat message, the word-click context, or the whole timed subtitle transcript sent for processing — and the model's reply. Alongside them: the word, the video id, which surface it came from, token counts, cost and timings.

Purpose: billing your prepaid balance server-side, and keeping the record of what was charged.

We also store the per-video conversation history (each turn, role and verbatim content) so your conversation follows you across devices.

### Voice

In voice mode, your microphone audio is captured for the whole session as a single 16 kHz mono WAV file and uploaded to our storage. The transcription of what you said is also stored as text.

If you use pronunciation scoring, your recording of the attempt is uploaded too, along with the target word, the surrounding sentence, per-phoneme and per-syllable scores, overall accuracy/fluency/prosody scores, estimated CEFR/IELTS/PTE/TOEIC levels, and the scoring provider's raw response.

Purpose: the live audio stream is what lets the teacher hear and answer you, and the transcription of your turn is what we bill. The full-session recording is kept afterwards as a record of the session, and the pronunciation recordings as your pronunciation history. The stored recordings are not needed to produce the teacher's answers.

### Subtitles

We store the processed subtitles of the videos you watched, so returning to a video does not re-run a paid processing step.

We also store diagnostics of how subtitles were captured — the URL and parameters used, video id, language, outcome, error messages — **including the raw subtitle bodies YouTube returned**.

Purpose: the processed subtitles are the feature you see on screen. The capture diagnostics exist to keep subtitle capture working and to investigate failures.

Honest note: the raw subtitle bodies are the one thing with an automatic expiry. A scheduled job runs daily and blanks raw subtitle bodies older than 30 days. The rest of the diagnostic record is kept.

### Money

We store your balance, your account status, and every change to the balance with its reason, reference and timestamp. Card data is not part of this — see the payments section.

### Settings

Your model choices, interface language, prompt slots and other settings are stored so they sync across devices.

### An anonymous install id

Each browser profile gets a random id when Lex is first installed. It is written next to your account id on the video sessions, subtitle diagnostics and pronunciation records.

Honest note: this id **survives logging out** and does not change if you sign in with a different account on the same browser profile. That means two accounts used on one machine can be linked through it. It is a leftover from before sign-in was mandatory.

### What you must provide, and what happens if you don't

Required for the service to work at all — refusing means Lex cannot be used:

- **Email address and password.** Contractually required. Without an account there is no balance, and every paid model call is refused.
- **The video snapshot and session record.** Contractually required. It is what authorises and prices each call against your balance.
- **Your message text and the subtitles of the video.** Contractually required. The teacher cannot answer without them.

Optional — refusing costs you only that one feature:

- **Microphone audio.** Only captured if you start voice mode or pronunciation scoring. Refuse and text chat works normally.
- **Your own provider API keys.** Only if you choose to use them; they stay in your browser.

We collect nothing else that you are asked to volunteer. The sign-up IP address is recorded automatically for abuse prevention and cannot be refused separately from creating an account.

## What stays only in your browser

Some data never leaves your computer. It still counts as data about you, and Chrome Web Store rules require us to disclose it, so here it is.

In IndexedDB (database `lex_db`):

- word clicks — the word, its context, video title and URL, the prompt used and the model calls made
- subtitle processing records
- a per-call snapshot of exactly what was sent to and received from text models
- voice recordings — capped at 200 clips or 150 MB, oldest deleted first
- the 300 most recent raw subtitle captures
- processed subtitles for the 300 most recent videos

In Chrome extension storage:

- your authentication session (tokens, user id, email)
- the anonymous install id
- your conversation history per video
- the active model per video, a pronunciation cache
- if you use your own provider API keys, those keys

Honest note: word clicks and the model call snapshots have **no size cap** and grow indefinitely on your machine. The rest prune themselves by size, not by age.

Uninstalling the extension removes this local data with it.

## The website, lex-me.club

The website uses only cookies that are strictly necessary to keep you signed in and to complete a payment. It sets no advertising cookies, runs no third-party analytics, and does not track you across other sites, so no consent banner is required. Your payment provider may set its own cookies on its own payment page under its own policy.

When you visit lex-me.club, our hosting provider processes your IP address and browser user-agent in server logs, for security and to keep the site running.

## Third parties that receive your data

Lex cannot produce the teacher's answers without sending your content to AI providers. This is the core of how it works, and you should read this section carefully.

### AI providers

**OpenAI** — receives your chat messages, word-click context, subtitle transcripts and system prompts (relayed through our server). In voice mode, your microphone audio streams **directly from your browser to OpenAI**, not through our server. Also used for dictation and audio transcription.

**Anthropic** — receives text prompts and conversation content, relayed through our server.

**Google** — receives your Google account identity if you choose Google sign-in, and, as Gemini, receives text prompts and content through our server. In Gemini voice mode, your microphone audio streams **directly from your browser to Google** over a WebSocket.

**Groq** — receives audio for transcription when a video has no YouTube captions and Lex has to transcribe the audio itself.

What each provider may do with the content it receives is governed by its own published API terms, which you should read directly; we do not restate them here, because they change. We have not yet signed data processing agreements with these providers or enabled zero-retention where it is offered. When we do, this section will name the agreement and the retention setting.

**Can a human read what I write?** Not at Lex — we do not read your conversations. At the AI providers, a person may read your content when an automated abuse or safety system flags it and someone reviews the flag. That is a security review, not product improvement.

### Pronunciation scoring

Where pronunciation scoring is available, it sends your microphone audio to **Microsoft Azure Cognitive Services** (West Europe region), directly from the page, and your recorded attempt together with the target word or sentence to **SpeechAce**, from the extension's background worker.

### Infrastructure

**Supabase** — our database, authentication provider, audio storage and the proxy through which model traffic is relayed. It holds everything listed in the sections above.

**RapidAPI (ytjar) and the 123tokyo.xyz CDN** — when a video carries no captions of its own, Lex has to produce subtitles from the audio. The video id is sent to obtain an audio stream address, and the stream is read by your browser in order to be transcribed, which means your IP address reaches that CDN. Nothing is saved on your computer as a media file and nothing is offered to you to keep.

**Our payment provider** — see the payments section below.

We do not sell your data. We do not share it with advertisers, data brokers or information resellers. We do not use it for advertising, for profiling for advertising, or for credit decisions.

We will not disclose your data to any other third party without your consent, with the exceptions provided by law — on a lawful request from a state institution, a law-enforcement body or a court, or where disclosure is necessary to establish, exercise or defend a legal claim. If we receive such a request we will tell you, unless the law forbids us from doing so.

Your data is processed by mixed means — automated and manual.

**Chrome Web Store statement:** Lex's use of data complies with the Chrome Web Store User Data Policy, including the Limited Use requirements. Data is collected, used and transmitted only as necessary for Lex's single purpose — teaching English on the YouTube video you chose — and for related operational purposes such as billing, security and reliability.

## Payments

Payments are not open yet. When they open, payment for your prepaid balance will be handled by a payment provider. **Card data will be entered on the payment provider's own secure page and will never reach us.** We will never see or store your card number, expiry date, security code or cardholder name. 3-D Secure authentication applies to card payments.

The provider will receive your email address, the amount, your billing country and your IP address, and will process that data as an independent controller under its own privacy policy, linked from the payment page. Where the provider acts as Merchant of Record, it is the seller of record for that transaction. It will pass us what we need to credit your balance and to keep our accounts. We will name the provider and list exactly what it passes us on this page before the first payment is taken.

Delivery is immediate and electronic: your balance is available in your account as soon as the payment is confirmed. There is no delivery cost.

Refunds go back by the same method the payment was made. Your unspent balance is refundable on request; balance you have already spent is not.

You also have a statutory right to withdraw from a distance contract within 14 days, under art. 1059–1060 of the Civil Code of the Republic of Moldova. For a prepaid balance this period runs from the day the contract is concluded. To exercise it, email nikolaev.gd@gmail.com — you may use the standard revocation form set out in Anexa nr. 6 to Legea nr. 1125/2002, but you are not obliged to. Your unspent balance is refunded in full, by the same method you paid.

## Where your data is stored

Server-side data is stored in a single Supabase project hosted in **AWS eu-central-1 (Frankfurt, European Union)**, on PostgreSQL.

Voice and pronunciation recordings are stored in a **private** storage bucket. It is not publicly readable. Each file's path is derived on the server from your authentication token, so a client cannot write into another account's folder or choose whose account a file belongs to.

Sending your content to the AI providers above means it leaves Moldova and the EU — several of them process in the United States. As far as we are aware the European Commission has not adopted an adequacy decision covering Moldova, and we cannot confirm that the United States is on the list of states recognised as adequate by the Moldovan supervisory authority.

Under Article 32 of Legea nr. 133/2011, a transfer to a state without an adequate level of protection needs a specific ground. We rely on: **The transfer is made because it is necessary in order to perform this contract with you, and with your consent (Legea nr. 133/2011 art. 32 alin. (5) lit. b) and lit. a)).**. For transfers out of the European Union we rely, for each provider in turn, on an adequacy decision where the provider is certified under the EU–US Data Privacy Framework, and otherwise on the European Commission's Standard Contractual Clauses. You can ask us which mechanism covers which provider, and for a copy of the clauses, by emailing nikolaev.gd@gmail.com — free of charge.

**Risk warning:** because these destinations are not covered by an adequacy decision, your data may be subject to a lower level of legal protection than under Moldovan or EU law, and you may have fewer or harder-to-enforce remedies there. Your conversation content, subtitles and voice audio are transferred on that basis.

## Security

All traffic between your browser, our servers and the AI providers runs over HTTPS/TLS, and lex-me.club is served over HTTPS with a valid certificate. Access to the database is restricted per account by row-level security tied to your authentication token, so one account cannot read another's rows. Voice and pronunciation recordings live in a private storage bucket whose paths are derived on the server from your token. Payment card data never reaches our systems at all.

That said: no transmission of data over the internet or over a wireless network can be made completely secure. We protect your data with measures appropriate to the risk, but we cannot guarantee absolute security. If a breach affects your data we will notify you and the Centrul Național pentru Protecția Datelor cu Caracter Personal as required by law.

## How long we keep things

- **Raw subtitle bodies** inside the capture diagnostics: blanked automatically after 30 days. This is the only automatic expiry that currently runs.
- **The financial ledger** — top-ups and spending: kept for 5 years, because accounting rules and card-acquiring conditions require it. This is the one category that survives account deletion, de-identified.
- **Everything else on the server** — video sessions, model inputs and outputs, voice transcripts and recordings, chat turns, processed subtitles, pronunciation records, settings, sign-up IP addresses — is kept for as long as your account exists and is deleted when you ask us to delete it or to delete your account. There is **no automatic expiry job for these categories today**, so if you do not ask, they stay.
- **Local browser data** prunes by size, as described above; word clicks and model call snapshots do not prune at all, and go when you uninstall.

This is a plain statement of the current state, not a target. If you want your data gone sooner, ask — see the next section.

## Deleting your account and your data

There is **no self-service delete button in Lex today**. To have your account deleted, email **nikolaev.gd@gmail.com** from the address on the account. We will delete it manually.

What deletion does:

- Removed automatically, because they are tied to your account: your video session records, your model calls including the stored inputs and outputs, your subtitle capture diagnostics, and your pronunciation records.
- Removed by hand as part of the same request: your per-video chat turns, your cached processed subtitles, your settings, your voice session records, the sign-up IP records, and every voice and pronunciation audio file stored for your account. Ask us to confirm when it is done.
- **One deliberate exception:** the financial ledger — the record of balance top-ups and spending — is **kept, de-identified**. The account reference in it stops resolving to any account, but the financial entries themselves remain, for accounting integrity.
- Any positive balance at the moment of deletion is treated as follows: **If you ask us to delete your account while you still have an unspent balance, tell us and we will refund it before the account is deleted.**.
- Telemetry recorded before sign-in became mandatory carries no account id, so it is not reached automatically. It is not anonymous: it carries the same anonymous install id described above. Ask us and we will delete those rows by install id as part of your request.
- Local data in your browser is removed by uninstalling the extension or clearing the extension's storage. We do not hold the install id after deletion.

## Your rights

Whoever you are and wherever you are, you can ask us to: confirm whether we process your data and get a copy of it; correct or update it; delete it; restrict or block its processing; object to processing; receive it in a portable form; and withdraw any consent you have given. You can also object at any time, without giving a reason, to any use of your data for commercial prospecting, and you can demand the annulment of any decision taken solely by automated processing.

These rights are granted under Legea nr. 133/2011 (arts. 12, 13, 14, 16, 17, 18 and 32), which applies until 23 August 2026, and from that date under Legea nr. 195/2024 privind protecția datelor cu caracter personal, published in Monitorul Oficial nr. 367-369, art. 574, of 23 August 2024, which transposes Regulation (EU) 2016/679 into Moldovan law. We have written this page to the standard of Legea nr. 195/2024 so that it does not change under you when that law takes effect. If you are in the European Union, the same rights arise under the GDPR, which applies to us under its Article 3(2).

To exercise any of these, write to **nikolaev.gd@gmail.com** from the email address on your account. We answer free of charge, within one month. If a request is complex we may take up to two further months, and we will tell you inside the first month if that happens. If we cannot confirm from the request that you are the account holder, we will ask you for something that does — and only for as much as we need.

If you are not satisfied with our answer, you can complain to the supervisory authority below at any time; you do not have to ask us first.

### Why we are allowed to process each thing

| What we do | Why | Legal basis |
|---|---|---|
| Hold your account and balance, run lessons, send your messages and the video's subtitles to the AI providers | To deliver the service you paid for | Performance of the contract (GDPR Art. 6(1)(b)) |
| Store your chat history and processed subtitles so they follow you across devices | Part of the service | Performance of the contract |
| Capture and stream your microphone audio in voice mode and pronunciation scoring, and store the recording and transcript | Only if you start those features | Performance of the contract, at your request |
| Record sign-up IP addresses; keep subtitle capture diagnostics | Preventing abuse of the free sign-up surface and keeping subtitle capture working | Legitimate interest (Art. 6(1)(f)) — you may object under Art. 21 |
| Keep the financial ledger for 5 years | Accounting and card-acquiring requirements | Legal obligation (Art. 6(1)(c)) |

Lex does not make automated decisions with legal or similarly significant effects about you. The AI providers generate teaching content; they do not decide anything about your rights.

### The supervisory authorities

For your personal data:

**Centrul Național pentru Protecția Datelor cu Caracter Personal** (National Center for Personal Data Protection)
MD-2004, Chișinău, str. Serghei Lazo 48, Republic of Moldova
Phone: (022) 820 801 · Email: centru@datepersonale.md · https://datepersonale.md
Monday–Friday, 08:00–17:00

If you are in the European Union, you may instead complain to the supervisory authority of your own country.

For complaints about the service itself rather than your data:

**Inspectoratul de Stat pentru Supravegherea Produselor Nealimentare și Protecția Consumatorilor (ISSPNPC)**
State Inspectorate for Supervision of Non-Food Products and Consumer Protection
MD-2012, mun. Chișinău, str. Vasile Alecsandri 78, Republic of Moldova
Phone: 022 51 51 51 · Email: secretariat@isspnpc.gov.md · https://consumator.gov.md
Monday–Friday, 08:00–17:00

This authority is named here as required by art. 12 alin. (1) lit. j) of Legea nr. 284/2004 and art. 33 alin. (13) of Legea nr. 105/2003.

## Browser permissions and what they are for

- **activeTab** — lets clicking the Lex icon act on the tab you are looking at.
- **storage** — the local storage described above.
- **scripting** — injects the Lex chat overlay into the current page when you ask for it.
- **downloads** — used to save a copy of your locally stored Lex data to a file on your computer.
- **offscreen** — decodes audio when Lex has to transcribe a video that has no captions.
- **contextMenus** — the right-click items on the toolbar icon.
- **identity** — Google sign-in.
- **Access to youtube.com** — the subtitles, the overlay and the chat.
- **Access to the AI provider and backend domains** listed above — the model calls, authentication, storage and the audio path.
- **Access to all sites** — used so that the standalone chat window can open on whatever page you happen to have open when you click the icon. Injection is refused on restricted browser pages. Lex reads and writes nothing on those pages beyond drawing its own chat window: it does not collect page content, browsing history or form data from them. This is the broadest permission Lex requests and it exists for that single reason.

## Age

Lex is not for children. You must be at least 16 to create an account. If you are between 13 and 16 and the law of your country sets a lower age for consenting to online services, you may use Lex only with the consent of a parent or guardian, and we may ask for proof of it.

We do not knowingly collect data from anyone below these ages. If you believe a child has created an account, write to nikolaev.gd@gmail.com and we will delete the account and its data.

## Changes to this policy

If our data practices change, we will update this page and tell existing users about the change rather than changing it quietly.

---

This privacy policy forms part of the [Termeni și Condiții](https://lex-me.club/termeni) of lex-me.club and is incorporated into them as the sections "Protecția datelor cu caracter personal" and "Politica de confidențialitate". By accepting the Terms and Conditions at checkout you also accept this policy.

---
