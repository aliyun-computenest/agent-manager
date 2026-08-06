import React, { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, Loader2, Maximize2, RefreshCw, Upload, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { apiUrl } from '../lib/api'

interface UploadFileItem {
  file: File
  status: 'pending' | 'uploading' | 'done' | 'error' | 'cancelled'
  progress: number
  uploadedBytes: number
}

interface TerminalPanelProps {
  instanceId: string
  accessToken: string
  sandboxId?: string | null
  onClose: () => void
  onFloat?: () => void
  onSessionClosed?: () => void
}

type TerminalState = 'connecting' | 'connected' | 'closed' | 'error'

const TRANSCRIPT_MAX_CHARS = 200_000

function terminalErrorKey(error: string) {
  return `terminal.errors.${error}`
}

function terminalTranscriptKey(instanceId: string) {
  return `openclaw-terminal:${instanceId}:transcript`
}

function readStoredTranscript(instanceId: string) {
  try {
    return window.sessionStorage.getItem(terminalTranscriptKey(instanceId)) || ''
  } catch {
    return ''
  }
}

function writeStoredTranscript(instanceId: string, transcript: string) {
  try {
    window.sessionStorage.setItem(terminalTranscriptKey(instanceId), transcript.slice(-TRANSCRIPT_MAX_CHARS))
  } catch {
    // Ignore storage quota / private browsing failures; terminal must keep working.
  }
}

function parseSandboxTarget(sandboxId?: string | null) {
  if (!sandboxId) return null
  const parts = sandboxId.split('--')
  if (parts.length < 2) {
    return { namespace: '', podName: sandboxId, sandboxId }
  }
  return {
    namespace: parts[0],
    podName: parts.slice(1).join('--'),
    sandboxId
  }
}

const TerminalPanel: React.FC<TerminalPanelProps> = ({ instanceId, accessToken, sandboxId, onClose, onFloat, onSessionClosed }) => {
  const { t } = useTranslation('admin')
  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const terminalRunRef = useRef(0)
  const instanceIdRef = useRef(instanceId)
  const transcriptRef = useRef(readStoredTranscript(instanceId))
  const transcriptFlushTimerRef = useRef<number | null>(null)
  const heartbeatRef = useRef<number | null>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const fitFrameRef = useRef<number | null>(null)
  const lastObservedSizeRef = useRef('')
  const [state, setState] = useState<TerminalState>('connecting')
  const [error, setError] = useState('')
  const [terminalUser, setTerminalUser] = useState<string | null>(null)
  const [sessionSandboxId, setSessionSandboxId] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [uploadConfirm, setUploadConfirm] = useState<{ files: File[] } | null>(null)
  const [uploadFiles, setUploadFiles] = useState<UploadFileItem[]>([])
  const [isUploading, setIsUploading] = useState(false)
  const uploadCancelledRef = useRef(false)
  const xhrRef = useRef<XMLHttpRequest | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const target = parseSandboxTarget(sessionSandboxId || sandboxId)

  const effectiveUser = terminalUser || 'root'
  const uploadDir = effectiveUser === 'root' ? '/root/uploads/' : `/home/${effectiveUser}/uploads/`

  useEffect(() => {
    instanceIdRef.current = instanceId
  }, [instanceId])

  const flushTranscript = useCallback(() => {
    if (transcriptFlushTimerRef.current) {
      window.clearTimeout(transcriptFlushTimerRef.current)
      transcriptFlushTimerRef.current = null
    }
    writeStoredTranscript(instanceIdRef.current, transcriptRef.current)
  }, [])

  const appendTranscript = useCallback((data: string) => {
    if (!data) return
    transcriptRef.current = `${transcriptRef.current}${data}`.slice(-TRANSCRIPT_MAX_CHARS)
    if (!transcriptFlushTimerRef.current) {
      transcriptFlushTimerRef.current = window.setTimeout(flushTranscript, 500)
    }
  }, [flushTranscript])

  const disposeTerminal = useCallback(() => {
    terminalRunRef.current += 1
    flushTranscript()
    if (heartbeatRef.current) {
      window.clearInterval(heartbeatRef.current)
      heartbeatRef.current = null
    }
    resizeObserverRef.current?.disconnect()
    resizeObserverRef.current = null
    if (fitFrameRef.current !== null) {
      window.cancelAnimationFrame(fitFrameRef.current)
      fitFrameRef.current = null
    }
    lastObservedSizeRef.current = ''
    if (wsRef.current) {
      wsRef.current.onopen = null
      wsRef.current.onmessage = null
      wsRef.current.onclose = null
      wsRef.current.onerror = null
      wsRef.current.close()
    }
    wsRef.current = null
    terminalRef.current?.dispose()
    terminalRef.current = null
    fitAddonRef.current = null
  }, [flushTranscript])

  const sendResize = useCallback(() => {
    const terminal = terminalRef.current
    const ws = wsRef.current
    if (!terminal || !ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({
      type: 'resize',
      cols: terminal.cols,
      rows: terminal.rows
    }))
  }, [])

  const fitTerminal = useCallback(() => {
    const container = containerRef.current
    if (!container || container.clientWidth <= 0 || container.clientHeight <= 0) return
    try {
      fitAddonRef.current?.fit()
      sendResize()
    } catch (err) {
      console.warn('Terminal fit failed:', err)
    }
  }, [sendResize])

  const scheduleFitTerminal = useCallback(() => {
    if (fitFrameRef.current !== null) return
    fitFrameRef.current = window.requestAnimationFrame(() => {
      fitFrameRef.current = null
      fitTerminal()
    })
  }, [fitTerminal])

  const openTerminal = useCallback(async () => {
    if (!containerRef.current) return

    disposeTerminal()
    const runId = terminalRunRef.current
    const isCurrentRun = () => terminalRunRef.current === runId
    setState('connecting')
    setError('')
    setTerminalUser(null)
    setSessionSandboxId(null)
    transcriptRef.current = readStoredTranscript(instanceId)

    const terminal = new XTerm({
      cursorBlink: true,
      convertEol: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 3000,
      theme: {
        background: '#0f172a',
        foreground: '#dbeafe',
        cursor: '#38bdf8',
        selectionBackground: '#334155'
      }
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(containerRef.current)
    terminalRef.current = terminal
    fitAddonRef.current = fitAddon
    if (transcriptRef.current) {
      terminal.write(transcriptRef.current)
    }
    if (isCurrentRun()) scheduleFitTerminal()

    try {
      const response = await fetch(`${apiUrl}/api/instances/${instanceId}/terminal/session`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      })
      const payload = await response.json()
      if (!payload.success) {
        const code = payload.error || 'TERMINAL_START_FAILED'
        throw new Error(t(terminalErrorKey(code), payload.message || code))
      }
      if (!isCurrentRun()) return
      setSessionSandboxId(payload.data?.sandboxId || null)

      const ws = new WebSocket(payload.data.wsUrl)
      wsRef.current = ws

      terminal.onData(data => {
        if (!isCurrentRun()) return
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'stdin', data }))
        }
      })

      terminal.onResize(({ cols, rows }) => {
        if (!isCurrentRun()) return
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols, rows }))
        }
      })

      ws.onopen = () => {
        if (!isCurrentRun()) return
        scheduleFitTerminal()
        terminal.focus()
        heartbeatRef.current = window.setInterval(() => {
          if (isCurrentRun() && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'heartbeat' }))
          }
        }, 25_000)
      }

      ws.onmessage = event => {
        if (!isCurrentRun()) return
        try {
          const message = JSON.parse(String(event.data))
          if (message.type === 'ready') {
            setTerminalUser(message.terminalUser || t('terminal.defaultUser'))
            setState('connected')
            terminal.focus()
          } else if (message.type === 'stdout') {
            const data = message.data || ''
            appendTranscript(data)
            terminal.write(data)
          } else if (message.type === 'error') {
            setError(t(terminalErrorKey(message.error), message.message || message.error))
            setState('error')
          } else if (message.type === 'exit') {
            setState('closed')
            terminal.writeln('')
            terminal.writeln(t('terminal.closed'))
            onSessionClosed?.()
          }
        } catch (err: any) {
          setError(err.message)
          setState('error')
        }
      }

      ws.onclose = () => {
        if (!isCurrentRun()) return
        setState(prev => {
          if (prev === 'connected' || prev === 'connecting') {
            onSessionClosed?.()
            return 'closed'
          }
          return prev
        })
      }

      ws.onerror = () => {
        if (!isCurrentRun()) return
        setError(t('terminal.errors.WEBSOCKET_ERROR'))
        setState('error')
      }

      resizeObserverRef.current = new ResizeObserver(entries => {
        if (!isCurrentRun()) return
        const width = Math.floor(entries[0]?.contentRect.width || 0)
        const height = Math.floor(entries[0]?.contentRect.height || 0)
        const sizeKey = `${width}x${height}`
        if (!width || !height || sizeKey === lastObservedSizeRef.current) return
        lastObservedSizeRef.current = sizeKey
        scheduleFitTerminal()
      })
      resizeObserverRef.current.observe(containerRef.current)
    } catch (err: any) {
      if (!isCurrentRun()) return
      setError(err.message || t('terminal.errors.TERMINAL_START_FAILED'))
      setState('error')
    }
  }, [accessToken, appendTranscript, disposeTerminal, instanceId, scheduleFitTerminal, t])

  useEffect(() => {
    openTerminal()
    return () => disposeTerminal()
    // A terminal session should only restart when the target instance or auth token changes.
    // Ordinary re-renders, route layout updates, or i18n function identity changes must not
    // close and recreate the WebSocket.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId, accessToken])

  useEffect(() => {
    window.addEventListener('beforeunload', flushTranscript)
    return () => window.removeEventListener('beforeunload', flushTranscript)
  }, [flushTranscript])

  const formatFileSize = useCallback((bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  }, [])

  const uploadSingleFile = useCallback((item: UploadFileItem, index: number): Promise<void> => {
    return new Promise((resolve, reject) => {
      const formData = new FormData()
      formData.append('file', item.file)
      if (terminalUser) {
        formData.append('targetUser', terminalUser)
      }

      const xhr = new XMLHttpRequest()
      xhrRef.current = xhr

      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          const percent = Math.round((event.loaded / event.total) * 100)
          setUploadFiles(prev => prev.map((f, idx) =>
            idx === index ? { ...f, progress: percent, uploadedBytes: event.loaded } : f
          ))
        }
      }

      xhr.onload = () => {
        xhrRef.current = null
        try {
          const result = JSON.parse(xhr.responseText)
          if (result.success) {
            const sizeStr = formatFileSize(result.data.size)
            terminalRef.current?.write(
              `\r\n\x1b[32m\u2713 ${t('terminal.uploadSuccess', { path: result.data.path, size: sizeStr })}\x1b[0m\r\n`
            )
            resolve()
          } else {
            terminalRef.current?.write(
              `\r\n\x1b[31m\u2717 ${t('terminal.uploadFailed', { message: result.message || result.error })}\x1b[0m\r\n`
            )
            reject(new Error(result.message || result.error))
          }
        } catch {
          terminalRef.current?.write(
            `\r\n\x1b[31m\u2717 ${t('terminal.uploadFailed', { message: t('terminal.uploadErrorInvalidResponse') })}\x1b[0m\r\n`
          )
          reject(new Error('Invalid response'))
        }
      }

      xhr.onerror = () => {
        xhrRef.current = null
        terminalRef.current?.write(
          `\r\n\x1b[31m\u2717 ${t('terminal.uploadFailed', { message: t('terminal.uploadErrorNetwork') })}\x1b[0m\r\n`
        )
        reject(new Error('Network error'))
      }

      xhr.onabort = () => {
        xhrRef.current = null
        reject(new Error('Aborted'))
      }

      xhr.open('POST', `${apiUrl}/api/instances/${instanceId}/files/upload`)
      xhr.setRequestHeader('Authorization', `Bearer ${accessToken}`)
      xhr.send(formData)
    })
  }, [instanceId, accessToken, formatFileSize, t, terminalUser])

  const handleBatchUpload = useCallback(async (files: UploadFileItem[]) => {
    setIsUploading(true)
    uploadCancelledRef.current = false
    setUploadFiles(files)

    let successCount = 0
    let failCount = 0

    for (let i = 0; i < files.length; i++) {
      if (uploadCancelledRef.current) {
        setUploadFiles(prev => prev.map((f, idx) =>
          idx >= i ? { ...f, status: 'cancelled' } : f
        ))
        break
      }

      setUploadFiles(prev => prev.map((f, idx) =>
        idx === i ? { ...f, status: 'uploading' } : f
      ))

      try {
        await uploadSingleFile(files[i], i)
        setUploadFiles(prev => prev.map((f, idx) =>
          idx === i ? { ...f, status: 'done', progress: 100 } : f
        ))
        successCount++
      } catch {
        if (uploadCancelledRef.current) {
          setUploadFiles(prev => prev.map((f, idx) =>
            idx === i ? { ...f, status: 'cancelled' } : f
          ))
          // Mark remaining as cancelled too
          setUploadFiles(prev => prev.map((f, idx) =>
            idx > i && f.status === 'pending' ? { ...f, status: 'cancelled' } : f
          ))
          break
        } else {
          setUploadFiles(prev => prev.map((f, idx) =>
            idx === i ? { ...f, status: 'error' } : f
          ))
          failCount++
        }
      }
    }

    setIsUploading(false)

    if (uploadCancelledRef.current) {
      terminalRef.current?.write(
        `\r\n\x1b[33m\u26A0 ${t('terminal.uploadBatchCancelled')}\x1b[0m\r\n`
      )
    } else if (files.length > 1) {
      terminalRef.current?.write(
        `\r\n\x1b[36m\u2139 ${t('terminal.uploadBatchComplete', { success: successCount, failed: failCount })}\x1b[0m\r\n`
      )
    }

    // Clear upload files after a delay so user can see final state
    setTimeout(() => {
      setUploadFiles([])
    }, 2000)
  }, [uploadSingleFile, t])

  const handleCancelAllUploads = useCallback(() => {
    uploadCancelledRef.current = true
    if (xhrRef.current) {
      xhrRef.current.abort()
    }
  }, [])

  const confirmUpload = useCallback(() => {
    if (uploadConfirm) {
      const items: UploadFileItem[] = uploadConfirm.files.map(file => ({
        file,
        status: 'pending' as const,
        progress: 0,
        uploadedBytes: 0
      }))
      setUploadConfirm(null)
      handleBatchUpload(items)
    }
  }, [uploadConfirm, handleBatchUpload])

  const cancelUpload = useCallback(() => {
    setUploadConfirm(null)
  }, [])

  const requestUpload = useCallback((files: File[]) => {
    if (files.length === 0) return
    setUploadConfirm({ files })
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) requestUpload(files)
  }, [requestUpload])

  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    if (files.length > 0) requestUpload(files)
    // Reset input so same file can be re-selected
    e.target.value = ''
  }, [requestUpload])

  const statusClass = state === 'connected'
    ? 'bg-emerald-400/10 text-emerald-200 ring-emerald-300/20'
    : state === 'error'
      ? 'bg-red-400/10 text-red-200 ring-red-300/20'
      : state === 'connecting'
        ? 'bg-sky-400/10 text-sky-200 ring-sky-300/20'
        : 'bg-slate-400/10 text-slate-200 ring-slate-300/20'

  const statusDotClass = state === 'connected'
    ? 'bg-emerald-300'
    : state === 'error'
      ? 'bg-red-300'
      : state === 'connecting'
        ? 'bg-sky-300'
        : 'bg-slate-300'

  return (
    <div className="flex min-w-0 w-full max-w-full flex-col overflow-hidden rounded-xl bg-slate-950 shadow-lg ring-1 ring-slate-900/10">
      <style>{`
        .openclaw-terminal {
          width: 100%;
          max-width: 100%;
          contain: layout paint inline-size;
        }
        .openclaw-terminal .xterm {
          height: 100%;
          width: 100% !important;
          max-width: 100%;
        }
        .openclaw-terminal .xterm-viewport {
          width: 100% !important;
          overflow-x: hidden !important;
        }
        .openclaw-terminal .xterm-screen {
          max-width: 100%;
        }
        .openclaw-terminal .xterm-viewport::-webkit-scrollbar {
          width: 10px;
        }
        .openclaw-terminal .xterm-viewport::-webkit-scrollbar-track {
          background: transparent;
        }
        .openclaw-terminal .xterm-viewport::-webkit-scrollbar-thumb {
          background: rgba(148, 163, 184, 0.32);
          border: 3px solid transparent;
          border-radius: 999px;
          background-clip: content-box;
        }
      `}</style>
      <div className="min-w-0 border-b border-white/10 bg-slate-900 px-4 py-3.5 sm:px-5">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2.5">
            <h3 className="text-sm font-semibold text-slate-50">{t('terminal.title')}</h3>
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${statusClass}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${statusDotClass}`} />
              {state === 'connected' && terminalUser ? t('terminal.connectedAs', { user: terminalUser }) : t(`terminal.state.${state}`)}
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={handleFileInputChange}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading || state !== 'connected'}
              title={t('terminal.uploadTooltip') as string}
              aria-label={t('terminal.uploadTooltip') as string}
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-white/10 px-3 text-sm font-medium text-slate-100 transition-colors hover:bg-white/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isUploading ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Upload className="h-4 w-4" aria-hidden="true" />
              )}
              <span>{t('terminal.upload')}</span>
            </button>
            {onFloat && (
              <button
                type="button"
                onClick={onFloat}
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-white/10 px-3 text-sm font-medium text-slate-100 transition-colors hover:bg-white/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
              >
                <Maximize2 className="h-4 w-4" aria-hidden="true" />
                <span>{t('terminal.float')}</span>
              </button>
            )}
            {state === 'error' && (
              <button
                onClick={openTerminal}
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-white/10 px-3 text-sm font-medium text-slate-100 transition-colors hover:bg-white/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
              >
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
                <span>{t('terminal.retry')}</span>
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              title={t('terminal.close') as string}
              aria-label={t('terminal.close') as string}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-300 transition-colors hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </div>

        {target && (
          <div className="mt-3 grid min-w-0 grid-cols-1 gap-2 text-xs sm:grid-cols-3">
            <div className="min-w-0 rounded-lg bg-white/[0.04] px-3 py-2 ring-1 ring-white/[0.06]">
              <span className="block text-[11px] font-medium text-slate-400">{t('terminal.targetSandbox')}</span>
              <code className="mt-1 block truncate font-mono text-slate-200" title={target.sandboxId}>{target.sandboxId}</code>
            </div>
            {target.namespace && (
              <div className="min-w-0 rounded-lg bg-white/[0.04] px-3 py-2 ring-1 ring-white/[0.06]">
                <span className="block text-[11px] font-medium text-slate-400">{t('terminal.targetNamespace')}</span>
                <code className="mt-1 block truncate font-mono text-slate-200" title={target.namespace}>{target.namespace}</code>
              </div>
            )}
            <div className="min-w-0 rounded-lg bg-white/[0.04] px-3 py-2 ring-1 ring-white/[0.06]">
              <span className="block text-[11px] font-medium text-slate-400">{t('terminal.targetPod')}</span>
              <code className="mt-1 block truncate font-mono text-slate-200" title={target.sandboxId}>{target.podName}</code>
            </div>
          </div>
        )}

        <p className="mt-2 text-xs leading-5 text-slate-400">
          {t('terminal.historyHint')}
        </p>
      </div>

      {state === 'connecting' && (
        <div className="flex items-center gap-2 border-b border-white/10 bg-slate-900/80 px-4 py-3 text-sm text-slate-200 sm:px-5">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>{t('terminal.connecting')}</span>
        </div>
      )}

      {state === 'error' && (
        <div className="flex items-start gap-3 border-b border-red-400/20 bg-red-500/10 px-4 py-3 text-sm text-red-100 sm:px-5">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {isUploading && uploadFiles.length > 0 && (() => {
        const completedCount = uploadFiles.filter(f => f.status === 'done' || f.status === 'error' || f.status === 'cancelled').length
        const currentFile = uploadFiles.find(f => f.status === 'uploading')
        return (
          <div className="px-4 py-2.5 bg-slate-900 border-b border-white/10 sm:px-5">
            <div className="flex justify-between items-center mb-2">
              <span className="text-xs text-slate-400">
                {completedCount}/{uploadFiles.length} {t('terminal.uploadBatchProgress')}
              </span>
              <button
                type="button"
                onClick={handleCancelAllUploads}
                className="text-slate-400 hover:text-white p-1 rounded transition-colors hover:bg-white/10"
                title={t('terminal.uploadCancel') as string}
              >
                <X size={14} />
              </button>
            </div>
            {currentFile && (
              <div>
                <div className="flex justify-between text-xs text-slate-400 mb-1">
                  <span className="truncate mr-2">{currentFile.file.name}</span>
                  <span className="shrink-0">{formatFileSize(currentFile.uploadedBytes)} / {formatFileSize(currentFile.file.size)} ({currentFile.progress}%)</span>
                </div>
                <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-sky-500 rounded-full transition-all duration-200"
                    style={{ width: `${currentFile.progress}%` }}
                  />
                </div>
              </div>
            )}
            <div className="mt-2 max-h-24 overflow-y-auto space-y-0.5">
              {uploadFiles.map((item, idx) => (
                <div key={idx} className="flex items-center gap-2 text-xs">
                  {item.status === 'done' && <Check size={12} className="text-emerald-400 shrink-0" />}
                  {item.status === 'error' && <X size={12} className="text-red-400 shrink-0" />}
                  {item.status === 'uploading' && <Loader2 size={12} className="text-sky-400 animate-spin shrink-0" />}
                  {item.status === 'pending' && <span className="w-3 h-3 shrink-0" />}
                  {item.status === 'cancelled' && <X size={12} className="text-slate-500 shrink-0" />}
                  <span className={`truncate ${
                    item.status === 'done' ? 'text-emerald-300' :
                    item.status === 'error' ? 'text-red-300' :
                    item.status === 'uploading' ? 'text-slate-200' :
                    item.status === 'cancelled' ? 'text-slate-500' :
                    'text-slate-500'
                  }`}>{item.file.name}</span>
                </div>
              ))}
            </div>
          </div>
        )
      })()}

      <div
        className="relative bg-slate-950 p-2 sm:p-3"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {dragOver && (
          <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-sky-500/20 backdrop-blur-sm ring-2 ring-inset ring-sky-400/50">
            <div className="flex flex-col items-center gap-2 text-sky-100">
              <Upload className="h-8 w-8" />
              <span className="text-sm font-medium">{t('terminal.dragHint')}</span>
            </div>
          </div>
        )}
        <div
          ref={containerRef}
          className="openclaw-terminal h-[clamp(300px,46vh,520px)] min-w-0 max-w-full overflow-hidden rounded-lg bg-[#07101f] shadow-inner ring-1 ring-white/[0.06]"
        />
      </div>

      {/* Upload Confirmation Dialog */}
      {uploadConfirm && (() => {
        const totalSize = uploadConfirm.files.reduce((sum, f) => sum + f.size, 0)
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
            <div className="w-full max-w-md rounded-xl bg-gray-800 p-6 shadow-2xl ring-1 ring-white/10">
              <h3 className="text-lg font-semibold text-white">{t('terminal.uploadConfirm.title')}</h3>
              <div className="mt-4 space-y-3">
                <div className="max-h-40 overflow-y-auto rounded-lg bg-white/[0.04] p-2 ring-1 ring-white/[0.06]">
                  {uploadConfirm.files.map((f, i) => (
                    <div key={i} className="flex justify-between text-sm text-slate-300 py-0.5 px-1">
                      <span className="truncate mr-2">{f.name}</span>
                      <span className="text-slate-500 whitespace-nowrap shrink-0">{formatFileSize(f.size)}</span>
                    </div>
                  ))}
                </div>
                <div className="text-xs text-slate-500">
                  {t('terminal.uploadConfirm.totalFiles', { count: uploadConfirm.files.length })} · {formatFileSize(totalSize)}
                </div>
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-medium text-slate-400">{t('terminal.uploadConfirm.targetDir')}:</span>
                  <code className="text-sm text-emerald-300 font-mono">{uploadDir}</code>
                </div>
              </div>
              <div className="mt-6 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={cancelUpload}
                  className="rounded-lg px-4 py-2 text-sm font-medium text-slate-300 transition-colors hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
                >
                  {t('terminal.uploadConfirm.cancel')}
                </button>
                <button
                  type="button"
                  onClick={confirmUpload}
                  disabled={isUploading}
                  className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {t('terminal.uploadConfirm.confirm')}
                </button>
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}

export default TerminalPanel
