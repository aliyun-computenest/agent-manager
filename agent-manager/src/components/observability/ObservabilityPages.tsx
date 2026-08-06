import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../contexts/AuthContext'
import { apiUrl } from '../../lib/api'
import { Loader2, AlertCircle, RefreshCw, Activity, Bot, ExternalLink, Users, User, Settings, ChevronLeft, ChevronRight, CheckCircle, XCircle, Zap, Network, ArrowRight, AlertTriangle, PauseCircle } from 'lucide-react'
import IframeEmbed from '../IframeEmbed'
import toast from 'react-hot-toast'

/** Map backend error keywords to user-friendly messages with guidance */
function getFriendlyError(error: string, t: any): { title: string; detail: string; action?: string; actionHref?: string } {
  if (error.includes('NoPermission') || error.includes('not authorized') || error.includes('Forbidden')) {
    return {
      title: t('admin:observability.errors.permissionDenied.title'),
      detail: t('admin:observability.errors.permissionDenied.detail'),
      action: t('admin:observability.errors.permissionDenied.action'),
      actionHref: 'https://ram.console.aliyun.com/users'
    }
  }
  if (error.includes('INVALID_CREDENTIALS') || error.includes('InvalidAccessKeyId') || error.includes('SignatureDoesNotMatch')) {
    return {
      title: t('admin:observability.errors.invalidCredentials.title'),
      detail: t('admin:observability.errors.invalidCredentials.detail'),
    }
  }
  if (error.includes('AccessKey not configured') || error.includes('credentials not configured')) {
    return {
      title: t('admin:observability.errors.credentialsNotConfigured.title'),
      detail: t('admin:observability.errors.credentialsNotConfigured.detail'),
    }
  }
  if (error.includes('WORKSPACE_EMPTY') || error.includes('No CMS workspaces found')) {
    return {
      title: t('admin:observability.errors.workspaceCreationFailed.title'),
      detail: t('admin:observability.errors.workspaceCreationFailed.detail'),
    }
  }
  if (error.includes('REGION_NOT_FOUND')) {
    return {
      title: t('admin:observability.errors.regionNotFound.title'),
      detail: t('admin:observability.errors.regionNotFound.detail'),
      action: t('admin:observability.errors.regionNotFound.action')
    }
  }
  if (error.includes('SANDBOX_NOT_FOUND')) {
    return {
      title: t('admin:observability.errors.sandboxNotFound.title'),
      detail: t('admin:observability.errors.sandboxNotFound.detail'),
    }
  }
  if (error.includes('CONTAINER_INTEGRATION_FAILED')) {
    return {
      title: t('admin:observability.errors.containerIntegrationFailed.title'),
      detail: t('admin:observability.errors.containerIntegrationFailed.detail'),
    }
  }
  if (error.includes('ENTITY_NOT_FOUND')) {
    return {
      title: t('admin:observability.errors.entityNotFound.title'),
      detail: t('admin:observability.errors.entityNotFound.detail'),
    }
  }
  if (error.includes('INSTANCE_NOT_FOUND') || error.includes('Instance not found')) {
    return {
      title: t('admin:observability.errors.instanceNotFound.title'),
      detail: t('admin:observability.errors.instanceNotFound.detail'),
    }
  }
  if (error.includes('Gateway ID not configured') || error.includes('gatewayId')) {
    return {
      title: t('admin:observability.errors.gatewayNotConfigured.title'),
      detail: t('admin:observability.errors.gatewayNotConfigured.detail'),
      action: t('admin:observability.errors.gatewayNotConfigured.action')
    }
  }
  if (error.includes('CLUSTER_NOT_FOUND') || error.includes('No ACK clusters found') || error.includes('Multiple ACK clusters')) {
    return {
      title: t('admin:observability.errors.clusterConfigError.title'),
      detail: error.includes('Multiple')
        ? t('admin:observability.errors.clusterConfigError.detailMultiple')
        : t('admin:observability.errors.clusterConfigError.detailNotFound'),
    }
  }
  if (error.includes('Invalid or expired token') || error.includes('jwt') || error.includes('Unauthorized')) {
    return {
      title: t('admin:observability.errors.authExpired.title'),
      detail: t('admin:observability.errors.authExpired.detail'),
    }
  }
  return {
    title: t('admin:observability.errors.loadFailed'),
    detail: error,
  }
}

/** Auto-refresh ticket before 24h expiration (refresh every 20 hours) */
const TICKET_REFRESH_INTERVAL = 20 * 60 * 60 * 1000

function useTicketAutoRefresh(loadFn: () => Promise<void>, hasUrl: boolean) {
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const loadFnRef = useRef(loadFn)
  loadFnRef.current = loadFn

  useEffect(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    if (hasUrl) {
      timerRef.current = setInterval(() => {
        loadFnRef.current()
      }, TICKET_REFRESH_INTERVAL)
    }
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current)
      }
    }
  }, [hasUrl])
}

/** Integration status type — each resource has exists/ready/name/reason */
interface IntegrationStatus {
  workspace: { exists: boolean; ready: boolean; name: string; reason: string }
  policy: { exists: boolean; ready: boolean; name: string; reason: string }
  addon: { exists: boolean; ready: boolean; name: string; reason: string }
  entity: { exists: boolean; ready: boolean; name: string; reason: string }
}

/** Gateway integration resource labels */
function getGatewayResourceLabels(t: any): Record<string, { label: string; desc: string }> {
  return {
    workspace: { label: t('admin:observability.integration.gateway.workspace'), desc: t('admin:observability.integration.gateway.workspaceDesc') },
    policy: { label: t('admin:observability.integration.gateway.policy'), desc: t('admin:observability.integration.gateway.policyDesc') },
    addon: { label: t('admin:observability.integration.gateway.addon'), desc: t('admin:observability.integration.gateway.addonDesc') },
    entity: { label: t('admin:observability.integration.gateway.entity'), desc: t('admin:observability.integration.gateway.entityDesc') },
  }
}

/** Container integration resource labels */
function getContainerResourceLabels(t: any): Record<string, { label: string; desc: string }> {
  return {
    workspace: { label: t('admin:observability.integration.container.workspace'), desc: t('admin:observability.integration.container.workspaceDesc') },
    policy: { label: t('admin:observability.integration.container.policy'), desc: t('admin:observability.integration.container.policyDesc') },
    addon: { label: t('admin:observability.integration.container.addon'), desc: t('admin:observability.integration.container.addonDesc') },
    entity: { label: t('admin:observability.integration.container.entity'), desc: t('admin:observability.integration.container.entityDesc') },
  }
}

/** Hook to check integration status from backend */
function useIntegrationStatus(session: any, type: 'gateway' | 'pod') {
  const { t } = useTranslation('admin')
  const [status, setStatus] = useState<IntegrationStatus | null>(null)
  const [allReady, setAllReady] = useState(false)
  const [checking, setChecking] = useState(false)
  const [creating, setCreating] = useState(false)
  const [integrationError, setIntegrationError] = useState<string | null>(null)

  const checkStatus = useCallback(async () => {
    const token = session?.access_token
    if (!token) return
    setChecking(true)
    try {
      const response = await fetch(`${apiUrl}/api/observability/integration-status?type=${type}`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      const data = await response.json()
      if (!response.ok || !data.success) {
        setIntegrationError(data.error || '获取集成状态失败')
        return
      }
      if (data.success) {
        setStatus(data.resources)
        setAllReady(data.allReady)
        setIntegrationError(data.integrationError || null)
      }
    } catch (err) {
      console.warn('Failed to check integration status:', err)
    } finally {
      setChecking(false)
    }
  }, [session?.access_token, type])

  const createResources = useCallback(async () => {
    const token = session?.access_token
    if (!token) return
    setCreating(true)
    try {
      const response = await fetch(`${apiUrl}/api/observability/integration`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ type })
      })

      if (response.status === 202) {
        // Async mode: poll integration-status until done
        const maxAttempts = 20
        const interval = 10000
        for (let i = 0; i < maxAttempts; i++) {
          await new Promise(r => setTimeout(r, interval))
          const statusRes = await fetch(`${apiUrl}/api/observability/integration-status?type=${type}`, {
            headers: { Authorization: `Bearer ${token}` }
          })
          const statusData = await statusRes.json()
          if (statusData.success && statusData.allReady) {
            setStatus(statusData.resources)
            setAllReady(true)
            return { status: 'completed', created: Object.keys(statusData.resources || {}).filter(k => statusData.resources[k]?.status === 'Ready'), skipped: [] }
          }
          if (statusData.success && !statusData.creating && !statusData.allReady) {
            // Integration finished but not all ready — partial failure
            setStatus(statusData.resources)
            setAllReady(statusData.allReady)
            setIntegrationError(statusData.integrationError || null)
            return { status: 'failed', error: statusData.integrationError || t('observability.status.createResourcesFailed'), created: [], skipped: [] }
          }
          // Still creating, continue polling
        }
        // Timeout after max attempts
        return { status: 'failed', error: t('observability.status.createResourcesFailed'), created: [], skipped: [] }
      }

      const data = await response.json()
      if (data.status === 'failed') {
        return { status: 'failed', error: data.error || t('observability.status.createResourcesFailed'), created: [], skipped: [] }
      }
      // Fallback: re-check status (should not normally reach here)
      await checkStatus()
      return data
    } catch (err) {
      console.error('Failed to create integration resources:', err)
      return { status: 'failed', error: t('observability.status.createResourcesFailed'), created: [], skipped: [] }
    } finally {
      setCreating(false)
    }
  }, [session?.access_token, type, checkStatus, t])

  return { status, allReady, checking, creating, integrationError, checkStatus, createResources }
}

