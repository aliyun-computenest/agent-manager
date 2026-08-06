# Agent Manager AutoDev Workflow v2：隔离环境自动开发

本 Workflow 定义 Agent Manager 工作项进入自动开发后的执行规则。

核心假设：进入本流程时，工作项已经具备完整设计文档和 UI 输入。Agent 只校验输入是否齐全、是否可执行，不额外执行设计评审或 UI 评审阶段。设计和 UI 的人工评审后续应作为上游审批节点或独立人工 gate 接入。

## 全局规则

- 面向用户、工作项、评论、里程碑、任务 output 的描述必须优先使用中文。文件路径、API 路径、命令、字段名、测试名可以保留英文原文。
- 工作项描述和已批准设计文档是需求来源。不得导入无关历史工作项、评论、截图、记忆或本地聊天上下文。
- 真实需求优先：工作项必须修改现有业务代码路径或现有业务测试。readiness/demo/mock-only 任务不能作为自动开发全流程验收样本。
- 编码前必须在 `dev_orchestration` 阶段发布 allowlist、DAG、资源锁、并行实施编排、隔离环境方案、测试矩阵和证据要求。这里不是设计评审或 UI 评审。
- 环境隔离是一等卡点。没有 AOneCI 创建出的 namespace/service/URL 或无法创建隔离环境时，不得进入真实环境 API/浏览器测试。
- 隔离环境生命周期必须优先走仓库 wrapper：`node harness/scripts/aone-lifecycle.mjs ...`。创建使用 `.aoneci/harness_env_create.yaml`，镜像构建复用 `.aoneci/build_and_push_image.yaml`，隔离环境发布使用目标业务仓库配置的 deploy-only CI，API 冒烟和真实集成测试通过对应 AOneCI/测试入口执行，清理使用 `.aoneci/harness_env_cleanup.yaml`。Agent 不得直接执行底层 AOneCI、手工 `kubectl`、Docker 或 dev server 作为主链路阶段完成证据。
- 任何 gate 失败时，当前任务保持 `in_progress`，output 写入 `state=awaiting_human`、`waitType`、`reason`、`resumeCriteria`、`blockedNextStages`，然后使用 `harness ask` 或 `harness milestone blocker ... --require-ack`。
- AOneCI 成功、环境创建成功、镜像发布成功等普通进展只能用 `harness log`、task output 或 artifact 记录；不得写成 milestone，避免制造虚假的人工确认卡点。
- 提问后不得继续下游阶段。“已提问”不等于“已批准”。
- Daemon 在线、本地测试、截图、分支推送或 MR 创建都只是证据，不等于平台最终验收完成。
- 最终完成前必须执行 `node harness/scripts/check-workflow-completion.mjs --manifest <manifest> --run <delivery-run.json>`。该命令失败时，不得手工把下游任务改成 done。
- task output 与平台 task status 必须一致：`output.state=completed` 时平台 task status 必须是 `done`；task status 为 `done` 时 output 不能还是 `awaiting_human`、`blocked` 或 `failed`。状态不一致时不得启动下游阶段。

## 0. work_item_intake

创建或认领工作项时，必须先做输入完整性检查，并把结果写入 `clarify` 输出。

必须记录：

- `designDocProvided`: `true|false`
- `designDocLocation`: 设计文档位置
- `uiChange`: `true|false`
- `uiReferenceRequired`: `true|false`
- `uiReferenceProvided`: `true|false`
- `uiReferenceType`: `screenshot|image|html|figma|existing_page|spec|none`
- `uiReferenceLocation`: 图片链接、附件 ID、HTML 文件、Figma 链接、现有页面路径等
- `realFeaturePath`: 真实业务路径，例如 instance lifecycle、terminal、backup、group sharing、sandbox upgrade
- `mockOnly`: `true|false`

如果 `designDocProvided=false`，或 `uiChange=true` 但没有 UI 输入资产，必须在 `clarify` 阶段 ask，不能进入 `dev_orchestration`。

如果 `mockOnly=true`，必须 blocker：工作项不能作为完整自动开发验收样本。

## 1. clarify

