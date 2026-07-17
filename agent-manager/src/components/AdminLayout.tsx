import React, { useState, useEffect } from 'react'
import { Outlet, useNavigate, useLocation, Link, Navigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { useTerminalDock } from '../contexts/TerminalContext'
import { useTranslation } from 'react-i18next'
import LanguageSwitcher from './LanguageSwitcher'
import { apiUrl } from '../lib/api'
import {
  LayoutDashboard,
  Users,
  UserCog,
  Cpu,
  Bot,
  LogOut,
  Menu,
  X,
  Shield,
  FileJson,
  Key,
  ChevronDown,
  Mail,
  Boxes,
  ArchiveRestore,
  History,
  Eye,
  Layers,
  Package
} from 'lucide-react'

interface NavItem {
  name: string
  href: string
  icon: React.ElementType
  children?: NavItem[]
}

interface AdminLayoutProps {
  currentUser: {
    id: string
    username: string
    email?: string
    role: 'admin' | 'user'
  }
}

function shouldOpenSidebarByDefault() {
  return typeof window === 'undefined' || window.matchMedia('(min-width: 768px)').matches
}

const AdminLayout: React.FC<AdminLayoutProps> = ({ currentUser }) => {
  const navigate = useNavigate()
  const location = useLocation()
  const { signOut, session } = useAuth()
  const { closeTerminal } = useTerminalDock()
  const { t } = useTranslation(['admin', 'common'])
  const [sidebarOpen, setSidebarOpen] = useState(shouldOpenSidebarByDefault)
  const [expandedMenus, setExpandedMenus] = useState<string[]>(['/admin/members'])

  // 点击「网关监控」时实时检查当前 Provider：
  // 如果当前启用的是 LiteLLM，直接跳转到 provider 配置中的 proxyUrl/ui；
  // 否则走默认路由到 /admin/observability/cms。
  const handleGatewayMonitorClick = async (
    e: React.MouseEvent<HTMLAnchorElement>,
    href: string
  ) => {
    e.preventDefault()
    try {
      const token = session?.access_token
      if (token) {
        const resp = await fetch(`${apiUrl}/api/providers/current/stats`, {
          headers: { Authorization: `Bearer ${token}` }
        })
        const data = await resp.json()
        const stats = data?.stats
        const proxyUrl: string | undefined = stats?.proxyUrl
        const isLiteLLM = !!proxyUrl && stats?.usageUnit === 'usd'
        if (isLiteLLM && proxyUrl) {
          const normalized = /^https?:\/\//.test(proxyUrl) ? proxyUrl : `http://${proxyUrl}`
          const target = `${normalized.replace(/\/+$/, '')}/ui`
          window.open(target, '_blank', 'noopener,noreferrer')
          return
        }
      }
    } catch (err) {
      console.warn('[AdminLayout] gateway monitor provider check failed, fallback to default route:', err)
    }
    navigate(href)
  }

  // Auto-expand parent menu when navigating to a child route
  useEffect(() => {
    const parentPaths = ['/admin/members', '/admin/observability']
    const childPaths: Record<string, string[]> = {
      '/admin/members': ['/admin/users', '/admin/groups', '/admin/sso-config', '/admin/email-auth'],
      '/admin/observability': ['/admin/observability/container', '/admin/observability/cms']
    }
    for (const parent of parentPaths) {
      if (childPaths[parent]?.some(child => location.pathname.startsWith(child))) {
        setExpandedMenus(prev => prev.includes(parent) ? prev : [...prev, parent])
      }
    }
  }, [location.pathname])

  // 未登录或不是管理员，重定向到首页
  if (!currentUser || currentUser.role !== 'admin') {
    return <Navigate to="/" replace />
  }

  const navigation: NavItem[] = [
    { name: t('admin:nav.dashboard'), href: '/admin/dashboard', icon: LayoutDashboard },
    {
      name: t('admin:nav.memberManagement'),
      href: '/admin/members',
      icon: Users,
      children: [
        { name: t('admin:nav.userManagement'), href: '/admin/users', icon: UserCog },
        { name: t('admin:nav.groupManagement'), href: '/admin/groups', icon: Layers },
        { name: t('admin:nav.ssoConfig'), href: '/admin/sso-config', icon: Key },
        { name: t('admin:nav.emailAuth'), href: '/admin/email-auth', icon: Mail },
      ]
    },
    { name: t('admin:nav.modelConfig'), href: '/admin/models', icon: Cpu },
    { name: t('admin:nav.instanceList'), href: '/admin/instances', icon: Bot },
    { name: t('admin:nav.agentConfig'), href: '/admin/agent-types', icon: FileJson },
    { name: t('admin:nav.skillSpaceManagement'), href: '/admin/skill-spaces', icon: Package },
    { name: t('admin:nav.instanceUpgrade'), href: '/admin/instance-upgrades', icon: History },
    { name: t('admin:nav.instanceBackup'), href: '/admin/backups', icon: ArchiveRestore },
    { name: t('admin:nav.sandboxConfig'), href: '/admin/sandboxsets', icon: Boxes },
    {
      name: t('admin:observability.nav.monitoring'),
      href: '/admin/observability',
      icon: Eye,
      children: [
        { name: t('admin:observability.nav.gatewayMonitor'), href: '/admin/observability/cms', icon: Eye },
        { name: t('admin:observability.nav.containerMonitor'), href: '/admin/observability/container', icon: Eye },
        { name: t('admin:observability.nav.appMonitor'), href: '/admin/observability/app-monitor', icon: Eye },
      ]
    },
  ]

  const toggleMenu = (href: string) => {
    setExpandedMenus(prev =>
      prev.includes(href) ? prev.filter(n => n !== href) : [...prev, href]
    )
  }

  const isMenuActive = (item: NavItem): boolean => {
    if (location.pathname.startsWith(item.href)) return true
    if (item.children) {
      return item.children.some(child => location.pathname.startsWith(child.href))
    }
    return false
  }

  const isObservabilityPage = location.pathname.startsWith('/admin/observability/')

  const handleLogout = async () => {
    closeTerminal()
    navigate('/')
    await signOut()
  }

  return (
    <div className="min-h-screen bg-gray-100 flex">
        {/* Sidebar */}
        <aside
          className={`${
            sidebarOpen ? 'w-64' : 'w-20'
          } bg-sidebar-bg text-white transition-all duration-300 flex flex-col`}
        >
        {/* Logo */}
        <div className="h-16 flex items-center justify-between px-4 border-b border-gray-700">
          {sidebarOpen && (
            <div className="flex items-center space-x-3">
              <div className="w-8 h-8 bg-primary-600 rounded-lg flex items-center justify-center">
                <Shield className="w-5 h-5 text-white" />
              </div>
              <span className="font-bold text-sm">Agent Manager</span>
            </div>
          )}
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            aria-label={sidebarOpen ? t('common:nav.collapseSidebar') : t('common:nav.expandSidebar')}
            title={sidebarOpen ? t('common:nav.collapseSidebar') : t('common:nav.expandSidebar')}
            className="p-2 hover:bg-sidebar-hover rounded-lg transition-colors"
          >
            {sidebarOpen ? <X className="w-5 h-5" aria-hidden="true" /> : <Menu className="w-5 h-5" aria-hidden="true" />}
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 py-4 space-y-1">
          {navigation.map((item) => {
            const isActive = isMenuActive(item)
            const isExpanded = expandedMenus.includes(item.href)
            const hasChildren = item.children && item.children.length > 0

            return (
              <div key={item.href}>
                {hasChildren ? (
                  <>
                    {/* 父菜单项 - 可点击展开/收起 */}
                    <button
                      onClick={() => toggleMenu(item.href)}
                      className={`w-full flex items-center justify-between px-4 py-2.5 mx-2 rounded-lg transition-all duration-200 ${
                        isActive
                          ? 'bg-sidebar-active text-white'
                          : 'text-gray-400 hover:bg-sidebar-hover hover:text-white'
                      }`}
                      style={{ width: 'calc(100% - 16px)' }}
                    >
                      <div className="flex items-center">
                        <item.icon className="w-5 h-5 flex-shrink-0" />
                        {sidebarOpen && <span className="ml-3 font-medium">{item.name}</span>}
                      </div>
                      {sidebarOpen && (
                        <ChevronDown className={`w-4 h-4 transition-transform duration-200 ${isExpanded ? '' : '-rotate-90'}`} />
                      )}
                    </button>
                    {/* 子菜单 */}
                    {sidebarOpen && isExpanded && (
                      <div className="mt-1 ml-6 mr-2 pl-3 border-l border-gray-600/50 space-y-0.5">
                        {item.children?.map((child) => {
                          const isGatewayMonitor = child.href === '/admin/observability/cms'
                          return (
                            <Link
                              key={child.href}
                              to={child.href}
                              onClick={isGatewayMonitor ? (e) => handleGatewayMonitorClick(e, child.href) : undefined}
                              className={`flex items-center px-3 py-2 rounded-md transition-all duration-200 text-sm group ${
                                location.pathname.startsWith(child.href)
                                  ? 'bg-primary-600/20 text-primary-400'
                                  : 'text-gray-400 hover:bg-sidebar-hover hover:text-white'
                              }`}
                            >
                              <span className={`w-1.5 h-1.5 rounded-full mr-3 transition-colors ${
                                location.pathname.startsWith(child.href) ? 'bg-primary-400' : 'bg-gray-500 group-hover:bg-gray-400'
                              }`} />
                              <span>{child.name}</span>
                            </Link>
                          )
                        })}
                      </div>
                    )}
                  </>
                ) : (
                  <Link
                    to={item.href}
                    className={`flex items-center px-4 py-2.5 mx-2 rounded-lg transition-all duration-200 ${
                      isActive
                        ? 'bg-sidebar-active text-white'
                        : 'text-gray-400 hover:bg-sidebar-hover hover:text-white'
                    }`}
                  >
                    <item.icon className="w-5 h-5 flex-shrink-0" />
                    {sidebarOpen && <span className="ml-3">{item.name}</span>}
                  </Link>
                )}
              </div>
            )
          })}
        </nav>

        {/* User Info */}
        <div className="p-4 border-t border-gray-700">
          {sidebarOpen && (
            <div className="mb-3">
              <p className="text-sm font-medium text-white">{currentUser.username}</p>
              <p className="text-xs text-gray-400">{t('admin:currentUser.role')}</p>
            </div>
          )}
          <button
            onClick={handleLogout}
            className="w-full flex items-center justify-center px-4 py-2 bg-red-600 hover:bg-red-700 rounded-lg transition-colors"
          >
            <LogOut className="w-4 h-4" />
            {sidebarOpen && <span className="ml-2">{t('common:buttons.logout')}</span>}
          </button>
          {sidebarOpen && (
            <p className="text-xs text-gray-500 text-center mt-3">v{__APP_VERSION__}</p>
          )}
        </div>
      </aside>

      {/* Main Content */}
      <div className="min-w-0 flex-1 flex flex-col">
        {/* Top Bar */}
        <header className="h-16 bg-white border-b border-gray-200 flex items-center justify-between gap-3 px-4 sm:px-6">
          <h1 className="min-w-0 truncate text-lg font-semibold text-gray-900 sm:text-xl">
            {(() => {
              // 先检查子菜单
              for (const item of navigation) {
                if (item.children) {
                  const child = item.children.find(c => location.pathname.startsWith(c.href))
                  if (child) return child.name
                }
                if (location.pathname.startsWith(item.href)) return item.name
              }
              return t('admin:defaultTitle')
            })()}
          </h1>
          <div className="flex shrink-0 items-center space-x-3 sm:space-x-4">
            <LanguageSwitcher />
            <span className="hidden text-sm text-gray-600 sm:inline">
              {t('admin:currentUser.label', { name: currentUser.username })}
            </span>
          </div>
        </header>

        {/* Page Content */}
        <main className={`min-w-0 flex-1 ${isObservabilityPage ? 'overflow-hidden' : 'overflow-y-auto overflow-x-hidden p-6'}`}>
          <Outlet />
        </main>
      </div>
    </div>
  )
}

export default AdminLayout
