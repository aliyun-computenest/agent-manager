---
name: agent-manager-harness-live-integration
description: Verifies Agent Manager behavior through real OOS, Kubernetes, E2B, Supabase, gateway, or sandbox readback and classifies failures. Use only for the integration_live stage.
---

# Harness Stage: Live Integration

Run the approved integration wrapper with the isolated base URL and namespace.
Read back the target system state; daemon availability or CI success alone is
not integration evidence.

On failure, run `classify-integration-failure.mjs` before proceeding:

- feature-related failures return to `develop`
- external-only prerequisite failures may continue only with classification and report
- mixed or unrelated failures require `harness ask` and block review/release

Record correlation IDs, target objects, status, and sanitized log/report links.
Never expose cloud credentials or temporary tokens.
