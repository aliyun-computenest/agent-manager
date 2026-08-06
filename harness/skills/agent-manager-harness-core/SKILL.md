---
name: agent-manager-harness-core
description: Applies the shared Harness state, waiting, evidence, security, and completion contract to every Agent Manager delivery stage. Use together with the stage-specific Agent Manager Harness skill selected by the task template.
---

# Agent Manager Harness Core

Use this cloud skill on every Harness stage. The stage-specific skill defines
what to do; this skill defines how state, evidence, waiting, and completion are
written back to Harness.

## Start The Stage

1. Read `harness context <work_item_id>` and use only the current assigned task.
2. Read the feature manifest under `harness/manifests/`.
3. Run `harness task update <task_id> in_progress` before doing stage work.
4. Record concise progress with `harness log <task_id> "<message>"`.

## Waiting

- Use `harness ask` for a choice or missing input.
- Use `harness milestone <kind> <task_id> "<reason>" --require-ack` only for a
  decision or blocker that requires acknowledgement.
- While waiting, keep the task `in_progress`, write `state=awaiting_human`, and
  do not start blocked downstream stages.
- A normal comment is not a structured answer and must not resume the workflow.

## Evidence And Security

- Keep task output compact and upload large logs, screenshots, videos, or traces.
- Never print or store API keys, owner tokens, kubeconfigs, `.env` secrets, or
  temporary credentials in task output, artifacts, or repository files.
- Local success is not platform success. Evidence must identify the command,
  target environment, exit code, result counts, and relevant artifact links.

## Complete The Stage

Do not mark a task done directly. Write the stage output JSON, then run:

```bash
node harness/scripts/complete-stage.mjs \
  --stage <stage> --task-id <task_id> --output <stage-output.json>
```

For `test_e2e`, also pass `--work-item-id <work_item_id>`. Before final workflow
completion run `check-workflow-completion.mjs`. A red guard, open acknowledgement,
or missing evidence keeps the current task `in_progress`.
