---
name: agent-manager-harness-develop
description: Implements Agent Manager changes inside the declared write scope while preserving architecture, security, and real product behavior. Use only for the develop stage.
---

# Harness Stage: Develop

1. Re-read the assigned task and write scope before editing.
2. Change real existing product paths; do not replace required behavior with a
   mock, hard-coded success, or documentation-only implementation.
3. Preserve repository architecture, credential handling, tenant boundaries,
   and immutable migration rules.
4. Add or update focused tests with the implementation.
5. Stop and ask before writing outside the allowlist or changing the agreed scope.

Record the changed files and commit or diff evidence. Do not claim unit,
deployment, browser, or live-integration success from the develop stage.
