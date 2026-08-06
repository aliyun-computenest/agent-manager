---
name: agent-manager-harness-api-test
description: Verifies Agent Manager APIs against the isolated deployed base URL with request, response, count, and correlation evidence. Use only for the test_api stage.
---

# Harness Stage: API Test

Run the manifest's API checks against the isolated environment `baseUrl`, never
localhost or a mock. The AOneCI path is:

```bash
node harness/scripts/aone-lifecycle.mjs \
  smoke-api --work-item <work_item_id> --task-id <task_id> \
  --branch <remote-branch> --base-url <baseUrl>
```

Record the target URL, exit code, request/response or report artifact, and
`testsPassed == totalTests > 0`. Redact credentials and temporary tokens. A
failed assertion returns the workflow to `develop` with evidence.
