---
name: agent-manager-harness-code-review
description: Reviews the Agent Manager delivery diff, scope, architecture, security, tests, and live evidence without relying on a local personal review skill. Use only for the code_review stage.
---

# Harness Stage: Code Review

1. Compare the changed files with the manifest allowlist and task write scopes.
2. Review correctness, regressions, tenant boundaries, credential handling,
   command injection risks, and architecture rules.
3. Confirm required unit, API, E2E, and live evidence belongs to this build.
4. Confirm the worktree contains no unrelated or generated artifacts.
5. Record actionable findings with severity and file/line evidence.

Run the kit's deterministic scope and delivery validators. Complete only when
there are no unresolved blocking findings or each accepted blocker has explicit
human acknowledgement. This cloud skill is the review contract; do not require
`~/.qoder/skills` or `~/.codex/skills` to perform the stage.
