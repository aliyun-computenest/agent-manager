import React from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { Toaster } from 'react-hot-toast'
import { useTranslation } from 'react-i18next'
import { useAuth } from './contexts/AuthContext'
import { TerminalProvider } from './contexts/TerminalContext'
import AdminLayout from './components/AdminLayout'
import UserLayout from './components/UserLayout'
import TerminalDock from './components/TerminalDock'
import AdminDashboard from './components/AdminDashboard'
import UserManagement from './components/UserManagement'
import ModelConfig from './components/ModelConfig'
import SSOConfig from './components/SSOConfig'
import EmailAuthConfig from './components/EmailAuthConfig'
import ResetPassword from './components/ResetPassword'
import GroupManagement from './components/GroupManagement'

import OpenClawList from './components/OpenClawList'
import AgentTypeConfig from './components/AgentTypeConfig'
import AgentTypeDetail from './components/AgentTypeDetail'
import InstanceUpgrade from './components/InstanceUpgrade'
import {
  BackupExecutionCreatePage,
  BackupExecutionDetailPage,
  BackupExecutionsPage
} from './components/CheckpointBackupExecutions'
import InstanceBackupStartPage from './components/InstanceBackupStartPage'
import SandboxSetManagement from './components/SandboxSetManagement'
import SandboxSetDetailPage from './components/SandboxSetDetailPage'
import UserProfile from './components/UserProfile'
import UserOpenClawList from './components/UserOpenClawList'
import OpenClawDetail from './components/OpenClawDetail'
import NativeAgentWorkspace from './components/NativeAgentWorkspace'
import CreateOpenClaw from './components/CreateOpenClaw'
import TerminalPage from './components/TerminalPage'
import LandingPage from './components/LandingPage'
import NotFound from './components/NotFound'
import UserLogin from './components/Auth/UserLogin'
import AdminLogin from './components/Auth/AdminLogin'
import { PodObservability, CmsGatewayObservability, UserCmsGatewayObservability, ApmObservability } from './components/observability/ObservabilityPages'
import { hasSignupDisabledError } from './lib/login-route-error'
import SkillMarket from './components/skill-market'
import UserSkillMarket from './components/skill-market/UserSkillMarket'
import SkillSpaceDetail from './components/SkillSpaceDetail'
import SkillDetail from './components/SkillDetail'

// 定义当前用户类型
export interface CurrentUser {
  id: string
  username: string
  email: string | undefined
  role: 'admin' | 'user'
  status: 'active' | 'disabled'
  max_agent_instances: number
}

