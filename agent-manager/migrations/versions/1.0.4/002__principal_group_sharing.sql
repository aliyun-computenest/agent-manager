-- Agent 分组共享迁移：把 user_profiles 扩展为统一的 principal_profiles。
-- 原因：分组本身也需要拥有实例、配额和 Consumer 信息，继续用 user_profiles 会把
-- “用户”和“分组主体”拆成两套模型；统一为 principal 后，实例归属可用同一个
-- agent_instances.principal_id 表达用户实例和分组实例。

-- 原因：从 1.0.3 升级时表名仍是 user_profiles；baseline 已直接创建 principal_profiles。
-- 只在缺少 principal_profiles 且存在 user_profiles 时 rename，避免重复执行时再次改名。
DO $$
BEGIN
  IF to_regclass('public.principal_profiles') IS NULL
     AND to_regclass('public.user_profiles') IS NOT NULL THEN
    ALTER TABLE user_profiles RENAME TO principal_profiles;
  END IF;
END $$;

-- 原因：principal_profiles.id 不再只指向 auth.users.id，group principal 也会占用该主键；
-- 正式升级路径里 rename 后 FK 名仍是 user_profiles_id_fkey，需要移除旧 auth.users 强 FK。
ALTER TABLE principal_profiles
  DROP CONSTRAINT IF EXISTS user_profiles_id_fkey;

-- 原因：新增 principal_type 区分 user/group；统一用 name 承载主体展示名。
DO $$
DECLARE
  has_username BOOLEAN;
  has_name BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'principal_profiles'
      AND column_name = 'username'
  ) INTO has_username;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'principal_profiles'
      AND column_name = 'name'
  ) INTO has_name;

  IF has_username AND NOT has_name THEN
    ALTER TABLE principal_profiles RENAME COLUMN username TO name;
  ELSIF has_username AND has_name THEN
    UPDATE principal_profiles
    SET name = COALESCE(name, username)
    WHERE name IS NULL;

    ALTER TABLE principal_profiles DROP COLUMN username;
  END IF;
END $$;

ALTER TABLE principal_profiles
  ADD COLUMN IF NOT EXISTS principal_type VARCHAR(20) NOT NULL DEFAULT 'user';

-- 原因：group principal 没有 email，必须放宽旧用户资料表的 email 非空约束。
ALTER TABLE principal_profiles
  ALTER COLUMN email DROP NOT NULL;

-- 原因：email 唯一性只适用于 user principal；group principal 不使用 email，
-- 用 partial unique index 明确语义，避免依赖 PostgreSQL 多 NULL 不冲突的隐含行为。
ALTER TABLE principal_profiles
  DROP CONSTRAINT IF EXISTS user_profiles_email_key;

ALTER TABLE principal_profiles
  DROP CONSTRAINT IF EXISTS principal_profiles_email_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_principal_profiles_user_email_unique
  ON principal_profiles(email)
  WHERE principal_type = 'user';

-- 原因：正式升级路径里 rename 后旧约束名仍是 user_profiles_principal_type_check；
-- 先删除旧约束，后面重建为 principal_profiles_principal_type_check。
ALTER TABLE principal_profiles
  DROP CONSTRAINT IF EXISTS user_profiles_principal_type_check;

-- 原因：重建目标约束前先删除同名约束，保证迁移失败后可以直接重跑。
ALTER TABLE principal_profiles
  DROP CONSTRAINT IF EXISTS principal_profiles_principal_type_check;

-- 原因：principal 当前只支持用户和分组两类，明确约束可防止写入未知主体类型。
ALTER TABLE principal_profiles
  ADD CONSTRAINT principal_profiles_principal_type_check
  CHECK (principal_type IN ('user', 'group'));

-- 原因：旧必填字段约束只适合 user profile；需要替换为按 principal_type 区分字段要求的版本。
ALTER TABLE principal_profiles
  DROP CONSTRAINT IF EXISTS user_profiles_required_fields_by_type_check;

-- 原因：重建目标约束前先删除同名约束，保证迁移失败后可以直接重跑。
ALTER TABLE principal_profiles
  DROP CONSTRAINT IF EXISTS principal_profiles_required_fields_by_type_check;

