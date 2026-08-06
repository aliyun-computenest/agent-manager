import { useState, useEffect, useRef, useCallback } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { Loader2, CheckCircle2, XCircle, QrCode, RefreshCw } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { apiUrl } from '../lib/api'

interface WecomQRConfigProps {
  /** Instance ID to bind the credentials to (optional - if not provided, credentials returned via callback) */
  instanceId?: string
  /** Called when authorization succeeds with the obtained credentials */
  onSuccess: (credentials: { clientId: string; clientSecret?: string }) => void
  /** Called when the user cancels or closes the QR flow */
  onCancel?: () => void
}

type FlowStatus = 'idle' | 'loading' | 'scanning' | 'success' | 'expired' | 'error'

export default function WecomQRConfig({ instanceId, onSuccess, onCancel }: WecomQRConfigProps) {
  const { session } = useAuth()
  const [status, setStatus] = useState<FlowStatus>('idle')
  const [authUrl, setAuthUrl] = useState('')
  const [qcId, setQcId] = useState('')
  const [interval] = useState(3)
  const [errorMsg, setErrorMsg] = useState('')
  const [countdown, setCountdown] = useState(0)
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const abortRef = useRef(false)

  // Start the WeCom QR code generation flow
  const startFlow = useCallback(async () => {
    if (!session?.access_token) return

    setStatus('loading')
    setErrorMsg('')
    abortRef.current = false

    try {
      const res = await fetch(`${apiUrl}/api/channel-auto-config/wecom/begin`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`
        }
      })

      const data = await res.json()

      if (!data.success) {
        throw new Error(data.error || '启动企业微信授权失败')
      }

      setAuthUrl(data.authUrl)
      setQcId(data.qcId)
      setCountdown(data.expiresIn || 300)
      setStatus('scanning')
    } catch (err: any) {
      setStatus('error')
      setErrorMsg(err.message || '启动企业微信授权失败')
    }
  }, [session?.access_token])

  // Poll for authorization result
  const pollStatus = useCallback(async () => {
    if (!session?.access_token || !qcId || abortRef.current) return

    try {
      const res = await fetch(`${apiUrl}/api/channel-auto-config/wecom/poll`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`
        },
        body: JSON.stringify({ qcId, instanceId })
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

      if (data.status === 'ERROR') {
        setStatus('error')
        setErrorMsg(data.errmsg || '授权失败')
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
  }, [session?.access_token, qcId, instanceId, interval, onSuccess])

  // Start polling when we enter 'scanning' state
  useEffect(() => {
    if (status === 'scanning' && qcId) {
      // Start first poll after one interval
      pollTimerRef.current = setTimeout(pollStatus, interval * 1000)
    }

    return () => {
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current)
        pollTimerRef.current = null
      }
    }
  }, [status, qcId, pollStatus, interval])

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
    <div className="border border-green-200 rounded-lg p-6 bg-green-50/50">
      <div className="flex items-center space-x-2 mb-4">
        <QrCode className="w-5 h-5 text-green-600" />
        <h4 className="font-medium text-gray-900">企业微信扫码授权配置</h4>
      </div>

      {/* Loading state */}
      {status === 'loading' && (
        <div className="flex flex-col items-center py-8">
          <Loader2 className="w-8 h-8 text-green-500 animate-spin mb-3" />
          <p className="text-sm text-gray-600">正在生成授权二维码...</p>
        </div>
      )}

      {/* QR Code display – scanning state */}
      {status === 'scanning' && authUrl && (
        <div className="flex flex-col items-center">
          <div className="bg-white p-4 rounded-lg shadow-sm border border-gray-200 mb-4">
            <QRCodeSVG
              value={authUrl}
              size={200}
              level="M"
              includeMargin
            />
          </div>
          <p className="text-sm text-gray-700 mb-1">
            请使用<span className="font-semibold text-green-600">企业微信 App</span> 扫描上方二维码
          </p>
          <p className="text-xs text-gray-400 mt-1">
            剩余有效时间: {formatTime(countdown)}
          </p>
          <div className="flex items-center mt-2 text-xs text-green-500">
            <Loader2 className="w-3 h-3 animate-spin mr-1" />
            等待扫码授权...
          </div>
        </div>
      )}

      {/* Success state */}
      {status === 'success' && (
        <div className="flex flex-col items-center py-6">
          <CheckCircle2 className="w-12 h-12 text-green-500 mb-3" />
          <p className="text-sm font-medium text-green-700">授权成功！</p>
          <p className="text-xs text-gray-500 mt-1">企业微信渠道凭证已自动配置</p>
        </div>
      )}

      {/* Expired state */}
      {status === 'expired' && (
        <div className="flex flex-col items-center py-6">
          <XCircle className="w-10 h-10 text-orange-400 mb-3" />
          <p className="text-sm text-gray-700 mb-3">二维码已过期</p>
          <button
            type="button"
            onClick={handleRetry}
            className="btn-secondary flex items-center space-x-1 text-sm"
          >
            <RefreshCw className="w-4 h-4" />
            <span>重新生成</span>
          </button>
        </div>
      )}

      {/* Error state */}
      {status === 'error' && (
        <div className="flex flex-col items-center py-6">
          <XCircle className="w-10 h-10 text-red-400 mb-3" />
          <p className="text-sm text-red-600 mb-1">授权流程出错</p>
          <p className="text-xs text-gray-500 mb-3">{errorMsg}</p>
          <button
            type="button"
            onClick={handleRetry}
            className="btn-secondary flex items-center space-x-1 text-sm"
          >
            <RefreshCw className="w-4 h-4" />
            <span>重试</span>
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
            取消，改为手动填写
          </button>
        </div>
      )}
    </div>
  )
}
