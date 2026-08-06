# Product Sense

## What This Product Does

Agent Manager is an **enterprise AI agent management platform**. It lets administrators provision, configure and operate AI agent instances ("OpenClaws") on behalf of users, and lets end users create and bind their own agents to IM channels (WeChat, Enterprise WeChat, QQ, Feishu, DingTalk). Each agent runs inside an isolated [E2B](https://e2b.dev/) code interpreter sandbox, can talk to one or more LLM providers (DashScope / LiteLLM / Aliyun AI Gateway), and is governed by per-user quotas (max instances, daily token budget).

The platform itself is a single Node.js process exposing a React/Vite SPA and an Express REST API under `/api`, backed by [Supabase](https://supabase.com/) (Postgres + Auth + RLS). It is deployed via aliyun ROS templates onto ACS Serverless behind an SLB.

## Who Uses It

| Persona | Goal |
|---------|------|
| **Platform Admin** | Onboard tenants, configure models / channels / templates, monitor global usage, manage SSO & email auth |
| **Tenant End User** | Create an agent instance, bind it to an IM channel, start/stop it, watch token usage |
| **Integrator** (ToC scripts) | Programmatically drive `/api/instances` using a Supabase Bearer token |

## Core User Journeys

1. **Admin first-time bootstrap**: deploy via ROS → `docker-entrypoint.sh` writes `.env`, runs `node migrations/init-db.js full`, then creates the seed admin (`ADMIN_EMAIL` / `ADMIN_PASSWORD`) → admin logs into `/admin/login` and configures models / channels / agent types.
2. **End user creates an agent**: SSO/email login → choose an enabled Agent Type and model → fill any Agent Type custom variables → `POST /api/instances` (quota check via `principal_profiles.max_agent_instances`) → `instance-provisioner.js` validates the custom variables, allocates an E2B sandbox, injects skills and returns (in `local-dev`) `/etc/hosts` hints → user opens the native Agent workspace or binds an IM channel.
3. **Admin observability**: `/admin/observability/cms` proxies to Aliyun CMS / SLS, gated by `gateway-config.js` credentials encrypted via `API_ENCRYPTION_KEY`.
4. **Instance upgrade**: admin uploads a new sandbox image / template → `sandbox-upgrades.js` performs backup → re-provision → rollback path on failure.
5. **Channel auto-config**: user scans DingTalk QR → `channel-auto-config.js` exchanges the code for tenant credentials, persists encrypted, registers the agent webhook.

## Business Rules

- **RLS-first data isolation**: Every table that holds user-owned data (`agent_instances`, `token_usage_logs`, `principal_profiles`, …) has Supabase Row-Level Security. The backend uses `createUserClient(token)` for user-scoped reads and `supabaseAdmin` only for explicit cross-tenant operations.
- **Quota gate is enforced server-side**: `max_agent_instances` and `daily_token_limit` checks live in `routes/instances.js` and `services/instance-provisioner.js` — never trust the client.
- **Credentials are always encrypted at rest**: Channel secrets, provider API keys and Aliyun AKSK go through `utils/crypto.js` (AES-GCM keyed by `API_ENCRYPTION_KEY`).
- **Migrations are immutable**: Files in `agent-manager/migrations/versions/<semver>/NNN__*.sql` are SHA-256 checksummed in `schema_migrations`. Edits to a shipped file cause `init-db.js migrate` to fail loudly.
- **Layered backend imports** (see [ARCHITECTURE.md](ARCHITECTURE.md)): `routes/` may not directly access Supabase — they go through `services/`. `services/` may not import from `routes/` or `middleware/`.
- **Single source of truth for version**: `agent-manager/version.json` → surfaced by `GET /api/version` and Docker image tags.

## Domain Terminology

| Term | Meaning |
|------|---------|
| **OpenClaw** | Synonym for "agent instance" — a running agent bound to a user, a model and zero or more IM channels |
| **Agent Type** | Reusable template describing default sandbox image, skills and channel bindings (managed under `/admin/agent-types`) |
| **Custom Variable** | Admin-defined per-Agent-Type input collected when a user creates an instance. Values are referenced as `${VAR_NAME}` in config templates, startup commands, and modify scripts |
| **SandboxSet** | K8s CRD that groups sandbox replicas (used for the `sandboxsets` admin view) |
| **Skill Hub** | OSS-mounted bundle of executable skills (`VITE_OSS_PV_NAME`) injected into the sandbox by `utils/skill-injector.js` |
| **Channel** | IM platform binding (DingTalk / Feishu / WeCom / QQ / WeChat). Stored as a row in `im_channels` with encrypted credentials |
| **Provider** | LLM provider implementation (`server/services/providers/*Provider.js`) — `AlibabaCloudAIGateway`, `LiteLLM`, `APIProvider`. Encapsulates auth, request shaping and budget bookkeeping |
| **AI Gateway** | Aliyun APIG instance acting as a model router; toggled by `ENABLE_AI_GATEWAY`, configured in `gateway-config.js` |
| **Deploy Environment** | `DEPLOY_ENVIRONMENT` ∈ `local-dev` / `cloud-dev` / `production`. Controls whether the backend auto-writes `/etc/hosts` for the E2B custom domain |
| **Consumer Key** | Per-instance credential used for model calls through Aliyun APIG |
