# ADB Supabase 数据库故障切换操作指南（ROS 集群版）

> 场景：通过 ROS 部署的集群版 Agent Manager 正在使用的旧 ADB Supabase 实例故障或不可用，新 ADB Supabase 实例已经完成数据恢复。本文只说明如何把 Agent Manager 切到新库。

## 1 前提

- 新 ADB Supabase 实例状态为运行中。
- 新实例最好与旧实例在同一地域、同一 VPC、同一 VSwitch；如果 VSwitch 不同，先确认 Manager 到新实例网络互通。
- 已拿到新实例的 API URL、Anon Key、Service Role Key、Database URL。
- 数据库已经恢复完成，切换 Manager 配置时不再单独执行迁移。

## 2 切换步骤

1. 确认新实例网络。
2. 在新实例白名单中放通 Manager 所在 VPC 网段。
3. 如果需要绑定 EIP，再处理外网地址、NAT 或网卡 EIP；数据库白名单仍先只放 VPC 网段。
4. 把 Manager 的 Supabase 环境变量改成新实例值。
5. 如果要同步升级 Manager 版本，直接替换 Deployment 镜像。
6. 重启 Manager。
7. 确认 Manager 能启动、登录，实例列表正常。

## 3 配置示例

### 3.1 环境变量

```bash
VITE_SUPABASE_URL=https://<新实例公网 ADB Supabase URL>
SUPABASE_INTERNAL_URL=https://<新实例内网 ADB Supabase URL>
VITE_SUPABASE_ANON_KEY=<新实例 Anon Key>
SERVICE_ROLE_KEY=<新实例 Service Role Key>
DATABASE_URL=postgresql://postgres:<密码>@<新实例内网数据库地址>:5432/postgres
```

`VITE_SUPABASE_URL` 给浏览器使用，通常填公网地址。`SUPABASE_INTERNAL_URL` 和 `DATABASE_URL` 给 Manager 后端使用，优先填同 VPC 内网地址。

### 3.2 ROS 集群控制台方式

平台资源所在 namespace 是计算巢参数 `PlatformNamespaceName`，默认是 `openclaw-platform`。Secret 和 ConfigMap 都在这个 namespace 下。

1. 打开 ACK/ACS 控制台，进入 Manager 所在集群。
2. 进入 `PlatformNamespaceName` 对应的 namespace。
3. 更新 ConfigMap `openclaw-platform-config`：
   - `VITE_SUPABASE_URL`
   - `SUPABASE_INTERNAL_URL`
4. 更新 Secret `openclaw-platform-secret`：
   - `VITE_SUPABASE_ANON_KEY`
   - `SERVICE_ROLE_KEY`
   - `DATABASE_URL`
5. 进入 Manager Deployment，按需替换镜像 tag。
6. 保存后触发滚动更新。

### 3.3 ROS 集群 kubectl 方式

```bash
# 改成计算巢参数 PlatformNamespaceName；默认 openclaw-platform。
PLATFORM_NAMESPACE=openclaw-platform

VITE_SUPABASE_URL='https://new-adb-supabase.example.com'
SUPABASE_INTERNAL_URL='https://new-adb-supabase-internal.example.com'
VITE_SUPABASE_ANON_KEY='new-anon-key'
SERVICE_ROLE_KEY='new-service-role-key'
DATABASE_URL='postgresql://postgres:password@new-db-internal.example.com:5432/postgres'

kubectl -n "$PLATFORM_NAMESPACE" patch configmap openclaw-platform-config \
  --type merge \
  -p "{\"data\":{\"VITE_SUPABASE_URL\":\"$VITE_SUPABASE_URL\",\"SUPABASE_INTERNAL_URL\":\"$SUPABASE_INTERNAL_URL\"}}"

VITE_SUPABASE_ANON_KEY_B64="$(printf '%s' "$VITE_SUPABASE_ANON_KEY" | base64 | tr -d '\n')"
SERVICE_ROLE_KEY_B64="$(printf '%s' "$SERVICE_ROLE_KEY" | base64 | tr -d '\n')"
DATABASE_URL_B64="$(printf '%s' "$DATABASE_URL" | base64 | tr -d '\n')"

kubectl -n "$PLATFORM_NAMESPACE" patch secret openclaw-platform-secret \
  --type merge \
  -p "{\"data\":{\"VITE_SUPABASE_ANON_KEY\":\"$VITE_SUPABASE_ANON_KEY_B64\",\"SERVICE_ROLE_KEY\":\"$SERVICE_ROLE_KEY_B64\",\"DATABASE_URL\":\"$DATABASE_URL_B64\"}}"

# 如果要同时切到新版本镜像：
MANAGER_IMAGE='registry.example.com/openclaw/openclaw-platform:tag'
kubectl -n "$PLATFORM_NAMESPACE" set image deployment/openclaw-platform \
  openclaw-platform="$MANAGER_IMAGE"

kubectl -n "$PLATFORM_NAMESPACE" rollout restart deployment/openclaw-platform
kubectl -n "$PLATFORM_NAMESPACE" rollout status deployment/openclaw-platform --timeout=180s
```


## 4 网络示例

优先走内网：

```text
Manager Pod/ECS -> 同 VPC 内网 -> 新 ADB Supabase
```

白名单先只放 VPC 网段，例如：

```text
10.0.0.0/16        # Manager 所在 VPC 或节点网段
```

不要先加入非 VPC 网段，也不要放开 `0.0.0.0/0`。

## 5 Auth 回调示例

如果新 ADB Supabase URL 变了，同步更新 OAuth/SAML 回调。

OAuth 回调：

```text
<新 ADB Supabase URL>/auth/v1/callback
```

SAML SP 信息：

```text
SP Metadata URL: <新 ADB Supabase URL>/auth/v1/sso/saml/metadata
ACS URL: <新 ADB Supabase URL>/auth/v1/sso/saml/acs
```

如果 Manager 的公网地址也变了，同时更新 Supabase Auth 的 Site URL 和 Redirect URL。

## 6 回滚

如果切换失败：

1. 保留新实例，保存 Manager 和 ADB Supabase 错误日志。
2. 如果旧实例已经恢复可用，把 Manager 环境变量改回旧实例值。
3. 重启 Manager。
4. 重新确认登录和实例列表。

如果旧实例不可用，不要反复覆盖新实例；先排查新实例网络、白名单、key、Auth 回调和 Manager 配置。
