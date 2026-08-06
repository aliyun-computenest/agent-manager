---
name: agent-manager-harness-unit-test
description: Runs the declared Agent Manager lint, build, and unit checks and records exact machine-readable results. Use only for the test_unit stage.
---

# Harness Stage: Unit Test

Run the manifest's real commands without weakening, skipping, or replacing them.
A passing result requires all of the following:

- process exit code is `0`
- `totalTests` is greater than `0`
- `testsPassed` equals `totalTests`
- the output records the exact command and relevant report or stdout artifact

If any command fails, keep the task `in_progress` and return to `develop` with
the failure evidence. A successful build alone is not a successful unit stage.
