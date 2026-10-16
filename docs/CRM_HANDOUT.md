# Anibros CRM — Handout

*What it is, what it does today, what is coming, and how to use it. Written for the people who run an agency or developer sales team, not for programmers.*

---

## 1. What Anibros is, in one paragraph

Anibros is a customer-relationship tool built for **real-estate agencies and property developers**. Every enquiry, from an ad, a website form, a phone call or a spreadsheet, lands in one place as a **lead**. You see who they are, what they want, who should call them, and when. You move each lead through your sales stages until it becomes a booking or is closed as lost. Your **properties** and **projects** (the homes you sell or rent) live in the same system, with pictures, prices and availability. Nothing is forgotten, because reminders tell the right person at the right time.

**The problem it solves:** leads arrive from many places, get lost in WhatsApp chats and spreadsheets, and nobody knows who called whom. Anibros makes sure every lead has an owner, a next step and a history.

---

## 2. How to read this handout — status labels

| Label | Meaning |
|---|---|
| ✅ **Ready** | Built, tested, and you can use it today. |
| 🟡 **Works, older version** | You can use it, but it is the first version and is being rebuilt to the new quality standard. |
| 🔨 **Building now** | The next thing being built. |
| ⏳ **Planned** | Designed, not started. |
| ⛔ **Needs your accounts** | Cannot be switched on until you give us access to an outside account (Meta, Google, WhatsApp…). We build everything up to that point and test it with simulated data. |

---

## 3. Try it on this computer (local setup)

| What | Address |
|---|---|
| The CRM (what you click) | http://localhost:5174/ |
| Inbox for emails the CRM "sends" (local only) | http://localhost:8025 |
| API health check (for technicians) | http://127.0.0.1:4000/healthz |
| Where leads arrive from Meta/Google/website | menu **Lead sources** |
| Health, errors, audit trail | menu **Monitor** |

**First time:**
1. Open http://localhost:5174/ and choose **Create a workspace** (your company name, your name, email, password).
2. Open http://localhost:8025. This is a pretend mailbox: the verification email appears here. Click the link inside it.
3. You are in, as the **Owner** of a brand-new, empty workspace.

> Use **localhost** in the address, not 127.0.0.1. Older emails may contain a 127.0.0.1 link; replace that word with `localhost` and it will open.

Nothing leaves this computer in local mode: emails stay in that pretend mailbox, and pictures are saved in the project's `storage` folder.

---

## 4. Who can do what (roles)

You invite team members under **Team** and pick a role for each. A role decides what someone can see and change.

| Role | In plain words |
|---|---|
| **Owner** | Everything, including adding other owners. At least one owner always remains. |
| **Admin** | Everything except making owners. Manages team, API keys, settings. |
| **Sales manager** | Sees and manages all leads, tasks, properties. Can reassign leads. |
| **Sales agent** | Sees and works **their own** leads and tasks. Can look at properties. |
| **Marketing manager** | Lead sources, campaigns, integrations, reports. |
| **Marketing analyst** | Reports and attribution (read only). |
| **Executive (read-only)** | Dashboards and reports, no changes. |
| **Auditor** | Sees the audit trail and team list only. Cannot see leads. |

The system enforces this on the server. Hiding a button is only a courtesy, and a person without permission cannot get around it.

---

## 5. Features today

### 5.1 Leads ✅ — *the heart of the CRM*
**What:** a lead is one person's interest in buying or renting. It holds their details, budget, source, stage, owner, score, tags and full history.
**Why:** one place to see every enquiry and who is handling it.
**How to use:**
- **Leads → New lead** to add one by hand. Phone numbers and emails are cleaned up automatically. If the same person already exists, the CRM links to them instead of creating a duplicate.
- Use the **filters** (stage, owner, source, tag, score, last activity) and **search** (name, phone digits, email). The address bar remembers your filters, so you can bookmark or share a filtered view.
- Click **Save view** to keep a filter as a named shortcut.
- Select several rows to **assign, move stage, tag or archive in bulk**.
- **Import CSV** brings in a spreadsheet (errors are reported row by row, nothing is silently dropped). **Export CSV** downloads the current list.
- Open a lead to see its **timeline**, add notes, log calls/emails/meetings, change stage, assign, and edit. The **score** (0–100) explains itself: hover to see which things raised or lowered it.
- A lead that has not had a first reply shows a **reply clock** so slow responses are visible.

