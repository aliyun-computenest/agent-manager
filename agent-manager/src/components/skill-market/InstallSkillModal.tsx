import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, CheckCircle2, Loader2, RefreshCw, Search, X, XCircle } from 'lucide-react'
import toast from 'react-hot-toast'
import { useTranslation } from 'react-i18next'
import {
  installSkills,
  listOfficialSkills,
  listSkills,
  listSkillSpaces,
} from '../../lib/computenest-api'
import type {
  InstallSkillResult,
  SkillItem,
  SkillSpaceItem,
} from '../../lib/computenest-api'
import { generateDarkerTextColor, generateSoftColorFromString } from './utils'
import { InstallToInstanceModal } from './InstallToInstanceModal'

type SourceType = 'official' | 'custom'
const MAX_INSTALL_SKILLS = 10

interface InstallSkillModalProps {
  token: string
  instanceId?: string
  isAdminView: boolean
  translationNamespace?: 'admin' | 'user'
  initialSkillSpace?: SkillSpaceItem | null
  onClose: () => void
}

export const InstallSkillModal: React.FC<InstallSkillModalProps> = ({
  token,
  instanceId,
  isAdminView,
  translationNamespace = 'admin',
  initialSkillSpace = null,
  onClose,
}) => {
  const { t } = useTranslation(translationNamespace)
  const [source, setSource] = useState<SourceType>(initialSkillSpace ? 'custom' : 'official')
  const [spaces, setSpaces] = useState<SkillSpaceItem[]>(initialSkillSpace ? [initialSkillSpace] : [])
  const [selectedSpaceId, setSelectedSpaceId] = useState(initialSkillSpace?.skillSpaceId || '')
  const [skills, setSkills] = useState<SkillItem[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [keyword, setKeyword] = useState('')
  const [loading, setLoading] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState('')
  const [results, setResults] = useState<InstallSkillResult[] | null>(null)
  const [showTargetInstances, setShowTargetInstances] = useState(false)

  const loadSpaces = useCallback(async () => {
    if (initialSkillSpace) return
    const response = await listSkillSpaces(token, { maxResults: 100 })
    const availableSpaces = response.skillSpaces || []
    setSpaces(availableSpaces)
    setSelectedSpaceId(current => current || availableSpaces[0]?.skillSpaceId || '')
  }, [initialSkillSpace, token])

  const loadSkills = useCallback(async () => {
    setLoading(true)
    setError('')
    setSelectedIds(new Set())
    try {
      if (source === 'official') {
        const response = await listOfficialSkills(token, { maxResults: 100 })
        setSkills(response.skills || [])
      } else if (selectedSpaceId) {
        const response = await listSkills(token, selectedSpaceId, { maxResults: 100 })
        setSkills(response.skills || [])
      } else {
        setSkills([])
      }
    } catch (err) {
      setSkills([])
      setError(err instanceof Error ? err.message : t('skillInstall.loadSkillsFailed'))
    } finally {
      setLoading(false)
    }
  }, [selectedSpaceId, source, t, token])

  useEffect(() => {
    if (source !== 'custom') return
    loadSpaces().catch(err => setError(err instanceof Error ? err.message : t('skillInstall.loadSpacesFailed')))
  }, [loadSpaces, source, t])

  useEffect(() => {
    if (source === 'custom' && !selectedSpaceId) return
    loadSkills()
  }, [loadSkills, selectedSpaceId, source])

  const filteredSkills = useMemo(() => {
    const normalized = keyword.trim().toLowerCase()
    if (!normalized) return skills
    return skills.filter(skill => `${skill.skillName} ${skill.skillDescription}`.toLowerCase().includes(normalized))
  }, [keyword, skills])

  const selectedSkills = useMemo(
    () => skills.filter(skill => selectedIds.has(skill.skillId)),
    [selectedIds, skills],
  )

  const selectionLimitMessage = t('skillInstall.selectionLimit', {
    max: MAX_INSTALL_SKILLS,
    defaultValue: `每次最多安装 ${MAX_INSTALL_SKILLS} 个 Skill`,
  })

  const toggleSkill = (skillId: string) => {
    if (installing) return
    const next = new Set(selectedIds)
    if (next.has(skillId)) {
      next.delete(skillId)
      setError('')
    } else if (next.size >= MAX_INSTALL_SKILLS) {
      setError(selectionLimitMessage)
      return
    } else {
      next.add(skillId)
      setError('')
    }
    setSelectedIds(next)
  }

  const toggleAll = () => {
    if (installing) return
    const allSelected = filteredSkills.length > 0 && filteredSkills.every(skill => selectedIds.has(skill.skillId))
    const next = new Set(selectedIds)
    let limitReached = false
    filteredSkills.forEach(skill => {
      if (allSelected) {
        next.delete(skill.skillId)
      } else if (!next.has(skill.skillId)) {
        if (next.size >= MAX_INSTALL_SKILLS) {
          limitReached = true
          return
        }
        next.add(skill.skillId)
      }
    })
    setSelectedIds(next)
    setError(limitReached ? selectionLimitMessage : '')
  }

  const handleInstall = async () => {
    if (selectedSkills.length === 0 || installing) return
    if (selectedSkills.length > MAX_INSTALL_SKILLS) {
      setError(selectionLimitMessage)
      return
    }
    if (!instanceId) {
      setShowTargetInstances(true)
      return
    }

    setInstalling(true)
    setError('')
    try {
      const response = await installSkills(token, instanceId, selectedSkills.map(skill => ({
        skillId: skill.skillId,
        ...(source === 'custom' ? { skillSpaceId: selectedSpaceId } : {}),
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

  if (showTargetInstances) {
    return (
      <InstallToInstanceModal
        token={token}
        skills={selectedSkills}
        skillSpaceId={source === 'custom' ? selectedSpaceId : null}
        isAdminView={isAdminView}
        translationNamespace={translationNamespace}
        onClose={onClose}
      />
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 px-4" onMouseDown={handleClose}>
      <div
        className="flex max-h-[88vh] w-full max-w-[920px] flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
        onMouseDown={event => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="install-skill-title"
      >
        <div className="flex items-start justify-between border-b border-gray-100 px-6 py-5">
          <div>
            <h2 id="install-skill-title" className="text-lg font-semibold text-gray-900">{t('skillInstall.selectSkills')}</h2>
            <p className="mt-1 text-sm text-gray-500">
              {instanceId ? t('skillInstall.installToCurrentInstance') : t('skillInstall.selectSkillsThenInstance')}
            </p>
          </div>
          <button type="button" onClick={handleClose} disabled={installing} className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:opacity-40" aria-label={t('skillInstall.close')}>
            <X className="h-5 w-5" />
          </button>
        </div>

        {results ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            <div className="space-y-3">
              {results.map(result => {
                const skill = skills.find(item => item.skillId === result.skillId)
                const succeeded = result.status === 'succeeded'
                return (
                  <div key={result.skillId} className={`flex items-start gap-3 rounded-lg border px-4 py-3 ${succeeded ? 'border-emerald-200 bg-emerald-50' : 'border-red-200 bg-red-50'}`}>
                    {succeeded ? <CheckCircle2 className="mt-0.5 h-5 w-5 text-emerald-600" /> : <XCircle className="mt-0.5 h-5 w-5 text-red-600" />}
                    <div>
                      <p className="text-sm font-medium text-gray-900">{skill?.skillName || result.skillId}</p>
                      <p className={`mt-0.5 text-xs ${succeeded ? 'text-emerald-700' : 'text-red-700'}`}>
                        {succeeded ? t('skillInstall.succeeded') : result.errorMessage || t('skillInstall.failed')}
                      </p>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ) : (
          <>
            <div className="border-b border-gray-100 px-6">
              <div className="flex gap-6">
                {(['official', 'custom'] as SourceType[]).map(tab => {
                  const disabled = Boolean(initialSkillSpace && tab === 'official')
                  return (
                    <button
                      key={tab}
                      type="button"
                      disabled={disabled || installing}
                      onClick={() => { setSource(tab); setKeyword(''); setResults(null) }}
                      className={`border-b-2 py-3 text-sm font-medium ${source === tab ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-800'} disabled:hidden`}
                    >
                      {tab === 'official' ? t('skillInstall.officialSkills') : t('skillInstall.skillSpaces')}
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3 px-6 py-4">
              {source === 'custom' && (
                <select
                  value={selectedSpaceId}
                  onChange={event => setSelectedSpaceId(event.target.value)}
                  disabled={Boolean(initialSkillSpace) || installing}
                  className="h-9 min-w-[240px] rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-800 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-50"
                >
                  {spaces.map(space => <option key={space.skillSpaceId} value={space.skillSpaceId}>{space.skillSpaceName}</option>)}
                </select>
              )}
              <div className="relative min-w-[220px] flex-1 sm:max-w-[320px]">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                <input
                  value={keyword}
                  onChange={event => setKeyword(event.target.value)}
                  placeholder={t('skillInstall.searchSkills')}
                  disabled={installing}
                  className="h-9 w-full rounded-lg border border-gray-300 pl-9 pr-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
              <button type="button" onClick={loadSkills} disabled={loading || installing} className="inline-flex h-9 items-center gap-2 rounded-lg border border-gray-300 px-3 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50">
                <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                {t('skillInstall.refresh')}
              </button>
              <button type="button" onClick={toggleAll} disabled={loading || filteredSkills.length === 0 || installing} className="h-9 rounded-lg border border-gray-300 px-3 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50">
                {filteredSkills.length > 0 && filteredSkills.every(skill => selectedIds.has(skill.skillId)) ? t('skillInstall.clearAll') : t('skillInstall.selectAll')}
              </button>
            </div>

            <div className="min-h-[300px] flex-1 overflow-y-auto px-6 pb-5">
              {loading ? (
                <div className="flex h-[300px] items-center justify-center text-sm text-gray-500"><Loader2 className="mr-2 h-5 w-5 animate-spin" />{t('skillInstall.loadingSkills')}</div>
              ) : filteredSkills.length === 0 ? (
                <div className="flex h-[300px] items-center justify-center rounded-lg border border-dashed border-gray-300 text-sm text-gray-500">{t('skillInstall.noSkills')}</div>
              ) : (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  {filteredSkills.map(skill => {
                    const selected = selectedIds.has(skill.skillId)
                    const avatarColor = generateSoftColorFromString(skill.skillName || '')
                    return (
                      <button
                        key={skill.skillId}
                        type="button"
                        onClick={() => toggleSkill(skill.skillId)}
                        disabled={installing}
                        className={`relative flex min-h-[126px] gap-3 rounded-xl border p-4 text-left transition-all ${selected ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-500' : 'border-gray-200 hover:border-blue-300 hover:shadow-sm'}`}
                      >
                        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-sm font-semibold" style={{ backgroundColor: avatarColor, color: generateDarkerTextColor(avatarColor) }}>
                          {skill.skillName?.charAt(0)?.toUpperCase() || 'S'}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold text-gray-900">{skill.skillName}</span>
                          <span className="mt-1.5 line-clamp-2 block text-xs leading-5 text-gray-500">{skill.skillDescription}</span>
                        </span>
                        <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border ${selected ? 'border-blue-600 bg-blue-600 text-white' : 'border-gray-300 bg-white'}`}>
                          {selected && <Check className="h-3.5 w-3.5" />}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
              {error && <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
            </div>
          </>
        )}

        <div className="flex items-center justify-between border-t border-gray-100 px-6 py-4">
          <div>
            <p className="text-sm font-medium text-gray-700">{t('skillInstall.selectedCount', { count: selectedIds.size })}</p>
            {!results && (selectedIds.size === 0 || error !== selectionLimitMessage) && (
              <p className={`mt-0.5 text-xs ${selectedIds.size >= MAX_INSTALL_SKILLS ? 'text-amber-600' : 'text-gray-400'}`}>
                {selectedIds.size === 0 ? t('skillInstall.selectAtLeastOne') : selectionLimitMessage}
              </p>
            )}
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={handleClose} disabled={installing} className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50">{results ? t('skillInstall.close') : t('skillInstall.cancel')}</button>
            {!results && (
              <button type="button" onClick={handleInstall} disabled={selectedIds.size === 0 || selectedIds.size > MAX_INSTALL_SKILLS || installing} className="inline-flex items-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-45">
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
