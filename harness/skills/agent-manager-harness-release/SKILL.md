---
name: agent-manager-harness-release
description: Runs final Harness acceptance, preserves the review environment until explicit approval, and cleans it only after approval or cancellation. Use only for the deploy stage.
---

# Harness Stage: Release And Acceptance

1. Run `check-workflow-completion.mjs` and the platform-defined acceptance command.
2. Confirm every required stage, artifact, acknowledgement, and review finding is closed.
3. Publish the retained experience URL and final evidence summary for human review.
4. Keep the isolated environment running while approval is pending.
5. Trigger the cleanup wrapper only after explicit approval, cancellation, or a
   direct cleanup request; record the cleanup run ID and result.

Never convert local tests, a merge request, or deployment health alone into
platform acceptance. An unapproved delivery remains `in_progress` with
`state=awaiting_human`.
