# Harness Parallel Development Trial

本文件定义如何用 Harness 平台在 Agent Manager 仓库跑多任务并发开发
trial。目标是让多个 worker 同时推进互不冲突的任务，同时保留平台日志、
等待状态、测试证据和最终验收边界。

## 适用范围

使用本流程时，必须已经有 Harness work item、task 列表、manifest 和平台
agent 连接。仓库内脚本只负责规划、验证和生成报告；Harness 平台负责派发、
日志、人工确认和最终 acceptance。

如果缺少 work item、milestone 或 acceptance command，本次 trial 只能停在
证据边界，不能宣称平台最终验收完成。

## 任务选择原则

选择并发任务前，先把 feature 拆成 DAG。每个 task 必须有 stage、
dependsOn、resources、writeScope 和验收证据。

优先选择满足以下条件的任务进入同一 wave：

- 任务之间没有 DAG 依赖。
- `writeScope` 没有重叠。
- `resources` 没有共享独占锁。
- 每个任务都能独立产出 unit、E2E、集成或平台日志证据。
- 每个任务都能由一个 worker 在自己的允许写入范围内完成。

不要把以下任务放进同一并发 wave：

- 同一后端 route/service 的开发任务。
- 同一前端页面或状态容器的开发任务。
- 同一测试文件或测试 fixture 的修改任务。
- 同一 Supabase 测试库、E2B quota、K8s namespace 或 OOS template 的 live
  验证任务。
- 需要同一个人工确认才能继续的下游任务。

## writeScope 和 Resource Lock 要求

每个 develop、test、integration_live task 都必须声明 `writeScope`。只读验证
任务可以使用空 `writeScope`，但仍要声明会触碰的 `resources`。

`writeScope` 要写到最小可执行范围。例如：

```json
{
  "id": "worker-c-platform-doc",
  "stage": "develop",
  "dependsOn": ["orchestrate-delivery-dag"],
  "resources": ["file:harness"],
  "writeScope": ["harness/platform/parallel-development-trial.md"],
  "description": "Document the Harness parallel development trial flow."
}
```

`resources` 用来表达文件之外的共享风险。常用锁包括：

- `file:backend`
- `file:frontend`
- `file:tests`
- `file:harness`
- `supabase:test`
- `e2b:quota`
- `k8s:target-namespace`
- `oos:backup-template`

硬性禁止：

- 禁止同一 `writeScope` 并发写。
- 禁止包含父子路径关系的 `writeScope` 并发写，例如 `harness/platform/**`
  和 `harness/platform/task-template.md`。
- 禁止绕过 `resources` 共享锁并发跑 live 集成。
- 禁止写入 task allowlist 以外的文件。

## 并发 Wave 生成命令

先用 manifest 生成安全 wave。该命令只读仓库文件，不派发任务：

```bash
node harness/scripts/plan-parallel-waves.mjs \
  --manifest harness/manifests/<feature>.json
```

输出中的 `waves` 是可并发执行的批次，`serializedByLocks` 是因为
`writeScope` 或 `resources` 冲突而被串行化的任务。只有同一个 wave 内的
任务可以同时派发。

示例输出形态：

```json
{
  "schemaVersion": "1.0",
  "featureId": "checkpoint-backup",
  "dispatchModel": "harness-daemon-safe-waves",
  "waves": [
    {
      "index": 0,
      "tasks": ["clarify-delivery-inputs"],
      "resourceLocks": [],
      "writeScope": []
    },
    {
      "index": 1,
      "tasks": ["backend-api", "frontend-ui", "platform-doc"],
      "resourceLocks": ["file:backend", "file:frontend", "file:harness"],
      "writeScope": [
        "agent-manager/server/routes/checkpoint-backups.js",
        "agent-manager/src/components/checkpoint/**",
        "harness/platform/parallel-development-trial.md"
      ]
    }
  ],
  "serializedByLocks": []
}
```

如果 `serializedByLocks` 不为空，平台调度必须把对应任务放到后续 wave。

## 本地并发 Trial 命令

在提交给平台前，可以先跑一个仓库内的只读 trial，验证 DAG、资源锁、并发
wave 和 task 证据输出是否符合预期：

```bash
node harness/scripts/run-parallel-flow-trial.mjs \
  --manifest harness/tests/fixtures/parallel-flow-trial.json \
  --trial harness/tests/fixtures/parallel-flow-trial.json
```

该命令不会调用 Harness CLI，也不会认领平台任务。它只执行受限的
repo-local Node 命令或短延迟 `node -e` trial 脚本，并输出可审计 JSON：

