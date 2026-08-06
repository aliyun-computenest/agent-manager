import React, { useCallback, useEffect, useState } from 'react'
import { Box, Edit2, Gauge, HelpCircle, Loader2, Plus, Search, SlidersHorizontal, Trash2, UserMinus, Users } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import toast from 'react-hot-toast'
import { useAuth } from '../contexts/AuthContext'
import { apiUrl } from '../lib/api'
import Tooltip from './Tooltip'

function sanitizeConsumerName(value: string): string {
  let name = value.replace(/@/g, '.').replace(/[^a-zA-Z0-9.-]/g, '-')
  name = name.replace(/^[^a-zA-Z0-9]+/, '').replace(/[^a-zA-Z0-9]+$/, '')
  name = name.replace(/([.-]){2,}/g, '$1')
  if (name.length > 64) {
    name = name.slice(0, 64).replace(/[^a-zA-Z0-9]+$/, '')
  }
  if (name.length < 2) {
    name = name.padEnd(2, '0')
  }
  return name
}

interface Group {
  id: string
  name: string
  role: string | null
  quota: {
    used: number
    limit: number | null
  }
  apiKey: {
    status: string
    provider: string | null
  }
  createdAt: string
  updatedAt: string
}

interface Member {
  principalId: string
  username: string | null
  email: string | null
  role: 'admin' | 'member'
  status: 'active' | 'removed'
  createdAt: string
  updatedAt: string
}

interface UserOption {
  id: string
  username: string | null
  email: string | null
  status?: string
}

interface BudgetItem {
  timeRate: string
  value: number
  unit: string
}

interface ConsumerUsageItem {
  consumer: string
  username?: string
  name?: string
  value?: number
  totalToken?: number
}

interface GroupLimitData {
  enabled: boolean
  usageUnit?: string
  budgets: BudgetItem[]
  globalBudgets: BudgetItem[]
  effectiveBudgets: BudgetItem[]
  hasConsumer?: boolean
}

interface GroupManagementProps {
  mode?: 'admin' | 'user'
}

