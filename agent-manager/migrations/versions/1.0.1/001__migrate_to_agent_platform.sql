-- =====================================================
-- 迁移脚本: V1.0.0 → V1.0.1
-- 从 OpenClaw Manager 升级为通用 Agent Manager
-- 执行方式：在 Supabase SQL Editor 或 init-db.js migrate 中运行
-- =====================================================

-- =====================================================
-- 1. 创建 agent_types 表
-- =====================================================

CREATE TABLE IF NOT EXISTS agent_types (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  code VARCHAR(50) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  icon VARCHAR(50) DEFAULT 'bot',
  category VARCHAR(20) NOT NULL DEFAULT 'builtin'
    CHECK (category IN ('builtin', 'custom')),
  
  -- E2B 沙箱配置
  sandbox_template_id VARCHAR(100),
  sandbox_timeout INTEGER DEFAULT 300,
  
  -- 配置模板 (JSONB)
  config_template JSONB DEFAULT '{}',
  config_write_path VARCHAR(255),
  
  -- 启动 & 就绪检查
  startup_command TEXT,
  readiness_check JSONB DEFAULT '{}',
  
  -- 能力声明
  supports_channels BOOLEAN DEFAULT false,
  sandbox_user VARCHAR(50) DEFAULT NULL,

  -- 状态
  is_enabled BOOLEAN DEFAULT true,
  sort_order INTEGER DEFAULT 0,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_agent_types_code ON agent_types(code);
CREATE INDEX IF NOT EXISTS idx_agent_types_category ON agent_types(category);
CREATE INDEX IF NOT EXISTS idx_agent_types_enabled ON agent_types(is_enabled);

-- RLS
ALTER TABLE agent_types ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can view enabled agent types" ON agent_types;
CREATE POLICY "Anyone can view enabled agent types" ON agent_types
  FOR SELECT USING (is_enabled = true);

DROP POLICY IF EXISTS "Admins can manage agent types" ON agent_types;
CREATE POLICY "Admins can manage agent types" ON agent_types
  FOR ALL USING (is_admin_check());

-- 触发器
DROP TRIGGER IF EXISTS set_agent_types_updated_at ON agent_types;
CREATE TRIGGER set_agent_types_updated_at
  BEFORE UPDATE ON agent_types
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- 2. 插入内置 Agent 类型种子数据
-- =====================================================

-- OpenClaw (内置) - 从 system_config.openclaw_template 迁移配置
INSERT INTO agent_types (code, name, description, icon, category, sandbox_template_id, sandbox_timeout, config_template, config_write_path, startup_command, readiness_check, supports_channels, sandbox_user, is_enabled, sort_order) VALUES (
  'openclaw',
  'OpenClaw',
  '基于 OpenClaw 框架的 AI Agent，支持多模型、渠道集成和 Gateway 控制',
  'claw',
  'builtin',
  'agent-manager-openclaw',
  300,
  '{
    "agents": {
      "defaults": {
        "model": {
          "primary": "${MODEL_PROVIDER}/${MODEL_NAME}"
        },
        "workspace": "/home/node/.openclaw/workspace"
      }
    },
    "models": {
      "mode": "merge",
      "providers": {
        "bailian": {
          "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
          "apiKey": "${DASHSCOPE_API_KEY}",
          "api": "openai-completions",
          "models": []
        },
        "api_gateway": {
          "baseUrl": "http://${AI_GATEWAY_DOMAIN}/v1",
          "apiKey": "${CONSUMER_API_KEY}",
          "api": "openai-completions",
          "models": []
        },
        "litellm": {
          "baseUrl": "http://${LITELLM_PROXY_URL}",
          "apiKey": "${LITELLM_API_KEY}",
          "api": "openai-completions",
          "models": []
        }
      }
    },
    "commands": {
      "native": "auto",
      "nativeSkills": "auto",
      "restart": true,
      "ownerDisplay": "raw"
    },
    "gateway": {
      "port": 18789,
      "bind": "lan",
      "controlUi": {
        "allowedOrigins": ["*"],
        "dangerouslyAllowHostHeaderOriginFallback": true,
        "allowInsecureAuth": true,
        "dangerouslyDisableDeviceAuth": true
      },
      "auth": {
        "mode": "token",
        "token": "${GATEWAY_TOKEN}"
      }
    },
    "channels": {}
  }'::jsonb,
  '/home/node/.openclaw/openclaw.json',
  '#!/bin/bash
chown node:node /home/node/.openclaw/openclaw.json
supervisorctl restart openclaw',
  '{"type": "http", "port": 18789, "path": "/health", "timeout": 120}'::jsonb,
  true,
  'root',
  true,
  1
) ON CONFLICT (code) DO UPDATE SET
  config_template = EXCLUDED.config_template,
  config_write_path = EXCLUDED.config_write_path,
  startup_command = EXCLUDED.startup_command,
  readiness_check = EXCLUDED.readiness_check,
  supports_channels = EXCLUDED.supports_channels,
  sandbox_user = EXCLUDED.sandbox_user,
  is_enabled = EXCLUDED.is_enabled;

