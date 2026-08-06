import { useCallback, useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import TerminalPanel from './TerminalPanel'

function TerminalPage() {
  const { id } = useParams<{ id: string }>()
  const { t } = useTranslation(['admin', 'common'])
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const [tokenError, setTokenError] = useState(false)
  const [showSessionClosedModal, setShowSessionClosedModal] = useState(false)
  const [closeBlocked, setCloseBlocked] = useState(false)

  useEffect(() => {
    if (!id) {
      setTokenError(true)
      return
    }
    const key = `terminal-token:${id}`
    const token = sessionStorage.getItem(key)
    if (token) {
      setAccessToken(token)
      sessionStorage.removeItem(key)
    } else {
      setTokenError(true)
    }
  }, [id])

  useEffect(() => {
    if (id) {
      document.title = t('admin:terminal.pageTitle', { id })
    }
  }, [id, t])

  const handleClose = () => {
    window.close()
  }

  const handleSessionClosed = useCallback(() => {
    setShowSessionClosedModal(true)
  }, [])

  const handleConfirmClose = useCallback(() => {
    window.close()
    // If window.close() is blocked by the browser, show a hint
    setTimeout(() => setCloseBlocked(true), 300)
  }, [])

  if (tokenError || !id) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-gray-900">
        <div className="text-center space-y-4">
          <p className="text-red-400 text-lg">{t('terminal.errors.TERMINAL_SESSION_INVALID')}</p>
          <Link to="/" className="text-blue-400 hover:text-blue-300 underline">
            {t('common:nav.home', '← Back')}
          </Link>
        </div>
      </div>
    )
  }

  if (!accessToken) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-gray-900">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-gray-600 border-t-green-400" />
      </div>
    )
  }

  return (
    <div className="h-screen w-screen overflow-hidden bg-gray-900">
      <TerminalPanel
        instanceId={id}
        accessToken={accessToken}
        onClose={handleClose}
        onSessionClosed={handleSessionClosed}
      />

      {showSessionClosedModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="mx-4 max-w-md rounded-lg bg-slate-800 p-6 shadow-xl ring-1 ring-white/10">
            <h3 className="text-lg font-semibold text-slate-50">
              {t('admin:terminal.sessionClosed.title')}
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-slate-300">
              {t('admin:terminal.sessionClosed.message')}
            </p>
            {closeBlocked && (
              <p className="mt-2 text-xs text-amber-400">
                {t('admin:terminal.sessionClosed.closeBlocked')}
              </p>
            )}
            <button
              type="button"
              onClick={handleConfirmClose}
              className="mt-5 w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-800"
            >
              {t('admin:terminal.sessionClosed.confirm')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default TerminalPage
