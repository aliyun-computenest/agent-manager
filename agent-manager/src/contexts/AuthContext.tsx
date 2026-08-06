import { createContext, useContext, useEffect, useState, ReactNode } from 'react'
import { User, Session, Provider } from '@supabase/supabase-js'
import { getSupabase, isSupabaseConfigured } from '../lib/supabase'
import { resolveOAuthProfileEmail } from '../lib/oauth-profile-email'
import { getOAuthProviderScopes } from '../lib/oauth-provider-scopes'
import { isProfileCreationDenied } from '../lib/auth-profile-errors'
import type { SupportedOAuthProvider } from '../lib/oauth-provider-scopes'
import i18next from 'i18next'

interface UserProfile {
  id: string
  username: string
  email: string
  role: 'admin' | 'user'
  status: 'active' | 'disabled'
  max_agent_instances: number
}

const UserProfileSelect = 'id, username:name, email, role, status, max_agent_instances'

export interface OAuthProvider {
  provider: string
  enabled: boolean
}

type RuntimeEnvWindow = Window & { __ENV__?: Record<string, string | undefined> }

interface AuthContextType {
  user: User | null
  session: Session | null
  profile: UserProfile | null
  loading: boolean
  error: string | null
  isConfigured: boolean
  signIn: (email: string, password: string) => Promise<{ error: Error | null }>
  signInWithOAuth: (provider: SupportedOAuthProvider) => Promise<{ error: Error | null }>
  signInWithSSO: (domain: string) => Promise<{ error: Error | null; url?: string }>
  getEnabledOAuthProviders: () => Promise<OAuthProvider[]>
  signOut: () => Promise<void>
  refreshProfile: () => Promise<void>
  isRecovery: boolean
  clearRecovery: () => void
  updatePassword: (newPassword: string) => Promise<{ error: Error | null }>
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isConfigured, setIsConfigured] = useState(true)
  const [isRecovery, setIsRecovery] = useState(false)

  const showUnauthorizedLogin = async () => {
    console.warn('[AuthContext] 用户没有可用 profile，显示无权限登录界面')
    setProfile(null)
    setError(i18next.t('auth:errors.unauthorizedLogin'))
    await forceSignOut()
    if (window.location.pathname !== '/login' || !window.location.search.includes('error=unauthorized')) {
      window.location.replace('/login?error=unauthorized')
    }
  }

  const fetchProfile = async (userId: string, authUser?: User) => {
    console.log('[AuthContext] 开始获取用户 profile，userId:', userId)
    try {
      const supabase = await getSupabase()
      const { data, error } = await supabase
        .from('principal_profiles')
        .select(UserProfileSelect)
        .eq('id', userId)
        .eq('principal_type', 'user')
        .maybeSingle()

      console.log('[AuthContext] profile 查询结果:', { data, error })
      if (error) throw error

      // 没有预置 profile 时，OAuth/SSO 用户尝试自动创建；权限策略拒绝时视为不可用账号。
      if (!data && authUser) {
        const isExternalAuth = authUser.app_metadata?.provider &&
          authUser.app_metadata.provider !== 'email'

        if (isExternalAuth) {
          console.log('[AuthContext] OAuth/SSO 用户首次登录，自动创建 profile')
          const newProfile = await ensureExternalUserProfile(authUser)

          if (!newProfile) {
            await showUnauthorizedLogin()
            return
          }

          // 检查新创建的 profile 是否被禁用
          if (newProfile.status === 'disabled') {
            console.warn('[AuthContext] 用户账号已被禁用，自动登出')
            setProfile(null)
            setError(i18next.t('auth:errors.accountDisabled'))
            await forceSignOut()
            return
          }

          setProfile(newProfile)
          return
        }

        await showUnauthorizedLogin()
        return
      }

      // 检查用户状态：如果被禁用，立即登出并设置错误信息
      if (data && (data as UserProfile).status === 'disabled') {
        console.warn('[AuthContext] 用户账号已被禁用，自动登出:', userId)
        setProfile(null)
        setError(i18next.t('auth:errors.accountDisabled'))
        await forceSignOut()
        return
      }

      // 如果是 OAuth/SSO 用户且有 profile，更新用户信息
      if (data && authUser) {
        const isExternalAuth = authUser.app_metadata?.provider &&
          authUser.app_metadata.provider !== 'email'

        if (isExternalAuth) {
          const updatedProfile = await updateExternalUserProfile(authUser, data as UserProfile)
          if (updatedProfile) {
            setProfile(updatedProfile)
            return
          }
        }
      }

      setProfile(data as UserProfile | null)
      console.log('[AuthContext] profile 设置完成:', data)
    } catch (err) {
      console.error('[AuthContext] Failed to fetch profile:', err)
    }
  }

  // 强制登出（不清除 error 状态）
  const forceSignOut = async () => {
    setUser(null)
    setSession(null)
    setLoading(false)
    try {
      const supabase = await getSupabase()
      await supabase.auth.signOut()
    } catch (err) {
      console.error('[AuthContext] forceSignOut API 调用失败:', err)
    }
  }

  // 为 OAuth/SSO 用户创建 profile
  const ensureExternalUserProfile = async (authUser: User): Promise<UserProfile | null> => {
    try {
      const supabase = await getSupabase()

      // 从 user_metadata 提取用户信息
      const metadata = authUser.user_metadata || {}
      const provider = authUser.app_metadata?.provider || ''
      const providerId = metadata.provider_id || metadata.sub || ''

      // 用户名：保留原始名称（中文/英文都行），用于辨识
      const username = metadata.name ||
                       metadata.full_name ||
                       metadata.preferred_username ||
                       metadata.user_name ||
                       providerId ||
                       authUser.email?.split('@')[0] ||
                       'user'

      // 邮箱处理：优先使用 OAuth provider 返回的真实邮箱，避免展示 provider 生成的占位邮箱。
      let email = resolveOAuthProfileEmail({ provider, authEmail: authUser.email, metadata })

      const isAlibabacloudOAuth = provider === 'alibabacloud' &&
                                   email?.endsWith('@alibabacloud.com')
      if (isAlibabacloudOAuth) {
        const upn = metadata.upn || metadata.login_name
        if (upn) {
          email = upn
        } else {
          // 邮箱前缀用 provider_id（纯英文），不用中文用户名
          email = `${providerId || username}@alibabacloud.oauth`
        }
      }

      // 基础字段（不包含可能不存在的列）
      const newProfile: Record<string, unknown> = {
        id: authUser.id,
        principal_type: 'user',
        name: username,
        email: email || `${authUser.id}@sso.local`,
        role: 'user',
        status: 'active',
        max_agent_instances: 5,
        is_first_login: true
      }

      console.log('[AuthContext] 创建 OAuth/SSO 用户 profile:', newProfile)

      const { data, error } = await supabase
        .from('principal_profiles')
        .insert(newProfile)
        .select(UserProfileSelect)
        .single()

      if (error) {
        console.error('[AuthContext] 创建 profile 失败:', error)
        if (isProfileCreationDenied(error)) {
          return null
        }
        throw error
      }

      console.log('[AuthContext] OAuth/SSO 用户 profile 创建成功:', data)
      return data as UserProfile
    } catch (err) {
      console.error('[AuthContext] ensureExternalUserProfile 异常:', err)
      throw err
    }
  }

  // 更新 OAuth/SSO 用户的 profile 信息
  const updateExternalUserProfile = async (authUser: User, existingProfile: UserProfile): Promise<UserProfile | null> => {
    try {
      const supabase = await getSupabase()

      // 从 user_metadata 提取最新用户信息
      const metadata = authUser.user_metadata || {}
      const provider = authUser.app_metadata?.provider || ''

      const providerId = metadata.provider_id || metadata.sub || ''

      // 用户名：保留原始名称（中文/英文都行）
      const newUsername = metadata.name ||
                          metadata.full_name ||
                          metadata.preferred_username ||
                          metadata.user_name

      let newEmail = resolveOAuthProfileEmail({ provider, authEmail: authUser.email, metadata })

      const isAlibabacloudOAuth = provider === 'alibabacloud' &&
                                   newEmail?.endsWith('@alibabacloud.com')
      if (isAlibabacloudOAuth) {
        const upn = metadata.upn || metadata.login_name
        if (upn) {
          newEmail = upn
        } else {
          newEmail = `${providerId || newUsername || existingProfile.username}@alibabacloud.oauth`
        }
      }

      // 检查是否需要更新
      const needsUpdate = (newUsername && newUsername !== existingProfile.username) ||
                          (newEmail && newEmail !== existingProfile.email)

      if (!needsUpdate) {
        console.log('[AuthContext] OAuth/SSO 用户信息无变化，跳过更新')
        return null
      }

      const updates: Record<string, unknown> = {}
      if (newUsername && newUsername !== existingProfile.username) {
        updates.name = newUsername
      }
      if (newEmail && newEmail !== existingProfile.email) {
        updates.email = newEmail
      }

      console.log('[AuthContext] 更新 OAuth/SSO 用户 profile:', updates)

      const { data, error } = await supabase
        .from('principal_profiles')
        .update(updates)
        .eq('id', authUser.id)
        .eq('principal_type', 'user')
        .select(UserProfileSelect)
        .single()

      if (error) {
        console.error('[AuthContext] 更新 profile 失败:', error)
        return null
      }

      console.log('[AuthContext] OAuth/SSO 用户 profile 更新成功:', data)
      return data as UserProfile
    } catch (err) {
      console.error('[AuthContext] updateExternalUserProfile 异常:', err)
      return null
    }
  }

  useEffect(() => {
    // fetchProfile with timeout wrapper to prevent infinite loading
    const fetchProfileWithTimeout = async (userId: string, authUser?: User, timeoutMs = 10000) => {
      try {
        await Promise.race([
          fetchProfile(userId, authUser),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error('fetchProfile timeout')), timeoutMs)
          )
        ])
      } catch (err) {
        console.warn('[AuthContext] fetchProfile timed out or failed:', (err as Error).message)
      }
    }

    const initAuth = async () => {
      console.log('[AuthContext] 开始初始化认证...')
      // CRITICAL: 先检查 Supabase 是否配置
      if (!isSupabaseConfigured()) {
        console.log('[AuthContext] Supabase 未配置')
        setIsConfigured(false)
        setLoading(false)
        return
      }

      try {
        const supabase = await getSupabase()

        // Check URL hash for recovery type BEFORE Supabase processes/clears it
        const hashParams = new URLSearchParams(window.location.hash.substring(1))
        if (hashParams.get('type') === 'recovery') {
          console.log('[AuthContext] 检测到 URL hash 中 type=recovery，标记恢复模式')
          setIsRecovery(true)
        }

        // Flag to prevent onAuthStateChange from redundantly fetching profile during
        // initial load. Without this, Supabase's INITIAL_SESSION event triggers a
        // profile fetch inside the callback, and then getSession() below triggers
        // ANOTHER profile fetch — causing ~2x load time (6-10+ seconds).
        let initialLoadComplete = false

        // Set up onAuthStateChange FIRST so events from getSession/detectSessionInUrl are captured
        const { data: { subscription } } = supabase.auth.onAuthStateChange(
          async (event, session) => {
            console.log('[AuthContext] 认证状态变化:', { event, session: !!session, user: session?.user?.email })
            if (event === 'PASSWORD_RECOVERY') {
              setIsRecovery(true)
            }
            setSession(session)
            setUser(session?.user ?? null)

            // During initial load, skip profile fetch here — it will be handled
            // by the getSession() flow below (for non-hash) or after we set
            // initialLoadComplete=true (for hash tokens).
            // This eliminates the redundant double-fetch that causes slow loading.
            if (!initialLoadComplete) {
              console.log('[AuthContext] 初始化阶段，跳过 onAuthStateChange profile 获取')
              return
            }

            // Handle subsequent auth events (sign-in, sign-out, token refresh, etc.)
            if (session?.user) {
              // For USER_UPDATED (triggered by updateUser/password change),
              // fire-and-forget to prevent blocking the updateUser promise chain
              if (event === 'USER_UPDATED') {
                fetchProfile(session.user.id, session.user).catch(err => {
                  console.error('[AuthContext] fetchProfile after USER_UPDATED failed:', err)
                })
              } else {
                await fetchProfileWithTimeout(session.user.id, session.user)
              }
            } else {
              setProfile(null)
            }
            setLoading(false)
          }
        )

        // Do NOT manually call setSession() with hash tokens here.
        // The Supabase client (detectSessionInUrl: true) already handles URL hash tokens
        // internally via _initialize(). Manually calling setSession creates a lock
        // contention that causes "Lock not released within 5000ms" errors.
        // The onAuthStateChange handler above will receive PASSWORD_RECOVERY / SIGNED_IN
        // events automatically when Supabase processes the URL hash.

        // For non-hash cases (page reload with existing session), getSession still works:
        const hasHashTokens = !!hashParams.get('access_token')
        if (!hasHashTokens) {
          const { data: { session } } = await supabase.auth.getSession()
          console.log('[AuthContext] getSession 结果:', { session: !!session, user: session?.user?.email })
          setSession(session)
          setUser(session?.user ?? null)

          if (session?.user) {
            console.log('[AuthContext] 用户已登录，开始获取 profile:', session.user.id)
            await fetchProfileWithTimeout(session.user.id, session.user)
          } else {
            console.log('[AuthContext] 用户未登录')
          }

          // Mark initial load complete BEFORE setting loading=false
          // so subsequent onAuthStateChange events are handled normally
          initialLoadComplete = true
          setLoading(false)
          console.log('[AuthContext] 初始化完成，loading=false')
        } else {
          console.log('[AuthContext] 检测到 URL hash tokens，等待 Supabase 自动处理...')
          // Mark initial load complete so onAuthStateChange handles
          // the upcoming SIGNED_IN event (including profile fetch)
          initialLoadComplete = true
          // Clean the URL hash after a short delay to avoid exposing tokens
          setTimeout(() => {
            window.history.replaceState({}, document.title, window.location.pathname)
          }, 1000)
        }

        return () => subscription.unsubscribe()
      } catch (err) {
        console.error('[AuthContext] Auth initialization failed:', err)
        setError(err instanceof Error ? err.message : i18next.t('auth:errors.loginFailed'))
        setLoading(false)
      }
    }
    initAuth()

    // Global safety valve: never let loading hang forever
    const safetyTimer = setTimeout(() => {
      setLoading(prev => {
        if (prev) {
          console.warn('[AuthContext] Global loading timeout (15s), forcing loading=false')
          return false
        }
        return prev
      })
    }, 15000)
    return () => clearTimeout(safetyTimer)
    // Auth bootstrap owns the Supabase subscription lifecycle and should run once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const signIn = async (email: string, password: string) => {
    console.log('[AuthContext] signIn called:', { email, passwordLength: password.length })
    setError(null)
    try {
      const supabase = await getSupabase()
      console.log('[AuthContext] Supabase client obtained')
      const { data, error } = await supabase.auth.signInWithPassword({ email, password })
      console.log('[AuthContext] signInWithPassword result:', { data: !!data, error: error?.message, errorDetails: error })

      if (error) {
        const msg = error.message?.toLowerCase() || ''
        if (msg.includes('banned') || msg.includes('disabled')) {
          return { error: new Error(i18next.t('auth:errors.accountDisabled')) }
        }
        return { error }
      }

      // Explicitly update state after successful sign-in
      // This ensures state is set even if onAuthStateChange fires late
      if (data?.session) {
        setSession(data.session)
        setUser(data.user ?? null)
        if (data.user) {
          // Fire-and-forget: don't await fetchProfile to prevent signIn from hanging
          // Profile will also be loaded by onAuthStateChange handler
          fetchProfile(data.user.id, data.user).catch(err => {
            console.error('[AuthContext] fetchProfile in signIn failed:', err)
          })
        }
      }

      return { error: null }
    } catch (err) {
      return { error: err instanceof Error ? err : new Error(i18next.t('auth:errors.loginFailed')) }
    }
  }

  const signInWithOAuth = async (provider: SupportedOAuthProvider) => {
    console.log('[AuthContext] signInWithOAuth called:', { provider })
    try {
      const supabase = await getSupabase()
      const scopes = getOAuthProviderScopes(provider)
      const { error } = await supabase.auth.signInWithOAuth({
        // Supabase SDK 的 Provider 类型未包含自定义 OAuth provider；运行时 provider 已由 GoTrue 配置支持。
        provider: provider as Provider,
        options: {
          redirectTo: `${window.location.origin}/login`,
          scopes
        }
      })
      console.log('[AuthContext] signInWithOAuth result:', { error: error?.message })
      return { error }
    } catch (err) {
      console.error('[AuthContext] signInWithOAuth exception:', err)
      return { error: err instanceof Error ? err : new Error(i18next.t('auth:errors.oauthLoginFailed')) }
    }
  }

  const getEnabledOAuthProviders = async (): Promise<OAuthProvider[]> => {
    try {
      const windowEnv = (window as RuntimeEnvWindow).__ENV__
      const supabaseUrl = (windowEnv && windowEnv['VITE_SUPABASE_URL']) || import.meta.env.VITE_SUPABASE_URL
      const anonKey = (windowEnv && windowEnv['VITE_SUPABASE_ANON_KEY']) || import.meta.env.VITE_SUPABASE_ANON_KEY

      if (!supabaseUrl || !anonKey) {
        console.error('[AuthContext] Supabase URL or anon key not configured')
        return []
      }

      const response = await fetch(`${supabaseUrl}/auth/v1/settings`, {
        headers: {
          'apikey': anonKey,
          'Authorization': `Bearer ${anonKey}`
        }
      })

      if (!response.ok) {
        console.error('[AuthContext] Failed to fetch auth settings:', response.status)
        return []
      }

      const settings = await response.json()
      const excludeProviders = ['email', 'phone', 'anonymous_users']
      const enabledProviders: OAuthProvider[] = []
      const addProvider = (providerName: string) => {
        if (!excludeProviders.includes(providerName) && !enabledProviders.some((p) => p.provider === providerName)) {
          enabledProviders.push({ provider: providerName, enabled: true })
        }
      }

      Object.entries(settings).forEach(([key, value]) => {
        const match = key.match(/^external_(\w+)_enabled$/)
        if (match && value === true) {
          addProvider(match[1])
        }
      })

      if (settings.external && typeof settings.external === 'object') {
        Object.entries(settings.external).forEach(([providerName, enabled]) => {
          if (enabled === true) {
            addProvider(providerName)
          }
        })
      }

      return enabledProviders
    } catch (err) {
      console.error('[AuthContext] getEnabledOAuthProviders exception:', err)
      return []
    }
  }

  const signInWithSSO = async (domain: string) => {
    console.log('[AuthContext] signInWithSSO called:', { domain })
    try {
      const supabase = await getSupabase()
      const { data, error } = await supabase.auth.signInWithSSO({
        domain,
        options: {
          redirectTo: window.location.origin
        }
      })

      if (error) {
        console.error('[AuthContext] signInWithSSO error:', error)
        return { error }
      }

      // SSO 返回重定向 URL
      if (data?.url) {
        console.log('[AuthContext] SSO redirect URL:', data.url)
        window.location.href = data.url
      }

      return { error: null, url: data?.url }
    } catch (err) {
      console.error('[AuthContext] signInWithSSO exception:', err)
      return { error: err instanceof Error ? err : new Error(i18next.t('auth:errors.ssoLoginFailed')) }
    }
  }

  const signOut = async () => {
    if (!isSupabaseConfigured()) return
    // 先立即清除本地状态，确保 UI 立刻响应退出
    setUser(null)
    setSession(null)
    setProfile(null)
    setError(null)
    // 再异步调用 Supabase signOut（清除服务端 session），不阻塞 UI
    try {
      const supabase = await getSupabase()
      await supabase.auth.signOut()
    } catch (err) {
      console.error('[AuthContext] signOut API 调用失败（可能 token 已过期），本地状态已清除:', err)
    }
  }

  const _resetPassword = async (email: string) => {
    try {
      const supabase = await getSupabase()
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/user/reset-password`
      })
      return { error }
    } catch (err) {
      return { error: err instanceof Error ? err : new Error(i18next.t('auth:errors.resetPasswordFailed')) }
    }
  }

  const refreshProfile = async () => {
    if (user) {
      await fetchProfile(user.id, user)
    }
  }

  const updatePassword = async (newPassword: string) => {
    try {
      const supabase = await getSupabase()

      // Wait for auth session to be ready (setSession may still be in progress
      // when isRecovery renders the form before initAuth completes)
      for (let i = 0; i < 20; i++) {
        const { data: { session: s } } = await supabase.auth.getSession()
        if (s) break
        await new Promise(r => setTimeout(r, 500))
      }

      // Add timeout to prevent indefinite hang (e.g., if onAuthStateChange blocks)
      const result = await Promise.race([
        supabase.auth.updateUser({ password: newPassword }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(i18next.t('auth:errors.passwordChangeTimeout'))), 15000)
        ),
      ])
      // Don't clear isRecovery here — let the caller (ResetPassword) show
      // the success message before navigating away.
      return { error: result.error }
    } catch (err) {
      return { error: err instanceof Error ? err : new Error(i18next.t('auth:errors.passwordChangeFailed')) }
    }
  }

  return (
    <AuthContext.Provider value={{
      user,
      session,
      profile,
      loading,
      error,
      isConfigured,
      signIn,
      signInWithOAuth,
      signInWithSSO,
      getEnabledOAuthProviders,
      signOut,
      refreshProfile,
      isRecovery,
      clearRecovery: () => setIsRecovery(false),
      updatePassword,
    }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used within AuthProvider')
  return context
}
