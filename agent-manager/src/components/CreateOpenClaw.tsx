import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Bot, Cpu, Plus, Loader2, MessageSquare, Users, QrCode, Settings } from 'lucide-react'
import toast from 'react-hot-toast'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../contexts/AuthContext'
import { apiUrl } from '../lib/api'
import DingtalkQRConfig from './DingtalkQRConfig'
import FeishuQRConfig from './FeishuQRConfig'
import WecomQRConfig from './WecomQRConfig'
import SkillSpaceSelect from './SkillSpaceSelect'

interface CreateOpenClawProps {
  mode?: 'user' | 'admin'
}

interface Model {
  id: string
  name: string
  provider: string
  model_code: string
  status: 'active' | 'disabled'
}

interface ChannelTemplate {
  id: string
  channel_type: 'feishu' | 'dingtalk' | 'qq' | 'wecom'
  name: string
  description?: string
  config_fields: ConfigField[]
  is_enabled: boolean
}

interface AgentType {
  id: string
  code: string
  name: string
  description?: string
  icon?: string
  category: 'builtin' | 'custom'
  supports_channels: boolean
  is_enabled: boolean
  custom_vars_schema?: { name: string; label: string; type: 'text' | 'password' | 'textarea'; required: boolean; placeholder?: string; description?: string }[] | null
  skill_config?: {
    pvName?: string
    mountPath: string
    subPath: string
    isRequired?: boolean
    skillSpaceId?: string
  }[] | null
}

interface ConfigField {
  name: string
  label: string
  type: 'text' | 'password' | 'textarea'
  required: boolean
  placeholder?: string
}

interface User {
  id: string
  username: string
  email: string
}

interface GroupOption {
  id: string
  name: string
  role: string | null
}

interface CreateInstanceRequestBody {
  name: string
  description: string | null
  agentTypeId?: string
  modelId: string
  configJson: {
    model: string
    channelType?: string
  }
  async: boolean
  channelType?: string
  channelClientId?: string
  channelClientSecret?: string
  groupId?: string
  userId?: string
}

// 暂未完全适配的 Agent 配置，前端限制不可选
const COMING_SOON_AGENT_CODES: string[] = []

