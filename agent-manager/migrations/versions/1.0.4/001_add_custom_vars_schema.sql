-- Add custom_vars_schema field to agent_types table.
-- Allows admins to define custom variables that users provide values for during instance creation.
-- These variables are used as ${VAR} placeholders in startup commands and config templates.

ALTER TABLE agent_types
  ADD COLUMN IF NOT EXISTS custom_vars_schema JSONB DEFAULT NULL;

COMMENT ON COLUMN agent_types.custom_vars_schema IS
  '自定义变量定义数组。格式: [{"name":"MY_VAR","label":"我的变量","type":"text|password|textarea","required":true,"placeholder":"请输入...","description":"变量用途说明"}]。用户创建实例时按此定义填写值，运行时通过 ${MY_VAR} 占位符注入到启动命令和配置模板中。';
