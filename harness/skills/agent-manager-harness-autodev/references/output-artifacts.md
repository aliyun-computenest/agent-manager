# Output And Artifacts

Harness task outputs should be small and machine-readable. Large logs, videos,
screenshots, traces, coverage reports, and review reports should be uploaded or
written as artifacts and referenced by URL or path.

## Task Output Shape

```json
{
  "state": "completed",
  "summary": "Implemented the delivery run validator.",
  "evidence": [
    {
      "kind": "unit",
      "command": "node --test harness/tests/*.test.mjs",
      "exitCode": 0,
      "testsPassed": 8,
      "totalTests": 8
    }
  ],
  "artifacts": [
    {
      "kind": "report",
      "url": "https://harness.example/artifacts/report.md"
    }
  ]
}
```

## Rules

- Keep inline output concise.
- Do not paste raw kubeconfigs, owner tokens, `.env` files, or credentials.
- Prefer `harness upload` for screenshots, videos, traces, and long logs.
- Include enough artifact metadata for an automated checker to decide whether
  evidence belongs to the feature.
