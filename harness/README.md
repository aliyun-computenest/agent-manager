# Agent Manager Harness Rules Pack

This directory is the canonical source for Agent Manager's Harness rules,
stage Skills, manifests, and local workflow helpers. Agents run these files
from the Agent Manager repository; cloning a separate Harness kit repository
is not required.

This package integrates with the external Harness platform. It is not a
replacement for Harness CLI, Harness Daemon, or the Harness web platform.

## What Lives Here

- `rules/` defines reusable delivery rules, waiting gates, evidence gates, and
  parallelism constraints.
- `platform/` contains Markdown templates that can be copied into Harness task
  templates or agent instructions.
- `domains/agent-manager.json` maps Agent Manager design docs, UI evidence,
  test commands, and live OOS/K8s evidence chains to the generic rules.
- `manifests/` contains feature-level examples that the platform can use to
  dispatch parallel work and verify evidence.
- `config/stage-skills.json` declares the cloud Skill set selected by each stage.
- `skills/agent-manager-harness-core/` plus the 11 stage Skill directories are
  published to the Harness Workspace; templates bind them by cloud `skillIds`.
- `scripts/` contains local helpers for validating/rendering this rules pack
  plus the `aone-lifecycle.mjs` wrapper that hides raw AOneCI command assembly
  from agents.

## What Does Not Live Here

- No `owner-token`, API key, agent id, kubeconfig, or service credential.
- No wrapper around `harness connect`.
- No custom scheduler or replacement for Harness task dispatch.
- No final platform acceptance writeback.

Harness platform identity is provided externally:

```bash
npx -y --registry=https://registry.anpm.alibaba-inc.com @ali/harness@latest connect \
  --server-url <platform-url> \
  --owner-token <platform-issued-token> \
  --name "agent-manager-main" \
  --provider claude
```

The CLI stores credentials outside the repository, normally under
`~/.harness/credentials.json`, or reads them from environment variables such as
`HARNESS_API_KEY` and `HARNESS_SERVER_URL`.

## Required Agent Behavior

Agents must report progress through Harness CLI:

- Start a stage with `harness task update <task_id> in_progress`.
- Record normal progress with `harness log`; reserve `harness milestone` for
  human-approved decisions and blockers.
- Ask for human clarification with `harness ask`.
- Read replies with `harness comment list <work_item_id>`.
- Upload screenshots or archives with `harness upload`.
- Publish structured delivery reports with `harness artifact create`.
- Keep blocked tasks `in_progress` until the required human answer or
  acknowledgement arrives.
- Mark a stage `done` only when its required evidence is present.

Do not continue after asking a question. Do not mark a `--require-ack`
milestone complete before the platform records acknowledgement.
Do not use a milestone for successful AOneCI progress that does not need human
approval; it can create a false pending gate.

## Cloud Stage Skills

Harness stages use cloud Skills as their normal instruction source:

- `harness/skills/agent-manager-harness-core/SKILL.md`
- one stage Skill selected by `harness/config/stage-skills.json`
- `harness/platform/WORKFLOW.md`
- `harness/manifests/<feature>.json`
- `harness/scripts/aone-lifecycle.mjs`
- `harness/scripts/classify-integration-failure.mjs`
- `harness/scripts/check-workflow-completion.mjs`

The selected cloud Skills are shown in `harness context` as `slug@version`.
Do not replace them with a path under `~/.qoder/skills`, `~/.codex/skills`, or
the legacy monolithic Skill.

The short execution contract is:

```text
使用当前 Harness 阶段配置的云端公共 Skill 和阶段 Skill。
按 clarify -> dev_orchestration -> env_prepare -> develop -> test_unit -> deploy_ephemeral -> test_api -> test_e2e -> integration_live -> code_review -> deploy 执行。
AOneCI 阶段只调用 node harness/scripts/aone-lifecycle.mjs ...。
test_e2e 必须提供 experienceUrl、featureAssertions 和功能相关截图/trace，登录页/首页截图不能通过。
加载态、骨架屏、空白页、暂无数据截图也不能通过；截图必须带功能内容摘要，不能只给图片 URL。
manifest 声明 requiredAssertions/requiresPostActionReadback 时，必须提交 assertionResults，并用截图 assertionIds 关联必需断言。
安装、创建、更新等写操作必须截图目标系统的操作后终态（phase=post_action_readback）；操作前页面或提交弹窗不能代替。
integration_live 失败后先跑 classify-integration-failure.mjs。
最终完成前跑 check-workflow-completion.mjs，失败不得手工标 done。
```

## Local Helpers

The existing local helper scripts remain intentionally small:

```bash
make setup-env
make start-server
make teardown-env
```

They cover local-dev/mock health checks only. Passing those helpers does not
prove live OOS/K8s behavior and does not mean Harness platform acceptance.

