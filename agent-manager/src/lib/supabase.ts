import { createClient, SupabaseClient } from '@supabase/supabase-js'

let supabaseInstance: SupabaseClient | null = null
let initPromise: Promise<SupabaseClient> | null = null

/**
 * 获取环境变量
 * 优先级：Docker 运行时注入的 window.__ENV__ > Vite 构建时 import.meta.env
 */
export function getEnvVar(key: string): string | undefined {
  // Docker 运行时注入
  const windowEnv = (window as unknown as Record<string, unknown>).__ENV__ as Record<string, string> | undefined
  if (windowEnv && windowEnv[key]) {
    return windowEnv[key]
  }
  // Vite 开发/构建时注入
  return (import.meta.env as Record<string, string>)?.[key]
}

/**
 * 根据 app_id 生成 schema 名称
 * 规则：将连字符替换为下划线，移除非字母数字下划线字符
 */
function getSchemaName(appId: string): string {
  return appId.replace(/-/g, '_').replace(/[^a-zA-Z0-9_]/g, '')
}

/**
 * 检查 Supabase 是否已配置（CRITICAL - 必须提供此函数）
 * 用于在调用 getSupabase() 前进行预检查，实现优雅降级
 */
export function isSupabaseConfigured(): boolean {
  const supabaseUrl = getEnvVar('VITE_SUPABASE_URL')
  const supabaseAnonKey = getEnvVar('VITE_SUPABASE_ANON_KEY')
  return !!(supabaseUrl && supabaseAnonKey)
}

export async function getSupabase(): Promise<SupabaseClient> {
  if (supabaseInstance) return supabaseInstance
  if (initPromise) return initPromise
  
  // 创建初始化 Promise，防止并发创建多个实例
  initPromise = (async (): Promise<SupabaseClient> => {
    try {
      const supabaseUrl = getEnvVar('VITE_SUPABASE_URL')
      const supabaseAnonKey = getEnvVar('VITE_SUPABASE_ANON_KEY')
      const appId = getEnvVar('VITE_APP_ID')
      
      if (!supabaseUrl || !supabaseAnonKey) {
        console.error('[getSupabase] Missing env vars:', { hasUrl: !!supabaseUrl, hasKey: !!supabaseAnonKey })
        throw new Error('Missing Supabase environment variables. Please check .env file has VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.')
      }
      
      const schema = appId ? getSchemaName(appId) : 'public'
      
      const client = createClient(supabaseUrl, supabaseAnonKey, {
        db: { schema },
        auth: {
          flowType: 'implicit',
          detectSessionInUrl: true,
          persistSession: true,
          autoRefreshToken: true,
        }
      }) as SupabaseClient
      supabaseInstance = client
      return client
    } catch (err) {
      // 失败时重置，允许下次重试
      initPromise = null
      throw err
    }
  })()
  
  return initPromise
}
