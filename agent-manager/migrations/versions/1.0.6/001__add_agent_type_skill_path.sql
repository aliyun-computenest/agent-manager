-- Agent Type 的在线 Skill 安装目录。
-- 该目录由 Agent 自身扫描，Agent Manager 只负责把下载结果原子发布到这里。

ALTER TABLE agent_types
  ADD COLUMN IF NOT EXISTS skill_path VARCHAR(512);

UPDATE agent_types
SET skill_path = CASE code
  WHEN 'openclaw' THEN '/home/node/.agents/skills'
  WHEN 'hermes' THEN '/opt/data/skills'
  WHEN 'qwenpaw' THEN '/app/working/skill_pool'
  ELSE CASE
    WHEN COALESCE(NULLIF(terminal_user, ''), NULLIF(sandbox_user, ''), 'node') = 'root'
      THEN '/root/.agents/skills'
    ELSE '/home/' || COALESCE(NULLIF(terminal_user, ''), NULLIF(sandbox_user, ''), 'node') || '/.agents/skills'
  END
END
WHERE skill_path IS NULL OR btrim(skill_path) = '';

-- Hermes 官方镜像内置 hermes 用户，终端和在线安装统一使用该用户。
UPDATE agent_types
SET terminal_user = 'hermes'
WHERE code = 'hermes';

ALTER TABLE agent_types
  ALTER COLUMN skill_path SET NOT NULL;

COMMENT ON COLUMN agent_types.skill_path IS
  'Agent 在线安装 Skill 的根目录；必须是 Agent 运行时实际扫描的绝对路径。';
