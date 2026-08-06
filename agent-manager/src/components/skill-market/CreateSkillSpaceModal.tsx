/**
 * CreateSkillSpaceModal — create a new skill space
 * Aligned with ComputeNest CreateSkillSpaceModal
 */
import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, X } from 'lucide-react'

interface CreateSkillSpaceModalProps {
  onClose: () => void
  onSubmit: (values: { skillSpaceName: string; skillSpaceDescription: string }) => Promise<void>
  loading: boolean
}

export const CreateSkillSpaceModal: React.FC<CreateSkillSpaceModalProps> = ({
  onClose,
  onSubmit,
  loading,
}) => {
  const { t } = useTranslation('admin')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  const handleSubmit = async () => {
    if (!name.trim() || !description.trim()) return
    await onSubmit({
      skillSpaceName: name.trim(),
      skillSpaceDescription: description.trim(),
    })
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-900">{t('skillSpace.createSpaceModal.title')}</h3>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t('skillSpace.createSpaceModal.nameLabel')} <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={t('skillSpace.createSpaceModal.namePlaceholder')}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-1 focus:ring-[#1890ff] focus:border-[#1890ff]"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t('skillSpace.createSpaceModal.descLabel')} <span className="text-red-500">*</span>
            </label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              rows={3}
              placeholder={t('skillSpace.createSpaceModal.descPlaceholder')}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-1 focus:ring-[#1890ff] focus:border-[#1890ff]"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              onClick={onClose}
              className="px-4 py-1.5 text-sm border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
            >
              {t('skillSpace.createSpaceModal.cancel')}
            </button>
            <button
              onClick={handleSubmit}
              disabled={loading || !name.trim() || !description.trim()}
              className="px-4 py-1.5 text-sm bg-[#1890ff] text-white rounded-lg hover:bg-[#40a9ff] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin inline" /> : t('skillSpace.createSpaceModal.ok')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}