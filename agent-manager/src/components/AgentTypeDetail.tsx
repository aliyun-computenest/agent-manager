import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useParams, useNavigate, Link, useSearchParams } from 'react-router-dom'
import {
  ArrowLeft, Save, Loader2, Settings, FileJson, MessageSquare, Puzzle,
  Plus, Edit2, ToggleLeft, ToggleRight, X, Upload, Eye, Copy, Check,
  Download, Trash2, ExternalLink, Terminal, Play, RefreshCw, AlertTriangle,
  History, Search, ChevronLeft, ChevronRight, Info, ShieldCheck
} from 'lucide-react'
import { useTranslation, Trans } from 'react-i18next'
import toast from 'react-hot-toast'
import { useAuth } from '../contexts/AuthContext'
import { apiUrl } from '../lib/api'
import AgentTypeSkillsGuideTab from './AgentTypeSkillsGuideTab'
import { listSandboxSets, type SandboxSetSummary } from '../lib/sandboxsets'
import { getDefaultUpgradeCommandText } from '../lib/upgradeDefaults'

// ====== Types ======

interface AgentType {
  id: string
  code: string
  name: string
  description: string | null
  icon: string
  category: 'builtin' | 'custom'
  sandbox_template_id: string | null
  sandbox_timeout: number
  config_template: Record<string, unknown>
  config_write_path: string | null
  startup_command: string | null
  modify_model_command: string | null
  modify_channel_command: string | null
  readiness_check: Record<string, unknown>
  upgrade_metadata?: UpgradeMetadata
  supports_channels: boolean
  supports_env_vars: boolean
  supports_skills: boolean
  skill_path: string
  user_terminal_enabled: boolean
  sandbox_user: string | null
  terminal_user: string | null
  is_enabled: boolean
  sort_order: number
  custom_vars_schema: CustomVarDef[] | null
  observability_env: Record<string, string> | null
  observability_enabled: boolean
}

interface CustomVarDef {
  name: string
  label: string
  type: 'text' | 'password' | 'textarea'
  required: boolean
  placeholder?: string
  description?: string
}

interface UpgradeMetadata {
  timeoutSeconds?: number
  preUpgrade?: { command?: string[] }
  postUpgrade?: { command?: string[] }
}

interface SandboxItem {
  Name: string
  Namespace: string
  Phase: string | null
  PodIP: string | null
  BackupReady: boolean
  CurrentImage: string | null
  TargetImage: string | null
  ImageMatchesTarget: boolean
  Images?: {
    Name: string
    Image: string | null
    TargetImage: string | null
    ImageMatchesTarget: boolean
  }[]
  Labels: Record<string, string>
  CreatedAt: string
}

interface BackupRestoreCapability {
  Supported: boolean
  RequiredRuntimes: string[]
  MissingRuntimes: string[]
  Message?: string | null
  Error?: string | null
}

interface UpgradeContext {
  Namespace: string
  SandboxSetName: string
  DefaultSelector: {
    matchLabels?: Record<string, string>
    matchExpressions?: {
      key: string
      operator: string
      values?: string[]
    }[]
  }
  TargetImage?: string | null
  TargetImages?: {
    Name: string
    Image: string
  }[]
  BackupRestoreCapability?: BackupRestoreCapability
}

interface UpgradeItem {
  UpgradeId: string
  Phase: string
  RawPhase?: string
  Retryable?: boolean
  Optimistic?: boolean
  Progress: {
    Replicas: number
    UpdatedReplicas: number
    UpdatingReplicas: number
    FailedReplicas: number
  }
  MaxUnavailable: number | string
  CreatedAt: string
  Selector?: {
    matchLabels?: Record<string, string>
    matchExpressions?: {
      key: string
      operator: string
      values?: string[]
    }[]
  }
  Conditions?: {
    type?: string
    Type?: string
    status?: string
    Status?: string
    reason?: string
    Reason?: string
    message?: string
    Message?: string
    lastTransitionTime?: string
    LastTransitionTime?: string
  }[]
  FailedSandboxes?: {
    SandboxName: string
    PodName: string
    PodIP: string | null
    NodeName?: string | null
    Phase: string | null
    ConditionType?: string | null
    ConditionStatus?: string | null
    Reason: string | null
    Message: string
    LastTransitionTime?: string | null
    CreatedAt?: string | null
    MatchedBySnapshot?: boolean
  }[]
  Sandboxes?: {
    SandboxName: string
    PodName: string
    PodIP: string | null
    NodeName?: string | null
    Phase: string | null
    ConditionType?: string | null
    ConditionStatus?: string | null
    Reason: string | null
    Message: string
    LastTransitionTime?: string | null
    CreatedAt?: string | null
    MatchedBySnapshot?: boolean
  }[]
}

export interface SandboxUpgradeAgentType {
  id: string
  code: string
  name: string
  sandbox_template_id: string | null
  upgrade_metadata?: UpgradeMetadata
}

type UpgradeLifecycleMode = 'Full' | 'PostOnly'

interface ChannelTemplate {
  id: string
  channel_type: 'feishu' | 'dingtalk' | 'qq' | 'wecom'
  name: string
  description?: string
  config_fields: { name: string; label: string; type: string; required: boolean; placeholder?: string }[]
  is_enabled: boolean
  agent_type_id: string
}

type TabId = 'basic' | 'template' | 'channels' | 'skills' | 'backupUpgrade'

const isTabId = (value: string | null): value is TabId =>
  value === 'basic' ||
  value === 'template' ||
  value === 'channels' ||
  value === 'skills' ||
  value === 'backupUpgrade'

