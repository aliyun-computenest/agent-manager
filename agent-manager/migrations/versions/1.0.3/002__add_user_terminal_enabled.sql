-- Allow each Agent type to opt in to user-side browser terminal access.
-- Admins can still open terminals for troubleshooting; this flag only gates normal users.

ALTER TABLE agent_types
  ADD COLUMN IF NOT EXISTS user_terminal_enabled BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN agent_types.user_terminal_enabled IS
  'Whether normal users can open a browser terminal for instances of this Agent type.';

-- Separate browser terminal login user from sandbox write/startup user.
-- Existing Agent types default to a non-root login user so user-side terminals do not open as root.

ALTER TABLE agent_types
  ADD COLUMN IF NOT EXISTS terminal_user VARCHAR(50);

UPDATE agent_types
SET terminal_user = 'node'
WHERE terminal_user IS NULL OR btrim(terminal_user) = '';

-- Hermes images use the E2B default non-root user "user" instead of "node".
UPDATE agent_types
SET terminal_user = 'user'
WHERE code = 'hermes';

ALTER TABLE agent_types
  ALTER COLUMN terminal_user SET DEFAULT 'node',
  ALTER COLUMN terminal_user SET NOT NULL;

COMMENT ON COLUMN agent_types.terminal_user IS
  'System user used when creating browser terminal PTY sessions. Defaults to node.';
