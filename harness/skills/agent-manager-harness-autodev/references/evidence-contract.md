# Evidence Contract

Evidence must be attached to the Harness task output as compact JSON plus links
or paths to artifacts.

## Unit

Unit tests pass only when:

- exit code is `0`
- `testsPassed` equals `totalTests`
- `totalTests` is greater than `0`
- the command is the real command that was executed

## E2E

E2E tests pass only when:

- exit code is `0`
- the target URL is the isolated environment `baseUrl`
- `experienceUrl` points to the page a human can open
- `featureAssertions` lists the feature-specific claims verified by the test
- at least one feature-specific screenshot, video, trace, or browser log exists
- the evidence names the target page, URL, or user flow and mentions the
  current feature, or the artifact is explicitly marked `featureSpecific=true`
- screenshots of login, home, landing, loading, skeleton, blank, empty, or
  unrelated pages do not pass even when Playwright exits with code `0`
- each screenshot includes a feature-specific content descriptor such as
  `domText`, `screenshotText`, `pageTitle`, `description`, `assertions`, or
  `verifiedBehaviors`; an image URL alone is not enough
- browser console errors and failed network requests are empty or explicitly
  waived by a human acknowledgement
- layout overflow checks are recorded for desktop and mobile when UI is touched
- when the manifest declares `requiredAssertions`, every ID has a passed
  `assertionResults` entry and is linked by a screenshot `assertionIds` field
- when the manifest declares `requiresPostActionReadback=true`, an uploaded
  target-system screenshot uses `phase=post_action_readback`, includes the
  target URL and visible feature content, and proves the state after the write
  completed; pre-action pages and submit dialogs are insufficient
- the manifest `postActionReadback` contract constrains the parsed URL pathname
  (query text cannot impersonate the target route) and
  correlation fields; screenshot metadata, `assertionResults`, and (when
  required) successful `actionResults` must identify the same target entity,
  while configured dynamic values such as a Skill display name must appear in
  the visible evidence text
- `complete-stage.mjs` loads the manifest/test binding from the platform-owned
  task template and verifies its digest; a caller-provided manifest cannot
  replace the published E2E evidence policy

## Deploy Ephemeral

Isolated deployment passes only when:

- exit code is `0`
- namespace, service, image tag, and base URL are recorded
- rollout status succeeds
- `/api/health` is read back through the isolated service
- local dev server is not used as a substitute for the cluster service

## API

API tests pass only when:

- exit code is `0`
- the target URL is the isolated environment `baseUrl`
- request/response evidence or a machine-readable test report is attached
- `testsPassed` equals `totalTests`

## Integration Live

Live integration passes only when:

- exit code is `0`
- the target environment is isolated or a human approved shared usage
- OOS, K8s, E2B, Supabase, or gateway evidence is read back from the live
  system, not inferred from daemon availability
- skipped live checks include a human-facing reason and do not become platform
  acceptance

If live integration exits non-zero, the agent must run
`harness/scripts/classify-integration-failure.mjs` and follow the decision:

- explicit external prerequisites, such as missing OOS templates or E2B
  connectivity timeouts, are classified before feature-token matching
- feature-related failures: loop back to `develop`
- external-only failures with no unrelated failures: may continue downstream
  only when the output contains the classification and report link
- unrelated or mixed failures: keep the task `in_progress`, write
  `awaiting_human`, and block `code_review` plus `deploy`

## Deploy

Deploy or platform acceptance passes only when:

- the Harness work item is known
- the milestone or acceptance command is known
- evidence is uploaded or linked
- health checks or platform writeback evidence are included
