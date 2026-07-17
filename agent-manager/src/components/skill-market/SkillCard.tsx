/**
 * SkillCard — skill card component with Avatar + hover clone button
 * Aligned with ComputeNest SkillCard + SkillInfo + SkillCardFooter
 */
import React, { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download } from 'lucide-react'
import { getSkillDisplayName, type SkillItem } from '../../lib/computenest-api'
import { generateSoftColorFromString, generateDarkerTextColor, formatUpdateTime } from './utils'
import { SkillTagsList } from './SkillTagsList'

interface SkillCardProps {
  skill: SkillItem
  isCustomSkill?: boolean
  onClone?: (skill: SkillItem) => void
  onInstall?: (skill: SkillItem) => void
  installLabel?: string
  onClick?: () => void
}

export const SkillCard: React.FC<SkillCardProps> = ({
  skill,
  isCustomSkill = false,
  onClone,
  onInstall,
  installLabel,
  onClick,
}) => {
  const { t } = useTranslation('admin')
  const [isHovered, setIsHovered] = useState(false)

  // Generate avatar color from display name
  const displayName = getSkillDisplayName(skill)
  const avatarBgColor = useMemo(
    () => generateSoftColorFromString(displayName),
    [displayName],
  )
  const avatarTextColor = useMemo(
    () => generateDarkerTextColor(avatarBgColor),
    [avatarBgColor],
  )

  const handleClone = (e: React.MouseEvent) => {
    e.stopPropagation()
    onClone?.(skill)
  }

  const handleCardClick = () => {
    onClick?.()
  }

  const showPersistentInstall = Boolean(onInstall && !onClick && !onClone)

  const handleInstall = (e: React.MouseEvent) => {
    e.stopPropagation()
    onInstall?.(skill)
  }

  return (
    <div
      className={`group relative rounded-lg border border-[#e8e8e8] p-5 min-h-[160px] hover:shadow-[0_4px_12px_rgba(0,0,0,0.1)] transition-all duration-300 flex flex-col ${onClick ? 'cursor-pointer' : ''}`}
      onClick={handleCardClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Header: Avatar + Name + Description */}
      <div className="flex gap-3 mb-4 flex-1">
        {/* Avatar (official skills only) */}
        {!isCustomSkill && (
          <div
            className="shrink-0 w-12 h-12 rounded-[10px] font-medium flex items-center justify-center text-base"
            style={{ backgroundColor: avatarBgColor, color: avatarTextColor }}
          >
            {getSkillDisplayName(skill).charAt(0)?.toUpperCase() || 'S'}
          </div>
        )}

        {/* Name + Description */}
        <div className="flex-1 min-w-0 flex flex-col gap-2">
          <div className="text-base font-medium text-[#262626] leading-6 truncate" title={getSkillDisplayName(skill)}>
            {getSkillDisplayName(skill)}
          </div>
          <span className="text-xs text-[rgba(0,0,0,0.45)] truncate">{skill.skillName}</span>
          <div className="text-sm text-[#8c8c8c] leading-5 line-clamp-2 break-words" title={skill.skillDescription}>
            {skill.skillDescription}
          </div>
        </div>
      </div>

      {/* Footer: Tags + UpdateTime + CloneButton (hover only, aligned with ComputeNest) */}
      <div className="flex justify-between items-center min-h-[32px] mt-auto relative">
        {/* Tags — overflow folded into dropdown */}
        <div className={`transition-all duration-300 ${isHovered ? 'opacity-60 blur-[1px]' : ''}`}>
          <SkillTagsList tags={skill.skillLabels} />
        </div>

        {/* Update time — hidden on hover */}
        {!isHovered && !showPersistentInstall && skill.updateTime && (
          <div className="text-xs text-[#bfbfbf] leading-5 absolute right-0">
            {t('skillSpace.updatedAt')}: {formatUpdateTime(skill.updateTime)}
          </div>
        )}

        {/* Clone button — visible on hover */}
        {(isHovered || showPersistentInstall) && (onInstall || onClone) && (
          <div className="absolute right-0 flex items-center gap-2">
            {onClone && (
              <button onClick={handleClone} className="rounded border border-[#1890ff] bg-white px-3 py-1 text-sm text-[#1890ff] hover:bg-blue-50">
                {t('skillSpace.cloneButton')}
              </button>
            )}
            {onInstall && (
              <button onClick={handleInstall} className="inline-flex items-center gap-1.5 rounded bg-[#1890ff] px-3 py-1 text-sm text-white hover:bg-[#40a9ff] active:bg-[#096dd9]">
                <Download className="h-3.5 w-3.5" />
                {installLabel || t('skillInstall.installToInstance')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