-- Hermes (内置) - YAML 格式配置
INSERT INTO agent_types (code, name, description, icon, category, sandbox_template_id, sandbox_timeout, config_template, config_write_path, startup_command, readiness_check, supports_channels, sandbox_user, is_enabled, sort_order) VALUES (
  'hermes',
  'Hermes',
  '基于 Hermes 框架的 AI Agent，支持终端操作、记忆和压缩等高级功能',
  'message-circle',
  'builtin',
  'agent-manager-hermes',
  300,
  jsonb_build_object('_format', 'yaml', '_content', 'model:
  default: ${MODEL_NAME}
  provider: alibaba
  base_url: https://dashscope.aliyuncs.com/compatible-mode/v1
  # 阿里云AI网关的配置
  #  default: ${MODEL_NAME}
  #  provider: custom
  #  base_url: http://${AI_GATEWAY_DOMAIN}/v1
  #  api_key: ${CONSUMER_API_KEY}

  # LiteLLM网关的配置
  #  default: ${MODEL_NAME}
  #  provider: custom
  #  base_url: http://${LITELLM_PROXY_URL}/v1
  #  api_key: ${LITELLM_API_KEY}
terminal:
  backend: local
  cwd: .
  timeout: 180
  docker_mount_cwd_to_workspace: false
  lifetime_seconds: 300
  container_cpu: 1
  container_memory: 5120
  container_disk: 51200
  container_persistent: true
browser:
  inactivity_timeout: 120
compression:
  enabled: true
  threshold: 0.5
  target_ratio: 0.2
  protect_last_n: 20
memory:
  memory_enabled: true
  user_profile_enabled: true
  memory_char_limit: 2200
  user_char_limit: 1375
  nudge_interval: 10
  flush_min_turns: 6
session_reset:
  mode: both
  idle_minutes: 1440
  at_hour: 4
group_sessions_per_user: true
streaming:
  enabled: false
skills:
  creation_nudge_interval: 15
agent:
  max_turns: 60
  verbose: false
  reasoning_effort: medium
  personalities:
    helpful: You are a helpful, friendly AI assistant.
    concise: You are a concise assistant. Keep responses brief and to the point.
    technical: You are a technical expert. Provide detailed, accurate technical information.
    creative: You are a creative assistant. Think outside the box and offer innovative
      solutions.
    teacher: You are a patient teacher. Explain concepts clearly with examples.
    kawaii: "You are a kawaii assistant! Use cute expressions like (\u25D5\u203F\u25D5\
      ), \u2605, \u266A, and ~! Add sparkles and be super enthusiastic about everything!\
      \ Every response should feel warm and adorable desu~! \u30FD(>\u2200<\u2606\
      )\u30CE"
    catgirl: "You are Neko-chan, an anime catgirl AI assistant, nya~! Add ''nya'' and\
      \ cat-like expressions to your speech. Use kaomoji like (=^\uFF65\u03C9\uFF65\
      ^=) and \u0E05^\u2022\uFECC\u2022^\u0E05. Be playful and curious like a cat,\
      \ nya~!"
    pirate: ''Arrr! Ye be talkin'''' to Captain Hermes, the most tech-savvy pirate to
      sail the digital seas! Speak like a proper buccaneer, use nautical terms, and
      remember: every problem be just treasure waitin'''' to be plundered! Yo ho ho!''
    shakespeare: Hark! Thou speakest with an assistant most versed in the bardic arts.
      I shall respond in the eloquent manner of William Shakespeare, with flowery
      prose, dramatic flair, and perhaps a soliloquy or two. What light through yonder
      terminal breaks?
    surfer: "Duuude! You''re chatting with the chillest AI on the web, bro! Everything''s\
      \ gonna be totally rad. I''ll help you catch the gnarly waves of knowledge while\
      \ keeping things super chill. Cowabunga! \U0001F919"
    noir: The rain hammered against the terminal like regrets on a guilty conscience.
      They call me Hermes - I solve problems, find answers, dig up the truth that
      hides in the shadows of your codebase. In this city of silicon and secrets,
      everyone''s got something to hide. What''s your story, pal?
    uwu: hewwo! i''m your fwiendwy assistant uwu~ i wiww twy my best to hewp you! *nuzzles
      your code* OwO what''s this? wet me take a wook! i pwomise to be vewy hewpful
      >w<
    philosopher: Greetings, seeker of wisdom. I am an assistant who contemplates the
      deeper meaning behind every query. Let us examine not just the ''how'' but the
      ''why'' of your questions. Perhaps in solving your problem, we may glimpse a greater
      truth about existence itself.
    hype: "YOOO LET''S GOOOO!!! \U0001F525\U0001F525\U0001F525 I am SO PUMPED to help\
      \ you today! Every question is AMAZING and we''re gonna CRUSH IT together! This\
      \ is gonna be LEGENDARY! ARE YOU READY?! LET''S DO THIS! \U0001F4AA\U0001F624\
      \U0001F680"
platform_toolsets:
  cli:
  - hermes-cli
  telegram:
  - hermes-telegram
  discord:
  - hermes-discord
  whatsapp:
  - hermes-whatsapp
  slack:
  - hermes-slack
  signal:
  - hermes-signal
  homeassistant:
  - hermes-homeassistant
  qqbot:
  - hermes-qqbot
stt:
  enabled: true
  local:
    model: base
  openai:
    model: whisper-1
code_execution:
  timeout: 300
  max_tool_calls: 50
delegation:
  max_iterations: 50
  default_toolsets:
  - terminal
  - file
  - web
display:
  compact: false
  tool_progress: all
  interim_assistant_messages: true
  busy_input_mode: interrupt
  background_process_notifications: all
  bell_on_complete: false
  show_reasoning: false
  streaming: true
  skin: default'),
  '/opt/data/config.yaml',
  '#!/bin/bash

cat > /opt/data/.env << ''EOF''
DASHSCOPE_API_KEY=${DASHSCOPE_API_KEY}
DINGTALK_CLIENT_ID=${CHANNEL_CLIENT_ID}
DINGTALK_CLIENT_SECRET=${CHANNEL_CLIENT_SECRET}
GATEWAY_ALLOW_ALL_USERS=true
EOF

# 重启hermes
supervisorctl restart hermes',
  '{"type":"tcp","port":9119,"timeout":120}'::jsonb,
  true,
  'root',
  true,
  2
) ON CONFLICT (code) DO UPDATE SET
  config_template = EXCLUDED.config_template,
  config_write_path = EXCLUDED.config_write_path,
  startup_command = EXCLUDED.startup_command,
  readiness_check = EXCLUDED.readiness_check,
  supports_channels = EXCLUDED.supports_channels,
  sandbox_user = EXCLUDED.sandbox_user,
  is_enabled = EXCLUDED.is_enabled;

-- =====================================================
-- 3. 重命名 openclaw_instances → agent_instances
-- =====================================================

-- 先删除旧触发器
DROP TRIGGER IF EXISTS set_updated_at ON openclaw_instances;
DROP TRIGGER IF EXISTS set_openclaw_instances_updated_at ON openclaw_instances;

-- 重命名表
ALTER TABLE IF EXISTS openclaw_instances RENAME TO agent_instances;

-- 新增 agent_type_id 字段
ALTER TABLE agent_instances
  ADD COLUMN IF NOT EXISTS agent_type_id UUID REFERENCES agent_types(id) ON DELETE SET NULL;

-- 新增 agent_image 字段：记录实例创建时使用的 SandboxSet 容器镜像，
-- 供 InstanceVersionPanel 进行版本对比 / 升级判断。
ALTER TABLE agent_instances
  ADD COLUMN IF NOT EXISTS agent_image VARCHAR(500);

-- 回填：将现有实例关联到 OpenClaw 类型
UPDATE agent_instances
  SET agent_type_id = (SELECT id FROM agent_types WHERE code = 'openclaw')
  WHERE agent_type_id IS NULL;

-- 重命名索引
ALTER INDEX IF EXISTS idx_openclaw_user_id RENAME TO idx_agent_instances_user_id;
ALTER INDEX IF EXISTS idx_openclaw_model_id RENAME TO idx_agent_instances_model_id;
ALTER INDEX IF EXISTS idx_openclaw_sandbox_id RENAME TO idx_agent_instances_sandbox_id;
ALTER INDEX IF EXISTS idx_openclaw_status RENAME TO idx_agent_instances_status;

-- 新增索引
CREATE INDEX IF NOT EXISTS idx_agent_instances_type ON agent_instances(agent_type_id);

-- 重建触发器 (指向新表名)
DROP TRIGGER IF EXISTS set_updated_at ON agent_instances;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON agent_instances
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_agent_instances_updated_at ON agent_instances;
CREATE TRIGGER set_agent_instances_updated_at
  BEFORE UPDATE ON agent_instances
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- 4. 更新 RLS 策略 (表名已自动跟随 RENAME)
-- PostgreSQL RENAME TABLE 会自动更新策略中的表名引用
-- 但子查询中引用旧表名的需要手动更新
-- =====================================================

-- instance_channel_configs 中的 RLS 引用了 openclaw_instances，需要更新
-- 由于 ALTER TABLE RENAME 不会自动更新子查询中的引用，我们重建策略

DROP POLICY IF EXISTS "Users can view own instance channel configs" ON instance_channel_configs;
CREATE POLICY "Users can view own instance channel configs" ON instance_channel_configs
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM agent_instances
      WHERE agent_instances.id = instance_channel_configs.instance_id
      AND agent_instances.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users can manage own instance channel configs" ON instance_channel_configs;
CREATE POLICY "Users can manage own instance channel configs" ON instance_channel_configs
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM agent_instances
      WHERE agent_instances.id = instance_channel_configs.instance_id
      AND agent_instances.user_id = auth.uid()
    )
  );

