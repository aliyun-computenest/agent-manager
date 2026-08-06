# Waiting And Resume

Use waiting whenever a required human decision, credential, environment, design
approval, or platform input is missing.

## Clarification

Ask structured questions with options:

```bash
harness ask <work_item_id> --task-id <task_id> \
  --question "<question>" \
  --option "id=<id>;label=<label>;recommended" \
  --option "id=<id>;label=<label>"
```

After asking, keep the task `in_progress` and do not run downstream stages.

## Approval

Use an acknowledgement milestone:

```bash
harness milestone <kind> <task_id> "<decision text>" --require-ack
```

Do not continue until the platform records acknowledgement.

## Awaiting Output

Write task output in this shape:

```json
{
  "state": "awaiting_human",
  "waitType": "clarification",
  "reason": "Live K8s namespace is not known.",
  "resumeCriteria": "Human provides namespace or chooses local-only evidence.",
  "blockedNextStages": ["integration_live", "deploy"]
}
```

## Resume Output

Before resuming, read the Harness answer through the platform or CLI, log the
decision, then write:

```json
{
  "state": "resumed",
  "humanAnswer": "Use namespace am-e2e-20260702.",
  "decision": "run_live",
  "resumedAt": "2026-07-02T10:00:00.000Z",
  "resumeCriteriaSatisfied": true
}
```
