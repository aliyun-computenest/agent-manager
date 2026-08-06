---
name: agent-manager-harness-ephemeral-deploy
description: Builds and deploys the current Agent Manager branch to the retained isolated environment and verifies rollout and health. Use only for the deploy_ephemeral stage.
---

# Harness Stage: Ephemeral Deploy

Run the approved wrapper:

```bash
node harness/scripts/aone-lifecycle.mjs \
  deploy-image --work-item <work_item_id> --task-id <task_id> \
  --branch <remote-branch> --namespace <namespace>
```

Require a pushed remote branch and current pipeline YAML. Record the AOneCI run
ID, image tag, namespace, service, rollout status, isolated base URL, and a
successful `/api/health` readback. A local dev server or an older shared
deployment is not valid evidence.
