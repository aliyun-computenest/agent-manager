import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { getSupabase } from '../lib/supabase'
import {
  Loader2, Info, Search,
  AlertCircle, CheckCircle2, X, Plus, Trash2, Copy, Check, RefreshCw
} from 'lucide-react'

const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001'

const getAuthToken = async (): Promise<string | null> => {
  const supabase = await getSupabase()
  const { data: { session } } = await supabase.auth.getSession()
  return session?.access_token || null
}

interface AuthProvider {
  provider: string
  name: string
  color: string
  enabled: boolean
}

interface SSOProvider {
  id: string
  saml?: {
    entity_id: string
    metadata_url?: string
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

const defaultSAMLForm: SAMLConfigForm = {
  domain: '',
  metadata_url: '',
  attribute_mapping_email: 'email'
}

export default function AuthSettings() {
  const { t } = useTranslation('admin')
  const [activeTab, setActiveTab] = useState<'oauth' | 'saml'>('oauth')

  return (
    <div className="space-y-6">
      {/* Tab Header - 简洁下划线样式 */}
      <div className="border-b border-gray-200">
        <nav className="flex space-x-8">
          <button
            onClick={() => setActiveTab('oauth')}
            className={`py-3 px-1 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'oauth'
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            {t('authSettings.tabs.oauth')}
          </button>
          <button
            onClick={() => setActiveTab('saml')}
            className={`py-3 px-1 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'saml'
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            {t('authSettings.tabs.saml')}
          </button>
        </nav>
      </div>

      {/* Tab Content */}
      {activeTab === 'oauth' ? <OAuthSettings /> : <SAMLSettings />}
    </div>
  )
}

// ========== OAuth Settings ==========
function OAuthSettings() {
  const { t } = useTranslation('admin')
  const [providers, setProviders] = useState<AuthProvider[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchTerm, setSearchTerm] = useState('')

  const apiRequest = async (endpoint: string, options: RequestInit = {}) => {
    const token = await getAuthToken()
    if (!token) throw new Error(t('authSettings.errors.notLoggedIn'))

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
      throw new Error(data.error || t('authSettings.errors.requestFailed'))
    }
    return data
  }

  useEffect(() => {
    fetchAuthProviders()
  }, [])

  const fetchAuthProviders = async () => {
    try {
      setLoading(true)
      setError(null)
      const data = await apiRequest('/api/sso/auth-providers')
      setProviders(data.oauthProviders || [])
    } catch (err) {
      setError(err instanceof Error ? err.message : t('authSettings.errors.loadFailed'))
    } finally {
      setLoading(false)
    }
  }

  const getEnvVar = (key: string): string => {
    const windowEnv = (window as any).__ENV__
    return (windowEnv && windowEnv[key]) || import.meta.env[key] || ''
  }
  const supabaseConsoleUrl = `${getEnvVar('VITE_SUPABASE_URL')}/project/default/auth/providers`

  const filteredProviders = providers.filter(p =>
    p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    p.provider.toLowerCase().includes(searchTerm.toLowerCase())
  )

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* 蓝色提示信息 */}
      <div className="bg-blue-50 rounded-lg p-4 flex items-start gap-3">
        <Info className="w-5 h-5 text-blue-500 mt-0.5 flex-shrink-0" />
        <p className="text-sm text-blue-700">
          {t('authSettings.oauth.infoMessage')}
        </p>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-red-600" />
          <span className="text-red-800">{error}</span>
          <button onClick={() => setError(null)} className="ml-auto">
            <X className="w-4 h-4 text-red-600" />
          </button>
        </div>
      )}

      {/* 操作栏 */}
      <div className="flex items-center gap-4">
        <a
          href={supabaseConsoleUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 px-4 py-2 bg-blue-500 text-white text-sm font-medium rounded hover:bg-blue-600 transition-colors"
        >
          {t('authSettings.oauth.configureOAuth')}
        </a>
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder={t('authSettings.oauth.filterProviders')}
            className="w-full pl-9 pr-4 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </div>
        <button
          onClick={fetchAuthProviders}
          className="p-2 hover:bg-gray-100 rounded transition-colors"
          title={t('authSettings.oauth.refresh')}
        >
          <RefreshCw className="w-4 h-4 text-gray-500" />
        </button>
      </div>

      {/* 提供商列表 */}
      <div className="bg-white rounded-lg border border-gray-200">
        {/* 表头 */}
        <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
          <span className="text-sm font-medium text-gray-700">{t('authSettings.oauth.identityProviders')}</span>
        </div>

        {/* 列表内容 */}
        <div className="divide-y divide-gray-100">
          {filteredProviders.length === 0 ? (
            <div className="px-4 py-8 text-center text-gray-500 text-sm">
              {searchTerm ? t('authSettings.oauth.noMatchingProviders') : t('authSettings.oauth.noEnabledProviders')}
            </div>
          ) : (
            filteredProviders.map(provider => (
              <div key={provider.provider} className="px-4 py-3 flex items-center justify-between hover:bg-gray-50">
                <div className="flex items-center gap-3">
                  <div
                    className="w-8 h-8 rounded flex items-center justify-center text-white text-sm font-medium"
                    style={{ backgroundColor: provider.color }}
                  >
                    {provider.name.charAt(0)}
                  </div>
                  <span className="text-sm text-blue-600 hover:underline cursor-default">
                    {provider.name}
                  </span>
                </div>
                <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-green-100 text-green-700 text-xs font-medium rounded">
                  <CheckCircle2 className="w-3 h-3" />
                  {t('authSettings.oauth.enabled')}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

// ========== SAML Settings ==========
function SAMLSettings() {
  const { t } = useTranslation('admin')
  const [providers, setProviders] = useState<SSOProvider[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const [showAddForm, setShowAddForm] = useState(false)
  const [form, setForm] = useState<SAMLConfigForm>(defaultSAMLForm)
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [searchTerm, setSearchTerm] = useState('')

  const [supabaseUrl, setSupabaseUrl] = useState('')
  const [siteUrl, setSiteUrl] = useState('')
  const [savingSiteUrl, setSavingSiteUrl] = useState(false)

  const apiRequest = async (endpoint: string, options: RequestInit = {}) => {
    const token = await getAuthToken()
    if (!token) throw new Error(t('authSettings.errors.notLoggedIn'))

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
      throw new Error(data.error || t('authSettings.errors.requestFailed'))
    }
    return data
  }

  useEffect(() => {
    fetchData()
  }, [])

  useEffect(() => {
    if (success) {
      const timer = setTimeout(() => setSuccess(null), 3000)
      return () => clearTimeout(timer)
    }
  }, [success])

  const fetchData = async () => {
    try {
      setLoading(true)
      setError(null)

      const [infoRes, settingsRes, providersRes] = await Promise.all([
        apiRequest('/api/sso/info'),
        apiRequest('/api/sso/settings'),
        apiRequest('/api/sso/providers')
      ])

      setSupabaseUrl(infoRes.supabaseUrl || '')
      setSiteUrl(settingsRes.siteUrl || '')
      setProviders(providersRes.providers || [])
    } catch (err) {
      setError(err instanceof Error ? err.message : t('authSettings.errors.loadFailed'))
    } finally {
      setLoading(false)
    }
  }

  const handleAddProvider = async () => {
    if (!form.domain || !form.metadata_url) {
      setError(t('authSettings.saml.domainAndMetadataRequired'))
      return
    }

    try {
      setSaving(true)
      setError(null)

      await apiRequest('/api/sso/providers', {
        method: 'POST',
        body: JSON.stringify({
          type: 'saml',
          domain: form.domain,
          metadata_url: form.metadata_url,
          attribute_mapping: {
            keys: {
              email: { name: form.attribute_mapping_email || 'email' }
            }
          }
        })
      })

      setSuccess(t('authSettings.saml.providerAdded'))
      setForm(defaultSAMLForm)
      setShowAddForm(false)
      fetchData()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('authSettings.saml.addFailed'))
    } finally {
      setSaving(false)
    }
  }

  const handleDeleteProvider = async (id: string) => {
    try {
      setSaving(true)
      await apiRequest(`/api/sso/providers/${id}`, { method: 'DELETE' })
      setSuccess(t('authSettings.saml.providerDeleted'))
      setDeleteConfirm(null)
      fetchData()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('authSettings.saml.deleteFailed'))
    } finally {
      setSaving(false)
    }
  }

  const handleSaveSiteUrl = async () => {
    try {
      setSavingSiteUrl(true)
      await apiRequest('/api/sso/settings', {
        method: 'PUT',
        body: JSON.stringify({ siteUrl })
      })
      setSuccess(t('authSettings.saml.callbackSaved'))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('authSettings.errors.saveFailed'))
    } finally {
      setSavingSiteUrl(false)
    }
  }

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text)
    setCopied(key)
    setTimeout(() => setCopied(null), 2000)
  }

  const acsUrl = supabaseUrl ? `${supabaseUrl}/auth/v1/sso/saml/acs` : ''
  const entityId = supabaseUrl ? `${supabaseUrl}/auth/v1/sso/saml/metadata` : ''

  const filteredProviders = providers.filter(p => {
    const domain = p.domains[0]?.domain || ''
    return domain.toLowerCase().includes(searchTerm.toLowerCase())
  })

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* 蓝色提示信息 */}
      <div className="bg-blue-50 rounded-lg p-4 flex items-start gap-3">
        <Info className="w-5 h-5 text-blue-500 mt-0.5 flex-shrink-0" />
        <p className="text-sm text-blue-700">
          {t('authSettings.saml.infoMessage')}
        </p>
      </div>

      {/* 错误/成功提示 */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-red-600" />
          <span className="text-red-800">{error}</span>
          <button onClick={() => setError(null)} className="ml-auto">
            <X className="w-4 h-4 text-red-600" />
          </button>
        </div>
      )}
      {success && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 flex items-center gap-3">
          <CheckCircle2 className="w-5 h-5 text-green-600" />
          <span className="text-green-800">{success}</span>
        </div>
      )}

      {/* SP 配置信息卡片 */}
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <h3 className="text-base font-semibold text-gray-900 mb-4">{t('authSettings.saml.spConfigTitle')}</h3>
        <p className="text-sm text-gray-600 mb-4">
          {t('authSettings.saml.spConfigDescription')}
        </p>
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-500 w-28 flex-shrink-0">ACS URL:</span>
            <code className="flex-1 text-sm bg-gray-100 px-3 py-2 rounded overflow-x-auto">{acsUrl}</code>
            <button onClick={() => copyToClipboard(acsUrl, 'acs')} className="p-2 hover:bg-gray-100 rounded flex-shrink-0">
              {copied === 'acs' ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4 text-gray-400" />}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-500 w-28 flex-shrink-0">Entity ID:</span>
            <code className="flex-1 text-sm bg-gray-100 px-3 py-2 rounded overflow-x-auto">{entityId}</code>
            <button onClick={() => copyToClipboard(entityId, 'entity')} className="p-2 hover:bg-gray-100 rounded flex-shrink-0">
              {copied === 'entity' ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4 text-gray-400" />}
            </button>
          </div>
        </div>

        {/* IDaaS 配置提示 */}
        <div className="mt-4 p-4 bg-amber-50 border border-amber-200 rounded-lg">
          <div className="flex items-start gap-2">
            <AlertCircle className="w-5 h-5 text-amber-600 mt-0.5 flex-shrink-0" />
            <div className="text-sm text-amber-800">
              <p className="font-medium">{t('authSettings.saml.idaasHintTitle')}</p>
              <ul className="mt-2 list-disc list-inside space-y-1">
                <li>{t('authSettings.saml.idaasHint1')}</li>
                <li>{t('authSettings.saml.idaasHint2')}</li>
                <li>{t('authSettings.saml.idaasHint3')}</li>
              </ul>
            </div>
          </div>
        </div>
      </div>

      {/* 登录回调地址 */}
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <h3 className="text-base font-semibold text-gray-900 mb-2">{t('authSettings.saml.callbackTitle')}</h3>
        <p className="text-sm text-gray-500 mb-4">{t('authSettings.saml.callbackDescription')}</p>
        <div className="flex items-center gap-3">
          <input
            type="url"
            value={siteUrl}
            onChange={(e) => setSiteUrl(e.target.value)}
            placeholder="https://your-app.example.com"
            className="flex-1 px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          <button
            onClick={handleSaveSiteUrl}
            disabled={savingSiteUrl}
            className="inline-flex items-center gap-2 px-4 py-2 bg-blue-500 text-white text-sm font-medium rounded hover:bg-blue-600 transition-colors disabled:opacity-50"
          >
            {savingSiteUrl ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            {t('common:buttons.save')}
          </button>
        </div>
      </div>

      {/* 操作栏 */}
      <div className="flex items-center gap-4">
        <button
          onClick={() => setShowAddForm(true)}
          className="inline-flex items-center gap-2 px-4 py-2 bg-blue-500 text-white text-sm font-medium rounded hover:bg-blue-600 transition-colors"
        >
          <Plus className="w-4 h-4" />
          {t('authSettings.saml.createProvider')}
        </button>
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder={t('authSettings.saml.filterProviders')}
            className="w-full pl-9 pr-4 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </div>
        <button
          onClick={fetchData}
          className="p-2 hover:bg-gray-100 rounded transition-colors"
          title={t('authSettings.saml.refresh')}
        >
          <RefreshCw className="w-4 h-4 text-gray-500" />
        </button>
      </div>

      {/* 提供商列表 */}
      <div className="bg-white rounded-lg border border-gray-200">
        <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
          <span className="text-sm font-medium text-gray-700">{t('authSettings.saml.identityProviders')}</span>
        </div>

        <div className="divide-y divide-gray-100">
          {filteredProviders.length === 0 ? (
            <div className="px-4 py-8 text-center text-gray-500 text-sm">
              {searchTerm ? t('authSettings.saml.noMatchingProviders') : t('authSettings.saml.noSamlProviders')}
            </div>
          ) : (
            filteredProviders.map(provider => (
              <div key={provider.id} className="px-4 py-3 flex items-center justify-between hover:bg-gray-50">
                <span className="text-sm text-blue-600 hover:underline cursor-default">
                  {provider.domains[0]?.domain || 'Unknown'}
                </span>
                <button
                  onClick={() => setDeleteConfirm(provider.id)}
                  className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                  title={t('common:buttons.delete')}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Add Form Modal */}
      {showAddForm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl p-6 w-full max-w-lg">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">{t('authSettings.saml.createSamlProvider')}</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('authSettings.saml.enterpriseDomain')} <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={form.domain}
                  onChange={(e) => setForm({ ...form, domain: e.target.value })}
                  placeholder="example.com"
                  className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('authSettings.saml.idpMetadataUrl')} <span className="text-red-500">*</span>
                </label>
                <input
                  type="url"
                  value={form.metadata_url}
                  onChange={(e) => setForm({ ...form, metadata_url: e.target.value })}
                  placeholder="https://idp.example.com/saml/metadata"
                  className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('authSettings.saml.emailAttributeMapping')}
                </label>
                <input
                  type="text"
                  value={form.attribute_mapping_email}
                  onChange={(e) => setForm({ ...form, attribute_mapping_email: e.target.value })}
                  placeholder="email"
                  className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
                <p className="text-xs text-gray-500 mt-1">{t('authSettings.saml.emailAttributeMappingHint')}</p>
              </div>
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => setShowAddForm(false)}
                className="px-4 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded hover:bg-gray-50 transition-colors"
              >
                {t('common:buttons.cancel')}
              </button>
              <button
                onClick={handleAddProvider}
                disabled={saving}
                className="inline-flex items-center gap-2 px-4 py-2 bg-blue-500 text-white text-sm font-medium rounded hover:bg-blue-600 transition-colors disabled:opacity-50"
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                {t('authSettings.saml.create')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirm Modal */}
      {deleteConfirm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl p-6 w-full max-w-sm">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">{t('authSettings.saml.confirmDelete')}</h2>
            <p className="text-gray-600 text-sm mb-6">{t('authSettings.saml.confirmDeleteMessage')}</p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="px-4 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded hover:bg-gray-50 transition-colors"
              >
                {t('common:buttons.cancel')}
              </button>
              <button
                onClick={() => handleDeleteProvider(deleteConfirm)}
                disabled={saving}
                className="inline-flex items-center gap-2 px-4 py-2 bg-red-500 text-white text-sm font-medium rounded hover:bg-red-600 transition-colors disabled:opacity-50"
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                {t('common:buttons.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
