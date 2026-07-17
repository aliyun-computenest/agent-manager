# Development Setup

> All commands in this document assume you are at the **repository root**: `/path/to/agent-manager/` (the directory that contains `agent-manager/`, `agent-docker/`, `docs/`, `harness/`, `Makefile`).

## 1 Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | 18 or newer (20 recommended) | Vite + Express backend |
| npm | bundled with Node | Package manager (lockfile is `package-lock.json`) |
| Python | 3.9+ | Required by `scripts/validate.py` and `scripts/lint-*.py` |
| Docker | 24+ | Optional — only needed to build / run images (`Dockerfile`, `docker-compose.yml`) |
| Make | GNU make | Convenience targets (the `make` shipped with macOS is sufficient) |
| Git + SSH | — | Source control |

### External services (you must have access)

| Service | Why | Variables |
|---------|-----|-----------|
| Supabase project | Postgres + Auth + RLS | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SERVICE_ROLE_KEY`, `DATABASE_URL` |
| E2B Cloud (or self-hosted) | Sandbox runtime | `E2B_API_KEY`, `E2B_DOMAIN` (optional: `E2B_IP`) |
| Aliyun APIG (optional) | AI Gateway routing | `APIG_*`, `ALIBABA_CLOUD_ACCESS_KEY_*` |
| OSS / ACK / SLS / CMS (optional) | Observability + skill mount | See `agent-manager/.env.example` |

## 2 Quick Start

```bash
# 1. Clone
git clone <repo> agent-manager
cd agent-manager

# 2. Configure env (fill real values)
cp agent-manager/.env.example agent-manager/.env
$EDITOR agent-manager/.env

# 3. Install
make install              # cd agent-manager && npm install && cd server && npm install

# 4. Bootstrap database (first time only)
cd agent-manager && node migrations/init-db.js full && cd ..

# 5. Start backend + frontend dev
make dev                  # Vite on :8080 (or as configured) — proxies /api to backend
# in a second terminal:
cd agent-manager/server && node --watch index.js     # backend on :3001

