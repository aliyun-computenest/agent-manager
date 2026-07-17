-- =====================================================
-- Agent Manager - 清理 public schema（仅删除，不重建）
-- 执行方式：在 Supabase SQL Editor 中直接运行
-- 警告：此脚本会删除所有数据，请谨慎使用！
-- =====================================================

-- 设置 schema
set search_path to public;

-- =====================================================
-- 清理现有数据（按依赖顺序删除）
-- =====================================================

-- 删除触发器
drop trigger if exists on_auth_user_created on auth.users;
drop trigger if exists set_updated_at on token_usage_logs;
drop trigger if exists set_updated_at on openclaw_instances;
drop trigger if exists set_updated_at on ai_models;
drop trigger if exists set_updated_at on user_profiles;
drop trigger if exists set_user_profiles_updated_at on user_profiles;
drop trigger if exists set_updated_at on principal_profiles;
drop trigger if exists set_principal_profiles_updated_at on principal_profiles;
drop trigger if exists set_ai_models_updated_at on ai_models;
drop trigger if exists set_openclaw_instances_updated_at on openclaw_instances;

-- 删除函数（使用 CASCADE 处理依赖）
drop function if exists create_user_profile() cascade;
drop function if exists create_or_update_admin_profile() cascade;
drop function if exists is_admin(uuid) cascade;
drop function if exists update_updated_at_column() cascade;
drop function if exists update_user_profiles_timestamp() cascade;
drop function if exists update_principal_profiles_timestamp() cascade;

-- 删除表（按依赖顺序：先删子表，再删父表）
drop table if exists token_usage_logs cascade;
drop table if exists openclaw_instances cascade;
drop table if exists ai_models cascade;
drop table if exists user_profiles cascade;
drop table if exists principal_profiles cascade;

-- =====================================================
-- 清理完成
-- =====================================================

do $$
begin
  raise notice 'public schema 已清理完成，现在可以运行 init_database.sql 进行初始化';
end;
$$;
