# Audit 2026-10-14 · 08 — Slice 0 acceptance (safety and truth)

Branch `feat/anibros-crm-remediation-2026-10-14`. Date: 2026-10-14. Roadmap: `07_REMEDIATION_ROADMAP.md` §2, Slice 0.
Result: **all steps delivered; four deviations and the open items below are stated, not hidden.** The audit's passing test count was not used as proof: each step below names the specific test or run that demonstrates its acceptance criterion.

## Gate results

| Gate | Result |
| --- | --- |
| `npm run typecheck` (app + server) | pass |
| `npm run lint` | 0 errors (56 warnings; 75 at audit time) |
| `npm test` | **24 files, 499 tests pass** (was 22 files / 451 at audit time) |
| `npm run build` | pass |
| `npm run api:check` | up to date |
| `npm audit --omit=dev` | **0 vulnerabilities** (was 1 high: nodemailer, 15 advisories) |
| Restricted database role | `slice0.test.ts` boots the API as the restricted login role; row-level security is real in every Slice 0 test |
| Browser (`journey8`, Playwright, restricted-role stack on ports 4100/5199) | all checks pass, no console errors, no HTTP 5xx |
| Upgrade from the previous schema | `upgrade-slice0.test.ts`: 020 to 021 with data in place; migration stops and changes nothing when bad data exists |
| Existing data | `npm run db:report-integrity` against the dev database before migrating: clean (one preserved, unused settings blob reported) |

## Step by step

| Step | Acceptance (roadmap) | Evidence |
| --- | --- | --- |
| 0.1 commit work | branch, clean tree | 13 commits from `a9363b9`; nothing pushed |
| 0.2 remove legacy members routes | endpoints 404 | `slice0.test.ts` "removed legacy endpoints" (18 routes, owner gets 404); `access-control.test.ts` unchanged and green |
| 0.3 custom-field integrity | cross-workspace link impossible under both roles | migration 021 composite FK `(field_id, tenant_id)`; `slice0.test.ts` "the database refuses it"; `upgrade-slice0.test.ts` (migration refuses to run over existing cross-workspace links and changes nothing). **Deviation:** the legacy custom-field API was deleted, not ported, so type/regex/required validation is not rebuilt yet (no screen could use it) |
| 0.4 viewings | auditor/exec refused; foreign agent refused; archived refused; agents see own; 6-way race | `slice0.test.ts` "viewings": 10 tests including role matrix, D6 availability rules (available and under-offer allowed; reserved, sold, rented, inactive, archived refused), archived lead, cross-workspace lead and unit, active-member agent, 6 concurrent requests = 1 created + 5 conflicts, pagination, no agent e-mail in the response, lead status not rewritten, audit entry |
| 0.5 remove Integrations and Automation routers | no endpoint stores or returns secrets | routers deleted; pages deleted; `/integrations` redirects to Lead sources; nav entry removed (browser journey) |
| 0.6 port legacy reads | same numbers under both roles; dashboard equals lists; archived and test excluded; agent scope; auditor out | **Deviation:** new v1 modules (`dashboard`, `matching`) rather than a mechanical swap. `slice0.test.ts` "dashboard numbers reconcile": buckets sum to total, archived and test leads excluded, `includeTest`, stage counts, pipeline value open-only, own-scope for agents, auditor 403, other workspace sees zeros, attribution reports untracked separately with no invented campaigns. The pipeline-velocity report was removed with the legacy reports router (it was failing in production anyway); its replacement is Slice 5 |
| 0.7 settings stop destroying data | saving keeps other keys; timezone affects reminders | `slice0.test.ts` "workspace settings": merge keeps `leadAssignment`, `sla`, `scoring`, `defaultCountry` and unrelated keys; timezone validated and stored in `tenants.timezone`, stale copy removed; unknown keys and bad values 400; If-Match gives 412; only admins write; audit entry. Browser: name and zone saved, an earlier first-reply setting survived. **Deviation:** the page is kept (made safe) rather than hidden until Slice 2 |
| 0.8 honesty | no feature claims more than it does | Dashboard: removed "Live WAL Replication", the fabricated "Stale Leads = 0", "Tasks Due Today" that showed all pending tasks; added "Include test leads". Reports: status buckets that add up; won value labelled an estimate. Attribution rebuilt as "Lead sources" (no ROI, no channel table, no "Live Synced", untracked shown honestly, 390 px overflow fixed). "AI Property Matching" renamed. Automation and Custom fields pages replaced by "Not available yet" with no controls |
| 0.9 CI | green on a clean checkout | `.github/workflows/ci.yml` rewritten: no `./project` working directory, Node 24, high/critical production advisories block, OpenAPI drift check, test-database cleanup, secret scan blocking on pull requests, migration job. **Not yet proven:** it has not run on GitHub (nothing was pushed); every command in it was run locally. Actions are pinned by version tag, not commit SHA, and the TruffleHog tag could not be verified offline |
| 0.10 nodemailer | `npm audit --omit=dev` clean | upgraded 6.10.1 to 10.1.1. New `mail-smtp.test.ts` sends through a local SMTP listener: envelope, encoded subject, link, refused connection surfaces as an error. It also exposed that a malformed recipient string could be re-parsed into a different address, so the transport now refuses anything that is not a single plain address |
| 0.11 documents | a new developer can run it from the README | `README.md`, `.env.native.example` matches the real config names (the old `.env.example` was Supabase leftovers and was removed), runbook rewritten (port 5442, no Python, real commands), ADRs 002 and 003, `docs/README.md` index. **Deviation:** historical documents carry a banner instead of being moved to an archive folder, because the log and other documents link to them |

Also fixed on the way: the shared Input, Textarea and Select did not associate their label with the field unless an id or name was passed (an accessibility defect found because the browser test could not find "Workspace name" by its label); the browser client now reads `application/problem+json` error bodies; `ifMatchVersion` accepts millisecond ETags.

## Found while verifying

- The app has **no screen that books a viewing** (the Calendar empty state claimed there was one). The API is correct and tested; the booking screen belongs to Slice 3. The empty state and the handout now say so.

## Behaviour changes to be aware of

- Sales agents now see only their own viewings (those they run, or on their own leads). Before, every non-auditor saw all of them with buyer contact details.
- Dashboard and report numbers dropped where a workspace had archived or test leads; that is the correction.
- Removed endpoints return 404. Nothing in the app called them.

## Open items (not done, and why)

1. **CI has not run remotely.** Needs a push, which you have not authorised.
2. **Custom-field validation** (type, regex, required, options) is not rebuilt; the feature returns with Slice 2/6 design.
3. **Dev environment still needs the restricted role.** Point `DATABASE_URL` and `WORKER_DATABASE_URL` in your `.env.native` at the `RESTRICTED_*` values so your own dev API runs with row-level security on; I did not edit your secrets file. All tests and my browser run already use the restricted role.
4. **One workspace holds an unused `automation_rules` blob** from the retired screen. Preserved untouched, as instructed. Nothing reads it.
5. **Accessibility sweep is partial:** the shared form-field fix and the new pages are covered; a full axe run in CI is Slice 8.
6. Production gates (backup and restore drill, deployment, monitoring, load test) are Slice 8 and are not met. This is not production-ready.
