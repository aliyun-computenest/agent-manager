import React, { useState, useEffect, useCallback, useRef } from 'react'
import { Bot, Search, Eye, Trash2, Loader2, Plus, Users, ChevronLeft, ChevronRight, Play, Square, ExternalLink, ArrowUpCircle, Box, ShieldCheck, UserRound, Copy, Check, TrendingUp, Cpu } from 'lucide-react'
import { useNavigate, Link, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import toast from 'react-hot-toast'
import { useAuth } from '../contexts/AuthContext'
import { apiUrl } from '../lib/api'
import Tooltip from './Tooltip'

// ACS Cluster ID from environment
const ACS_CLUSTER_ID = import.meta.env.VITE_ACS_CLUSTER_ID || ''

interface AgentInstance {
  id: string
  name: string
  description: string | null
  status: string
  total_tokens_used: number
  last_active_at: string | null
  created_at: string
  sandbox_id?: string | null
  agent_image?: string | null
  username?: string
  principal?: { principalId: string; username: string | null; email: string | null } | null
  group?: { id: string; name: string } | null
  actions?: { canDelete: boolean }
  ai_models?: { id: string; name: string; provider: string } | null
  agent_type?: { id: string; code: string; name: string; sandbox_template_id?: string | null } | null
  sandbox_upgrade?: {
    CanUpgrade: boolean
    Reason: string
    AgentTypeId: string | null
    SandboxName: string | null
    Namespace: string | null
    SandboxSetName: string | null
    CurrentImage: string | null
    TargetImage: string | null
    Error?: string | null
  } | null
}

interface Pagination {
  page: number
  pageSize: number
  total: number
  totalPages: number
}

interface OpenClawListProps {
  view?: 'admin' | 'user'
  userId?: string
}

interface UserOverview {
  totalInstances: number
  privateInstances?: number
  groupInstances?: number
  groupCount?: number
  todayTokenUsage: number | null
  monthlyTokenUsage: number | null
  effectiveDailyLimit: number
  effectiveMonthlyLimit: number
  usageUnit: string
  aiGatewayEnabled: boolean
  slsEnabled: boolean
}

interface GroupOption {
  id: string
  name: string
  role: string | null
}

type OwnershipFilter = 'private' | 'group'

const OpenClawList: React.FC<OpenClawListProps> = ({ view = 'user'}) => {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { session, signOut } = useAuth()
  const { t, i18n } = useTranslation(['admin', 'common'])
  const accessTokenRef = useRef<string | null>(session?.access_token ?? null)
  const signOutRef = useRef(signOut)
  const isAuthenticated = Boolean(session?.access_token)
  const [instances, setInstances] = useState<AgentInstance[]>([])
  const [searchTerm, setSearchTerm] = useState('')
  const [userFilter, setUserFilter] = useState('')
  const initialGroupIdParam = searchParams.get('groupId') || ''
  const [ownershipFilter, setOwnershipFilter] = useState<OwnershipFilter>(initialGroupIdParam ? 'group' : 'private')
  const [groupFilter, setGroupFilter] = useState(initialGroupIdParam)
  const [groups, setGroups] = useState<GroupOption[]>([])
  const [loading, setLoading] = useState(true)
  const [overview, setOverview] = useState<UserOverview | null>(null)
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    pageSize: 10,
    total: 0,
    totalPages: 0
  })

  // Debounce search and filter
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [debouncedUserFilter, setDebouncedUserFilter] = useState('')

  useEffect(() => {
    accessTokenRef.current = session?.access_token ?? null
  }, [session?.access_token])

  useEffect(() => {
    signOutRef.current = signOut
  }, [signOut])

  // Sync filter from URL search params (e.g. when navigated from GroupManagement)
  useEffect(() => {
    const groupIdFromUrl = searchParams.get('groupId') || ''
    if (groupIdFromUrl && groupIdFromUrl !== groupFilter) {
      setOwnershipFilter('group')
      setGroupFilter(groupIdFromUrl)
    }
  }, [searchParams, groupFilter])

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchTerm)
    }, 300)
    return () => clearTimeout(timer)
  }, [searchTerm])

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedUserFilter(userFilter)
    }, 300)
    return () => clearTimeout(timer)
  }, [userFilter])

  // Fetch OpenClaw instances from backend API
  const fetchInstances = useCallback(async (page: number) => {
    try {
      setLoading(true)
      const token = accessTokenRef.current

      if (!token) {
        console.error('Not authenticated')
        setLoading(false)
        return
      }

      const params = new URLSearchParams({
        page: page.toString(),
        pageSize: pagination.pageSize.toString()
      })

      if (debouncedSearch) {
        params.append('search', debouncedSearch)
      }

      if (view === 'admin' && ownershipFilter === 'private' && debouncedUserFilter) {
        params.append('username', debouncedUserFilter)
      }

      if (ownershipFilter === 'private') {
        params.append('scope', 'private')
      } else if (ownershipFilter === 'group') {
        if (groupFilter) {
          params.append('groupId', groupFilter)
        } else {
          setInstances([])
          setPagination(prev => ({ ...prev, page: 1, total: 0, totalPages: 0 }))
          setLoading(false)
          return
        }
      }

      // Use different endpoints for admin and user views
      const endpoint = view === 'admin' ? '/api/admin/instances' : '/api/instances'
      const response = await fetch(`${apiUrl}${endpoint}?${params}`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      })

      if (response.status === 401) {
        console.warn('Session expired, signing out')
        await signOutRef.current()
        return
      }

      const data = await response.json()

      if (!data.success) {
        throw new Error(data.error || 'Failed to fetch instances')
      }

      setInstances(data.instances || [])
      setPagination(data.pagination)
    } catch (error) {
      console.error('Error fetching instances:', error)
    } finally {
      setLoading(false)
    }
  }, [view, debouncedSearch, debouncedUserFilter, ownershipFilter, groupFilter, pagination.pageSize])

  const fetchGroups = useCallback(async () => {
    try {
      const token = accessTokenRef.current
      if (!token) return

      const response = await fetch(`${apiUrl}/api/groups`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      })

      if (response.status === 401) {
        console.warn('Session expired, signing out')
        await signOutRef.current()
        return
      }

      const data = await response.json()
      if (data.success) {
        setGroups((data.groups || []).map((group: { id: string; name: string; role: string | null }) => ({
          id: group.id,
          name: group.name,
          role: group.role
        })))
      }
    } catch (error) {
      console.error('Error fetching groups:', error)
    }
  }, [])

  // Fetch user overview data (for user view only)
  const fetchOverview = useCallback(async () => {
    if (view !== 'user') return

    try {
      const token = accessTokenRef.current
      if (!token) return

      const params = new URLSearchParams()
      if (ownershipFilter === 'private') {
        params.set('scope', 'private')
      } else if (ownershipFilter === 'group') {
        if (!groupFilter) {
          setOverview(null)
          return
        }
        params.set('scope', 'group')
        params.set('groupId', groupFilter)
      }

      const query = params.toString()
      const response = await fetch(`${apiUrl}/api/instances/overview${query ? `?${query}` : ''}`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      })

      const data = await response.json()
      if (data.success) {
        setOverview(data.overview)
      }
    } catch (error) {
      console.error('Error fetching overview:', error)
    }
  }, [view, ownershipFilter, groupFilter])

  // Reset to page 1 when filters change
  useEffect(() => {
    if (isAuthenticated) {
      fetchInstances(1)
      fetchOverview()
    }
  }, [debouncedSearch, debouncedUserFilter, ownershipFilter, groupFilter, fetchInstances, fetchOverview, isAuthenticated])

  useEffect(() => {
    if (isAuthenticated) {
      fetchGroups()
    }
  }, [fetchGroups, isAuthenticated])

  // Fetch when page changes (but not on initial load or filter change)
  const handlePageChange = (newPage: number) => {
    if (newPage >= 1 && newPage <= pagination.totalPages) {
      fetchInstances(newPage)
    }
  }

  const handleToggleStatus = async (instanceId: string, currentStatus: string) => {
    const action = currentStatus === 'running' ? 'stop' : 'start'
    const actionText = action === 'stop' ? t('openClawList.actions.stop') : t('openClawList.actions.start')

    try {
      const token = session?.access_token
      if (!token) {
        toast.error(t('openClawList.notLoggedIn'))
        return
      }

      // Update UI immediately for better UX
      setInstances(prev => prev.map(inst =>
        inst.id === instanceId ? { ...inst, status: action === 'stop' ? 'stopping' : 'starting' } : inst
      ))

      const response = await fetch(`${apiUrl}/api/instances/${instanceId}/${action}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      })

      const data = await response.json()

      if (!data.success) {
        throw new Error(data.error || t('openClawList.actionFailed', { action: actionText }))
      }

      // Update with final status
      setInstances(prev => prev.map(inst =>
        inst.id === instanceId ? { ...inst, status: data.status } : inst
      ))
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error)
      console.error(`Error ${action} instance:`, error)
      toast.error(t('openClawList.actionFailedWithReason', { action: actionText, reason }))
      // Revert to original status on error
      setInstances(prev => prev.map(inst =>
        inst.id === instanceId ? { ...inst, status: currentStatus } : inst
      ))
    }
  }

  const handleDelete = async (instanceId: string) => {
    if (!confirm(t('openClawList.confirmDelete'))) return

    try {
      const token = session?.access_token
      if (!token) {
        toast.error(t('openClawList.notLoggedIn'))
        return
      }

      const response = await fetch(`${apiUrl}/api/instances/${instanceId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      })

      const data = await response.json()

      if (!data.success) {
        throw new Error(data.error || t('openClawList.deleteFailed'))
      }

      toast.success(t('openClawList.deleteSuccess'))
      // Refresh current page
      fetchInstances(pagination.page)
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error)
      console.error('Error deleting instance:', error)
      toast.error(t('openClawList.deleteFailedWithReason', { reason }))
    }
  }

  const handleViewDetail = (instanceId: string) => {
    navigate(view === 'admin' ? `/admin/instances/${instanceId}` : `/user/instances/${instanceId}`)
  }

  const handleGoUpgrade = (instance: AgentInstance) => {
    if (!instance.agent_type?.id) return
    const params = new URLSearchParams({ agentTypeId: instance.agent_type.id })
    if (instance.sandbox_upgrade?.SandboxName) {
      params.set('selectedSandbox', instance.sandbox_upgrade.SandboxName)
    }
    navigate(`/admin/instance-upgrades?${params.toString()}`)
  }

  const getStatusText = (status: string) => {
    switch (status) {
      case 'running': return t('openClawList.status.running')
      case 'stopping': return t('openClawList.status.stopping')
      case 'starting': return t('openClawList.status.starting')
      default: return t('openClawList.status.stopped')
    }
  }

  const handleOwnershipFilterChange = (filter: OwnershipFilter) => {
    setOwnershipFilter(filter)
    if (filter === 'group') {
      setUserFilter('')
      const firstGroupId = groups[0]?.id || ''
      setGroupFilter(firstGroupId)
      const next = new URLSearchParams(searchParams)
      if (firstGroupId) {
        next.set('groupId', firstGroupId)
      } else {
        next.delete('groupId')
      }
      setSearchParams(next, { replace: true })
    } else {
      setGroupFilter('')
      if (searchParams.get('groupId')) {
        const next = new URLSearchParams(searchParams)
        next.delete('groupId')
        setSearchParams(next, { replace: true })
      }
    }
  }

  const handleGroupFilterChange = (groupId: string) => {
    setGroupFilter(groupId)
    const next = new URLSearchParams(searchParams)
    if (groupId) {
      next.set('groupId', groupId)
    } else {
      next.delete('groupId')
    }
    setSearchParams(next, { replace: true })
  }

  useEffect(() => {
    if (ownershipFilter !== 'group' || groupFilter || groups.length === 0) return
    const firstGroupId = groups[0].id
    setGroupFilter(firstGroupId)
    const next = new URLSearchParams(searchParams)
    next.set('groupId', firstGroupId)
    setSearchParams(next, { replace: true })
  }, [ownershipFilter, groupFilter, groups, searchParams, setSearchParams])

  const getOwnershipLabel = (instance: AgentInstance) => {
    if (instance.group) return instance.group.name
    return instance.principal?.username
      || instance.principal?.email
      || instance.username
      || t('common:messages.unknownUser')
  }

  const getOwnershipTypeLabel = (instance: AgentInstance) => {
    return instance.group
      ? t('openClawList.table.ownerTypeGroup')
      : t('openClawList.table.ownerTypeUser')
  }

  const [copiedId, setCopiedId] = useState<string | null>(null)

  const handleCopyId = (id: string) => {
    navigator.clipboard.writeText(id)
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 1500)
  }

  const groupInstances = overview?.groupInstances ?? instances.filter(instance => instance.group).length
  const privateInstances = overview?.privateInstances ?? Math.max(0, (overview?.totalInstances || 0) - groupInstances)
  const groupCount = overview?.groupCount ?? groups.length
  const ownershipFilters: Array<{ value: OwnershipFilter; label: string }> = view === 'admin'
    ? [
        { value: 'private', label: t('openClawList.filters.private') },
        { value: 'group', label: t('openClawList.filters.group') },
      ]
    : [
        { value: 'private', label: t('openClawList.filters.private') },
        { value: 'group', label: t('openClawList.filters.group') },
      ]

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-1 flex-col gap-3 xl:flex-row xl:items-center">
          <div className="relative w-full xl:max-w-[360px]">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
            <input
              type="text"
              placeholder={t('openClawList.searchPlaceholder')}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="input-field pl-10"
            />
          </div>
          <div className="inline-flex w-full rounded-md border border-gray-200 bg-white p-1 xl:w-auto">
            {ownershipFilters.map(filter => (
              <button
                key={filter.value}
                type="button"
                onClick={() => handleOwnershipFilterChange(filter.value)}
                className={`min-h-9 flex-1 rounded px-3 text-sm font-medium transition-colors xl:flex-none ${
                  ownershipFilter === filter.value
                    ? 'bg-primary-600 text-white shadow-sm'
                    : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                }`}
              >
                {filter.label}
              </button>
            ))}
          </div>
          {ownershipFilter === 'group' && (
            <select
              value={groupFilter}
              onChange={(e) => handleGroupFilterChange(e.target.value)}
              className="input-field w-full xl:w-44"
            >
              {groups.map(group => (
                <option key={group.id} value={group.id}>{group.name}</option>
              ))}
            </select>
          )}
          {view === 'admin' && ownershipFilter === 'private' && (
            <div className="relative w-full xl:w-48">
              <Users className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
              <input
                type="text"
                placeholder={t('openClawList.filterUserPlaceholder')}
                value={userFilter}
                onChange={(e) => setUserFilter(e.target.value)}
                className="input-field pl-10"
              />
            </div>
          )}
        </div>
        {(view === 'user' || view === 'admin') && (
          <Link
            to={view === 'admin' ? '/admin/instances/create' : '/user/instances/create'}
            className="btn-primary flex items-center space-x-2"
          >
            <Plus className="w-5 h-5" />
            <span>{t('openClawList.createInstance')}</span>
          </Link>
        )}
      </div>

      {/* User Overview Cards */}
      {view === 'user' && overview && (
        <div className={`grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 ${ownershipFilter === 'group' ? 'xl:grid-cols-4' : ''}`}>
          <>
            {ownershipFilter === 'private' && (
              <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="mb-2 inline-flex rounded-md bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
                      {t('openClawList.overview.privateBadge')}
                    </div>
                    <p className="text-sm font-medium text-gray-600">{t('openClawList.overview.myInstances')}</p>
                    <p className="mt-1 text-3xl font-semibold text-gray-900">{privateInstances}</p>
                  </div>
                  <div className="rounded-lg bg-blue-50 p-3">
                    <UserRound className="h-5 w-5 text-blue-600" />
                  </div>
                </div>
              </div>
            )}
            {ownershipFilter === 'group' && (
              <>
                <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="mb-2 inline-flex rounded-md bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                        {t('openClawList.overview.groupBadge')}
                      </div>
                      <p className="text-sm font-medium text-gray-600">{t('openClawList.overview.groupInstances')}</p>
                      <p className="mt-1 text-3xl font-semibold text-gray-900">{groupInstances}</p>
                    </div>
                    <div className="rounded-lg bg-emerald-50 p-3">
                      <Users className="h-5 w-5 text-emerald-600" />
                    </div>
                  </div>
                </div>
                <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="mb-2 inline-flex rounded-md bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                        {t('openClawList.overview.groupCountBadge')}
                      </div>
                      <p className="text-sm font-medium text-gray-600">{t('openClawList.overview.groupCount')}</p>
                      <p className="mt-1 text-3xl font-semibold text-gray-900">{groupCount}</p>
                    </div>
                    <div className="rounded-lg bg-amber-50 p-3">
                      <ShieldCheck className="h-5 w-5 text-amber-600" />
                    </div>
                  </div>
                </div>
              </>
            )}
          </>

          {overview.aiGatewayEnabled && overview.slsEnabled && (
            <>
              {overview.usageUnit === 'usd' ? (
                <>
                  <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="mb-1 text-sm text-gray-600">{t('openClawList.overview.todayUsdUsage')}</p>
                        <p className="text-2xl font-bold text-gray-900">
                          {overview.todayTokenUsage !== null ? `$${overview.todayTokenUsage.toFixed(4)}` : '-'}
                        </p>
                        {overview.effectiveDailyLimit > 0 && (
                          <p className="mt-0.5 text-xs text-gray-500">
                            {t('openClawList.overview.limit')} ${overview.effectiveDailyLimit.toFixed(2)}
                          </p>
                        )}
                      </div>
                      <div className="rounded-lg bg-orange-500 p-3">
                        <TrendingUp className="h-5 w-5 text-white" />
                      </div>
                    </div>
                    {overview.effectiveDailyLimit > 0 && overview.todayTokenUsage !== null && (
                      <div className="mt-3">
                        <div className="h-2 w-full rounded-full bg-gray-200">
                          <div
                            className={`h-2 rounded-full transition-all ${
                              (overview.todayTokenUsage / overview.effectiveDailyLimit) >= 0.9
                                ? 'bg-red-500'
                                : (overview.todayTokenUsage / overview.effectiveDailyLimit) >= 0.7
                                  ? 'bg-amber-500'
                                  : 'bg-green-500'
                            }`}
                            style={{ width: `${Math.min(100, (overview.todayTokenUsage / overview.effectiveDailyLimit) * 100)}%` }}
                          />
                        </div>
                        <p className="mt-1 text-right text-xs text-gray-500">
                          {((overview.todayTokenUsage / overview.effectiveDailyLimit) * 100).toFixed(1)}%
                        </p>
                      </div>
                    )}
                  </div>

                  <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="mb-1 text-sm text-gray-600">{t('openClawList.overview.monthlyUsdUsage')}</p>
                        <p className="text-2xl font-bold text-gray-900">
                          {overview.monthlyTokenUsage !== null ? `$${overview.monthlyTokenUsage.toFixed(4)}` : '-'}
                        </p>
                        {overview.effectiveMonthlyLimit > 0 && (
                          <p className="mt-0.5 text-xs text-gray-500">
                            {t('openClawList.overview.limit')} ${overview.effectiveMonthlyLimit.toFixed(2)}
                          </p>
                        )}
                      </div>
                      <div className="rounded-lg bg-purple-500 p-3">
                        <TrendingUp className="h-5 w-5 text-white" />
                      </div>
                    </div>
                    {overview.effectiveMonthlyLimit > 0 && overview.monthlyTokenUsage !== null && (
                      <div className="mt-3">
                        <div className="h-2 w-full rounded-full bg-gray-200">
                          <div
                            className={`h-2 rounded-full transition-all ${
                              (overview.monthlyTokenUsage / overview.effectiveMonthlyLimit) >= 0.9
                                ? 'bg-red-500'
                                : (overview.monthlyTokenUsage / overview.effectiveMonthlyLimit) >= 0.7
                                  ? 'bg-amber-500'
                                  : 'bg-green-500'
                            }`}
                            style={{ width: `${Math.min(100, (overview.monthlyTokenUsage / overview.effectiveMonthlyLimit) * 100)}%` }}
                          />
                        </div>
                        <p className="mt-1 text-right text-xs text-gray-500">
                          {((overview.monthlyTokenUsage / overview.effectiveMonthlyLimit) * 100).toFixed(1)}%
                        </p>
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="mb-1 flex items-center gap-2">
                          <p className="text-sm text-gray-600">{t('openClawList.overview.todayTokenUsage')}</p>
                          <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-400">{t('openClawList.overview.aiGateway')}</span>
                        </div>
                        <p className="text-2xl font-bold text-gray-900">
                          {overview.todayTokenUsage !== null ? overview.todayTokenUsage.toLocaleString() : '-'}
                        </p>
                        {overview.effectiveDailyLimit > 0 && (
                          <p className="mt-0.5 text-xs text-gray-500">
                            {t('openClawList.overview.limit')} {overview.effectiveDailyLimit.toLocaleString()}
                          </p>
                        )}
                      </div>
                      <div className="rounded-lg bg-orange-500 p-3">
                        <TrendingUp className="h-5 w-5 text-white" />
                      </div>
                    </div>
                    {overview.effectiveDailyLimit > 0 && overview.todayTokenUsage !== null && (
                      <div className="mt-3">
                        <div className="h-2 w-full rounded-full bg-gray-200">
                          <div
                            className={`h-2 rounded-full transition-all ${
                              (overview.todayTokenUsage / overview.effectiveDailyLimit) >= 0.9
                                ? 'bg-red-500'
                                : (overview.todayTokenUsage / overview.effectiveDailyLimit) >= 0.7
                                  ? 'bg-amber-500'
                                  : 'bg-green-500'
                            }`}
                            style={{ width: `${Math.min(100, (overview.todayTokenUsage / overview.effectiveDailyLimit) * 100)}%` }}
                          />
                        </div>
                        <p className="mt-1 text-right text-xs text-gray-500">
                          {((overview.todayTokenUsage / overview.effectiveDailyLimit) * 100).toFixed(1)}%
                        </p>
                      </div>
                    )}
                  </div>

                  <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="mb-1 flex items-center gap-2">
                          <p className="text-sm text-gray-600">{t('openClawList.overview.monthlyTokenUsage')}</p>
                          <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-400">{t('openClawList.overview.aiGateway')}</span>
                        </div>
                        <p className="text-2xl font-bold text-gray-900">
                          {overview.monthlyTokenUsage !== null ? overview.monthlyTokenUsage.toLocaleString() : '-'}
                        </p>
                        {overview.effectiveMonthlyLimit > 0 && (
                          <p className="mt-0.5 text-xs text-gray-500">
                            {t('openClawList.overview.limit')} {overview.effectiveMonthlyLimit.toLocaleString()}
                          </p>
                        )}
                      </div>
                      <div className="rounded-lg bg-purple-500 p-3">
                        <TrendingUp className="h-5 w-5 text-white" />
                      </div>
                    </div>
                    {overview.effectiveMonthlyLimit > 0 && overview.monthlyTokenUsage !== null && (
                      <div className="mt-3">
                        <div className="h-2 w-full rounded-full bg-gray-200">
                          <div
                            className={`h-2 rounded-full transition-all ${
                              (overview.monthlyTokenUsage / overview.effectiveMonthlyLimit) >= 0.9
                                ? 'bg-red-500'
                                : (overview.monthlyTokenUsage / overview.effectiveMonthlyLimit) >= 0.7
                                  ? 'bg-amber-500'
                                  : 'bg-green-500'
                            }`}
                            style={{ width: `${Math.min(100, (overview.monthlyTokenUsage / overview.effectiveMonthlyLimit) * 100)}%` }}
                          />
                        </div>
                        <p className="mt-1 text-right text-xs text-gray-500">
                          {((overview.monthlyTokenUsage / overview.effectiveMonthlyLimit) * 100).toFixed(1)}%
                        </p>
                      </div>
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}

      {/* Table */}
      <div className="card p-0 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-primary-600" />
            <span className="ml-2 text-gray-600">{t('common:loading.default')}</span>
          </div>
        ) : instances.length === 0 ? (
          <div className="text-center py-12">
            <Bot className="w-16 h-16 text-gray-400 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-gray-900 mb-2">
              {t('openClawList.noInstances')}
            </h3>
            <p className="mx-auto max-w-xl text-sm leading-6 text-gray-500">
              {view === 'user'
                ? t('openClawList.clickToCreate')
                : t('openClawList.adminEmptyHint')}
            </p>
            {view === 'admin' && (
              <button
                type="button"
                onClick={() => navigate('/admin/agent-types')}
                className="btn-secondary mt-5 inline-flex items-center space-x-2"
              >
                <ArrowUpCircle className="h-4 w-4" />
                <span>{t('openClawList.goAgentConfig')}</span>
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
          <table className={`w-full divide-y divide-gray-200 ${view === 'admin' ? 'min-w-[1200px]' : 'min-w-[820px]'}`}>
            <thead className="bg-gray-50">
              <tr>
                {view === 'admin' && (
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    {t('openClawList.table.id')}
                  </th>
                )}
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  {t('openClawList.table.name')}
                </th>
                {view === 'admin' && (
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    {t('openClawList.table.owner')}
                  </th>
                )}
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  {t('openClawList.table.agentConfig')}
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  {t('openClawList.table.status')}
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  {t('openClawList.table.model')}
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  {t('openClawList.table.createdAt')}
                </th>
                <th className="w-[176px] px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                  {t('openClawList.table.actions')}
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {instances.map((instance) => {
                const sandboxParts = instance.sandbox_id?.split('--')
                const hasPodLink = view === 'admin' && ACS_CLUSTER_ID && sandboxParts && sandboxParts.length >= 2

                return (
                <tr key={instance.id} className="hover:bg-gray-50">
                  {view === 'admin' && (
                    <td className="max-w-[130px] px-4 py-4 whitespace-nowrap text-sm text-gray-900 font-mono">
                      <button
                        type="button"
                        onClick={() => handleCopyId(instance.id)}
                        className="group inline-flex items-center gap-1 rounded px-1 py-0.5 text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                        title={instance.id}
                      >
                        <span className="truncate max-w-[90px]">{instance.id.slice(0, 8)}</span>
                        {copiedId === instance.id
                          ? <Check className="w-3.5 h-3.5 text-green-600 shrink-0" />
                          : <Copy className="w-3.5 h-3.5 opacity-0 group-hover:opacity-100 shrink-0" />
                        }
                      </button>
                    </td>
                  )}
                  <td className="min-w-[280px] px-4 py-4 text-sm text-gray-900">
                    <div className="max-w-[360px]">
                      <button
                        type="button"
                        onClick={() => handleViewDetail(instance.id)}
                        className="font-semibold text-primary-600 hover:text-primary-800 hover:underline text-left"
                      >
                        {instance.name}
                      </button>
                      {view === 'user' && instance.group && (
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                          <span className="inline-flex items-center rounded-md bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                            {t('openClawList.groupLabel', { name: instance.group.name })}
                          </span>
                        </div>
                      )}
                      {!instance.group && instance.description && (
                        <div className="text-gray-500 truncate max-w-xs">{instance.description}</div>
                      )}
                    </div>
                  </td>
                  {view === 'admin' && (
                    <td className="px-4 py-4 text-sm">
                      <div className="max-w-[220px]">
                        <div className="truncate font-medium text-gray-700">
                          {getOwnershipLabel(instance)}
                        </div>
                        <div className="mt-0.5 text-xs text-gray-400">
                          {getOwnershipTypeLabel(instance)}
                        </div>
                      </div>
                    </td>
                  )}
                  <td className="px-4 py-4 whitespace-nowrap text-sm">
                    {instance.agent_type ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-indigo-50 text-indigo-700">
                          {instance.agent_type.name}
                        </span>
                        {view === 'admin' && instance.sandbox_upgrade?.CanUpgrade && (
                          <span
                            className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-amber-50 text-amber-700 ring-1 ring-amber-100"
                            title={t('openClawList.upgrade.imageTitle', {
                              current: instance.sandbox_upgrade.CurrentImage || '-',
                              target: instance.sandbox_upgrade.TargetImage || '-'
                            })}
                          >
                            {t('openClawList.upgrade.available')}
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="text-gray-400">-</span>
                    )}
                  </td>
                  <td className="px-4 py-4 whitespace-nowrap">
                    <span className={`status-badge ${
                      instance.status === 'running' ? 'status-active' :
                      instance.status === 'stopping' || instance.status === 'starting' ? 'status-pending' :
                      'status-inactive'
                    }`}>
                      {getStatusText(instance.status)}
                    </span>
                  </td>
                  <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-600">
                    {instance.ai_models?.name || t('common:messages.notConfigured')}
                  </td>
                  <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-600">
                    {new Date(instance.created_at).toLocaleString(i18n.language)}
                  </td>
                  <td className="w-[176px] min-w-[176px] px-4 py-4 whitespace-nowrap text-right text-sm font-medium">
                    <div className="inline-flex items-center justify-end gap-1">
                      {hasPodLink && (
                        <Tooltip content={t('openClawList.actions.viewPod')}>
                          <a
                            href={`https://cs.console.aliyun.com/v2#/k8s/cluster/${ACS_CLUSTER_ID}/v2/workload/pod/${sandboxParts![0]}/${sandboxParts!.slice(1).join('--')}/container?type=pod`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-blue-600 hover:bg-blue-50 hover:text-blue-900"
                          >
                            <ExternalLink className="w-5 h-5" />
                          </a>
                        </Tooltip>
                      )}
                      <Tooltip content={t('openClawList.actions.detail')}>
                        <button
                          onClick={() => handleViewDetail(instance.id)}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-primary-600 hover:bg-primary-50 hover:text-primary-900"
                        >
                          <Eye className="w-5 h-5" />
                        </button>
                      </Tooltip>
                      {view === 'admin' && instance.sandbox_upgrade?.CanUpgrade && (
                        <Tooltip content={t('openClawList.actions.goUpgrade')}>
                          <button
                            type="button"
                            onClick={() => handleGoUpgrade(instance)}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-amber-600 hover:bg-amber-50 hover:text-amber-900"
                          >
                            <ArrowUpCircle className="w-5 h-5" />
                          </button>
                        </Tooltip>
                      )}
                      <Tooltip content={instance.status === 'running' ? t('openClawList.actions.stop') : t('openClawList.actions.start')}>
                        <button
                          onClick={() => handleToggleStatus(instance.id, instance.status)}
                          disabled={instance.status === 'stopping' || instance.status === 'starting'}
                          className={`inline-flex h-8 w-8 items-center justify-center rounded-md disabled:cursor-not-allowed disabled:opacity-50 ${
                            instance.status === 'running'
                              ? 'text-orange-600 hover:bg-orange-50 hover:text-orange-900'
                              : 'text-green-600 hover:bg-green-50 hover:text-green-900'
                          }`}
                        >
                          {instance.status === 'running' ? (
                            <Square className="w-5 h-5" />
                          ) : instance.status === 'stopping' || instance.status === 'starting' ? (
                            <Loader2 className="w-5 h-5 animate-spin" />
                          ) : (
                            <Play className="w-5 h-5" />
                          )}
                        </button>
                      </Tooltip>
                      {view === 'admin' && instance.sandbox_id && (
                        <Tooltip content={t('admin:observability.nav.appMonitor')}>
                          <button
                            type="button"
                            onClick={() => {
                              const query = pagination.page > 1 ? `?page=${pagination.page}` : ''
                              navigate(`/admin/observability/app-monitor/instance/${instance.id}${query}`)
                            }}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-blue-600 hover:bg-blue-50 hover:text-blue-900"
                          >
                            <Bot className="w-5 h-5" />
                          </button>
                        </Tooltip>
                      )}
                      {view === 'admin' && instance.sandbox_id && (
                        <Tooltip content={t('openClawList.actions.viewContainer')}>
                          <button
                            type="button"
                            onClick={() => {
                              const query = pagination.page > 1 ? `?page=${pagination.page}` : ''
                              navigate(`/admin/observability/container/${instance.id}${query}`)
                            }}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-purple-600 hover:bg-purple-50 hover:text-purple-900"
                          >
                            <Box className="w-5 h-5" />
                          </button>
                        </Tooltip>
                      )}
                      <Tooltip content={instance.actions?.canDelete === false ? t('openClawList.deleteSharedTooltip') : t('common:buttons.delete')}>
                        <button
                          onClick={() => handleDelete(instance.id)}
                          disabled={instance.actions?.canDelete === false}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-red-600 hover:bg-red-50 hover:text-red-900 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                        >
                          <Trash2 className="w-5 h-5" />
                        </button>
                      </Tooltip>
                    </div>
                  </td>
                </tr>
                )
              })}
            </tbody>
          </table>
          </div>
        )}
      </div>

      {/* Pagination */}
      {pagination.totalPages > 0 && (
        <div className="flex items-center justify-between px-4 py-3 bg-white border border-gray-200 rounded-lg">
          <div className="text-sm text-gray-700">
            {t('openClawList.pagination.totalRecords', { total: pagination.total, page: pagination.page, totalPages: pagination.totalPages })}
          </div>
          <div className="flex items-center space-x-2">
            <button
              onClick={() => handlePageChange(pagination.page - 1)}
              disabled={pagination.page <= 1}
              className="px-3 py-1 border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
            >
              <ChevronLeft className="w-4 h-4 mr-1" />
              {t('openClawList.pagination.prevPage')}
            </button>

            {/* Page numbers */}
            <div className="flex items-center space-x-1">
              {Array.from({ length: Math.min(5, pagination.totalPages) }, (_, i) => {
                let pageNum: number
                if (pagination.totalPages <= 5) {
                  pageNum = i + 1
                } else if (pagination.page <= 3) {
                  pageNum = i + 1
                } else if (pagination.page >= pagination.totalPages - 2) {
                  pageNum = pagination.totalPages - 4 + i
                } else {
                  pageNum = pagination.page - 2 + i
                }
                return (
                  <button
                    key={pageNum}
                    onClick={() => handlePageChange(pageNum)}
                    className={`px-3 py-1 rounded-md text-sm font-medium ${
                      pageNum === pagination.page
                        ? 'bg-primary-600 text-white'
                        : 'text-gray-700 hover:bg-gray-100'
                    }`}
                  >
                    {pageNum}
                  </button>
                )
              })}
            </div>

            <button
              onClick={() => handlePageChange(pagination.page + 1)}
              disabled={pagination.page >= pagination.totalPages}
              className="px-3 py-1 border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
            >
              {t('openClawList.pagination.nextPage')}
              <ChevronRight className="w-4 h-4 ml-1" />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default OpenClawList
