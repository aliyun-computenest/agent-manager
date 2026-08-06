/**
 * CloneSkillModal — clone a skill to a target skill space
 * Aligned with ComputeNest CloneSkillModal
 */
import React, { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, X, ChevronDown, Check } from 'lucide-react'
import toast from 'react-hot-toast'
import { listSkillSpaces, createSkill, getSkillDisplayName } from '../../lib/computenest-api'
import type { SkillItem, SkillSpaceItem } from '../../lib/computenest-api'

interface CloneSkillModalProps {
  skill: SkillItem
  token: string
  isCustomSkill?: boolean
  onClose: () => void
  onSuccess: () => void
}

export const CloneSkillModal: React.FC<CloneSkillModalProps> = ({
  skill,
  token,
  isCustomSkill = false,
  onClose,
  onSuccess,
}) => {
  const { t } = useTranslation('admin')
  const [skillName, setSkillName] = useState(skill.skillName || '')
  const [skillDisplayName, setSkillDisplayName] = useState(getSkillDisplayName(skill))
  const [skillDescription, setSkillDescription] = useState(skill.skillDescription || '')
  const [skillSpaceId, setSkillSpaceId] = useState(isCustomSkill ? skill.skillSpaceId || '' : '')
  const [spaces, setSpaces] = useState<SkillSpaceItem[]>([])
  const [loading, setLoading] = useState(false)
  const [loadingSpaces, setLoadingSpaces] = useState(false)
  const [spaceDropdownOpen, setSpaceDropdownOpen] = useState(false)
  const spaceDropdownRef = useRef<HTMLDivElement>(null)

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (spaceDropdownRef.current && !spaceDropdownRef.current.contains(e.target as Node)) {
        setSpaceDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Load available skill spaces
  useEffect(() => {
    if (!isCustomSkill) {
      setLoadingSpaces(true)
      listSkillSpaces(token, { maxResults: 100 })
        .then(res => setSpaces(res.skillSpaces ?? []))
        .catch(() => {})
        .finally(() => setLoadingSpaces(false))
    }
  }, [token, isCustomSkill])

  const handleSubmit = async () => {
    if (!skillName.trim() || !skillSpaceId) return
    setLoading(true)
    try {
      await createSkill(token, skillSpaceId, {
        sourceType: 'COPY',
        skillName: skillName.trim(),
        skillDisplayName: skillDisplayName.trim(),
        skillDescription: skillDescription.trim(),
        sourceSkillId: skill.skillId,
      })
      onSuccess()
      onClose()
    } catch (e: any) {
      const msg = e?.message || t('skillSpace.cloneFailed')
      toast.error(msg)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-900">{t('skillSpace.cloneModal.title')}</h3>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-4">
          {/* Skill identifier (not auto-filled, user must input manually) */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t('skillSpace.skillIdentifier')} <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={skillName}
              onChange={e => setSkillName(e.target.value)}
              placeholder={t('skillSpace.skillIdentifierPlaceholder')}
              maxLength={64}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-1 focus:ring-[#1890ff] focus:border-[#1890ff]"
            />
          </div>

          {/* Skill display name (auto-filled from source skill) */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t('skillSpace.skillDisplayName')} <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={skillDisplayName}
              onChange={e => setSkillDisplayName(e.target.value)}
              placeholder={t('skillSpace.skillDisplayNamePlaceholder')}
              maxLength={64}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-1 focus:ring-[#1890ff] focus:border-[#1890ff]"
            />
          </div>

          {/* Skill description */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t('skillSpace.skillDescription')} <span className="text-red-500">*</span>
            </label>
            <textarea
              value={skillDescription}
              onChange={e => setSkillDescription(e.target.value)}
              rows={3}
              placeholder={t('skillSpace.cloneModal.skillDescPlaceholder')}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-1 focus:ring-[#1890ff] focus:border-[#1890ff]"
            />
          </div>

          {/* Target skill space */}
          {!isCustomSkill && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {t('skillSpace.cloneModal.skillSpace')} <span className="text-red-500">*</span>
              </label>
              <div ref={spaceDropdownRef} className="relative">
                <button
                  type="button"
                  onClick={() => setSpaceDropdownOpen(v => !v)}
                  className="w-full flex items-center justify-between border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-1 focus:ring-[#1890ff] focus:border-[#1890ff] bg-white"
                >
                  <span className={skillSpaceId ? 'text-gray-900' : 'text-gray-400'}>
                    {skillSpaceId ? spaces.find(s => s.skillSpaceId === skillSpaceId)?.skillSpaceName : t('skillSpace.cloneModal.skillSpacePlaceholder')}
                  </span>
                  <ChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0" />
                </button>
                {spaceDropdownOpen && (
                  <div className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                    {loadingSpaces ? (
                      <div className="px-3 py-2 text-sm text-gray-400 flex items-center gap-2">
                        <Loader2 className="w-3 h-3 animate-spin" /> Loading...
                      </div>
                    ) : spaces.length === 0 ? (
                      <div className="px-3 py-2 text-sm text-gray-400">No skill spaces</div>
                    ) : (
                      spaces.map(s => (
                        <button
                          key={s.skillSpaceId}
                          type="button"
                          onClick={() => { setSkillSpaceId(s.skillSpaceId); setSpaceDropdownOpen(false) }}
                          className={`w-full flex items-center justify-between px-3 py-1.5 text-sm text-left hover:bg-blue-50 ${skillSpaceId === s.skillSpaceId ? 'bg-blue-50 text-[#1890ff]' : 'text-gray-700'}`}
                        >
                          <span className="truncate">{s.skillSpaceName}</span>
                          {skillSpaceId === s.skillSpaceId && <Check className="w-3.5 h-3.5 flex-shrink-0" />}
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-2">
            <button
              onClick={handleSubmit}
              disabled={loading || !skillName.trim() || !skillSpaceId}
              className="px-4 py-1.5 text-sm bg-[#1890ff] text-white rounded-lg hover:bg-[#40a9ff] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin inline" /> : t('skillSpace.cloneModal.ok')}
            </button>
            <button
              onClick={onClose}
              className="px-4 py-1.5 text-sm border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
            >
              {t('skillSpace.cloneModal.cancel')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}