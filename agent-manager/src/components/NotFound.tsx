import React from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Home, ArrowLeft } from 'lucide-react'

const NotFound: React.FC = () => {
  const navigate = useNavigate()
  const { t } = useTranslation('common')

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="text-center">
        <h1 className="text-9xl font-bold text-primary-600 mb-4">404</h1>
        <h2 className="text-3xl font-semibold text-gray-900 mb-4">
          {t('notFound.title')}
        </h2>
        <p className="text-gray-600 mb-8 max-w-md">
          {t('notFound.description')}
        </p>
        <div className="flex justify-center space-x-4">
          <button
            onClick={() => navigate(-1)}
            className="btn-secondary flex items-center space-x-2"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>{t('notFound.goBack')}</span>
          </button>
          <button
            onClick={() => navigate('/')}
            className="btn-primary flex items-center space-x-2"
          >
            <Home className="w-4 h-4" />
            <span>{t('notFound.goHome')}</span>
          </button>
        </div>
      </div>
    </div>
  )
}

export default NotFound