-- =====================================================
-- 5. user_profiles 字段重命名
-- =====================================================

-- Rename max_openclaw_instances → max_agent_instances (idempotent: skip if already renamed or added)
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'user_profiles' AND column_name = 'max_openclaw_instances'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'user_profiles' AND column_name = 'max_agent_instances'
  ) THEN
    ALTER TABLE user_profiles RENAME COLUMN max_openclaw_instances TO max_agent_instances;
  END IF;
END $$;

-- 更新 CHECK 约束 (需要先删除再重建)
ALTER TABLE user_profiles DROP CONSTRAINT IF EXISTS user_profiles_max_openclaw_instances_check;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_profiles_max_agent_instances_check'
  ) THEN
    ALTER TABLE user_profiles ADD CONSTRAINT user_profiles_max_agent_instances_check CHECK (max_agent_instances >= 0);
  END IF;
END $$;

-- =====================================================
-- 6. 更新 create_or_update_admin_profile 函数
-- =====================================================

CREATE OR REPLACE FUNCTION create_or_update_admin_profile()
RETURNS VOID AS $$
DECLARE
  admin_user_id UUID;
BEGIN
  SELECT id INTO admin_user_id
  FROM auth.users
  WHERE email = 'admin@openclaw.local';

  IF admin_user_id IS NOT NULL THEN
    INSERT INTO user_profiles (
      id, username, email, role, status, max_agent_instances, is_first_login
    ) VALUES (
      admin_user_id, 'Admin', 'admin@openclaw.local', 'admin', 'active', 999, true
    )
    ON CONFLICT (id) DO UPDATE SET
      username = 'Admin',
      role = 'admin',
      status = 'active',
      max_agent_instances = 999,
      is_first_login = true;

    RAISE NOTICE '管理员 profile 已创建/更新';
  ELSE
    RAISE NOTICE '管理员账号不存在，请先在 Supabase Dashboard 中创建用户';
  END IF;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- 7. channel_templates 表增加 config_template 字段
