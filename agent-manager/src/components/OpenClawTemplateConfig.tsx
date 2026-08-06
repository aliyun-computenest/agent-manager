import React, { useState, useEffect } from 'react'
import { Upload, FileJson, Eye, Copy, Check, Trash2, Download, Save, Loader2, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../contexts/AuthContext'
import { apiUrl } from '../lib/api'

interface TemplateData {
  content: Record<string, unknown>
  updatedAt?: string
  updatedBy?: string
}

const OpenClawTemplateConfig: React.FC = () => {
  const { t } = useTranslation('admin')
  const { session } = useAuth()
  const [activeTab, setActiveTab] = useState<'upload' | 'preview'>('upload')
  const [template, setTemplate] = useState<TemplateData | null>(null)
  const [jsonText, setJsonText] = useState('')
  const [error, setError] = useState('')
  const [successMessage, setSuccessMessage] = useState('')
  const [copied, setCopied] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // Load template from backend on mount
  useEffect(() => {
    if (session?.access_token) {
      loadTemplate()
    }
  }, [session])

  const loadTemplate = async () => {
    setLoading(true)
    setError('')
    try {
      const token = session?.access_token
      if (!token) {
        setError(t('openClawTemplateConfig.notLoggedIn'))
        setLoading(false)
        return
      }

      const response = await fetch(`${apiUrl}/api/template`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || t('openClawTemplateConfig.loadFailed'))
      }

      if (data.exists && data.template) {
        // Handle both _meta (our format) and meta (existing format)
        const { _meta, ...rest } = data.template
        const displayTemplate = rest

        // Get update info from _meta or meta field
        const metaInfo = _meta || data.template.meta

        setTemplate({
          content: displayTemplate,
          updatedAt: metaInfo?.updatedAt || metaInfo?.lastTouchedAt || data.updatedAt,
          updatedBy: metaInfo?.updatedBy
        })
        setJsonText(JSON.stringify(displayTemplate, null, 2))
        setActiveTab('preview')
      } else {
        setTemplate(null)
        setJsonText('')
      }
    } catch (err) {
      console.error('Load template error:', err)
      setError(err instanceof Error ? err.message : t('openClawTemplateConfig.loadFailed'))
    } finally {
      setLoading(false)
    }
  }

  const saveTemplate = async (content: Record<string, unknown>) => {
    setSaving(true)
    setError('')
    setSuccessMessage('')
    try {
      const token = session?.access_token
      if (!token) {
        throw new Error(t('openClawTemplateConfig.notLoggedIn'))
      }

      const response = await fetch(`${apiUrl}/api/template`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ template: content })
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || t('openClawTemplateConfig.saveFailed'))
      }

      setTemplate({
        content,
        updatedAt: data.updatedAt
      })
      setSuccessMessage(t('openClawTemplateConfig.saveSuccess'))
      setTimeout(() => setSuccessMessage(''), 3000)
    } catch (err) {
      console.error('Save template error:', err)
      setError(err instanceof Error ? err.message : t('openClawTemplateConfig.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const deleteTemplate = async () => {
    if (!confirm(t('openClawTemplateConfig.confirmDelete'))) return

    setSaving(true)
    setError('')
    try {
      const token = session?.access_token
      if (!token) {
        throw new Error(t('openClawTemplateConfig.notLoggedIn'))
      }

      const response = await fetch(`${apiUrl}/api/template`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || t('openClawTemplateConfig.deleteFailed'))
      }

      setTemplate(null)
      setJsonText('')
      setActiveTab('upload')
      setSuccessMessage(t('openClawTemplateConfig.deleteSuccess'))
      setTimeout(() => setSuccessMessage(''), 3000)
    } catch (err) {
      console.error('Delete template error:', err)
      setError(err instanceof Error ? err.message : t('openClawTemplateConfig.deleteFailed'))
    } finally {
      setSaving(false)
    }
  }

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      processFile(file)
    }
  }

  const processFile = (file: File) => {
    if (!file.name.endsWith('.json')) {
      setError(t('openClawTemplateConfig.uploadJsonOnly'))
      return
    }

    const reader = new FileReader()
    reader.onload = async (event) => {
      try {
        const content = JSON.parse(event.target?.result as string)
        setJsonText(JSON.stringify(content, null, 2))
        setError('')
        // Save to backend
        await saveTemplate(content)
        setActiveTab('preview')
      } catch {
        setError(t('openClawTemplateConfig.jsonParseFailed'))
      }
    }
    reader.readAsText(file)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) {
      processFile(file)
    }
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }

  const handleDragLeave = () => {
    setIsDragging(false)
  }

  const handleTextInput = async () => {
    try {
      const content = JSON.parse(jsonText)
      setError('')
      // Save to backend
      await saveTemplate(content)
      setActiveTab('preview')
    } catch {
      setError(t('openClawTemplateConfig.jsonFormatError'))
    }
  }

  const handleCopy = async () => {
    await navigator.clipboard.writeText(jsonText)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleDownload = () => {
    const blob = new Blob([jsonText], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'openclaw-template.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  const downloadSampleTemplate = async () => {
    try {
      const token = session?.access_token
      if (!token) {
        setError(t('openClawTemplateConfig.notLoggedIn'))
        return
      }

      const response = await fetch(`${apiUrl}/api/template/example`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || t('openClawTemplateConfig.downloadExampleFailed'))
      }

      const blob = new Blob([JSON.stringify(data.template, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'openclaw-template-example.json'
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('Download example template error:', err)
      setError(err instanceof Error ? err.message : t('openClawTemplateConfig.downloadExampleFailed'))
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-primary-600" />
        <span className="ml-3 text-gray-600">{t('openClawTemplateConfig.loading')}</span>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header with Tabs */}
      <div className="flex items-center justify-between">
        <div className="flex space-x-1 bg-gray-100 p-1 rounded-lg">
          <button
            onClick={() => setActiveTab('upload')}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
              activeTab === 'upload'
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            <Upload className="w-4 h-4 inline-block mr-2" />
            {t('openClawTemplateConfig.uploadConfig')}
          </button>
          <button
            onClick={() => setActiveTab('preview')}
            disabled={!template}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
              activeTab === 'preview'
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-600 hover:text-gray-900 disabled:text-gray-400 disabled:cursor-not-allowed'
            }`}
          >
            <Eye className="w-4 h-4 inline-block mr-2" />
            {t('openClawTemplateConfig.previewConfig')}
          </button>
        </div>

        <div className="flex items-center space-x-2">
          <button
            onClick={loadTemplate}
            className="btn-secondary flex items-center space-x-2"
            disabled={loading}
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            <span>{t('openClawTemplateConfig.refresh')}</span>
          </button>
          <button
            onClick={downloadSampleTemplate}
            className="btn-secondary flex items-center space-x-2"
          >
            <Download className="w-4 h-4" />
            <span>{t('openClawTemplateConfig.downloadExample')}</span>
          </button>
        </div>
      </div>

      {/* Success Message */}
      {successMessage && (
        <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg flex items-center">
          <Check className="w-5 h-5 mr-2" />
          {successMessage}
        </div>
      )}

      {/* Error Message */}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
          {error}
        </div>
      )}

      {/* Upload Tab */}
      {activeTab === 'upload' && (
        <div className="space-y-6">
          {/* Drag & Drop Zone */}
          <div
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            className={`border-2 border-dashed rounded-xl p-12 text-center transition-colors ${
              isDragging
                ? 'border-primary-500 bg-primary-50'
                : 'border-gray-300 hover:border-gray-400'
            }`}
          >
            <FileJson className={`w-16 h-16 mx-auto mb-4 ${
              isDragging ? 'text-primary-500' : 'text-gray-400'
            }`} />
            <p className="text-lg font-medium text-gray-700 mb-2">
              {t('openClawTemplateConfig.dragDrop')}
            </p>
            <p className="text-gray-500 mb-4">{t('common:or')}</p>
            <label className="btn-primary cursor-pointer inline-flex items-center space-x-2">
              <Upload className="w-4 h-4" />
              <span>{t('openClawTemplateConfig.selectFile')}</span>
              <input
                type="file"
                accept=".json"
                onChange={handleFileUpload}
                className="hidden"
              />
            </label>
          </div>

          {/* Or Paste JSON */}
          <div className="card">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">
              {t('openClawTemplateConfig.orPaste')}
            </h3>
            <textarea
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
              placeholder='{"meta": {...}, "models": {...}, "agents": {...}, "commands": {...}, "gateway": {...}}'
              className="input-field font-mono text-sm h-48 resize-none"
            />
            <div className="mt-4 flex justify-end">
              <button
                onClick={handleTextInput}
                disabled={!jsonText.trim() || saving}
                className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed flex items-center space-x-2"
              >
                {saving ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>{t('openClawTemplateConfig.saving')}</span>
                  </>
                ) : (
                  <>
                    <Save className="w-4 h-4" />
                    <span>{t('openClawTemplateConfig.parseAndSave')}</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Preview Tab */}
      {activeTab === 'preview' && template && (
        <div className="space-y-6">
          {/* Template Info Card */}
          <div className="card">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center space-x-3">
                <div className="p-3 bg-primary-100 rounded-lg">
                  <FileJson className="w-6 h-6 text-primary-600" />
                </div>
                <div>
                  <h3 className="font-semibold text-gray-900">openclaw-template.json</h3>
                  <p className="text-sm text-gray-500">
                    {template.updatedAt && (
                      <>{t('openClawTemplateConfig.updatedAt')} {new Date(template.updatedAt).toLocaleString()}</>
                    )}
                    {template.updatedBy && (
                      <span className="ml-2">by {template.updatedBy}</span>
                    )}
                  </p>
                  <p className="text-xs text-gray-400 mt-1">
                    {t('openClawTemplateConfig.storageLocation')}
                  </p>
                </div>
              </div>
              <div className="flex items-center space-x-2">
                <button
                  onClick={handleCopy}
                  className="btn-secondary flex items-center space-x-1"
                >
                  {copied ? (
                    <>
                      <Check className="w-4 h-4 text-green-600" />
                      <span>{t('openClawTemplateConfig.copied')}</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-4 h-4" />
                      <span>{t('openClawTemplateConfig.copy')}</span>
                    </>
                  )}
                </button>
                <button
                  onClick={handleDownload}
                  className="btn-secondary flex items-center space-x-1"
                >
                  <Download className="w-4 h-4" />
                  <span>{t('openClawTemplateConfig.download')}</span>
                </button>
                <button
                  onClick={deleteTemplate}
                  disabled={saving}
                  className="px-3 py-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors flex items-center space-x-1 disabled:opacity-50"
                >
                  {saving ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Trash2 className="w-4 h-4" />
                  )}
                  <span>{t('common:buttons.delete')}</span>
                </button>
              </div>
            </div>

            {/* JSON Preview with Syntax Highlighting */}
            <div className="bg-gray-900 rounded-lg p-4 overflow-auto max-h-[600px]">
              <pre className="text-sm text-gray-100 font-mono whitespace-pre-wrap">
                {jsonText}
              </pre>
            </div>
          </div>

          {/* Parsed Structure */}
          <div className="card">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">{t('openClawTemplateConfig.structurePreview')}</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {Object.entries(template.content).map(([key, value]) => (
                <div key={key} className="bg-gray-50 rounded-lg p-4">
                  <h4 className="font-medium text-gray-700 mb-2">{key}</h4>
                  <p className="text-sm text-gray-500">
                    {typeof value === 'object'
                      ? (Array.isArray(value)
                        ? t('openClawTemplateConfig.arrayType', { count: value.length })
                        : t('openClawTemplateConfig.objectType', { count: Object.keys(value as object).length }))
                      : String(value)
                    }
                  </p>
                </div>
              ))}
            </div>
          </div>

          {/* Edit Section */}
          <div className="card">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">{t('openClawTemplateConfig.editConfig')}</h3>
            <textarea
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
              className="input-field font-mono text-sm h-64 resize-none"
            />
            <div className="mt-4 flex justify-end">
              <button
                onClick={handleTextInput}
                disabled={!jsonText.trim() || saving}
                className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed flex items-center space-x-2"
              >
                {saving ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>{t('openClawTemplateConfig.saving')}</span>
                  </>
                ) : (
                  <>
                    <Save className="w-4 h-4" />
                    <span>{t('openClawTemplateConfig.saveChanges')}</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Empty State for Preview */}
      {activeTab === 'preview' && !template && (
        <div className="card text-center py-12">
          <FileJson className="w-16 h-16 text-gray-300 mx-auto mb-4" />
          <p className="text-gray-500">{t('openClawTemplateConfig.noTemplate')}</p>
          <button
            onClick={() => setActiveTab('upload')}
            className="btn-primary mt-4"
          >
            {t('openClawTemplateConfig.goUpload')}
          </button>
        </div>
      )}
    </div>
  )
}

export default OpenClawTemplateConfig
