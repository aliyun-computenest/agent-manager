# Agent Manager

企业级 AI 智能体管理平台，包含用户侧和管理员侧的完整功能。

## 项目结构

```
/home/project/
├── src/
│   ├── components/
│   │   ├── Auth/
│   │   │   └── index.tsx            # 登录/注册组件
│   │   ├── AdminLayout.tsx          # 管理员侧布局组件（侧边栏导航）
│   │   ├── UserLayout.tsx           # 用户侧布局组件（侧边栏导航）
│   │   ├── LandingPage.tsx          # 首页/登录页（角色切换）
│   │   ├── NotFound.tsx             # 404 页面
│   │   ├── AdminDashboard.tsx       # 管理员仪表盘（统计数据）
│   │   ├── UserDashboard.tsx        # 用户仪表盘（个人统计）
│   │   ├── UserManagement.tsx       # 用户管理（编辑、重置密码、启用/禁用）
│   │   ├── ModelConfig.tsx          # 模型配置（添加、编辑、启用/禁用模型）
│   │   ├── ChannelConfig.tsx        # 通道配置（IM 通道管理）
│   │   ├── OpenClawList.tsx         # OpenClaw 列表（支持 admin/user 视图）
│   │   ├── UserOpenClawList.tsx     # 用户 OpenClaw 列表
│   │   ├── OpenClawDetail.tsx       # OpenClaw 详情（配置模型和通道）
│   │   └── CreateOpenClaw.tsx       # 创建 OpenClaw 表单
│   ├── contexts/
│   │   └── AuthContext.tsx          # 认证上下文（用户状态管理）
│   ├── lib/
│   │   └── supabase.ts              # Supabase 客户端配置
│   ├── App.tsx                      # 主路由配置
│   ├── main.tsx                     # 应用入口
│   ├── index.css                    # 全局样式（Tailwind CSS）
│   └── mock.json                    # 模拟数据
├── migrations/
│   └── init_openclaw_platform.sql   # 完整数据库初始化脚本（含管理员初始化说明）
├── package.json
├── vite.config.ts
├── tsconfig.json
├── tsconfig.node.json
├── tailwind.config.js
├── postcss.config.js
└── index.html
```

## 路由映射表

### 公共路由
| 路径 | 组件 | 说明 |
|------|------|------|
| `/` | LandingPage | 首页/角色选择页 |
| `*` | NotFound | 404 页面 |

### 管理员侧路由 (`/admin/*`)
| 路径 | 组件 | 说明 |
|------|------|------|
| `/admin` | 重定向 | 重定向到 `/admin/dashboard` |
| `/admin/dashboard` | AdminDashboard | 管理员仪表盘 |
| `/admin/users` | UserManagement | 用户管理 |
| `/admin/models` | ModelConfig | 模型配置 |
| `/admin/channels` | ChannelConfig | 通道配置 |
| `/admin/openclaws` | OpenClawList | 查看所有 OpenClaw |

### 用户侧路由 (`/user/*`)
| 路径 | 组件 | 说明 |
|------|------|------|
| `/user` | 重定向 | 重定向到 `/user/dashboard` |
| `/user/dashboard` | UserDashboard | 用户仪表盘 |
| `/user/openclaws` | UserOpenClawList | 我的 OpenClaw 列表 |
| `/user/openclaws/create` | CreateOpenClaw | 创建 OpenClaw |
| `/user/openclaws/:id` | OpenClawDetail | OpenClaw 详情 |

## 功能说明

### 管理员侧功能
1. **仪表盘**: 查看平台统计数据（用户数、实例数、模型数、Token 用量）
2. **用户管理**: 
   - 编辑用户信息（用户名、邮箱、角色、状态）
   - 配置用户角色（admin/user）
   - 设置 OpenClaw 实例数量上限
   - 设置每日 Tokens 用量上限
   - 重置用户密码
   - 启用/禁用用户
3. **模型配置**:
   - 查看可用 AI 模型列表（DeepSeek、混元等）
   - 添加自定义模型
   - 编辑模型信息
   - 启用/禁用模型
   - 删除模型
4. **通道配置**:
   - 查看 IM 通道列表（微信、企业微信、QQ、飞书、钉钉）
   - 添加新通道
   - 编辑通道信息
   - 启用/禁用通道
5. **Agent 列表**: 查看所有用户的 Agent 实例

### 用户侧功能
1. **仪表盘**: 查看个人统计数据（实例数、Token 用量、可用模型）
2. **Agent 管理**:
   - 创建 Agent 实例
   - 查看 Agent 列表
   - 删除 Agent
   - 查看详情
   - 配置 AI 模型
   - 配置 IM 通道
   - 启动/停止实例

