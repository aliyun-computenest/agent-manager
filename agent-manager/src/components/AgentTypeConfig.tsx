import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate, Link, useSearchParams } from 'react-router-dom'
import {
  Bot, Plus, Trash2, Loader2, ToggleLeft, ToggleRight,
  Settings, MessageSquare, FileJson, X, Save, Copy, ExternalLink, Puzzle, ShieldCheck,
  Terminal,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import toast from 'react-hot-toast'
import { useAuth } from '../contexts/AuthContext'
import { apiUrl } from '../lib/api'
import { listSandboxSets, type SandboxSetSummary } from '../lib/sandboxsets'

interface AgentType {
  id: string
  code: string
  name: string
  description: string | null
  icon: string
  category: 'builtin' | 'custom'
  sandbox_template_id: string | null
  sandbox_timeout: number
  config_write_path: string | null
  startup_command: string | null
  sandbox_user: string | null
  terminal_user: string | null
  upgrade_metadata?: {
    timeoutSeconds?: number
    preUpgrade?: { command?: string[] }
    postUpgrade?: { command?: string[] }
  }
  supports_channels: boolean
  supports_env_vars: boolean
  supports_skills: boolean
  skill_path: string
  user_terminal_enabled: boolean
  is_enabled: boolean
  sort_order: number
  created_at: string
}

// 暂未完全适配的 Agent 配置，禁止启用和作为模板源
const COMING_SOON_AGENT_CODES: string[] = []

const emptyForm = {
  code: '',
  name: '',
  description: '',
  sandboxTemplateId: '',
  sandboxTimeout: 300,
  configWritePath: '',
  startupCommand: '',
  modifyModelCommand: '',
  modifyChannelCommand: '',
  sandboxUser: '',
  terminalUser: 'node',
  supportsChannels: false,
  supportsEnvVars: false,
  supportsSkills: true,
  skillPath: '/home/node/.agents/skills',
  userTerminalEnabled: false,
  sortOrder: 0,
  readinessCheck: '{"type": "http", "port": 8080, "path": "/health", "timeout": 120}',
}

const AgentTypeConfig: React.FC = () => {
  const { t } = useTranslation('admin')
  const { session } = useAuth()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const accessTokenRef = useRef<string | null>(session?.access_token ?? null)
  const isAuthenticated = Boolean(session?.access_token)
  const requestedTab = searchParams.get('tab')
  const requestedAgentTypeId = searchParams.get('agentTypeId') || ''
  const requestedSandboxName = searchParams.get('selectedSandbox') || undefined
  const redirectingToSandboxUpgrade = requestedTab === 'sandboxUpgrade'
  const [agentTypes, setAgentTypes] = useState<AgentType[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [successMessage, setSuccessMessage] = useState('')
  const [form, setForm] = useState({ ...emptyForm })
  const [templateSourceId, setTemplateSourceId] = useState('')
  const [copiedConfigTemplate, setCopiedConfigTemplate] = useState<object | null>(null)
  const [copiedUpgradeMetadata, setCopiedUpgradeMetadata] = useState<object | null>(null)
  const [copiedSkillConfig, setCopiedSkillConfig] = useState<unknown[] | null>(null)
  const [observabilityEnabled, setObservabilityEnabled] = useState(false)
  const [observabilityEnv, setObservabilityEnv] = useState<{ key: string; value: string }[]>([])

  // Helper to reset all copied-from-template states in one place,
  // so every call site stays in sync when new copied fields are added.
  const resetCopyState = () => {
    setCopiedConfigTemplate(null)
    setCopiedUpgradeMetadata(null)
    setCopiedSkillConfig(null)
  }
  const [sandboxSetOptions, setSandboxSetOptions] = useState<SandboxSetSummary[]>([])

  useEffect(() => {
    accessTokenRef.current = session?.access_token ?? null
  }, [session?.access_token])

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
    if (!redirectingToSandboxUpgrade) return
    const params = new URLSearchParams()
    if (requestedAgentTypeId) params.set('agentTypeId', requestedAgentTypeId)
    if (requestedSandboxName) params.set('selectedSandbox', requestedSandboxName)
    const query = params.toString()
    navigate(query ? `/admin/instance-upgrades?${query}` : '/admin/instance-upgrades', { replace: true })
  }, [redirectingToSandboxUpgrade, requestedAgentTypeId, requestedSandboxName, navigate])

  useEffect(() => {
    const token = accessTokenRef.current
    if (!isAuthenticated || !token || !showCreateModal) return
    listSandboxSets(token).then(setSandboxSetOptions).catch(() => {})
  }, [isAuthenticated, showCreateModal])

  useEffect(() => {
    if (redirectingToSandboxUpgrade) return
    if (isAuthenticated) fetchAgentTypes()
  }, [fetchAgentTypes, isAuthenticated, redirectingToSandboxUpgrade])

  if (redirectingToSandboxUpgrade) {
    return null
  }

  const showSuccess = (msg: string) => {
    setSuccessMessage(msg)
    setTimeout(() => setSuccessMessage(''), 3000)
  }

  const capabilityOptionClass = (enabled: boolean) =>
    `flex min-h-[52px] cursor-pointer items-center gap-3 rounded-lg border px-3.5 py-3 transition-colors ${
      enabled
        ? 'border-primary-200 bg-primary-50 text-gray-900 shadow-sm'
        : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300 hover:bg-gray-50'
    }`
  const capabilityIconClass = (enabled: boolean) =>
    `h-4 w-4 shrink-0 ${enabled ? 'text-primary-600' : 'text-gray-400'}`

  const handleApplyTemplate = async (sourceId: string) => {
    setTemplateSourceId(sourceId)
    if (!sourceId) {
      // Reset to empty form but keep code/name user may have entered
      setForm(prev => ({ ...emptyForm, code: prev.code, name: prev.name, description: prev.description }))
      resetCopyState()
      setObservabilityEnv([])
      setObservabilityEnabled(false)
      return
    }
    try {
      const token = session?.access_token
      if (!token) return
      const res = await fetch(`${apiUrl}/api/agent-types/${sourceId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      })
      const data = await res.json()
      if (!data.success || !data.agentType) return
      const src = data.agentType
      setForm(prev => ({
        ...prev,
        // Keep user-entered code/name, copy the rest
        description: prev.description || src.description || '',
        sandboxTemplateId: src.sandbox_template_id || '',
        sandboxTimeout: src.sandbox_timeout || 300,
        configWritePath: src.config_write_path || '',
        startupCommand: src.startup_command || '',
        modifyModelCommand: src.modify_model_command || '',
        modifyChannelCommand: src.modify_channel_command || '',
        sandboxUser: src.sandbox_user || '',
        terminalUser: src.terminal_user || 'node',
        readinessCheck: src.readiness_check ? JSON.stringify(src.readiness_check, null, 2) : emptyForm.readinessCheck,
        supportsChannels: src.supports_channels || false,
        supportsEnvVars: src.supports_env_vars || false,
        supportsSkills: src.supports_skills !== false,
        skillPath: src.skill_path || '/home/node/.agents/skills',
        userTerminalEnabled: src.user_terminal_enabled === true,
        sortOrder: 0,
      }))
      setCopiedConfigTemplate(src.config_template && Object.keys(src.config_template).length > 0 ? src.config_template : null)
      setCopiedUpgradeMetadata(src.upgrade_metadata || null)
      setCopiedSkillConfig(Array.isArray(src.skill_config) ? src.skill_config : null)

      // Auto-fill observability config when copying from built-in agent types
      const BUILTIN_CODES = ['openclaw', 'hermes', 'qwenpaw']
      if (BUILTIN_CODES.includes(src.code)) {
        const obsEnv = src.observability_env
        if (obsEnv && typeof obsEnv === 'object' && Object.keys(obsEnv).length > 0) {
          setObservabilityEnv(Object.entries(obsEnv).map(([key, value]) => ({ key, value: String(value) })))
        }
        setObservabilityEnabled(src.observability_enabled !== false)
      } else {
        // Non-builtin: reset observability fields
        setObservabilityEnv([])
        setObservabilityEnabled(false)
      }
    } catch (err) {
      console.error('Failed to load template source:', err)
    }
  }

  const handleCreate = async () => {
    setError('')
    if (!form.code || !form.name) { setError(t('agentTypeConfig.validation.required')); return }
    if (!form.skillPath.startsWith('/') || form.skillPath.split('/').some(segment => segment === '.' || segment === '..')) {
      setError(t('agentTypeConfig.validation.skillPath'))
      return
    }
    let readinessCheck
    try { readinessCheck = JSON.parse(form.readinessCheck) } catch { setError(t('agentTypeConfig.validation.readinessCheck')); return }
    setSaving(true)
    try {
      const token = session?.access_token
      if (!token) return
      const body: Record<string, any> = {
        code: form.code,
        name: form.name,
        description: form.description || null,
        sandboxTemplateId: form.sandboxTemplateId || null,
        sandboxTimeout: form.sandboxTimeout,
        configWritePath: form.configWritePath || null,
        startupCommand: form.startupCommand || null,
        sandboxUser: form.sandboxUser || null,
        terminalUser: form.terminalUser || 'node',
        readinessCheck,
        supportsChannels: form.supportsChannels,
        supportsEnvVars: form.supportsEnvVars,
        supportsSkills: form.supportsSkills,
        skillPath: form.skillPath,
        userTerminalEnabled: form.userTerminalEnabled,
        sortOrder: form.sortOrder,
      }
      // Include config template if copied from source
      if (copiedConfigTemplate) {
        body.configTemplate = copiedConfigTemplate
      }
      // Script commands are always sourced from the form fields;
      // handleApplyTemplate copies source values into form directly.
      if (form.modifyModelCommand) {
        body.modifyModelCommand = form.modifyModelCommand
      }
      if (form.modifyChannelCommand) {
        body.modifyChannelCommand = form.modifyChannelCommand
      }
      if (copiedUpgradeMetadata) {
        body.upgradeMetadata = copiedUpgradeMetadata
      }
      if (copiedSkillConfig) {
        body.skillConfig = copiedSkillConfig
      }
      // Include templateSourceId to copy channel_templates on server side
      if (templateSourceId) {
        body.templateSourceId = templateSourceId
      }
      // Observability config
      body.observability_enabled = observabilityEnabled
      if (observabilityEnv.length > 0) {
        const filtered = observabilityEnv.filter(e => e.key)
        if (filtered.length > 0) {
          body.observabilityEnv = Object.fromEntries(filtered.map(e => [e.key, e.value]))
        }
      }
      const res = await fetch(`${apiUrl}/api/agent-types`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
      const data = await res.json()
      if (!data.success) throw new Error(data.error || t('agentTypeConfig.createFailed'))
      showSuccess(t('agentTypeConfig.createSuccess'))
      setShowCreateModal(false)
      setForm({ ...emptyForm })
      setTemplateSourceId('')
      resetCopyState()
      setObservabilityEnabled(false)
      setObservabilityEnv([])
      await fetchAgentTypes()
      if (data.agentType?.id) navigate(`/admin/agent-types/${data.agentType.id}`)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!confirm(t('agentTypeConfig.confirmDelete'))) return
    try {
      const token = session?.access_token
      if (!token) return
      const res = await fetch(`${apiUrl}/api/agent-types/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      })
      const data = await res.json()
      if (!data.success) throw new Error(data.error || t('agentTypeConfig.deleteFailed'))
      showSuccess(t('agentTypeConfig.deleteSuccess'))
      await fetchAgentTypes()
    } catch (err: any) {
      toast.error(err.message)
    }
  }

  const handleToggle = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    const target = agentTypes.find(at => at.id === id)
    if (target && COMING_SOON_AGENT_CODES.includes(target.code)) {
      toast.error(t('agentTypeConfig.comingSoonAlert', { name: target.name }))
      return
    }
    try {
      const token = session?.access_token
      if (!token) return
      const res = await fetch(`${apiUrl}/api/agent-types/${id}/toggle`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}` }
      })
      const data = await res.json()
      if (!data.success) throw new Error(data.error || t('agentTypeConfig.toggleFailed'))
      setAgentTypes(prev => prev.map(at =>
        at.id === id ? { ...at, is_enabled: data.agentType.is_enabled } : at
      ))
    } catch (err: any) {
      toast.error(err.message)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-primary-600" />
        <span className="ml-3 text-gray-600">{t('common:loading.default')}</span>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <Bot className="w-6 h-6 text-primary-600" />
          <h2 className="text-xl font-semibold text-gray-900">{t('agentTypeConfig.title')}</h2>
        </div>
        <button
          onClick={() => { setShowCreateModal(true); setError(''); setForm({ ...emptyForm }); setTemplateSourceId(''); resetCopyState() }}
          className="btn-primary flex items-center space-x-2"
        >
          <Plus className="w-4 h-4" />
          <span>{t('agentTypeConfig.addNew')}</span>
        </button>
      </div>

      {successMessage && (
        <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg">
          {successMessage}
        </div>
      )}

      {/* Agent Types Card Grid */}
      {agentTypes.length === 0 ? (
        <div className="card text-center py-12">
          <Bot className="w-16 h-16 text-gray-300 mx-auto mb-4" />
          <p className="text-gray-500">{t('agentTypeConfig.noAgent')}</p>
          <button onClick={() => { setShowCreateModal(true); setForm({ ...emptyForm }) }} className="btn-primary mt-4">{t('agentTypeConfig.createFirst')}</button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {agentTypes.map((at) => {
            const isComingSoon = COMING_SOON_AGENT_CODES.includes(at.code)
            return (
            <div
              key={at.id}
              onClick={() => !isComingSoon && navigate(`/admin/agent-types/${at.id}`)}
              className={`card transition-all border-l-4 ${
                isComingSoon
                  ? 'border-l-gray-300 opacity-60 cursor-not-allowed'
                  : `hover:shadow-lg cursor-pointer ${at.is_enabled ? 'border-l-green-500' : 'border-l-gray-300'}`
              }`}
            >
              {/* Card Header */}
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center space-x-3">
                  <div className={`p-2.5 rounded-lg ${
                    at.is_enabled ? 'bg-primary-100' : 'bg-gray-100'
                  }`}>
                    <Bot className={`w-5 h-5 ${
                      at.is_enabled ? 'text-primary-600' : 'text-gray-400'
                    }`} />
                  </div>
                  <div>
                    <h3 className="font-semibold text-gray-900">{at.name}</h3>
                    <code className="text-xs bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">{at.code}</code>
                  </div>
                </div>
                <div className="flex items-center space-x-1">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                    at.category === 'builtin'
                      ? 'bg-blue-100 text-blue-700'
                      : 'bg-purple-100 text-purple-700'
                  }`}>
                    {at.category === 'builtin' ? t('agentTypeConfig.builtin') : t('agentTypeConfig.custom')}
                  </span>
                  {isComingSoon && (
                    <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-amber-100 text-amber-700">{t('agentTypeConfig.comingSoon')}</span>
                  )}
                </div>
              </div>

              {/* Description */}
              <p className="text-sm text-gray-500 mb-4 line-clamp-2 min-h-[2.5rem]">
                {at.description || t('agentTypeConfig.noDescription')}
              </p>

              {/* Info Tags */}
              <div className="flex flex-wrap gap-2 mb-4">
                {at.sandbox_template_id && (
                  <span className="inline-flex items-center text-xs bg-gray-50 text-gray-600 px-2 py-1 rounded-md">
                    <Settings className="w-3 h-3 mr-1" />
                    {t('agentTypeConfig.sandbox')}: {at.sandbox_template_id}
                  </span>
                )}
                {at.supports_channels && (
                  <span className="inline-flex items-center text-xs bg-green-50 text-green-700 px-2 py-1 rounded-md">
                    <MessageSquare className="w-3 h-3 mr-1" />
                    {t('agentTypeConfig.supportsChannel')}
                  </span>
                )}
                {at.supports_env_vars && (
                  <span className="inline-flex items-center text-xs bg-amber-50 text-amber-700 px-2 py-1 rounded-md">
                    <ShieldCheck className="w-3 h-3 mr-1" />
                    {t('agentTypeConfig.supportsEnvVar')}
                  </span>
                )}
                {at.supports_skills !== false && (
                  <span className="inline-flex items-center text-xs bg-purple-50 text-purple-700 px-2 py-1 rounded-md">
                    <Puzzle className="w-3 h-3 mr-1" />
                    {t('agentTypeConfig.supportsSkill')}
                  </span>
                )}
                <span className="inline-flex items-center text-xs bg-sky-50 text-sky-700 px-2 py-1 rounded-md">
                  <Terminal className="w-3 h-3 mr-1" />
                  {t('agentTypeConfig.terminalUser')}: {at.terminal_user || 'node'}
                </span>
                {at.user_terminal_enabled && (
                  <span className="inline-flex items-center text-xs bg-cyan-50 text-cyan-700 px-2 py-1 rounded-md">
                    <Terminal className="w-3 h-3 mr-1" />
                    {t('agentTypeConfig.userTerminal')}
                  </span>
                )}
                {at.config_write_path && (
                  <span className="inline-flex items-center text-xs bg-gray-50 text-gray-600 px-2 py-1 rounded-md">
                    <FileJson className="w-3 h-3 mr-1" />
                    {at.config_write_path.split('/').pop()}
                  </span>
                )}
              </div>

              {/* Card Footer */}
              <div className="flex items-center justify-between pt-3 border-t border-gray-100">
                <div className="flex items-center space-x-1">
                  <button
                    onClick={(e) => handleToggle(at.id, e)}
                    className="p-1.5 rounded-md hover:bg-gray-100 transition-colors"
                    title={at.is_enabled ? t('agentTypeConfig.disable') : t('agentTypeConfig.enable')}
                  >
                    {at.is_enabled
                      ? <ToggleRight className="w-5 h-5 text-green-500" />
                      : <ToggleLeft className="w-5 h-5 text-gray-400" />
                    }
                  </button>
                  {at.category !== 'builtin' && (
                    <button
                      onClick={(e) => handleDelete(at.id, e)}
                      className="p-1.5 rounded-md text-red-500 hover:bg-red-50 transition-colors"
                      title={t('common:buttons.delete')}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
                <span className={`text-xs font-medium px-2 py-1 rounded-full ${
                  at.is_enabled
                    ? 'bg-green-100 text-green-700'
                    : 'bg-red-100 text-red-600'
                }`}>
                  {at.is_enabled ? t('common:status.active') : t('common:status.disabled')}
                </span>
              </div>
            </div>
            )
          })}
        </div>
      )}

      {/* Create Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="sticky top-0 bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between rounded-t-xl">
              <h2 className="text-xl font-semibold text-gray-900">{t('agentTypeConfig.createModalTitle')}</h2>
              <button onClick={() => setShowCreateModal(false)} className="text-gray-400 hover:text-gray-600"><X className="w-5 h-5" /></button>
            </div>
            <div className="p-6 space-y-5">
              {error && (
                <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">{error}</div>
              )}

              {/* Template Source Selector */}
              {agentTypes.length > 0 && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                  <div className="flex items-center space-x-2 mb-2">
                    <Copy className="w-4 h-4 text-blue-600" />
                    <label className="text-sm font-medium text-blue-800">{t('agentTypeConfig.copyFromExisting')}</label>
                  </div>
                  <select
                    value={templateSourceId}
                    onChange={(e) => handleApplyTemplate(e.target.value)}
                    className="input-field text-sm"
                  >
                    <option value="">{t('agentTypeConfig.noTemplate')}</option>
                    {agentTypes.filter(at => !COMING_SOON_AGENT_CODES.includes(at.code)).map(at => (
                      <option key={at.id} value={at.id}>
                        {at.name} ({at.code}) {at.category === 'builtin' ? `- ${t('agentTypeConfig.builtin')}` : `- ${t('agentTypeConfig.custom')}`}
                      </option>
                    ))}
                  </select>
                  {templateSourceId && copiedConfigTemplate && (
                    <p className="text-xs text-blue-600 mt-1.5 flex items-center">
                      <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500 mr-1.5" />
                      {t('agentTypeConfig.copiedWithTemplate')}
                    </p>
                  )}
                  {templateSourceId && !copiedConfigTemplate && (
                    <p className="text-xs text-blue-600 mt-1.5 flex items-center">
                      <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 mr-1.5" />
                      {t('agentTypeConfig.copiedWithoutTemplate')}
                    </p>
                  )}
                </div>
              )}

              {/* Required fields */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">{t('agentTypeConfig.code')} <span className="text-red-500">*</span></label>
                  <input type="text" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder={t('agentTypeConfig.codePlaceholder')} className="input-field" />
                  <p className="text-xs text-gray-400 mt-1">{t('agentTypeConfig.codeHint')}</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">{t('agentTypeConfig.name')} <span className="text-red-500">*</span></label>
                  <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t('agentTypeConfig.namePlaceholder')} className="input-field" />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('agentTypeConfig.description')}</label>
                <input type="text" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder={t('agentTypeConfig.descriptionPlaceholder')} className="input-field" />
              </div>

              {/* Sandbox config */}
              <div className="border-t border-gray-100 pt-4">
                <h3 className="text-sm font-semibold text-gray-800 mb-3 flex items-center space-x-2"><Settings className="w-4 h-4 text-gray-500" /><span>{t('agentTypeConfig.sandboxConfig')}</span></h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">{t('agentTypeConfig.sandboxTemplateId')}</label>
                    <select
                      value={form.sandboxTemplateId}
                      onChange={(e) => setForm({ ...form, sandboxTemplateId: e.target.value })}
                      className="input-field"
                    >
                      <option value="">{t('agentTypeConfig.sandboxTemplateDefault')}</option>
                      {sandboxSetOptions.map(o => (
                        <option key={o.name} value={o.name}>
                          {o.name} ({o.namespace})
                        </option>
                      ))}
                    </select>
                    <div className="mt-1 flex items-center justify-between">
                      <p className="text-xs text-gray-400">{t('agentTypeConfig.sandboxTemplateHint')}</p>
                      <Link
                        to="/admin/sandboxsets"
                        className="text-xs text-primary-600 hover:text-primary-700 inline-flex items-center gap-1"
                      >
                        {t('agentTypeConfig.manageSandboxsets')}
                        <ExternalLink className="w-3 h-3" />
                      </Link>
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">{t('agentTypeConfig.sandboxTimeout')}</label>
                    <input type="number" value={form.sandboxTimeout} onChange={(e) => setForm({ ...form, sandboxTimeout: parseInt(e.target.value) || 300 })} className="input-field" />
                  </div>
                </div>
              </div>

              {/* Runtime config */}
              <div className="border-t border-gray-100 pt-4">
                <h3 className="text-sm font-semibold text-gray-800 mb-3 flex items-center space-x-2"><FileJson className="w-4 h-4 text-gray-500" /><span>{t('agentTypeConfig.runtimeConfig')}</span></h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">{t('agentTypeConfig.configWritePath')}</label>
                    <input type="text" value={form.configWritePath} onChange={(e) => setForm({ ...form, configWritePath: e.target.value })} placeholder={t('agentTypeConfig.configWritePathPlaceholder')} className="input-field" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">{t('agentTypeConfig.sandboxUser')}</label>
                    <input type="text" value={form.sandboxUser} onChange={(e) => setForm({ ...form, sandboxUser: e.target.value })} placeholder={t('agentTypeConfig.sandboxUserPlaceholder')} className="input-field" />
                    <p className="text-xs text-gray-400 mt-1">{t('agentTypeConfig.sandboxUserHint')}</p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">{t('agentTypeConfig.terminalUser')}</label>
                    <input type="text" value={form.terminalUser} onChange={(e) => setForm({ ...form, terminalUser: e.target.value })} placeholder={t('agentTypeConfig.terminalUserPlaceholder')} className="input-field" />
                    <p className="text-xs text-gray-400 mt-1">{t('agentTypeConfig.terminalUserHint')}</p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">{t('agentTypeConfig.skillPath')}</label>
                    <input type="text" value={form.skillPath} onChange={(e) => setForm({ ...form, skillPath: e.target.value })} placeholder={t('agentTypeConfig.skillPathPlaceholder')} className="input-field font-mono" />
                    <p className="text-xs text-gray-400 mt-1">{t('agentTypeConfig.skillPathHint')}</p>
                  </div>
                </div>
                <div className="mt-4">
                  <label className="block text-sm font-medium text-gray-700 mb-1">{t('agentTypeConfig.startupCommand')}</label>
                  <textarea value={form.startupCommand} onChange={(e) => setForm({ ...form, startupCommand: e.target.value })} className="input-field font-mono text-sm h-28 resize-y" placeholder={'#!/bin/bash\ncat > /opt/data/.env << \'EOF\'\nKEY=value\nEOF'} />
                </div>
                <div className="mt-4">
                  <label className="block text-sm font-medium text-gray-700 mb-1">{t('agentTypeConfig.readinessCheck')}</label>
                  <textarea value={form.readinessCheck} onChange={(e) => setForm({ ...form, readinessCheck: e.target.value })} className="input-field font-mono text-sm h-20 resize-none" placeholder='{"type": "http", "path": "/health", "timeout": 60}' />
                </div>
                <div className="mt-4">
                  <label className="block text-sm font-medium text-gray-700 mb-1">{t('agentTypeConfig.modifyModelCommand')}</label>
                  <textarea value={form.modifyModelCommand} onChange={(e) => setForm({ ...form, modifyModelCommand: e.target.value })} className="input-field font-mono text-sm h-24 resize-y" placeholder={'#!/bin/bash\n# Modify model script using ${MODEL_NAME}, ${MODEL_PROVIDER}, ${AI_GATEWAY_DOMAIN}, ${CONSUMER_API_KEY}'} />
                  <p className="text-xs text-gray-400 mt-1">{t('agentTypeConfig.modifyModelCommandHint')}</p>
                </div>
                {form.supportsChannels && (
                  <div className="mt-4">
                    <label className="block text-sm font-medium text-gray-700 mb-1">{t('agentTypeConfig.modifyChannelCommand')}</label>
                    <textarea value={form.modifyChannelCommand} onChange={(e) => setForm({ ...form, modifyChannelCommand: e.target.value })} className="input-field font-mono text-sm h-24 resize-y" placeholder={'#!/bin/bash\n# Modify channel script using ${CHANNEL_CONFIG_JSON}, ${CHANNEL_TYPE}'} />
                    <p className="text-xs text-gray-400 mt-1">{t('agentTypeConfig.modifyChannelCommandHint')}</p>
                  </div>
                )}
              </div>

              {/* 展示与行为 */}
              <div className="border-t border-gray-100 pt-4">
                <h3 className="text-sm font-semibold text-gray-800 mb-3 flex items-center space-x-2"><Settings className="w-4 h-4 text-gray-500" /><span>{t('agentTypeConfig.displayBehavior')}</span></h3>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">{t('agentTypeConfig.sortOrder')}</label>
                    <input type="number" value={form.sortOrder} onChange={(e) => setForm({ ...form, sortOrder: parseInt(e.target.value) || 0 })} className="input-field w-40" />
                    <p className="text-xs text-gray-400 mt-1">{t('agentTypeConfig.sortOrderHint')}</p>
                  </div>
                  <div>
                    <span className="mb-2 block text-sm font-medium text-gray-700">{t('agentTypeConfig.capabilities')}</span>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <label className={capabilityOptionClass(form.supportsChannels)}>
                        <input type="checkbox" checked={form.supportsChannels} onChange={(e) => setForm({ ...form, supportsChannels: e.target.checked })} className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500" id="supports-channels" />
                        <MessageSquare className={capabilityIconClass(form.supportsChannels)} />
                        <span className="min-w-0 text-sm font-medium leading-5">{t('agentTypeConfig.supportsChannels')}</span>
                      </label>
                      <label className={capabilityOptionClass(form.supportsEnvVars)}>
                        <input type="checkbox" checked={form.supportsEnvVars} onChange={(e) => setForm({ ...form, supportsEnvVars: e.target.checked })} className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500" id="supports-env-vars" />
                        <ShieldCheck className={capabilityIconClass(form.supportsEnvVars)} />
                        <span className="min-w-0 text-sm font-medium leading-5">{t('agentTypeConfig.supportsEnvVars')}</span>
                      </label>
                      <label className={capabilityOptionClass(form.supportsSkills)}>
                        <input type="checkbox" checked={form.supportsSkills} onChange={(e) => setForm({ ...form, supportsSkills: e.target.checked })} className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500" id="supports-skills" />
                        <Puzzle className={capabilityIconClass(form.supportsSkills)} />
                        <span className="min-w-0 text-sm font-medium leading-5">{t('agentTypeConfig.supportsSkills')}</span>
                      </label>
                      <label className={capabilityOptionClass(form.userTerminalEnabled)}>
                        <input type="checkbox" checked={form.userTerminalEnabled} onChange={(e) => setForm({ ...form, userTerminalEnabled: e.target.checked })} className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500" id="user-terminal-enabled" />
                        <Terminal className={capabilityIconClass(form.userTerminalEnabled)} />
                        <span className="min-w-0 text-sm font-medium leading-5">{t('agentTypeConfig.userTerminalEnabled')}</span>
                      </label>
                    </div>
                  </div>
                </div>
              </div>

              {/* AI 应用可观测配置 */}
              <div className="border-t border-gray-100 pt-4">
                <h3 className="text-sm font-semibold text-gray-900 flex items-center space-x-2 mb-4">
                  <span className="w-1 h-4 bg-teal-600 rounded-full"></span>
                  <span>{t('agentTypeConfig.observability.title', 'AI 应用可观测')}</span>
                </h3>

                {/* 采集开关 */}
                <div className="flex items-center gap-3 mb-4">
                  <button
                    type="button"
                    onClick={() => setObservabilityEnabled(!observabilityEnabled)}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${observabilityEnabled ? 'bg-teal-600' : 'bg-gray-300'}`}
                  >
                    <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${observabilityEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
                  </button>
                  <span className="text-sm text-gray-700">{observabilityEnabled ? t('agentTypeConfig.observability.enabled', '采集开启') : t('agentTypeConfig.observability.disabled', '采集关闭')}</span>
                </div>

                {/* KV 编辑器 */}
                <p className="text-xs text-gray-500 mb-2">{t('agentTypeConfig.observability.envHint', '可观测环境变量（可选，留空则由系统自动配置）')}</p>
                {observabilityEnv.length > 0 && (
                  <div className="border border-gray-200 rounded-lg overflow-hidden mb-3">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="text-left px-3 py-2 font-medium text-gray-600 w-1/3">{t('agentTypeConfig.observability.varName', '变量名')}</th>
                          <th className="text-left px-3 py-2 font-medium text-gray-600">{t('agentTypeConfig.observability.varValue', '变量值')}</th>
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
                                placeholder={t('agentTypeConfig.observability.valuePlaceholder', '值')}
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
                  {t('agentTypeConfig.observability.addVar', '添加变量')}
                </button>
              </div>
            </div>

            <div className="sticky bottom-0 bg-gray-50 border-t border-gray-200 px-6 py-4 flex justify-end space-x-3 rounded-b-xl">
              <button onClick={() => setShowCreateModal(false)} className="btn-secondary" disabled={saving}>{t('common:buttons.cancel')}</button>
              <button onClick={handleCreate} disabled={saving} className="btn-primary flex items-center space-x-2 disabled:opacity-50">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                <span>{saving ? t('agentTypeConfig.creating') : t('agentTypeConfig.create')}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default AgentTypeConfig