```json
{
  "status": "passed",
  "waves": [
    { "index": 0, "tasks": ["edit-api-route", "edit-ui-panel"] },
    { "index": 1, "tasks": ["verify-parallel-flow"] }
  ],
  "parallelism": {
    "observedMax": 2
  }
}
```

如果平台或人工指定了非法同 wave override，例如两个 task 共享同一
`resources` 或重叠 `writeScope`，trial 必须失败：

```bash
node harness/scripts/run-parallel-flow-trial.mjs \
  --manifest harness/tests/fixtures/parallel-flow-lock-conflict.json \
  --trial harness/tests/fixtures/parallel-flow-lock-conflict.json
```

本地 trial 通过只能证明规则包和任务拆分可执行；不能替代 Harness 平台的
work item、task update、ask/milestone 等链路证据。

## 平台指派就绪检查

真实 Harness 平台试跑开始前，先确认当前 CLI agent 拥有目标 work item /
task。否则即使 work item 已经创建，当前 agent 也可能无法写 task output 或
越过卡点。

```bash
harness agent whoami > /tmp/harness-agent.json
harness work-item get <work_item_id> > /tmp/harness-work-item.json
node harness/scripts/check-platform-readiness.mjs \
  --work-item /tmp/harness-work-item.json \
  --agent /tmp/harness-agent.json \
  --task-id <task_id> \
  --report-task-id <owned_report_task_id>
```

输出 `status=ready` 才能继续派发当前 agent 的后续阶段。输出
`status=awaiting_human` 时，必须按 JSON 里的 `reportingCommands` 发
blocker / ask，并把 `platformAcceptance.claimedPlatformComplete` 保持为
`false`。

## 平台 Work Item 和 Task 日志要求

每个 worker 开始前必须读取平台上下文：

```bash
harness context <work_item_id>
```

每个 task 开始时必须标记 `in_progress`：

```bash
harness task update <task_id> in_progress
harness log <task_id> "worker=<worker-id> scope=<writeScope> start"
```

每个关键节点必须留下平台日志或 milestone：

```bash
harness milestone dev_plan <task_id> "<plan summary>" --require-ack
harness log <task_id> "implemented files=<file-list>"
harness log <task_id> "unit evidence: <command> exitCode=0 testsPassed=<n> totalTests=<n>"
harness log <task_id> "e2e evidence: <artifact-url-or-path>"
harness milestone completion_summary <task_id> "<summary>"
```

完成 task 时，`--output` 必须包含结构化证据：

```bash
harness task update <task_id> done --output '{
  "stage": "test_e2e",
  "state": "completed",
  "summary": "Verified checkpoint backup UI flow.",
  "evidence": [
    "node --test agent-manager/tests/checkpoint-backups.test.js",
    "artifacts/checkpoint-backup-ui-trace.zip"
  ],
  "artifacts": [
    {
      "kind": "trace",
      "url": "harness://artifacts/<artifact-id>"
    }
  ],
  "testsPassed": 18,
  "totalTests": 18
}'
```

## 卡点和等待行为

遇到缺少输入、需要人工选择、需要 ack 或外部平台不可用时，必须停在当前
task。不要继续下游 stage。

人工选择用 `harness ask`：

```bash
harness ask <work_item_id> --task-id <task_id> \
  --question "是否允许本次 trial 跑真实 OOS/K8s 集成验证？" \
  --option "id=run_live;label=允许跑真实验证;recommended" \
  --option "id=stop_at_evidence;label=只停在本地和集成测试"
```

同时记录 blocker milestone，并保持 task 为 `in_progress`：

```bash
harness milestone blocker <task_id> "等待人工回复：缺少 live 集成授权" --require-ack
harness task update <task_id> in_progress --output '{
  "state": "awaiting_human",
  "waitType": "approval",
  "reason": "缺少 live OOS/K8s 验证授权",
  "resumeCriteria": "平台回复 run_live 或 stop_at_evidence",
  "blockedNextStages": ["integration_live", "deploy"]
}'
```

恢复前先读取平台回复：

```bash
harness comment list <work_item_id> --limit 20
harness log <task_id> "收到人工回复，恢复执行：<summary>"
```

只有回复满足 `resumeCriteria`，worker 才能继续。

## 失败判定

满足任一条件时，本次 trial 或单个 task 判定失败：

- task 写入了 `writeScope` 以外的文件。
- 同一 wave 中出现重叠 `writeScope`。
- 同一 wave 中出现共享独占 `resources`。
- 单测命令非 0，或 `testsPassed != totalTests`。
- E2E stage 缺少截图、trace、video 或可审计日志。
- integration_live stage 只有 daemon 可用性或本地 smoke 结果，没有直接
  readback 证据。
