import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { QRCodeSVG } from 'qrcode.react'
import { Loader2, CheckCircle2, XCircle, QrCode, RefreshCw } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { apiUrl } from '../lib/api'

interface DingtalkQRConfigProps {
  /** Instance ID to bind the credentials to (optional - if not provided, credentials returned via callback) */
  instanceId?: string
  /** Called when authorization succeeds with the obtained credentials */
  onSuccess: (credentials: { clientId: string; clientSecret?: string }) => void
  /** Called when the user cancels or closes the QR flow */
  onCancel?: () => void
}

type FlowStatus = 'idle' | 'loading' | 'scanning' | 'success' | 'expired' | 'error'

export default function DingtalkQRConfig({ instanceId, onSuccess, onCancel }: DingtalkQRConfigProps) {
  const { t } = useTranslation('admin')
  const { session } = useAuth()
  const [status, setStatus] = useState<FlowStatus>('idle')
  const [verificationUrl, setVerificationUrl] = useState('')
  const [userCode, setUserCode] = useState('')
  const [deviceCode, setDeviceCode] = useState('')
  const [interval, setInterval_] = useState(2)
  const [errorMsg, setErrorMsg] = useState('')
  const [countdown, setCountdown] = useState(0)
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const abortRef = useRef(false)

  // Start the DingTalk device registration flow
  const startFlow = useCallback(async () => {
    if (!session?.access_token) return

    setStatus('loading')
    setErrorMsg('')
    abortRef.current = false

    try {
      const res = await fetch(`${apiUrl}/api/channel-auto-config/dingtalk/begin`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`
        }
      })

      const data = await res.json()

      if (!data.success) {
        throw new Error(data.error || t('qrConfig.dingtalk.startFailed'))
      }

      setVerificationUrl(data.verificationUrl)
      setUserCode(data.userCode)
      setDeviceCode(data.deviceCode)
      setInterval_(data.interval || 2)
      setCountdown(data.expiresIn || 7200)
      setStatus('scanning')
    } catch (err: any) {
      setStatus('error')
      setErrorMsg(err.message || t('qrConfig.dingtalk.startFailed'))
    }
  }, [session?.access_token, t])

  // Poll for authorization result
  const pollStatus = useCallback(async () => {
    if (!session?.access_token || !deviceCode || abortRef.current) return

    try {
      const res = await fetch(`${apiUrl}/api/channel-auto-config/dingtalk/poll`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`
        },
        body: JSON.stringify({ deviceCode, instanceId })
      })

      const data = await res.json()

      if (abortRef.current) return

      if (data.success && data.status === 'SUCCESS') {
        setStatus('success')
        onSuccess({
          clientId: data.clientId,
          clientSecret: data.clientSecret
        })
        return
      }

      if (data.status === 'EXPIRED') {
        setStatus('expired')
        abortRef.current = true
        return
      }

      if (data.status === 'ERROR' || data.success === false) {
        setStatus('error')
        setErrorMsg(data.error || data.errmsg || t('qrConfig.common.authFailed'))
        abortRef.current = true
        return
      }

      // Still pending – schedule next poll
      if (!abortRef.current) {
        pollTimerRef.current = setTimeout(pollStatus, interval * 1000)
      }
    } catch (err: any) {
      // Network error – retry after interval
      if (!abortRef.current) {
        pollTimerRef.current = setTimeout(pollStatus, interval * 1000)
      }
    }
  }, [session?.access_token, deviceCode, instanceId, interval, onSuccess, t])

  // Start polling when we enter 'scanning' state
  useEffect(() => {
    if (status === 'scanning' && deviceCode) {
      // Start first poll after one interval
      pollTimerRef.current = setTimeout(pollStatus, interval * 1000)
    }

    return () => {
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current)
        pollTimerRef.current = null
      }
    }
  }, [status, deviceCode, pollStatus, interval])

  // Countdown timer
  useEffect(() => {
    if (status === 'scanning') {
      countdownTimerRef.current = setInterval(() => {
        setCountdown(prev => {
          if (prev <= 1) {
            setStatus('expired')
            abortRef.current = true
            return 0
          }
          return prev - 1
        })
      }, 1000)
    }

    return () => {
      if (countdownTimerRef.current) {
        clearInterval(countdownTimerRef.current)
        countdownTimerRef.current = null
      }
    }
  }, [status])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      abortRef.current = true
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current)
      if (countdownTimerRef.current) clearInterval(countdownTimerRef.current)
    }
  }, [])

  // Auto-start the flow
  useEffect(() => {
    startFlow()
  }, [startFlow])

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60)
    const s = seconds % 60
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  const handleRetry = () => {
    abortRef.current = true
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current)
    if (countdownTimerRef.current) clearInterval(countdownTimerRef.current)
    startFlow()
  }

  return (
    <div className="border border-blue-200 rounded-lg p-6 bg-blue-50/50">
      <div className="flex items-center space-x-2 mb-4">
        <QrCode className="w-5 h-5 text-blue-600" />
        <h4 className="font-medium text-gray-900">{t('qrConfig.dingtalk.title')}</h4>
      </div>

      {/* Loading state */}
      {status === 'loading' && (
        <div className="flex flex-col items-center py-8">
          <Loader2 className="w-8 h-8 text-blue-500 animate-spin mb-3" />
          <p className="text-sm text-gray-600">{t('qrConfig.common.generatingQR')}</p>
        </div>
      )}

      {/* QR Code display – scanning state */}
      {status === 'scanning' && verificationUrl && (
        <div className="flex flex-col items-center">
          <div className="bg-white p-4 rounded-lg shadow-sm border border-gray-200 mb-4">
            <QRCodeSVG
              value={verificationUrl}
              size={200}
              level="M"
              includeMargin
            />
          </div>
          <p className="text-sm text-gray-700 mb-1">
            {t('qrConfig.common.scanQrPrefix')}
            <span className="font-semibold text-blue-600">{t('qrConfig.dingtalk.appName')}</span>
            {t('qrConfig.common.scanQrSuffix')}
          </p>
          <p className="text-xs text-gray-500 mb-2">
            {t('qrConfig.common.userCode')} <code className="bg-gray-100 px-1 rounded">{userCode}</code>
          </p>
          <p className="text-xs text-gray-400">
            {t('qrConfig.common.timeRemaining')} {formatTime(countdown)}
          </p>
          <div className="flex items-center mt-2 text-xs text-blue-500">
            <Loader2 className="w-3 h-3 animate-spin mr-1" />
            {t('qrConfig.common.waiting')}
          </div>
        </div>
      )}

      {/* Success state */}
      {status === 'success' && (
        <div className="flex flex-col items-center py-6">
          <CheckCircle2 className="w-12 h-12 text-green-500 mb-3" />
          <p className="text-sm font-medium text-green-700">{t('qrConfig.common.success')}</p>
          <p className="text-xs text-gray-500 mt-1">{t('qrConfig.dingtalk.successHint')}</p>
        </div>
      )}

      {/* Expired state */}
      {status === 'expired' && (
        <div className="flex flex-col items-center py-6">
          <XCircle className="w-10 h-10 text-orange-400 mb-3" />
          <p className="text-sm text-gray-700 mb-3">{t('qrConfig.common.expired')}</p>
          <button
            type="button"
            onClick={handleRetry}
            className="btn-secondary flex items-center space-x-1 text-sm"
          >
            <RefreshCw className="w-4 h-4" />
            <span>{t('qrConfig.common.regenerate')}</span>
          </button>
        </div>
      )}

      {/* Error state */}
      {status === 'error' && (
        <div className="flex flex-col items-center py-6">
          <XCircle className="w-10 h-10 text-red-400 mb-3" />
          <p className="text-sm text-red-600 mb-1">{t('qrConfig.common.errorTitle')}</p>
          <p className="text-xs text-gray-500 mb-3">{errorMsg}</p>
          <button
            type="button"
            onClick={handleRetry}
            className="btn-secondary flex items-center space-x-1 text-sm"
          >
            <RefreshCw className="w-4 h-4" />
            <span>{t('qrConfig.common.retry')}</span>
          </button>
        </div>
      )}

      {/* Cancel button */}
      {(status === 'scanning' || status === 'loading') && onCancel && (
        <div className="flex justify-center mt-4">
          <button
            type="button"
            onClick={() => {
              abortRef.current = true
              onCancel()
            }}
            className="text-sm text-gray-500 hover:text-gray-700 underline"
          >
            {t('qrConfig.common.cancelManual')}
          </button>
        </div>
      )}
    </div>
  )
}
