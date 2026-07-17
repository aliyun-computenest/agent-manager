/**
 * SettingsTab — Read-only SkillHub config display
 * Reads config from ComputeNest; configuration must be done on the ComputeNest side.
 */
import React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle } from 'lucide-react'
import type { SkillHubConfigResponse } from '../../lib/computenest-api'

interface SettingsTabProps {
  hubConfig: SkillHubConfigResponse | null
}

export const SettingsTab: React.FC<SettingsTabProps> = ({
  hubConfig,
}) => {
  const { t } = useTranslation('admin')

  const configured = hubConfig?.configured
  const existingRegionId = hubConfig?.hubConfig?.ossRegionId
  const existingBucketName = hubConfig?.hubConfig?.ossBucketName

  // Not configured — show guidance alert
  if (!configured) {
    return (
      <div className="max-w-[800px] py-6">
        <div className="rounded-lg border border-orange-200 bg-orange-50 px-4 py-3 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-orange-500 mt-0.5 shrink-0" />
          <div className="text-sm">
            <p className="font-medium text-orange-800">{t('skillSpace.configNotInitializedAlert')}</p>
            <p className="mt-1 text-orange-700">{t('skillSpace.configNotInitializedDesc')}</p>
          </div>
        </div>
      </div>
    )
  }

  // Configured — show Descriptions (aligned with ComputeNest)
  return (
    <div className="max-w-[800px] py-6">
      <h3 className="text-base font-medium text-gray-900 mb-4">{t('skillSpace.skillHubConfig')}</h3>
      <div className="grid grid-cols-2 gap-4 text-sm">
        <div>
          <span className="text-gray-500">{t('skillSpace.ossRegionId')}</span>
          <p className="font-medium text-gray-900 mt-1">{existingRegionId || '-'}</p>
        </div>
        <div>
          <span className="text-gray-500">{t('skillSpace.ossBucketName')}</span>
          <p className="font-medium text-gray-900 mt-1">{existingBucketName || '-'}</p>
        </div>
      </div>
    </div>
  )
}