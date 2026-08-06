---
name: agent-manager-harness-orchestration
description: Produces the implementation allowlist, dependency graph, resource locks, isolated environment plan, test matrix, and evidence contract for Agent Manager delivery. Use only for the dev_orchestration stage.
---

# Harness Stage: Dev Orchestration

1. Convert the clarified scope into concrete tasks and dependencies.
2. Declare each task's write scope and shared resource locks before code changes.
3. Define the isolated namespace, service, base URL, image tag, database/tenant
   isolation, and secret references.
4. Define unit, API, browser, and live-integration checks with observable evidence.
5. Require acknowledgement for cross-module, shared-environment, or high-risk work.

Use `plan-test-environment.mjs` for deterministic environment names. Complete
only when the DAG, allowlist, locks, test matrix, evidence, and human gates are
specific enough for another agent to execute without guessing.
