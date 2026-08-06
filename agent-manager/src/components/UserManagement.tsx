import React, { useState, useEffect, useRef, useCallback } from 'react'
import { Edit2, Trash2, Search, Plus, Loader2, Upload, Download, ChevronLeft, ChevronRight, ExternalLink, Gauge, Lock, UserX, Eye, EyeOff, Network, HelpCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { useAuth } from '../contexts/AuthContext'
import { apiUrl } from '../lib/api'
import Tooltip from './Tooltip'

/**
 * Sanitize email to consumer name (must match server-side sanitizeConsumerName in apig.js)
 */
function sanitizeConsumerName(email: string): string {
  let name = email.replace(/@/g, '.').replace(/[^a-zA-Z0-9.-]/g, '-')
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

interface UserProfile {
  id: string
  username: string
  email: string
  role: string
  status: string
  max_agent_instances: number
  created_at: string
  consumer_id?: string
}

interface User {
  id: string
  username: string
  email: string
  role: 'admin' | 'user'
  status: 'active' | 'disabled'
  maxInstances: number
  createdAt: string
  consumerId?: string
}

interface Pagination {
  page: number
  pageSize: number
  total: number
  totalPages: number
}

interface ConsumerUsageItem {
  consumer: string
  value?: number
  totalToken?: number
}

interface BudgetEntry {
  timeRate: string
  value: number
  unit: string
}

const UserManagement: React.FC = () => {
  const { t } = useTranslation(['admin', 'common'])
  const navigate = useNavigate()
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    pageSize: 10,
    total: 0,
    totalPages: 0
  })
  const [aiGatewayRegionId, setAiGatewayRegionId] = useState<string>('')
  const [aiGatewayEnabled, setAiGatewayEnabled] = useState<boolean>(false)
  const [usageUnit, setUsageUnit] = useState<string>('token')
  const [litellmProxyUrl, setLitellmProxyUrl] = useState<string>('')
  const [consumerTokenMap, setConsumerTokenMap] = useState<Map<string, number>>(new Map())
  const [consumer30dTokenMap, setConsumer30dTokenMap] = useState<Map<string, number>>(new Map())
  const [editingUser, setEditingUser] = useState<User | null>(null)
  const [showEditModal, setShowEditModal] = useState(false)
  const [showAddModal, setShowAddModal] = useState(false)
  const [saving, setSaving] = useState(false)
  const [newUser, setNewUser] = useState({
    username: '',
    email: '',
    password: '',
    role: 'user' as 'admin' | 'user',
    maxInstances: 5,
    authProvider: 'email' as 'email' | 'oauth' | 'saml'
  })
  const [showBatchModal, setShowBatchModal] = useState(false)
  const [batchData, setBatchData] = useState('')
  const [batchResult, setBatchResult] = useState<{
    total: number
    created: number
    failed: number
    errors: { email: string; error: string }[]
  } | null>(null)
  const [batchImporting, setBatchImporting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { session, user: currentUser, signOut } = useAuth()
  const [ssoStatus, setSsoStatus] = useState({ oauthEnabled: false, samlEnabled: false })

  // Token rate limit modal state
  const [showTokenLimitModal, setShowTokenLimitModal] = useState(false)
  const [tokenLimitUser, setTokenLimitUser] = useState<User | null>(null)
  const [tokenLimitLoading, setTokenLimitLoading] = useState(false)
  const [tokenLimitSaving, setTokenLimitSaving] = useState(false)
  const [userDailyLimit, setUserDailyLimit] = useState('')
  const [userMonthlyLimit, setUserMonthlyLimit] = useState('')
  const [globalDailyLimit, setGlobalDailyLimit] = useState(0)
  const [globalMonthlyLimit, setGlobalMonthlyLimit] = useState(0)
  const [effectiveDailyLimit, setEffectiveDailyLimit] = useState(0)
  const [effectiveMonthlyLimit, setEffectiveMonthlyLimit] = useState(0)
  const [tokenLimitError, setTokenLimitError] = useState('')
  const [tokenLimitSuccess, setTokenLimitSuccess] = useState('')
  const [budgetTimeRate, setBudgetTimeRate] = useState<'daily' | 'monthly'>('monthly')

  // Password change modal state
  const [showPasswordModal, setShowPasswordModal] = useState(false)
  const [passwordUser, setPasswordUser] = useState<User | null>(null)
  const [newPassword, setNewPassword] = useState('')
  const [showNewUserPwd, setShowNewUserPwd] = useState(false)
  const [showResetPwd, setShowResetPwd] = useState(false)
  const [passwordSaving, setPasswordSaving] = useState(false)

  // Delete user confirmation state
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deleteUser, setDeleteUser] = useState<User | null>(null)
  const [deleting, setDeleting] = useState(false)

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchTerm)
    }, 300)
    return () => clearTimeout(timer)
  }, [searchTerm])

  // 缓存 token 引用，避免 session 对象变化导致无限循环
  const tokenRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    tokenRef.current = session?.access_token
  }, [session?.access_token])

  // 获取 SSO 启用状态（用于添加用户时动态显示认证方式）
  useEffect(() => {
    const fetchSSOStatus = async () => {
      try {
        const token = tokenRef.current
        if (!token) return
        const resp = await fetch(`${apiUrl}/api/sso/auth-providers`, {
          headers: { 'Authorization': `Bearer ${token}` }
        })
        if (resp.ok) {
          const data = await resp.json()
          if (data.success) {
            const activeMode = data.activeMode || 'none'
            setSsoStatus({
              oauthEnabled: activeMode === 'oauth',
              samlEnabled: activeMode === 'saml'
            })
          }
        }
      } catch (err) {
        console.error('Failed to fetch SSO status:', err)
      }
    }
    fetchSSOStatus()
  }, [session?.access_token])

  // Fetch current provider stats to determine enabled status and usage unit
  useEffect(() => {
    const fetchProviderStats = async () => {
      try {
        const token = session?.access_token
        if (!token) return

        const response = await fetch(`${apiUrl}/api/providers/current/stats`, {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        })
        const data = await response.json()
        if (data.success && data.stats) {
          setAiGatewayEnabled(!!data.stats.aiGatewayEnabled && !!data.stats.slsEnabled)
          setUsageUnit(data.stats.usageUnit || 'token')
          if (data.stats.proxyUrl) {
            setLitellmProxyUrl(data.stats.proxyUrl)
          }
        }

        // Fetch AlibabaCloud-specific config for console link (only when provider uses tokens)
        if (!data.stats?.usageUnit || data.stats.usageUnit !== 'usd') {
          const configRes = await fetch(`${apiUrl}/api/providers/api_gateway/config`, {
            headers: { 'Authorization': `Bearer ${token}` }
          })
          const configData = await configRes.json()
          if (configData.success) {
            setAiGatewayRegionId(configData.config?.regionId || '')
          }
        }
      } catch (error) {
        console.error('Error fetching provider stats:', error)
      }
    }
    fetchProviderStats()
  }, [session?.access_token])

  // Fetch consumer usage when provider is enabled
  const fetchConsumerTokens = useCallback(async () => {
    if (!aiGatewayEnabled) return

    try {
      const token = session?.access_token
      if (!token) return

      const [tokenRes, token30dRes] = await Promise.allSettled([
        fetch(`${apiUrl}/api/providers/current/tokens?days=1`, {
          headers: { 'Authorization': `Bearer ${token}` }
        }),
        fetch(`${apiUrl}/api/providers/current/tokens?days=30`, {
          headers: { 'Authorization': `Bearer ${token}` }
        })
      ])

      if (tokenRes.status === 'fulfilled') {
        const tokenData = await tokenRes.value.json()
        if (tokenData.success && tokenData.consumers) {
          const tokenMap = new Map<string, number>()
          const consumers = tokenData.consumers as ConsumerUsageItem[]
          consumers.forEach((item) => {
            tokenMap.set(item.consumer, item.value ?? item.totalToken ?? 0)
          })
          setConsumerTokenMap(tokenMap)
        }
      }

      if (token30dRes.status === 'fulfilled') {
        const token30dData = await token30dRes.value.json()
        if (token30dData.success && token30dData.consumers) {
          const tokenMap = new Map<string, number>()
          const consumers = token30dData.consumers as ConsumerUsageItem[]
          consumers.forEach((item) => {
            tokenMap.set(item.consumer, item.value ?? item.totalToken ?? 0)
          })
          setConsumer30dTokenMap(tokenMap)
        }
      }
    } catch (error) {
      console.error('Error fetching consumer usage:', error)
    }
  }, [aiGatewayEnabled, session?.access_token])

  // Fetch consumer tokens when AI Gateway status changes
  useEffect(() => {
    fetchConsumerTokens()
  }, [fetchConsumerTokens])

  const isUsd = usageUnit === 'usd'

  // Helper: look up user usage from consumer maps (works for both AlibabaCloud and LiteLLM)
  const getUserUsageValue = (user: User, map: Map<string, number>): number | undefined => {
    // LiteLLM: consumer key is user_id (stored as consumerId)
    if (user.consumerId && map.has(user.consumerId)) {
      return map.get(user.consumerId)
    }
    // AlibabaCloud: consumer key is sanitized email
    const sanitized = sanitizeConsumerName(user.email)
    if (map.has(sanitized)) {
      return map.get(sanitized)
    }
    return undefined
  }

  // Helper: format usage value based on unit
  const formatUsageValue = (value: number | undefined): string => {
    if (value === undefined) return '-'
    if (isUsd) return `$${value.toFixed(4)}`
    return value.toLocaleString()
  }

  // Fetch users from API
  const fetchUsers = useCallback(async (page: number) => {
    console.log('[UserManagement] fetchUsers called, page:', page)
    try {
      setLoading(true)
      const token = tokenRef.current
      console.log('[UserManagement] Got token:', !!token)

      if (!token) {
        console.error('Not authenticated')
        setLoading(false)
        return
      }

      const params = new URLSearchParams({
        page: page.toString(),
        pageSize: '10'
      })

      if (debouncedSearch) {
        params.append('search', debouncedSearch)
      }

      console.log('Fetching users with params:', params.toString())

      const response = await fetch(`${apiUrl}/api/users?${params}`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      })

      const data = await response.json()

      console.log('API response:', data)

      if (!data.success) {
        throw new Error(data.error || 'Failed to fetch users')
      }

      // Map database fields to UI fields
      const mappedUsers: User[] = (data.users as UserProfile[] || []).map(row => ({
        id: row.id,
        username: row.username,
        email: row.email,
        role: row.role as 'admin' | 'user',
        status: row.status === 'active' ? 'active' : 'disabled',
        maxInstances: row.max_agent_instances,
        createdAt: row.created_at,
        consumerId: row.consumer_id
      }))

      setUsers(mappedUsers)
      setPagination(data.pagination)
    } catch (error) {
      console.error('Error fetching users:', error)
    } finally {
      setLoading(false)
    }
  }, [debouncedSearch])

  // Load when session is available or the debounced search query changes.
  useEffect(() => {
    if (session?.access_token) {
      console.log('[UserManagement] Session available, loading users')
      fetchUsers(1)
    }
  }, [session?.access_token, fetchUsers])

  const handlePageChange = (newPage: number) => {
    if (newPage >= 1 && newPage <= pagination.totalPages) {
      fetchUsers(newPage)
    }
  }

  const handleEdit = (user: User) => {
    setEditingUser({ ...user })
    setShowEditModal(true)
  }

  const handleResetPassword = (userId: string) => {
    const user = users.find(u => u.id === userId)
    if (!user) return
    setPasswordUser(user)
    setNewPassword('')
    setShowPasswordModal(true)
  }

  const handleChangePassword = async () => {
    if (!passwordUser) return
    if (!newPassword || newPassword.length < 6) {
      alert(t('admin:userManagement.passwordMinLength'))
      return
    }

    setPasswordSaving(true)
    try {
      const token = session?.access_token
      if (!token) throw new Error(t('admin:userManagement.sessionExpired'))

      const response = await fetch(`${apiUrl}/api/users/${passwordUser.id}/password`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ password: newPassword })
      })

      const data = await response.json()
      if (!data.success) throw new Error(data.error || t('admin:userManagement.passwordChangeFailed'))

      if (passwordUser.id === currentUser?.id) {
        // 管理员改了自己的密码：清除本地 session 后立刻跳转 /admin/login。
        // 否则页面刷新后 AuthContext 会从 localStorage 恢复旧 session，
        // AdminLogin 检测到已登录又会把用户重定向到 /admin/dashboard。
        // 注意：signOut 走 fire-and-forget，不能 await，
        // 因为预发环境的 supabase 调用偶尔会卡十几秒。
        signOut().catch(err => console.error('[UserManagement] signOut failed:', err))
        // 主动清掉所有 supabase 持久化的 token，确保 AuthContext 重启时拿不到旧 session
        Object.keys(localStorage)
          .filter(k => k.startsWith('sb-'))
          .forEach(k => localStorage.removeItem(k))
        window.location.replace('/admin/login')
        return
      }
      alert(t('admin:userManagement.passwordChangeSuccess'))
      setShowPasswordModal(false)
      setPasswordUser(null)
      setNewPassword('')
    } catch (error) {
      console.error('Error changing password:', error)
      alert(t('admin:userManagement.passwordChangeFailedWithReason', { reason: error instanceof Error ? error.message : t('admin:userManagement.unknownError') }))
    } finally {
      setPasswordSaving(false)
    }
  }

  const handleConfirmDelete = (user: User) => {
    setDeleteUser(user)
    setShowDeleteConfirm(true)
  }

  const handleDeleteUser = async () => {
    if (!deleteUser) return

    setDeleting(true)
    try {
      const token = session?.access_token
      if (!token) throw new Error(t('admin:userManagement.sessionExpired'))

      const response = await fetch(`${apiUrl}/api/users/${deleteUser.id}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      })

      const data = await response.json()
      if (!data.success) {
        if (data.errorCode === 'USER_HAS_INSTANCES') {
          toast.error(t('admin:userManagement.userHasInstances', { count: data.instanceCount ?? 0 }))
          return
        }
        throw new Error(data.error || t('admin:userManagement.deleteFailed'))
      }

      toast.success(t('admin:userManagement.userDeleted'))
      setShowDeleteConfirm(false)
      setDeleteUser(null)
      fetchUsers(pagination.page)
    } catch (error) {
      console.error('Error deleting user:', error)
      toast.error(t('admin:userManagement.deleteFailedWithReason', { reason: error instanceof Error ? error.message : t('admin:userManagement.unknownError') }))
    } finally {
      setDeleting(false)
    }
  }

  const handleToggleStatus = async (userId: string) => {
    const user = users.find(u => u.id === userId)
    if (!user) return

    const newStatus = user.status === 'active' ? 'disabled' : 'active'

    try {
      const token = session?.access_token
      if (!token) {
        throw new Error(t('admin:userManagement.sessionExpired'))
      }

      const response = await fetch(`${apiUrl}/api/users/${userId}/status`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ status: newStatus })
      })

      const data = await response.json()
      if (!data.success) {
        throw new Error(data.error || t('admin:userManagement.updateStatusFailed'))
      }

      setUsers(prev => prev.map(u =>
        u.id === userId ? { ...u, status: newStatus } : u
      ))
    } catch (error) {
      console.error('Error updating user status:', error)
      alert(t('admin:userManagement.updateStatusFailedWithReason', { reason: error instanceof Error ? error.message : t('admin:userManagement.unknownError') }))
    }
  }

  // Open token rate limit modal for a user
  const handleOpenTokenLimit = async (user: User) => {
    setTokenLimitUser(user)
    setTokenLimitError('')
    setTokenLimitSuccess('')
    setUserDailyLimit('')
    setUserMonthlyLimit('')
    setGlobalDailyLimit(0)
    setGlobalMonthlyLimit(0)
    setEffectiveDailyLimit(0)
    setEffectiveMonthlyLimit(0)
    setBudgetTimeRate('monthly')
    setShowTokenLimitModal(true)
    setTokenLimitLoading(true)

    try {
      const token = session?.access_token
      if (!token) return

      const res = await fetch(`${apiUrl}/api/providers/current/user-limit?userId=${user.id}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      })
      const data = await res.json()

      if (data.success && data.config) {
        const budgets: Array<{timeRate: string, value: number, unit: string}> = data.config.budgets || []
        const globalBudgets: Array<{timeRate: string, value: number, unit: string}> = data.config.globalBudgets || []
        const effectiveBudgets: Array<{timeRate: string, value: number, unit: string}> = data.config.effectiveBudgets || []

        const userDaily = budgets.find(b => b.timeRate === 'daily' && b.unit === usageUnit)
        const userMonthly = budgets.find(b => b.timeRate === 'monthly' && b.unit === usageUnit)
        const globalDaily = globalBudgets.find(b => b.timeRate === 'daily' && b.unit === usageUnit)
        const globalMonthly = globalBudgets.find(b => b.timeRate === 'monthly' && b.unit === usageUnit)
        const effectiveDaily = effectiveBudgets.find(b => b.timeRate === 'daily' && b.unit === usageUnit)
        const effectiveMonthly = effectiveBudgets.find(b => b.timeRate === 'monthly' && b.unit === usageUnit)

        setUserDailyLimit(userDaily && userDaily.value > 0 ? userDaily.value.toString() : '')
        setUserMonthlyLimit(userMonthly && userMonthly.value > 0 ? userMonthly.value.toString() : '')
        setGlobalDailyLimit(globalDaily?.value || 0)
        setGlobalMonthlyLimit(globalMonthly?.value || 0)
        setEffectiveDailyLimit(effectiveDaily?.value || 0)
        setEffectiveMonthlyLimit(effectiveMonthly?.value || 0)

        // LiteLLM: detect existing budget timeRate for the single-budget selector
        if (isUsd) {
          const existingBudget = budgets.find(b => b.unit === 'usd' && b.value > 0)
          if (existingBudget) setBudgetTimeRate(existingBudget.timeRate as 'daily' | 'monthly')
        }
      }
    } catch (err) {
      console.error('Error fetching user token limit:', err)
      setTokenLimitError(t('admin:userManagement.loadRateLimitFailed'))
    } finally {
      setTokenLimitLoading(false)
    }
  }

  // Save per-user token rate limit
  const handleSaveTokenLimit = async () => {
    if (!tokenLimitUser) return

    setTokenLimitSaving(true)
    setTokenLimitError('')
    setTokenLimitSuccess('')

    try {
      const token = session?.access_token
      if (!token) {
        setTokenLimitError(t('admin:userManagement.notLoggedIn'))
        setTokenLimitSaving(false)
        return
      }

      const dailyTokenLimit = userDailyLimit.trim() === '' ? 0 : (isUsd ? parseFloat(userDailyLimit) : parseInt(userDailyLimit, 10))
      const monthlyTokenLimit = userMonthlyLimit.trim() === '' ? 0 : (isUsd ? parseFloat(userMonthlyLimit) : parseInt(userMonthlyLimit, 10))

      if (isNaN(dailyTokenLimit) || dailyTokenLimit < 0 || isNaN(monthlyTokenLimit) || monthlyTokenLimit < 0) {
        setTokenLimitError(t('admin:userManagement.enterValidNumber'))
        setTokenLimitSaving(false)
        return
      }

      const res = await fetch(`${apiUrl}/api/providers/current/user-limit`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          userId: tokenLimitUser.id,
          budgets: isUsd
            ? ((() => {
                const val = budgetTimeRate === 'daily' ? dailyTokenLimit : monthlyTokenLimit
                return val > 0 ? [{ timeRate: budgetTimeRate, value: val, unit: 'usd' }] : []
              })())
            : [
                ...(dailyTokenLimit > 0 ? [{ timeRate: 'daily', value: dailyTokenLimit, unit: 'token' }] : []),
                ...(monthlyTokenLimit > 0 ? [{ timeRate: 'monthly', value: monthlyTokenLimit, unit: 'token' }] : [])
              ]
        })
      })

      const data = await res.json()

      if (data.success) {
        setTokenLimitSuccess(data.message || t('admin:userManagement.rateLimitSaved'))

        // Re-fetch to update effective limits display
        try {
          const refetchRes = await fetch(`${apiUrl}/api/providers/current/user-limit?userId=${tokenLimitUser.id}`, {
            headers: { 'Authorization': `Bearer ${token}` }
          })
          const refetchData = await refetchRes.json()
          if (refetchData.success && refetchData.config) {
            const budgets: BudgetEntry[] = refetchData.config.budgets || []
            const globalBudgets: BudgetEntry[] = refetchData.config.globalBudgets || []
            const effectiveBudgets: BudgetEntry[] = refetchData.config.effectiveBudgets || []

            const userDaily = budgets.find((b) => b.timeRate === 'daily' && b.unit === usageUnit)
            const userMonthly = budgets.find((b) => b.timeRate === 'monthly' && b.unit === usageUnit)
            const globalDaily = globalBudgets.find((b) => b.timeRate === 'daily' && b.unit === usageUnit)
            const globalMonthly = globalBudgets.find((b) => b.timeRate === 'monthly' && b.unit === usageUnit)
            const effectiveDaily = effectiveBudgets.find((b) => b.timeRate === 'daily' && b.unit === usageUnit)
            const effectiveMonthly = effectiveBudgets.find((b) => b.timeRate === 'monthly' && b.unit === usageUnit)

            setUserDailyLimit(userDaily && userDaily.value > 0 ? userDaily.value.toString() : '')
            setUserMonthlyLimit(userMonthly && userMonthly.value > 0 ? userMonthly.value.toString() : '')
            setGlobalDailyLimit(globalDaily?.value || 0)
            setGlobalMonthlyLimit(globalMonthly?.value || 0)
            setEffectiveDailyLimit(effectiveDaily?.value || 0)
            setEffectiveMonthlyLimit(effectiveMonthly?.value || 0)
          }
        } catch (err) {
          console.warn('Failed to refresh token limit data:', err)
        }
      } else {
        setTokenLimitError(data.error || t('admin:userManagement.saveFailed'))
      }
    } catch (err) {
      console.error('Error saving user token limit:', err)
      setTokenLimitError(t('admin:userManagement.saveRateLimitFailed'))
    } finally {
      setTokenLimitSaving(false)
    }
  }

  const handleSaveEdit = async () => {
    if (!editingUser) return

    setSaving(true)
    try {
      const token = session?.access_token
      if (!token) {
        throw new Error(t('admin:userManagement.sessionExpiredRetry'))
      }

      const response = await fetch(`${apiUrl}/api/users/${editingUser.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          username: editingUser.username,
          email: editingUser.email,
          role: editingUser.role,
          status: editingUser.status,
          maxInstances: editingUser.maxInstances
        })
      })

      const data = await response.json()
      if (!data.success) {
        throw new Error(data.error || t('admin:userManagement.saveFailed'))
      }

      setShowEditModal(false)
      setEditingUser(null)
      // Refresh current page
      fetchUsers(pagination.page)
    } catch (error) {
      console.error('Error updating user:', error)
      alert(t('admin:userManagement.saveFailedWithReason', { reason: error instanceof Error ? error.message : t('admin:userManagement.unknownError') }))
    } finally {
      setSaving(false)
    }
  }

  const handleAddUser = async () => {
    const isExternalAuth = ['oauth', 'saml'].includes(newUser.authProvider)

    // OAuth/SAML 用户邮箱可选，邮箱登录用户必须填邮箱
    if (!newUser.username) {
      alert(t('admin:userManagement.usernameRequired'))
      return
    }
    if (!isExternalAuth && !newUser.email) {
      alert(t('admin:userManagement.emailRequiredForEmail'))
      return
    }

    // Password required only for email auth
    if (!isExternalAuth) {
      if (!newUser.password) {
        alert(t('admin:userManagement.passwordRequiredForEmail'))
        return
      }
      if (newUser.password.length < 6) {
        alert(t('admin:userManagement.passwordMinLength'))
        return
      }
    }

    // OAuth/SAML 用户如果没填邮箱，生成占位邮箱
    const userEmail = newUser.email || `${newUser.username}@${newUser.authProvider}.local`

    setSaving(true)
    try {
      const token = session?.access_token
      if (!token) {
        throw new Error(t('admin:userManagement.sessionExpired'))
      }

      const response = await fetch(`${apiUrl}/api/users`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          email: userEmail,
          password: newUser.password || undefined,
          username: newUser.username,
          role: newUser.role,
          maxInstances: newUser.maxInstances,
          authProvider: newUser.authProvider
        })
      })

      const data = await response.json()

      if (!data.success) {
        throw new Error(data.error || t('admin:userManagement.createFailed'))
      }

      // Reset form and close modal
      setNewUser({
        username: '',
        email: '',
        password: '',
        role: 'user',
        maxInstances: 5,
        authProvider: 'email'
      })
      setShowAddModal(false)

      if (isExternalAuth) {
        alert(t('admin:userManagement.userCreatedExternal', { username: newUser.username, authProvider: newUser.authProvider.toUpperCase() }))
      } else {
        alert(t('admin:userManagement.userCreatedEmail', { email: userEmail, password: newUser.password }))
      }

      // Refresh user list
      fetchUsers(1)

    } catch (error) {
      console.error('Error adding user:', error)
      alert(t('admin:userManagement.createUserFailed', { reason: error instanceof Error ? error.message : t('admin:userManagement.unknownError') }))
    } finally {
      setSaving(false)
    }
  }

  // Parse CSV data
  const parseCSV = (csv: string): Record<string, string>[] => {
    const lines = csv.trim().split('\n')
    if (lines.length < 2) return []

    const headers = lines[0].split(',').map(h => h.trim().toLowerCase())
    const rows: Record<string, string>[] = []

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(',')
      if (values.length !== headers.length) continue

      const row: Record<string, string> = {}
      headers.forEach((header, index) => {
        row[header] = values[index].trim()
      })
      rows.push(row)
    }
    return rows
  }

  // Handle file upload
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = (event) => {
      const content = event.target?.result as string
      setBatchData(content)
    }
    reader.readAsText(file)
  }

  // Download CSV template
  const downloadTemplate = () => {
    const template = `email,password,username,role,maxInstances,authProvider
user1@example.com,password123,User1,user,5,email
user2@example.com,,User2,user,5,oauth
user3@example.com,,User3,user,5,saml`
    const blob = new Blob([template], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'users_template.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  // Batch import users
  const handleBatchImport = async () => {
    if (!batchData.trim()) {
      alert(t('admin:userManagement.enterOrUploadData'))
      return
    }

    setBatchImporting(true)
    setBatchResult(null)

    try {
      const token = session?.access_token
      if (!token) {
        throw new Error(t('admin:userManagement.sessionExpired'))
      }

      // Parse data - try JSON first, then CSV
      let users: Record<string, unknown>[]
      try {
        users = JSON.parse(batchData)
        if (!Array.isArray(users)) {
          users = [users]
        }
      } catch {
        // Try CSV
        const csvRows = parseCSV(batchData)

        // Detect IDaaS format: has userExternalId or organizationalUnitPath columns
        const isIdaasFormat = csvRows.length > 0 && (
          'userExternalId' in csvRows[0] ||
          'userexternalid' in csvRows[0] ||
          'organizationalUnitPath' in csvRows[0] ||
          'organizationalunitpath' in csvRows[0]
        )

        users = csvRows.map(row => {
          // For IDaaS format, use username as email if email is missing
          const email = row.email || (isIdaasFormat && row.username ? `${row.username}@sso.local` : undefined)

          return {
            email,
            password: row.password || undefined,  // Optional for OAuth/SAML
            username: row.username || row.displayname || row.displayName,
            role: row.role || 'user',
            maxInstances: parseInt(row.maxinstances || row.maxInstances || '5'),
            // Auto-detect: IDaaS format -> saml, otherwise check authProvider field
            authProvider: row.authprovider || row.authProvider || (isIdaasFormat ? 'saml' : 'email')
          }
        })
      }

      if (users.length === 0) {
        throw new Error(t('admin:userManagement.noValidUserData'))
      }

      const response = await fetch(`${apiUrl}/api/users/batch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ users })
      })

      const data = await response.json()

      if (!data.success && !data.results) {
        throw new Error(data.error || t('admin:userManagement.batchImportFailed'))
      }

      setBatchResult({
        total: data.total,
        created: data.created,
        failed: data.failed,
        errors: data.errors || []
      })

      // Refresh user list
      fetchUsers(1)

    } catch (error) {
      console.error('Batch import error:', error)
      alert(t('admin:userManagement.batchImportFailedWithReason', { reason: error instanceof Error ? error.message : t('admin:userManagement.unknownError') }))
    } finally {
      setBatchImporting(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div className="relative w-96">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
          <input
            type="text"
            placeholder={t('admin:userManagement.searchPlaceholder')}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="input-field pl-10"
          />
        </div>
        <div className="flex space-x-3">
        <button onClick={() => setShowAddModal(true)} className="btn-primary flex items-center space-x-2">
          <Plus className="w-5 h-5" />
          <span>{t('admin:userManagement.addUser')}</span>
        </button>
        <button onClick={() => setShowBatchModal(true)} className="btn-secondary flex items-center space-x-2">
          <Upload className="w-5 h-5" />
          <span>{t('admin:userManagement.batchImport')}</span>
        </button>
        </div>
      </div>

      {/* Users Table */}
      <div className="card">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-primary-600" />
            <span className="ml-2 text-gray-600">{t('common:loading.default')}</span>
          </div>
        ) : (
        <div className="table-container">
          <table className="table-base">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  {t('admin:userManagement.user')}
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  {t('admin:userManagement.role')}
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  {t('admin:userManagement.status')}
                </th>
                {aiGatewayEnabled && (
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    {t('admin:userManagement.consumerId')}
                  </th>
                )}
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  {t('admin:userManagement.instanceLimit')}
                </th>
                {aiGatewayEnabled && (
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    <span className="inline-flex items-center gap-1">
                      {isUsd ? t('admin:userManagement.todayUsdSpend') : t('admin:userManagement.todayTokenUsage')}
                      <span className="relative inline-flex group">
                        <HelpCircle className="w-3.5 h-3.5 text-gray-400 cursor-help" />
                        <span className="pointer-events-none absolute left-1/2 -translate-x-1/2 top-full mt-1 px-2 py-1 bg-gray-800 text-white text-xs font-normal normal-case rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-50 shadow-lg">
                          {t('admin:userManagement.todayHint')}
                        </span>
                      </span>
                    </span>
                  </th>
                )}
                {aiGatewayEnabled && (
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    {isUsd ? t('admin:userManagement.monthlyUsdSpend') : t('admin:userManagement.monthlyTokenUsage')}
                  </th>
                )}
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  {t('admin:userManagement.actions')}
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {users.length === 0 ? (
                <tr>
                  <td colSpan={aiGatewayEnabled ? 8 : 5} className="px-6 py-12 text-center text-gray-500">
                    {t('admin:userManagement.noUserData')}
                  </td>
                </tr>
              ) : (
                users.map((user) => (
                <tr key={user.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div>
                      <div className="text-sm font-medium text-gray-900">
                        {user.username}
                      </div>
                      <div className="text-sm text-gray-500">{user.email}</div>
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className={`status-badge ${
                      user.role === 'admin' ? 'bg-purple-100 text-purple-800' : 'bg-blue-100 text-blue-800'
                    }`}>
                      {user.role === 'admin' ? t('common:roles.admin') : t('common:roles.user')}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className={`status-badge ${
                      user.status === 'active' ? 'status-active' : 'status-inactive'
                    }`}>
                      {user.status === 'active' ? t('admin:userManagement.enabled') : t('admin:userManagement.disabled')}
                    </span>
                  </td>
                  {aiGatewayEnabled && (
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                      {user.consumerId ? (
                        <a
                          href={isUsd
                            ? `${litellmProxyUrl.match(/^https?:\/\//) ? litellmProxyUrl : `http://${litellmProxyUrl}`}/ui/?page=users`
                            : `https://apig.console.aliyun.com/#/${aiGatewayRegionId}/ai-gateway-consumer-manage/${user.consumerId}?region=${aiGatewayRegionId}&tabKey=basicInfo`
                          }
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center space-x-1 font-mono text-xs bg-gray-100 px-2 py-1 rounded hover:bg-primary-100 hover:text-primary-700 transition-colors cursor-pointer"
                          title={isUsd ? t('admin:userManagement.goToLitellmConsole') : t('admin:userManagement.goToAiGatewayConsole')}
                        >
                          <span>
                            {user.consumerId.length > 12
                              ? `${user.consumerId.slice(0, 8)}...${user.consumerId.slice(-4)}`
                              : user.consumerId}
                          </span>
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      ) : (
                        <span className="text-gray-400">-</span>
                      )}
                    </td>
                  )}
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                    {user.maxInstances}
                  </td>
                  {aiGatewayEnabled && (
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                      {formatUsageValue(getUserUsageValue(user, consumerTokenMap))}
                    </td>
                  )}
                  {aiGatewayEnabled && (
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                      {formatUsageValue(getUserUsageValue(user, consumer30dTokenMap))}
                    </td>
                  )}
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                    <div className="flex items-center space-x-2">
                      <Tooltip content={t('admin:userManagement.tooltipEdit')}>
                        <button
                          onClick={() => handleEdit(user)}
                          className="text-primary-600 hover:text-primary-900"
                        >
                          <Edit2 className="w-4 h-4" />
                        </button>
                      </Tooltip>
                      {aiGatewayEnabled && user.consumerId && (
                        <Tooltip content={isUsd ? t('admin:userManagement.tooltipBudgetRateLimit') : t('admin:userManagement.tooltipTokenRateLimit')}>
                          <button
                            onClick={() => handleOpenTokenLimit(user)}
                            className="text-amber-600 hover:text-amber-900"
                          >
                            <Gauge className="w-4 h-4" />
                          </button>
                        </Tooltip>
                      )}
                      {user.consumerId && (
                        <Tooltip content={t('admin:userManagement.tooltipGatewayMonitor')}>
                          <button
                            onClick={() => {
                              const query = pagination.page > 1 ? `?page=${pagination.page}` : ''
                              navigate(`/admin/observability/cms/user/${sanitizeConsumerName(user.email)}${query}`)
                            }}
                            className="text-indigo-600 hover:text-indigo-900"
                          >
                            <Network className="w-4 h-4" />
                          </button>
                        </Tooltip>
                      )}
                      <Tooltip content={t('admin:userManagement.tooltipChangePassword')}>
                        <button
                          onClick={() => handleResetPassword(user.id)}
                          className="text-gray-600 hover:text-gray-900"
                        >
                          <Lock className="w-4 h-4" />
                        </button>
                      </Tooltip>
                      <Tooltip content={user.status === 'active' ? t('admin:userManagement.tooltipDisable') : t('admin:userManagement.tooltipEnable')}>
                        <button
                          onClick={() => handleToggleStatus(user.id)}
                          className={user.status === 'active' ? 'text-orange-600 hover:text-orange-900' : 'text-green-600 hover:text-green-900'}
                        >
                          <UserX className="w-4 h-4" />
                        </button>
                      </Tooltip>
                      <Tooltip content={t('admin:userManagement.tooltipDeleteUser')}>
                        <button
                          onClick={() => handleConfirmDelete(user)}
                          className="text-red-600 hover:text-red-900"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </Tooltip>
                    </div>
                  </td>
                </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        )}

        {/* Pagination */}
        {pagination.totalPages > 0 && (
          <div className="flex items-center justify-between px-6 py-4 border-t border-gray-200">
            <div className="text-sm text-gray-700">
              {t('admin:userManagement.totalRecords', { total: pagination.total, page: pagination.page, totalPages: pagination.totalPages })}
            </div>
            <div className="flex items-center space-x-2">
              <button
                onClick={() => handlePageChange(pagination.page - 1)}
                disabled={pagination.page <= 1}
                className="px-3 py-1 border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
              >
                <ChevronLeft className="w-4 h-4 mr-1" />
                {t('admin:userManagement.prevPage')}
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
                {t('admin:userManagement.nextPage')}
                <ChevronRight className="w-4 h-4 ml-1" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Edit Modal */}
      {showEditModal && editingUser && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-md">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">
              {t('admin:userManagement.editUserInfo')}
            </h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('admin:userManagement.userId')}
                </label>
                <input
                  type="text"
                  value={editingUser.id}
                  disabled
                  className="input-field bg-gray-100 text-gray-500 cursor-not-allowed"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('admin:userManagement.username')}
                </label>
                <input
                  type="text"
                  value={editingUser.username}
                  onChange={(e) => setEditingUser({ ...editingUser, username: e.target.value })}
                  className="input-field"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('admin:userManagement.email')}
                </label>
                <input
                  type="email"
                  value={editingUser.email}
                  onChange={(e) => setEditingUser({ ...editingUser, email: e.target.value })}
                  className="input-field"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('admin:userManagement.role')}
                </label>
                <select
                  value={editingUser.role}
                  onChange={(e) => setEditingUser({ ...editingUser, role: e.target.value as 'admin' | 'user' })}
                  className="input-field"
                >
                  <option value="user">{t('common:roles.user')}</option>
                  <option value="admin">{t('common:roles.admin')}</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('admin:userManagement.status')}
                </label>
                <select
                  value={editingUser.status}
                  onChange={(e) => setEditingUser({ ...editingUser, status: e.target.value as 'active' | 'disabled' })}
                  className="input-field"
                >
                  <option value="active">{t('admin:userManagement.enabled')}</option>
                  <option value="disabled">{t('admin:userManagement.disabled')}</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('admin:userManagement.instanceQuota')}
                </label>
                <input
                  type="number"
                  value={editingUser.maxInstances}
                  onChange={(e) => setEditingUser({ ...editingUser, maxInstances: parseInt(e.target.value) })}
                  className="input-field"
                />
              </div>
            </div>
            <div className="flex justify-end space-x-3 mt-6">
              <button
                onClick={() => setShowEditModal(false)}
                className="btn-secondary"
              >
                {t('common:buttons.cancel')}
              </button>
              <button
                onClick={handleSaveEdit}
                className="btn-primary"
                disabled={saving}
              >
                {saving ? t('admin:userManagement.saving') : t('common:buttons.save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add User Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-md">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">
              {t('admin:userManagement.addNewUser')}
            </h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('admin:userManagement.username')} <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={newUser.username}
                  onChange={(e) => setNewUser({ ...newUser, username: e.target.value })}
                  className="input-field"
                  placeholder={t('admin:userManagement.usernamePlaceholder')}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('admin:userManagement.email')} {newUser.authProvider === 'email' && <span className="text-red-500">*</span>}
                  {newUser.authProvider !== 'email' && <span className="text-gray-400 text-xs ml-1">{t('admin:userManagement.optional')}</span>}
                </label>
                <input
                  type="email"
                  value={newUser.email}
                  onChange={(e) => setNewUser({ ...newUser, email: e.target.value })}
                  className="input-field"
                  placeholder={newUser.authProvider === 'email' ? t('admin:userManagement.emailPlaceholder') : t('admin:userManagement.emailOptionalPlaceholder')}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('admin:userManagement.authMethod')}
                </label>
                <select
                  value={newUser.authProvider}
                  onChange={(e) => setNewUser({ ...newUser, authProvider: e.target.value as 'email' | 'oauth' | 'saml', password: '' })}
                  className="input-field"
                >
                  <option value="email">{t('admin:userManagement.emailAuth')}</option>
                  {ssoStatus.oauthEnabled && <option value="oauth">{t('admin:userManagement.oauthAuth')}</option>}
                  {ssoStatus.samlEnabled && <option value="saml">{t('admin:userManagement.ssoAuth')}</option>}
                </select>
                <p className="mt-1 text-xs text-gray-500">
                  {newUser.authProvider === 'email' && t('admin:userManagement.emailAuthHint')}
                  {newUser.authProvider === 'oauth' && t('admin:userManagement.oauthAuthHint')}
                  {newUser.authProvider === 'saml' && t('admin:userManagement.ssoAuthHint')}
                </p>
              </div>
              {newUser.authProvider === 'email' && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('admin:userManagement.password')} <span className="text-red-500">*</span>
                </label>
                <div className="relative">
                  <input
                    type={showNewUserPwd ? 'text' : 'password'}
                    value={newUser.password}
                    onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                    className="input-field pr-10"
                    placeholder={t('admin:userManagement.passwordPlaceholder')}
                  />
                  <button
                    type="button"
                    onClick={() => setShowNewUserPwd(!showNewUserPwd)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  >
                    {showNewUserPwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
              )}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('admin:userManagement.role')}
                </label>
                <select
                  value={newUser.role}
                  onChange={(e) => setNewUser({ ...newUser, role: e.target.value as 'admin' | 'user' })}
                  className="input-field"
                >
                  <option value="user">{t('common:roles.user')}</option>
                  <option value="admin">{t('common:roles.admin')}</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('admin:userManagement.instanceQuota')}
                </label>
                <input
                  type="number"
                  value={newUser.maxInstances}
                  onChange={(e) => setNewUser({ ...newUser, maxInstances: parseInt(e.target.value) || 5 })}
                  className="input-field"
                />
              </div>
            </div>
            <div className="flex justify-end space-x-3 mt-6">
              <button
                onClick={() => setShowAddModal(false)}
                className="btn-secondary"
              >
                {t('common:buttons.cancel')}
              </button>
              <button
                onClick={handleAddUser}
                className="btn-primary"
                disabled={saving}
              >
                {saving ? t('admin:userManagement.creating') : t('admin:userManagement.createUser')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Batch Import Modal */}
      {showBatchModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">
              {t('admin:userManagement.batchImportUsers')}
            </h2>

            <div className="space-y-4">
              {/* Instructions */}
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                <h3 className="font-medium text-blue-800 mb-2">{t('admin:userManagement.batchInstructions')}</h3>
                <ul className="text-sm text-blue-700 list-disc list-inside space-y-1">
                  <li>{t('admin:userManagement.batchFormatSupport')}</li>
                  <li>{t('admin:userManagement.batchCsvHeader')}</li>
                  <li>{t('admin:userManagement.batchOptionalFields')}</li>
                  <li><strong>{t('admin:userManagement.batchAuthProviderField')}</strong>：{t('admin:userManagement.batchAuthProviderValues')}</li>
                  <li>{t('admin:userManagement.batchNoPasswordNeeded')}</li>
                  <li>{t('admin:userManagement.batchMaxUsers')}</li>
                </ul>
              </div>

              {/* Template Download */}
              <div>
                <button
                  onClick={downloadTemplate}
                  className="text-primary-600 hover:text-primary-800 flex items-center space-x-1 text-sm"
                >
                  <Download className="w-4 h-4" />
                  <span>{t('admin:userManagement.downloadCsvTemplate')}</span>
                </button>
              </div>

              {/* File Upload */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  {t('admin:userManagement.uploadFile')}
                </label>
                <label className="inline-flex items-center space-x-2 px-4 py-2 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors cursor-pointer text-sm text-gray-700">
                  <Upload className="w-4 h-4" />
                  <span>{t('admin:userManagement.selectFile')}</span>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".csv,.json"
                    onChange={handleFileUpload}
                    className="hidden"
                  />
                </label>
              </div>

              {/* Text Input */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  {t('admin:userManagement.orPasteData')}
                </label>
                <textarea
                  value={batchData}
                  onChange={(e) => setBatchData(e.target.value)}
                  className="input-field h-48 font-mono text-sm"
                  placeholder={t('admin:userManagement.batchPlaceholder')}
                />
              </div>

              {/* Result */}
              {batchResult && (
                <div className={`border rounded-lg p-4 ${
                  batchResult.failed > 0 ? 'bg-yellow-50 border-yellow-200' : 'bg-green-50 border-green-200'
                }`}>
                  <h3 className="font-medium mb-2">
                    {t('admin:userManagement.importResult')}
                  </h3>
                  <div className="text-sm space-y-1">
                    <p>{t('admin:userManagement.total')}: {batchResult.total}</p>
                    <p className="text-green-700">{t('admin:userManagement.succeeded')}: {batchResult.created}</p>
                    <p className="text-red-700">{t('admin:userManagement.failed')}: {batchResult.failed}</p>
                  </div>
                  {batchResult.errors.length > 0 && (
                    <div className="mt-3">
                      <p className="text-sm font-medium text-red-700 mb-1">{t('admin:userManagement.failureDetails')}</p>
                      <div className="max-h-32 overflow-y-auto text-xs text-red-600 bg-white rounded p-2">
                        {batchResult.errors.map((err) => (
                          <div key={`${err.email}-${err.error}`}>{err.email}: {err.error}</div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="flex justify-end space-x-3 mt-6">
              <button
                onClick={() => {
                  setShowBatchModal(false)
                  setBatchData('')
                  setBatchResult(null)
                }}
                className="btn-secondary"
              >
                {t('common:buttons.close')}
              </button>
              <button
                onClick={handleBatchImport}
                className="btn-primary flex items-center space-x-2"
                disabled={batchImporting || !batchData.trim()}
              >
                {batchImporting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>{t('admin:userManagement.importing')}</span>
                  </>
                ) : (
                  <>
                    <Upload className="w-4 h-4" />
                    <span>{t('admin:userManagement.startImport')}</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Per-User Token Rate Limit Modal */}
      {showTokenLimitModal && tokenLimitUser && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-md">
            <h2 className="text-xl font-semibold text-gray-900 mb-1 flex items-center gap-2">
              <Gauge className="w-5 h-5 text-amber-500" />
              {isUsd ? t('admin:userManagement.budgetRateLimit') : t('admin:userManagement.tokenRateLimit')}
            </h2>
            <p className="text-sm text-gray-500 mb-4">
              {isUsd
                ? t('admin:userManagement.setUserBudgetLimit', { username: tokenLimitUser.username })
                : t('admin:userManagement.setUserRateLimit', { username: tokenLimitUser.username })}
            </p>

            {tokenLimitLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-6 h-6 animate-spin text-amber-500" />
                <span className="ml-2 text-gray-500">{t('common:loading.default')}</span>
              </div>
            ) : (
              <div className="space-y-4">
                {/* Effective limits summary */}
                {(effectiveDailyLimit > 0 || effectiveMonthlyLimit > 0) && (
                  <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
                    <p className="text-sm font-medium text-amber-800 mb-2">{isUsd ? t('admin:userManagement.currentEffectiveBudgetLimit') : t('admin:userManagement.currentEffectiveTokenLimit')}</p>
                    <div className="flex flex-wrap gap-3">
                      {effectiveDailyLimit > 0 && (
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm text-amber-700">{t('admin:userManagement.dailyLabel')}</span>
                          <span className="text-sm font-semibold text-amber-900">{isUsd ? `$${effectiveDailyLimit.toFixed(2)}` : `${effectiveDailyLimit.toLocaleString()} tokens`}</span>
                          <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                            userDailyLimit && parseFloat(userDailyLimit) > 0
                              ? 'bg-blue-100 text-blue-700'
                              : 'bg-gray-100 text-gray-600'
                          }`}>
                            {userDailyLimit && parseFloat(userDailyLimit) > 0 ? t('admin:userManagement.personal') : t('admin:userManagement.globalLabel')}
                          </span>
                        </div>
                      )}
                      {effectiveMonthlyLimit > 0 && (
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm text-amber-700">{t('admin:userManagement.per30DaysLabel')}</span>
                          <span className="text-sm font-semibold text-amber-900">{isUsd ? `$${effectiveMonthlyLimit.toFixed(2)}` : `${effectiveMonthlyLimit.toLocaleString()} tokens`}</span>
                          <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                            userMonthlyLimit && parseFloat(userMonthlyLimit) > 0
                              ? 'bg-blue-100 text-blue-700'
                              : 'bg-gray-100 text-gray-600'
                          }`}>
                            {userMonthlyLimit && parseFloat(userMonthlyLimit) > 0 ? t('admin:userManagement.personal') : t('admin:userManagement.globalLabel')}
                          </span>
                        </div>
                      )}
                    </div>
                    {effectiveDailyLimit === 0 && effectiveMonthlyLimit === 0 && (
                      <span className="text-sm text-amber-600">{t('admin:userManagement.noLimit')}</span>
                    )}
                  </div>
                )}

                {/* Global limits reference */}
                {(globalDailyLimit > 0 || globalMonthlyLimit > 0) && (
                  <div className="bg-gray-50 border border-gray-200 rounded-lg px-4 py-2">
                    <p className="text-xs text-gray-500 mb-1">{isUsd ? t('admin:userManagement.globalBudgetStrategy') : t('admin:userManagement.globalRateLimitStrategy')}</p>
                    <div className="flex flex-wrap gap-3 text-xs text-gray-600">
                      {globalDailyLimit > 0 && <span>{t('admin:userManagement.dailyLabel')} {isUsd ? `$${globalDailyLimit.toFixed(2)}` : `${globalDailyLimit.toLocaleString()} tokens`}</span>}
                      {globalMonthlyLimit > 0 && <span>{t('admin:userManagement.per30DaysLabel')} {isUsd ? `$${globalMonthlyLimit.toFixed(2)}` : `${globalMonthlyLimit.toLocaleString()} tokens`}</span>}
                    </div>
                  </div>
                )}

                {isUsd ? (
                  /* LiteLLM: single budget input + time-rate selector */
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      {t('admin:userManagement.budgetLimitPersonal')}
                    </label>
                    <div className="flex items-center gap-3">
                      <select
                        value={budgetTimeRate}
                        onChange={(e) => {
                          const newRate = e.target.value as 'daily' | 'monthly'
                          // Move value to the correct field when switching
                          if (newRate === 'daily' && budgetTimeRate === 'monthly') {
                            setUserDailyLimit(userMonthlyLimit)
                            setUserMonthlyLimit('')
                          } else if (newRate === 'monthly' && budgetTimeRate === 'daily') {
                            setUserMonthlyLimit(userDailyLimit)
                            setUserDailyLimit('')
                          }
                          setBudgetTimeRate(newRate)
                        }}
                        className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-amber-500 focus:border-transparent text-sm"
                      >
                        <option value="daily">{t('admin:userManagement.budgetTimeRateDaily')}</option>
                        <option value="monthly">{t('admin:userManagement.budgetTimeRateMonthly')}</option>
                      </select>
                      <input
                        type="text"
                        value={budgetTimeRate === 'daily' ? userDailyLimit : userMonthlyLimit}
                        onChange={(e) => {
                          const val = e.target.value
                          if (val === '' || /^\d*\.?\d*$/.test(val)) {
                            if (budgetTimeRate === 'daily') setUserDailyLimit(val)
                            else setUserMonthlyLimit(val)
                          }
                        }}
                        placeholder={t('admin:userManagement.noLimit')}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-amber-500 focus:border-transparent text-sm"
                      />
                      <span className="text-sm text-gray-500 whitespace-nowrap">
                        {budgetTimeRate === 'daily' ? t('admin:userManagement.usdPerDay') : t('admin:userManagement.usdPer30Days')}
                      </span>
                    </div>
                  </div>
                ) : (
                  /* AlibabaCloud: dual input (daily + monthly) */
                  <>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        {t('admin:userManagement.dailyTokenLimitPersonal')}
                      </label>
                      <div className="flex items-center gap-3">
                        <input
                          type="text"
                          value={userDailyLimit}
                          onChange={(e) => {
                            const val = e.target.value
                            if (val === '' || /^\d+$/.test(val)) setUserDailyLimit(val)
                          }}
                          placeholder={globalDailyLimit > 0 ? t('admin:userManagement.inheritGlobal', { value: globalDailyLimit.toLocaleString() }) : t('admin:userManagement.noLimit')}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-amber-500 focus:border-transparent text-sm"
                        />
                        <span className="text-sm text-gray-500 whitespace-nowrap">{t('admin:userManagement.tokensPerDay')}</span>
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        {t('admin:userManagement.monthlyTokenLimitPersonal')}
                      </label>
                      <div className="flex items-center gap-3">
                        <input
                          type="text"
                          value={userMonthlyLimit}
                          onChange={(e) => {
                            const val = e.target.value
                            if (val === '' || /^\d+$/.test(val)) setUserMonthlyLimit(val)
                          }}
                          placeholder={globalMonthlyLimit > 0 ? t('admin:userManagement.inheritGlobal', { value: globalMonthlyLimit.toLocaleString() }) : t('admin:userManagement.noLimit')}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-amber-500 focus:border-transparent text-sm"
                        />
                        <span className="text-sm text-gray-500 whitespace-nowrap">{t('admin:userManagement.tokensPer30Days')}</span>
                      </div>
                    </div>
                  </>
                )}
                <p className="text-xs text-gray-500">
                  {isUsd ? t('admin:userManagement.rateLimitHintUsd') : t('admin:userManagement.rateLimitHint')}
                </p>

                {tokenLimitError && (
                  <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                    {tokenLimitError}
                  </div>
                )}
                {tokenLimitSuccess && (
                  <div className="text-sm text-green-600 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                    {tokenLimitSuccess}
                  </div>
                )}
              </div>
            )}

            <div className="flex justify-end space-x-3 mt-6">
              <button
                onClick={() => setShowTokenLimitModal(false)}
                className="btn-secondary"
              >
                {t('common:buttons.close')}
              </button>
              <button
                onClick={handleSaveTokenLimit}
                disabled={tokenLimitSaving || tokenLimitLoading}
                className="flex items-center gap-2 px-4 py-2 text-sm bg-amber-500 text-white rounded-lg hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {tokenLimitSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Gauge className="w-4 h-4" />}
                {tokenLimitSaving ? t('admin:userManagement.saving') : t('admin:userManagement.saveRateLimitConfig')}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Change Password Modal */}
      {showPasswordModal && passwordUser && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-md">
            <h2 className="text-xl font-semibold text-gray-900 mb-4 flex items-center gap-2">
              <Lock className="w-5 h-5 text-gray-600" />
              {t('admin:userManagement.changePassword')}
            </h2>
            <p className="text-sm text-gray-500 mb-4">
              {t('admin:userManagement.setPasswordForUser', { username: passwordUser.username, email: passwordUser.email })}
            </p>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('admin:userManagement.newPassword')} <span className="text-red-500">*</span>
                </label>
                <div className="relative">
                  <input
                    type={showResetPwd ? 'text' : 'password'}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="input-field pr-10"
                    placeholder={t('admin:userManagement.newPasswordPlaceholder')}
                    autoFocus
                  />
                  <button
                    type="button"
                    onClick={() => setShowResetPwd(!showResetPwd)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  >
                    {showResetPwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            </div>
            <div className="flex justify-end space-x-3 mt-6">
              <button
                onClick={() => { setShowPasswordModal(false); setPasswordUser(null); setNewPassword('') }}
                className="btn-secondary"
              >
                {t('common:buttons.cancel')}
              </button>
              <button
                onClick={handleChangePassword}
                className="btn-primary"
                disabled={passwordSaving || !newPassword || newPassword.length < 6}
              >
                {passwordSaving ? t('admin:userManagement.modifying') : t('admin:userManagement.confirmChangePassword')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete User Confirmation Modal */}
      {showDeleteConfirm && deleteUser && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-md">
            <h2 className="text-xl font-semibold text-red-600 mb-4 flex items-center gap-2">
              <Trash2 className="w-5 h-5" />
              {t('admin:userManagement.deleteUser')}
            </h2>
            <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-4">
              <p className="text-sm text-red-800">
                {t('admin:userManagement.confirmDeleteUser', { username: deleteUser.username, email: deleteUser.email })}
              </p>
              <p className="text-sm text-red-600 mt-2">
                {t('admin:userManagement.deleteUserWarning')}
              </p>
            </div>
            <div className="flex justify-end space-x-3">
              <button
                onClick={() => { setShowDeleteConfirm(false); setDeleteUser(null) }}
                className="btn-secondary"
              >
                {t('common:buttons.cancel')}
              </button>
              <button
                onClick={handleDeleteUser}
                className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 transition-colors text-sm"
                disabled={deleting}
              >
                {deleting ? t('admin:userManagement.deleting') : t('common:buttons.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default UserManagement
