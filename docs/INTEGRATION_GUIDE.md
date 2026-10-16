# Getting leads in: Meta, Google, websites and your own systems

Every client (workspace) has its own **lead sources**. Each source is a private receiving address. A lead can only arrive from a sender
you set up, and nothing is accepted without proof that the sender is who it says it is. In the app: **client → Settings → Lead sources**.
For each source, **Setup guide** shows the steps, and **Copy for client** / **Download** produce a ready-to-send message with the address,
the proof method, what we read, the answers and examples, so you can send it to the client's developer or ad agency as it is.

## The four kinds of source

| Source | Who sends | How we know it is real | Notes |
|---|---|---|---|
| **Meta Lead Ads** (Facebook / Instagram) | Meta, to our callback address | `X-Hub-Signature-256` HMAC of the raw body with the app secret; the one-time subscription handshake needs the verify token | Meta only sends a lead id; we fetch the answers with the Page access token (leads_retrieval, pages_show_list, pages_read_engagement). Several leads in one delivery become several leads. |
| **Google Ads lead forms** | Google, to our webhook address | The **key** you configure in Google Ads travels in the body (`google_key`) and is compared in constant time | The key is never stored in the lead data. |
| **Website form** | A visitor's browser | Allowed website addresses (origin check), a hidden bot-trap field, and a strict per-visitor rate limit | No secret exists in a web page, so none is used. |
| **Another system** (portal, Zapier, Make, your software) | A server | `X-Anibros-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">` with the signing secret; requests more than 5 minutes off are refused (replay protection) | `X-Event-Id` makes a retry harmless: the same id is processed once. |

For programs that want to create leads directly there are also **API keys** (client → Settings → API keys): `POST /api/v1/leads` with
`Authorization: Bearer <key>`. A key belongs to one client, can do only the actions you tick, can expire, and can be revoked at once.
Creating a key offers the same **Copy instructions for the developer** message. The full reference is at `/api/docs`.

## What we refuse (and say so plainly)

| Answer | Cause |
|---|---|
| 401 | missing, wrong or old signature / key |
| 403 | a website that is not on the allowed list; a key without that action |
| 404 | a wrong or deleted address, an unknown id (all look the same) |
| 400 | a body we cannot read |
| 413 / 400 | a body over 256 KB |
| 429 | too many requests (per address, per visitor, per key); `Retry-After` says when to retry |
| 503 | the source is paused, or we are briefly unavailable: **nothing was saved**, the sender retries |

A delivery is saved before we answer 200, so a crash cannot lose a lead. A person who already has an open lead gets the new enquiry
added to it instead of a second lead. Deliveries that cannot be turned into a lead (nobody to contact) wait in the **Delivery log** with a
reason, and can be retried or ignored.

## Where each lead goes

By default a new lead follows the client's assignment setting. **Settings → Lead handling → Send leads to specific people** lets you
say, for example, *Instagram and Meta leads go to Divya and Arjun; Google leads go to Ravi*: each new lead goes to the least busy person on
the rule. A rule beats "leave leads unassigned"; a lead created with an explicit owner keeps that owner.

## What has been verified, and what cannot be from here

Verified by automated tests (`server/src/tests/inbound.test.ts`, `wave2.test.ts`, `wave3.test.ts`): every signature rule above including
tampered bodies, wrong secrets, stale timestamps and replays; the Meta handshake and signature over the raw bytes; Graph fetch outcomes
(temporary outage retried, bad token needs review, missing token waits); duplicate handling; website origin and bot checks and rate
limits; paused / deleted / suspended sources; isolation between clients; that no secret ever appears in logs, audit or API output;
routing rules.

**Not verifiable on a development machine:** a live Meta or Google account sending real deliveries. Both need a **public HTTPS address**
for the callback (set `PUBLIC_APP_URL` on the deployed server; locally use **Send test lead**, or a tunnel while testing), a Meta app in
live mode with the Page connected, and a Google Ads lead form with the webhook key pasted in. Do one real test submission per client
after connecting, and check it in the Delivery log.


## Sending data out: webhooks (wave 4)

Lead sources bring data IN. A webhook is the other direction: the CRM tells another system the moment something happens (Settings → Connect → Send data out, or `/api/v1/webhooks`).

