import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../contexts/AuthContext'
import { apiUrl } from '../lib/api'
import { Key, Shield, Loader2, CheckCircle2, Power, PowerOff, AlertTriangle, UserPlus, ShieldCheck } from 'lucide-react'
import OAuthConfig from './OAuthConfig'
import SAMLConfig from './SAMLConfig'

type SSOTab = 'oauth' | 'saml'
type SSOMode = 'none' | 'oauth' | 'saml'

export default function SSOConfig() {
  const { t } = useTranslation('admin')
  const { session } = useAuth()
  const [activeTab, setActiveTab] = useState<SSOTab>('oauth')
  const [detecting, setDetecting] = useState(true)
  const [ssoMode, setSsoMode] = useState<SSOMode>('none')
  const [switching, setSwitching] = useState(false)
  const [signupEnabled, setSignupEnabled] = useState(true)
  const [signupSaving, setSignupSaving] = useState(false)
  const [signupError, setSignupError] = useState<string | null>(null)
  const [signupWarning, setSignupWarning] = useState<string | null>(null)
  // Supabase 中实际配置了的 providers（用于辅助展示）
  const [configured, setConfigured] = useState<{ oauth: boolean; saml: boolean }>({ oauth: false, saml: false })

  const fetchStatus = useCallback(async () => {
    try {
      const token = session?.access_token
      if (!token) return

      const resp = await fetch(`${apiUrl}/api/sso/auth-providers`, {
        headers: { 'Authorization': `Bearer ${token}` }
      })

      if (resp.ok) {
        const data = await resp.json()
        if (data.success) {
          const hasSAML = data.samlProviders && data.samlProviders.length > 0
          const hasOAuth = data.oauthProviders && data.oauthProviders.length > 0
          setConfigured({ oauth: hasOAuth, saml: hasSAML })

          // 使用后端返回的 activeMode
          const mode: SSOMode = data.activeMode || 'none'
          setSsoMode(mode)

          // 自动选中已启用的 tab
          if (mode === 'saml') {
            setActiveTab('saml')
          } else if (mode === 'oauth') {
            setActiveTab('oauth')
          }
        }
      }

      const authResp = await fetch(`${apiUrl}/api/email/auth-settings`, {
        headers: { 'Authorization': `Bearer ${token}` }
      })
      const authPayload = await authResp.json().catch(() => null)
      if (!authResp.ok || !authPayload?.success) {
        throw new Error(authPayload?.errorCode === 'modifyUnsupported'
          ? t('ssoConfig.signup.errors.modifyUnsupported')
          : authPayload?.error || t('ssoConfig.signup.errors.loadFailed'))
      }

      const { data } = authPayload
      setSignupEnabled(data.signupEnabled)
      setSignupError(null)
    } catch (err) {
      console.error('检测 SSO 配置失败:', err)
      setSignupError(err instanceof Error ? err.message : t('ssoConfig.signup.errors.loadFailed'))
    } finally {
      setDetecting(false)
    }
  }, [session, t])

  useEffect(() => {
    fetchStatus()
  }, [fetchStatus])

  const handleToggleMode = async (targetMode: SSOMode) => {
    const token = session?.access_token
    if (!token) return

    setSwitching(true)
    try {
      const resp = await fetch(`${apiUrl}/api/sso/mode`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ mode: targetMode })
      })

      if (resp.ok) {
        const data = await resp.json()
        if (data.success) {
          setSsoMode(data.mode)
        }
      }
    } catch (err) {
      console.error('切换 SSO 模式失败:', err)
    } finally {
      setSwitching(false)
    }
  }

  const handleSignupToggle = async () => {
    const token = session?.access_token
    if (!token) return

    setSignupSaving(true)
    setSignupError(null)
    setSignupWarning(null)
    try {
      const resp = await fetch(`${apiUrl}/api/email/auth-settings`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ signupEnabled: !signupEnabled })
      })
      const payload = await resp.json().catch(() => null)
      if (!resp.ok || !payload?.success) {
        throw new Error(payload?.errorCode === 'modifyUnsupported'
          ? t('ssoConfig.signup.errors.modifyUnsupported')
          : payload?.error || t('ssoConfig.signup.errors.saveFailed'))
      }

      const { data, warningCodes, warnings } = payload
      setSignupEnabled(data.signupEnabled)
      setSignupWarning(warningCodes?.includes('unsupportedHardening')
        ? t('ssoConfig.signup.warnings.unsupportedHardening')
        : warnings?.[0] || null)
    } catch (err) {
      console.error('切换用户自助注册失败:', err)
      setSignupError(err instanceof Error ? err.message : t('ssoConfig.signup.errors.saveFailed'))
    } finally {
      setSignupSaving(false)
    }
  }

  const tabs = [
    { key: 'oauth' as SSOTab, label: 'OAuth', icon: Key, desc: t('ssoConfig.tabs.oauthDesc') },
    { key: 'saml' as SSOTab, label: 'SAML SSO', icon: Shield, desc: t('ssoConfig.tabs.samlDesc') },
  ]

  if (detecting) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* 页面标题 */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">{t('ssoConfig.title')}</h1>
        <p className="mt-1 text-sm text-gray-500">
          {t('ssoConfig.description')}
        </p>
      </div>

      <div className={`rounded-lg border p-4 ${
        signupEnabled
          ? 'bg-amber-50 border-amber-200'
          : 'bg-green-50 border-green-200'
      }`}>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            {signupEnabled ? (
              <UserPlus className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
            ) : (
              <ShieldCheck className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
            )}
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium text-gray-900">{t('ssoConfig.signup.title')}</p>
                <span className={`inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-full ${
                  signupEnabled
                    ? 'bg-amber-100 text-amber-800'
                    : 'bg-green-100 text-green-700'
                }`}>
                  {signupEnabled ? t('ssoConfig.signup.riskBadge') : t('ssoConfig.signup.recommendedBadge')}
                </span>
              </div>
              <p className="text-xs text-gray-600 mt-1">
                {signupEnabled
                  ? t('ssoConfig.signup.enabledDescription')
                  : t('ssoConfig.signup.disabledDescription')}
              </p>
            </div>
          </div>
          <button
            onClick={handleSignupToggle}
            disabled={signupSaving}
            className={`w-full px-4 py-2 text-sm font-medium rounded-lg transition-colors sm:w-auto ${
              signupEnabled
                ? 'bg-red-100 text-red-700 hover:bg-red-200'
                : 'bg-white text-gray-700 border border-gray-300 hover:bg-gray-50'
            } disabled:opacity-50`}
          >
            {signupSaving ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : signupEnabled ? (
              t('ssoConfig.signup.disableRecommended')
            ) : (
              t('ssoConfig.signup.enableSignup')
            )}
          </button>
        </div>

        {(signupError || signupWarning) && (
          <div className={`mt-3 rounded-lg border p-3 text-sm ${
            signupError
              ? 'bg-red-50 border-red-200 text-red-700'
              : 'bg-amber-50 border-amber-200 text-amber-800'
          }`}>
            <AlertTriangle className="w-4 h-4 inline mr-1 -mt-0.5" />
            {signupError || signupWarning}
          </div>
        )}

      </div>

      {/* Tab 切换 */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        <div className="flex border-b border-gray-200">
          {tabs.map(tab => {
            const Icon = tab.icon
            const isActive = activeTab === tab.key
            const isEnabled = ssoMode === tab.key
            const isConfigured = configured[tab.key]
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`flex-1 flex items-center justify-center gap-3 px-6 py-4 text-sm font-medium transition-colors relative ${
                  isActive
                    ? 'text-blue-600 bg-blue-50/50'
                    : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50'
                }`}
              >
                <Icon className="w-5 h-5" />
                <div className="text-left">
                  <div className="flex items-center gap-2">
                    <span className={isActive ? 'font-semibold' : ''}>{tab.label}</span>
                    {isEnabled ? (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs font-medium rounded-full bg-green-100 text-green-700">
                        <CheckCircle2 className="w-3 h-3" />
                        {t('ssoConfig.status.enabled')}
                      </span>
                    ) : isConfigured ? (
                      <span className="inline-flex items-center px-1.5 py-0.5 text-xs font-medium rounded-full bg-yellow-100 text-yellow-700">
                        {t('ssoConfig.status.configured')}
                      </span>
                    ) : (
                      <span className="inline-flex items-center px-1.5 py-0.5 text-xs font-medium rounded-full bg-gray-100 text-gray-500">
                        {t('ssoConfig.status.notConfigured')}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-gray-400 mt-0.5">{tab.desc}</div>
                </div>
                {isActive && (
                  <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-600" />
                )}
              </button>
            )
          })}
        </div>
      </div>

      {/* 启用开关 */}
      <div className={`rounded-lg border p-4 flex items-center justify-between ${
        ssoMode === activeTab
          ? 'bg-green-50 border-green-200'
          : 'bg-white border-gray-200'
      }`}>
        <div className="flex items-center gap-3">
          {ssoMode === activeTab ? (
            <Power className="w-5 h-5 text-green-600" />
          ) : (
            <PowerOff className="w-5 h-5 text-gray-400" />
          )}
          <div>
            <p className="text-sm font-medium text-gray-900">
              {t('ssoConfig.toggle.loginLabel', { mode: activeTab === 'oauth' ? 'OAuth' : 'SAML SSO' })}
            </p>
            <p className="text-xs text-gray-500">
              {ssoMode === activeTab
                ? t('ssoConfig.toggle.enabledCurrent')
                : ssoMode !== 'none'
                  ? t('ssoConfig.toggle.enabledOther', { mode: ssoMode === 'oauth' ? 'OAuth' : 'SAML SSO' })
                  : t('ssoConfig.toggle.disabled')
              }
            </p>
          </div>
        </div>
        <button
          onClick={() => handleToggleMode(ssoMode === activeTab ? 'none' : activeTab)}
          disabled={switching}
          className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
            ssoMode === activeTab
              ? 'bg-red-100 text-red-700 hover:bg-red-200'
              : 'bg-blue-600 text-white hover:bg-blue-700'
          } disabled:opacity-50`}
        >
          {switching ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : ssoMode === activeTab ? (
            t('ssoConfig.toggle.disable')
          ) : (
            t('ssoConfig.toggle.enable')
          )}
        </button>
      </div>

      {/* 互斥提示 */}
      <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
        <p className="text-sm text-amber-800">
          <span className="font-medium">{t('ssoConfig.hint.label')}</span>{t('ssoConfig.hint.message')}
        </p>
      </div>

      {/* 内容区域 */}
      {activeTab === 'oauth' && <OAuthConfig embedded />}
      {activeTab === 'saml' && <SAMLConfig embedded />}
    </div>
  )
}
