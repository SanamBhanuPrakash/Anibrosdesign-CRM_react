# Documentation index

Which documents to trust. When two disagree, the one higher in this list wins, and the code and tests win over all of them.

## Current

| Document | Use it for |
| --- | --- |
| [audit/2026-10-14/](audit/2026-10-14/) | The audit: what works and what does not (`01` capability matrix), the automation, workflow, integration and security findings, the UX plan, and the approved remediation roadmap (`07`). `00` holds the requirements checklist with evidence. |
| [adr/](adr/) | Decisions: PostgreSQL 17, the approved product decisions D1-D12, retirement of the legacy endpoints. |
| [CRM_HANDOUT.md](CRM_HANDOUT.md) | What each screen does and how to use it, written for a non-engineer. |
| [LOCAL_AND_PRODUCTION_RUNBOOK.md](LOCAL_AND_PRODUCTION_RUNBOOK.md) | Running it locally; production steps (no container image exists yet). |
| [ARCHITECTURE_V2.md](ARCHITECTURE_V2.md) | Target architecture; sections marked as built are verified. |
| [SECURITY_MODEL.md](SECURITY_MODEL.md), [SECURITY_REMEDIATION.md](SECURITY_REMEDIATION.md) | What is enforced, where, and what is not covered. |
| [API_PLATFORM.md](API_PLATFORM.md), [openapi.json](openapi.json) | API conventions; the generated reference (`npm run api:types` regenerates it). |
| [FAILURE_MODES.md](FAILURE_MODES.md), [WAVE3_DOMAIN_DESIGN.md](WAVE3_DOMAIN_DESIGN.md), [LEAD_INTAKE_AND_MONITORING_DESIGN.md](LEAD_INTAKE_AND_MONITORING_DESIGN.md), [UI_DESIGN_SYSTEM.md](UI_DESIGN_SYSTEM.md) | Module designs. |
| [SUBSCRIPTION_DESIGN.md](SUBSCRIPTION_DESIGN.md) | Billing, deferred and not part of the product. |

## Historical (kept for reference; most carry a banner at the top)

`ARCHITECTURE.md`, `NATIVE_POSTGRESQL_ARCHITECTURE.md`, `NATIVE_POSTGRESQL_SCHEMA_MAP.md`, `BACKEND_FEATURE_MATRIX.md`,
`DEPLOYMENT_STATE.md`, `RELEASE_READINESS.md`, `MASTER_ENGINEERING_DIRECTIVE.md`, `MASTER_REQUIREMENTS_LEDGER.md`,
`MASTER_DIRECTIVE_IMPLEMENTATION_PLAN.md`, `REQUIREMENT_TRACEABILITY_MATRIX.md`, `REQUIREMENT_CONFLICTS_AND_DECISIONS.md`,
`SOURCE_COVERAGE_REPORT.md`, `BRANCH_REVIEW_AND_MERGE_GATE.md`, `MIGRATION_AND_ROLLBACK_PLAN.md`,
`legacy_schema_catalog.json`, `raw_supabase_audit.json`, `master_directive_chunks_manifest.json`.

These describe the retired Supabase architecture or earlier plans. Their PASS marks were assigned before the audit and
are not evidence. They were not moved to an archive folder because the project log and several documents link to them.