/** Status cards showing each resource's readiness with a "Create All" button */
function IntegrationStatusPanel({
  status,
  creating,
  onCreate,
  labels,
  integrationError
}: {
  status: IntegrationStatus
  creating: boolean
  onCreate: () => void
  labels: Record<string, { label: string; desc: string }>
  integrationError?: string | null
}) {
  const { t } = useTranslation('admin')
  const resourceKeys = ['workspace', 'policy', 'addon', 'entity'] as const
  const hasMissing = resourceKeys.some(k => !status[k].exists || (k === 'addon' && !status[k].ready))

  return (
    <div className="max-w-lg mx-auto">
      <div className="mb-4">
        <h3 className="text-base font-semibold text-gray-800 mb-1">{t('observability.integration.title')}</h3>
        <p className="text-xs text-gray-500">{t('observability.integration.description')}</p>
      </div>
      <div className="grid grid-cols-2 gap-3 mb-4">
        {resourceKeys.map(key => {
          const res = status[key]
          const info = labels[key]
          const isOk = res.exists && (key !== 'addon' || res.ready)
          return (
            <div
              key={key}
              className={`rounded-lg border p-3 ${isOk ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'}`}
            >
              <div className="flex items-center space-x-2 mb-1">
                {isOk ? (
                  <CheckCircle className="w-4 h-4 text-green-600 flex-shrink-0" />
                ) : (
                  <XCircle className="w-4 h-4 text-red-500 flex-shrink-0" />
                )}
                <span className="text-sm font-medium text-gray-800">{info.label}</span>
              </div>
              <p className="text-xs text-gray-500 ml-6">{info.desc}</p>
              {isOk && res.name && (
                <p className="text-xs text-green-700 ml-6 mt-1 truncate">{res.name}</p>
              )}
              {!isOk && res.reason && (
                <p className="text-xs text-red-600 ml-6 mt-1">{res.reason}</p>
              )}
            </div>
          )
        })}
      </div>
      {integrationError && (
        <div className="mb-3 p-2.5 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-xs text-red-600">{t('observability.status.createResourcesFailed')}: {integrationError}</p>
        </div>
      )}
      {hasMissing && (
        <button
          onClick={onCreate}
          disabled={creating}
          className="w-full inline-flex items-center justify-center px-4 py-2.5 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {creating ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              {t('observability.integration.creating')}
            </>
          ) : (
            <>
              <Zap className="w-4 h-4 mr-2" />
              {t('observability.integration.createAll')}
            </>
          )}
        </button>
      )}
    </div>
  )
}

/**
 * Pod observability page that uses the backend ticket endpoint (type="pod")
 * (URL is built dynamically from instanceId → sandbox_id → namespace/pod_name → Pod entity)
 * Always shows instance list sidebar for switching between instances
 */
interface PodObservabilityPageProps {
  instanceId: string
}

interface InstanceItem {
  id: string
  name: string
  status: string
  sandbox_id: string | null
  username?: string
}