function App() {
  const { user, profile, loading, isConfigured, isRecovery } = useAuth()
  const { t } = useTranslation('common')

  console.log('[App] 渲染 App 组件:', {
    user: !!user,
    email: user?.email,
    profile,
    loading,
    isConfigured
  })

  // PASSWORD_RECOVERY: 优先于 loading 检查，否则 fetchProfile 挂住时永远卡在加载中
  if (isRecovery) {
    if (window.location.pathname !== '/user/reset-password') {
      return <Navigate to="/user/reset-password" replace />
    }
    // 已在 /user/reset-password，直接渲染（不等 loading）
    return (
      <>
        <Toaster position="top-center" />
        <Routes>
          <Route path="/user/reset-password" element={<ResetPassword />} />
          <Route path="*" element={<Navigate to="/user/reset-password" replace />} />
        </Routes>
      </>
    )
  }

  if (window.location.pathname === '/' && hasSignupDisabledError(window.location)) {
    return <Navigate to="/login?error=unauthorized" replace />
  }

  // 只在配置了 Supabase 时等待加载
  if (isConfigured && loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-4 border-blue-200 border-t-blue-600 mx-auto mb-4" />
          <p className="text-gray-600">{t('loading.default')}</p>
        </div>
      </div>
    )
  }

  // 构建当前用户对象（从 AuthContext 获取）
  // OAuth 用户优先从 user_metadata 中获取用户名
  // 阿里云 OAuth 返回字段: name(显示名), upn(RAM用户登录名), login_name(主账号登录名)
  const getDisplayName = () => {
    if (profile?.username) return profile.username

    // OAuth 用户：尝试从 user_metadata 获取（阿里云 OAuth 字段）
    const metadata = user?.user_metadata as Record<string, unknown> | undefined
    const getMetadataString = (key: string) => {
      const value = metadata?.[key]
      return typeof value === 'string' && value ? value : null
    }
    const name = getMetadataString('name')
    if (name) return name
    const upn = getMetadataString('upn')
    if (upn) return upn  // RAM 用户登录名
    const loginName = getMetadataString('login_name')
    if (loginName) return loginName  // 主账号登录名
    const preferredUsername = getMetadataString('preferred_username')
    if (preferredUsername) return preferredUsername

    // 最后尝试邮箱前缀（过滤掉自动生成的 alibabacloud 邮箱）
    const email = user?.email || ''
    if (email.endsWith('@alibabacloud.com')) return t('roles.alicloudUser')
    return email.split('@')[0] || 'User'
  }

  const currentUser = user && profile ? {
    id: user.id,
    username: getDisplayName(),
    email: user.email,
    role: profile.role,
    status: profile.status,
    max_agent_instances: profile.max_agent_instances
  } : null

  console.log('[App] currentUser 构建完成:', currentUser)

  return (
    <TerminalProvider>
      <Routes>
        <Route path="/" element={<LandingPage currentUser={currentUser} />} />
      {/* 登录路由 */}
      <Route path="/login" element={<UserLogin />} />
      <Route path="/admin/login" element={<AdminLogin />} />

      {/* 密码重置页 — 顶层路由，用户通过邮件链接到达，此时无 session */}
      <Route path="/user/reset-password" element={<ResetPassword />} />

        {/* 独立终端页面路由（全屏，无 layout wrapper） */}
      <Route path="/admin/instances/:id/terminal" element={<TerminalPage />} />
      <Route path="/user/instances/:id/terminal" element={<TerminalPage />} />

      {/* 管理员侧路由 - 在 AdminLayout 中检查权限 */}
        <Route path="/admin/*" element={<AdminLayoutWrapper currentUser={currentUser} />}>
          <Route index element={<Navigate to="/admin/dashboard" replace />} />
          <Route path="dashboard" element={<AdminDashboard />} />
          <Route path="users" element={<UserManagement />} />
          <Route path="sso-config" element={<SSOConfig />} />
          <Route path="email-auth" element={<EmailAuthConfig />} />
          <Route path="models" element={<ModelConfig />} />
          <Route path="groups" element={<GroupManagement />} />

          <Route path="instances" element={<OpenClawList view="admin" />} />
          <Route path="instances/create" element={<CreateOpenClaw mode="admin" />} />
          <Route path="instances/:id" element={<OpenClawDetail />} />
          <Route path="instances/:id/native-ui" element={<NativeAgentWorkspace />} />
          <Route path="instances/:id/backups/new" element={<InstanceBackupStartPage />} />
          <Route path="agent-types" element={<AgentTypeConfig />} />
          <Route path="agent-types/:id" element={<AgentTypeDetail />} />
          <Route path="skill-spaces" element={<SkillMarket />} />
          <Route path="skill-spaces/:skillSpaceId" element={<SkillSpaceDetail />} />
          <Route path="skill-spaces/skills/:skillId" element={<SkillDetail />} />
          <Route path="instance-upgrades" element={<InstanceUpgrade />} />
          <Route path="backups" element={<BackupExecutionsPage />} />
          <Route path="backups/create" element={<BackupExecutionCreatePage />} />
          <Route path="backups/:executionId" element={<BackupExecutionDetailPage />} />
          <Route path="sandboxsets" element={<SandboxSetManagement />} />
          <Route path="sandboxsets/new" element={<SandboxSetDetailPage />} />
          <Route path="sandboxsets/:name" element={<SandboxSetDetailPage />} />
          <Route path="observability" element={<Navigate to="/admin/observability/cms" replace />} />
          <Route path="observability/container" element={<PodObservability />} />
          <Route path="observability/container/:instanceId" element={<PodObservability />} />
          <Route path="observability/cms" element={<CmsGatewayObservability />} />
          <Route path="observability/cms/user/:consumerName" element={<UserCmsGatewayObservability />} />
          <Route path="observability/app-monitor" element={<ApmObservability />} />
          <Route path="observability/app-monitor/instance/:instanceId" element={<ApmObservability />} />

        </Route>

        {/* 用户侧路由 - 所有登录且未被禁用的用户可访问 */}
        {currentUser && currentUser.status !== 'disabled' && (
          <Route path="/user" element={<UserLayout currentUser={currentUser} />}>
            <Route index element={<Navigate to="/user/instances" replace />} />
            <Route path="dashboard" element={<Navigate to="/user/instances" replace />} />
            <Route path="instances" element={<UserOpenClawList />} />
            <Route path="instances/create" element={<CreateOpenClaw />} />
            <Route path="instances/:id" element={<OpenClawDetail />} />
            <Route path="instances/:id/native-ui" element={<NativeAgentWorkspace />} />
            <Route path="instances/:id/backups/new" element={<InstanceBackupStartPage />} />
            <Route path="skill-market" element={<UserSkillMarket />} />
            <Route path="groups" element={<GroupManagement mode="user" />} />
            <Route path="profile" element={<UserProfile />} />
          </Route>
        )}

        {/* 404 路由 */}
        <Route path="*" element={<NotFound />} />
      </Routes>
      <TerminalDock />
      <Toaster position="top-center" />
    </TerminalProvider>
  )
}

