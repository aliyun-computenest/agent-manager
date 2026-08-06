# Review Gate

Run automated review after implementation and before platform acceptance.

The review gate passes only when:

- the current diff is limited to the manifest allowlist and task `writeScope`
- generated files and artifacts are either ignored or intentionally included
- automated review reports zero blocking findings
- any accepted blocker has a human acknowledgement
- required unit, E2E, integration, and waiting evidence is present

Recommended local dry-run command:

```bash
node harness/scripts/validate-delivery-run.mjs \
  --manifest harness/manifests/<feature>.json \
  --run <delivery-run.json>
```

If a blocking review finding remains, keep the Harness task `in_progress`.
