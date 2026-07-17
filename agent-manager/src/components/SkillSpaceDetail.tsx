/**
 * SkillSpaceDetail — aligned with ComputeNest SkillSpaceDetail
 * Layout: Back arrow + title | search + create + delete-space icon
 * Skill cards: hover to show edit/delete, tags footer
 *
 * CreateSkillDialog: two-step modal aligned with ComputeNest
 * Step 1: Select source type (UPLOAD / COPY) — Radio card style
 * Step 2: Fill form based on source type
 *   - UPLOAD: upload file → show "安全检测" button (manual trigger) → create
 *   - COPY: select official skill → auto-fill name/desc → create
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../contexts/AuthContext'
import toast from 'react-hot-toast'
import {
  Loader2, Search, Plus, Trash2, ArrowLeft, Layers,
  Upload, Copy, Inbox, X, ShieldCheck, ShieldAlert, File, AlertCircle, Info, ChevronDown,
} from 'lucide-react'
import {
  getSkillSpace, listSkills, createSkill, deleteSkill, deleteSkillSpace,
  createSkillFileDetect, pollFileDetectResult, listOfficialSkills, uploadSkillFile,
  listSkillSpaces, updateSkill, getSkillDisplayName,
  type SkillSpaceItem, type SkillItem,
} from '../lib/computenest-api'
import { SkillTag } from './skill-market/SkillTag'
import { SkillTagsList } from './skill-market/SkillTagsList'
import { SKILL_TAG_I18N_KEYS } from './skill-market/constants'

export default function SkillSpaceDetail() {
  const { skillSpaceId } = useParams<{ skillSpaceId: string }>()
  const { t } = useTranslation('admin')
  const { session } = useAuth()
  const token = session?.access_token || ''
  const navigate = useNavigate()

  const [space, setSpace] = useState<SkillSpaceItem | null>(null)
  const [skills, setSkills] = useState<SkillItem[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [keyword, setKeyword] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [editingSkill, setEditingSkill] = useState<SkillItem | null>(null)
  const [editingBasicInfo, setEditingBasicInfo] = useState<SkillItem | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [editMenuOpen, setEditMenuOpen] = useState<string | null>(null)
  // Delete confirmation dialog state (aligned with ComputeNest Modal.confirm)
  const [deleteConfirm, setDeleteConfirm] = useState<{
    type: 'space' | 'skill'
    title: string
    content: string
    onConfirm: () => void
  } | null>(null)

  const loadData = useCallback(async () => {
    if (!skillSpaceId) return
    setLoading(true)
    try {
      const [spaceRes, skillsRes] = await Promise.all([
        getSkillSpace(token, skillSpaceId),
        listSkills(token, skillSpaceId, { keyword: keyword || undefined, maxResults: 50 }),
      ])
      setSpace(spaceRes.skillSpace)
      setSkills(skillsRes.skills)
      setTotalCount(skillsRes.totalCount ?? skillsRes.skills.length)
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setLoading(false)
    }
  }, [token, skillSpaceId, keyword])

  useEffect(() => { loadData() }, [loadData])

  const handleDeleteSkill = (skillId: string, skillName: string) => {
    setDeleteConfirm({
      type: 'skill',
      title: t('skillSpace.confirmDeleteSkill', { name: skillName }),
      content: t('skillSpace.deleteSkillConfirmContent'),
      onConfirm: async () => {
        setDeleteConfirm(null)
        if (!skillSpaceId) return
        setDeleting(skillId)
        try {
          await deleteSkill(token, skillSpaceId, skillId)
          toast.success(t('skillSpace.deleteSkillSuccess'))
          loadData()
        } catch (e: any) {
          toast.error(e.message)
        } finally {
          setDeleting(null)
        }
      },
    })
  }

  const handleDeleteSpace = () => {
    if (!skillSpaceId || !space) return
    setDeleteConfirm({
      type: 'space',
      title: t('skillSpace.deleteSpaceConfirmTitle', { name: space.skillSpaceName }),
      content: t('skillSpace.deleteSpaceConfirmContent'),
      onConfirm: async () => {
        setDeleteConfirm(null)
        try {
          await deleteSkillSpace(token, skillSpaceId)
          toast.success(t('skillSpace.deleteSpaceSuccess'))
          navigate('/admin/skill-spaces?tab=custom')
        } catch (e: any) {
          toast.error(e.message)
        }
      },
    })
  }

  const handleSearch = () => {
    setKeyword(searchInput)
  }

  if (loading && !space) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
      </div>
    )
  }

  return (
    <div className="bg-white rounded-xl min-h-[calc(100vh-165px)] px-6 py-5">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
            <button onClick={() => navigate('/admin/skill-spaces?tab=custom')} className="text-[rgba(0,0,0,0.65)] hover:text-[#1890ff] transition-colors">
              <ArrowLeft className="w-5 h-5" />
            </button>
            {space?.skillSpaceName}
          </h2>
          {space?.skillSpaceDescription && (
            <p className="mt-1 ml-7 text-sm text-[rgba(0,0,0,0.45)]">{space.skillSpaceDescription}</p>
          )}
          {totalCount > 0 && (
            <div className="mt-1.5 ml-7 flex items-center gap-1 text-sm text-[rgba(0,0,0,0.45)]">
              <Layers className="w-3.5 h-3.5" />
              {t('skillSpace.skillCount', { count: totalCount })}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex w-[240px]">
            <input type="text" value={searchInput} onChange={e => setSearchInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleSearch()} placeholder={t('skillSpace.searchSkills')} className="flex-1 h-8 pl-3 pr-0 border border-r-0 border-gray-300 rounded-l text-sm focus:ring-1 focus:ring-[#1890ff] focus:border-[#1890ff]" />
            <button onClick={handleSearch} className="h-8 w-8 flex items-center justify-center border border-gray-300 rounded-r bg-white hover:bg-gray-50">
              <Search className="w-3.5 h-3.5 text-gray-500" />
            </button>
          </div>
          <button onClick={() => setShowCreateDialog(true)} className="h-8 px-4 bg-[#1890ff] text-white text-sm rounded hover:bg-[#40a9ff] flex items-center gap-1.5">
            <Plus className="w-3.5 h-3.5" />
            {t('skillSpace.createSkill')}
          </button>
          <button onClick={handleDeleteSpace} className="w-8 h-8 flex items-center justify-center text-[rgba(0,0,0,0.45)] hover:text-red-500 transition-colors" title={t('skillSpace.deleteSpaceConfirmOk')}>
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-gray-400" /></div>
      ) : skills.length === 0 ? (
        <div className="text-center py-8 text-gray-400">{t('skillSpace.noSkillsInSpace')}</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5 mt-2.5 mb-5">
          {skills.map(skill => (
            <div key={skill.skillId} className="rounded-lg border border-[#e8e8e8] px-5 py-5 hover:shadow-[0_4px_12px_rgba(0,0,0,0.1)] transition-all duration-300 cursor-pointer flex flex-col min-h-[160px]" onClick={() => navigate(`/admin/skill-spaces/skills/${skill.skillId}?skillSpaceId=${skillSpaceId}&skillSpaceName=${encodeURIComponent(space?.skillSpaceName || '')}&isCustomSkill=true`)} onMouseLeave={() => setEditMenuOpen(null)}>
              <div className="flex-1 min-w-0 flex flex-col gap-2">
                <h4 className="text-base font-medium text-[#262626] truncate">{getSkillDisplayName(skill)}</h4>
                <span className="text-xs text-[rgba(0,0,0,0.45)] truncate">{skill.skillName}</span>
                <p className="text-sm text-[#8c8c8c] line-clamp-2 break-words leading-5">{skill.skillDescription}</p>
              </div>
              <div className="flex items-center justify-between mt-auto pt-3">
                {/* Left: tags */}
                <div className="flex-1 min-w-0">
                  <SkillTagsList tags={skill.skillLabels || []} />
                </div>
                {/* Right: action buttons (always visible) */}
                <div className="flex items-center gap-2 flex-shrink-0">
                  {/* Edit dropdown menu */}
                  <div className="relative">
                    <button onClick={(e) => { e.stopPropagation(); setEditMenuOpen(editMenuOpen === skill.skillId ? null : skill.skillId) }}
                      className="px-3 py-1 text-sm border border-[#d9d9d9] rounded hover:border-[#1890ff] hover:text-[#1890ff] flex items-center gap-1">
                      {t('skillSpace.edit')}
                      <ChevronDown className="w-3 h-3" />
                    </button>
                    {editMenuOpen === skill.skillId && (
                      <div className="absolute right-0 mt-1 w-36 bg-white border border-[#d9d9d9] rounded shadow-lg z-10">
                        <button onClick={(e) => { e.stopPropagation(); setEditingBasicInfo(skill); setEditMenuOpen(null) }}
                          className="w-full text-left px-3 py-2 text-sm hover:bg-[#f5f5f5]">
                          {t('skillSpace.editBasicInfo')}
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); setEditingSkill(skill); setEditMenuOpen(null) }}
                          className="w-full text-left px-3 py-2 text-sm hover:bg-[#f5f5f5]">
                          {t('skillSpace.updateSkillFile')}
                        </button>
                      </div>
                    )}
                  </div>
                  {/* Delete button */}
                  <button onClick={(e) => { e.stopPropagation(); handleDeleteSkill(skill.skillId, skill.skillName) }}
                    disabled={deleting === skill.skillId}
                    className="px-3 py-1 text-sm border border-[#d9d9d9] rounded hover:border-[#ff4d4f] hover:text-[#ff4d4f]">
                    {deleting === skill.skillId ? <Loader2 className="w-4 h-4 animate-spin inline" /> : t('skillSpace.deleteSkill')}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {showCreateDialog && (
        <CreateSkillDialog token={token} skillSpaceId={skillSpaceId!} onClose={() => setShowCreateDialog(false)} onCreated={() => { setShowCreateDialog(false); loadData() }} />
      )}

      {editingSkill && (
        <EditSkillDialog
          token={token}
          skillSpaceId={skillSpaceId!}
          skillSpaceName={space?.skillSpaceName || skillSpaceId!}
          skill={editingSkill}
          onClose={() => setEditingSkill(null)}
          onSaved={() => { setEditingSkill(null); loadData() }}
        />
      )}

      {editingBasicInfo && (
        <EditBasicInfoDialog
          token={token}
          skillSpaceId={skillSpaceId!}
          skill={editingBasicInfo}
          onClose={() => setEditingBasicInfo(null)}
          onSaved={() => { setEditingBasicInfo(null); loadData() }}
        />
      )}

      {/* Delete confirmation dialog (aligned with ComputeNest Modal.confirm) */}
      {deleteConfirm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setDeleteConfirm(null)}>
          <div className="bg-white rounded-[8px] shadow-xl w-full max-w-[400px]" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-5">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-5 h-5 rounded-full bg-[#ff4d4f] flex items-center justify-center flex-shrink-0">
                  <svg className="w-3 h-3 text-white" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" /></svg>
                </div>
                <h3 className="text-base font-medium text-[rgba(0,0,0,0.88)]">{deleteConfirm.title}</h3>
              </div>
              <p className="text-sm text-[rgba(0,0,0,0.65)] leading-[22px] ml-8">{deleteConfirm.content}</p>
            </div>
            <div className="flex justify-end gap-2 px-6 py-4 border-t border-[#f0f0f0]">
              <button onClick={() => setDeleteConfirm(null)} className="h-8 px-4 border border-[#d9d9d9] rounded text-sm text-[rgba(0,0,0,0.65)] hover:border-[#1890ff] hover:text-[#1890ff]">{t('skillSpace.deleteSpaceConfirmCancel')}</button>
              <button onClick={deleteConfirm.onConfirm} className="h-8 px-4 bg-[#ff4d4f] text-white text-sm rounded hover:bg-[#ff7875]">{t('skillSpace.deleteSpaceConfirmOk')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Create Skill Dialog (two-step, aligned with ComputeNest) ──

type SourceType = 'UPLOAD' | 'COPY'
type ModalStep = 'selectType' | 'fillForm'
type DetectStatus = 'idle' | 'uploading' | 'detecting' | 'safe' | 'unsafe' | 'failed'

function getMixedLength(str: string): number {
  let len = 0
  for (const char of str) {
    len += /[\u4e00-\u9fff\u3400-\u4dbf]/.test(char) ? 2 : 1
  }
  return len
}

// Aligned with ComputeNest: COPY + UPLOAD only (OSS is feature-gated, hidden in production)
const SOURCE_TYPE_OPTIONS: { value: SourceType; icon: typeof Upload; labelKey: string; descKey: string }[] = [
  { value: 'COPY', icon: Copy, labelKey: 'skillSpace.sourceTypeCopy', descKey: 'skillSpace.sourceTypeCopyDesc' },
  { value: 'UPLOAD', icon: Upload, labelKey: 'skillSpace.sourceTypeUpload', descKey: 'skillSpace.sourceTypeUploadDesc' },
]

/** Generate a soft color from a string (for skill avatar) */
function avatarColor(str: string): string {
  const colors = ['#1890ff', '#52c41a', '#fa8c16', '#722ed1', '#eb2f96', '#13c2c2', '#faad14', '#2f54eb']
  let hash = 0
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash)
  return colors[Math.abs(hash) % colors.length]
}

