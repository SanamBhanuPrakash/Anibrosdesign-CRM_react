# Start Here — Anibros CRM Handoff

This package carries the project from Bolt into Antigravity with Gemini/Claude.

## Use this package

1. Copy the files/folders from this package into the **root of the downloaded Anibros CRM repository**. If files with these names already exist, compare before replacing. Preserve any useful local changes and merge rather than blindly overwrite.
2. Give the coding agent `AI_AGENT_MASTER_PROMPT.md` and tell it to read `MASTER_CONTEXT.md`, `plan.md`, `PROJECT_LOG.md`, and `ARCHITECTURE_BASELINE_ORIGINAL.md` first.
3. From the repository root run:
   ```bash
   python scripts/update_ai_context.py
   ```
4. Tell the agent to read `AI_CONTEXT_BUNDLE.md`, inspect the actual code/database, update statuses based on evidence, then start implementation.
5. Keep using the same repo-root `plan.md` and `PROJECT_LOG.md` after every significant task. Re-run the Python script before handing work to another model/session.

## Files

- `MASTER_CONTEXT.md` — main project context, user requirements, architecture, prior work, auth issue history, live-sync requirements, observability design and current risks.
- `AI_AGENT_MASTER_PROMPT.md` — copy/paste instructions for Antigravity/Gemini/Claude.
- `plan.md` — new prioritized implementation roadmap with concrete acceptance tests.
- `PROJECT_LOG.md` — evidence-based historical snapshot and appendable project log.
- `ARCHITECTURE_BASELINE_ORIGINAL.md` — original detailed architecture document preserved as historical reference; some status/roadmap text is stale.
- `scripts/update_ai_context.py` — safe context inventory generator. It writes `AI_CONTEXT_BUNDLE.md` only and does not alter source or environment settings.
- `AI_HANDOFF_ALL_IN_ONE.md` — single large Markdown file combining the context, plan, log, master prompt, and original architecture reference.

## First thing to tell the coding agent

“Do not assume the backend works because old documentation says it exists. Inspect this downloaded repo and connected Supabase project. Verify feature wiring. Make live lead synchronization the first product priority, and keep the Operations Center/security work in the same plan. Update the project log and plan continuously. Never make unsupported claims or touch live provider settings without approval.”