确认工作项 id、当前 task id、agent、workspace、目标分支、设计文档、UI 输入、真实业务路径、scope、non-goals、必要平台输入和成功标准。

完成条件：

- `missingInputs`、`successCriteria`、`constraints` 已记录。
- `designDocProvided=true`。
- 如果 `uiChange=true`，则 `uiReferenceProvided=true`，或已收到结构化人工决策。
- `mockOnly=false` 且 `realFeaturePath` 指向现有业务代码。
- 所有阻塞问题都有结构化回复。

## 2. dev_orchestration（实施编排）

编码前发布 allowlist、DAG、资源锁、并行实施编排、隔离环境方案、测试矩阵和证据要求。

实施编排输出必须包含：

- 允许修改文件 allowlist 和禁止修改范围 denylist
- 阶段 DAG 和并行 wave
- 资源锁：git 分支、AOneCI pipeline、namespace、service、image tag、端口、浏览器、数据库 schema、live 环境
- 环境隔离输入：AOneCI pipeline id、cluster/context、namespace、service、image registry/tag、base URL、secret/env 来源
- 单测命令
- API 测试命令，目标必须是隔离环境 base URL
- 浏览器功能测试命令，目标必须是隔离环境 base URL
- code review 前 scope guard 命令

跨模块实施编排、共享集成环境或真实集群发布方案，必须发 `harness milestone dev_plan <task_id> "...实施编排..." --require-ack`。

## 3. env_prepare

通过 AOneCI 创建或绑定本工作项专属环境。环境名必须可追踪到 work item。

必须调用生命周期 wrapper：

```bash
node harness/scripts/aone-lifecycle.mjs env-create \
  --work-item <work_item_id> \
  --task-id <task_id> \
  --branch <remote-branch> \
  --namespace <namespace>
```

必须记录：

- `aoneCiRunId`
- `pipelinePath`: `.aoneci/harness_env_create.yaml`
- `namespace`: 例如 `am-harness-<shortId>`
- `serviceName`: 例如 `agent-manager-<shortId>`
- `baseUrl`: 浏览器/API 测试入口
- `kubeContext` 或 `clusterId`
- `imageRegistry` 和 `imageTag`
- `databaseIsolation`: dedicated database、schema、tenant、fixture seed 或 explicit none
- `secretRefs`: 只记录引用名，不记录明文

如果缺少 KUBECONFIG、cluster id、registry、namespace 权限、service/ingress 权限、Supabase/E2B 等必需环境输入，必须 `harness ask` 等待。不得回退到 mock 环境冒充隔离环境。

建议环境变量：

- `HARNESS_ENV_CREATE_PIPELINE_ID`
- `HARNESS_BUILD_DEPLOY_PIPELINE_ID`
- `HARNESS_ENV_CLEANUP_PIPELINE_ID`
- `HARNESS_KUBE_CONTEXT`
- `HARNESS_NAMESPACE_PREFIX`
- `HARNESS_SERVICE_PREFIX`
- `HARNESS_IMAGE_REGISTRY`
- `HARNESS_BASE_DOMAIN`
- `HARNESS_TEST_DATABASE_URL` 或 `HARNESS_TEST_SCHEMA_PREFIX`
- `SUPABASE_URL` / `SERVICE_ROLE_KEY`
- `E2B_API_KEY` / `E2B_DOMAIN`，仅实例启动相关任务需要

## 4. develop

只修改 `dev_orchestration` / 实施编排阶段声明的 writeScope。并行子任务不得共享独占资源锁或重叠 writeScope。

如果需要扩大范围，必须停止并 ask。不得静默编辑 allowlist 以外文件。

完成条件：实现完成、diff 在范围内、记录 changed files 和 commit/diff。

## 5. test_unit

单元测试只有在 `exitCode=0` 且 `testsPassed == totalTests` 时才能完成。包装命令成功但隐藏 skipped/failed 不能算通过。

## 6. deploy_ephemeral

开发完成后必须通过 AOneCI 自动构建镜像并发布到专属 namespace/service。

必须调用生命周期 wrapper：

