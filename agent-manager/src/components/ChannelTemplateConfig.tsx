import React, { useState, useEffect } from 'react'
import { Settings, Plus, Edit2, Search, ToggleLeft, ToggleRight, Loader2, FileJson, X, Save } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../contexts/AuthContext'
import { apiUrl } from '../lib/api'

interface ChannelTemplate {
  id: string
  channel_type: 'feishu' | 'dingtalk' | 'qq' | 'wecom'
  name: string
  description?: string
  config_fields: ConfigField[]
  is_enabled: boolean
  created_at: string
}

interface ConfigField {
  name: string
  label: string
  type: 'text' | 'password' | 'textarea'
  required: boolean
  placeholder?: string
}

// 渠道图标组件
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

const ChannelTemplateConfig: React.FC = () => {
  const { t } = useTranslation('admin')
  const { session } = useAuth()

  const channelTypeOptions = [
    { value: 'feishu', label: t('channelTemplateConfig.channelType.feishu'), Icon: FeishuIcon, iconColor: 'text-blue-500', defaultName: t('channelTemplateConfig.channelDefaultName.feishu') },
    { value: 'dingtalk', label: t('channelTemplateConfig.channelType.dingtalk'), Icon: DingtalkIcon, iconColor: 'text-sky-500', defaultName: t('channelTemplateConfig.channelDefaultName.dingtalk') },
    { value: 'wecom', label: t('channelTemplateConfig.channelType.wecom'), Icon: WecomIcon, iconColor: 'text-green-500', defaultName: t('channelTemplateConfig.channelDefaultName.wecom') },
    { value: 'qq', label: t('channelTemplateConfig.channelType.qq'), Icon: QQIcon, iconColor: 'text-red-500', defaultName: t('channelTemplateConfig.channelDefaultName.qq') }
  ]

  const defaultConfigFields: ConfigField[] = [
    { name: 'clientId', label: 'Client ID', type: 'text', required: true, placeholder: t('channelTemplateConfig.configField.appId') },
    { name: 'clientSecret', label: 'Client Secret', type: 'password', required: true, placeholder: t('channelTemplateConfig.configField.appSecret') }
  ]

  const getDefaultName = (channelType: string) => {
    return channelTypeOptions.find(opt => opt.value === channelType)?.defaultName || channelType
  }

  const getChannelTypeLabel = (type: string) => {
    return channelTypeOptions.find(opt => opt.value === type)?.label || type
  }

  const getChannelTypeIcon = (type: string) => {
    const opt = channelTypeOptions.find(opt => opt.value === type)
    if (!opt) return null
    const { Icon, iconColor } = opt
    return <Icon className={`w-6 h-6 ${iconColor}`} />
  }

  const [templates, setTemplates] = useState<ChannelTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  const [showAddModal, setShowAddModal] = useState(false)
  const [editingTemplate, setEditingTemplate] = useState<ChannelTemplate | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [newTemplate, setNewTemplate] = useState({
    channelType: 'feishu',
    name: getDefaultName('feishu'),
    description: '',
    configFields: JSON.stringify(defaultConfigFields, null, 2)
  })

  // Channel config editor state
  const [editingConfigType, setEditingConfigType] = useState<string | null>(null)
  const [configText, setConfigText] = useState('')
  const [configFormat, setConfigFormat] = useState<'json' | 'yaml'>('json')
  const [configError, setConfigError] = useState('')
  const [configLoading, setConfigLoading] = useState(false)
  const [configSaving, setConfigSaving] = useState(false)

  const fetchTemplates = async () => {
    try {
      const token = session?.access_token
      if (!token) return

      const response = await fetch(`${apiUrl}/api/channel-templates`, {
        headers: { 'Authorization': `Bearer ${token}` }
      })
      const data = await response.json()

      if (data.success) {
        setTemplates(data.templates)
      }
    } catch (error) {
      console.error('Failed to fetch channel templates:', error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (session?.access_token) {
      fetchTemplates()
    }
  }, [session])

  const filteredTemplates = templates.filter(template =>
    template.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    template.channel_type.toLowerCase().includes(searchTerm.toLowerCase())
  )

  const handleToggleStatus = async (templateId: string) => {
    try {
      const token = session?.access_token
      if (!token) return

      const response = await fetch(`${apiUrl}/api/channel-templates/${templateId}/toggle`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}` }
      })
      const data = await response.json()

      if (data.success) {
        setTemplates(templates.map(item =>
          item.id === templateId ? data.template : item
        ))
      }
    } catch (error) {
      console.error('Failed to toggle template status:', error)
    }
  }

  const handleAddTemplate = async () => {
    if (!newTemplate.name || !newTemplate.channelType) {
      alert(t('channelTemplateConfig.validation.required'))
      return
    }

    try {
      let configFields
      try {
        configFields = JSON.parse(newTemplate.configFields)
      } catch {
        alert(t('channelTemplateConfig.validation.configFields'))
        return
      }

      setSubmitting(true)
      const token = session?.access_token
      if (!token) return

      const response = await fetch(`${apiUrl}/api/channel-templates`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          channelType: newTemplate.channelType,
          name: newTemplate.name,
          description: newTemplate.description,
          configFields,
          configFile: null
        })
      })
      const data = await response.json()

      if (data.success) {
        setTemplates([data.template, ...templates])
        setShowAddModal(false)
        setNewTemplate({
          channelType: 'feishu',
          name: '',
          description: '',
          configFields: JSON.stringify(defaultConfigFields, null, 2)
        })
      } else {
        alert(data.error || t('channelTemplateConfig.addFailed'))
      }
    } catch (error) {
      console.error('Failed to add template:', error)
      alert(t('channelTemplateConfig.addFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  const handleEditTemplate = (template: ChannelTemplate) => {
    setEditingTemplate({ ...template })
  }

  const handleSaveEdit = async () => {
    if (!editingTemplate) return

    try {
      setSubmitting(true)
      const token = session?.access_token
      if (!token) return

      const response = await fetch(`${apiUrl}/api/channel-templates/${editingTemplate.id}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: editingTemplate.name,
          description: editingTemplate.description
        })
      })
      const data = await response.json()

      if (data.success) {
        setTemplates(templates.map(item => item.id === editingTemplate.id ? data.template : item))
        setEditingTemplate(null)
      } else {
        alert(data.error || t('channelTemplateConfig.saveFailed'))
      }
    } catch (error) {
      console.error('Failed to update template:', error)
      alert(t('channelTemplateConfig.saveFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  // Open the config editor for a channel config
  const openConfigEditor = async (channelType: string) => {
    setEditingConfigType(channelType)
    setConfigError('')
    setConfigText('')
    setConfigFormat('json')
    setConfigLoading(true)
    try {
      const token = session?.access_token
      if (!token) return

      const fileName = `${channelType}-channel.json`
      const response = await fetch(`${apiUrl}/api/channel-config-files/${fileName}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      })
      const data = await response.json()

      if (data.success) {
        const fmt = data.format === 'yaml' ? 'yaml' : 'json'
        setConfigFormat(fmt)
        setConfigText(data.content || (fmt === 'json' ? '{}' : ''))
      } else {
        setConfigText('{}')
      }
    } catch (error) {
      console.error('Failed to load channel config:', error)
      setConfigText('{}')
    } finally {
      setConfigLoading(false)
    }
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
    if (!editingConfigType) return
    if (configError) {
      alert(configFormat === 'json' ? t('channelTemplateConfig.jsonFormatError') : t('channelTemplateConfig.fixErrorFirst'))
      return
    }

    if (configFormat === 'json') {
      try { JSON.parse(configText) } catch (e: any) { setConfigError(e.message); return }
    } else if (!configText.trim()) {
      setConfigError(t('channelTemplateConfig.yamlEmpty')); return
    }

    try {
      setConfigSaving(true)
      const token = session?.access_token
      if (!token) return

      const fileName = `${editingConfigType}-channel.json`
      const response = await fetch(`${apiUrl}/api/channel-config-files`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          fileName,
          content: configText,
          format: configFormat
        })
      })
      const data = await response.json()

      if (data.success) {
        setEditingConfigType(null)
      } else {
        alert(data.error || t('channelTemplateConfig.saveFailed'))
      }
    } catch (error) {
      console.error('Failed to save channel config:', error)
      alert(t('channelTemplateConfig.saveFailed'))
    } finally {
      setConfigSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-primary-600" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div className="relative w-96">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
          <input
            type="text"
            placeholder={t('channelTemplateConfig.searchPlaceholder')}
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
          <span>{t('channelTemplateConfig.addChannelTemplate')}</span>
        </button>
      </div>

      {/* Templates Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {filteredTemplates.map((template) => (
          <div key={template.id} className="card hover:shadow-lg transition-shadow">
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center space-x-3">
                <div className="p-3 rounded-lg bg-purple-100">
                  {getChannelTypeIcon(template.channel_type)}
                </div>
                <div>
                  <h3 className="font-semibold text-gray-900">{template.name}</h3>
                  <p className="text-sm text-gray-500">{getChannelTypeLabel(template.channel_type)}</p>
                </div>
              </div>
              <button
                onClick={() => handleToggleStatus(template.id)}
                className="text-gray-400 hover:text-gray-600"
              >
                {template.is_enabled ? (
                  <ToggleRight className="w-6 h-6 text-green-600" />
                ) : (
                  <ToggleLeft className="w-6 h-6" />
                )}
              </button>
            </div>

            <div className="space-y-2 mb-4">
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-500">{t('channelTemplateConfig.typeIdentifier')}</span>
                <span className="text-gray-700 font-mono text-xs">{template.channel_type}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-500">{t('channelTemplateConfig.status')}</span>
                <span className={`status-badge ${
                  template.is_enabled ? 'status-active' : 'status-inactive'
                }`}>
                  {template.is_enabled ? t('common:status.active') : t('common:status.disabled')}
                </span>
              </div>
              <div className="text-sm text-gray-500">
                {t('channelTemplateConfig.configFieldsCount', { count: template.config_fields?.length || 0 })}
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-500">{t('channelTemplateConfig.channelConfig')}</span>
                <span className="text-xs font-mono text-gray-400">{t('channelTemplateConfig.storageLocation')}</span>
              </div>
              {template.description && (
                <div className="text-sm text-gray-600 mt-2">
                  {template.description}
                </div>
              )}
            </div>

            <div className="flex items-center space-x-2 pt-4 border-t border-gray-100">
              <button
                onClick={() => handleEditTemplate(template)}
                className="flex-1 btn-secondary flex items-center justify-center space-x-1 py-2"
              >
                <Edit2 className="w-4 h-4" />
                <span>{t('common:buttons.edit')}</span>
              </button>
              <button
                onClick={() => openConfigEditor(template.channel_type)}
                className="flex-1 btn-secondary flex items-center justify-center space-x-1 py-2 text-blue-600 border-blue-200 hover:bg-blue-50"
              >
                <FileJson className="w-4 h-4" />
                <span>{t('channelTemplateConfig.channelConfigBtn')}</span>
              </button>
            </div>
          </div>
        ))}
      </div>

      {filteredTemplates.length === 0 && !loading && (
        <div className="text-center py-12">
          <Settings className="w-16 h-16 text-gray-300 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">{t('channelTemplateConfig.noChannelTemplates')}</h3>
          <p className="text-gray-500 mb-4">{t('channelTemplateConfig.noChannelTemplatesDesc')}</p>
          <button
            onClick={() => setShowAddModal(true)}
            className="btn-primary"
          >
            {t('channelTemplateConfig.addFirstTemplate')}
          </button>
        </div>
      )}

      {/* Add Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-lg">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">
              {t('channelTemplateConfig.addModal.title')}
            </h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('channelTemplateConfig.addModal.channelType')} <span className="text-red-500">*</span>
                </label>
                <select
                  value={newTemplate.channelType}
                  onChange={(e) => {
                    const channelType = e.target.value
                    setNewTemplate({
                      ...newTemplate,
                      channelType,
                      name: getDefaultName(channelType)
                    })
                  }}
                  className="input-field"
                >
                  {channelTypeOptions.map(opt => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('channelTemplateConfig.addModal.displayName')} <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={newTemplate.name}
                  onChange={(e) => setNewTemplate({ ...newTemplate, name: e.target.value })}
                  className="input-field"
                  placeholder={t('channelTemplateConfig.addModal.displayNamePlaceholder')}
                />
                <p className="text-xs text-gray-500 mt-1">
                  {t('channelTemplateConfig.addModal.displayNameHint')}
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('channelTemplateConfig.addModal.description')}
                </label>
                <input
                  type="text"
                  value={newTemplate.description}
                  onChange={(e) => setNewTemplate({ ...newTemplate, description: e.target.value })}
                  className="input-field"
                  placeholder={t('channelTemplateConfig.addModal.descriptionPlaceholder')}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('channelTemplateConfig.addModal.configFieldsJson')}
                </label>
                <textarea
                  value={newTemplate.configFields}
                  onChange={(e) => setNewTemplate({ ...newTemplate, configFields: e.target.value })}
                  className="input-field font-mono text-sm"
                  rows={8}
                />
                <p className="text-xs text-gray-500 mt-1">
                  {t('channelTemplateConfig.addModal.configFieldsHint')}
                </p>
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
                onClick={handleAddTemplate}
                className="btn-primary flex items-center space-x-2"
                disabled={submitting}
              >
                {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                <span>{t('channelTemplateConfig.add')}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {editingTemplate && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-md">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">
              {t('channelTemplateConfig.editModal.title')}
            </h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('channelTemplateConfig.editModal.displayName')}
                </label>
                <input
                  type="text"
                  value={editingTemplate.name}
                  onChange={(e) => setEditingTemplate({ ...editingTemplate, name: e.target.value })}
                  className="input-field"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('channelTemplateConfig.editModal.description')}
                </label>
                <input
                  type="text"
                  value={editingTemplate.description || ''}
                  onChange={(e) => setEditingTemplate({ ...editingTemplate, description: e.target.value })}
                  className="input-field"
                />
              </div>
            </div>
            <div className="flex justify-end space-x-3 mt-6">
              <button
                onClick={() => setEditingTemplate(null)}
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

      {/* Channel Config Editor Modal (JSON / YAML) */}
      {editingConfigType && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-2xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center space-x-2">
                <FileJson className="w-5 h-5 text-blue-600" />
                <h2 className="text-xl font-semibold text-gray-900">
                  {t('channelTemplateConfig.configEditor.title', { type: getChannelTypeLabel(editingConfigType) })}
                </h2>
              </div>
              <div className="flex items-center space-x-3">
                {/* Read-only format label: channel configs are stored in a fixed format (JSON or YAML)
                   determined at creation time. In-place JSON↔YAML conversion is not supported because
                   round-trip fidelity (comments, ordering) cannot be guaranteed. Users who need a
                   different format should re-create the channel template. */}
                <span className={`px-3 py-1 rounded text-xs font-medium ${configFormat === 'yaml' ? 'bg-amber-100 text-amber-800' : 'bg-gray-100 text-gray-900'}`}>{configFormat === 'yaml' ? 'YAML' : 'JSON'}</span>
                <button
                  onClick={() => setEditingConfigType(null)}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="mb-3 p-3 bg-blue-50 rounded-lg text-sm text-blue-700">
              <p className="font-medium mb-1">{t('channelTemplateConfig.configEditor.variableHint')}</p>
              <p className="font-mono text-xs">
                {'${CHANNEL_CLIENT_ID}'} {'${CHANNEL_CLIENT_SECRET}'} {'${GATEWAY_TOKEN}'} {'${DASHSCOPE_API_KEY}'}
              </p>
            </div>

            {configLoading ? (
              <div className="flex items-center justify-center h-48">
                <Loader2 className="w-6 h-6 animate-spin text-primary-600" />
              </div>
            ) : (
              <div className="flex-1 flex flex-col min-h-0">
                <textarea
                  value={configText}
                  onChange={(e) => handleConfigTextChange(e.target.value)}
                  placeholder={configFormat === 'yaml' ? 'feishu:\n  app_id: ${CHANNEL_CLIENT_ID}' : '{"feishu": {}}'}
                  className={`flex-1 input-field font-mono text-sm resize-none min-h-[300px] ${
                    configError ? 'border-red-400 focus:ring-red-300' : ''
                  }`}
                  spellCheck={false}
                />
                {configError && (
                  <p className="text-xs text-red-500 mt-1">{configError}</p>
                )}
              </div>
            )}

            <div className="flex justify-end space-x-3 mt-4">
              <button
                onClick={() => setEditingConfigType(null)}
                className="btn-secondary"
                disabled={configSaving}
              >
                {t('common:buttons.cancel')}
              </button>
              <button
                onClick={handleSaveConfig}
                className="btn-primary flex items-center space-x-2"
                disabled={configSaving || !!configError || configLoading}
              >
                {configSaving ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Save className="w-4 h-4" />
                )}
                <span>{t('channelTemplateConfig.configEditor.saveToDatabase')}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default ChannelTemplateConfig
