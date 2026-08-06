import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import {
  ArrowLeft,
  ArchiveRestore,
  ChevronRight,
  ClipboardCopy,
  Clock,
  ExternalLink,
  Loader2,
  Search,
  ShieldAlert,
  X
} from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { apiUrl } from '../lib/api'

type BackupRunMode = 'immediate' | 'scheduled'
type BackupExecutionFilter = 'all' | BackupRunMode
type BackupExecutionStatus = 'Running' | 'Success' | 'Failed' | 'PartialFailed' | 'Cancelled'
type ApiResult = { success?: boolean; error?: string }

const OOS_CRON_HELP_URL = 'https://help.aliyun.com/zh/oos/use-cases/configure-cron-expressions?spm=5176.202021321.console-base_help.dexternal.27713daac95lb2'
const NEARBY_CRON_WINDOW_MINUTES = 10
const NEARBY_CRON_WINDOW_MS = NEARBY_CRON_WINDOW_MINUTES * 60 * 1000
const CRON_CONFLICT_PREVIEW_COUNT = 6

interface BackupExecution {
  executionId: string
  oosRegionId?: string | null
  runMode: BackupRunMode
  scope: string
  cronExpression: string | null
  retentionCount: number
  status: BackupExecutionStatus
  nextRunAt: string | null
  startedAt: string | null
  message: string | null
}

interface BackupExecutionRecord {
  status: BackupExecutionStatus
  startedAt: string | null
  message: string
}

interface InstanceOption {
  id: string
  name: string
  status: string
  group?: { id: string; name: string } | null
  agent_type?: { id: string; code: string; name: string } | null
}

const statusText: Record<BackupExecutionStatus, string> = {
  Running: '运行中',
  Success: '成功',
  Failed: '异常',
  PartialFailed: '部分失败',
  Cancelled: '已取消'
}

const runModeText: Record<BackupRunMode, string> = {
  immediate: '立即执行',
  scheduled: '周期性重复执行'
}

function formatDateTime(value: string | null) {
  if (!value) return '-'
  try {
    return new Date(value).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    })
  } catch {
    return value
  }
}

function formatCronPreviewDate(value: Date) {
  return value.toLocaleString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })
}

function parseCronField(value: string, min: number, max: number, allowQuestion = false) {
  const trimmed = value.trim().toUpperCase()
  if (trimmed === '?' && allowQuestion) return null
  const values = new Set<number>()
  const addRange = (start: number, end: number, step = 1) => {
    if (!Number.isInteger(start) || !Number.isInteger(end) || !Number.isInteger(step) || step <= 0) return false
    if (start < min || end > max || start > end) return false
    for (let item = start; item <= end; item += step) values.add(item)
    return true
  }

  for (const part of trimmed.split(',')) {
    if (!part) return undefined
    const [rangePart, stepPart] = part.split('/')
    if (part.split('/').length > 2) return undefined
    const step = stepPart ? Number(stepPart) : 1
    if (rangePart === '*') {
      if (!addRange(min, max, step)) return undefined
      continue
    }
    const range = rangePart.split('-')
    if (range.length === 2) {
      if (!addRange(Number(range[0]), Number(range[1]), step)) return undefined
      continue
    }
    if (range.length === 1 && stepPart) {
      if (!addRange(Number(rangePart), max, step)) return undefined
      continue
    }
    const numberValue = Number(rangePart)
    if (!addRange(numberValue, numberValue, 1)) return undefined
  }

  return values
}

function cronFieldMatches(values: Set<number> | null, value: number) {
  return values === null || values.has(value)
}

function getCronSchedulePreviewDates(
  cronExpression: string,
  baseDate: Date = new Date(),
  count = 5
) {
  const expression = cronExpression.trim()
  const match = expression.match(/^cron\((.*)\)$/i)
  const fields = (match ? match[1] : expression).trim().split(/\s+/)
  if (fields.length !== 6 && fields.length !== 7) {
    return { items: [], message: 'Cron 表达式需要包含秒、分、时、日、月、周字段。' }
  }

  const [secondField, minuteField, hourField, dayField, monthField, weekField, yearField = '*'] = fields
  const seconds = parseCronField(secondField, 0, 59)
  const minutes = parseCronField(minuteField, 0, 59)
  const hours = parseCronField(hourField, 0, 23)
  const days = parseCronField(dayField, 1, 31, true)
  const months = parseCronField(monthField, 1, 12)
  const weeks = parseCronField(weekField, 1, 7, true)
  const years = parseCronField(yearField, baseDate.getFullYear(), baseDate.getFullYear() + 10)
  if (!seconds || !minutes || !hours || days === undefined || !months || weeks === undefined || !years) {
    return { items: [], message: '当前表达式包含复杂字符，请参考 OOS 文档确认执行计划。' }
  }

  const sortedSeconds = [...seconds].sort((a, b) => a - b)
  const preview: Date[] = []
  const cursor = new Date(baseDate)
  cursor.setMilliseconds(0)
  cursor.setSeconds(0)
  const deadline = new Date(baseDate)
  deadline.setFullYear(deadline.getFullYear() + 1)

  while (cursor <= deadline && preview.length < count) {
    const year = cursor.getFullYear()
    const month = cursor.getMonth() + 1
    const day = cursor.getDate()
    const week = cursor.getDay() + 1
    const hour = cursor.getHours()
    const minute = cursor.getMinutes()

    if (
      years.has(year)
      && months.has(month)
      && cronFieldMatches(days, day)
      && cronFieldMatches(weeks, week)
      && hours.has(hour)
      && minutes.has(minute)
    ) {
      for (const second of sortedSeconds) {
        const candidate = new Date(cursor)
        candidate.setSeconds(second)
        if (candidate > baseDate) preview.push(candidate)
        if (preview.length >= count) break
      }
    }
    cursor.setMinutes(cursor.getMinutes() + 1)
  }

  if (preview.length === 0) {
    return { items: [], message: '未来一年内没有匹配的执行时间，请检查 Cron 表达式。' }
  }
  return { items: preview, message: null }
}

