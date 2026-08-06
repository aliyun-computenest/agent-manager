import React, { useState, useEffect } from 'react'
import { Lock, Eye, EyeOff, Loader2, CheckCircle, KeyRound, Mail } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../contexts/AuthContext'
import { apiUrl } from '../lib/api'

const PwdInput = ({ value, onChange, show, onToggle, placeholder }: {
  value: string; onChange: (v: string) => void; show: boolean; onToggle: () => void; placeholder: string
}) => (
  <div className="relative">
    <input type={show ? 'text' : 'password'} value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full px-3 py-2 text-sm bg-gray-50 border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent focus:bg-white pr-9 transition-colors"
      placeholder={placeholder} />
    <button type="button" onClick={onToggle}
      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
      {show ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
    </button>
  </div>
)

const UserProfile: React.FC = () => {
  const { user, profile, session, signOut } = useAuth()
  const { t } = useTranslation(['user', 'common'])

  const [pwdOpen, setPwdOpen] = useState(false)
  const [emailAuthEnabled, setEmailAuthEnabled] = useState(false)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showCurrentPassword, setShowCurrentPassword] = useState(false)
  const [showNewPassword, setShowNewPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const displayName = profile?.username || user?.email?.split('@')[0] || 'User'
  const email = user?.email || '-'
  const role = profile?.role === 'admin' ? t('common:roles.admin') : t('common:roles.user')
  const maxInstances = profile?.max_agent_instances ?? 5

  useEffect(() => {
    const token = session?.access_token
    if (!token) return
    fetch(`${apiUrl}/api/users/me/auth-mode`, {
      headers: { Authorization: `Bearer ${token}` }
    })
      .then(r => r.json())
      .then(d => { if (d.success) setEmailAuthEnabled(d.data.emailAuthEnabled) })
      .catch(() => {})
  }, [session])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(''); setSuccess('')
    if (!currentPassword) { setError(t('profile.validation.currentPasswordRequired')); return }
    if (!emailAuthEnabled) {
      if (!newPassword || newPassword.length < 6) { setError(t('profile.validation.newPasswordTooShort')); return }
      if (newPassword !== confirmPassword) { setError(t('profile.validation.passwordMismatch')); return }
      if (currentPassword === newPassword) { setError(t('profile.validation.sameAsOld')); return }
    }

    setSaving(true)
    try {
      const token = session?.access_token
      if (!token) throw new Error(t('profile.validation.notLoggedIn'))
      const response = await fetch(`${apiUrl}/api/users/me/password`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ currentPassword, newPassword })
      })
      const data = await response.json()
      if (!data.success) throw new Error(data.error || t('profile.validation.changeFailed'))

      if (data.requiresEmailVerification) {
        setSuccess(t('profile.emailResetSuccess'))
      } else {
        // 密码修改成功：清除本地 session 后立刻跳转 /login。
        // 否则页面刷新后 AuthContext 会从 localStorage 恢复旧 session，
        // UserLogin 检测到已登录又会把用户重定向到 /user/instances，
        // 接着路由条件渲染时序错乱导致 404。
        // 注意：signOut 走 fire-and-forget，不能 await，
        // 因为预发环境的 supabase 调用偶尔会卡十几秒。
        signOut().catch(err => console.error('[UserProfile] signOut failed:', err))
        // 主动清掉所有 supabase 持久化的 token，确保 AuthContext 重启时拿不到旧 session
        Object.keys(localStorage)
          .filter(k => k.startsWith('sb-'))
          .forEach(k => localStorage.removeItem(k))
        window.location.replace('/login')
        return
      }
      setCurrentPassword(''); setNewPassword(''); setConfirmPassword('')
    } catch (err) {
      setError(err instanceof Error ? err.message : t('profile.validation.changeFailed'))
    } finally { setSaving(false) }
  }

  return (
    <div className="max-w-lg">
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        {/* Header */}
        <div className="px-6 py-5 flex items-center gap-4 border-b border-gray-100">
          <div className="w-14 h-14 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white font-bold text-xl flex-shrink-0 shadow-md shadow-blue-200">
            {displayName.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-bold text-gray-900 truncate">{displayName}</h2>
            <p className="text-sm text-gray-500 truncate">{email}</p>
          </div>
          <span className={`px-2.5 py-1 text-xs font-medium rounded-full flex-shrink-0 ${
            profile?.role === 'admin' ? 'bg-amber-50 text-amber-700' : 'bg-blue-50 text-blue-700'
          }`}>{role}</span>
        </div>

        {/* Info */}
        <div className="px-6 py-4 grid grid-cols-2 gap-x-6 gap-y-3 border-b border-gray-100">
          <div>
            <p className="text-xs text-gray-400 mb-0.5">{t('profile.email')}</p>
            <p className="text-sm font-medium text-gray-900 truncate" title={email}>{email}</p>
          </div>
          <div>
            <p className="text-xs text-gray-400 mb-0.5">{t('profile.instanceQuota')}</p>
            <p className="text-sm font-medium text-gray-900">{t('profile.instanceQuotaUnit', { count: maxInstances })}</p>
          </div>
        </div>

        {/* Password */}
        <div>
          <button
            onClick={() => { setPwdOpen(!pwdOpen); setError(''); setSuccess('') }}
            className="w-full px-6 py-4 flex items-center justify-between hover:bg-gray-50 transition-colors group"
          >
            <div className="flex items-center gap-3">
              <KeyRound className="w-4 h-4 text-gray-400 group-hover:text-gray-600 transition-colors" />
              <span className="text-sm font-medium text-gray-700">{t('profile.changePassword')}</span>
            </div>
            <Lock className={`w-3.5 h-3.5 text-gray-300 transition-transform ${pwdOpen ? 'rotate-12' : ''}`} />
          </button>

          {pwdOpen && (
            <form onSubmit={handleSubmit} className="px-6 pb-5 space-y-3">
              <PwdInput value={currentPassword} onChange={setCurrentPassword}
                show={showCurrentPassword} onToggle={() => setShowCurrentPassword(!showCurrentPassword)} placeholder={t('profile.currentPassword')} />

              {!emailAuthEnabled && (
                <div className="grid grid-cols-2 gap-3">
                  <PwdInput value={newPassword} onChange={setNewPassword}
                    show={showNewPassword} onToggle={() => setShowNewPassword(!showNewPassword)} placeholder={t('profile.newPassword')} />
                  <PwdInput value={confirmPassword} onChange={setConfirmPassword}
                    show={showConfirmPassword} onToggle={() => setShowConfirmPassword(!showConfirmPassword)} placeholder={t('profile.confirmNewPassword')} />
                </div>
              )}

              {emailAuthEnabled && !success && (
                <p className="text-xs text-gray-500 bg-gray-50 rounded-lg px-3 py-2 flex items-center gap-1.5">
                  <Mail className="w-3.5 h-3.5 flex-shrink-0" />
                  {t('profile.emailResetHint')}
                </p>
              )}

              {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
              {success && success.includes('@') ? (
                <div className="text-xs bg-blue-50 border border-blue-200 rounded-lg px-3 py-2.5 space-y-1">
                  <p className="text-blue-700 font-medium flex items-center gap-1">
                    <Mail className="w-3.5 h-3.5" />
                    {t('profile.resetEmailSent')}
                  </p>
                  <p className="text-blue-600">
                    {t('profile.resetEmailDetail')}
                  </p>
                </div>
              ) : success ? (
                <div className="text-xs bg-green-50 border border-green-200 rounded-lg px-3 py-2.5">
                  <p className="text-green-700 font-medium flex items-center gap-1">
                    <CheckCircle className="w-3.5 h-3.5" />{success}
                  </p>
                </div>
              ) : null}

              <button type="submit" disabled={saving}
                className="w-full py-2 text-sm font-medium text-white bg-gray-900 hover:bg-gray-800 disabled:opacity-50 rounded-lg transition-colors flex items-center justify-center gap-1.5">
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                {saving ? (emailAuthEnabled ? t('profile.sending') : t('profile.changing')) : (emailAuthEnabled ? t('profile.sendResetEmail') : t('profile.confirmChange'))}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}

export default UserProfile
