# 数据库迁移开发规范

本目录收集**增量**数据库变更，由 ROS Stack 升级时触发的 `DbMigrateJob` 按版本顺序应用。

> 设计文档：[ROS升级触发数据库迁移设计.md](../../../docs/design/数据库升级设计文档.md)

## 目录结构

```
versions/
├── 1.0.0/
│   └── 1_0_0_base.sql                       # 基线 SQL（记录初始 schema，不会被执行）
├── 1.0.1/
│   └── 1_0_1__migrate_to_agent_platform.sql  # 首个增量迁移
├── 1.0.2/
│   └── 001__add_xxx.sql
└── 1.1.0/
    ├── 001__add_yyy.sql
    └── 002__backfill_yyy.sql
```

## schema_migrations 表

迁移状态由 `schema_migrations` 表跟踪，由 `init-db.js` 自动创建：

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT        NOT NULL,   -- semver 版本号，如 '1.0.0'
  filename    TEXT        NOT NULL,   -- SQL 文件名，如 '1_0_0_base.sql'
  checksum    TEXT        NOT NULL,   -- 文件内容的 SHA-256 哈希
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (version, filename)
);
```

**核心规则**：
- 每个 SQL 文件执行成功后，会写入一行记录（版本 + 文件名 + checksum）
- 下次 migrate 时，已有记录的文件直接跳过
- 如果文件内容被修改（checksum 不匹配），migrate 会**立即报错退出**

## 版本检测与升级机制

### 当前版本判断

`migrate` 通过查询 `schema_migrations` 表来判断当前数据库处于哪个版本：

| `schema_migrations` 状态 | 判断结果 |
|--------------------------|---------|
| 无记录 | 当前版本为 `INITIAL_VERSION`（1.0.0），即迁移框架引入前的老环境 |
| 有记录 | 当前版本为表中最高的 `version` |

### 四种场景的行为

#### 场景 1：新安装（schema_migrations 不存在）

```
isAlreadyInitialized() → schema_migrations 不存在 → 新库
  → 执行 init_database.sql 创建全量 schema
    → 创建 schema_migrations 表 + INSERT (version, 'init_database.sql') 标记记录
  → baselineMigrations() 读取标记 version，stamp versions/ 下所有 ≤ 该版本的文件
  → init-admin 创建管理员（幂等）
  → 后续 migrate 所有文件已 stamp → applied=0
```

**维护规则**：每次新增 `versions/X.Y.Z/` 迁移目录并同步更新 `init_database.sql` 后，
只需更新 `init_database.sql` 末尾 INSERT 语句中的 version 为最新版本号。
`tests/unit/migration-baseline.test.js` 会校验该 version 不低于 `versions/` 下的最高版本；
如果新增版本目录但忘记同步更新，`npm run test:migration-baseline` 会失败。

#### 场景 2：已有 schema_migrations 的环境升级

```
isAlreadyInitialized() → schema_migrations 存在 → 跳过 init
  → init-admin 幂等执行
  → DbMigrateJob 比对记录和磁盘文件，执行新增的迁移
```

当前运行时 bootstrap 只以 `schema_migrations` 作为环境版本来源，不再探测
`principal_profiles` / `user_profiles` 表。已发布的 v1.0.4 增量迁移仍保留
`user_profiles` → `principal_profiles` 的历史升级 SQL，但新的运行时脚本不再
支持无 `schema_migrations` 的旧库自动分流；这类环境需要先补齐迁移记录或按
运维手册执行一次性修复。

#### 场景 3：后续升级（schema_migrations 表已存在）

```
isAlreadyInitialized() → schema_migrations 存在 → 跳过 init
  → init-admin 幂等执行
  → DbMigrateJob 比对记录和磁盘文件，执行新增的迁移
```

日志示例：
```
📦 Running migrations...
📋 Discovered versions: 1.0.0, 1.0.1
   Total migration files: 2
   - 1.0.0/1_0_0_base.sql (checksum: a1b2c3d4e5f6...)
   - 1.0.1/1_0_1__migrate_to_agent_platform.sql (checksum: f6e5d4c3b2a1...)

🔍 Current database version: v1.0.0
🎯 Latest available version: v1.0.1

ℹ️  No migration records found — treating as existing v1.0.0 environment.
   Stamping v1.0.0 and earlier (1 file(s)) without executing...
   ✓ stamped 1.0.0/1_0_0_base.sql

🚀 Upgrade path: v1.0.0 → v1.0.1
   Pending migrations (1 file(s)):
   - 1.0.1/1_0_1__migrate_to_agent_platform.sql (24412 bytes, checksum: f6e5d4c3b2a1...)

   → applying 1.0.1/1_0_1__migrate_to_agent_platform.sql (24412 bytes) ...
   ✅ 1.0.1/1_0_1__migrate_to_agent_platform.sql applied successfully