function CreateOpenClaw({ mode = 'user' }: CreateOpenClawProps) {
  const navigate = useNavigate()
  const { session } = useAuth()
  const { t } = useTranslation(['admin', 'common'])
  const [agentTypes, setAgentTypes] = useState<AgentType[]>([])
  const [models, setModels] = useState<Model[]>([])
  const [channelTemplates, setChannelTemplates] = useState<ChannelTemplate[]>([])
  const [loadingAgentTypes, setLoadingAgentTypes] = useState(true)
  const [loadingModels, setLoadingModels] = useState(true)
  const [loadingChannels, setLoadingChannels] = useState(true)
  const [formData, setFormData] = useState({
    name: '',
    agentTypeId: '',
    model: '',
    groupId: '',
    channelType: '',
    channelConfig: {} as Record<string, string>,
    customVars: {} as Record<string, string>
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  // DingTalk scan-to-configure state
  const [showDingtalkQR, setShowDingtalkQR] = useState(false)
  const [dingtalkAutoConfigured, setDingtalkAutoConfigured] = useState(false)
  // Feishu scan-to-configure state
  const [showFeishuQR, setShowFeishuQR] = useState(false)
  const [feishuAutoConfigured, setFeishuAutoConfigured] = useState(false)
  // WeCom scan-to-configure state
  const [showWecomQR, setShowWecomQR] = useState(false)
  const [wecomAutoConfigured, setWecomAutoConfigured] = useState(false)

  // Admin mode state
  const [users, setUsers] = useState<User[]>([])
  const [groups, setGroups] = useState<GroupOption[]>([])
  const [loadingUsers, setLoadingUsers] = useState(false)
  const [loadingGroups, setLoadingGroups] = useState(false)
  const [selectedUserId, setSelectedUserId] = useState('')
  const [adminOwnershipType, setAdminOwnershipType] = useState<'user' | 'group'>('user')

  // Skill space selection state
  const [selectedSkillSpaceIds, setSelectedSkillSpaceIds] = useState<string[]>([])

  // Whether currently selected agent type supports channel configuration.
  // 语义与 OpenClawDetail 保持一致：仅当显式为 false 时隐藏，
  // null/undefined/true 均视为支持、避免历史数据（hermes/openclaw 可能为 null）
  // 被错误隐藏渠道配置。
  const supportsChannels = agentTypes.find(at => at.id === formData.agentTypeId)?.supports_channels !== false

  // Fetch models and channel templates from API
  useEffect(() => {
    const fetchData = async () => {
      try {
        const token = session?.access_token
        if (!token) {
          setLoadingAgentTypes(false)
          setLoadingModels(false)
          setLoadingChannels(false)
          setLoadingGroups(false)
          return
        }

        setLoadingGroups(true)

        // Fetch agent types, models, and accessible groups in parallel (channel templates loaded after agent type selection)
        const [agentTypesResponse, modelsResponse, groupsResponse] = await Promise.all([
          fetch(`${apiUrl}/api/agent-types`, { headers: { 'Authorization': `Bearer ${token}` } }),
          fetch(`${apiUrl}/api/models`, { headers: { 'Authorization': `Bearer ${token}` } }),
          fetch(`${apiUrl}/api/groups`, { headers: { 'Authorization': `Bearer ${token}` } })
        ])

        const [agentTypesData, modelsData, groupsData] = await Promise.all([
          agentTypesResponse.json(), modelsResponse.json(), groupsResponse.json()
        ])

        if (agentTypesData.success) {
          const enabledTypes = agentTypesData.agentTypes.filter((at: AgentType) => at.is_enabled)
          setAgentTypes(enabledTypes)
          // Default to first available (non-coming-soon) agent type.
          // 仅在用户尚未选择时设置，避免浏览器 tab 切换/token 自动刷新导致 session 引用
          // 变化时，把用户已选择的 agentTypeId 覆盖回第一个。
          const selectableTypes = enabledTypes.filter((at: AgentType) => !COMING_SOON_AGENT_CODES.includes(at.code))
          if (selectableTypes.length > 0) {
            setFormData(prev => prev.agentTypeId ? prev : { ...prev, agentTypeId: selectableTypes[0].id })
          }
        }

        if (modelsData.success) {
          setModels(modelsData.models.filter((m: Model) => m.status === 'active'))
        }

        if (groupsData.success) {
          setGroups(groupsData.groups || [])
        }

        // Channel templates are loaded by the second useEffect when agentTypeId changes,
        // no need to load all templates here.

        // Fetch users for admin mode
        if (mode === 'admin') {
          setLoadingUsers(true)
          const usersResponse = await fetch(`${apiUrl}/api/users?pageSize=100`, {
            headers: { 'Authorization': `Bearer ${token}` }
          })
          const usersData = await usersResponse.json()

          if (usersData.success) {
            setUsers(usersData.users || [])
          }
        }
      } catch (error) {
        console.error('Failed to fetch data:', error)
      } finally {
        setLoadingAgentTypes(false)
        setLoadingModels(false)
        setLoadingChannels(false)
        setLoadingUsers(false)
        setLoadingGroups(false)
      }
    }

    if (session?.access_token) {
      fetchData()
    }
    // 依赖使用 access_token 字符串而非 session 对象，避免 Supabase 在 tab 切换/
    // 自动刷新 token 时生成新的 session 引用导致 useEffect 重跑、表单状态被重置。
  }, [session?.access_token, mode])

  // Fetch channel templates when agent type changes
  useEffect(() => {
    const fetchChannelTemplates = async () => {
      if (!formData.agentTypeId || !session?.access_token) {
        setChannelTemplates([])
        return
      }
      // Skip loading when the selected agent type does not support channels
      const agentType = agentTypes.find(at => at.id === formData.agentTypeId)
      if (agentType && agentType.supports_channels === false) {
        setChannelTemplates([])
        setLoadingChannels(false)
        return
      }
      setLoadingChannels(true)
      try {
        const res = await fetch(
          `${apiUrl}/api/channel-templates?agentTypeId=${formData.agentTypeId}`,
          { headers: { 'Authorization': `Bearer ${session.access_token}` } }
        )
        const data = await res.json()
        if (data.success) {
          setChannelTemplates(data.templates.filter((ct: ChannelTemplate) => ct.is_enabled))
        } else {
          setChannelTemplates([])
        }
      } catch (error) {
        console.error('Failed to fetch channel templates:', error)
        setChannelTemplates([])
      } finally {
        setLoadingChannels(false)
      }
    }
    // 不在此处重置 channelType/channelConfig：清空逻辑改为在 agentType 切换按钮 onClick
    // 中执行，避免 session/agentTypes 引用变化时误清空用户已填写的渠道配置。
    fetchChannelTemplates()
  }, [formData.agentTypeId, session?.access_token, agentTypes])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    const newErrors: Record<string, string> = {}

    if (!formData.name.trim()) {
      newErrors.name = t('createOpenClaw.validation.nameRequired')
    }
    if (!formData.model) {
      newErrors.model = t('createOpenClaw.validation.modelRequired')
    }

    // Admin mode validation
    if (mode === 'admin' && adminOwnershipType === 'user' && !selectedUserId) {
      newErrors.userId = t('createOpenClaw.validation.userRequired')
    }
    if (mode === 'admin' && adminOwnershipType === 'group' && !formData.groupId) {
      newErrors.groupId = '请选择分组'
    }

    // Validate channel config fields only if channel is selected and supported
    if (supportsChannels && formData.channelType) {
      const selectedTemplate = channelTemplates.find(ct => ct.channel_type === formData.channelType)
      if (selectedTemplate) {
        for (const field of selectedTemplate.config_fields) {
          if (field.required && !formData.channelConfig[field.name]) {
            newErrors[`channel_${field.name}`] = t('createOpenClaw.validation.channelFieldRequired', { label: field.label })
          }
        }
      }
    }

    // Validate custom vars required fields
    const selectedAgentType = agentTypes.find(at => at.id === formData.agentTypeId)
    if (selectedAgentType?.custom_vars_schema && selectedAgentType.custom_vars_schema.length > 0) {
      for (const field of selectedAgentType.custom_vars_schema) {
        if (field.required && !formData.customVars[field.name]) {
          newErrors[`customVar_${field.name}`] = t('createOpenClaw.validation.customVarRequired', { label: field.label })
        }
      }
    }

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors)
      return
    }

    try {
      setSubmitting(true)

      const token = session?.access_token
      if (!token) {
        toast.error(t('createOpenClaw.notLoggedIn'))
        return
      }

      // Prepare request body with channel config if selected
      const requestBody: CreateInstanceRequestBody = {
        name: formData.name.trim(),
        description: null,
        agentTypeId: formData.agentTypeId || undefined,
        modelId: formData.model,
        configJson: {
          model: formData.model,
          ...(supportsChannels ? { channelType: formData.channelType } : {})
        },
        async: true
      }

      // Include channel config if selected and supported
      if (supportsChannels && formData.channelType && formData.channelConfig.clientId && formData.channelConfig.clientSecret) {
        requestBody.channelType = formData.channelType
        requestBody.channelClientId = formData.channelConfig.clientId
        requestBody.channelClientSecret = formData.channelConfig.clientSecret
      }

      // Include custom vars if the agent type defines them
      const agentTypeForVars = agentTypes.find(at => at.id === formData.agentTypeId)
      if (agentTypeForVars?.custom_vars_schema && agentTypeForVars.custom_vars_schema.length > 0 && Object.keys(formData.customVars).length > 0) {
        requestBody.customVars = formData.customVars
      }

      if (mode === 'admin') {
        if (adminOwnershipType === 'group' && formData.groupId) {
          requestBody.groupId = formData.groupId
        }
        if (adminOwnershipType === 'user' && selectedUserId) {
          requestBody.userId = selectedUserId
        }
      } else if (formData.groupId) {
        requestBody.groupId = formData.groupId
      }

      // Include selected skill space IDs
      if (selectedSkillSpaceIds.length > 0) {
        requestBody.selectedSkillSpaceIds = selectedSkillSpaceIds
      }
      const apiEndpoint = mode === 'admin'
        ? `${apiUrl}/api/admin/instances`
        : `${apiUrl}/api/instances`

      const response = await fetch(apiEndpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      })

      const data = await response.json()

      if (!data.success) {
        throw new Error(data.error || t('createOpenClaw.createFailed'))
      }

      toast.success(t('createOpenClaw.createSuccess'))
      const basePath = mode === 'admin' ? '/admin/instances' : '/user/instances'
      navigate(`${basePath}/${data.instance.id}`)

    } catch (error: unknown) {
      console.error('Error creating instance:', error)
      toast.error(error instanceof Error ? error.message : t('createOpenClaw.createFailedRetry'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center">
        <button
          onClick={() => navigate(mode === 'admin' ? '/admin/instances' : '/user/instances')}
          className="flex items-center space-x-2 text-gray-600 hover:text-gray-900"
        >
          <ArrowLeft className="w-5 h-5" />
          <span>{t('createOpenClaw.backToList')}</span>
        </button>
      </div>

      {/* Form */}
      <div className="card max-w-3xl">
        <div className="flex items-center space-x-3 mb-6">
          <div className="p-3 bg-primary-100 rounded-lg">
            <Bot className="w-6 h-6 text-primary-600" />
          </div>
          <div>
            <h2 className="text-xl font-semibold text-gray-900">{t('createOpenClaw.title')}</h2>
            <p className="text-sm text-gray-500">{t('createOpenClaw.subtitle')}</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          {mode === 'admin' ? (
            <div>
              <div className="flex items-center space-x-2 mb-3">
                <Users className="w-5 h-5 text-primary-600" />
                <label className="text-sm font-medium text-gray-700">
                  {t('createOpenClaw.instanceOwnership', '实例归属')} <span className="text-red-500">*</span>
                </label>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 max-w-lg">
                <button
                  type="button"
                  onClick={() => {
                    setAdminOwnershipType('user')
                    setFormData(prev => ({ ...prev, groupId: '' }))
                    setErrors(prev => ({ ...prev, groupId: '' }))
                  }}
                  className={`relative flex items-start gap-3 rounded-lg border-2 p-3.5 text-left transition-all ${
                    adminOwnershipType === 'user'
                      ? 'border-primary-500 bg-primary-50/60 ring-1 ring-primary-200'
                      : 'border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                    adminOwnershipType === 'user' ? 'bg-primary-100 text-primary-600' : 'bg-gray-100 text-gray-500'
                  }`}>
                    <Users className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <p className={`text-sm font-semibold ${adminOwnershipType === 'user' ? 'text-primary-700' : 'text-gray-800'}`}>
                      {t('createOpenClaw.ownerUser', '指定用户')}
                    </p>
                    <p className="mt-0.5 text-xs text-gray-500">{t('createOpenClaw.ownerUserDesc', '实例归属某位用户，仅该用户可管理')}</p>
                  </div>
                  {adminOwnershipType === 'user' && (
                    <span className="absolute right-2.5 top-2.5 h-2 w-2 rounded-full bg-primary-500" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAdminOwnershipType('group')
                    setSelectedUserId('')
                    setErrors(prev => ({ ...prev, userId: '' }))
                  }}
                  className={`relative flex items-start gap-3 rounded-lg border-2 p-3.5 text-left transition-all ${
                    adminOwnershipType === 'group'
                      ? 'border-primary-500 bg-primary-50/60 ring-1 ring-primary-200'
                      : 'border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                    adminOwnershipType === 'group' ? 'bg-primary-100 text-primary-600' : 'bg-gray-100 text-gray-500'
                  }`}>
                    <Cpu className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <p className={`text-sm font-semibold ${adminOwnershipType === 'group' ? 'text-primary-700' : 'text-gray-800'}`}>
                      {t('createOpenClaw.ownerGroup', '归属分组')}
                    </p>
                    <p className="mt-0.5 text-xs text-gray-500">{t('createOpenClaw.ownerGroupDesc', '实例归属某个分组，成员均可访问')}</p>
                  </div>
                  {adminOwnershipType === 'group' && (
                    <span className="absolute right-2.5 top-2.5 h-2 w-2 rounded-full bg-primary-500" />
                  )}
                </button>
              </div>

              <div className="mt-3 max-w-lg">
                {adminOwnershipType === 'user' ? (
                  <>
                    <select
                      value={selectedUserId}
                      onChange={(e) => {
                        setSelectedUserId(e.target.value)
                        if (errors.userId) setErrors(prev => ({ ...prev, userId: '' }))
                      }}
                      className={`input-field ${errors.userId ? 'border-red-500' : ''}`}
                      disabled={loadingUsers}
                    >
                      <option value="">{loadingUsers ? t('common:loading.default') : t('createOpenClaw.selectUserPlaceholder')}</option>
                      {users.map(user => (
                        <option key={user.id} value={user.id}>{user.username} ({user.email})</option>
                      ))}
                    </select>
                    {errors.userId && (
                      <p className="text-red-500 text-sm mt-1">{errors.userId}</p>
                    )}
                  </>
                ) : (
                  <>
                    <select
                      value={formData.groupId}
                      onChange={(e) => {
                        setFormData({ ...formData, groupId: e.target.value })
                        if (errors.groupId) setErrors(prev => ({ ...prev, groupId: '' }))
                      }}
                      className={`input-field ${errors.groupId ? 'border-red-500' : ''}`}
                      disabled={loadingGroups}
                    >
                      <option value="">{loadingGroups ? t('common:loading.default') : t('createOpenClaw.selectGroupPlaceholder', '请选择分组')}</option>
                      {groups.map(group => (
                        <option key={group.id} value={group.id}>
                          {group.name}
                        </option>
                      ))}
                    </select>
                    {errors.groupId && (
                      <p className="text-red-500 text-sm mt-1">{errors.groupId}</p>
                    )}
                  </>
                )}
              </div>
            </div>
          ) : (
            <div>
              <div className="flex items-center space-x-2 mb-2">
                <Users className="w-5 h-5 text-primary-600" />
                <label className="text-sm font-medium text-gray-700">
                  {t('createOpenClaw.instanceOwnership', '实例归属')}
                </label>
              </div>
              <select
                value={formData.groupId}
                onChange={(e) => setFormData({ ...formData, groupId: e.target.value })}
                className="input-field max-w-md"
                disabled={loadingGroups}
              >
                <option value="">
                  {loadingGroups ? t('common:loading.default') : t('createOpenClaw.privateOption', '👤 个人 — 仅自己可见')}
                </option>
                {groups.map(group => (
                  <option key={group.id} value={group.id}>
                    {t('createOpenClaw.groupOption', { name: group.name })}
                  </option>
                ))}
              </select>
              {formData.groupId && (
                <p className="text-xs text-amber-600 mt-1.5">
                  {t('createOpenClaw.groupOwnershipHint', '实例将归属于该分组，分组成员均可访问')}
                </p>
              )}
            </div>
          )}

          {/* Agent Type Selection */}
          <div>
            <div className="flex items-center space-x-2 mb-2">
              <Bot className="w-5 h-5 text-primary-600" />
              <label className="text-sm font-medium text-gray-700">
                {t('createOpenClaw.selectAgentConfig')} <span className="text-red-500">*</span>
              </label>
            </div>
            {loadingAgentTypes ? (
              <div className="flex items-center space-x-2 text-gray-500">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>{t('common:loading.default')}</span>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {agentTypes.map((agentType) => {
                  const isComingSoon = COMING_SOON_AGENT_CODES.includes(agentType.code)
                  return (
                    <button
                      key={agentType.id}
                      type="button"
                      onClick={() => {
                        if (isComingSoon) return
                        // 仅当切换到不同 agentType 时才清空渠道配置，避免重复点击同一项
                        // 或 tab 切换导致已填写的 channelConfig 丢失。
                        setFormData(prev => prev.agentTypeId === agentType.id
                          ? prev
                          : { ...prev, agentTypeId: agentType.id, channelType: '', channelConfig: {} })
                        setSelectedSkillSpaceIds([])
                      }}
                      disabled={isComingSoon}
                      className={`p-4 border-2 rounded-lg text-left transition-all ${
                        isComingSoon
                          ? 'border-gray-200 bg-gray-50 opacity-60 cursor-not-allowed'
                          : formData.agentTypeId === agentType.id
                            ? 'border-primary-500 bg-primary-50 shadow-sm'
                            : 'border-gray-200 hover:border-gray-300'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div className={`font-medium ${isComingSoon ? 'text-gray-400' : 'text-gray-900'}`}>{agentType.name}</div>
                        {isComingSoon && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">{t('createOpenClaw.comingSoon')}</span>
                        )}
                      </div>
                      {agentType.description && (
                        <div className={`text-xs mt-1 ${isComingSoon ? 'text-gray-400' : 'text-gray-500'}`}>{agentType.description}</div>
                      )}
                      <div className="mt-1">
                        <span className={`text-xs px-1.5 py-0.5 rounded ${
                          agentType.category === 'builtin'
                            ? isComingSoon ? 'bg-blue-50 text-blue-400' : 'bg-blue-100 text-blue-700'
                            : 'bg-gray-100 text-gray-600'
                        }`}>
                          {agentType.category === 'builtin' ? t('createOpenClaw.builtin') : t('createOpenClaw.custom')}
                        </span>
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {/* Skill Space Selection */}
          {(() => {
            const selectedAgentType = agentTypes.find(at => at.id === formData.agentTypeId)
            const skillConfig = selectedAgentType?.skill_config
            if (!skillConfig || !Array.isArray(skillConfig) || skillConfig.length === 0) return null
            const spacesWithId = skillConfig.filter(e => e.skillSpaceId)
            if (spacesWithId.length === 0) return null
            return (
              <SkillSpaceSelect
                skillConfig={skillConfig}
                selectedIds={selectedSkillSpaceIds}
                onChange={setSelectedSkillSpaceIds}
                token={session!.access_token}
              />
            )
          })()}

          {/* Name Input */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              {t('createOpenClaw.instanceName')} <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) => {
                setFormData({ ...formData, name: e.target.value })
                if (errors.name) setErrors(prev => ({ ...prev, name: '' }))
              }}
              placeholder={t('createOpenClaw.instanceNamePlaceholder')}
              className={`input-field ${errors.name ? 'border-red-500' : ''}`}
            />
            {errors.name && (
              <p className="text-red-500 text-sm mt-1">{errors.name}</p>
            )}
          </div>

          {/* Model Selection */}
          <div>
            <div className="flex items-center space-x-2 mb-2">
              <Cpu className="w-5 h-5 text-primary-600" />
              <label className="text-sm font-medium text-gray-700">
                {t('createOpenClaw.selectAiModel')} <span className="text-red-500">*</span>
              </label>
            </div>
            <select
              value={formData.model}
              onChange={(e) => {
                setFormData({ ...formData, model: e.target.value })
                if (errors.model) setErrors(prev => ({ ...prev, model: '' }))
              }}
              className={`input-field max-w-md ${errors.model ? 'border-red-500' : ''}`}
              disabled={loadingModels}
            >
              <option value="">{loadingModels ? t('common:loading.default') : t('createOpenClaw.selectModelPlaceholder')}</option>
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
            </select>
            {errors.model && (
              <p className="text-red-500 text-sm mt-1">{errors.model}</p>
            )}
          </div>

          {/* Channel Selection */}
          {supportsChannels && (
          <div>
            <div className="flex items-center space-x-2 mb-2">
              <MessageSquare className="w-5 h-5 text-primary-600" />
              <label className="text-sm font-medium text-gray-700">
                {t('createOpenClaw.selectChannel')} <span className="text-gray-400 font-normal">{t('createOpenClaw.channelOptional')}</span>
              </label>
            </div>
            <select
              value={formData.channelType}
              onChange={(e) => {
                const channelType = e.target.value
                setFormData({
                  ...formData,
                  channelType,
                  channelConfig: {}
                })
                if (errors.channelType) setErrors(prev => ({ ...prev, channelType: '' }))
              }}
              className={`input-field max-w-md ${errors.channelType ? 'border-red-500' : ''}`}
              disabled={loadingChannels}
            >
              <option value="">{loadingChannels ? t('common:loading.default') : t('createOpenClaw.noChannel')}</option>
              {channelTemplates.map((template) => (
                <option key={template.id} value={template.channel_type}>
                  {t(`admin:agentTypeDetail.channelType.${template.channel_type}`, template.name)}
                </option>
              ))}
            </select>
            {errors.channelType && (
              <p className="text-red-500 text-sm mt-1">{errors.channelType}</p>
            )}
          </div>
          )}

          {/* Channel Config Fields */}
          {supportsChannels && formData.channelType && (
            <div className="border border-gray-200 rounded-lg p-4 space-y-4">
              <h3 className="font-medium text-gray-900">{t('createOpenClaw.channelConfig')}</h3>

              {/* DingTalk: scan-to-configure option */}
              {formData.channelType === 'dingtalk' && !dingtalkAutoConfigured && (
                <div className="flex items-center space-x-3 mb-2">
                  <button
                    type="button"
                    onClick={() => setShowDingtalkQR(true)}
                    className="btn-primary flex items-center space-x-2 text-sm py-2 px-4"
                  >
                    <QrCode className="w-4 h-4" />
                    <span>扫码自动配置（推荐）</span>
                  </button>
                  <span className="text-xs text-gray-400">或手动填写以下字段</span>
                </div>
              )}

              {/* DingTalk: QR code scanning flow */}
              {formData.channelType === 'dingtalk' && showDingtalkQR && !dingtalkAutoConfigured && (
                <DingtalkQRConfig
                  onSuccess={(credentials) => {
                    setFormData({
                      ...formData,
                      channelConfig: {
                        ...formData.channelConfig,
                        clientId: credentials.clientId,
                        clientSecret: credentials.clientSecret || ''
                      }
                    })
                    setDingtalkAutoConfigured(true)
                    setShowDingtalkQR(false)
                    toast.success('钉钉渠道已自动配置成功！')
                  }}
                  onCancel={() => setShowDingtalkQR(false)}
                />
              )}

              {/* DingTalk: auto-configured success indicator */}
              {formData.channelType === 'dingtalk' && dingtalkAutoConfigured && (
                <div className="flex items-center space-x-2 p-3 bg-green-50 border border-green-200 rounded-lg">
                  <svg className="w-5 h-5 text-green-500" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                  </svg>
                  <span className="text-sm text-green-700 font-medium">钉钉渠道凭证已通过扫码自动获取</span>
                </div>
              )}

              {/* Feishu: scan-to-configure option */}
              {formData.channelType === 'feishu' && !feishuAutoConfigured && (
                <div className="flex items-center space-x-3 mb-2">
                  <button
                    type="button"
                    onClick={() => setShowFeishuQR(true)}
                    className="btn-primary flex items-center space-x-2 text-sm py-2 px-4"
                  >
                    <QrCode className="w-4 h-4" />
                    <span>扫码自动配置（推荐）</span>
                  </button>
                  <span className="text-xs text-gray-400">或手动填写以下字段</span>
                </div>
              )}

              {/* Feishu: QR code scanning flow */}
              {formData.channelType === 'feishu' && showFeishuQR && !feishuAutoConfigured && (
                <FeishuQRConfig
                  onSuccess={(credentials) => {
                    setFormData({
                      ...formData,
                      channelConfig: {
                        ...formData.channelConfig,
                        clientId: credentials.clientId,
                        clientSecret: credentials.clientSecret || ''
                      }
                    })
                    setFeishuAutoConfigured(true)
                    setShowFeishuQR(false)
                    toast.success('飞书渠道已自动配置成功！')
                  }}
                  onCancel={() => setShowFeishuQR(false)}
                />
              )}

              {/* Feishu: auto-configured success indicator */}
              {formData.channelType === 'feishu' && feishuAutoConfigured && (
                <div className="flex items-center space-x-2 p-3 bg-green-50 border border-green-200 rounded-lg">
                  <svg className="w-5 h-5 text-green-500" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                  </svg>
                  <span className="text-sm text-green-700 font-medium">飞书渠道凭证已通过扫码自动获取</span>
                </div>
              )}

              {/* WeCom: scan-to-configure option */}
              {formData.channelType === 'wecom' && !wecomAutoConfigured && (
                <div className="flex items-center space-x-3 mb-2">
                  <button
                    type="button"
                    onClick={() => setShowWecomQR(true)}
                    className="btn-primary flex items-center space-x-2 text-sm py-2 px-4"
                  >
                    <QrCode className="w-4 h-4" />
                    <span>扫码自动配置（推荐）</span>
                  </button>
                  <span className="text-xs text-gray-400">或手动填写以下字段</span>
                </div>
              )}

              {/* WeCom: QR code scanning flow */}
              {formData.channelType === 'wecom' && showWecomQR && !wecomAutoConfigured && (
                <WecomQRConfig
                  onSuccess={(credentials) => {
                    setFormData({
                      ...formData,
                      channelConfig: {
                        ...formData.channelConfig,
                        clientId: credentials.clientId,
                        clientSecret: credentials.clientSecret || ''
                      }
                    })
                    setWecomAutoConfigured(true)
                    setShowWecomQR(false)
                    toast.success('企业微信渠道已自动配置成功！')
                  }}
                  onCancel={() => setShowWecomQR(false)}
                />
              )}

              {/* WeCom: auto-configured success indicator */}
              {formData.channelType === 'wecom' && wecomAutoConfigured && (
                <div className="flex items-center space-x-2 p-3 bg-green-50 border border-green-200 rounded-lg">
                  <svg className="w-5 h-5 text-green-500" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                  </svg>
                  <span className="text-sm text-green-700 font-medium">企业微信渠道凭证已通过扫码自动获取</span>
                </div>
              )}

              {/* Manual config fields (hidden when auto-configured or QR is showing) */}
              {!(formData.channelType === 'dingtalk' && (showDingtalkQR || dingtalkAutoConfigured)) &&
               !(formData.channelType === 'feishu' && (showFeishuQR || feishuAutoConfigured)) &&
               !(formData.channelType === 'wecom' && (showWecomQR || wecomAutoConfigured)) && (
                channelTemplates
                  .find(ct => ct.channel_type === formData.channelType)
                  ?.config_fields.map((field) => (
                    <div key={field.name}>
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        {t(`createOpenClaw.channelFields.${field.name}.label`, field.label)} {field.required && <span className="text-red-500">*</span>}
                      </label>
                      <input
                        type={field.type}
                        value={formData.channelConfig[field.name] || ''}
                        onChange={(e) => {
                          setFormData({
                            ...formData,
                            channelConfig: {
                              ...formData.channelConfig,
                              [field.name]: e.target.value
                            }
                          })
                          if (errors[`channel_${field.name}`]) {
                            setErrors(prev => ({ ...prev, [`channel_${field.name}`]: '' }))
                          }
                        }}
                        placeholder={t(`createOpenClaw.channelFields.${field.name}.placeholder`, field.placeholder)}
                        className={`input-field ${errors[`channel_${field.name}`] ? 'border-red-500' : ''}`}
                      />
                      {errors[`channel_${field.name}`] && (
                        <p className="text-red-500 text-sm mt-1">{errors[`channel_${field.name}`]}</p>
                      )}
                    </div>
                  ))
              )}
            </div>
          )}

          {/* Custom Variables Section */}
          {(() => {
            const currentAgentType = agentTypes.find(at => at.id === formData.agentTypeId)
            const schema = currentAgentType?.custom_vars_schema
            if (!schema || schema.length === 0) return null
            return (
              <div>
                <div className="flex items-center space-x-2 mb-3">
                  <Settings className="w-5 h-5 text-purple-600" />
                  <label className="text-sm font-medium text-gray-700">
                    {t('createOpenClaw.customVarsSection')}
                  </label>
                </div>
                <div className="space-y-3">
                  {schema.map((field) => (
                    <div key={field.name}>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        {field.label}
                        {field.required && <span className="text-red-500 ml-1">*</span>}
                      </label>
                      {field.description && (
                        <p className="text-xs text-gray-400 mb-1">{field.description}</p>
                      )}
                      {field.type === 'textarea' ? (
                        <textarea
                          value={formData.customVars[field.name] || ''}
                          onChange={(e) => {
                            setFormData({
                              ...formData,
                              customVars: { ...formData.customVars, [field.name]: e.target.value }
                            })
                            if (errors[`customVar_${field.name}`]) {
                              setErrors(prev => ({ ...prev, [`customVar_${field.name}`]: '' }))
                            }
                          }}
                          placeholder={field.placeholder}
                          className={`input-field h-20 resize-y ${errors[`customVar_${field.name}`] ? 'border-red-500' : ''}`}
                        />
                      ) : (
                        <input
                          type={field.type === 'password' ? 'password' : 'text'}
                          value={formData.customVars[field.name] || ''}
                          onChange={(e) => {
                            setFormData({
                              ...formData,
                              customVars: { ...formData.customVars, [field.name]: e.target.value }
                            })
                            if (errors[`customVar_${field.name}`]) {
                              setErrors(prev => ({ ...prev, [`customVar_${field.name}`]: '' }))
                            }
                          }}
                          placeholder={field.placeholder}
                          className={`input-field ${errors[`customVar_${field.name}`] ? 'border-red-500' : ''}`}
                        />
                      )}
                      {errors[`customVar_${field.name}`] && (
                        <p className="text-red-500 text-sm mt-1">{errors[`customVar_${field.name}`]}</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )
          })()}

          {/* Submit Button */}
          <div className="flex justify-end space-x-3 pt-6 border-t border-gray-200">
            <button
              type="button"
              onClick={() => navigate(mode === 'admin' ? '/admin/instances' : '/user/instances')}
              className="btn-secondary"
            >
              {t('common:buttons.cancel')}
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="btn-primary flex items-center space-x-2 disabled:opacity-50"
            >
              {submitting ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <Plus className="w-5 h-5" />
              )}
              <span>{submitting ? t('createOpenClaw.creating') : t('createOpenClaw.createInstance')}</span>
            </button>
          </div>
        </form>
      </div>

      {/* Tips */}
      <div className="card bg-blue-50 border-blue-200">
        <h3 className="font-medium text-blue-900 mb-2">{t('createOpenClaw.tips.title')}</h3>
        <ul className="text-sm text-blue-800 space-y-1">
          <li>• {t('createOpenClaw.tips.tip1')}</li>
          <li>• {t('createOpenClaw.tips.tip2')}</li>
          <li>• {t('createOpenClaw.tips.tip3')}</li>
        </ul>
      </div>
    </div>
  )
}

export default CreateOpenClaw