// 管理员 Layout 包装器 - 动态检查权限
function AdminLayoutWrapper({ currentUser }: { currentUser: CurrentUser | null }) {
  const { profile, signOut } = useAuth()
  const { t } = useTranslation('common')

  console.log('[AdminLayoutWrapper] 渲染，currentUser:', currentUser, 'profile:', profile)

  // 如果 profile 还在加载，显示 loading
  if (!profile && currentUser) {
    console.log('[AdminLayoutWrapper] profile 未加载，显示 loading')
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-4 border-blue-200 border-t-blue-600 mx-auto mb-4" />
          <p className="text-gray-600">{t('loading.permissions')}</p>
        </div>
      </div>
    )
  }

  // 重新构建 currentUser（使用最新的 profile）
  const updatedCurrentUser = currentUser ? {
    ...currentUser,
    role: profile?.role || 'user' as 'admin' | 'user',
    status: profile?.status || 'active' as 'active' | 'disabled',
    max_agent_instances: profile?.max_agent_instances || 5
  } : null

  console.log('[AdminLayoutWrapper] updatedCurrentUser:', updatedCurrentUser)
  console.log('[AdminLayoutWrapper] role 检查:', updatedCurrentUser?.role, '是否为 admin:', updatedCurrentUser?.role === 'admin')

  // 被禁用的用户，强制登出并跳转到登录页
  if (updatedCurrentUser?.status === 'disabled') {
    console.log('[AdminLayoutWrapper] 用户已被禁用，强制登出')
    signOut()
    return <Navigate to="/admin/login" replace />
  }

  // 非管理员重定向到首页
  if (updatedCurrentUser?.role !== 'admin') {
    console.log('[AdminLayoutWrapper] 非管理员，重定向到首页')
    return <Navigate to="/" replace />
  }

  console.log('[AdminLayoutWrapper] 是管理员，渲染 AdminLayout')
  return <AdminLayout currentUser={updatedCurrentUser} />
}

export default App
