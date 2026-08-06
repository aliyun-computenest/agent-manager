import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth, OAuthProvider } from '../../contexts/AuthContext'
import { apiUrl } from '../../lib/api'
import type { SupportedOAuthProvider } from '../../lib/oauth-provider-scopes'
import { Mail, Lock, Loader2, Github, Cloud, Shield, MessageCircle } from 'lucide-react'

// SSO Provider 类型
interface SSOProvider {
  id: string
  domains: { domain: string }[]
}

interface AuthProps {
  onSuccess?: () => void
}

export default function Auth({ onSuccess }: AuthProps) {
  const { t } = useTranslation('auth')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [oauthLoading, setOauthLoading] = useState(false)
  const [ssoLoading, setSsoLoading] = useState(false)
  const [oauthProviders, setOauthProviders] = useState<OAuthProvider[]>([])
  const [ssoProviders, setSsoProviders] = useState<SSOProvider[]>([])
  const { signIn, signInWithOAuth, signInWithSSO, getEnabledOAuthProviders } = useAuth()

  // OAuth 提供商图标、颜色和显示名称配置
  const providerConfig: Record<string, { icon: React.ReactNode; bgColor: string; displayName: string }> = {
    github: { icon: <Github className="h-5 w-5" />, bgColor: 'bg-gray-900 hover:bg-gray-800', displayName: t('oauth.github') },
    alibabacloud: { icon: <Cloud className="h-5 w-5" />, bgColor: 'bg-orange-500 hover:bg-orange-600', displayName: t('oauth.alibabaCloud') },
    feishu: { icon: <MessageCircle className="h-5 w-5" />, bgColor: 'bg-blue-600 hover:bg-blue-700', displayName: t('oauth.feishu') },
    dingtalk: { icon: <MessageCircle className="h-5 w-5" />, bgColor: 'bg-sky-500 hover:bg-sky-600', displayName: t('oauth.dingtalk') }
  }

  // 根据管理员设置的 SSO 模式加载对应的登录方式
  useEffect(() => {
    const loadLoginProviders = async () => {
      try {
        // 先获取管理员设置的 SSO 模式
        const modeResp = await fetch(`${apiUrl}/api/sso/mode/public`)
        let ssoMode = 'none'
        if (modeResp.ok) {
          const modeData = await modeResp.json()
          ssoMode = modeData.mode || 'none'
        }

        // 只有启用了 SAML 模式才加载 SAML providers
        if (ssoMode === 'saml') {
          setOauthProviders([])
          const resp = await fetch(`${apiUrl}/api/sso/providers/public`)
          if (resp.ok) {
            const data = await resp.json()
            if (data.success && data.providers) {
              setSsoProviders(data.providers)
            }
          }
        } else if (ssoMode === 'oauth') {
          const providers = await getEnabledOAuthProviders()
          setOauthProviders(providers)
          setSsoProviders([])
        } else {
          setOauthProviders([])
          setSsoProviders([])
        }
      } catch (err) {
        console.error('Failed to load login providers:', err)
      }
    }
    loadLoginProviders()
  }, [getEnabledOAuthProviders])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)

    const { error } = await signIn(email, password)

    if (error) {
      setError(error.message)
    } else if (onSuccess) {
      onSuccess()
    }

    setLoading(false)
  }

  const handleOAuthLogin = async (provider: string) => {
    setOauthLoading(true)
    setError(null)

    // 支持 Supabase 内置 provider 和阿里云 Supabase 扩展的 alibabacloud provider
    const { error } = await signInWithOAuth(provider as SupportedOAuthProvider)

    if (error) {
      setError(error.message)
      setOauthLoading(false)
    }
    // OAuth 登录成功后会重定向，不需要手动处理
  }

  const handleSSOLogin = async (domain: string) => {
    setSsoLoading(true)
    setError(null)

    const { error } = await signInWithSSO(domain)

    if (error) {
      setError(error.message)
      setSsoLoading(false)
    }
    // SSO 登录成功后会重定向到 IdP
  }

  // 获取所有启用的 OAuth 提供商
  const enabledProviders = oauthProviders.filter(p => providerConfig[p.provider])

  // OAuth 和 SAML 互斥展示：优先展示实际配置的那个
  const showOAuth = enabledProviders.length > 0 && ssoProviders.length === 0
  const showSAML = ssoProviders.length > 0

  return (
    <div className="w-full max-w-md mx-auto p-6">
      <div className="bg-white rounded-2xl shadow-xl p-8">
        <div className="text-center mb-8">
          <h2 className="text-3xl font-bold text-gray-900 mb-2">
            {t('welcomeBack')}
          </h2>
          <p className="text-gray-600">
            {t('loginSubtitle')}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="relative">
            <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400" />
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder={t('placeholders.email')}
              required
              className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
            />
          </div>

          <div className="relative">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400" />
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder={t('placeholders.password')}
              required
              className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
            />
          </div>

          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
          >
            {loading && <Loader2 className="h-5 w-5 animate-spin" />}
            {loading ? t('login.processing') : t('login.login')}
          </button>
        </form>

        {/* OAuth 登录分隔线和按钮 */}
        {showOAuth && (
          <>
            <div className="relative my-6">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-gray-300" />
              </div>
              <div className="relative flex justify-center text-sm">
                <span className="bg-white px-4 text-gray-500">{t('or')}</span>
              </div>
            </div>

            <div className="space-y-3">
              {enabledProviders.map(provider => {
                const config = providerConfig[provider.provider]
                return (
                  <button
                    key={provider.id}
                    type="button"
                    onClick={() => handleOAuthLogin(provider.provider)}
                    disabled={oauthLoading}
                    className={`w-full py-3 text-white font-semibold rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2 ${config.bgColor}`}
                  >
                    {oauthLoading ? (
                      <Loader2 className="h-5 w-5 animate-spin" />
                    ) : (
                      config.icon
                    )}
                    {oauthLoading ? t('redirecting') : config.displayName}
                  </button>
                )
              })}
            </div>
          </>
        )}

        {/* SAML SSO 企业登录 */}
        {showSAML && (
          <>
            <div className="relative my-6">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-gray-300" />
              </div>
              <div className="relative flex justify-center text-sm">
                <span className="bg-white px-4 text-gray-500">{t('sso.enterpriseSSO')}</span>
              </div>
            </div>

            {ssoProviders.map(provider => {
              const domain = provider.domains?.[0]?.domain || ''
              return (
                <button
                  key={provider.id}
                  type="button"
                  onClick={() => handleSSOLogin(domain)}
                  disabled={ssoLoading}
                  className="w-full py-3 bg-blue-700 hover:bg-blue-800 text-white font-semibold rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
                >
                  {ssoLoading ? (
                    <Loader2 className="h-5 w-5 animate-spin" />
                  ) : (
                    <Shield className="h-5 w-5" />
                  )}
                  {ssoLoading ? t('redirecting') : t('sso.ssoLoginWithDomain', { domain })}
                </button>
              )
            })}
            <p className="text-xs text-gray-500 text-center mt-2">
              {t('sso.ssoHelpText')}
            </p>
          </>
        )}

        <div className="mt-6 text-center text-sm text-gray-500">
          <p>{t('accountCreatedByAdminPrefix')}</p>
          <p className="mt-1">{t('contactAdmin')}</p>
        </div>
      </div>
    </div>
  )
}
