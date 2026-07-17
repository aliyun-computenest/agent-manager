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
-- 2. 触发器函数 - 自动更新 updated_at（必须在建表/建触发器之前定义）
-- =====================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- 3. 用户资料表 (principal_profiles)
-- =====================================================

CREATE TABLE IF NOT EXISTS principal_profiles (
  id UUID PRIMARY KEY,
  principal_type VARCHAR(20) NOT NULL DEFAULT 'user' CHECK (principal_type IN ('user', 'group')),
  name VARCHAR(100),
  email VARCHAR(255),
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
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT principal_profiles_required_fields_by_type_check CHECK (
    (principal_type = 'user' AND name IS NOT NULL AND email IS NOT NULL)
    OR (principal_type = 'group' AND name IS NOT NULL AND role = 'user')
  )
);

COMMENT ON COLUMN principal_profiles.email IS
  '仅 user principal 使用并要求唯一；group principal 不使用 email。';
COMMENT ON COLUMN principal_profiles.role IS
  '仅 user principal 用于平台权限；group principal 固定为 user 占位，分组角色存放在 agent_group_members.role。';

-- 创建索引
CREATE UNIQUE INDEX IF NOT EXISTS idx_principal_profiles_user_email_unique
  ON principal_profiles(email)
  WHERE principal_type = 'user';
CREATE INDEX IF NOT EXISTS idx_principal_profiles_role ON principal_profiles(role);
CREATE INDEX IF NOT EXISTS idx_principal_profiles_status ON principal_profiles(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_principal_profiles_group_name
  ON principal_profiles(lower(name))
  WHERE principal_type = 'group';
CREATE INDEX IF NOT EXISTS idx_principal_profiles_type_created
  ON principal_profiles(principal_type, created_at DESC, id);

-- =====================================================
-- 3a. 辅助函数 - 检查用户是否为管理员（避免 RLS 递归）
-- =====================================================

-- 重要：使用 SECURITY DEFINER 和 SET search_path 绕过 RLS 递归检查，并只认可 active admin。
CREATE OR REPLACE FUNCTION is_admin_check()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
    FROM principal_profiles
    WHERE id = auth.uid()
      AND principal_type = 'user'
      AND role = 'admin'
      AND status = 'active'
  );
$$ LANGUAGE SQL SECURITY DEFINER STABLE SET search_path = public;

-- 当前 baseline 仍有多处 admin policy 调用 is_admin(auth.uid())；
-- 保留这个入口，但按传入 user principal 判断，避免函数名误导调用方。
CREATE OR REPLACE FUNCTION is_admin(user_uuid UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
    FROM principal_profiles
    WHERE id = user_uuid
      AND principal_type = 'user'
      AND role = 'admin'
      AND status = 'active'
  );
$$ LANGUAGE SQL SECURITY DEFINER STABLE SET search_path = public;

-- 启用行级安全
ALTER TABLE principal_profiles ENABLE ROW LEVEL SECURITY;

-- 策略：用户只能查看自己的资料
CREATE POLICY "Users can view own profile" ON principal_profiles
  FOR SELECT USING (principal_type = 'user' AND auth.uid() = id);

-- 策略：用户可以创建自己的资料
CREATE POLICY "Users can create own profile" ON principal_profiles
  FOR INSERT WITH CHECK (
    principal_type = 'user'
    AND auth.uid() = id
    AND role = 'user'
    AND status = 'active'
    AND max_agent_instances = 5
    AND consumer_id IS NULL
    AND consumer_apikey_encrypted IS NULL
    AND authorized_http_api_id IS NULL
  );

-- 策略：用户可以更新自己的资料
-- WITH CHECK 锁 id 列；列级越权防护由下面的 BEFORE UPDATE 触发器兜底。
CREATE POLICY "Users can update own profile" ON principal_profiles
  FOR UPDATE USING (principal_type = 'user' AND auth.uid() = id)
  WITH CHECK (principal_type = 'user' AND auth.uid() = id);

-- 策略：管理员可以查看所有资料（使用安全函数避免递归）
CREATE POLICY "Admins can view all profiles" ON principal_profiles
  FOR SELECT USING (is_admin_check());

-- 策略：管理员可以更新所有资料
CREATE POLICY "Admins can update all profiles" ON principal_profiles
  FOR UPDATE USING (is_admin_check());

-- 策略：管理员可以管理所有资料
CREATE POLICY "Admins can manage all profiles" ON principal_profiles
  FOR ALL USING (is_admin_check());

-- =====================================================
-- 3b. 列级越权防护（基线中直接使用 principal_profiles 命名）
-- =====================================================
-- 阻止非 admin 通过 PostgREST 直接 PATCH 自己的 principal_profiles 行来提权
-- （role/status/max_agent_instances/consumer_*/authorized_http_api_id/id/email）。
-- service_role 与 admin 保留全权限。
CREATE OR REPLACE FUNCTION principal_profiles_protect_privileged_columns()
RETURNS TRIGGER AS $$
BEGIN
  -- service_role / 服务端连接没有 auth.uid()，直接放行。
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  -- admin 仍然保留全权限。
  IF is_admin_check() THEN
    RETURN NEW;
  END IF;

  IF NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION 'principal_profiles.role can only be changed by an admin'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'principal_profiles.status can only be changed by an admin'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.max_agent_instances IS DISTINCT FROM OLD.max_agent_instances THEN
    RAISE EXCEPTION 'principal_profiles.max_agent_instances can only be changed by an admin'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.consumer_id IS DISTINCT FROM OLD.consumer_id THEN
    RAISE EXCEPTION 'principal_profiles.consumer_id is system-managed'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.consumer_apikey_encrypted IS DISTINCT FROM OLD.consumer_apikey_encrypted THEN
    RAISE EXCEPTION 'principal_profiles.consumer_apikey_encrypted is system-managed'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.authorized_http_api_id IS DISTINCT FROM OLD.authorized_http_api_id THEN
    RAISE EXCEPTION 'principal_profiles.authorized_http_api_id is system-managed'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'principal_profiles.id is immutable'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.email IS DISTINCT FROM OLD.email THEN
    RAISE EXCEPTION 'principal_profiles.email is system-managed'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
CREATE TRIGGER protect_principal_profiles_privileged_columns
  BEFORE UPDATE ON principal_profiles
  FOR EACH ROW
  EXECUTE FUNCTION principal_profiles_protect_privileged_columns();

-- =====================================================
-- 3c. Group sharing (versions/1.0.5)
-- =====================================================