-- 将渠道配置从 system_config 迁移到 channel_templates
-- =====================================================

ALTER TABLE channel_templates
  ADD COLUMN IF NOT EXISTS config_template JSONB DEFAULT '{}';

-- 迁移 channel_config:feishu → channel_templates.config_template
UPDATE channel_templates SET config_template = sc.value
FROM (SELECT value FROM system_config WHERE key = 'channel_config:feishu') sc
WHERE channel_type = 'feishu' AND (config_template IS NULL OR config_template = '{}'::jsonb);

UPDATE channel_templates SET config_template = sc.value
FROM (SELECT value FROM system_config WHERE key = 'channel_config:dingtalk') sc
WHERE channel_type = 'dingtalk' AND (config_template IS NULL OR config_template = '{}'::jsonb);

UPDATE channel_templates SET config_template = sc.value
FROM (SELECT value FROM system_config WHERE key = 'channel_config:wecom') sc
WHERE channel_type = 'wecom' AND (config_template IS NULL OR config_template = '{}'::jsonb);

UPDATE channel_templates SET config_template = sc.value
FROM (SELECT value FROM system_config WHERE key = 'channel_config:qq') sc
WHERE channel_type = 'qq' AND (config_template IS NULL OR config_template = '{}'::jsonb);

-- =====================================================
-- 8. 清理废弃的 system_config 数据 (可选，建议确认迁移成功后执行)
-- =====================================================

