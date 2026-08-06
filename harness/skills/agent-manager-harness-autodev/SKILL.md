---
name: agent-manager-harness-autodev
description: Runs Agent Manager Harness AutoDev gates for design-to-release work. Use when developing Agent Manager features with Harness, validating DAG stages, test isolation, evidence, human waiting/resume, task output, artifact writeback, or automated review gates.
---

# Agent Manager Harness AutoDev

Use this skill when an Agent Manager feature is delivered through the external
Harness platform or through a local dry run that must produce Harness-compatible
evidence.

This skill does not replace Harness CLI. It tells agents how to consume this
repository's `harness/` rules pack, execute a feature DAG, stop for human input,
and produce a delivery run report that can be judged automatically.

## 给团队/Qoder 的最短启动口令

```text
请使用仓库内 `harness/skills/agent-manager-harness-autodev`。
阶段必须按 `clarify -> dev_orchestration -> env_prepare -> develop -> test_unit -> deploy_ephemeral -> test_api -> test_e2e -> integration_live -> code_review -> deploy` 执行。
AOneCI 生命周期只走 `node harness/scripts/aone-lifecycle.mjs ...`；不要直接执行底层 AOneCI 命令。
AOneCI 成功进展只能写 `harness log`、task output 或 artifact，不能写 `harness milestone`。
test_e2e 必须写 `experienceUrl`、`featureAssertions`，截图/trace 必须能看出本次功能，登录页/首页截图不能通过。
加载态、骨架屏、空白页、暂无数据截图不能通过；截图必须带 `domText`、`screenshotText`、`description` 或 `assertions` 等内容摘要。
integration_live 失败后先跑 `classify-integration-failure.mjs`：本功能相关失败回 develop，纯外部前置失败可自动继续，混合不相关失败必须 ask 人工。
最终完成前跑 `check-workflow-completion.mjs`，失败时不能手工把下游任务标 done。
```

## Workflow

1. Read the feature manifest under `harness/manifests/`.
2. Complete `dev_orchestration`: produce allowlist, DAG waves, resource locks,
   isolated environment orchestration, test matrix, and evidence requirements. Use
   `node harness/scripts/plan-test-environment.mjs` for deterministic names.
3. Execute only the current DAG wave assigned by Harness.
4. Use Harness CLI for all task state, milestones, asks, comments, and uploads.
5. Stop at human gates by following `references/waiting-resume.md`.
6. Write compact task outputs and artifact links by following
   `references/output-artifacts.md`.
7. Before completion, validate the delivery run report with
   `node harness/scripts/validate-delivery-run.mjs`.
8. Before final workflow completion, run
   `node harness/scripts/check-workflow-completion.mjs`.
9. Render a human-readable report with
   `node harness/scripts/render-delivery-report.mjs` and upload it to Harness
   whenever a stage uses AOneCI, browser evidence, or live integration evidence.

## AOneCI 主路径

Agents should call the wrapper and let it render a compact JSON output/report:

```bash
node harness/scripts/aone-lifecycle.mjs env-create --work-item <id> --task-id <id> --branch <branch>
node harness/scripts/aone-lifecycle.mjs deploy-image --work-item <id> --task-id <id> --branch <branch> --namespace <ns>
node harness/scripts/aone-lifecycle.mjs smoke-api --work-item <id> --task-id <id> --branch <branch> --base-url <url>
node harness/scripts/aone-lifecycle.mjs integration --work-item <id> --task-id <id> --branch <branch> --base-url <url> --namespace <ns>
node harness/scripts/aone-lifecycle.mjs cleanup --work-item <id> --task-id <id> --branch <branch> --namespace <ns>
```

For local validation use `--dry-run --no-write-harness`.

## Required References

- `references/workflow.md` for the stage-by-stage execution contract.
- `references/evidence-contract.md` for unit, E2E, integration, and deploy
  evidence requirements.
- `references/waiting-resume.md` for `harness ask`, `--require-ack`, and resume
  behavior.
- `references/review-gate.md` for automated review and merge readiness.
- `references/output-artifacts.md` for task output and artifact writeback.

## Core Rule

Never mark a task or platform acceptance as complete from local success alone.
Completion requires the feature manifest, Harness task state, required evidence,
and any human acknowledgement to agree.