```bash
node harness/scripts/aone-lifecycle.mjs deploy-image \
  --work-item <work_item_id> \
  --task-id <task_id> \
  --branch <remote-branch> \
  --namespace <namespace> \
  --image-tag <image_tag>
```

必须记录：

- AOneCI run id、pipeline path 和 exit code
- image tag 或部署 artifact
- a1 command
- namespace、deployment、service、ingress/port-forward
- rollout status
- /api/health readback
- pod logs 摘要

如果发布失败或权限不足，保持 `in_progress/awaiting_human` 并 ask。不得用本地 dev server 代替集群服务完成此阶段。

## 7. test_api

API 测试必须针对隔离环境 `baseUrl`，不能只测 mock 或本地 stub。

必须记录：

- baseUrl
- exact API requests/responses 或测试报告
- auth/session/fixture 来源
- passed/total

如果没有可用真实环境或测试凭证，必须等待人工输入。

## 8. test_e2e

浏览器功能测试必须针对隔离环境 `baseUrl`，并覆盖本次真实业务功能。UI 需求必须提供新页面或新交互的截图、trace 或 video。登录页、通用首页、加载态、骨架屏、空白页、暂无数据和无关后台页面不算通过。

完成条件：

- `experienceUrl` 指向可体验的功能页面或功能入口。
- `featureAssertions` 明确列出本次功能断言。
- 截图、video、trace 或 log 的 `target/targetPath/targetUrl` 必须能看出本次功能，不得只提交登录页、首页、加载态、骨架屏、空白页、暂无数据或无关页面。
- 每张截图必须提供功能内容摘要，例如 `domText`、`screenshotText`、`pageTitle`、`description`、`assertions` 或 `verifiedBehaviors`；只有图片 URL 不算完成证据。
- 记录 console/network/pageerror 摘要。

阶段结束前必须能通过：

```bash
node harness/scripts/validate-delivery-run.mjs \
  --manifest <manifest> \
  --run <delivery-run.json>
```

## 9. integration_live

真实集成需要 readback 证据，例如 namespace/deployment/service/ingress、/api/health、目标 API readback、业务对象状态、pod logs、OOS/K8s 资源或平台验收输出。

必须先执行集成测试，再执行失败分类：

```bash
node harness/scripts/aone-lifecycle.mjs integration \
  --work-item <work_item_id> \
  --task-id <task_id> \
  --branch <remote-branch> \
  --base-url <baseUrl> \
  --namespace <namespace>

node harness/scripts/classify-integration-failure.mjs \
  --input <integration-failures.json> \
  --feature-id <feature_id>
```

分类决策：

- `relatedFailures > 0`：必须回退到 `develop`，不能进入 `code_review/deploy`。
- `relatedFailures=0 && unrelatedFailures=0 && externalFailures>0`：可按外部前置失败自动继续，但 output 必须包含分类报告和 AOneCI 链接。
- `unrelatedFailures>0`：保持 `in_progress/awaiting_human`，ask 人工选择继续、修复后复跑，或回退开发。
- 明确外部前置失败优先于功能词匹配。例如 checkpoint backup 任务里 `OOS backup template not configured` 应归为外部环境前置缺失，而不是业务代码失败。

如果凭证、执行 ID、live 环境或 owner decision 缺失，保持 `in_progress/awaiting_human` 并 ask。

## 10. code_review

MR 或最终评审前必须证明：

- 工作区干净，包括 untracked 文件。
- diff 全部在 allowlist 内。
- 单测、隔离环境发布、API 测试、浏览器功能测试和 live readback 证据齐全。
- 没有未解除 blocker。

## 11. deploy

最终平台完成必须满足：

- `claimedPlatformComplete=true`
- `platformAcceptance.status=accepted`
- 存在 owner ack 或明确 acceptance command result

完成、取消或人工要求清理时，必须通过 `.aoneci/harness_env_cleanup.yaml` 删除本工作项专属 namespace，并记录 cleanup AOneCI run id。清理失败时不得隐藏，应留下 blocker 或 evidence boundary。

没有这些输入时，必须停在 `evidence_boundary`。不得关闭工作项并宣称平台完成。
