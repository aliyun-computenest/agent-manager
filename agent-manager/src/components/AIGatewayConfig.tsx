import React, { useState, useEffect } from 'react'
import { Settings, Key, Save, Loader2, RefreshCw, Eye, EyeOff, Cloud, AlertCircle, CheckCircle, ExternalLink, Gauge } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { useTranslation } from 'react-i18next'
import { apiUrl } from '../lib/api'

interface GatewayConfig {
  gatewayId: string
  httpApiId: string
  environmentId: string
  regionId: string
  gatewayDomain: string
  hasCredentials: boolean
  maskedAccessKeyId: string
  maskedAccessKeySecret: string
}

interface TokenRateLimitConfig {
  enabled: boolean
  dailyTokenLimit: number
  monthlyTokenLimit: number
}

interface AIGatewayConfigProps {
  embedded?: boolean
  onSave?: () => void
  providerCode?: string
}

const AIGatewayConfig: React.FC<AIGatewayConfigProps> = ({ embedded = false, onSave, providerCode = 'api_gateway' }) => {
  const { session } = useAuth()
  const { t } = useTranslation('admin')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savingTokenLimit, setSavingTokenLimit] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  // Gateway config
  const [gatewayConfig, setGatewayConfig] = useState<GatewayConfig>({
    gatewayId: '',
    httpApiId: '',
    environmentId: '',
    regionId: 'cn-hangzhou',
    gatewayDomain: '',
    hasCredentials: false,
    maskedAccessKeyId: '',
    maskedAccessKeySecret: ''
  })

  // Aliyun AccessKey config (for editing)
  const [accessKeyIdInput, setAccessKeyIdInput] = useState('')
  const [accessKeySecretInput, setAccessKeySecretInput] = useState('')

  // Token Rate Limit config
  const [tokenRateLimitConfig, setTokenRateLimitConfig] = useState<TokenRateLimitConfig>({
    enabled: false,
    dailyTokenLimit: 0,
    monthlyTokenLimit: 0
  })
  const [dailyTokenLimitInput, setDailyTokenLimitInput] = useState('')
  const [monthlyTokenLimitInput, setMonthlyTokenLimitInput] = useState('')

  const [showAccessKey, setShowAccessKey] = useState(false)
  const [savingAccessKey, setSavingAccessKey] = useState(false)

  // Placeholders
  const [apiKeyPlaceholder, setApiKeyPlaceholder] = useState('')
  const [domainPlaceholder, setDomainPlaceholder] = useState('')
  const [originalPlaceholders, setOriginalPlaceholders] = useState({ apiKey: '', domain: '' })

  const regionOptions = [
    { value: 'cn-beijing', labelKey: 'aiGateway.regions.beijing' },
    { value: 'cn-hangzhou', labelKey: 'aiGateway.regions.hangzhou' },
    { value: 'cn-shanghai', labelKey: 'aiGateway.regions.shanghai' },
    { value: 'cn-hongkong', labelKey: 'aiGateway.regions.hongkong' },
    { value: 'ap-southeast-1', labelKey: 'aiGateway.regions.singapore' },
    { value: 'us-east-1', labelKey: 'aiGateway.regions.virginia' },
    { value: 'eu-central-1', labelKey: 'aiGateway.regions.frankfurt' },
    { value: 'cn-qingdao', labelKey: 'aiGateway.regions.qingdao' }
  ]

  // Fetch configurations
  const fetchConfigs = async () => {
    setLoading(true)
    setError('')

    try {
      const token = session?.access_token
      if (!token) {
        setError(t('aiGateway.notLoggedIn'))
        setLoading(false)
        return
      }

      const gatewayRes = await fetch(`${apiUrl}/api/providers/${providerCode}/config`, {
        headers: { 'Authorization': `Bearer ${token}` }
      })
      const gatewayData = await gatewayRes.json()

      if (gatewayData.success) {
        const config = gatewayData.config
        setGatewayConfig({
          gatewayId: config.gatewayId || '',
          httpApiId: config.httpApiId || '',
          environmentId: config.environmentId || '',
          regionId: config.regionId || 'cn-hangzhou',
          gatewayDomain: config.gatewayDomain || '',
          hasCredentials: config.hasCredentials || false,
          maskedAccessKeyId: config.aliyunAccessKeyId || '',
          maskedAccessKeySecret: config.aliyunAccessKeySecret || ''
        })

        const akPlaceholder = config.apiKeyPlaceholder || ''
        const domPlaceholder = config.domainPlaceholder || ''
        setApiKeyPlaceholder(akPlaceholder)
        setDomainPlaceholder(domPlaceholder)
        setOriginalPlaceholders({ apiKey: akPlaceholder, domain: domPlaceholder })


        const tokenLimitRes = await fetch(`${apiUrl}/api/providers/${providerCode}/limit-config`, {
          headers: { 'Authorization': `Bearer ${token}` }
        })
        const tokenLimitData = await tokenLimitRes.json()

        if (tokenLimitData.success) {
          const budgets: Array<{timeRate: string, value: number, unit: string}> = tokenLimitData.config?.budgets || []
          const dailyBudget = budgets.find(b => b.timeRate === 'daily' && b.unit === 'token')
          const monthlyBudget = budgets.find(b => b.timeRate === 'monthly' && b.unit === 'token')
          const dailyVal = dailyBudget?.value || 0
          const monthlyVal = monthlyBudget?.value || 0
          setTokenRateLimitConfig({
            enabled: dailyVal > 0 || monthlyVal > 0,
            dailyTokenLimit: dailyVal,
            monthlyTokenLimit: monthlyVal
          })
          setDailyTokenLimitInput(dailyVal > 0 ? dailyVal.toString(): '')
          setMonthlyTokenLimitInput(monthlyVal > 0 ? monthlyVal.toString() : '')
        }
      }

    } catch (err) {
      console.error('Fetch config error:', err)
      setError(t('aiGateway.loadConfigFailed'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (session?.access_token) {
      fetchConfigs()
    }
  }, [session])

  // Save Gateway config
  const handleSaveGateway = async () => {
    setSaving(true)
    setError('')
    setSuccess('')

    try {
      const token = session?.access_token
      if (!token) {
        setError(t('aiGateway.notLoggedInShort'))
        return
      }

      const updateData: Record<string, string> = {
        gatewayId: gatewayConfig.gatewayId,
        httpApiId: gatewayConfig.httpApiId,
        regionId: gatewayConfig.regionId,
        environmentId: gatewayConfig.environmentId,
        gatewayDomain: gatewayConfig.gatewayDomain
      }

      if (apiKeyPlaceholder !== originalPlaceholders.apiKey) {
        updateData.apiKeyPlaceholder = apiKeyPlaceholder
      }
      if (domainPlaceholder !== originalPlaceholders.domain) {
        updateData.domainPlaceholder = domainPlaceholder
      }

      const response = await fetch(`${apiUrl}/api/providers/${providerCode}/config`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(updateData)
      })

      const data = await response.json()

      if (data.success) {
        setSuccess(t('aiGateway.configSaved'))
        fetchConfigs()
        onSave?.()
      } else {
        setError(data.error || t('aiGateway.saveFailed'))
      }
    } catch (err) {
      console.error('Save gateway config error:', err)
      setError(t('aiGateway.saveConfigFailed'))
    } finally {
      setSaving(false)
    }
  }

  // Save Aliyun AccessKey config
  const handleSaveAccessKey = async () => {
    setSavingAccessKey(true)
    setError('')
    setSuccess('')

    try {
      const token = session?.access_token
      if (!token) {
        setError(t('aiGateway.notLoggedInShort'))
        return
      }

      const updateData: Record<string, string> = {}
      if (accessKeyIdInput.trim()) {
        updateData.aliyunAccessKeyId = accessKeyIdInput
      }
      if (accessKeySecretInput.trim()) {
        updateData.aliyunAccessKeySecret = accessKeySecretInput
      }

      if (Object.keys(updateData).length === 0) {
        setError(t('aiGateway.enterAccessKey'))
        setSavingAccessKey(false)
        return
      }

      const response = await fetch(`${apiUrl}/api/providers/${providerCode}/config`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(updateData)
      })

      const data = await response.json()

      if (data.success) {
        setSuccess(t('aiGateway.credentialsSaved'))
        setAccessKeyIdInput('')
        setAccessKeySecretInput('')
        fetchConfigs()
        onSave?.()
      } else {
        setError(data.error || t('aiGateway.saveFailed'))
      }
    } catch (err) {
      console.error('Save accesskey config error:', err)
      setError(t('aiGateway.saveConfigFailed'))
    } finally {
      setSavingAccessKey(false)
    }
  }

  // Save Token Rate Limit config
  const handleSaveTokenRateLimit = async () => {
    setSavingTokenLimit(true)
    setError('')
    setSuccess('')

    try {
      const token = session?.access_token
      if (!token) {
        setError(t('aiGateway.notLoggedInShort'))
        return
      }

      const dailyTokenLimit = dailyTokenLimitInput.trim() === ''
        ? 0
        : parseInt(dailyTokenLimitInput, 10)

      const monthlyTokenLimit = monthlyTokenLimitInput.trim() === ''
        ? 0
        : parseInt(monthlyTokenLimitInput, 10)

      if (isNaN(dailyTokenLimit) || dailyTokenLimit < 0 || isNaN(monthlyTokenLimit) || monthlyTokenLimit < 0) {
        setError(t('aiGateway.enterValidNumber'))
        setSavingTokenLimit(false)
        return
      }

      const response = await fetch(`${apiUrl}/api/providers/${providerCode}/limit-config`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          budgets: [
            ...(dailyTokenLimit > 0 ? [{ timeRate: 'daily', value: dailyTokenLimit, unit: 'token' }] : []),
            ...(monthlyTokenLimit > 0 ? [{ timeRate: 'monthly', value: monthlyTokenLimit, unit: 'token' }] : [])
          ]
        })
      })

      const data = await response.json()

      if (data.success) {
        setSuccess(data.message || t('aiGateway.tokenRateLimitSaved'))
        fetchConfigs()
        onSave?.()
      } else {
        setError(data.error || t('aiGateway.saveFailed'))
      }
    } catch (err) {
      console.error('Save token rate limit config error:', err)
      setError(t('aiGateway.saveConfigFailed'))
    } finally {
      setSavingTokenLimit(false)
    }
  }

  if (loading) {
    return (
      <div className={`flex items-center justify-center ${embedded ? 'h-32' : 'h-64'}`}>
        <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
      </div>
    )
  }

  const configContent = (
    <>
      {/* Status Messages */}
      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2 text-red-700">
          <AlertCircle className="h-5 w-5" />
          {error}
        </div>
      )}
      {success && (
        <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg flex items-center gap-2 text-green-700">
          <CheckCircle className="h-5 w-5" />
          {success}
        </div>
      )}

      {/* AI Gateway Configuration */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 mb-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <Settings className="h-6 w-6 text-blue-500" />
            <h2 className="text-lg font-semibold text-gray-900">{t('aiGateway.title')}</h2>
          </div>
          {gatewayConfig.gatewayId && gatewayConfig.regionId && (
            <a
              href={`https://apig.console.aliyun.com/#/${gatewayConfig.regionId}/ai-gateway/${gatewayConfig.gatewayId}/model-api?region=${gatewayConfig.regionId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded-lg transition-colors"
              title={t('aiGateway.openConsoleTitle')}
            >
              <span>{t('aiGateway.openConsole')}</span>
              <ExternalLink className="h-4 w-4" />
            </a>
          )}
        </div>

        {/* Aliyun AccessKey Configuration */}
        <div className="mb-6 p-4 bg-gray-50 rounded-lg border border-gray-200">
          <h3 className="text-sm font-medium text-gray-900 mb-3 flex items-center gap-2">
            <Key className="h-4 w-4 text-gray-500" />
            {t('aiGateway.alibabaCloudCredentials')}
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {t('aiGateway.accessKeyId')}
              </label>
              <div className="relative">
                <input
                  type={showAccessKey ? 'text' : 'password'}
                  value={accessKeyIdInput}
                  onChange={(e) => setAccessKeyIdInput(e.target.value)}
                  placeholder={t('aiGateway.enterNewAccessKeyId')}
                  className="w-full px-3 py-2 pr-10 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                />
                <button
                  type="button"
                  onClick={() => setShowAccessKey(!showAccessKey)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                >
                  {showAccessKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {gatewayConfig.maskedAccessKeyId && (
                <p className="mt-1 text-xs text-gray-500">
                  {t('aiGateway.currentValue')} {gatewayConfig.maskedAccessKeyId}
                </p>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {t('aiGateway.accessKeySecret')}
              </label>
              <div className="relative">
                <input
                  type={showAccessKey ? 'text' : 'password'}
                  value={accessKeySecretInput}
                  onChange={(e) => setAccessKeySecretInput(e.target.value)}
                  placeholder={t('aiGateway.enterNewAccessKeySecret')}
                  className="w-full px-3 py-2 pr-10 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                />
                <button
                  type="button"
                  onClick={() => setShowAccessKey(!showAccessKey)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                >
                  {showAccessKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {gatewayConfig.maskedAccessKeySecret && (
                <p className="mt-1 text-xs text-gray-500">
                  {t('aiGateway.currentValue')} {gatewayConfig.maskedAccessKeySecret}
                </p>
              )}
            </div>
          </div>
          <button
            onClick={handleSaveAccessKey}
            disabled={savingAccessKey || (!accessKeyIdInput.trim() && !accessKeySecretInput.trim())}
            className="mt-3 flex items-center gap-2 px-3 py-1.5 text-sm bg-gray-600 text-white rounded-lg hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {savingAccessKey ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
            {t('aiGateway.saveCredentials')}
          </button>
        </div>

        {/* Placeholder Configuration */}
        <div className="mb-6 p-4 bg-gray-50 rounded-lg border border-gray-200">
          <h3 className="text-sm font-medium text-gray-900 mb-3 flex items-center gap-2">
            <Key className="h-4 w-4 text-gray-500" />
            {t('aiGateway.placeholderConfig')}
          </h3>
          <p className="text-xs text-gray-500 mb-4">
            {t('aiGateway.placeholderHint')}
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {t('aiGateway.apiKeyPlaceholder')}
              </label>
              <input
                type="text"
                value={apiKeyPlaceholder}
                onChange={(e) => setApiKeyPlaceholder(e.target.value)}
                placeholder={t('aiGateway.apiKeyPlaceholderExample')}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {t('aiGateway.domainPlaceholder')}
              </label>
              <input
                type="text"
                value={domainPlaceholder}
                onChange={(e) => setDomainPlaceholder(e.target.value)}
                placeholder={t('aiGateway.domainPlaceholderExample')}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
              />
            </div>
          </div>
        </div>

        {/* Gateway ID, HTTP API ID, Region */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t('aiGateway.gatewayId')} <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={gatewayConfig.gatewayId}
              onChange={(e) => setGatewayConfig({ ...gatewayConfig, gatewayId: e.target.value })}
              placeholder="gw-xxx"
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t('aiGateway.httpApiId')} <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={gatewayConfig.httpApiId}
              onChange={(e) => setGatewayConfig({ ...gatewayConfig, httpApiId: e.target.value })}
              placeholder="api-xxx"
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t('aiGateway.region')} <span className="text-red-500">*</span>
            </label>
            <select
              value={gatewayConfig.regionId}
              onChange={(e) => setGatewayConfig({ ...gatewayConfig, regionId: e.target.value })}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              {regionOptions.map(option => (
                <option key={option.value} value={option.value}>
                  {t(option.labelKey)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Environment ID
              <span className="ml-2 text-xs text-gray-400 font-normal">{t('aiGateway.autoFetchHint')}</span>
            </label>
            <input
              type="text"
              value={gatewayConfig.environmentId}
              onChange={(e) => setGatewayConfig({ ...gatewayConfig, environmentId: e.target.value })}
              placeholder={t('aiGateway.autoFetchAfterSave')}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t('aiGateway.gatewayDomain')}
              <span className="ml-2 text-xs text-gray-400 font-normal">{t('aiGateway.autoFetchHint')}</span>
            </label>
            <input
              type="text"
              value={gatewayConfig.gatewayDomain}
              onChange={(e) => setGatewayConfig({ ...gatewayConfig, gatewayDomain: e.target.value })}
              placeholder={t('aiGateway.autoFetchAfterSave')}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
        </div>

        <div className="mt-6">
          <button
            onClick={handleSaveGateway}
            disabled={saving}
            className="flex items-center gap-2 px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {t('aiGateway.saveGatewayConfig')}
          </button>
        </div>

        {/* Token Rate Limit Configuration */}
        <div className="mt-6 p-4 bg-amber-50 rounded-lg border border-amber-200">
          <h3 className="text-sm font-medium text-gray-900 mb-3 flex items-center gap-2">
            <Gauge className="h-4 w-4 text-amber-500" />
            {t('aiGateway.tokenRateLimitStrategy')}
          </h3>
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {t('aiGateway.dailyTokenLimit')}
              </label>
              <div className="flex items-center gap-3">
                <input
                  type="text"
                  value={dailyTokenLimitInput}
                  onChange={(e) => {
                    const val = e.target.value
                    if (val === '' || /^\d+$/.test(val)) {
                      setDailyTokenLimitInput(val)
                    }
                  }}
                  placeholder={t('aiGateway.noLimit')}
                  className="w-48 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-amber-500 focus:border-transparent text-sm"
                />
                <span className="text-sm text-gray-500">{t('aiGateway.tokensPerDay')}</span>
              </div>
              <p className="mt-1 text-xs text-gray-500">
                {t('aiGateway.noLimitHint')}
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {t('aiGateway.monthlyTokenLimit')}
              </label>
              <div className="flex items-center gap-3">
                <input
                  type="text"
                  value={monthlyTokenLimitInput}
                  onChange={(e) => {
                    const val = e.target.value
                    if (val === '' || /^\d+$/.test(val)) {
                      setMonthlyTokenLimitInput(val)
                    }
                  }}
                  placeholder={t('aiGateway.noLimit')}
                  className="w-48 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-amber-500 focus:border-transparent text-sm"
                />
                <span className="text-sm text-gray-500">{t('aiGateway.tokensPer30Days')}</span>
              </div>
              <p className="mt-1 text-xs text-gray-500">
                {t('aiGateway.noLimitBothHint')}
              </p>
            </div>

            {/* Current status indicator */}
            <div className="flex items-center gap-2 text-sm flex-wrap">
              <span className="text-gray-600">{t('aiGateway.currentStatus')}</span>
              {tokenRateLimitConfig.enabled && (tokenRateLimitConfig.dailyTokenLimit > 0 || tokenRateLimitConfig.monthlyTokenLimit > 0) ? (
                <>
                  {tokenRateLimitConfig.dailyTokenLimit > 0 && (
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800">
                      {t('aiGateway.daily')} {tokenRateLimitConfig.dailyTokenLimit.toLocaleString()} tokens
                    </span>
                  )}
                  {tokenRateLimitConfig.monthlyTokenLimit > 0 && (
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-orange-100 text-orange-800">
                      {t('aiGateway.per30Days')} {tokenRateLimitConfig.monthlyTokenLimit.toLocaleString()} tokens
                    </span>
                  )}
                </>
              ) : (
                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600">
                  {t('aiGateway.notEnabled')}
                </span>
              )}
            </div>

            <button
              onClick={handleSaveTokenRateLimit}
              disabled={savingTokenLimit}
              className="flex items-center gap-2 px-3 py-1.5 text-sm bg-amber-500 text-white rounded-lg hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {savingTokenLimit ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
              {t('aiGateway.saveTokenRateLimit')}
            </button>
          </div>
        </div>
      </div>
    </>
  )

  if (embedded) {
    return <div className="space-y-6">{configContent}</div>
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Cloud className="h-8 w-8 text-blue-500" />
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{t('aiGateway.title')}</h1>
            <p className="text-sm text-gray-500">{t('aiGateway.subtitle')}</p>
          </div>
        </div>
        <button
          onClick={fetchConfigs}
          className="flex items-center gap-2 px-3 py-2 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors"
        >
          <RefreshCw className="h-4 w-4" />
          {t('aiGateway.refresh')}
        </button>
      </div>
      {configContent}
    </div>
  )
}

export default AIGatewayConfig