-- 原因：user principal 仍必须有 name/email；group principal 只要求 name，
-- 同时固定 group principal 的 role='user' 为占位值；真正的分组角色在 agent_group_members.role。
ALTER TABLE principal_profiles
  ADD CONSTRAINT principal_profiles_required_fields_by_type_check
  CHECK (
    (principal_type = 'user' AND name IS NOT NULL AND email IS NOT NULL)
    OR (principal_type = 'group' AND name IS NOT NULL AND role = 'user')
  );

COMMENT ON COLUMN principal_profiles.email IS
  '仅 user principal 使用并要求唯一；group principal 不使用 email。';
COMMENT ON COLUMN principal_profiles.role IS
  '仅 user principal 用于平台权限；group principal 固定为 user 占位，分组角色存放在 agent_group_members.role。';

-- 原因：分组名需要大小写不敏感地唯一，避免 UI 中出现 OpenClaw/openclaw 两个同名组。
CREATE UNIQUE INDEX IF NOT EXISTS idx_principal_profiles_group_name
  ON principal_profiles(lower(name))
  WHERE principal_type = 'group';

-- 原因：管理端会按主体类型分页查询用户/分组，补充组合索引减少列表扫描成本。
CREATE INDEX IF NOT EXISTS idx_principal_profiles_type_created
  ON principal_profiles(principal_type, created_at DESC, id);

-- 原因：RLS policy 里需要判断当前用户是否 active admin；改表名后必须从 principal_profiles 读取。
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

-- 原因：现有迁移和 baseline 仍有多处 admin policy 调用 is_admin(auth.uid())；
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

-- 原因：表和函数从 user_profiles 改名为 principal_profiles 后，旧 trigger/function 名称要清掉，
-- 否则重复迁移或不同环境中的旧命名会和新触发器并存。
DROP TRIGGER IF EXISTS protect_user_profiles_privileged_columns ON principal_profiles;
DROP TRIGGER IF EXISTS protect_principal_profiles_privileged_columns ON principal_profiles;
DROP FUNCTION IF EXISTS user_profiles_protect_privileged_columns();

-- 原因：普通用户可 PATCH 自己的 profile，但不能借此改 role/status/quota/consumer 等敏感字段；
-- group sharing 扩展后这些系统字段更多，需要用 trigger 继续兜底防越权。
CREATE OR REPLACE FUNCTION principal_profiles_protect_privileged_columns()
RETURNS TRIGGER AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

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

-- 原因：把新的列级保护函数绑定到 principal_profiles，覆盖旧 user_profiles trigger。
CREATE TRIGGER protect_principal_profiles_privileged_columns
  BEFORE UPDATE ON principal_profiles
  FOR EACH ROW
  EXECUTE FUNCTION principal_profiles_protect_privileged_columns();

-- 原因：表 rename 后旧 updated_at trigger 名称可能不同；先清理所有旧名，再创建统一命名的 trigger。
DROP TRIGGER IF EXISTS set_updated_at ON principal_profiles;
DROP TRIGGER IF EXISTS set_user_profiles_updated_at ON principal_profiles;
DROP TRIGGER IF EXISTS set_principal_profiles_updated_at ON principal_profiles;
CREATE TRIGGER set_principal_profiles_updated_at
  BEFORE UPDATE ON principal_profiles
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- 原因：Supabase Auth 新建用户时仍要自动创建 user principal，而不是旧 user_profiles 行。
CREATE OR REPLACE FUNCTION create_user_profile()
RETURNS TRIGGER AS $$
DECLARE
  extracted_name VARCHAR(100);
