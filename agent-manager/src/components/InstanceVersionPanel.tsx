import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'

type VersionPanelState =
  | 'upgrade-available'
  | 'upgrade-blocked'
  | 'up-to-date'
  | 'no-version'

interface InstanceVersionPanelProps {
  agentImage?: string | null
  agentVersion?: string | null
  templateId?: string | null
  namespace?: string | null
  sandboxUpgrade?: {
    CanUpgrade: boolean
    Reason: string
    AgentTypeId?: string | null
    SandboxName?: string | null
    CurrentImage: string | null
    TargetImage: string | null
    SandboxSetName?: string | null
    Error?: string | null
  } | null
}

function getVersionPanelState({
  currentImage,
  targetImage,
  canUpgrade,
  targetUnavailable
}: {
  currentImage: string
  targetImage: string
  canUpgrade: boolean
  targetUnavailable: boolean
}): VersionPanelState {
  if (!currentImage) return 'no-version'
  if (canUpgrade && targetImage && currentImage !== targetImage) return 'upgrade-available'
  if (targetImage && currentImage !== targetImage && !canUpgrade && !targetUnavailable) return 'upgrade-blocked'
  if (targetImage && currentImage === targetImage) return 'up-to-date'
  if (targetUnavailable) return 'no-version'
  return 'up-to-date'
}

function inferVersionFromImage(image?: string | null) {
  if (!image) return ''
  const imageParts = image.split(':')
  return imageParts.length > 1 ? imageParts[imageParts.length - 1] : ''
}

