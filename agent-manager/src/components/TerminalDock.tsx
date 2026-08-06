import React, { useEffect } from 'react'
import TerminalPanel from './TerminalPanel'
import { useTerminalDock } from '../contexts/TerminalContext'
import { useAuth } from '../contexts/AuthContext'

const TerminalDock: React.FC = () => {
  const { terminalSession, closeTerminal } = useTerminalDock()
  const { session } = useAuth()

  useEffect(() => {
    if (!session && terminalSession) {
      closeTerminal()
    }
  }, [closeTerminal, session, terminalSession])

  if (!terminalSession || !session) return null

  return (
    <div className="fixed bottom-4 right-4 z-[45] max-h-[calc(100vh-2rem)] w-[min(960px,calc(100vw-2rem))] min-w-0 overflow-hidden shadow-2xl">
      <TerminalPanel
        instanceId={terminalSession.instanceId}
        accessToken={terminalSession.accessToken}
        sandboxId={terminalSession.sandboxId}
        onClose={closeTerminal}
      />
    </div>
  )
}

export default TerminalDock