-- 注意: 以下删除操作建议在确认迁移成功后手动执行
DELETE FROM system_config WHERE key = 'openclaw_template';
DELETE FROM system_config WHERE key LIKE 'channel_config:%';

-- =====================================================
-- 9. 将渠道模板关联到 Agent 类型
-- 每个 Agent 类型可独立管理自己的渠道配置
-- =====================================================

-- 添加 agent_type_id 列
ALTER TABLE channel_templates
  ADD COLUMN IF NOT EXISTS agent_type_id UUID REFERENCES agent_types(id) ON DELETE CASCADE;

-- 移除 channel_type 的全局唯一约束（同一渠道类型可属于不同 Agent 类型）
ALTER TABLE channel_templates
  DROP CONSTRAINT IF EXISTS channel_templates_channel_type_key;

-- 将现有渠道模板复制到 OpenClaw 类型（仅 OpenClaw 需要预置渠道配置，其他类型由管理员按需添加）
INSERT INTO channel_templates (channel_type, name, description, config_fields, config_file, config_template, is_enabled, agent_type_id)
SELECT ct.channel_type, ct.name, ct.description, ct.config_fields, ct.config_file, ct.config_template, ct.is_enabled, at.id
FROM channel_templates ct
CROSS JOIN agent_types at
WHERE ct.agent_type_id IS NULL
  AND at.code = 'openclaw';

