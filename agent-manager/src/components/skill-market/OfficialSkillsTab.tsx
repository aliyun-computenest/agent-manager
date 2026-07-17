/**
 * OfficialSkillsTab — official skills tab with search + tag filter + InfiniteScroll
 * Aligned with ComputeNest OfficialSkillsTab
 */
import React, { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { Search, RefreshCw, Loader2 } from 'lucide-react'
import InfiniteScroll from 'react-infinite-scroll-component'
import toast from 'react-hot-toast'
import { listOfficialSkills } from '../../lib/computenest-api'
import type { SkillItem } from '../../lib/computenest-api'
import { SkillTagFilter } from './SkillTagFilter'
import { SkillCard } from './SkillCard'
import { CloneSkillModal } from './CloneSkillModal'
import { MAX_RESULTS, SCROLL_CONTAINER_OFFSET, SCROLL_THRESHOLD, type SkillTagCode } from './constants'

interface OfficialSkillsTabProps {
  token: string
  hubConfigured: boolean
  readOnly?: boolean
  onInstall?: (skill: SkillItem) => void
  installLabel?: string
}

export const OfficialSkillsTab: React.FC<OfficialSkillsTabProps> = ({
  token,
  hubConfigured,
  readOnly = false,
  onInstall,
  installLabel,
}) => {
  const { t } = useTranslation('admin')
  const navigate = useNavigate()
  const [skills, setSkills] = useState<SkillItem[]>([])
  const [nextToken, setNextToken] = useState<string | undefined>(undefined)
  const [totalCount, setTotalCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [selectedTag, setSelectedTag] = useState<SkillTagCode | null>(null)
  const [showCloneModal, setShowCloneModal] = useState<SkillItem | null>(null)
  const [scrollHeight, setScrollHeight] = useState(600)

  // Calculate scroll height
  useEffect(() => {
    const update = () => setScrollHeight(window.innerHeight - SCROLL_CONTAINER_OFFSET)
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  // Fetch skills
  const fetchSkills = useCallback(async (next?: string, isLoadMore = false) => {
    setLoading(true)
    try {
      const res = await listOfficialSkills(token, {
        keyword: keyword || undefined,
        skillLabel: selectedTag || undefined,
        nextToken: next || undefined,
        maxResults: MAX_RESULTS,
      })
      const newSkills = res.skills ?? []
      setSkills(prev => isLoadMore ? [...prev, ...newSkills] : newSkills)
      setNextToken(res.nextToken)
      setTotalCount(res.totalCount)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [token, keyword, selectedTag])

  // Initial load + reload on filter change
  useEffect(() => {
    setSkills([])
    setNextToken(undefined)
    fetchSkills()
  }, [fetchSkills])

  // Debounce search input — keyword change triggers fetchSkills via useEffect dependency
  const handleKeywordChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setKeyword(e.target.value)
  }

  // Handle Enter key in search
  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      setSkills([])
      setNextToken(undefined)
      fetchSkills()
    }
  }

  // Refresh
  const handleRefresh = () => {
    setSkills([])
    setNextToken(undefined)
    fetchSkills()
  }

  // Tag click
  const handleTagClick = (tagCode: SkillTagCode | null) => {
    setSelectedTag(tagCode)
  }

  // Load more
  const handleLoadMore = () => {
    if (nextToken && !loading) {
      fetchSkills(nextToken, true)
    }
  }

  // Clone success
  const handleCloneSuccess = () => {
    toast.success(t('skillSpace.cloneSuccess'))
    handleRefresh()
  }

  return (
    <>
      {/* Search bar + Tag filter */}
      <div className="mt-4">
        <div className="flex items-center gap-2 mb-2">
          {/* Search input */}
          <div className="relative w-[220px]">
            <input
              type="text"
              value={keyword}
              onChange={handleKeywordChange}
              onKeyDown={handleSearchKeyDown}
              placeholder={t('skillSpace.searchPlaceholder')}
              className="w-full h-8 pl-3 pr-8 border border-gray-300 rounded-lg text-sm focus:ring-1 focus:ring-[#1890ff] focus:border-[#1890ff]"
            />
            <Search className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          </div>

          {/* Refresh button */}
          <button
            onClick={handleRefresh}
            disabled={loading}
            className="w-8 h-8 flex items-center justify-center border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
            title={t('skillSpace.refresh')}
          >
            <RefreshCw className={`w-4 h-4 text-gray-500 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* Tag filter (below search) */}
        <SkillTagFilter selectedTag={selectedTag} onTagClick={handleTagClick} />
      </div>

      {/* Content area */}
      {loading && skills.length === 0 ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
        </div>
      ) : skills.length === 0 ? (
        <div className="text-center py-12 text-gray-400">{t('skillSpace.emptyDescription')}</div>
      ) : (
        <InfiniteScroll
          dataLength={skills.length}
          next={handleLoadMore}
          hasMore={!!nextToken}
          height={scrollHeight}
          scrollThreshold={SCROLL_THRESHOLD}
          loader={
            <div className="text-center leading-9 h-9 mt-5">
              <Loader2 className="w-4 h-4 animate-spin inline mr-1" />
              {t('skillSpace.loading')}
            </div>
          }
          endMessage={
            !nextToken && totalCount > MAX_RESULTS && skills.length > 0 ? (
              <div className="text-center leading-9 h-9 mt-5 text-gray-400">{t('skillSpace.noMore')}</div>
            ) : null
          }
        >
          <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-5 mt-2.5 mb-5">
            {skills.map(skill => (
              <SkillCard
                key={skill.skillId}
                skill={skill}
                isCustomSkill={false}
                onClone={!readOnly && hubConfigured ? () => setShowCloneModal(skill) : undefined}
                onInstall={onInstall}
                installLabel={installLabel}
                onClick={readOnly ? undefined : () => navigate(`/admin/skill-spaces/skills/${skill.skillId}?skillSpaceId=${skill.skillSpaceId}`)}
              />
            ))}
          </div>
        </InfiniteScroll>
      )}

      {/* Clone modal */}
      {showCloneModal && (
        <CloneSkillModal
          skill={showCloneModal}
          token={token}
          isCustomSkill={false}
          onClose={() => setShowCloneModal(null)}
          onSuccess={handleCloneSuccess}
        />
      )}
    </>
  )
}