export function getCronSchedulePreview(
  cronExpression: string,
  baseDate: Date = new Date(),
  count = 5
) {
  const preview = getCronSchedulePreviewDates(cronExpression, baseDate, count)
  return {
    items: preview.items.map(formatCronPreviewDate),
    message: preview.message
  }
}

type BackupExecutionConflictCandidate = Pick<BackupExecution, 'executionId' | 'runMode' | 'scope' | 'cronExpression' | 'status'>

function parseExecutionScope(scope: string) {
  if (scope === 'all') return { type: 'all' as const, instanceIds: new Set<string>() }
  if (!scope.startsWith('instances:')) return { type: 'unknown' as const, instanceIds: new Set<string>() }
  return {
    type: 'instances' as const,
    instanceIds: new Set(scope.slice('instances:'.length).split(',').map(item => item.trim()).filter(Boolean))
  }
}

function scopesOverlap(a: string, b: string) {
  const left = parseExecutionScope(a)
  const right = parseExecutionScope(b)
  if (left.type === 'unknown' || right.type === 'unknown') return left.type === right.type && a === b
  if (left.type === 'all' || right.type === 'all') return true
  for (const id of left.instanceIds) {
    if (right.instanceIds.has(id)) return true
  }
  return false
}

function buildRequestedScope(scopeType: 'all' | 'instances', selectedIds: string[]) {
  if (scopeType === 'all') return 'all'
  return `instances:${[...new Set(selectedIds)].join(',')}`
}

export function findNearbyScheduledCronConflict(
  executions: BackupExecutionConflictCandidate[],
  {
    cronExpression,
    scope,
    baseDate = new Date(),
    windowMs = NEARBY_CRON_WINDOW_MS
  }: {
    cronExpression: string
    scope: string
    baseDate?: Date
    windowMs?: number
  }
) {
  const currentPreview = getCronSchedulePreviewDates(cronExpression, baseDate, CRON_CONFLICT_PREVIEW_COUNT)
  if (currentPreview.message || currentPreview.items.length === 0) return null

  let best: {
    execution: BackupExecutionConflictCandidate
    deltaMs: number
    currentTime: Date
    existingTime: Date
  } | null = null

  for (const execution of executions) {
    if (execution.runMode !== 'scheduled' || execution.status !== 'Running' || !execution.cronExpression) continue
    if (!scopesOverlap(scope, execution.scope)) continue

    const existingPreview = getCronSchedulePreviewDates(
      execution.cronExpression,
      baseDate,
      CRON_CONFLICT_PREVIEW_COUNT
    )
    if (existingPreview.message || existingPreview.items.length === 0) continue

    for (const currentTime of currentPreview.items) {
      for (const existingTime of existingPreview.items) {
        const deltaMs = Math.abs(currentTime.getTime() - existingTime.getTime())
        if (deltaMs > windowMs) continue
        if (!best || deltaMs < best.deltaMs) {
          best = { execution, deltaMs, currentTime, existingTime }
        }
      }
    }
  }

  if (!best) return null
  return {
    execution: best.execution,
    deltaMinutes: Math.round(best.deltaMs / 60000),
    currentTime: formatCronPreviewDate(best.currentTime),
    existingTime: formatCronPreviewDate(best.existingTime)
  }
}

function statusBadgeClass(status: BackupExecutionStatus) {
  if (status === 'Success') return 'bg-green-100 text-green-700'
  if (status === 'Running') return 'bg-blue-100 text-blue-700'
  if (status === 'PartialFailed') return 'bg-yellow-100 text-yellow-800'
  if (status === 'Cancelled') return 'bg-gray-100 text-gray-600'
  return 'bg-red-100 text-red-700'
}

function StatusBadge({ status }: { status: BackupExecutionStatus }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(status)}`}>
      {statusText[status]}
    </span>
  )
}

function runModeBadgeClass(runMode: BackupRunMode) {
  return runMode === 'scheduled'
    ? 'bg-violet-50 text-violet-700 ring-violet-200'
    : 'bg-sky-50 text-sky-700 ring-sky-200'
}

function RunModeBadge({ runMode }: { runMode: BackupRunMode }) {
  const Icon = runMode === 'scheduled' ? Clock : ArchiveRestore
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${runModeBadgeClass(runMode)}`}>
      <Icon className="h-3.5 w-3.5" />
      {runModeText[runMode]}
    </span>
  )
}