- 等待人工回复后仍继续下游 task。
- 缺少 E2E 或集成证据就把 task 标为 `done`。
- 没有平台 acceptance command 就宣称最终验收完成。
- 输出里包含 token、owner-token、kubeconfig、`.env` secret 或其它凭据。

失败时，worker 要把 task 保持在 `in_progress` 或标记为平台定义的失败状态，
并记录失败证据。不要用本地成功覆盖平台失败。

## 证据模板

每个 worker 结束时，把以下信息写入 task output、artifact report 或
completion milestone：

```json
{
  "worker": "<worker-id>",
  "taskId": "<task_id>",
  "stage": "<stage>",
  "writeScope": ["<allowed-file-or-glob>"],
  "resources": ["<resource-lock>"],
  "changedFiles": ["<file>"],
  "commands": [
    {
      "command": "<command>",
      "exitCode": 0,
      "testsPassed": 0,
      "totalTests": 0,
      "stdoutArtifact": "<artifact-url-or-path>"
    }
  ],
  "e2eEvidence": [
    {
      "kind": "screenshot|trace|video|log",
      "url": "<artifact-url-or-path>"
    }
  ],
  "integrationEvidence": [
    {
      "kind": "readback|oos-log|k8s-object|api-response",
      "url": "<artifact-url-or-path>"
    }
  ],
  "acceptance": {
    "command": "<platform-acceptance-command>",
    "status": "passed|blocked|not-run",
    "reason": "<required when blocked or not-run>"
  }
}
```

如果 `acceptance.status` 是 `not-run`，最终报告必须写清楚缺少的
platform input，例如 `workItemId`、`milestoneId` 或 `acceptanceCommand`。

## 可复制 Harness CLI 示例

以下示例不包含 token 或 owner-token。按真实 work item、task id 和 artifact
路径替换占位符。

```bash
# 1. 读取平台上下文
harness context WI-12345

# 2. 生成并发 wave，只读
node harness/scripts/plan-parallel-waves.mjs \
  --manifest harness/manifests/checkpoint-backup.json

# 3. worker C 开始自己的 task
harness task update TASK-platform-doc in_progress
harness log TASK-platform-doc \
  "worker=C start writeScope=harness/platform/parallel-development-trial.md resources=file:harness"

# 4. 记录计划并等待 ack
harness milestone dev_plan TASK-platform-doc \
  "新增 Harness 多任务并发开发 trial 文档，覆盖 wave、锁、日志、等待、失败和证据模板。" \
  --require-ack

# 5. 遇到缺少 live 验证授权时发起结构化 ask
harness ask WI-12345 --task-id TASK-integration-live \
  --question "是否允许本次 trial 跑真实 OOS/K8s 集成验证？" \
  --option "id=run_live;label=允许跑真实验证;recommended" \
  --option "id=stop_at_evidence;label=只停在本地和集成测试"

harness milestone blocker TASK-integration-live \
  "等待人工回复：缺少 live 集成授权" \
  --require-ack

harness task update TASK-integration-live in_progress --output '{
  "state": "awaiting_human",
  "waitType": "approval",
  "reason": "缺少 live OOS/K8s 验证授权",
  "resumeCriteria": "平台回复 run_live 或 stop_at_evidence",
  "blockedNextStages": ["integration_live", "deploy"]
}'

# 6. 上传证据并完成 worker C 的文档 task
harness upload archive artifacts/parallel-development-trial-doc.zip \
  --work-item-id WI-12345

harness milestone completion_summary TASK-platform-doc \
  "worker C 完成平台并发 trial 文档；未修改 writeScope 外文件。"

harness task update TASK-platform-doc done --output '{
  "stage": "develop",
  "state": "completed",
  "summary": "Added Harness parallel development trial documentation.",
  "evidence": [
    "harness/platform/parallel-development-trial.md",
    "node harness/scripts/plan-parallel-waves.mjs --manifest harness/manifests/checkpoint-backup.json"
  ],
  "artifacts": [
    {
      "kind": "archive",
      "url": "harness://artifacts/<artifact-id>"
    }
  ]
}'
```

## 最终验收边界

trial 可以在本地完成文档、代码、unit、E2E 和 live evidence 收集，但最终验收
只属于 Harness 平台。最终报告必须同时具备：

- Harness work item。
- 已记录的 task 日志和 milestones。
- 所有 required stages 的结构化 evidence。
- 通过的 delivery run validation。
- 平台提供的 acceptance command 及其成功输出。

缺少任一项时，报告只能写 `acceptance.status=blocked` 或
`acceptance.status=not-run`，不能写最终验收完成。