## AOneCI Isolated Environment

Full-flow Agent Manager AutoDev uses AOneCI as the environment lifecycle
authority. Project initialization should resolve or create these pipelines and
store only their ids in the Harness platform/workspace configuration.

The CI YAML files live in this Agent Manager repository. If they are missing,
the agent must stop instead of starting live environment work.

All three pipelines require the repository-level AOneCI Secret
`HZ_KUBECONFIG_B64`. They fail fast when it is missing to avoid accidentally
using a runner-default kubeconfig against the wrong cluster.

- `.aoneci/harness_env_create.yaml`: creates the per-work-item namespace,
  Service, runtime Secret references, and environment ConfigMap.
- `.aoneci/harness_build_deploy.yaml`: builds the current branch image, pushes
  it to the public Hangzhou registry, deploys the namespace Deployment/Service,
  and reads back `/api/health`.
- `.aoneci/harness_env_cleanup.yaml`: deletes the per-work-item namespace with
  prefix and work-item label guards.

Agents should trigger them through the wrapper, then write the run id and
readback evidence to the Harness task output:

```bash
node harness/scripts/aone-lifecycle.mjs env-create \
  --work-item <work-item-id> \
  --task-id <task-id> \
  --branch <remote-branch> \
  --namespace <namespace>

node harness/scripts/aone-lifecycle.mjs deploy-image \
  --work-item <work-item-id> \
  --task-id <task-id> \
  --branch <remote-branch> \
  --namespace <namespace> \
  --image-tag <image-tag>

node harness/scripts/aone-lifecycle.mjs integration \
  --work-item <work-item-id> \
  --task-id <task-id> \
  --branch <remote-branch> \
  --base-url <base-url> \
  --namespace <namespace>
```

Raw `a1 ci pipeline ...` commands may appear in rendered templates as
troubleshooting hints, not as the agent's normal execution path.

Local `kubectl`, Docker, or dev-server commands may help diagnose a failure,
but they are not sufficient evidence for `env_prepare`, `deploy_ephemeral`,
`test_api`, or `test_e2e`.

## Validation

```bash
node harness/scripts/validate-rules.mjs
node harness/scripts/plan-test-environment.mjs \
  --work-item <work-item-id> \
  --task <task-id> \
  --feature <feature-id>
node harness/scripts/validate-delivery-run.mjs \
  --manifest harness/manifests/harness-autodev-kit.json \
  --run harness/tests/fixtures/delivery-run-pass.json
node harness/scripts/check-workflow-completion.mjs \
  --manifest harness/manifests/harness-autodev-kit.json \
  --run harness/tests/fixtures/delivery-run-pass.json
node harness/scripts/classify-integration-failure.mjs \
  --input <integration-failures.json> \
  --feature-id <feature-id>
node harness/scripts/aone-lifecycle.mjs env-create \
  --work-item WI-TEST \
  --task-id TASK-TEST \
  --branch harness/test \
  --namespace am-harness-test \
  --dry-run \
  --no-write-harness
node harness/scripts/check-platform-readiness.mjs \
  --input harness/tests/fixtures/platform-readiness-owned.json
node harness/scripts/render-delivery-report.mjs \
  --run harness/tests/fixtures/delivery-run-pass.json
node harness/scripts/render-platform-template.mjs \
  --manifest harness/manifests/checkpoint-backup.json
node harness/scripts/package-cloud-skills.mjs \
  --out /tmp/agent-manager-harness-cloud-skills.zip
HARNESS_JSON=1 harness publish skill /tmp/agent-manager-harness-cloud-skills.zip \
  --wsid <workspace-id> --no-wait > /tmp/agent-manager-cloud-skill-publish.json
node harness/scripts/render-platform-package.mjs \
  --manifest harness/manifests/harness-autodev-kit.json \
  --skill-catalog /tmp/agent-manager-cloud-skill-publish.json \
  --out /tmp/agent-manager-auto-dev-template.json
node harness/scripts/render-platform-package.mjs \
  --manifest harness/manifests/skill-market-install.json \
  --name agent-manager-skill-market-install-v1 \
  --label "Agent Manager Skill 安装全流程" \
  --skill-catalog /tmp/agent-manager-cloud-skill-publish.json \
  --out /tmp/agent-manager-skill-market-install-template.json
node harness/scripts/check-platform-workflow.mjs \
  --work-item /tmp/harness-work-item.json \
  --context /tmp/harness-context.json \
  --expected-template-name agent-manager-auto-dev-v1
```

Packaging and rendering only write the requested local output. The two
`harness publish` commands are the explicit cloud writes.

