-- =====================================================
-- 1.0.5: Add skill_config column to agent_instances
-- Stores the skill mount snapshot selected by the customer at instance creation time.
-- NULL = legacy instance (created before this feature); [] = new instance with no skills.
-- =====================================================

ALTER TABLE agent_instances
  ADD COLUMN IF NOT EXISTS skill_config JSONB DEFAULT NULL;

COMMENT ON COLUMN agent_instances.skill_config IS
  '实例创建时客户选择的技能挂载快照。与 agent_types.skill_config 字段结构一致（pvName/mountPath/subPath/isRequired/skillSpaceId）；NULL 表示旧实例（功能上线前创建），[]（空数组）表示新实例无技能配置';