-- 删除没有 agent_type_id 的旧记录
DELETE FROM channel_templates WHERE agent_type_id IS NULL;

-- 添加复合唯一约束（同一 agent_type 下每种渠道类型只能有一个模板）
ALTER TABLE channel_templates
  ADD CONSTRAINT channel_templates_type_agent_unique UNIQUE(channel_type, agent_type_id);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_channel_templates_agent_type ON channel_templates(agent_type_id);

-- =====================================================
-- 9b. 插入 Hermes 类型的钉钉渠道模板
-- =====================================================

INSERT INTO channel_templates (channel_type, name, description, config_fields, config_file, config_template, is_enabled, agent_type_id)
SELECT 'dingtalk', '钉钉 (DingTalk)', '钉钉开放平台应用配置',
  '[{"name": "clientId", "type": "text", "label": "Client ID (AppKey)", "required": true}, {"name": "clientSecret", "type": "password", "label": "Client Secret (AppSecret)", "required": true}]'::jsonb,
  NULL,
  '{"_format": "yaml", "_content": "gateway:\n  dingtalk:\n    enabled: true"}'::jsonb,
  true,
  at.id
FROM agent_types at WHERE at.code = 'hermes'
ON CONFLICT (channel_type, agent_type_id) DO UPDATE SET
  config_template = EXCLUDED.config_template,
  config_fields = EXCLUDED.config_fields;

-- =====================================================
-- 10. 创建 provider_config 表
-- =====================================================