## 技术栈
- React 18.2.0
- TypeScript 5.0.0
- Vite 6.4.1
- React Router DOM 6.28.0 (Hash 路由)
- Tailwind CSS 3.3.1
- Lucide React 0.575.0 (图标库)
- date-fns 2.30.0
- **@supabase/supabase-js 2.49.8** (后端数据库)

## Supabase 数据库表

### 1. principal_profiles - 用户资料表
| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID | 用户 ID（引用 auth.users） |
| username | VARCHAR | 用户名 |
| email | VARCHAR | 邮箱 |
| role | VARCHAR | 角色（admin/user） |
| status | VARCHAR | 状态（active/disabled） |
| max_openclaw_instances | INTEGER | OpenClaw 实例数量上限 |
| daily_token_limit | INTEGER | 每日 Token 用量上限 |
| used_tokens_today | INTEGER | 今日已用 Token 数 |

### 2. ai_models - AI 模型配置表
| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID | 模型 ID |
| name | VARCHAR | 模型名称 |
| provider | VARCHAR | 提供商（DeepSeek/Tencent/OpenAI） |
| model_code | VARCHAR | 模型代码（唯一） |
| max_tokens | INTEGER | 最大 Token 数 |
| is_enabled | BOOLEAN | 是否启用 |
| is_custom | BOOLEAN | 是否自定义模型 |

### 3. im_channels - IM 通道配置表
| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID | 通道 ID |
| name | VARCHAR | 通道名称 |
| channel_type | VARCHAR | 类型（wechat/wecom/qq/feishu/dingtalk） |
| is_enabled | BOOLEAN | 是否启用 |
| config_json | JSONB | 通道配置 |

### 4. openclaw_instances - OpenClaw 实例表
| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID | 实例 ID |
| name | VARCHAR | 实例名称 |
| user_id | UUID | 所属用户 ID |
| model_id | UUID | 使用的模型 ID |
| status | VARCHAR | 状态（running/stopped/error） |
| im_channel_ids | UUID[] | 关联的 IM 通道 ID 数组 |
| total_tokens_used | INTEGER | 累计 Token 用量 |

### 5. token_usage_logs - Token 使用记录表
| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID | 记录 ID |
| user_id | UUID | 用户 ID |
| instance_id | UUID | 实例 ID |
| model_id | UUID | 模型 ID |
| tokens_used | INTEGER | 使用 Token 数 |
| usage_date | DATE | 使用日期 |

## 开发命令
```bash
npm install      # 安装依赖
npm run dev      # 启动开发服务器
npm run build    # 构建生产版本
npm run preview  # 预览生产构建
```

## 本地构建镜像并发布到 ComputeNest 部署物

### 固定信息

| 项目 | 值 |
|------|------|
| **ROS 预发 Endpoint** | `ros-pre.aliyuncs.com` |
| **镜像仓库** | `compute-nest-registry.cn-hangzhou.cr.aliyuncs.com/computenest-test/openclaw-registry.cn-hangzhou.cr.aliyuncs.com/openclaw/agent-manager` |
| **agent-manager ArtifactId** | `artifact-ee2444a2c52e4d93bb50` |
| **agent-manager ArtifactId** | `artifact-9b43d3ec1cc648aebe1b` |

### 发布流程

1. **发布前检查**：确认 `Dockerfile`、`docker-entrypoint.sh`、`migrations/init_database.sql` 无回退
2. **确认发布 tag**（不要推 `latest`）
3. **本地构建**：`docker build` 或 `docker buildx build --platform linux/amd64`
4. **登录 ACR 并推送**：`aliyun cr GetAuthorizationToken` → `docker login` → `docker push`
5. **创建并发布部署物版本**：对 agent-manager 和 agent-manager 分别 `CreateArtifact` + `ReleaseArtifact`
6. **发布后校验**：`ListArtifactVersions` 确认版本正确

### ROS 预发调用约定

- ROS 预发环境统一使用 `ros-pre.aliyuncs.com`
- 通过 `template/ros_stack_manager.py` 调用时，固定传 `--endpoint ros-pre.aliyuncs.com`
- 直接调用 ROS CLI 时同样固定传 `--endpoint ros-pre.aliyuncs.com`

### 发布前检查要点

- `Dockerfile` 里是 `COPY server/ ./server/`
- `migrations` builder 不依赖不存在的 `migrations/package.json`
- `docker-entrypoint.sh` 先写 `/app/.env`，再执行 DB init 和 init-admin

> 详细步骤参见 skill 文档：`openclaw-image-build`

## Supabase 配置说明