function PodObservabilityPage({ instanceId }: PodObservabilityPageProps) {
  const { t } = useTranslation('admin')
  const { session } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [iframeUrl, setIframeUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const { status: integrationStatus, allReady, checking, creating, integrationError, checkStatus, createResources } = useIntegrationStatus(session, 'pod')

  // Instance list state
  const [instances, setInstances] = useState<InstanceItem[]>([])
  const [instancesLoading, setInstancesLoading] = useState(true)
  const [instancesError, setInstancesError] = useState('')
  const [instancesPagination, setInstancesPagination] = useState({
    page: 1,
    pageSize: 10,
    total: 0,
    totalPages: 0
  })

  // Check integration status on mount — if resources not ready, show creation panel immediately
  useEffect(() => {
    if (session?.access_token) {
      checkStatus()
    }
  }, [session?.access_token, checkStatus])

  // Restore page from URL and fetch instances on mount
  useEffect(() => {
    if (session?.access_token && allReady) {
      const params = new URLSearchParams(location.search)
      const pageFromUrl = parseInt(params.get('page') || '1', 10)
      const page = pageFromUrl >= 1 ? pageFromUrl : 1
      setInstancesPagination(prev => ({ ...prev, page }))
      fetchInstances(page)
    }
  }, [session?.access_token, allReady])

  const fetchInstances = async (targetPage?: number) => {
    const page = targetPage || instancesPagination.page
    setInstancesLoading(true)
    setInstancesError('')
    try {
      const token = session?.access_token
      if (!token) return
      const instancesEndpoint = '/api/admin/instances'
      const response = await fetch(`${apiUrl}${instancesEndpoint}?page=${page}&pageSize=${instancesPagination.pageSize}`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      const data = await response.json()
      if (!data.success) {
        console.error('Failed to fetch instances:', data.error)
        setInstancesError(data.error || t('observability.status.loadInstancesFailed'))
        return
      }
      const list = (data.instances || [])
        .filter((inst: InstanceItem) => inst.sandbox_id)
        .map((inst: InstanceItem) => ({
          id: inst.id,
          name: inst.name,
          status: inst.status,
          sandbox_id: inst.sandbox_id,
          username: inst.username
        }))
      setInstances(list)
      if (data.pagination) {
        setInstancesPagination(data.pagination)
      }
    } catch (err) {
      console.error('Error fetching instances:', err)
      setInstancesError(t('observability.status.loadInstancesFailed'))
    } finally {
      setInstancesLoading(false)
    }
  }

  const handleInstancesPageChange = (newPage: number) => {
    if (newPage >= 1 && newPage <= instancesPagination.totalPages) {
      fetchInstances(newPage)
    }
  }

  const skipLoadRef = useRef(false)

  const handleSelectInstance = (inst: InstanceItem) => {
    const page = instancesPagination.page
    const query = page > 1 ? `?page=${page}` : ''
    const isStopped = inst.status !== 'running'
    if (isStopped) {
      skipLoadRef.current = true
    }
    navigate(`/admin/observability/container/${inst.id}${query}`, { replace: true })
    if (isStopped) {
      setIframeUrl('')
      setError(t('observability.status.instanceStopped'))
      return
    }
    loadEmbedUrl(inst.id)
  }

  const loadEmbedUrl = useCallback(async (targetInstanceId?: string) => {
    const id = targetInstanceId || instanceId
    if (!id) return

    setLoading(true)
    setError('')
    setIframeUrl('')

    try {
      const token = session?.access_token
      if (!token) {
        setError(t('observability.status.notLoggedIn'))
        return
      }

      const response = await fetch(`${apiUrl}/api/observability/embed-url`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ type: 'pod', targetId: id })
      })

      const data = await response.json()
      if (data.success && data.embedUrl) {
        setIframeUrl(data.embedUrl)
      } else {
        setError(data.error || t('observability.status.generateEmbedUrlFailed'))
        // Auto-check integration status when embed URL fails
        checkStatus()
      }
    } catch (err) {
      console.error('Error generating embed URL:', err)
      setError(t('observability.status.generateEmbedUrlFailed'))
      checkStatus()
    } finally {
      setLoading(false)
    }
  }, [session?.access_token, instanceId, checkStatus, t])

  // Load embed when instanceId changes (from URL)
  useEffect(() => {
    if (session?.access_token && instanceId) {
      if (skipLoadRef.current) {
        skipLoadRef.current = false
        return
      }
      loadEmbedUrl(instanceId)
    }
  }, [session?.access_token, instanceId, loadEmbedUrl])

  // When instances load, check if the current instance is stopped (handles direct URL navigation)
  useEffect(() => {
    if (instanceId && instances.length > 0) {
      const inst = instances.find(i => i.id === instanceId)
      if (inst && inst.status !== 'running') {
        setIframeUrl('')
        setError(t('observability.status.instanceStopped'))
      }
    }
  }, [instances, instanceId, t])

  useTicketAutoRefresh(() => loadEmbedUrl(instanceId), !!iframeUrl)

  const handleCreateResources = async () => {
    const result = await createResources()
    if (result?.status !== 'failed') {
      // Re-try loading embed URL after successful creation
      loadEmbedUrl()
    }
  }

  const currentInstance = instances.find(i => i.id === instanceId)

  // Check if the error is a global one (credentials, workspace, etc.) that makes the sidebar useless
  const globalError = error ? getFriendlyError(error, t) : null
  const isGlobalError = !!(error && (
    error.includes('credentials not configured') ||
    error.includes('AccessKey not configured') ||
    error.includes('INVALID_CREDENTIALS') ||
    error.includes('InvalidAccessKeyId') ||
    error.includes('SignatureDoesNotMatch') ||
    error.includes('WORKSPACE_EMPTY') ||
    error.includes('No CMS workspaces found') ||
    error.includes('REGION_NOT_FOUND') ||
    error.includes('NoPermission') ||
    error.includes('not authorized') ||
    error.includes('CONTAINER_INTEGRATION_FAILED')
  ))

  const containerLabels = getContainerResourceLabels(t)

  // 1. Checking integration status — show loading spinner
  if (checking && !integrationStatus) {
    return (
      <div className="flex items-center justify-center h-full bg-gray-50">
        <div className="text-center">
          <Loader2 className="w-10 h-10 text-primary-600 animate-spin mx-auto mb-3" />
          <p className="text-gray-500 text-sm">{t('observability.status.checkingIntegrationStatus')}</p>
        </div>
      </div>
    )
  }

  // 2. Integration status checked and resources not ready — show creation panel immediately
  if (integrationStatus && !allReady) {
    return (
      <div className="flex items-center justify-center h-full bg-gray-50">
        <div className="text-center max-w-lg">
          <AlertCircle className="w-14 h-14 mx-auto mb-4 text-amber-500" />
          <p className="text-lg font-medium text-gray-700 mb-2">{t('observability.status.integrationResourcesNotReady')}</p>
          <p className="text-sm text-gray-500 mb-5">{t('observability.status.integrationResourcesMissing')}</p>
          <IntegrationStatusPanel
            status={integrationStatus}
            creating={creating}
            onCreate={handleCreateResources}
            labels={containerLabels}
            integrationError={integrationError}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full">
      {/* Global error: show full-screen message without sidebar */}
      {isGlobalError ? (
        <div className="flex-1 flex items-center justify-center bg-gray-50">
          <div className="text-center max-w-lg">
            <AlertCircle className="w-14 h-14 mx-auto mb-4 text-amber-500" />
            <p className="text-lg font-medium text-gray-700 mb-2">{globalError!.title}</p>
            <p className="text-sm text-gray-500 mb-5">{globalError!.detail}</p>
            <div className="flex items-center justify-center space-x-3">
              <button
                onClick={() => loadEmbedUrl()}
                className="inline-flex items-center px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors text-sm"
              >
                <RefreshCw className="w-4 h-4 mr-2" />
                {t('observability.status.retry')}
              </button>
              {globalError!.action && (
                <a
                  href={globalError!.actionHref || '/admin/models'}
                  target={globalError!.actionHref ? '_blank' : undefined}
                  rel={globalError!.actionHref ? 'noopener noreferrer' : undefined}
                  className="inline-flex items-center px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors text-sm"
                >
                  {globalError!.actionHref ? <ExternalLink className="w-4 h-4 mr-2" /> : <Settings className="w-4 h-4 mr-2" />}
                  {globalError!.action}
                </a>
              )}
            </div>
          </div>
        </div>
      ) : (
        <>
      {/* Left sidebar: instance list */}
      <div className="w-72 bg-white border-r border-gray-200 flex flex-col">
        <div className="p-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900 flex items-center">
            <Activity className="w-5 h-5 mr-2 text-primary-600" />
            {t('observability.sidebar.containerMonitor')}
          </h2>
          <p className="text-xs text-gray-500 mt-1">{t('observability.sidebar.selectInstance')}</p>
        </div>
        <div className="flex-1 overflow-auto">
          {instancesLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
            </div>
          ) : instancesError ? (
            <div className="p-4 text-center">
              <AlertCircle className="w-6 h-6 text-amber-500 mx-auto mb-2" />
              <p className="text-sm text-amber-600 mb-1">{t('observability.status.instanceLoadFailed')}</p>
              <p className="text-xs text-gray-500 mb-2 break-all">{instancesError}</p>
              <button
                onClick={() => fetchInstances(1)}
                className="text-xs text-primary-600 hover:text-primary-700"
              >
                {t('observability.status.retry')}
              </button>
            </div>
          ) : instances.length === 0 ? (
            <div className="p-4 text-center text-gray-500 text-sm">{t('observability.status.noDeployedInstances')}</div>
          ) : (
            <div className="divide-y divide-gray-100">
              {instances.map(inst => (
                <button
                  key={inst.id}
                  onClick={() => handleSelectInstance(inst)}
                  className={`w-full text-left p-4 hover:bg-gray-50 transition-colors ${
                    instanceId === inst.id ? 'bg-blue-50 border-l-4 border-primary-600' : 'border-l-4 border-transparent'
                  } ${inst.status !== 'running' ? 'opacity-50' : ''}`}
                >
                  <div className="flex items-start space-x-3">
                    <Bot className="w-5 h-5 text-gray-400 flex-shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">{inst.name}</p>
                      <p className="text-xs text-gray-400 font-mono truncate mt-0.5">{inst.sandbox_id}</p>
                      <div className="flex items-center justify-between mt-0.5">
                        {inst.username && (
                          <p className="text-xs text-gray-500 truncate flex-1 min-w-0 mr-2">{inst.username}</p>
                        )}
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium flex-shrink-0 ${
                          inst.status === 'running' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'
                        }`}>
                          {inst.status === 'running' ? t('observability.status.running') : inst.status}
                        </span>
                      </div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
        {/* Instance Pagination */}
        {instancesPagination.totalPages > 1 && (
          <div className="px-3 py-2 border-t border-gray-200 flex items-center justify-between bg-white">
            <div className="text-xs text-gray-500">
              {t('observability.status.total', { total: instancesPagination.total })}
            </div>
            <div className="flex items-center space-x-1">
              <button
                onClick={() => handleInstancesPageChange(instancesPagination.page - 1)}
                disabled={instancesPagination.page <= 1}
                className="p-1 rounded hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <ChevronLeft className="w-4 h-4 text-gray-600" />
              </button>
              {Array.from({ length: Math.min(5, instancesPagination.totalPages) }, (_, i) => {
                let pageNum: number
                if (instancesPagination.totalPages <= 5) {
                  pageNum = i + 1
                } else if (instancesPagination.page <= 3) {
                  pageNum = i + 1
                } else if (instancesPagination.page >= instancesPagination.totalPages - 2) {
                  pageNum = instancesPagination.totalPages - 4 + i
                } else {
                  pageNum = instancesPagination.page - 2 + i
                }
                return (
                  <button
                    key={pageNum}
                    onClick={() => handleInstancesPageChange(pageNum)}
                    className={`px-2 py-0.5 rounded text-xs font-medium ${
                      pageNum === instancesPagination.page
                        ? 'bg-primary-600 text-white'
                        : 'text-gray-600 hover:bg-gray-100'
                    }`}
                  >
                    {pageNum}
                  </button>
                )
              })}
              <button
                onClick={() => handleInstancesPageChange(instancesPagination.page + 1)}
                disabled={instancesPagination.page >= instancesPagination.totalPages}
                className="p-1 rounded hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <ChevronRight className="w-4 h-4 text-gray-600" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Right content: observability iframe */}
      <div className="flex-1 flex flex-col bg-gray-50">
        {currentInstance ? (
          <>
            <div className="bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-medium text-gray-900">{currentInstance.name}</h3>
                <p className="text-xs text-gray-500 mt-0.5 font-mono">{currentInstance.sandbox_id}</p>
              </div>
              <div className="flex items-center space-x-2">
                {error && (
                  <div className="flex items-center text-xs text-amber-600 bg-amber-50 px-2 py-1 rounded max-w-xs">
                    <AlertCircle className="w-3 h-3 mr-1 flex-shrink-0" />
                    <span className="truncate">{getFriendlyError(error, t).title}</span>
                  </div>
                )}
                {iframeUrl && (
                  <a
                    href={iframeUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center px-3 py-1.5 text-xs text-primary-600 hover:text-primary-700 border border-primary-200 rounded-md hover:bg-primary-50 transition-colors"
                  >
                    <ExternalLink className="w-3.5 h-3.5 mr-1" />
                    {t('observability.status.openInNewWindow')}
                  </a>
                )}
              </div>
            </div>
            <div className="flex-1 relative">
              {loading ? (
                <div className="absolute inset-0 flex items-center justify-center bg-gray-50">
                  <div className="text-center">
                    <Loader2 className="w-8 h-8 animate-spin text-primary-600 mx-auto mb-2" />
                    <p className="text-sm text-gray-500">{t('observability.status.generatingEmbedUrl')}</p>
                  </div>
                </div>
              ) : iframeUrl ? (
                <IframeEmbed url={iframeUrl} title={t('observability.title.containerMonitorWithInstance', { name: currentInstance.name })} />
              ) : !error ? (
                <div className="absolute inset-0 flex items-center justify-center bg-gray-50">
                  <div className="text-center text-gray-500">
                    <Activity className="w-12 h-12 mx-auto mb-3 text-gray-300" />
                    <p>{t('observability.status.selectInstance')}</p>
                  </div>
                </div>
              ) : (
                <div className="absolute inset-0 flex items-center justify-center bg-gray-50">
                  <div className="text-center max-w-lg">
                    <AlertCircle className="w-12 h-12 mx-auto mb-3 text-amber-500" />
                    <p className="font-medium text-gray-700 mb-1">{getFriendlyError(error, t).title}</p>
                    <p className="text-sm text-gray-500 mb-3">{getFriendlyError(error, t).detail}</p>
                    <div className="flex items-center justify-center space-x-3">
                      <button
                        onClick={() => loadEmbedUrl()}
                        className="inline-flex items-center px-3 py-1.5 text-xs bg-primary-600 text-white rounded-md hover:bg-primary-700"
                      >
                        <RefreshCw className="w-3 h-3 mr-1" />
                        {t('observability.status.retry')}
                      </button>
                      {getFriendlyError(error, t).action && (
                        <a
                          href="/admin/models"
                          className="inline-flex items-center px-3 py-1.5 text-xs border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50"
                        >
                          <Settings className="w-3 h-3 mr-1" />
                          {getFriendlyError(error, t).action}
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center text-gray-500">
              <Activity className="w-12 h-12 mx-auto mb-3 text-gray-300" />
              <p>{t('observability.status.selectInstance')}</p>
            </div>
          </div>
        )}
      </div>
        </>
      )}
    </div>
  )
}

/**
 * AI Gateway observability page with user list sidebar
 * Uses the backend ticket endpoint (type="gateway")
 * Always shows user list sidebar for switching between users
 */
interface CmsGatewayObservabilityPageProps {
  consumerName?: string
  title: string
}

interface UserItem {
  id: string
  username: string
  email: string
  consumerName: string
}

function sanitizeConsumerName(email: string): string {
  let name = email.replace(/@/g, '.').replace(/[^a-zA-Z0-9.\-]/g, '-')
  name = name.replace(/^[^a-zA-Z0-9]+/, '').replace(/[^a-zA-Z0-9]+$/, '')
  name = name.replace(/([.\-]){2,}/g, '$1')
  if (name.length > 64) {
    name = name.slice(0, 64).replace(/[^a-zA-Z0-9]+$/, '')
  }
  if (name.length < 2) {
    name = name.padEnd(2, '0')
  }
  return name
}

function CmsGatewayObservabilityPage({ consumerName, title }: CmsGatewayObservabilityPageProps) {
  const { t } = useTranslation('admin')
  const { session } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [iframeUrl, setIframeUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const { status: integrationStatus, allReady, checking, creating, integrationError, checkStatus, createResources } = useIntegrationStatus(session, 'gateway')

  // Provider type check: gateway monitoring requires AlibabaCloudAIGateway provider
  const [providerCheckLoading, setProviderCheckLoading] = useState(true)
  const [isAigwProvider, setIsAigwProvider] = useState(false)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [currentProviderName, setCurrentProviderName] = useState<string>('')

  // User list state
  const [users, setUsers] = useState<UserItem[]>([])
  const [usersLoading, setUsersLoading] = useState(false)
  const [usersError, setUsersError] = useState('')
  const [usersPagination, setUsersPagination] = useState({
    page: 1,
    pageSize: 10,
    total: 0,
    totalPages: 0
  })

  // Check provider type on mount — gateway monitoring requires AlibabaCloudAIGateway
  useEffect(() => {
    const checkProviderType = async () => {
      if (!session?.access_token) {
        setProviderCheckLoading(false)
        return
      }
      try {
        const response = await fetch(`${apiUrl}/api/providers`, {
          headers: { Authorization: `Bearer ${session.access_token}` }
        })
        const data = await response.json()
        if (data.success) {
          const enabledProvider = data.providers?.find((p: any) => p.isEnabled)
          if (enabledProvider && enabledProvider.type === 'AlibabaCloudAIGateway') {
            setIsAigwProvider(true)
            setCurrentProviderName(enabledProvider.displayName || enabledProvider.code)
          }
        }
      } catch (err) {
        console.warn('Failed to check provider type:', err)
      } finally {
        setProviderCheckLoading(false)
      }
    }
    checkProviderType()
  }, [session?.access_token])

  // Check integration status on mount — if resources not ready, show creation panel immediately
  useEffect(() => {
    if (session?.access_token && isAigwProvider) {
      checkStatus()
    }
  }, [session?.access_token, isAigwProvider, checkStatus])

  // Restore page from URL and fetch users on mount
  useEffect(() => {
    if (session?.access_token && allReady && isAigwProvider) {
      const params = new URLSearchParams(location.search)
      const pageFromUrl = parseInt(params.get('page') || '1', 10)
      const page = pageFromUrl >= 1 ? pageFromUrl : 1
      setUsersPagination(prev => ({ ...prev, page }))
      fetchUsers(page)
    }
  }, [session?.access_token, allReady, isAigwProvider])

  const fetchUsers = async (targetPage?: number) => {
    const page = targetPage || usersPagination.page
    setUsersLoading(true)
    setUsersError('')
    try {
      const token = session?.access_token
      if (!token) return
      const response = await fetch(`${apiUrl}/api/users?page=${page}&pageSize=${usersPagination.pageSize}`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      const data = await response.json()
      if (!data.success && data.users === undefined) {
        console.error('Failed to fetch users:', data.error)
        setUsersError(data.error || t('observability.status.loadUsersFailed'))
        return
      }
      const list = (data.users || [])
        .filter((u: any) => u.email)
        .map((u: any) => ({
          id: u.id,
          username: u.username || u.email.split('@')[0],
          email: u.email,
          consumerName: sanitizeConsumerName(u.email)
        }))
      setUsers(list)
      if (data.pagination) {
        setUsersPagination(data.pagination)
      }
    } catch (err) {
      console.error('Error fetching users:', err)
      setUsersError(t('observability.status.loadUsersFailed'))
    } finally {
      setUsersLoading(false)
    }
  }

  const handleUsersPageChange = (newPage: number) => {
    if (newPage >= 1 && newPage <= usersPagination.totalPages) {
      fetchUsers(newPage)
    }
  }

  const handleSelectUser = (user: UserItem | null) => {
    const cn = user ? user.consumerName : ''
    loadEmbedUrl(cn)
    // Update URL so it's bookmarkable, preserve current page
    const basePath = '/admin'
    const page = usersPagination.page
    const query = page > 1 ? `?page=${page}` : ''
    if (cn) {
      navigate(`${basePath}/observability/cms/user/${cn}${query}`, { replace: true })
    } else {
      navigate(`${basePath}/observability/cms${query}`, { replace: true })
    }
  }

  const loadEmbedUrl = useCallback(async (targetConsumerName?: string) => {
    setLoading(true)
    setError('')
    setIframeUrl('')

    try {
      const token = session?.access_token
      if (!token) {
        setError(t('observability.status.notLoggedIn'))
        return
      }

      const response = await fetch(`${apiUrl}/api/observability/embed-url`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ type: 'gateway', targetId: targetConsumerName })
      })

      const data = await response.json()
      if (data.success && data.embedUrl) {
        setIframeUrl(data.embedUrl)
      } else {
        setError(data.error || t('observability.status.generateEmbedUrlFailed'))
        // Auto-check integration status when embed URL fails
        checkStatus()
      }
    } catch (err) {
      console.error('Error generating CMS embed URL:', err)
      setError(t('observability.status.generateEmbedUrlFailed'))
      checkStatus()
    } finally {
      setLoading(false)
    }
  }, [session?.access_token, checkStatus, t])

  // Load embed when consumerName changes (from URL), or on initial page load without consumer
  // Only load when integration resources are ready
  useEffect(() => {
    if (session?.access_token && allReady) {
      loadEmbedUrl(consumerName || '')
    }
  }, [session?.access_token, consumerName, allReady, loadEmbedUrl])

  useTicketAutoRefresh(() => loadEmbedUrl(consumerName || ''), !!iframeUrl)

  const handleCreateResources = async () => {
    const result = await createResources()
    if (result?.status !== 'failed') {
      // Re-try loading embed URL after successful creation
      loadEmbedUrl(consumerName || '')
    }
  }

  const currentUser = users.find(u => u.consumerName === consumerName)

  // Check if the error is a global one (credentials, workspace, etc.) that makes the sidebar useless
  const globalError = error ? getFriendlyError(error, t) : null
  const isGlobalError = !!(error && (
    error.includes('credentials not configured') ||
    error.includes('AccessKey not configured') ||
    error.includes('INVALID_CREDENTIALS') ||
    error.includes('InvalidAccessKeyId') ||
    error.includes('SignatureDoesNotMatch') ||
    error.includes('WORKSPACE_EMPTY') ||
    error.includes('No CMS workspaces found') ||
    error.includes('REGION_NOT_FOUND') ||
    error.includes('NoPermission') ||
    error.includes('not authorized')
  ))

  const gatewayLabels = getGatewayResourceLabels(t)

  // 0. Provider type check loading
  if (providerCheckLoading) {
    return (
      <div className="flex items-center justify-center h-full bg-gray-50">
        <div className="text-center">
          <Loader2 className="w-10 h-10 text-primary-600 animate-spin mx-auto mb-3" />
          <p className="text-gray-500 text-sm">{t('observability.status.checkingProviderType')}</p>
        </div>
      </div>
    )
  }

  // 0.5 Not using AlibabaCloudAIGateway provider — show guidance
  if (!isAigwProvider) {
    return (
      <div className="flex items-center justify-center h-full bg-gray-50">
        <div className="text-center max-w-md">
          <Network className="w-16 h-16 mx-auto mb-4 text-gray-300" />
          <h2 className="text-xl font-semibold text-gray-800 mb-2">{t('observability.status.gatewayMonitorUnavailable.title')}</h2>
          <p className="text-sm text-gray-500 mb-6">{t('observability.status.gatewayMonitorUnavailable.description')}</p>
          <button
            onClick={() => navigate('/admin/models')}
            className="inline-flex items-center px-5 py-2.5 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors text-sm font-medium"
          >
            {t('observability.status.gatewayMonitorUnavailable.goToModelConfig')}
            <ArrowRight className="w-4 h-4 ml-2" />
          </button>
        </div>
      </div>
    )
  }

  // 1. Checking integration status — show loading spinner
  if (checking && !integrationStatus) {
    return (
      <div className="flex items-center justify-center h-full bg-gray-50">
        <div className="text-center">
          <Loader2 className="w-10 h-10 text-primary-600 animate-spin mx-auto mb-3" />
          <p className="text-gray-500 text-sm">{t('observability.status.checkingIntegrationStatus')}</p>
        </div>
      </div>
    )
  }

  // 2. Integration status checked and resources not ready — show creation panel immediately
  if (integrationStatus && !allReady) {
    return (
      <div className="flex items-center justify-center h-full bg-gray-50">
        <div className="text-center max-w-lg">
          <AlertCircle className="w-14 h-14 mx-auto mb-4 text-amber-500" />
          <p className="text-lg font-medium text-gray-700 mb-2">{t('observability.status.integrationResourcesNotReady')}</p>
          <p className="text-sm text-gray-500 mb-5">{t('observability.status.integrationResourcesMissing')}</p>
          <IntegrationStatusPanel
            status={integrationStatus}
            creating={creating}
            onCreate={handleCreateResources}
            labels={gatewayLabels}
            integrationError={integrationError}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full">
      {/* Global error: show full-screen message without sidebar */}
      {isGlobalError ? (
        <div className="flex-1 flex items-center justify-center bg-gray-50">
          <div className="text-center max-w-lg">
            <AlertCircle className="w-14 h-14 mx-auto mb-4 text-amber-500" />
            <p className="text-lg font-medium text-gray-700 mb-2">{globalError!.title}</p>
                <p className="text-sm text-gray-500 mb-5">{globalError!.detail}</p>
                <div className="flex items-center justify-center space-x-3">
                  <button
                    onClick={() => loadEmbedUrl(consumerName || '')}
                    className="inline-flex items-center px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors text-sm"
                  >
                    <RefreshCw className="w-4 h-4 mr-2" />
                    {t('observability.status.retry')}
                  </button>
                  {globalError!.action && (
                    <a
                      href={globalError!.actionHref || '/admin/models'}
                      target={globalError!.actionHref ? '_blank' : undefined}
                      rel={globalError!.actionHref ? 'noopener noreferrer' : undefined}
                      className="inline-flex items-center px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors text-sm"
                    >
                      {globalError!.actionHref ? <ExternalLink className="w-4 h-4 mr-2" /> : <Settings className="w-4 h-4 mr-2" />}
                      {globalError!.action}
                    </a>
                  )}
                </div>
          </div>
        </div>
      ) : (
        <>
      {/* Left sidebar: user list (always visible) */}
      <div className="w-72 bg-white border-r border-gray-200 flex flex-col">
        <div className="p-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900 flex items-center">
            <Network className="w-5 h-5 mr-2 text-primary-600" />
            {t('observability.sidebar.gatewayMonitor')}
          </h2>
          <p className="text-xs text-gray-500 mt-1">{t('observability.sidebar.selectUser')}</p>
        </div>
        <div className="flex-1 overflow-auto">
          {usersLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
            </div>
          ) : usersError ? (
            <div className="p-4 text-center">
              <AlertCircle className="w-6 h-6 text-amber-500 mx-auto mb-2" />
              <p className="text-sm text-amber-600 mb-1">{t('observability.status.userListLoadFailed')}</p>
              <p className="text-xs text-gray-500 mb-2 break-all">{usersError}</p>
              <button
                onClick={() => fetchUsers(1)}
                className="text-xs text-primary-600 hover:text-primary-700"
              >
                {t('observability.status.retry')}
              </button>
            </div>
          ) : (<>
            {/* All Users — pinned filter card, visually distinct from the list */}
            <div className="px-3 pt-3 pb-2">
              <button
                onClick={() => handleSelectUser(null)}
                className={`w-full text-left p-3 rounded-lg transition-colors ${
                  !consumerName
                    ? 'bg-primary-50 ring-1 ring-primary-200'
                    : 'bg-gray-50 hover:bg-gray-100'
                }`}
              >
                <div className="flex items-center space-x-3">
                  <div className={`flex items-center justify-center w-8 h-8 rounded-full flex-shrink-0 ${
                    !consumerName ? 'bg-primary-100' : 'bg-gray-200'
                  }`}>
                    <Users className={`w-4 h-4 ${!consumerName ? 'text-primary-600' : 'text-gray-500'}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm font-medium ${!consumerName ? 'text-primary-700' : 'text-gray-700'}`}>{t('observability.sidebar.allUsers')}</p>
                    <p className={`text-xs mt-0.5 ${!consumerName ? 'text-primary-500' : 'text-gray-400'}`}>{t('observability.sidebar.allUsersDesc')}</p>
                  </div>
                </div>
              </button>
            </div>
            {/* Divider between pinned filter and user list */}
            <div className="mx-3 border-t border-gray-200" />
            {/* User list */}
            <div className="divide-y divide-gray-100">
              {users.map(user => (
                <button
                  key={user.id}
                  onClick={() => handleSelectUser(user)}
                  className={`w-full text-left p-4 hover:bg-gray-50 transition-colors ${
                    consumerName === user.consumerName ? 'bg-blue-50 border-l-4 border-primary-600' : 'border-l-4 border-transparent'
                  }`}
                >
                  <div className="flex items-start space-x-3">
                    <User className="w-5 h-5 text-gray-400 flex-shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">{user.username}</p>
                      <p className="text-xs text-gray-400 truncate mt-0.5">{user.email}</p>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </>)}
        </div>
        {/* User Pagination */}
        {usersPagination.totalPages > 1 && (
          <div className="px-3 py-2 border-t border-gray-200 flex items-center justify-between bg-white">
            <div className="text-xs text-gray-500">
              {t('observability.status.total', { total: usersPagination.total })}
            </div>
            <div className="flex items-center space-x-1">
              <button
                onClick={() => handleUsersPageChange(usersPagination.page - 1)}
                disabled={usersPagination.page <= 1}
                className="p-1 rounded hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <ChevronLeft className="w-4 h-4 text-gray-600" />
              </button>
              {Array.from({ length: Math.min(5, usersPagination.totalPages) }, (_, i) => {
                let pageNum: number
                if (usersPagination.totalPages <= 5) {
                  pageNum = i + 1
                } else if (usersPagination.page <= 3) {
                  pageNum = i + 1
                } else if (usersPagination.page >= usersPagination.totalPages - 2) {
                  pageNum = usersPagination.totalPages - 4 + i
                } else {
                  pageNum = usersPagination.page - 2 + i
                }
                return (
                  <button
                    key={pageNum}
                    onClick={() => handleUsersPageChange(pageNum)}
                    className={`px-2 py-0.5 rounded text-xs font-medium ${
                      pageNum === usersPagination.page
                        ? 'bg-primary-600 text-white'
                        : 'text-gray-600 hover:bg-gray-100'
                    }`}
                  >
                    {pageNum}
                  </button>
                )
              })}
              <button
                onClick={() => handleUsersPageChange(usersPagination.page + 1)}
                disabled={usersPagination.page >= usersPagination.totalPages}
                className="p-1 rounded hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <ChevronRight className="w-4 h-4 text-gray-600" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Right content: observability iframe */}
      <div className="flex-1 flex flex-col bg-gray-50">
        <div className="bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium text-gray-900">
              {currentUser ? currentUser.username : t('observability.sidebar.allUsers')}
            </h3>
            <p className="text-xs text-gray-500 mt-0.5">
              {currentUser ? `Consumer: ${consumerName || ''}` : t('observability.sidebar.allUsersDesc')}
            </p>
          </div>
          <div className="flex items-center space-x-2">
            {error && (
              <div className="flex items-center text-xs text-amber-600 bg-amber-50 px-2 py-1 rounded max-w-xs">
                <AlertCircle className="w-3 h-3 mr-1 flex-shrink-0" />
                <span className="truncate">{getFriendlyError(error, t).title}</span>
              </div>
            )}
            {iframeUrl && (
              <a
                href={iframeUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center px-3 py-1.5 text-xs text-primary-600 hover:text-primary-700 border border-primary-200 rounded-md hover:bg-primary-50 transition-colors"
              >
                <ExternalLink className="w-3.5 h-3.5 mr-1" />
                {t('observability.status.openInNewWindow')}
              </a>
            )}
          </div>
        </div>
        <div className="flex-1 relative">
          {loading ? (
            <div className="absolute inset-0 flex items-center justify-center bg-gray-50">
              <div className="text-center">
                <Loader2 className="w-8 h-8 animate-spin text-primary-600 mx-auto mb-2" />
                <p className="text-sm text-gray-500">{t('observability.status.generatingEmbedUrl')}</p>
              </div>
            </div>
          ) : iframeUrl ? (
            <IframeEmbed url={iframeUrl} title={title} />
          ) : !error ? (
            <div className="absolute inset-0 flex items-center justify-center bg-gray-50">
              <div className="text-center text-gray-500">
                <Users className="w-12 h-12 mx-auto mb-3 text-gray-300" />
                <p>{t('observability.status.selectUserToView')}</p>
              </div>
            </div>
          ) : (
            <div className="absolute inset-0 flex items-center justify-center bg-gray-50">
              <div className="text-center max-w-md">
                <AlertCircle className="w-12 h-12 mx-auto mb-3 text-amber-500" />
                <p className="font-medium text-gray-700 mb-1">{getFriendlyError(error, t).title}</p>
                <p className="text-sm text-gray-500 mb-3">{getFriendlyError(error, t).detail}</p>
                <div className="flex items-center justify-center space-x-3">
                  <button
                    onClick={() => loadEmbedUrl(consumerName || '')}
                    className="inline-flex items-center px-3 py-1.5 text-xs bg-primary-600 text-white rounded-md hover:bg-primary-700"
                  >
                    <RefreshCw className="w-3 h-3 mr-1" />
                    {t('observability.status.retry')}
                  </button>
                  {getFriendlyError(error, t).action && (
                    <a
                      href="/admin/models"
                      className="inline-flex items-center px-3 py-1.5 text-xs border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50"
                    >
                      <Settings className="w-3 h-3 mr-1" />
                      {getFriendlyError(error, t).action}
                    </a>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
        </>
      )}
    </div>
  )
}

export function CmsGatewayObservability() {
  const { t } = useTranslation('admin')
  const { consumerName } = useParams<{ consumerName?: string }>()
  return <CmsGatewayObservabilityPage consumerName={consumerName} title={t('observability.title.gatewayMonitor')} />
}

export function PodObservability() {
  const { instanceId } = useParams<{ instanceId: string }>()
  return <PodObservabilityPage instanceId={instanceId || ''} />
}

/**
 * APM GenAI Service observability page
 * Uses the backend apm-ticket endpoint (entityId resolved via CMS GetEntityStoreData API)
 * Always shows instance list sidebar for switching between instances
 * Includes install command generation for instances without APM service
 */
function ApmObservabilityPage({ instanceId, title }: { instanceId: string; title: string }) {
  const { session } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const { t } = useTranslation('admin')
  const [iframeUrl, setIframeUrl] = useState('')

  // APM status machine
  type ApmStatus = 'idle' | 'loading' | 'ready' | 'no_params' | 'no_entity' | 'error' | 'disabled'
  const [apmStatus, setApmStatus] = useState<ApmStatus>('idle')
  // Diagnosis info driven by app-monitor/status API
  const [statusSubstatus, setStatusSubstatus] = useState<string>('')
  const [statusMessage, setStatusMessage] = useState<string>('')
  const [statusConfigUrl, setStatusConfigUrl] = useState<string | null>(null)
  const [showErrorDetail, setShowErrorDetail] = useState(false)
  const [errorDetail, setErrorDetail] = useState({ code: '', message: '', lastAttempt: '' })

  // Instance list state
  const [instances, setInstances] = useState<InstanceItem[]>([])
  const [instancesLoading, setInstancesLoading] = useState(false)
  const [instancesError, setInstancesError] = useState('')
  const [selectedInstanceId, setSelectedInstanceId] = useState(instanceId)
  const [instancesPagination, setInstancesPagination] = useState({
    page: 1,
    pageSize: 10,
    total: 0,
    totalPages: 0
  })


  // Workspace state (derived from app-monitor/status platform.workspaceReady)
  const [workspaceExists, setWorkspaceExists] = useState<boolean | null>(true)
  const [creatingWorkspace, setCreatingWorkspace] = useState(false)

  const handleCreateWorkspace = async () => {
    setCreatingWorkspace(true)
    try {
      const token = session?.access_token
      if (!token) return
      const response = await fetch(`${apiUrl}/api/observability/integration`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ type: 'pod' })
      })
      const data = await response.json()
      if (data.status === 'ready' || response.status === 202) {
        toast.success('项目空间创建成功')
        setWorkspaceExists(true)
      } else {
        toast.error(data.error || '创建项目空间失败')
      }
    } catch {
      toast.error('创建项目空间失败')
    } finally {
      setCreatingWorkspace(false)
    }
  }

  // Fetch APM monitoring status for a single instance (drives the right panel UI).
  // No auto-polling; refresh only happens on explicit user action.
  const loadStatus = async (targetInstanceId: string) => {
    if (!targetInstanceId) return
    setApmStatus('loading')
    setIframeUrl('')
    setStatusSubstatus('')
    setStatusMessage('')
    setStatusConfigUrl(null)
    try {
      const token = session?.access_token
      if (!token) {
        setApmStatus('error')
        setErrorDetail({ code: 'AUTH_ERROR', message: '未登录', lastAttempt: new Date().toISOString() })
        return
      }
      const response = await fetch(`${apiUrl}/api/observability/instances/${targetInstanceId}/app-monitor/status`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      const data = await response.json()
      if (!data.success) {
        // 实例不存在时，清除选中状态，让用户重新选择
        if (response.status === 404) {
          setSelectedInstanceId('')
          setApmStatus('idle')
          return
        }
        setApmStatus('error')
        setErrorDetail({ code: 'STATUS_ERROR', message: data.error || '获取监控状态失败', lastAttempt: new Date().toISOString() })
        return
      }
      // Update workspace state from platform info
      if (data.platform?.workspaceReady !== undefined) {
        setWorkspaceExists(data.platform.workspaceReady)
      }
      setStatusMessage(data.instance?.reason || data.message || '')
      setStatusConfigUrl(data.agentTypeConfigUrl || null)
      setStatusSubstatus(data.instance?.substatus || data.substatus || '')
      const effectiveStatus = data.instance?.status || data.status
      switch (effectiveStatus) {
        case 'ready':
          loadEmbedUrl(targetInstanceId)
          break
        case 'no_params':
          setApmStatus('no_params')
          break
        case 'disabled':
          setApmStatus('disabled')
          break
        case 'no_entity':
          setApmStatus('no_entity')
          break
        default:
          setApmStatus('error')
          setErrorDetail({ code: 'UNKNOWN_STATUS', message: data.message || '未知状态', lastAttempt: new Date().toISOString() })
      }
    } catch (err) {
      console.error('Error fetching APM status:', err)
      setApmStatus('error')
      setErrorDetail({ code: 'NETWORK_ERROR', message: '获取监控状态失败', lastAttempt: new Date().toISOString() })
    }
  }


  // Fetch instances on mount
  useEffect(() => {
    if (session?.access_token) {
      const params = new URLSearchParams(location.search)
      const pageFromUrl = parseInt(params.get('page') || '1', 10)
      const page = pageFromUrl >= 1 ? pageFromUrl : 1
      setInstancesPagination(prev => ({ ...prev, page }))
      fetchInstances(page)
    }
  }, [session?.access_token])

  const fetchInstances = async (targetPage?: number) => {
    const page = targetPage || instancesPagination.page
    setInstancesLoading(true)
    setInstancesError('')
    try {
      const token = session?.access_token
      if (!token) return
      const response = await fetch(`${apiUrl}/api/admin/instances?page=${page}&pageSize=${instancesPagination.pageSize}`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      const data = await response.json()
      if (!data.success) {
        console.error('Failed to fetch instances:', data.error)
        setInstancesError(data.error || t('observability.status.loadInstancesFailed'))
        return
      }
      const list = (data.instances || [])
        .filter((inst: any) => inst.sandbox_id)
        .map((inst: any) => ({
          id: inst.id,
          name: inst.name,
          status: inst.status,
          sandbox_id: inst.sandbox_id,
          username: inst.username
        }))
      setInstances(list)
      if (data.pagination) {
        setInstancesPagination(data.pagination)
      }
    } catch (err) {
      console.error('Error fetching instances:', err)
      setInstancesError(t('observability.status.loadInstancesFailed'))
    } finally {
      setInstancesLoading(false)
    }
  }

  const handleInstancesPageChange = (newPage: number) => {
    if (newPage >= 1 && newPage <= instancesPagination.totalPages) {
      fetchInstances(newPage)
    }
  }

  const handleSelectInstance = (inst: InstanceItem) => {
    setSelectedInstanceId(inst.id)
    // Reset all APM states when switching instances
    setShowErrorDetail(false)
    setErrorDetail({ code: '', message: '', lastAttempt: '' })
    setIframeUrl('')
    loadStatus(inst.id)
    navigate(`/admin/observability/app-monitor/instance/${inst.id}`, { replace: true })
  }

  const loadEmbedUrl = async (targetInstanceId: string, silent?: boolean) => {
    if (!targetInstanceId) return

    if (!silent) {
      setApmStatus('loading')
      setIframeUrl('')
    }

    try {
      const token = session?.access_token
      if (!token) {
        setApmStatus('error')
        setErrorDetail({ code: 'AUTH_ERROR', message: '未登录', lastAttempt: new Date().toISOString() })
        return
      }

      const response = await fetch(`${apiUrl}/api/observability/embed-url`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ type: 'apm', instanceId: targetInstanceId })
      })

      const data = await response.json()
      if (data.success && data.embedUrl) {
        setIframeUrl(data.embedUrl)
        setApmStatus('ready')
      } else {
        const rawError = data.error || '生成嵌入链接失败'
        if (rawError.includes('PLUGIN_NOT_INSTALLED')) {
          setApmStatus('no_entity')
          setStatusSubstatus('need_upgrade')
          setStatusMessage('未检测到探针插件，请升级实例镜像至最新版本。')
        } else if (rawError.includes('NO_TRACE_YET')) {
          setApmStatus('no_entity')
          setStatusSubstatus('awaiting_conversation')
          setStatusMessage('探针已就绪，发起一次对话后即可上报数据。')
        } else {
          setApmStatus('error')
          setErrorDetail({ code: 'UNKNOWN', message: rawError, lastAttempt: new Date().toISOString() })
        }
      }
    } catch (err) {
      console.error('Error generating APM embed URL:', err)
      const errMsg = '生成嵌入链接失败'
      setApmStatus('error')
      setErrorDetail({ code: 'NETWORK_ERROR', message: errMsg, lastAttempt: new Date().toISOString() })
    }
  }




  // Load status when instanceId changes (from URL)
  useEffect(() => {
    if (session?.access_token && instanceId) {
      setSelectedInstanceId(instanceId)
      loadStatus(instanceId)
    }
  }, [session?.access_token, instanceId])

  const currentInstance = instances.find(i => i.id === selectedInstanceId)

  return (
    <div className="flex h-full">
      {/* Left sidebar: instance list (always visible) */}
      <div className="w-72 bg-white border-r border-gray-200 flex flex-col">
        <div className="p-4 border-b border-gray-200">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900 flex items-center">
              <Bot className="w-5 h-5 mr-2 text-primary-600" />
              {title}
            </h2>
          </div>
          <p className="text-xs text-gray-500 mt-2">选择实例查看应用可观测</p>
        </div>
        <div className="flex-1 overflow-auto">
          {instancesLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
            </div>
          ) : instancesError ? (
            <div className="p-4 text-center text-red-500 text-sm">{instancesError}</div>
          ) : instances.length === 0 ? (
            <div className="p-4 text-center text-gray-500 text-sm">{t('observability.status.noDeployedInstances')}</div>
          ) : (
            <div className="divide-y divide-gray-100">
              {instances.map(inst => {
                return (
                <div
                  key={inst.id}
                  onClick={() => handleSelectInstance(inst)}
                  className={`w-full text-left p-4 hover:bg-gray-50 transition-colors cursor-pointer ${
                    selectedInstanceId === inst.id ? 'bg-blue-50 border-l-4 border-primary-600' : 'border-l-4 border-transparent'
                  } ${inst.status !== 'running' ? 'opacity-50' : ''}`}
                >
                  <div className="flex items-start space-x-3">
                    <Bot className="w-5 h-5 text-gray-400 flex-shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <p className="text-sm font-medium text-gray-900 truncate">{inst.name}</p>
                      </div>
                      <p className="text-xs text-gray-400 font-mono truncate mt-0.5">{inst.sandbox_id}</p>
                      <div className="flex items-center justify-between mt-0.5">
                        {inst.username && (
                          <p className="text-xs text-gray-500 truncate flex-1 min-w-0 mr-2">{inst.username}</p>
                        )}
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium flex-shrink-0 ${
                          inst.status === 'running' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'
                        }`}>
                          {inst.status === 'running' ? t('observability.status.running') : inst.status}
                        </span>
                      </div>
                      {/* Diagnosis hints removed from list cards — shown in detail panel instead */}
                    </div>
                  </div>
                </div>
                )
              })}
            </div>
          )}
        </div>
        {/* Instance Pagination */}
        {instancesPagination.totalPages > 1 && (
          <div className="px-3 py-2 border-t border-gray-200 flex items-center justify-between bg-white">
            <div className="text-xs text-gray-500">
              {t('observability.status.total', { total: instancesPagination.total })}
            </div>
            <div className="flex items-center space-x-1">
              <button
                onClick={() => handleInstancesPageChange(instancesPagination.page - 1)}
                disabled={instancesPagination.page <= 1}
                className="p-1 rounded hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <ChevronLeft className="w-4 h-4 text-gray-600" />
              </button>
              {Array.from({ length: Math.min(5, instancesPagination.totalPages) }, (_, i) => {
                let pageNum = 1
                if (instancesPagination.totalPages <= 5) {
                  pageNum = i + 1
                } else if (instancesPagination.page <= 3) {
                  pageNum = i + 1
                } else if (instancesPagination.page >= instancesPagination.totalPages - 2) {
                  pageNum = instancesPagination.totalPages - 4 + i
                } else {
                  pageNum = instancesPagination.page - 2 + i
                }
                return (
                  <button
                    key={pageNum}
                    onClick={() => handleInstancesPageChange(pageNum)}
                    className={`px-2 py-1 rounded text-xs ${
                      pageNum === instancesPagination.page
                        ? 'bg-primary-600 text-white'
                        : 'text-gray-600 hover:bg-gray-100'
                    }`}
                  >
                    {pageNum}
                  </button>
                )
              })}
              <button
                onClick={() => handleInstancesPageChange(instancesPagination.page + 1)}
                disabled={instancesPagination.page >= instancesPagination.totalPages}
                className="p-1 rounded hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <ChevronRight className="w-4 h-4 text-gray-600" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Right content: observability iframe */}
      <div className="flex-1 flex flex-col bg-gray-50">
        {/* Workspace loading state */}
        {workspaceExists === false ? (
          /* Workspace guidance panel */
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center max-w-md p-8">
              <AlertTriangle className="w-16 h-16 mx-auto mb-4 text-yellow-500" />
              <h3 className="text-lg font-semibold text-gray-900 mb-2">⚠️ 尚未创建 CMS 项目空间</h3>
              <p className="text-sm text-gray-600 mb-6">AI 应用监控需要 CMS 项目空间来存储和展示监控数据</p>
              <button
                onClick={handleCreateWorkspace}
                disabled={creatingWorkspace}
                className="inline-flex items-center px-6 py-3 text-sm text-white bg-primary-600 hover:bg-primary-700 rounded-lg disabled:opacity-50 shadow-sm"
              >
                {creatingWorkspace ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Zap className="w-4 h-4 mr-2" />
                )}
                一键创建项目空间
              </button>
            </div>
          </div>
        ) : currentInstance ? (
          <>
            {/* Toolbar */}
            <div className="bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-medium text-gray-900">{currentInstance.name}</h3>
                <p className="text-xs text-gray-500 mt-0.5 font-mono">{currentInstance.sandbox_id}</p>
              </div>
              <div className="flex items-center space-x-2">
                {/* Agent Type level collection status (read-only) */}
                {apmStatus === 'disabled' && (
                  <div className="flex items-center text-xs text-gray-500 bg-gray-100 px-2 py-1 rounded">
                    <PauseCircle className="w-3 h-3 mr-1 flex-shrink-0" />
                    采集已关闭，请前往 Agent Type 配置页开启
                  </div>
                )}
                {/* Error state - show error + detail toggle */}
                {apmStatus === 'error' && (
                  <>
                    <div className="flex items-center text-xs text-red-600 bg-red-50 px-2 py-1 rounded">
                      <AlertCircle className="w-3 h-3 mr-1 flex-shrink-0" />
                      <span className="truncate max-w-xs">{errorDetail.message || t('observability.apm.error.retry')}</span>
                    </div>
                    <button onClick={() => setShowErrorDetail(!showErrorDetail)} className="text-xs text-blue-600 hover:underline">
                      {t('observability.apm.error.viewDetail')}
                    </button>
                    <button onClick={() => loadEmbedUrl(selectedInstanceId)} className="inline-flex items-center px-3 py-1.5 text-xs text-white bg-primary-600 hover:bg-primary-700 rounded-md">
                      <RefreshCw className="w-3 h-3 mr-1" />
                      {t('observability.apm.error.retry')}
                    </button>
                  </>
                )}
                {/* Ready - show "open in new window" */}
                {apmStatus === 'ready' && iframeUrl && (
                  <a href={iframeUrl} target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center px-3 py-1.5 text-xs text-primary-600 border border-primary-600 rounded-md hover:bg-primary-50">
                    <ExternalLink className="w-3.5 h-3.5 mr-1" />
                    {t('observability.status.openInNewWindow')}
                  </a>
                )}
              </div>
            </div>
            {/* Main content area */}
            <div className="flex-1 relative">
              {/* Collection disabled at Agent Type level (read-only) */}
              {apmStatus === 'disabled' && (
                <div className="absolute inset-0 flex items-center justify-center bg-gray-50">
                  <div className="text-center max-w-md">
                    <PauseCircle className="w-12 h-12 mx-auto mb-3 text-gray-300" />
                    <p className="font-medium text-gray-700">采集已关闭</p>
                    <p className="text-sm text-gray-400 mt-1">
                      {statusMessage || '该 Agent 类型的可观测性采集已关闭，开启后即可上报数据。'}
                    </p>
                    {statusConfigUrl && (
                      <button onClick={() => navigate(statusConfigUrl)}
                        className="mt-4 inline-flex items-center px-4 py-2 text-sm text-white bg-primary-600 hover:bg-primary-700 rounded-md">
                        <ArrowRight className="w-4 h-4 mr-2" />
                        前往开启采集
                      </button>
                    )}
                  </div>
                </div>
              )}
              {/* No observability params configured */}
              {apmStatus === 'no_params' && (
                <div className="absolute inset-0 flex items-center justify-center bg-gray-50">
                  <div className="text-center max-w-md">
                    <AlertTriangle className="w-12 h-12 mx-auto mb-3 text-yellow-500" />
                    <p className="font-medium text-gray-700">未配置可观测参数</p>
                    <p className="text-sm text-gray-400 mt-1">
                      {statusMessage || '该实例的 Agent 类型尚未配置可观测性参数。'}
                    </p>
                    {statusConfigUrl && (
                      <button onClick={() => navigate(statusConfigUrl)}
                        className="mt-4 inline-flex items-center px-4 py-2 text-sm text-white bg-primary-600 hover:bg-primary-700 rounded-md">
                        <ArrowRight className="w-4 h-4 mr-2" />
                        前往 Agent Type 配置页
                      </button>
                    )}
                  </div>
                </div>
              )}
              {/* No entity found yet */}
              {apmStatus === 'no_entity' && (
                <div className="absolute inset-0 flex items-center justify-center bg-gray-50">
                  <div className="text-center max-w-md">
                    {statusSubstatus === 'need_upgrade' ? (
                      <>
                        <AlertTriangle className="w-12 h-12 mx-auto mb-3 text-yellow-500" />
                        <p className="font-medium text-gray-700">请升级实例镜像至最新版本</p>
                        <p className="text-sm text-gray-400 mt-1">
                          {statusMessage || '未检测到探针文件，请升级实例镜像后重试。'}
                        </p>
                      </>
                    ) : (
                      <>
                        <Bot className="w-12 h-12 mx-auto mb-3 text-gray-300" />
                        <p className="font-medium text-gray-700">暂无监控数据</p>
                        <p className="text-sm text-gray-400 mt-1">
                          {statusMessage || '发起对话后稍后刷新查看。'}
                        </p>
                        <button onClick={() => loadStatus(selectedInstanceId)}
                          className="mt-4 inline-flex items-center px-4 py-2 text-sm text-white bg-primary-600 hover:bg-primary-700 rounded-md">
                          <RefreshCw className="w-4 h-4 mr-2" />
                          刷新
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )}
              {/* Loading */}
              {apmStatus === 'loading' && (
                <div className="absolute inset-0 flex items-center justify-center bg-gray-50">
                  <div className="text-center">
                    <Loader2 className="w-8 h-8 animate-spin text-primary-600 mx-auto mb-2" />
                    <p className="text-sm text-gray-500">{t('observability.status.generatingEmbedUrl')}</p>
                  </div>
                </div>
              )}
              {/* Ready - show iframe */}
              {apmStatus === 'ready' && iframeUrl && (
                <IframeEmbed url={iframeUrl} title={`${currentInstance.name} - 应用监控`} />
              )}
              {/* Error */}
              {apmStatus === 'error' && (
                <div className="absolute inset-0 flex items-center justify-center bg-gray-50">
                  <div className="text-center max-w-md">
                    <AlertCircle className="w-12 h-12 mx-auto mb-3 text-red-400" />
                    <p className="font-medium text-gray-500">{t('observability.apm.error.retry')}</p>
                    <p className="text-xs text-gray-400 mt-1">{errorDetail.message}</p>
                    {showErrorDetail && (
                      <div className="mt-3 p-3 bg-gray-100 rounded text-xs text-gray-600 font-mono text-left">
                        <div>Code: {errorDetail.code}</div>
                        <div>Message: {errorDetail.message}</div>
                        <div>Last attempt: {errorDetail.lastAttempt}</div>
                      </div>
                    )}
                    <button onClick={() => loadEmbedUrl(selectedInstanceId)}
                      className="mt-4 inline-flex items-center px-4 py-2 text-sm text-white bg-primary-600 hover:bg-primary-700 rounded-md">
                      <RefreshCw className="w-4 h-4 mr-2" />
                      {t('observability.apm.error.retry')}
                    </button>
                  </div>
                </div>
              )}
              {/* Idle */}
              {apmStatus === 'idle' && (
                <div className="absolute inset-0 flex items-center justify-center bg-gray-50">
                  <div className="text-center text-gray-500">
                    <Bot className="w-12 h-12 mx-auto mb-3 text-gray-300" />
                    <p>请选择实例查看应用监控</p>
                  </div>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center text-gray-500">
              <Bot className="w-12 h-12 mx-auto mb-3 text-gray-300" />
              <p>请选择一个实例查看 应用监控</p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export function ApmObservability() {
  const { instanceId } = useParams<{ instanceId: string }>()
  return <ApmObservabilityPage instanceId={instanceId || ''} title="应用监控" />
}

export function UserCmsGatewayObservability() {
  const { t } = useTranslation('admin')
  const { consumerName } = useParams<{ consumerName: string }>()
  return <CmsGatewayObservabilityPage consumerName={consumerName} title={t('observability.title.gatewayMonitor')} />
}
