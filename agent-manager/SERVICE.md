# Agent Manager — 服务简介

一站式 AI 智能体管理平台，支持多用户创建、配置和运维 AI Agent 实例，集成 E2B 安全沙箱和多 IM 通道。

## 核心能力

### 智能体管理
- **实例全生命周期管理**：创建、配置、启停、删除 OpenClaw 智能体实例
- **模型灵活配置**：支持多种 AI 模型接入，管理员可统一管理模型列表和可用状态
- **多通道集成**：支持微信、企业微信、QQ、飞书、钉钉等主流 IM 平台接入

### 用户与权限
- **角色分离**：管理员和普通用户独立的功能视图和操作权限
- **资源配额**：Token 用量监控和实例数量限制，精细化资源管控
- **多种认证方式**：支持账号密码、OAuth、SAML SSO 登录

### 安全沙箱
- **E2B 集成**：通过 E2B Code Interpreter 提供安全隔离的代码执行环境
- **资源隔离**：每个智能体实例运行在独立沙箱中，互不影响

## 技术架构

```
┌──────────────────────────────────────────────────┐
│                  用户浏览器                        │
│              http://<SLB-IP>                      │
└────────────────────┬─────────────────────────────┘
                     │
          ┌──────────▼──────────┐
          │    公网 SLB (L4)     │
          │   :80  → :8080      │
          │   :3001 → :3001     │
          └──────────┬──────────┘
                     │
┌────────────────────▼─────────────────────────────┐
│              ACS Serverless 集群                   │
│  ┌─────────────────────────────────────────────┐ │
│  │  Pod: agent-manager                     │ │
│  │  ┌───────────────┐  ┌────────────────────┐  │ │
│  │  │  前端 (Vite)   │  │  后端 (Express)    │  │ │
│  │  │  React + TS   │  │  Node.js API       │  │ │
│  │  │  :8080        │  │  :3001             │  │ │
│  │  └───────────────┘  └────────┬───────────┘  │ │
│  └──────────────────────────────┼──────────────┘ │
└─────────────────────────────────┼────────────────┘
                     ┌────────────┼────────────┐
                     ▼            ▼            ▼
              ┌──────────┐ ┌──────────┐ ┌──────────┐
              │ Supabase │ │ E2B      │ │ 阿里云    │
              │ (PgSQL)  │ │ Sandbox  │ │ API GW   │
              └──────────┘ └──────────┘ └──────────┘
```

### 技术栈

| 层级 | 技术选型 |
|------|---------|
| **前端** | React 18 + TypeScript + Vite + Tailwind CSS |
| **后端** | Node.js + Express |
| **数据库** | Supabase (PostgreSQL)，含 RLS 行级安全策略 |
| **沙箱** | E2B Code Interpreter |
| **容器** | Docker 单容器部署（前端 + 后端） |
| **编排** | 阿里云 ROS 资源编排 |
| **集群** | 阿里云 ACS Serverless |
| **负载均衡** | 阿里云 SLB（公网四层） |

## 功能模块

### 管理员功能

| 模块 | 说明 |
|------|------|
| **仪表盘** | 平台全局统计：用户数、实例数、模型数、Token 用量 |
| **用户管理** | 用户增删改查、角色分配、配额设置、启用/禁用 |
| **模型配置** | AI 模型的增删改查和启用/禁用管理 |
| **通道配置** | IM 通道模板管理（微信/企微/QQ/飞书/钉钉） |
| **OpenClaw 列表** | 查看所有用户的智能体实例 |
| **模板配置** | OpenClaw 实例模板管理 |
| **Skill Hub** | 技能中心配置 |
| **认证设置** | OAuth / SAML SSO 配置 |

### 用户功能

| 模块 | 说明 |
|------|------|
| **仪表盘** | 个人统计：实例数、Token 用量、可用模型 |
| **我的 OpenClaw** | 查看和管理自己的智能体实例 |
| **创建 OpenClaw** | 创建新的智能体实例 |
| **实例详情** | 配置 AI 模型、绑定 IM 通道、启停实例 |

## 数据模型

| 表名 | 用途 |
|------|------|
| `principal_profiles` | 用户和分组主体资料、角色、配额 |
| `ai_models` | AI 模型配置 |
| `im_channels` | IM 通道配置 |
| `openclaw_instances` | 智能体实例 |
| `token_usage_logs` | Token 使用记录 |

## 部署方式

通过阿里云 ROS 模板一键部署，自动完成以下资源创建：

1. **Supabase 实例** — PostgreSQL 数据库 + Auth + REST API
2. **EIP** — Supabase 公网访问
3. **SLB** — 平台公网入口
4. **K8s 资源** — Namespace、ConfigMap、Secret、Deployment、Service
5. **数据库初始化** — 自动建表 + 创建管理员账号
6. **健康检查** — 自动验证部署结果

---

# 版本记录

## v1.0.0 (2026-04-08)

**首个正式版本** — 完整的 AI 智能体管理平台。

### 新增功能

- **平台框架**
  - 管理员 / 普通用户双角色体系
  - 基于 Supabase RLS 的行级数据安全策略
  - 支持账号密码、OAuth、SAML SSO 多种认证方式

