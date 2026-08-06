---
name: agent-manager-harness-env-prepare
description: Creates or binds the isolated Agent Manager test environment through the approved AOneCI wrapper and records environment readback. Use only for the env_prepare stage.
---

# Harness Stage: Environment Prepare

Run the kit wrapper, not a hand-written AOneCI command:

```bash
node harness/scripts/aone-lifecycle.mjs \
  env-create --work-item <work_item_id> --task-id <task_id> \
  --branch <remote-branch> --namespace <namespace>
```

Confirm the remote branch and pipeline YAML exist before starting. Record the
pipeline run ID plus namespace, service, base URL, image source, database/tenant
isolation, and secret references. Missing cluster or secret inputs require
`harness ask`; local development services cannot substitute for this stage.
