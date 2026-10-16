# ADR 002: Product and engineering decisions approved for the 2026-10 remediation

## Status
Accepted (owner approval, 2026-10-14). Source: `docs/audit/2026-10-14/07_REMEDIATION_ROADMAP.md`.

## Decisions
| Id | Decision |
| --- | --- |
| D1 | Work happens on the local branch `feat/anibros-crm-remediation-2026-10-14`, committed in reviewable chunks. Nothing is pushed, merged or deployed without separate authorisation. |
| D2 | Slice 0 (security, cross-workspace integrity, restricted-role failures, unsafe legacy endpoints, settings data loss, inaccurate reports, CI and dependency issues) comes first. Legacy endpoints are removed, not kept for compatibility. Existing bad data is reported, never silently deleted or rewritten. |
| D3 | A **completed sale** is a lead that reaches Won **and** has a recorded deal value linked to a specific unit. Booking or reservation is a separate milestone. The number is called "won deal value", not "revenue", unless an accounting integration justifies more. |
| D4 | One "Not a fit" outcome with mandatory reason codes for new workspaces. Existing history is preserved and grouped in reports; it is never rewritten. |
| D5 | Marketing spend: manual entry and CSV import first; automatic Google/Meta sync later. |
| D6 | Viewings are allowed for `available` and `under_offer` units; refused for `reserved`, `sold`, `rented`, `inactive` and archived units, and for archived leads. |
| D7 | A recommended beginner pipeline is applied to **new** workspaces only. An existing pipeline is never replaced silently; applying the recommendation is an explicit, audited action. |
| D8 | Test leads (tag `test`, created by "Send test lead") are excluded from reports by default, with a visible option to include them. |
| D9 | Automation: engine first, templates first, visual builder later. First slice: on lead creation keep an explicit owner or apply the assignment rule, create exactly one follow-up task from workspace settings, notify the owner. Durable, idempotent, tenant-isolated, observable. E-mail and WhatsApp actions stay off until real accounts and implementations exist. |
| D10 | Charts use MUI X Charts, free-licence features only. No paid dependency without approval. |
| D11 | Nodemailer is upgraded to a fixed major version with regression tests; the production dependency audit must be clean. |
| D12 | Keep the rebuilt MUI screens as the foundation; fix specific defects; redesign navigation by job (Home / Sales / Inventory / Marketing / Automation / Analytics / Administration). No invented campaign data, false connection states, fake automation success or unsupported metrics. |

## Consequences
- Every later slice is judged against these definitions; a report that contradicts one is a defect.
- Production readiness is not declared until the gates in the roadmap (security, restricted role, CI, backup and restore, deployment, monitoring, load, accessibility) pass.
