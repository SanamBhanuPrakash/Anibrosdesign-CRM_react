# ADR 005: Recommended pipeline for new workspaces, reason codes, point-in-time history

## Status
Accepted and implemented in Slice 2 (decisions D4, D7; findings in `docs/audit/2026-10-14/03_PRODUCT_WORKFLOW_PIPELINE_INVENTORY.md` §3).

## Context
The seeded pipeline was strict (a new lead could only go to three stages; "Contacted" was refused; Nurture was a dead end), had two
different "not a fit" outcomes that reports could not tell apart, and recorded history by stage id so that renaming a stage or
changing its probability rewrote how the past read. Workspace settings were split between a page that wiped them and an API nobody used.

## Decision
1. **New workspaces start with the recommended pipeline** (`app.seed_beginner_pipeline`, template `beginner_v1`): twelve plain stages,
   free movement between open stages and into the outcomes, `Won` only from `Booked`, `Follow up later` requires a follow-up date,
   one `Not a fit` outcome. Stage keys are kept where the meaning is the same (`new`, `contacted`, `qualified`, `won`, `lost`, …) so integrations
   and imports that refer to them keep working.
2. **Existing pipelines are never replaced or silently changed.** The only automatic change is additive: stages with key `nurture` that had
   no way out gain exits (to every stage except themselves and Won), and only in pipelines that restrict moves. Everything else for an existing
   workspace happens through an explicit, permission-checked, audited action: `POST /pipelines/apply-recommended` adds the recommendation as a
   *second* pipeline (optionally as the one new leads start in). It is idempotent, moves no lead, and a unique index allows one such pipeline per workspace.
3. **Reason codes** for Lost and Not a fit: fixed catalogues in code (stable codes, reword-able labels, "other" always needs a note), stored on the
   lead and on its history row. `pipelines.reason_codes_required` makes them mandatory; it is on for the recommended pipeline and off for older
   ones, which keep their written-reason rule. It is a visible setting (Advanced) in either direction. Reports group outcomes by code; leads closed
   before codes existed are shown as "No reason recorded", never guessed.
4. **History is a snapshot.** Every `lead_stage_history` row carries the stage name, meaning and probability at that moment, filled by a database
   trigger so no code path (API, import, SQL function, stage archive) can forget. Existing rows were back-filled with the current values and flagged
   `snapshot_backfilled`, because for them "as it was then" cannot be known.
5. **Basic and Advanced.** Basic changes only names, colours, order and which stages exist (new stages are "in progress"); it cannot change what a stage
   means or how likely it is to win. Advanced holds meaning, chance, move rules, required details and the reason-code switch.
6. **One settings writer.** The workspace page (`/settings/workspace`, old address redirects) is the only editor of the settings blob and uses the
   merge-style API from Slice 0; it now covers name, time zone, currency, phone country, assignment rule and first-reply time. Brand colours and
   lead-scoring weights are not offered: nothing used the colours, and re-scoring on a weight change is not built.

## Consequences
- Tests that assumed the old seeded pipeline for a signed-up workspace now ask for it explicitly (`register({ legacyPipeline: true })`); the new suites
  cover the recommended pipeline and the upgrade path.
- The reports' "Not a fit" bucket already combined the old Invalid and Unqualified outcomes (both map to the same status); nothing was rewritten.
- A workspace that already has a pipeline named like a template is unaffected; the template is identified by its `template` column, not its name.
- Cross-pipeline moves of existing leads are still not supported, so adopting the recommendation for existing leads means finishing them in the old pipeline.
