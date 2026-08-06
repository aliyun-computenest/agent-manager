/**
 * SkillSpaceCard — skill space card for CustomSpacesTab
 * Aligned with ComputeNest SkillSpaceCard
 */
import React from 'react'
import { Download } from 'lucide-react'
import type { SkillSpaceItem } from '../../lib/computenest-api'

interface SkillSpaceCardProps {
  space: SkillSpaceItem
  onClick: () => void
  onInstall?: (space: SkillSpaceItem) => void
  installLabel?: string
}

export const SkillSpaceCard: React.FC<SkillSpaceCardProps> = ({
  space,
  onClick,
  onInstall,
  installLabel,
}) => {
  const handleInstall = (event: React.MouseEvent) => {
    event.stopPropagation()
    onInstall?.(space)
  }

  return (
    <div
      className="min-h-[120px] rounded border border-[#e8e8e8] px-6 py-5 hover:shadow-[0_2px_8px_rgba(0,0,0,0.15)] transition-all duration-300 cursor-pointer flex flex-col gap-2"
      onClick={onClick}
    >
      <div className="text-base font-medium text-[rgba(0,0,0,0.88)] leading-6 truncate" title={space.skillSpaceName}>
        {space.skillSpaceName}
      </div>
      <div className="text-sm text-[rgba(0,0,0,0.65)] leading-[22px] line-clamp-2 break-words" title={space.skillSpaceDescription}>
        {space.skillSpaceDescription}
      </div>
      {onInstall && (
        <div className="mt-auto flex justify-end pt-2">
          <button type="button" onClick={handleInstall} className="inline-flex items-center gap-1.5 rounded bg-[#1890ff] px-3 py-1.5 text-sm text-white hover:bg-[#40a9ff]">
            <Download className="h-3.5 w-3.5" />
            {installLabel}
          </button>
        </div>
      )}
    </div>
  )
}
