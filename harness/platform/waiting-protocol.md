# Waiting Protocol

This protocol prevents agents from asking a question and then continuing past
the blocked stage.

## Approval Gate

Use an approval gate when the next stage requires human acknowledgement.

```bash
harness milestone <kind> <task_id> "<content>" --require-ack
```

Then keep the task `in_progress`:

```bash
harness task update <task_id> in_progress --output '{
  "state": "awaiting_human",
  "waitType": "approval",
  "reason": "<why acknowledgement is required>",
  "resumeCriteria": "<which acknowledgement permits resume>",
  "blockedNextStages": ["<stage>"]
}'
```

## Clarification Gate

Use a clarification gate when the agent needs a human choice or missing
external input.

```bash
harness ask <work_item_id> --task-id <task_id> \
  --question "请选择本次 checkpoint backup 是否允许跑真实 OOS/K8s 验证？" \
  --option "id=run_live;label=允许跑真实验证;recommended" \
  --option "id=stop_at_evidence;label=只停在本地和集成测试"
```

Also record a blocking milestone:

```bash
harness milestone blocker <task_id> "等待人工回复：<原因>" --require-ack
```

And keep the task `in_progress` with awaiting output.

## Platform Assignment Gate

Before claiming that a real Harness work item is fully automated, verify that
the current CLI agent can update the target work item/task:

```bash
harness agent whoami > /tmp/harness-agent.json
harness work-item get <work_item_id> > /tmp/harness-work-item.json
node harness/scripts/check-platform-readiness.mjs \
  --work-item /tmp/harness-work-item.json \
  --agent /tmp/harness-agent.json \
  --task-id <task_id> \
  --report-task-id <owned_report_task_id>
```

If the script exits non-zero, keep the reporting task `in_progress`, emit the
printed blocker milestone / ask commands, and do not start downstream stages.
This covers the case where the work item was created successfully but assigned
to a different agent or requires `assign` / `swap` capability.

## Resume

When the platform provides the answer or acknowledgement:

```bash
harness comment list <work_item_id> --limit 20
harness log <task_id> "收到人工回复，恢复执行：<summary>"
harness task update <task_id> in_progress --output '{
  "state": "resumed",
  "humanAnswer": "<answer or ack summary>",
  "decision": "<selected option or approved action>",
  "resumedAt": "<ISO8601>",
  "resumeCriteriaSatisfied": true
}'
```

Continue only if the answer satisfies `resumeCriteria`.

## Forbidden

- Do not mark the current task `done` while waiting.
- Do not start blocked downstream stages while waiting.
- Do not use a plain comment as a substitute for `harness ask`.
- Do not cross a `--require-ack` gate without platform acknowledgement.
- Do not claim platform acceptance from local tests, smoke tests, or daemon
  availability alone.
