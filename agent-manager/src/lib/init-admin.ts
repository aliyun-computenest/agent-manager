/**
 * 初始化管理员账号
 * 在应用启动时自动检查并创建默认管理员账号
 */

import { getSupabase } from './supabase'

const ADMIN_EMAIL = 'admin@openclaw.local'
const ADMIN_PASSWORD = 'admin123'
const ADMIN_USERNAME = 'Admin'

/**
 * 检查并创建默认管理员账号
 * 只在首次运行时创建
 */
export async function initAdminUser(): Promise<void> {
  try {
    const supabase = await getSupabase()
    
    // 步骤 1: 尝试使用管理员账号登录
    const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD
    })
    
    // 如果登录成功，说明管理员已存在，检查是否有 profile
    if (signInData.user) {
      console.log('管理员账号已存在')
      
      // 检查是否已有 profile
      const { data: existingProfile } = await supabase
        .from('principal_profiles')
        .select('id')
        .eq('id', signInData.user.id)
        .eq('principal_type', 'user')
        .maybeSingle()
      
      // 如果没有 profile，创建它
      if (!existingProfile) {
        await supabase.from('principal_profiles').insert({
          id: signInData.user.id,
          principal_type: 'user',
          name: ADMIN_USERNAME,
          email: ADMIN_EMAIL,
          role: 'admin',
          status: 'active',
          max_agent_instances: 999,
          is_first_login: true
        })
        console.log('管理员 profile 已创建')
      }
      return
    }
    
    // 步骤 2: 登录失败，检查错误类型
    const errorMessage = signInError?.message || ''
    
    // 如果是账号不存在或密码错误，尝试创建
    if (errorMessage.includes('Invalid login') || 
        errorMessage.includes('credentials') ||
        errorMessage.includes('not found') ||
        errorMessage.includes('does not exist')) {
      
      console.log('管理员账号不存在，尝试创建...')
      
      // 尝试创建管理员账号
      const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD
      })
      
      if (signUpError) {
        // 如果是因为邮箱已存在（但未确认），忽略错误
        if (signUpError.message.includes('User already registered') ||
            signUpError.message.includes('already been registered')) {
          console.log('管理员账号已注册但未确认，请先确认邮箱或使用 Dashboard 创建')
          return
        }
        // 其他错误，输出提示
        console.error('创建管理员账号失败:', signUpError.message)
        console.log('请通过 Supabase Dashboard > Authentication > Users 手动创建管理员账号')
        return
      }
      
      if (signUpData.user) {
        // 创建用户资料
        try {
          await supabase.from('principal_profiles').insert({
            id: signUpData.user.id,
            principal_type: 'user',
            name: ADMIN_USERNAME,
            email: ADMIN_EMAIL,
            role: 'admin',
            status: 'active',
            max_agent_instances: 999,
            is_first_login: true
          })
          console.log('默认管理员账号创建成功')
        } catch (profileError) {
          console.error('创建用户资料失败:', profileError)
          console.log('请登录 Supabase Dashboard 运行 migrations/recreate_admin_user.sql 脚本')
        }
      }
    } else {
      // 其他登录错误
      console.error('登录检查失败:', signInError)
    }
  } catch (error) {
    // 静默失败，不影响应用启动
    console.error('初始化管理员账号失败:', error)
  }
}
