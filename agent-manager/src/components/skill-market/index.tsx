/**
 * SkillMarket — page shell with Tab routing + HubConfig
 * Aligned with ComputeNest SkillMarket/index.tsx
 */
import React, { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../contexts/AuthContext'
import toast from 'react-hot-toast'
import { Loader2 } from 'lucide-react'
import { getSkillHubConfig } from '../../lib/computenest-api'
import type { SkillHubConfigResponse } from '../../lib/computenest-api'
import type { SkillItem, SkillSpaceItem } from '../../lib/computenest-api'
import { OfficialSkillsTab } from './OfficialSkillsTab'
import { CustomSkillSpacesTab } from './CustomSkillSpacesTab'
import { SettingsTab } from './SettingsTab'
import { type TabId } from './constants'
import { InstallToInstanceModal } from './InstallToInstanceModal'
import { InstallSkillModal } from './InstallSkillModal'

const TAB_KEYS: TabId[] = ['official', 'custom', 'settings']

interface SkillMarketProps {
  mode?: 'admin' | 'user'
}

export default function SkillMarket({ mode = 'admin' }: SkillMarketProps) {
  const isUserView = mode === 'user'
  const { t } = useTranslation(isUserView ? 'user' : 'admin')
  const { session } = useAuth()
  const token = session?.access_token || ''

  const [searchParams, setSearchParams] = useSearchParams()
  const [hubConfig, setHubConfig] = useState<SkillHubConfigResponse | null>(null)
  const [loadingHub, setLoadingHub] = useState(!isUserView)
  const [installSkill, setInstallSkill] = useState<SkillItem | null>(null)
  const [installSpace, setInstallSpace] = useState<SkillSpaceItem | null>(null)

  // Derive active tab from URL query param, fallback to 'official'
  const tabParam = searchParams.get('tab') as TabId | null
  const allowedTabs = isUserView ? TAB_KEYS.filter(tab => tab !== 'settings') : TAB_KEYS
  const activeTab: TabId = allowedTabs.includes(tabParam!) ? tabParam! : 'official'

  // Load SkillHub config on mount
  useEffect(() => {
    if (!token) return
    if (isUserView) {
      setLoadingHub(false)
      return
    }
    setLoadingHub(true)
    getSkillHubConfig(token)
      .then(data => {
        setHubConfig(data)
      })
      .catch(() => toast.error(t('skillSpace.hubConfigLoadFailed')))
      .finally(() => setLoadingHub(false))
  }, [isUserView, token]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleTabChange = (tab: TabId) => {
    setSearchParams({ tab }, { replace: true })
  }

  const hubConfigured = isUserView || (hubConfig?.configured ?? false)
  const configLoading = loadingHub

  const tabs: { id: TabId; label: string }[] = isUserView
    ? [
        { id: 'official', label: t('skillMarket.tabOfficial') },
        { id: 'custom', label: t('skillMarket.tabSpaces') },
      ]
    : [
        { id: 'official', label: t('skillSpace.tabOfficial') },
        { id: 'custom', label: t('skillSpace.tabCustom') },
        { id: 'settings', label: t('skillSpace.tabSettings') },
      ]

  return (
    <div className="bg-white rounded-xl min-h-[calc(100vh-165px)] px-6 py-5">
      {/* Page title */}
      <h2 className="mb-4 text-lg font-semibold text-gray-900">{isUserView ? t('skillMarket.title') : t('skillSpace.title')}</h2>

      {/* Tab navigation — blue underline style matching ComputeNest */}
      <div className="flex border-b border-gray-200 mb-0">
        {tabs.map(tab => {
          const isActive = activeTab === tab.id
          const isDisabled = tab.id === 'custom' && !hubConfigured && !configLoading
          return (
            <button
              key={tab.id}
              onClick={() => !isDisabled && handleTabChange(tab.id)}
              disabled={isDisabled}
              className={`px-4 py-2.5 text-sm border-b-2 transition-colors whitespace-nowrap ${
                isActive
                  ? 'border-[#1890ff] text-[#1890ff] font-medium'
                  : isDisabled
                    ? 'border-transparent text-gray-300 cursor-not-allowed'
                    : 'border-transparent text-[rgba(0,0,0,0.65)] hover:text-[#1890ff]'
              }`}
              title={isDisabled ? t('skillSpace.hubNotConfiguredHint') : undefined}
            >
              {tab.label}
            </button>
          )
        })}
      </div>

      {/* Tab content */}
      {loadingHub ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
        </div>
      ) : (
        <>
          {activeTab === 'official' && (
            <OfficialSkillsTab
              token={token}
              hubConfigured={hubConfigured}
              readOnly={isUserView}
              onInstall={setInstallSkill}
              installLabel={t('skillInstall.installToInstance')}
            />
          )}
          {activeTab === 'custom' && (
            <CustomSkillSpacesTab
              token={token}
              hubConfigured={hubConfigured}
              readOnly={isUserView}
              onInstall={setInstallSpace}
              installLabel={t('skillInstall.selectAndInstall')}
            />
          )}
          {activeTab === 'settings' && (
            <SettingsTab hubConfig={hubConfig} />
          )}
        </>
      )}

      {installSkill && (
        <InstallToInstanceModal
          token={token}
          skills={[installSkill]}
          isAdminView={!isUserView}
          translationNamespace={isUserView ? 'user' : 'admin'}
          onClose={() => setInstallSkill(null)}
        />
      )}
      {installSpace && (
        <InstallSkillModal
          token={token}
          initialSkillSpace={installSpace}
          isAdminView={!isUserView}
          translationNamespace={isUserView ? 'user' : 'admin'}
          onClose={() => setInstallSpace(null)}
        />
      )}
    </div>
  )
}
