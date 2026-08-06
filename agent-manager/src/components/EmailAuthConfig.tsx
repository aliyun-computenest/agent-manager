import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../contexts/AuthContext'
import { apiUrl } from '../lib/api'
import { Power, PowerOff, Loader2, Server, Globe, AlertTriangle } from 'lucide-react'

export default function EmailAuthConfig() {
  const { t } = useTranslation('admin')
  const { session } = useAuth()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [smtpConfigured, setSmtpConfigured] = useState(false)
  const [smtpHost, setSmtpHost] = useState('')
  const [siteUrl, setSiteUrl] = useState('')
  const [error, setError] = useState<string | null>(null)

  const fetchSettings = useCallback(async () => {
    try {
      const token = session?.access_token
      if (!token) return
      setError(null)
      const resp = await fetch(`${apiUrl}/api/email/auth-settings`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const payload = await resp.json().catch(() => null)
      if (!resp.ok || !payload?.success) {
        throw new Error(payload?.error || t('emailAuthConfig.loadFailed'))
      }
      const { data } = payload
      setEnabled(data.enabled)
      setSmtpConfigured(data.smtpConfigured)
      setSmtpHost(data.smtpHost)
      setSiteUrl(data.siteUrl)
    } catch (err) {
      console.error('获取邮箱认证设置失败:', err)
      setError(err instanceof Error ? err.message : t('emailAuthConfig.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [session, t])

  useEffect(() => { fetchSettings() }, [fetchSettings])

  const handleToggle = async () => {
    const token = session?.access_token
    if (!token) return
    setSaving(true)
    setError(null)
    try {
      const resp = await fetch(`${apiUrl}/api/email/auth-settings`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ enabled: !enabled }),
      })
      const payload = await resp.json().catch(() => null)
      if (!resp.ok || !payload?.success) {
        throw new Error(payload?.error || t('emailAuthConfig.saveFailed'))
      }
      const { data } = payload
      setEnabled(data.enabled)
      setSmtpConfigured(data.smtpConfigured)
      setSmtpHost(data.smtpHost)
      setSiteUrl(data.siteUrl)
    } catch (err) {
      console.error('保存认证设置失败:', err)
      setError(err instanceof Error ? err.message : t('emailAuthConfig.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">{t('emailAuthConfig.title')}</h1>
        <p className="mt-1 text-sm text-gray-500">
          {t('emailAuthConfig.description')}
        </p>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-700">{t('emailAuthConfig.mailServiceStatus')}</h2>
        </div>
        <div className="px-6 py-4 grid grid-cols-2 gap-x-6 gap-y-4">
          <div className="flex items-center gap-3">
            <Server className="w-4 h-4 text-gray-400 flex-shrink-0" />
            <div>
              <p className="text-xs text-gray-400 mb-0.5">{t('emailAuthConfig.smtpServer')}</p>
              <p className="text-sm font-medium text-gray-900">
                {smtpHost || t('common:messages.notConfigured')}
              </p>
            </div>
          </div>
          <div>
            <p className="text-xs text-gray-400 mb-0.5">{t('emailAuthConfig.configStatus')}</p>
            {smtpConfigured ? (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs font-medium rounded-full bg-green-100 text-green-700">
                ✅ {t('emailAuthConfig.configured')}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs font-medium rounded-full bg-red-100 text-red-700">
                ❌ {t('emailAuthConfig.notConfigured')}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <Globe className="w-4 h-4 text-gray-400 flex-shrink-0" />
            <div>
              <p className="text-xs text-gray-400 mb-0.5">{t('emailAuthConfig.siteAddress')}</p>
              <p className="text-sm font-medium text-gray-900 truncate">
                {siteUrl || t('emailAuthConfig.notSet')}
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className={`rounded-lg border p-4 flex items-center justify-between ${
        enabled
          ? 'bg-green-50 border-green-200'
          : 'bg-white border-gray-200'
      }`}>
        <div className="flex items-center gap-3">
          {enabled ? (
            <Power className="w-5 h-5 text-green-600" />
          ) : (
            <PowerOff className="w-5 h-5 text-gray-400" />
          )}
          <div>
            <p className="text-sm font-medium text-gray-900">{t('emailAuthConfig.emailAuth')}</p>
            <p className="text-xs text-gray-500">
              {enabled
                ? t('emailAuthConfig.enabledDescription')
                : t('emailAuthConfig.disabledDescription')}
            </p>
          </div>
        </div>
        <button
          onClick={handleToggle}
          disabled={saving || !smtpConfigured}
          className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
            enabled
              ? 'bg-red-100 text-red-700 hover:bg-red-200'
              : 'bg-blue-600 text-white hover:bg-blue-700'
          } disabled:opacity-50`}
        >
          {saving ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : enabled ? (
            t('emailAuthConfig.disabled')
          ) : (
            t('emailAuthConfig.enabled')
          )}
        </button>
      </div>

      <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
        <p className="text-sm text-amber-800">
          <AlertTriangle className="w-4 h-4 inline mr-1 -mt-0.5" />
          {t('emailAuthConfig.smtpWarning')}
        </p>
      </div>
    </div>
  )
}