BEGIN
  extracted_name := COALESCE(
    NEW.raw_user_meta_data->>'username',
    NEW.raw_user_meta_data->>'preferred_username',
    NEW.raw_user_meta_data->>'user_name',
    NEW.raw_user_meta_data->>'name',
    NEW.raw_user_meta_data->>'full_name',
    SPLIT_PART(NEW.email, '@', 1)
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
    RAISE WARNING 'Failed to create principal profile for %: %', NEW.id, SQLERRM;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 原因：重新绑定 auth.users 插入触发器，确保 OAuth/邮箱登录新用户落到 principal_profiles。
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION create_user_profile();

-- 原因：默认管理员资料也必须写入 principal_profiles，并保持 user principal 字段一致。
CREATE OR REPLACE FUNCTION create_or_update_admin_profile()
RETURNS VOID AS $$
DECLARE
  admin_user_id UUID;
BEGIN
  SELECT id INTO admin_user_id
  FROM auth.users
  WHERE email = 'admin@openclaw.local';

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
  END IF;
END;
$$ LANGUAGE plpgsql;

-- 原因：历史 user_profiles 行改名后都应视为 user principal，避免 principal_type 为空导致新约束失败。
UPDATE principal_profiles
SET principal_type = 'user'
WHERE principal_type IS NULL;

-- 原因：新增分组共享需要记录 group principal 与 user principal 的成员关系和角色。
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

-- 原因：用户侧列表和权限校验会按 principal_id 查 active 分组成员关系。
CREATE INDEX IF NOT EXISTS idx_agent_group_members_principal_status
  ON agent_group_members(principal_id, status, group_id);

-- 原因：分组管理页和 admin 权限判断会按 group_id/status/role 查询成员。
CREATE INDEX IF NOT EXISTS idx_agent_group_members_group_status_role
  ON agent_group_members(group_id, status, role);

-- 原因：实例归属从单一用户扩展为 user/group principal；principal_id 承载统一归属，
-- 不再保留旧 user_id，避免同一实例出现两套归属语义。
ALTER TABLE agent_instances
  ADD COLUMN IF NOT EXISTS principal_id UUID;

-- 原因：历史实例都是用户私有实例，旧 user_id 可直接作为 user principal_id。
UPDATE agent_instances
SET principal_id = user_id
WHERE principal_id IS NULL;

-- 原因：旧 RLS policy 仍引用 agent_instances.user_id；必须先删除这些依赖，
-- 否则 PostgreSQL 会拒绝 DROP COLUMN user_id。
DROP POLICY IF EXISTS "Users can view own instances" ON agent_instances;
DROP POLICY IF EXISTS "Users can create instances" ON agent_instances;
DROP POLICY IF EXISTS "Users can update own instances" ON agent_instances;
DROP POLICY IF EXISTS "Users can delete own instances" ON agent_instances;
DROP POLICY IF EXISTS "Users can manage own instances" ON agent_instances;
DROP POLICY IF EXISTS "Users can view own instance channel configs" ON instance_channel_configs;
DROP POLICY IF EXISTS "Users can manage own instance channel configs" ON instance_channel_configs;

-- 原因：旧 user_id 字段不再参与权限判断；回填完成后直接删除。
ALTER TABLE agent_instances
  DROP CONSTRAINT IF EXISTS agent_instances_user_id_fkey;

ALTER TABLE agent_instances
  DROP COLUMN user_id;

-- 原因：所有实例必须有明确归属主体，否则后续 RLS 和配额无法判断。
ALTER TABLE agent_instances
  ALTER COLUMN principal_id SET NOT NULL;

-- 原因：principal_id 指向 principal_profiles，可引用 user 或 group；
-- ON DELETE RESTRICT 防止删除主体时留下无归属实例。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_instances_principal_id_fkey'
  ) THEN
    ALTER TABLE agent_instances
      ADD CONSTRAINT agent_instances_principal_id_fkey
      FOREIGN KEY (principal_id) REFERENCES principal_profiles(id) ON DELETE RESTRICT;
  END IF;
END $$;

-- 原因：实例列表、配额统计和分组实例查询都按 principal_id + created_at 访问。
CREATE INDEX IF NOT EXISTS idx_agent_instances_principal_created
  ON agent_instances(principal_id, created_at DESC, id);

-- 原因：旧 user_id 索引随字段删除后不应保留；统一使用 principal_id 复合索引。
DROP INDEX IF EXISTS idx_agent_instances_user_id;

COMMENT ON COLUMN agent_instances.principal_id IS
  '实例归属主体：私有实例为 user principal，分组实例为 group principal。';

-- is_platform_admin(uuid)
-- 原因：分组成员权限之外，平台 admin 需要跨主体访问管理资源。
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
-- 原因：分组实例访问取决于用户是否是该 group principal 的 active 成员。
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
-- 原因：删除、限额管理等操作需要区分 group admin/member 角色。
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
-- 原因：实例读取/更新从创建者权限改为 principal_id 权限；用户可访问自己的私有实例、
-- 平台 admin 可访问所有实例，active 分组成员可访问分组实例。
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
-- 原因：分组实例删除比读取更严格，只允许平台 admin、分组 admin、私有实例本人，
-- 避免普通成员误删他人实例。
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

