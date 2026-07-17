import React, { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { apiUrl } from '../lib/api'

interface InstanceData {
  id: string
  name: string
}

type ApiResult = { success?: boolean; error?: string }

function useAccessToken() {
  const { session } = useAuth()
  const accessTokenRef = useRef<string | null>(session?.access_token ?? null)
  useEffect(() => {
    accessTokenRef.current = session?.access_token ?? null
  }, [session?.access_token])
  return accessTokenRef
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}

async function parseApiError<T extends ApiResult = ApiResult>(response: Response, fallback: string): Promise<T> {
  let data: T | null = null
  try {
    data = await response.json() as T
  } catch {
    // ignore non-json error responses
  }
  if (!response.ok || data?.success === false) {
    throw new Error(data?.error || fallback)
  }
  return data
}

export default function InstanceBackupStartPage() {
  const { id = '' } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const accessTokenRef = useAccessToken()
  const [instance, setInstance] = useState<InstanceData | null>(null)
  const [loading, setLoading] = useState(true)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const basePath = location.pathname.startsWith('/admin') ? '/admin' : '/user'

  useEffect(() => {
    const token = accessTokenRef.current
    if (!token || !id) return
    setLoading(true)
    fetch(`${apiUrl}/api/instances/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${token}` }
    })
      .then(response => parseApiError<{ instance?: InstanceData }>(response, '实例信息加载失败'))
      .then(data => setInstance(data.instance || null))
      .catch(error => toast.error(getErrorMessage(error, '实例信息加载失败')))
      .finally(() => setLoading(false))
  }, [accessTokenRef, id])

  const submit = async () => {
    const token = accessTokenRef.current
    if (!token || !instance || submitting) return
    setSubmitting(true)
    try {
      const response = await fetch(`${apiUrl}/api/instances/${encodeURIComponent(instance.id)}/backups`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({})
      })
      await parseApiError(response, '发起备份失败')
      toast.success('备份已发起')
      navigate(`${basePath}/instances/${instance.id}`)
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, '发起备份失败'))
    } finally {
      setSubmitting(false)
      setConfirmOpen(false)
    }
  }

  return (
    <div className="space-y-6">
      <button type="button" onClick={() => navigate(`${basePath}/instances/${id}`)} className="inline-flex items-center text-sm text-gray-600 hover:text-gray-900">
        <ArrowLeft className="mr-1 h-4 w-4" />
        返回实例详情
      </button>

      <div className="card overflow-hidden p-0">
        <div className="flex items-center justify-between gap-4 border-b border-gray-200 px-6 py-5">
          <div>
            <h1 className="text-xl font-semibold text-gray-900">发起备份</h1>
            <p className="mt-1 text-sm text-gray-500">该备份仅作用于当前实例，完成后可在实例详情中恢复。</p>
          </div>
          <button type="button" onClick={() => setConfirmOpen(true)} disabled={loading || !instance} className="btn-primary">
            发起备份
          </button>
        </div>
        {loading ? (
          <div className="flex items-center justify-center py-12 text-gray-500">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" />
            加载中...
          </div>
        ) : (
          <div className="space-y-4 px-6 py-5">
            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-lg border border-gray-200 px-4 py-3">
                <div className="text-xs text-gray-500">实例</div>
                <div className="mt-2 font-medium text-gray-900">{instance?.name || '-'}</div>
              </div>
              <div className="rounded-lg border border-gray-200 px-4 py-3">
                <div className="text-xs text-gray-500">备份方式</div>
                <div className="mt-2 font-medium text-gray-900">立即执行</div>
              </div>
              <div className="rounded-lg border border-gray-200 px-4 py-3">
                <div className="text-xs text-gray-500">备份范围</div>
                <div className="mt-2 font-medium text-gray-900">当前实例</div>
              </div>
            </div>
            <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
              备份过程中会短暂占用当前实例；如果实例正在备份或恢复，本次请求会被拒绝。
            </div>
          </div>
        )}
      </div>

      {confirmOpen && instance && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-2xl rounded-lg bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-gray-200 px-5 py-4">
              <div>
                <h3 className="text-lg font-semibold text-gray-900">确认发起备份</h3>
                <p className="mt-1 text-sm text-gray-500">确认后才会向后端发起当前实例的备份请求。</p>
              </div>
              <button type="button" onClick={() => setConfirmOpen(false)} className="btn-secondary">关闭</button>
            </div>
            <div className="grid gap-3 px-5 py-5 md:grid-cols-3">
              <div className="rounded-lg border border-gray-200 px-4 py-3">
                <div className="text-xs text-gray-500">实例</div>
                <div className="mt-2 font-medium text-gray-900">{instance.name}</div>
              </div>
              <div className="rounded-lg border border-gray-200 px-4 py-3">
                <div className="text-xs text-gray-500">备份方式</div>
                <div className="mt-2 font-medium text-gray-900">立即执行</div>
              </div>
              <div className="rounded-lg border border-gray-200 px-4 py-3">
                <div className="text-xs text-gray-500">备份范围</div>
                <div className="mt-2 font-medium text-gray-900">当前实例</div>
              </div>
            </div>
            <div className="mx-5 rounded-lg border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-900">
              发起前确认：备份过程中会短暂占用当前实例；备份完成后会出现在实例详情的可恢复记录中。
            </div>
            <div className="flex items-center justify-end gap-3 px-5 py-5">
              <button type="button" onClick={() => setConfirmOpen(false)} className="btn-secondary">取消</button>
              <button type="button" onClick={submit} disabled={submitting} className="btn-primary inline-flex items-center gap-2 disabled:opacity-50">
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                确认发起
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
