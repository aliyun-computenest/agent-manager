/**
 * SkillSpaceSelect — 创建实例时的技能空间选择区
 *
 * 可折叠面板 + 搜索过滤 + 限高滚动列表。
 * 必选技能固定顶部（不可取消），可选技能支持搜索和勾选。
 */
import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Lock, Loader2, ChevronDown, ChevronRight, Search, X } from 'lucide-react'
import { listSkillSpaces, getSkillHubConfig, type SkillSpaceItem, type SkillHubConfigResponse } from '../lib/computenest-api'

interface SkillConfigEntry {
  pvName?: string
  mountPath: string
  subPath: string
  isRequired?: boolean
  skillSpaceId?: string
}

interface SkillSpaceSelectProps {
  skillConfig: SkillConfigEntry[]
  selectedIds: string[]
  onChange: (selectedIds: string[]) => void
  token: string
}

export default function SkillSpaceSelect({ skillConfig, selectedIds, onChange, token }: SkillSpaceSelectProps) {
  const { t } = useTranslation('admin')
  const selectedSet = new Set(selectedIds)

  // UI state
  const [expanded, setExpanded] = useState(true)
  const [keyword, setKeyword] = useState('')

  // Skill space metadata from backend API
  const [spaceMap, setSpaceMap] = useState<Map<string, SkillSpaceItem>>(new Map())
  const [loadingSpaces, setLoadingSpaces] = useState(false)
  const prevSkillSpaceIdsRef = useRef<string>('')

  // Separate required and optional
  const requiredEntries = skillConfig.filter(e => e.isRequired && e.skillSpaceId)
  const optionalEntries = skillConfig.filter(e => !e.isRequired && e.skillSpaceId)

  const requiredCount = requiredEntries.length
  const selectedOptionalCount = optionalEntries.filter(e => selectedSet.has(e.skillSpaceId!)).length
  const totalCount = requiredCount + optionalEntries.length

  const handleToggle = (skillSpaceId: string) => {
    if (selectedSet.has(skillSpaceId)) {
      onChange(selectedIds.filter(id => id !== skillSpaceId))
    } else {
      onChange([...selectedIds, skillSpaceId])
    }
  }

  // Filter optional entries by keyword
  const filteredOptional = keyword.trim()
    ? optionalEntries.filter(e => {
        const detail = spaceMap.get(e.skillSpaceId!)
        const haystack = `${detail?.skillSpaceName || ''} ${detail?.skillSpaceDescription || ''} ${e.skillSpaceId}`.toLowerCase()
        return haystack.includes(keyword.trim().toLowerCase())
      })
    : optionalEntries

  // Build a map for display — only entries with skillSpaceId
  const allEntries = [...requiredEntries, ...optionalEntries]

  // Fetch skill space metadata when skillSpaceIds change
  useEffect(() => {
    if (!token || allEntries.length === 0) return

    const currentIds = allEntries.map(e => e.skillSpaceId).sort().join(',')
    if (currentIds === prevSkillSpaceIdsRef.current) return
    prevSkillSpaceIdsRef.current = currentIds

    let cancelled = false
    setLoadingSpaces(true)

    const fetchSpaceDetails = async () => {
      try {
        const hubConfig: SkillHubConfigResponse = await getSkillHubConfig(token)
        if (!hubConfig.configured) {
          setLoadingSpaces(false)
          return
        }

        const res = await listSkillSpaces(token, { maxResults: 100 })
        if (cancelled) return

        const map = new Map<string, SkillSpaceItem>()
        for (const space of (res?.skillSpaces ?? [])) {
          map.set(space.skillSpaceId, space)
        }
        setSpaceMap(map)
      } catch (e) {
        console.error('Failed to load skill space details:', e)
      } finally {
        if (!cancelled) setLoadingSpaces(false)
      }
    }

    fetchSpaceDetails()
    return () => { cancelled = true }
  }, [token, allEntries.map(e => e.skillSpaceId).sort().join(',')])

  if (allEntries.length === 0) return null

  // Get display name for an entry
  const getDisplayName = (entry: SkillConfigEntry) => {
    const detail = spaceMap.get(entry.skillSpaceId!)
    return detail?.skillSpaceName || entry.skillSpaceId
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white">
      {/* — Header: clickable to expand/collapse — */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left hover:bg-gray-50 transition-colors rounded-lg"
      >
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            {expanded ? (
              <ChevronDown className="w-4 h-4 text-gray-400" />
            ) : (
              <ChevronRight className="w-4 h-4 text-gray-400" />
            )}
            <span className="text-sm font-medium text-gray-700">
              {t('skillSpaceSelect.collapsedTitle')}
            </span>
          </div>
          <span className="text-xs text-gray-400">{t('skillSpaceSelect.totalCount', { count: totalCount })}</span>
        </div>
        {/* Collapsed summary: tag chips */}
        {!expanded && (
          <div className="flex flex-wrap items-center gap-1.5 px-4 pb-3 pt-0">
            {/* Required tags */}
            {requiredEntries.map(entry => (
              <span
                key={entry.skillSpaceId}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-red-50 text-red-600 border border-red-100"
              >
                <Lock className="w-2.5 h-2.5" />
                {getDisplayName(entry)}
              </span>
            ))}
            {/* Selected optional tags */}
            {optionalEntries
              .filter(e => selectedSet.has(e.skillSpaceId!))
              .map(entry => (
                <span
                  key={entry.skillSpaceId}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-primary-50 text-primary-600 border border-primary-100"
                >
                  <Check className="w-2.5 h-2.5" />
                  {getDisplayName(entry)}
                </span>
              ))
            }
            {/* Unselected optional hint */}
            {optionalEntries.length - selectedOptionalCount > 0 && (
              <span className="text-[11px] text-gray-400">
                +{optionalEntries.length - selectedOptionalCount} {t('skillSpaceSelect.unselectedHint')}
              </span>
            )}
          </div>
        )}
      </button>

      {/* — Expandable content — */}
      {expanded && (
        <div className="border-t border-gray-100 px-4 pb-4">
          {/* Search bar */}
          {(requiredEntries.length + optionalEntries.length) > 5 && (
            <div className="relative mt-3 mb-3">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
              <input
                type="text"
                value={keyword}
                onChange={e => setKeyword(e.target.value)}
                placeholder={t('skillSpaceSelect.searchPlaceholder')}
                className="w-full pl-8 pr-8 py-1.5 border border-gray-200 rounded-md text-xs focus:ring-1 focus:ring-primary-500 focus:border-primary-500"
              />
              {keyword && (
                <button
                  type="button"
                  onClick={() => setKeyword('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          )}

          {loadingSpaces && (
            <div className="flex items-center gap-2 py-3 text-gray-400">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span className="text-xs">{t('skillSpaceSelect.loading')}</span>
            </div>
          )}

          {/* Card grid with max-height scroll */}
          <div className="max-h-[200px] overflow-y-auto mt-1">
            {/* Required section */}
            {requiredEntries.length > 0 && (
              <div className="mb-3">
                <div className="flex items-center gap-1.5 mb-2">
                  <Lock className="w-3 h-3 text-red-500" />
                  <span className="text-[11px] font-medium text-red-600">{t('skillSpaceSelect.requiredLabel', { count: requiredCount })}</span>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
                {requiredEntries.map(entry => {
                  const detail = spaceMap.get(entry.skillSpaceId!)
                  return (
                    <div
                      key={entry.skillSpaceId}
                      className="text-left p-2.5 rounded-lg border border-green-200 bg-green-50"
                    >
                      <div className="flex items-start justify-between">
                        <h5 className="text-xs font-medium text-gray-900 truncate">{detail?.skillSpaceName || entry.skillSpaceId}</h5>
                        <span className="ml-1 flex-shrink-0 inline-flex items-center gap-0.5 text-[10px] text-green-600 font-medium">
                          <Check className="w-3 h-3" />
                          {t('skillSpaceSelect.required')}
                        </span>
                      </div>
                      {detail?.skillSpaceDescription && (
                        <p className="mt-0.5 text-[10px] text-gray-500 line-clamp-2" title={detail.skillSpaceDescription}>{detail.skillSpaceDescription}</p>
                      )}
                    </div>
                  )
                })}
                </div>
              </div>
            )}

            {/* Optional section */}
            {optionalEntries.length > 0 && (
              <div>
                {requiredEntries.length > 0 && (
                  <div className="flex items-center gap-1.5 mb-2">
                    <span className="text-[11px] font-medium text-gray-500">{t('skillSpaceSelect.optionalLabel', { count: optionalEntries.length, selected: selectedOptionalCount })}</span>
                  </div>
                )}
                {filteredOptional.length === 0 ? (
                  <p className="text-xs text-gray-400 py-2 text-center">{t('skillSpaceSelect.noMatch')}</p>
                ) : (
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
                  {filteredOptional.map(entry => {
                    const isSelected = selectedSet.has(entry.skillSpaceId!)
                    const detail = spaceMap.get(entry.skillSpaceId!)
                    return (
                      <button
                        type="button"
                        key={entry.skillSpaceId}
                        onClick={() => handleToggle(entry.skillSpaceId!)}
                        className={`text-left p-2.5 rounded-lg border transition-colors ${
                          isSelected
                            ? 'border-primary-300 bg-primary-50'
                            : 'border-gray-200 hover:border-gray-300'
                        }`}
                      >
                        <div className="flex items-start justify-between">
                          <h5 className="text-xs font-medium text-gray-900 truncate">{detail?.skillSpaceName || entry.skillSpaceId}</h5>
                          {isSelected && (
                            <span className="ml-1 flex-shrink-0 inline-flex items-center gap-0.5 text-[10px] text-primary-600 font-medium">
                              <Check className="w-3 h-3" />
                            </span>
                          )}
                        </div>
                        {detail?.skillSpaceDescription && (
                          <p className="mt-0.5 text-[10px] text-gray-500 line-clamp-2" title={detail.skillSpaceDescription}>{detail.skillSpaceDescription}</p>
                        )}
                      </button>
                    )
                  })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}