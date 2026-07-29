# Supabase Auth 手动配置指南

本文只记录 OpenClaw Manager 接入 Supabase OAuth / SAML 时必须手动处理的配置。密钥只用占位符，不能写入文档或提交到仓库。

## 部署顺序

1. 部署 Supabase，记录模板输出的 `SupabaseUrl`、`OAuthCallbackUrl`、`SamlMetadataUrl`、`SamlAcsUrl`、`AnonKey`、`ServiceRoleKey`。
2. 在 OAuth App 或企业 IdP 中填写 Supabase 输出的回调、metadata、ACS 地址。
3. 部署 Manager，等 Manager 的 SLB、EIP 或域名确定后，记录 `MANAGER_URL`。
4. 回到 Supabase Auth，手动设置业务站点 URL 和允许跳转 URL 列表。
5. 切换 Manager 登录模式：`none`、`oauth` 或 `saml`。

Supabase 模板先部署，Manager 后部署。Manager URL 在 Supabase 创建时还不存在，所以 `GOTRUE_SITE_URL` 和 `GOTRUE_URI_ALLOW_LIST` 不应作为 Supabase 模板的必填参数。模板后置 Job 只会写入 Supabase 自身地址作为临时值，Manager 部署后必须改成 Manager 地址。

## Supabase 模板参数

开源 Supabase 部署模板（独立维护）只处理 Supabase 自身需要的参数：

| 参数 | 说明 |
| --- | --- |
| `DeploymentNamespace` | 可选。指定 Supabase 部署到哪个 Kubernetes namespace。留空则使用当前 ROS 栈名。 |
| `OAuthProvider` | `none`、`github`、`google` 三选一 |
| `OAuthClientId` | 所选 OAuth App 的 Client ID |
| `OAuthClientSecret` | 所选 OAuth App 的 Client Secret，`NoEcho` |
| `EnableSaml` | 是否开启 GoTrue SAML |
| `SamlIdpMetadataUrl` | 企业 IdP 应用的 metadata URL |
| `SamlDomain` | 用于匹配 SAML 登录的邮箱域名 |

OAuth 的 Client ID 和 Secret 共用一组字段，由 `OAuthProvider` 决定写入 GitHub 还是 Google 的 GoTrue 环境变量。未选择 OAuth 时，这两个字段不需要填写。

开启 SAML 时，`SamlIdpMetadataUrl` 和 `SamlDomain` 必填。模板不再要求用户传入 SAML 私钥；后置 Job 会优先复用 GoTrue Deployment 里已有的 `GOTRUE_SAML_PRIVATE_KEY`，仍为空则在集群内生成新的 PKCS#1 DER RSA 私钥并写回 GoTrue。

SAML 私钥只负责 GoTrue/SP 侧能力，用来生成 SP metadata 和处理 SAML 断言；`SamlIdpMetadataUrl` 和 `SamlDomain` 用来在部署后自动注册 Supabase SSO Provider。只配置私钥不能完成可登录的 SAML。

如果 IdP 需要先填写 Supabase 的 `SamlMetadataUrl` / `SamlAcsUrl` 才能生成 metadata URL，先用 `EnableSaml=false` 部署 Supabase，拿到输出后去 IdP 配置应用，再更新 ROS 栈打开 `EnableSaml=true` 并填写 `SamlIdpMetadataUrl`、`SamlDomain`。

模板自动生成的私钥不会作为 ROS 输出返回；需要查看或备份时，从 GoTrue Deployment 的 `GOTRUE_SAML_PRIVATE_KEY` 环境变量读取。

## 站点 URL 和跳转白名单

部署 Manager 后再设置。GoTrue 的 `site_url` 决定 SAML/OAuth 回调后用户被重定向到哪个地址，必须指向 Manager 的公网访问地址。

### 阿里云托管 Supabase

托管版 GoTrue 支持 `/modify/settings` Admin API：

```bash
export SUPABASE_AUTH_URL="<SupabaseUrl>/auth/v1"
export SERVICE_ROLE_KEY="<service-role-key>"
export MANAGER_URL="https://manager.example.com"

curl -X PATCH "${SUPABASE_AUTH_URL}/modify/settings" \
  -H "apikey: ${SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SERVICE_ROLE_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "site_url": "'"${MANAGER_URL}"'",
    "uri_allow_list": "'"${MANAGER_URL}"'"
  }'
```

### 开源 Supabase

开源 GoTrue **不支持** `/modify/settings` 端点，必须通过 Kubernetes 环境变量设置：

```bash
export MANAGER_URL="http://<Manager-SLB-IP>:8080"

kubectl -n <supabase-namespace> set env deployment/supabase-supabase-auth \
  GOTRUE_SITE_URL="${MANAGER_URL}" \
  GOTRUE_URI_ALLOW_LIST="${MANAGER_URL}/"

kubectl -n <supabase-namespace> rollout restart deployment/supabase-supabase-auth
kubectl -n <supabase-namespace> rollout status deployment/supabase-supabase-auth --timeout=180s
```

Helm upgrade 或 Flux reconciliation 可能覆盖手动设置的环境变量。建议同步修改 Helm values 或 Flux patch 以持久化配置。

