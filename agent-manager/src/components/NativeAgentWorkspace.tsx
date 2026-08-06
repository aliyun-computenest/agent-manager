/**
 * Agent 原生工作台页面。
 * 创建短期预览会话并通过 iframe 展示完整原生界面，
 * 同时提供返回、刷新、加载和错误状态。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Loader2, RefreshCw, TriangleAlert } from 'lucide-react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../contexts/AuthContext'
import { apiUrl } from '../lib/api'

interface NativeUiInstance {
  id: string
  name: string
}

interface InstanceResponse {
  success?: boolean
  error?: string
  instance?: NativeUiInstance
}

interface PreviewSessionResponse {
  success?: boolean
  error?: string
  previewUrl?: string
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}

function previewKeyFromUrl(value: string) {
  try {
    return new URL(value, window.location.href).pathname
      .match(/\/_preview\/([A-Za-z0-9_-]{24})(?:\/|$)/)?.[1] || ''
  } catch {
    return ''
  }
}

export default function NativeAgentWorkspace() {
  const { id = '' } = useParams<{ id: string }>()
  const location = useLocation()
  const navigate = useNavigate()
  const { session } = useAuth()
  const { t } = useTranslation('admin')
  const accessTokenRef = useRef<string | null>(session?.access_token ?? null)
  const previewTokenRef = useRef<string | null>(null)
  const [instance, setInstance] = useState<NativeUiInstance | null>(null)
  const [previewUrl, setPreviewUrl] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [iframeKey, setIframeKey] = useState(0)
  // 管理员和普通用户共用工作区，只保留各自详情页的返回路径。
  const basePath = location.pathname.startsWith('/admin') ? '/admin' : '/user'

  // 回调中读取 ref，避免 OAuth token 更新时重建整条加载流程。
  useEffect(() => {
    accessTokenRef.current = session?.access_token ?? null
  }, [session?.access_token])

  const loadInstance = useCallback(async (signal?: AbortSignal) => {
    const token = accessTokenRef.current
    if (!token || !id) {
      setError(t('openClawDetail.nativeUi.notLoggedIn'))
      setLoading(false)
      return
    }

    setLoading(true)
    setError('')
    try {
      // 第一次请求只读取实例展示信息，不让普通 GET 接口产生预览副作用。
      const response = await fetch(`${apiUrl}/api/instances/${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal,
      })
      const data = await response.json() as InstanceResponse
      if (!response.ok || data.success === false || !data.instance) {
        throw new Error(data.error || t('openClawDetail.nativeUi.loadFailed'))
      }
      // iframe 和 WebSocket 不能携带页面现有的 Authorization header，
      // 因此用 POST 建立短期 Cookie，并取得当前标签页独有的预览地址。
      const sessionResponse = await fetch(
        `${apiUrl}/api/instances/${encodeURIComponent(id)}/preview-session`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          credentials: 'include',
          signal,
        },
      )
      let sessionData: PreviewSessionResponse = {}
      try {
        sessionData = await sessionResponse.json() as PreviewSessionResponse
      } catch {
        // A plain error body is intentionally not shown to avoid leaking proxy details.
      }
      if (!sessionResponse.ok || sessionData.success === false || !sessionData.previewUrl) {
        throw new Error(sessionData.error || t('openClawDetail.nativeUi.loadFailed'))
      }
      setInstance(data.instance)
      previewTokenRef.current = token
      setPreviewUrl(sessionData.previewUrl)
      // 同一实例点击刷新时强制重建 iframe，确保 Agent 自身状态完整重新加载。
      setIframeKey(current => current + 1)
    } catch (loadError: unknown) {
      if (loadError instanceof DOMException && loadError.name === 'AbortError') return
      setInstance(null)
      setPreviewUrl('')
      setError(errorMessage(loadError, t('openClawDetail.nativeUi.loadFailed')))
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [id, t])

  useEffect(() => {
    const controller = new AbortController()
    void loadInstance(controller.signal)
    return () => controller.abort()
  }, [loadInstance])

  useEffect(() => {
    const token = session?.access_token
    const previewKey = previewKeyFromUrl(previewUrl)
    if (!token || !previewKey || !previewTokenRef.current || previewTokenRef.current === token) return

    const controller = new AbortController()
    const renewPreviewCookie = async () => {
      try {
        const response = await fetch(
          `${apiUrl}/api/instances/${encodeURIComponent(id)}/preview-session`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            credentials: 'include',
            body: JSON.stringify({ previewKey }),
            signal: controller.signal,
          },
        )
        let data: PreviewSessionResponse = {}
        try {
          data = await response.json() as PreviewSessionResponse
        } catch {
          // 代理错误正文不展示给用户。
        }
        if (!response.ok || data.success === false
            || previewKeyFromUrl(data.previewUrl || '') !== previewKey) {
          throw new Error(data.error || t('openClawDetail.nativeUi.loadFailed'))
        }
        previewTokenRef.current = token
      } catch (renewError: unknown) {
        if (renewError instanceof DOMException && renewError.name === 'AbortError') return
        setPreviewUrl('')
        setError(errorMessage(renewError, t('openClawDetail.nativeUi.loadFailed')))
      }
    }
    void renewPreviewCookie()
    return () => controller.abort()
  }, [id, previewUrl, session?.access_token, t])

  const backToDetail = () => navigate(`${basePath}/instances/${encodeURIComponent(id)}`)

  return (
    <div
      className="flex h-[100dvh] min-h-[32rem] w-full min-w-0 flex-col overflow-hidden bg-slate-950"
      data-testid="native-agent-ui-workspace"
    >
      <header
        className="flex h-12 shrink-0 items-center gap-2 border-b border-white/10 bg-slate-950 px-2 text-white sm:gap-3 sm:px-4"
        data-testid="native-agent-ui-toolbar"
      >
        <button
          type="button"
          onClick={backToDetail}
          data-testid="native-agent-ui-back"
          aria-label={t('openClawDetail.nativeUi.back')}
          title={t('openClawDetail.nativeUi.back')}
          className="inline-flex h-8 shrink-0 items-center gap-2 rounded-md px-2 text-sm text-slate-200 transition-colors hover:bg-white/10 hover:text-white sm:px-3"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          <span className="hidden sm:inline">{t('openClawDetail.nativeUi.back')}</span>
        </button>

        <div className="hidden h-5 w-px shrink-0 bg-white/15 sm:block" aria-hidden="true" />

        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="hidden shrink-0 text-sm font-semibold text-white md:inline">Agent Manager</span>
          <span className="hidden text-slate-500 md:inline" aria-hidden="true">/</span>
          <h1 className="truncate text-sm font-medium text-slate-200">
            {t('openClawDetail.nativeUi.title', { name: instance?.name || '-' })}
          </h1>
        </div>

        <button
          type="button"
          onClick={() => void loadInstance()}
          disabled={!previewUrl || loading}
          data-testid="native-agent-ui-refresh"
          aria-label={t('openClawDetail.nativeUi.refresh')}
          title={t('openClawDetail.nativeUi.refresh')}
          className="inline-flex h-8 shrink-0 items-center justify-center gap-2 rounded-md border border-white/15 px-2 text-sm text-slate-200 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40 sm:px-3"
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          <span className="hidden sm:inline">{t('openClawDetail.nativeUi.refresh')}</span>
        </button>
      </header>

      <main className="flex min-h-0 min-w-0 flex-1 overflow-hidden bg-white">
        {loading ? (
          <div data-testid="native-agent-ui-loading" className="flex flex-1 items-center justify-center text-gray-500">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" />
            {t('openClawDetail.nativeUi.loading')}
          </div>
        ) : error ? (
          <div data-testid="native-agent-ui-error" className="flex flex-1 flex-col items-center justify-center px-6 text-center">
            <TriangleAlert className="mb-3 h-8 w-8 text-red-500" />
            <p className="font-medium text-gray-900">{t('openClawDetail.nativeUi.errorTitle')}</p>
            <p className="mt-1 max-w-xl break-words text-sm text-gray-500">{error}</p>
            <button type="button" onClick={() => void loadInstance()} className="btn-secondary mt-4">
              {t('openClawDetail.nativeUi.retry')}
            </button>
          </div>
        ) : !previewUrl ? (
          <div data-testid="native-agent-ui-unavailable" className="flex flex-1 flex-col items-center justify-center px-6 text-center">
            <TriangleAlert className="mb-3 h-8 w-8 text-amber-500" />
            <p className="font-medium text-gray-900">{t('openClawDetail.nativeUi.unavailableTitle')}</p>
            <p className="mt-1 text-sm text-gray-500">{t('openClawDetail.nativeUi.unavailable')}</p>
          </div>
        ) : (
          <iframe
            key={iframeKey}
            src={previewUrl}
            title={t('openClawDetail.nativeUi.iframeTitle', { name: instance.name })}
            data-testid="native-agent-ui-frame"
            className="h-full min-h-0 w-full min-w-0 flex-1 border-0"
            sandbox="allow-downloads allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
            referrerPolicy="no-referrer"
            allow="clipboard-read; clipboard-write; fullscreen; microphone"
          />
        )}
      </main>
    </div>
  )
}
