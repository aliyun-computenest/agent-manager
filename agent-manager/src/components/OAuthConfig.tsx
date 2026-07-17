import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { 
  Loader2, Settings, AlertCircle, CheckCircle2, 
  ExternalLink, RefreshCw, Cloud, Github, Mail, Globe
} from 'lucide-react'

/**
 * 运行时获取环境变量。必须在函数体内部读取 window.__ENV__，
 * 避免 Vite 构建时将 import.meta.env 静态折叠为 void 0。
 */
function getEnvVar(key: string): string {
  const w = (window as Record<string, unknown>).__ENV__ as Record<string, string> | undefined
  if (w && w[key]) return w[key]
  try { return (import.meta as any).env?.[key] ?? '' } catch { return '' }
}

interface OAuthProvider {
  name: string
  enabled: boolean
}

// 提供商显示信息（label 在组件内通过 t() 解析）
const providerInfo: Record<string, { icon: React.ReactNode; color: string }> = {
  alibabacloud: { 
    icon: <Cloud className="w-5 h-5" />,
    color: 'bg-orange-500'
  },
  github: { 
    icon: <Github className="w-5 h-5" />,
    color: 'bg-gray-800'
  },
  google: { 
    icon: <Mail className="w-5 h-5" />,
    color: 'bg-red-500'
  },
  azure: { 
    icon: <Globe className="w-5 h-5" />,
    color: 'bg-blue-600'
  },
  gitlab: { 
    icon: <Globe className="w-5 h-5" />,
    color: 'bg-orange-600'
  },
  bitbucket: { 
    icon: <Globe className="w-5 h-5" />,
    color: 'bg-blue-500'
  },
  discord: { 
    icon: <Globe className="w-5 h-5" />,
    color: 'bg-indigo-500'
  },
  facebook: { 
    icon: <Globe className="w-5 h-5" />,
    color: 'bg-blue-700'
  },
  twitter: { 
    icon: <Globe className="w-5 h-5" />,
    color: 'bg-sky-500'
  },
  apple: { 
    icon: <Globe className="w-5 h-5" />,
    color: 'bg-gray-900'
  },
  slack: { 
    icon: <Globe className="w-5 h-5" />,
    color: 'bg-purple-600'
  },
  spotify: { 
    icon: <Globe className="w-5 h-5" />,
    color: 'bg-green-500'
  },
  twitch: { 
    icon: <Globe className="w-5 h-5" />,
    color: 'bg-purple-500'
  },
  workos: { 
    icon: <Globe className="w-5 h-5" />,
    color: 'bg-indigo-600'
  },
  keycloak: { 
    icon: <Globe className="w-5 h-5" />,
    color: 'bg-gray-600'
  },
  linkedin: { 
    icon: <Globe className="w-5 h-5" />,
    color: 'bg-blue-800'
  },
  notion: { 
    icon: <Globe className="w-5 h-5" />,
    color: 'bg-gray-800'
  },
  zoom: { 
    icon: <Globe className="w-5 h-5" />,
    color: 'bg-blue-500'
  },
  figma: { 
    icon: <Globe className="w-5 h-5" />,
    color: 'bg-purple-500'
  },
  kakao: { 
    icon: <Globe className="w-5 h-5" />,
    color: 'bg-yellow-400'
  },
}

