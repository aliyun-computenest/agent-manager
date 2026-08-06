# Agent Manager 自动开发轮转模板

这个模板用于 Harness 平台上的 Agent Manager 真实功能开发工作项。进入本流程的前提是：工作项已经提供完整设计文档和 UI 输入。自动化主链路只校验这些输入是否齐全、是否可执行，不再把设计评审和 UI 评审作为两个默认节点。

## 发布模板

```bash
node harness/scripts/render-platform-package.mjs \
  --manifest harness/manifests/harness-autodev-kit.json \
  --skill-catalog /tmp/agent-manager-cloud-skill-publish.json \
  --out /tmp/agent-manager-auto-dev-template.json

harness publish template /tmp/agent-manager-auto-dev-template.json \
  --wsid <workspace-id>
```

创建真实工作项时必须使用发布后的 template id。使用 builtin `general` 模板的工作项不能作为 Agent Manager 自动开发全流程验收样本。

## 阶段顺序

1. `clarify`：校验设计文档、UI 输入、真实业务路径、非 mock 范围和成功标准。
2. `dev_orchestration`：发布 allowlist、denylist、DAG、并行 wave、资源锁、隔离环境方案、测试矩阵和证据要求。
3. `env_prepare`：通过 AOneCI 创建或绑定专属 namespace/service/baseUrl，并记录 run id、kubeContext、镜像、数据库隔离和 secret 引用。
4. `develop`：只修改声明的真实业务代码或测试路径。
5. `test_unit`：本地单元测试，必须 exitCode=0 且 testsPassed 等于 totalTests。
6. `deploy_ephemeral`：通过 AOneCI 构建镜像并发布到专属 namespace/service，并读回 `/api/health`。
7. `test_api`：针对隔离环境 baseUrl 执行 API 测试。
8. `test_e2e`：针对隔离环境 baseUrl 执行浏览器功能测试，记录 `experienceUrl`、`featureAssertions`，并上传能看出本次功能的截图/trace/video。
9. `integration_live`：读取真实集成证据，例如 K8s 对象、业务 API、OOS 执行或 pod logs。
10. `code_review`：检查 clean tree、scope guard、测试证据和阻塞问题。
11. `deploy`：只有 owner ack 或平台验收命令成功后才能声明平台完成；完成或取消后通过 AOneCI 清理隔离环境。

## 必需输入

- 设计文档位置。
- UI 是否变更，以及 UI 输入位置。涉及 UI 时输入可以是截图、图片、HTML、Figma、现有页面路径或明确规格。
- 真实业务路径，例如 instance lifecycle、terminal、backup、group sharing、sandbox upgrade。
- 隔离环境输入：cluster/context、namespace 前缀、service 前缀、镜像 registry/tag 来源、base domain 或 port-forward 策略、测试数据库/tenant/schema、必要 secret 引用。
- AOneCI pipeline id：`harness_env_create.yaml`、`harness_build_deploy.yaml`、`harness_env_cleanup.yaml` 对应的 pipeline id。
- API 和浏览器测试的成功标准。

## AOneCI 隔离环境生命周期

平台初始化项目时，先按 YAML 路径解析或创建三条流水线。这个动作由平台/owner 完成，Agent 正常开发阶段只调用仓库 wrapper，不直接拼底层 AOneCI 命令：

```bash
a1 ci pipeline get-by-path \
  --repo acs-automation/agent-manager \
  --code-file-url https://code.alibaba-inc.com/acs-automation/agent-manager/blob/<remote-branch>/.aoneci/harness_env_create.yaml \
  --format json

a1 ci pipeline get-by-path \
  --repo acs-automation/agent-manager \
  --code-file-url https://code.alibaba-inc.com/acs-automation/agent-manager/blob/<remote-branch>/.aoneci/harness_build_deploy.yaml \
  --format json

a1 ci pipeline get-by-path \
  --repo acs-automation/agent-manager \
  --code-file-url https://code.alibaba-inc.com/acs-automation/agent-manager/blob/<remote-branch>/.aoneci/harness_env_cleanup.yaml \
  --format json
```

`env_prepare` 阶段运行 wrapper：

```bash
node harness/scripts/aone-lifecycle.mjs env-create \
  --work-item <work_item_id> \
  --task-id <task_id> \
  --branch <remote-branch> \
  --namespace <namespace>
```

`deploy_ephemeral` 阶段运行 wrapper：

```bash
node harness/scripts/aone-lifecycle.mjs deploy-image \
  --work-item <work_item_id> \
  --task-id <task_id> \
  --branch <remote-branch> \
  --namespace <namespace> \
  --image-tag <image_tag>
```

`test_api` 阶段运行 wrapper：

```bash
node harness/scripts/aone-lifecycle.mjs smoke-api \
  --work-item <work_item_id> \
  --task-id <task_id> \
  --branch <remote-branch> \
  --base-url <baseUrl>
```

`integration_live` 阶段运行 wrapper 并分类失败：

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

完成、取消或人工要求清理时运行清理流水线：

```bash
node harness/scripts/aone-lifecycle.mjs cleanup \
  --work-item <work_item_id> \
  --task-id <task_id> \
  --branch <remote-branch> \
  --namespace <namespace>
```

这三条 CI 的 run id、输出摘要、namespace/service 读回、镜像 tag 和 `/api/health` 结果必须写入对应 task output 或 artifact。

涉及 AOneCI、浏览器或 live 集成的阶段，还必须渲染并上传平台可读报告：

```bash
node harness/scripts/render-delivery-report.mjs \
  --run <delivery-run.json>
```

## 等待协议

缺少设计/UI/环境/凭证/验收输入时，Agent 必须保持当前 task 为 `in_progress`，写入：

```json
{
  "state": "awaiting_human",
  "waitType": "clarification|approval",
  "reason": "...",
  "resumeCriteria": "...",
  "blockedNextStages": ["develop", "deploy_ephemeral", "test_api", "test_e2e"]
}
```

需要人选择时必须使用结构化提问：

```bash
harness ask <work_item_id> --task-id <task_id> \
  --question "<问题>" \
  --option "id=<id>;label=<标签>;recommended" \
  --option "id=<id>;label=<标签>"
```

需要审批时必须使用带确认的里程碑：

```bash
harness milestone blocker <task_id> "等待人工回复：<原因>" --require-ack
```

发起 ask 或 `--require-ack` 后，不得继续下游阶段。

## 完成输出

每个阶段完成时用结构化 output 记录证据：

```json
{
  "stage": "<stage>",
  "state": "completed",
  "summary": "<本阶段完成了什么>",
  "evidence": ["<路径、URL、命令输出或 artifact id>"],
  "testsPassed": 0,
  "totalTests": 0
}
```

非测试阶段可以省略 `testsPassed` 和 `totalTests`。大型日志、截图、trace 和视频必须上传为 artifact，不要塞进 task output。

最终完成前必须运行：

```bash
node harness/scripts/check-workflow-completion.mjs \
  --manifest harness/manifests/<feature>.json \
  --run <delivery-run.json>
```

## 明确禁止

- 用 readiness、demo、mock-only 任务冒充完整自动开发样本。
- 用本地 dev server、Docker 或手工 `kubectl` 代替 AOneCI 隔离 namespace/service 完成 `env_prepare`、`deploy_ephemeral`、`test_api` 或 `test_e2e`。
- 没有 `experienceUrl`、`featureAssertions` 和功能相关浏览器证据就通过涉及 UI 或浏览器行为的任务。
- 用登录页、首页、通用空页面截图冒充浏览器功能验证。
- 没有 live evidence 时宣称平台最终验收完成。
