# Agent Instructions for Harness CLI Work Items

You are working inside an Agent Manager repository that provides a Harness
rules pack under `harness/`.

## Before Work

1. Run `harness context <work_item_id>` and read the full work item context.
2. Read `AGENTS.md`, `docs/DEVELOPMENT.md`, and the relevant manifest under
   `harness/manifests/`.
3. Confirm `harness context` lists `agent-manager-harness-core` and the current
   stage's cloud Skill. If either is missing, keep the task `in_progress` and
   report a template binding problem instead of loading a personal local Skill.
4. Start the current task with `harness task update <task_id> in_progress`.
5. Produce or confirm the file allowlist before writing code.
6. In `dev_orchestration` / 实施编排, generate isolated environment inputs with
   `node harness/scripts/plan-test-environment.mjs`.

## During Work

- Use `harness log <task_id> "<message>"` for concise progress.
- Use `harness milestone` only for decisions/blockers that really need human
  acknowledgement. AOneCI success progress must be a normal log/report, not a
  milestone.
- Use `harness ask` for structured human decisions.
- Do not continue downstream work after asking a blocking question.
- Do not read or print tokens, kubeconfigs, `.env` secrets, or owner tokens.
- Do not write outside the declared `writeScope`.

## Evidence Rules

- Unit test completion requires exit code 0 and `testsPassed == totalTests`.
- Environment preparation requires a dedicated namespace, service, base URL,
  image tag, database isolation, and secret refs.
- API test completion requires requests against the isolated environment
  `baseUrl`, not localhost or mocks.
- Browser E2E completion requires the isolated environment `baseUrl` plus
  `experienceUrl`, `featureAssertions`, and feature-specific screenshot, trace,
  video, or log evidence. Login/home screenshots do not pass unless that is the
  requested feature.
- Live OOS/K8s completion requires direct readback evidence, not only daemon or
  CI availability.
- Platform acceptance requires a Harness work item, milestone, and platform
  acceptance command.

## Completion Rules

Before marking any task done:

1. Re-read the stage requirements.
2. Run the required verification.
3. Include evidence in `--output`.
4. Validate the delivery run report with
   `node harness/scripts/validate-delivery-run.mjs`.
5. Render and upload the human-readable report with
   `node harness/scripts/render-delivery-report.mjs`.
6. Confirm no blocker or required acknowledgement is still open.

If any required evidence is missing, keep the task `in_progress` and follow
`harness/platform/waiting-protocol.md`.