### 5.2 Pipeline board ✅
**What:** the same leads as columns, one per stage. A **new workspace** starts with the recommended process, in plain words: **New enquiry → Trying to reach → In conversation → Qualified → Site visit booked → Site visit done → Negotiating → Booked → Follow up later**, and three outcomes: **Won**, **Lost**, **Not a fit**.
**How:** **Pipeline** in the menu. Drag a card to another column, or use the buttons on the lead. The strip on top shows the **weighted forecast**: value of open deals × the chance each stage usually closes (those chances are estimates, not measured results).
**Rules in the recommended process:** a lead can go from any step to any other, so nobody is told "not allowed" while learning. Only **Won** needs **Booked** first. **Follow up later** needs a follow-up date. **Lost** and **Not a fit** ask *why*, from a short fixed list (Lost: bought elsewhere, price too high, could not get financing, timing, changed their mind, stopped responding, other. Not a fit: spam, wrong number, duplicate, not a buyer, test enquiry, other). "Other" needs a few words. The reason is kept on the lead and in its history, and **Reports** counts leads by reason.
**Your history never changes:** each move remembers the step name and weight it had at that moment, so renaming a stage or changing its chance does not rewrite the past. Moves recorded before this existed show the current names and are marked as such in the database.
**Set up stages:** **Pipelines** (under Workspace) has two levels. **Basic**: rename, recolour, reorder, add or remove steps, choose where new leads start. **Advanced**: what each step means for reports, its chance of winning, which moves are allowed, details required before entering a step, and whether a reason from the list is mandatory.
**If your workspace was set up before the recommendation existed:** nothing changed for you, except that **Nurture** (which had no way out) can now move to every other step. Basic shows a card, **Want a simpler process?**, that adds the recommended process as a **second pipeline** when you press the button. Your current pipeline and every lead stay exactly as they are; you can also choose to start new leads in it. It is recorded in the audit trail.

### 5.3 Contacts ✅
**What:** the people, separate from their leads. One person can have several leads (buy now, rent later).
**How:** **Contacts** lists everyone, with search by name, phone or email. **Merge** combines two records of the same person (you can **undo within 30 days**). **Consent** records whether the person agreed to be contacted by WhatsApp/email/SMS and who recorded it; this matters for privacy law.

### 5.4 Tasks and reminders ✅
**What:** to-dos tied to a lead or contact: call, visit, send brochure, follow up.
**How:** **Tasks** shows your work grouped by day (overdue, today, tomorrow, later). Type in the quick-add box and press Enter, or use **New task** for date, priority and reminder. Tick to complete (with **Undo**). Set **repeat** (daily, weekly, monthly…) and the next one appears automatically. Choose **Remind me** (for example 1 hour before); the **bell** at the top right alerts the person, even if they have the page open on another screen.
Open tasks on a lead set that lead's **next follow-up date** automatically.

### 5.5 Notifications (the bell) ✅
Personal alerts: task reminders, overdue tasks, assignments. Click one to jump to the lead. They update live without refreshing.

### 5.6 Properties ✅
**What:** every unit you sell or rent: price, size, bedrooms, tower/unit, facing, furnishing, RERA number, amenities, owner/agent.
**How:**
- **Properties → New property.** Type prices naturally (`85 lakh`, `1.2 cr`).
- Switch between **grid** (pictures) and **table**; filter by status, project, type, sale/rent, bedrooms.
- Open a property: drag in **pictures and PDFs** (JPEG, PNG, WebP, PDF, up to 10 MB each). Click the star to choose the **cover picture**.
- **Availability:** Available → Under offer → Reserved → Sold/Rented, and back. Reversing a sale or rental asks for a reason, so the history is honest.
- The **Availability** and **Price** tabs show who changed what and when.
- **Archive** hides a property from lists, with **Undo**.
- Files are checked by their actual content, so a harmful file renamed `.jpg` is refused.

### 5.7 Projects ✅
**What:** a development or building that groups many units.
**How:** **Projects → New project.** Each card shows how many units are available, on hold or closed, the price range, and the value still unsold. Open **edit** to add brochures and site pictures.

### 5.8 Team and security ✅
- **Team:** invite by email, choose a role, deactivate people. The system never lets you remove the last owner.
- **Profile & security:** change password, switch on **two-step login** (authenticator app, with recovery codes), see your signed-in devices and sign them out.
- **API keys:** create keys so your own website or tools can talk to the CRM. A key can never do more than the person who made it.
- Every important action is written to an **audit trail** that cannot be edited.
- Dark and light themes: **account menu → Dark/Light**.