CREATE TABLE IF NOT EXISTS agent_group_members (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  group_id UUID NOT NULL REFERENCES principal_profiles(id) ON DELETE CASCADE,
  principal_id UUID NOT NULL REFERENCES principal_profiles(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(group_id, principal_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_group_members_principal_status
  ON agent_group_members(principal_id, status, group_id);

CREATE INDEX IF NOT EXISTS idx_agent_group_members_group_status_role
  ON agent_group_members(group_id, status, role);


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
  modify_model_command   TEXT DEFAULT NULL,
  modify_channel_command TEXT DEFAULT NULL,
  readiness_check JSONB DEFAULT '{}',
  upgrade_metadata JSONB DEFAULT '{}',
  supports_channels BOOLEAN DEFAULT false,
  supports_env_vars BOOLEAN DEFAULT false,
  supports_skills BOOLEAN DEFAULT true,
  skill_path VARCHAR(512) NOT NULL DEFAULT '/home/node/.agents/skills',
  user_terminal_enabled BOOLEAN NOT NULL DEFAULT false,
  sandbox_user VARCHAR(50) DEFAULT NULL,
  terminal_user VARCHAR(50) NOT NULL DEFAULT 'node',
  is_enabled BOOLEAN DEFAULT true,
  sort_order INTEGER DEFAULT 0,
  skill_config JSONB DEFAULT NULL,
  custom_vars_schema JSONB DEFAULT NULL,
  observability_env JSONB DEFAULT '{}'::jsonb,
  observability_enabled BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE agent_types
  ADD COLUMN IF NOT EXISTS upgrade_metadata JSONB DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_agent_types_code ON agent_types(code);
CREATE INDEX IF NOT EXISTS idx_agent_types_category ON agent_types(category);
CREATE INDEX IF NOT EXISTS idx_agent_types_enabled ON agent_types(is_enabled);

ALTER TABLE agent_types ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can view enabled agent types" ON agent_types
  FOR SELECT USING (is_enabled = true);
CREATE POLICY "Admins can manage agent types" ON agent_types
  FOR ALL USING (is_admin_check());
CREATE TRIGGER set_agent_types_updated_at
  BEFORE UPDATE ON agent_types
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- 字段注释：增量修改脚本
-- 背景：修改模型/渠道时不再整体覆盖配置文件（避免覆盖用户的自定义内容），
-- 改为执行管理员在 Agent 配置中定义的局部修改脚本。
-- 当字段为空/NULL 时：
--   - 前端禁用模型/渠道修改入口
--   - 后端拒绝对应字段的修改请求
COMMENT ON COLUMN agent_types.modify_model_command IS
  '修改模型的 shell 命令（支持 ${MODEL_NAME}、${MODEL_PROVIDER}、${MODEL_BASE_URL}、${CONSUMER_API_KEY}、${AI_GATEWAY_DOMAIN} 等占位符）；为空表示不支持在线修改模型';

COMMENT ON COLUMN agent_types.modify_channel_command IS
  '修改渠道的 shell 命令（支持 ${CHANNEL_TYPE}、${CHANNEL_CLIENT_ID}、${CHANNEL_CLIENT_SECRET}、${CHANNEL_CONFIG_JSON} 等占位符）；为空表示不支持在线修改渠道';

COMMENT ON COLUMN agent_types.upgrade_metadata IS
  'Agent-level Sandbox upgrade configuration: hook commands, timeoutSeconds, and selector defaults.';

COMMENT ON COLUMN agent_types.skill_config IS
  'CSI volume mount config for skills. Format: [{"pvName":"","mountPath":"","subPath":""}]. pvName auto-filled from VITE_OSS_PV_NAME at sandbox creation.';

COMMENT ON COLUMN agent_types.supports_skills IS
  '是否支持技能配置（包含技能挂载与 SkillHub 引导）。前端依据该字段控制技能 Tab、技能配置卡片是否展示。';

COMMENT ON COLUMN agent_types.skill_path IS
  'Agent 在线安装 Skill 的根目录；必须是 Agent 运行时实际扫描的绝对路径。';

COMMENT ON COLUMN agent_types.user_terminal_enabled IS
  '普通用户是否可在实例详情页打开该 Agent 的浏览器终端；管理员排障入口不受此开关限制。';

COMMENT ON COLUMN agent_types.terminal_user IS
  '浏览器终端创建 PTY 时使用的系统用户；默认 node，避免用户侧终端获得 root 权限。';

COMMENT ON COLUMN agent_types.custom_vars_schema IS
  '自定义变量定义数组。格式: [{"name":"MY_VAR","label":"我的变量","type":"text|password|textarea","required":true,"placeholder":"请输入...","description":"变量用途说明"}]。用户创建实例时按此定义填写值，运行时通过 ${MY_VAR} 占位符注入到启动命令和配置模板中。';

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
CREATE POLICY "Users can view enabled models" ON ai_models
  FOR SELECT USING (ai_models.is_enabled = true);

-- 策略：所有用户都可以查看启用的模型（通过status）
CREATE POLICY "Users can view active models" ON ai_models
  FOR SELECT USING (ai_models.status = 'active');

-- 策略：管理员可以查看所有模型
CREATE POLICY "Admins can view all models" ON ai_models
  FOR SELECT USING (is_admin(auth.uid()));

-- 策略：管理员可以管理模型
CREATE POLICY "Admins can manage models" ON ai_models
  FOR ALL USING (is_admin(auth.uid()));

-- 策略：管理员可以管理所有模型
CREATE POLICY "Admins can manage all models" ON ai_models
  FOR ALL USING (is_admin(auth.uid()));

-- =====================================================
-- 6. Agent 实例表 (agent_instances)
-- =====================================================

CREATE TABLE IF NOT EXISTS agent_instances (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  -- 实例归属主体，指向 principal_profiles；私有实例为用户 principal，分组实例为 group principal。
  principal_id UUID NOT NULL REFERENCES principal_profiles(id) ON DELETE RESTRICT,
  agent_type_id UUID REFERENCES agent_types(id) ON DELETE SET NULL,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  model_id UUID REFERENCES ai_models(id) ON DELETE SET NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'stopped' CHECK (status IN ('running', 'stopped', 'error', 'starting', 'stopping', 'active', 'paused', 'disabled')),
  config_json JSONB DEFAULT '{}',
  sandbox_id VARCHAR(255),
  agent_image VARCHAR(500),
  backup_enabled BOOLEAN NOT NULL DEFAULT false,
  token VARCHAR(512),
  last_activity_at TIMESTAMPTZ,
  last_active_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE agent_instances
  ADD COLUMN IF NOT EXISTS backup_enabled BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE agent_instances
  ADD COLUMN IF NOT EXISTS skill_config JSONB DEFAULT NULL;

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_agent_instances_model_id ON agent_instances(model_id);
CREATE INDEX IF NOT EXISTS idx_agent_instances_sandbox_id ON agent_instances(sandbox_id);
CREATE INDEX IF NOT EXISTS idx_agent_instances_status ON agent_instances(status);
CREATE INDEX IF NOT EXISTS idx_agent_instances_type ON agent_instances(agent_type_id);
CREATE INDEX IF NOT EXISTS idx_agent_instances_principal_created
  ON agent_instances(principal_id, created_at DESC, id);

COMMENT ON COLUMN agent_instances.backup_enabled IS
  'Whether this instance was created with backup CSI metadata and can participate in backup-based upgrades.';
COMMENT ON COLUMN agent_instances.principal_id IS
  '实例归属主体：私有实例为 user principal，分组实例为 group principal。';

COMMENT ON COLUMN agent_instances.skill_config IS
  '实例创建时客户选择的技能挂载快照。与 agent_types.skill_config 字段结构一致（pvName/mountPath/subPath/isRequired/skillSpaceId）；NULL 表示旧实例（功能上线前创建），[]（空数组）表示新实例无技能配置';


-- Principal-based access helpers (versions/1.0.5)
-- is_platform_admin(uuid)
-- 判断某个 principal 是否为"激活中的 admin"。
CREATE OR REPLACE FUNCTION is_platform_admin(principal_uuid UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
    FROM principal_profiles
    WHERE id = principal_uuid
      AND principal_type = 'user'
      AND role = 'admin'
      AND status = 'active'
  );
$$ LANGUAGE SQL SECURITY DEFINER STABLE SET search_path = public;

-- is_active_group_member(uuid, uuid)
-- 判断用户 principal 是否为某个 group 的 active 成员。
CREATE OR REPLACE FUNCTION is_active_group_member(group_uuid UUID, principal_uuid UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
    FROM agent_group_members agm
    JOIN principal_profiles g
      ON g.id = agm.group_id
     AND g.principal_type = 'group'
    WHERE agm.group_id = group_uuid
      AND agm.principal_id = principal_uuid
      AND agm.status = 'active'
  );
$$ LANGUAGE SQL SECURITY DEFINER STABLE SET search_path = public;

-- has_group_role(uuid, uuid, text[])
-- 判断用户在某分组里是否具备 allowed_roles 中的某个角色（admin/member）。
CREATE OR REPLACE FUNCTION has_group_role(group_uuid UUID, principal_uuid UUID, allowed_roles TEXT[])
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
    FROM agent_group_members agm
    JOIN principal_profiles g
      ON g.id = agm.group_id
     AND g.principal_type = 'group'
    WHERE agm.group_id = group_uuid
      AND agm.principal_id = principal_uuid
      AND agm.status = 'active'
      AND agm.role = ANY(allowed_roles)
  );
$$ LANGUAGE SQL SECURITY DEFINER STABLE SET search_path = public;

-- can_access_instance(uuid, uuid)
-- 判断某用户是否可访问实例（本人、管理员、或所在分组成员）。
CREATE OR REPLACE FUNCTION can_access_instance(instance_uuid UUID, principal_uuid UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
    FROM agent_instances ai
    WHERE ai.id = instance_uuid
      AND (
        ai.principal_id = principal_uuid
        OR is_platform_admin(principal_uuid)
        OR is_active_group_member(ai.principal_id, principal_uuid)
      )
  );
$$ LANGUAGE SQL SECURITY DEFINER STABLE SET search_path = public;

-- can_delete_instance(uuid, uuid)
-- 判断是否可删实例（本人、管理员、或分组 admin）。
CREATE OR REPLACE FUNCTION can_delete_instance(instance_uuid UUID, principal_uuid UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
    FROM agent_instances ai
    WHERE ai.id = instance_uuid
      AND (
        ai.principal_id = principal_uuid
        OR is_platform_admin(principal_uuid)
        OR has_group_role(ai.principal_id, principal_uuid, ARRAY['admin'])
      )
  );
$$ LANGUAGE SQL SECURITY DEFINER STABLE SET search_path = public;

-- Instance quota enforcement (versions/1.0.5)
-- enforce_agent_instance_quota()
-- 在 agent_instances 插入前按 user/group principal 的 max_agent_instances 做最终配额拦截。
CREATE OR REPLACE FUNCTION enforce_agent_instance_quota()
RETURNS TRIGGER AS $$
DECLARE
  max_instances INTEGER;
  current_instances INTEGER;
  quota_type TEXT;
  quota_label TEXT;
BEGIN
  SELECT principal_type, max_agent_instances
  INTO quota_type, max_instances
  FROM principal_profiles
  WHERE id = NEW.principal_id
  FOR UPDATE;

  max_instances := COALESCE(max_instances, 5);
  quota_label := CASE WHEN quota_type = 'group' THEN 'Group' ELSE 'User' END;

  SELECT COUNT(*)::INTEGER
  INTO current_instances
  FROM agent_instances
  WHERE principal_id = NEW.principal_id;

  IF current_instances >= max_instances THEN
    RAISE EXCEPTION '% has reached the maximum limit of % instances', quota_label, max_instances
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
CREATE TRIGGER enforce_agent_instance_quota_before_insert
  BEFORE INSERT ON agent_instances
  FOR EACH ROW
  EXECUTE FUNCTION enforce_agent_instance_quota();

-- validate_group_member_principals()
-- 给 agent_group_members 写入前校验：group_id 必须是 group 类型 principal，principal_id 必须是 user 类型 principal。
CREATE OR REPLACE FUNCTION validate_group_member_principals()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM principal_profiles
    WHERE id = NEW.group_id AND principal_type = 'group'
  ) THEN
    RAISE EXCEPTION 'agent_group_members.group_id must reference a group principal'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM principal_profiles
    WHERE id = NEW.principal_id AND principal_type = 'user'
  ) THEN
    RAISE EXCEPTION 'agent_group_members.principal_id must reference a user principal'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
CREATE TRIGGER validate_group_member_principals
  BEFORE INSERT OR UPDATE ON agent_group_members
  FOR EACH ROW
  EXECUTE FUNCTION validate_group_member_principals();

-- validate_agent_instance_principals()
-- 给 agent_instances 写入前校验：principal_id 必须指向合法 user/group principal；
-- 且不允许更新时改 principal_id（归属主体不可变）。
CREATE OR REPLACE FUNCTION validate_agent_instance_principals()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.principal_id IS DISTINCT FROM OLD.principal_id THEN
    RAISE EXCEPTION 'agent_instances.principal_id is immutable'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM principal_profiles
    WHERE id = NEW.principal_id AND principal_type IN ('user', 'group')
  ) THEN
    RAISE EXCEPTION 'agent_instances.principal_id must reference a principal'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