-- validate_group_member_principals()
-- 原因：成员关系表必须保证 group_id 只指向 group principal，principal_id 只指向 user principal，
-- 防止 group 套 group 或 user 当 group 的错误数据进入权限系统。
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

-- 原因：把成员关系类型校验应用到插入/更新路径，保证 API 和 SQL 直写都受约束。
DROP TRIGGER IF EXISTS validate_group_member_principals ON agent_group_members;
CREATE TRIGGER validate_group_member_principals
  BEFORE INSERT OR UPDATE ON agent_group_members
  FOR EACH ROW
  EXECUTE FUNCTION validate_group_member_principals();

-- validate_agent_instance_principals()
-- 原因：实例创建后归属主体不能被随意改写，否则会绕过配额和权限审计；
-- 同时 principal_id 必须指向合法 user/group principal。
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

-- 原因：把实例归属主体校验应用到插入/更新路径，防止直接 SQL 写入非法 principal_id。
DROP TRIGGER IF EXISTS validate_agent_instance_principals ON agent_instances;
CREATE TRIGGER validate_agent_instance_principals
  BEFORE INSERT OR UPDATE ON agent_instances
  FOR EACH ROW
  EXECUTE FUNCTION validate_agent_instance_principals();

-- enforce_agent_instance_quota()
-- 原因：配额从用户维度扩展到 user/group principal 维度，数据库层需要最终拦截超额创建，
-- 避免并发请求绕过服务端预检查。
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

-- 原因：在实例插入前执行配额检查，确保用户实例和分组实例都走同一套配额规则。
DROP TRIGGER IF EXISTS enforce_agent_instance_quota_before_insert ON agent_instances;
CREATE TRIGGER enforce_agent_instance_quota_before_insert
  BEFORE INSERT ON agent_instances
  FOR EACH ROW
  EXECUTE FUNCTION enforce_agent_instance_quota();

-- 原因：旧策略基于 user_id，只能表达私有实例；先清理旧策略和可能已创建的新策略，
-- 再统一创建 principal_id 版本，保证重复执行迁移时不会留下冲突 policy。
DROP POLICY IF EXISTS "Users can view own instances" ON agent_instances;
DROP POLICY IF EXISTS "Users can create instances" ON agent_instances;
DROP POLICY IF EXISTS "Users can update own instances" ON agent_instances;
DROP POLICY IF EXISTS "Users can delete own instances" ON agent_instances;
DROP POLICY IF EXISTS "Users can manage own instances" ON agent_instances;
DROP POLICY IF EXISTS "Admins can view all instances" ON agent_instances;
DROP POLICY IF EXISTS "Admins can manage all instances" ON agent_instances;
DROP POLICY IF EXISTS "Principals can view accessible instances" ON agent_instances;
DROP POLICY IF EXISTS "Principals can create owned instances" ON agent_instances;
DROP POLICY IF EXISTS "Principals can update accessible instances" ON agent_instances;
DROP POLICY IF EXISTS "Principals can delete allowed instances" ON agent_instances;

-- 原因：替换旧的创建者 RLS 为 principal_id RLS，让私有实例和分组实例共用同一套访问判断。
CREATE POLICY "Principals can view accessible instances" ON agent_instances
  FOR SELECT USING (can_access_instance(id, auth.uid()));

-- 原因：创建实例时 principal_id 可以是本人或其所在 active 分组，数据库层拦住越权归属。
CREATE POLICY "Principals can create owned instances" ON agent_instances
  FOR INSERT WITH CHECK (
    principal_id = auth.uid()
    OR is_active_group_member(principal_id, auth.uid())
  );

-- 原因：实例更新权限跟读取一致；同分组 active 成员需要能更新分组实例的运行态信息。
CREATE POLICY "Principals can update accessible instances" ON agent_instances
  FOR UPDATE USING (can_access_instance(id, auth.uid()))
  WITH CHECK (can_access_instance(id, auth.uid()));

-- 原因：删除权限比读取/更新更严格，使用 can_delete_instance 区分本人、平台 admin 和分组 admin。
CREATE POLICY "Principals can delete allowed instances" ON agent_instances
  FOR DELETE USING (can_delete_instance(id, auth.uid()));

