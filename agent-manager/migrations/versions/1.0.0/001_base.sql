-- =====================================================
-- Agent 管理平台 - 完整数据库初始化脚本
-- 执行方式：在 Supabase SQL Editor 中直接运行
-- =====================================================

-- =====================================================
-- 1. 扩展和基础配置
-- =====================================================

-- 启用 UUID 扩展
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =====================================================
-- 2. 辅助函数 - 检查用户是否为管理员（避免 RLS 递归）
-- =====================================================

-- 重要：使用 SECURITY DEFINER 和 SET search_path 绕过 RLS 递归检查
CREATE OR REPLACE FUNCTION is_admin_check()
RETURNS BOOLEAN AS $$
DECLARE
  user_role TEXT;
BEGIN
  -- SECURITY DEFINER 允许函数绕过 RLS，避免递归
  SELECT role INTO user_role FROM user_profiles WHERE id = auth.uid();
  RETURN user_role = 'admin';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 兼容旧版本的别名函数
CREATE OR REPLACE FUNCTION is_admin(user_uuid UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN is_admin_check();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- =====================================================
-- 2b. 触发器函数 - 自动更新 updated_at（必须在建表/建触发器之前定义）
-- =====================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- 3. 用户资料表 (user_profiles)
-- =====================================================

CREATE TABLE IF NOT EXISTS user_profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username VARCHAR(100) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  role VARCHAR(20) NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  max_agent_instances INTEGER NOT NULL DEFAULT 5 CHECK (max_agent_instances >= 0),
  is_first_login BOOLEAN DEFAULT false,
  -- AI Gateway Consumer fields
  consumer_id VARCHAR(100),
  consumer_apikey_encrypted TEXT,
  -- 用户最后授权的 HTTP API ID，用于检测 Gateway 变更并触发重新授权
  authorized_http_api_id VARCHAR(200),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_user_profiles_email ON user_profiles(email);
CREATE INDEX IF NOT EXISTS idx_user_profiles_role ON user_profiles(role);
CREATE INDEX IF NOT EXISTS idx_user_profiles_status ON user_profiles(status);

-- 启用行级安全
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;

-- 策略：用户只能查看自己的资料
DROP POLICY IF EXISTS "Users can view own profile" ON user_profiles;
CREATE POLICY "Users can view own profile" ON user_profiles
  FOR SELECT USING (auth.uid() = id);

-- 策略：用户可以创建自己的资料
DROP POLICY IF EXISTS "Users can create own profile" ON user_profiles;
CREATE POLICY "Users can create own profile" ON user_profiles
  FOR INSERT WITH CHECK (auth.uid() = id);

-- 策略：用户可以更新自己的资料
DROP POLICY IF EXISTS "Users can update own profile" ON user_profiles;
CREATE POLICY "Users can update own profile" ON user_profiles
  FOR UPDATE USING (auth.uid() = id);

-- 策略：管理员可以查看所有资料（使用安全函数避免递归）
DROP POLICY IF EXISTS "Admins can view all profiles" ON user_profiles;
CREATE POLICY "Admins can view all profiles" ON user_profiles
  FOR SELECT USING (is_admin_check());

-- 策略：管理员可以更新所有资料
DROP POLICY IF EXISTS "Admins can update all profiles" ON user_profiles;
CREATE POLICY "Admins can update all profiles" ON user_profiles
  FOR UPDATE USING (is_admin_check());

-- 策略：管理员可以管理所有资料
DROP POLICY IF EXISTS "Admins can manage all profiles" ON user_profiles;
CREATE POLICY "Admins can manage all profiles" ON user_profiles
  FOR ALL USING (is_admin_check());

-- =====================================================
-- 4. Agent 类型表 (agent_types)
-- =====================================================

CREATE TABLE IF NOT EXISTS agent_types (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  code VARCHAR(50) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  icon VARCHAR(50) DEFAULT 'bot',
  category VARCHAR(20) NOT NULL DEFAULT 'builtin'
    CHECK (category IN ('builtin', 'custom')),
  sandbox_template_id VARCHAR(100),
  sandbox_timeout INTEGER DEFAULT 300,
  config_template JSONB DEFAULT '{}',
  config_write_path VARCHAR(255),
  startup_command TEXT,
  readiness_check JSONB DEFAULT '{}',
  supports_channels BOOLEAN DEFAULT false,
  sandbox_user VARCHAR(50) DEFAULT NULL,
  is_enabled BOOLEAN DEFAULT true,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_types_code ON agent_types(code);
CREATE INDEX IF NOT EXISTS idx_agent_types_category ON agent_types(category);
CREATE INDEX IF NOT EXISTS idx_agent_types_enabled ON agent_types(is_enabled);

ALTER TABLE agent_types ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can view enabled agent types" ON agent_types;
CREATE POLICY "Anyone can view enabled agent types" ON agent_types
  FOR SELECT USING (is_enabled = true);

DROP POLICY IF EXISTS "Admins can manage agent types" ON agent_types;
CREATE POLICY "Admins can manage agent types" ON agent_types
  FOR ALL USING (is_admin_check());

DROP TRIGGER IF EXISTS set_agent_types_updated_at ON agent_types;
CREATE TRIGGER set_agent_types_updated_at
  BEFORE UPDATE ON agent_types
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- 5. AI 模型配置表 (ai_models)
-- =====================================================

CREATE TABLE IF NOT EXISTS ai_models (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  provider VARCHAR(50) NOT NULL,
  model_code VARCHAR(100) NOT NULL,
  description TEXT,
  is_enabled BOOLEAN DEFAULT true,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (model_code, provider)
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_ai_models_provider ON ai_models(provider);
CREATE INDEX IF NOT EXISTS idx_ai_models_status ON ai_models(status);
CREATE INDEX IF NOT EXISTS idx_ai_models_enabled ON ai_models(is_enabled);

-- 启用行级安全
ALTER TABLE ai_models ENABLE ROW LEVEL SECURITY;

-- 策略：所有用户都可以查看启用的模型
DROP POLICY IF EXISTS "Users can view enabled models" ON ai_models;
CREATE POLICY "Users can view enabled models" ON ai_models
  FOR SELECT USING (ai_models.is_enabled = true);

-- 策略：所有用户都可以查看启用的模型（通过status）
DROP POLICY IF EXISTS "Users can view active models" ON ai_models;
CREATE POLICY "Users can view active models" ON ai_models
  FOR SELECT USING (ai_models.status = 'active');

-- 策略：管理员可以查看所有模型
DROP POLICY IF EXISTS "Admins can view all models" ON ai_models;
CREATE POLICY "Admins can view all models" ON ai_models
  FOR SELECT USING (is_admin(auth.uid()));

-- 策略：管理员可以管理模型
DROP POLICY IF EXISTS "Admins can manage models" ON ai_models;
CREATE POLICY "Admins can manage models" ON ai_models
  FOR ALL USING (is_admin(auth.uid()));

-- 策略：管理员可以管理所有模型
DROP POLICY IF EXISTS "Admins can manage all models" ON ai_models;
CREATE POLICY "Admins can manage all models" ON ai_models
  FOR ALL USING (is_admin(auth.uid()));

-- =====================================================
-- 6. Agent 实例表 (agent_instances)
-- =====================================================

CREATE TABLE IF NOT EXISTS agent_instances (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  agent_type_id UUID REFERENCES agent_types(id) ON DELETE SET NULL,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  model_id UUID REFERENCES ai_models(id) ON DELETE SET NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'stopped' CHECK (status IN ('running', 'stopped', 'error', 'active', 'paused', 'disabled')),
  config_json JSONB DEFAULT '{}',
  sandbox_id VARCHAR(255),
  token VARCHAR(512),
  last_activity_at TIMESTAMPTZ,
  last_active_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_agent_instances_user_id ON agent_instances(user_id);
CREATE INDEX IF NOT EXISTS idx_agent_instances_model_id ON agent_instances(model_id);
CREATE INDEX IF NOT EXISTS idx_agent_instances_sandbox_id ON agent_instances(sandbox_id);
CREATE INDEX IF NOT EXISTS idx_agent_instances_status ON agent_instances(status);
CREATE INDEX IF NOT EXISTS idx_agent_instances_type ON agent_instances(agent_type_id);

-- 启用行级安全
ALTER TABLE agent_instances ENABLE ROW LEVEL SECURITY;

-- 策略：用户可以查看自己的实例
DROP POLICY IF EXISTS "Users can view own instances" ON agent_instances;
CREATE POLICY "Users can view own instances" ON agent_instances
  FOR SELECT USING (auth.uid() = user_id);

-- 策略：用户可以创建自己的实例
DROP POLICY IF EXISTS "Users can create instances" ON agent_instances;
CREATE POLICY "Users can create instances" ON agent_instances
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- 策略：用户可以更新自己的实例
DROP POLICY IF EXISTS "Users can update own instances" ON agent_instances;
CREATE POLICY "Users can update own instances" ON agent_instances
  FOR UPDATE USING (auth.uid() = user_id);

-- 策略：用户可以删除自己的实例
DROP POLICY IF EXISTS "Users can delete own instances" ON agent_instances;
CREATE POLICY "Users can delete own instances" ON agent_instances
  FOR DELETE USING (auth.uid() = user_id);

-- 策略：用户可以管理自己的实例
DROP POLICY IF EXISTS "Users can manage own instances" ON agent_instances;
CREATE POLICY "Users can manage own instances" ON agent_instances
  FOR ALL USING (user_id = auth.uid());

-- 策略：管理员可以查看所有实例
DROP POLICY IF EXISTS "Admins can view all instances" ON agent_instances;
CREATE POLICY "Admins can view all instances" ON agent_instances
  FOR SELECT USING (is_admin(auth.uid()));

-- 策略：管理员可以管理所有实例
DROP POLICY IF EXISTS "Admins can manage all instances" ON agent_instances;
CREATE POLICY "Admins can manage all instances" ON agent_instances
  FOR ALL USING (is_admin(auth.uid()));

-- 为所有表添加 updated_at 触发器
DROP TRIGGER IF EXISTS set_updated_at ON user_profiles;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON user_profiles
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_user_profiles_updated_at ON user_profiles;
CREATE TRIGGER set_user_profiles_updated_at
  BEFORE UPDATE ON user_profiles
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_updated_at ON ai_models;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON ai_models
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_ai_models_updated_at ON ai_models;
CREATE TRIGGER set_ai_models_updated_at
  BEFORE UPDATE ON ai_models
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

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
-- 8. 辅助函数 - 创建用户资料（配合 Auth 使用）
-- =====================================================

CREATE OR REPLACE FUNCTION create_user_profile()
RETURNS TRIGGER AS $$
DECLARE
  extracted_username VARCHAR(100);
BEGIN
  -- 从多种来源提取用户名（支持 OAuth 登录）
  -- 优先级: username > preferred_username (GitHub) > user_name > name > email
  extracted_username := COALESCE(
    NEW.raw_user_meta_data->>'username',
    NEW.raw_user_meta_data->>'preferred_username',  -- GitHub username
    NEW.raw_user_meta_data->>'user_name',
    NEW.raw_user_meta_data->>'name',
    NEW.raw_user_meta_data->>'full_name',
    SPLIT_PART(NEW.email, '@', 1)  -- 从邮箱提取用户名
  );

  INSERT INTO user_profiles (id, username, email, role, status)
  VALUES (
    NEW.id,
    extracted_username,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'role', 'user'),
    COALESCE(NEW.raw_user_meta_data->>'status', 'active')
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    -- Log error but don't fail the user creation
    RAISE WARNING 'Failed to create user profile for %: %', NEW.id, SQLERRM;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 创建触发器：新用户注册时自动创建资料
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION create_user_profile();

-- =====================================================
-- 9. 渠道模板配置表 (channel_templates)
-- 管理员定义支持的渠道类型和所需字段
-- =====================================================

CREATE TABLE IF NOT EXISTS channel_templates (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  channel_type VARCHAR(50) NOT NULL CHECK (channel_type IN ('feishu', 'dingtalk', 'qq', 'wecom')),
  agent_type_id UUID REFERENCES agent_types(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  config_fields JSONB NOT NULL DEFAULT '[
    {"name": "clientId", "label": "Client ID", "type": "text", "required": true},
    {"name": "clientSecret", "label": "Client Secret", "type": "password", "required": true}
  ]',
  config_file TEXT,
  config_template JSONB DEFAULT '{}',
  is_enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(channel_type, agent_type_id)
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_channel_templates_type ON channel_templates(channel_type);
CREATE INDEX IF NOT EXISTS idx_channel_templates_enabled ON channel_templates(is_enabled);
CREATE INDEX IF NOT EXISTS idx_channel_templates_agent_type ON channel_templates(agent_type_id);

-- 启用行级安全
ALTER TABLE channel_templates ENABLE ROW LEVEL SECURITY;

-- 策略：所有用户都可以查看启用的渠道模板
DROP POLICY IF EXISTS "Users can view enabled channel templates" ON channel_templates;
CREATE POLICY "Users can view enabled channel templates" ON channel_templates
  FOR SELECT USING (channel_templates.is_enabled = true);

-- 策略：管理员可以管理渠道模板
DROP POLICY IF EXISTS "Admins can manage channel templates" ON channel_templates;
CREATE POLICY "Admins can manage channel templates" ON channel_templates
  FOR ALL USING (is_admin(auth.uid()));

-- 触发器：自动更新 updated_at
DROP TRIGGER IF EXISTS set_channel_templates_updated_at ON channel_templates;
CREATE TRIGGER set_channel_templates_updated_at
  BEFORE UPDATE ON channel_templates
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- 10. 实例渠道配置表 (instance_channel_configs)
-- 用户为实例配置的渠道信息
-- =====================================================

CREATE TABLE IF NOT EXISTS instance_channel_configs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  instance_id UUID NOT NULL REFERENCES agent_instances(id) ON DELETE CASCADE,
  channel_type VARCHAR(50) NOT NULL CHECK (channel_type IN ('feishu', 'dingtalk', 'qq', 'wecom')),
  client_id VARCHAR(255) NOT NULL,
  client_secret VARCHAR(255) NOT NULL,
  config_json JSONB DEFAULT '{}',
  is_configured BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(instance_id)
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_instance_channel_instance_id ON instance_channel_configs(instance_id);
CREATE INDEX IF NOT EXISTS idx_instance_channel_type ON instance_channel_configs(channel_type);

-- 启用行级安全
ALTER TABLE instance_channel_configs ENABLE ROW LEVEL SECURITY;

-- 策略：用户可以查看自己的实例渠道配置
DROP POLICY IF EXISTS "Users can view own instance channel configs" ON instance_channel_configs;
CREATE POLICY "Users can view own instance channel configs" ON instance_channel_configs
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM agent_instances
      WHERE agent_instances.id = instance_channel_configs.instance_id
      AND agent_instances.user_id = auth.uid()
    )
  );

-- 策略：用户可以管理自己的实例渠道配置
DROP POLICY IF EXISTS "Users can manage own instance channel configs" ON instance_channel_configs;
CREATE POLICY "Users can manage own instance channel configs" ON instance_channel_configs
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM agent_instances
      WHERE agent_instances.id = instance_channel_configs.instance_id
      AND agent_instances.user_id = auth.uid()
    )
  );

-- 策略：管理员可以查看所有实例渠道配置
DROP POLICY IF EXISTS "Admins can view all instance channel configs" ON instance_channel_configs;
CREATE POLICY "Admins can view all instance channel configs" ON instance_channel_configs
  FOR SELECT USING (is_admin(auth.uid()));

-- 触发器：自动更新 updated_at
DROP TRIGGER IF EXISTS set_instance_channel_configs_updated_at ON instance_channel_configs;
CREATE TRIGGER set_instance_channel_configs_updated_at
  BEFORE UPDATE ON instance_channel_configs
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- 11. 初始化数据
-- =====================================================

-- =====================================================
-- 11. 系统配置表 (system_config)
-- 存储全局配置，如 Provider、AI 网关等
-- 11. Provider 配置表 (provider_config)
-- 存储各种 Provider 的配置信息
-- =====================================================

CREATE TABLE IF NOT EXISTS provider_config (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  display_name VARCHAR(200),  -- 显示名称
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
-- 12. 系统配置表 (system_config)
-- 存储全局配置
-- Key-Value 结构，value 为 JSONB
-- =====================================================

CREATE TABLE IF NOT EXISTS system_config (
  key VARCHAR(100) PRIMARY KEY,
  value JSONB NOT NULL DEFAULT 'null',
  description TEXT,
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 启用行级安全
ALTER TABLE system_config ENABLE ROW LEVEL SECURITY;

-- 策略：管理员可以读写所有配置
DROP POLICY IF EXISTS "Admins can manage system config" ON system_config;
CREATE POLICY "Admins can manage system config" ON system_config
  FOR ALL USING (is_admin(auth.uid()));

-- =====================================================
-- 13. 初始化数据
-- =====================================================

-- 插入默认 Provider 配置
INSERT INTO provider_config (name, display_name, type, config, enabled, description) VALUES (
  'bailian',
  '百炼',
  'API',
  '{"apiKey": "", "apiKeyPlaceholder": "${DASHSCOPE_API_KEY}", "domain": "", "domainPlaceholder": "${DASHSCOPE_API_DOMAIN}"}'::jsonb,
  true,
  '百炼 API Provider 配置'
)
ON CONFLICT (name) DO NOTHING;

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


-- 插入默认 AI 模型
INSERT INTO ai_models (name, provider, model_code, status, description, is_enabled) VALUES
  ('qwen3.5-plus', 'bailian', 'qwen3.5-plus', 'active', '通义千问 Qwen3.5-plus 大语言模型，综合能力强', true)
ON CONFLICT (model_code, provider) DO NOTHING;

-- 插入内置 Agent 类型种子数据
-- OpenClaw
INSERT INTO agent_types (code, name, description, icon, category, sandbox_template_id, sandbox_timeout, config_template, config_write_path, readiness_check, supports_channels, sandbox_user, sort_order) VALUES
  ('openclaw', 'OpenClaw', '基于 OpenClaw 框架的 AI Agent，支持多模型、渠道集成和 Gateway 控制', 'claw', 'builtin', 'openclaw', 300,
   '{"agents":{"defaults":{"model":{"primary":"${MODEL_PROVIDER}/${MODEL_NAME}"},"workspace":"/home/node/.openclaw/workspace"}},"models":{"mode":"merge","providers":{"bailian":{"baseUrl":"https://dashscope.aliyuncs.com/compatible-mode/v1","apiKey":"${DASHSCOPE_API_KEY}","api":"openai-completions","models":[]},"api_gateway":{"baseUrl":"http://${AI_GATEWAY_DOMAIN}/v1","apiKey":"${CONSUMER_API_KEY}","api":"openai-completions","models":[]}}},"commands":{"native":"auto","nativeSkills":"auto","restart":true,"ownerDisplay":"raw"},"gateway":{"port":18789,"bind":"lan","controlUi":{"allowedOrigins":["*"],"dangerouslyAllowHostHeaderOriginFallback":true,"allowInsecureAuth":true,"dangerouslyDisableDeviceAuth":true},"auth":{"mode":"token","token":"${GATEWAY_TOKEN}"}},"channels":{}}'::jsonb,
   '/home/node/.openclaw/openclaw.json', '{"type":"http","port":18789,"path":"/health","timeout":120}'::jsonb, true, 'node', 1)
ON CONFLICT (code) DO UPDATE SET
  config_template = EXCLUDED.config_template,
  config_write_path = EXCLUDED.config_write_path,
  startup_command = EXCLUDED.startup_command,
  readiness_check = EXCLUDED.readiness_check,
  supports_channels = EXCLUDED.supports_channels,
  sandbox_user = EXCLUDED.sandbox_user;

-- Hermes
INSERT INTO agent_types (code, name, description, icon, category, sandbox_template_id, sandbox_timeout, config_template, config_write_path, startup_command, readiness_check, supports_channels, sandbox_user, sort_order)
VALUES (
  'hermes',
  'Hermes',
  '基于 Hermes 框架的 AI Agent，支持终端操作、记忆和压缩等高级功能',
  'message-circle',
  'builtin',
  'hermes',
  300,
  jsonb_build_object('_format', 'yaml', '_content', 'model:
  default: ${MODEL_NAME}
  provider: alibaba
  base_url: https://dashscope.aliyuncs.com/compatible-mode/v1
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

# 延迟 2 秒后发送 kill 信号，让 bash 先退出
(sleep 2 && kill $(pgrep -f "hermes gateway") 2>/dev/null) &
disown',
  '{"type":"tcp","port":9119,"timeout":120}'::jsonb,
  true,
  'root',
  2
)
ON CONFLICT (code) DO UPDATE SET
  config_template = EXCLUDED.config_template,
  config_write_path = EXCLUDED.config_write_path,
  startup_command = EXCLUDED.startup_command,
  readiness_check = EXCLUDED.readiness_check,
  supports_channels = EXCLUDED.supports_channels,
  sandbox_user = EXCLUDED.sandbox_user;

-- 插入 OpenClaw 类型的默认渠道模板（必须在 agent_types 插入之后，子查询才能获取到 agent_type_id）
INSERT INTO channel_templates (channel_type, name, description, config_fields, config_file, config_template, is_enabled, agent_type_id) VALUES
  ('feishu', '飞书 (Feishu)', '飞书开放平台应用配置',
    '[{"name": "clientId", "type": "text", "label": "App ID", "required": true, "placeholder": "cli_xxxxxxxxxxxxxxxx"}, {"name": "clientSecret", "type": "password", "label": "App Secret", "required": true, "placeholder": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}]',
    'feishu-channel.json',
    '{"feishu": {"appId": "${CHANNEL_CLIENT_ID}", "domain": "feishu", "enabled": true, "dmPolicy": "open", "appSecret": "${CHANNEL_CLIENT_SECRET}", "groupPolicy": "open", "connectionMode": "websocket", "requireMention": true}}'::jsonb,
    true, (SELECT id FROM agent_types WHERE code = 'openclaw')),
  ('dingtalk', '钉钉 (DingTalk)', '钉钉开放平台应用配置',
    '[{"name": "clientId", "type": "text", "label": "Client ID (AppKey)", "required": true, "placeholder": "dingxxxxxxxxxxxxxxxx"}, {"name": "clientSecret", "type": "password", "label": "Client Secret (AppSecret)", "required": true, "placeholder": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}]',
    'dingtalk-channel.json',
    '{"dingtalk-connector": {"ackText": "任务已接收", "enabled": true, "clientId": "${CHANNEL_CLIENT_ID}", "clientSecret": "${CHANNEL_CLIENT_SECRET}", "gatewayToken": "${GATEWAY_TOKEN}", "gatewayPassword": "", "groupSessionScope": "group", "separateSessionByConversation": true, "sharedMemoryAcrossConversations": false}}'::jsonb,
    true, (SELECT id FROM agent_types WHERE code = 'openclaw')),
  ('wecom', '企业微信 (WeCom)', '企业微信应用配置',
    '[{"name": "clientId", "type": "text", "label": "CorpID", "required": true, "placeholder": "wwxxxxxxxxxxxxxxxx"}, {"name": "clientSecret", "type": "password", "label": "Secret", "required": true, "placeholder": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}]',
    'wecom-channel.json',
    '{"wecom": {"dm": {"policy": "open"}, "botId": "${CHANNEL_CLIENT_ID}", "secret": "${CHANNEL_CLIENT_SECRET}", "enabled": true, "welcomeText": "你好！我是 AI 助手", "connectionMode": "websocket", "streamPlaceholderContent": "正在思考..."}}'::jsonb,
    true, (SELECT id FROM agent_types WHERE code = 'openclaw')),
  ('qq', 'QQ', 'QQ机器人配置',
    '[{"name": "clientId", "type": "text", "label": "App ID", "required": true, "placeholder": "123456789"}, {"name": "clientSecret", "type": "password", "label": "App Secret", "required": true, "placeholder": "xxxxxxxxxxxxxxxx"}]',
    'qq-channel.json',
    '{"qqbot": {"appId": "${CHANNEL_CLIENT_ID}", "enabled": true, "clientSecret": "${CHANNEL_CLIENT_SECRET}"}}'::jsonb,
    true, (SELECT id FROM agent_types WHERE code = 'openclaw'))
ON CONFLICT (channel_type, agent_type_id) DO UPDATE SET
  config_template = EXCLUDED.config_template,
  config_fields = EXCLUDED.config_fields,
  config_file = EXCLUDED.config_file;

-- 插入 Hermes 类型的钉钉渠道模板
INSERT INTO channel_templates (channel_type, name, description, config_fields, config_file, config_template, is_enabled, agent_type_id) VALUES
  ('dingtalk', '钉钉 (DingTalk)', '钉钉开放平台应用配置',
    '[{"name": "clientId", "type": "text", "label": "Client ID (AppKey)", "required": true, "placeholder": "dingxxxxxxxxxxxxxxxx"}, {"name": "clientSecret", "type": "password", "label": "Client Secret (AppSecret)", "required": true, "placeholder": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}]',
    NULL,
    '{"_format": "yaml", "_content": "gateway:\n  dingtalk:\n    enabled: true"}'::jsonb,
    true, (SELECT id FROM agent_types WHERE code = 'hermes'))
ON CONFLICT (channel_type, agent_type_id) DO UPDATE SET
  config_template = EXCLUDED.config_template,
  config_fields = EXCLUDED.config_fields;


-- 注意：AI Gateway 配置已迁移到 provider_config 表，以 'api_gateway' 名称存储

-- =====================================================
-- 10. 管理员账号初始化说明
-- =====================================================

-- 注意：管理员账号需要在 Supabase Auth 中手动创建后，执行以下 SQL：
-- 1. 在 Supabase Dashboard > Authentication > Users 中创建用户 admin@openclaw.local
-- 2. 设置密码为 admin123
-- 3. 获取该用户的 UUID
-- 4. 执行以下 SQL（替换 YOUR_ADMIN_UUID 为实际 UUID）

-- 示例（执行前请替换 UUID）：
/*
INSERT INTO user_profiles (id, username, email, role, status, max_agent_instances)
VALUES ('YOUR_ADMIN_UUID', 'Admin', 'admin@openclaw.local', 'admin', 'active', 999);
*/

-- 或者使用以下函数自动创建/更新管理员资料：
CREATE OR REPLACE FUNCTION create_or_update_admin_profile()
RETURNS VOID AS $$
DECLARE
  admin_user_id UUID;
BEGIN
  -- 从 auth.users 中查找管理员账号
  SELECT id INTO admin_user_id 
  FROM auth.users 
  WHERE email = 'admin@openclaw.local';
  
  -- 如果找到用户，创建或更新用户资料
  IF admin_user_id IS NOT NULL THEN
    INSERT INTO user_profiles (
      id,
      username,
      email,
      role,
      status,
      max_agent_instances,
      is_first_login
    ) VALUES (
      admin_user_id,
      'Admin',
      'admin@openclaw.local',
      'admin',
      'active',
      999,
      true
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

-- 执行创建/更新管理员资料
-- SELECT create_or_update_admin_profile();

-- =====================================================
-- 初始化完成
-- =====================================================