CREATE TRIGGER validate_agent_instance_principals
  BEFORE INSERT OR UPDATE ON agent_instances
  FOR EACH ROW
  EXECUTE FUNCTION validate_agent_instance_principals();

ALTER TABLE principal_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_group_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members can view their groups" ON principal_profiles
  FOR SELECT USING (
    principal_type = 'group'
    AND (
      is_platform_admin(auth.uid())
      OR is_active_group_member(id, auth.uid())
    )
  );
CREATE POLICY "Members can view group memberships" ON agent_group_members
  FOR SELECT USING (
    is_platform_admin(auth.uid())
    OR is_active_group_member(group_id, auth.uid())
  );
CREATE TRIGGER set_agent_group_members_updated_at
  BEFORE UPDATE ON agent_group_members
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();


COMMENT ON COLUMN agent_instances.skill_config IS
  '实例创建时客户选择的技能挂载快照。与 agent_types.skill_config 字段结构一致（pvName/mountPath/subPath/isRequired/skillSpaceId）；NULL 表示旧实例（功能上线前创建），[]（空数组）表示新实例无技能配置';

-- 启用行级安全
ALTER TABLE agent_instances ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Principals can view accessible instances" ON agent_instances
  FOR SELECT USING (can_access_instance(id, auth.uid()));

CREATE POLICY "Principals can create owned instances" ON agent_instances
  FOR INSERT WITH CHECK (
    principal_id = auth.uid()
    OR is_active_group_member(principal_id, auth.uid())
  );

CREATE POLICY "Principals can update accessible instances" ON agent_instances
  FOR UPDATE USING (can_access_instance(id, auth.uid()))
  WITH CHECK (can_access_instance(id, auth.uid()));

CREATE POLICY "Principals can delete allowed instances" ON agent_instances
  FOR DELETE USING (can_delete_instance(id, auth.uid()));

-- 为各表创建规范命名的 updated_at 触发器。
CREATE TRIGGER set_principal_profiles_updated_at
  BEFORE UPDATE ON principal_profiles
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER set_ai_models_updated_at
  BEFORE UPDATE ON ai_models
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
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
  extracted_name VARCHAR(100);