-- 原因：instance_channel_configs 的访问应跟随实例访问权限，先清理旧 user_id/admin 策略，
-- 再创建基于 can_access_instance 的 principal 版本。
DROP POLICY IF EXISTS "Users can view own instance channel configs" ON instance_channel_configs;
DROP POLICY IF EXISTS "Users can manage own instance channel configs" ON instance_channel_configs;
DROP POLICY IF EXISTS "Admins can view all instance channel configs" ON instance_channel_configs;
DROP POLICY IF EXISTS "Principals can view accessible instance channel configs" ON instance_channel_configs;
DROP POLICY IF EXISTS "Principals can manage accessible instance channel configs" ON instance_channel_configs;

-- 原因：渠道配置跟随实例权限；用户能访问实例时，才允许读取对应 channel config。
CREATE POLICY "Principals can view accessible instance channel configs" ON instance_channel_configs
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM agent_instances
      WHERE agent_instances.id = instance_channel_configs.instance_id
        AND can_access_instance(agent_instances.id, auth.uid())
    )
  );

-- 原因：渠道配置的增删改也应跟随实例访问权限，分组实例成员需要管理该实例的渠道配置。
CREATE POLICY "Principals can manage accessible instance channel configs" ON instance_channel_configs
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM agent_instances
      WHERE agent_instances.id = instance_channel_configs.instance_id
        AND can_access_instance(agent_instances.id, auth.uid())
    )
  );

-- 原因：agent_group_members 存放分组成员关系，开启 RLS 后只暴露给平台 admin 和分组成员。
ALTER TABLE agent_group_members ENABLE ROW LEVEL SECURITY;

-- 原因：旧 profile 自查策略要限定在 user principal，避免普通用户直接看到任意 group principal。
DROP POLICY IF EXISTS "Users can view own profile" ON principal_profiles;
CREATE POLICY "Users can view own profile" ON principal_profiles
  FOR SELECT USING (principal_type = 'user' AND id = auth.uid());

-- 原因：OAuth/邮箱首次登录仍允许用户创建自己的 user principal profile。
DROP POLICY IF EXISTS "Users can create own profile" ON principal_profiles;
CREATE POLICY "Users can create own profile" ON principal_profiles
  FOR INSERT WITH CHECK (
    principal_type = 'user'
    AND id = auth.uid()
    AND role = 'user'
    AND status = 'active'
    AND max_agent_instances = 5
    AND consumer_id IS NULL
    AND consumer_apikey_encrypted IS NULL
    AND authorized_http_api_id IS NULL
  );

-- 原因：普通用户只能更新自己的 user profile，敏感列由前面的 trigger 继续保护。
DROP POLICY IF EXISTS "Users can update own profile" ON principal_profiles;
CREATE POLICY "Users can update own profile" ON principal_profiles
  FOR UPDATE USING (principal_type = 'user' AND id = auth.uid())
  WITH CHECK (principal_type = 'user' AND id = auth.uid());

-- 原因：group principal 是分组资料，只有平台 admin 或该分组 active 成员可以查看。
DROP POLICY IF EXISTS "Members can view their groups" ON principal_profiles;
CREATE POLICY "Members can view their groups" ON principal_profiles
  FOR SELECT USING (
    principal_type = 'group'
    AND (
      is_platform_admin(auth.uid())
      OR is_active_group_member(id, auth.uid())
    )
  );

-- 原因：成员关系只能被平台 admin 或同分组成员查看，避免泄漏其他分组的成员列表。
DROP POLICY IF EXISTS "Members can view group memberships" ON agent_group_members;
CREATE POLICY "Members can view group memberships" ON agent_group_members
  FOR SELECT USING (
    is_platform_admin(auth.uid())
    OR is_active_group_member(group_id, auth.uid())
  );

-- 原因：成员角色/status 变化后需要刷新 updated_at，供 UI 排序和审计展示使用。
DROP TRIGGER IF EXISTS set_agent_group_members_updated_at ON agent_group_members;
CREATE TRIGGER set_agent_group_members_updated_at
  BEFORE UPDATE ON agent_group_members
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- get_group_usage_counts(uuid[])
-- 原因：分组列表需要展示已用实例数；批量 RPC 可避免每个分组单独查询造成 N+1。
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
-- 原因：创建分组和写入初始 admin 必须在同一事务内完成。
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

-- 原因：给数据库函数写入 COMMENT 元数据，便于 DBA/Review 在数据库侧直接理解这些函数的职责。
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