### 5.9 Search and shortcuts ✅
Press **Ctrl+K** (or ⌘K), or click the search box at the top. Type two or more letters and you get **leads, contacts, properties, projects and tasks** that match (names, e-mail, phone digits, titles, places, unit numbers), at most five of each, plus the pages you can open. Arrow keys and Enter open the highlighted result.
You only ever find what you are allowed to see: a salesperson finds their own leads and tasks; a role that cannot read a kind of record does not get that kind in the results. Archived records are never found.

### 5.10 Lead sources — Meta, Google, website, other systems ✅ (live connection needs your accounts ⛔)
**What:** the automatic way leads arrive. Each source (a Meta lead form, a Google lead form, your website contact form, a property portal or Zapier) gets its **own private address**. When someone submits a form, the lead appears in **Leads** by itself, with the campaign, ad and form it came from, tagged with its source, assigned by your rule, and the owner gets a bell notification.
**Why it matters:** the first call decides whether a lead buys. Copying leads by hand from Facebook or Google is slow and loses them.
**How to use it:**
1. **Lead sources → Add source** and choose Meta, Google, Website form or Another system.
2. Fill the short form: a name, what should happen to the lead (campaign label, tags, pipeline and starting stage, who it is assigned to). Meta needs your app secret (and a Page access token so we can read what the person typed).
3. A **Setup guide** opens with the exact steps for that platform, your private address, and (for Google and "other system") your secret, **shown only once**, so copy it now. The website option gives you a ready-to-paste form.
4. Press **Send test lead**. A lead tagged *test* appears in Leads in a few seconds. Delete it afterwards.
5. Check the **Delivery log** any time. Every delivery shows what happened:
   - **Lead created**: done.
   - **Added to existing lead**: that person already had an open lead, so the new enquiry became a note on it and the owner was told. No duplicates.
   - **Needs attention**: we understood it but cannot go on (for example the submission had no phone or email, or the Meta token expired). The reason is written in plain words; fix it and press **Retry**, or press **Ignore**.
   - **Failed**: a technical problem after several tries. Press **Retry** when it is fixed.
6. A switch on each source **pauses** it. While paused, Meta and Google will keep retrying and nothing is lost.
**Safety:** a source only accepts deliveries it can prove come from the platform (signature or key). Strangers who find the address cannot add leads. The workspace is decided by the address, never by what is inside the message. Secrets are stored encrypted.
**Local testing:** Meta and Google can only reach a public internet address. On this computer use **Send test lead**; real campaigns need the deployed server with a public HTTPS address and your Meta/Google accounts.

### 5.11 Monitor ✅ — is it running, what went wrong, who changed what
**What:** one page (menu **Monitor**) for owners, admins, auditors and marketing managers. It only ever shows your own workspace.
**Health tab:** five checks in plain words: Database, Background worker (emails, reminders, lead intake), Job queue, Lead intake (are deliveries stuck? has a source gone quiet for a day?) and Errors. A banner says *All systems normal*, *Needs attention* or *Something is wrong*, and refreshes by itself every 30 seconds. Below: leads in the last 24 hours, first replies overdue, overdue tasks, and where new leads came from this week.
**Activity log tab:** problems worth knowing about: server errors, someone denied permission, too many requests, slow pages, failed background jobs, refused lead deliveries. Click a row for details and a **request id**; give that id to support and they can trace exactly what happened. Kept 30 days. Passwords and secrets are removed before anything is saved.
**Audit trail tab:** who did what, when, from which address. Filter by action, record type, person and dates; click a row to see **what changed (before and after)**; **Export CSV** for your records. Nobody can edit or delete the trail, and the export itself is recorded.
**Auditors** see health and the audit trail but no leads or business numbers.