BEGIN
  -- 从多种来源提取用户名（支持 OAuth 登录）
  -- 优先级: username > preferred_username (GitHub) > user_name > name > email
  extracted_name := COALESCE(
    NEW.raw_user_meta_data->>'username',
    NEW.raw_user_meta_data->>'preferred_username',  -- GitHub username
    NEW.raw_user_meta_data->>'user_name',
    NEW.raw_user_meta_data->>'name',
    NEW.raw_user_meta_data->>'full_name',
    SPLIT_PART(NEW.email, '@', 1)  -- 从邮箱提取用户名
  );

  INSERT INTO principal_profiles (id, name, email, role, status)
  VALUES (
    NEW.id,
    extracted_name,
    NEW.email,
    'user',
    'active'
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
CREATE POLICY "Users can view enabled channel templates" ON channel_templates
  FOR SELECT USING (channel_templates.is_enabled = true);

-- 策略：管理员可以管理渠道模板
CREATE POLICY "Admins can manage channel templates" ON channel_templates
  FOR ALL USING (is_admin(auth.uid()));

-- 触发器：自动更新 updated_at
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

CREATE POLICY "Principals can view accessible instance channel configs" ON instance_channel_configs
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM agent_instances
      WHERE agent_instances.id = instance_channel_configs.instance_id
        AND can_access_instance(agent_instances.id, auth.uid())
    )
  );

CREATE POLICY "Principals can manage accessible instance channel configs" ON instance_channel_configs
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM agent_instances
      WHERE agent_instances.id = instance_channel_configs.instance_id
        AND can_access_instance(agent_instances.id, auth.uid())
    )
  );

-- 触发器：自动更新 updated_at
CREATE TRIGGER set_instance_channel_configs_updated_at
  BEFORE UPDATE ON instance_channel_configs
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();


-- =====================================================
-- Group sharing RPC functions (versions/1.0.5)
-- =====================================================

-- get_group_usage_counts(uuid[])
-- 批量统计分组已被占用的实例数，返回 group_id -> instance_count。
CREATE OR REPLACE FUNCTION get_group_usage_counts(target_group_ids UUID[])
RETURNS TABLE(group_id UUID, instance_count BIGINT) AS $$
  SELECT ai.principal_id AS group_id, COUNT(*)::BIGINT
  FROM agent_instances ai
  JOIN principal_profiles g
    ON g.id = ai.principal_id
   AND g.principal_type = 'group'
  WHERE ai.principal_id = ANY(target_group_ids)
  GROUP BY ai.principal_id;
$$ LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public;

