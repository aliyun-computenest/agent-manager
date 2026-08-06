import React from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Bot, PlusCircle, TrendingUp, Cpu } from 'lucide-react'
import mockData from '../mock.json'

const UserDashboard: React.FC = () => {
  const navigate = useNavigate()
  const { t } = useTranslation(['user', 'common'])
  const currentUserId = '2' // 模拟当前用户 ID

  const userAgents = mockData.openClaws.filter(oc => oc.userId === currentUserId)
  const user = mockData.users.find(u => u.id === currentUserId)
  const runningCount = userAgents.filter(oc => oc.status === 'running').length

  const stats = [
    {
      name: t('dashboard.myAgents'),
      value: userAgents.length,
      max: user?.maxInstances || 0,
      icon: Bot,
      color: 'bg-blue-500'
    },
    {
      name: t('dashboard.runningInstances'),
      value: runningCount,
      icon: TrendingUp,
      color: 'bg-green-500'
    },
    {
      name: t('dashboard.availableModels'),
      value: mockData.models.filter(m => m.status === 'active').length,
      icon: Cpu,
      color: 'bg-purple-500'
    }
  ]

  return (
    <div className="space-y-6">
      {/* Welcome Section */}
      <div className="card bg-gradient-to-r from-primary-500 to-primary-600 text-white">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold mb-2">{t('dashboard.welcomeBack', { name: user?.username })}</h2>
            <p className="text-primary-100">
              {t('dashboard.runningAgentCount', { count: runningCount })}
            </p>
          </div>
          <button
            onClick={() => navigate('/user/instances/create')}
            className="bg-white text-primary-600 hover:bg-primary-50 font-medium py-3 px-6 rounded-lg transition-colors flex items-center space-x-2"
          >
            <PlusCircle className="w-5 h-5" />
            <span>{t('dashboard.createInstance')}</span>
          </button>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {stats.map((stat) => (
          <div key={stat.name} className="card">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-600 mb-1">{stat.name}</p>
                <p className="text-3xl font-bold text-gray-900">
                  {stat.value}
                  {stat.max && stat.max > 0 && (
                    <span className="text-sm text-gray-500 font-normal"> / {stat.max}</span>
                  )}
                </p>
              </div>
              <div className={`${stat.color} p-3 rounded-lg`}>
                <stat.icon className="w-6 h-6 text-white" />
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Recent Agents */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">
            {t('dashboard.myAgentInstances')}
          </h2>
          <button
            onClick={() => navigate('/user/instances')}
            className="text-primary-600 hover:text-primary-700 text-sm font-medium"
          >
            {t('dashboard.viewAll')}
          </button>
        </div>
        <div className="table-container">
          <table className="table-base">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  {t('dashboard.table.name')}
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  {t('dashboard.table.status')}
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  {t('dashboard.table.model')}
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  {t('dashboard.table.tokenUsage')}
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {userAgents.slice(0, 5).map((agent) => (
                <tr key={agent.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                    {agent.name}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className={`status-badge ${
                      agent.status === 'running' ? 'status-active' :
                      agent.status === 'starting' ? 'status-pending' :
                      'status-inactive'
                    }`}>
                      {agent.status === 'running' ? t('common:status.running') :
                       agent.status === 'starting' ? t('common:status.starting') :
                       t('common:status.stopped')}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                    {agent.model}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                    {agent.tokenUsage.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

export default UserDashboard
