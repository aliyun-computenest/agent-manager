import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Lock, Eye, EyeOff, Loader2, CheckCircle, ShieldCheck } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'

const PwdInput = ({ value, onChange, show, onToggle, placeholder }: {
  value: string; onChange: (v: string) => void; show: boolean; onToggle: () => void; placeholder: string
}) => (
  <div className="relative">
    <input
      type={show ? 'text' : 'password'}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full px-3 py-2 text-sm bg-gray-50 border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent focus:bg-white pr-9 transition-colors"
      placeholder={placeholder}
    />
    <button
      type="button"
      onClick={onToggle}
      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
    >
      {show ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
    </button>
  </div>
)

export default function ResetPassword() {
  const navigate = useNavigate()
  const { t } = useTranslation('auth')
  const { isRecovery, clearRecovery, updatePassword } = useAuth()
  const [newPassword, setNewPassword] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)
  const [countdown, setCountdown] = useState(3)
  const [waiting, setWaiting] = useState(!isRecovery)

  // Wait up to 3 seconds for PASSWORD_RECOVERY event to fire
  useEffect(() => {
    if (isRecovery) {
      setWaiting(false)
      return
    }
    const timer = setTimeout(() => setWaiting(false), 3000)
    return () => clearTimeout(timer)
  }, [isRecovery])

  useEffect(() => {
    if (!success) return
    const timer = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          clearInterval(timer)
          clearRecovery()
          // 通过 location state 告诉 UserLogin：这次是密码重置后主动跳回登录页，
          // 不要因为残留的 session 把用户自动重定向到 /user/instances
          navigate('/login', { replace: true, state: { fromPasswordReset: true } })
          return 0
        }
        return prev - 1
      })
    }, 1000)
    return () => clearInterval(timer)
  }, [success, navigate, clearRecovery])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (!newPassword || newPassword.length < 6) {
      setError(t('errors.passwordMinLength')); return
    }
    setSaving(true)
    try {
      const { error: updateError } = await updatePassword(newPassword)
      if (updateError) throw updateError
      setSuccess(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.passwordChangeFailed'))
    } finally {
      setSaving(false)
    }
  }

  if (waiting) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="max-w-sm w-full bg-white rounded-2xl border border-gray-200 shadow-sm p-8 text-center">
          <Loader2 className="w-12 h-12 text-blue-500 mx-auto mb-4 animate-spin" />
          <h2 className="text-lg font-bold text-gray-900 mb-2">{t('resetPassword.verifyingLink')}</h2>
          <p className="text-sm text-gray-500">{t('resetPassword.pleaseWait')}</p>
        </div>
      </div>
    )
  }

  if (!isRecovery) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="max-w-sm w-full bg-white rounded-2xl border border-gray-200 shadow-sm p-8 text-center">
          <Lock className="w-12 h-12 text-gray-300 mx-auto mb-4" />
          <h2 className="text-lg font-bold text-gray-900 mb-2">{t('resetPassword.linkInvalid')}</h2>
          <p className="text-sm text-gray-500 mb-6">
            {t('resetPassword.retryFromProfile')}
          </p>
          <button
            onClick={() => navigate('/login')}
            className="w-full py-2 text-sm font-medium text-white bg-gray-900 hover:bg-gray-800 rounded-lg transition-colors"
          >
            {t('backToLogin')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="max-w-sm w-full">
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-6 py-6 flex flex-col items-center border-b border-gray-100">
            <div className="w-14 h-14 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white shadow-md shadow-blue-200 mb-3">
              <ShieldCheck className="w-7 h-7" />
            </div>
            <h2 className="text-lg font-bold text-gray-900">{t('resetPassword.title')}</h2>
            <p className="text-sm text-gray-500 mt-1">{t('resetPassword.subtitle')}</p>
          </div>

          {!success ? (
            <form onSubmit={handleSubmit} className="px-6 py-5 space-y-3">
              <PwdInput
                value={newPassword}
                onChange={setNewPassword}
                show={showNew}
                onToggle={() => setShowNew(!showNew)}
                placeholder={t('placeholders.newPassword')}
              />

              {error && (
                <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={saving}
                className="w-full py-2 text-sm font-medium text-white bg-gray-900 hover:bg-gray-800 disabled:opacity-50 rounded-lg transition-colors flex items-center justify-center gap-1.5"
              >
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                {saving ? t('resetPassword.changing') : t('resetPassword.confirmChange')}
              </button>
            </form>
          ) : (
            <div className="px-6 py-8 text-center">
              <p className="text-sm text-green-600 bg-green-50 rounded-lg px-3 py-3 flex items-center justify-center gap-1.5">
                <CheckCircle className="w-4 h-4" />
                {t('resetPassword.passwordChangeSuccess', { countdown })}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