- **Events**: `lead.created`, `lead.assigned`, `lead.stage_changed`, `lead.updated`, `lead.deleted`, `activity.created`, `task.created`, `task.completed`, `contact.created`. Three one-click presets cover "every new lead", "the whole journey" and "everything the team does".
- **Each message** is a JSON POST with `X-Anibros-Event`, `X-Anibros-Delivery` (the same on every retry: the receiver's idempotency key) and `X-Anibros-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`. The signing secret is shown once; "Copy instructions" gives the developer the payload shape and copy-paste verification code (Node, Python, PHP).
- **Delivery**: a transactional outbox. The event is written in the same transaction as the change; a worker fans it out to the workspace's active webhooks (one `outbound_deliveries` row per endpoint and event, UNIQUE, so replays never double-send) and sends with retries and back-off for about a day. A 410 switches the webhook off at once; 30 failures in a row switch it off with the reason shown. Turning it back on starts fresh. Only events that happened after the webhook was created are sent.
- **Address safety (SSRF)**: https only in production, no credentials in the URL, no redirects followed, and every address the name resolves to must be public. The connection is made to the address that was checked (so DNS rebinding cannot swap it). Private, loopback, link-local, carrier-grade NAT and cloud-metadata addresses, including IPv4 hidden in IPv6, are refused when saving and again when sending. `OUTBOUND_ALLOW_PRIVATE` exists for development and tests only and is refused in production.
- **Isolation**: both tables are row-level-secured by workspace; the secret is encrypted with a context-bound key and never returned or audited; the dispatcher can ask only a one-bit function ("does this workspace have an active webhook?") so it never reads another workspace's endpoints.

## Ready-made API keys (wave 4)

`GET /api/v1/api-keys/templates` (and the three cards at the top of the API keys page):

| Template | Direction | Can | Cannot |
|---|---|---|---|
| Send leads into the CRM | into the CRM | add leads and contacts | read or change anything |
| Read data out of the CRM | out of the CRM | read leads, contacts, activity, reports | create, change or delete anything |
| Get notified when things happen | CRM tells you | it is a webhook, not a key | |

Both keys expire after a year by default; "Customise" opens the full role and scope pickers. A person can only create a template they could grant themselves.

## E-mail and WhatsApp from a lead (wave 4)

On a lead, choose E-mail or WhatsApp in Log activity and switch to "Send from here" (`POST /api/v1/messaging/send`).

- It is an ordinary logged activity (timeline, first-reply clock, reports) plus a send job created in the same transaction, so the record and its delivery exist together or not at all. Delivery shows on the timeline: Sending, Sent, or Not delivered with the reason; a failure also notifies the sender.
- The address or number always comes from the lead's own contact. The request cannot name a recipient, so the CRM cannot be used to mail arbitrary people. Sending follows the sender's work channels (a WhatsApp-only specialist cannot send e-mail) and the lead's visibility. At most 40 messages per person per 10 minutes.
- **E-mail** goes through the platform mail server under the client's name, with the employee as reply-to; display names are sanitised.
- **WhatsApp** uses the client's own WhatsApp Business (Cloud API) number: Settings → Lead sources → WhatsApp Business number takes the phone number id and a permanent access token, checks both with Meta, and stores the token encrypted (never returned). Free text works only within WhatsApp's 24-hour window; outside it send an approved `template`. Meta's refusals are explained in plain words.
- Replies from people (inbound WhatsApp) are not read yet; log them as "They reached out".

## Rate limits across processes (wave 4)

`RATE_LIMIT_STORE=postgres` makes the per-key, per-user, bad-key, sign-in and public-intake limiters share one allowance across several API processes (an UNLOGGED table touched only by the atomic function `app.rate_take`, using the database clock). It fails open if the database is unreachable. The default `memory` is exact for one process.

## Any website form, any chatbot (wave 5)

**Website form.** Add a "Website form" source and paste ONE line before `</body>` on the client's site:
`<script src="https://<your-api>/hooks/<source-id>/capture.js" async></script>`. The script finds every form on the page (also ones added later), whatever the fields are called, and sends what the visitor typed when they submit. It never changes the form's own behaviour, skips login/search/payment forms and forms without a phone or e-mail, never reads passwords, card numbers or OTPs, drops bot traps, sends the page address without its query string, and keeps utm/gclid/fbclid. `data-anibros="ignore"` on a form skips it. A chatbot that is the site's own code can call `AnibrosCRM.say('visitor'|'bot', text)` while it talks and `AnibrosCRM.lead({ name, email, phone })` when it has the details; the conversation is attached.

**Field recognition.** Names are matched exactly first (name, your-name, e-mail …), then by pattern (anything containing "mail", "phone/mobile/tel/whatsapp", "message/comment/enquiry/requirement/details …"), then by what the value looks like (an e-mail address, 7-15 digits). Budgets, prices and postcodes are never mistaken for phone numbers.

**The visitor's own words** become a note on the lead ("Their message") and a chatbot conversation becomes "Chat with the visitor" (up to 60 turns), first things the team reads.

**Chatbots and no-code tools** (Tidio, Crisp, Tawk.to, Intercom, Zapier, Make, WPForms …): add a "Chatbot or another tool" source and give the tool its web address with `?key=…` (or `Authorization: Bearer <key>` / `X-Anibros-Key`). Nested visitor objects (`visitor.email`) and transcripts in several shapes are understood. Signed requests still work for developers. Treat the address like a password; rotate it if it leaks. Query strings are never written to logs.

## Send everything to one person (wave 5)

Settings → Lead handling → "Send leads to specific people": choose people for **every lead** (`routing` rule with source `all`; several people share, least busy first, and it also applies to leads the team adds by hand), then optional exceptions per source, which win over it. An explicit owner chosen when creating a lead is always respected.

## Consent (wave 5)

A switch per channel on the contact records whether the person agreed to be contacted. If they withdrew (granted, then revoked) and have not agreed again, sending an e-mail or WhatsApp message from the lead is refused with an explanation; "never recorded" does not block (replying to an enquiry is fine).
