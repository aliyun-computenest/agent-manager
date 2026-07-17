-- =====================================================
-- Migration: agent_types 新增增量修改脚本字段
-- Version: 1.0.2
-- =====================================================
-- 背景：修改模型/渠道时不再整体覆盖配置文件（避免覆盖
-- 用户的自定义内容），改为执行管理员在 Agent 配置中
-- 定义的局部修改脚本。
--
-- 新增两个字段：
--   modify_model_command   - 修改模型的 shell 命令模板
--   modify_channel_command - 修改渠道的 shell 命令模板
--
-- 当字段为空/NULL 时：
--   - 前端禁用模型/渠道修改入口
--   - 后端拒绝对应字段的修改请求
-- =====================================================

ALTER TABLE agent_types
  ADD COLUMN IF NOT EXISTS modify_model_command   TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS modify_channel_command TEXT DEFAULT NULL;

COMMENT ON COLUMN agent_types.modify_model_command IS
  '修改模型的 shell 命令（支持 ${MODEL_NAME}、${MODEL_PROVIDER}、${MODEL_BASE_URL}、${CONSUMER_API_KEY}、${AI_GATEWAY_DOMAIN} 等占位符）；为空表示不支持在线修改模型';

COMMENT ON COLUMN agent_types.modify_channel_command IS
  '修改渠道的 shell 命令（支持 ${CHANNEL_TYPE}、${CHANNEL_CLIENT_ID}、${CHANNEL_CLIENT_SECRET}、${CHANNEL_CONFIG_JSON} 等占位符）；为空表示不支持在线修改渠道';

-- ---------------------------------------------------
-- 为内置 Agent 类型预置默认脚本调用
-- ---------------------------------------------------

-- OpenClaw：使用镜像中内置的 /usr/local/bin/run-cmd.sh
-- modify-model 接受 "provider/model" 字符串
-- modify-channel 接受「完整的渠道配置 JSON」。为什么不是 3 字段简版？
--   真实 openclaw.json 的渠道块字段远多于 clientId/clientSecret
--   （例如钉钉的 dingtalk-connector 还要 ackText / enabled / gatewayToken
--    / gatewayPassword / groupSessionScope 等 8 个字段），且顶层 key 名称
--   与 channel_type 不一致（dingtalk → dingtalk-connector）。
--   因此由后端基于 channel_templates 渲染出完整 JSON 注入 ${CHANNEL_CONFIG_JSON}，
--   保证与创建实例时写入的结构完全一致。
--   该占位符在传递时会通过 _AGENT_CHANNEL_CONFIG_JSON 环境变量脱敏，
--   避免含明文 secret 的 JSON 出现在 ps / shell history 中。
UPDATE agent_types
SET
  modify_model_command = 'bash /usr/local/bin/run-cmd.sh modify-model "${MODEL_PROVIDER}/${MODEL_NAME}"',
  modify_channel_command = 'bash /usr/local/bin/run-cmd.sh modify-channel "${CHANNEL_CONFIG_JSON}"'
WHERE code = 'openclaw' AND modify_model_command IS NULL;

-- Hermes：run-cmd.sh 只接收 model_name。provider / base_url / api_key
-- 在实例创建时由平台写入 config.yaml，后续禁止跨 provider 修改，因此
-- 无需再在 modify-model 阶段传递，避免敏感值暴露到命令行 / 日志。
-- 渠道接收三个位置参数（channel_type, client_id, client_secret）
UPDATE agent_types
SET
  modify_model_command = 'bash /usr/local/bin/run-cmd.sh modify-model "${MODEL_NAME}"',
  modify_channel_command = 'bash /usr/local/bin/run-cmd.sh modify-channel "${CHANNEL_TYPE}" "${CHANNEL_CLIENT_ID}" "${CHANNEL_CLIENT_SECRET}"
supervisorctl restart hermes'
WHERE code = 'hermes' AND modify_model_command IS NULL;
