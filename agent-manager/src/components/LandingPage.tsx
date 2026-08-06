import React from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../contexts/AuthContext'
import { Shield, Users, Bot, ArrowRight, LogIn, KeyRound } from 'lucide-react'
import LanguageSwitcher from './LanguageSwitcher'

interface LandingPageProps {
  currentUser: {
    id: string
    username: string
    email?: string
    role: 'admin' | 'user'
  } | null
}

const LandingPage: React.FC<LandingPageProps> = ({ currentUser }) => {
  const navigate = useNavigate()
  const { signOut } = useAuth()
  const { t } = useTranslation('landing')

  const handleLogout = async () => {
    await signOut()
    navigate('/')
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary-50 via-white to-primary-100">
      {/* Header */}
      <header className="border-b border-gray-200 bg-white/80 backdrop-blur-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-4">
            <div className="flex items-center space-x-3">
              <div className="w-10 h-10 bg-primary-600 rounded-lg flex items-center justify-center">
                <Bot className="w-6 h-6 text-white" />
              </div>
              <span className="text-2xl font-bold text-gray-900">Agent Manager</span>
            </div>
            <nav className="flex items-center space-x-4">
              <LanguageSwitcher />
              {currentUser ? (
                <>
                  <span className="text-gray-600">{t('nav.welcome', { name: currentUser.username })}</span>
                  <button
                    onClick={() => navigate('/user/dashboard')}
                    className="px-4 py-2 rounded-lg font-medium text-gray-600 hover:bg-gray-100 transition-colors"
                  >
                    {t('nav.userCenter')}
                  </button>
                  {currentUser.role === 'admin' && (
                    <button
                      onClick={() => navigate('/admin/dashboard')}
                      className="px-4 py-2 rounded-lg font-medium bg-primary-600 text-white hover:bg-primary-700 transition-colors"
                    >
                      {t('nav.adminCenter')}
                    </button>
                  )}
                  <button
                    onClick={handleLogout}
                    className="px-4 py-2 rounded-lg font-medium text-red-600 hover:bg-red-50 transition-colors"
                  >
                    {t('nav.logout')}
                  </button>
                </>
              ) : (
                <div className="flex items-center space-x-3">
                  <button
                    onClick={() => navigate('/login')}
                    className="btn-primary flex items-center space-x-2"
                  >
                    <LogIn className="w-4 h-4" />
                    <span>{t('nav.login')}</span>
                  </button>
                  <button
                    onClick={() => navigate('/admin/login')}
                    className="px-4 py-2 rounded-lg font-medium text-gray-600 hover:bg-gray-100 transition-colors flex items-center space-x-2"
                  >
                    <KeyRound className="w-4 h-4" />
                    <span>{t('nav.admin')}</span>
                  </button>
                </div>
              )}
            </nav>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="py-20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h1 className="text-5xl font-bold text-gray-900 mb-6">
            {t('hero.title')}
          </h1>
          <p className="text-xl text-gray-600 mb-10 max-w-3xl mx-auto">
            {t('hero.description')}
          </p>
          {!currentUser && (
            <div className="flex justify-center gap-4">
              <button
                onClick={() => navigate('/login')}
                className="btn-primary flex items-center space-x-2 px-8 py-3 text-lg"
              >
                <Users className="w-5 h-5" />
                <span>{t('hero.userLogin')}</span>
                <ArrowRight className="w-5 h-5" />
              </button>
              <button
                onClick={() => navigate('/admin/login')}
                className="px-8 py-3 text-lg border-2 border-gray-600 text-gray-600 font-semibold rounded-lg hover:bg-gray-50 transition-colors flex items-center space-x-2"
              >
                <Shield className="w-5 h-5" />
                <span>{t('hero.adminLogin')}</span>
              </button>
            </div>
          )}
          {currentUser && currentUser.role === 'admin' && (
            <div className="flex justify-center space-x-4">
              <button
                onClick={() => navigate('/user/dashboard')}
                className="btn-primary flex items-center space-x-2 px-8 py-3 text-lg"
              >
                <Users className="w-5 h-5" />
                <span>{t('welcome.userCenter')}</span>
              </button>
              <button
                onClick={() => navigate('/admin/dashboard')}
                className="px-8 py-3 text-lg border-2 border-primary-600 text-primary-600 font-semibold rounded-lg hover:bg-primary-50 transition-colors flex items-center space-x-2"
              >
                <Shield className="w-5 h-5" />
                <span>{t('admin.adminCenter')}</span>
              </button>
            </div>
          )}
          {currentUser && currentUser.role === 'user' && (
            <div className="flex justify-center space-x-4">
              <button
                onClick={() => navigate('/user/dashboard')}
                className="btn-primary flex items-center space-x-2 px-8 py-3 text-lg"
              >
                <ArrowRight className="w-5 h-5" />
                <span>{t('hero.enterConsole')}</span>
              </button>
            </div>
          )}
        </div>
      </section>

      {/* Features Section */}
      <section className="py-16 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <h2 className="text-3xl font-bold text-center text-gray-900 mb-12">
            {t('features.title')}
          </h2>
          <div className="grid md:grid-cols-3 gap-8">
            <div className="card text-center hover:shadow-lg transition-shadow">
              <div className="w-16 h-16 bg-primary-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <Bot className="w-8 h-8 text-primary-600" />
              </div>
              <h3 className="text-xl font-semibold text-gray-900 mb-2">{t('features.agentManagement.title')}</h3>
              <p className="text-gray-600">
                {t('features.agentManagement.description')}
              </p>
            </div>
            <div className="card text-center hover:shadow-lg transition-shadow">
              <div className="w-16 h-16 bg-primary-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <Shield className="w-8 h-8 text-primary-600" />
              </div>
              <h3 className="text-xl font-semibold text-gray-900 mb-2">{t('features.multiModel.title')}</h3>
              <p className="text-gray-600">
                {t('features.multiModel.description')}
              </p>
            </div>
            <div className="card text-center hover:shadow-lg transition-shadow">
              <div className="w-16 h-16 bg-primary-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <Users className="w-8 h-8 text-primary-600" />
              </div>
              <h3 className="text-xl font-semibold text-gray-900 mb-2">{t('features.userManagement.title')}</h3>
              <p className="text-gray-600">
                {t('features.userManagement.description')}
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-gray-900 text-white py-8">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <p className="text-gray-400">
            © 2025 Agent Manager. All rights reserved.
          </p>
        </div>
      </footer>
    </div>
  )
}

export default LandingPage