✅ Migrations done. applied=1 skipped=1 total=2
📌 Database is now at v1.0.1
```

#### 场景 3：已有迁移记录的环境升级

```
schema_migrations 已有 v1.0.0、v1.0.1 的记录
  → 判定当前版本为 v1.0.1
  → 跳过已记录的文件
  → 从 v1.0.2 开始执行新增的迁移
```

日志示例：
```
🔍 Current database version: v1.0.1
🎯 Latest available version: v1.0.2

🚀 Upgrade path: v1.0.1 → v1.0.2
   Pending migrations (1 file(s)):
   - 1.0.2/001__add_new_feature.sql (3200 bytes, checksum: 1a2b3c4d5e6f...)
```

### 并发安全

多个 `DbMigrateJob` Pod 同时执行时，通过 PostgreSQL Advisory Lock 保证只有一个进程实际执行迁移：

```
Pod A: pg_try_advisory_lock(0x4F434C57, 0x4D494721) → locked=true  → 执行迁移
Pod B: pg_try_advisory_lock(0x4F434C57, 0x4D494721) → locked=false → 跳过
```

## 命名规则

| 对象 | 规则 | 示例 |
|---|---|---|
| 目录名 | 严格 semver：`^[0-9]+\.[0-9]+\.[0-9]+$` | `1.0.0` / `1.2.3` |
| 文件名 | `NNN__<snake_case_desc>.sql`，`NNN` 为 3 位数字，**双下划线**分隔；或 `X_Y_Z_base.sql` 作为基线记录 | `001__add_skill_hub.sql`、`1_0_0_base.sql` |

执行顺序：**目录按 semver 升序**；**目录内按文件名字典序**。

## SQL 编写要求

1. **优先幂等**（作为第二道防线）：
   ```sql
   CREATE TABLE IF NOT EXISTS ...;
   ALTER TABLE x ADD COLUMN IF NOT EXISTS ...;
   CREATE INDEX IF NOT EXISTS ...;
   DROP POLICY IF EXISTS ... ON ...;
   ALTER TABLE IF EXISTS old_name RENAME TO new_name;
   ```
   不幂等的 DDL（如 `ADD CONSTRAINT`、`RENAME COLUMN`）依赖 `schema_migrations` 版本表防止重复执行。
2. **单文件原子** —— 每个 `.sql` 在一个事务中执行；任意一条失败整个文件回滚，`schema_migrations` 不会记录。
3. **不要写 `BEGIN;` / `COMMIT;`** —— 执行器已经包事务，重复包会报错。
4. **一经发布不得修改** —— 文件 checksum (sha256) 会被记入 `schema_migrations`；再次 apply 时 checksum 不匹配会立即报错退出。
5. **同目录内顺序冲突** —— 若同目录需补一个更早顺序的文件，请新开一个更高版本目录。

## 新增迁移流程

1. 根据语义版本确定目录：
   - 不破坏兼容性的列/索引新增 → `PATCH`
   - 新增表 / 业务语义变化 → `MINOR`
   - 破坏性 schema 变更 → `MAJOR`
2. `mkdir agent-manager/migrations/versions/X.Y.Z`
3. 新建 `001__<desc>.sql`，填写（优先幂等的）SQL。
4. 本地跑：
   ```bash
   cd agent-manager
   npm run test:migration-baseline
   node migrations/init-db.js migrate
   # 再跑一次验证 schema_migrations 生效（应立即退出，applied=0 skipped=N）
   node migrations/init-db.js migrate
   ```
5. 提交时连同代码变更一起；CI 会在预发环境自动跑 migrate。

## init-db.js 子命令一览

| 命令 | 用途 | 调用场景 |
|------|------|---------|
| `init` | 创建全量 schema + 种子数据，幂等（已初始化则跳过）；完成后 stamp 所有版本 | ROS Stack 首次创建（DbInitJob） |
| `init-admin` | 创建/更新管理员账号，幂等 | ROS Stack 首次创建（DbInitJob） |
| `migrate` | 按 semver 顺序执行增量迁移，自动检测当前版本 | ROS Stack 每次升级（DbMigrateJob） |
| `drop` | 删除所有表（危险） | 开发调试 |
| `full` | drop + init | 开发调试 |

## ROS Stack 中的 Job 编排

```
ROS Stack Update
  → DbMigrateJob (node migrations/init-db.js migrate)
    → WaitUntil Job 完成
      → PlatformDeployment (滚动更新 Pod)
        → HealthCheckJob
```

- **DbMigrateJob** 的 Job 名带时间戳后缀（`openclaw-db-migrate-${CurTime}`），避免 K8s `spec.template is immutable` 冲突
- `restartPolicy: Never`，失败后 Pod 保留 300 秒供 `kubectl logs` 查看
- `backoffLimit: 3`，Job 级别重试

## 回滚

- **不允许**手动删 `schema_migrations` 行。
- 如需回退，在下一个正向版本里写反向迁移 SQL。
- 紧急情况走 Supabase 快照恢复。