1. **环境变量**：在 `.env` 文件中配置
   ```
   VITE_SUPABASE_URL=your_supabase_url
   VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
   VITE_APP_ID=your_app_id
   ```

2. **执行数据库迁移**：在 Supabase Dashboard 的 SQL Editor 中运行 `migrations/init_openclaw_platform.sql` 文件内容

3. **创建管理员账号**：
   - 在 Supabase Dashboard > Authentication > Users 中创建用户
   - 邮箱：`admin@openclaw.local`
   - 密码：`admin123`
   - 获取用户 UUID 后，在 SQL Editor 中执行：
   ```sql
   INSERT INTO principal_profiles (id, username, email, role, status)
   VALUES ('YOUR_ADMIN_UUID', 'Admin', 'admin@openclaw.local', 'admin', 'active');
   ```

4. **邮件配置**：如需启用邮箱验证，在 Supabase Dashboard > Authentication > Providers 中配置 SMTP

## 数据库 SQL Migration 开发规范

> 完整规范、四种升级场景、并发安全、回滚策略详见
> `migrations/versions/README.md`，本节只列**最常用的开发动作**。

### 目录结构与执行机制

- 所有增量 SQL 都放在 `migrations/versions/<semver>/<NNN>__<desc>.sql`
- ROS Stack 升级时由 `DbMigrateJob` 触发 `node migrations/init-db.js migrate`
- 执行顺序：**目录按 semver 升序**，**目录内按文件名字典序**（`001` → `002` → `003` ...）
- 已执行的文件会写入 `schema_migrations` 表（含 SHA-256 checksum），下次执行自动跳过

### 决定放在哪个版本目录

| 场景 | 放置位置 |
|------|---------|
| 同一轮 schema 变更的延续（小修补、字段重命名等） | **复用当前 MINOR 目录**，编号顺延（如 `1.0.1/002__xxx.sql`） |
| 不破坏兼容性的列/索引新增 | 新开 `PATCH` 目录（如 `1.0.2/`） |
| 新增表 / 业务语义变化 | 新开 `MINOR` 目录（如 `1.1.0/`） |
| 破坏性 schema 变更 | 新开 `MAJOR` 目录（如 `2.0.0/`） |

> ⚠️ 不要为单个小 UPDATE 单独开新版本目录。先看现有最高版本目录是不是同一轮变更，能并入就并入并顺延编号。

### 新增 migration 文件的步骤

1. 决定版本目录与编号（参考上表）
2. 文件命名严格遵循：`NNN__<snake_case_desc>.sql`，三位数字 + **双下划线** + 描述
   - ✅ `001__add_skill_hub.sql`、`002__rename_sandbox_template_id.sql`
   - ❌ `1_add_xxx.sql`、`add_xxx.sql`、`001_add.sql`（单下划线）
3. SQL 编写要求：
   - **优先幂等**：`CREATE TABLE IF NOT EXISTS`、`ADD COLUMN IF NOT EXISTS`、`DROP POLICY IF EXISTS`...
   - **不写 `BEGIN;` / `COMMIT;`**：执行器已经包了事务
   - **条件更新**：仅当字段还是默认值时才改，避免覆盖用户自定义
     ```sql
     UPDATE agent_types
     SET    sandbox_template_id = 'agent-manager-openclaw',
            updated_at = NOW()
     WHERE  code = 'openclaw'
       AND  sandbox_template_id = 'openclaw';   -- ← 只动旧默认值
     ```
4. **本地验证**：
   ```bash
   cd agent-manager
   node migrations/init-db.js migrate     # 第一次：applied=N
   node migrations/init-db.js migrate     # 第二次：applied=0 skipped=N
   ```
5. 提交时连同代码一起，CI 会在预发跑 migrate

### 一经发布，绝对不可修改

- 文件 checksum 已写入 `schema_migrations`，**改一个空格 migrate 就会立即报错退出**
- 需要修正只能在下一个文件里写补丁 SQL（前向修复）
- 同样不允许调整目录/文件名（会变成"新文件"被重复执行，破坏数据）

### 调试 / 回滚

- **不允许**手动删 `schema_migrations` 行
- 紧急回滚走 Supabase 快照恢复
- 业务回退在下一个正向版本里写反向迁移
- 本地完全重来：`node migrations/init-db.js drop && node migrations/init-db.js full`

## 主题色系
在 `tailwind.config.js` 中定义：
- `primary`: 主色调（蓝色系，50-900）
- `sidebar`: 侧边栏主题（深色背景）

## 模拟数据
`mock.json` 包含：
- users: 用户数据（含管理员和普通用户）
- models: AI 模型配置
- channels: IM 通道配置
- openClaws: OpenClaw 实例数据