# 6. Open the SPA
open http://localhost:8080/
```

> For SSO setup, see `agent-manager/scripts/setup-saml-sso.py` and `docs/user-docs/`.

## 3 Build Commands

| Command | What it does |
|---------|--------------|
| `make build` | `cd agent-manager && npm run build` → emits `agent-manager/dist/` |
| `cd agent-manager && npm run preview` | Serve the production bundle locally |
| `docker build -f agent-manager/Dockerfile -t agent-manager:dev agent-manager/` | Build the single deploy image (frontend + backend + migrations) |
| `docker compose -f agent-manager/docker-compose.yml up --build` | Local docker run (frontend + backend, two services) |

## 4 Test Commands

| Command | Scope |
|---------|-------|
| `make test` | Vitest unit tests under `agent-manager/tests/unit/` |
| `make test-integration` | API integration tests; requires `agent-manager/.env.test` and `TEST_BASE_URL` |
| `make test-smoke` | Only `tests/integration/suites/smoke` (fast subset) |
| `cd agent-manager && npm run test:integration:sandbox-upgrade` | Sandbox-upgrade integration suite |
| `cd agent-manager && npm run test:ui:batch-import` | Playwright UI: batch import flow |
| `cd agent-manager && npm run test:ui:batch-import:headed` | Same but headed (debug) |

`vitest` config: `agent-manager/tests/integration/vitest.config.js`.
Playwright config: `agent-manager/playwright.config.ts`.

## 5 Lint Commands

| Command | What it does |
|---------|--------------|
| `make lint-arch` | Runs `scripts/lint-deps.py` + `scripts/lint-quality.py` (architecture + quality) |
| `make lint` | Alias for `lint-arch` |
| `cd agent-manager && npm run lint` | ESLint over the frontend + server JS/TS sources |
| `cd agent-manager && npm run lint:fix` | ESLint with `--fix` |
| `cd agent-manager/server && npm run validate:openapi` | Validate OpenAPI doc generated from `zod` schemas |

Pre-commit: `agent-manager/.husky/pre-commit` runs `lint-staged` (ESLint `--max-warnings 0` on staged JS/TS).

## 6 Migrations

```bash
cd agent-manager
node migrations/init-db.js migrate    # apply pending SQL (idempotent)
node migrations/init-db.js full       # drop + re-apply everything (local only)
node migrations/init-db.js drop       # drop all tables (DANGEROUS)
```

- New SQL goes in `agent-manager/migrations/versions/<semver>/NNN__<desc>.sql`.
- See `agent-manager/migrations/versions/README.md` for the immutability rule and version-folder decision matrix.
- The runner records SHA-256 checksums in `schema_migrations` — **never edit a shipped file**, write a forward-fix instead.

## 7 Validation Pipeline

```bash
python3 scripts/validate.py .
```

Runs in order, stops on first failure:

1. `make build`
2. `make lint-arch`
3. `make test`
4. `make verify` (skipped automatically if `scripts/verify/` has no executable scenarios)

Use `--skip-verify` to skip step 4.

## 8 Harness Helpers

`harness/scripts/` contains convenience scripts the agent (and humans) can use to set up an isolated test environment without polluting the developer's main `.env`:

```bash
make setup-env          # ./harness/scripts/setup-env.sh — checks required env vars
make start-server       # ./harness/scripts/start-server.sh — start backend on a test port and wait for /api/health
make teardown-env       # ./harness/scripts/teardown-env.sh — stop the backend
```

See [`harness/config/environment.json`](../harness/config/environment.json) for the runtime contract.

## 9 Common Tasks

| Task | How |
|------|-----|
| Add an HTTP route | Create handler in `agent-manager/server/routes/<file>.js`, register in `routes/index.js`, use `defineRoute(...)` so it appears in OpenAPI |
| Add a service | Drop into `agent-manager/server/services/`, export named functions, import only from `config/`/`utils/`/peers (never `routes/`) |
| Add a frontend page | Component in `agent-manager/src/components/`, route in `agent-manager/src/App.tsx` |
| Add a SQL migration | New `NNN__*.sql` file under the appropriate `migrations/versions/<semver>/` folder; run `node migrations/init-db.js migrate` twice (second time must report 0 applied) |
| Add a new LLM provider | New file under `agent-manager/server/services/providers/`, extend `BaseProvider`, register in `providers/index.js` |
| Add a new IM channel | Add template under `agent-manager/data/channels/`, handler under `agent-manager/server/services/<channel>-auto-config.js`, wire into `routes/channel-auto-config.js` |
| Bump version | Edit `agent-manager/version.json` (single source) → surfaced by `GET /api/version` and Docker tags |

## 10 Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| `Missing VITE_SUPABASE_URL or SERVICE_ROLE_KEY in .env` | Backend can't find `.env` — must be at `agent-manager/.env` (loaded by `server/config/index.js`) |
| `Missing TERMINAL_SESSION_SECRET or API_ENCRYPTION_KEY in .env` | Generate one: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `Failed to resolve E2B API host` | Either set `E2B_IP` explicitly or add the entry to `/etc/hosts`; in `local-dev` the backend prints the suggested line |
| Migrations report "checksum mismatch" | A previously-applied file was edited. Write a new forward-fix file instead |
| `npx vitest` cannot find tests | Run from `agent-manager/`, not the repo root |

## 11 Repository Layout Reference

```
.                                  # repo root (you are here for make commands)
├── AGENTS.md                      # Agent navigation map
├── Makefile                       # Build / test / lint targets
├── docs/                          # All documentation (this file lives here)
├── scripts/                       # Architecture linters + validate.py
├── harness/                       # Agent infrastructure (config, scripts, tasks, traces, memory)
├── agent-manager/                 # The actual app (frontend + backend)
│   ├── src/                       # React/Vite frontend
│   ├── server/                    # Express backend (ESM)
│   ├── migrations/                # SQL versions + runner
│   ├── tests/                     # unit / integration / ui
│   ├── data/                      # Static templates (channels, openclaw-template.json, ca cert)
│   └── package.json
├── agent-docker/                  # Per-agent Docker images (hermes / openclaw / qwenpaw)
├── deploy/agent-gateway/          # OpenResty + K8s deploy assets for the gateway
└── template/                      # ROS / ComputeNest deployment templates
```
