---
name: agent-manager-harness-e2e-test
description: Runs browser verification against the isolated Agent Manager deployment and produces feature-specific, post-action visual evidence. Use only for the test_e2e stage.
---

# Harness Stage: Browser E2E

Test the actual isolated `baseUrl` and record an `experienceUrl` a reviewer can
open. The evidence must show the requested feature's final state, not merely a
successful click or test exit code.

Require:

- passed `featureAssertions` and matching `assertionResults`
- screenshots linked to assertion IDs with visible feature text or DOM summary
- post-action target-system readback for state-changing flows
- no login, home, loading, skeleton, blank, or empty-state screenshot as proof
- console and failed-request results, or an explicit acknowledged waiver
- desktop/mobile overflow checks when UI changed

Complete with the guarded command and `--work-item-id`. Missing functional
content or correlation keeps the task `in_progress` even when Playwright exits 0.
