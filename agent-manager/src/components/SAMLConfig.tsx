import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../contexts/AuthContext'
import { apiUrl } from '../lib/api'
import {
  Shield, Loader2, Save, Settings, AlertCircle, CheckCircle2,
  Plus, Trash2, X, RefreshCw, Copy, Check, Link
} from 'lucide-react'

interface SSOProvider {
  id: string
  saml?: {
    entity_id: string
    metadata_url?: string
    metadata_xml?: string
    attribute_mapping?: {
      keys?: Record<string, { name: string }>
    }
  }
  domains: { domain: string; created_at: string }[]
  created_at: string
  updated_at: string
}

interface SAMLConfigForm {
  domain: string
  metadata_url: string
  attribute_mapping_email: string
}

const defaultForm: SAMLConfigForm = {
  domain: '',
  metadata_url: '',
  attribute_mapping_email: 'email'
}



export default function SAMLConfig({ embedded = false }: { embedded?: boolean }) {
  const { t } = useTranslation('admin')
  const { session } = useAuth()
  const [providers, setProviders] = useState<SSOProvider[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const [showAddForm, setShowAddForm] = useState(false)
  const [form, setForm] = useState<SAMLConfigForm>(defaultForm)
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  // Supabase 配置信息
  const [supabaseUrl, setSupabaseUrl] = useState('')
  const [siteUrl, setSiteUrl] = useState('')
  const [savingSiteUrl, setSavingSiteUrl] = useState(false)

  // API 请求封装
  const apiRequest = async (endpoint: string, options: RequestInit = {}) => {
    const token = session?.access_token
    if (!token) throw new Error(t('samlConfig.errors.notLoggedIn'))


  const resp = await fetch(`${apiUrl}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      ...options.headers
    }
  })

  const data = await resp.json()
  if (!resp.ok || !data.success) {
    throw new Error(data.error || t('samlConfig.errors.requestFailed'))
  }
  return data
}

  useEffect(() => {
    if (session?.access_token) {
      fetchData()
    }
  }, [session])

  const fetchData = async () => {
    try {
      setLoading(true)
      setError(null)

      // 并行获取 SSO 信息、设置和 providers
      const [infoRes, settingsRes, providersRes] = await Promise.all([
        apiRequest('/api/sso/info'),
        apiRequest('/api/sso/settings'),
        apiRequest('/api/sso/providers')
      ])

      setSupabaseUrl(infoRes.supabaseUrl || '')
      setSiteUrl(settingsRes.settings?.site_url || '')
      setProviders(providersRes.providers || [])
    } catch (err) {
      setError(err instanceof Error ? err.message : t('samlConfig.errors.loadFailed'))
    } finally {
      setLoading(false)
    }
  }

  const fetchProviders = async () => {
    try {
      const res = await apiRequest('/api/sso/providers')
      setProviders(res.providers || [])
    } catch (err) {
      setError(err instanceof Error ? err.message : t('samlConfig.errors.fetchSsoFailed'))
    }
  }

  const saveSiteUrl = async () => {
    try {
      setSavingSiteUrl(true)
      setError(null)

      await apiRequest('/api/sso/settings', {
        method: 'PATCH',
        body: JSON.stringify({ site_url: siteUrl })
      })

      setSuccess(t('samlConfig.success.siteUrlSaved'))
      setTimeout(() => setSuccess(null), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('samlConfig.errors.saveFailed'))
    } finally {
      setSavingSiteUrl(false)
    }
  }

  const addProvider = async () => {
    try {
      if (!form.domain || !form.metadata_url) {
        setError(t('samlConfig.errors.domainAndMetadataRequired'))
        return
      }

      setSaving(true)
      setError(null)

      await apiRequest('/api/sso/providers', {
        method: 'POST',
        body: JSON.stringify({
          domain: form.domain,
          metadata_url: form.metadata_url,
          attribute_mapping_email: form.attribute_mapping_email || 'email'
        })
      })

      setSuccess(t('samlConfig.success.samlConfigured'))
      setShowAddForm(false)
      setForm(defaultForm)
      fetchProviders()
      setTimeout(() => setSuccess(null), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('samlConfig.errors.configFailed'))
    } finally {
      setSaving(false)
    }
  }

  const deleteProvider = async (id: string) => {
    try {
      setSaving(true)

      await apiRequest(`/api/sso/providers/${id}`, {
        method: 'DELETE'
      })

      setProviders(prev => prev.filter(p => p.id !== id))
      setDeleteConfirm(null)
      setSuccess(t('samlConfig.success.deleted'))
      setTimeout(() => setSuccess(null), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('samlConfig.errors.deleteFailed'))
    } finally {
      setSaving(false)
    }
  }

  const copyToClipboard = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(key)
      setTimeout(() => setCopied(null), 2000)
    } catch (err) {
      console.error('复制失败:', err)
    }
  }

  // 计算 SP 信息
  const spEntityId = `${supabaseUrl}/auth/v1/sso/saml/metadata`
  const spAcsUrl = `${supabaseUrl}/auth/v1/sso/saml/acs`

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
            <h1 className="text-2xl font-bold text-gray-900">{t('samlConfig.title')}</h1>
            <p className="mt-1 text-sm text-gray-500">
              {t('samlConfig.subtitle')}
            </p>
          </div>
          <button
            onClick={() => setShowAddForm(true)}
            className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            <Plus className="w-4 h-4" />
            {t('samlConfig.addSamlSso')}
          </button>
        </div>
      )}

      {/* 错误/成功提示 */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-red-600" />
          <span className="text-red-800">{error}</span>
          <button onClick={() => setError(null)} className="ml-auto text-red-600 hover:text-red-800">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {success && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 flex items-center gap-3">
          <CheckCircle2 className="w-5 h-5 text-green-600" />
          <span className="text-green-800">{success}</span>
        </div>
      )}

      {/* SP 信息（提供给 IdP） */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 bg-gray-50">
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
            <Shield className="w-5 h-5" />
            {t('samlConfig.spInfo.title')}
          </h2>
        </div>
        <div className="p-6 space-y-4">
          <p className="text-sm text-gray-600 mb-4">
            {t('samlConfig.spInfo.description')}
          </p>

          <div className="grid gap-4">
            <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
              <div>
                <div className="text-sm font-medium text-gray-700">{t('samlConfig.spInfo.entityId')}</div>
                <code className="text-sm text-gray-900 break-all">{spEntityId}</code>
              </div>
              <button
                onClick={() => copyToClipboard(spEntityId, 'entityId')}
                className="p-2 text-gray-500 hover:text-gray-700"
              >
                {copied === 'entityId' ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>

            <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
              <div>
                <div className="text-sm font-medium text-gray-700">{t('samlConfig.spInfo.acsUrl')}</div>
                <code className="text-sm text-gray-900 break-all">{spAcsUrl}</code>
              </div>
              <button
                onClick={() => copyToClipboard(spAcsUrl, 'acsUrl')}
                className="p-2 text-gray-500 hover:text-gray-700"
              >
                {copied === 'acsUrl' ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <div className="mt-4 p-4 bg-amber-50 border border-amber-200 rounded-lg">
            <div className="flex items-start gap-2">
              <AlertCircle className="w-5 h-5 text-amber-600 mt-0.5" />
              <div className="text-sm text-amber-800">
                <p className="font-medium">{t('samlConfig.idaasSteps.hintTitle')}</p>
                <ul className="mt-1 list-disc list-inside space-y-1">
                  <li>{t('samlConfig.idaasSteps.hint1')}</li>
                  <li>{t('samlConfig.idaasSteps.hint2')}</li>
                  <li>{t('samlConfig.idaasSteps.hint3')}</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Site URL 配置 */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 bg-gray-50">
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
            <Link className="w-5 h-5" />
            {t('samlConfig.callbackConfig.title')}
          </h2>
        </div>
        <div className="p-6">
          <p className="text-sm text-gray-600 mb-4">
            {t('samlConfig.callbackConfig.description')}
          </p>

          <div className="flex items-center gap-3">
            <div className="flex-1">
              <label className="block text-sm font-medium text-gray-700 mb-1">{t('samlConfig.callbackConfig.siteUrl')}</label>
              <input
                type="url"
                value={siteUrl}
                onChange={e => setSiteUrl(e.target.value)}
                placeholder="http://localhost:5173"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
            <button
              onClick={saveSiteUrl}
              disabled={savingSiteUrl}
              className="mt-6 inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {savingSiteUrl ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              {t('common:buttons.save')}
            </button>
          </div>
        </div>
      </div>

      {/* 已配置的 SSO Providers */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 bg-gray-50 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">{t('samlConfig.configuredSso.title')}</h2>
          <button
            onClick={fetchProviders}
            className="p-2 text-gray-500 hover:text-gray-700 rounded-lg hover:bg-gray-100"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>

        {providers.length > 0 ? (
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">{t('samlConfig.configuredSso.domain')}</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">{t('samlConfig.configuredSso.idpEntityId')}</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">{t('samlConfig.configuredSso.createdAt')}</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">{t('samlConfig.configuredSso.actions')}</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {providers.map(provider => (
                <tr key={provider.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="flex items-center gap-2">
                      <Shield className="w-4 h-4 text-green-600" />
                      <span className="font-medium text-gray-900">
                        {provider.domains?.map(d => d.domain).join(', ') || '-'}
                      </span>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <code className="text-xs text-gray-600 truncate max-w-[300px] block">
                      {provider.saml?.entity_id || '-'}
                    </code>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    {new Date(provider.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right">
                    {deleteConfirm === provider.id ? (
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => deleteProvider(provider.id)}
                          disabled={saving}
                          className="text-red-600 hover:text-red-800 text-sm font-medium"
                        >
                          {t('samlConfig.configuredSso.confirmDelete')}
                        </button>
                        <button
                          onClick={() => setDeleteConfirm(null)}
                          className="text-gray-500 hover:text-gray-700 text-sm"
                        >
                          {t('common:buttons.cancel')}
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setDeleteConfirm(provider.id)}
                        className="text-red-600 hover:text-red-800"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="text-center py-12 text-gray-500">
            <Shield className="w-12 h-12 mx-auto mb-3 text-gray-300" />
            <p>{t('samlConfig.configuredSso.noSamlSso')}</p>
            <button
              onClick={() => setShowAddForm(true)}
              className="mt-3 text-blue-600 hover:text-blue-800 text-sm font-medium"
            >
              {t('samlConfig.configuredSso.addFirstSso')}
            </button>
          </div>
        )}
      </div>

      {/* 添加 SAML SSO 弹窗 */}
      {showAddForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg">
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-gray-900">{t('samlConfig.addSamlSso')}</h3>
              <button onClick={() => setShowAddForm(false)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('samlConfig.form.ssoDomain')} <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={form.domain}
                  onChange={e => setForm(prev => ({ ...prev, domain: e.target.value }))}
                  placeholder="example.com"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
                <p className="text-xs text-gray-500 mt-1">
                  {t('samlConfig.form.ssoDomainHint')}
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('samlConfig.form.idpMetadataUrl')} <span className="text-red-500">*</span>
                </label>
                <input
                  type="url"
                  value={form.metadata_url}
                  onChange={e => setForm(prev => ({ ...prev, metadata_url: e.target.value }))}
                  placeholder="https://your-idp.com/saml2/metadata"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
                <p className="text-xs text-gray-500 mt-1">
                  {t('samlConfig.form.idpMetadataUrlHint')}
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('samlConfig.form.emailAttribute')}
                </label>
                <input
                  type="text"
                  value={form.attribute_mapping_email}
                  onChange={e => setForm(prev => ({ ...prev, attribute_mapping_email: e.target.value }))}
                  placeholder="email"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
                <p className="text-xs text-gray-500 mt-1">
                  {t('samlConfig.form.emailAttributeHint')}
                </p>
              </div>

              <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
                <div className="flex items-start gap-2">
                  <Settings className="w-5 h-5 text-blue-600 mt-0.5" />
                  <div className="text-sm text-blue-800">
                    <p className="font-medium">{t('samlConfig.form.idaasMetadataFormat')}</p>
                    <code className="block mt-1 text-xs bg-blue-100 px-2 py-1 rounded break-all">
                      https://{'<instance>'}.aliyunidaas.com/api/v2/{'<app_id>'}/saml2/meta
                    </code>
                  </div>
                </div>
              </div>
            </div>

            <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-end gap-3">
              <button
                onClick={() => setShowAddForm(false)}
                className="px-4 py-2 text-gray-700 hover:text-gray-900"
              >
                {t('common:buttons.cancel')}
              </button>
              <button
                onClick={addProvider}
                disabled={saving}
                className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                {t('samlConfig.form.saveConfig')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* IDaaS 配置指南 */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">{t('samlConfig.idaasSteps.title')}</h3>
        <ol className="space-y-3 text-sm text-gray-600">
          <li className="flex items-start gap-3">
            <span className="flex-shrink-0 w-6 h-6 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center text-xs font-medium">1</span>
            <span>{t('samlConfig.idaasSteps.step1')}</span>
          </li>
          <li className="flex items-start gap-3">
            <span className="flex-shrink-0 w-6 h-6 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center text-xs font-medium">2</span>
            <span>{t('samlConfig.idaasSteps.step2')}</span>
          </li>
          <li className="flex items-start gap-3">
            <span className="flex-shrink-0 w-6 h-6 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center text-xs font-medium">3</span>
            <span>{t('samlConfig.idaasSteps.step3')}</span>
          </li>
          <li className="flex items-start gap-3">
            <span className="flex-shrink-0 w-6 h-6 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center text-xs font-medium">4</span>
            <span>{t('samlConfig.idaasSteps.step4')}</span>
          </li>
          <li className="flex items-start gap-3">
            <span className="flex-shrink-0 w-6 h-6 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center text-xs font-medium">5</span>
            <span>{t('samlConfig.idaasSteps.step5')}</span>
          </li>
          <li className="flex items-start gap-3">
            <span className="flex-shrink-0 w-6 h-6 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center text-xs font-medium">6</span>
            <span>{t('samlConfig.idaasSteps.step6')}</span>
          </li>
        </ol>
      </div>
    </div>
  )
}