`validate-delivery-run.mjs` validates the machine-readable contract for a
completed Harness task graph: DAG dependency state, isolated namespace/service
environment, deploy readback, unit/API/browser evidence, live integration
evidence boundary, human waiting/resume state, compact task outputs, artifact
links, automated review, and platform acceptance status.

`classify-integration-failure.mjs` turns a failed integration run into one of
three workflow decisions: feature-related failures loop back to `develop`,
external-only prerequisite failures may continue downstream, and mixed unrelated
failures must wait for human triage. External prerequisite patterns are checked
before feature-token matching, so missing OOS templates in a checkpoint task are
not mistaken for feature code failures.

`check-workflow-completion.mjs` is the last hard guard. It blocks completion if
an awaiting/blocked upstream stage has downstream tasks marked done, if E2E
evidence lacks `experienceUrl`/`featureAssertions`, if browser evidence does not
mention the requested feature, if a manifest-required assertion has no passed
`assertionResults` and linked screenshot, if a state-changing flow lacks a
`post_action_readback` screenshot, if a task output says `completed` while the
platform task is still `in_progress`, or if integration failure classification
was skipped.

`render-delivery-report.mjs` renders the platform-facing evidence card: isolated
environment, AOneCI links, browser `experienceUrl`, screenshots/traces,
integration classification, waiting state, review state, and platform acceptance
boundary. Upload this report whenever the platform task output would otherwise
only show a raw CI link.

`check-platform-readiness.mjs` validates the missing platform-control layer:
whether the current Harness agent owns the target work item/task and can safely
write `task update`, `milestone`, and `ask` evidence. If ownership does not
match, it exits non-zero and prints an `awaiting_human` payload plus blocker
commands instead of allowing an agent to claim platform completion.

`render-platform-package.mjs` resolves Skill slugs from the current cloud
publish result and emits exactly two `skillIds` per stage: the shared core and
that stage's Skill. A missing Skill ID/version fails closed. Publish the package
and validate that the platform did not drop an unattached Skill:

```bash
HARNESS_JSON=1 harness publish template /tmp/agent-manager-auto-dev-template.json \
  --wsid <workspace-id> > /tmp/agent-manager-template-publish.json
node harness/scripts/check-cloud-template-publish.mjs \
  --result /tmp/agent-manager-template-publish.json
```

Feature-specific write flows should be published from their own manifest. This
binds the platform E2E task to the exact manifest digest and test ID, so an
agent cannot complete it with another feature's weaker evidence policy.

Then create a work item with the returned template id:

```bash
harness work-item create \
  --title "Agent Manager 真实功能自动开发验证" \
  --desc-file harness/platform/task-template.md \
  --template <template-id> \
  --workspace-id <workspace-id> \
  --assign-agent-id <agent-id>
```

`check-platform-workflow.mjs` verifies that the work item is not using the
builtin `general` template and contains the expected Agent Manager
environment-isolated auto-development stage tasks before any agent claims a
full platform workflow run.

## Platform Full-Flow Inputs

To run the real Harness platform flow, provide these platform-owned values:

- `workItemId`
- `taskId`
- `milestoneId` or the stage/task that requires acknowledgement
- `templateId` for `agent-manager-auto-dev-v1`, published with
  `harness publish template`
- cluster context or kubeconfig reference with permission to create a dedicated
  namespace, deployment, service, and optional ingress
- image build/push input, such as an Aone pipeline command, image registry, and
  tag policy
- isolated test base URL or permission to port-forward the generated service
- test database/schema/tenant and required secret refs
- `ownerTokenRef` or an already active Harness agent credential
- `acceptanceCommand`
- upload target or permission to create Harness artifacts

Without those values, the correct terminal state is an evidence boundary, not
platform completion.

## Post-action UI readback

State-changing browser flows declare their observable postcondition in the
feature manifest. For example, a Skill installation flow should require the
target Agent UI readback, not only the market page or install dialog:

```json
{
  "id": "skill-install-browser",
  "stage": "test_e2e",
  "requiredAssertions": ["installed-skill-visible-in-agent-ui"],
  "requiresPostActionReadback": true,
  "postActionReadback": {
    "targetPathPattern": "^/[^/]+/skills/?$",
    "resultMatchFields": ["instanceId", "skillName"],
    "evidenceTextFields": ["skillName"],
    "requiredEvidenceText": ["Skills", "Installed skills"],
    "actionResultMatchFields": ["instanceId", "skillName"],
    "actionResultStatuses": ["succeeded"]
  }
}
```

The completed E2E output must include a passed `assertionResults` entry and an
uploaded screenshot with `phase: "post_action_readback"`, the same ID in
`assertionIds`, the target Agent URL, and feature-specific `domText` or a
description of the visible installed Skill. The screenshot, assertion result,
and successful `actionResults` entry must carry the same instance and Skill
identity; the visible content must contain the parsed `SKILL.md` display name.
