import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Bot, History, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../contexts/AuthContext'
import { apiUrl } from '../lib/api'
import { SandboxUpgradeTab, type SandboxUpgradeAgentType } from './AgentTypeDetail'

const InstanceUpgrade: React.FC = () => {
  const { t } = useTranslation('admin')
  const { session } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const accessTokenRef = useRef<string | null>(session?.access_token ?? null)
  const isAuthenticated = Boolean(session?.access_token)
  const requestedAgentTypeId = searchParams.get('agentTypeId') || ''
  const requestedSandboxName = searchParams.get('selectedSandbox') || undefined
  const [agentTypes, setAgentTypes] = useState<SandboxUpgradeAgentType[]>([])
  const [selectedAgentTypeId, setSelectedAgentTypeId] = useState(requestedAgentTypeId)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [successMessage, setSuccessMessage] = useState('')
  const [defaultAgentTypeApplied, setDefaultAgentTypeApplied] = useState(false)

  useEffect(() => {
    accessTokenRef.current = session?.access_token ?? null
  }, [session?.access_token])

  useEffect(() => {
    if (requestedAgentTypeId) setSelectedAgentTypeId(requestedAgentTypeId)
  }, [requestedAgentTypeId])

  const fetchAgentTypes = useCallback(async () => {
    const token = accessTokenRef.current
    if (!token) {
      setLoading(false)
      return
    }

    setLoading(true)
    try {
      const res = await fetch(`${apiUrl}/api/agent-types`, {
        headers: { 'Authorization': `Bearer ${token}` }
      })
      const data = await res.json()
      if (data.success) setAgentTypes(data.agentTypes || [])
    } catch (err) {
      console.error('Fetch agent types error:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (isAuthenticated) fetchAgentTypes()
  }, [fetchAgentTypes, isAuthenticated])

  useEffect(() => {
    if (defaultAgentTypeApplied || requestedAgentTypeId || selectedAgentTypeId || agentTypes.length === 0) return
    const firstUpgradeableAgentType = agentTypes.find(item => item.sandbox_template_id) || agentTypes[0]
    if (!firstUpgradeableAgentType) return
    setSelectedAgentTypeId(firstUpgradeableAgentType.id)
    setDefaultAgentTypeApplied(true)
  }, [defaultAgentTypeApplied, requestedAgentTypeId, selectedAgentTypeId, agentTypes])

  const selectAgentType = (agentTypeId: string) => {
    setSelectedAgentTypeId(agentTypeId)
    const params = new URLSearchParams()
    if (agentTypeId) params.set('agentTypeId', agentTypeId)
    setSearchParams(params, { replace: true })
  }

  const showSuccess = (msg: string) => {
    setSuccessMessage(msg)
    setTimeout(() => setSuccessMessage(''), 3000)
  }

  const selectedAgentType = agentTypes.find(at => at.id === selectedAgentTypeId) || null
  const selectableAgentTypes = agentTypes.filter(at => at.sandbox_template_id)
  const agentTypeOptions = selectableAgentTypes.length > 0 ? selectableAgentTypes : agentTypes

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-primary-600" />
        <span className="ml-3 text-gray-600">{t('common:loading.default')}</span>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {successMessage && (
        <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-green-700">
          {successMessage}
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-red-700">
          {error}
        </div>
      )}

      <div className="rounded-lg border border-gray-200 bg-white px-5 py-4">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary-50 text-primary-600">
              <History className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h2 className="text-lg font-semibold text-gray-900">{t('instanceUpgrade.title')}</h2>
              <p className="mt-1 text-sm text-gray-500">{t('instanceUpgrade.description')}</p>
            </div>
          </div>
          <div className="w-full xl:w-[360px]">
            <label className="mb-1 block text-sm font-medium text-gray-700">{t('instanceUpgrade.agentTypeLabel')}</label>
            <select
              value={selectedAgentTypeId}
              onChange={(event) => selectAgentType(event.target.value)}
              className="input-field"
            >
              <option value="">{t('instanceUpgrade.selectAgentType')}</option>
              {agentTypeOptions.map(at => (
                <option key={at.id} value={at.id}>
                  {at.name} ({at.code})
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {selectedAgentType ? (
        <SandboxUpgradeTab
          key={selectedAgentType.id}
          agentType={selectedAgentType}
          token={session!.access_token}
          initialSelectedSandboxName={requestedSandboxName}
          onError={setError}
          onSuccess={showSuccess}
        />
      ) : (
        <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-6 py-12 text-center">
          <Bot className="mx-auto h-10 w-10 text-gray-300" />
          <p className="mt-3 text-sm font-medium text-gray-700">{t('instanceUpgrade.emptyTitle')}</p>
          <p className="mt-1 text-sm text-gray-500">{t('instanceUpgrade.emptyDescription')}</p>
        </div>
      )}
    </div>
  )
}

export default InstanceUpgrade
