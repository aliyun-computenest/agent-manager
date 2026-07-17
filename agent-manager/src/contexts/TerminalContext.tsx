import React, { createContext, useCallback, useContext, useMemo, useState } from 'react'

export interface TerminalSession {
  instanceId: string
  accessToken: string
  sandboxId?: string | null
}

interface TerminalContextValue {
  terminalSession: TerminalSession | null
  openTerminal: (session: TerminalSession) => void
  closeTerminal: () => void
  isTerminalOpen: (instanceId: string) => boolean
}

const defaultValue: TerminalContextValue = {
  terminalSession: null,
  openTerminal: () => undefined,
  closeTerminal: () => undefined,
  isTerminalOpen: () => false
}

const TerminalContext = createContext<TerminalContextValue>(defaultValue)
const TERMINAL_DOCK_STORAGE_KEY = 'openclaw-terminal:dock-session'
const TERMINAL_DOCK_RESTORE_ENABLED_KEY = 'openclaw-terminal:restore-dock-enabled'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readStoredTerminalSession(): TerminalSession | null {
  if (typeof window === 'undefined') return null
  if (!isTerminalDockRestoreEnabled()) {
    clearStoredTerminalSession()
    return null
  }

  try {
    const stored = window.sessionStorage.getItem(TERMINAL_DOCK_STORAGE_KEY)
    if (!stored) return null

    const parsed = JSON.parse(stored)
    if (!isRecord(parsed)) return null
    if (typeof parsed.instanceId !== 'string' || typeof parsed.accessToken !== 'string') {
      return null
    }

    return {
      instanceId: parsed.instanceId,
      accessToken: parsed.accessToken,
      sandboxId: typeof parsed.sandboxId === 'string' ? parsed.sandboxId : null
    }
  } catch {
    return null
  }
}

function writeStoredTerminalSession(session: TerminalSession) {
  if (typeof window === 'undefined') return
  if (!isTerminalDockRestoreEnabled()) return

  try {
    window.sessionStorage.setItem(TERMINAL_DOCK_STORAGE_KEY, JSON.stringify(session))
  } catch {
    // Terminal UI must keep working even if sessionStorage is unavailable.
  }
}

function clearStoredTerminalSession() {
  if (typeof window === 'undefined') return

  try {
    window.sessionStorage.removeItem(TERMINAL_DOCK_STORAGE_KEY)
  } catch {
    // Ignore storage failures for the same reason as writes.
  }
}

function isTerminalDockRestoreEnabled() {
  if (typeof window === 'undefined') return false

  try {
    return window.localStorage.getItem(TERMINAL_DOCK_RESTORE_ENABLED_KEY) === 'true' ||
      window.sessionStorage.getItem(TERMINAL_DOCK_RESTORE_ENABLED_KEY) === 'true'
  } catch {
    return false
  }
}

export const TerminalProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [terminalSession, setTerminalSession] = useState<TerminalSession | null>(() => readStoredTerminalSession())

  const openTerminal = useCallback((session: TerminalSession) => {
    writeStoredTerminalSession(session)
    setTerminalSession(session)
  }, [])

  const closeTerminal = useCallback(() => {
    clearStoredTerminalSession()
    setTerminalSession(null)
  }, [])

  const isTerminalOpen = useCallback((instanceId: string) => {
    return terminalSession?.instanceId === instanceId
  }, [terminalSession?.instanceId])

  const value = useMemo(() => ({
    terminalSession,
    openTerminal,
    closeTerminal,
    isTerminalOpen
  }), [closeTerminal, isTerminalOpen, openTerminal, terminalSession])

  return (
    <TerminalContext.Provider value={value}>
      {children}
    </TerminalContext.Provider>
  )
}

export function useTerminalDock() {
  return useContext(TerminalContext)
}