const GroupManagement: React.FC<GroupManagementProps> = ({ mode = 'admin' }) => {
  const isPlatformAdmin = mode === 'admin'
  const { t } = useTranslation(['admin', 'common'])
  const { session } = useAuth()
  const navigate = useNavigate()

  const [groups, setGroups] = useState<Group[]>([])
  const [members, setMembers] = useState<Member[]>([])
  const [selectedGroupId, setSelectedGroupId] = useState('')
  const [loading, setLoading] = useState(true)
  const [membersLoading, setMembersLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [showEditModal, setShowEditModal] = useState(false)
  const [showQuotaModal, setShowQuotaModal] = useState(false)
  const [showMembersModal, setShowMembersModal] = useState(false)
  const [newGroup, setNewGroup] = useState({ name: '' })
  const [editGroup, setEditGroup] = useState({ name: '' })
  const [quotaGroup, setQuotaGroup] = useState<Group | null>(null)
  const [quotaInput, setQuotaInput] = useState('')
  const [newMember, setNewMember] = useState({ email: '', role: 'member' as 'admin' | 'member' })
  const [memberOptions, setMemberOptions] = useState<UserOption[]>([])
  const [memberSearchLoading, setMemberSearchLoading] = useState(false)
  const [showMemberOptions, setShowMemberOptions] = useState(false)
  const [aiGatewayEnabled, setAiGatewayEnabled] = useState(false)
  const [usageUnit, setUsageUnit] = useState('token')
  const [consumerUsageMap, setConsumerUsageMap] = useState<Map<string, number>>(new Map())
  const [consumer30dUsageMap, setConsumer30dUsageMap] = useState<Map<string, number>>(new Map())

  const [limitLoading, setLimitLoading] = useState(false)
  const [limitSaving, setLimitSaving] = useState(false)
  const [limitData, setLimitData] = useState<GroupLimitData | null>(null)
  const [limitGroup, setLimitGroup] = useState<Group | null>(null)
  const [showLimitModal, setShowLimitModal] = useState(false)
  const [limitDailyInput, setLimitDailyInput] = useState('')
  const [limitMonthlyInput, setLimitMonthlyInput] = useState('')
  const [limitBudgetTimeRate, setLimitBudgetTimeRate] = useState<'daily' | 'monthly'>('monthly')

  const token = session?.access_token
  const selectedGroup = groups.find(group => group.id === selectedGroupId) || groups[0] || null
  const isUsd = usageUnit === 'usd'
  const canManageGroup = useCallback((group: Group | null) => Boolean(
    group && (isPlatformAdmin || group.role === 'admin')
  ), [isPlatformAdmin])
  const canManageSelectedGroup = Boolean(
    selectedGroup && canManageGroup(selectedGroup)
  )
  const limitUnit = limitData?.usageUnit || limitData?.globalBudgets?.[0]?.unit || limitData?.budgets?.[0]?.unit || 'token'
  const limitIsUsd = limitUnit === 'usd'
  const findLimitBudget = (budgets: BudgetItem[] = [], timeRate: string) =>
    budgets.find(b => b.timeRate === timeRate && b.unit === limitUnit)
  const globalDailyLimit = findLimitBudget(limitData?.globalBudgets, 'daily')?.value || 0
  const globalMonthlyLimit = findLimitBudget(limitData?.globalBudgets, 'monthly')?.value || 0
  const effectiveDailyLimit = findLimitBudget(limitData?.effectiveBudgets, 'daily')?.value || 0
  const effectiveMonthlyLimit = findLimitBudget(limitData?.effectiveBudgets, 'monthly')?.value || 0
  const formatLimitValue = (value: number) => limitIsUsd
    ? `$${value.toFixed(2)}`
    : `${value.toLocaleString()} tokens`

  const formatUsageValue = (value: number | undefined) => {
    if (value === undefined) return '-'
    return isUsd ? `$${value.toFixed(4)}` : value.toLocaleString()
  }

  const getGroupUsageValue = (group: Group, map: Map<string, number>) => {
    const sanitizedName = sanitizeConsumerName(group.name)
    if (map.has(sanitizedName)) return map.get(sanitizedName)
    if (map.has(group.name)) return map.get(group.name)
    return undefined
  }

  const buildConsumerUsageMap = (items: ConsumerUsageItem[] = []) => {
    const map = new Map<string, number>()
    items.forEach((item) => {
      const value = item.value ?? item.totalToken ?? 0
      const aliases = [item.consumer, item.username, item.name].filter(Boolean) as string[]
      aliases.forEach((alias) => {
        map.set(alias, value)
        map.set(sanitizeConsumerName(alias), value)
      })
    })
    return map
  }

  const formatRole = (role: string | null) => {
    if (role === 'admin') return t('admin:groupManagement.roles.admin')
    if (role === 'member') return t('admin:groupManagement.roles.member')
    return '-'
  }

  const formatInstanceQuota = (group: Group) => {
    if (group.quota.limit === null || group.quota.limit === undefined) return String(group.quota.used)
    return `${group.quota.used} / ${group.quota.limit}`
  }

  const authHeaders = useCallback(() => ({
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json'
  }), [token])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(searchTerm)
    }, 300)
    return () => window.clearTimeout(timer)
  }, [searchTerm])

  useEffect(() => {
    const loadProviderStats = async () => {
      if (!token) return
      try {
        const res = await fetch(`${apiUrl}/api/providers/current/stats`, {
          headers: { Authorization: `Bearer ${token}` }
        })
        const data = await res.json()
        if (data.success && data.stats) {
          const enabled = !!data.stats.aiGatewayEnabled && !!data.stats.slsEnabled
          setAiGatewayEnabled(enabled)
          setUsageUnit(data.stats.usageUnit || 'token')
        }
      } catch (error) {
        console.error('Failed to load provider stats:', error)
      }
    }
    loadProviderStats()
  }, [token])

  const loadConsumerUsage = useCallback(async () => {
    if (!token || !aiGatewayEnabled) return
    try {
      const [todayRes, monthRes] = await Promise.allSettled([
        fetch(`${apiUrl}/api/providers/current/tokens?days=1`, {
          headers: { Authorization: `Bearer ${token}` }
        }),
        fetch(`${apiUrl}/api/providers/current/tokens?days=30`, {
          headers: { Authorization: `Bearer ${token}` }
        })
      ])

      if (todayRes.status === 'fulfilled') {
        const data = await todayRes.value.json()
        if (data.success && data.consumers) {
          setConsumerUsageMap(buildConsumerUsageMap(data.consumers))
        }
      }

      if (monthRes.status === 'fulfilled') {
        const data = await monthRes.value.json()
        if (data.success && data.consumers) {
          setConsumer30dUsageMap(buildConsumerUsageMap(data.consumers))
        }
      }
    } catch (error) {
      console.error('Failed to load group usage:', error)
    }
  }, [aiGatewayEnabled, token])

  useEffect(() => {
    loadConsumerUsage()
  }, [loadConsumerUsage])

  const loadGroups = useCallback(async () => {
    if (!token) return
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (debouncedSearch.trim()) {
        params.set('filter', JSON.stringify([{ name: 'search', value: debouncedSearch.trim() }]))
      }
      const query = params.toString()
      const res = await fetch(`${apiUrl}/api/groups${query ? `?${query}` : ''}`, { headers: authHeaders() })
      const data = await res.json()
      if (!data.success) throw new Error(data.error || t('admin:groupManagement.toast.loadFailed'))
      const nextGroups = data.groups || []
      setGroups(nextGroups)
      setSelectedGroupId(current => {
        if (nextGroups.length === 0) return ''
        if (!current || !nextGroups.some((group: Group) => group.id === current)) return nextGroups[0].id
        return current
      })
    } catch (error) {
      console.error('Failed to load groups:', error)
      toast.error(error instanceof Error ? error.message : t('admin:groupManagement.toast.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [authHeaders, debouncedSearch, t, token])

  const loadMembers = useCallback(async (groupId: string) => {
    if (!token || !groupId) return
    setMembersLoading(true)
    try {
      const res = await fetch(`${apiUrl}/api/groups/${groupId}/members`, { headers: authHeaders() })
      const data = await res.json()
      if (!data.success) throw new Error(data.error || t('admin:groupManagement.toast.loadMembersFailed'))
      setMembers(data.members || [])
    } catch (error) {
      console.error('Failed to load members:', error)
      toast.error(error instanceof Error ? error.message : t('admin:groupManagement.toast.loadMembersFailed'))
    } finally {
      setMembersLoading(false)
    }
  }, [authHeaders, t, token])

  const loadGroupLimit = useCallback(async (groupId: string) => {
    if (!token || !groupId) return
    setLimitLoading(true)
    setLimitData(null)
    setLimitDailyInput('')
    setLimitMonthlyInput('')
    setLimitBudgetTimeRate('monthly')
    try {
      const res = await fetch(`${apiUrl}/api/groups/${groupId}/limit`, { headers: authHeaders() })
      const data = await res.json()
      if (data.success && data.data) {
        setLimitData(data.data)
        const budgets = data.data.budgets || []
        const unit = data.data.usageUnit || data.data.globalBudgets?.[0]?.unit || budgets[0]?.unit || 'token'
        const isUsd = unit === 'usd'
        const daily = budgets.find((b: BudgetItem) => b.timeRate === 'daily' && b.unit === unit)
        const monthly = budgets.find((b: BudgetItem) => b.timeRate === 'monthly' && b.unit === unit)
        setLimitDailyInput(daily && daily.value > 0 ? daily.value.toString() : '')
        setLimitMonthlyInput(monthly && monthly.value > 0 ? monthly.value.toString() : '')
        if (isUsd) {
          const existing = budgets.find((b: BudgetItem) => b.unit === 'usd' && b.value > 0)
          if (existing) setLimitBudgetTimeRate(existing.timeRate as 'daily' | 'monthly')
        }
      }
    } catch (error) {
      console.error('Failed to load group limit:', error)
    } finally {
      setLimitLoading(false)
    }
  }, [authHeaders, token])

  const saveGroupLimit = async () => {
    if (!limitGroup || !token) return
    setLimitSaving(true)
    try {
      const dailyVal = limitDailyInput.trim() === '' ? 0 : (limitIsUsd ? parseFloat(limitDailyInput) : parseInt(limitDailyInput, 10))
      const monthlyVal = limitMonthlyInput.trim() === '' ? 0 : (limitIsUsd ? parseFloat(limitMonthlyInput) : parseInt(limitMonthlyInput, 10))

      if (Number.isNaN(dailyVal) || dailyVal < 0 || Number.isNaN(monthlyVal) || monthlyVal < 0) {
        toast.error(t('admin:groupManagement.enterValidNumber'))
        return
      }

      let budgets
      if (limitIsUsd) {
        const val = limitBudgetTimeRate === 'daily' ? dailyVal : monthlyVal
        budgets = val > 0 ? [{ timeRate: limitBudgetTimeRate, value: val, unit: 'usd' }] : []
      } else {
        budgets = [
          ...(dailyVal > 0 ? [{ timeRate: 'daily', value: dailyVal, unit: 'token' }] : []),
          ...(monthlyVal > 0 ? [{ timeRate: 'monthly', value: monthlyVal, unit: 'token' }] : [])
        ]
      }

      const res = await fetch(`${apiUrl}/api/groups/${limitGroup.id}/limit`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ budgets })
      })
      const data = await res.json()
      if (data.success) {
        toast.success(data.message || t('admin:groupManagement.toast.limitSaved'))
        await loadGroupLimit(limitGroup.id)
      } else {
        toast.error(data.message || data.error || t('admin:groupManagement.toast.limitSaveFailed'))
      }
    } catch (error) {
      console.error('Failed to save group limit:', error)
      toast.error(error instanceof Error ? error.message : t('admin:groupManagement.toast.limitSaveFailed'))
    } finally {
      setLimitSaving(false)
    }
  }

  const openGroupLimitModal = async (group: Group) => {
    if (!canManageGroup(group) || group.apiKey.status !== 'ready') return
    setSelectedGroupId(group.id)
    setLimitGroup(group)
    setShowLimitModal(true)
    await loadGroupLimit(group.id)
  }

  const openEditGroupModal = (group: Group) => {
    if (!canManageGroup(group)) return
    setSelectedGroupId(group.id)
    setEditGroup({ name: group.name })
    setShowEditModal(true)
  }

  const openInstanceQuotaModal = (group: Group) => {
    if (!canManageGroup(group)) return
    setSelectedGroupId(group.id)
    setQuotaGroup(group)
    setQuotaInput(group.quota.limit === null || group.quota.limit === undefined ? '' : String(group.quota.limit))
    setShowQuotaModal(true)
  }

  const openMembersModal = async (group: Group) => {
    setSelectedGroupId(group.id)
    setMembers([])
    setNewMember({ email: '', role: 'member' })
    setMemberOptions([])
    setShowMemberOptions(false)
    setShowMembersModal(true)
    await loadMembers(group.id)
  }

  useEffect(() => {
    loadGroups()
  }, [loadGroups])

  useEffect(() => {
    if (!selectedGroup) {
      return
    }
    setEditGroup({
      name: selectedGroup.name
    })
  }, [selectedGroup])

  useEffect(() => {
    const query = newMember.email.trim()
    if (!isPlatformAdmin || !token || !showMemberOptions || !query) {
      setMemberOptions([])
      setMemberSearchLoading(false)
      return
    }

    let cancelled = false
    const timer = window.setTimeout(async () => {
      setMemberSearchLoading(true)
      try {
        const params = new URLSearchParams({ pageSize: '8', search: query })
        const endpoint = `/api/users?${params.toString()}`
        const res = await fetch(`${apiUrl}${endpoint}`, { headers: authHeaders() })
        const data = await res.json()
        if (!cancelled && data.success) {
          setMemberOptions((data.users || []).filter((user: UserOption) => user.status !== 'disabled'))
        }
      } catch (error) {
        console.error('Failed to search users:', error)
        if (!cancelled) setMemberOptions([])
      } finally {
        if (!cancelled) setMemberSearchLoading(false)
      }
    }, 250)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [authHeaders, isPlatformAdmin, newMember.email, showMemberOptions, token])

  const createGroup = async () => {
    if (!newGroup.name.trim()) {
      toast.error(t('admin:groupManagement.toast.nameRequired'))
      return
    }
    setSaving(true)
    try {
      const res = await fetch(`${apiUrl}/api/groups`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          name: newGroup.name.trim()
        })
      })
      const data = await res.json()
      if (!data.success) throw new Error(data.error || t('admin:groupManagement.toast.createFailed'))
      setNewGroup({ name: '' })
      setShowCreateModal(false)
      setSelectedGroupId(data.group.id)
      toast.success(t('admin:groupManagement.toast.created'))
      await loadGroups()
    } catch (error) {
      console.error('Failed to create group:', error)
      toast.error(error instanceof Error ? error.message : t('admin:groupManagement.toast.createFailed'))
    } finally {
      setSaving(false)
    }
  }

  const updateGroup = async () => {
    if (!selectedGroup) return
    setSaving(true)
    try {
      const res = await fetch(`${apiUrl}/api/groups/${selectedGroup.id}`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({
          name: editGroup.name.trim()
        })
      })
      const data = await res.json()
      if (!data.success) throw new Error(data.error || t('admin:groupManagement.toast.updateFailed'))
      toast.success(t('admin:groupManagement.toast.updated'))
      setShowEditModal(false)
      await loadGroups()
    } catch (error) {
      console.error('Failed to update group:', error)
      toast.error(error instanceof Error ? error.message : t('admin:groupManagement.toast.updateFailed'))
    } finally {
      setSaving(false)
    }
  }

  const updateInstanceQuota = async () => {
    if (!quotaGroup) return
    const trimmed = quotaInput.trim()
    const nextQuota = trimmed === '' ? 5 : parseInt(trimmed, 10)
    if (Number.isNaN(nextQuota) || nextQuota < 0) {
      toast.error(t('admin:groupManagement.enterValidNumber'))
      return
    }

    setSaving(true)
    try {
      const res = await fetch(`${apiUrl}/api/groups/${quotaGroup.id}`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({
          maxAgentInstances: nextQuota
        })
      })
      const data = await res.json()
      if (!data.success) throw new Error(data.error || t('admin:groupManagement.toast.quotaSaveFailed'))
      toast.success(t('admin:groupManagement.toast.quotaSaved'))
      setShowQuotaModal(false)
      setQuotaGroup(null)
      setQuotaInput('')
      await loadGroups()
    } catch (error) {
      console.error('Failed to update group instance quota:', error)
      toast.error(error instanceof Error ? error.message : t('admin:groupManagement.toast.quotaSaveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const addMember = async () => {
    const memberEmail = newMember.email.trim()
    if (!selectedGroup || !memberEmail) {
      toast.error(t('admin:groupManagement.toast.emailRequired'))
      return
    }
    if (!memberEmail.includes('@')) {
      toast.error(t('admin:groupManagement.toast.invalidEmail'))
      return
    }
    setSaving(true)
    try {
      const res = await fetch(`${apiUrl}/api/groups/${selectedGroup.id}/members`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          email: memberEmail,
          role: newMember.role
        })
      })
      const data = await res.json()
      if (!data.success) throw new Error(data.error || t('admin:groupManagement.toast.memberSaveFailed'))
      setNewMember({ email: '', role: 'member' })
      setMemberOptions([])
      setShowMemberOptions(false)
      toast.success(t('admin:groupManagement.toast.memberSaved'))
      await loadMembers(selectedGroup.id)
      await loadGroups()
    } catch (error) {
      console.error('Failed to add member:', error)
      toast.error(error instanceof Error ? error.message : t('admin:groupManagement.toast.memberSaveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const updateMemberRole = async (member: Member, role: Member['role']) => {
    if (!selectedGroup || !member.email || member.role === role) return
    setSaving(true)
    try {
      const res = await fetch(`${apiUrl}/api/groups/${selectedGroup.id}/members`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          email: member.email,
          role
        })
      })
      const data = await res.json()
      if (!data.success) throw new Error(data.error || t('admin:groupManagement.toast.memberSaveFailed'))
      toast.success(t('admin:groupManagement.toast.memberSaved'))
      await loadMembers(selectedGroup.id)
      await loadGroups()
    } catch (error) {
      console.error('Failed to update member role:', error)
      toast.error(error instanceof Error ? error.message : t('admin:groupManagement.toast.memberSaveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const removeMember = async (member: Member) => {
    if (!selectedGroup) return
    const label = member.email || member.username || member.principalId
    if (!window.confirm(t('admin:groupManagement.confirm.removeMember', { name: label }))) return
    setSaving(true)
    try {
      const res = await fetch(`${apiUrl}/api/groups/${selectedGroup.id}/members/${member.principalId}`, {
        method: 'DELETE',
        headers: authHeaders()
      })
      const data = await res.json()
      if (!data.success) throw new Error(data.error || t('admin:groupManagement.toast.memberRemoveFailed'))
      toast.success(t('admin:groupManagement.toast.memberRemoved'))
      await loadMembers(selectedGroup.id)
      await loadGroups()
    } catch (error) {
      console.error('Failed to remove member:', error)
      toast.error(error instanceof Error ? error.message : t('admin:groupManagement.toast.memberRemoveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const deleteGroup = async (group = selectedGroup) => {
    if (!group) return
    setSelectedGroupId(group.id)
    if (!window.confirm(t('admin:groupManagement.confirm.deleteGroup', { name: group.name }))) return
    setSaving(true)
    try {
      const res = await fetch(`${apiUrl}/api/groups/${group.id}`, {
        method: 'DELETE',
        headers: authHeaders()
      })
      const data = await res.json()
      if (!data.success) {
        const errorKey = data.error === 'GROUP_HAS_INSTANCES' ? 'hasInstances'
          : data.error === 'GROUP_HAS_ACTIVE_MEMBERS' ? 'hasMembers'
          : 'deleteFailed'
        throw new Error(t(`admin:groupManagement.toast.${errorKey}`))
      }
      toast.success(t('admin:groupManagement.toast.deleted'))
      setSelectedGroupId('')
      setShowEditModal(false)
      setShowMembersModal(false)
      await loadGroups()
    } catch (error) {
      console.error('Failed to delete group:', error)
      toast.error(error instanceof Error ? error.message : t('admin:groupManagement.toast.deleteFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="relative min-w-0 flex-1 sm:w-96 sm:flex-none">
          <Search className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder={t('admin:groupManagement.searchPlaceholder')}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="input-field pl-10"
          />
        </div>
        {isPlatformAdmin && (
          <button
            type="button"
            onClick={() => setShowCreateModal(true)}
            className="btn-primary flex h-10 w-10 shrink-0 items-center justify-center sm:w-auto sm:space-x-2"
            title={t('admin:groupManagement.createGroup')}
          >
            <Plus className="h-5 w-5" />
            <span className="hidden sm:inline">{t('admin:groupManagement.createGroup')}</span>
          </button>
        )}
      </div>

      <div className="card">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-primary-600" />
            <span className="ml-2 text-gray-600">{t('common:loading.default')}</span>
          </div>
        ) : (
          <div className="table-container">
            <table className="table-base">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium uppercase text-gray-500">
                    {t('admin:groupManagement.table.group')}
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium uppercase text-gray-500">
                    {t('admin:groupManagement.instanceCountColumn')}
                  </th>
                  {aiGatewayEnabled && (
                    <th className="px-6 py-3 text-left text-xs font-medium uppercase text-gray-500">
                      <span className="inline-flex items-center gap-1">
                        {isUsd ? t('admin:groupManagement.todayUsdSpend') : t('admin:groupManagement.todayTokenUsage')}
                        <span className="group relative inline-flex">
                          <HelpCircle className="h-3.5 w-3.5 cursor-help text-gray-400" />
                          <span className="pointer-events-none absolute left-1/2 top-full z-50 mt-1 -translate-x-1/2 whitespace-nowrap rounded bg-gray-800 px-2 py-1 text-xs font-normal normal-case text-white opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
                            {t('admin:groupManagement.todayHint')}
                          </span>
                        </span>
                      </span>
                    </th>
                  )}
                  {aiGatewayEnabled && (
                    <th className="px-6 py-3 text-left text-xs font-medium uppercase text-gray-500">
                      {isUsd ? t('admin:groupManagement.monthlyUsdSpend') : t('admin:groupManagement.monthlyTokenUsage')}
                    </th>
                  )}
                  <th className="px-6 py-3 text-left text-xs font-medium uppercase text-gray-500">
                    {t('admin:groupManagement.table.actions')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 bg-white">
                {groups.length === 0 ? (
                  <tr>
                    <td colSpan={aiGatewayEnabled ? 5 : 3} className="px-6 py-12 text-center text-gray-500">
                      {t('admin:groupManagement.noGroups')}
                    </td>
                  </tr>
                ) : (
                  groups.map(group => {
                    const canManage = canManageGroup(group)
                    const canSetGroupLimit = canManage && group.apiKey.status === 'ready'
                    return (
                      <tr key={group.id} className="hover:bg-gray-50">
                        <td className="whitespace-nowrap px-6 py-4">
                          <div className="text-sm font-medium text-gray-900">{group.name}</div>
                        </td>
                        <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-600">
                          {formatInstanceQuota(group)}
                        </td>
                        {aiGatewayEnabled && (
                          <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-600">
                            {formatUsageValue(getGroupUsageValue(group, consumerUsageMap))}
                          </td>
                        )}
                        {aiGatewayEnabled && (
                          <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-600">
                            {formatUsageValue(getGroupUsageValue(group, consumer30dUsageMap))}
                          </td>
                        )}
                        <td className="whitespace-nowrap px-6 py-4 text-sm font-medium">
                          <div className="flex items-center space-x-2">
                            <Tooltip content={t('admin:groupManagement.tooltipViewInstances')}>
                              <button
                                type="button"
                                onClick={() => {
                                  const basePath = isPlatformAdmin ? '/admin/instances' : '/user/instances'
                                  navigate(`${basePath}?groupId=${encodeURIComponent(group.id)}`)
                                }}
                                className="text-emerald-600 hover:text-emerald-900"
                              >
                                <Box className="h-4 w-4" />
                              </button>
                            </Tooltip>
                            {canManage && (
                              <Tooltip content={t('admin:groupManagement.tooltipEdit')}>
                                <button
                                  type="button"
                                  onClick={() => openEditGroupModal(group)}
                                  className="text-primary-600 hover:text-primary-900"
                                >
                                  <Edit2 className="h-4 w-4" />
                                </button>
                              </Tooltip>
                            )}
                            {canManage && (
                              <Tooltip content={t('admin:groupManagement.tooltipInstanceQuota')}>
                                <button
                                  type="button"
                                  onClick={() => openInstanceQuotaModal(group)}
                                  className="text-sky-600 hover:text-sky-900"
                                >
                                  <SlidersHorizontal className="h-4 w-4" />
                                </button>
                              </Tooltip>
                            )}
                            {canManage && (
                              <Tooltip
                                content={canSetGroupLimit
                                  ? (isUsd ? t('admin:groupManagement.tooltipBudgetLimit') : t('admin:groupManagement.tooltipTokenLimit'))
                                  : t('admin:groupManagement.noConsumer')}
                              >
                                <button
                                  type="button"
                                  onClick={() => openGroupLimitModal(group)}
                                  disabled={!canSetGroupLimit || limitLoading}
                                  className="text-amber-600 hover:text-amber-900 disabled:cursor-not-allowed disabled:text-gray-300"
                                >
                                  <Gauge className="h-4 w-4" />
                                </button>
                              </Tooltip>
                            )}
                            <Tooltip content={t('admin:groupManagement.tooltipMembers')}>
                              <button
                                type="button"
                                onClick={() => openMembersModal(group)}
                                className="text-indigo-600 hover:text-indigo-900"
                              >
                                <Users className="h-4 w-4" />
                              </button>
                            </Tooltip>
                            {isPlatformAdmin && (
                              <Tooltip content={t('admin:groupManagement.tooltipDeleteGroup')}>
                                <button
                                  type="button"
                                  onClick={() => deleteGroup(group)}
                                  disabled={saving}
                                  className="text-red-600 hover:text-red-900 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </button>
                              </Tooltip>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
    {showCreateModal && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 px-4">
        <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
          <h2 className="mb-4 text-xl font-semibold text-gray-900">
            {t('admin:groupManagement.createGroup')}
          </h2>
          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                {t('admin:groupManagement.groupName')} <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={newGroup.name}
                onChange={(e) => setNewGroup({ ...newGroup, name: e.target.value })}
                className="input-field"
                placeholder={t('admin:groupManagement.groupNamePlaceholder')}
                autoFocus
              />
            </div>
          </div>
          <div className="mt-6 flex justify-end space-x-3">
            <button
              type="button"
              onClick={() => {
                setShowCreateModal(false)
                setNewGroup({ name: '' })
              }}
              className="btn-secondary"
            >
              {t('common:buttons.cancel')}
            </button>
            <button
              type="button"
              onClick={createGroup}
              disabled={saving}
              className="btn-primary inline-flex items-center gap-2 disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              <span>{saving ? t('admin:groupManagement.saving') : t('admin:groupManagement.create')}</span>
            </button>
          </div>
        </div>
      </div>
    )}
    {showEditModal && selectedGroup && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 px-4">
        <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
          <h2 className="mb-4 text-xl font-semibold text-gray-900">
            {t('admin:groupManagement.editGroup')}
          </h2>
          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                {t('admin:groupManagement.groupName')} <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={editGroup.name}
                onChange={(e) => setEditGroup({ ...editGroup, name: e.target.value })}
                className="input-field"
                placeholder={t('admin:groupManagement.groupNamePlaceholder')}
                autoFocus
              />
            </div>
          </div>
          <div className="mt-6 flex justify-end space-x-3">
            <button
              type="button"
              onClick={() => setShowEditModal(false)}
              className="btn-secondary"
            >
              {t('common:buttons.cancel')}
            </button>
            <button
              type="button"
              onClick={updateGroup}
              disabled={saving}
              className="btn-primary inline-flex items-center gap-2 disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Edit2 className="h-4 w-4" />}
              <span>{saving ? t('admin:groupManagement.saving') : t('common:buttons.save')}</span>
            </button>
          </div>
        </div>
      </div>
    )}
    {showQuotaModal && quotaGroup && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 px-4">
        <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
          <h2 className="mb-2 text-xl font-semibold text-gray-900">
            {t('admin:groupManagement.instanceQuotaTitle')}
          </h2>
          <p className="mb-4 text-sm text-gray-500">
            {t('admin:groupManagement.instanceQuotaSubtitle', { name: quotaGroup.name })}
          </p>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">
              {t('admin:groupManagement.instanceQuotaLimit')}
            </label>
            <input
              type="number"
              min="0"
              step="1"
              value={quotaInput}
              onChange={(e) => setQuotaInput(e.target.value)}
              className="input-field"
              placeholder="5"
              autoFocus
            />
            <p className="mt-2 text-xs text-gray-500">
              {t('admin:groupManagement.instanceQuotaHint', { used: quotaGroup.quota.used })}
            </p>
          </div>
          <div className="mt-6 flex justify-end space-x-3">
            <button
              type="button"
              onClick={() => {
                setShowQuotaModal(false)
                setQuotaGroup(null)
                setQuotaInput('')
              }}
              className="btn-secondary"
            >
              {t('common:buttons.cancel')}
            </button>
            <button
              type="button"
              onClick={updateInstanceQuota}
              disabled={saving}
              className="btn-primary inline-flex items-center gap-2 disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <SlidersHorizontal className="h-4 w-4" />}
              <span>{saving ? t('admin:groupManagement.saving') : t('common:buttons.save')}</span>
            </button>
          </div>
        </div>
      </div>
    )}
    {showMembersModal && selectedGroup && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 px-4">
        <div className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-xl bg-white p-6 shadow-xl">
          <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold text-gray-900">
                {t('admin:groupManagement.manageMembers')}
              </h2>
              <p className="mt-1 text-sm text-gray-500">{selectedGroup.name}</p>
            </div>
            <button
              type="button"
              onClick={() => setShowMembersModal(false)}
              className="btn-secondary"
            >
              {t('common:buttons.close')}
            </button>
          </div>

          {canManageSelectedGroup && (
            <div className="mb-5 grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_160px_auto] lg:items-start">
              <div className="relative">
                <input
                  type="text"
                  value={newMember.email}
                  onFocus={() => setShowMemberOptions(isPlatformAdmin)}
                  onBlur={() => window.setTimeout(() => setShowMemberOptions(false), 150)}
                  onChange={(e) => {
                    setNewMember({ ...newMember, email: e.target.value })
                    setShowMemberOptions(isPlatformAdmin)
                  }}
                  className="input-field"
                  placeholder={isPlatformAdmin
                    ? t('admin:groupManagement.searchMemberPlaceholder')
                    : t('admin:groupManagement.memberEmailPlaceholder')}
                  autoComplete="off"
                />
                {isPlatformAdmin && showMemberOptions && newMember.email.trim() && (
                  <div className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-md border border-gray-200 bg-white shadow-lg">
                    {memberSearchLoading ? (
                      <div className="flex items-center px-3 py-2 text-sm text-gray-500">
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        {t('admin:groupManagement.searchingUsers')}
                      </div>
                    ) : memberOptions.length > 0 ? (
                      memberOptions.map(user => (
                        <button
                          key={user.id}
                          type="button"
                          onMouseDown={(event) => {
                            event.preventDefault()
                            setNewMember({ ...newMember, email: user.email || '' })
                            setShowMemberOptions(false)
                          }}
                          className="block w-full px-3 py-2 text-left hover:bg-primary-50"
                        >
                          <div className="truncate text-sm font-medium text-gray-900">
                            {user.username || user.email || user.id}
                          </div>
                          <div className="truncate text-xs text-gray-500">{user.email || t('admin:groupManagement.noEmail')}</div>
                        </button>
                      ))
                    ) : (
                      <div className="px-3 py-2 text-sm text-gray-500">{t('admin:groupManagement.noMatchUsers')}</div>
                    )}
                  </div>
                )}
              </div>
              <select
                value={newMember.role}
                onChange={(e) => setNewMember({ ...newMember, role: e.target.value as Member['role'] })}
                className="input-field h-[42px]"
              >
                <option value="member">{t('admin:groupManagement.roles.member')}</option>
                <option value="admin">{t('admin:groupManagement.roles.admin')}</option>
              </select>
              <button
                type="button"
                onClick={addMember}
                disabled={saving}
                className="btn-primary inline-flex h-[42px] items-center justify-center gap-2 whitespace-nowrap disabled:opacity-50"
              >
                <Plus className="h-4 w-4" />
                <span>{t('admin:groupManagement.saveMember')}</span>
              </button>
            </div>
          )}

          {membersLoading ? (
            <div className="flex items-center justify-center py-10 text-gray-500">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />
              {t('admin:groupManagement.loadingMembers')}
            </div>
          ) : (
            <div className="table-container">
              <table className="table-base">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">{t('admin:groupManagement.table.user')}</th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">{t('admin:groupManagement.table.role')}</th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">{t('admin:groupManagement.table.status')}</th>
                    {canManageSelectedGroup && (
                      <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">{t('admin:groupManagement.table.actions')}</th>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 bg-white">
                  {members.length === 0 ? (
                    <tr>
                      <td colSpan={canManageSelectedGroup ? 4 : 3} className="px-4 py-8 text-center text-sm text-gray-500">
                        {t('admin:groupManagement.noMembers')}
                      </td>
                    </tr>
                  ) : (
                    members.map(member => (
                      <tr key={member.principalId} className="hover:bg-gray-50">
                        <td className="whitespace-nowrap px-4 py-3">
                          <div>
                            <div className="text-sm font-medium text-gray-900">
                              {member.username || member.email || member.principalId}
                            </div>
                            <div className="text-sm text-gray-500">{member.email || t('admin:groupManagement.noEmail')}</div>
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-600">
                          {canManageSelectedGroup ? (
                            <select
                              value={member.role}
                              onChange={(e) => updateMemberRole(member, e.target.value as Member['role'])}
                              disabled={saving || !member.email}
                              className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-transparent focus:ring-2 focus:ring-primary-500 disabled:cursor-not-allowed disabled:bg-gray-50"
                            >
                              <option value="member">{t('admin:groupManagement.roles.member')}</option>
                              <option value="admin">{t('admin:groupManagement.roles.admin')}</option>
                            </select>
                          ) : (
                            <span className={`status-badge ${
                              member.role === 'admin' ? 'bg-purple-100 text-purple-800'
                                : 'bg-blue-100 text-blue-800'
                            }`}>
                              {formatRole(member.role)}
                            </span>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-600">
                          <span className={`status-badge ${member.status === 'active' ? 'status-active' : 'status-inactive'}`}>
                            {member.status}
                          </span>
                        </td>
                        {canManageSelectedGroup && (
                          <td className="whitespace-nowrap px-4 py-3 text-right">
                            <Tooltip content={t('admin:groupManagement.removeMember')}>
                              <button
                                type="button"
                                onClick={() => removeMember(member)}
                                disabled={saving}
                                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-red-600 hover:bg-red-50 hover:text-red-900 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                              >
                                <UserMinus className="h-4 w-4" />
                              </button>
                            </Tooltip>
                          </td>
                        )}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    )}
    {showLimitModal && limitGroup && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
        <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
          <h2 className="mb-1 flex items-center gap-2 text-xl font-semibold text-gray-900">
            <Gauge className="h-5 w-5 text-amber-500" />
            {limitIsUsd ? t('admin:groupManagement.budgetLimit') : t('admin:groupManagement.tokenLimit')}
          </h2>
          <p className="mb-4 text-sm text-gray-500">
            {limitIsUsd
              ? t('admin:groupManagement.setGroupBudgetLimit', { name: limitGroup.name })
              : t('admin:groupManagement.setGroupTokenLimit', { name: limitGroup.name })}
          </p>

          {limitLoading ? (
            <div className="flex items-center justify-center py-8 text-gray-500">
              <Loader2 className="h-6 w-6 animate-spin text-amber-500" />
              <span className="ml-2">{t('common:loading.default')}</span>
            </div>
          ) : !limitData || (!limitData.hasConsumer && !limitData.enabled) ? (
            <p className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-500">
              {t('admin:groupManagement.noConsumer')}
            </p>
          ) : (
            <div className="space-y-4">
              {(effectiveDailyLimit > 0 || effectiveMonthlyLimit > 0) && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
                  <p className="mb-2 text-sm font-medium text-amber-800">
                    {limitIsUsd ? t('admin:groupManagement.currentEffectiveBudgetLimit') : t('admin:groupManagement.currentEffectiveTokenLimit')}
                  </p>
                  <div className="flex flex-wrap gap-3">
                    {effectiveDailyLimit > 0 && (
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm text-amber-700">{t('admin:groupManagement.daily')}</span>
                        <span className="text-sm font-semibold text-amber-900">{formatLimitValue(effectiveDailyLimit)}</span>
                        <span className={`rounded-full px-1.5 py-0.5 text-xs ${
                          limitDailyInput && parseFloat(limitDailyInput) > 0
                            ? 'bg-blue-100 text-blue-700'
                            : 'bg-gray-100 text-gray-600'
                        }`}>
                          {limitDailyInput && parseFloat(limitDailyInput) > 0 ? t('admin:groupManagement.groupSpecific') : t('admin:groupManagement.defaultLabel')}
                        </span>
                      </div>
                    )}
                    {effectiveMonthlyLimit > 0 && (
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm text-amber-700">{t('admin:groupManagement.monthly')}</span>
                        <span className="text-sm font-semibold text-amber-900">{formatLimitValue(effectiveMonthlyLimit)}</span>
                        <span className={`rounded-full px-1.5 py-0.5 text-xs ${
                          limitMonthlyInput && parseFloat(limitMonthlyInput) > 0
                            ? 'bg-blue-100 text-blue-700'
                            : 'bg-gray-100 text-gray-600'
                        }`}>
                          {limitMonthlyInput && parseFloat(limitMonthlyInput) > 0 ? t('admin:groupManagement.groupSpecific') : t('admin:groupManagement.defaultLabel')}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {(globalDailyLimit > 0 || globalMonthlyLimit > 0) && (
                <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-2">
                  <p className="mb-1 text-xs text-gray-500">
                    {limitIsUsd ? t('admin:groupManagement.defaultBudgetStrategy') : t('admin:groupManagement.defaultRateLimitStrategy')}
                  </p>
                  <div className="flex flex-wrap gap-3 text-xs text-gray-600">
                    {globalDailyLimit > 0 && <span>{t('admin:groupManagement.daily')} {formatLimitValue(globalDailyLimit)}</span>}
                    {globalMonthlyLimit > 0 && <span>{t('admin:groupManagement.monthly')} {formatLimitValue(globalMonthlyLimit)}</span>}
                  </div>
                </div>
              )}

              {limitIsUsd ? (
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">{t('admin:groupManagement.budgetLimitGroup')}</label>
                  <div className="flex items-center gap-3">
                    <select
                      value={limitBudgetTimeRate}
                      onChange={(e) => {
                        const newRate = e.target.value as 'daily' | 'monthly'
                        if (newRate === 'daily' && limitBudgetTimeRate === 'monthly') {
                          setLimitDailyInput(limitMonthlyInput)
                          setLimitMonthlyInput('')
                        } else if (newRate === 'monthly' && limitBudgetTimeRate === 'daily') {
                          setLimitMonthlyInput(limitDailyInput)
                          setLimitDailyInput('')
                        }
                        setLimitBudgetTimeRate(newRate)
                      }}
                      className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-transparent focus:ring-2 focus:ring-amber-500"
                    >
                      <option value="daily">{t('admin:groupManagement.perDay')}</option>
                      <option value="monthly">{t('admin:groupManagement.per30Days')}</option>
                    </select>
                    <input
                      type="text"
                      value={limitBudgetTimeRate === 'daily' ? limitDailyInput : limitMonthlyInput}
                      onChange={(e) => {
                        const value = e.target.value
                        if (value === '' || /^\d*\.?\d*$/.test(value)) {
                          if (limitBudgetTimeRate === 'daily') setLimitDailyInput(value)
                          else setLimitMonthlyInput(value)
                        }
                      }}
                      placeholder="0"
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-transparent focus:ring-2 focus:ring-amber-500"
                    />
                    <span className="whitespace-nowrap text-sm text-gray-500">
                      {limitBudgetTimeRate === 'daily' ? t('admin:groupManagement.usdPerDay') : t('admin:groupManagement.usdPer30Days')}
                    </span>
                  </div>
                </div>
              ) : (
                <>
                  <div>
                    <label className="mb-1 block text-sm font-medium text-gray-700">{t('admin:groupManagement.dailyTokenLimitGroup')}</label>
                    <div className="flex items-center gap-3">
                      <input
                        type="text"
                        value={limitDailyInput}
                        onChange={(e) => {
                          const value = e.target.value
                          if (value === '' || /^\d+$/.test(value)) setLimitDailyInput(value)
                        }}
                        placeholder={globalDailyLimit > 0 ? t('admin:groupManagement.inheritDefault', { value: globalDailyLimit.toLocaleString() }) : t('admin:groupManagement.noLimit')}
                        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-transparent focus:ring-2 focus:ring-amber-500"
                      />
                      <span className="whitespace-nowrap text-sm text-gray-500">{t('admin:groupManagement.tokensPerDay')}</span>
                    </div>
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-medium text-gray-700">{t('admin:groupManagement.monthlyTokenLimitGroup')}</label>
                    <div className="flex items-center gap-3">
                      <input
                        type="text"
                        value={limitMonthlyInput}
                        onChange={(e) => {
                          const value = e.target.value
                          if (value === '' || /^\d+$/.test(value)) setLimitMonthlyInput(value)
                        }}
                        placeholder={globalMonthlyLimit > 0 ? t('admin:groupManagement.inheritDefault', { value: globalMonthlyLimit.toLocaleString() }) : t('admin:groupManagement.noLimit')}
                        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-transparent focus:ring-2 focus:ring-amber-500"
                      />
                      <span className="whitespace-nowrap text-sm text-gray-500">{t('admin:groupManagement.tokensPer30Days')}</span>
                    </div>
                  </div>
                </>
              )}
              <p className="text-xs text-gray-500">{t('admin:groupManagement.limitHintClear')}</p>
            </div>
          )}

          <div className="mt-6 flex justify-end space-x-3">
            <button
              type="button"
              onClick={() => setShowLimitModal(false)}
              className="btn-secondary"
            >
              {t('common:buttons.close')}
            </button>
            <button
              type="button"
              onClick={saveGroupLimit}
              disabled={limitSaving || limitLoading || !limitData || (!limitData.hasConsumer && !limitData.enabled)}
              className="inline-flex items-center gap-2 rounded-lg bg-amber-500 px-4 py-2 text-sm text-white transition-colors hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {limitSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Gauge className="h-4 w-4" />}
              {limitSaving ? t('admin:groupManagement.saving') : t('admin:groupManagement.saveLimit')}
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  )
}

export default GroupManagement
