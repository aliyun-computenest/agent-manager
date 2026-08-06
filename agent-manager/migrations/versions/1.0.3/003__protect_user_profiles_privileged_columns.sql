-- Prevent non-admin users from escalating privilege via direct PATCH on
-- user_profiles. The original RLS policy allowed any authenticated user to
-- update their own row including role/status/max_agent_instances/consumer_*,
-- which let a normal user self-promote to admin and bypass terminal /
-- instance authorization checks. Defense layered as:
--   1. RLS policy gains an explicit WITH CHECK so the new row must still
--      satisfy auth.uid() = id (prevents id-rewrite tricks).
--   2. A BEFORE UPDATE trigger blocks any change to privileged columns
--      unless the caller is admin or service_role.
--
-- Service-role connections (server-side admin SDK) and admin users keep full
-- write access. Self-service updates for normal users remain allowed for
-- non-privileged columns (username, is_first_login, etc.).

-- 1) Tighten the existing self-update policy with a WITH CHECK clause.
DROP POLICY IF EXISTS "Users can update own profile" ON user_profiles;
CREATE POLICY "Users can update own profile" ON user_profiles
  FOR UPDATE USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- 2) Trigger function: block privileged-column edits from non-admin users.
CREATE OR REPLACE FUNCTION user_profiles_protect_privileged_columns()
RETURNS TRIGGER AS $$
BEGIN
  -- Server-side / service-role contexts have no auth.uid(); allow them.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  -- Admins keep full edit power (account management, quotas, etc.).
  IF is_admin_check() THEN
    RETURN NEW;
  END IF;

  IF NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION 'user_profiles.role can only be changed by an admin'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'user_profiles.status can only be changed by an admin'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.max_agent_instances IS DISTINCT FROM OLD.max_agent_instances THEN
    RAISE EXCEPTION 'user_profiles.max_agent_instances can only be changed by an admin'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.consumer_id IS DISTINCT FROM OLD.consumer_id THEN
    RAISE EXCEPTION 'user_profiles.consumer_id is system-managed'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.consumer_apikey_encrypted IS DISTINCT FROM OLD.consumer_apikey_encrypted THEN
    RAISE EXCEPTION 'user_profiles.consumer_apikey_encrypted is system-managed'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.authorized_http_api_id IS DISTINCT FROM OLD.authorized_http_api_id THEN
    RAISE EXCEPTION 'user_profiles.authorized_http_api_id is system-managed'
      USING ERRCODE = '42501';
  END IF;

  -- id and email anchor the row identity; preserve them on self-updates as
  -- well (auth.users still owns email; user_profiles only mirrors it).
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'user_profiles.id is immutable'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.email IS DISTINCT FROM OLD.email THEN
    RAISE EXCEPTION 'user_profiles.email is system-managed'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS protect_user_profiles_privileged_columns ON user_profiles;
CREATE TRIGGER protect_user_profiles_privileged_columns
  BEFORE UPDATE ON user_profiles
  FOR EACH ROW
  EXECUTE FUNCTION user_profiles_protect_privileged_columns();

COMMENT ON FUNCTION user_profiles_protect_privileged_columns IS
  'Blocks non-admin authenticated users from modifying privileged columns on user_profiles via direct PATCH. Service-role and admin callers bypass.';
