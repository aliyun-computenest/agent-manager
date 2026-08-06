# Agent Manager — AI Agent Guide

> Enterprise AI agent management platform — multi-user creation, configuration and operation of AI agent instances, integrated with E2B sandboxes and multiple IM channels.

## 1 Quick Start
- Build: `make build` (delegates to `cd agent-manager && npm run build`)
- Test: `make test` (Vitest unit tests in `agent-manager/`)
- Lint: `make lint-arch` (architecture + quality linters)
- Dev: `make dev` (Vite dev server in `agent-manager/`)
- Validate: `python3 scripts/validate.py .` (full pipeline)

## 2 Repository Layout
| Path | Purpose |
|------|---------|
| `agent-manager/` | Main app — React+Vite frontend (`src/`) + Express backend (`server/`) |
| `agent-manager/server/` | Node.js ESM backend, mounted under `/api` |
| `agent-manager/migrations/` | SQL migrations executed via `init-db.js` |
| `agent-manager/tests/` | Vitest unit + integration + Playwright UI tests |
| `agent-docker/` | Per-agent Docker images (hermes, openclaw, qwenpaw) |
| `template/` | ROS / ComputeNest deployment templates |
| `docs/` | All harness + design documentation |
| `scripts/` | Architecture + quality linters |
| `harness/` | Agent infrastructure (config, scripts, tasks, traces, memory) |

→ Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## 3 Architecture (Backend `agent-manager/server/`)
| Layer | Packages | Purpose |
|-------|----------|---------|
| L0 | `server/config/`, `server/schemas/` | Config loading, zod schemas — no internal imports |
| L1 | `server/utils/` | Crypto, logger, agent-config, skill-injector — imports L0 |
| L2 | `server/services/` (+ `services/providers/`) | Business logic (provisioner, sandbox, channels, gateways) — imports L0-L1 |
| L3 | `server/middleware/`, `server/openapi/` | Auth, validation, OpenAPI registry — imports L0-L1 |
| L4 | `server/routes/` (+ `routes/internal/`) | HTTP handlers — imports L0-L3 |
| L5 | `server/index.js`, `server/frontend-server.js` | Entry points — imports L0-L4 |

→ Layer rules + diagrams: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## 4 Documentation
| Doc | Purpose |
|-----|---------|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Layer hierarchy, diagrams, forbidden imports |
| [DEVELOPMENT.md](docs/DEVELOPMENT.md) | Prereqs, env setup, build/test/lint commands |
| [PRODUCT_SENSE.md](docs/PRODUCT_SENSE.md) | What the product does, users, journeys |
| [design-docs/](docs/design-docs/) | Per-component design (provisioner, providers, channels, sandbox) |
| [DEVELOPMENT_GUIDE.md](docs/DEVELOPMENT_GUIDE.md) | Pre-existing long-form dev guide (deep details) |
| [api/api.md](docs/api/api.md) | Pre-existing REST API reference |

## 5 Development Commands
```bash
make install        # Install root + agent-manager deps
make dev            # Start Vite dev server (frontend)
make build          # Build agent-manager (Vite production build)
make test           # Run Vitest unit tests
make test-smoke     # Run integration smoke suite (requires .env.test)
make lint-arch      # Architecture lints (lint-deps + lint-quality)
make lint           # Alias for lint-arch
python3 scripts/validate.py .   # Build + lint + test pipeline
```

## 6 Key Runtime Dependencies
| Dependency | Where | Required |
|-----------|-------|----------|
| Supabase (PostgreSQL + Auth) | `SUPABASE_URL`, `SERVICE_ROLE_KEY`, `DATABASE_URL` | Yes |
| E2B Code Interpreter | `E2B_API_KEY`, `E2B_DOMAIN` | Yes (for instance start) |
| Aliyun APIG (AI Gateway) | `APIG_*`, `ALIBABA_CLOUD_*` | Optional |
| Kubernetes (ACK / ACS) | kubeconfig in pod | Optional (sandboxsets only) |

→ Full env contract: [`harness/config/environment.json`](harness/config/environment.json), example: [`agent-manager/.env.example`](agent-manager/.env.example)

## 7 Rules
- Layer N can only import from layers `< N` (see Section 3). Enforced by `scripts/lint-deps.py`.
- Single source file ≤ 800 lines (warning above); legacy files are listed in `scripts/lint-quality.py` `KNOWN_EXCEPTIONS`.
- Use `appLogger` from `server/utils/logger.js` in `services/` and `routes/`; raw `console.*` is reserved for `server/index.js` and `server/config/index.js` bootstrapping.
- SQL migrations are immutable once shipped — see `agent-manager/migrations/versions/README.md`. Add a new `NNN__*.sql` rather than editing an existing one.
- New API routes MUST use `defineRoute` from `server/openapi/route-helper.js` so they appear in the OpenAPI spec and Swagger UI.
- All sensitive provider credentials must be passed through `server/utils/crypto.js` (`encryptApiKey` / `decryptApiKey`) — never store plaintext keys in the DB or logs.
- All routes derive the caller from the Supabase JWT (`req.user`) and use `createUserClient(req.token)` for user-scoped DB reads; `supabaseAdmin` is only allowed in `services/` for explicit cross-tenant operations.

→ Component-level design notes live under [`docs/design-docs/`](docs/design-docs/index.md).
