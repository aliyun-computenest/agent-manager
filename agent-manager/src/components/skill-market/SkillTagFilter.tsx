/**
 * SkillTagFilter — tag filter row for official skills tab
 * Aligned with ComputeNest SkillTagFilter
 */
import React from 'react'
import { useTranslation } from 'react-i18next'
import { SkillTag } from './SkillTag'
import { SKILL_TAG_CODES, SKILL_TAG_I18N_KEYS, type SkillTagCode } from './constants'

interface SkillTagFilterProps {
  selectedTag: SkillTagCode | null
  onTagClick: (tagCode: SkillTagCode | null) => void
}

export const SkillTagFilter: React.FC<SkillTagFilterProps> = ({
  selectedTag,
  onTagClick,
}) => {
  const { t } = useTranslation('admin')

  return (
    <div className="flex flex-wrap gap-3 py-3">
      {/* Category tags — aligned with ComputeNest: no "全部" tag */}
      {Object.entries(SKILL_TAG_CODES).map(([, code]) => (
        <SkillTag
          key={code}
          checked={selectedTag === code}
          onClick={() => onTagClick(selectedTag === code ? null : code)}
        >
          {t(SKILL_TAG_I18N_KEYS[code])}
        </SkillTag>
      ))}
    </div>
  )
}