-- 原因：该 RPC 会绕过调用者 RLS 汇总分组用量，只允许后端 service_role 代调。
REVOKE EXECUTE ON FUNCTION get_group_usage_counts(UUID[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_group_usage_counts(UUID[]) TO service_role;

-- create_group_with_admin(uuid, text, uuid)
-- 创建分组 principal，并写入初始 admin 成员，返回新建的 group principal 记录。
CREATE OR REPLACE FUNCTION create_group_with_admin(
  target_group_id UUID,
  group_name TEXT,
  admin_principal_id UUID
)
RETURNS SETOF principal_profiles AS $$
DECLARE
  now_ts TIMESTAMPTZ := NOW();
BEGIN
  PERFORM 1
  FROM principal_profiles
  WHERE principal_profiles.id = admin_principal_id
    AND principal_profiles.principal_type = 'user'
    AND principal_profiles.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Admin user not found';
  END IF;

  INSERT INTO principal_profiles (
    id,
    principal_type,
    name,
    role,
    created_at,
    updated_at
  )
  VALUES (
    target_group_id,
    'group',
    group_name,
    'user',
    now_ts,
    now_ts
  );

  INSERT INTO agent_group_members (
    group_id,
    principal_id,
    role,
    status,
    created_at,
    updated_at
  )
  VALUES (
    target_group_id,
    admin_principal_id,
    'admin',
    'active',
    now_ts,
    now_ts
  );

  RETURN QUERY
  SELECT *
  FROM principal_profiles
  WHERE principal_profiles.id = target_group_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 原因：创建 group principal 是服务端管理写操作；禁止客户端直接 RPC 绕过路由权限校验。
REVOKE EXECUTE ON FUNCTION create_group_with_admin(UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION create_group_with_admin(UUID, TEXT, UUID) TO service_role;

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
CREATE POLICY "Users can view enabled provider configs" ON provider_config
  FOR SELECT USING (provider_config.enabled = true);

-- 策略：管理员可以管理所有 Provider 配置
CREATE POLICY "Admins can manage provider configs" ON provider_config
  FOR ALL USING (is_admin(auth.uid()));

-- 触发器：自动更新 updated_at
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

INSERT INTO provider_config (name, display_name, type, config, enabled, description) VALUES (
  'litellm',
  'LiteLLM网关',
  'LiteLLM',
  '{"apiKeyPlaceholder": "${LITELLM_API_KEY}", "domainPlaceholder": "${LITELLM_PROXY_URL}"}'::jsonb,
  false,
  'LiteLLM Proxy 统一模型网关配置'
)
ON CONFLICT (name) DO NOTHING;


-- 插入默认 AI 模型
INSERT INTO ai_models (name, provider, model_code, status, description, is_enabled) VALUES
  ('qwen3.5-plus', 'bailian', 'qwen3.5-plus', 'active', '通义千问 Qwen3.5-plus 大语言模型，综合能力强', true),
  ('qwen3.7-plus', 'bailian', 'qwen3.7-plus', 'active', '通义千问 Qwen3.7-plus 大语言模型', true),
  ('qwen3.7-max', 'bailian', 'qwen3.7-max', 'active', '通义千问 Qwen3.7-max 大语言模型', true),
  ('qwen3.6-plus', 'bailian', 'qwen3.6-plus', 'active', '通义千问 Qwen3.6-plus 大语言模型', true),
  ('deepseek-v4-pro', 'bailian', 'deepseek-v4-pro', 'active', 'DeepSeek V4 Pro 大语言模型', true)
ON CONFLICT (model_code, provider) DO NOTHING;

-- 插入内置 Agent 类型种子数据
-- OpenClaw
INSERT INTO agent_types (code, name, description, icon, category, sandbox_template_id, sandbox_timeout, config_template, config_write_path, startup_command, modify_model_command, modify_channel_command, readiness_check, upgrade_metadata, supports_channels, supports_env_vars, sandbox_user, terminal_user, skill_path, is_enabled, sort_order) VALUES (
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
      "http": {
        "endpoints": {
          "chatCompletions": {
            "enabled": true
          }
        }
      },
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
    "plugins": {
      "entries": {
        "openclaw-lark": {
          "enabled": true
        },
        "dingtalk-connector": {
          "enabled": true
        },
        "wecom-openclaw-plugin": {
          "enabled": true
        },
        "openclaw-qqbot": {
          "enabled": true
        }
      }
    },
    "channels": {}
  }'::jsonb,
  '/home/node/.openclaw/openclaw.json',
  '#!/bin/bash
chown node:node /home/node/.openclaw/openclaw.json
chown node:node /home/node/.openclaw/.env 2>/dev/null || true
supervisorctl restart openclaw',
  'bash /usr/local/bin/run-cmd.sh modify-model "${MODEL_PROVIDER}/${MODEL_NAME}"
chown node:node /home/node/.openclaw/openclaw.json
chown node:node /home/node/.openclaw/.env 2>/dev/null || true
supervisorctl restart openclaw',
  'bash /usr/local/bin/run-cmd.sh modify-channel "${CHANNEL_CONFIG_JSON}"
chown node:node /home/node/.openclaw/openclaw.json
chown node:node /home/node/.openclaw/.env 2>/dev/null || true
supervisorctl restart openclaw',
  '{"type": "http", "port": 18789, "path": "/health", "timeout": 120}'::jsonb,
  jsonb_build_object(
    'timeoutSeconds', 300,
    'preUpgrade', jsonb_build_object(
      'command', jsonb_build_array(
        '/bin/bash',
        '-c',
$pre$
set -euo pipefail

OPENCLAW_HOME="/home/node/.openclaw"
BACKUP_ROOT="/backup"
BACKUP_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
ARCHIVE="$BACKUP_ROOT/openclaw-state-$BACKUP_ID.tgz"
TAR_STATUS=0

log() {
  echo "[openclaw-upgrade][pre] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"
}

restart_on_error() {
  status=$?
  if [ "$status" -ne 0 ] && command -v supervisorctl >/dev/null 2>&1; then
    log "backup failed: status=$status; restarting openclaw on old pod"
    supervisorctl start openclaw || supervisorctl restart openclaw || true
  fi
  exit "$status"
}
trap restart_on_error EXIT

log "start backup: home=$OPENCLAW_HOME backupRoot=$BACKUP_ROOT archive=$ARCHIVE"
test -d "$BACKUP_ROOT"
test -d "$OPENCLAW_HOME"
if command -v supervisorctl >/dev/null 2>&1; then
  log "stopping openclaw before archiving"
  supervisorctl stop openclaw || true
fi

log "creating backup archive"
tar --warning=no-file-changed --ignore-failed-read \
    --exclude='.openclaw/devices' \
    --exclude='.openclaw/identity/device-auth.json' \
    -czf "$ARCHIVE" -C "$(dirname "$OPENCLAW_HOME")" "$(basename "$OPENCLAW_HOME")" || TAR_STATUS=$?
if [ "$TAR_STATUS" -ne 0 ] && [ "$TAR_STATUS" -ne 1 ]; then
  log "tar failed: status=$TAR_STATUS"
  exit "$TAR_STATUS"
fi
test -s "$ARCHIVE"
log "backup archive ready: bytes=$(wc -c < "$ARCHIVE")"
trap - EXIT
$pre$
      )
    ),
    'postUpgrade', jsonb_build_object(
      'command', jsonb_build_array(
        '/bin/bash',
        '-c',
$post$
set -euo pipefail

OPENCLAW_HOME="/home/node/.openclaw"
BACKUP_ROOT="/backup"
ARCHIVE="$(ls -1t "$BACKUP_ROOT"/openclaw-state-*.tgz 2>/dev/null | head -n 1 || true)"
if [ -z "$ARCHIVE" ] && [ -f "$BACKUP_ROOT/openclaw-state.tgz" ]; then
  ARCHIVE="$BACKUP_ROOT/openclaw-state.tgz"
fi
RESTORE_ROOT=""

log() {
  echo "[openclaw-upgrade][post] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"
}

cleanup() {
  if [ -n "$RESTORE_ROOT" ] && [ -d "$RESTORE_ROOT" ]; then
    rm -rf "$RESTORE_ROOT"
  fi
}
trap cleanup EXIT

log "start restore: home=$OPENCLAW_HOME backupRoot=$BACKUP_ROOT archive=${ARCHIVE:-none}"
test -n "$ARCHIVE"
test -f "$ARCHIVE"

RESTORE_ROOT="$(mktemp -d /home/node/.openclaw-restore.XXXXXX)"
log "extracting archive to $RESTORE_ROOT"
tar -xzf "$ARCHIVE" -C "$RESTORE_ROOT"
RESTORED_HOME="$RESTORE_ROOT/.openclaw"
test -d "$RESTORED_HOME"
test -f "$RESTORED_HOME/openclaw.json"
test -f "$RESTORED_HOME/.env"
log "validated restored config files"

mkdir -p "$(dirname "$OPENCLAW_HOME")"
rm -rf "$OPENCLAW_HOME.before-upgrade"
if [ -d "$OPENCLAW_HOME" ]; then
  log "moving current home to $OPENCLAW_HOME.before-upgrade"
  mv "$OPENCLAW_HOME" "$OPENCLAW_HOME.before-upgrade"
fi
mv "$RESTORED_HOME" "$OPENCLAW_HOME"
chown -R "$(id -u node):$(id -g node)" "$OPENCLAW_HOME"
test -d "$OPENCLAW_HOME"
test -f "$OPENCLAW_HOME/openclaw.json"
test -f "$OPENCLAW_HOME/.env"
log "restore complete: home=$OPENCLAW_HOME"

if command -v supervisorctl >/dev/null 2>&1; then
  log "restarting openclaw"
  supervisorctl restart openclaw || supervisorctl start openclaw
fi
log "post upgrade complete"
$post$
      )
    )
  ),
  true,
  true,
  'root',
  'node',
  '/home/node/.agents/skills',
  true,
  1
) ON CONFLICT (code) DO UPDATE SET
  config_template = EXCLUDED.config_template,
  config_write_path = EXCLUDED.config_write_path,
  startup_command = EXCLUDED.startup_command,
  modify_model_command = EXCLUDED.modify_model_command,
  modify_channel_command = EXCLUDED.modify_channel_command,
  readiness_check = EXCLUDED.readiness_check,
  upgrade_metadata = CASE
    WHEN agent_types.upgrade_metadata IS NULL
      OR agent_types.upgrade_metadata = '{}'::jsonb
      OR agent_types.upgrade_metadata #> '{preUpgrade,command}' IS NULL
      OR agent_types.upgrade_metadata #> '{postUpgrade,command}' IS NULL
      OR agent_types.upgrade_metadata::text LIKE '%/backup/openclaw-state.tgz%'
      OR agent_types.upgrade_metadata::text LIKE '%cd /home/node%'
      OR agent_types.upgrade_metadata::text LIKE '%chown -R node:node%'
      OR agent_types.upgrade_metadata::text LIKE '%api-upgrade-%'
      OR agent_types.upgrade_metadata::text LIKE '%/tmp/api-%'
    THEN EXCLUDED.upgrade_metadata
    ELSE agent_types.upgrade_metadata
  END,
  supports_channels = EXCLUDED.supports_channels,
  supports_env_vars = EXCLUDED.supports_env_vars,
  sandbox_user = EXCLUDED.sandbox_user,
  terminal_user = EXCLUDED.terminal_user,
  skill_path = EXCLUDED.skill_path,
  is_enabled = EXCLUDED.is_enabled;

-- Hermes
INSERT INTO agent_types (code, name, description, icon, category, sandbox_template_id, sandbox_timeout, config_template, config_write_path, startup_command, modify_model_command, modify_channel_command, readiness_check, upgrade_metadata, supports_channels, sandbox_user, terminal_user, skill_path, sort_order)
VALUES (
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

cat > /opt/data/.env << EOF
DASHSCOPE_API_KEY=${DASHSCOPE_API_KEY}
DINGTALK_CLIENT_ID=${CHANNEL_CLIENT_ID}
DINGTALK_CLIENT_SECRET=${CHANNEL_CLIENT_SECRET}
GATEWAY_ALLOW_ALL_USERS=true
FEISHU_CONNECTION_MODE=websocket
FEISHU_APP_ID=${CHANNEL_CLIENT_ID}
FEISHU_APP_SECRET=${CHANNEL_CLIENT_SECRET}
FEISHU_DOMAIN=feishu
EOF

# 重启hermes
supervisorctl restart hermes',
  'bash /usr/local/bin/run-cmd.sh modify-model "${MODEL_NAME}"',
  'bash /usr/local/bin/run-cmd.sh modify-channel "${CHANNEL_TYPE}" "${CHANNEL_CLIENT_ID}" "${CHANNEL_CLIENT_SECRET}"
supervisorctl restart hermes',
  '{"type":"tcp","port":9119,"timeout":120}'::jsonb,
  jsonb_build_object(
    'timeoutSeconds', 60,
    'preUpgrade', jsonb_build_object(
      'command', jsonb_build_array(
        '/bin/bash',
        '-c',
$pre$
set -euo pipefail

HERMES_DATA_DIR="/opt/data"
BACKUP_ROOT="/backup"
BACKUP_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
ARCHIVE="$BACKUP_ROOT/hermes-state-$BACKUP_ID.tgz"

test -d "$BACKUP_ROOT"
test -d "$HERMES_DATA_DIR"
test -f "$HERMES_DATA_DIR/config.yaml"
tar -czf "$ARCHIVE" -C "$HERMES_DATA_DIR" .
test -s "$ARCHIVE"
$pre$
      )
    ),
    'postUpgrade', jsonb_build_object(
      'command', jsonb_build_array(
        '/bin/bash',
        '-c',
$post$
set -euo pipefail

HERMES_DATA_DIR="/opt/data"
BACKUP_ROOT="/backup"
ARCHIVE="$(ls -1t "$BACKUP_ROOT"/hermes-state-*.tgz 2>/dev/null | head -n 1 || true)"
if [ -z "$ARCHIVE" ] && [ -f "$BACKUP_ROOT/hermes-state.tgz" ]; then
  ARCHIVE="$BACKUP_ROOT/hermes-state.tgz"
fi

test -n "$ARCHIVE"
test -f "$ARCHIVE"
mkdir -p "$HERMES_DATA_DIR"
find "$HERMES_DATA_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
tar -xzf "$ARCHIVE" -C "$HERMES_DATA_DIR"
chown -R "$(id -u):$(id -g)" "$HERMES_DATA_DIR"
test -f "$HERMES_DATA_DIR/config.yaml"
if command -v supervisorctl >/dev/null 2>&1; then
  supervisorctl restart hermes || supervisorctl start hermes
fi
$post$
      )
    )
  ),
  true,
  'root',
  'hermes',
  '/opt/data/skills',
  2
)
ON CONFLICT (code) DO UPDATE SET
  config_template = EXCLUDED.config_template,
  config_write_path = EXCLUDED.config_write_path,
  startup_command = EXCLUDED.startup_command,
  modify_model_command = EXCLUDED.modify_model_command,
  modify_channel_command = EXCLUDED.modify_channel_command,
  readiness_check = EXCLUDED.readiness_check,
  upgrade_metadata = CASE
    WHEN agent_types.upgrade_metadata IS NULL
      OR agent_types.upgrade_metadata = '{}'::jsonb
      OR agent_types.upgrade_metadata #> '{preUpgrade,command}' IS NULL
      OR agent_types.upgrade_metadata #> '{postUpgrade,command}' IS NULL
      OR agent_types.upgrade_metadata::text LIKE '%/backup/hermes-state.tgz%'
      OR agent_types.upgrade_metadata::text LIKE '%api-upgrade-%'
      OR agent_types.upgrade_metadata::text LIKE '%/tmp/api-%'
    THEN EXCLUDED.upgrade_metadata
    ELSE agent_types.upgrade_metadata
  END,
  supports_channels = EXCLUDED.supports_channels,
  sandbox_user = EXCLUDED.sandbox_user,
  terminal_user = EXCLUDED.terminal_user,
  skill_path = EXCLUDED.skill_path;

-- QwenPaw
INSERT INTO agent_types (
  code, name, description, icon, category,
  sandbox_template_id, sandbox_timeout,
  config_template, config_write_path,
  startup_command, readiness_check,
  upgrade_metadata,
  supports_channels, supports_skills, sandbox_user, terminal_user, skill_path,
  is_enabled, sort_order,
  modify_model_command, modify_channel_command
) VALUES (
  'qwenpaw',
  'QwenPaw',
  '基于 AgentScope QwenPaw 的桌面型 AI Agent，内置 Xvfb 桌面 + Chromium + 多工具能力',
  'bot',
  'builtin',
  'agent-manager-qwenpaw',
  300,
  '{
  "mcp": {
    "clients": {
      "tavily_search": {
        "cwd": "",
        "env": { "TAVILY_API_KEY": "" },
        "url": "",
        "args": ["-y", "tavily-mcp@latest"],
        "name": "tavily_mcp",
        "command": "npx",
        "enabled": false,
        "headers": {},
        "transport": "stdio",
        "description": ""
      }
    }
  },
  "tools": {
    "builtin_tools": {
      "edit_file":            {"icon": "🖊️", "name": "edit_file",            "enabled": true, "description": "Edit file using find-and-replace",             "async_execution": false, "display_to_user": true},
      "read_file":            {"icon": "📄",  "name": "read_file",            "enabled": true, "description": "Read file contents",                         "async_execution": false, "display_to_user": true},
      "view_image":           {"icon": "🖼️",  "name": "view_image",           "enabled": true, "description": "Load an image into LLM context for visual analysis", "async_execution": false, "display_to_user": false},
      "view_video":           {"icon": "🎥", "name": "view_video",           "enabled": true, "description": "Load a video into LLM context for visual analysis", "async_execution": false, "display_to_user": false},
      "write_file":           {"icon": "✍️", "name": "write_file",           "enabled": true, "description": "Write content to file",                    "async_execution": false, "display_to_user": true},
      "browser_use":          {"icon": "🌐", "name": "browser_use",          "enabled": true, "description": "Browser automation and web interaction",     "async_execution": false, "display_to_user": true},
      "glob_search":          {"icon": "📁", "name": "glob_search",          "enabled": true, "description": "Find files matching a glob pattern",         "async_execution": false, "display_to_user": true},
      "grep_search":          {"icon": "🔍", "name": "grep_search",          "enabled": true, "description": "Search file contents by pattern",            "async_execution": false, "display_to_user": true},
      "list_agents":          {"icon": "🤖", "name": "list_agents",          "enabled": true, "description": "List configured agents from the local API",  "async_execution": false, "display_to_user": true},
      "chat_with_agent":      {"icon": "💬", "name": "chat_with_agent",      "enabled": true, "description": "Send a message to another configured agent", "async_execution": false, "display_to_user": true},
      "get_token_usage":      {"icon": "📊", "name": "get_token_usage",      "enabled": true, "description": "Get llm token usage",                        "async_execution": false, "display_to_user": true},
      "get_current_time":     {"icon": "🕐", "name": "get_current_time",     "enabled": true, "description": "Get current date and time",                  "async_execution": false, "display_to_user": true},
      "send_file_to_user":    {"icon": "📤", "name": "send_file_to_user",    "enabled": true, "description": "Send files to user",                         "async_execution": false, "display_to_user": true},
      "set_user_timezone":    {"icon": "🌍", "name": "set_user_timezone",    "enabled": true, "description": "Set user timezone",                          "async_execution": false, "display_to_user": true},
      "desktop_screenshot":   {"icon": "📸", "name": "desktop_screenshot",   "enabled": true, "description": "Capture desktop screenshots",                "async_execution": false, "display_to_user": true},
      "execute_shell_command":{"icon": "💻", "name": "execute_shell_command","enabled": true, "description": "Execute shell commands",                    "async_execution": false, "display_to_user": true}
    }
  },
  "agents": {
    "running": {
      "max_iters": 100,
      "llm_max_qpm": 600,
      "memory_summary": {"force_min_score": 0.3, "force_max_results": 1, "force_memory_search": false, "memory_prompt_enabled": true, "memory_summary_enabled": true, "force_memory_search_timeout": 10, "rebuild_memory_index_on_start": false},
      "context_compact": {"token_count_model": "default", "memory_compact_ratio": 0.75, "memory_reserve_ratio": 0.1, "token_count_use_mirror": false, "context_compact_enabled": true, "compact_with_thinking_block": true, "token_count_estimate_divisor": 4},
      "llm_backoff_cap": 10,
      "llm_max_retries": 3,
      "embedding_config": {"api_key": "", "backend": "openai", "base_url": "", "dimensions": 1024, "model_name": "", "enable_cache": true, "max_batch_size": 10, "max_cache_size": 3000, "use_dimensions": false, "max_input_length": 8192},
      "llm_backoff_base": 1,
      "max_input_length": 131072,
      "llm_retry_enabled": true,
      "history_max_length": 10000,
      "llm_max_concurrent": 10,
      "llm_acquire_timeout": 300,
      "tool_result_compact": {"enabled": true, "recent_n": 2, "old_max_bytes": 3000, "retention_days": 5, "recent_max_bytes": 50000},
      "llm_rate_limit_pause": 5,
      "llm_rate_limit_jitter": 1,
      "memory_manager_backend": "remelight"
    },
    "defaults": {"heartbeat": {"every": "6h", "target": "main", "enabled": false, "activeHours": null}},
    "language": "zh",
    "profiles": {
      "default":              {"id": "default",              "enabled": true, "workspace_dir": "/app/working/workspaces/default"},
      "QwenPaw_QA_Agent_0.2": {"id": "QwenPaw_QA_Agent_0.2", "enabled": true, "workspace_dir": "/app/working/workspaces/QwenPaw_QA_Agent_0.2"}
    },
    "audio_mode": "auto",
    "agent_order": ["default"],
    "llm_routing": {"mode": "local_first", "cloud": null, "local": {"model": "", "provider_id": ""}, "enabled": false},
    "active_agent": "default",
    "system_prompt_files": ["AGENTS.md", "SOUL.md", "PROFILE.md"],
    "transcription_model": "whisper-1",
    "transcription_provider_id": "",
    "installed_md_files_language": "zh",
    "transcription_provider_type": "disabled"
  },
  "plugins": {},
  "channels": {
    "console":    {"enabled": true,  "dm_policy": "open", "media_dir": null, "allow_from": [], "bot_prefix": "", "deny_message": "", "group_policy": "open", "filter_thinking": false, "require_mention": false, "filter_tool_messages": false}
  },
  "last_api": {"host": "127.0.0.1", "port": 8088},
  "security": {
    "file_guard":    {"enabled": true, "sensitive_files": []},
    "tool_guard":    {"enabled": true, "custom_rules": [], "denied_tools": [], "guarded_tools": null, "disabled_rules": []},
    "skill_scanner": {"mode": "warn", "timeout": 30, "whitelist": []}
  },
  "last_dispatch": null,
  "user_timezone": "Etc/UTC",
  "show_tool_details": true
}'::jsonb,
  '/app/working/config.json',
  '#!/bin/bash
set -e
export _QP_BAILIAN_KEY="${DASHSCOPE_API_KEY}"
export _QP_GATEWAY_KEY="${CONSUMER_API_KEY}"
export _QP_LITELLM_KEY="${LITELLM_API_KEY}"
export _QP_GATEWAY_URL="http://${AI_GATEWAY_DOMAIN}/v1"
export _QP_LITELLM_URL="${LITELLM_PROXY_URL}"

bash /usr/local/bin/run-cmd.sh seed
bash /usr/local/bin/run-cmd.sh write-model "${MODEL_PROVIDER}" "${MODEL_NAME}"
bash /usr/local/bin/run-cmd.sh restart
',
  '{"path": "/api/version", "port": 8088, "type": "http", "timeout": 120}'::jsonb,
  jsonb_build_object(
    'timeoutSeconds', 60,
    'preUpgrade', jsonb_build_object(
      'command', jsonb_build_array(
        '/bin/bash',
        '-c',
$qp_pre$
set -euo pipefail

WORKING_DIR="/app/working"
SECRET_DIR="/app/working.secret"
BACKUP_ROOT="/backup"
BACKUP_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
ARCHIVE="$BACKUP_ROOT/qwenpaw-state-$BACKUP_ID.tgz"

test -d "$BACKUP_ROOT"
test -d "$WORKING_DIR"
test -d "$SECRET_DIR"
tar -czf "$ARCHIVE" -C /app working working.secret
test -s "$ARCHIVE"
$qp_pre$
      )
    ),
    'postUpgrade', jsonb_build_object(
      'command', jsonb_build_array(
        '/bin/bash',
        '-c',
$qp_post$
set -euo pipefail

WORKING_DIR="/app/working"
SECRET_DIR="/app/working.secret"
BACKUP_ROOT="/backup"
ARCHIVE="$(ls -1t "$BACKUP_ROOT"/qwenpaw-state-*.tgz 2>/dev/null | head -n 1 || true)"
if [ -z "$ARCHIVE" ] && [ -f "$BACKUP_ROOT/qwenpaw-state.tgz" ]; then
  ARCHIVE="$BACKUP_ROOT/qwenpaw-state.tgz"
fi

test -n "$ARCHIVE"
test -f "$ARCHIVE"
mkdir -p "$WORKING_DIR" "$SECRET_DIR"
find "$WORKING_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
find "$SECRET_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
tar -xzf "$ARCHIVE" -C /app
test -f "$WORKING_DIR/config.json"
chown -R "$(id -u):$(id -g)" "$WORKING_DIR" "$SECRET_DIR"

if [ -x /usr/local/bin/run-cmd.sh ]; then
  bash /usr/local/bin/run-cmd.sh restart || true
fi
$qp_post$
      )
    )
  ),
  false,
  false,
  'root',
  'node',
  '/app/working/skill_pool',
  true,
  3,
  '#!/bin/bash
set -e
export _QP_BAILIAN_KEY="${DASHSCOPE_API_KEY}"
export _QP_GATEWAY_KEY="${CONSUMER_API_KEY}"
export _QP_LITELLM_KEY="${LITELLM_API_KEY}"
export _QP_GATEWAY_URL="http://${AI_GATEWAY_DOMAIN}/v1"
export _QP_LITELLM_URL="${LITELLM_PROXY_URL}"

bash /usr/local/bin/run-cmd.sh write-model "${MODEL_PROVIDER}" "${MODEL_NAME}"
bash /usr/local/bin/run-cmd.sh restart
',
  NULL
)
ON CONFLICT (code) DO UPDATE SET
  name                   = EXCLUDED.name,
  description            = EXCLUDED.description,
  icon                   = EXCLUDED.icon,
  category               = EXCLUDED.category,
  sandbox_template_id    = EXCLUDED.sandbox_template_id,
  sandbox_timeout        = EXCLUDED.sandbox_timeout,
  config_template        = EXCLUDED.config_template,
  config_write_path      = EXCLUDED.config_write_path,
  startup_command        = EXCLUDED.startup_command,
  readiness_check        = EXCLUDED.readiness_check,
  upgrade_metadata       = CASE
    WHEN agent_types.upgrade_metadata IS NULL
      OR agent_types.upgrade_metadata = '{}'::jsonb
      OR agent_types.upgrade_metadata #> '{preUpgrade,command}' IS NULL
      OR agent_types.upgrade_metadata #> '{postUpgrade,command}' IS NULL
      OR agent_types.upgrade_metadata::text LIKE '%/backup/qwenpaw-state.tgz%'
      OR agent_types.upgrade_metadata::text LIKE '%api-upgrade-%'
      OR agent_types.upgrade_metadata::text LIKE '%/tmp/api-%'
    THEN EXCLUDED.upgrade_metadata
    ELSE agent_types.upgrade_metadata
  END,
  supports_channels      = EXCLUDED.supports_channels,
  supports_skills        = EXCLUDED.supports_skills,
  sandbox_user           = EXCLUDED.sandbox_user,
  terminal_user          = EXCLUDED.terminal_user,
  skill_path             = EXCLUDED.skill_path,
  is_enabled             = EXCLUDED.is_enabled,
  sort_order             = EXCLUDED.sort_order,
  modify_model_command   = EXCLUDED.modify_model_command,
  modify_channel_command = EXCLUDED.modify_channel_command;

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
    '{"dingtalk-connector": {"ackText": "任务已接收", "enabled": true, "clientId": "${CHANNEL_CLIENT_ID}", "clientSecret": "${CHANNEL_CLIENT_SECRET}", "groupSessionScope": "group", "separateSessionByConversation": true, "sharedMemoryAcrossConversations": false}}'::jsonb,
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

-- 插入 Hermes 类型的渠道模板（钉钉 + 飞书）
INSERT INTO channel_templates (channel_type, name, description, config_fields, config_file, config_template, is_enabled, agent_type_id) VALUES
  ('dingtalk', '钉钉 (DingTalk)', '钉钉开放平台应用配置',
    '[{"name": "clientId", "type": "text", "label": "Client ID (AppKey)", "required": true, "placeholder": "dingxxxxxxxxxxxxxxxx"}, {"name": "clientSecret", "type": "password", "label": "Client Secret (AppSecret)", "required": true, "placeholder": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}]',
    NULL,
    '{"_format": "yaml", "_content": ""}'::jsonb,
    true, (SELECT id FROM agent_types WHERE code = 'hermes')),
  ('feishu', '飞书 (Feishu)', '飞书开放平台应用配置',
    '[{"name": "clientId", "type": "text", "label": "App ID", "required": true, "placeholder": "cli_xxxxxxxxxxxxxxxx"}, {"name": "clientSecret", "type": "password", "label": "App Secret", "required": true, "placeholder": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}]',
    NULL,
    '{"_format": "yaml", "_content": ""}'::jsonb,
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
INSERT INTO principal_profiles (id, name, email, role, status, max_agent_instances)
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
    INSERT INTO principal_profiles (
      id,
      name,
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
      name = 'Admin',
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

-- 函数元数据注释：便于 DBA/Review 在数据库侧直接理解这些函数的职责。
COMMENT ON FUNCTION is_admin_check() IS
  '判断当前认证用户是否为 active 的管理员 principal，并避免 RLS 递归。';
COMMENT ON FUNCTION is_admin(UUID) IS
  '判断指定 user principal 是否为 active 的管理员；现有 admin policy 传入 auth.uid。';
COMMENT ON FUNCTION principal_profiles_protect_privileged_columns() IS
  '阻止非管理员认证用户修改 principal profile 上的权限列和系统托管列。';
COMMENT ON FUNCTION create_user_profile() IS
  'auth.users 新增用户后自动创建 user principal profile。';
COMMENT ON FUNCTION create_or_update_admin_profile() IS
  '在默认管理员 auth user 存在时创建或刷新管理员 principal profile。';
COMMENT ON FUNCTION is_platform_admin(UUID) IS
  '判断 user principal 是否为 active 的平台管理员。';
COMMENT ON FUNCTION is_active_group_member(UUID, UUID) IS
  '判断 user principal 是否为某个 group principal 的 active 成员。';
COMMENT ON FUNCTION has_group_role(UUID, UUID, TEXT[]) IS
  '判断 user principal 在 group principal 中是否拥有指定 active 角色。';
COMMENT ON FUNCTION can_access_instance(UUID, UUID) IS
  '判断 user principal 是否可通过本人归属、管理员权限或分组成员关系访问实例。';
COMMENT ON FUNCTION can_delete_instance(UUID, UUID) IS
  '判断 user principal 是否可通过本人归属、管理员权限或分组 admin 身份删除实例。';
COMMENT ON FUNCTION validate_group_member_principals() IS
  '校验 agent_group_members 只能从 group principal 指向 user principal。';
COMMENT ON FUNCTION validate_agent_instance_principals() IS
  '校验实例 principal_id 指向合法主体，并保持实例归属主体不可变。';
COMMENT ON FUNCTION enforce_agent_instance_quota() IS
  '实例创建前按 user/group principal 的 max_agent_instances 执行最终配额拦截。';
COMMENT ON FUNCTION get_group_usage_counts(UUID[]) IS
  '批量返回 group principal 的实例使用数量。';
COMMENT ON FUNCTION create_group_with_admin(UUID, TEXT, UUID) IS
  '在同一事务中创建 group principal 和初始 admin 成员关系。';

-- 执行创建/更新管理员资料
-- SELECT create_or_update_admin_profile();

-- =====================================================
-- 14. 迁移版本跟踪表 (schema_migrations)
-- 记录已应用的数据库迁移，防止重复执行
-- =====================================================

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT        NOT NULL,
  filename    TEXT        NOT NULL,
  checksum    TEXT        NOT NULL DEFAULT '',
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (version, filename)
);

-- 标记当前 init_database.sql 对应的最新 schema 版本。
-- ⚠️ 维护规则：每次新增 versions/X.Y.Z/ 并同步更新本文件后，
--   只需更新下方 INSERT 的 version 为最新版本号即可。
--   init-db.js baselineMigrations() 会根据此 version 自动 stamp
--   所有 ≤ 该版本的 versions/ 下的迁移文件记录。
INSERT INTO schema_migrations (version, filename) VALUES
  ('1.0.6', 'init_database.sql')
ON CONFLICT (version, filename) DO NOTHING;

-- =====================================================
-- 初始化完成
-- =====================================================
