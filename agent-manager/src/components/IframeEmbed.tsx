import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, AlertTriangle, ExternalLink, RefreshCw } from 'lucide-react'

const LOADING_TIMEOUT = 30_000 // 30 seconds

interface IframeEmbedProps {
  url: string
  title: string
}

const IframeEmbed: React.FC<IframeEmbedProps> = ({ url, title }) => {
  const { t } = useTranslation()
  const [isLoading, setIsLoading] = useState(true)
  const [hasError, setHasError] = useState(false)
  const [retryKey, setRetryKey] = useState(0)
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>()

  const clearTimer = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = undefined
    }
  }, [])

  const handleError = useCallback(() => {
    setIsLoading(false)
    setHasError(true)
    clearTimer()
  }, [clearTimer])

  const handleRetry = () => {
    setIsLoading(true)
    setHasError(false)
    setRetryKey(prev => prev + 1)
  }

  // Timeout detection: if still loading after 30s, treat as load failure
  // This handles cross-origin iframes blocked by X-Frame-Options/CSP
  // where onError never fires
  useEffect(() => {
    timeoutRef.current = setTimeout(() => {
      setIsLoading(prev => {
        if (prev) {
          setHasError(true)
          return false
        }
        return prev
      })
    }, LOADING_TIMEOUT)
    return clearTimer
  }, [retryKey, clearTimer])

  return (
    <div className="w-full h-full relative">
      {/* Loading overlay */}
      {isLoading && !hasError && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-50 z-10">
          <div className="text-center">
            <Loader2 className="w-10 h-10 text-primary-600 animate-spin mx-auto mb-3" />
            <p className="text-gray-600 text-sm">{t('loading.default')}</p>
          </div>
        </div>
      )}

      {/* Error overlay */}
      {hasError && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-50 z-10">
          <div className="text-center">
            <AlertTriangle className="w-12 h-12 text-amber-500 mx-auto mb-4" />
            <p className="text-gray-700 font-medium mb-2">{t('iframe.loadFailed')}</p>
            <p className="text-gray-500 text-sm mb-4">{t('iframe.embedFailed')}</p>
            <div className="flex items-center justify-center space-x-3">
              <button
                onClick={handleRetry}
                className="inline-flex items-center px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors text-sm"
              >
                <RefreshCw className="w-4 h-4 mr-2" />
                {t('iframe.retry')}
              </button>
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center px-4 py-2 bg-white text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors text-sm"
              >
                <ExternalLink className="w-4 h-4 mr-2" />
                {t('iframe.openInNewTab')}
              </a>
            </div>
          </div>
        </div>
      )}

      {/* Iframe */}
      <iframe
        key={`${url}-${retryKey}`}
        src={url}
        title={title}
        className="absolute inset-0 w-full h-full border-0"
        onLoad={() => {
          setIsLoading(false)
          clearTimer()
        }}
        onError={handleError}
      />
    </div>
  )
}

export default IframeEmbed