- **智能体管理**
  - OpenClaw 实例的创建、配置、启停全生命周期管理
  - 多 AI 模型接入和统一管理
  - 微信、企业微信、QQ、飞书、钉钉等 IM 通道集成
  - OpenClaw 实例模板，快速创建标准化智能体

- **资源管控**
  - Token 用量实时监控和日志记录
  - 用户级实例数量配额限制
  - 管理员仪表盘全局数据概览

- **安全沙箱**
  - 集成 E2B Code Interpreter，提供隔离的代码执行环境
  - 每个智能体实例独立沙箱，资源互不干扰

- **一键部署**
  - 阿里云 ROS 模板自动编排所有云资源
  - 支持 ACS Serverless 容器集群部署
  - 自动创建 Supabase 数据库并初始化
  - 公网 SLB 自动配置，开箱即用

### 部署信息

| 项目 | 值 |
|------|------|
| **镜像** | `agent-manager:v1.0.0-20260408-amd64` |
| **架构** | `linux/amd64` |
| **ROS 模板** | `platform_template_prerelease.yaml` |
| **数据库** | Supabase (PostgreSQL) |
| **默认管理员** | `admin@openclaw.local` / `admin123` |

### 已知限制

- Sandbox URL 需要通过 `kubectl port-forward` 访问（ALB 为内网，暂无公网入口）
- Supabase 仅支持部分可用区（杭州-j、上海-l、北京-i 等）
- 单容器部署模式，前后端未拆分独立扩缩

---

## ToC 直连 API 使用指南

平台支持 **ToC 场景**：最终用户拿着自己的账号登录 Supabase 获取 Bearer Token，直接调用 `/api/*` 完成实例全生命周期操作，无需经过管理员或前端。

### 1. 获取 Bearer Token（Supabase 账号密码登录）

```typescript
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

export async function getAccessToken(email: string, password: string): Promise<string | null> {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) throw error
  return data.session?.access_token ?? null  // ← This is the Bearer token
}
```

> Access Token 默认 1 小时有效，SDK 在浏览器中会自动刷新；服务端脚本用 `supabase.auth.refreshSession()` 主动续期。

### 2. 自助注册（邮箱认证开启时）

```typescript
const { data, error } = await supabase.auth.signUp({ email, password })
// on_auth_user_created 触发器会自动在 principal_profiles 建 profile
```

### 3. 最小用户闭环示例

```typescript
const token = await getAccessToken(email, password)
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

// ① 查可用模型
const { models } = await fetch(`${API_BASE}/api/models`, { headers }).then(r => r.json())

// ② 创建实例
const { instance } = await fetch(`${API_BASE}/api/instances`, {
  method: 'POST', headers,
  body: JSON.stringify({ name: 'my-bot', modelId: models[0].id })
}).then(r => r.json())

// ③ 查看实例详情（含 sandboxUrl、hosts 提示等）
const detail = await fetch(`${API_BASE}/api/instances/${instance.id}`, { headers }).then(r => r.json())

// ④ 启停
await fetch(`${API_BASE}/api/instances/${instance.id}/stop`,  { method: 'POST', headers })
await fetch(`${API_BASE}/api/instances/${instance.id}/start`, { method: 'POST', headers })

// ⑤ 查用量
const overview = await fetch(`${API_BASE}/api/instances/overview`, { headers }).then(r => r.json())

// ⑥ 删除
await fetch(`${API_BASE}/api/instances/${instance.id}`, { method: 'DELETE', headers })
```

### 4. 管理员代建实例（运营侧）

管理员以自己的 Token 调用下面的 API，创建出的实例归属到目标用户。支持通过 `userId` 或 `email` 指定目标用户：

```bash
POST /api/admin/instances
Authorization: Bearer <admin_access_token>
Content-Type: application/json

{
  "email": "alice@example.com",
  "name": "onboarding-demo",
  "modelName": "qwen-max",
  "channelType": "feishu",
  "channelClientId": "...",
  "channelClientSecret": "..."
}
```

也可以用 `"userId": "<uuid>"` 代替 `email`，二选一；用 `"modelId": "<uuid>"` 代替 `modelName`。目标用户下次登录时会在自己的 `/api/instances` 列表中看到该实例。

### 5. 常见端点速查

| 场景 | 方法 | 路径 |
|------|:---:|------|
| 查个人实例列表 | GET | `/api/instances` |
| 查用量/限额 | GET | `/api/instances/overview` |
| 创建实例 | POST | `/api/instances` |
| 管理员代建 | POST | `/api/admin/instances` |
| 启动/停止 | POST | `/api/instances/:id/start` \| `/api/instances/:id/stop` |
| 删除 | DELETE | `/api/instances/:id` |
| 修改密码 | PUT | `/api/users/me/password` |
| 查可用模型 | GET | `/api/models` |
| 查渠道模板 | GET | `/api/channel-templates` |

响应统一为 `{ success, instance | data, error? }`，错误状态下 HTTP 码非 2xx 且 `success: false`。