### 5.12 Automation ✅ — one automation so far: follow up every new lead
**What:** menu **Automation**. One ready-made automation, **Follow up every new lead**, that you turn on or off. It is deliberately not a rule builder: the steps are fixed, so it behaves the same way every time and you can read exactly what it does.
**When it runs:** every time a lead is created: by hand, by CSV import or by a lead source (Meta, Google, website). It only covers leads created **after** you turn it on; it never touches leads that already exist.
**What it does, in order:**
1. **Owner.** If the lead already has an owner, that owner is kept. If it was created on purpose without an owner, it stays unassigned. Otherwise, and only if your assignment rule allows, it goes to the least busy salesperson.
2. **One call task** for the owner, due within your **first-reply time** (Workspace settings; 30 minutes if you set none).
3. **One notification** to the owner. Nobody is notified about a lead they created for themselves, and nobody is told twice when a lead source already told them.
**Your settings it uses:** *Who gets a new lead* and *Reply to a new lead within (minutes)*, both in **Workspace settings → New leads**.
**What it did:** the table under the card lists every run: when, which lead, **Done / Skipped / Failed / Waiting to retry**, and in plain words what it did (for example "Kept the owner: Sam · Created the task 'Call Meera Nair (new lead)', due 14 Oct, 16:38 (Asia/Kolkata)"). A failed run shows the reason and a **Retry** button.
**Safe by design:** a lead never gets two tasks, even if the system restarts, retries or runs on several servers; **Pause** stops it for new leads straight away; one workspace's automation never touches another's.
**Who:** owners, admins and marketing managers can turn it on, pause it and retry; sales managers and marketing analysts can read the history; salespeople and auditors do not see the page.
**Not included (on purpose):** sending e-mail or WhatsApp. Those need your provider accounts and are added with that integration, not before.

### 5.13 Home ✅ — what needs you today
**What:** the first page after sign-in. It answers "what do I do now?" and every number on it is a count of the list under it.
**My day (for everyone):** leads **waiting for your first reply** with the time left or how late they are; your **overdue** tasks; **today**: your tasks and site visits in time order (a visit that has ended and is not recorded shows **Record outcome**); how many visits you have in the next 7 days. "Today" follows your workspace time zone.
**Your team (managers, admins, owners):** leads with **no owner**, first replies that are already late, overdue tasks, and visits that nobody recorded.
**Pipeline:** open leads and their estimated value by step. The weighted forecast is labelled as what it is: your own estimates of each step's chance, not a measured result. Test leads are left out.
**Needs attention (owners, admins, auditors, marketing managers):** lead deliveries that need review and automation runs that failed, with links.
**Get started (owners and admins):** six short steps (add a lead, invite your team, add a property, connect a lead source, turn on the follow-up automation, book a site visit) that tick themselves off.
A site visit is shown **once**, as a visit. Its reminder task does not appear again as an overdue task.

