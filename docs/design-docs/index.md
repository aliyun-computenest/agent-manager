# Design Docs Index

Per-component design notes. Each doc explains *why* a component looks the way it does,
its key interfaces, the happy path, and where things go wrong.

| # | Component | Backend code | Doc |
|---|-----------|--------------|-----|
| 1 | Instance Provisioner | [`agent-manager/server/services/instance-provisioner.js`](../../agent-manager/server/services/instance-provisioner.js) | [instance-provisioner.md](instance-provisioner.md) |
| 2 | LLM Providers | [`agent-manager/server/services/providers/`](../../agent-manager/server/services/providers/) | [providers.md](providers.md) |
| 3 | Channel Auto-Config | [`agent-manager/server/services/*-auto-config.js`](../../agent-manager/server/services/) + [`routes/channel-auto-config.js`](../../agent-manager/server/routes/channel-auto-config.js) | [channels.md](channels.md) |
| 4 | Sandbox & Terminal | [`agent-manager/server/services/sandbox.js`](../../agent-manager/server/services/sandbox.js) + [`terminal.js`](../../agent-manager/server/services/terminal.js) | [sandbox-terminal.md](sandbox-terminal.md) |

See also: [docs/ARCHITECTURE.md](../ARCHITECTURE.md), [docs/DEVELOPMENT.md](../DEVELOPMENT.md), [docs/PRODUCT_SENSE.md](../PRODUCT_SENSE.md).
