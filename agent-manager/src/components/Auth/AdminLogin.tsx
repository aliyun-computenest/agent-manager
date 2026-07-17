import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../contexts/AuthContext'
import ExternalLoginControls from './ExternalLoginControls'
import { Mail, Lock, Loader2, ArrowLeft, Shield, Users, Eye, EyeOff } from 'lucide-react'

export default function AdminLogin() {
  const navigate = useNavigate()
  const { t } = useTranslation('auth')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const { user, profile, loading: authLoading, signIn, error: authError } = useAuth()

  // 同步 AuthContext 全局错误（如账号被禁用）
  useEffect(() => {
    if (authError) {
      setError(authError)
      setLoading(false)
    }
  }, [authError])

  // 如果已登录，根据角色重定向
  useEffect(() => {
    // 等待认证加载完成
    if (authLoading) return

    if (user && profile) {
      if (profile.role === 'admin') {
        navigate('/admin/dashboard')
      } else {
        // 非管理员重定向到用户中心
        navigate('/user/instances')
      }
    }
  }, [user, profile, authLoading, navigate])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)

    const { error } = await signIn(email, password)

    if (error) {
      setError(error.message)
      setLoading(false)
    }
    // Don't setLoading(false) on success — let useEffect redirect handle it
    // This prevents flashing the login form between signIn return and profile load
  }

  // Show loading overlay when user is authenticated but profile hasn't loaded yet
  if (authLoading || (user && !profile && !authError)) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[linear-gradient(145deg,#f8fafc_0%,#eef2f7_52%,#f8fbff_100%)] flex flex-col">
      {/* Header */}
      <header className="p-4">
        <button
          onClick={() => navigate('/')}
          className="flex items-center text-sm text-slate-500 hover:text-slate-900 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-slate-500"
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
              <div className="w-12 h-12 bg-slate-950 rounded-xl flex items-center justify-center mx-auto mb-4 shadow-sm shadow-slate-300">
                <Shield className="w-7 h-7 text-white" />
              </div>
              <h1 className="text-xl font-semibold text-slate-950 mb-1">
                {t('adminLogin.title')}
              </h1>
              <p className="text-sm text-slate-500">
                {t('adminLogin.subtitle')}
              </p>
            </div>

            {error && (
              <div className="mb-6 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
                {error}
              </div>
            )}

            <ExternalLoginControls
              disabled={loading}
              accent="slate"
              onError={(message) => {
                setError(message)
                setLoading(false)
              }}
              passwordContent={({ externalLoginBusy }) => (
                <form onSubmit={handleSubmit} className="space-y-4">
                  <div className="relative">
                    <label htmlFor="admin-email" className="sr-only">{t('placeholders.adminEmail')}</label>
                    <Mail className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                    <input
                      id="admin-email"
                      type="email"
                      value={email}
                      onChange={e => setEmail(e.target.value)}
                      placeholder={t('placeholders.adminEmail')}
                      autoComplete="email"
                      spellCheck={false}
                      required
                      className="w-full pl-11 pr-4 py-3 text-base border border-slate-300 rounded-lg focus:ring-2 focus:ring-slate-700 focus:border-transparent transition-colors"
                    />
                  </div>

                  <div className="relative">
                    <label htmlFor="admin-password" className="sr-only">{t('placeholders.password')}</label>
                    <Lock className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                    <input
                      id="admin-password"
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      placeholder={t('placeholders.password')}
                      autoComplete="current-password"
                      required
                      className="w-full pl-11 pr-11 py-3 text-base border border-slate-300 rounded-lg focus:ring-2 focus:ring-slate-700 focus:border-transparent transition-colors"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      aria-label={showPassword ? t('password.hide') : t('password.show')}
                      className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md p-1 text-slate-400 hover:text-slate-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-500"
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>

                  <button
                    type="submit"
                    disabled={loading || externalLoginBusy}
                    className="w-full min-h-11 px-4 py-3 bg-slate-950 text-white text-base font-medium rounded-lg hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-500"
                  >
                    {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                    {loading ? t('login.loggingIn') : t('login.login')}
                  </button>
                </form>
              )}
            />

            {/* User Login Link */}
            <div className="mt-6 border-t border-slate-200 pt-4">
              <button
                onClick={() => navigate('/login')}
                className="w-full flex min-h-10 items-center justify-center gap-2 rounded-lg text-sm text-slate-500 hover:bg-slate-50 hover:text-slate-900 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-500"
              >
                <Users className="w-4 h-4" />
                <span>{t('adminLogin.userLogin')}</span>
              </button>
              <p className="mt-3 text-center text-xs leading-5 text-slate-400">
                {t('adminLogin.adminOnly')}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