### 5.14 Site visits and the calendar ✅
**Book:** from a lead (**Book a visit** under Site visits), from a property (only while it is available or under offer), or from **Tasks and calendar**. Pick the buyer, the property, the time, the length, and (managers) the agent. The server refuses an overlapping visit for the property or the agent (409), a property that is reserved, sold, rented, inactive or archived (422), and an archived lead.
**Every visit has a real reminder:** a task for the agent, due when the visit starts, with a reminder an hour before. It is the lead's next follow-up, it moves when you reschedule and closes when you cancel or record the visit.
**Open a visit** (calendar, lead page, Home) to: **Reschedule** (same rules as booking; if a colleague changed it meanwhile you are told instead of overwriting), **Cancel** (optional reason; the slot is free again), **No-show** (only after it was due to start), **Record visit** (from 15 minutes before the start): how it went (interested, likely to make an offer, needs time, wants other options, not interested), a note, and an optional **follow-up task**. You are then offered **Site visit done** for the lead; you decide whether to move it.
**Calendar file:** **Calendar file** downloads a .ics your Apple, Google or Outlook calendar opens. It has the time, the place, the property and the buyer's name, never the buyer's phone or e-mail.
**Tasks and calendar:** one page. **List** is your tasks as before. **Calendar** is one week, visits and tasks together (managers can include the whole team's tasks). The old Calendar address redirects here. Times show in your own time zone.
**Next step on every lead:** a banner at the top of a lead says what to do next: reply (with the deadline), record a visit that has happened, the coming visit, your most urgent task, or "plan the next step" when nothing is planned. It is worked out from the lead's own data, never typed in.

### 5.15 Shortlists, offers, reservations and sales ✅ — what makes money
**The path of a deal:** *shortlist → offer → reserved → sold (or rented).* Each step is a record you can see on the lead, on the property and on **Offers and bookings** (under Sales).
- **Shortlist:** the properties a buyer is considering. Add them from the lead page (**Add a property**) or from **Matching** (**Save to their shortlist**, which also keeps the match score). It records interest only: it never holds or changes a property.
- **Offer:** **Record an offer** from the lead or the property. The property shows **under offer** and the lead moves forward to *Negotiating* (never backwards, and the screen says when it moved). Several buyers can offer on one property; one buyer cannot offer twice.
- **Reserved:** token received. The property is **held for one buyer**: nobody else can reserve it, even two people clicking at the same moment (the database refuses the second). The lead moves forward to *Booked*. A hold date is optional; **nothing is released automatically**: when the date passes, the page tells you and a person decides. Booking is a milestone, not a sale.
- **Sold or rented:** **Record sale** (from the deal) or move the lead to **Won**: you say which property and its **final deal value**. In one step the property becomes sold (or rented), the lead becomes Won, and other buyers' open offers on it are closed and their agents are told. If anything in that step cannot happen (for example the property is held by someone else) **nothing changes**.
- **Won needs a recorded sale** in the recommended pipeline (a switch under **Pipelines, Advanced**: *Require a recorded sale to win a lead*). Older pipelines keep working as before until an admin turns it on. **Reports count revenue only from recorded sales** ("won deal value"); leads won without one are listed as "won without a recorded sale", never guessed. The value typed on a lead stays an estimate.
- **Who holds this property?** The property page says it is reserved and by which agent. The buyer's name and the money are shown only to people who may see that buyer.
- **While a deal exists** the property's status cannot be changed by hand (the page explains why); you end the offer or reservation instead. A recorded sale is reversed by reopening the lead (a manager can), which makes the property available again and stops that sale counting.
- **Who can do it:** salespeople work the deals of their own buyers; managers, admins and owners all of them. Marketing, executives and auditors cannot create or change deals.

### 5.16 Dashboard ✅ — the whole business on one screen
**Home is for you, Dashboard is for the business.** Home (5.13) is your personal "my day". **Dashboard** (under Home in the menu) is the executive overview of everything: leads, pipeline, recorded sales, tasks, site visits, stock, where leads come from and (for managers) the team.
- **Choose the days:** 7, 30 or 90 days, this month, year to date, or exact dates. "Today" and the day boundaries follow your workspace time zone. **Include test leads** is a visible switch (off by default).
- **Key figures**, each one a link: total leads, new leads (with a plain comparison to the previous period), **won deal value** (the total of recorded sales, never an estimate), win rate, open pipeline value (an estimate, and its weighted value), overdue tasks, visits in the next 7 days, available properties.
- **Needs attention:** only what is non-zero: overdue tasks, late first replies, overdue follow-ups, leads with no owner, visits nobody recorded, reservations past their hold date. Each opens the list to fix.
- **Charts:** new leads over time, recorded sales over time, the pipeline by stage, where new leads came from, inventory by status, site visits held, cancelled and missed. Clicking a bar or a slice opens the matching list (every chart also has a row of links under it that works with a keyboard).
- **Team** (managers): open leads, new leads, sales, deal value and overdue tasks per person; click a person for their open leads.
- **Every number matches its list.** Clicking "Total leads" opens exactly that many leads; "Overdue tasks" opens only the overdue tasks; "Available properties" opens the available units; a day's bar opens the leads created that day. The page you land on shows a small chip for the filter it applied (for example "Test leads left out") so a short list is never a surprise.
- **You only see what your role allows:** a salesperson sees their own leads, tasks and visits and no team table; a section you cannot see is not shown.
- **Not shown, because the data does not exist yet:** marketing spend and cost per lead (Attribution and Reports get those next).

### 5.17 Reports and Attribution ✅ — what is working, and where buyers come from
**Reports** answers six business questions for the days you choose: how leads become sales (a funnel where each step is a subset of the one above; click any number to see the leads), why leads are not converting (the reasons chosen when they were lost), where the pipeline is right now (and how long leads stay in each stage), whether the team is following up (site visits, first-reply speed, overdue), what there is to sell, and how each person is doing. **Export CSV** downloads the same figures. Revenue is only the total of recorded sales; the value typed on leads is shown as an estimate.
**Attribution** shows which sources, channels and campaigns bring buyers and what became of them (leads, qualified, site visit, booked, won, won deal value). Each lead is credited to the first place it came from (that never changes) or, if you choose, the latest. Enter **marketing spend** by hand or by CSV (a preview checks the file first, and nothing is saved if a row is wrong) to see cost per lead, cost per sale and return; without spend there is no cost or return, and none is guessed. You can regroup a source under another channel. "This shows where buyers came from. It does not prove which ad caused a sale."
**Property matching** now starts from the buyer's own recorded requirements, explains every score, and saves a suggestion to the buyer's shortlist; when nothing fits it says why. **Workspace settings** was rebuilt. The whole application now follows light and dark mode consistently.

---

## 6. Older screens: what they do now (updated 2026-10-14 after Slice 0)

These screens come from the first prototype. The audit tested each one by using it; the ones that only *looked* finished were fixed or replaced. Details: `docs/audit/2026-10-14/` (`08_SLICE0_ACCEPTANCE.md` has the evidence).

| Screen | What it does today | Still to come |
|---|---|---|
| **Automation** | Rebuilt: see section 5.12. The old rule editor only stored settings that nothing ever ran, so it was removed. | More templates, later |
| **Integrations (old page)** | Removed. The address now opens **Lead sources**, which is where Meta, Google and website forms connect. | — |
| **Workspace settings** | Name, time zone, currency, the country used to read phone numbers, who gets a new lead and the first-reply time (address: Settings, Workspace). Saving changes only what you edited and never erases other settings. Time zone is the one reminders use. | Lead-scoring weights are not editable yet. Brand colours were removed because nothing used them |
| **Dashboard** | Rebuilt as the executive overview (section 5.16); **Home** (5.13) stays your personal day. Reports keeps these rules: it counts live leads only: archived leads are never counted and test leads are left out unless you switch on **Include test leads**. The status counts add up to the total. The page refreshes every 10 seconds and says so. | Home page built around your day (Slice 3) |
| **Reports** | Rebuilt as an analytical workspace: see section 5.17. | Per-route polish of the other screens |
| **Calendar** | Now part of **Tasks and calendar** (section 5.14): book, reschedule, cancel, record and export visits. The old address redirects. | — (offers and reservations: section 5.15) |
| **Property matching** | Rule-based suggestions with the reasons for each score (not AI). Sold, reserved and archived units are never suggested. | — (**Save to their shortlist** keeps a suggestion on the lead, section 5.15) |
| **Attribution** | Rebuilt: see section 5.17. | Automatic spend sync from Meta and Google (needs your accounts) |
| **Custom fields** | Shows "Not available yet". Existing values are kept in the database. | Rebuilt with proper validation |

---

## 7. Lead capture from Meta, Google and your website

**Question you asked: "Did you build the webhooks for leads from Meta and Google? Those are core."**
**Answer:** Yes, now (2026-10-14). Section 5.10 explains how to use it. What is finished and what still needs you:

| Source | How the lead gets in | Status |
|---|---|---|
| **Meta (Facebook & Instagram) Lead Ads** | Meta calls your private CRM address when someone submits an ad form. The CRM checks Meta's signature, fetches the full answers from Meta, and creates the lead with its campaign, ad set and ad. | ✅ Built and tested with simulated Meta deliveries · ⛔ going live needs your Meta app secret, a Page access token, and the public server address |
| **Google Ads lead forms** | Google posts the form to your private address with your secret key; the CRM validates it and creates the lead with campaign and click id. | ✅ Built and tested · ⛔ going live needs your Google Ads account and the public server address |
| **Your website form** | A small snippet posts the form to your private address. Protected against spam bots (hidden trap field, rate limit, allowed websites). | ✅ Ready (works as soon as the site can reach the server) |
| **Anything else** (portals, Zapier, Make, your own system) | Send JSON signed with your secret. | ✅ Ready |
| **CSV / manual** | Described in 5.1 | ✅ Ready |

**What makes it safe:** each source has its **own private address and secret**. The sender is proven by signature, so a stranger cannot inject leads. The workspace is decided by that address only; the CRM never guesses. The CRM saves the message **first** and answers "received" immediately, so a busy moment or restart never loses a lead. A repeat delivery of the same lead is recognised and ignored. A message that cannot be understood is put in the delivery log with the reason, never dropped.

**Still to come in this area:** a "Connect with Facebook" button (so you do not paste secrets), and sending conversions **back** to Meta and Google so the ad platforms learn which leads became customers.

---

## 8. What is coming next, in order

1. ✅ **Viewings** with double-booking prevention and calendar export: done (5.14).
2. ✅ **Buyer shortlists, offers, reservations and recorded sales** (5.15). Still to come here: matching that learns from outcomes.
3. ⏳ **WhatsApp, email and SMS** from inside a lead (templates, replies, consent checks). ⛔ Needs WhatsApp Business and email provider accounts.
4. ⏳ **More automation:** the first one is live (5.12). Next: stage-change and overdue triggers. A WhatsApp or e-mail welcome ⛔ needs your provider accounts.
5. ⏳ **Send conversions back to Meta and Google.** ⛔ Needs your accounts.
6. ⏳ **Outbound webhooks and public API docs** for your developers.
7. ⏳ **Reports & dashboards** rebuilt: funnel, source and campaign return on spend, agent performance, response times, forecast.
8. ⏳ **Custom fields**, **AI helpers** (lead summaries, suggested next step, reply drafts).
9. ⏳ **Production hardening:** cloud deployment with a public address, automated backups with a tested restore, load testing, alerts that page you.
10. ⏳ **Subscriptions and billing** (deliberately last, design is written in `docs/SUBSCRIPTION_DESIGN.md`).

---

## 9. A typical day, start to finish

1. **Morning:** the manager opens **Leads**, filters *New* + *Unassigned*, selects them and **assigns** them to agents.
2. Each agent opens **Tasks**. Overdue and today's calls are on top.
3. The agent calls, logs the call on the lead (**timeline → Call**), schedules a follow-up task with a reminder, and moves the lead to *Contacted*. The first-reply clock stops.
4. A good conversation → the agent opens **Properties**, filters by project and budget, and notes the favourites on the lead.
5. The lead moves along the board. When it reaches *Won*, the property is marked **Sold** (or *Rented*).
6. The owner checks the **Pipeline** forecast and the team's overdue tasks.

---

## 10. Your data, privacy and safety (short version)

- Every workspace is **sealed from every other workspace by the database itself**, not just by application code.
- Passwords are stored with a slow, strong method; two-step login is available; sessions can be revoked.
- Sensitive stored secrets (integration keys) are **encrypted**.
- Important actions leave an **audit entry**, and the audit table cannot be edited by the application.
- Uploads are checked and served with safe settings.
- Contact **consent** is recorded. Data-export and erasure requests (privacy law) are planned.
- Details for technical reviewers: `docs/SECURITY_MODEL.md`, `docs/FAILURE_MODES.md`, `docs/WAVE3_DOMAIN_DESIGN.md`, `docs/ARCHITECTURE_V2.md`.

---

## 11. Frequently asked questions

**I did not get the verification email.** Local mode: open http://localhost:8025. Live mode: emails go to real inboxes once an email provider is connected.

**A verification link says "site can't be reached".** It has `127.0.0.1` in it. Replace that with `localhost`. New emails now use `localhost`.

**I forgot to assign a lead.** Select it in Leads, then **Assign**. Or filter *Unassigned*.

**Can two people edit the same lead?** Yes. If someone saved first, you get a clear message asking you to reopen it, so nobody's changes are lost silently.

**I archived something by mistake.** Look for **Undo** right after, or ask an admin to restore it.

**Where do Meta/Google leads show up?** In **Leads**, with the source, campaign and ad filled in (once your Meta or Google account is connected, section 7).

**Can my website developer connect to this?** Yes: **API keys** (ready today) and the website form source (**Lead sources**, ready today).

---

## 12. Words you will see

| Word | Meaning |
|---|---|
| **Lead** | One person's interest in a property. |
| **Contact** | The person record; one contact can have many leads. |
| **Stage** | A step in your sales process. |
| **Pipeline** | The ordered list of stages. You can have several (sales, rentals). |
| **Weighted forecast** | Estimated value × chance of closing at its stage. Your own estimates, not a measurement. |
| **Won deal value** | The total of recorded sales: the final value of each property sold or rented to a won lead. The only revenue figure reports use. |
| **Reserved (booked)** | A property held for one buyer after a token. A milestone, not a sale. |
| **Webhook** | A message one system sends another the moment something happens (for example, "a new lead just submitted a form"). |
| **Source** | Where a lead came from: Meta, Google, website, referral… |
| **Attribution** | Crediting the right campaign for a lead or sale. |
| **Audit trail** | The permanent record of who did what, and when. |
| **Workspace** | Your company's private area inside Anibros. |

---

*Last updated: 2026-10-14 (lead sources and Monitor added; older-screens section corrected by the audit). Technical documents live in the `docs/` folder; progress is tracked in `Claude_plan.md` and `PROJECT_LOG.md`.*
