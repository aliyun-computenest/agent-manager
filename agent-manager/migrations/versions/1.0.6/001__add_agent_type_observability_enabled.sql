-- 为 agent_types 表新增 Agent Type 级采集开关字段
ALTER TABLE agent_types ADD COLUMN IF NOT EXISTS observability_enabled BOOLEAN DEFAULT false;

-- 复合索引：优化按类型+状态查询 running 实例的性能（供批量 toggle 使用）
CREATE INDEX IF NOT EXISTS idx_agent_instances_type_status ON agent_instances(agent_type_id, status);

-- Add observability_env column if not exists (idempotent)
ALTER TABLE agent_types ADD COLUMN IF NOT EXISTS observability_env JSONB DEFAULT '{}'::jsonb;
