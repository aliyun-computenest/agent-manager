import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import toast from 'react-hot-toast'
import {
  ArrowLeft,
  Bot,
  Cpu,
  Save,
  Play,
  Square,
  Loader2,
  ExternalLink,
  User,
  MessageSquare,
  Eye,
  EyeOff,
  Terminal,
  QrCode,
  RefreshCw,
  ArchiveRestore,
  Clock,
  ChevronDown,
  Wrench
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../contexts/AuthContext'
import { useTerminalDock } from '../contexts/TerminalContext'
import { apiUrl } from '../lib/api'
import InstanceVersionPanel from './InstanceVersionPanel'
import TerminalPanel from './TerminalPanel'
import DingtalkQRConfig from './DingtalkQRConfig'
import FeishuQRConfig from './FeishuQRConfig'
import WecomQRConfig from './WecomQRConfig'
import { InstallSkillModal } from './skill-market/InstallSkillModal'

// ACS Cluster ID from environment
const ACS_CLUSTER_ID = import.meta.env.VITE_ACS_CLUSTER_ID || ''
const CHECKPOINT_CLONE_PENDING_KEY_PREFIX = 'openclaw:checkpoint-clone-pending'
const CHECKPOINT_CLONE_PENDING_TTL_MS = 10 * 60 * 1000

interface InstanceData {
  id: string
  principal_id: string
  name: string
  description: string | null
  status: string
  sandbox_id: string | null
  model_id?: string | null
  sandboxStatus?: string | null
  sandboxUrl?: string | null
  hostsEntries?: string[] | null
  total_tokens_used: number
  created_at: string
  last_active_at: string | null
  config_json: Record<string, unknown>
  agent_image?: string | null
  agent_version?: string | null
  agent_type_id?: string | null
  ai_models?: { id: string; name: string; provider: string } | null
  agent_type?: {
    id: string
    code: string
    name: string
    sandbox_template_id?: string | null
    supports_channels?: boolean
    supports_modify_model?: boolean
    supports_modify_channel?: boolean
    user_terminal_enabled?: boolean
  } | null
  sandbox_upgrade?: {
    CanUpgrade: boolean
    Reason: string
    AgentTypeId: string | null
    SandboxName: string | null
    SandboxPhase?: string | null
    Namespace: string | null
    SandboxSetName: string | null
    PodPhase?: string | null
    PodReady?: boolean
    PodIP?: string | null
    BackupReady?: boolean
    CurrentImage: string | null
    TargetImage: string | null
    Error?: string | null
  } | null
  // Channel config
  instance_channel_configs?: { channel_type: string; client_id: string; client_secret: string; is_configured: boolean }[] | null
  // User info (for admin view)
  username?: string
  group?: { id: string; name: string } | null
}

interface CheckpointBackupItem {
  backupId: string
  createdAt: string | null
}

interface CheckpointRestoreInfo {
  backupId?: string | null
  sourceInstanceId?: string | null
  status?: string | null
  startedAt?: string | null
}

interface PendingCheckpointClone {
  sourceInstanceId: string
  backupId: string
  startedAt: number
}

interface RestoreNavigationState {
  restoreFromBackup?: boolean
  sourceInstanceName?: string
}

function getPendingCheckpointCloneKey(sourceInstanceId: string) {
  return `${CHECKPOINT_CLONE_PENDING_KEY_PREFIX}:${sourceInstanceId}`
}

function readPendingCheckpointClone(sourceInstanceId: string | null | undefined): PendingCheckpointClone | null {
  if (!sourceInstanceId || typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(getPendingCheckpointCloneKey(sourceInstanceId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as PendingCheckpointClone
    const startedAt = Number(parsed?.startedAt || 0)
    if (parsed?.sourceInstanceId !== sourceInstanceId || !parsed?.backupId || !startedAt) {
      window.localStorage.removeItem(getPendingCheckpointCloneKey(sourceInstanceId))
      return null
    }
    if (Date.now() - startedAt > CHECKPOINT_CLONE_PENDING_TTL_MS) {
      window.localStorage.removeItem(getPendingCheckpointCloneKey(sourceInstanceId))
      return null
    }
    return parsed
  } catch {
    window.localStorage.removeItem(getPendingCheckpointCloneKey(sourceInstanceId))
    return null
  }
}

function writePendingCheckpointClone(sourceInstanceId: string, backupId: string) {
  if (typeof window === 'undefined') return
  const pending: PendingCheckpointClone = {
    sourceInstanceId,
    backupId,
    startedAt: Date.now()
  }
  window.localStorage.setItem(getPendingCheckpointCloneKey(sourceInstanceId), JSON.stringify(pending))
}

function clearPendingCheckpointClone(sourceInstanceId: string | null | undefined, backupId?: string | null) {
  if (!sourceInstanceId || typeof window === 'undefined') return
  const existing = readPendingCheckpointClone(sourceInstanceId)
  if (backupId && existing?.backupId !== backupId) return
  window.localStorage.removeItem(getPendingCheckpointCloneKey(sourceInstanceId))
}

interface AiModel {
  id: string
  name: string
  provider: string
  status: string
}

interface ChannelTemplate {
  id: string
  channel_type: string
  name: string
  config_fields: { name: string; label: string; type: string; required: boolean; placeholder?: string }[]
  is_enabled: boolean
}

function appendHiddenField(form: HTMLFormElement, name: string, value: string) {
  const input = document.createElement('input')
  input.type = 'hidden'
  input.name = name
  input.value = value
  form.appendChild(input)
}

function buildGatewayAuthUrl(sandboxUrl: string) {
  const url = new URL('/__agent_gateway_auth', sandboxUrl)
  return url.toString()
}

function buildGatewayNextPath(sandboxUrl: string) {
  const url = new URL(sandboxUrl)
  return `${url.pathname || '/'}${url.search || ''}`
}

function isGatewaySandboxUrl(sandboxUrl: string, instanceId: string) {
  try {
    const url = new URL(sandboxUrl)
    const instancePrefix = `/${instanceId}`
    return url.pathname === instancePrefix || url.pathname.startsWith(`${instancePrefix}/`)
  } catch {
    return false
  }
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}

function getCheckpointRestoreInfo(instance: InstanceData | null): CheckpointRestoreInfo | null {
  const restoreInfo = instance?.config_json?.checkpointRestore
  if (!restoreInfo || typeof restoreInfo !== 'object' || Array.isArray(restoreInfo)) return null
  return restoreInfo as CheckpointRestoreInfo
}

function createBackupCloneName(sourceName: string) {
  const normalized = (sourceName || 'instance')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '')
    .slice(0, 36) || 'instance'
  const suffix = Math.random().toString(36).slice(2, 8)
  return `${normalized}-backup-${suffix}`
}

const OpenClawDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const { session } = useAuth()
  const { closeTerminal, isTerminalOpen, openTerminal } = useTerminalDock()
  const { t, i18n } = useTranslation(['admin', 'common'])
  const accessTokenRef = useRef<string | null>(session?.access_token ?? null)
  const terminalSectionRef = useRef<HTMLDivElement | null>(null)
  const isAuthenticated = Boolean(session?.access_token)
  const isAdminView = location.pathname.startsWith('/admin')
  const [instance, setInstance] = useState<InstanceData | null>(null)
  const [loading, setLoading] = useState(true)
  const [statusLoading, setStatusLoading] = useState(false)
  const [savingConfig, setSavingConfig] = useState(false)
  const [showTerminal, setShowTerminal] = useState(false)
  const [showInstallSkills, setShowInstallSkills] = useState(false)

  // Editable config state
  const [selectedModel, setSelectedModel] = useState('')
  const [originalModel, setOriginalModel] = useState('')
  const [selectedChannel, setSelectedChannel] = useState('')
  const [originalChannel, setOriginalChannel] = useState('')
  const [channelClientId, setChannelClientId] = useState('')
  const [originalChannelClientId, setOriginalChannelClientId] = useState('')
  const [channelClientSecret, setChannelClientSecret] = useState('')

  // Show/hide original channel credentials
  const [showClientId, setShowClientId] = useState(false)
  const [showClientSecret, setShowClientSecret] = useState(false)
  const [revealedClientId, setRevealedClientId] = useState('')
  const [revealedClientSecret, setRevealedClientSecret] = useState('')
  const [revealLoading, setRevealLoading] = useState(false)
  // Store masked values from backend
  const [maskedClientId, setMaskedClientId] = useState('')
  const [maskedClientSecret, setMaskedClientSecret] = useState('')
  // QR scan-to-configure state
  const [showQRConfig, setShowQRConfig] = useState(false)
  const [qrAutoConfigured, setQrAutoConfigured] = useState(false)

  // Available options
  const [models, setModels] = useState<AiModel[]>([])
  const [channelTemplates, setChannelTemplates] = useState<ChannelTemplate[]>([])
  const [checkpointBackups, setCheckpointBackups] = useState<CheckpointBackupItem[]>([])
  const [checkpointLoading, setCheckpointLoading] = useState(false)
  const [checkpointActionLoading, setCheckpointActionLoading] = useState<string | null>(null)
  const [checkpointExpanded, setCheckpointExpanded] = useState(true)
  const [restoreTarget, setRestoreTarget] = useState<CheckpointBackupItem | null>(null)
  const [restoreInstanceName, setRestoreInstanceName] = useState('')
  const cloneInProgress = checkpointActionLoading?.startsWith('clone:')
  const restoreNavigationState = location.state as RestoreNavigationState | null
  const checkpointRestoreInfo = getCheckpointRestoreInfo(instance)
  const isCheckpointRestoreRestoring = checkpointRestoreInfo?.status === 'restoring'
  const isCheckpointRestoreInstance = Boolean(checkpointRestoreInfo || restoreNavigationState?.restoreFromBackup)
  const checkpointRestoreInProgress = Boolean(
    (isCheckpointRestoreRestoring || restoreNavigationState?.restoreFromBackup)
      && instance?.status !== 'running'
      && instance?.status !== 'error'
  )
  const checkpointRestoreWaitingSandbox = Boolean(checkpointRestoreInProgress && !instance?.sandbox_id)
  const checkpointRestoreFailed = Boolean(isCheckpointRestoreInstance && instance?.status === 'error')

  const isDirty = selectedModel !== originalModel ||
    selectedChannel !== originalChannel ||
    channelClientId !== originalChannelClientId

  // Whether model / channel modification is supported by the backend agent type
  const canModifyModel = instance?.agent_type?.supports_modify_model !== false
  const canModifyChannel = instance?.agent_type?.supports_modify_channel !== false
  // Whether the agent type supports channel configuration at all
  const supportsChannels = instance?.agent_type?.supports_channels !== false

  useEffect(() => {
    accessTokenRef.current = session?.access_token ?? null
  }, [session?.access_token])

  useEffect(() => {
    if (!instance?.id) return
    const pending = readPendingCheckpointClone(instance.id)
    setCheckpointActionLoading(current => {
      if (pending) return current || `clone:${pending.backupId}`
      return current?.startsWith('clone:') ? null : current
    })
  }, [instance?.id])

  // Fetch decrypted channel credentials
  const fetchChannelSecret = async () => {
    if (!instance || revealLoading) return
    try {
      setRevealLoading(true)
      const token = accessTokenRef.current
      if (!token) return
      const res = await fetch(`${apiUrl}/api/instances/${instance.id}/channel-secret`, {
        headers: { 'Authorization': `Bearer ${token}` }
      })
      const data = await res.json()
      if (data.success) {
        setRevealedClientId(data.clientId)
        setRevealedClientSecret(data.clientSecret)
      }
    } catch (e) {
      console.error('Failed to fetch channel secret:', e)
    } finally {
      setRevealLoading(false)
    }
  }

  const toggleShowClientId = () => {
    if (!showClientId && !revealedClientId) {
      fetchChannelSecret().then(() => setShowClientId(true))
    } else {
      setShowClientId(!showClientId)
    }
  }

  const toggleShowClientSecret = () => {
    if (!showClientSecret && !revealedClientSecret) {
      fetchChannelSecret().then(() => setShowClientSecret(true))
    } else {
      setShowClientSecret(!showClientSecret)
    }
  }

  // Fetch instance details (also used for polling)
  const fetchInstanceData = useCallback(async () => {
    try {
      const token = accessTokenRef.current
      if (!token) return null

      const instanceRes = await fetch(`${apiUrl}/api/instances/${id}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      })
      const instanceData = await instanceRes.json()
      if (!instanceData.success) throw new Error(instanceData.error || 'Failed to fetch instance')
      return instanceData.instance
    } catch (error) {
      console.error('Error fetching instance:', error)
      return null
    }
  }, [id])

  const fetchCheckpointBackups = useCallback(async (instanceId: string) => {
    const token = accessTokenRef.current
    if (!token) return
    const res = await fetch(`${apiUrl}/api/instances/${instanceId}/backups`, {
      headers: { 'Authorization': `Bearer ${token}` }
    })
    const data = await res.json()
    if (!data.success) throw new Error(data.error || 'Failed to fetch backups')
    setCheckpointBackups(data.items || [])
  }, [])

  const refreshCheckpointWorkspace = useCallback(async (instanceId: string) => {
    setCheckpointLoading(true)
    try {
      await fetchCheckpointBackups(instanceId)
    } catch (error: unknown) {
      console.error('Failed to refresh checkpoint workspace:', error)
      toast.error(getErrorMessage(error, t('openClawDetail.checkpoint.loadFailed')))
    } finally {
      setCheckpointLoading(false)
    }
  }, [fetchCheckpointBackups, t])

  useEffect(() => {
    let cancelled = false
    const fetchInstance = async () => {
      try {
        setLoading(true)
        const token = accessTokenRef.current
        if (!token) { setLoading(false); return }

        // Fetch instance + models in parallel; channel templates depend on the instance's agent_type_id.
        const [instanceRes, modelsRes] = await Promise.all([
          fetch(`${apiUrl}/api/instances/${id}`, { headers: { 'Authorization': `Bearer ${token}` } }),
          fetch(`${apiUrl}/api/models`, { headers: { 'Authorization': `Bearer ${token}` } })
        ])

        const [instanceData, modelsData] = await Promise.all([
          instanceRes.json(), modelsRes.json()
        ])

        if (!instanceData.success) throw new Error(instanceData.error || 'Failed to fetch instance')

        if (cancelled) return

        if (modelsData.success) setModels(modelsData.models || [])

        // Fetch channel templates filtered by agent_type_id (only when the agent type supports channels)
        const agentTypeId = instanceData.instance.agent_type_id
        const agentTypeSupportsChannels = instanceData.instance.agent_type?.supports_channels !== false
        if (agentTypeSupportsChannels) {
          const channelUrl = agentTypeId
            ? `${apiUrl}/api/channel-templates?agentTypeId=${agentTypeId}`
            : `${apiUrl}/api/channel-templates`
          const channelsRes = await fetch(channelUrl, { headers: { 'Authorization': `Bearer ${token}` } })
          const channelsData = await channelsRes.json()
          if (cancelled) return
          if (channelsData.success) setChannelTemplates(channelsData.templates?.filter((t: ChannelTemplate) => t.is_enabled) || [])
        } else {
          setChannelTemplates([])
        }

        setInstance(instanceData.instance)
        void refreshCheckpointWorkspace(instanceData.instance.id)

        const modelName = instanceData.instance.ai_models?.name || instanceData.instance.config_json?.model || ''
        setSelectedModel(modelName)
        setOriginalModel(modelName)

        const channelConfig = instanceData.instance.instance_channel_configs?.[0]
        const channelType = channelConfig?.channel_type || ''
        const clientId = channelConfig?.client_id || ''  // masked value from backend
        const clientSecret = channelConfig?.client_secret || ''  // masked value from backend
        setSelectedChannel(channelType)
        setOriginalChannel(channelType)
        setChannelClientId(clientId)
        setOriginalChannelClientId(clientId)
        setMaskedClientId(clientId)
        setMaskedClientSecret(clientSecret)
      } catch (error) {
        console.error('Error fetching instance:', error)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    if (!id) return
    if (!isAuthenticated) {
      setLoading(false)
      return
    }
    fetchInstance()
    return () => { cancelled = true }
  }, [id, isAuthenticated, refreshCheckpointWorkspace])

  // Poll for status updates when instance is in 'starting' state
  const instanceStatus = instance?.status

  useEffect(() => {
    if (!instanceStatus || (instanceStatus !== 'starting' && instanceStatus !== 'stopping')) return

    const currentTransitionalStatus = instanceStatus
    const pollInterval = setInterval(async () => {
      const updated = await fetchInstanceData()
      if (updated && updated.status !== currentTransitionalStatus) {
        setInstance(prev => prev ? { ...prev, ...updated } : updated)
        clearInterval(pollInterval)
      }
    }, 3000)

    return () => clearInterval(pollInterval)
  }, [fetchInstanceData, instanceStatus])

  const floatingTerminalOpen = Boolean(instance?.id && isTerminalOpen(instance.id))

  useEffect(() => {
    if (!instance?.status || instance.status === 'running') return
    if (showTerminal) setShowTerminal(false)
    if (floatingTerminalOpen) closeTerminal()
  }, [closeTerminal, floatingTerminalOpen, instance?.status, showTerminal])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-primary-600" />
        <span className="ml-2 text-gray-600">{t('common:loading.default')}</span>
      </div>
    )
  }

  if (!instance) {
    return (
      <div className="text-center py-12">
        <Bot className="w-16 h-16 text-gray-400 mx-auto mb-4" />
        <h3 className="text-lg font-medium text-gray-900 mb-2">
          {t('openClawDetail.notExist')}
        </h3>
        <button
          onClick={() => navigate(-1)}
          className="btn-primary"
        >
          {t('openClawDetail.back')}
        </button>
      </div>
    )
  }

  const handleToggleStatus = async () => {
    if (!instance || statusLoading) return

    const action = instance.status === 'running' ? 'stop' : 'start'
    const actionText = action === 'stop' ? t('openClawDetail.actions.stop') : t('openClawDetail.actions.start')

    try {
      setStatusLoading(true)
      const token = session?.access_token
      if (!token) {
        toast.error(t('openClawDetail.notLoggedIn'))
        return
      }

      const response = await fetch(`${apiUrl}/api/instances/${instance.id}/${action}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      })

      const data = await response.json()

      if (!data.success) {
        throw new Error(data.error || t('openClawDetail.actionFailed', { action: actionText }))
      }

      setInstance({
        ...instance,
        status: data.status
      })
    } catch (error: unknown) {
      console.error(`Error ${action} instance:`, error)
      toast.error(t('openClawDetail.actionFailedWithReason', { action: actionText, reason: getErrorMessage(error, '') }))
    } finally {
      setStatusLoading(false)
    }
  }

  const handleSaveConfig = async () => {
    if (!instance || !isDirty || savingConfig) return
    try {
      setSavingConfig(true)
      const token = session?.access_token
      if (!token) { toast.error(t('openClawDetail.notLoggedIn')); return }

      const body: Record<string, string> = {}
      if (selectedModel !== originalModel) body.modelName = selectedModel
      if (selectedChannel !== originalChannel || channelClientId !== originalChannelClientId) {
        body.channelType = selectedChannel
        body.channelClientId = channelClientId
        // Only send secret if channel changed, otherwise send placeholder
        body.channelClientSecret = channelClientSecret || '__unchanged__'
      }

      const response = await fetch(`${apiUrl}/api/instances/${instance.id}`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
      const data = await response.json()
      if (!data.success) throw new Error(data.error || t('openClawDetail.saveFailed'))

      // Sync originals to current
      setOriginalModel(selectedModel)
      setOriginalChannel(selectedChannel)
      setOriginalChannelClientId(channelClientId)
      setChannelClientSecret('')
      // Update status if backend set it to starting
      if (data.instance?.status) {
        setInstance(prev => prev ? { ...prev, status: data.instance.status } : null)
      }
      toast.success(t('openClawDetail.configSaved'))
    } catch (error: unknown) {
      console.error('Save config error:', error)
      toast.error(t('openClawDetail.saveFailedWithReason', { reason: getErrorMessage(error, '') }))
    } finally {
      setSavingConfig(false)
    }
  }

  const handleBack = () => {
    navigate(isAdminView ? '/admin/instances' : '/user/instances')
  }

  const handleOpenSandboxApp = (event: React.MouseEvent<HTMLElement>) => {
    if (!instance?.sandboxUrl) return

    if (!isGatewaySandboxUrl(instance.sandboxUrl, instance.id)) return

    event.preventDefault()
    const token = accessTokenRef.current
    if (!token) {
      toast.error(t('openClawDetail.notLoggedIn'))
      return
    }

    let action = ''
    let nextPath = '/'
    try {
      action = buildGatewayAuthUrl(instance.sandboxUrl)
      nextPath = buildGatewayNextPath(instance.sandboxUrl)
    } catch (error) {
      console.error('Invalid sandbox URL:', error)
      toast.error(t('openClawDetail.notExist'))
      return
    }

    const targetName = `openclaw_gateway_${instance.id.replace(/[^A-Za-z0-9_-]/g, '_')}_${Date.now()}`
    const popup = window.open('about:blank', targetName)
    if (popup) {
      popup.opener = null
    }

    const form = document.createElement('form')
    form.method = 'POST'
    form.action = action
    form.target = popup ? targetName : '_self'
    form.acceptCharset = 'UTF-8'
    form.enctype = 'application/x-www-form-urlencoded'
    form.style.display = 'none'
    appendHiddenField(form, 'access_token', token)
    appendHiddenField(form, 'instance_id', instance.id)
    appendHiddenField(form, 'next', nextPath)

    document.body.appendChild(form)
    form.submit()
    form.remove()
  }

  const terminalDisabledReason = instance.status !== 'running'
    ? t('terminal.disabledByStatus')
    : (!isAdminView && instance.agent_type?.user_terminal_enabled !== true)
      ? t('terminal.disabledForAgent')
      : ''
  const canOpenTerminal = !terminalDisabledReason && isAuthenticated
  const installSkillsDisabledReason = instance.status !== 'running'
    ? t('skillInstall.disabledByStatus')
    : ''
  const protectedSandboxAccess = Boolean(
    instance?.sandboxUrl && isGatewaySandboxUrl(instance.sandboxUrl, instance.id)
  )

  const handleOpenTerminal = () => {
    if (!canOpenTerminal || !accessTokenRef.current) return
    const token = accessTokenRef.current
    sessionStorage.setItem(`terminal-token:${instance.id}`, token)
    const prefix = isAdminView ? '/admin' : '/user'
    window.open(`${prefix}/instances/${instance.id}/terminal`, '_blank')
  }

  const handleFloatTerminal = () => {
    const token = accessTokenRef.current
    if (!canOpenTerminal || !token) return
    openTerminal({
      instanceId: instance.id,
      accessToken: token,
      sandboxId: instance.sandbox_id
    })
    setShowTerminal(false)
  }

  const handleOpenCheckpointBackupPage = () => {
    if (!instance) return
    navigate(`${isAdminView ? '/admin' : '/user'}/instances/${instance.id}/backups/new`)
  }

  const openRestoreDialog = (backup: CheckpointBackupItem) => {
    if (!instance) return
    setRestoreTarget(backup)
    setRestoreInstanceName(createBackupCloneName(instance.name))
  }

  const createInstanceFromBackup = async (backup: CheckpointBackupItem) => {
    if (!instance || cloneInProgress) return
    const sourceInstanceId = instance.id
    const nextInstanceName = restoreInstanceName.trim()
    if (!nextInstanceName) {
      toast.error(t('openClawDetail.checkpoint.cloneNameRequired'))
      return
    }
    try {
      setCheckpointActionLoading(`clone:${backup.backupId}`)
      const token = accessTokenRef.current
      if (!token) { toast.error(t('openClawDetail.notLoggedIn')); setCheckpointActionLoading(null); return }
      writePendingCheckpointClone(sourceInstanceId, backup.backupId)
      const requestBody: Record<string, unknown> = {
        name: nextInstanceName,
        description: instance.description,
        agentTypeId: instance.agent_type_id || instance.agent_type?.id || undefined,
        modelId: instance.model_id || instance.ai_models?.id || undefined,
        configJson: instance.config_json || {},
        async: true,
        backupId: backup.backupId
      }
      if (instance.group?.id) {
        requestBody.groupId = instance.group.id
      }
      const response = await fetch(`${apiUrl}/api/instances`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      })
      const data = await response.json()
      if (!data.success) throw new Error(data.error || t('openClawDetail.checkpoint.createFailed'))
      clearPendingCheckpointClone(sourceInstanceId, backup.backupId)
      setRestoreTarget(null)
      setRestoreInstanceName('')
      toast.success(t('openClawDetail.checkpoint.createSuccess'))
      if (data.instance?.id) {
        navigate(`${isAdminView ? '/admin' : '/user'}/instances/${data.instance.id}`, {
          state: {
            restoreFromBackup: true,
            sourceInstanceName: instance.name
          }
        })
      }
    } catch (error: unknown) {
      clearPendingCheckpointClone(sourceInstanceId, backup.backupId)
      console.error('Create instance from checkpoint backup error:', error)
      toast.error(getErrorMessage(error, t('openClawDetail.checkpoint.createFailed')))
    } finally {
      setCheckpointActionLoading(null)
    }
  }

  const handleRestoreCheckpoint = async () => {
    if (!restoreTarget) return
    await createInstanceFromBackup(restoreTarget)
  }

  const formatBackupTime = (value: string | null) => {
    if (!value) return '-'
    return new Date(value).toLocaleString(i18n.language)
  }

  return (
    <div className="min-w-0 w-full max-w-full space-y-6 overflow-x-hidden">
      {/* Header */}
      <div className="flex min-w-0 items-center justify-between gap-4">
        <button
          onClick={handleBack}
          className="flex items-center space-x-2 text-gray-600 hover:text-gray-900"
        >
          <ArrowLeft className="w-5 h-5" />
          <span>{t('openClawDetail.backToList')}</span>
        </button>
        <div className="flex shrink-0 items-center space-x-3">
          <button
            type="button"
            onClick={() => setShowInstallSkills(true)}
            disabled={Boolean(installSkillsDisabledReason)}
            title={installSkillsDisabledReason || undefined}
            className="btn-secondary flex items-center space-x-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Wrench className="h-5 w-5" />
            <span>{t('skillInstall.action')}</span>
          </button>
          <button
            onClick={handleOpenTerminal}
            disabled={!canOpenTerminal}
            title={terminalDisabledReason || undefined}
            className="btn-secondary flex items-center space-x-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Terminal className="w-5 h-5" />
            <span>{t('terminal.open')}</span>
          </button>
          <button
            onClick={handleToggleStatus}
            disabled={statusLoading || instance.status === 'starting' || instance.status === 'stopping'}
            className={`btn-primary flex items-center space-x-2 disabled:opacity-50 disabled:cursor-not-allowed ${
              instance.status === 'running' ? 'bg-orange-600 hover:bg-orange-700' : ''
            }`}
          >
            {statusLoading || instance.status === 'starting' || instance.status === 'stopping' ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : instance.status === 'running' ? (
              <Square className="w-5 h-5" />
            ) : (
              <Play className="w-5 h-5" />
            )}
            <span>
              {instance.status === 'starting'
                ? t('openClawDetail.status.starting')
                : instance.status === 'stopping'
                  ? t('openClawDetail.status.stopping')
                  : statusLoading
                    ? (instance.status === 'running' ? t('openClawDetail.status.stopping') : t('openClawDetail.status.starting'))
                    : (instance.status === 'running' ? t('openClawDetail.actions.stop') : t('openClawDetail.actions.start'))}
            </span>
          </button>
          <button
            onClick={handleSaveConfig}
            disabled={!isDirty || savingConfig}
            className="btn-primary flex items-center space-x-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {savingConfig ? <Loader2 className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}
            <span>{savingConfig ? t('openClawDetail.saving') : t('openClawDetail.saveConfig')}</span>
          </button>
        </div>
      </div>

      {checkpointRestoreInProgress && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-blue-950 shadow-sm">
          <div className="flex items-start gap-3">
            <Loader2 className="mt-0.5 h-5 w-5 flex-shrink-0 animate-spin text-blue-600" />
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">{t('openClawDetail.checkpoint.restoreProgressTitle')}</h2>
              <p className="mt-1 text-sm text-blue-800">
                {t(checkpointRestoreWaitingSandbox
                  ? 'openClawDetail.checkpoint.restoreWaitingSandboxDescription'
                  : 'openClawDetail.checkpoint.restoreProgressDescription')}
              </p>
            </div>
          </div>
        </div>
      )}

      {checkpointRestoreFailed && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-red-950 shadow-sm">
          <div className="flex items-start gap-3">
            <ArchiveRestore className="mt-0.5 h-5 w-5 flex-shrink-0 text-red-600" />
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">{t('openClawDetail.checkpoint.restoreFailedTitle')}</h2>
              <p className="mt-1 text-sm text-red-800">
                {t('openClawDetail.checkpoint.restoreFailedDescription')}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Basic Info */}
      <div className="card min-w-0 max-w-full overflow-hidden">
        <h2 className="text-xl font-semibold text-gray-900 mb-4">{t('openClawDetail.basicInfo')}</h2>
        <div className="grid min-w-0 grid-cols-1 gap-6 md:grid-cols-2">
          <div className="min-w-0">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t('openClawDetail.fields.id')}
            </label>
            <p className="break-all font-mono text-sm text-gray-900">{instance.id}</p>
          </div>
          {instance.sandbox_id && (
            <div className="min-w-0">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {t('openClawDetail.fields.sandboxId')}
              </label>
              <p className="break-all font-mono text-sm text-gray-900">{instance.sandbox_id}</p>
            </div>
          )}
          <div className="min-w-0">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t('openClawDetail.fields.name')}
            </label>
            <p className="break-words text-lg text-gray-900">{instance.name}</p>
          </div>
          <div className="min-w-0">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t('openClawDetail.fields.status')}
            </label>
            <span className={`status-badge ${
              instance.status === 'running' ? 'status-active' 
                : instance.status === 'starting' ? 'status-active bg-yellow-100 text-yellow-800'
                : instance.status === 'error' ? 'bg-red-100 text-red-800'
                : 'status-inactive'
            }`}>
              {instance.status === 'running' ? t('common:status.running')
                : instance.status === 'starting' ? t('common:status.starting')
                : instance.status === 'error' ? t('common:status.error', 'Error')
                : t('common:status.stopped')}
            </span>
          </div>
          <div className="min-w-0">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t('openClawDetail.fields.createdAt')}
            </label>
            <p className="text-gray-900">
              {new Date(instance.created_at).toLocaleString(i18n.language)}
            </p>
          </div>
          <div className="min-w-0">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t('openClawDetail.fields.lastActive')}
            </label>
            <p className="text-gray-900">
              {instance.last_active_at ? new Date(instance.last_active_at).toLocaleString(i18n.language) : t('openClawDetail.never')}
            </p>
          </div>
          {isAdminView && instance.username && (
            <div className="min-w-0">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {t('openClawDetail.fields.ownerUser')}
              </label>
              <div className="flex min-w-0 items-center space-x-2">
                <User className="w-4 h-4 text-gray-500" />
                <p className="min-w-0 break-words text-gray-900">{instance.username}</p>
              </div>
            </div>
          )}
          {instance.sandboxUrl && (
            <div className="min-w-0 md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {t('openClawDetail.fields.appAccessUrl')}
              </label>
              <div className="flex min-w-0 items-center space-x-2">
                {protectedSandboxAccess ? (
                  <button
                    type="button"
                    onClick={handleOpenSandboxApp}
                    className="inline-flex min-w-0 items-center space-x-2 break-all text-left font-mono text-sm text-primary-600 hover:text-primary-800"
                  >
                    <span className="min-w-0 break-all">{instance.sandboxUrl}</span>
                    <ExternalLink className="w-4 h-4 flex-shrink-0" />
                  </button>
                ) : (
                  <a
                    href={instance.sandboxUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-w-0 items-center space-x-2 break-all font-mono text-sm text-primary-600 hover:text-primary-800"
                  >
                    <span className="min-w-0 break-all">{instance.sandboxUrl}</span>
                    <ExternalLink className="w-4 h-4 flex-shrink-0" />
                  </a>
                )}
              </div>
            </div>
          )}
          {instance.hostsEntries && instance.hostsEntries.length > 0 && (
            <div className="min-w-0 md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {t('openClawDetail.fields.hostsConfig')}
              </label>
              <div className="min-w-0 overflow-hidden rounded-lg bg-gray-900 p-3 font-mono text-sm">
                <pre className="whitespace-pre-wrap break-all text-green-400">
                  {instance.hostsEntries.join('\n')}
                </pre>
              </div>
              <p className="text-xs text-gray-500 mt-1">
                {t('openClawDetail.fields.hostsHint')}
              </p>
            </div>
          )}
          {isAdminView && ACS_CLUSTER_ID && instance.sandbox_id && (
            (() => {
              // Parse sandbox_id: format is "namespace--podname"
              const parts = instance.sandbox_id.split('--')
              if (parts.length >= 2) {
                const namespace = parts[0]
                const podName = parts.slice(1).join('--')
                return (
                  <div className="min-w-0 md:col-span-2">
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      {t('openClawDetail.fields.viewContainer')}
                    </label>
                    <div className="flex min-w-0 items-center space-x-2">
                      <a
                        href={`https://cs.console.aliyun.com/v2#/k8s/cluster/${ACS_CLUSTER_ID}/v2/workload/pod/${namespace}/${podName}/container?type=pod`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex min-w-0 items-center space-x-2 break-all font-mono text-sm text-blue-600 hover:text-blue-800"
                      >
                        <span className="min-w-0 break-words">{t('openClawDetail.fields.goToConsole')}</span>
                        <ExternalLink className="w-4 h-4 flex-shrink-0" />
                      </a>
                    </div>
                  </div>
                )
              }
              return null
            })()
          )}
        </div>
      </div>

      {isAdminView && instance.sandbox_upgrade && (
        <InstanceVersionPanel
          agentImage={instance.agent_image}
          agentVersion={instance.agent_version}
          templateId={instance.agent_type?.sandbox_template_id || null}
          namespace={instance.sandbox_upgrade.Namespace}
          sandboxUpgrade={instance.sandbox_upgrade}
        />
      )}

      {/* Checkpoint Backup and Restore */}
      <div className="card min-w-0 overflow-hidden">
        <div className="mb-4 flex min-w-0 items-center justify-between gap-3">
          <div className="flex min-w-0 items-center space-x-2">
            <ArchiveRestore className="h-5 w-5 flex-shrink-0 text-primary-600" />
            <h2 className="truncate text-xl font-semibold text-gray-900">{t('openClawDetail.checkpoint.title')}</h2>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => refreshCheckpointWorkspace(instance.id)}
              disabled={checkpointLoading || Boolean(checkpointActionLoading)}
              className="btn-secondary flex items-center space-x-2 disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${checkpointLoading ? 'animate-spin' : ''}`} />
              <span>{t('openClawDetail.checkpoint.refresh')}</span>
            </button>
            <button
              type="button"
              onClick={handleOpenCheckpointBackupPage}
              disabled={Boolean(checkpointActionLoading)}
              className="btn-primary flex items-center space-x-2 disabled:opacity-50"
            >
              <ArchiveRestore className="h-4 w-4" />
              <span>{t('openClawDetail.checkpoint.startBackup')}</span>
            </button>
          </div>
        </div>

        <div className="mb-4 rounded-md border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-900">
          {t('openClawDetail.checkpoint.cloneNotice')}
        </div>

        <div className="min-w-0 overflow-hidden rounded-lg border border-gray-200">
          <div className="flex min-w-0 items-center justify-between border-b border-gray-200 px-4 py-3">
            <div className="flex min-w-0 items-center space-x-2">
              <Clock className="h-4 w-4 flex-shrink-0 text-gray-500" />
              <p className="truncate text-sm font-medium text-gray-900">{t('openClawDetail.checkpoint.availableBackups')}</p>
            </div>
            <button
              type="button"
              onClick={() => setCheckpointExpanded(value => !value)}
              className="inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900"
            >
              <span>{checkpointExpanded ? t('openClawDetail.checkpoint.collapse') : t('openClawDetail.checkpoint.expand')}</span>
              <ChevronDown className={`h-4 w-4 transition-transform ${checkpointExpanded ? 'rotate-180' : ''}`} />
            </button>
          </div>

          {checkpointExpanded && checkpointBackups.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-gray-500">
              {t('openClawDetail.checkpoint.noAvailableBackups')}
            </div>
          ) : checkpointExpanded ? (
            <div className="min-w-0 overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium text-gray-600">{t('openClawDetail.checkpoint.backupTime')}</th>
                    <th className="px-4 py-2 text-left font-medium text-gray-600">{t('openClawDetail.checkpoint.description')}</th>
                    <th className="px-4 py-2 text-right font-medium text-gray-600">{t('openClawDetail.checkpoint.operation')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 bg-white">
                  {checkpointBackups.map((backup) => {
                    const creating = checkpointActionLoading === `clone:${backup.backupId}`
                    return (
                      <tr key={backup.backupId}>
                        <td className="whitespace-nowrap px-4 py-3 text-gray-700">
                          {formatBackupTime(backup.createdAt)}
                        </td>
                        <td className="px-4 py-3 text-gray-600">
                          {t('openClawDetail.checkpoint.cloneFromThisPoint')}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <button
                            type="button"
                            onClick={() => openRestoreDialog(backup)}
                            disabled={Boolean(checkpointActionLoading)}
                            className="btn-secondary inline-flex items-center space-x-2 disabled:opacity-50"
                          >
                            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArchiveRestore className="h-4 w-4" />}
                            <span>{creating ? t('openClawDetail.checkpoint.creating') : t('openClawDetail.checkpoint.cloneFromBackup')}</span>
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : null}

          {restoreTarget && checkpointExpanded && (
            <div className="border-t border-yellow-200 bg-yellow-50 px-4 py-4">
              <div className="flex flex-col gap-4">
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-yellow-950">{t('openClawDetail.checkpoint.cloneTitle')}</h3>
                  <p className="mt-1 text-sm text-yellow-900">
                    {t('openClawDetail.checkpoint.cloneConfirm', { time: formatBackupTime(restoreTarget.createdAt) })}
                  </p>
                  <p className="mt-1 text-xs text-yellow-800">{t('openClawDetail.checkpoint.cloneAfterCreate')}</p>
                </div>
                <div className="grid gap-2 md:max-w-xl">
                  <label className="text-sm font-medium text-yellow-950" htmlFor="checkpoint-restore-instance-name">
                    {t('openClawDetail.checkpoint.cloneNameLabel')}
                  </label>
                  <input
                    id="checkpoint-restore-instance-name"
                    type="text"
                    value={restoreInstanceName}
                    onChange={(event) => setRestoreInstanceName(event.target.value)}
                    disabled={cloneInProgress}
                    className="input-field bg-white disabled:opacity-60"
                    placeholder={t('openClawDetail.checkpoint.cloneNamePlaceholder')}
                  />
                  <p className="text-xs text-yellow-800">{t('openClawDetail.checkpoint.cloneNameHint')}</p>
                </div>
                <div className="flex shrink-0 justify-end gap-3">
                  <button
                    type="button"
                    onClick={() => { setRestoreTarget(null); setRestoreInstanceName('') }}
                    disabled={cloneInProgress}
                    className="btn-secondary disabled:opacity-50"
                  >
                    {t('openClawDetail.checkpoint.cancel')}
                  </button>
                  <button
                    type="button"
                    onClick={handleRestoreCheckpoint}
                    disabled={Boolean(checkpointActionLoading) || restoreInstanceName.trim().length === 0}
                    className="btn-primary flex items-center space-x-2 disabled:opacity-50"
                  >
                    {cloneInProgress && <Loader2 className="h-4 w-4 animate-spin" />}
                    <span>{cloneInProgress ? t('openClawDetail.checkpoint.creating') : t('openClawDetail.checkpoint.createInstance')}</span>
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Model Configuration */}
      <div className="card">
        <div className="flex items-center space-x-2 mb-4">
          <Cpu className="w-5 h-5 text-primary-600" />
          <h2 className="text-xl font-semibold text-gray-900">{t('openClawDetail.modelConfig')}</h2>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">{t('openClawDetail.selectModel')}</label>
          {(() => {
            const currentProvider = instance?.ai_models?.provider
            const filteredModels = currentProvider
              ? models.filter(m => m.status === 'active' && m.provider === currentProvider)
              : models.filter(m => m.status === 'active')
            return (
              <>
                <select
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value)}
                  disabled={!canModifyModel}
                  className="input-field max-w-md disabled:bg-gray-100 disabled:cursor-not-allowed"
                >
                  <option value="">{t('openClawDetail.selectModelPlaceholder')}</option>
                  {filteredModels.map((model) => (
                    <option key={model.id} value={model.name}>
                      {model.name} ({model.provider})
                    </option>
                  ))}
                </select>
                {canModifyModel && currentProvider && (
                  <p className="text-xs text-gray-400 mt-1">
                    仅可在当前模型提供商 <code className="px-1 bg-gray-100 rounded">{currentProvider}</code> 内切换模型；如需切换到其他提供商，请重新创建实例。
                  </p>
                )}
              </>
            )
          })()}
          {!canModifyModel && (
            <p className="text-xs text-gray-500 mt-1">当前 Agent 类型未配置模型修改脚本，暂不支持在平台侧修改模型</p>
          )}
          {canModifyModel && selectedModel !== originalModel && (
            <p className="text-xs text-orange-500 mt-1">{t('openClawDetail.modified')}</p>
          )}
        </div>
      </div>

      {/* Channel Configuration */}
      {supportsChannels && (
      <div className="card">
        <div className="flex items-center space-x-2 mb-4">
          <MessageSquare className="w-5 h-5 text-primary-600" />
          <h2 className="text-xl font-semibold text-gray-900">{t('openClawDetail.channelConfig')}</h2>
        </div>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">{t('openClawDetail.selectChannel')}</label>
            <select
              value={selectedChannel}
              onChange={(e) => {
                setSelectedChannel(e.target.value)
                setChannelClientId('')
                setChannelClientSecret('')
                setShowQRConfig(false)
                setQrAutoConfigured(false)
              }}
              disabled={!canModifyChannel}
              className="input-field max-w-md disabled:bg-gray-100 disabled:cursor-not-allowed"
            >
              <option value="">{t('openClawDetail.noChannel')}</option>
              {channelTemplates.map((ct) => (
                <option key={ct.id} value={ct.channel_type}>{t(`admin:agentTypeDetail.channelType.${ct.channel_type}`, ct.name)}</option>
              ))}
            </select>
            {!canModifyChannel && (
              <p className="text-xs text-gray-500 mt-1">当前 Agent 类型未配置渠道修改脚本，暂不支持在平台侧修改渠道</p>
            )}
          </div>
          {selectedChannel && (() => {
            const template = channelTemplates.find(ct => ct.channel_type === selectedChannel)
            if (!template) return null
            const hasStored = maskedClientId && selectedChannel === originalChannel
            const supportsQR = selectedChannel === 'dingtalk' || selectedChannel === 'feishu' || selectedChannel === 'wecom'
            return (
              <div className="border border-gray-200 rounded-lg p-4 space-y-4">
                {/* QR scan-to-configure option for DingTalk / Feishu */}
                {supportsQR && canModifyChannel && !qrAutoConfigured && !showQRConfig && (
                  <div className="flex items-center space-x-3 mb-2">
                    <button
                      type="button"
                      onClick={() => setShowQRConfig(true)}
                      className="btn-primary flex items-center space-x-2 text-sm py-2 px-4"
                    >
                      <QrCode className="w-4 h-4" />
                      <span>扫码自动配置（推荐）</span>
                    </button>
                    <span className="text-xs text-gray-400">或手动填写以下字段</span>
                  </div>
                )}

                {/* QR code scanning flow */}
                {supportsQR && showQRConfig && !qrAutoConfigured && (
                  selectedChannel === 'dingtalk' ? (
                    <DingtalkQRConfig
                      instanceId={instance?.id}
                      onSuccess={(credentials) => {
                        setChannelClientId(credentials.clientId)
                        // When instanceId is provided to the QR component the
                        // backend has already encrypted+persisted the secret;
                        // the response only carries a masked preview, so we
                        // keep local state empty and rely on the masked UI.
                        setChannelClientSecret(credentials.clientSecret || '')
                        setQrAutoConfigured(true)
                        setShowQRConfig(false)
                        // Sync originals so isDirty becomes false after auto-save
                        setOriginalChannel(selectedChannel)
                        setOriginalChannelClientId(credentials.clientId)
                        setMaskedClientId(credentials.clientId.substring(0, 3) + '***' + credentials.clientId.substring(credentials.clientId.length - 3))
                        setMaskedClientSecret('***')
                        toast.success('钉钉渠道已通过扫码自动配置成功！')
                      }}
                      onCancel={() => setShowQRConfig(false)}
                    />
                  ) : selectedChannel === 'feishu' ? (
                    <FeishuQRConfig
                      instanceId={instance?.id}
                      onSuccess={(credentials) => {
                        setChannelClientId(credentials.clientId)
                        setChannelClientSecret(credentials.clientSecret || '')
                        setQrAutoConfigured(true)
                        setShowQRConfig(false)
                        setOriginalChannel(selectedChannel)
                        setOriginalChannelClientId(credentials.clientId)
                        setMaskedClientId(credentials.clientId.substring(0, 3) + '***' + credentials.clientId.substring(credentials.clientId.length - 3))
                        setMaskedClientSecret('***')
                        toast.success('飞书渠道已通过扫码自动配置成功！')
                      }}
                      onCancel={() => setShowQRConfig(false)}
                    />
                  ) : (
                    <WecomQRConfig
                      instanceId={instance?.id}
                      onSuccess={(credentials) => {
                        setChannelClientId(credentials.clientId)
                        setChannelClientSecret(credentials.clientSecret || '')
                        setQrAutoConfigured(true)
                        setShowQRConfig(false)
                        setOriginalChannel(selectedChannel)
                        setOriginalChannelClientId(credentials.clientId)
                        setMaskedClientId(credentials.clientId.substring(0, 3) + '***' + credentials.clientId.substring(credentials.clientId.length - 3))
                        setMaskedClientSecret('***')
                        toast.success('企业微信渠道已通过扫码自动配置成功！')
                      }}
                      onCancel={() => setShowQRConfig(false)}
                    />
                  )
                )}

                {/* QR auto-configured success indicator */}
                {supportsQR && qrAutoConfigured && (
                  <div className="flex items-center space-x-2 p-3 bg-green-50 border border-green-200 rounded-lg">
                    <svg className="w-5 h-5 text-green-500" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                    </svg>
                    <span className="text-sm text-green-700 font-medium">渠道凭证已通过扫码自动配置并应用</span>
                  </div>
                )}

                {/* Client ID */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t('createOpenClaw.channelFields.clientId.label', template.config_fields.find(f => f.name === 'clientId')?.label || 'Client ID')}
                  </label>
                  {hasStored && (
                    <div className="flex items-center space-x-2 mb-2">
                      <span className="text-xs text-gray-400">{t('openClawDetail.currentValue')}</span>
                      <code className="text-xs font-mono bg-gray-50 border border-gray-200 rounded px-2 py-0.5">
                        {showClientId && revealedClientId ? revealedClientId : maskedClientId}
                      </code>
                      <button
                        type="button"
                        onClick={toggleShowClientId}
                        disabled={revealLoading}
                        className="p-0.5 text-gray-400 hover:text-gray-600"
                        title={showClientId ? t('openClawDetail.hide') : t('openClawDetail.viewOriginal')}
                      >
                        {revealLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : showClientId ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  )}
                  <input
                    type="text"
                    value={channelClientId}
                    onChange={(e) => setChannelClientId(e.target.value)}
                    disabled={!canModifyChannel}
                    placeholder={hasStored ? t('openClawDetail.overwritePlaceholder') : t('createOpenClaw.channelFields.clientId.placeholder', template.config_fields.find(f => f.name === 'clientId')?.placeholder)}
                    className="input-field max-w-md disabled:bg-gray-100 disabled:cursor-not-allowed"
                  />
                </div>
                {/* Client Secret */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t('createOpenClaw.channelFields.clientSecret.label', template.config_fields.find(f => f.name === 'clientSecret')?.label || 'Client Secret')}
                  </label>
                  {hasStored && (
                    <div className="flex items-center space-x-2 mb-2">
                      <span className="text-xs text-gray-400">{t('openClawDetail.currentValue')}</span>
                      <code className="text-xs font-mono bg-gray-50 border border-gray-200 rounded px-2 py-0.5">
                        {showClientSecret && revealedClientSecret ? revealedClientSecret : maskedClientSecret}
                      </code>
                      <button
                        type="button"
                        onClick={toggleShowClientSecret}
                        disabled={revealLoading}
                        className="p-0.5 text-gray-400 hover:text-gray-600"
                        title={showClientSecret ? t('openClawDetail.hide') : t('openClawDetail.viewOriginal')}
                      >
                        {revealLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : showClientSecret ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  )}
                  <input
                    type="password"
                    value={channelClientSecret}
                    onChange={(e) => setChannelClientSecret(e.target.value)}
                    disabled={!canModifyChannel}
                    placeholder={t('openClawDetail.unchangedPlaceholder')}
                    className="input-field max-w-md disabled:bg-gray-100 disabled:cursor-not-allowed"
                  />
                </div>
              </div>
            )
          })()}
          {(selectedChannel !== originalChannel || channelClientId !== originalChannelClientId) && (
            <p className="text-xs text-orange-500">{t('openClawDetail.modified')}</p>
          )}
        </div>
      </div>
      )}

      {showTerminal && accessTokenRef.current && (
        <div ref={terminalSectionRef} className="scroll-mt-6">
          <TerminalPanel
            instanceId={instance.id}
            accessToken={accessTokenRef.current}
            sandboxId={instance.sandbox_id}
            onClose={() => setShowTerminal(false)}
            onFloat={handleFloatTerminal}
          />
        </div>
      )}

      {showInstallSkills && accessTokenRef.current && (
        <InstallSkillModal
          token={accessTokenRef.current}
          instanceId={instance.id}
          isAdminView={isAdminView}
          translationNamespace={isAdminView ? 'admin' : 'user'}
          onClose={() => setShowInstallSkills(false)}
        />
      )}

    </div>
  )
}

export default OpenClawDetail
