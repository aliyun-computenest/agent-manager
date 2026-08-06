import React, { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Loader2, Server, X, XCircle } from 'lucide-react'
import toast from 'react-hot-toast'
import { useTranslation } from 'react-i18next'
import { apiUrl } from '../../lib/api'
import { installSkills } from '../../lib/computenest-api'
import type { InstallSkillResult, SkillItem } from '../../lib/computenest-api'

interface InstanceOption {
  id: string
  name: string
  status: string
  sandbox_id?: string | null
}

interface InstallToInstanceModalProps {
  token: string
  skills: SkillItem[]
  skillSpaceId?: string | null
  isAdminView: boolean
  translationNamespace?: 'admin' | 'user'
  onClose: () => void
}

export const InstallToInstanceModal: React.FC<InstallToInstanceModalProps> = ({
  token,
  skills,
  skillSpaceId = null,
  isAdminView,
  translationNamespace = 'admin',
  onClose,
}) => {
  const { t } = useTranslation(translationNamespace)
  const [instances, setInstances] = useState<InstanceOption[]>([])
  const [selectedInstanceId, setSelectedInstanceId] = useState('')
  const [loading, setLoading] = useState(true)
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState('')
  const [results, setResults] = useState<InstallSkillResult[] | null>(null)

  useEffect(() => {
    let cancelled = false
    const endpoint = isAdminView ? '/api/admin/instances' : '/api/instances'
    setLoading(true)
    fetch(`${apiUrl}${endpoint}?page=1&pageSize=100&status=running`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async response => {
        const data = await response.json()
        if (!response.ok || !data.success) throw new Error(data.error || t('skillInstall.loadInstancesFailed'))
        if (!cancelled) setInstances(data.instances || [])
      })
      .catch(err => { if (!cancelled) setError(err.message || t('skillInstall.loadInstancesFailed')) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [isAdminView, t, token])

  const availableInstances = useMemo(
    () => instances.filter(instance => instance.status === 'running' && instance.sandbox_id),
    [instances],
  )

  const handleInstall = async () => {
    if (!selectedInstanceId || installing) return
    setInstalling(true)
    setError('')
    try {
      const response = await installSkills(token, selectedInstanceId, skills.map(skill => ({
        skillId: skill.skillId,
        ...(skillSpaceId ? { skillSpaceId } : {}),
      })))
      setResults(response.results)
    } catch (err) {
      const message = err instanceof Error ? err.message : t('skillInstall.requestFailed')
      setError(message)
      toast.error(message)
    } finally {
      setInstalling(false)
    }
  }

  const handleClose = () => {
    if (!installing) onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 px-4" onMouseDown={handleClose}>
      <div
        className="w-full max-w-[640px] rounded-xl bg-white shadow-2xl"
        onMouseDown={event => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="install-to-instance-title"
      >
        <div className="flex items-start justify-between border-b border-gray-100 px-6 py-5">
          <div>
            <h2 id="install-to-instance-title" className="text-lg font-semibold text-gray-900">
              {t('skillInstall.selectInstance')}
            </h2>
            <p className="mt-1 text-sm text-gray-500">
              {t('skillInstall.selectedSkills', { count: skills.length })}
            </p>
          </div>
          <button
            type="button"
            onClick={handleClose}
            disabled={installing}
            className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:cursor-not-allowed disabled:opacity-40"
            aria-label={t('skillInstall.close')}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="max-h-[56vh] overflow-y-auto px-6 py-5">
          {results ? (
            <div className="space-y-3">
              {results.map(result => {
                const skill = skills.find(item => item.skillId === result.skillId)
                const succeeded = result.status === 'succeeded'
                return (
                  <div key={result.skillId} className={`flex items-start gap-3 rounded-lg border px-4 py-3 ${succeeded ? 'border-emerald-200 bg-emerald-50' : 'border-red-200 bg-red-50'}`}>
                    {succeeded
                      ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
                      : <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />}
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-gray-900">{skill?.skillName || result.skillId}</p>
                      <p className={`mt-0.5 text-xs ${succeeded ? 'text-emerald-700' : 'text-red-700'}`}>
                        {succeeded ? t('skillInstall.succeeded') : (result.errorMessage || t('skillInstall.failed'))}
                      </p>
                    </div>
                  </div>
                )
              })}
            </div>
          ) : loading ? (
            <div className="flex items-center justify-center py-12 text-sm text-gray-500">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />
              {t('skillInstall.loadingInstances')}
            </div>
          ) : availableInstances.length === 0 ? (
            <div className="rounded-lg border border-dashed border-gray-300 px-5 py-12 text-center">
              <Server className="mx-auto h-8 w-8 text-gray-300" />
              <p className="mt-3 text-sm font-medium text-gray-700">{t('skillInstall.noRunningInstances')}</p>
              <p className="mt-1 text-xs text-gray-500">{t('skillInstall.noRunningInstancesHint')}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {availableInstances.map(instance => {
                const selected = selectedInstanceId === instance.id
                return (
                  <button
                    key={instance.id}
                    type="button"
                    onClick={() => setSelectedInstanceId(instance.id)}
                    className={`flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors ${selected ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-500' : 'border-gray-200 hover:border-blue-300 hover:bg-gray-50'}`}
                  >
                    <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${selected ? 'bg-blue-100 text-blue-600' : 'bg-gray-100 text-gray-500'}`}>
                      <Server className="h-5 w-5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-gray-900">{instance.name}</span>
                      <span className="mt-0.5 block truncate font-mono text-xs text-gray-500">{instance.id}</span>
                    </span>
                    <span className={`h-4 w-4 rounded-full border-2 ${selected ? 'border-blue-600 bg-blue-600 shadow-[inset_0_0_0_3px_white]' : 'border-gray-300'}`} />
                  </button>
                )
              })}
            </div>
          )}

          {error && <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        </div>

        <div className="flex items-center justify-between border-t border-gray-100 px-6 py-4">
          <p className="text-xs text-gray-500">
            {results ? t('skillInstall.resultOnlyHint') : t('skillInstall.instanceSingleSelectHint')}
          </p>
          <div className="flex gap-2">
            <button type="button" onClick={handleClose} disabled={installing} className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50">
              {results ? t('skillInstall.close') : t('skillInstall.cancel')}
            </button>
            {!results && (
              <button
                type="button"
                onClick={handleInstall}
                disabled={!selectedInstanceId || installing}
                className="inline-flex items-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-45"
              >
                {installing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {installing ? t('skillInstall.installing') : t('skillInstall.install')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
