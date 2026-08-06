# E2B 证书与域名变更指南

## 第一部分：E2B 实例侧 — 域名 / 证书变更

> 适用场景：仅修改域名、仅修改证书、或域名 + 证书同时变更。
> ⚠️ 操作顺序很重要：**先更新证书 → 再改域名配置**，顺序反了会导致 Ingress 报 `mismatch host`。

### 前置信息

| 项目 | 值 |
|---|---|
| 新域名 | `<NEW_DOMAIN>`（例如 `sandbox.example.com`） |
| 新证书文件 | `fullchain.pem`、`privkey.pem`（证书 SAN 需覆盖 `*.<NEW_DOMAIN>` 和 `<NEW_DOMAIN>`） |

---

### 步骤 1：更新 TLS 证书

将新域名对应的证书更新到 K8s Secret。

**方式一：ACK 控制台**

1. 打开 [ACK 控制台](https://cs.console.aliyun.com/)，进入对应集群
2. 左侧菜单 **配置管理 → 保密字典**
3. 命名空间选择 `sandbox-system`，找到 `sandbox-manager-tls`
4. 点击 **编辑**，更新 `tls.crt`（证书内容，base64 编码）和 `tls.key`（私钥内容，base64 编码）
5. 保存

**方式二：kubectl 命令**

```bash
kubectl create secret tls sandbox-manager-tls \
  --cert=fullchain.pem \
  --key=privkey.pem \
  -n sandbox-system \
  --dry-run=client -o yaml | kubectl apply -f -
```

**验证**：

```bash
kubectl get secret sandbox-manager-tls -n sandbox-system \
  -o jsonpath='{.data.tls\.crt}' | base64 -d | \
  openssl x509 -noout -subject -ext subjectAltName -dates
```

确认输出的 SAN 包含新域名。

> 如果只改证书不改域名（例如证书续期），做完这一步即可，后面的步骤跳过，直接进入第二部分。

---

### 步骤 2：更新 sandbox-manager 域名配置

在 ACK 控制台操作：

1. 进入 **集群详情 → 运维管理 → 组件管理**
2. 找到 **ack-sandbox-manager** → 点击 **修改配置**
3. 将 `domain` 字段改为新域名
4. 保存

> 保存后 Helm 会自动重新渲染 Ingress 资源，host 和 TLS hosts 会自动更新为新域名，无需手动 patch Ingress。

验证：

```bash
# 确认 Ingress host 已更新
kubectl get ingress sandbox-manager -n sandbox-system \
  -o jsonpath='{.spec.rules[*].host}' && echo

# 确认 TLS hosts 已更新
kubectl get ingress sandbox-manager -n sandbox-system \
  -o jsonpath='{.spec.tls[0].hosts}' && echo
```

> 如果只改域名不改证书，仍需先执行步骤 1 更新证书（新域名必须有匹配的证书）。

---

### 步骤 3：更新 PrivateZone DNS 解析

在阿里云 [PrivateZone 控制台](https://dns.console.aliyun.com/#/dns/setting/zones) 操作：

**3.1** 获取 ALB DNS Name：

```bash
kubectl get ingress sandbox-manager -n sandbox-system \
  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' && echo
```

**3.2** 创建新 Zone 并配置解析：

| 操作 | 说明 |
|---|---|
| 添加 Zone | Zone 名称填 `<NEW_DOMAIN>` |
| 绑定 VPC | 选择集群所在的 VPC |
| 添加解析记录 | 记录类型 `CNAME`，主机记录 `*`，记录值填上面获取的 ALB DNS Name |

**3.3** 验证（在 VPC 内机器上执行）：

```bash
nslookup api.<NEW_DOMAIN>
```

**3.4** ⚠️ **删除旧域名的 PrivateZone 解析**

> **必须操作，不是可选**。如果旧域名的 PrivateZone 和 CNAME 记录不删除，同一个 ALB 上会同时存在新旧两个域名的解析，导致 ALB Ingress Controller 尝试匹配两套域名的证书，触发 `mismatch host` 错误。

1. 进入 PrivateZone 控制台，找到旧域名的 Zone
2. 先删除 Zone 下的所有解析记录（CNAME `*` 记录）
3. 解绑 VPC
4. 删除旧域名的 Zone

---

### 步骤 4：验证 E2B 侧

**方式一：ACK 控制台**

1. 进入集群 → 左侧 **工作负载 → 无状态**，命名空间选 `sandbox-system`
2. 找到 `sandbox-manager`，点击进入查看 Pod 状态是否 Running
3. 点击 Pod 名称 → **日志** 标签页，查看是否有异常
4. 左侧 **网络 → 路由**，命名空间选 `sandbox-system`，确认 Ingress `sandbox-manager` 的 host 已更新为新域名

**方式二：kubectl 命令**

```bash
# HTTPS 连通性
curl -v https://api.<NEW_DOMAIN>/health

# sandbox-manager 日志中是否有请求记录
kubectl logs deployment/sandbox-manager -n sandbox-system \
  -c controller --tail=20

# Ingress 事件是否有异常
kubectl get events -n sandbox-system --sort-by='.lastTimestamp' | tail -10
```

---

### E2B 侧操作速查表

| 变更场景 | 需要操作的步骤 |
|---|---|
| **仅续期证书**（域名不变） | 步骤 1 |
| **仅改域名** | 步骤 1 + 2 + 3 |
| **域名 + 证书都变** | 步骤 1 + 2 + 3 |
| ALB 配置 | 无需修改 |
| Ingress 规则 | 无需手动修改（步骤 2 自动更新） |

---

## 第二部分：Agent Manager 侧 — 同步配置

当 E2B 实例更新了证书/域名后，Agent Manager 侧需要同步以下配置，确保平台能正常连接 E2B API。

### 1. e2b-ca-cert Secret（CA 证书）

从 `sandbox-system` 复制最新证书到 `agent-manager`。

**方式一：ACK 控制台**

1. 进入集群 → **配置管理 → 保密字典**
2. 命名空间选 `sandbox-system`，找到 `sandbox-manager-tls`，点击进入查看详情
3. 复制 `tls.crt` 字段的 base64 值
4. 切换命名空间到 `agent-manager`，找到 `e2b-ca-cert`
5. 点击 **编辑**，将 `ca-fullchain.pem` 字段的值替换为刚才复制的 `tls.crt` 值
6. 保存

**方式二：kubectl 命令**

```bash
CERT=$(kubectl -n sandbox-system get secret sandbox-manager-tls -o jsonpath='{.data.tls\.crt}')
kubectl -n agent-manager patch secret e2b-ca-cert \
  -p "{\"data\":{\"ca-fullchain.pem\":\"$CERT\"}}"
```

**作用**：Platform Pod 通过 `NODE_EXTRA_CA_CERTS` 加载此证书，用于 TLS 验证 E2B API 请求。

---

### 2. agent-manager-config ConfigMap（E2B_DOMAIN）

确认 `E2B_DOMAIN` 是否变化，如果变了需要更新。

**方式一：ACK 控制台**

1. 进入集群 → **配置管理 → 配置项**
2. 命名空间选 `agent-manager`，找到 `agent-manager-config`
3. 点击 **编辑**，找到 `E2B_DOMAIN` 字段
4. 将值修改为新的 E2B 域名
5. 保存

**方式二：kubectl 命令**

```bash
# 查看当前域名
kubectl -n agent-manager get configmap agent-manager-config \
  -o jsonpath='{.data.E2B_DOMAIN}'

# 如果域名变了，更新 ConfigMap
kubectl -n agent-manager patch configmap agent-manager-config \
  -p '{"data":{"E2B_DOMAIN":"<新的E2B域名>"}}'
```

**作用**：E2B SDK 用这个域名连接 sandbox-manager API。

---

### 3. agent-manager-secret Secret（E2B_API_KEY）

如果 E2B 更新后 API Key 也变了，需要同步更新。

**方式一：ACK 控制台**

1. 进入集群 → **配置管理 → 保密字典**
2. 命名空间选 `agent-manager`，找到 `agent-manager-secret`
3. 点击 **编辑**，找到 `E2B_API_KEY` 字段
4. 将值修改为新的 API Key（控制台会自动处理 base64 编码）
5. 保存

**方式二：kubectl 命令**

```bash
NEW_KEY_B64=$(echo -n "<新的E2B_API_KEY>" | base64)
kubectl -n agent-manager patch secret agent-manager-secret \
  -p "{\"data\":{\"E2B_API_KEY\":\"$NEW_KEY_B64\"}}"
```

**作用**：Platform 调用 E2B API 的认证凭证。

---

### 4. 重启 Pod（最后一步）

**方式一：ACK 控制台**

1. 进入集群 → **工作负载 → 无状态**
2. 命名空间选 `agent-manager`，找到 `agent-manager`
3. 点击右侧 **更多 → 重新部署**

**方式二：kubectl 命令**

```bash
kubectl -n agent-manager delete pod -l app=agent-manager
```

**作用**：Pod 重启后会加载新的证书文件 + 读取新的环境变量。

---

### Platform 侧速查表

| 配置项 | K8s 资源 | 命名空间 | 何时需要改 |
|--------|----------|----------|-----------|
| CA 证书 | Secret `e2b-ca-cert` | `agent-manager` | E2B 重新签发了 TLS 证书 |
| E2B 域名 | ConfigMap `agent-manager-config` → `E2B_DOMAIN` | `agent-manager` | E2B 的 ALB/域名地址变了 |
| API Key | Secret `agent-manager-secret` → `E2B_API_KEY` | `agent-manager` | E2B 重新生成了 API Key |
| 重启 Pod | Deployment `agent-manager` | `agent-manager` | 以上任一项变更后必须执行 |

---

## 常见问题

### Q: Ingress 报 `mismatch host`

**原因**：证书的域名和 Ingress host 不匹配。

排查：

```bash
# 对比 Ingress host 和证书域名
echo "=== Ingress TLS hosts ==="
kubectl get ingress sandbox-manager -n sandbox-system \
  -o jsonpath='{.spec.tls[0].hosts}' && echo

echo "=== 证书域名 ==="
kubectl get secret sandbox-manager-tls -n sandbox-system \
  -o jsonpath='{.data.tls\.crt}' | base64 -d | \
  openssl x509 -noout -ext subjectAltName
```

常见场景：

| 现象 | 原因 | 修复 |
|---|---|---|
| Ingress 是新域名，证书是旧域名 | 先改了 Addon 域名再换证书，顺序反了 | 重新执行步骤 1 更新证书 |
| 同一个 ALB 上挂了多个 Ingress | 旧域名的 Ingress 没有清理 | 删除旧 Ingress |

检查是否有多余的 Ingress：

```bash
kubectl get ingress --all-namespaces -o wide | grep alb
```

### Q: sandbox-manager 完全收不到请求

依次检查：

1. **DNS 是否解析到 ALB** → `nslookup api.<NEW_DOMAIN>`
2. **Ingress host 是否已更新** → `kubectl get ingress sandbox-manager -n sandbox-system -o jsonpath='{.spec.rules[*].host}'`
3. **证书是否匹配** → 见上方 mismatch 排查

### Q: 通配符证书 `*.example.com` 能匹配哪些域名

- ✅ `api.example.com`、`ws.example.com`（一级子域名）
- ❌ `api.sandbox.example.com`（两级子域名，`*` 只匹配一级）
