/**
 * SkillTagsList — tags list with overflow dropdown (aligned with ComputeNest SkillTagsList)
 * Visible tags shown inline; overflow tags folded into "..." dropdown
 */
import React, { useState, useRef, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { SkillTag } from './SkillTag'
import { SKILL_TAG_I18N_KEYS } from './constants'

const DEFAULT_MAX_VISIBLE_TAGS = 3

interface SkillTagsListProps {
  tags?: string[]
  maxVisibleTags?: number
}

export const SkillTagsList: React.FC<SkillTagsListProps> = ({
  tags,
  maxVisibleTags = DEFAULT_MAX_VISIBLE_TAGS,
}) => {
  const { t } = useTranslation('admin')
  const [showDropdown, setShowDropdown] = useState(false)

  if (!tags || tags.length === 0) return null

  const visibleTags = tags.slice(0, maxVisibleTags)
  const remainingTags = tags.slice(maxVisibleTags)

  const getTagLabel = (tag: string) => {
    const i18nKey = SKILL_TAG_I18N_KEYS[tag]
    return i18nKey ? t(i18nKey) : tag
  }

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {visibleTags.map(tag => (
        <SkillTag key={tag}>{getTagLabel(tag)}</SkillTag>
      ))}
      {remainingTags.length > 0 && (
        <div className="relative">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setShowDropdown(prev => !prev) }}
            className="inline-flex items-center justify-center w-6 h-6 rounded-full border border-[#d9d9d9] bg-white text-xs text-[rgba(0,0,0,0.65)] hover:border-[#1890ff] hover:text-[#1890ff] transition-colors cursor-pointer"
          >
            ...
          </button>
          {showDropdown && (
            <div
              className="absolute left-0 top-full mt-1 bg-white border border-[#e8e8e8] rounded-lg shadow-lg py-1 z-50 min-w-[120px]"
              onClick={e => e.stopPropagation()}
            >
              {remainingTags.map(tag => (
                <div key={tag} className="px-3 py-1.5 text-sm text-[rgba(0,0,0,0.85)] hover:bg-[#e6f7ff] cursor-pointer whitespace-nowrap">
                  {getTagLabel(tag)}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
