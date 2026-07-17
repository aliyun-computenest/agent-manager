import { type ReactNode, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Github, Cloud, Shield, MessageCircle } from 'lucide-react'
import { useAuth, type OAuthProvider } from '../../contexts/AuthContext'
import { apiUrl } from '../../lib/api'
import type { SupportedOAuthProvider } from '../../lib/oauth-provider-scopes'
import FeishuLogoIcon from '../icons/FeishuLogoIcon'

export type LoginTab = 'sso' | 'password'

interface SSOProvider {
  id: string
  domains: { domain: string }[]
}

interface ExternalLoginControlsProps {
  disabled?: boolean
  forcePassword?: boolean
  accent?: 'blue' | 'slate'
  onError: (message: string | null) => void
  passwordContent: (state: { externalLoginBusy: boolean }) => ReactNode
}

interface LoginTabState {
  hasExternalLogin: boolean
  activeLoginTab: LoginTab
}

interface NextLoginTabState {
  loginProvidersLoaded: boolean
  hasExternalLogin: boolean
  forcePassword: boolean
  loginTabTouched: boolean
}

const accentClass = {
  blue: {
    focus: 'focus-visible:outline-blue-500',
    active: 'bg-white text-blue-700 shadow-sm',
    ssoButton: 'bg-blue-600 hover:bg-blue-700 text-white',
    spinner: 'text-blue-500',
  },
  slate: {
    focus: 'focus-visible:outline-slate-500',
    active: 'bg-white text-slate-950 shadow-sm',
    ssoButton: 'bg-slate-950 hover:bg-slate-800 text-white',
    spinner: 'text-slate-500',
  },
} as const

export function getVisibleLoginTab({ hasExternalLogin, activeLoginTab }: LoginTabState): LoginTab {
  return hasExternalLogin ? activeLoginTab : 'password'
}

export function shouldLoadOAuthProviders(ssoMode: string): boolean {
  return ssoMode === 'oauth'
}

export function getNextLoginTab({
  loginProvidersLoaded,
  hasExternalLogin,
  forcePassword,
  loginTabTouched,
}: NextLoginTabState): LoginTab | null {
  if (!loginProvidersLoaded) return null
  if (!hasExternalLogin || forcePassword) return 'password'
  if (!loginTabTouched) return 'sso'
  return null
}