export default function InstanceVersionPanel({
  agentImage,
  agentVersion,
  templateId,
  namespace,
  sandboxUpgrade
}: InstanceVersionPanelProps) {
  const { t } = useTranslation('admin')
  const navigate = useNavigate()

  const resolvedTemplateId = templateId || 'openclaw'
  const resolvedNamespace = namespace || 'default'
  const currentImage = sandboxUpgrade?.CurrentImage || agentImage || ''
  const targetImage = sandboxUpgrade?.TargetImage || ''
  const resolvedAgentVersion = agentVersion || inferVersionFromImage(currentImage) || ''
  const targetVersion = inferVersionFromImage(targetImage)
  const upgradeAgentTypeId = sandboxUpgrade?.AgentTypeId || ''
  const upgradeSandboxName = sandboxUpgrade?.SandboxName || ''
  const targetUnavailable = sandboxUpgrade?.Reason === 'NO_TARGET_IMAGE' || sandboxUpgrade?.Reason === 'TARGET_UNAVAILABLE'
  const upgradeBlockedHint = sandboxUpgrade?.Reason === 'NO_BACKUP_MOUNT'
    ? t('instanceVersionPanel.upgradeBlocked.legacyInstanceHint')
    : t('instanceVersionPanel.upgradeBlocked.hint')

  const goToUpgrade = () => {
    if (!upgradeAgentTypeId) return
    const params = new URLSearchParams({ agentTypeId: upgradeAgentTypeId })
    if (upgradeSandboxName) params.set('selectedSandbox', upgradeSandboxName)
    navigate(`/admin/instance-upgrades?${params.toString()}`)
  }

  const state = getVersionPanelState({
    currentImage,
    targetImage,
    canUpgrade: Boolean(sandboxUpgrade?.CanUpgrade),
    targetUnavailable
  })

  return (
    <div className="space-y-6">
      <div className="card">
        <div className="flex items-center space-x-2 mb-4">
          <h2 className="text-xl font-semibold text-gray-900">{t('instanceVersionPanel.title')}</h2>
          <span className={`status-badge ml-auto ${
            state === 'upgrade-available' ? 'bg-amber-100 text-amber-800' :
            state === 'upgrade-blocked' ? 'bg-red-100 text-red-800' :
            state === 'up-to-date' ? 'bg-green-100 text-green-800' :
            'bg-gray-100 text-gray-600'
          }`}>
            {state === 'upgrade-available' && t('instanceVersionPanel.state.upgradeAvailable')}
            {state === 'upgrade-blocked' && t('instanceVersionPanel.state.upgradeBlocked')}
            {state === 'up-to-date' && t('instanceVersionPanel.state.upToDate')}
            {state === 'no-version' && t('instanceVersionPanel.state.noVersion')}
          </span>
        </div>

        {state === 'upgrade-available' && (
          <>
            <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4">
              <p className="text-sm font-medium text-amber-800">{t('instanceVersionPanel.upgradeAvailable.detected', { from: resolvedAgentVersion || '-', to: targetVersion || '-' })}</p>
              <p className="mt-1 text-xs text-amber-700">{t('instanceVersionPanel.upgradeAvailable.hint')}</p>
            </div>
            <VersionGrid agentImage={currentImage} templateId={resolvedTemplateId} namespace={resolvedNamespace} />
            <ComparePanel agentImage={currentImage} templateImage={targetImage} />
            <div className="flex items-center space-x-3 pt-4 border-t border-gray-100">
              <button
                type="button"
                onClick={goToUpgrade}
                disabled={!upgradeAgentTypeId}
                className="btn-primary disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t('instanceVersionPanel.upgradeAvailable.upgradeToLatest')}
              </button>
            </div>
          </>
        )}

        {state === 'upgrade-blocked' && (
          <>
            <div className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4">
              <p className="text-sm font-medium text-red-800">{t('instanceVersionPanel.upgradeBlocked.title')}</p>
              <p className="mt-1 text-xs text-red-700">{upgradeBlockedHint}</p>
            </div>
            <VersionGrid agentImage={currentImage} templateId={resolvedTemplateId} namespace={resolvedNamespace} />
            <ComparePanel agentImage={currentImage} templateImage={targetImage} />
          </>
        )}

        {state === 'up-to-date' && (
          <VersionGrid agentImage={targetImage || currentImage} templateId={resolvedTemplateId} namespace={resolvedNamespace} />
        )}

        {state === 'no-version' && (
          <>
            <div className="mb-6 rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-700">
              {t('instanceVersionPanel.noVersion.hint')}
            </div>
            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('instanceVersionPanel.noVersion.agentImage')}</label>
                <p className="text-sm italic text-gray-400">{t('instanceVersionPanel.noVersion.notRecorded')}</p>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function VersionGrid({
  agentImage,
  templateId,
  namespace
}: {
  agentImage: string
  templateId: string
  namespace: string
}) {
  const { t } = useTranslation('admin')
  return (
    <div className="grid grid-cols-1 gap-6 mb-6 md:grid-cols-2 xl:grid-cols-3">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">{t('instanceVersionPanel.grid.agentImage')}</label>
        <p className="break-all font-mono text-sm text-gray-900">{agentImage}</p>
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">{t('instanceVersionPanel.grid.sandboxTemplate')}</label>
        <p className="font-mono text-sm text-gray-900">{templateId}</p>
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">{t('instanceVersionPanel.grid.namespace')}</label>
        <p className="font-mono text-sm text-gray-900">{namespace}</p>
      </div>
    </div>
  )
}

function ComparePanel({
  agentImage,
  templateImage
}: {
  agentImage: string
  templateImage: string
}) {
  const { t } = useTranslation('admin')
  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 mb-6">
      <h3 className="mb-3 text-sm font-semibold text-gray-900">{t('instanceVersionPanel.compare.title')}</h3>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-gray-400">{t('instanceVersionPanel.compare.instanceSnapshot')}</p>
          <p className="mt-2 font-mono text-sm text-gray-900">image={agentImage}</p>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-gray-400">{t('instanceVersionPanel.compare.currentTemplate')}</p>
          <p className="mt-2 font-mono text-sm text-gray-900">image={templateImage}</p>
        </div>
      </div>
    </div>
  )
}