OAuth App 的 callback 仍然填写 Supabase Auth 地址，不要改成 Manager 地址：

```text
<SupabaseUrl>/auth/v1/callback
```

## OAuth 配置

OAuth App 控制台填写模板输出：

```text
Authorization callback URL: <OAuthCallbackUrl>
```

验证 Supabase Auth 是否真的启用 provider：

```bash
curl -sS "${SUPABASE_AUTH_URL}/settings" \
  -H "apikey: ${ANON_KEY}" \
  -H "Authorization: Bearer ${ANON_KEY}"

curl -i "${SUPABASE_AUTH_URL}/authorize?provider=github&redirect_to=${MANAGER_URL}" \
  -H "apikey: ${ANON_KEY}"
```

`settings` 返回 provider 为启用状态，并且 `authorize` 返回 302 到第三方登录页，才算 OAuth 配好。Manager 兼容两种 settings 结构：

```json
{ "external": { "github": true } }
```

```json
{ "external_github_enabled": true }
```

当前测试过的自建和阿里云托管环境里，`/auth/v1/admin/custom-providers` 返回 404；因此不要把 Custom OAuth/OIDC 放进基础流程。阿里云 OAuth 只有在 GoTrue 或托管 Supabase 明确支持对应 provider 后才能接入。

## SAML 配置

模板开启 SAML 后会输出：

```text
SamlMetadataUrl = <SupabaseUrl>/auth/v1/sso/saml/metadata
SamlAcsUrl      = <SupabaseUrl>/auth/v1/sso/saml/acs
```

IdP 控制台填写：

| 配置项 | 值 |
| --- | --- |
| SP Entity ID / Metadata URL | `SamlMetadataUrl` |
| ACS URL | `SamlAcsUrl` |
| NameID | 用户邮箱 |
| Attribute `email` | 用户邮箱 |

自建 Supabase 还需要保证 GoTrue 具备这些环境变量：

```bash
kubectl -n <namespace> set env deployment/<gotrue-deployment> \
  GOTRUE_SAML_ENABLED=true \
  GOTRUE_SAML_PRIVATE_KEY="<base64-pkcs1-der-rsa-private-key>" \
  GOTRUE_SAML_EXTERNAL_URL="${SUPABASE_AUTH_URL}" \
  API_EXTERNAL_URL="${SUPABASE_AUTH_URL}"
```

如果使用开源 Supabase 部署模板部署，上面的私钥会由模板后置 Job 自动生成并写入；手动维护已有集群时才需要自己生成或复制该值。

SAML provider 仍需注册到 Supabase Auth。能访问 IdP metadata URL 时：

```bash
curl -X POST "${SUPABASE_AUTH_URL}/admin/sso/providers" \
  -H "apikey: ${SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SERVICE_ROLE_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "saml",
    "metadata_url": "https://idp.example.com/saml2/metadata",
    "domains": ["example.com"],
    "attribute_mapping": {
      "keys": {
        "email": { "name": "email" }
      }
    }
  }'
```

如果 IdP metadata URL 不能被 Supabase Auth 访问，改用 `metadata_xml` 传入 XML。

如果 IdP 只能导出 metadata XML，Supabase 模板无法在创建时自动注册 provider。此时不要在模板里开启 SAML，先部署 Supabase，再手动调用上面的 Auth Admin API。

登录报 `SAML2 NameID is empty` 时，优先检查 IdP 用户是否有邮箱、NameID 表达式是否取到邮箱、是否映射了 `email` attribute。

## Manager 登录模式

登录页由 `system_config.sso_active_mode` 控制：

| mode | 登录页展示 |
| --- | --- |
| `none` | 账号密码 |
| `oauth` | 账号密码 + 已启用 OAuth providers |
| `saml` | 账号密码 + SAML SSO |

通过 Manager Admin API 修改：

```bash
curl -X PUT "${MANAGER_URL}/api/sso/mode" \
  -H "Authorization: Bearer <manager-admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"mode":"saml"}'
```

没有 admin token 时，可以直接改 Manager 数据库：

```sql
insert into system_config (key, value, description, updated_at)
values (
  'sso_active_mode',
  '{"mode":"saml"}'::jsonb,
  '单点登录启用模式：none/oauth/saml',
  now()
)
on conflict (key) do update
set value = excluded.value,
    updated_at = now();
```

切到 `oauth` 前确认 `/auth/v1/settings` 已返回启用的 OAuth provider。切到 `saml` 前确认：

```bash
curl -sS "${MANAGER_URL}/api/sso/providers/public"
```

能返回可用的 SAML provider。

## 兼容边界

| 场景 | 结论 |
| --- | --- |
| 官方 hosted Supabase 修改 Auth config | 通常需要官方 Management API access token 或控制台权限 |
| 阿里云托管 Supabase 修改 Auth config | 以托管侧开放的 Auth Admin API / 控制台能力为准 |
| 自建 Supabase 修改 Auth config | 可以用 service role 调 Auth Admin API，或直接改 GoTrue env |
| Custom OAuth/OIDC | 当前测试环境未开放 `/admin/custom-providers`，基础流程不支持 |
| Manager URL 未确定时设置跳转白名单 | 不可靠，部署 Manager 后再设置 |
