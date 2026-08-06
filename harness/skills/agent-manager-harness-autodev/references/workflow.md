# Harness Delivery Workflow

## Inputs

Every run starts with these inputs from the external Harness platform:

- `workItemId`
- `taskId`
- `milestoneId` when approval gates are used
- owner token or credential reference outside the repository
- feature manifest path under `harness/manifests/`
- acceptance command or explicit statement that acceptance is not available

If an input is missing, use `harness ask` and keep the task `in_progress`.

## Stages

1. `clarify`: verify the design document, UI input, real feature path, scope,
   environment, and evidence inputs.
2. `dev_orchestration`: publish allowlist, DAG wave, test matrix, and environment plan.
3. `env_prepare`: create or bind the dedicated namespace, service, base URL,
   image tag, database isolation, and secret refs.
4. `develop`: modify only declared `writeScope` files in real business code or
   tests.
5. `test_unit`: run unit checks and record exact exit code and counts.
6. `deploy_ephemeral`: deploy the current build into the dedicated
   namespace/service and read back `/api/health`.
7. `test_api`: run API checks against the isolated environment base URL.
8. `test_e2e`: run browser functional checks against the isolated environment
   base URL and capture feature-specific evidence, `experienceUrl`, and
   `featureAssertions`. Login/home screenshots are rejected unless the feature
   itself is login/home.
9. `integration_live`: use live OOS, K8s, E2B, or Supabase only with required
   inputs and isolation. If the run fails, classify failures before downstream
   stages continue. External prerequisites are classified before feature-token
   matching so missing OOS templates do not look like feature code failures.
10. `code_review`: run automated review and scope guard.
11. `deploy`: run platform acceptance only when the work item and acceptance
    command are known.

## Parallel Work

Parallel tasks may run only when the Harness platform assigns them and their
manifest dependencies are complete. Each task must have independent task output,
evidence, and artifact references.

## State Consistency

Task output and platform task status must agree:

- `output.state=completed` requires platform task status `done`.
- platform task status `done` cannot carry `output.state=awaiting_human`,
  `blocked`, or `failed`.
- downstream stages must not start while an upstream task is still
  `in_progress`, even if its output already contains a successful report.

## Local Dry Run

For local validation, use a delivery run JSON report and run:

```bash
node harness/scripts/validate-delivery-run.mjs \
  --manifest harness/manifests/<feature>.json \
  --run harness/tests/fixtures/<feature>-run.json

node harness/scripts/check-workflow-completion.mjs \
  --manifest harness/manifests/<feature>.json \
  --run harness/tests/fixtures/<feature>-run.json
```
