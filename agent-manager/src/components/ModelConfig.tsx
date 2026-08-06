import React, { useState, useEffect } from 'react'
import { Cpu, Plus, Edit2, Trash2, Search, ToggleLeft, ToggleRight, Loader2, Eye, EyeOff, Save, Check, X, Cloud } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { useTranslation } from 'react-i18next'
import { apiUrl } from '../lib/api'
import AIGatewayConfig from './AIGatewayConfig'
import LiteLLMConfig from './LiteLLMConfig'

// ============ Interfaces ============

interface Model {
  id: string
  name: string
  provider: string
  model_code: string
  description?: string
  status: 'active' | 'disabled'
}

interface Provider {
  code: string
  displayName?: string  // 显示名称
  apiKeyPlaceholder: string  // 模板中的 apiKey 占位符，如 "${DASHSCOPE_API_KEY}"
  domainPlaceholder?: string  // 模板中的 domain 占位符，如 "${DASHSCOPE_API_DOMAIN}"
  type?: 'API' | 'AlibabaCloudAIGateway' | 'LiteLLM'  // Provider 类型
  isEnabled: boolean
  hasApiKey: boolean
}

interface ProviderDetail extends Provider {
  apiKey?: string
  domain?: string
  description?: string
}

// ============ Component ============

