-- =====================================================
-- Migration: 为 agent_types 增加 supports_skills 字段
-- Version: 1.0.2
-- =====================================================
-- 背景：
--   现有 agent_types 已通过 supports_channels 控制是否支持渠道配置；
--   现新增 supports_skills 字段以同样的方式控制是否支持技能配置。
--   - openclaw / hermes：默认 true（支持技能）
--   - qwenpaw：默认 false（本期不支持技能）
-- =====================================================

ALTER TABLE agent_types
  ADD COLUMN IF NOT EXISTS supports_skills BOOLEAN DEFAULT true;

COMMENT ON COLUMN agent_types.supports_skills IS
  '是否支持技能配置（包含技能挂载与 SkillHub 引导）。前端依据该字段控制技能 Tab、技能配置卡片是否展示。';

-- 内置类型的初始值：
--   openclaw / hermes 支持技能配置
--   qwenpaw 当前不支持技能配置（前端隐藏技能 Tab）
UPDATE agent_types SET supports_skills = true  WHERE code IN ('openclaw', 'hermes');
UPDATE agent_types SET supports_skills = false WHERE code = 'qwenpaw';