function createClientToken() {
  const cryptoApi = globalThis.crypto
  if (typeof cryptoApi?.getRandomValues === 'function') {
    const bytes = new Uint8Array(16)
    cryptoApi.getRandomValues(bytes)
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0'))
    return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`
  }
  return `sbu-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`
}

// ====== Channel icons ======

const FeishuIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 15h-2v-6h2v6zm4 0h-2v-6h2v6zm-2-8c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1z"/>
  </svg>
)
const DingtalkIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69a.2.2 0 00-.05-.18c-.06-.05-.14-.03-.21-.02-.09.02-1.49.95-4.22 2.79-.4.27-.76.41-1.08.4-.36-.01-1.04-.2-1.55-.37-.63-.2-1.12-.31-1.08-.66.02-.18.27-.36.74-.55 2.92-1.27 4.86-2.11 5.83-2.51 2.78-1.16 3.35-1.36 3.73-1.36.08 0 .27.02.39.12.1.08.13.19.14.27-.01.06.01.24 0 .38z"/>
  </svg>
)
const WecomIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-2-3.5l4-2.5-4-2.5v5z"/>
  </svg>
)
const QQIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z"/>
  </svg>
)

// ====== Main Component ======

const AgentTypeDetail: React.FC = () => {
  const { t } = useTranslation('admin')
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { session } = useAuth()
  const requestedTab = searchParams.get('tab')
  const selectedSandboxName = searchParams.get('selectedSandbox') || undefined
  const [activeTab, setActiveTab] = useState<TabId>(() => isTabId(requestedTab) ? requestedTab : 'basic')
  const [agentType, setAgentType] = useState<AgentType | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [successMsg, setSuccessMsg] = useState('')

  const token = session?.access_token
  const accessTokenRef = useRef<string | null>(token ?? null)
  const tRef = useRef(t)
  const isAuthenticated = Boolean(token)

  useEffect(() => {
    accessTokenRef.current = token ?? null
  }, [token])

  useEffect(() => {
    tRef.current = t
  }, [t])

  useEffect(() => {
    if (isTabId(requestedTab)) {
      setActiveTab(requestedTab)
    }
  }, [requestedTab])

  useEffect(() => {
    if (requestedTab !== 'sandboxUpgrade' || !id) return
    const params = new URLSearchParams({ agentTypeId: id })
    if (selectedSandboxName) params.set('selectedSandbox', selectedSandboxName)
    navigate(`/admin/instance-upgrades?${params.toString()}`, { replace: true })
  }, [requestedTab, id, selectedSandboxName, navigate])

  const channelTypeOptions = [
    { value: 'feishu', label: t('agentTypeDetail.channelType.feishu'), Icon: FeishuIcon, iconColor: 'text-blue-500', defaultName: t('agentTypeDetail.channelDefaultName.feishu') },
    { value: 'dingtalk', label: t('agentTypeDetail.channelType.dingtalk'), Icon: DingtalkIcon, iconColor: 'text-sky-500', defaultName: t('agentTypeDetail.channelDefaultName.dingtalk') },
    { value: 'wecom', label: t('agentTypeDetail.channelType.wecom'), Icon: WecomIcon, iconColor: 'text-green-500', defaultName: t('agentTypeDetail.channelDefaultName.wecom') },
    { value: 'qq', label: t('agentTypeDetail.channelType.qq'), Icon: QQIcon, iconColor: 'text-red-500', defaultName: t('agentTypeDetail.channelDefaultName.qq') }
  ]

  const getChannelTypeLabel = (type: string) => channelTypeOptions.find(o => o.value === type)?.label || type
  const getChannelTypeIcon = (type: string) => {
    const opt = channelTypeOptions.find(o => o.value === type)
    if (!opt) return null
    const { Icon, iconColor } = opt
    return <Icon className={`w-5 h-5 ${iconColor}`} />
  }

  const defaultConfigFields = [
    { name: 'clientId', label: 'Client ID', type: 'text', required: true, placeholder: t('agentTypeDetail.configField.appId') },
    { name: 'clientSecret', label: 'Client Secret', type: 'password', required: true, placeholder: t('agentTypeDetail.configField.appSecret') }
  ]

  const tabs: { id: TabId; label: string; icon: React.ElementType }[] = [
    { id: 'basic', label: t('agentTypeDetail.tabs.basic'), icon: Settings },
    { id: 'template', label: t('agentTypeDetail.tabs.template'), icon: FileJson },
    ...(agentType?.supports_channels ? [{ id: 'channels' as TabId, label: t('agentTypeDetail.tabs.channels'), icon: MessageSquare }] : []),
    ...(agentType?.supports_skills !== false ? [{ id: 'skills' as TabId, label: t('agentTypeDetail.tabs.skills'), icon: Puzzle }] : []),
    { id: 'backupUpgrade', label: t('agentTypeDetail.tabs.backupUpgrade'), icon: Terminal },
  ]

  const showSuccess = (msg: string) => {
    setSuccessMsg(msg)
    setTimeout(() => setSuccessMsg(''), 3000)
  }

  const fetchAgentType = useCallback(async () => {
    const currentToken = accessTokenRef.current
    if (!currentToken || !id) return
    setLoading(true)
    try {
      const res = await fetch(`${apiUrl}/api/agent-types/${id}`, {
        headers: { 'Authorization': `Bearer ${currentToken}` }
      })
      const data = await res.json()
      if (data.success) setAgentType(data.agentType)
      else setError(data.error || tRef.current('agentTypeDetail.loadFailed'))
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    if (isAuthenticated) fetchAgentType()
  }, [fetchAgentType, isAuthenticated])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-primary-600" />
        <span className="ml-3 text-gray-600">{t('common:loading.default')}</span>
      </div>
    )
  }

  if (!agentType) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500">{t('agentTypeDetail.notExist')}</p>
        <button onClick={() => navigate('/admin/agent-types')} className="btn-primary mt-4">{t('agentTypeDetail.backToList')}</button>
      </div>
    )
  }

  return (
    <div className="min-w-0 max-w-full space-y-6 overflow-x-hidden">
      {/* Header */}
      <div className="flex items-center space-x-4">
        <button onClick={() => navigate('/admin/agent-types')} className="p-2 hover:bg-gray-100 rounded-lg">
          <ArrowLeft className="w-5 h-5 text-gray-600" />
        </button>
        <div>
          <div className="flex items-center space-x-2">
            <h2 className="text-xl font-semibold text-gray-900">{agentType.name}</h2>
            <code className="text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">{agentType.code}</code>
            <span className={`text-xs px-1.5 py-0.5 rounded ${
              agentType.category === 'builtin' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'
            }`}>
              {agentType.category === 'builtin' ? t('agentTypeDetail.builtin') : t('agentTypeDetail.custom')}
            </span>
          </div>
          {agentType.description && <p className="text-sm text-gray-500 mt-0.5">{agentType.description}</p>}
        </div>
      </div>

      {successMsg && <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg">{successMsg}</div>}
      {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">{error}</div>}

      {/* Tabs */}
      <div className="border-b border-gray-200">
        <div className="flex gap-1 overflow-x-auto">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => { setActiveTab(tab.id); setError('') }}
              className={`flex shrink-0 items-center gap-2 whitespace-nowrap px-4 py-2.5 border-b-2 text-sm font-medium transition-colors ${
                activeTab === tab.id
                  ? 'border-primary-600 text-primary-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              <tab.icon className="h-4 w-4 shrink-0" />
              <span>{tab.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      {activeTab === 'basic' && (
        <BasicConfigTab agentType={agentType} token={token!} onUpdate={(at) => { setAgentType(at); showSuccess(t('agentTypeDetail.saveSuccess')) }} onError={setError} />
      )}
      {activeTab === 'template' && (
        <ConfigTemplateTab agentType={agentType} token={token!} onUpdate={(at) => { setAgentType(at); showSuccess(t('agentTypeDetail.configTemplateSaved')) }} onError={setError} />
      )}
      {activeTab === 'channels' && agentType.supports_channels && (
        <ChannelsTab agentTypeId={agentType.id} token={token!} channelTypeOptions={channelTypeOptions} getChannelTypeLabel={getChannelTypeLabel} getChannelTypeIcon={getChannelTypeIcon} defaultConfigFields={defaultConfigFields} onError={setError} onSuccess={showSuccess} />
      )}
      {activeTab === 'skills' && agentType.supports_skills !== false && <AgentTypeSkillsGuideTab agentType={agentType} token={token!} onUpdate={(at) => { setAgentType(at); showSuccess(t('agentTypeDetail.saveSuccess')) }} onError={setError} />}
      {activeTab === 'backupUpgrade' && (
        <BackupUpgradeConfigTab agentType={agentType} token={token!} onUpdate={(at) => { setAgentType(at); showSuccess(t('agentTypeDetail.backupUpgrade.saveSuccess')) }} onError={setError} />
      )}
    </div>
  )
}

// ====== Tab 1: Basic Config ======

function BasicConfigTab({ agentType, token, onUpdate, onError }: {
  agentType: AgentType; token: string;
  onUpdate: (at: AgentType) => void; onError: (e: string) => void
}) {
  const { t } = useTranslation('admin')
  const [form, setForm] = useState({
    name: agentType.name,
    description: agentType.description || '',
    sandboxTemplateId: agentType.sandbox_template_id || '',
    sandboxTimeout: agentType.sandbox_timeout || 300,
    configWritePath: agentType.config_write_path || '',
    startupCommand: agentType.startup_command || '',
    modifyModelCommand: agentType.modify_model_command || '',
    modifyChannelCommand: agentType.modify_channel_command || '',
    supportsChannels: agentType.supports_channels,
    supportsEnvVars: agentType.supports_env_vars || false,
    supportsSkills: agentType.supports_skills !== false,
    skillPath: agentType.skill_path || '',
    userTerminalEnabled: agentType.user_terminal_enabled === true,
    sandboxUser: agentType.sandbox_user || '',
    terminalUser: agentType.terminal_user || 'node',
    sortOrder: agentType.sort_order,
    readinessCheck: JSON.stringify(agentType.readiness_check || {}, null, 2),
  })
  const [customVarsSchema, setCustomVarsSchema] = useState<CustomVarDef[]>(agentType.custom_vars_schema || [])
  const [observabilityEnv, setObservabilityEnv] = useState<{ key: string; value: string }[]>(
    Object.entries(agentType.observability_env || {}).map(([key, value]) => ({ key, value }))
  )
  const [observabilityEnabled, setObservabilityEnabled] = useState<boolean>(agentType.observability_enabled !== false)
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    onError('')
    if (!form.name) {
      onError(t('agentTypeDetail.validation.nameRequired'))
      return
    }
    if (!form.skillPath.startsWith('/') || form.skillPath.split('/').some(segment => segment === '.' || segment === '..')) {
      onError(t('agentTypeDetail.validation.skillPath'))
      return
    }
    let readinessCheck
    try { readinessCheck = JSON.parse(form.readinessCheck) } catch { onError(t('agentTypeDetail.validation.readinessCheck')); return }

    setSaving(true)
    try {
      const res = await fetch(`${apiUrl}/api/agent-types/${agentType.id}`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name,
          description: form.description || null,
          sandboxTemplateId: form.sandboxTemplateId || null,
          sandboxTimeout: form.sandboxTimeout,
          configWritePath: form.configWritePath || null,
          startupCommand: form.startupCommand || null,
          modifyModelCommand: form.modifyModelCommand || null,
          modifyChannelCommand: form.modifyChannelCommand || null,
          readinessCheck,
          supportsChannels: form.supportsChannels,
          supportsEnvVars: form.supportsEnvVars,
          supportsSkills: form.supportsSkills,
          skillPath: form.skillPath,
          userTerminalEnabled: form.userTerminalEnabled,
          sandboxUser: form.sandboxUser || null,
          terminalUser: form.terminalUser || 'node',
          sortOrder: form.sortOrder,
          customVarsSchema: customVarsSchema.length > 0 ? customVarsSchema : null,
          observabilityEnv: observabilityEnv.length > 0
            ? Object.fromEntries(observabilityEnv.filter(e => e.key).map(e => [e.key, e.value]))
            : null,
          observability_enabled: observabilityEnabled,
        })
      })
      const data = await res.json()
      if (!data.success) throw new Error(data.error || t('agentTypeDetail.saveFailed'))
      onUpdate(data.agentType)
    } catch (err: any) {
      onError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const capabilityOptionClass = (enabled: boolean) =>
    `flex min-h-[52px] cursor-pointer items-center gap-3 rounded-lg border px-3.5 py-3 transition-colors ${
      enabled
        ? 'border-primary-200 bg-primary-50 text-gray-900 shadow-sm'
        : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300 hover:bg-gray-50'
    }`
  const capabilityIconClass = (enabled: boolean) =>
    `h-4 w-4 shrink-0 ${enabled ? 'text-primary-600' : 'text-gray-400'}`

  return (
    <div className="space-y-6">
      {/* 基本信息 */}
      <div className="card">
        <h3 className="text-sm font-semibold text-gray-900 mb-4 flex items-center space-x-2">
          <span className="w-1 h-4 bg-primary-600 rounded-full"></span>
          <span>{t('agentTypeDetail.basicInfo')}</span>
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">{t('agentTypeDetail.name')} *</label>
            <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="input-field" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">{t('agentTypeDetail.description')}</label>
            <input type="text" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="input-field" placeholder={t('agentTypeDetail.descriptionPlaceholder')} />
          </div>
        </div>
      </div>

      {/* 运行时配置 */}
      <div className="card">
        <h3 className="text-sm font-semibold text-gray-900 mb-4 flex items-center space-x-2">
          <span className="w-1 h-4 bg-green-600 rounded-full"></span>
          <span>{t('agentTypeDetail.runtimeConfig')}</span>
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">{t('agentTypeDetail.sandboxTemplateId')}</label>
            <SandboxSetSelect
              value={form.sandboxTemplateId}
              onChange={(v) => setForm({ ...form, sandboxTemplateId: v })}
              agentTypeCode={agentType.code}
            />
            <div className="mt-1 flex items-center justify-between">
              <p className="text-xs text-gray-400">{t('agentTypeDetail.sandboxTemplateHint', { code: agentType.code })}</p>
              <Link
                to={`/admin/sandboxsets/${form.sandboxTemplateId || agentType.code}`}
                className="text-xs text-primary-600 hover:text-primary-700 inline-flex items-center gap-1"
              >
                {t('agentTypeDetail.viewOrEdit')}
                <ExternalLink className="w-3 h-3" />
              </Link>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">{t('agentTypeDetail.sandboxTimeout')}</label>
            <input type="number" value={form.sandboxTimeout} onChange={(e) => setForm({ ...form, sandboxTimeout: parseInt(e.target.value) || 300 })} className="input-field" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">{t('agentTypeDetail.configWritePath')}</label>
            <input type="text" value={form.configWritePath} onChange={(e) => setForm({ ...form, configWritePath: e.target.value })} className="input-field" placeholder={t('agentTypeDetail.configWritePathPlaceholder')} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">{t('agentTypeDetail.sandboxUser')}</label>
            <input type="text" value={form.sandboxUser} onChange={(e) => setForm({ ...form, sandboxUser: e.target.value })} className="input-field" placeholder={t('agentTypeDetail.sandboxUserPlaceholder')} />
            <p className="text-xs text-gray-400 mt-1">{t('agentTypeDetail.sandboxUserHint')}</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">{t('agentTypeDetail.terminalUser')}</label>
            <input type="text" value={form.terminalUser} onChange={(e) => setForm({ ...form, terminalUser: e.target.value })} className="input-field" placeholder={t('agentTypeDetail.terminalUserPlaceholder')} />
            <p className="text-xs text-gray-400 mt-1">{t('agentTypeDetail.terminalUserHint')}</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">{t('agentTypeDetail.skillPath')}</label>
            <input type="text" value={form.skillPath} onChange={(e) => setForm({ ...form, skillPath: e.target.value })} className="input-field font-mono" placeholder={t('agentTypeDetail.skillPathPlaceholder')} />
            <p className="text-xs text-gray-400 mt-1">{t('agentTypeDetail.skillPathHint')}</p>
          </div>
        </div>
        <div className="mt-4">
          <label className="block text-sm font-medium text-gray-700 mb-1">{t('agentTypeDetail.startupCommand')}</label>
          <textarea value={form.startupCommand} onChange={(e) => setForm({ ...form, startupCommand: e.target.value })} className="input-field font-mono text-sm h-28 resize-y" placeholder={'#!/bin/bash\ncat > /opt/data/.env << \'EOF\'\nKEY=value\nEOF'} />
        </div>
        <div className="mt-4">
          <label className="block text-sm font-medium text-gray-700 mb-1">{t('agentTypeDetail.modifyModelCommand')}</label>
          <textarea
            value={form.modifyModelCommand}
            onChange={(e) => setForm({ ...form, modifyModelCommand: e.target.value })}
            className="input-field font-mono text-sm h-24 resize-y"
            placeholder={t('agentTypeDetail.modifyModelCommandPlaceholder')}
          />
          <p className="text-xs text-gray-400 mt-1">
            <Trans
              t={t}
              i18nKey="agentTypeDetail.modifyModelCommandHint"
              ns="admin"
              values={{ vars: '${MODEL_NAME} / ${MODEL_PROVIDER} / ${AI_GATEWAY_DOMAIN} / ${CONSUMER_API_KEY}' }}
              components={{ 1: <code /> }}
            />
          </p>
        </div>
        {form.supportsChannels && (
          <div className="mt-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">{t('agentTypeDetail.modifyChannelCommand')}</label>
            <textarea
              value={form.modifyChannelCommand}
              onChange={(e) => setForm({ ...form, modifyChannelCommand: e.target.value })}
              className="input-field font-mono text-sm h-24 resize-y"
              placeholder={t('agentTypeDetail.modifyChannelCommandPlaceholder')}
            />
            <p className="text-xs text-gray-400 mt-1">
              <Trans
                t={t}
                i18nKey="agentTypeDetail.modifyChannelCommandHint"
                ns="admin"
                values={{ vars: '${CHANNEL_CONFIG_JSON} / ${CHANNEL_TYPE} / ${CHANNEL_CLIENT_ID} / ${CHANNEL_CLIENT_SECRET}' }}
                components={{ 1: <code /> }}
              />
            </p>
          </div>
        )}
        <div className="mt-4">
          <label className="block text-sm font-medium text-gray-700 mb-1">{t('agentTypeDetail.readinessCheck')}</label>
          <textarea value={form.readinessCheck} onChange={(e) => setForm({ ...form, readinessCheck: e.target.value })} className="input-field font-mono text-sm h-24 resize-none" placeholder='{"type": "http", "path": "/health", "interval": 5, "timeout": 60}' />
        </div>
      </div>

      {/* 自定义变量 */}
      <div className="card">
        <h3 className="text-sm font-semibold text-gray-900 mb-4 flex items-center space-x-2">
          <span className="w-1 h-4 bg-purple-600 rounded-full"></span>
          <span>{t('agentTypeDetail.customVars.title')}</span>
        </h3>
        <p className="text-xs text-gray-500 mb-4">{t('agentTypeDetail.customVars.hint')}</p>

        {customVarsSchema.length > 0 && (
          <div className="border border-gray-200 rounded-lg overflow-hidden mb-4">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left px-3 py-2 font-medium text-gray-600">{t('agentTypeDetail.customVars.varName')}</th>
                  <th className="text-left px-3 py-2 font-medium text-gray-600">{t('agentTypeDetail.customVars.varLabel')}</th>
                  <th className="text-left px-3 py-2 font-medium text-gray-600">{t('agentTypeDetail.customVars.varType')}</th>
                  <th className="text-center px-3 py-2 font-medium text-gray-600">{t('agentTypeDetail.customVars.varRequired')}</th>
                  <th className="text-left px-3 py-2 font-medium text-gray-600">{t('agentTypeDetail.customVars.varPlaceholder')}</th>
                  <th className="w-10"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {customVarsSchema.map((v, idx) => (
                  <tr key={idx} className="hover:bg-gray-50">
                    <td className="px-3 py-2">
                      <input type="text" value={v.name} onChange={(e) => { const arr = [...customVarsSchema]; arr[idx] = { ...v, name: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '') }; setCustomVarsSchema(arr) }} className="input-field text-xs font-mono py-1" placeholder="MY_VAR" />
                    </td>
                    <td className="px-3 py-2">
                      <input type="text" value={v.label} onChange={(e) => { const arr = [...customVarsSchema]; arr[idx] = { ...v, label: e.target.value }; setCustomVarsSchema(arr) }} className="input-field text-xs py-1" placeholder={t('agentTypeDetail.customVars.labelPlaceholder')} />
                    </td>
                    <td className="px-3 py-2">
                      <select value={v.type} onChange={(e) => { const arr = [...customVarsSchema]; arr[idx] = { ...v, type: e.target.value as 'text' | 'password' | 'textarea' }; setCustomVarsSchema(arr) }} className="input-field text-xs py-1">
                        <option value="text">text</option>
                        <option value="password">password</option>
                        <option value="textarea">textarea</option>
                      </select>
                    </td>
                    <td className="px-3 py-2 text-center">
                      <input type="checkbox" checked={v.required} onChange={(e) => { const arr = [...customVarsSchema]; arr[idx] = { ...v, required: e.target.checked }; setCustomVarsSchema(arr) }} className="h-4 w-4 rounded border-gray-300 text-primary-600" />
                    </td>
                    <td className="px-3 py-2">
                      <input type="text" value={v.placeholder || ''} onChange={(e) => { const arr = [...customVarsSchema]; arr[idx] = { ...v, placeholder: e.target.value }; setCustomVarsSchema(arr) }} className="input-field text-xs py-1" placeholder={t('agentTypeDetail.customVars.placeholderHint')} />
                    </td>
                    <td className="px-3 py-2">
                      <button onClick={() => setCustomVarsSchema(customVarsSchema.filter((_, i) => i !== idx))} className="text-red-400 hover:text-red-600">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <button
          type="button"
          onClick={() => setCustomVarsSchema([...customVarsSchema, { name: '', label: '', type: 'text', required: false, placeholder: '' }])}
          className="inline-flex items-center gap-1.5 text-sm text-primary-600 hover:text-primary-700 font-medium"
        >
          <Plus className="w-4 h-4" />
          {t('agentTypeDetail.customVars.add')}
        </button>
      </div>

      {/* AI 应用可观测参数 */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-gray-900 flex items-center space-x-2">
            <span className="w-1 h-4 bg-teal-600 rounded-full"></span>
            <span>{t('agentTypeDetail.observabilityEnv.title')}</span>
          </h3>
        </div>

        {/* 采集开关 - 紧凑一体 */}
        <div className="flex items-center gap-3 mb-4">
          <button
            type="button"
            onClick={() => setObservabilityEnabled(!observabilityEnabled)}
            className={`relative inline-flex h-7 w-[72px] items-center rounded-full transition-all duration-200 shadow-inner flex-shrink-0 ${
              observabilityEnabled
                ? 'bg-gradient-to-r from-blue-500 to-blue-600'
                : 'bg-gradient-to-r from-gray-300 to-gray-400'
            }`}
          >
            <span className={`absolute text-[10px] font-medium select-none ${
              observabilityEnabled ? 'left-2 text-white' : 'right-2 text-gray-600'
            }`}>
              {observabilityEnabled ? '开启' : '关闭'}
            </span>
            <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-md transition-transform duration-200 ${
              observabilityEnabled ? 'translate-x-[47px]' : 'translate-x-[3px]'
            }`}>
              <span className={`absolute inset-0 m-auto w-1.5 h-1.5 rounded-full ${
                observabilityEnabled ? 'bg-blue-500' : 'bg-gray-400'
              }`} />
            </span>
          </button>
          <span className={`text-sm ${observabilityEnabled ? 'text-gray-700' : 'text-gray-500'}`}>
            {observabilityEnabled ? '采集上报中' : '采集已关闭'}
          </span>
          <span className="text-xs text-gray-400">· 切换后即时生效</span>
        </div>

        {observabilityEnv.length > 0 && (
          <div className="border border-gray-200 rounded-lg overflow-hidden mb-4">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left px-3 py-2 font-medium text-gray-600 w-1/3">{t('agentTypeDetail.observabilityEnv.varName')}</th>
                  <th className="text-left px-3 py-2 font-medium text-gray-600">{t('agentTypeDetail.observabilityEnv.varValue')}</th>
                  <th className="w-10"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {observabilityEnv.map((entry, idx) => (
                  <tr key={idx} className="hover:bg-gray-50">
                    <td className="px-3 py-2">
                      <input
                        type="text"
                        value={entry.key}
                        onChange={(e) => {
                          const arr = [...observabilityEnv]
                          arr[idx] = { ...entry, key: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '') }
                          setObservabilityEnv(arr)
                        }}
                        className="input-field text-xs font-mono py-1"
                        placeholder="ENV_VAR_NAME"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="text"
                        value={entry.value}
                        onChange={(e) => {
                          const arr = [...observabilityEnv]
                          arr[idx] = { ...entry, value: e.target.value }
                          setObservabilityEnv(arr)
                        }}
                        className="input-field text-xs font-mono py-1"
                        placeholder={t('agentTypeDetail.observabilityEnv.valuePlaceholder')}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <button onClick={() => setObservabilityEnv(observabilityEnv.filter((_, i) => i !== idx))} className="text-red-400 hover:text-red-600">
                        <X className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <button
          type="button"
          onClick={() => setObservabilityEnv([...observabilityEnv, { key: '', value: '' }])}
          className="inline-flex items-center gap-1.5 text-sm text-primary-600 hover:text-primary-700 font-medium"
        >
          <Plus className="w-4 h-4" />
          {t('agentTypeDetail.observabilityEnv.add')}
        </button>

        <p className="text-xs text-gray-400 mt-3">{t('agentTypeDetail.observabilityEnv.hint')}</p>
      </div>

      {/* 展示与行为 */}
      <div className="card">
        <h3 className="text-sm font-semibold text-gray-900 mb-4 flex items-center space-x-2">
          <span className="w-1 h-4 bg-amber-500 rounded-full"></span>
          <span>{t('agentTypeDetail.displayBehavior')}</span>
        </h3>
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(220px,320px)_1fr]">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">{t('agentTypeDetail.sortOrder')}</label>
            <input type="number" value={form.sortOrder} onChange={(e) => setForm({ ...form, sortOrder: parseInt(e.target.value) || 0 })} className="input-field" />
            <p className="text-xs text-gray-400 mt-1">{t('agentTypeDetail.sortOrderHint')}</p>
          </div>
          <div>
            <span className="mb-2 block text-sm font-medium text-gray-700">{t('agentTypeDetail.capabilities')}</span>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <label className={capabilityOptionClass(form.supportsChannels)}>
                <input type="checkbox" checked={form.supportsChannels} onChange={(e) => setForm({ ...form, supportsChannels: e.target.checked })} className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500" />
                <MessageSquare className={capabilityIconClass(form.supportsChannels)} />
                <span className="min-w-0 text-sm font-medium leading-5">{t('agentTypeDetail.supportsChannels')}</span>
              </label>
              <label className={capabilityOptionClass(form.supportsEnvVars)}>
                <input type="checkbox" checked={form.supportsEnvVars} onChange={(e) => setForm({ ...form, supportsEnvVars: e.target.checked })} className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500" />
                <ShieldCheck className={capabilityIconClass(form.supportsEnvVars)} />
                <span className="min-w-0 text-sm font-medium leading-5">{t('agentTypeDetail.supportsEnvVars')}</span>
              </label>
              <label className={capabilityOptionClass(form.supportsSkills)}>
                <input type="checkbox" checked={form.supportsSkills} onChange={(e) => setForm({ ...form, supportsSkills: e.target.checked })} className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500" />
                <Puzzle className={capabilityIconClass(form.supportsSkills)} />
                <span className="min-w-0 text-sm font-medium leading-5">{t('agentTypeDetail.supportsSkills')}</span>
              </label>
              <label className={capabilityOptionClass(form.userTerminalEnabled)}>
                <input type="checkbox" checked={form.userTerminalEnabled} onChange={(e) => setForm({ ...form, userTerminalEnabled: e.target.checked })} className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500" />
                <Terminal className={capabilityIconClass(form.userTerminalEnabled)} />
                <span className="min-w-0 text-sm font-medium leading-5">{t('agentTypeDetail.userTerminalEnabled')}</span>
              </label>
            </div>
          </div>
        </div>
      </div>

      <div className="flex justify-end">
        <button onClick={handleSave} disabled={saving} className="btn-primary flex items-center space-x-2 disabled:opacity-50">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          <span>{saving ? t('agentTypeDetail.saving') : t('common:buttons.save')}</span>
        </button>
      </div>
    </div>
  )
}

// ====== Tab 2: Config Template ======

// Helper: detect template format from stored config_template
function detectTemplateFormat(tpl: Record<string, unknown>): 'json' | 'yaml' {
  return tpl?._format === 'yaml' ? 'yaml' : 'json'
}

// Helper: extract display text from config_template
function getTemplateDisplayText(tpl: Record<string, unknown>, fmt: 'json' | 'yaml'): string {
  if (fmt === 'yaml') return (tpl?._content as string) || ''
  const { _meta, _format, _content, ...rest } = tpl || {}
  return Object.keys(rest).length > 0 ? JSON.stringify(rest, null, 2) : ''
}

function SandboxSetSelect({ value, onChange, agentTypeCode }: { value: string; onChange: (v: string) => void; agentTypeCode: string }) {
  const { session } = useAuth()
  const [options, setOptions] = useState<SandboxSetSummary[]>([])

  useEffect(() => {
    const token = session?.access_token
    if (!token) return
    listSandboxSets(token).then(setOptions).catch(() => {})
  }, [session?.access_token])

  const hasMatch = options.some(o => o.name === value)
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="input-field"
    >
      <option value="">默认使用 {agentTypeCode}</option>
      {options.map(o => (
        <option key={o.name} value={o.name}>
          {o.name} ({o.namespace})
        </option>
      ))}
      {value && !hasMatch && (
        <option value={value}>{value}（未在列表中）</option>
      )}
    </select>
  )
}

function ConfigTemplateTab({ agentType, token, onUpdate, onError }: {
  agentType: AgentType; token: string;
  onUpdate: (at: AgentType) => void; onError: (e: string) => void
}) {
  const { t } = useTranslation('admin')
  const hasTemplate = agentType.config_template && Object.keys(agentType.config_template).length > 0
  const detectedFormat = hasTemplate ? detectTemplateFormat(agentType.config_template) : 'json'
  const [view, setView] = useState<'upload' | 'preview'>(hasTemplate ? 'preview' : 'upload')
  const [format, setFormat] = useState<'json' | 'yaml'>(detectedFormat)
  const [configText, setConfigText] = useState(hasTemplate ? getTemplateDisplayText(agentType.config_template, detectedFormat) : '')
  const [saving, setSaving] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [copied, setCopied] = useState(false)

  const saveTemplate = async (content: Record<string, unknown>) => {
    setSaving(true)
    onError('')
    try {
      const res = await fetch(`${apiUrl}/api/agent-types/${agentType.id}`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ configTemplate: content })
      })
      const data = await res.json()
      if (!data.success) throw new Error(data.error || t('agentTypeDetail.saveFailed'))
      onUpdate(data.agentType)
      setView('preview')
    } catch (err: any) {
      onError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const handleParseAndSave = () => {
    if (format === 'yaml') {
      if (!configText.trim()) { onError(t('agentTypeDetail.yamlEmpty')); return }
      saveTemplate({ _format: 'yaml', _content: configText })
    } else {
      try {
        const content = JSON.parse(configText)
        saveTemplate(content)
      } catch {
        onError(t('agentTypeDetail.jsonFormatError'))
      }
    }
  }

  const isYamlFile = (name: string) => name.endsWith('.yaml') || name.endsWith('.yml')
  const isJsonFile = (name: string) => name.endsWith('.json')
  const isSupportedFile = (name: string) => isJsonFile(name) || isYamlFile(name)

  const handleFileContent = (fileName: string, text: string) => {
    if (isYamlFile(fileName)) {
      setFormat('yaml')
      setConfigText(text)
      saveTemplate({ _format: 'yaml', _content: text })
    } else {
      try {
        const content = JSON.parse(text)
        setFormat('json')
        setConfigText(JSON.stringify(content, null, 2))
        saveTemplate(content)
      } catch { onError(t('agentTypeDetail.jsonParseFailed')) }
    }
  }

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (!isSupportedFile(file.name)) { onError(t('agentTypeDetail.unsupportedFile')); return }
    const reader = new FileReader()
    reader.onload = (ev) => handleFileContent(file.name, ev.target?.result as string)
    reader.readAsText(file)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); setIsDragging(false)
    const file = e.dataTransfer.files[0]
    if (!file) return
    if (!isSupportedFile(file.name)) { onError(t('agentTypeDetail.unsupportedFile')); return }
    const reader = new FileReader()
    reader.onload = (ev) => handleFileContent(file.name, ev.target?.result as string)
    reader.readAsText(file)
  }

  const handleDelete = async () => {
    if (!confirm(t('agentTypeDetail.confirmClear'))) return
    setSaving(true)
    try {
      const res = await fetch(`${apiUrl}/api/agent-types/${agentType.id}`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ configTemplate: {} })
      })
      const data = await res.json()
      if (!data.success) throw new Error(data.error || t('agentTypeDetail.clearFailed'))
      setConfigText('')
      setView('upload')
      onUpdate(data.agentType)
    } catch (err: any) { onError(err.message) }
    finally { setSaving(false) }
  }

  const handleCopy = async () => { await navigator.clipboard.writeText(configText); setCopied(true); setTimeout(() => setCopied(false), 2000) }
  const handleDownload = () => {
    const ext = format === 'yaml' ? 'yaml' : 'json'
    const mime = format === 'yaml' ? 'text/yaml' : 'application/json'
    const blob = new Blob([configText], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = `${agentType.code}-template.${ext}`; a.click()
    URL.revokeObjectURL(url)
  }

  const fileExt = format === 'yaml' ? 'yaml' : 'json'
  const formatLabel = format === 'yaml' ? 'YAML' : 'JSON'

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex space-x-1 bg-gray-100 p-1 rounded-lg">
          <button onClick={() => setView('upload')} className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${view === 'upload' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'}`}>
            <Upload className="w-4 h-4 inline-block mr-2" />{t('agentTypeDetail.uploadConfig')}
          </button>
          <button onClick={() => setView('preview')} disabled={!hasTemplate && !configText} className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${view === 'preview' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900 disabled:text-gray-400'}`}>
            <Eye className="w-4 h-4 inline-block mr-2" />{t('agentTypeDetail.previewConfig')}
          </button>
        </div>
        {/* Format indicator: selectable in upload view (for manual text input; file uploads auto-detect from extension), read-only in preview */}
        <div className="flex items-center space-x-2">
          <span className="text-sm text-gray-500">{t('agentTypeDetail.format')}</span>
          {view === 'upload' ? (
            <div className="flex space-x-1 bg-gray-100 p-0.5 rounded-lg">
              <button onClick={() => setFormat('json')} className={`px-3 py-1 rounded text-xs font-medium transition-colors ${format === 'json' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>JSON</button>
              <button onClick={() => setFormat('yaml')} className={`px-3 py-1 rounded text-xs font-medium transition-colors ${format === 'yaml' ? 'bg-amber-100 text-amber-800 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>YAML</button>
            </div>
          ) : (
            <span className={`px-3 py-1 rounded text-xs font-medium ${format === 'yaml' ? 'bg-amber-100 text-amber-800' : 'bg-gray-100 text-gray-900'}`}>{formatLabel}</span>
          )}
        </div>
      </div>

      {view === 'upload' && (
        <div className="space-y-6">
          <div onDrop={handleDrop} onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }} onDragLeave={() => setIsDragging(false)}
            className={`border-2 border-dashed rounded-xl p-12 text-center transition-colors ${isDragging ? 'border-primary-500 bg-primary-50' : 'border-gray-300 hover:border-gray-400'}`}>
            <FileJson className={`w-16 h-16 mx-auto mb-4 ${isDragging ? 'text-primary-500' : 'text-gray-400'}`} />
            <p className="text-lg font-medium text-gray-700 mb-2">{t('agentTypeDetail.dragDrop')}</p>
            <p className="text-sm text-gray-400 mb-1">{t('agentTypeDetail.supportedFormats')}</p>
            <p className="text-gray-500 mb-4">{t('common:or')}</p>
            <label className="btn-primary cursor-pointer inline-flex items-center space-x-2">
              <Upload className="w-4 h-4" /><span>{t('agentTypeDetail.selectFile')}</span>
              <input type="file" accept=".json,.yaml,.yml" onChange={handleFileUpload} className="hidden" />
            </label>
          </div>
          <div className="card">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">{t('agentTypeDetail.orPaste')} {formatLabel}</h3>
            <textarea value={configText} onChange={(e) => setConfigText(e.target.value)} placeholder={format === 'yaml' ? 'model:\n  default: ${MODEL_NAME}' : '{"key": "value"}'} className="input-field font-mono text-sm h-48 resize-none" />
            <div className="mt-4 flex justify-end">
              <button onClick={handleParseAndSave} disabled={!configText.trim() || saving} className="btn-primary disabled:opacity-50 flex items-center space-x-2">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                <span>{saving ? t('agentTypeDetail.saving') : t('agentTypeDetail.parseAndSave')}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {view === 'preview' && hasTemplate && (
        <div className="space-y-6">
          <div className="card">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center space-x-3">
                <div className={`p-3 rounded-lg ${format === 'yaml' ? 'bg-amber-100' : 'bg-primary-100'}`}><FileJson className={`w-6 h-6 ${format === 'yaml' ? 'text-amber-600' : 'text-primary-600'}`} /></div>
                <div>
                  <h3 className="font-semibold text-gray-900">{agentType.code}-template.{fileExt}</h3>
                  <p className="text-xs text-gray-400 mt-1">{t('agentTypeDetail.storageLocation', { format: formatLabel })}</p>
                </div>
              </div>
              <div className="flex items-center space-x-2">
                <button onClick={handleCopy} className="btn-secondary flex items-center space-x-1">
                  {copied ? <><Check className="w-4 h-4 text-green-600" /><span>{t('agentTypeDetail.copied')}</span></> : <><Copy className="w-4 h-4" /><span>{t('agentTypeDetail.copy')}</span></>}
                </button>
                <button onClick={handleDownload} className="btn-secondary flex items-center space-x-1"><Download className="w-4 h-4" /><span>{t('agentTypeDetail.download')}</span></button>
                <button onClick={handleDelete} disabled={saving} className="px-3 py-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors flex items-center space-x-1 disabled:opacity-50">
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}<span>{t('agentTypeDetail.clear')}</span>
                </button>
              </div>
            </div>
            <div className="bg-gray-900 rounded-lg p-4 overflow-auto max-h-[500px]">
              <pre className="text-sm text-gray-100 font-mono whitespace-pre-wrap">{configText}</pre>
            </div>
          </div>
          {/* Parsed Structure - JSON only */}
          {format === 'json' && (
            <div className="card">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">{t('agentTypeDetail.structurePreview')}</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {Object.entries(agentType.config_template || {}).filter(([key]) => !key.startsWith('_')).map(([key, value]) => (
                  <div key={key} className="bg-gray-50 rounded-lg p-4">
                    <h4 className="font-medium text-gray-700 mb-2">{key}</h4>
                    <p className="text-sm text-gray-500">
                      {value === null || value === undefined ? 'null' : typeof value === 'object' ? (Array.isArray(value) ? t('agentTypeDetail.arrayType', { count: value.length }) : t('agentTypeDetail.objectType', { count: Object.keys(value as object).length })) : String(value)}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
          {/* YAML structure hint */}
          {format === 'yaml' && (
            <div className="card bg-amber-50 border border-amber-100">
              <p className="text-sm text-amber-700">{t('agentTypeDetail.yamlHint')}</p>
            </div>
          )}
          {/* Edit */}
          <div className="card">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">{t('agentTypeDetail.editConfig')}</h3>
            <textarea value={configText} onChange={(e) => setConfigText(e.target.value)} className="input-field font-mono text-sm h-64 resize-none" />
            <div className="mt-4 flex justify-end">
              <button onClick={handleParseAndSave} disabled={!configText.trim() || saving} className="btn-primary disabled:opacity-50 flex items-center space-x-2">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                <span>{saving ? t('agentTypeDetail.saving') : t('agentTypeDetail.saveChanges')}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {view === 'preview' && !hasTemplate && (
        <div className="card text-center py-12">
          <FileJson className="w-16 h-16 text-gray-300 mx-auto mb-4" />
          <p className="text-gray-500">{t('agentTypeDetail.noTemplate')}</p>
          <button onClick={() => setView('upload')} className="btn-primary mt-4">{t('agentTypeDetail.goUpload')}</button>
        </div>
      )}
    </div>
  )
}

// ====== Tab 3: Channels ======

function ChannelsTab({ agentTypeId, token, channelTypeOptions, getChannelTypeLabel, getChannelTypeIcon, defaultConfigFields, onSuccess }: {
  agentTypeId: string; token: string;
  channelTypeOptions: { value: string; label: string; Icon: React.ElementType; iconColor: string; defaultName: string }[];
  getChannelTypeLabel: (type: string) => string;
  getChannelTypeIcon: (type: string) => React.ReactNode;
  defaultConfigFields: { name: string; label: string; type: string; required: boolean; placeholder: string }[];
  onError?: (e: string) => void; onSuccess: (m: string) => void
}) {
  const { t } = useTranslation('admin')
  const [templates, setTemplates] = useState<ChannelTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [showAddModal, setShowAddModal] = useState(false)
  const [editingTemplate, setEditingTemplate] = useState<ChannelTemplate | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [newTemplate, setNewTemplate] = useState({ channelType: 'feishu', name: t('agentTypeDetail.channelDefaultName.feishu'), description: '', configFields: JSON.stringify(defaultConfigFields, null, 2) })
  // Config editor state
  const [editingConfigType, setEditingConfigType] = useState<string | null>(null)
  const [configText, setConfigText] = useState('')
  const [configFormat, setConfigFormat] = useState<'json' | 'yaml'>('json')
  const [configError, setConfigError] = useState('')
  const [configLoading, setConfigLoading] = useState(false)
  const [configSaving, setConfigSaving] = useState(false)

  const fetchTemplates = useCallback(async () => {
    try {
      const res = await fetch(`${apiUrl}/api/channel-templates?agentTypeId=${agentTypeId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      })
      const data = await res.json()
      if (data.success) setTemplates(data.templates || [])
    } catch (err) { console.error(err) }
    finally { setLoading(false) }
  }, [agentTypeId, token])

  useEffect(() => { fetchTemplates() }, [fetchTemplates])

  const handleToggle = async (id: string) => {
    try {
      const res = await fetch(`${apiUrl}/api/channel-templates/${id}/toggle`, { method: 'PATCH', headers: { 'Authorization': `Bearer ${token}` } })
      const data = await res.json()
      if (data.success) setTemplates(prev => prev.map(item => item.id === id ? data.template : item))
    } catch (err) { console.error(err) }
  }

  const handleAdd = async () => {
    if (!newTemplate.name || !newTemplate.channelType) { toast.error(t('agentTypeDetail.channels.validation.required')); return }
    let configFields
    try { configFields = JSON.parse(newTemplate.configFields) } catch { toast.error(t('agentTypeDetail.channels.validation.configFields')); return }
    setSubmitting(true)
    try {
      const res = await fetch(`${apiUrl}/api/channel-templates`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelType: newTemplate.channelType, name: newTemplate.name, description: newTemplate.description, configFields, agentTypeId })
      })
      const data = await res.json()
      if (data.success) {
        setTemplates([data.template, ...templates])
        setShowAddModal(false)
        onSuccess(t('agentTypeDetail.channels.channelAdded'))
      } else { toast.error(data.error || t('agentTypeDetail.channels.addFailed')) }
    } catch { toast.error(t('agentTypeDetail.channels.addFailed')) }
    finally { setSubmitting(false) }
  }

  const handleSaveEdit = async () => {
    if (!editingTemplate) return
    setSubmitting(true)
    try {
      const res = await fetch(`${apiUrl}/api/channel-templates/${editingTemplate.id}`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editingTemplate.name, description: editingTemplate.description })
      })
      const data = await res.json()
      if (data.success) { setTemplates(prev => prev.map(item => item.id === editingTemplate.id ? data.template : item)); setEditingTemplate(null) }
      else { toast.error(data.error || t('agentTypeDetail.channels.saveFailed')) }
    } catch { toast.error(t('agentTypeDetail.channels.saveFailed')) }
    finally { setSubmitting(false) }
  }

  const openConfigEditor = async (channelType: string) => {
    setEditingConfigType(channelType); setConfigError(''); setConfigText(''); setConfigFormat('json'); setConfigLoading(true)
    try {
      const res = await fetch(`${apiUrl}/api/channel-config-files/${channelType}-channel.json?agentTypeId=${agentTypeId}`, { headers: { 'Authorization': `Bearer ${token}` } })
      const data = await res.json()
      if (data.success) {
        const fmt = data.format === 'yaml' ? 'yaml' : 'json'
        setConfigFormat(fmt)
        setConfigText(data.content || (fmt === 'json' ? '{}' : ''))
      } else {
        setConfigText('{}')
      }
    } catch { setConfigText('{}') }
    finally { setConfigLoading(false) }
  }

  const handleConfigTextChange = (text: string) => {
    setConfigText(text)
    if (configFormat === 'json') {
      try { JSON.parse(text); setConfigError('') } catch (e: any) { setConfigError(e.message) }
    } else {
      setConfigError('')
    }
  }

  const handleSaveConfig = async () => {
    if (!editingConfigType || configError) return
    if (configFormat === 'json') {
      try { JSON.parse(configText) } catch (e: any) { setConfigError(e.message); return }
    } else if (!configText.trim()) {
      setConfigError(t('agentTypeDetail.channels.yamlEmpty')); return
    }
    setConfigSaving(true)
    try {
      const res = await fetch(`${apiUrl}/api/channel-config-files`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: `${editingConfigType}-channel.json`, content: configText, format: configFormat, agentTypeId })
      })
      const data = await res.json()
      if (data.success) { setEditingConfigType(null); onSuccess(t('agentTypeDetail.channels.channelConfigSaved')) } else { toast.error(data.error || t('agentTypeDetail.channels.saveFailed')) }
    } catch { toast.error(t('agentTypeDetail.channels.saveFailed')) }
    finally { setConfigSaving(false) }
  }

  if (loading) return <div className="flex items-center justify-center h-48"><Loader2 className="w-8 h-8 animate-spin text-primary-600" /></div>

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <p className="text-sm text-gray-500">{t('agentTypeDetail.channels.manageChannels')}</p>
        <button onClick={() => setShowAddModal(true)} className="btn-primary flex items-center space-x-2"><Plus className="w-4 h-4" /><span>{t('agentTypeDetail.channels.addChannel')}</span></button>
      </div>

      {templates.length === 0 ? (
        <div className="card text-center py-12">
          <MessageSquare className="w-16 h-16 text-gray-300 mx-auto mb-4" />
          <p className="text-gray-500">{t('agentTypeDetail.channels.noChannelTemplates')}</p>
          <button onClick={() => setShowAddModal(true)} className="btn-primary mt-4">{t('agentTypeDetail.channels.addFirstChannel')}</button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {templates.map(ch => (
            <div key={ch.id} className="card hover:shadow-lg transition-shadow">
              <div className="flex items-start justify-between mb-4">
                <div className="flex items-center space-x-3">
                  <div className="p-3 rounded-lg bg-purple-100">{getChannelTypeIcon(ch.channel_type)}</div>
                  <div>
                    <h3 className="font-semibold text-gray-900">{ch.name}</h3>
                    <p className="text-sm text-gray-500">{getChannelTypeLabel(ch.channel_type)}</p>
                  </div>
                </div>
                <button onClick={() => handleToggle(ch.id)} className="text-gray-400 hover:text-gray-600">
                  {ch.is_enabled ? <ToggleRight className="w-6 h-6 text-green-600" /> : <ToggleLeft className="w-6 h-6" />}
                </button>
              </div>
              <div className="space-y-1 mb-4 text-sm">
                <div className="flex justify-between"><span className="text-gray-500">{t('agentTypeDetail.channels.status')}</span><span className={`status-badge ${ch.is_enabled ? 'status-active' : 'status-inactive'}`}>{ch.is_enabled ? t('agentTypeDetail.channels.enabled') : t('agentTypeDetail.channels.disabled')}</span></div>
                <div className="text-gray-500">{t('agentTypeDetail.channels.configFieldsCount', { count: ch.config_fields?.length || 0 })}</div>
                {ch.description && <div className="text-gray-600 mt-1">{ch.description}</div>}
              </div>
              <div className="flex items-center space-x-2 pt-4 border-t border-gray-100">
                <button onClick={() => setEditingTemplate({ ...ch })} className="flex-1 btn-secondary flex items-center justify-center space-x-1 py-2"><Edit2 className="w-4 h-4" /><span>{t('common:buttons.edit')}</span></button>
                <button onClick={() => openConfigEditor(ch.channel_type)} className="flex-1 btn-secondary flex items-center justify-center space-x-1 py-2 text-blue-600 border-blue-200 hover:bg-blue-50"><FileJson className="w-4 h-4" /><span>{t('agentTypeDetail.channels.channelConfig')}</span></button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-lg">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">{t('agentTypeDetail.channels.addChannelTemplate')}</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('agentTypeDetail.channels.channelType')} *</label>
                <select value={newTemplate.channelType} onChange={(e) => {
                  const ct = e.target.value
                  setNewTemplate({ ...newTemplate, channelType: ct, name: channelTypeOptions.find(o => o.value === ct)?.defaultName || ct })
                }} className="input-field">
                  {channelTypeOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('agentTypeDetail.channels.displayName')} *</label>
                <input type="text" value={newTemplate.name} onChange={(e) => setNewTemplate({ ...newTemplate, name: e.target.value })} className="input-field" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('agentTypeDetail.channels.description')}</label>
                <input type="text" value={newTemplate.description} onChange={(e) => setNewTemplate({ ...newTemplate, description: e.target.value })} className="input-field" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('agentTypeDetail.channels.configFieldsJson')}</label>
                <textarea value={newTemplate.configFields} onChange={(e) => setNewTemplate({ ...newTemplate, configFields: e.target.value })} className="input-field font-mono text-sm" rows={6} />
              </div>
            </div>
            <div className="flex justify-end space-x-3 mt-6">
              <button onClick={() => setShowAddModal(false)} className="btn-secondary" disabled={submitting}>{t('common:buttons.cancel')}</button>
              <button onClick={handleAdd} className="btn-primary flex items-center space-x-2" disabled={submitting}>
                {submitting && <Loader2 className="w-4 h-4 animate-spin" />}<span>{t('agentTypeDetail.channels.add')}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {editingTemplate && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-md">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">{t('agentTypeDetail.channels.editChannelTemplate')}</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('agentTypeDetail.channels.displayName')}</label>
                <input type="text" value={editingTemplate.name} onChange={(e) => setEditingTemplate({ ...editingTemplate, name: e.target.value })} className="input-field" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('agentTypeDetail.channels.description')}</label>
                <input type="text" value={editingTemplate.description || ''} onChange={(e) => setEditingTemplate({ ...editingTemplate, description: e.target.value })} className="input-field" />
              </div>
            </div>
            <div className="flex justify-end space-x-3 mt-6">
              <button onClick={() => setEditingTemplate(null)} className="btn-secondary" disabled={submitting}>{t('common:buttons.cancel')}</button>
              <button onClick={handleSaveEdit} className="btn-primary flex items-center space-x-2" disabled={submitting}>
                {submitting && <Loader2 className="w-4 h-4 animate-spin" />}<span>{t('common:buttons.save')}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Config Editor Modal (JSON / YAML) */}
      {editingConfigType && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-2xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center space-x-2">
                <FileJson className="w-5 h-5 text-blue-600" />
                <h2 className="text-xl font-semibold text-gray-900">{t('agentTypeDetail.channels.channelConfigTitle', { type: getChannelTypeLabel(editingConfigType) })}</h2>
              </div>
              <div className="flex items-center space-x-3">
                <span className={`px-3 py-1 rounded text-xs font-medium ${configFormat === 'yaml' ? 'bg-amber-100 text-amber-800' : 'bg-gray-100 text-gray-900'}`}>{configFormat === 'yaml' ? 'YAML' : 'JSON'}</span>
                <button onClick={() => setEditingConfigType(null)} className="text-gray-400 hover:text-gray-600"><X className="w-5 h-5" /></button>
              </div>
            </div>
            <div className="mb-3 p-3 bg-blue-50 rounded-lg text-sm text-blue-700">
              <p className="font-medium mb-1">{t('agentTypeDetail.channels.variableHint')}</p>
              <p className="font-mono text-xs">{'${CHANNEL_CLIENT_ID}'} {'${CHANNEL_CLIENT_SECRET}'} {'${GATEWAY_TOKEN}'} {'${DASHSCOPE_API_KEY}'}</p>
            </div>
            {configLoading ? (
              <div className="flex items-center justify-center h-48"><Loader2 className="w-6 h-6 animate-spin text-primary-600" /></div>
            ) : (
              <div className="flex-1 flex flex-col min-h-0">
                <textarea value={configText} onChange={(e) => handleConfigTextChange(e.target.value)}
                  placeholder={configFormat === 'yaml' ? 'feishu:\n  app_id: ${CHANNEL_CLIENT_ID}' : '{"feishu": {}}'}
                  className={`flex-1 input-field font-mono text-sm resize-none min-h-[300px] ${configError ? 'border-red-400 focus:ring-red-300' : ''}`} spellCheck={false} />
                {configError && <p className="text-xs text-red-500 mt-1">{configError}</p>}
              </div>
            )}
            <div className="flex justify-end space-x-3 mt-4">
              <button onClick={() => setEditingConfigType(null)} className="btn-secondary" disabled={configSaving}>{t('common:buttons.cancel')}</button>
              <button onClick={handleSaveConfig} className="btn-primary flex items-center space-x-2" disabled={configSaving || !!configError || configLoading}>
                {configSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}<span>{t('agentTypeDetail.channels.saveToDatabase')}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ====== Tab 5: Backup & Upgrade Config ======

const commandToText = (command?: string[]) => {
  if (!command || command.length === 0) return ''
  if (command[0] === '/bin/bash' && command[1] === '-c') return command.slice(2).join(' ')
  return JSON.stringify(command, null, 2)
}

const textToCommand = (text: string) => ['/bin/bash', '-c', text]

type Translate = (key: string, options?: Record<string, unknown>) => string

const formatSelector = (selector: UpgradeContext['DefaultSelector'] | undefined, loadingText: string) => {
  if (!selector) return loadingText
  const lines = Object.entries(selector.matchLabels || {}).map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
  for (const expression of selector.matchExpressions || []) {
    const values = expression.values?.length ? ` [${expression.values.map(value => JSON.stringify(value)).join(', ')}]` : ''
    lines.push(`${expression.key}: ${expression.operator}${values}`)
  }
  return lines.length > 0 ? lines.join('\n') : '{}'
}

const formatImageForDisplay = (image?: string | null) => {
  if (!image) return '-'
  const leaf = image.split('/').pop() || image
  return leaf.length > 56 ? `${leaf.slice(0, 53)}...` : leaf
}

const INITIAL_SELECTOR_TEXT = '{\n  "matchLabels": {}\n}'
const ACS_SANDBOX_UPDATE_DOC_URL = 'https://help.aliyun.com/zh/cs/user-guide/upgrade-pre-warmed-pools-and-claimed-sandboxes'
const UPGRADE_AUTO_REFRESH_INTERVAL_MS = 5000

const mergeUpgradeItems = (incoming: UpgradeItem[], current: UpgradeItem[]) => {
  const incomingIds = new Set(incoming.map(item => item.UpgradeId))
  const pendingItems = current.filter(item => item.Optimistic && !incomingIds.has(item.UpgradeId))
  return [...pendingItems, ...incoming]
}

const buildPendingUpgradeItem = ({
  upgradeId,
  maxUnavailable,
  replicas = 0,
  selector
}: {
  upgradeId: string
  maxUnavailable: number | string
  replicas?: number
  selector?: UpgradeItem['Selector']
}): UpgradeItem => ({
  UpgradeId: upgradeId,
  Phase: 'Pending',
  RawPhase: 'Pending',
  Retryable: false,
  Optimistic: true,
  Progress: {
    Replicas: replicas,
    UpdatedReplicas: 0,
    UpdatingReplicas: 0,
    FailedReplicas: 0
  },
  MaxUnavailable: maxUnavailable,
  CreatedAt: new Date().toISOString(),
  Selector: selector,
  Conditions: [],
  FailedSandboxes: [],
  Sandboxes: []
})

const buildRecommendedSelector = (
  agentType: SandboxUpgradeAgentType,
  upgradeContext?: UpgradeContext | null,
  sandboxes: SandboxItem[] = []
) => {
  const baseLabels = upgradeContext?.DefaultSelector?.matchLabels || {}
  const firstSandboxLabels = sandboxes.find(item => item.Labels)?.Labels || {}
  const matchLabels: Record<string, string> = {}
  const app = baseLabels.app || firstSandboxLabels.app || agentType.sandbox_template_id || agentType.code

  if (app) matchLabels.app = app

  return { matchLabels }
}

const formatMaxUnavailable = (value: number | string | undefined, t: Translate) => {
  if (value === undefined || value === null || value === '') return '-'
  const text = String(value)
  if (text.endsWith('%')) return t('agentTypeDetail.backupUpgrade.format.maxUnavailablePercent', { value: text })
  return t('agentTypeDetail.backupUpgrade.format.maxUnavailableCount', { value: text })
}

const getBackupRestoreCapabilityWarning = (capability: BackupRestoreCapability | null | undefined, t: Translate) => {
  if (!capability || capability.Supported !== false) return ''
  const separator = t('agentTypeDetail.backupUpgrade.format.listSeparator')
  const missing = capability.MissingRuntimes?.length
    ? capability.MissingRuntimes.map(name => `name: ${name}`).join(separator)
    : ['name: agent-runtime', 'name: csi'].join(separator)
  return t('agentTypeDetail.backupUpgrade.backupWarning', { missing })
}

const formatSandboxUpgradeError = (message: string, t: Translate) => {
  if (/SandboxSet .+ not found in namespaces/i.test(message) || /sandboxsets\..+ not found/i.test(message)) {
    return t('agentTypeDetail.sandboxUpgrade.errors.sandboxSetNotFound')
  }
  return message
}

function BackupUpgradeConfigTab({ agentType, token, onUpdate, onError }: {
  agentType: AgentType; token: string;
  onUpdate: (at: AgentType) => void; onError: (e: string) => void
}) {
  const { t } = useTranslation('admin')
  const metadata = agentType.upgrade_metadata || {}
  const [timeoutSeconds, setTimeoutSeconds] = useState(metadata.timeoutSeconds || 60)
  const [preCommand, setPreCommand] = useState(commandToText(metadata.preUpgrade?.command) || getDefaultUpgradeCommandText(agentType, 'pre'))
  const [postCommand, setPostCommand] = useState(commandToText(metadata.postUpgrade?.command) || getDefaultUpgradeCommandText(agentType, 'post'))
  const [saving, setSaving] = useState(false)
  const [upgradeContext, setUpgradeContext] = useState<UpgradeContext | null>(null)
  const backupRestoreWarning = getBackupRestoreCapabilityWarning(upgradeContext?.BackupRestoreCapability, t)

  useEffect(() => {
    let cancelled = false
    const loadUpgradeContext = async () => {
      try {
        const res = await fetch(`${apiUrl}/api/agent-types/${agentType.id}/sandboxes`, {
          headers: { 'Authorization': `Bearer ${token}` }
        })
        const data = await res.json()
        if (!data.success) throw new Error(data.error || t('agentTypeDetail.backupUpgrade.loadContextFailed'))
        if (!cancelled) {
          setUpgradeContext({
            Namespace: data.Namespace,
            SandboxSetName: data.SandboxSetName,
            DefaultSelector: data.DefaultSelector,
            TargetImage: data.TargetImage,
            TargetImages: data.TargetImages || [],
            BackupRestoreCapability: data.BackupRestoreCapability
          })
        }
      } catch (err: any) {
        if (!cancelled) onError(formatSandboxUpgradeError(err.message, t))
      }
    }
    loadUpgradeContext()
    return () => { cancelled = true }
  }, [agentType, token, onError, t])

  const handleSave = async () => {
    onError('')
    if (!preCommand.trim() || !postCommand.trim()) {
      onError(t('agentTypeDetail.backupUpgrade.validation.commandsRequired'))
      return
    }
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0) {
      onError(t('agentTypeDetail.backupUpgrade.validation.timeoutPositive'))
      return
    }

    setSaving(true)
    try {
      const res = await fetch(`${apiUrl}/api/agent-types/${agentType.id}`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          upgrade_metadata: {
            timeoutSeconds,
            preUpgrade: { command: textToCommand(preCommand) },
            postUpgrade: { command: textToCommand(postCommand) }
          }
        })
      })
      const data = await res.json()
      if (!data.success) throw new Error(data.error || t('agentTypeDetail.saveFailed'))
      onUpdate(data.agentType)
    } catch (err: any) {
      onError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="card">
        <div className="flex items-start space-x-4 mb-6">
          <div className="p-3 rounded-lg bg-blue-50 flex-shrink-0"><Terminal className="w-6 h-6 text-primary-600" /></div>
          <div>
            <h2 className="text-lg font-semibold text-gray-900">{t('agentTypeDetail.backupUpgrade.title')}</h2>
            <p className="text-sm text-gray-500 mt-1">{t('agentTypeDetail.backupUpgrade.subtitle')}</p>
          </div>
        </div>

        {backupRestoreWarning && (
          <div className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4 text-red-900">
            <div className="flex items-start space-x-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0" />
              <div>
                <p className="text-sm font-semibold">{t('agentTypeDetail.backupUpgrade.backupUnsupportedTitle')}</p>
                <p className="mt-1 text-sm leading-6">{backupRestoreWarning}</p>
              </div>
            </div>
          </div>
        )}

        <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-amber-900">
          <div className="flex items-start space-x-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0" />
            <div>
              <p className="text-sm font-semibold">{t('agentTypeDetail.backupUpgrade.riskTitle')}</p>
              <p className="mt-1 text-sm leading-6">
                {t('agentTypeDetail.backupUpgrade.riskText')}
              </p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">{t('agentTypeDetail.backupUpgrade.namespace')}</label>
            <input value={upgradeContext?.Namespace || t('common:loading.default')} disabled className="input-field bg-gray-50 text-gray-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">{t('agentTypeDetail.backupUpgrade.sandboxSet')}</label>
            <input value={upgradeContext?.SandboxSetName || agentType.sandbox_template_id || t('common:loading.default')} disabled className="input-field bg-gray-50 text-gray-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">{t('agentTypeDetail.backupUpgrade.timeoutSeconds')}</label>
            <input type="number" min={1} value={timeoutSeconds} onChange={(e) => setTimeoutSeconds(parseInt(e.target.value) || 60)} className="input-field" />
          </div>
        </div>

        <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 mb-6">
          <p className="text-sm font-medium text-gray-700 mb-2">{t('agentTypeDetail.backupUpgrade.baseSelector')}</p>
          <pre className="text-xs text-gray-600 font-mono whitespace-pre-wrap">{formatSelector(upgradeContext?.DefaultSelector, t('common:loading.default'))}</pre>
          <div className="mt-4 border-t border-gray-200 pt-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">{t('agentTypeDetail.backupUpgrade.targetImage')}</p>
            <p className="mt-1 break-all font-mono text-xs leading-5 text-gray-700" title={upgradeContext?.TargetImage || ''}>
              {upgradeContext?.TargetImage || '-'}
            </p>
          </div>
        </div>

        <div className="mb-5 rounded-lg border border-blue-100 bg-blue-50 p-4 text-sm leading-6 text-blue-900">
          {t('agentTypeDetail.backupUpgrade.commandHint')}
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
          <div className="border border-gray-200 rounded-lg overflow-hidden">
            <div className="bg-gray-900 text-white px-4 py-3 flex items-center justify-between">
              <div>
                <h3 className="font-semibold">{t('agentTypeDetail.backupUpgrade.preCommand')}</h3>
                <p className="text-xs text-gray-400">{t('agentTypeDetail.backupUpgrade.preCommandDesc')}</p>
              </div>
              <span className="text-xs bg-blue-500/20 text-blue-100 px-2 py-1 rounded">{t('agentTypeDetail.backupUpgrade.required')}</span>
            </div>
            <textarea value={preCommand} onChange={(e) => setPreCommand(e.target.value)} className="w-full h-64 p-4 font-mono text-sm bg-slate-950 text-slate-100 resize-none focus:outline-none" spellCheck={false} placeholder={'set -e\nBACKUP_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"\ntar -czf "/backup/openclaw-state-$BACKUP_ID.tgz" -C "$HOME" .openclaw'} />
          </div>
          <div className="border border-gray-200 rounded-lg overflow-hidden">
            <div className="bg-gray-900 text-white px-4 py-3 flex items-center justify-between">
              <div>
                <h3 className="font-semibold">{t('agentTypeDetail.backupUpgrade.postCommand')}</h3>
                <p className="text-xs text-gray-400">{t('agentTypeDetail.backupUpgrade.postCommandDesc')}</p>
              </div>
              <span className="text-xs bg-blue-500/20 text-blue-100 px-2 py-1 rounded">{t('agentTypeDetail.backupUpgrade.required')}</span>
            </div>
            <textarea value={postCommand} onChange={(e) => setPostCommand(e.target.value)} className="w-full h-64 p-4 font-mono text-sm bg-slate-950 text-slate-100 resize-none focus:outline-none" spellCheck={false} placeholder={'set -e\nARCHIVE="$(ls -1t /backup/openclaw-state-*.tgz | head -n 1)"\ntar -xzf "$ARCHIVE" -C "$HOME"'} />
          </div>
        </div>

        <div className="mt-6 flex justify-end">
          <button onClick={handleSave} disabled={saving} className="btn-primary flex items-center space-x-2 disabled:opacity-50">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            <span>{saving ? t('agentTypeDetail.saving') : t('agentTypeDetail.backupUpgrade.saveConfig')}</span>
          </button>
        </div>
      </div>
    </div>
  )
}

// ====== Tab 6: Sandbox Upgrade ======

export function SandboxUpgradeTab({ agentType, token, initialSelectedSandboxName, onSuccess, onError }: {
  agentType: SandboxUpgradeAgentType; token: string;
  initialSelectedSandboxName?: string;
  onError: (e: string) => void; onSuccess: (m: string) => void
}) {
  const { t } = useTranslation('admin')
  const tokenRef = useRef(token)
  const [sandboxes, setSandboxes] = useState<SandboxItem[]>([])
  const [upgrades, setUpgrades] = useState<UpgradeItem[]>([])
  const [upgradeContext, setUpgradeContext] = useState<UpgradeContext | null>(null)
  const [activeUpgradeTab, setActiveUpgradeTab] = useState<'create' | 'history'>('create')
  const [createStep, setCreateStep] = useState<'target' | 'confirm'>('target')
  const [selectedNames, setSelectedNames] = useState<string[]>([])
  const [targetMode, setTargetMode] = useState<'SelectedSandboxes' | 'LabelSelector'>('LabelSelector')
  const [selectorText, setSelectorText] = useState(INITIAL_SELECTOR_TEXT)
  const [maxUnavailable, setMaxUnavailable] = useState('1')
  const [loading, setLoading] = useState(false)
  const [creatingMode, setCreatingMode] = useState<UpgradeLifecycleMode | null>(null)
  const [failureDetailUpgrade, setFailureDetailUpgrade] = useState<UpgradeItem | null>(null)
  const [resourceUpgrade, setResourceUpgrade] = useState<UpgradeItem | null>(null)
  const [resourceText, setResourceText] = useState('')
  const [resourceLoading, setResourceLoading] = useState(false)
  const [resourceSaving, setResourceSaving] = useState(false)
  const [deletingUpgradeId, setDeletingUpgradeId] = useState<string | null>(null)
  const [retryingUpgradeId, setRetryingUpgradeId] = useState<string | null>(null)
  const [resourceError, setResourceError] = useState('')
  const [sandboxSearch, setSandboxSearch] = useState('')
  const [sandboxPage, setSandboxPage] = useState(1)
  const autoRefreshInFlightRef = useRef(false)
  const selectedTargetMissing = targetMode === 'SelectedSandboxes' && selectedNames.length === 0
  const maxUnavailableValue = maxUnavailable.trim()
  const maxUnavailableInvalid = !!maxUnavailableValue && !/^([1-9]\d*|([1-9]\d?|100)%)$/.test(maxUnavailableValue)
  const blockingUpgrade = upgrades.find(item => item.Phase !== 'Completed') || null
  const hasActiveUpgrade = upgrades.some(item => item.Phase !== 'Completed' && item.Phase !== 'Failed')
  const backupRestoreWarning = getBackupRestoreCapabilityWarning(upgradeContext?.BackupRestoreCapability, t)
  const creating = creatingMode !== null
  const createDisabled = loading || creating || Boolean(blockingUpgrade) || Boolean(backupRestoreWarning) || selectedTargetMissing || !maxUnavailableValue || maxUnavailableInvalid
  const sandboxPageSize = 20

  useEffect(() => {
    tokenRef.current = token
  }, [token])

  const loadData = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    const currentToken = tokenRef.current
    if (!currentToken) return

    if (!silent) {
      setLoading(true)
      onError('')
    }
    try {
      const [sandboxRes, upgradeRes] = await Promise.all([
        fetch(`${apiUrl}/api/agent-types/${agentType.id}/sandboxes`, { headers: { 'Authorization': `Bearer ${currentToken}` } }),
        fetch(`${apiUrl}/api/sandbox-upgrades?agentTypeId=${agentType.id}`, { headers: { 'Authorization': `Bearer ${currentToken}` } })
      ])
      const sandboxData = await sandboxRes.json()
      const upgradeData = await upgradeRes.json()
      if (!sandboxData.success) throw new Error(sandboxData.error || t('agentTypeDetail.sandboxUpgrade.errors.loadSandboxesFailed'))
      if (!upgradeData.success) throw new Error(upgradeData.error || t('agentTypeDetail.sandboxUpgrade.errors.loadHistoryFailed'))
      setUpgradeContext({
        Namespace: sandboxData.Namespace,
        SandboxSetName: sandboxData.SandboxSetName,
        DefaultSelector: sandboxData.DefaultSelector,
        TargetImage: sandboxData.TargetImage,
        TargetImages: sandboxData.TargetImages || [],
        BackupRestoreCapability: sandboxData.BackupRestoreCapability
      })
      setSandboxes(sandboxData.Items || [])
      setSelectorText(prev => prev === INITIAL_SELECTOR_TEXT
        ? JSON.stringify(buildRecommendedSelector(agentType, {
          Namespace: sandboxData.Namespace,
          SandboxSetName: sandboxData.SandboxSetName,
          DefaultSelector: sandboxData.DefaultSelector,
          TargetImage: sandboxData.TargetImage,
          TargetImages: sandboxData.TargetImages || [],
          BackupRestoreCapability: sandboxData.BackupRestoreCapability
        }, sandboxData.Items || []), null, 2)
        : prev)
      setUpgrades(prev => mergeUpgradeItems(upgradeData.Items || [], prev))
    } catch (err: any) {
      if (!silent) onError(formatSandboxUpgradeError(err.message, t))
    } finally {
      if (!silent) setLoading(false)
    }
  }, [agentType, onError, t])

  useEffect(() => { loadData() }, [loadData])

  useEffect(() => {
    if (!hasActiveUpgrade) return
    const timer = window.setInterval(async () => {
      if (autoRefreshInFlightRef.current) return
      autoRefreshInFlightRef.current = true
      try {
        await loadData({ silent: true })
      } finally {
        autoRefreshInFlightRef.current = false
      }
    }, UPGRADE_AUTO_REFRESH_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [hasActiveUpgrade, loadData])

  useEffect(() => {
    if (!initialSelectedSandboxName || sandboxes.length === 0) return
    const matched = sandboxes.find(item => item.Name === initialSelectedSandboxName && item.BackupReady)
    if (!matched) return
    setTargetMode('SelectedSandboxes')
    setSelectedNames(prev => prev.includes(matched.Name) ? prev : [matched.Name])
  }, [initialSelectedSandboxName, sandboxes])

  useEffect(() => {
    setSandboxPage(1)
  }, [sandboxSearch, targetMode, sandboxes.length])

  const toggleSandbox = (name: string) => {
    setSelectedNames(prev => prev.includes(name) ? prev.filter(item => item !== name) : [...prev, name])
  }

  const handleCreate = async (lifecycleMode: UpgradeLifecycleMode = 'Full') => {
    onError('')
    let target: any
    if (targetMode === 'SelectedSandboxes') {
      if (selectedNames.length === 0) {
        onError(t('agentTypeDetail.sandboxUpgrade.errors.selectAtLeastOne'))
        return
      }
      target = { type: 'SelectedSandboxes', sandboxNames: selectedNames }
    } else {
      try {
        target = { type: 'LabelSelector', selector: JSON.parse(selectorText) }
      } catch {
        onError(t('agentTypeDetail.sandboxUpgrade.errors.labelSelectorJson'))
        return
      }
    }

    setCreatingMode(lifecycleMode)
    try {
      const maxUnavailablePayload = maxUnavailableValue.includes('%') ? maxUnavailableValue : parseInt(maxUnavailableValue, 10)
      const res = await fetch(`${apiUrl}/api/agent-types/${agentType.id}/sandbox-upgrades`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientToken: createClientToken(),
          maxUnavailable: maxUnavailablePayload,
          target,
          lifecycleMode
        })
      })
      const data = await res.json()
      if (!data.success) throw new Error(data.error || t('agentTypeDetail.sandboxUpgrade.errors.createFailed'))
      onSuccess(lifecycleMode === 'PostOnly'
        ? t('agentTypeDetail.sandboxUpgrade.success.postOnlyCreated', { upgradeId: data.UpgradeId })
        : t('agentTypeDetail.sandboxUpgrade.success.created', { upgradeId: data.UpgradeId }))
      const pendingItem = buildPendingUpgradeItem({
        upgradeId: data.UpgradeId,
        maxUnavailable: maxUnavailablePayload,
        replicas: target.type === 'SelectedSandboxes' ? target.sandboxNames.length : 0,
        selector: target.type === 'LabelSelector' ? target.selector : undefined
      })
      setUpgrades(prev => [pendingItem, ...prev.filter(item => item.UpgradeId !== data.UpgradeId)])
      setSelectedNames([])
      setCreateStep('target')
      setActiveUpgradeTab('history')
      await loadData({ silent: true })
    } catch (err: any) {
      onError(formatSandboxUpgradeError(err.message, t))
    } finally {
      setCreatingMode(null)
    }
  }

  const getPhaseMeta = (phase: string) => {
    if (phase === 'Completed') return { label: t('agentTypeDetail.sandboxUpgrade.phase.completed'), className: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100' }
    if (phase === 'Updating') return { label: t('agentTypeDetail.sandboxUpgrade.phase.updating'), className: 'bg-blue-50 text-blue-700 ring-1 ring-blue-100' }
    if (phase === 'Failed') return { label: t('agentTypeDetail.sandboxUpgrade.phase.failed'), className: 'bg-red-50 text-red-700 ring-1 ring-red-100' }
    return { label: phase || t('agentTypeDetail.sandboxUpgrade.phase.pending'), className: 'bg-gray-100 text-gray-600 ring-1 ring-gray-200' }
  }

  const selectedSandboxes = sandboxes.filter(item => selectedNames.includes(item.Name))
  const selectedNoopSandboxes = selectedSandboxes.filter(item => item.ImageMatchesTarget)
  const targetImage = upgradeContext?.TargetImage || sandboxes.find(item => item.TargetImage)?.TargetImage || null
  const recommendedSelector = useMemo(() => buildRecommendedSelector(agentType, upgradeContext, sandboxes), [agentType, upgradeContext, sandboxes])
  const commonLabels = Object.entries(recommendedSelector.matchLabels).map(([key, value]) => ({ key, value }))
  const filteredSandboxes = useMemo(() => {
    const keyword = sandboxSearch.trim().toLowerCase()
    if (!keyword) return sandboxes
    return sandboxes.filter(item => {
      const labelText = Object.entries(item.Labels || {})
        .map(([key, value]) => `${key}=${value}`)
        .join(' ')
      return [
        item.Name,
        item.Namespace,
        item.Phase,
        item.PodIP,
        item.CurrentImage,
        item.TargetImage,
        labelText
      ].some(value => String(value || '').toLowerCase().includes(keyword))
    })
  }, [sandboxes, sandboxSearch])
  const sandboxTotalPages = Math.max(1, Math.ceil(filteredSandboxes.length / sandboxPageSize))
  const safeSandboxPage = Math.min(sandboxPage, sandboxTotalPages)
  const pagedSandboxes = filteredSandboxes.slice((safeSandboxPage - 1) * sandboxPageSize, safeSandboxPage * sandboxPageSize)
  const sandboxPageStart = filteredSandboxes.length === 0 ? 0 : (safeSandboxPage - 1) * sandboxPageSize + 1
  const sandboxPageEnd = Math.min(safeSandboxPage * sandboxPageSize, filteredSandboxes.length)
  const selectableSandboxCount = filteredSandboxes.filter(item => item.BackupReady).length

  useEffect(() => {
    if (sandboxPage > sandboxTotalPages) setSandboxPage(sandboxTotalPages)
  }, [sandboxPage, sandboxTotalPages])

  const getProgressPercent = (item: UpgradeItem) => {
    const total = Math.max(item.Progress.Replicas || 0, 1)
    const finished = Math.min(total, (item.Progress.UpdatedReplicas || 0) + (item.Progress.FailedReplicas || 0))
    return Math.round((finished / total) * 100)
  }

  const getWaitingReplicas = (item: UpgradeItem) => {
    const total = item.Progress.Replicas || 0
    const consumed = (item.Progress.UpdatedReplicas || 0) + (item.Progress.UpdatingReplicas || 0) + (item.Progress.FailedReplicas || 0)
    return Math.max(total - consumed, 0)
  }

  const getLatestCondition = (item: UpgradeItem) => {
    const conditions = item.Conditions || []
    return conditions.length > 0 ? conditions[conditions.length - 1] : null
  }

  const getPrimaryFailure = (item: UpgradeItem) => {
    const failed = item.FailedSandboxes || []
    if (failed.length > 0) return failed[0]
    const condition = getLatestCondition(item)
    if (!condition) return null
    return {
      SandboxName: '',
      PodName: '',
      PodIP: null,
      NodeName: null,
      Phase: item.Phase,
      ConditionType: condition.type || condition.Type || null,
      ConditionStatus: condition.status || condition.Status || null,
      Reason: condition.reason || condition.Reason || null,
      Message: condition.message || condition.Message || '',
      LastTransitionTime: condition.lastTransitionTime || condition.LastTransitionTime || null
    }
  }

  const hasUpgradeFailures = (item: UpgradeItem) => (
    item.Phase === 'Failed'
      || (item.Progress.FailedReplicas || 0) > 0
      || (item.FailedSandboxes || []).length > 0
  )

  const getFailureExplanation = (item: UpgradeItem) => {
    const failed = getPrimaryFailure(item)
    const reason = failed?.Reason || ''
    const message = failed?.Message || ''

    if (reason === 'PreUpgradeFailed') {
      return t('agentTypeDetail.sandboxUpgrade.failure.preUpgradeFailed')
    }
    if (reason === 'PostUpgradeFailed') {
      return t('agentTypeDetail.sandboxUpgrade.failure.postUpgradeFailed')
    }
    if (reason === 'UpgradePodFailed' || message.includes('ImagePullBackOff') || message.includes('ErrImagePull')) {
      return t('agentTypeDetail.sandboxUpgrade.failure.upgradePodFailed')
    }
    if (message.includes('hook execution error')) {
      return t('agentTypeDetail.sandboxUpgrade.failure.hookExecutionError')
    }
    return reason || message
      ? t('agentTypeDetail.sandboxUpgrade.failure.generic', { reason: reason || t('agentTypeDetail.sandboxUpgrade.phase.failed'), message, separator: message ? t('agentTypeDetail.sandboxUpgrade.format.colon') : '' })
      : t('agentTypeDetail.sandboxUpgrade.failure.pendingReason')
  }

  const getDetailSandboxes = (item: UpgradeItem | null) => item?.Sandboxes?.length
    ? item.Sandboxes
    : item?.FailedSandboxes || []

  const getConditionClassName = (status?: string | null) => {
    if (status === 'False') return 'text-red-700'
    if (status === 'True') return 'text-emerald-700'
    return 'text-gray-700'
  }

  const getMessageClassName = (status?: string | null) => status === 'False' ? 'text-red-700' : 'text-gray-500'

  const failedUpgradeHint = t('agentTypeDetail.sandboxUpgrade.failedUpgradeHint')

  const getSelectorSummary = (item: UpgradeItem) => {
    const matchLabels = item.Selector?.matchLabels || {}
    const entries = Object.entries(matchLabels)
    if (entries.length === 0) return t('agentTypeDetail.sandboxUpgrade.selector.empty')
    const visible = entries.slice(0, 3).map(([key, value]) => `${key}=${value}`)
    const suffix = entries.length > visible.length
      ? t('agentTypeDetail.sandboxUpgrade.selector.moreLabels', { count: entries.length })
      : ''
    return `${visible.join(t('agentTypeDetail.sandboxUpgrade.format.listSeparator'))}${suffix}`
  }

  const handleUseRecommendedSelector = () => {
    setSelectorText(JSON.stringify(recommendedSelector, null, 2))
  }

  const openResourceEditor = async (item: UpgradeItem) => {
    setResourceUpgrade(item)
    setResourceText('')
    setResourceError('')
    setResourceLoading(true)
    try {
      const res = await fetch(`${apiUrl}/api/agent-types/${agentType.id}/sandbox-upgrades/${encodeURIComponent(item.UpgradeId)}/resource`, {
        headers: { 'Authorization': `Bearer ${token}` }
      })
      const data = await res.json()
      if (!data.success) throw new Error(data.error || t('agentTypeDetail.sandboxUpgrade.errors.loadResourceFailed'))
      setResourceText(JSON.stringify(data.Resource, null, 2))
    } catch (err: any) {
      setResourceError(formatSandboxUpgradeError(err.message, t))
    } finally {
      setResourceLoading(false)
    }
  }

  const rejectActiveResourceMutation = () => {
    if (resourceUpgrade?.Phase !== 'Updating') return false
    setResourceError(t('agentTypeDetail.sandboxUpgrade.errors.activeResourceLocked'))
    return true
  }

  const handleDeleteResource = async () => {
    if (!resourceUpgrade) return
    if (rejectActiveResourceMutation()) return
    if (!window.confirm(t('agentTypeDetail.sandboxUpgrade.confirm.deleteResource', { upgradeId: resourceUpgrade.UpgradeId }))) return
    setResourceSaving(true)
    setResourceError('')
    try {
      const res = await fetch(`${apiUrl}/api/agent-types/${agentType.id}/sandbox-upgrades/${encodeURIComponent(resourceUpgrade.UpgradeId)}/resource`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      })
      const data = await res.json()
      if (!data.success) throw new Error(data.error || t('agentTypeDetail.sandboxUpgrade.errors.deleteResourceFailed'))
      onSuccess(t('agentTypeDetail.sandboxUpgrade.success.deleted', { upgradeId: resourceUpgrade.UpgradeId }))
      setResourceUpgrade(null)
      setResourceText('')
      await loadData()
    } catch (err: any) {
      setResourceError(formatSandboxUpgradeError(err.message, t))
    } finally {
      setResourceSaving(false)
    }
  }

  const handleDeleteUpgrade = async (item: UpgradeItem) => {
    if (item.Phase === 'Updating') {
      onError(t('agentTypeDetail.sandboxUpgrade.errors.activeDeleteLocked'))
      return
    }
    if (!window.confirm(t('agentTypeDetail.sandboxUpgrade.confirm.deleteUpgrade', { upgradeId: item.UpgradeId }))) return
    setDeletingUpgradeId(item.UpgradeId)
    onError('')
    try {
      const res = await fetch(`${apiUrl}/api/agent-types/${agentType.id}/sandbox-upgrades/${encodeURIComponent(item.UpgradeId)}/resource`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      })
      const data = await res.json()
      if (!data.success) throw new Error(data.error || t('agentTypeDetail.sandboxUpgrade.errors.deleteResourceFailed'))
      onSuccess(t('agentTypeDetail.sandboxUpgrade.success.deleted', { upgradeId: item.UpgradeId }))
      setFailureDetailUpgrade(current => current?.UpgradeId === item.UpgradeId ? null : current)
      setResourceUpgrade(current => current?.UpgradeId === item.UpgradeId ? null : current)
      if (resourceUpgrade?.UpgradeId === item.UpgradeId) {
        setResourceText('')
      }
      await loadData()
    } catch (err: any) {
      onError(formatSandboxUpgradeError(err.message, t))
    } finally {
      setDeletingUpgradeId(null)
    }
  }

  const handleRetryUpgrade = async (item: UpgradeItem) => {
    if (item.Phase !== 'Failed') {
      onError(t('agentTypeDetail.sandboxUpgrade.errors.retryOnlyFailed'))
      return
    }
    if (!window.confirm(t('agentTypeDetail.sandboxUpgrade.confirm.retry', { upgradeId: item.UpgradeId }))) return
    setRetryingUpgradeId(item.UpgradeId)
    onError('')
    try {
      const res = await fetch(`${apiUrl}/api/agent-types/${agentType.id}/sandbox-upgrades/${encodeURIComponent(item.UpgradeId)}/retry`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientToken: createClientToken()
        })
      })
      const data = await res.json()
      if (!data.success) throw new Error(data.error || t('agentTypeDetail.sandboxUpgrade.errors.retryFailed'))
      onSuccess(t('agentTypeDetail.sandboxUpgrade.success.retried', { upgradeId: data.UpgradeId }))
      const pendingItem = buildPendingUpgradeItem({
        upgradeId: data.UpgradeId,
        maxUnavailable: item.MaxUnavailable,
        replicas: item.Progress.Replicas,
        selector: item.Selector
      })
      setUpgrades(prev => [
        pendingItem,
        ...prev.filter(existing => existing.UpgradeId !== data.UpgradeId && existing.UpgradeId !== item.UpgradeId)
      ])
      setFailureDetailUpgrade(current => current?.UpgradeId === item.UpgradeId ? null : current)
      setResourceUpgrade(current => current?.UpgradeId === item.UpgradeId ? null : current)
      if (resourceUpgrade?.UpgradeId === item.UpgradeId) {
        setResourceText('')
      }
      setActiveUpgradeTab('history')
      await loadData({ silent: true })
    } catch (err: any) {
      onError(formatSandboxUpgradeError(err.message, t))
    } finally {
      setRetryingUpgradeId(null)
    }
  }

  const resourceUpgradeLocked = resourceUpgrade?.Phase === 'Updating'
  const resourceMutationDisabled = resourceLoading || resourceSaving || resourceUpgradeLocked
  const upgradeSubTabs = [
    { id: 'create' as const, label: t('agentTypeDetail.sandboxUpgrade.tabs.create'), icon: Play },
    { id: 'history' as const, label: t('agentTypeDetail.sandboxUpgrade.tabs.history'), icon: History }
  ]

  return (
    <div className="min-w-0 max-w-full space-y-6">
      <div className="border-b border-gray-200">
        <div className="flex gap-1 overflow-x-auto">
          {upgradeSubTabs.map(tab => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveUpgradeTab(tab.id)}
              className={`flex shrink-0 items-center gap-2 whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
                activeUpgradeTab === tab.id
                  ? 'border-primary-600 text-primary-600'
                  : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700'
              }`}
            >
              <tab.icon className="h-4 w-4 shrink-0" />
              <span>{tab.label}</span>
            </button>
          ))}
        </div>
      </div>

      {activeUpgradeTab === 'create' && (
      <div className="card overflow-hidden">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">{t('agentTypeDetail.sandboxUpgrade.createTitle')}</h2>
            <p className="text-sm text-gray-500 mt-1">{t('agentTypeDetail.sandboxUpgrade.createDescription')}</p>
          </div>
          <div className="flex items-center gap-2">
            <a
              href={ACS_SANDBOX_UPDATE_DOC_URL}
              target="_blank"
              rel="noreferrer"
              className="btn-secondary flex items-center space-x-2"
              title={t('agentTypeDetail.sandboxUpgrade.officialDocTitle')}
            >
              <ExternalLink className="w-4 h-4" />
              <span>{t('agentTypeDetail.sandboxUpgrade.officialDoc')}</span>
            </a>
            <button onClick={loadData} className="btn-secondary flex items-center space-x-2" disabled={loading}>
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              <span>{t('agentTypeDetail.sandboxUpgrade.actions.refresh')}</span>
            </button>
          </div>
        </div>

        {backupRestoreWarning && (
          <div className="mb-5 rounded-lg border border-red-200 bg-red-50 p-4 text-sm leading-6 text-red-900">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0" />
              <div>
                <p className="font-semibold">{t('agentTypeDetail.backupUpgrade.backupUnsupportedTitle')}</p>
                <p className="mt-1">{backupRestoreWarning}</p>
              </div>
            </div>
          </div>
        )}

        <div className="mb-5 rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm text-gray-600">
          <div className="flex items-center gap-2">
            <Info className="h-4 w-4 flex-shrink-0 text-gray-400" />
            <p>{failedUpgradeHint}</p>
          </div>
        </div>

        <div className={`grid min-w-0 grid-cols-1 gap-6 ${targetMode === 'SelectedSandboxes' && createStep === 'target' ? '' : 'lg:grid-cols-[minmax(0,1fr)_320px]'}`}>
          <div className="min-w-0">
            <div className="flex space-x-2 mb-4">
              <button onClick={() => { setTargetMode('LabelSelector'); setCreateStep('confirm') }} className={`px-4 py-2 rounded-lg text-sm font-medium ${targetMode === 'LabelSelector' ? 'bg-primary-600 text-white' : 'bg-gray-100 text-gray-600'}`}>{t('agentTypeDetail.sandboxUpgrade.targetMode.labelSelector')}</button>
              <button onClick={() => { setTargetMode('SelectedSandboxes'); setCreateStep('target') }} className={`px-4 py-2 rounded-lg text-sm font-medium ${targetMode === 'SelectedSandboxes' ? 'bg-primary-600 text-white' : 'bg-gray-100 text-gray-600'}`}>{t('agentTypeDetail.sandboxUpgrade.targetMode.selectedSandboxes')}</button>
            </div>

            {targetMode === 'SelectedSandboxes' && createStep === 'target' ? (
              <div className="max-w-full overflow-hidden rounded-lg border border-gray-200 bg-white">
                <div className="space-y-3 border-b border-gray-200 bg-gray-50 px-4 py-3">
                  <div className="flex min-w-0 flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                    <div className="relative min-w-[260px] flex-1 xl:max-w-xl">
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                      <input
                        value={sandboxSearch}
                        onChange={(event) => setSandboxSearch(event.target.value)}
                        className="w-full rounded-lg border border-gray-300 bg-white py-2 pl-9 pr-3 text-sm outline-none transition-colors focus:border-primary-500 focus:ring-2 focus:ring-primary-100"
                        placeholder={t('agentTypeDetail.sandboxUpgrade.searchPlaceholder')}
                      />
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-2 text-xs text-gray-500">
                      <span className="rounded bg-white px-2.5 py-1.5 ring-1 ring-gray-200">{t('agentTypeDetail.sandboxUpgrade.selectedCount', { count: selectedNames.length })}</span>
                      <span className="rounded bg-white px-2.5 py-1.5 ring-1 ring-gray-200">{t('agentTypeDetail.sandboxUpgrade.selectableCount', { selectable: selectableSandboxCount, total: filteredSandboxes.length })}</span>
                      <button
                        type="button"
                        onClick={() => setCreateStep('confirm')}
                        disabled={selectedNames.length === 0}
                        className="btn-primary inline-flex h-9 items-center justify-center space-x-2 px-3 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <span>{t('agentTypeDetail.sandboxUpgrade.actions.nextConfig')}</span>
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                  <p className="text-xs leading-5 text-gray-500">
                    {t('agentTypeDetail.sandboxUpgrade.listHint')}
                  </p>
                </div>
                <div className="border-b border-gray-200 bg-white px-4 py-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">{t('agentTypeDetail.sandboxUpgrade.selectedSandboxesTitle')}</p>
                    {selectedNames.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setSelectedNames([])}
                        className="text-xs font-medium text-gray-500 hover:text-gray-900"
                      >
                        {t('agentTypeDetail.sandboxUpgrade.actions.clear')}
                      </button>
                    )}
                  </div>
                  {selectedNames.length === 0 ? (
                    <p className="text-xs leading-5 text-gray-500">{t('agentTypeDetail.sandboxUpgrade.selectedEmptyHint')}</p>
                  ) : (
                    <div className="flex max-h-24 flex-wrap gap-2 overflow-y-auto pr-1">
                      {selectedNames.map(name => (
                        <span key={name} className="inline-flex max-w-full items-center gap-1 rounded bg-primary-50 px-2.5 py-1 text-xs font-mono text-primary-700 ring-1 ring-primary-100">
                          <span className="max-w-[280px] truncate" title={name}>{name}</span>
                          <button
                            type="button"
                            onClick={() => toggleSandbox(name)}
                            className="rounded p-0.5 text-primary-500 hover:bg-white hover:text-primary-800"
                            aria-label={t('agentTypeDetail.sandboxUpgrade.actions.removeSandbox', { name })}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="max-h-[520px] max-w-full overflow-auto">
                  <table className="min-w-[860px] w-full text-sm">
                    <thead className="sticky top-0 z-10 bg-gray-50 text-gray-600 shadow-[0_1px_0_0_rgba(229,231,235,1)]">
                      <tr>
                        <th className="w-10 px-4 py-3"></th>
                        <th className="text-left px-4 py-3">Sandbox</th>
                        <th className="text-left px-4 py-3">{t('agentTypeDetail.sandboxUpgrade.table.status')}</th>
                        <th className="text-left px-4 py-3">{t('agentTypeDetail.sandboxUpgrade.table.imageStatus')}</th>
                        <th className="text-left px-4 py-3">{t('agentTypeDetail.sandboxUpgrade.table.backupCapability')}</th>
                        <th className="text-left px-4 py-3">Pod IP</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {pagedSandboxes.map(item => (
                        <tr key={item.Name} className={`hover:bg-gray-50 ${item.BackupReady ? '' : 'text-gray-400 bg-gray-50/60'} ${selectedNames.includes(item.Name) ? 'bg-primary-50/40' : ''} ${selectedNames.includes(item.Name) && item.ImageMatchesTarget ? 'bg-amber-50/50' : ''}`}>
                          <td className="px-4 py-3"><input type="checkbox" disabled={!item.BackupReady} checked={selectedNames.includes(item.Name)} onChange={() => toggleSandbox(item.Name)} /></td>
                          <td className="px-4 py-3 font-mono text-xs text-gray-800">{item.Name}</td>
                          <td className="px-4 py-3"><span className="px-2 py-1 rounded bg-green-50 text-green-700 text-xs">{item.Phase || '-'}</span></td>
                          <td className="px-4 py-3">
                            {item.TargetImage && item.CurrentImage ? (
                              <div className="max-w-[220px]" title={t('agentTypeDetail.sandboxUpgrade.imageTitle', { current: item.CurrentImage, target: item.TargetImage })}>
                                <span className={`inline-flex rounded px-2 py-1 text-xs font-medium ${item.ImageMatchesTarget ? 'bg-amber-50 text-amber-700 ring-1 ring-amber-100' : 'bg-blue-50 text-blue-700 ring-1 ring-blue-100'}`}>
                                  {item.ImageMatchesTarget ? t('agentTypeDetail.sandboxUpgrade.imageMatchesTarget') : t('agentTypeDetail.sandboxUpgrade.pendingUpgrade')}
                                </span>
                                <p className="mt-1 truncate font-mono text-[11px] text-gray-500">{formatImageForDisplay(item.CurrentImage)}</p>
                              </div>
                            ) : (
                              <span className="rounded bg-gray-100 px-2 py-1 text-xs text-gray-500">{t('agentTypeDetail.sandboxUpgrade.unknown')}</span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <span className={`px-2 py-1 rounded text-xs ${item.BackupReady ? 'bg-blue-50 text-blue-700' : 'bg-gray-100 text-gray-500'}`}>
                              {item.BackupReady ? t('agentTypeDetail.sandboxUpgrade.enabled') : t('agentTypeDetail.sandboxUpgrade.disabled')}
                            </span>
                          </td>
                          <td className="px-4 py-3 font-mono text-xs text-gray-500">{item.PodIP || '-'}</td>
                        </tr>
                      ))}
                      {filteredSandboxes.length === 0 && (
                        <tr><td colSpan={6} className="text-center text-gray-400 py-8">{sandboxes.length === 0 ? t('agentTypeDetail.sandboxUpgrade.empty.noUpgradeable') : t('agentTypeDetail.sandboxUpgrade.empty.noMatched')}</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <div className="flex flex-col gap-3 border-t border-gray-200 bg-gray-50 px-4 py-3 text-xs text-gray-500 sm:flex-row sm:items-center sm:justify-between">
                  <span>
                    {t('agentTypeDetail.sandboxUpgrade.pagination.range', { start: sandboxPageStart, end: sandboxPageEnd, total: filteredSandboxes.length })}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setSandboxPage(page => Math.max(1, page - 1))}
                      disabled={safeSandboxPage <= 1}
                      className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-gray-600 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <ChevronLeft className="h-3.5 w-3.5" />
                      {t('agentTypeDetail.sandboxUpgrade.pagination.prev')}
                    </button>
                    <span className="rounded bg-white px-2.5 py-1.5 ring-1 ring-gray-200">{t('agentTypeDetail.sandboxUpgrade.pagination.page', { page: safeSandboxPage, totalPages: sandboxTotalPages })}</span>
                    <button
                      type="button"
                      onClick={() => setSandboxPage(page => Math.min(sandboxTotalPages, page + 1))}
                      disabled={safeSandboxPage >= sandboxTotalPages}
                      className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-gray-600 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {t('agentTypeDetail.sandboxUpgrade.pagination.next')}
                      <ChevronRight className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            ) : targetMode === 'SelectedSandboxes' ? (
              <div className="max-w-full overflow-hidden rounded-lg border border-gray-200 bg-white">
                <div className="flex flex-col gap-3 border-b border-gray-200 bg-gray-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-semibold text-gray-900">{t('agentTypeDetail.sandboxUpgrade.confirmSelectedTitle')}</p>
                    <p className="mt-0.5 text-xs text-gray-500">{t('agentTypeDetail.sandboxUpgrade.confirmSelectedDescription')}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setCreateStep('target')}
                    className="btn-secondary flex items-center space-x-1 px-3 py-1.5 text-xs"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                    <span>{t('agentTypeDetail.sandboxUpgrade.actions.backToSelectPod')}</span>
                  </button>
                </div>
                <div className="p-4">
                  {selectedNames.length === 0 ? (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                      {t('agentTypeDetail.sandboxUpgrade.noSelectedPod')}
                    </div>
                  ) : (
                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                      {selectedNames.map(name => {
                        const item = sandboxes.find(sandbox => sandbox.Name === name)
                        return (
                          <div key={name} className="min-w-0 rounded-lg border border-gray-200 bg-gray-50 px-3 py-3">
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <p className="truncate font-mono text-xs font-semibold text-gray-900" title={name}>{name}</p>
                                <p className="mt-1 text-[11px] text-gray-500">{item?.PodIP || t('agentTypeDetail.sandboxUpgrade.podIpEmpty')}</p>
                              </div>
                              <button
                                type="button"
                                onClick={() => toggleSandbox(name)}
                                className="rounded p-1 text-gray-400 transition-colors hover:bg-white hover:text-gray-700"
                                aria-label={t('agentTypeDetail.sandboxUpgrade.actions.removeSandbox', { name })}
                              >
                                <X className="h-3.5 w-3.5" />
                              </button>
                            </div>
                            <div className="mt-3 flex flex-wrap gap-2">
                              <span className="rounded bg-white px-2 py-0.5 text-[11px] text-gray-600 ring-1 ring-gray-200">{item?.Phase || '-'}</span>
                              <span className={`rounded px-2 py-0.5 text-[11px] ring-1 ${item?.ImageMatchesTarget ? 'bg-amber-50 text-amber-700 ring-amber-100' : 'bg-blue-50 text-blue-700 ring-blue-100'}`}>
                                {item?.ImageMatchesTarget ? t('agentTypeDetail.sandboxUpgrade.imageMatchesTarget') : t('agentTypeDetail.sandboxUpgrade.pendingUpgrade')}
                              </span>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="max-w-full overflow-hidden rounded-lg border border-gray-200 bg-white">
                <div className="flex items-start justify-between gap-4 border-b border-gray-200 bg-gray-50 px-4 py-3">
                  <div>
                    <p className="text-sm font-semibold text-gray-900">LabelSelector</p>
                    <p className="mt-0.5 text-xs text-gray-500">{t('agentTypeDetail.sandboxUpgrade.labelSelectorDescription')}</p>
                  </div>
                  <button type="button" onClick={handleUseRecommendedSelector} className="btn-secondary flex flex-shrink-0 items-center space-x-1 px-3 py-1.5 text-xs">
                    <Copy className="h-3.5 w-3.5" />
                    <span>{t('agentTypeDetail.sandboxUpgrade.actions.fillExample')}</span>
                  </button>
                </div>
                <div className="grid min-w-0 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_300px]">
                  <textarea
                    value={selectorText}
                    onChange={(e) => setSelectorText(e.target.value)}
                    className="h-72 min-w-0 w-full resize-none border-0 bg-white p-4 font-mono text-sm leading-6 text-gray-900 outline-none focus:ring-0"
                    spellCheck={false}
                  />
                  <div className="min-w-0 border-t border-gray-200 bg-gray-50 p-4 lg:border-l lg:border-t-0">
                    <p className="text-xs font-semibold text-gray-500">{t('agentTypeDetail.sandboxUpgrade.commonLabels')}</p>
                    <div className="mt-3 space-y-2">
                      {commonLabels.map(label => (
                        <div key={label.key} className="rounded border border-gray-200 bg-white px-3 py-2">
                          <code className="block break-all text-xs font-semibold text-gray-800">{label.key}</code>
                          <code className="mt-1 block break-all text-xs text-primary-700">{label.value}</code>
                        </div>
                      ))}
                    </div>
                    <p className="mt-4 text-xs leading-5 text-gray-500">
                      {t('agentTypeDetail.sandboxUpgrade.selectorHint')}
                    </p>
                    <div className="mt-4 rounded-lg border border-blue-100 bg-blue-50 p-3 text-xs leading-5 text-blue-800">
                      {t('agentTypeDetail.sandboxUpgrade.selectorGuard')}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {!(targetMode === 'SelectedSandboxes' && createStep === 'target') && (
          <div className="min-w-0 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('agentTypeDetail.sandboxUpgrade.maxUnavailable')}</label>
                <input
                  value={maxUnavailable}
                  onChange={(e) => setMaxUnavailable(e.target.value)}
                  className={`input-field ${maxUnavailableInvalid ? 'border-amber-400 focus:ring-amber-300' : ''}`}
                  placeholder={t('agentTypeDetail.sandboxUpgrade.maxUnavailablePlaceholder')}
                  aria-invalid={maxUnavailableInvalid}
                />
                {maxUnavailableInvalid && (
                  <p className="mt-1 text-xs text-amber-700">{t('agentTypeDetail.sandboxUpgrade.maxUnavailableInvalid')}</p>
                )}
              </div>

              <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">{t('agentTypeDetail.backupUpgrade.targetImage')}</p>
                <p className="mt-1 max-h-[3.75rem] overflow-hidden break-all font-mono text-xs leading-5 text-gray-700" title={targetImage || ''}>
                  {targetImage || '-'}
                </p>
              </div>

              <div className="space-y-2 rounded-lg border border-gray-200 p-3 text-sm text-gray-600">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-gray-500">{t('agentTypeDetail.sandboxUpgrade.target.label')}</span>
                  <span className={`text-right font-medium ${selectedTargetMissing ? 'text-amber-700' : 'text-gray-900'}`}>
                    {targetMode === 'SelectedSandboxes' ? t('agentTypeDetail.sandboxUpgrade.target.selectedSandboxes', { count: selectedNames.length }) : 'LabelSelector'}
                  </span>
                </div>
                {selectedTargetMissing && (
                  <p className="text-xs text-amber-700">{t('agentTypeDetail.sandboxUpgrade.errors.selectAtLeastOneBackupReady')}</p>
                )}
                <div className="flex items-center justify-between gap-3">
                  <span className="text-gray-500">{t('agentTypeDetail.sandboxUpgrade.concurrency')}</span>
                  <span className="text-right font-medium text-gray-900">{formatMaxUnavailable(maxUnavailableValue, t)}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-gray-500">{t('agentTypeDetail.sandboxUpgrade.commandTimeout')}</span>
                  <span className="text-right font-medium text-gray-900">{agentType.upgrade_metadata?.timeoutSeconds || 60}s</span>
                </div>
                <div className="flex items-start justify-between gap-3">
                  <span className="text-gray-500">SandboxSet</span>
                  <span className="min-w-0 break-all text-right font-mono text-xs text-gray-900">{upgradeContext?.SandboxSetName || agentType.sandbox_template_id || '-'}</span>
                </div>
              </div>
            </div>

            {targetMode === 'SelectedSandboxes' && selectedNoopSandboxes.length > 0 && (
              <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-800">
                <div className="flex items-start space-x-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                  <div>
                    <p className="text-sm font-medium">{t('agentTypeDetail.sandboxUpgrade.noopSelectedTitle', { count: selectedNoopSandboxes.length })}</p>
                    <p className="mt-1 text-xs leading-5">
                      {t('agentTypeDetail.sandboxUpgrade.noopSelectedText')}
                    </p>
                  </div>
                </div>
              </div>
            )}
            <div className="mt-4 rounded-lg border border-blue-100 bg-blue-50 p-3 text-blue-800">
              <div className="flex items-start space-x-2">
                <Info className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <div className="text-xs leading-5">
                  <p>{t('agentTypeDetail.sandboxUpgrade.autoPatchHint')}</p>
                  <p className="mt-1">{t('agentTypeDetail.sandboxUpgrade.namespaceSingleOpsNotice')}</p>
                </div>
              </div>
            </div>
            <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900">
              <div className="flex items-start space-x-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <p className="text-xs leading-5">
                  {t('agentTypeDetail.sandboxUpgrade.riskText')}
                </p>
              </div>
            </div>
            {blockingUpgrade && (
              <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-red-800">
                <div className="flex items-start space-x-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                  <p className="min-w-0 text-xs leading-5">
                    {t('agentTypeDetail.sandboxUpgrade.blockingUpgradeBefore')} <span className="break-all font-mono">{blockingUpgrade.UpgradeId}</span> {t('agentTypeDetail.sandboxUpgrade.blockingUpgradeAfter', { phase: getPhaseMeta(blockingUpgrade.Phase).label })}
                  </p>
                </div>
              </div>
            )}
            <div className="mt-4 space-y-2">
              <button
                type="button"
                onClick={() => handleCreate('Full')}
                disabled={createDisabled}
                className="btn-primary w-full flex items-center justify-center space-x-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {creatingMode === 'Full' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                <span>{creatingMode === 'Full' ? t('agentTypeDetail.sandboxUpgrade.actions.creating') : t('agentTypeDetail.sandboxUpgrade.actions.createFull')}</span>
              </button>
              <button
                type="button"
                onClick={() => handleCreate('PostOnly')}
                disabled={createDisabled}
                className="btn-secondary w-full flex items-center justify-center space-x-2 disabled:cursor-not-allowed disabled:opacity-50"
                title={t('agentTypeDetail.sandboxUpgrade.actions.postOnlyTitle')}
              >
                {creatingMode === 'PostOnly' ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                <span>{creatingMode === 'PostOnly' ? t('agentTypeDetail.sandboxUpgrade.actions.creating') : t('agentTypeDetail.sandboxUpgrade.actions.createPostOnly')}</span>
              </button>
              <p className="text-xs leading-5 text-gray-500">
                {t('agentTypeDetail.sandboxUpgrade.postOnlyHint')}
              </p>
            </div>
          </div>
          )}
        </div>
      </div>

      )}

      {activeUpgradeTab === 'history' && (
      <div className="card">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">{t('agentTypeDetail.sandboxUpgrade.historyTitle')}</h2>
            <p className="mt-1 text-sm text-gray-500">{t('agentTypeDetail.sandboxUpgrade.historyDescription')}</p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {hasActiveUpgrade && (
              <span className="inline-flex items-center gap-1.5 rounded-lg bg-blue-50 px-3 py-2 text-xs font-medium text-blue-700 ring-1 ring-blue-100">
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                {t('agentTypeDetail.sandboxUpgrade.autoRefreshActive')}
              </span>
            )}
            <button onClick={() => loadData()} className="btn-secondary flex items-center space-x-2" disabled={loading}>
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              <span>{t('agentTypeDetail.sandboxUpgrade.actions.refresh')}</span>
            </button>
          </div>
        </div>
        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="min-w-[720px] w-full text-sm">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="text-left px-4 py-3">{t('agentTypeDetail.sandboxUpgrade.history.upgradeId')}</th>
                <th className="text-left px-4 py-3">{t('agentTypeDetail.sandboxUpgrade.history.status')}</th>
                <th className="text-left px-4 py-3">{t('agentTypeDetail.sandboxUpgrade.history.progress')}</th>
                <th className="text-left px-4 py-3">{t('agentTypeDetail.sandboxUpgrade.history.concurrency')}</th>
                <th className="text-left px-4 py-3">{t('agentTypeDetail.sandboxUpgrade.history.createdAt')}</th>
                <th className="text-left px-4 py-3">{t('agentTypeDetail.sandboxUpgrade.history.actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {upgrades.map(item => {
                const hasFailedObjects = hasUpgradeFailures(item)
                const isActiveUpgrade = item.Phase !== 'Completed' && item.Phase !== 'Failed'
                return (
                <React.Fragment key={item.UpgradeId}>
                  <tr className={item.Phase === 'Failed' ? 'bg-red-50/40' : ''}>
                    <td className="px-4 py-3 font-mono text-xs">{item.UpgradeId}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex rounded px-2 py-1 text-xs font-medium ${getPhaseMeta(item.Phase).className}`}>
                        {getPhaseMeta(item.Phase).label}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700">{t('agentTypeDetail.sandboxUpgrade.progress.completedOf', { completed: item.Progress.UpdatedReplicas, total: item.Progress.Replicas })}</span>
                        {item.Progress.UpdatingReplicas > 0 && (
                          <span className="rounded bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700">{t('agentTypeDetail.sandboxUpgrade.progress.updating', { count: item.Progress.UpdatingReplicas })}</span>
                        )}
                        {item.Progress.FailedReplicas > 0 && (
                          <span className="rounded bg-red-50 px-2 py-1 text-xs font-medium text-red-700">{t('agentTypeDetail.sandboxUpgrade.progress.failed', { count: item.Progress.FailedReplicas })}</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">{formatMaxUnavailable(item.MaxUnavailable, t)}</td>
                    <td className="px-4 py-3 text-gray-500">{item.CreatedAt ? new Date(item.CreatedAt).toLocaleString() : '-'}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => setFailureDetailUpgrade(item)}
                          className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                            hasFailedObjects
                              ? 'text-red-700 hover:bg-red-100'
                              : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                          }`}
                        >
                          <Eye className="h-3.5 w-3.5" />
                          <span>{hasFailedObjects ? t('agentTypeDetail.sandboxUpgrade.actions.viewReason') : isActiveUpgrade ? t('agentTypeDetail.sandboxUpgrade.actions.viewProgress') : t('agentTypeDetail.sandboxUpgrade.actions.viewProcess')}</span>
                        </button>
                        {item.Retryable && (
                          <button
                            type="button"
                            onClick={() => handleRetryUpgrade(item)}
                            disabled={retryingUpgradeId === item.UpgradeId}
                            className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-primary-700 transition-colors hover:bg-primary-50 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {retryingUpgradeId === item.UpgradeId
                              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              : <RefreshCw className="h-3.5 w-3.5" />}
                            <span>{retryingUpgradeId === item.UpgradeId ? t('agentTypeDetail.sandboxUpgrade.actions.creating') : t('agentTypeDetail.sandboxUpgrade.actions.retry')}</span>
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {isActiveUpgrade && (
                    <tr className="bg-blue-50/30">
                      <td colSpan={6} className="px-4 py-3">
                        <div className="rounded-lg border border-blue-100 bg-white px-4 py-3">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2 text-blue-700">
                              <Info className="h-4 w-4 flex-shrink-0" />
                              <span className="text-sm font-semibold">{item.Phase === 'Pending' ? t('agentTypeDetail.sandboxUpgrade.progress.waitingController') : t('agentTypeDetail.sandboxUpgrade.progress.rolling')}</span>
                              <span className="rounded bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">{t('agentTypeDetail.sandboxUpgrade.progress.updating', { count: item.Progress.UpdatingReplicas })}</span>
                              <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">{t('agentTypeDetail.sandboxUpgrade.progress.waiting', { count: getWaitingReplicas(item) })}</span>
                            </div>
                            <div className="mt-3 h-2 overflow-hidden rounded-full bg-gray-100">
                              <div
                                className="h-full rounded-full bg-primary-500 transition-all"
                                style={{ width: `${getProgressPercent(item)}%` }}
                              />
                            </div>
                            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
                              <span>{t('agentTypeDetail.sandboxUpgrade.progress.completedOf', { completed: item.Progress.UpdatedReplicas, total: item.Progress.Replicas })}</span>
                              <span>{t('agentTypeDetail.sandboxUpgrade.progress.maxUnavailable', { value: formatMaxUnavailable(item.MaxUnavailable, t) })}</span>
                              <span className="min-w-0 break-all">selector: {getSelectorSummary(item)}</span>
                            </div>
                            {getLatestCondition(item) && (
                              <p className="mt-2 break-words text-xs text-gray-500">
                                {t('agentTypeDetail.sandboxUpgrade.progress.latestStatus')}{getLatestCondition(item)?.type || getLatestCondition(item)?.Type || '-'}
                                {` / ${getLatestCondition(item)?.status || getLatestCondition(item)?.Status || '-'}`}
                                {(getLatestCondition(item)?.reason || getLatestCondition(item)?.Reason) && ` / ${getLatestCondition(item)?.reason || getLatestCondition(item)?.Reason}`}
                                {(getLatestCondition(item)?.message || getLatestCondition(item)?.Message) && `${t('agentTypeDetail.sandboxUpgrade.format.colon')}${getLatestCondition(item)?.message || getLatestCondition(item)?.Message}`}
                              </p>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                  {hasFailedObjects && (
                    <tr className="bg-red-50/40">
                      <td colSpan={6} className="px-4 py-3">
                        <div className="border-l-2 border-red-200 bg-red-50/30 px-4 py-3">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <AlertTriangle className="h-4 w-4 flex-shrink-0 text-red-700" />
                              <span className="truncate text-sm font-semibold text-red-700">
                                {(item.FailedSandboxes || []).length > 0 ? item.FailedSandboxes?.[0]?.SandboxName : t('agentTypeDetail.sandboxUpgrade.failedObjectSyncing')}
                              </span>
                              <span className="rounded bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700 ring-1 ring-red-100">
                                {t('agentTypeDetail.sandboxUpgrade.failedCount', { count: Math.max(item.Progress.FailedReplicas, (item.FailedSandboxes || []).length) })}
                              </span>
                              {(item.FailedSandboxes || []).length > 0 && (
                                <span className="rounded bg-white/70 px-2 py-0.5 text-xs text-gray-500 ring-1 ring-red-100">
                                  {item.FailedSandboxes?.[0]?.Reason || '-'}
                                </span>
                              )}
                            </div>
                            <p className="mt-1 text-xs leading-5 text-gray-500">
                              {getFailureExplanation(item)}
                            </p>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
                )
              })}
              {upgrades.length === 0 && (
                <tr><td colSpan={6} className="text-center text-gray-400 py-8">{t('agentTypeDetail.sandboxUpgrade.empty.noHistory')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      )}

      {resourceUpgrade && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/45 p-4">
          <div className="flex max-h-[88vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-gray-200 px-5 py-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-lg font-semibold text-gray-900">{t('agentTypeDetail.sandboxUpgrade.resource.title')}</h3>
                  <span className={`rounded px-2 py-1 text-xs font-medium ${getPhaseMeta(resourceUpgrade.Phase).className}`}>
                    {getPhaseMeta(resourceUpgrade.Phase).label}
                  </span>
                </div>
                <p className="mt-1 break-all font-mono text-xs text-gray-500">{resourceUpgrade.UpgradeId}</p>
              </div>
              <button
                type="button"
                onClick={() => setResourceUpgrade(null)}
                className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                aria-label={t('common:buttons.close')}
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-hidden px-5 py-4">
              {resourceError && (
                <div className="mb-3 rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm leading-6 text-red-700">
                  {resourceError}
                </div>
              )}
              {resourceLoading ? (
                <div className="flex h-96 items-center justify-center text-gray-500">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('agentTypeDetail.sandboxUpgrade.resource.loading')}
                </div>
              ) : (
                <textarea
                  value={resourceText}
                  readOnly
                  className="h-[62vh] w-full cursor-default resize-none rounded-lg border border-gray-200 bg-gray-950 p-4 font-mono text-xs leading-5 text-gray-100 outline-none"
                  spellCheck={false}
                />
              )}
            </div>

            <div className="flex flex-col gap-3 border-t border-gray-200 bg-gray-50 px-5 py-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex flex-wrap items-center gap-2">
                {!resourceUpgradeLocked && (
                  <button
                    type="button"
                    onClick={handleDeleteResource}
                    disabled={resourceMutationDisabled}
                    className="btn-secondary flex items-center space-x-1 px-3 py-1.5 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    <span>{t('agentTypeDetail.sandboxUpgrade.actions.deleteTask')}</span>
                  </button>
                )}
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <button type="button" onClick={() => setResourceUpgrade(null)} className="btn-primary">
                  {t('common:buttons.close')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {failureDetailUpgrade && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/45 p-4">
          <div className="flex max-h-[84vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-gray-200 px-5 py-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-lg font-semibold text-gray-900">{t('agentTypeDetail.sandboxUpgrade.detail.title')}</h3>
                  <span className={`rounded px-2 py-1 text-xs font-medium ${getPhaseMeta(failureDetailUpgrade.Phase).className}`}>
                    {getPhaseMeta(failureDetailUpgrade.Phase).label}
                  </span>
                </div>
                <p className="mt-1 break-all font-mono text-xs text-gray-500">{failureDetailUpgrade.UpgradeId}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <span className="rounded bg-gray-100 px-2 py-1 text-xs text-gray-600">{t('agentTypeDetail.sandboxUpgrade.progress.total', { count: failureDetailUpgrade.Progress.Replicas })}</span>
                  <span className="rounded bg-emerald-50 px-2 py-1 text-xs text-emerald-700">{t('agentTypeDetail.sandboxUpgrade.progress.completed', { count: failureDetailUpgrade.Progress.UpdatedReplicas })}</span>
                  <span className="rounded bg-blue-50 px-2 py-1 text-xs text-blue-700">{t('agentTypeDetail.sandboxUpgrade.progress.updating', { count: failureDetailUpgrade.Progress.UpdatingReplicas })}</span>
                  {hasUpgradeFailures(failureDetailUpgrade) && (
                    <span className="rounded bg-red-50 px-2 py-1 text-xs text-red-700">{t('agentTypeDetail.sandboxUpgrade.progress.failed', { count: Math.max(failureDetailUpgrade.Progress.FailedReplicas, failureDetailUpgrade.FailedSandboxes?.length || 0) })}</span>
                  )}
                  <span className="rounded bg-gray-100 px-2 py-1 text-xs text-gray-600">{t('agentTypeDetail.sandboxUpgrade.progress.waiting', { count: getWaitingReplicas(failureDetailUpgrade) })}</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setFailureDetailUpgrade(null)}
                className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                aria-label={t('common:buttons.close')}
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {getDetailSandboxes(failureDetailUpgrade).length > 0 ? (
              <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
                {hasUpgradeFailures(failureDetailUpgrade) && (
                  <div className="mb-4 rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm leading-6 text-red-700">
                    <p className="font-semibold">{t('agentTypeDetail.sandboxUpgrade.detail.failureExplanation')}</p>
                    <p className="mt-1">{getFailureExplanation(failureDetailUpgrade)}</p>
                  </div>
                )}
                <table className="min-w-[960px] w-full text-sm">
                  <thead className="sticky top-0 z-10 bg-white text-gray-500 shadow-[0_1px_0_0_#e5e7eb]">
                    <tr>
                      <th className="py-3 pr-4 text-left font-medium">Sandbox</th>
                      <th className="py-3 pr-4 text-left font-medium">{t('agentTypeDetail.sandboxUpgrade.detail.stage')}</th>
                      <th className="py-3 pr-4 text-left font-medium">Condition</th>
                      <th className="py-3 pr-4 text-left font-medium">Condition Reason</th>
                      <th className="py-3 pr-4 text-left font-medium">Pod IP</th>
                      <th className="py-3 pr-4 text-left font-medium">Node</th>
                      <th className="py-3 text-left font-medium">Message</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {getDetailSandboxes(failureDetailUpgrade).map((failed, index) => (
                      <tr key={`${failureDetailUpgrade.UpgradeId}-${failed.SandboxName}-${index}`}>
                        <td className="py-3 pr-4 font-mono text-xs text-gray-900">
                          <div className="space-y-1">
                            <p>{failed.SandboxName}</p>
                            {failed.MatchedBySnapshot && (
                              <span className="inline-flex rounded bg-amber-50 px-1.5 py-0.5 text-[11px] font-sans text-amber-700 ring-1 ring-amber-100">
                                {t('agentTypeDetail.sandboxUpgrade.detail.snapshot')}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="py-3 pr-4 text-gray-700">{failed.Phase || '-'}</td>
                        <td className={`py-3 pr-4 ${getConditionClassName(failed.ConditionStatus)}`}>
                          <div className="space-y-1">
                            <p>{failed.ConditionType || '-'}</p>
                            <p className="text-xs opacity-75">{failed.ConditionStatus || '-'}</p>
                          </div>
                        </td>
                        <td className={`py-3 pr-4 ${getConditionClassName(failed.ConditionStatus)}`}>{failed.Reason || '-'}</td>
                        <td className="py-3 pr-4 font-mono text-xs text-gray-500">{failed.PodIP || '-'}</td>
                        <td className="py-3 pr-4 font-mono text-xs text-gray-500">{failed.NodeName || '-'}</td>
                        <td className={`max-w-[520px] break-words py-3 ${getMessageClassName(failed.ConditionStatus)}`}>{failed.Message || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : hasUpgradeFailures(failureDetailUpgrade) ? (
              <div className="min-h-0 flex-1 px-5 py-6">
                <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900">{t('agentTypeDetail.sandboxUpgrade.detail.failedSyncingTitle')}</p>
                      <p className="mt-1 text-xs leading-5 text-gray-500">
                        {t('agentTypeDetail.sandboxUpgrade.detail.failedSyncingBefore')}
                        <code className="mx-1 rounded bg-white px-1.5 py-0.5 font-mono text-[11px] text-gray-700 ring-1 ring-gray-200">
                          agents.kruise.io/update-ops={failureDetailUpgrade.UpgradeId}
                        </code>
                        {t('agentTypeDetail.sandboxUpgrade.detail.failedSyncingAfter')}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={loadData}
                      disabled={loading}
                      className="btn-secondary flex flex-shrink-0 items-center space-x-1 px-3 py-1.5 text-xs"
                    >
                      <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
                      <span>{t('agentTypeDetail.sandboxUpgrade.actions.refresh')}</span>
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="min-h-0 flex-1 px-5 py-6">
                <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-4">
                  <p className="text-sm font-medium text-gray-900">{t('agentTypeDetail.sandboxUpgrade.detail.noDataTitle')}</p>
                  <p className="mt-1 text-xs leading-5 text-gray-500">{t('agentTypeDetail.sandboxUpgrade.detail.noDataText')}</p>
                </div>
              </div>
            )}

            <div className="border-t border-gray-200 bg-white px-5 py-3">
              {hasUpgradeFailures(failureDetailUpgrade) && (
                <div className="mb-3 flex items-center gap-2 text-xs text-gray-500">
                  <Info className="h-3.5 w-3.5 flex-shrink-0" />
                  <span>{failedUpgradeHint}</span>
                </div>
              )}
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  {hasUpgradeFailures(failureDetailUpgrade) && (
                    <button
                      type="button"
                      onClick={() => {
                        const item = failureDetailUpgrade
                        setFailureDetailUpgrade(null)
                        openResourceEditor(item)
                      }}
                      className="btn-secondary flex items-center gap-1.5 text-sm"
                    >
                      <FileJson className="h-4 w-4" />
                      <span>{t('agentTypeDetail.sandboxUpgrade.actions.viewOldOps')}</span>
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => setFailureDetailUpgrade(null)} className="btn-secondary text-sm">
                    {t('common:buttons.close')}
                  </button>
                  {hasUpgradeFailures(failureDetailUpgrade) && (
                    <button
                      type="button"
                      onClick={() => handleDeleteUpgrade(failureDetailUpgrade)}
                      disabled={deletingUpgradeId === failureDetailUpgrade.UpgradeId}
                      className="btn-danger flex items-center gap-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {deletingUpgradeId === failureDetailUpgrade.UpgradeId
                        ? <Loader2 className="h-4 w-4 animate-spin" />
                        : <Trash2 className="h-4 w-4" />}
                      <span>{deletingUpgradeId === failureDetailUpgrade.UpgradeId ? t('agentTypeDetail.sandboxUpgrade.actions.deleting') : t('agentTypeDetail.sandboxUpgrade.actions.deleteTask')}</span>
                    </button>
                  )}
                  {hasUpgradeFailures(failureDetailUpgrade) && (
                    <button
                      type="button"
                      onClick={() => handleRetryUpgrade(failureDetailUpgrade)}
                      disabled={retryingUpgradeId === failureDetailUpgrade.UpgradeId}
                      className="btn-primary flex items-center gap-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {retryingUpgradeId === failureDetailUpgrade.UpgradeId
                        ? <Loader2 className="h-4 w-4 animate-spin" />
                        : <RefreshCw className="h-4 w-4" />}
                      <span>{retryingUpgradeId === failureDetailUpgrade.UpgradeId ? t('agentTypeDetail.sandboxUpgrade.actions.creating') : t('agentTypeDetail.sandboxUpgrade.actions.retry')}</span>
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default AgentTypeDetail