const ModelConfig: React.FC = () => {
  const { session } = useAuth()
  const { t } = useTranslation('admin')

  // ========== Provider States ==========
  const [providers, setProviders] = useState<Provider[]>([])
  const [providersLoading, setProvidersLoading] = useState(true)
  const [selectedProviderCode, setSelectedProviderCode] = useState<string | null>(null)
  const [providerDetail, setProviderDetail] = useState<ProviderDetail | null>(null)
  const [providerDetailLoading, setProviderDetailLoading] = useState(false)

  // Provider form states
  const [providerForm, setProviderForm] = useState<{
    apiKey: string
    domain: string
    apiKeyPlaceholder: string
    domainPlaceholder: string
    type: 'API' | 'AlibabaCloudAIGateway' | 'LiteLLM'
  }>({
    apiKey: '',
    domain: '',
    apiKeyPlaceholder: '',
    domainPlaceholder: '',
    type: 'API',
  })
  const [showApiKey, setShowApiKey] = useState(false)
  const [showDomain, setShowDomain] = useState(false)
  const [savingProvider, setSavingProvider] = useState(false)
  const [togglingProvider, setTogglingProvider] = useState(false)

  // Create/Delete provider states
  const [showCreateProviderModal, setShowCreateProviderModal] = useState(false)
  const [creatingProvider, setCreatingProvider] = useState(false)
  const [deletingProvider, setDeletingProvider] = useState(false)
  const [newProvider, setNewProvider] = useState({
    name: '',
    displayName: '',
    type: 'API' as 'API' | 'AlibabaCloudAIGateway' | 'LiteLLM',
    apiKeyPlaceholder: '',
    domainPlaceholder: '',
    description: ''
  })

  // Get currently enabled provider (for single provider constraint)
  const enabledProvider = providers.find(p => p.isEnabled)

  // ========== Model States ==========
  const [models, setModels] = useState<Model[]>([])
  const [modelsLoading, setModelsLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  const [showAddModal, setShowAddModal] = useState(false)
  const [editingModel, setEditingModel] = useState<Model | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [newModel, setNewModel] = useState({
    name: '',
    provider: '',
    modelCode: '',
    description: ''
  })

  // ========== Provider API Functions ==========

  const fetchProviders = async () => {
    try {
      const token = session?.access_token
      if (!token) return

      const response = await fetch(`${apiUrl}/api/providers`, {
        headers: { 'Authorization': `Bearer ${token}` }
      })
      const data = await response.json()

      if (data.success) {
        setProviders(data.providers || [])
        if (!selectedProviderCode && data.providers?.length > 0) {
          setSelectedProviderCode(data.providers[0].code)
        }
      }
    } catch (error) {
      console.error('Failed to fetch providers:', error)
    } finally {
      setProvidersLoading(false)
    }
  }

  const fetchProviderDetail = async (code: string) => {
    if (!code) return

    setProviderDetailLoading(true)
    try {
      const token = session?.access_token
      if (!token) return

      const response = await fetch(`${apiUrl}/api/providers/${code}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      })
      const data = await response.json()

      if (data.success) {
        setProviderDetail(data.provider)
        setProviderForm({
          apiKey: '',
          domain: '',
          apiKeyPlaceholder: data.provider.apiKeyPlaceholder || '',
          domainPlaceholder: data.provider.domainPlaceholder || '',
          type: data.provider.type || 'API',
        })
      }
    } catch (error) {
      console.error('Failed to fetch provider detail:', error)
    } finally {
      setProviderDetailLoading(false)
    }
  }

  const handleSaveProviderConfig = async () => {
    if (!selectedProviderCode || !providerDetail) return

    setSavingProvider(true)
    try {
      const token = session?.access_token
      if (!token) return

      const updateData: Record<string, string | boolean> = {}

      if (providerForm.apiKey.trim()) {
        updateData.apiKey = providerForm.apiKey
      }
      if (providerForm.domain.trim()) {
        updateData.domain = providerForm.domain
      }
      if (providerForm.apiKeyPlaceholder !== providerDetail.apiKeyPlaceholder) {
        updateData.apiKeyPlaceholder = providerForm.apiKeyPlaceholder
      }
      if (providerForm.domainPlaceholder !== providerDetail.domainPlaceholder) {
        updateData.domainPlaceholder = providerForm.domainPlaceholder
      }

      if (Object.keys(updateData).length === 0) {
        alert(t('modelConfig.noChangesToSave'))
        setSavingProvider(false)
        return
      }

      const response = await fetch(`${apiUrl}/api/providers/${selectedProviderCode}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(updateData)
      })

      const data = await response.json()

      if (data.success) {
        setProviderForm(prev => ({ ...prev, apiKey: '', domain: '' }))
        await fetchProviders()
        await fetchProviderDetail(selectedProviderCode)
        alert(t('modelConfig.configSaved'))
      } else {
        alert(data.error || t('modelConfig.saveFailed'))
      }
    } catch (error) {
      console.error('Failed to save provider config:', error)
      alert(t('modelConfig.saveFailed'))
    } finally {
      setSavingProvider(false)
    }
  }

  const handleToggleProviderStatus = async () => {
    if (!selectedProviderCode || !providerDetail) return

    setTogglingProvider(true)
    try {
      const token = session?.access_token
      if (!token) return

      const response = await fetch(`${apiUrl}/api/providers/${selectedProviderCode}/toggle`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}` }
      })

      const data = await response.json()

      if (data.success) {
        await fetchProviders()
        await fetchProviderDetail(selectedProviderCode)
      } else {
        alert(data.error || t('modelConfig.toggleFailed'))
      }
    } catch (error) {
      console.error('Failed to toggle provider status:', error)
      alert(t('modelConfig.toggleFailed'))
    } finally {
      setTogglingProvider(false)
    }
  }

  const handleGatewayConfigSave = () => {
    fetchProviders()
  }

  const handleCreateProvider = async () => {
    if (!newProvider.name.trim()) {
      alert(t('modelConfig.enterProviderName'))
      return
    }

    setCreatingProvider(true)
    try {
      const token = session?.access_token
      if (!token) return

      const response = await fetch(`${apiUrl}/api/providers`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(newProvider)
      })

      const data = await response.json()

      if (data.success) {
        setShowCreateProviderModal(false)
        setNewProvider({
          name: '',
          displayName: '',
          type: 'API',
          apiKeyPlaceholder: '',
          domainPlaceholder: '',
          description: ''
        })
        await fetchProviders()
        alert(t('modelConfig.providerCreated'))
      } else {
        alert(data.error || t('modelConfig.createFailed'))
      }
    } catch (error) {
      console.error('Failed to create provider:', error)
      alert(t('modelConfig.createFailed'))
    } finally {
      setCreatingProvider(false)
    }
  }

  const handleDeleteProvider = async () => {
    if (!selectedProviderCode) return

    if (!confirm(t('modelConfig.confirmDeleteProvider', { code: selectedProviderCode }))) {
      return
    }

    setDeletingProvider(true)
    try {
      const token = session?.access_token
      if (!token) return

      const response = await fetch(`${apiUrl}/api/providers/${selectedProviderCode}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      })

      const data = await response.json()

      if (data.success) {
        setSelectedProviderCode(null)
        setProviderDetail(null)
        await fetchProviders()
        alert(t('modelConfig.providerDeleted'))
      } else {
        alert(data.error || t('modelConfig.deleteFailed'))
      }
    } catch (error) {
      console.error('Failed to delete provider:', error)
      alert(t('modelConfig.deleteFailed'))
    } finally {
      setDeletingProvider(false)
    }
  }

  // ========== Model API Functions ==========

  const fetchModels = async () => {
    try {
      const token = session?.access_token
      if (!token) return

      const response = await fetch(`${apiUrl}/api/models`, {
        headers: { 'Authorization': `Bearer ${token}` }
      })
      const data = await response.json()

      if (data.success) {
        setModels(data.models)
      }
    } catch (error) {
      console.error('Failed to fetch models:', error)
    } finally {
      setModelsLoading(false)
    }
  }

  // ========== Effects ==========

  useEffect(() => {
    if (session?.access_token) {
      fetchProviders()
      fetchModels()
    }
  }, [session])

  useEffect(() => {
    if (selectedProviderCode) {
      fetchProviderDetail(selectedProviderCode)
    }
  }, [selectedProviderCode, providers])

  // ========== Model Handlers ==========

  const filteredModels = models.filter(model =>
    model.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    model.provider.toLowerCase().includes(searchTerm.toLowerCase())
  )

  const enabledProviders = providers.filter(p => p.isEnabled)

  const getProviderName = (code: string) => {
    return code
  }

  const handleToggleStatus = async (modelId: string) => {
    try {
      const token = session?.access_token
      if (!token) return

      const response = await fetch(`${apiUrl}/api/models/${modelId}/toggle`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}` }
      })
      const data = await response.json()

      if (data.success) {
        setModels(models.map(model =>
          model.id === modelId ? data.model : model
        ))
      }
    } catch (error) {
      console.error('Failed to toggle model status:', error)
    }
  }

  const handleAddModel = async () => {
    if (!newModel.name || !newModel.provider || !newModel.modelCode) {
      alert(t('modelConfig.requiredFields'))
      return
    }

    try {
      setSubmitting(true)
      const token = session?.access_token
      if (!token) return

      const response = await fetch(`${apiUrl}/api/models`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(newModel)
      })
      const data = await response.json()

      if (data.success) {
        setModels([data.model, ...models])
        setShowAddModal(false)
        setNewModel({ name: '', provider: '', modelCode: '', description: '' })
      } else {
        alert(data.error || t('modelConfig.addFailed'))
      }
    } catch (error) {
      console.error('Failed to add model:', error)
      alert(t('modelConfig.addFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  const handleEditModel = (model: Model) => {
    setEditingModel({ ...model })
  }

  const handleSaveEdit = async () => {
    if (!editingModel) return

    try {
      setSubmitting(true)
      const token = session?.access_token
      if (!token) return

      const response = await fetch(`${apiUrl}/api/models/${editingModel.id}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: editingModel.name,
          provider: editingModel.provider,
          modelCode: editingModel.model_code,
          description: editingModel.description
        })
      })
      const data = await response.json()

      if (data.success) {
        setModels(models.map(m => m.id === editingModel.id ? data.model : m))
        setEditingModel(null)
      } else {
        alert(data.error || t('modelConfig.saveFailed'))
      }
    } catch (error) {
      console.error('Failed to update model:', error)
      alert(t('modelConfig.saveFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  const handleDeleteModel = async (modelId: string) => {
    if (!confirm(t('modelConfig.confirmDeleteModel'))) return

    try {
      const token = session?.access_token
      if (!token) return

      const response = await fetch(`${apiUrl}/api/models/${modelId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      })
      const data = await response.json()

      if (data.success) {
        setModels(models.filter(m => m.id !== modelId))
      } else {
        alert(data.error || t('modelConfig.deleteFailed'))
      }
    } catch (error) {
      console.error('Failed to delete model:', error)
      alert(t('modelConfig.deleteFailed'))
    }
  }

  // ========== Render ==========

  const selectedProvider = providers.find(p => p.code === selectedProviderCode)

  if (providersLoading && modelsLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-primary-600" />
      </div>
    )
  }

  return (
    <div className="space-y-8">
      {/* ============ Provider Management Section ============ */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
            <Cloud className="w-5 h-5 text-blue-500" />
            {t('modelConfig.providerManagement')}
          </h2>
          <button
            onClick={() => setShowCreateProviderModal(true)}
            className="btn-primary flex items-center gap-1"
          >
            <Plus className="w-4 h-4" />
            {t('modelConfig.createProvider')}
          </button>
        </div>

        {/* Provider Tabs */}
        <div className="flex flex-wrap items-center gap-2 mb-6">
          {providers.map((provider) => (
            <button
              key={provider.code}
              onClick={() => setSelectedProviderCode(provider.code)}
              className={`px-4 py-2 rounded-lg border transition-all flex items-center gap-2 ${
                selectedProviderCode === provider.code
                  ? 'border-blue-500 bg-blue-50 text-blue-700'
                  : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300 hover:bg-gray-50'
              }`}
            >
              <span className="font-medium">{t(`modelConfig.providerNames.${provider.code}`, provider.displayName || provider.code)}</span>
              <span className={`px-2 py-0.5 text-xs rounded-full ${
                provider.isEnabled
                  ? 'bg-green-100 text-green-700'
                  : 'bg-gray-100 text-gray-500'
              }`}>
                {provider.isEnabled ? t('modelConfig.enabled') : t('modelConfig.notEnabled')}
              </span>
            </button>
          ))}
        </div>

        {/* Provider Config Panel */}
        {selectedProvider && (
          <div className="border-t border-gray-100 pt-6">
            {/* Single Provider Constraint Warning */}
            {enabledProvider && enabledProvider.code !== selectedProviderCode && !providerDetail?.isEnabled && (
              <div className="mb-4 p-4 bg-amber-50 border border-amber-200 rounded-lg">
                <div className="flex items-start gap-3">
                  <div className="text-amber-600 mt-0.5">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-amber-800">
                      {t('modelConfig.singleProviderWarning')}
                    </p>
                    <p className="text-sm text-amber-700 mt-1">
                      {t('modelConfig.currentEnabledProvider')}<span className="font-medium">{enabledProvider.code}</span>。
                      {t('modelConfig.pleaseDisableFirst')} <span className="font-medium">{enabledProvider.code}</span>。
                    </p>
                  </div>
                </div>
              </div>
            )}
            {providerDetailLoading ? (
              <div className="flex items-center justify-center h-32">
                <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
              </div>
            ) : providerDetail ? (
              <div className="space-y-4">
                {/* Provider Name Display */}
                <div className="pb-4 border-b border-gray-100">
                  <div className="flex items-center gap-3 mb-3">
                    <label className="text-sm font-medium text-gray-700 whitespace-nowrap">{t('modelConfig.providerName')}</label>
                    <code className="px-3 py-1.5 bg-gray-100 rounded-md text-sm font-mono text-gray-800 select-all">{selectedProviderCode}</code>
                  </div>
                  <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
                    <p className="text-xs text-blue-700">
                      <span className="font-medium">{t('modelConfig.hintLabel')}</span>{t('modelConfig.placeholderHintBefore')}<code className="px-1 py-0.5 bg-blue-100 rounded text-blue-800 font-mono">{'${PLACEHOLDER_NAME}'}</code>{t('modelConfig.placeholderHintAfter')}
                    </p>
                  </div>
                </div>

                {/* Conditional Rendering based on type */}
                {providerForm.type === 'AlibabaCloudAIGateway' ? (
                  <AIGatewayConfig embedded onSave={handleGatewayConfigSave} providerCode={selectedProviderCode || undefined} />
                ) : providerForm.type === 'LiteLLM' ? (
                  <LiteLLMConfig embedded onSave={handleGatewayConfigSave} providerCode={selectedProviderCode || undefined} />
                ) : (
                  <div className="space-y-4">
                    {/* API Key Row: Placeholder + Key */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          {t('modelConfig.apiKeyPlaceholder')}
                        </label>
                        <input
                          type="text"
                          value={providerForm.apiKeyPlaceholder}
                          onChange={(e) => setProviderForm({ ...providerForm, apiKeyPlaceholder: e.target.value })}
                          className="input-field"
                          placeholder={t('modelConfig.apiKeyPlaceholderExample')}
                        />
                        <p className="mt-1 text-xs text-gray-500">
                          {t('modelConfig.apiKeyPlaceholderHint')}
                        </p>
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          {t('modelConfig.apiKey')}
                        </label>
                        <div className="relative">
                          <input
                            type={showApiKey ? 'text' : 'password'}
                            value={providerForm.apiKey}
                            onChange={(e) => setProviderForm({ ...providerForm, apiKey: e.target.value })}
                            className="input-field pr-10"
                            placeholder={t('modelConfig.enterNewApiKey')}
                          />
                          <button
                            type="button"
                            onClick={() => setShowApiKey(!showApiKey)}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                          >
                            {showApiKey ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                          </button>
                        </div>
                        {providerDetail.apiKey && (
                          <p className="mt-1 text-xs text-gray-500">
                            {t('modelConfig.currentValue')} {providerDetail.apiKey}
                          </p>
                        )}
                      </div>
                    </div>

                    {/* Domain Row: Placeholder + Domain */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          {t('modelConfig.domainPlaceholder')}
                        </label>
                        <input
                          type="text"
                          value={providerForm.domainPlaceholder}
                          onChange={(e) => setProviderForm({ ...providerForm, domainPlaceholder: e.target.value })}
                          className="input-field"
                          placeholder={t('modelConfig.domainPlaceholderExample')}
                        />
                        <p className="mt-1 text-xs text-gray-500">
                          {t('modelConfig.domainPlaceholderHint')}
                        </p>
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          {t('modelConfig.domain')}
                        </label>
                        <div className="relative">
                          <input
                            type={showDomain ? 'text' : 'password'}
                            value={providerForm.domain}
                            onChange={(e) => setProviderForm({ ...providerForm, domain: e.target.value })}
                            className="input-field pr-10"
                            placeholder={t('modelConfig.enterNewDomain')}
                          />
                          <button
                            type="button"
                            onClick={() => setShowDomain(!showDomain)}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                          >
                            {showDomain ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                          </button>
                        </div>
                        {providerDetail.domain && (
                          <p className="mt-1 text-xs text-gray-500">
                            {t('modelConfig.currentValue')} {providerDetail.domain}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {/* Actions */}
                <div className="flex items-center justify-between pt-4 border-t border-gray-100">
                  <div className="flex items-center gap-3">
                    {/* Save button only for non-gateway providers */}
                    {providerDetail?.type === 'API' && (
                    <button
                      onClick={handleSaveProviderConfig}
                      disabled={savingProvider}
                      className="btn-primary flex items-center gap-2"
                    >
                      {savingProvider ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Save className="w-4 h-4" />
                      )}
                      {t('modelConfig.saveConfig')}
                    </button>
                    )}

                    <button
                      onClick={handleToggleProviderStatus}
                      disabled={togglingProvider || (!providerDetail.isEnabled && !!enabledProvider)}
                      className={`px-4 py-2 rounded-lg flex items-center gap-2 transition-colors ${
                        providerDetail.isEnabled
                          ? 'bg-red-50 text-red-600 hover:bg-red-100'
                          : enabledProvider
                            ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                            : 'bg-green-50 text-green-600 hover:bg-green-100'
                      }`}
                      title={!providerDetail.isEnabled && enabledProvider ? t('modelConfig.disableBeforeEnable', { code: enabledProvider.code }) : ''}
                    >
                      {togglingProvider ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : providerDetail.isEnabled ? (
                        <X className="w-4 h-4" />
                      ) : (
                        <Check className="w-4 h-4" />
                      )}
                      {providerDetail.isEnabled ? t('modelConfig.disable') : t('modelConfig.enable')}
                    </button>
                  </div>


                  {!providerDetail.isEnabled && (
                    <button
                      onClick={handleDeleteProvider}
                      disabled={deletingProvider}
                      className="px-4 py-2 rounded-lg flex items-center gap-2 text-red-600 hover:bg-red-50 transition-colors"
                    >
                      {deletingProvider ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Trash2 className="w-4 h-4" />
                      )}
                      {t('common:buttons.delete')}
                    </button>
                  )}
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>

      {/* ============ Model Management Section ============ */}
      <div className="card">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
            <Cpu className="w-5 h-5 text-purple-500" />
            {t('modelConfig.modelManagement')}
          </h2>
        </div>

        {/* Model Header */}
        <div className="flex justify-between items-center mb-6">
          <div className="relative w-96">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
            <input
              type="text"
              placeholder={t('modelConfig.searchModels')}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="input-field pl-10"
            />
          </div>
          <button
            onClick={() => setShowAddModal(true)}
            className="btn-primary flex items-center space-x-2"
          >
            <Plus className="w-5 h-5" />
            <span>{t('modelConfig.addModel')}</span>
          </button>
        </div>

        {/* Models Grid */}
        {modelsLoading ? (
          <div className="flex items-center justify-center h-32">
            <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredModels.map((model) => (
              <div key={model.id} className="bg-gray-50 rounded-xl p-4 hover:shadow-md transition-shadow border border-gray-100">
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center space-x-3">
                    <div className="p-3 rounded-lg bg-primary-100">
                      <Cpu className="w-6 h-6 text-primary-600" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-gray-900">{model.name}</h3>
                      <p className="text-sm text-gray-500">{getProviderName(model.provider)}</p>
                    </div>
                  </div>
                  <button
                    onClick={() => handleToggleStatus(model.id)}
                    className="text-gray-400 hover:text-gray-600"
                  >
                    {model.status === 'active' ? (
                      <ToggleRight className="w-6 h-6 text-green-600" />
                    ) : (
                      <ToggleLeft className="w-6 h-6" />
                    )}
                  </button>
                </div>

                <div className="space-y-2 mb-4">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-gray-500">{t('modelConfig.providerLabel')}</span>
                    <span className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded text-xs font-medium">
                      {model.provider}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-gray-500">{t('modelConfig.modelCodeLabel')}</span>
                    <span className="text-gray-700 font-mono text-xs">{model.model_code}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-gray-500">{t('modelConfig.statusLabel')}</span>
                    <span className={`status-badge ${
                      model.status === 'active' ? 'status-active' : 'status-inactive'
                    }`}>
                      {model.status === 'active' ? t('modelConfig.enabled') : t('modelConfig.disabled')}
                    </span>
                  </div>
                </div>

                <div className="flex items-center space-x-2 pt-4 border-t border-gray-200">
                  <button
                    onClick={() => handleEditModel(model)}
                    className="flex-1 btn-secondary flex items-center justify-center space-x-1 py-2"
                  >
                    <Edit2 className="w-4 h-4" />
                    <span>{t('common:buttons.edit')}</span>
                  </button>
                  <button
                    onClick={() => handleDeleteModel(model.id)}
                    className="px-3 py-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ============ Add Model Modal ============ */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-md">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">
              {t('modelConfig.addNewModel')}
            </h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('modelConfig.modelName')} <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={newModel.name}
                  onChange={(e) => setNewModel({ ...newModel, name: e.target.value })}
                  className="input-field"
                  placeholder={t('modelConfig.modelNamePlaceholder')}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('modelConfig.provider')} <span className="text-red-500">*</span>
                </label>
                <select
                  value={newModel.provider}
                  onChange={(e) => setNewModel({ ...newModel, provider: e.target.value })}
                  className="input-field"
                >
                  <option value="">{t('modelConfig.selectProvider')}</option>
                  {enabledProviders.map((provider) => (
                    <option key={provider.code} value={provider.code}>
                      {provider.code}
                    </option>
                  ))}
                </select>
                {enabledProviders.length === 0 && (
                  <p className="mt-1 text-xs text-amber-600">{t('modelConfig.enableProviderFirst')}</p>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('modelConfig.modelCode')} <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={newModel.modelCode}
                  onChange={(e) => setNewModel({ ...newModel, modelCode: e.target.value })}
                  className="input-field"
                  placeholder={t('modelConfig.modelCodePlaceholder')}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('modelConfig.description')}
                </label>
                <input
                  type="text"
                  value={newModel.description}
                  onChange={(e) => setNewModel({ ...newModel, description: e.target.value })}
                  className="input-field"
                  placeholder={t('modelConfig.descriptionPlaceholder')}
                />
              </div>
            </div>
            <div className="flex justify-end space-x-3 mt-6">
              <button
                onClick={() => setShowAddModal(false)}
                className="btn-secondary"
                disabled={submitting}
              >
                {t('common:buttons.cancel')}
              </button>
              <button
                onClick={handleAddModel}
                className="btn-primary flex items-center space-x-2"
                disabled={submitting}
              >
                {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                <span>{t('modelConfig.add')}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ============ Edit Model Modal ============ */}
      {editingModel && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-md">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">
              {t('modelConfig.editModel')}
            </h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('modelConfig.modelName')}
                </label>
                <input
                  type="text"
                  value={editingModel.name}
                  onChange={(e) => setEditingModel({ ...editingModel, name: e.target.value })}
                  className="input-field"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('modelConfig.provider')}
                </label>
                <select
                  value={editingModel.provider}
                  onChange={(e) => setEditingModel({ ...editingModel, provider: e.target.value })}
                  className="input-field"
                >
                  <option value="">{t('modelConfig.selectProvider')}</option>
                  {enabledProviders.map((provider) => (
                    <option key={provider.code} value={provider.code}>
                      {provider.code}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('modelConfig.modelCode')}
                </label>
                <input
                  type="text"
                  value={editingModel.model_code}
                  onChange={(e) => setEditingModel({ ...editingModel, model_code: e.target.value })}
                  className="input-field"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('modelConfig.description')}
                </label>
                <input
                  type="text"
                  value={editingModel.description || ''}
                  onChange={(e) => setEditingModel({ ...editingModel, description: e.target.value })}
                  className="input-field"
                />
              </div>
            </div>
            <div className="flex justify-end space-x-3 mt-6">
              <button
                onClick={() => setEditingModel(null)}
                className="btn-secondary"
                disabled={submitting}
              >
                {t('common:buttons.cancel')}
              </button>
              <button
                onClick={handleSaveEdit}
                className="btn-primary flex items-center space-x-2"
                disabled={submitting}
              >
                {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                <span>{t('common:buttons.save')}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create Provider Modal */}
      {showCreateProviderModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-full max-w-md">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">{t('modelConfig.newProvider')}</h3>
              <button
                onClick={() => setShowCreateProviderModal(false)}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('modelConfig.providerName')} <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={newProvider.name}
                  onChange={(e) => setNewProvider({ ...newProvider, name: e.target.value })}
                  className="input-field"
                  placeholder={t('modelConfig.providerNamePlaceholder')}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('modelConfig.displayName')}
                </label>
                <input
                  type="text"
                  value={newProvider.displayName}
                  onChange={(e) => setNewProvider({ ...newProvider, displayName: e.target.value })}
                  className="input-field"
                  placeholder={t('modelConfig.displayNamePlaceholder')}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('modelConfig.type')}
                </label>
                <select
                  value={newProvider.type}
                  onChange={(e) => setNewProvider({ ...newProvider, type: e.target.value as 'API' | 'AlibabaCloudAIGateway' | 'LiteLLM' })}
                  className="input-field"
                >
                  <option value="API">{t('modelConfig.typeApi')}</option>
                  <option value="AlibabaCloudAIGateway">{t('modelConfig.providerNames.alibabaCloudAIGateway')}</option>
                  <option value="LiteLLM">{t('modelConfig.providerNames.litellm')}</option>
                </select>
              </div>


              {newProvider.type === 'API' ? (
                <div className="p-3 bg-blue-50 rounded-lg text-sm text-blue-700">
                  <p className="font-medium mb-1">{t('modelConfig.typeApiTitle')}</p>
                  <p>{t('modelConfig.typeApiDescription')}</p>
                </div>
              ) : newProvider.type === 'LiteLLM' ? (
                  <div className="p-3 bg-green-50 rounded-lg text-sm text-green-700">
                    <p className="font-medium mb-1">{t('modelConfig.typeLiteLLMTitle')}</p>
                    <p>{t('modelConfig.typeLiteLLMDescription')}</p>
                  </div>
              ) : (
                <div className="p-3 bg-purple-50 rounded-lg text-sm text-purple-700">
                  <p className="font-medium mb-1">{t('modelConfig.typeGatewayTitle')}</p>
                  <p>{t('modelConfig.typeGatewayDescription')}</p>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {newProvider.type === 'AlibabaCloudAIGateway' ? t('modelConfig.consumerApiKeyPlaceholder') : t('modelConfig.apiKeyPlaceholder')}
                </label>
                <input
                  type="text"
                  value={newProvider.apiKeyPlaceholder}
                  onChange={(e) => setNewProvider({ ...newProvider, apiKeyPlaceholder: e.target.value })}
                  className="input-field"
                  placeholder={newProvider.type === 'AlibabaCloudAIGateway' ? t('modelConfig.consumerApiKeyPlaceholderExample') : t('modelConfig.apiKeyPlaceholderExampleDefault')}
                />
                <p className="mt-1 text-xs text-gray-500">
                  {newProvider.type === 'AlibabaCloudAIGateway'
                    ? t('modelConfig.consumerApiKeyPlaceholderHint')
                    : t('modelConfig.apiKeyPlaceholderHint')}
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {newProvider.type === 'AlibabaCloudAIGateway' ? t('modelConfig.gatewayDomainPlaceholder') : t('modelConfig.domainPlaceholder')}
                </label>
                <input
                  type="text"
                  value={newProvider.domainPlaceholder}
                  onChange={(e) => setNewProvider({ ...newProvider, domainPlaceholder: e.target.value })}
                  className="input-field"
                  placeholder={newProvider.type === 'AlibabaCloudAIGateway' ? t('modelConfig.gatewayDomainPlaceholderExample') : t('modelConfig.domainPlaceholderExampleDefault')}
                />
                <p className="mt-1 text-xs text-gray-500">
                  {newProvider.type === 'AlibabaCloudAIGateway'
                    ? t('modelConfig.gatewayDomainPlaceholderHint')
                    : t('modelConfig.domainPlaceholderHint')}
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('modelConfig.description')}
                </label>
                <input
                  type="text"
                  value={newProvider.description}
                  onChange={(e) => setNewProvider({ ...newProvider, description: e.target.value })}
                  className="input-field"
                  placeholder={t('modelConfig.descriptionProviderPlaceholder')}
                />
              </div>
            </div>

            <div className="flex justify-end space-x-3 mt-6">
              <button
                onClick={() => setShowCreateProviderModal(false)}
                className="btn-secondary"
                disabled={creatingProvider}
              >
                {t('common:buttons.cancel')}
              </button>
              <button
                onClick={handleCreateProvider}
                className="btn-primary flex items-center space-x-2"
                disabled={creatingProvider}
              >
                {creatingProvider && <Loader2 className="w-4 h-4 animate-spin" />}
                <span>{t('modelConfig.create')}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default ModelConfig
