import { useState, useEffect, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import { ArrowUpRight, Plus, Trash2, Save, Loader2, Search, Check, ExternalLink, ChevronLeft, ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { apiUrl } from '../lib/api'
import {
  getSkillHubConfig, listSkillSpaces,
  type SkillSpaceItem, type SkillHubConfigResponse,
} from '../lib/computenest-api'

interface AgentTypeSkillTarget {
  id: string
  name: string
  code: string
  skill_config?: {
    pvName?: string
    mountPath: string
    subPath: string
    isRequired?: boolean
    skillSpaceId?: string
  }[] | null
}

interface AgentTypeSkillsGuideTabProps {
  agentType: AgentTypeSkillTarget
  token: string
  onUpdate: (agentType: AgentTypeSkillTarget) => void
  onError: (msg: string) => void
}

interface VolumeMountEntry {
  pvName: string
  mountPath: string
  subPath: string
  isRequired: boolean
  skillSpaceId?: string
}

// 运行时获取环境变量
function getEnvVar(key: string): string {
  const windowEnv = (window as unknown as Record<string, unknown>).__ENV__ as Record<string, string> | undefined
  if (windowEnv && windowEnv[key]) return windowEnv[key]
  return ((import.meta as any).env?.[key] as string) || ''
}

const OSS_ENDPOINT = getEnvVar('VITE_OSS_URL')
// Known placeholder values in .env.example — treat as "not configured"
const DUMMY_PV_NAMES = new Set(['your-pv-name', ''])
const DEFAULT_OSS_PV_NAME = (() => {
  const v = getEnvVar('VITE_OSS_PV_NAME')
  return DUMMY_PV_NAMES.has(v) ? '' : v
})()
const DEFAULT_SKILLHUB_OSS_PV_NAME = (() => {
  const v = getEnvVar('VITE_SKILLHUB_OSS_PV_NAME')
  return DUMMY_PV_NAMES.has(v) ? '' : v
})()

export default function AgentTypeSkillsGuideTab({ agentType, token, onUpdate, onError }: AgentTypeSkillsGuideTabProps) {
  const { t } = useTranslation('admin')

  // SkillHub config check
  const [hubConfig, setHubConfig] = useState<SkillHubConfigResponse | null>(null)
  const [loadingHub, setLoadingHub] = useState(true)

  // All skill spaces from ComputeNest (backend search, client-side pagination)
  const [allSpaces, setAllSpaces] = useState<SkillSpaceItem[]>([])
  const [loadingSpaces, setLoadingSpaces] = useState(false)
  const [spaceKeyword, setSpaceKeyword] = useState('')
  const spaceKeywordRef = useRef('')
  const initialLoadDone = useRef(false)
  const [currentPage, setCurrentPage] = useState(1)
  const PAGE_SIZE = 10

  // Config table
  const [mounts, setMounts] = useState<VolumeMountEntry[]>(() => {
    if (!agentType.skill_config || !Array.isArray(agentType.skill_config)) return []
    return agentType.skill_config.map(e => ({
      pvName: e.pvName || '',
      mountPath: e.mountPath || '',
      subPath: e.subPath || '',
      isRequired: e.isRequired ?? false,
      skillSpaceId: e.skillSpaceId,
    }))
  })
  const [saving, setSaving] = useState(false)
  const [showErrors, setShowErrors] = useState(false)
  const tableContainerRef = useRef<HTMLDivElement>(null)

  // Selected skill spaces for batch add
  const [selectedSpaceIds, setSelectedSpaceIds] = useState<Set<string>>(new Set())

  // Mounted space IDs for "已添加" badge
  const mountedSpaceIds = new Set(mounts.filter(m => m.skillSpaceId).map(m => m.skillSpaceId!))

  // Skill space lookup map: skillSpaceId → { name, description }
  const spaceLookup = new Map(allSpaces.map(s => [s.skillSpaceId, { name: s.skillSpaceName, desc: s.skillSpaceDescription }]))

  // Load SkillHub config
  useEffect(() => {
    if (!token) return
    setLoadingHub(true)
    getSkillHubConfig(token)
      .then(setHubConfig)
      .catch(() => setHubConfig({ success: true, configured: false, hubConfig: null }))
      .finally(() => setLoadingHub(false))
  }, [token])

  // Load skill spaces from backend (supports keyword search)
  const loadAllSpaces = useCallback(async (keyword?: string) => {
    if (!token || !hubConfig?.configured) return
    setLoadingSpaces(true)
    try {
      const res = await listSkillSpaces(token, {
        keyword: keyword || undefined,
        maxResults: 100,
      })
      setAllSpaces(res?.skillSpaces ?? [])
      setCurrentPage(1)
    } catch (e: any) {
      console.error('Failed to load skill spaces:', e)
    } finally {
      setLoadingSpaces(false)
    }
  }, [token, hubConfig?.configured])

  // Trigger search — call backend with keyword
  const handleSearch = useCallback(() => {
    loadAllSpaces(spaceKeywordRef.current)
  }, [loadAllSpaces])

  // Initial load — only once when hubConfig becomes ready
  const hubReady = hubConfig !== null
  useEffect(() => {
    if (!hubReady || initialLoadDone.current) return
    initialLoadDone.current = true
    loadAllSpaces()
  }, [hubReady, loadAllSpaces])

  // Derived: filtered list for current page
  const totalPages = Math.max(1, Math.ceil(allSpaces.length / PAGE_SIZE))
  const pagedSpaces = allSpaces.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)
  const canGoPrev = currentPage > 1
  const canGoNext = currentPage < totalPages
  const showPagination = totalPages > 1 && allSpaces.length > 0

  // Add skill spaces to config table
  const handleAddSelectedSpaces = () => {
    const newMounts: VolumeMountEntry[] = []
    for (const spaceId of selectedSpaceIds) {
      if (mountedSpaceIds.has(spaceId)) continue
      const space = allSpaces.find(s => s.skillSpaceId === spaceId)
      if (!space) continue
      // Use skillSpaceId for mountPath to avoid shell injection via special chars in skillSpaceName
      newMounts.push({
        pvName: DEFAULT_SKILLHUB_OSS_PV_NAME,  // SkillHub PV (auto-fill, backend fills if empty)
        mountPath: agentType.code === 'openclaw'
          ? `/home/node/.openclaw/skills/${spaceId}`
          : `/opt/skillhub/skills/${spaceId}`,
        subPath: `spaces/${spaceId}/`,
        isRequired: false,
        skillSpaceId: spaceId,
      })
    }
    if (newMounts.length > 0) {
      setMounts(prev => [...prev, ...newMounts])
      setSelectedSpaceIds(new Set())
      // Auto-scroll to bottom
      setTimeout(() => {
        const el = tableContainerRef.current
        if (el) el.scrollTop = el.scrollHeight
      }, 0)
    }
  }

  const addManualRow = () => {
    setMounts([...mounts, { pvName: '', mountPath: '/skills', subPath: '', isRequired: false }])
    // Auto-scroll to bottom so the new row is visible
    setTimeout(() => {
      const el = tableContainerRef.current
      if (el) el.scrollTop = el.scrollHeight
    }, 0)
  }

  const removeRow = (index: number) => {
    setMounts(mounts.filter((_, i) => i !== index))
  }

  const updateRow = (index: number, field: keyof VolumeMountEntry, value: string | boolean) => {
    const updated = [...mounts]
    updated[index] = { ...updated[index], [field]: value }
    setMounts(updated)
  }

  const validate = (): string | null => {
    for (let i = 0; i < mounts.length; i++) {
      const m = mounts[i]
      if (!m.mountPath.trim()) {
        return t('agentTypeSkillsGuide.validation.mountPathRequired', { index: i + 1 })
      }
      if (!m.mountPath.startsWith('/')) {
        return t('agentTypeSkillsGuide.validation.mountPathMustStartWithSlash', { index: i + 1 })
      }
      if (!m.subPath.trim()) {
        return t('agentTypeSkillsGuide.validation.subPathRequired', { index: i + 1 })
      }
    }
    return null
  }

  const handleSave = async () => {
    setShowErrors(true)
    const err = validate()
    if (err) { onError(err); return }

    setSaving(true)
    try {
      const filtered = mounts
        .filter(m => m.mountPath.trim() && m.subPath.trim())
        .map(m => {
          const entry: Record<string, any> = {
            pvName: m.pvName.trim() || '',  // Empty → backend normalizeSkillConfig fills from server-side VITE_OSS_PV_NAME
            mountPath: m.mountPath.trim(),
            subPath: m.subPath.trim(),
            isRequired: m.isRequired,
          }
          if (m.skillSpaceId) entry.skillSpaceId = m.skillSpaceId
          return entry
        })

      const res = await fetch(`${apiUrl}/api/agent-types/${agentType.id}`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ skillConfig: filtered.length > 0 ? filtered : null })
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(text || `HTTP ${res.status}`)
      }
      const data = await res.json()
      if (!data.success) throw new Error(data.error || 'Save failed')
      onUpdate(data.agentType)
    } catch (e: any) {
      onError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Snapshot isolation banner */}
      <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-xs text-blue-800">
        {t('agentTypeSkillsGuide.snapshotBanner')}
      </div>

      {/* === Upper section: Skill Space Card Grid === */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">
              {t('agentTypeSkillsGuide.allSkillSpaces', { count: allSpaces.length })}
            </h3>
            <p className="mt-1 text-xs text-gray-500">{t('agentTypeSkillsGuide.selectSpacesHint')}</p>
          </div>
          <div className="flex items-center gap-3">
            {/* Search — 计算巢风格：左侧蓝色竖条 + 右侧搜索图标 */}
            {hubConfig?.configured && (
              <div className="relative w-64">
                <input
                  type="text"
                  value={spaceKeyword}
                  onChange={e => { setSpaceKeyword(e.target.value); spaceKeywordRef.current = e.target.value }}
                  onKeyDown={e => { if (e.key === 'Enter') handleSearch() }}
                  placeholder={t('agentTypeSkillsGuide.searchSpacesPlaceholder')}
                  className="w-full pl-3 pr-8 py-1.5 border border-gray-300 rounded-lg text-xs focus:ring-1 focus:ring-primary-500 focus:border-primary-500"
                />
                <button
                  onClick={() => handleSearch()}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 text-gray-400 hover:text-primary-500"
                >
                  <Search className="h-4 w-4" />
                </button>
              </div>
            )}
            <button
              onClick={handleAddSelectedSpaces}
              disabled={selectedSpaceIds.size === 0}
              className="btn-primary flex items-center gap-1.5 text-xs disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" />
              {t('agentTypeSkillsGuide.addToMountList')}
            </button>
          </div>
        </div>

        {loadingHub ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
          </div>
        ) : !hubConfig?.configured ? (
          <div className="text-center py-8 text-gray-500">
            <p className="text-sm">{t('agentTypeSkillsGuide.hubNotConfigured')}</p>
            <Link to="/admin/skill-spaces" className="mt-2 inline-flex items-center gap-1 text-xs text-primary-600 hover:text-primary-700">
              {t('agentTypeSkillsGuide.goToSkillSpaceManagement')}
              <ArrowUpRight className="w-3 h-3" />
            </Link>
          </div>
        ) : (
          <>
            {loadingSpaces && allSpaces.length === 0 ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
              </div>
            ) : allSpaces.length === 0 ? (
              <p className="text-xs text-gray-400 py-4 text-center">{t('agentTypeSkillsGuide.noSpacesAvailable')}</p>
            ) : (
              <>
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2">
                {pagedSpaces.map(space => {
                  const isMounted = mountedSpaceIds.has(space.skillSpaceId)
                  const isSelected = selectedSpaceIds.has(space.skillSpaceId)
                  return (
                    <button
                      key={space.skillSpaceId}
                      onClick={() => {
                        if (isMounted) return
                        setSelectedSpaceIds(prev => {
                          const next = new Set(prev)
                          if (next.has(space.skillSpaceId)) next.delete(space.skillSpaceId)
                          else next.add(space.skillSpaceId)
                          return next
                        })
                      }}
                      disabled={isMounted}
                      className={`text-left p-3 rounded-lg border transition-colors ${
                        isMounted
                          ? 'border-green-200 bg-green-50 cursor-default'
                          : isSelected
                            ? 'border-primary-300 bg-primary-50'
                            : 'border-gray-200 hover:border-gray-300'
                      }`}
                    >
                      <div className="flex items-start justify-between">
                        <h5 className="text-xs font-medium text-gray-900 truncate" title={space.skillSpaceName}>{space.skillSpaceName}</h5>
                        {isMounted && (
                          <span className="ml-1 flex-shrink-0 inline-flex items-center gap-0.5 text-[10px] text-green-600 font-medium">
                            <Check className="w-3 h-3" />
                            {t('agentTypeSkillsGuide.added')}
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-[10px] text-gray-500 line-clamp-2" title={space.skillSpaceDescription || ''}>{space.skillSpaceDescription}</p>
                      <p className="mt-1 text-[9px] text-gray-400 font-mono truncate">{space.skillSpaceId}</p>
                    </button>
                  )
                })}
                </div>
                {/* Pagination */}
                {showPagination && (
                  <div className="flex items-center justify-center gap-1 mt-3">
                    <button
                      onClick={() => setCurrentPage(currentPage - 1)}
                      disabled={!canGoPrev || loadingSpaces}
                      className="p-1 rounded hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      <ChevronLeft className="w-3.5 h-3.5" />
                    </button>
                    {Array.from({ length: totalPages }, (_, i) => i + 1).map(page => (
                      <button
                        key={page}
                        onClick={() => setCurrentPage(page)}
                        disabled={loadingSpaces}
                        className={`min-w-[24px] h-6 rounded text-xs font-medium transition-colors ${
                          page === currentPage
                            ? 'bg-primary-500 text-white'
                            : 'text-gray-600 hover:bg-gray-100'
                        }`}
                      >
                        {page}
                      </button>
                    ))}
                    <button
                      onClick={() => setCurrentPage(currentPage + 1)}
                      disabled={!canGoNext || loadingSpaces}
                      className="p-1 rounded hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                    <span className="ml-2 text-[10px] text-gray-400">
                      {t('agentTypeSkillsGuide.totalCount', { count: allSpaces.length })}
                    </span>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>

      {/* === Lower section: Skill Mount Config === */}
      <div className="card">
        {/* Header */}
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-sm font-semibold text-gray-900">
            {t('agentTypeSkillsGuide.mountConfigTitle', { count: mounts.length })}
          </h3>
          {OSS_ENDPOINT && (
            <a
              href={OSS_ENDPOINT}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {t('agentTypeSkillsGuide.goToOss')}
            </a>
          )}
        </div>
        <p className="text-xs text-gray-500 mb-4">
          {t('agentTypeSkillsGuide.mountConfigSubtitle')}
        </p>

        {/* Warning banner */}
        {agentType.code === 'openclaw' && (
          <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
            <span className="font-semibold">{t('agentTypeSkillsGuide.noticeLabel')}</span>
            {t('agentTypeSkillsGuide.reservedMountPathWarning')}
          </div>
        )}

        {/* Mount table */}
        {mounts.length > 0 && (
          <div ref={tableContainerRef} className="max-h-[400px] overflow-y-auto overflow-x-auto border border-gray-200 rounded-lg">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="sticky top-0 bg-white z-10 py-2 px-2 text-left font-medium text-gray-500">{t('agentTypeSkillsGuide.pvName')}</th>
                  <th className="sticky top-0 bg-white z-10 py-2 px-2 text-left font-medium text-gray-500">{t('agentTypeSkillsGuide.mountPath')}</th>
                  <th className="sticky top-0 bg-white z-10 py-2 px-2 text-left font-medium text-gray-500">{t('agentTypeSkillsGuide.subPath')}</th>
                  <th className="sticky top-0 bg-white z-10 py-2 px-2 text-center font-medium text-gray-500">{t('agentTypeSkillsGuide.isRequired')}</th>
                  <th className="sticky top-0 bg-white z-10 py-2 px-2 text-center font-medium text-gray-500">{t('agentTypeSkillsGuide.skillSpaceIdCol')}</th>
                  <th className="sticky top-0 bg-white z-10 py-2 px-2 w-8" />
                </tr>
              </thead>
              <tbody>
                {mounts.map((mount, index) => {
                  const mountPathEmpty = showErrors && !mount.mountPath.trim()
                  const mountPathBadPrefix = showErrors && mount.mountPath.trim() && !mount.mountPath.startsWith('/')
                  const subPathEmpty = showErrors && !mount.subPath.trim()

                  return (
                    <tr key={index} className="border-b border-gray-100">
                      <td className="py-2 px-2">
                        <input
                          type="text"
                          value={mount.pvName}
                          onChange={e => updateRow(index, 'pvName', e.target.value)}
                          placeholder={DEFAULT_SKILLHUB_OSS_PV_NAME || DEFAULT_OSS_PV_NAME || t('agentTypeSkillsGuide.pvNamePlaceholder')}
                          className="w-full rounded-md bg-gray-50 border-0 px-3 py-1.5 text-xs font-mono text-gray-700 focus:ring-1 focus:ring-primary-500"
                        />
                      </td>
                      <td className="py-2 px-2">
                        <input
                          type="text"
                          value={mount.mountPath}
                          onChange={e => updateRow(index, 'mountPath', e.target.value)}
                          placeholder={t('agentTypeSkillsGuide.mountPathPlaceholder')}
                          className={`w-full rounded-md px-3 py-1.5 text-xs font-mono text-gray-700 focus:ring-1 focus:ring-primary-500 ${
                            mountPathEmpty || mountPathBadPrefix
                              ? 'bg-red-50 ring-1 ring-red-500'
                              : 'bg-gray-50 border-0'
                          }`}
                        />
                        {mountPathEmpty && <p className="mt-0.5 text-[10px] text-red-500">{t('agentTypeSkillsGuide.validation.mountPathRequired', { index: index + 1 })}</p>}
                        {mountPathBadPrefix && <p className="mt-0.5 text-[10px] text-red-500">{t('agentTypeSkillsGuide.validation.mountPathMustStartWithSlash', { index: index + 1 })}</p>}
                      </td>
                      <td className="py-2 px-2">
                        <input
                          type="text"
                          value={mount.subPath}
                          onChange={e => updateRow(index, 'subPath', e.target.value)}
                          placeholder={t('agentTypeSkillsGuide.subPathPlaceholder')}
                          className={`w-full rounded-md px-3 py-1.5 text-xs font-mono text-gray-700 focus:ring-1 focus:ring-primary-500 ${
                            subPathEmpty
                              ? 'bg-red-50 ring-1 ring-red-500'
                              : 'bg-gray-50 border-0'
                          }`}
                        />
                        {subPathEmpty && <p className="mt-0.5 text-[10px] text-red-500">{t('agentTypeSkillsGuide.validation.subPathRequired', { index: index + 1 })}</p>}
                      </td>
                      <td className="py-2 px-2 text-center">
                        <input
                          type="checkbox"
                          checked={mount.isRequired}
                          onChange={e => updateRow(index, 'isRequired', e.target.checked)}
                          className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                        />
                      </td>
                      <td className="py-2 px-2 text-center text-[10px]">
                        {mount.skillSpaceId ? (() => {
                          const info = spaceLookup.get(mount.skillSpaceId)
                          const label = info?.name || mount.skillSpaceId
                          return (
                            <Link
                              to={`/admin/skill-spaces/${mount.skillSpaceId}`}
                              className="font-medium text-primary-600 hover:text-primary-700 hover:underline"
                              title={info?.desc || ''}
                            >
                              {label.length > 20 ? label.slice(0, 18) + '…' : label}
                            </Link>
                          )
                        })() : (
                          <span className="text-gray-400">–</span>
                        )}
                      </td>
                      <td className="py-2 px-2">
                        <button
                          onClick={() => removeRow(index)}
                          className="inline-flex h-6 w-6 items-center justify-center rounded text-gray-400 hover:bg-red-50 hover:text-red-500"
                          title={t('agentTypeSkillsGuide.removeMount')}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Add mount button — below the rows */}
        <div className="mt-3">
          <button
            onClick={addManualRow}
            className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:border-primary-400 hover:text-primary-600"
          >
            <Plus className="h-3.5 w-3.5" />
            {t('agentTypeSkillsGuide.addMount')}
          </button>
        </div>

        {/* JSON Preview */}
        {mounts.length > 0 && (
          <div className="mt-4">
            <h4 className="text-xs font-medium text-gray-600 mb-2">
              {t('agentTypeSkillsGuide.jsonPreview')}
            </h4>
            <pre className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-[11px] font-mono text-gray-700 overflow-x-auto max-h-48 overflow-y-auto">
              {JSON.stringify(mounts.map(m => ({
                ...(m.pvName ? { pvName: m.pvName } : {}),
                mountPath: m.mountPath,
                subPath: m.subPath,
                ...(m.isRequired ? { isRequired: m.isRequired } : {}),
                ...(m.skillSpaceId ? { skillSpaceId: m.skillSpaceId } : {}),
              })), null, 2)}
            </pre>
          </div>
        )}

        {/* Save button */}
        <div className="mt-4 flex justify-end">
          <button
            onClick={handleSave}
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-700 disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {t('agentTypeSkillsGuide.save')}
          </button>
        </div>
      </div>
    </div>
  )
}