export default function OAuthConfig({ embedded = false }: { embedded?: boolean }) {
  const { t } = useTranslation('admin')
  const [providers, setProviders] = useState<OAuthProvider[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

  const fetchProviders = async () => {
    try {
      setLoading(true)
      setError(null)
      
      const supabaseUrl = getEnvVar('VITE_SUPABASE_URL')
      const anonKey = getEnvVar('VITE_SUPABASE_ANON_KEY')
      
      // 从 Supabase auth/v1/settings 获取真实配置
      const response = await fetch(`${supabaseUrl}/auth/v1/settings`, {
        headers: {
          'apikey': anonKey,
          'Authorization': `Bearer ${anonKey}`
        }
      })
      
      if (!response.ok) {
        throw new Error(t('oauthConfig.errors.fetchFailed', { status: response.status }))
      }
      
      const settings = await response.json()
      
      // 解析启用的 OAuth 提供商
      // API 返回格式是 external_xxx_enabled: true
      const enabledProviders: OAuthProvider[] = []
      const excludeProviders = ['email', 'phone', 'anonymous_users']
      
      Object.entries(settings).forEach(([key, value]) => {
        // 匹配 external_xxx_enabled 格式
        const match = key.match(/^external_(\w+)_enabled$/)
        if (match && value === true) {
          const providerName = match[1]
          // 排除非 OAuth 的内置认证方式
          if (!excludeProviders.includes(providerName)) {
            enabledProviders.push({
              name: providerName,
              enabled: true
            })
          }
        }
      })
      
      setProviders(enabledProviders)
      setLastUpdated(new Date())
    } catch (err) {
      setError(err instanceof Error ? err.message : t('oauthConfig.errors.fetchOAuthFailed'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchProviders()
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* 页面标题 - 独立页面时显示 */}
      {!embedded && (
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{t('oauthConfig.title')}</h1>
            <p className="mt-1 text-sm text-gray-500">
              {t('oauthConfig.description')}
            </p>
          </div>
          <button
            onClick={fetchProviders}
            disabled={loading}
            className="inline-flex items-center gap-2 px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            {t('oauthConfig.buttons.refresh')}
          </button>
        </div>
      )}

      {/* 提示信息 */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <div className="flex items-start gap-3">
          <Settings className="w-5 h-5 text-blue-600 mt-0.5" />
          <div className="text-sm text-blue-800 flex-1">
            <p className="font-medium">{t('oauthConfig.instructions.title')}</p>
            <p className="mt-1">
              {t('oauthConfig.instructions.description')}
            </p>
          </div>
          <a
            href={`${getEnvVar('VITE_SUPABASE_URL')}/project/default/auth/providers`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors whitespace-nowrap"
          >
            <ExternalLink className="w-4 h-4" />
            {t('oauthConfig.buttons.supabaseConsole')}
          </a>
        </div>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-red-600" />
          <span className="text-red-800">{error}</span>
        </div>
      )}

      {/* 已启用的 OAuth 提供商 */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 bg-gray-50 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">{t('oauthConfig.enabledProviders.title')}</h2>
          {lastUpdated && (
            <span className="text-xs text-gray-500">
              {t('oauthConfig.enabledProviders.updatedAt', { time: lastUpdated.toLocaleTimeString() })}
            </span>
          )}
        </div>
        
        {providers.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <div className="w-16 h-16 mx-auto bg-gray-100 rounded-full flex items-center justify-center mb-4">
              <Settings className="w-8 h-8 text-gray-400" />
            </div>
            <p className="text-gray-500 mb-2">{t('oauthConfig.enabledProviders.empty')}</p>
            <p className="text-sm text-gray-400">
              {t('oauthConfig.enabledProviders.emptyHint')}
            </p>
          </div>
        ) : (
          <div className="p-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {providers.map(provider => {
              const info = providerInfo[provider.name] || {
                icon: <Globe className="w-5 h-5" />,
                color: 'bg-gray-500'
              }
              
              return (
                <div
                  key={provider.name}
                  className="flex items-center gap-4 p-4 bg-gray-50 rounded-xl border border-gray-100 hover:border-gray-200 transition-colors"
                >
                  <div className={`w-12 h-12 ${info.color} rounded-xl flex items-center justify-center text-white shadow-sm`}>
                    {info.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-gray-900">{t(`oauthConfig.providers.${provider.name}`, provider.name.charAt(0).toUpperCase() + provider.name.slice(1))}</p>
                    <div className="flex items-center gap-1.5 mt-1">
                      <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
                      <span className="text-xs text-green-600 font-medium">{t('oauthConfig.status.enabled')}</span>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* 配置说明 */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">{t('oauthConfig.howTo.title')}</h3>
        <ol className="space-y-3 text-sm text-gray-600">
          <li className="flex items-start gap-3">
            <span className="flex-shrink-0 w-6 h-6 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center text-xs font-medium">1</span>
            <span>{t('oauthConfig.howTo.step1')}</span>
          </li>
          <li className="flex items-start gap-3">
            <span className="flex-shrink-0 w-6 h-6 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center text-xs font-medium">2</span>
            <span>{t('oauthConfig.howTo.step2')}</span>
          </li>
          <li className="flex items-start gap-3">
            <span className="flex-shrink-0 w-6 h-6 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center text-xs font-medium">3</span>
            <span>{t('oauthConfig.howTo.step3')}</span>
          </li>
          <li className="flex items-start gap-3">
            <span className="flex-shrink-0 w-6 h-6 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center text-xs font-medium">4</span>
            <span>
              {t('oauthConfig.howTo.step4')}
              <code className="ml-1 px-2 py-0.5 bg-gray-100 rounded text-xs">
                {getEnvVar('VITE_SUPABASE_URL')}/auth/v1/callback
              </code>
            </span>
          </li>
          <li className="flex items-start gap-3">
            <span className="flex-shrink-0 w-6 h-6 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center text-xs font-medium">5</span>
            <span>{t('oauthConfig.howTo.step5')}</span>
          </li>
        </ol>
      </div>
    </div>
  )
}
