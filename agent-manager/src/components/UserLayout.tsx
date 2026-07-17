import React, { useState } from 'react'
import { Outlet, useNavigate, useLocation, Link, Navigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { useTerminalDock } from '../contexts/TerminalContext'
import { useTranslation } from 'react-i18next'
import LanguageSwitcher from './LanguageSwitcher'
import {
  Bot,
  LogOut,
  Menu,
  X,
  Shield,
  UserCircle,
  Layers,
  PackageOpen
} from 'lucide-react'

interface UserLayoutProps {
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

const UserLayout: React.FC<UserLayoutProps> = ({ currentUser }) => {
  const navigate = useNavigate()
  const location = useLocation()
  const { signOut } = useAuth()
  const { closeTerminal } = useTerminalDock()
  const { t } = useTranslation(['user', 'common'])
  const [sidebarOpen, setSidebarOpen] = useState(shouldOpenSidebarByDefault)

  if (!currentUser) {
    return <Navigate to="/" replace />
  }

  const navigation = [
    { name: t('user:nav.instanceList'), href: '/user/instances', icon: Bot },
    { name: t('user:nav.skillMarket'), href: '/user/skill-market', icon: PackageOpen },
    { name: t('user:nav.groups'), href: '/user/groups', icon: Layers },
    { name: t('user:nav.profile'), href: '/user/profile', icon: UserCircle },
  ]

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
        <nav className="flex-1 py-4">
          {navigation.map((item) => {
            const isActive = location.pathname.startsWith(item.href)
            return (
              <Link
                key={item.href}
                to={item.href}
                className={`flex items-center px-4 py-3 mx-2 rounded-lg transition-colors ${
                  isActive
                    ? 'bg-sidebar-active text-white'
                    : 'text-gray-400 hover:bg-sidebar-hover hover:text-white'
                }`}
              >
                <item.icon className="w-5 h-5 flex-shrink-0" />
                {sidebarOpen && (
                  <span className="ml-3">{item.name}</span>
                )}
              </Link>
            )
          })}
        </nav>

        {/* User Info */}
        <div className="p-4 border-t border-gray-700">
          {sidebarOpen && (
            <div className="mb-3">
              <p className="text-sm font-medium text-white">{currentUser.username}</p>
              <p className="text-xs text-gray-400">{t('user:currentUser.role')}</p>
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
            {navigation.find(n => location.pathname.startsWith(n.href))?.name || t('user:defaultTitle')}
          </h1>
          <div className="flex shrink-0 items-center space-x-3 sm:space-x-4">
            <LanguageSwitcher />
            <span className="hidden text-sm text-gray-600 sm:inline">
              {t('user:currentUser.label', { name: currentUser.username })}
            </span>
          </div>
        </header>

        {/* Page Content */}
        <main className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden p-6">
          <Outlet />
        </main>
      </div>
    </div>
  )
}

export default UserLayout
