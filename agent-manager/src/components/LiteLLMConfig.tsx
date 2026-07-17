import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useTranslation } from 'react-i18next'
import { apiUrl } from '../lib/api'

interface LiteLLMConfigProps {
  embedded?: boolean
  onSave?: () => void
  providerCode?: string
}

export default function LiteLLMConfig({ embedded = false, onSave, providerCode = 'litellm' }: LiteLLMConfigProps) {
  const { session } = useAuth()
  const { t } = useTranslation('admin')

  // Basic config state
  const [proxyUrl, setProxyUrl] = useState('')
  const [masterKeyInput, setMasterKeyInput] = useState('')
  const [hasMasterKey, setHasMasterKey] = useState(false)
  const [maskedMasterKey, setMaskedMasterKey] = useState('')

  // Placeholder config state
  const [apiKeyPlaceholder, setApiKeyPlaceholder] = useState('')
  const [domainPlaceholder, setDomainPlaceholder] = useState('')
  const [originalPlaceholders, setOriginalPlaceholders] = useState({ apiKey: '', domain: '' })

  // Budget limit state (single rule: value + timeRate)
  const [budgetValue, setBudgetValue] = useState('')
  const [budgetTimeRate, setBudgetTimeRate] = useState<'daily' | 'monthly'>('monthly')


  // UI state
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savingLimit, setSavingLimit] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [showMasterKey, setShowMasterKey] = useState(false)

  const fetchConfig = useCallback(async () => {
    if (!session?.access_token) return
    setLoading(true)
    try {
      const res = await fetch(`${apiUrl}/api/providers/${providerCode}/config`, {
        headers: { 'Authorization': `Bearer ${session.access_token}` }
      })
      const data = await res.json()
      if (data.success) {
        const config = data.config || data
        setProxyUrl(config.proxyUrl || '')
        setHasMasterKey(config.hasMasterKey || false)
        setMaskedMasterKey(config.masterKey || '')
        // Load placeholders
        const akPlaceholder = config.apiKeyPlaceholder || ''
        const domPlaceholder = config.domainPlaceholder || ''
        setApiKeyPlaceholder(akPlaceholder)
        setDomainPlaceholder(domPlaceholder)
        setOriginalPlaceholders({ apiKey: akPlaceholder, domain: domPlaceholder })
      }
    } catch (e) {
      console.error('Failed to fetch LiteLLM config:', e)
    }

    // Fetch limit config
    try {
      const limitRes = await fetch(`${apiUrl}/api/providers/${providerCode}/limit-config`, {
        headers: { 'Authorization': `Bearer ${session.access_token}` }
      })
      const limitData = await limitRes.json()
      if (limitData.success && limitData.config) {
        const budgetsList = limitData.config.budgets || []
        if (budgetsList.length > 0) {
          setBudgetValue(budgetsList[0].value > 0 ? budgetsList[0].value.toString() : '')
          setBudgetTimeRate(budgetsList[0].timeRate || 'monthly')
        }
      }
    } catch (e) {
      console.error('Failed to fetch LiteLLM limit config:', e)
    }

    setLoading(false)
  }, [session, providerCode])

  useEffect(() => {
    fetchConfig()
  }, [fetchConfig])

  const handleSaveConfig = async () => {
    if (!session?.access_token) return
    setSaving(true)
    setError('')
    setMessage('')

    try {
      const body: Record<string, string> = {}
      if (proxyUrl) body.proxyUrl = proxyUrl
      if (masterKeyInput) body.masterKey = masterKeyInput
      // Include placeholders if changed
      if (apiKeyPlaceholder !== originalPlaceholders.apiKey) {
        body.apiKeyPlaceholder = apiKeyPlaceholder
      }
      if (domainPlaceholder !== originalPlaceholders.domain) {
        body.domainPlaceholder = domainPlaceholder
      }

      const res = await fetch(`${apiUrl}/api/providers/${providerCode}/config`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      })

      const data = await res.json()
      if (data.success) {
        setMessage(t('liteLLM.configSaved'))
        setMasterKeyInput('')
        await fetchConfig()
        onSave?.()
      } else {
        setError(data.error || t('liteLLM.saveFailed'))
      }
    } catch (e: any) {
      setError(e.message || t('liteLLM.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const handleSaveLimit = async () => {
    if (!session?.access_token) return
    setSavingLimit(true)
    setError('')
    setMessage('')

    try {
      const value = parseFloat(budgetValue) || 0
      const budgetsPayload = value > 0
        ? [{ timeRate: budgetTimeRate, value, unit: 'usd' }]
        : []

      const res = await fetch(`${apiUrl}/api/providers/${providerCode}/limit-config`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(budgetsPayload)
      })

      const data = await res.json()
      if (data.success) {
        setMessage(data.message || t('liteLLM.budgetSaved'))
        await fetchConfig()
      } else {
        setError(data.error || t('liteLLM.saveFailed'))
      }
    } catch (e: any) {
      setError(e.message || t('liteLLM.saveFailed'))
    } finally {
      setSavingLimit(false)
    }
  }

  if (loading) {
    return <div className="p-4 text-gray-500">{t('liteLLM.loading')}</div>
  }

  const content = (
    <div className="space-y-6">
      {/* Placeholder Config */}
      <div className="p-4 bg-gray-50 rounded-lg border border-gray-200 space-y-3">
        <h3 className="text-sm font-medium text-gray-700">{t('liteLLM.placeholderConfig')}</h3>
        <p className="text-xs text-gray-500">
          {t('liteLLM.placeholderHint')}
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-600 mb-1">{t('liteLLM.apiKeyPlaceholder')}</label>
            <input
              type="text"
              value={apiKeyPlaceholder}
              onChange={(e) => setApiKeyPlaceholder(e.target.value)}
              placeholder={t('liteLLM.apiKeyPlaceholderExample')}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p className="text-xs text-gray-500 mt-1">{t('liteLLM.apiKeyPlaceholderHint')}</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-600 mb-1">{t('liteLLM.proxyUrlPlaceholder')}</label>
            <input
              type="text"
              value={domainPlaceholder}
              onChange={(e) => setDomainPlaceholder(e.target.value)}
              placeholder={t('liteLLM.proxyUrlPlaceholderExample')}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p className="text-xs text-gray-500 mt-1">{t('liteLLM.proxyUrlPlaceholderHint')}</p>
          </div>
        </div>
      </div>

      {/* Connection Config */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-gray-700 border-b pb-2">{t('liteLLM.connectionConfig')}</h3>

        <div>
          <label className="block text-sm font-medium text-gray-600 mb-1">{t('liteLLM.proxyUrl')}</label>
          <input
            type="text"
            value={proxyUrl}
            onChange={(e) => setProxyUrl(e.target.value)}
            placeholder={t('liteLLM.proxyUrlInputPlaceholder')}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <p className="text-xs text-gray-500 mt-1">{t('liteLLM.proxyUrlDescription')}</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-600 mb-1">{t('liteLLM.masterKey')}</label>
          {hasMasterKey && (
            <p className="text-xs text-gray-500 mb-1">
              {t('liteLLM.currentKey')} <code className="bg-gray-100 px-1 rounded">{maskedMasterKey}</code>
            </p>
          )}
          <div className="relative">
            <input
              type={showMasterKey ? 'text' : 'password'}
              value={masterKeyInput}
              onChange={(e) => setMasterKeyInput(e.target.value)}
              placeholder={hasMasterKey ? t('liteLLM.enterNewKey') : t('liteLLM.masterKeyPlaceholder')}
              className="w-full px-3 py-2 pr-10 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              type="button"
              onClick={() => setShowMasterKey(!showMasterKey)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            >
              {showMasterKey ? t('liteLLM.hide') : t('liteLLM.show')}
            </button>
          </div>
          <p className="text-xs text-gray-500 mt-1">{t('liteLLM.masterKeyDescription')}</p>
        </div>

        <button
          onClick={handleSaveConfig}
          disabled={saving || (!proxyUrl && !masterKeyInput)}
          className="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? t('liteLLM.saving') : t('liteLLM.saveConnectionConfig')}
        </button>
      </div>

      {/* Budget Config */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-gray-700 border-b pb-2">{t('liteLLM.budgetConfig')}</h3>
        <p className="text-xs text-gray-500">
          {t('liteLLM.budgetHint')}
        </p>

        <div className="flex items-center gap-2">
          <input
            type="number"
            min="0"
            step="0.01"
            value={budgetValue}
            onChange={(e) => setBudgetValue(e.target.value)}
            placeholder={t('liteLLM.budgetPlaceholder')}
            className="w-40 px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <span className="text-sm text-gray-600 bg-gray-50 border border-gray-200 rounded-md px-3 py-2">USD</span>
          <span className="text-gray-500 text-sm">/</span>
          <select
            value={budgetTimeRate}
            onChange={(e) => setBudgetTimeRate(e.target.value as 'daily' | 'monthly')}
            className="px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="daily">{t('liteLLM.daily')}</option>
            <option value="monthly">{t('liteLLM.monthly')}</option>
          </select>
        </div>
        <p className="text-xs text-gray-400">{t('liteLLM.noLimitHint')}</p>

        <button
          onClick={handleSaveLimit}
          disabled={savingLimit}
          className="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {savingLimit ? t('liteLLM.saving') : t('liteLLM.saveBudgetConfig')}
        </button>
      </div>

      {/* Messages */}
      {message && (
        <div className="p-3 bg-green-50 border border-green-200 rounded-md text-sm text-green-700">
          {message}
        </div>
      )}
      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-md text-sm text-red-700">
          {error}
        </div>
      )}
    </div>
  )

  if (embedded) {
    return content
  }

  return (
    <div className="max-w-2xl mx-auto p-6">
      <h2 className="text-lg font-semibold mb-4">{t('liteLLM.title')}</h2>
      {content}
    </div>
  )
}
