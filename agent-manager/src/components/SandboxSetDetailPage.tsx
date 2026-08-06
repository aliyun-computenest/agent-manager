import React, { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Boxes, Check, Copy, Loader2, Save, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../contexts/AuthContext'
import {
  createSandboxSet,
  deleteSandboxSet,
  getSandboxSet,
  saveSandboxSet,
  type SandboxSetDetail,
} from '../lib/sandboxsets'

const DEFAULT_NAMESPACE = 'default'

interface FormState {
  name: string
  namespace: string
  yaml: string
}

function toForm(detail: SandboxSetDetail): FormState {
  return { name: detail.name, namespace: detail.namespace, yaml: detail.yaml }
}

const emptyForm: FormState = {
  name: '',
  namespace: DEFAULT_NAMESPACE,
  yaml: '',
}

const SandboxSetDetailPage: React.FC = () => {
  const { name } = useParams<{ name: string }>()
  const [searchParams] = useSearchParams()
  const namespace = searchParams.get('ns') || DEFAULT_NAMESPACE
  const navigate = useNavigate()
  const { session } = useAuth()
  const { t } = useTranslation('admin')
  const isNew = !name || name === 'new'

  const token = session?.access_token

  const [loading, setLoading] = useState(!isNew)
  const [notFound, setNotFound] = useState(false)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [original, setOriginal] = useState<SandboxSetDetail | null>(null)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [copied, setCopied] = useState(false)
  const [saving, setSaving] = useState(false)

  const fetchDetail = useCallback(async () => {
    if (isNew || !token || !name) return
    setLoading(true)
    try {
      const detail = await getSandboxSet(name, token, namespace)
      if (!detail) {
        setNotFound(true)
        return
      }
      setOriginal(detail)
      setForm(toForm(detail))
    } catch (err: any) {
      setError(err.message || t('sandboxsetDetail.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [name, isNew, token, namespace, t])

  useEffect(() => {
    if (isNew) {
      setForm(emptyForm)
      setOriginal(null)
      return
    }
    fetchDetail()
  }, [isNew, fetchDetail])

  const handleSave = async () => {
    if (!token) return
    setError('')
    setSuccess('')
    if (isNew && !form.name.trim()) {
      setError(t('sandboxsetDetail.validation.nameRequired'))
      return
    }
    if (!form.yaml.trim()) {
      setError(t('sandboxsetDetail.validation.yamlRequired'))
      return
    }

    setSaving(true)
    try {
      if (isNew) {
        await createSandboxSet({
          name: form.name.trim(),
          namespace: form.namespace.trim() || DEFAULT_NAMESPACE,
          yaml: form.yaml,
        }, token)
        setSuccess(t('sandboxsetDetail.createSuccess'))
        navigate(`/admin/sandboxsets/${form.name.trim()}?ns=${form.namespace.trim() || DEFAULT_NAMESPACE}`, { replace: true })
        return
      }

      if (!original) return
      const updated = await saveSandboxSet(original.name, form.yaml, token, original.namespace)
      setOriginal(updated)
      setSuccess(t('sandboxsetDetail.saveSuccess'))
    } catch (e: any) {
      setError(e?.message || t('sandboxsetDetail.operationFailed'))
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!original || !token) return
    if (!window.confirm(t('sandboxsetDetail.confirmDelete', { name: original.name }))) return
    try {
      await deleteSandboxSet(original.name, token, original.namespace)
      navigate('/admin/sandboxsets')
    } catch (err: any) {
      setError(err.message || t('sandboxsetDetail.deleteFailed'))
    }
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(form.yaml)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // ignore
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-primary-600" />
        <span className="ml-3 text-gray-600">{t('sandboxsetDetail.loading')}</span>
      </div>
    )
  }

  if (notFound) {
    return (
      <div className="card text-center py-12">
        <Boxes className="w-12 h-12 text-gray-300 mx-auto mb-3" />
        <p className="text-gray-500">{t('sandboxsetDetail.notFound', { name })}</p>
        <button onClick={() => navigate('/admin/sandboxsets')} className="btn-primary mt-4">{t('sandboxsetDetail.backToList')}</button>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center space-x-3">
        <button onClick={() => navigate('/admin/sandboxsets')} className="p-2 rounded-lg hover:bg-gray-100">
          <ArrowLeft className="w-5 h-5 text-gray-600" />
        </button>
        <div className="flex-1">
          <div className="flex items-center space-x-2">
            <Boxes className="w-5 h-5 text-primary-600" />
            <h2 className="text-xl font-semibold text-gray-900">
              {isNew ? t('sandboxsetDetail.newTitle') : t('sandboxsetDetail.editTitle', { name: form.name })}
            </h2>
            {!isNew && (
              <span className="text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">ns: {form.namespace}</span>
            )}
          </div>
          <p className="text-sm text-gray-500 mt-0.5">
            {isNew ? t('sandboxsetDetail.newSubtitle') : t('sandboxsetDetail.editSubtitle')}
          </p>
        </div>
        {!isNew && (
          <button
            onClick={handleDelete}
            className="inline-flex items-center space-x-1.5 px-3 py-2 text-sm font-medium text-red-600 border border-red-200 rounded-lg hover:bg-red-50"
          >
            <Trash2 className="w-4 h-4" />
            <span>{t('sandboxsetDetail.deleteButton')}</span>
          </button>
        )}
      </div>

      {success && (
        <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg text-sm">{success}</div>
      )}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">{error}</div>
      )}

      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
        {t('sandboxsetDetail.warning')}
      </div>

      {isNew && (
        <div className="card">
          <h3 className="text-sm font-semibold text-gray-800 mb-4">{t('sandboxsetDetail.basicInfo')}</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{t('sandboxsetDetail.nameLabel')}</label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder={t('sandboxsetDetail.namePlaceholder')}
                className="input-field"
              />
              <p className="text-xs text-gray-400 mt-1">{t('sandboxsetDetail.nameHint')}</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{t('sandboxsetDetail.namespaceLabel')}</label>
              <input
                type="text"
                value={form.namespace}
                onChange={(e) => setForm({ ...form, namespace: e.target.value })}
                className="input-field"
              />
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-800">{t('sandboxsetDetail.yamlLabel')}</h3>
          <button
            onClick={handleCopy}
            className="btn-secondary flex items-center gap-2"
          >
            {copied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
            <span>{copied ? t('sandboxsetDetail.copied') : t('sandboxsetDetail.copy')}</span>
          </button>
        </div>
        <textarea
          value={form.yaml}
          onChange={(e) => setForm({ ...form, yaml: e.target.value })}
          className="input-field font-mono text-xs leading-5 h-96 resize-y"
          placeholder={t('sandboxsetDetail.yamlPlaceholder')}
        />
      </div>

      <div className="flex justify-end space-x-3">
        <button onClick={() => navigate('/admin/sandboxsets')} className="btn-secondary">{t('sandboxsetDetail.cancel')}</button>
        <button onClick={handleSave} disabled={saving} className="btn-primary flex items-center space-x-2 disabled:opacity-50">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          <span>{isNew ? (saving ? t('sandboxsetDetail.creating') : t('sandboxsetDetail.create')) : (saving ? t('sandboxsetDetail.saving') : t('sandboxsetDetail.save'))}</span>
        </button>
      </div>
    </div>
  )
}

export default SandboxSetDetailPage
