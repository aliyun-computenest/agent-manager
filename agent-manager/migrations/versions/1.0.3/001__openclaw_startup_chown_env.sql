-- 001: Update openclaw startup_command to chown .env file
--
-- Background: Sensitive config values (API keys, tokens) are now written to
-- ~/.openclaw/.env instead of being embedded in openclaw.json. The startup
-- command needs to chown this file alongside the config file so that the
-- openclaw process (running as 'node') can read it.

UPDATE agent_types
SET startup_command = '#!/bin/bash
chown node:node /home/node/.openclaw/openclaw.json
chown node:node /home/node/.openclaw/.env 2>/dev/null || true
supervisorctl restart openclaw'
WHERE code = 'openclaw';

-- Add supports_env_vars column to agent_types
--
-- When true, generateAndWriteAgentConfig writes sensitive values to a .env
-- file and preserves ${VAR} placeholders in the config. The agent runtime
-- (e.g. OpenClaw) resolves them from .env at startup.
-- When false (default), all template variables are substituted directly
-- into the config — the original behaviour for agent types that do not
-- support environment variable resolution.

ALTER TABLE agent_types
    ADD COLUMN IF NOT EXISTS supports_env_vars BOOLEAN DEFAULT false;

UPDATE agent_types
SET supports_env_vars = true
WHERE code = 'openclaw';

-- Background: The modify_model_command and modify_channel_command previously
-- only ran run-cmd.sh without restarting the openclaw process. After modifying
-- the config (openclaw.json / .env), the service must be restarted to pick up
-- changes. Additionally, since files are written as root but openclaw runs as
-- 'node', we need chown to fix permissions before restart.
--
-- This mirrors the startup_command pattern already in place (see 001).

UPDATE agent_types
SET
    modify_model_command = 'bash /usr/local/bin/run-cmd.sh modify-model "${MODEL_PROVIDER}/${MODEL_NAME}"
chown node:node /home/node/.openclaw/openclaw.json
chown node:node /home/node/.openclaw/.env 2>/dev/null || true
supervisorctl restart openclaw',
    modify_channel_command = 'bash /usr/local/bin/run-cmd.sh modify-channel "${CHANNEL_CONFIG_JSON}"
chown node:node /home/node/.openclaw/openclaw.json
chown node:node /home/node/.openclaw/.env 2>/dev/null || true
supervisorctl restart openclaw'
WHERE code = 'openclaw';

