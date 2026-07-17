/**
 * 以 service role 连接测试 Supabase，用于测试中的数据断言与清理。
 * 仅测试代码使用，切勿在生产代码中引用。
 */
import { createClient } from '@supabase/supabase-js'
import { testEnv } from '../setup/test-env.js'

export const testSupabaseAdmin = createClient(testEnv.supabaseUrl, testEnv.serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

/** 按前缀批量删除表中记录，用于 afterAll 兜底清理 */
export async function deleteByPrefix(table, column, prefix) {
  const { error } = await testSupabaseAdmin.from(table).delete().like(column, `${prefix}%`)
  if (error) {
    console.warn(`[cleanup] delete ${table}.${column} like ${prefix}% 失败: ${error.message}`)
  }
}