function scopeLabel(scope: string) {
  if (scope === 'all') return '全部实例'
  if (scope.startsWith('instances:')) {
    const count = scope.slice('instances:'.length).split(',').filter(Boolean).length
    return `部分实例 · ${count} 个`
  }
  return scope
}

function planLabel(execution: Pick<BackupExecution, 'runMode' | 'cronExpression'>) {
  return execution.runMode === 'scheduled' ? (execution.cronExpression || '-') : '立即触发'
}

function getRuntimeEnv(key: string) {
  const windowEnv = (window as unknown as { __ENV__?: Record<string, string | undefined> }).__ENV__
  return windowEnv?.[key] || (import.meta.env as Record<string, string | undefined>)[key] || ''
}

function buildOosConsoleUrl(executionId: string, oosRegionId?: string | null) {
  const base = (getRuntimeEnv('VITE_OOS_CONSOLE_BASE_URL') || 'https://oos.console.aliyun.com').replace(/\/$/, '')
  const regionId = oosRegionId || getRuntimeEnv('VITE_OOS_REGION_ID') || 'cn-hangzhou'
  return `${base}/${regionId}/execution/detail/${encodeURIComponent(executionId)}`
}

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
    // ignore
  }
  if (!response.ok || data?.success === false) {
    throw new Error(data?.error || fallback)
  }
  return data
}

