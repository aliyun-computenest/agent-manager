import { useState, useEffect, useRef } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../contexts/AuthContext'
import { getLoginRouteError } from '../../lib/login-route-error'
import ExternalLoginControls from './ExternalLoginControls'
import { Loader2, Shield, ArrowLeft, Bot, KeyRound, Mail, Lock, Eye, EyeOff } from 'lucide-react'

export default function UserLogin() {
  const navigate = useNavigate()
  const location = useLocation()
  const { t } = useTranslation('auth')
  // 来自密码重置成功后的跳转，跳过"已登录自动重定向"，让用户用新密码主动登录
  const fromPasswordReset = (location.state as { fromPasswordReset?: boolean } | null)?.fromPasswordReset === true
  const unauthorizedFromCallback = getLoginRouteError(location) === 'unauthorized'
  const handledRouteErrorRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [passwordLoading, setPasswordLoading] = useState(false)
  const { user, profile, loading: authLoading, signIn, signOut, error: authError } = useAuth()

  // 同步 AuthContext 全局错误（如账号被禁用）
  useEffect(() => {
    if (authError) {
      setError(authError)
      setPasswordLoading(false)
    }
  }, [authError])

  useEffect(() => {
    if (!unauthorizedFromCallback) {
      handledRouteErrorRef.current = false
      return
    }

    setError(t('errors.unauthorizedLogin'))
    setPasswordLoading(false)
    if (!handledRouteErrorRef.current) {
      handledRouteErrorRef.current = true
      void signOut()
    }
  }, [unauthorizedFromCallback, signOut, t])

  // 如果已登录，根据角色重定向
  useEffect(() => {
    // 等待认证加载完成
    if (authLoading) return
    // 密码重置后跳回登录页：保留页面，等用户用新密码主动登录
    if (fromPasswordReset) return

    if (user && profile) {
      if (profile.role === 'admin') {
        navigate('/admin/dashboard')
      } else {
        navigate('/user/instances')
      }
    }
  }, [user, profile, authLoading, navigate, fromPasswordReset])

  const isUnauthorizedError = error === t('errors.unauthorizedLogin')

  const handlePasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setPasswordLoading(true)
    setError(null)

    const { error } = await signIn(email, password)

    if (error) {
      setError(error.message)
      setPasswordLoading(false)
    }
    // Don't reset loading on success — let useEffect redirect handle it
  }

  // Show loading overlay when user is authenticated but profile hasn't loaded yet
  if (authLoading || (user && !profile && !authError && !error)) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-blue-400" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[linear-gradient(145deg,#f8fafc_0%,#eef4ff_52%,#f8fbff_100%)] flex flex-col">
      {/* Header */}
      <header className="p-4">
        <button
          onClick={() => navigate('/')}
          className="flex items-center text-sm text-slate-500 hover:text-slate-900 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-500"
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          {t('backToHome')}
        </button>
      </header>

      {/* Main Content */}
      <div className="flex-1 flex items-center justify-center px-4 py-8">
        <div className="w-full max-w-[420px]">
          <div className="bg-white/95 rounded-xl border border-slate-200/80 shadow-lg shadow-slate-200/60 p-6 sm:p-7">
            {/* Logo */}
            <div className="text-center mb-6">
              <div className="w-12 h-12 bg-blue-600 rounded-xl flex items-center justify-center mx-auto mb-4 shadow-sm shadow-blue-200">
                <Bot className="w-7 h-7 text-white" />
              </div>
              <h1 className="text-xl font-semibold text-slate-950 mb-1">
                {t('userLogin.title')}
              </h1>
              <p className="text-sm text-slate-500">
                {t('userLogin.subtitle')}
              </p>
            </div>

            {isUnauthorizedError ? (
              <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 p-4">
                <div className="flex gap-3">
                  <Shield className="mt-0.5 h-5 w-5 flex-none text-amber-600" />
                  <div>
                    <p className="font-semibold text-amber-900">{t('unauthorized.title')}</p>
                    <p className="mt-1 text-sm text-amber-800">{t('unauthorized.description')}</p>
                  </div>
                </div>
              </div>
            ) : error && (
              <div className="mb-6 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
                {error}
              </div>
            )}

            <ExternalLoginControls
              disabled={passwordLoading}
              forcePassword={fromPasswordReset}
              accent="blue"
              onError={setError}
              passwordContent={({ externalLoginBusy }) => (
                <form onSubmit={handlePasswordLogin} className="space-y-4">
                  <div className="relative">
                    <label htmlFor="user-email" className="sr-only">{t('placeholders.email')}</label>
                    <Mail className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                    <input
                      id="user-email"
                      type="email"
                      value={email}
                      onChange={e => setEmail(e.target.value)}
                      placeholder={t('placeholders.email')}
                      autoComplete="email"
                      spellCheck={false}
                      required
                      className="w-full pl-11 pr-4 py-3 text-base border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-colors"
                    />
                  </div>
                  <div className="relative">
                    <label htmlFor="user-password" className="sr-only">{t('placeholders.password')}</label>
                    <Lock className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                    <input
                      id="user-password"
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      placeholder={t('placeholders.password')}
                      autoComplete="current-password"
                      required
                      className="w-full pl-11 pr-11 py-3 text-base border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-colors"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      aria-label={showPassword ? t('password.hide') : t('password.show')}
                      className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md p-1 text-slate-400 hover:text-slate-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  <button
                    type="submit"
                    disabled={passwordLoading || externalLoginBusy}
                    className="w-full min-h-11 px-4 py-3 bg-blue-600 text-white text-base font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
                  >
                    {passwordLoading && <Loader2 className="h-4 w-4 animate-spin" />}
                    {passwordLoading ? t('login.loggingIn') : t('login.login')}
                  </button>
                </form>
              )}
            />

            {/* Admin Login Link */}
            <div className="mt-6 border-t border-slate-200 pt-4">
              <button
                onClick={() => navigate('/admin/login')}
                className="w-full flex min-h-10 items-center justify-center gap-2 rounded-lg text-sm text-slate-500 hover:bg-slate-50 hover:text-slate-900 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
              >
                <KeyRound className="w-4 h-4" />
                <span>{t('adminLogin.title')}</span>
              </button>
              <p className="mt-3 text-center text-xs leading-5 text-slate-400">
                {t('accountCreatedByAdmin')}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
