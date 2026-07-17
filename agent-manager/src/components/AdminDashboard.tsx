import React, { useState, useEffect } from 'react'
import { Users, Bot, Cpu, TrendingUp, Activity, AlertTriangle, X, Loader2, ExternalLink, HelpCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../contexts/AuthContext'
import { apiUrl } from '../lib/api'
import type { SupabaseClient } from '@supabase/supabase-js'

// Singleton supabase client instance
let supabaseInstance: SupabaseClient | null = null

type RuntimeEnvWindow = Window & { __ENV__?: Record<string, string | undefined> }

/** 获取环境变量（优先 Docker 运行时注入的 window.__ENV__，回退到 Vite 构建时注入） */
function getEnvVar(key: string): string {
  const windowEnv = (window as RuntimeEnvWindow).__ENV__
  return (windowEnv && windowEnv[key]) || import.meta.env[key] || ''
}

const getSupabaseClient = async () => {
  if (supabaseInstance) return supabaseInstance
  const { createClient } = await import('@supabase/supabase-js')
  const supabaseUrl = getEnvVar('VITE_SUPABASE_URL')
  const supabaseKey = getEnvVar('VITE_SUPABASE_ANON_KEY')
  supabaseInstance = createClient(supabaseUrl, supabaseKey)
  return supabaseInstance
}

interface DashboardStats {
  totalUsers: number
  totalInstances: number
  activeModels: number
  todayTokenUsage: number
  todayRequests: number
  todayActiveUsers: number
  aiGatewayEnabled: boolean
  slsEnabled: boolean
  usageUnit: string
}

interface RecentInstance {
  id: string
  name: string
  username: string
  status: string
  model: string
  agentType: string | null
  createdAt: string
}

interface ConsumerTokenUsage {
  consumer: string
  username: string
  totalToken: number
  inputToken: number
  outputToken: number
  requests: number
  type?: string
}

interface DashboardModel {
  status?: string
}

interface DashboardInstance {
  id: string
  name: string
  principal_id: string
  status: string
  ai_models?: { name?: string } | null
  agent_type?: { name?: string } | null
  principal?: { username?: string | null; email?: string | null } | null
  group?: { name?: string | null } | null
  created_at?: string | null
}

interface ConsumerUsageItem {
  consumer: string
  username?: string
  value?: number
  totalToken?: number
  inputToken?: number
  outputToken?: number
  requests?: number
  type?: string
}

interface ProviderSummary {
  code: string
  isEnabled?: boolean
}

interface ProviderConfig {
  regionId?: string
  gatewayId?: string
  httpApiId?: string
}

const AdminDashboard: React.FC = () => {
  const { t, i18n } = useTranslation('admin')
  const { session } = useAuth()
  const [showPasswordAlert, setShowPasswordAlert] = useState(false)
  const [loading, setLoading] = useState(true)
  const [stats, setStats] = useState<DashboardStats>({
    totalUsers: 0,
    totalInstances: 0,
    activeModels: 0,
    todayTokenUsage: 0,
    todayRequests: 0,
    todayActiveUsers: 0,
    aiGatewayEnabled: false,
    slsEnabled: false,
    usageUnit: 'token'
  })
  const [recentInstances, setRecentInstances] = useState<RecentInstance[]>([])
  const [consumerTokenUsage, setConsumerTokenUsage] = useState<ConsumerTokenUsage[]>([])
  const [groupTokenUsage, setGroupTokenUsage] = useState<ConsumerTokenUsage[]>([])
  const [gatewayConfig, setGatewayConfig] = useState<{
    regionId: string
    gatewayId: string
    httpApiId: string
  } | null>(null)

  useEffect(() => {
    const fetchDashboardData = async () => {
      try {
        const token = session?.access_token
        if (!token) return

        const supabase = await getSupabaseClient()

        // Fetch all data in parallel
        const [modelsRes, instancesRes, usersRes, gatewayStatsRes, consumerTokensRes, consumerTokens30dRes, providersRes] = await Promise.all([
          fetch(`${apiUrl}/api/models`, {
            headers: { 'Authorization': `Bearer ${token}` }
          }),
          fetch(`${apiUrl}/api/admin/instances`, {
            headers: { 'Authorization': `Bearer ${token}` }
          }),
          supabase
            .from('principal_profiles')
            .select('id, username:name', { count: 'exact' })
            .eq('principal_type', 'user'),
          fetch(`${apiUrl}/api/providers/current/stats`, {
            headers: { 'Authorization': `Bearer ${token}` }
          }),
          fetch(`${apiUrl}/api/providers/current/tokens?days=1`, {
            headers: { 'Authorization': `Bearer ${token}` }
          }),
          fetch(`${apiUrl}/api/providers/current/tokens?days=30`, {
            headers: { 'Authorization': `Bearer ${token}` }
          }),
          fetch(`${apiUrl}/api/providers`, {
            headers: { 'Authorization': `Bearer ${token}` }
          })
        ])

        const modelsData = await modelsRes.json()
        const instancesData = await instancesRes.json()
        const gatewayStatsData = await gatewayStatsRes.json()
        const consumerTokensData = await consumerTokensRes.json()
        const consumerTokens30dData = await consumerTokens30dRes.json()
        const providersData = await providersRes.json()

        // Calculate stats
        const models = (modelsData.success ? modelsData.models : []) as DashboardModel[]
        const instances = (instancesData.success ? instancesData.instances : []) as DashboardInstance[]
        const activeModels = models.filter((m) => m.status === 'active').length
        
        // Get gateway stats
        const gatewayStats = (gatewayStatsData.success && gatewayStatsData.stats) ? gatewayStatsData.stats : {}

        setStats({
          totalUsers: usersRes.count || 0,
          totalInstances: instances.length,
          activeModels,
          todayTokenUsage: gatewayStats.todayTokens || gatewayStats.totalSpend || 0,
          todayRequests: gatewayStats.todayRequests || 0,
          todayActiveUsers: gatewayStats.todayActiveUsers || 0,
          aiGatewayEnabled: gatewayStats.aiGatewayEnabled || false,
          slsEnabled: gatewayStats.slsEnabled || false,
          usageUnit: gatewayStats.usageUnit || 'token'
        })

        // Map recent instances
        const recent: RecentInstance[] = instances.slice(0, 5).map((inst) => ({
          id: inst.id,
          name: inst.name,
          username: inst.group?.name || inst.principal?.username || inst.principal?.email || t('common:messages.unknownUser'),
          status: inst.status,
          model: inst.ai_models?.name || t('common:messages.notConfigured'),
          agentType: inst.agent_type?.name || null,
          createdAt: inst.created_at || ''
        }))

        setRecentInstances(recent)

        // Process consumer token usage data (days=1, users only)
        if (consumerTokensData.success && consumerTokensData.consumers) {
          const consumers = consumerTokensData.consumers as ConsumerUsageItem[]
          const tokenUsage: ConsumerTokenUsage[] = consumers
            .filter((item) => item.type !== 'group')
            .map((item) => ({
              consumer: item.consumer,
              username: item.username || item.consumer,
              totalToken: item.value ?? item.totalToken ?? 0,
              inputToken: item.inputToken || 0,
              outputToken: item.outputToken || 0,
              requests: item.requests || 0,
              type: item.type || 'user'
            }))

          setConsumerTokenUsage(tokenUsage)
        }

        // Process 30-day group consumption data
        if (consumerTokens30dData.success && consumerTokens30dData.consumers) {
          const consumers = consumerTokens30dData.consumers as ConsumerUsageItem[]
          const groupUsage: ConsumerTokenUsage[] = consumers
            .filter((item) => item.type === 'group')
            .map((item) => ({
              consumer: item.consumer,
              username: item.username || item.consumer,
              totalToken: item.value ?? item.totalToken ?? 0,
              inputToken: item.inputToken || 0,
              outputToken: item.outputToken || 0,
              requests: item.requests || 0,
              type: 'group'
            }))

          setGroupTokenUsage(groupUsage)
        }

        // Save gateway config for console link
        const providers = (providersData.success ? providersData.providers : []) as ProviderSummary[]
        const enabledProvider = providers.find((p) => p.isEnabled)
        if (enabledProvider) {
          // Fetch enabled provider's config
          const configRes = await fetch(`${apiUrl}/api/providers/${enabledProvider.code}/config`, {
            headers: { 'Authorization': `Bearer ${token}` }
          })
          const configData = await configRes.json()
          if (configData.success && configData.config) {
            const config = configData.config as ProviderConfig
            if (config.gatewayId && config.httpApiId) {
              setGatewayConfig({
                regionId: config.regionId || 'cn-hangzhou',
                gatewayId: config.gatewayId,
                httpApiId: config.httpApiId
              })
            }
          }
        }

      } catch (error) {
        console.error('Failed to fetch dashboard data:', error)
      } finally {
        setLoading(false)
      }
    }

    if (session?.access_token) {
      fetchDashboardData()
    }
  }, [session?.access_token, t])

  const isUsd = stats.usageUnit === 'usd'
  const providerLabel = isUsd ? 'LiteLLM' : t('stats.aiGateway')

  const statsConfig = [
    {
      name: t('stats.totalUsers'),
      value: stats.totalUsers,
      icon: Users,
      color: 'bg-blue-500'
    },
    {
      name: t('stats.agentInstances'),
      value: stats.totalInstances,
      icon: Bot,
      color: 'bg-green-500'
    },
    {
      name: t('stats.availableModels'),
      value: stats.activeModels,
      icon: Cpu,
      color: 'bg-purple-500'
    },
    ...(stats.aiGatewayEnabled && stats.slsEnabled && isUsd ? [
      {
        name: t('stats.totalUsdSpend'),
        description: providerLabel,
        value: `$${stats.todayTokenUsage.toFixed(4)}`,
        icon: TrendingUp,
        color: 'bg-orange-500',
        hint: t('stats.todayHint')
      }
    ] : []),
    ...(stats.aiGatewayEnabled && stats.slsEnabled && !isUsd ? [
      {
        name: t('stats.todayActiveUsers'),
        description: t('stats.aiGateway'),
        value: stats.todayActiveUsers.toLocaleString(),
        icon: Users,
        color: 'bg-pink-500',
        hint: t('stats.todayHint')
      },
      {
        name: t('stats.todayRequests'),
        description: t('stats.aiGateway'),
        value: stats.todayRequests.toLocaleString(),
        icon: Activity,
        color: 'bg-cyan-500',
        hint: t('stats.todayHint')
      },
      {
        name: t('stats.todayTokenUsage'),
        description: t('stats.aiGateway'),
        value: stats.todayTokenUsage.toLocaleString(),
        icon: TrendingUp,
        color: 'bg-orange-500',
        hint: t('stats.todayHint')
      }
    ] : [])
  ]

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-primary-600" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* 首次登录修改密码提示 */}
      {showPasswordAlert && (
        <div className="bg-yellow-50 border-l-4 border-yellow-400 p-4 rounded-lg shadow-md">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <AlertTriangle className="h-6 w-6 text-yellow-600" />
              <div>
                <h3 className="text-yellow-800 font-semibold">{t('changeDefaultPassword.title')}</h3>
                <p className="text-yellow-700 text-sm mt-1">
                  {t('changeDefaultPassword.message')}
                </p>
              </div>
            </div>
            <button
              onClick={() => {
                setShowPasswordAlert(false)
              }}
              className="text-yellow-600 hover:text-yellow-800 transition-colors"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>
      )}

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {statsConfig.map((stat) => (
          <div key={stat.name} className="card">
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <p className="text-sm text-gray-600">{stat.name}</p>
                  {'description' in stat && stat.description && (
                    <span className="text-xs text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded">
                      {stat.description}
                    </span>
                  )}
                  {'hint' in stat && stat.hint && (
                    <span className="relative inline-flex group">
                      <HelpCircle className="w-3.5 h-3.5 text-gray-400 cursor-help" />
                      <span className="pointer-events-none absolute left-1/2 -translate-x-1/2 top-full mt-1 px-2 py-1 bg-gray-800 text-white text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-50 shadow-lg">
                        {stat.hint as string}
                      </span>
                    </span>
                  )}
                </div>
                <p className="text-3xl font-bold text-gray-900">{stat.value}</p>
              </div>
              <div className={`${stat.color} p-3 rounded-lg`}>
                <stat.icon className="w-6 h-6 text-white" />
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* AI Gateway Console Link - only for AlibabaCloud provider */}
      {stats.aiGatewayEnabled && !isUsd && gatewayConfig && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-blue-700">
              {t('viewMoreGatewayStats')}
            </span>
            <a
              href={`https://apig.console.aliyun.com/#/${gatewayConfig.regionId}/ai-gateway/${gatewayConfig.gatewayId}/model-api/${gatewayConfig.httpApiId}?region=${gatewayConfig.regionId}&tabKey=statistics`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center space-x-1 text-sm text-blue-600 hover:text-blue-800 font-medium"
            >
              <span>{t('alibabaCloudConsole')}</span>
              <ExternalLink className="w-4 h-4" />
            </a>
          </div>
        </div>
      )}

      {/* Recent Agents */}
      <div className="card">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">
          {t('recentAgentInstances')}
        </h2>
        <div className="table-container">
          <table className="table-base">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  {t('table.name')}
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  {t('table.user')}
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  {t('table.agentConfig')}
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  {t('table.status')}
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  {t('table.model')}
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  {t('table.createdAt')}
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {recentInstances.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-8 text-center text-gray-500">
                    {t('common:messages.noData')}
                  </td>
                </tr>
              ) : (
                recentInstances.map((instance) => (
                  <tr key={instance.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                      {instance.name}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                      {instance.username}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm">
                      {instance.agentType ? (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-indigo-50 text-indigo-700">
                          {instance.agentType}
                        </span>
                      ) : (
                        <span className="text-gray-400">-</span>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={`status-badge ${
                        instance.status === 'running' ? 'status-active' :
                        instance.status === 'starting' ? 'status-pending' :
                        'status-inactive'
                      }`}>
                        {instance.status === 'running' ? t('common:status.running') :
                         instance.status === 'starting' ? t('common:status.starting') :
                         t('common:status.stopped')}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                      {instance.model}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                      {instance.createdAt ? new Date(instance.createdAt).toLocaleString(i18n.language) : '-'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* User Usage Ranking - Show when provider has usage data */}
      {stats.aiGatewayEnabled && stats.slsEnabled && (
        <div className="card">
          <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
            {isUsd ? t('usdSpendRanking') : t('todayTokenUsageRanking')}
            {!isUsd && (
              <span className="relative inline-flex group">
                <HelpCircle className="w-4 h-4 text-gray-400 cursor-help" />
                <span className="pointer-events-none absolute left-1/2 -translate-x-1/2 top-full mt-1 px-2 py-1 bg-gray-800 text-white text-xs font-normal rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-50 shadow-lg">
                  {t('stats.todayHint')}
                </span>
              </span>
            )}
          </h2>
          <div className="table-container">
            <table className="table-base">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    {t('tokenTable.rank')}
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    {t('tokenTable.user')}
                  </th>
                  {isUsd ? (
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                      {t('tokenTable.usdSpend')}
                    </th>
                  ) : (
                    <>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                        {t('tokenTable.totalToken')}
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                        {t('tokenTable.inputToken')}
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                        {t('tokenTable.outputToken')}
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                        {t('tokenTable.requests')}
                      </th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {consumerTokenUsage.length === 0 ? (
                  <tr>
                    <td colSpan={isUsd ? 3 : 6} className="px-6 py-8 text-center text-gray-500">
                      {t('common:messages.noData')}
                    </td>
                  </tr>
                ) : (
                  consumerTokenUsage.slice(0, 10).map((usage, index) => (
                    <tr key={usage.consumer} className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                        <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-medium ${
                          index === 0 ? 'bg-yellow-100 text-yellow-800' :
                          index === 1 ? 'bg-gray-200 text-gray-700' :
                          index === 2 ? 'bg-orange-100 text-orange-800' :
                          'bg-gray-50 text-gray-600'
                        }`}>
                          {index + 1}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                        {usage.username}
                      </td>
                      {isUsd ? (
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 font-semibold">
                          ${usage.totalToken.toFixed(4)}
                        </td>
                      ) : (
                        <>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 font-semibold">
                            {usage.totalToken.toLocaleString()}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                            {usage.inputToken.toLocaleString()}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                            {usage.outputToken.toLocaleString()}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                            {usage.requests.toLocaleString()}
                          </td>
                        </>
                      )}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Group Consumption Ranking (30 days) - Only for USD/LiteLLM provider */}
      {stats.aiGatewayEnabled && stats.slsEnabled && isUsd && (
        <div className="card">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">
            {t('groupSpendRanking')}
          </h2>
          <div className="table-container">
            <table className="table-base">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    {t('tokenTable.rank')}
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    {t('groupTokenTable.groupName')}
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    {t('tokenTable.usdSpend')}
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {groupTokenUsage.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-6 py-8 text-center text-gray-500">
                      {t('common:messages.noData')}
                    </td>
                  </tr>
                ) : (
                  groupTokenUsage.slice(0, 10).map((usage, index) => (
                    <tr key={usage.consumer} className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                        <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-medium ${
                          index === 0 ? 'bg-yellow-100 text-yellow-800' :
                          index === 1 ? 'bg-gray-200 text-gray-700' :
                          index === 2 ? 'bg-orange-100 text-orange-800' :
                          'bg-gray-50 text-gray-600'
                        }`}>
                          {index + 1}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                        {usage.username}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 font-semibold">
                        ${usage.totalToken.toFixed(4)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

export default AdminDashboard
