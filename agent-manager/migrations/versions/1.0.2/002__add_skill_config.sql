-- Migration 1.0.3: Add skill_config to agent_types
-- Purpose: Enable per-agent-type CSI volume mount configuration
-- for skills stored on persistent volumes (OSS-backed PV).

ALTER TABLE agent_types
  ADD COLUMN IF NOT EXISTS skill_config JSONB DEFAULT NULL;

COMMENT ON COLUMN agent_types.skill_config IS
  'CSI volume mount config for skills. Format: [{"pvName":"","mountPath":"","subPath":""}]. pvName auto-filled from VITE_OSS_PV_NAME at sandbox creation.';