function CreateSkillDialog({ token, skillSpaceId, onClose, onCreated }: {
  token: string
  skillSpaceId: string
  onClose: () => void
  onCreated: () => void
}) {
  const { t } = useTranslation('admin')
  const [currentStep, setCurrentStep] = useState<ModalStep>('selectType')
  const [sourceType, setSourceType] = useState<SourceType>('UPLOAD')
  const [skillName, setSkillName] = useState('')
  const [skillDisplayName, setSkillDisplayName] = useState('')
  const [skillDescription, setSkillDescription] = useState('')
  const [ossUrl, setOssUrl] = useState('')
  const [uploadedFile, setUploadedFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [selectedOfficialSkillId, setSelectedOfficialSkillId] = useState('')
  const [officialSkills, setOfficialSkills] = useState<SkillItem[]>([])
  const [loadingOfficialSkills, setLoadingOfficialSkills] = useState(false)
  const [skillDropdownOpen, setSkillDropdownOpen] = useState(false)
  const [skillSearchKeyword, setSkillSearchKeyword] = useState('')
  const [spaceDropdownOpen, setSpaceDropdownOpen] = useState(false)
  const spaceDropdownRef = useRef<HTMLDivElement>(null)
  // Security detection state (aligned with ComputeNest: manual trigger)
  const [detectStatus, setDetectStatus] = useState<DetectStatus>('idle')
  const [detectResult, setDetectResult] = useState<{ result: number; score: number; message?: string } | null>(null)
  const [creating, setCreating] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  // Skills space dropdown
  const [skillSpaces, setSkillSpaces] = useState<SkillSpaceItem[]>([])
  const [selectedSpaceId, setSelectedSpaceId] = useState(skillSpaceId)
  const [loadingSpaces, setLoadingSpaces] = useState(false)
  // Parsed metadata from SKILL.md in the ZIP (aligned with ComputeNest parseSkillFromZip)
  const [parsedMetadata, setParsedMetadata] = useState<{ name: string; description: string } | null>(null)

  // Load skill spaces on mount (for the dropdown)
  useEffect(() => {
    setLoadingSpaces(true)
    listSkillSpaces(token, { maxResults: 100 })
      .then(res => setSkillSpaces(res.skillSpaces || []))
      .catch(() => {})
      .finally(() => setLoadingSpaces(false))
  }, [token])

  // Load official skills when entering COPY step
  useEffect(() => {
    if (currentStep === 'fillForm' && sourceType === 'COPY' && officialSkills.length === 0) {
      setLoadingOfficialSkills(true)
      listOfficialSkills(token, { maxResults: 50 })
        .then(res => setOfficialSkills(res.skills || []))
        .catch(e => toast.error(e.message))
        .finally(() => setLoadingOfficialSkills(false))
    }
  }, [currentStep, sourceType])

  // When official skill is selected, auto-fill display name & description
  useEffect(() => {
    if (selectedOfficialSkillId && sourceType === 'COPY') {
      const skill = officialSkills.find(s => s.skillId === selectedOfficialSkillId)
      if (skill) {
        setSkillDisplayName(getSkillDisplayName(skill))
        setSkillDescription(skill.skillDescription || '')
      }
    }
  }, [selectedOfficialSkillId, sourceType, officialSkills])

  const handleNext = () => setCurrentStep('fillForm')
  const handleBack = () => setCurrentStep('selectType')

  // File drop/select handlers — upload to OSS only (no auto detection)
  const handleFileSelect = async (file: File) => {
    if (!file.name.endsWith('.zip')) {
      toast.error('仅支持 .zip 格式')
      return
    }
    if (file.size > 10 * 1024 * 1024) {
      toast.error('文件大小不超过 10MB')
      return
    }
    setUploadedFile(file)
    setOssUrl('')
    setDetectStatus('idle')
    setDetectResult(null)
    setParsedMetadata(null)

    // Upload file to OSS and parse SKILL.md metadata
    setUploading(true)
    try {
      const { ossUrl: uploadedUrl, metadata } = await uploadSkillFile(token, skillSpaceId, file)
      setOssUrl(uploadedUrl)
      // Auto-fill name and description from SKILL.md (aligned with ComputeNest)
      if (metadata) {
        setParsedMetadata(metadata)
        setSkillDisplayName(metadata.name)
        setSkillDescription(metadata.description)
      } else {
        // Fallback: use filename as skill display name
        const baseName = file.name.replace(/\.zip$/i, '')
        if (!skillDisplayName) setSkillDisplayName(baseName)
      }
    } catch (e: any) {
      toast.error(e.message || t('skillSpace.uploadFailed'))
      setUploadedFile(null)
    } finally {
      setUploading(false)
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFileSelect(file)
  }

  const handleRemoveFile = () => {
    setUploadedFile(null)
    setOssUrl('')
    setDetectStatus('idle')
    setDetectResult(null)
    setParsedMetadata(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  // Manual security detection (aligned with ComputeNest: user clicks button)
  const handleSecurityDetect = async () => {
    if (!ossUrl) {
      toast.error(t('skillSpace.detectWarningUpload'))
      return
    }
    setDetectStatus('detecting')
    setDetectResult(null)
    try {
      const { hashKey } = await createSkillFileDetect(token, { ossUrl })
      const result = await pollFileDetectResult(token, hashKey, { interval: 5000, timeout: 300000 })
      setDetectResult(result)
      if (result.result === 0) {
        setDetectStatus('safe')
        toast.success(t('skillSpace.detectSafe'))
      } else if (result.result === 1) {
        setDetectStatus('unsafe')
        toast.error(t('skillSpace.detectUnsafe', { score: result.score, message: result.message || '' }))
      } else {
        setDetectStatus('failed')
        toast.error(t('skillSpace.detectFailed', { message: result.message || '' }))
      }
    } catch (e: any) {
      setDetectStatus('failed')
      toast.error(e.message || t('skillSpace.detectFailed', { message: '' }))
    }
  }

  const handleCreate = async () => {
    if (!skillDisplayName.trim()) { toast.error(t('skillSpace.skillDisplayNameRequired')); return }
    if (getMixedLength(skillDisplayName.trim()) > 64) { toast.error(t('skillSpace.skillDisplayNameMaxLength')); return }
    if (!skillName.trim()) { toast.error(t('skillSpace.nameRequired')); return }
    if (skillName.trim().length > 64) { toast.error(t('skillSpace.skillNameMaxLength')); return }
    const SKILL_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/
    if (!SKILL_NAME_REGEX.test(skillName.trim())) { toast.error(t('skillSpace.skillNameInvalid')); return }
    if (!skillDescription.trim()) { toast.error(t('skillSpace.descRequired')); return }
    if (skillDescription.trim().length > 1024) { toast.error(t('skillSpace.skillDescMaxLength')); return }

    const finalOssUrl = ossUrl.trim()
    const finalSourceSkillId = sourceType === 'COPY' ? selectedOfficialSkillId : undefined
    const finalSkillSpaceId = selectedSpaceId || skillSpaceId

    if (sourceType === 'COPY' && !finalSourceSkillId) {
      toast.error(t('skillSpace.selectOfficialSkillRequired'))
      return
    }

    // UPLOAD: must have uploaded file (security detection is optional, aligned with ComputeNest)
    if (sourceType === 'UPLOAD') {
      if (!finalOssUrl) {
        toast.error(t('skillSpace.ossUrlRequired'))
        return
      }
      if (uploading || detectStatus === 'detecting') {
        toast.error(t('skillSpace.detecting'))
        return
      }
    }

    setCreating(true)
    try {
      await createSkill(token, finalSkillSpaceId, {
        sourceType,
        skillName: skillName.trim(),
        skillDisplayName: skillDisplayName.trim(),
        skillDescription: skillDescription.trim(),
        ossUrl: finalOssUrl || undefined,
        sourceSkillId: finalSourceSkillId,
      })
      toast.success(t('skillSpace.createSkillSuccess'))
      onCreated()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setCreating(false)
    }
  }

  const selectedSkill = officialSkills.find(s => s.skillId === selectedOfficialSkillId)

  // Whether "创建" button should be disabled
  const isCreateDisabled = creating || uploading || detectStatus === 'detecting' ||
    (sourceType === 'UPLOAD' && !ossUrl)

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-[600px] max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h3 className="text-base font-semibold text-gray-900">{t('skillSpace.createSkill')}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="w-4 h-4" /></button>
        </div>

        {/* Content */}
        <div className="px-6 py-4">
          {currentStep === 'selectType' && (
            <div className="space-y-4">
              {SOURCE_TYPE_OPTIONS.map(option => {
                const Icon = option.icon
                const isSelected = sourceType === option.value
                return (
                  <label key={option.value} className={`flex items-start gap-3 p-4 border rounded cursor-pointer transition-all duration-200 ${isSelected ? 'border-[#1890ff] bg-[#f0f8ff]' : 'border-[#d9d9d9] hover:border-[#1890ff]'}`}>
                    <span className={`mt-0.5 w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-colors ${isSelected ? 'border-[#1890ff]' : 'border-[#d9d9d9]'}`}>
                      {isSelected && <span className="w-2 h-2 rounded-full bg-[#1890ff]" />}
                    </span>
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <Icon className="w-4 h-4 text-[rgba(0,0,0,0.65)]" />
                        <span className="text-sm font-medium text-[rgba(0,0,0,0.85)]">{t(option.labelKey)}</span>
                      </div>
                      <p className="mt-1 text-xs text-[rgba(0,0,0,0.45)] leading-5">{t(option.descKey)}</p>
                    </div>
                    <input type="radio" name="sourceType" value={option.value} checked={isSelected} onChange={() => setSourceType(option.value)} className="sr-only" />
                  </label>
                )
              })}
            </div>
          )}

          {currentStep === 'fillForm' && (
            <div className="space-y-4">
              {/* ── UPLOAD: Drag & drop upload area ── */}
              {sourceType === 'UPLOAD' && (
                <div>
                  <label className="block text-sm font-medium text-[rgba(0,0,0,0.85)] mb-1">
                    {t('skillSpace.uploadSkillFile')} <span className="text-red-500">*</span>
                  </label>
                  {!uploadedFile ? (
                    <div
                      className={`border-2 border-dashed rounded p-6 text-center transition-colors cursor-pointer ${dragOver ? 'border-[#1890ff] bg-[#f0f8ff]' : 'border-[#1890ff] hover:border-[#40a9ff]'}`}
                      onDragOver={e => { e.preventDefault(); setDragOver(true) }}
                      onDragLeave={() => setDragOver(false)}
                      onDrop={handleDrop}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <Inbox className="w-10 h-10 mx-auto text-[#1890ff]" />
                      <p className="mt-2 text-sm text-[rgba(0,0,0,0.85)]">{t('skillSpace.uploadDragHint')}</p>
                      <p className="mt-1 text-xs text-[rgba(0,0,0,0.45)]">{t('skillSpace.uploadFormatHint')}</p>
                    </div>
                  ) : (
                    <>
                      {/* File info + progress */}
                      <div className="flex items-center gap-2 p-3 border border-[#d9d9d9] rounded bg-[#fafafa]">
                        <File className="w-4 h-4 text-[#1890ff] flex-shrink-0" />
                        <span className="flex-1 text-sm text-[rgba(0,0,0,0.85)] truncate">{uploadedFile.name}</span>
                        {uploading ? (
                          <Loader2 className="w-4 h-4 animate-spin text-[#1890ff]" />
                        ) : (
                          <button onClick={handleRemoveFile} className="text-[rgba(0,0,0,0.45)] hover:text-red-500"><X className="w-3.5 h-3.5" /></button>
                        )}
                      </div>
                      {uploading && (
                        <div className="mt-2 flex items-center gap-2 text-sm text-[#1890ff]">
                          <Loader2 className="w-4 h-4 animate-spin" />
                          {t('skillSpace.uploading')}
                        </div>
                      )}
                    </>
                  )}
                  <input ref={fileInputRef} type="file" accept=".zip" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleFileSelect(f) }} />

                  {/* Security Detection (aligned with ComputeNest SecurityDetection.tsx) */}
                  {uploadedFile && ossUrl && !uploading && (
                    <div className="mt-3">
                      {/* State 1: Not detected yet — show Alert with "安全检测" button */}
                      {detectStatus === 'idle' && !detectResult && (
                        <div className="flex items-center justify-between p-3 bg-[#e6f7ff] border border-[#91d5ff] rounded">
                          <div className="flex items-center gap-2 text-sm text-[rgba(0,0,0,0.65)]">
                            <Info className="w-4 h-4 text-[#1890ff] flex-shrink-0" />
                            <span>{t('skillSpace.detectAlert', { fileName: uploadedFile.name })}</span>
                          </div>
                          <button onClick={handleSecurityDetect} className="flex items-center gap-1 px-3 py-1 text-sm border border-[#d9d9d9] rounded hover:border-[#1890ff] hover:text-[#1890ff] bg-white flex-shrink-0">
                            <ShieldCheck className="w-3.5 h-3.5" />
                            {t('skillSpace.detectButton')}
                          </button>
                        </div>
                      )}

                      {/* State 2: Detecting — progress bar */}
                      {detectStatus === 'detecting' && (
                        <div className="p-3 bg-[#fafafa] border border-[#d9d9d9] rounded">
                          <div className="flex items-center gap-2 text-sm text-[#1890ff]">
                            <ShieldCheck className="w-4 h-4" />
                            {t('skillSpace.detecting')}
                          </div>
                          <div className="mt-2 w-full h-2 bg-[#f0f0f0] rounded-full overflow-hidden">
                            <div className="h-full bg-[#1890ff] rounded-full animate-pulse" style={{ width: '60%' }} />
                          </div>
                          <p className="mt-1.5 text-xs text-[rgba(0,0,0,0.45)]">{t('skillSpace.detectEstimate')}</p>
                        </div>
                      )}

                      {/* State 3: Safe */}
                      {detectStatus === 'safe' && detectResult && (
                        <div className="flex items-center justify-between p-3 bg-[#f6ffed] border border-[#b7eb8f] rounded">
                          <div className="flex items-center gap-2 text-sm text-[#52c41a]">
                            <ShieldCheck className="w-4 h-4" />
                            <span>{detectResult.score > 0 ? t('skillSpace.detectSafeWithScore', { score: detectResult.score }) : t('skillSpace.detectSafe')}</span>
                          </div>
                        </div>
                      )}

                      {/* State 4: Unsafe / Suspicious — show "重新检测" button */}
                      {(detectStatus === 'unsafe' || detectStatus === 'failed') && detectResult && (
                        <div className="flex items-center justify-between p-3 bg-[#fffbe6] border border-[#ffe58f] rounded">
                          <div className="flex items-center gap-2 text-sm text-[#faad14]">
                            <ShieldAlert className="w-4 h-4" />
                            <span>{detectResult.message || t('skillSpace.detectUnsafeShort')}</span>
                          </div>
                          <button onClick={handleSecurityDetect} className="flex items-center gap-1 px-3 py-1 text-sm border border-[#d9d9d9] rounded hover:border-[#1890ff] hover:text-[#1890ff] bg-white flex-shrink-0">
                            {t('skillSpace.detectRedetect')}
                          </button>
                        </div>
                      )}

                      {/* State 5: Failed (error) */}
                      {detectStatus === 'failed' && !detectResult && (
                        <div className="flex items-center justify-between p-3 bg-[#fff2f0] border border-[#ffccc7] rounded">
                          <div className="flex items-center gap-2 text-sm text-[#ff4d4f]">
                            <AlertCircle className="w-4 h-4" />
                            <span>{t('skillSpace.detectFailedShort')}</span>
                          </div>
                          <button onClick={handleSecurityDetect} className="flex items-center gap-1 px-3 py-1 text-sm border border-[#d9d9d9] rounded hover:border-[#1890ff] hover:text-[#1890ff] bg-white flex-shrink-0">
                            {t('skillSpace.detectRedetect')}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* ── COPY: Official skill selector (aligned with ComputeNest CopySkillForm with avatar + description + search) ── */}
              {sourceType === 'COPY' && (
                <div className="relative">
                  <label className="block text-sm font-medium text-[rgba(0,0,0,0.85)] mb-1">
                    {t('skillSpace.selectOfficialSkill')} <span className="text-red-500">*</span>
                  </label>
                  <div
                    className={`w-full h-8 border rounded px-3 text-sm flex items-center cursor-pointer ${skillDropdownOpen ? 'border-[#1890ff]' : 'border-[#d9d9d9]'} ${!selectedOfficialSkillId ? 'text-[rgba(0,0,0,0.25)]' : ''}`}
                    onClick={() => { setSkillDropdownOpen(!skillDropdownOpen); setSkillSearchKeyword('') }}
                  >
                    {selectedOfficialSkillId ? (
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <span className="w-5 h-5 rounded-full text-white text-xs flex items-center justify-center flex-shrink-0" style={{ backgroundColor: avatarColor(selectedSkill ? getSkillDisplayName(selectedSkill) : '') }}>
                          {selectedSkill ? getSkillDisplayName(selectedSkill).charAt(0)?.toUpperCase() || '?' : '?'}
                        </span>
                        <span className="truncate">{selectedSkill ? getSkillDisplayName(selectedSkill) : ''}</span>
                      </div>
                    ) : loadingOfficialSkills ? (
                      <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
                    ) : t('skillSpace.selectOfficialSkillPlaceholder')}
                    <svg className={`w-3 h-3 text-[rgba(0,0,0,0.25)] transition-transform flex-shrink-0 ${skillDropdownOpen ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 9l6 6 6-6" /></svg>
                  </div>
                  {skillDropdownOpen && (
                    <div className="absolute z-10 mt-1 w-full bg-white border border-[#d9d9d9] rounded shadow-lg">
                      {/* Search input (aligned with ComputeNest CopySkillForm showSearch + filterOption) */}
                      <div className="px-3 py-2 border-b border-[#f0f0f0]">
                        <input
                          type="text"
                          value={skillSearchKeyword}
                          onChange={e => setSkillSearchKeyword(e.target.value)}
                          placeholder={t('skillSpace.searchPlaceholder')}
                          className="w-full h-7 pl-2 pr-2 border border-[#d9d9d9] rounded text-sm focus:ring-1 focus:ring-[#1890ff] focus:border-[#1890ff]"
                          autoFocus
                        />
                      </div>
                      <div className="max-h-[300px] overflow-y-auto">
                        {officialSkills
                          .filter(s => !skillSearchKeyword || s.skillName?.toLowerCase().includes(skillSearchKeyword.toLowerCase()))
                          .map(skill => (
                            <div
                              key={skill.skillId}
                              className={`flex items-start gap-2 px-3 py-2 cursor-pointer hover:bg-[#f0f8ff] ${skill.skillId === selectedOfficialSkillId ? 'bg-[#f0f8ff]' : ''}`}
                              onClick={() => { setSelectedOfficialSkillId(skill.skillId); setSkillDropdownOpen(false); setSkillSearchKeyword('') }}
                            >
                              <span className="w-5 h-5 rounded-full text-white text-xs flex items-center justify-center flex-shrink-0 mt-0.5" style={{ backgroundColor: avatarColor(getSkillDisplayName(skill)) }}>
                                {getSkillDisplayName(skill).charAt(0)?.toUpperCase()}
                              </span>
                              <div className="flex-1 min-w-0">
                                <div className="text-sm text-[rgba(0,0,0,0.85)] truncate">{getSkillDisplayName(skill)}</div>
                                {skill.skillDescription && <div className="text-xs text-[rgba(0,0,0,0.45)] line-clamp-1">{skill.skillDescription}</div>}
                              </div>
                            </div>
                          ))
                        }
                        {officialSkills.filter(s => !skillSearchKeyword || s.skillName?.toLowerCase().includes(skillSearchKeyword.toLowerCase())).length === 0 && !loadingOfficialSkills && (
                          <div className="px-3 py-2 text-sm text-[rgba(0,0,0,0.25)]">{t('skillSpace.noOfficialSkills')}</div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* ── Common fields: aligned with ComputeNest CommonFormFields ── */}
              <>
                  {/* Skill 标识符 (skillName) */}
                  <div>
                    <label className="block text-sm font-medium text-[rgba(0,0,0,0.85)] mb-1">
                      {t('skillSpace.skillIdentifier')} <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={skillName}
                      onChange={e => setSkillName(e.target.value)}
                      maxLength={64}
                      placeholder={t('skillSpace.skillIdentifierPlaceholder')}
                      className="w-full h-8 border border-[#d9d9d9] rounded px-3 text-sm focus:ring-1 focus:ring-[#1890ff] focus:border-[#1890ff]"
                    />
                    <p className="mt-1 text-xs text-[rgba(0,0,0,0.45)]">{t('skillSpace.skillIdentifierHint')}</p>
                  </div>

                  {/* Skill 名称 (skillDisplayName) */}
                  <div>
                    <label className="block text-sm font-medium text-[rgba(0,0,0,0.85)] mb-1">
                      {t('skillSpace.skillDisplayName')} <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={skillDisplayName}
                      onChange={e => setSkillDisplayName(e.target.value)}
                      maxLength={64}
                      placeholder={t('skillSpace.skillDisplayNamePlaceholder')}
                      className="w-full h-8 border border-[#d9d9d9] rounded px-3 text-sm focus:ring-1 focus:ring-[#1890ff] focus:border-[#1890ff]"
                    />
                  </div>

                  {/* Description with character counter (aligned with ComputeNest: showCount={!showParsedFields}) */}
                  <div>
                    <label className="block text-sm font-medium text-[rgba(0,0,0,0.85)] mb-1">
                      {t('skillSpace.skillDescription')} <span className="text-red-500">*</span>
                    </label>
                    <div className="relative">
                      <textarea
                        value={skillDescription}
                        onChange={e => setSkillDescription(e.target.value)}
                        maxLength={1024}
                        rows={4}
                        // Aligned with ComputeNest: disabled only when showParsedFields (UPLOAD+parsedMetadata)
                        disabled={sourceType === 'UPLOAD' && !!parsedMetadata}
                        placeholder={t('skillSpace.skillDescPlaceholder')}
                        className={`w-full border border-[#d9d9d9] rounded px-3 py-1.5 text-sm focus:ring-1 focus:ring-[#1890ff] focus:border-[#1890ff] pb-6 ${sourceType === 'UPLOAD' && parsedMetadata ? 'bg-[#f5f5f5] cursor-not-allowed text-[rgba(0,0,0,0.85)]' : ''}`}
                      />
                      {/* Aligned with ComputeNest: showCount={!showParsedFields} */}
                      {!(sourceType === 'UPLOAD' && parsedMetadata) && (
                        <span className="absolute right-2 bottom-1.5 text-xs text-[rgba(0,0,0,0.25)]">{skillDescription.length} / 1024</span>
                      )}
                    </div>
                    {sourceType === 'UPLOAD' && parsedMetadata && (
                      <p className="mt-1 text-xs text-[rgba(0,0,0,0.45)]">{t('skillSpace.parsedFromSkillMd')}</p>
                    )}
                  </div>
              </>

              {/* ── Skills Space dropdown (aligned with ComputeNest — always opens upward via Portal) ── */}
              <div>
                <label className="block text-sm font-medium text-[rgba(0,0,0,0.85)] mb-1">
                  {t('skillSpace.skillSpaceLabel')} <span className="text-red-500">*</span>
                </label>
                <div
                  ref={spaceDropdownRef}
                  className={`w-full h-8 border rounded px-3 text-sm flex items-center cursor-pointer ${spaceDropdownOpen ? 'border-[#1890ff] ring-1 ring-[#1890ff]' : 'border-[#d9d9d9]'} ${!selectedSpaceId ? 'text-[rgba(0,0,0,0.25)]' : ''}`}
                  onClick={() => setSpaceDropdownOpen(!spaceDropdownOpen)}
                >
                  {loadingSpaces ? (
                    <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
                  ) : selectedSpaceId ? (
                    <span className="truncate flex-1">{skillSpaces.find(s => s.skillSpaceId === selectedSpaceId)?.skillSpaceName || selectedSpaceId}</span>
                  ) : t('skillSpace.skillSpacePlaceholder')}
                  <svg className={`w-3 h-3 text-[rgba(0,0,0,0.25)] transition-transform flex-shrink-0 ${spaceDropdownOpen ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 9l6 6 6-6" /></svg>
                </div>
                {spaceDropdownOpen && spaceDropdownRef.current && createPortal(
                  <div
                    className="fixed z-[9999] bg-white border border-[#d9d9d9] rounded shadow-lg max-h-[200px] overflow-y-auto"
                    style={{
                      left: spaceDropdownRef.current.getBoundingClientRect().left,
                      width: spaceDropdownRef.current.getBoundingClientRect().width,
                      bottom: window.innerHeight - spaceDropdownRef.current.getBoundingClientRect().top + 4,
                    }}
                  >
                    {skillSpaces.map(space => (
                      <div
                        key={space.skillSpaceId}
                        className={`px-3 py-1.5 cursor-pointer hover:bg-[#f0f8ff] text-sm ${space.skillSpaceId === selectedSpaceId ? 'bg-[#f0f8ff] text-[#1890ff] font-medium' : 'text-[rgba(0,0,0,0.85)]'}`}
                        onClick={() => { setSelectedSpaceId(space.skillSpaceId); setSpaceDropdownOpen(false) }}
                      >
                        {space.skillSpaceName}
                      </div>
                    ))}
                    {skillSpaces.length === 0 && !loadingSpaces && (
                      <div className="px-3 py-2 text-sm text-[rgba(0,0,0,0.25)]">{t('skillSpace.noSkillsInSpace')}</div>
                    )}
                  </div>,
                  document.body
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer buttons: aligned with ComputeNest — Next|Cancel, fillForm: Back|Create|Cancel */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-gray-100">
          {currentStep === 'selectType' ? (
            <div className="flex gap-2 ml-auto">
              <button onClick={handleNext} className="h-8 px-4 text-sm bg-[#1890ff] text-white rounded hover:bg-[#40a9ff]">{t('skillSpace.nextStep')}</button>
              <button onClick={onClose} className="h-8 px-4 text-sm border border-[#d9d9d9] rounded hover:border-[#1890ff] hover:text-[#1890ff]">{t('skillSpace.cancel')}</button>
            </div>
          ) : (
            <div className="flex gap-2 ml-auto">
              <button onClick={handleBack} className="h-8 px-4 text-sm border border-[#d9d9d9] rounded hover:border-[#1890ff] hover:text-[#1890ff]">{t('skillSpace.prevStep')}</button>
              <button onClick={handleCreate} disabled={isCreateDisabled} className="h-8 px-4 text-sm bg-[#1890ff] text-white rounded hover:bg-[#40a9ff] disabled:opacity-50">
                {creating ? <Loader2 className="w-4 h-4 animate-spin inline" /> : t('skillSpace.create')}
              </button>
              <button onClick={onClose} className="h-8 px-4 text-sm border border-[#d9d9d9] rounded hover:border-[#1890ff] hover:text-[#1890ff]">{t('skillSpace.cancel')}</button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Edit Basic Info Dialog ──

function EditBasicInfoDialog({ token, skillSpaceId, skill, onClose, onSaved }: {
  token: string
  skillSpaceId: string
  skill: SkillItem
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useTranslation('admin')
  const [skillDisplayName, setSkillDisplayName] = useState(skill.skillDisplayName || skill.skillName)
  const [skillDescription, setSkillDescription] = useState(skill.skillDescription)
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    if (!skillDisplayName.trim()) {
      toast.error(t('skillSpace.skillDisplayNameRequired'))
      return
    }
    if (getMixedLength(skillDisplayName.trim()) > 64) {
      toast.error(t('skillSpace.skillDisplayNameMaxLength'))
      return
    }
    if (!skillDescription.trim()) {
      toast.error(t('skillSpace.descRequired'))
      return
    }
    setSaving(true)
    try {
      await updateSkill(token, skillSpaceId, skill.skillId, {
        skillDisplayName: skillDisplayName.trim(),
        skillDescription: skillDescription.trim(),
      })
      toast.success(t('skillSpace.updateSuccess'))
      onSaved()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-[8px] shadow-xl w-full max-w-[520px]" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#f0f0f0]">
          <h3 className="text-base font-medium text-[rgba(0,0,0,0.88)]">{t('skillSpace.editBasicInfo')}</h3>
          <button onClick={onClose} className="text-[rgba(0,0,0,0.45)] hover:text-[rgba(0,0,0,0.75)]"><X className="w-4 h-4" /></button>
        </div>
        {/* Body */}
        <div className="px-6 py-4 space-y-4">
          {/* Skill 名称（可编辑） */}
          <div>
            <label className="block text-sm font-medium text-[rgba(0,0,0,0.85)] mb-1">{t('skillSpace.skillDisplayName')} <span className="text-red-500">*</span></label>
            <input type="text" value={skillDisplayName} onChange={e => setSkillDisplayName(e.target.value)} maxLength={64} placeholder={t('skillSpace.skillDisplayNamePlaceholder')} className="w-full h-8 border border-[#d9d9d9] rounded px-3 text-sm focus:ring-1 focus:ring-[#1890ff] focus:border-[#1890ff]" />
          </div>
          {/* 描述（可编辑） */}
          <div>
            <label className="block text-sm font-medium text-[rgba(0,0,0,0.85)] mb-1">{t('skillSpace.skillDescription')} <span className="text-red-500">*</span></label>
            <textarea value={skillDescription} onChange={e => setSkillDescription(e.target.value)} maxLength={1024} rows={4} placeholder={t('skillSpace.skillDescPlaceholder')} className="w-full border border-[#d9d9d9] rounded px-3 py-2 text-sm focus:ring-1 focus:ring-[#1890ff] focus:border-[#1890ff] resize-none" />
          </div>
        </div>
        {/* Footer */}
        <div className="flex justify-end gap-2 px-6 py-4 border-t border-[#f0f0f0]">
          <button onClick={handleSave} disabled={saving} className="px-4 py-1.5 text-sm bg-[#1890ff] text-white rounded hover:bg-[#40a9ff] disabled:opacity-50">{saving ? t('skillSpace.saving') : t('skillSpace.save')}</button>
          <button onClick={onClose} className="px-4 py-1.5 text-sm border border-[#d9d9d9] rounded hover:border-[#1890ff] hover:text-[#1890ff]">{t('skillSpace.cancel')}</button>
        </div>
      </div>
    </div>
  )
}

// ── Edit Skill Dialog (two-step, aligned with ComputeNest EditSkillModal) ──

const EDIT_SOURCE_TYPE_OPTIONS: { value: SourceType; icon: typeof Upload; labelKey: string; descKey: string }[] = [
  { value: 'COPY', icon: Copy, labelKey: 'skillSpace.sourceTypeCopyEdit', descKey: 'skillSpace.sourceTypeCopyEditDesc' },
  { value: 'UPLOAD', icon: Upload, labelKey: 'skillSpace.sourceTypeUploadEdit', descKey: 'skillSpace.sourceTypeUploadEditDesc' },
]

function EditSkillDialog({ token, skillSpaceId, skillSpaceName, skill, onClose, onSaved }: {
  token: string
  skillSpaceId: string
  skillSpaceName: string
  skill: SkillItem
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useTranslation('admin')
  const [currentStep, setCurrentStep] = useState<ModalStep>('selectType')
  const [sourceType, setSourceType] = useState<SourceType>('UPLOAD')
  const [ossUrl, setOssUrl] = useState('')
  const [uploadedFile, setUploadedFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [selectedOfficialSkillId, setSelectedOfficialSkillId] = useState('')
  const [officialSkills, setOfficialSkills] = useState<SkillItem[]>([])
  const [loadingOfficialSkills, setLoadingOfficialSkills] = useState(false)
  const [editSkillSearchKeyword, setEditSkillSearchKeyword] = useState('')
  const [editSkillDropdownOpen, setEditSkillDropdownOpen] = useState(false)
  // Security detection state
  const [detectStatus, setDetectStatus] = useState<DetectStatus>('idle')
  const [detectResult, setDetectResult] = useState<{ result: number; score: number; message?: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)

  // Load official skills when entering COPY step
  useEffect(() => {
    if (currentStep === 'fillForm' && sourceType === 'COPY' && officialSkills.length === 0) {
      setLoadingOfficialSkills(true)
      listOfficialSkills(token, { maxResults: 50 })
        .then(res => setOfficialSkills(res.skills || []))
        .catch(e => toast.error(e.message))
        .finally(() => setLoadingOfficialSkills(false))
    }
  }, [currentStep, sourceType])

  const handleNext = () => setCurrentStep('fillForm')
  const handleBack = () => setCurrentStep('selectType')

  // File drop/select handlers
  const handleFileSelect = async (file: File) => {
    if (!file.name.endsWith('.zip')) {
      toast.error(t('skillSpace.zipOnly'))
      return
    }
    if (file.size > 10 * 1024 * 1024) {
      toast.error(t('skillSpace.fileTooLarge'))
      return
    }
    setUploadedFile(file)
    setOssUrl('')
    setDetectStatus('idle')
    setDetectResult(null)

    setUploading(true)
    try {
      const { ossUrl: uploadedUrl } = await uploadSkillFile(token, skillSpaceId, file)
      setOssUrl(uploadedUrl)
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setUploading(false)
    }
  }

  // Security detection (aligned with ComputeNest: manual trigger, 5s interval, 300s timeout)
  const handleDetect = async () => {
    if (!ossUrl) return
    setDetectStatus('detecting')
    setDetectResult(null)
    try {
      const { hashKey } = await createSkillFileDetect(token, { ossUrl })
      const result = await pollFileDetectResult(token, hashKey, { interval: 5000, timeout: 300000 })
      if (result.result === 0) {
        setDetectStatus('safe')
      } else {
        setDetectStatus('unsafe')
      }
      setDetectResult(result)
    } catch {
      setDetectStatus('failed')
    }
  }

  const handleUpdate = async () => {
    if (sourceType === 'UPLOAD' && !ossUrl) {
      toast.error(t('skillSpace.ossUrlRequired'))
      return
    }
    if (sourceType === 'COPY' && !selectedOfficialSkillId) {
      toast.error(t('skillSpace.selectOfficialSkillRequired'))
      return
    }
    setSaving(true)
    try {
      await updateSkill(token, skillSpaceId, skill.skillId, {
        sourceType,
        ossUrl: sourceType === 'UPLOAD' ? ossUrl.trim() || undefined : undefined,
        sourceSkillId: sourceType === 'COPY' ? selectedOfficialSkillId || undefined : undefined,
      })
      toast.success(t('skillSpace.updateSuccess'))
      onSaved()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  // Aligned with ComputeNest: disable Update when no source provided
  const isUpdateDisabled = saving ||
    (sourceType === 'UPLOAD' && !ossUrl) ||
    (sourceType === 'COPY' && !selectedOfficialSkillId)

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-[8px] shadow-xl w-full max-w-[600px]" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#f0f0f0]">
          <h3 className="text-base font-medium text-[rgba(0,0,0,0.88)]">{t('skillSpace.updateSkillFile')}: {skill.skillName}</h3>
          <button onClick={onClose} className="text-[rgba(0,0,0,0.45)] hover:text-[rgba(0,0,0,0.75)] transition-colors"><X className="w-4 h-4" /></button>
        </div>

        {/* Content */}
        <div className="px-6 py-4">
          {currentStep === 'selectType' && (
            <div className="space-y-4">
              {EDIT_SOURCE_TYPE_OPTIONS.map(option => {
                const Icon = option.icon
                const isSelected = sourceType === option.value
                return (
                  <label key={option.value} className={`flex items-start gap-3 p-4 border rounded cursor-pointer transition-all duration-200 ${isSelected ? 'border-[#1890ff] bg-[#f0f8ff]' : 'border-[#d9d9d9] hover:border-[#1890ff]'}`}>
                    <span className={`mt-0.5 w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-colors ${isSelected ? 'border-[#1890ff]' : 'border-[#d9d9d9]'}`}>
                      {isSelected && <span className="w-2 h-2 rounded-full bg-[#1890ff]" />}
                    </span>
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <Icon className="w-4 h-4 text-[rgba(0,0,0,0.65)]" />
                        <span className="text-sm font-medium text-[rgba(0,0,0,0.85)]">{t(option.labelKey)}</span>
                      </div>
                      <p className="mt-1 text-xs text-[rgba(0,0,0,0.45)] leading-5">{t(option.descKey)}</p>
                    </div>
                    <input type="radio" name="editSourceType" value={option.value} checked={isSelected} onChange={() => setSourceType(option.value)} className="sr-only" />
                  </label>
                )
              })}
            </div>
          )}

          {currentStep === 'fillForm' && (
            <div className="space-y-4">
              {/* ── UPLOAD: Drag & drop upload area ── */}
              {sourceType === 'UPLOAD' && (
                <div>
                  <label className="block text-sm font-medium text-[rgba(0,0,0,0.85)] mb-1">
                    {t('skillSpace.uploadFile')} <span className="text-red-500">*</span>
                  </label>
                  <div
                    className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${dragOver ? 'border-[#1890ff] bg-[#f0f8ff]' : 'border-[#d9d9d9] hover:border-[#1890ff]'} ${uploadedFile ? 'border-solid border-[#1890ff] bg-[#f0f8ff]' : ''}`}
                    onClick={() => fileInputRef.current?.click()}
                    onDragOver={e => { e.preventDefault(); setDragOver(true) }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={e => {
                      e.preventDefault(); setDragOver(false)
                      const file = e.dataTransfer.files[0]
                      if (file) handleFileSelect(file)
                    }}
                  >
                    <input ref={fileInputRef} type="file" accept=".zip" className="hidden" onChange={e => { const file = e.target.files?.[0]; if (file) handleFileSelect(file); e.target.value = '' }} />
                    {uploading ? (
                      <div className="flex flex-col items-center gap-2">
                        <Loader2 className="w-8 h-8 animate-spin text-[#1890ff]" />
                        <span className="text-sm text-[rgba(0,0,0,0.45)]">{t('skillSpace.uploading')}</span>
                      </div>
                    ) : uploadedFile ? (
                      <div className="flex items-center justify-center gap-2">
                        <Inbox className="w-4 h-4 text-[#1890ff]" />
                        <span className="text-sm text-[#1890ff]">{uploadedFile.name}</span>
                        <button onClick={e => { e.stopPropagation(); setUploadedFile(null); setOssUrl(''); setDetectStatus('idle'); setDetectResult(null) }} className="text-[rgba(0,0,0,0.45)] hover:text-red-500"><X className="w-3.5 h-3.5" /></button>
                      </div>
                    ) : (
                      <div className="flex flex-col items-center gap-2">
                        <Inbox className="w-8 h-8 text-[rgba(0,0,0,0.25)]" />
                        <span className="text-sm text-[rgba(0,0,0,0.45)]">{t('skillSpace.dragOrClick')}</span>
                        <span className="text-xs text-[rgba(0,0,0,0.25)]">{t('skillSpace.zipOnlyHint')}</span>
                      </div>
                    )}
                  </div>

                  {/* Security detection (aligned with ComputeNest SecurityDetection.tsx — full version) */}
                  {uploadedFile && ossUrl && !uploading && (
                    <div className="mt-3">
                      {/* State 1: Not detected yet — show Alert with "安全检测" button */}
                      {detectStatus === 'idle' && !detectResult && (
                        <div className="flex items-center justify-between p-3 bg-[#e6f7ff] border border-[#91d5ff] rounded">
                          <div className="flex items-center gap-2 text-sm text-[rgba(0,0,0,0.65)]">
                            <Info className="w-4 h-4 text-[#1890ff] flex-shrink-0" />
                            <span>{t('skillSpace.detectAlert', { fileName: uploadedFile.name })}</span>
                          </div>
                          <button onClick={handleDetect} className="flex items-center gap-1 px-3 py-1 text-sm border border-[#d9d9d9] rounded hover:border-[#1890ff] hover:text-[#1890ff] bg-white flex-shrink-0">
                            <ShieldCheck className="w-3.5 h-3.5" />
                            {t('skillSpace.detectButton')}
                          </button>
                        </div>
                      )}

                      {/* State 2: Detecting — progress bar */}
                      {detectStatus === 'detecting' && (
                        <div className="p-3 bg-[#fafafa] border border-[#d9d9d9] rounded">
                          <div className="flex items-center gap-2 text-sm text-[#1890ff]">
                            <ShieldCheck className="w-4 h-4" />
                            {t('skillSpace.detecting')}
                          </div>
                          <div className="mt-2 w-full h-2 bg-[#f0f0f0] rounded-full overflow-hidden">
                            <div className="h-full bg-[#1890ff] rounded-full animate-pulse" style={{ width: '60%' }} />
                          </div>
                          <p className="mt-1.5 text-xs text-[rgba(0,0,0,0.45)]">{t('skillSpace.detectEstimate')}</p>
                        </div>
                      )}

                      {/* State 3: Safe */}
                      {detectStatus === 'safe' && detectResult && (
                        <div className="flex items-center justify-between p-3 bg-[#f6ffed] border border-[#b7eb8f] rounded">
                          <div className="flex items-center gap-2 text-sm text-[#52c41a]">
                            <ShieldCheck className="w-4 h-4" />
                            <span>{detectResult.score > 0 ? t('skillSpace.detectSafeWithScore', { score: detectResult.score }) : t('skillSpace.detectSafe')}</span>
                          </div>
                        </div>
                      )}

                      {/* State 4: Unsafe / Suspicious — show "重新检测" button */}
                      {(detectStatus === 'unsafe' || detectStatus === 'failed') && detectResult && (
                        <div className="flex items-center justify-between p-3 bg-[#fffbe6] border border-[#ffe58f] rounded">
                          <div className="flex items-center gap-2 text-sm text-[#faad14]">
                            <ShieldAlert className="w-4 h-4" />
                            <span>{detectResult.message || t('skillSpace.detectUnsafeShort')}</span>
                          </div>
                          <button onClick={handleDetect} className="flex items-center gap-1 px-3 py-1 text-sm border border-[#d9d9d9] rounded hover:border-[#1890ff] hover:text-[#1890ff] bg-white flex-shrink-0">
                            {t('skillSpace.detectRedetect')}
                          </button>
                        </div>
                      )}

                      {/* State 5: Failed (error) */}
                      {detectStatus === 'failed' && !detectResult && (
                        <div className="flex items-center justify-between p-3 bg-[#fff2f0] border border-[#ffccc7] rounded">
                          <div className="flex items-center gap-2 text-sm text-[#ff4d4f]">
                            <AlertCircle className="w-4 h-4" />
                            <span>{t('skillSpace.detectFailedShort')}</span>
                          </div>
                          <button onClick={handleDetect} className="flex items-center gap-1 px-3 py-1 text-sm border border-[#d9d9d9] rounded hover:border-[#1890ff] hover:text-[#1890ff] bg-white flex-shrink-0">
                            {t('skillSpace.detectRedetect')}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* ── COPY: Official skill selector (aligned with ComputeNest CopySkillForm — Select dropdown with showSearch) ── */}
              {sourceType === 'COPY' && (
                <div>
                  <label className="block text-sm font-medium text-[rgba(0,0,0,0.85)] mb-1">
                    {t('skillSpace.selectOfficialSkill')} <span className="text-red-500">*</span>
                  </label>
                  <div className="relative">
                    <div
                      className={`w-full h-8 border rounded px-3 text-sm flex items-center cursor-pointer ${editSkillDropdownOpen ? 'border-[#1890ff]' : 'border-[#d9d9d9]'} ${!selectedOfficialSkillId ? 'text-[rgba(0,0,0,0.25)]' : ''}`}
                      onClick={() => { setEditSkillDropdownOpen(!editSkillDropdownOpen); setEditSkillSearchKeyword('') }}
                    >
                      {selectedOfficialSkillId ? (
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                          <span className="w-5 h-5 rounded-full text-white text-xs flex items-center justify-center flex-shrink-0" style={{ backgroundColor: avatarColor((() => { const s = officialSkills.find(s => s.skillId === selectedOfficialSkillId); return s ? getSkillDisplayName(s) : '' })()) }}>
                            {(() => { const s = officialSkills.find(s => s.skillId === selectedOfficialSkillId); return s ? getSkillDisplayName(s).charAt(0)?.toUpperCase() || '?' : '?' })()}
                          </span>
                          <span className="truncate">{(() => { const s = officialSkills.find(s => s.skillId === selectedOfficialSkillId); return s ? getSkillDisplayName(s) : '' })()}</span>
                        </div>
                      ) : loadingOfficialSkills ? (
                        <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
                      ) : t('skillSpace.selectOfficialSkillPlaceholder')}
                      <svg className={`w-3 h-3 text-[rgba(0,0,0,0.25)] transition-transform flex-shrink-0 ${editSkillDropdownOpen ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 9l6 6 6-6" /></svg>
                    </div>
                    {editSkillDropdownOpen && (
                      <div className="absolute z-10 mt-1 w-full bg-white border border-[#d9d9d9] rounded shadow-lg">
                        <div className="px-3 py-2 border-b border-[#f0f0f0]">
                          <input
                            type="text"
                            value={editSkillSearchKeyword}
                            onChange={e => setEditSkillSearchKeyword(e.target.value)}
                            placeholder={t('skillSpace.searchPlaceholder')}
                            className="w-full h-7 pl-2 pr-2 border border-[#d9d9d9] rounded text-sm focus:outline-none focus:border-[#1890ff]"
                            autoFocus
                          />
                        </div>
                        <div className="max-h-[300px] overflow-y-auto">
                          {officialSkills
                            .filter(s => !editSkillSearchKeyword || s.skillName?.toLowerCase().includes(editSkillSearchKeyword.toLowerCase()))
                            .map(s => (
                              <div
                                key={s.skillId}
                                className={`flex items-start gap-2 px-3 py-2 cursor-pointer hover:bg-[#f0f8ff] ${s.skillId === selectedOfficialSkillId ? 'bg-[#f0f8ff]' : ''}`}
                                onClick={() => { setSelectedOfficialSkillId(s.skillId); setEditSkillDropdownOpen(false); setEditSkillSearchKeyword('') }}
                              >
                                <span className="w-5 h-5 rounded-full text-white text-xs flex items-center justify-center flex-shrink-0 mt-0.5" style={{ backgroundColor: avatarColor(getSkillDisplayName(s)) }}>
                                  {getSkillDisplayName(s).charAt(0)?.toUpperCase()}
                                </span>
                                <div className="flex-1 min-w-0">
                                  <div className="text-sm text-[rgba(0,0,0,0.85)] truncate">{getSkillDisplayName(s)}</div>
                                  {s.skillDescription && <div className="text-xs text-[rgba(0,0,0,0.45)] line-clamp-1">{s.skillDescription}</div>}
                                </div>
                              </div>
                            ))
                          }
                          {officialSkills.filter(s => !editSkillSearchKeyword || s.skillName?.toLowerCase().includes(editSkillSearchKeyword.toLowerCase())).length === 0 && !loadingOfficialSkills && (
                            <div className="px-3 py-2 text-sm text-[rgba(0,0,0,0.25)]">{t('skillSpace.noOfficialSkills')}</div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer buttons: aligned with ComputeNest — selectType: Next|Cancel, fillForm: Back|Update|Cancel */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-gray-100">
          {currentStep === 'selectType' ? (
            <div className="flex gap-2 ml-auto">
              <button onClick={handleNext} className="h-8 px-4 text-sm bg-[#1890ff] text-white rounded hover:bg-[#40a9ff]">{t('skillSpace.nextStep')}</button>
              <button onClick={onClose} className="h-8 px-4 text-sm border border-[#d9d9d9] rounded hover:border-[#1890ff] hover:text-[#1890ff]">{t('skillSpace.cancel')}</button>
            </div>
          ) : (
            <div className="flex gap-2 ml-auto">
              <button onClick={handleBack} className="h-8 px-4 text-sm border border-[#d9d9d9] rounded hover:border-[#1890ff] hover:text-[#1890ff]">{t('skillSpace.prevStep')}</button>
              <button onClick={handleUpdate} disabled={isUpdateDisabled} className="h-8 px-4 text-sm bg-[#1890ff] text-white rounded hover:bg-[#40a9ff] disabled:opacity-50">
                {saving ? <Loader2 className="w-4 h-4 animate-spin inline" /> : t('skillSpace.updateBtn')}
              </button>
              <button onClick={onClose} className="h-8 px-4 text-sm border border-[#d9d9d9] rounded hover:border-[#1890ff] hover:text-[#1890ff]">{t('skillSpace.cancel')}</button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