export default function ExternalLoginControls({
  disabled = false,
  forcePassword = false,
  accent = 'blue',
  onError,
  passwordContent,
}: ExternalLoginControlsProps) {
  const { t } = useTranslation('auth')
  const [oauthLoading, setOauthLoading] = useState<string | null>(null)
  const [ssoLoading, setSsoLoading] = useState(false)
  const [oauthProviders, setOauthProviders] = useState<OAuthProvider[]>([])
  const [ssoProviders, setSsoProviders] = useState<SSOProvider[]>([])
  const [loginProvidersLoaded, setLoginProvidersLoaded] = useState(false)
  const [activeLoginTab, setActiveLoginTab] = useState<LoginTab>('sso')
  const [loginTabTouched, setLoginTabTouched] = useState(false)
  const { signInWithOAuth, signInWithSSO, getEnabledOAuthProviders } = useAuth()
  const styles = accentClass[accent]

  const providerConfig: Record<string, { icon: ReactNode; buttonClassName: string; displayName: string }> = {
    github: { icon: <Github className="h-4 w-4" />, buttonClassName: 'bg-gray-900 text-white hover:bg-gray-800', displayName: t('oauth.github') },
    alibabacloud: { icon: <Cloud className="h-4 w-4" />, buttonClassName: 'bg-orange-500 text-white hover:bg-orange-600', displayName: t('oauth.alibabaCloud') },
    feishu: { icon: <FeishuLogoIcon className="h-5 w-5" />, buttonClassName: 'bg-white text-slate-900 ring-1 ring-inset ring-slate-200 hover:bg-slate-50', displayName: t('oauth.feishu') },
    dingtalk: { icon: <MessageCircle className="h-4 w-4" />, buttonClassName: 'bg-sky-500 text-white hover:bg-sky-600', displayName: t('oauth.dingtalk') },
  }

  useEffect(() => {
    const loadLoginProviders = async () => {
      try {
        setLoginProvidersLoaded(false)
        const modeResp = await fetch(`${apiUrl}/api/sso/mode/public`)
        let ssoMode = 'none'
        if (modeResp.ok) {
          const modeData = await modeResp.json()
          ssoMode = modeData.mode || 'none'
        }

        if (ssoMode === 'saml') {
          setOauthProviders([])
          const resp = await fetch(`${apiUrl}/api/sso/providers/public`)
          if (resp.ok) {
            const data = await resp.json()
            setSsoProviders(data.success && data.providers ? data.providers : [])
          }
        } else if (shouldLoadOAuthProviders(ssoMode)) {
          const providers = await getEnabledOAuthProviders()
          setOauthProviders(providers)
          setSsoProviders([])
        } else {
          setOauthProviders([])
          setSsoProviders([])
        }
      } catch (err) {
        console.error('Failed to load login providers:', err)
      } finally {
        setLoginProvidersLoaded(true)
      }
    }

    loadLoginProviders()
  }, [getEnabledOAuthProviders])

  const enabledProviders = oauthProviders.filter(p => providerConfig[p.provider])
  const hasExternalLogin = enabledProviders.length > 0 || ssoProviders.length > 0
  const visibleLoginTab = getVisibleLoginTab({ hasExternalLogin, activeLoginTab })
  const externalLoginBusy = !!oauthLoading || ssoLoading

  useEffect(() => {
    const nextLoginTab = getNextLoginTab({
      loginProvidersLoaded,
      hasExternalLogin,
      forcePassword,
      loginTabTouched,
    })
    if (nextLoginTab) {
      setActiveLoginTab(nextLoginTab)
    }
  }, [forcePassword, hasExternalLogin, loginProvidersLoaded, loginTabTouched])

  const handleOAuthLogin = async (provider: string) => {
    setOauthLoading(provider)
    onError(null)

    const { error } = await signInWithOAuth(provider as SupportedOAuthProvider)

    if (error) {
      onError(error.message)
      setOauthLoading(null)
    }
  }

  const handleSSOLogin = async (domain: string) => {
    setSsoLoading(true)
    onError(null)

    const { error } = await signInWithSSO(domain)

    if (error) {
      onError(error.message)
      setSsoLoading(false)
    }
  }

  return (
    <>
      {hasExternalLogin && (
        <div className="mb-5 grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1" role="tablist" aria-label={t('loginTabs.label')}>
          <button
            type="button"
            role="tab"
            aria-selected={visibleLoginTab === 'sso'}
            onClick={() => {
              setLoginTabTouched(true)
              setActiveLoginTab('sso')
            }}
            className={`rounded-md px-3 py-2 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${styles.focus} ${
              visibleLoginTab === 'sso'
                ? styles.active
                : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            {t('loginTabs.sso')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={visibleLoginTab === 'password'}
            onClick={() => {
              setLoginTabTouched(true)
              setActiveLoginTab('password')
            }}
            className={`rounded-md px-3 py-2 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${styles.focus} ${
              visibleLoginTab === 'password'
                ? styles.active
                : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            {t('loginTabs.password')}
          </button>
        </div>
      )}

      {!loginProvidersLoaded && (
        <div className={`flex items-center justify-center py-8 ${styles.spinner}`}>
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      )}

      {loginProvidersLoaded && visibleLoginTab === 'sso' && (
        <div className="space-y-3">
          {enabledProviders.map(provider => {
            const config = providerConfig[provider.provider]
            const isLoading = oauthLoading === provider.provider
            return (
              <button
                key={provider.provider}
                type="button"
                onClick={() => handleOAuthLogin(provider.provider)}
                disabled={disabled || externalLoginBusy}
                className={`w-full min-h-11 px-4 py-3 text-base font-medium rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${styles.focus} ${config.buttonClassName}`}
              >
                {isLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  config.icon
                )}
                <span>
                  {isLoading ? t('redirecting') : config.displayName}
                </span>
              </button>
            )
          })}

          {ssoProviders.length > 0 && (
            <>
              {enabledProviders.length > 0 && (
                <div className="relative my-4">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-gray-200" />
                  </div>
                  <div className="relative flex justify-center text-sm">
                    <span className="bg-white px-4 text-gray-500">{t('or')}</span>
                  </div>
                </div>
              )}

              {ssoProviders.map(provider => {
                const domain = provider.domains?.[0]?.domain || ''
                return (
                  <button
                    key={provider.id}
                    type="button"
                    onClick={() => handleSSOLogin(domain)}
                    disabled={disabled || externalLoginBusy}
                    className={`w-full min-h-11 px-4 py-3 text-base font-medium rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${styles.focus} ${styles.ssoButton}`}
                  >
                    {ssoLoading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Shield className="h-4 w-4" />
                    )}
                    <span>
                      {ssoLoading ? t('redirecting') : t('sso.ssoLoginWithDomain', { domain })}
                    </span>
                  </button>
                )
              })}
              <p className="text-sm text-gray-500 text-center mt-2">
                {t('sso.ssoHelpText')}
              </p>
            </>
          )}
        </div>
      )}

      {loginProvidersLoaded && visibleLoginTab === 'password' && passwordContent({ externalLoginBusy })}
    </>
  )
}
