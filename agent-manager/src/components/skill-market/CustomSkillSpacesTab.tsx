/**
 * CustomSkillSpacesTab — custom skill spaces tab with search + create + InfiniteScroll
 * Aligned with ComputeNest CustomSkillSpacesTab
 */
import React, { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { Search, RefreshCw, Loader2, X, AlertCircle } from 'lucide-react'
import InfiniteScroll from 'react-infinite-scroll-component'
import toast from 'react-hot-toast'
import { listSkillSpaces, createSkillSpace } from '../../lib/computenest-api'
import type { SkillSpaceItem } from '../../lib/computenest-api'
import { SkillSpaceCard } from './SkillSpaceCard'
import { CreateSkillSpaceModal } from './CreateSkillSpaceModal'
import { MAX_RESULTS, SCROLL_CONTAINER_OFFSET, SCROLL_THRESHOLD } from './constants'

interface CustomSkillSpacesTabProps {
  token: string
  hubConfigured: boolean
  readOnly?: boolean
  onInstall?: (space: SkillSpaceItem) => void
  installLabel?: string
}

export const CustomSkillSpacesTab: React.FC<CustomSkillSpacesTabProps> = ({
  token,
  hubConfigured,
  readOnly = false,
  onInstall,
  installLabel,
}) => {
  const { t } = useTranslation('admin')
  const navigate = useNavigate()
  const [spaces, setSpaces] = useState<SkillSpaceItem[]>([])
  const [nextToken, setNextToken] = useState<string | undefined>(undefined)
  const [totalCount, setTotalCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [creating, setCreating] = useState(false)
  const [showConfigAlert, setShowConfigAlert] = useState(false)
  const [scrollHeight, setScrollHeight] = useState(600)

  // Calculate scroll height
  useEffect(() => {
    const update = () => setScrollHeight(window.innerHeight - SCROLL_CONTAINER_OFFSET)
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  // Fetch skill spaces
  const fetchSpaces = useCallback(async (next?: string, isLoadMore = false) => {
    setLoading(true)
    try {
      const res = await listSkillSpaces(token, {
        keyword: keyword || undefined,
        nextToken: next || undefined,
        maxResults: MAX_RESULTS,
      })
      const newSpaces = res.skillSpaces ?? []
      setSpaces(prev => isLoadMore ? [...prev, ...newSpaces] : newSpaces)
      setNextToken(res.nextToken)
      setTotalCount(res.totalCount)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [token, keyword])

  // Initial load + reload on filter change
  useEffect(() => {
    setSpaces([])
    setNextToken(undefined)
    fetchSpaces()
  }, [fetchSpaces])

  // Handle Enter key in search
  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      setSpaces([])
      setNextToken(undefined)
      fetchSpaces()
    }
  }

  // Refresh
  const handleRefresh = () => {
    setSpaces([])
    setNextToken(undefined)
    fetchSpaces()
  }

  // Load more
  const handleLoadMore = () => {
    if (nextToken && !loading) {
      fetchSpaces(nextToken, true)
    }
  }

  // Create skill space
  const handleCreate = async (values: { skillSpaceName: string; skillSpaceDescription: string }) => {
    setCreating(true)
    try {
      await createSkillSpace(token, values)
      toast.success(t('skillSpace.createSpaceSuccess'))
      setShowCreateModal(false)
      handleRefresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setCreating(false)
    }
  }

  // Handle create button click
  const handleCreateClick = () => {
    if (!hubConfigured) {
      setShowConfigAlert(true)
      return
    }
    setShowCreateModal(true)
  }

  return (
    <>
      {/* Config not initialized alert */}
      {!readOnly && showConfigAlert && !hubConfigured && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 mb-4 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
          <div className="flex-1 text-sm text-red-800">
            {t('skillSpace.configNotInitializedAlert')}
            <button
              onClick={() => navigate('/admin/skill-spaces?tab=settings')}
              className="text-[#1890ff] hover:underline ml-1"
            >
              {t('skillSpace.configNotInitializedAction')}
            </button>
          </div>
          <button onClick={() => setShowConfigAlert(false)} className="text-red-400 hover:text-red-600">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Search bar */}
      <div className="mt-4 flex items-center gap-2 mb-2">
        {/* Create button (prefixChild) — no icon, just text like ComputeNest */}
        {!readOnly && (
          <button
            onClick={handleCreateClick}
            className="h-8 px-4 bg-[#1890ff] text-white text-sm rounded hover:bg-[#40a9ff]"
          >
            {t('skillSpace.createSpace')}
          </button>
        )}

        {/* Search input — Input.Search style with search button inside */}
        <div className="relative w-[220px] flex">
          <input
            type="text"
            value={keyword}
            onChange={e => setKeyword(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder={t('skillSpace.searchSpacePlaceholder')}
            className="flex-1 h-8 pl-3 pr-0 border border-r-0 border-gray-300 rounded-l text-sm focus:ring-1 focus:ring-[#1890ff] focus:border-[#1890ff]"
          />
          <button
            onClick={() => { setSpaces([]); setNextToken(undefined); fetchSpaces() }}
            className="h-8 w-8 flex items-center justify-center border border-gray-300 rounded-r bg-white hover:bg-gray-50"
          >
            <Search className="w-3.5 h-3.5 text-gray-500" />
          </button>
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

      {/* Content area */}
      {loading && spaces.length === 0 ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
        </div>
      ) : spaces.length === 0 ? (
        <div className="text-center py-12 text-gray-400">{t('skillSpace.emptyDescription')}</div>
      ) : (
        <InfiniteScroll
          dataLength={spaces.length}
          next={handleLoadMore}
          hasMore={!!nextToken}
          height={scrollHeight}
          scrollThreshold={SCROLL_THRESHOLD}
          loader={
            <div className="text-center py-4 text-[rgba(0,0,0,0.45)]">
              <Loader2 className="w-4 h-4 animate-spin inline mr-1" />
              {t('skillSpace.loading')}
            </div>
          }
          endMessage={
            !nextToken && totalCount > MAX_RESULTS && spaces.length > 0 ? (
              <div className="text-center py-4 text-[rgba(0,0,0,0.45)]">{t('skillSpace.noMore')}</div>
            ) : null
          }
        >
          <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4 py-4">
            {spaces.map(space => (
              <SkillSpaceCard
                key={space.skillSpaceId}
                space={space}
                onClick={() => readOnly ? onInstall?.(space) : navigate(`/admin/skill-spaces/${space.skillSpaceId}`)}
                onInstall={onInstall}
                installLabel={installLabel}
              />
            ))}
          </div>
        </InfiniteScroll>
      )}

      {/* Create modal */}
      {showCreateModal && (
        <CreateSkillSpaceModal
          onClose={() => setShowCreateModal(false)}
          onSubmit={handleCreate}
          loading={creating}
        />
      )}
    </>
  )
}