CREATE TABLE IF NOT EXISTS provider_config (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  display_name VARCHAR(200),
  type VARCHAR(100) NOT NULL,
  config JSONB NOT NULL DEFAULT '{}',
  enabled BOOLEAN DEFAULT true,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_provider_config_name ON provider_config(name);
CREATE INDEX IF NOT EXISTS idx_provider_config_enabled ON provider_config(enabled);
CREATE INDEX IF NOT EXISTS idx_provider_config_type ON provider_config(type);

-- 启用行级安全
ALTER TABLE provider_config ENABLE ROW LEVEL SECURITY;

-- 策略：所有用户可以查看启用的 Provider 配置
DROP POLICY IF EXISTS "Users can view enabled provider configs" ON provider_config;
CREATE POLICY "Users can view enabled provider configs" ON provider_config
  FOR SELECT USING (provider_config.enabled = true);

-- 策略：管理员可以管理所有 Provider 配置
DROP POLICY IF EXISTS "Admins can manage provider configs" ON provider_config;
CREATE POLICY "Admins can manage provider configs" ON provider_config
  FOR ALL USING (is_admin(auth.uid()));

-- 触发器：自动更新 updated_at
DROP TRIGGER IF EXISTS set_provider_config_updated_at ON provider_config;
CREATE TRIGGER set_provider_config_updated_at
  BEFORE UPDATE ON provider_config
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- 11. 迁移 Provider 数据：system_config → provider_config
-- =====================================================

-- 11a. 迁移百炼 Provider
INSERT INTO provider_config (name, display_name, type, config, enabled, description)
SELECT
  'bailian',
  '百炼',
  'API',
  jsonb_build_object(
    'apiKey', COALESCE(sc.value->>'apiKey', ''),
    'apiKeyPlaceholder', '${DASHSCOPE_API_KEY}',
    'domain', '',
    'domainPlaceholder', '${DASHSCOPE_API_DOMAIN}'
  ),
  COALESCE((sc.value->>'isEnabled')::boolean, true),
  '百炼 API Provider 配置'
FROM system_config sc
WHERE sc.key = 'provider_config:bailian'
ON CONFLICT (name) DO NOTHING;

-- 如果 system_config 中不存在旧记录，插入默认值
INSERT INTO provider_config (name, display_name, type, config, enabled, description) VALUES (
  'bailian',
  '百炼',
  'API',
  '{"apiKey": "", "apiKeyPlaceholder": "${DASHSCOPE_API_KEY}", "domain": "", "domainPlaceholder": "${DASHSCOPE_API_DOMAIN}"}'::jsonb,
  true,
  '百炼 API Provider 配置'
)
ON CONFLICT (name) DO NOTHING;

-- 11b. 迁移阿里云AI网关 Provider
INSERT INTO provider_config (name, display_name, type, config, enabled, description)
SELECT
  'api_gateway',
  '阿里云AI网关',
  'AlibabaCloudAIGateway',
  jsonb_build_object(
    'apiKeyPlaceholder', '${CONSUMER_API_KEY}',
    'domainPlaceholder', '${AI_GATEWAY_DOMAIN}',
    'parameters', jsonb_build_object(
      'regionId', COALESCE(gw.value->>'regionId', ''),
      'gatewayId', COALESCE(gw.value->>'gatewayId', ''),
      'httpApiId', COALESCE(gw.value->>'httpApiId', ''),
      'environmentId', COALESCE(gw.value->>'environmentId', ''),
      'gatewayDomain', COALESCE(gw.value->>'gatewayDomain', ''),
      'dashscopeApiKey', COALESCE(gw.value->>'dashscopeApiKey', ''),
      'aliyunAccessKeyId', COALESCE(gw.value->>'aliyunAccessKeyId', ''),
      'aliyunAccessKeySecret', COALESCE(gw.value->>'aliyunAccessKeySecret', '')
    )
  ),
  false,
  '阿里云 AI 网关配置'
FROM system_config gw
WHERE gw.key = 'ai_gateway_config'
ON CONFLICT (name) DO NOTHING;

-- 如果 system_config 中不存在旧的 ai_gateway_config 记录，插入默认值
INSERT INTO provider_config (name, display_name, type, config, enabled, description) VALUES (
  'api_gateway',
  '阿里云AI网关',
  'AlibabaCloudAIGateway',
  '{
    "apiKeyPlaceholder": "${CONSUMER_API_KEY}",
    "domainPlaceholder": "${AI_GATEWAY_DOMAIN}",
    "parameters": {
      "regionId": "",
      "gatewayId": "",
      "httpApiId": "",
      "environmentId": "",
      "gatewayDomain": "",
      "dashscopeApiKey": "",
      "aliyunAccessKeyId": "",
      "aliyunAccessKeySecret": ""
    }
  }'::jsonb,
  false,
  '阿里云 AI 网关配置'
)
ON CONFLICT (name) DO NOTHING;

INSERT INTO provider_config (name, display_name, type, config, enabled, description)
VALUES ('litellm',
        'LiteLLM网关',
        'LiteLLM',
        '{"apiKeyPlaceholder": "${LITELLM_API_KEY}", "domainPlaceholder": "${LITELLM_PROXY_URL}"}'::jsonb,
        false,
        'LiteLLM Proxy 统一模型网关配置') ON CONFLICT (name) DO NOTHING;

-- =====================================================
-- 12. 清理 system_config 中已废弃的 Provider 记录
-- =====================================================

DELETE FROM system_config WHERE key = 'provider_config:bailian';
DELETE FROM system_config WHERE key = 'provider_config:api_gateway';
DELETE FROM system_config WHERE key = 'ai_gateway_config';


-- =====================================================
-- 13.  Migration: Add 'starting' and 'stopping' to agent_instances status CHECK constraint
-- This supports async instance creation where status='starting' is set immediately
-- and updated to 'running' after background health check passes.
-- =====================================================

ALTER TABLE agent_instances
DROP CONSTRAINT IF EXISTS openclaw_instances_status_check;


ALTER TABLE agent_instances
    ADD CONSTRAINT agent_instances_status_check
        CHECK (status IN ('running', 'stopped', 'error', 'starting', 'stopping', 'active', 'paused', 'disabled'));



-- =====================================================
-- 迁移完成
-- =====================================================