export function BackupExecutionsPage() {
  const navigate = useNavigate()
  const accessTokenRef = useAccessToken()
  const [items, setItems] = useState<BackupExecution[]>([])
  const [filter, setFilter] = useState<BackupExecutionFilter>('all')
  const [loading, setLoading] = useState(true)

  const loadExecutions = useCallback(async () => {
    const token = accessTokenRef.current
    if (!token) return
    setLoading(true)
    try {
      const response = await fetch(`${apiUrl}/api/admin/backups/executions?limit=50`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      const data = await parseApiError<{ items?: BackupExecution[] }>(response, '备份执行加载失败')
      setItems(data.items || [])
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, '备份执行加载失败'))
    } finally {
      setLoading(false)
    }
  }, [accessTokenRef])

  useEffect(() => {
    void loadExecutions()
  }, [loadExecutions])

  const filteredItems = useMemo(
    () => filter === 'all' ? items : items.filter(item => item.runMode === filter),
    [filter, items]
  )
  const filterOptions = useMemo(() => [
    { value: 'all' as const, label: '全部', count: items.length },
    { value: 'immediate' as const, label: '立即执行', count: items.filter(item => item.runMode === 'immediate').length },
    { value: 'scheduled' as const, label: '周期执行', count: items.filter(item => item.runMode === 'scheduled').length }
  ], [items])
  const activeFilterLabel = filterOptions.find(option => option.value === filter)?.label || '备份'

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">实例备份</h1>
          <p className="mt-1 text-sm text-gray-500">管理员创建平台备份执行；普通用户在实例详情发起当前实例备份。</p>
        </div>
        <button
          type="button"
          onClick={() => navigate('/admin/backups/create')}
          className="btn-primary inline-flex items-center gap-2"
        >
          <ArchiveRestore className="h-4 w-4" />
          <span>创建备份执行</span>
        </button>
      </div>

      <div className="card overflow-hidden p-0">
        <div className="flex flex-col gap-4 border-b border-gray-200 px-6 py-5 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">备份执行</h2>
            <p className="mt-1 text-sm text-gray-500">按执行类型拆分查看；点击查看进入执行详情。</p>
          </div>
          <div className="inline-flex w-full rounded-lg border border-gray-200 bg-gray-50 p-1 sm:w-auto" role="tablist" aria-label="备份执行类型">
            {filterOptions.map(option => (
              <button
                key={option.value}
                type="button"
                role="tab"
                aria-selected={filter === option.value}
                onClick={() => setFilter(option.value)}
                className={`flex min-w-0 flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition sm:flex-none ${
                  filter === option.value
                    ? 'bg-white text-primary-700 shadow-sm ring-1 ring-gray-200'
                    : 'text-gray-600 hover:bg-white/70 hover:text-gray-900'
                }`}
              >
                <span className="truncate">{option.label}</span>
                <span className={`rounded-full px-2 py-0.5 text-xs ${filter === option.value ? 'bg-primary-50 text-primary-700' : 'bg-white text-gray-500'}`}>
                  {option.count}
                </span>
              </button>
            ))}
          </div>
        </div>
        {loading ? (
          <div className="flex items-center justify-center py-12 text-gray-500">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" />
            加载中...
          </div>
        ) : items.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <ArchiveRestore className="mx-auto mb-3 h-10 w-10 text-gray-300" />
            <p className="text-sm text-gray-500">暂无备份执行</p>
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <ArchiveRestore className="mx-auto mb-3 h-10 w-10 text-gray-300" />
            <p className="text-sm text-gray-500">暂无{activeFilterLabel}备份执行</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-5 py-3 text-left font-medium text-gray-600">执行类型</th>
                  <th className="px-5 py-3 text-left font-medium text-gray-600">实例范围</th>
                  <th className="px-5 py-3 text-left font-medium text-gray-600">计划</th>
                  <th className="px-5 py-3 text-left font-medium text-gray-600">最多保留</th>
                  <th className="px-5 py-3 text-left font-medium text-gray-600">健康状态</th>
                  <th className="px-5 py-3 text-left font-medium text-gray-600">最近结果</th>
                  <th className="px-5 py-3 text-left font-medium text-gray-600">下次执行</th>
                  <th className="px-5 py-3 text-right font-medium text-gray-600">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 bg-white">
                {filteredItems.map(item => (
                  <tr key={item.executionId} className="hover:bg-gray-50">
                    <td className="px-5 py-4">
                      <RunModeBadge runMode={item.runMode} />
                      <div className="mt-2 max-w-[260px] truncate font-mono text-xs text-gray-400" title={item.executionId}>
                        {item.executionId}
                      </div>
                    </td>
                    <td className="px-5 py-4">
                      <button
                        type="button"
                        onClick={() => navigate(`/admin/backups/${item.executionId}`)}
                        className="text-left font-medium text-primary-600 hover:text-primary-700"
                      >
                        {scopeLabel(item.scope)}
                      </button>
                    </td>
                    <td className="px-5 py-4 font-mono text-xs text-gray-700">{planLabel(item)}</td>
                    <td className="px-5 py-4 text-gray-700">{item.retentionCount} 个</td>
                    <td className="px-5 py-4"><StatusBadge status={item.status} /></td>
                    <td className="max-w-[320px] truncate px-5 py-4 text-gray-700" title={item.message || ''}>{item.message || '-'}</td>
                    <td className="px-5 py-4 text-gray-700">{formatDateTime(item.nextRunAt)}</td>
                    <td className="px-5 py-4 text-right">
                      <button
                        type="button"
                        onClick={() => navigate(`/admin/backups/${item.executionId}`)}
                        className="btn-secondary inline-flex items-center gap-1"
                      >
                        查看
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

function InstanceSelectModal({
  open,
  instances,
  selectedIds,
  onClose,
  onChange
}: {
  open: boolean
  instances: InstanceOption[]
  selectedIds: string[]
  onClose: () => void
  onChange: (ids: string[]) => void
}) {
  const [search, setSearch] = useState('')
  const [agentType, setAgentType] = useState('')
  const [group, setGroup] = useState('')
  const [onlySelected, setOnlySelected] = useState(false)

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])
  const agentTypes = useMemo(() => [...new Set(instances.map(item => item.agent_type?.name || item.agent_type?.code).filter(Boolean))], [instances])
  const groups = useMemo(() => [...new Set(instances.map(item => item.group?.name).filter(Boolean))], [instances])
  const filtered = useMemo(() => instances.filter(item => {
    if (onlySelected && !selectedSet.has(item.id)) return false
    if (search && !`${item.name} ${item.id}`.toLowerCase().includes(search.toLowerCase())) return false
    if (agentType && (item.agent_type?.name || item.agent_type?.code) !== agentType) return false
    if (group && item.group?.name !== group) return false
    return true
  }), [agentType, group, instances, onlySelected, search, selectedSet])

  if (!open) return null

  const toggle = (id: string) => {
    const next = new Set(selectedIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange([...next])
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="flex max-h-[82vh] w-full max-w-4xl flex-col rounded-lg bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-4">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">选择实例</h3>
            <p className="mt-1 text-sm text-gray-500">已选 {selectedIds.length} 个，只展示可发起备份的运行中实例。</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="grid gap-3 border-b border-gray-200 px-5 py-4 md:grid-cols-[1fr_160px_160px_auto_auto]">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
            <input
              value={search}
              onChange={event => setSearch(event.target.value)}
              className="input pl-9"
              placeholder="搜索实例名称或 ID"
            />
          </div>
          <select value={agentType} onChange={event => setAgentType(event.target.value)} className="input">
            <option value="">全部 Agent</option>
            {agentTypes.map(item => <option key={item} value={item}>{item}</option>)}
          </select>
          <select value={group} onChange={event => setGroup(event.target.value)} className="input">
            <option value="">全部分组</option>
            {groups.map(item => <option key={item} value={item}>{item}</option>)}
          </select>
          <button type="button" onClick={() => setOnlySelected(value => !value)} className={onlySelected ? 'btn-primary' : 'btn-secondary'}>
            只看已选
          </button>
          <button type="button" onClick={() => onChange([])} className="btn-secondary">
            清空选择
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="sticky top-0 bg-gray-50">
              <tr>
                <th className="w-12 px-5 py-3 text-left"></th>
                <th className="px-5 py-3 text-left font-medium text-gray-600">实例</th>
                <th className="px-5 py-3 text-left font-medium text-gray-600">Agent</th>
                <th className="px-5 py-3 text-left font-medium text-gray-600">分组</th>
                <th className="px-5 py-3 text-left font-medium text-gray-600">状态</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 bg-white">
              {filtered.map(item => (
                <tr key={item.id} className="hover:bg-gray-50">
                  <td className="px-5 py-3">
                    <input
                      type="checkbox"
                      checked={selectedSet.has(item.id)}
                      onChange={() => toggle(item.id)}
                      className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                    />
                  </td>
                  <td className="px-5 py-3">
                    <div className="font-medium text-gray-900">{item.name}</div>
                    <div className="font-mono text-xs text-gray-400">{item.id}</div>
                  </td>
                  <td className="px-5 py-3 text-gray-700">{item.agent_type?.name || item.agent_type?.code || '-'}</td>
                  <td className="px-5 py-3 text-gray-700">{item.group?.name || '个人实例'}</td>
                  <td className="px-5 py-3 text-gray-700">{item.status === 'running' ? '运行中' : item.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-end gap-3 border-t border-gray-200 px-5 py-4">
          <button type="button" onClick={onClose} className="btn-secondary">取消</button>
          <button type="button" onClick={onClose} className="btn-primary">确认选择</button>
        </div>
      </div>
    </div>
  )
}

export function BackupExecutionCreatePage() {
  const navigate = useNavigate()
  const accessTokenRef = useAccessToken()
  const [runMode, setRunMode] = useState<BackupRunMode>('immediate')
  const [scopeType, setScopeType] = useState<'all' | 'instances'>('all')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [instances, setInstances] = useState<InstanceOption[]>([])
  const [instanceModalOpen, setInstanceModalOpen] = useState(false)
  const [retentionCount, setRetentionCount] = useState(5)
  const [cronSecond, setCronSecond] = useState('0')
  const [cronMinute, setCronMinute] = useState('0')
  const [cronHour, setCronHour] = useState('3')
  const [cronDay, setCronDay] = useState('*')
  const [cronMonth, setCronMonth] = useState('*')
  const [cronWeek, setCronWeek] = useState('?')
  const [cronYear, setCronYear] = useState('*')
  const [submitting, setSubmitting] = useState(false)

  const cronExpression = `cron(${cronSecond} ${cronMinute} ${cronHour} ${cronDay} ${cronMonth} ${cronWeek} ${cronYear})`
  const cronPreview = useMemo(() => getCronSchedulePreview(cronExpression), [cronExpression])
  const selectedInstances = useMemo(() => instances.filter(item => selectedIds.includes(item.id)), [instances, selectedIds])
  const cronFields: Array<{
    label: string
    hint: string
    value: string
    setter: React.Dispatch<React.SetStateAction<string>>
  }> = [
    { label: '秒', hint: '0-59', value: cronSecond, setter: setCronSecond },
    { label: '分', hint: '0-59', value: cronMinute, setter: setCronMinute },
    { label: '时', hint: '0-23', value: cronHour, setter: setCronHour },
    { label: '日', hint: '1-31 或 *', value: cronDay, setter: setCronDay },
    { label: '月', hint: '1-12 或 *', value: cronMonth, setter: setCronMonth },
    { label: '周', hint: '1-7 或 ?', value: cronWeek, setter: setCronWeek },
    { label: '年', hint: '* 或年份', value: cronYear, setter: setCronYear }
  ]

  useEffect(() => {
    const token = accessTokenRef.current
    if (!token) return
    fetch(`${apiUrl}/api/admin/instances?page=1&pageSize=100&status=running`, {
      headers: { Authorization: `Bearer ${token}` }
    })
      .then(response => parseApiError(response, '实例列表加载失败'))
      .then(data => setInstances(data.instances || []))
      .catch(error => toast.error(error.message || '实例列表加载失败'))
  }, [accessTokenRef])

  const submit = async () => {
    const token = accessTokenRef.current
    if (!token || submitting) return
    if (scopeType === 'instances' && selectedIds.length === 0) {
      toast.error('请选择至少一个实例')
      return
    }
    setSubmitting(true)
    try {
      const requestedScope = buildRequestedScope(scopeType, selectedIds)
      if (runMode === 'scheduled') {
        const listResponse = await fetch(`${apiUrl}/api/admin/backups/executions?limit=100`, {
          headers: { Authorization: `Bearer ${token}` }
        })
        const listData = await parseApiError<{ items?: BackupExecution[] }>(listResponse, '备份执行加载失败')
        const conflict = findNearbyScheduledCronConflict(listData.items || [], {
          cronExpression,
          scope: requestedScope
        })
        if (conflict) {
          toast.error(
            `已有相近的周期备份执行：${scopeLabel(conflict.execution.scope)} ${conflict.execution.cronExpression}。两次计划执行时间相差 ${conflict.deltaMinutes} 分钟，请调整 Cron 至少间隔 ${NEARBY_CRON_WINDOW_MINUTES} 分钟。`
          )
          return
        }
      }

      const response = await fetch(`${apiUrl}/api/admin/backups/executions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          runMode,
          scope: requestedScope === 'all'
            ? { type: 'all' }
            : { type: 'instances', instanceIds: selectedIds },
          cronExpression: runMode === 'scheduled' ? cronExpression : undefined,
          retentionCount
        })
      })
      await parseApiError<{ executionId: string }>(response, '创建备份执行失败')
      toast.success('备份执行已创建')
      navigate('/admin/backups')
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, '创建备份执行失败'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-6">
      <button type="button" onClick={() => navigate('/admin/backups')} className="inline-flex items-center text-sm text-gray-600 hover:text-gray-900">
        <ArrowLeft className="mr-1 h-4 w-4" />
        返回备份执行
      </button>

      <div className="card overflow-hidden p-0">
        <div className="border-b border-gray-200 px-6 py-5">
          <h1 className="text-xl font-semibold text-gray-900">创建备份执行</h1>
          <p className="mt-1 text-sm text-gray-500">选择实例范围、执行方式和保留策略。全部实例或周期性重复执行会影响较多实例，请确认后再提交。</p>
        </div>

        <div className="space-y-6 px-6 py-5">
          <section>
            <h2 className="mb-3 text-sm font-semibold text-gray-900">实例范围</h2>
            <div className="grid gap-3 md:grid-cols-2">
              <button
                type="button"
                onClick={() => setScopeType('all')}
                className={`rounded-lg border px-4 py-4 text-left ${scopeType === 'all' ? 'border-primary-500 bg-primary-50' : 'border-gray-200 bg-white'}`}
              >
                <div className="font-medium text-gray-900">全部实例</div>
                <div className="mt-1 text-sm text-gray-500">覆盖平台内全部运行中实例。</div>
              </button>
              <button
                type="button"
                onClick={() => setScopeType('instances')}
                className={`rounded-lg border px-4 py-4 text-left ${scopeType === 'instances' ? 'border-primary-500 bg-primary-50' : 'border-gray-200 bg-white'}`}
              >
                <div className="font-medium text-gray-900">部分实例</div>
                <div className="mt-1 text-sm text-gray-500">选择单个或多个运行中实例。</div>
              </button>
            </div>
            {scopeType === 'instances' && (
              <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-gray-600">已选择 {selectedIds.length} 个实例</span>
                  <button type="button" onClick={() => setInstanceModalOpen(true)} className="btn-secondary">选择实例</button>
                </div>
                {selectedInstances.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {selectedInstances.slice(0, 8).map(item => (
                      <span key={item.id} className="rounded-full bg-white px-3 py-1 text-xs text-gray-700 shadow-sm">{item.name}</span>
                    ))}
                    {selectedInstances.length > 8 && <span className="rounded-full bg-white px-3 py-1 text-xs text-gray-500">还有 {selectedInstances.length - 8} 个</span>}
                  </div>
                )}
              </div>
            )}
          </section>

          <section>
            <h2 className="mb-3 text-sm font-semibold text-gray-900">定时设置</h2>
            <div className="flex flex-wrap gap-4">
              <label className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-4 py-3">
                <input type="radio" checked={runMode === 'immediate'} onChange={() => setRunMode('immediate')} />
                <span>立即执行</span>
              </label>
              <label className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-4 py-3">
                <input type="radio" checked={runMode === 'scheduled'} onChange={() => setRunMode('scheduled')} />
                <span>周期性重复执行</span>
              </label>
            </div>
            {runMode === 'scheduled' && (
              <div className="mt-4 space-y-4 rounded-lg border border-gray-200 bg-white p-4">
                <div className="grid gap-3 md:grid-cols-[180px_1fr]">
                  <label className="block">
                    <span className="mb-1 block text-xs text-gray-500">重复周期</span>
                    <select className="input" value="cron" disabled>
                      <option value="cron">Cron 表达式</option>
                    </select>
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs text-gray-500">时区</span>
                    <input className="input" value="香港 / 北京时间 (UTC+8)" disabled />
                  </label>
                </div>
                <div className="overflow-hidden rounded-lg border border-gray-200 bg-gray-200">
                  <div className="grid gap-px sm:grid-cols-2 lg:grid-cols-7">
                    {cronFields.map(field => (
                      <label key={field.label} className="flex min-w-0 flex-col gap-2 bg-white px-3 py-3">
                        <span className="text-xs font-medium text-gray-700">{field.label}</span>
                        <input
                          value={field.value}
                          onChange={event => field.setter(event.target.value.trim())}
                          className="h-9 w-full rounded-md border border-gray-300 bg-white px-2 text-center font-mono text-sm text-gray-900 shadow-sm outline-none transition focus:border-primary-500 focus:ring-2 focus:ring-primary-100"
                          aria-label={`Cron ${field.label}`}
                        />
                        <span className="truncate text-[11px] leading-4 text-gray-400">{field.hint}</span>
                      </label>
                    ))}
                  </div>
                </div>
                <div className="flex flex-col gap-3 rounded-lg border border-primary-100 bg-primary-50 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-primary-700">Cron 表达式</div>
                    <div className="mt-1 break-all rounded-md bg-white/75 px-2 py-1 font-mono text-sm text-primary-950 ring-1 ring-primary-100">
                      {cronExpression}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <a
                      href={OOS_CRON_HELP_URL}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex h-9 items-center gap-1.5 rounded-md border border-primary-200 bg-white px-3 text-sm font-medium text-primary-700 shadow-sm transition hover:border-primary-300 hover:bg-primary-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
                    >
                      Cron 帮助
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                    <div className="group relative">
                      <button
                        type="button"
                        aria-describedby="cron-schedule-preview"
                        className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary-600 px-3 text-sm font-medium text-white shadow-sm transition hover:bg-primary-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
                      >
                        <Clock className="h-4 w-4" />
                        执行计划预览
                      </button>
                      <div
                        id="cron-schedule-preview"
                        role="tooltip"
                        className="invisible absolute bottom-full right-0 z-30 mb-3 w-[min(22rem,calc(100vw-3rem))] translate-y-1 rounded-lg border border-gray-200 bg-white p-4 text-left opacity-0 shadow-xl shadow-gray-200/70 ring-1 ring-black/5 transition duration-150 group-hover:visible group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:visible group-focus-within:translate-y-0 group-focus-within:opacity-100"
                      >
                        <div className="mb-3">
                          <div className="text-sm font-semibold text-gray-900">执行计划预览</div>
                          <div className="mt-1 break-all font-mono text-xs text-gray-500">{cronExpression}</div>
                        </div>
                        {cronPreview.items.length > 0 ? (
                          <ol className="space-y-3">
                            {cronPreview.items.map(item => (
                              <li key={item} className="flex gap-3 text-sm text-gray-700">
                                <span className="mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full bg-primary-50 text-primary-600">
                                  <Clock className="h-3.5 w-3.5" />
                                </span>
                                <span>{item}</span>
                              </li>
                            ))}
                          </ol>
                        ) : (
                          <div className="rounded-md bg-yellow-50 px-3 py-2 text-sm text-yellow-900">
                            {cronPreview.message}
                          </div>
                        )}
                        <div className="absolute -bottom-1.5 right-8 h-3 w-3 rotate-45 border-b border-r border-gray-200 bg-white" />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </section>

          <section className="grid gap-4 md:grid-cols-[220px_1fr]">
            <label>
              <span className="mb-1 block text-sm font-medium text-gray-700">最多保留</span>
              <input
                type="number"
                min={1}
                max={50}
                value={retentionCount}
                onChange={event => setRetentionCount(Number(event.target.value) || 5)}
                className="input"
              />
            </label>
            <div className="rounded-lg border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-900">
              <ShieldAlert className="mr-2 inline h-4 w-4" />
              提交前请确认范围和频率。系统会按实例维度最多保留 {retentionCount} 个可恢复备份，超出后由底层备份执行清理旧备份。
            </div>
          </section>
        </div>

        <div className="flex justify-end gap-3 border-t border-gray-200 px-6 py-4">
          <button type="button" onClick={() => navigate('/admin/backups')} className="btn-secondary">取消</button>
          <button type="button" onClick={submit} disabled={submitting} className="btn-primary inline-flex items-center gap-2 disabled:opacity-50">
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            创建备份执行
          </button>
        </div>
      </div>

      <InstanceSelectModal
        open={instanceModalOpen}
        instances={instances}
        selectedIds={selectedIds}
        onClose={() => setInstanceModalOpen(false)}
        onChange={setSelectedIds}
      />
    </div>
  )
}

export function BackupExecutionDetailPage() {
  const { executionId = '' } = useParams<{ executionId: string }>()
  const navigate = useNavigate()
  const accessTokenRef = useAccessToken()
  const [execution, setExecution] = useState<BackupExecution | null>(null)
  const [records, setRecords] = useState<BackupExecutionRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [cancelling, setCancelling] = useState(false)
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false)

  const loadDetail = useCallback(async () => {
    const token = accessTokenRef.current
    if (!token || !executionId) return
    setLoading(true)
    try {
      const [executionResponse, recordsResponse] = await Promise.all([
        fetch(`${apiUrl}/api/admin/backups/executions/${encodeURIComponent(executionId)}`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`${apiUrl}/api/admin/backups/executions/${encodeURIComponent(executionId)}/records?limit=50`, { headers: { Authorization: `Bearer ${token}` } })
      ])
      const [executionData, recordsData] = await Promise.all([
        parseApiError<{ item?: BackupExecution }>(executionResponse, '备份执行加载失败'),
        parseApiError<{ items?: BackupExecutionRecord[] }>(recordsResponse, '执行记录加载失败')
      ])
      setExecution(executionData.item || null)
      setRecords(recordsData.items || [])
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, '备份执行加载失败'))
    } finally {
      setLoading(false)
    }
  }, [accessTokenRef, executionId])

  useEffect(() => {
    void loadDetail()
  }, [loadDetail])

  const cancelExecution = async () => {
    const token = accessTokenRef.current
    if (!token || !execution || cancelling) return
    setCancelling(true)
    try {
      const response = await fetch(`${apiUrl}/api/admin/backups/executions/${encodeURIComponent(execution.executionId)}/cancel`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({})
      })
      await parseApiError(response, '取消备份执行失败')
      toast.success('备份执行已取消')
      navigate('/admin/backups')
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, '取消备份执行失败'))
    } finally {
      setCancelling(false)
    }
  }

  const copyErrorMessage = async () => {
    const message = execution?.message || records.find(record => record.status === 'Failed' || record.status === 'PartialFailed')?.message
    if (!message) return
    try {
      await navigator.clipboard.writeText(message)
      toast.success('错误信息已复制')
    } catch {
      toast.error('复制失败')
    }
  }

  return (
    <div className="space-y-6">
      <button type="button" onClick={() => navigate('/admin/backups')} className="inline-flex items-center text-sm text-gray-600 hover:text-gray-900">
        <ArrowLeft className="mr-1 h-4 w-4" />
        返回备份执行
      </button>

      <div className="card overflow-hidden p-0">
        {loading ? (
          <div className="flex items-center justify-center py-12 text-gray-500">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" />
            加载中...
          </div>
        ) : (
          <>
            <div className="flex items-start justify-between gap-4 border-b border-gray-200 px-6 py-5">
              <div>
                <div className="mb-2">{execution && <RunModeBadge runMode={execution.runMode} />}</div>
                <h1 className="text-xl font-semibold text-gray-900">{execution ? scopeLabel(execution.scope) : '备份执行详情'}</h1>
                <p className="mt-1 text-sm text-gray-500">执行配置和运行记录在这里确认；更深排查可查看 OOS 原始详情。</p>
              </div>
              <div className="flex shrink-0 gap-3">
                {execution?.runMode === 'scheduled' && execution.status === 'Running' && (
                  <button type="button" onClick={() => setCancelConfirmOpen(true)} disabled={cancelling} className="btn-secondary border-red-200 text-red-600 hover:bg-red-50">
                    取消备份执行
                  </button>
                )}
                <button type="button" onClick={() => window.open(buildOosConsoleUrl(executionId, execution?.oosRegionId), '_blank', 'noopener,noreferrer')} className="btn-primary">
                  查看详情
                </button>
              </div>
            </div>

            {execution && (
              <div className="space-y-4 px-6 py-5">
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary-200 bg-primary-50 px-4 py-3 text-sm text-primary-900">
                  <RunModeBadge runMode={execution.runMode} />
                  <span>范围：{scopeLabel(execution.scope)}</span>
                  <span>计划：{planLabel(execution)}</span>
                  <span>最多保留 {execution.retentionCount} 个</span>
                  <span>下次执行 {formatDateTime(execution.nextRunAt)}</span>
                  <StatusBadge status={execution.status} />
                </div>
                {(execution.status === 'Failed' || execution.status === 'PartialFailed') && (
                  <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3">
                    <div className="text-sm font-semibold text-red-900">异常处理</div>
                    <p className="mt-1 text-sm text-red-800">{execution.message || '备份执行存在异常，请查看 OOS 原始输出并检查集群权限配置。'}</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button type="button" onClick={() => window.open(buildOosConsoleUrl(execution.executionId, execution.oosRegionId), '_blank', 'noopener,noreferrer')} className="btn-secondary">
                        查看详情
                      </button>
                      <button type="button" onClick={copyErrorMessage} className="btn-secondary inline-flex items-center gap-2">
                        <ClipboardCopy className="h-4 w-4" />
                        复制错误信息
                      </button>
                      <span className="inline-flex items-center rounded-md bg-white px-3 py-2 text-sm text-red-700 ring-1 ring-red-100">
                        检查 RAM 和 Kubernetes 权限配置
                      </span>
                    </div>
                  </div>
                )}
                {cancelConfirmOpen && (
                  <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3">
                    <div className="text-sm font-semibold text-red-900">确认取消备份执行</div>
                    <p className="mt-1 text-sm text-red-800">取消后该备份执行不再触发后续周期备份，已经创建的可恢复备份点不会删除。</p>
                    <div className="mt-3 flex justify-end gap-3">
                      <button type="button" onClick={() => setCancelConfirmOpen(false)} className="btn-secondary">返回</button>
                      <button type="button" onClick={cancelExecution} disabled={cancelling} className="btn-primary bg-red-600 hover:bg-red-700 disabled:opacity-50">
                        {cancelling ? '取消中...' : '确认取消'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <div className="card overflow-hidden p-0">
        <div className="border-b border-gray-200 px-6 py-5">
          <h2 className="text-lg font-semibold text-gray-900">执行记录</h2>
          <p className="mt-1 text-sm text-gray-500">展示该备份执行下每次实际执行结果。</p>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-5 py-3 text-left font-medium text-gray-600">状态</th>
                <th className="px-5 py-3 text-left font-medium text-gray-600">开始时间</th>
                <th className="px-5 py-3 text-left font-medium text-gray-600">执行信息</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 bg-white">
              {records.length === 0 ? (
                <tr><td colSpan={3} className="px-5 py-8 text-center text-gray-500">暂无执行记录</td></tr>
              ) : records.map((record, index) => (
                <tr key={`${record.startedAt || index}-${record.message}`}>
                  <td className="px-5 py-4"><StatusBadge status={record.status} /></td>
                  <td className="px-5 py-4 text-gray-700">{formatDateTime(record.startedAt)}</td>
                  <td className="px-5 py-4 text-gray-700">{record.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
