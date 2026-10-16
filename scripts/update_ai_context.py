#!/usr/bin/env python3
"""Regenerate a sanitized AI handoff bundle from the repository and context docs.

Safe by design:
- Never reads .env files or prints environment variable values.
- Does not modify application source, migrations, configuration or database.
- Writes only AI_CONTEXT_BUNDLE.md in the current repository root.
- Uses only Python's standard library.

Run from repository root:
    python scripts/update_ai_context.py
Optional:
    python scripts/update_ai_context.py --output AI_CONTEXT_BUNDLE.md
    python scripts/update_ai_context.py --max-files 1200
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import subprocess
from pathlib import Path
from typing import Iterable

SKIP_DIRS = {
    ".git", "node_modules", "dist", "build", ".next", ".vite", ".turbo",
    "coverage", "playwright-report", "test-results", ".venv", "venv",
    "__pycache__", ".idea", ".vscode", "vendor", "target",
}
SKIP_NAMES = {
    ".env", ".env.local", ".env.development", ".env.production",
    ".env.test", ".env.staging", "id_rsa", "id_ed25519", "credentials.json",
    "service-account.json", "supabase-service-role.txt",
}
CONTEXT_FILES = [
    "MASTER_CONTEXT.md",
    "plan.md",
    "PROJECT_LOG.md",
    "AI_AGENT_MASTER_PROMPT.md",
]
TEXT_EXTENSIONS = {
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md",
    ".sql", ".toml", ".yaml", ".yml", ".html", ".css", ".scss",
    ".sh", ".py", ".jsonc",
}


def safe_rel(path: Path, root: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return str(path)


def should_skip(path: Path, root: Path) -> bool:
    rel_parts = path.relative_to(root).parts
    if any(part in SKIP_DIRS for part in rel_parts):
        return True
    if path.name in SKIP_NAMES or path.name.startswith(".env"):
        return True
    if path.suffix.lower() in {".pem", ".key", ".p12", ".pfx", ".keystore", ".sqlite", ".db"}:
        return True
    return False


def run_command(root: Path, args: list[str]) -> tuple[int, str]:
    try:
        proc = subprocess.run(
            args, cwd=root, text=True, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, timeout=8, check=False,
        )
        return proc.returncode, proc.stdout.strip()
    except (OSError, subprocess.TimeoutExpired) as exc:
        return 127, f"Unavailable: {type(exc).__name__}: {exc}"


def git_info(root: Path) -> str:
    code, branch = run_command(root, ["git", "branch", "--show-current"])
    if code != 0:
        return "Git metadata unavailable (not a Git checkout or git command unavailable)."
    _, commit = run_command(root, ["git", "rev-parse", "--short", "HEAD"])
    _, status = run_command(root, ["git", "status", "--short"])
    return "\n".join([
        f"- Branch: `{branch or 'unknown'}`",
        f"- Commit: `{commit or 'unknown'}`",
        "- Working tree status:",
        "```text",
        status if status else "clean (according to git status)",
        "```",
    ])


def package_info(root: Path) -> str:
    p = root / "package.json"
    if not p.exists():
        return "No root `package.json` found. Verify the repository root."
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception as exc:  # don't stop context generation for invalid json
        return f"Could not parse package.json: {exc}"
    scripts = data.get("scripts", {}) or {}
    deps = data.get("dependencies", {}) or {}
    devdeps = data.get("devDependencies", {}) or {}
    lines = [f"- Name: `{data.get('name', 'unknown')}`", f"- Version: `{data.get('version', 'unknown')}`", "", "### Package scripts", "```json", json.dumps(scripts, indent=2, ensure_ascii=False), "```", "", "### Key dependencies (names and versions only)", "```text"]
    for name, version in sorted({**deps, **devdeps}.items()):
        if any(key in name.lower() for key in ("react", "vite", "supabase", "router", "zustand", "tailwind", "typescript", "vitest", "playwright", "jest", "eslint", "zod", "sentry")):
            lines.append(f"{name}: {version}")
    lines.append("```")
    return "\n".join(lines)


def walk_files(root: Path, max_files: int) -> list[Path]:
    files: list[Path] = []
    for base, dirs, names in os.walk(root):
        base_path = Path(base)
        dirs[:] = sorted(d for d in dirs if not should_skip(base_path / d, root))
        for name in sorted(names):
            p = base_path / name
            if should_skip(p, root):
                continue
            if p.is_file():
                files.append(p)
                if len(files) >= max_files:
                    return files
    return files


def file_tree(paths: Iterable[Path], root: Path) -> str:
    grouped: dict[str, list[str]] = {}
    for p in paths:
        rel = safe_rel(p, root)
        first = rel.split("/", 1)[0]
        grouped.setdefault(first, []).append(rel)
    lines: list[str] = []
    for first in sorted(grouped):
        lines.append(f"### `{first}/` (or root files)")
        lines.extend(f"- `{name}`" for name in grouped[first])
        lines.append("")
    return "\n".join(lines).rstrip()


def inventory(paths: list[Path], root: Path) -> str:
    migrations = [p for p in paths if "/migrations/" in ("/" + safe_rel(p, root)) and p.suffix.lower() == ".sql"]
    functions = [p for p in paths if "/functions/" in ("/" + safe_rel(p, root)) and p.suffix.lower() in {".ts", ".js", ".tsx"}]
    tests = [p for p in paths if any(t in p.name.lower() or t in safe_rel(p, root).lower() for t in ("test", "spec", "playwright", "vitest"))]
    lines = ["### SQL migrations", f"Count: {len(migrations)}", *[f"- `{safe_rel(p, root)}`" for p in sorted(migrations)], "", "### Server/Edge Function source files", f"Count: {len(functions)}", *[f"- `{safe_rel(p, root)}`" for p in sorted(functions)], "", "### Candidate test files/config", f"Count: {len(tests)}", *[f"- `{safe_rel(p, root)}`" for p in sorted(tests)], ""]
    if not migrations:
        lines.append("NOTE: No `*.sql` under a path named `migrations` was found by this inventory. Verify project structure manually.")
    if not functions:
        lines.append("NOTE: No obvious Edge Function source files were found by this inventory. They may be in a different folder or absent from this export.")
    if not tests:
        lines.append("NOTE: No candidate test files were found. Check package scripts and add tests where missing.")
    return "\n".join(lines)


def env_names_only(root: Path) -> str:
    """Read .env.example names only if present; never read .env files or values."""
    candidates = [root / ".env.example", root / ".env.sample", root / ".env.template"]
    names: set[str] = set()
    for p in candidates:
        if not p.exists():
            continue
        try:
            for line in p.read_text(encoding="utf-8", errors="ignore").splitlines():
                stripped = line.strip()
                if not stripped or stripped.startswith("#") or "=" not in stripped:
                    continue
                key = stripped.split("=", 1)[0].strip()
                if key and all(ch.isalnum() or ch == "_" for ch in key):
                    names.add(key)
        except OSError:
            pass
    if not names:
        return "No variable names were extracted from `.env.example`/`.env.sample`/`.env.template`. The script intentionally does not read `.env` or secret values."
    return "\n".join(f"- `{name}` (name only; value intentionally omitted)" for name in sorted(names))


def read_context(root: Path) -> str:
    chunks: list[str] = []
    for rel in CONTEXT_FILES:
        path = root / rel
        if path.is_file():
            chunks.append(f"\n\n# BEGIN {rel}\n\n" + path.read_text(encoding="utf-8", errors="replace") + f"\n\n# END {rel}\n")
        else:
            chunks.append(f"\n\n# MISSING CONTEXT FILE: {rel}\n\nCopy/restore this canonical file from the handoff package and keep it updated.\n")
    return "".join(chunks)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default="AI_CONTEXT_BUNDLE.md", help="output path relative to repo root")
    parser.add_argument("--max-files", type=int, default=3000, help="maximum repository files to inventory")
    args = parser.parse_args()

    root = Path.cwd().resolve()
    out = (root / args.output).resolve()
    try:
        out.relative_to(root)
    except ValueError:
        raise SystemExit("Refusing to write outside the repository root.")

    paths = walk_files(root, max(1, args.max_files))
    generated = dt.datetime.now().astimezone().isoformat(timespec="seconds")
    sections = [
        "# Generated AI Context Bundle — Anibros CRM",
        f"\n> Generated: `{generated}`. This file is a generated snapshot; canonical docs remain MASTER_CONTEXT.md, plan.md and PROJECT_LOG.md.",
        "\n## Instructions for the coding agent\n\nRead all embedded canonical docs. Confirm actual repo and database facts. Do not assume historical claims are current. Do not expose secrets. Update the canonical plan and project log after each significant task.",
        "\n## Git state\n\n" + git_info(root),
        "\n## Runtime/package inventory\n\n" + package_info(root),
        "\n## Environment variable names only\n\n" + env_names_only(root),
        "\n## Migration/functions/test inventory\n\n" + inventory(paths, root),
        "\n## Repository file inventory\n\n" + file_tree(paths, root),
        "\n## Canonical project context and plan\n" + read_context(root),
        "\n## Safety notice\n\nThis script did not connect to Supabase, query the database, inspect deployed Edge Functions, execute tests, or read secret values. Those are separate tasks. The presence of a file does not prove runtime deployment or functionality.",
    ]
    out.write_text("\n\n---\n\n".join(sections) + "\n", encoding="utf-8")
    print(f"Wrote {safe_rel(out, root)}")
    print(f"Inventory scanned: {len(paths)} files (max={args.max_files})")
    print("Security: .env files and secret values were not read or emitted.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
