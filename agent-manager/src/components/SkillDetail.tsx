/**
 * SkillDetail — aligned with ComputeNest SkillDetail
 * Layout: SkillHeader (back arrow + name + desc + tags + updateTime + actions)
 *         FileExplorer (section header + file tree + code preview)
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../contexts/AuthContext'
import toast from 'react-hot-toast'
import {
  Loader2, X, Inbox, ShieldCheck, ShieldAlert, AlertCircle, Info,
  FileText, FolderOpen, Folder,
  ChevronRight, ChevronDown, Upload, Copy, ArrowLeft,
} from 'lucide-react'
import {
  getSkill, listSkillFiles, updateSkill, deleteSkill,
  createSkillFileDetect, pollFileDetectResult, uploadSkillFile,
  getSkillFileContent, downloadSkill, listOfficialSkills,
  getSkillDisplayName,
  type SkillItem, type SkillFileItem,
} from '../lib/computenest-api'
import { SkillTagsList } from './skill-market/SkillTagsList'
import InstallPanel from './skill-detail/InstallPanel'
import ReadmeTab from './skill-detail/ReadmeTab'
import CodeViewer from './skill-detail/CodeViewer'

// ── Types for Edit Skill Dialog (aligned with ComputeNest) ──
type EditSourceType = 'UPLOAD' | 'COPY'
type EditModalStep = 'selectType' | 'fillForm'
type DetectStatus = 'idle' | 'uploading' | 'detecting' | 'safe' | 'unsafe' | 'failed'

// Avatar color for official skill selector
function avatarColor(str: string): string {
  const colors = ['#1890ff', '#52c41a', '#fa8c16', '#722ed1', '#eb2f96', '#13c2c2', '#faad14', '#2f54eb']
  let hash = 0
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash)
  return colors[Math.abs(hash) % colors.length]
}

// Edit source type options (aligned with ComputeNest: COPY first, UPLOAD second — no OSS)
const EDIT_SOURCE_TYPE_OPTIONS: { value: EditSourceType; icon: typeof Upload; labelKey: string; descKey: string }[] = [
  { value: 'COPY', icon: Copy, labelKey: 'skillSpace.sourceTypeCopyEdit', descKey: 'skillSpace.sourceTypeCopyEditDesc' },
  { value: 'UPLOAD', icon: Upload, labelKey: 'skillSpace.sourceTypeUploadEdit', descKey: 'skillSpace.sourceTypeUploadEditDesc' },
]

// ── File Tree Node ──
interface FileTreeNode {
  name: string
  path: string
  isLeaf: boolean
  children?: FileTreeNode[]
}

/** Build a file tree from flat path list (like ComputeNest buildFileTree) */
function buildFileTree(files: SkillFileItem[]): FileTreeNode[] {
  const root: FileTreeNode = { name: 'root', path: '', isLeaf: false, children: [] }

  files.forEach(file => {
    const parts = file.filePath.split('/').filter(Boolean)
    let currentNode = root

    parts.forEach((part, index) => {
      const isFile = index === parts.length - 1
      const path = parts.slice(0, index + 1).join('/')

      if (!currentNode.children) currentNode.children = []

      let child = currentNode.children.find(c => c.path === path)
      if (!child) {
        child = {
          name: part,
          path,
          isLeaf: isFile,
        }
        currentNode.children.push(child)
      }
      currentNode = child
    })
  })

  return root.children || []
}

/** Format update time like ComputeNest: "YYYY-MM-DD HH:mm:ss" */
function formatUpdateTime(dateStr?: string): string {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`
}

// ── Main Component ──

export default function SkillDetail() {
  const { skillId } = useParams<{ skillId: string }>()
  const [searchParams] = useSearchParams()
  // Aligned with ComputeNest: skillSpaceId from query param, isCustomSkill defaults to false
  const querySkillSpaceId = searchParams.get('skillSpaceId') || ''
  const skillSpaceName = searchParams.get('skillSpaceName') || ''
  const isCustomSkill = searchParams.get('isCustomSkill') === 'true'
  const { t, i18n } = useTranslation('admin')
  const { session } = useAuth()
  const token = session?.access_token || ''
  const navigate = useNavigate()

  const [skill, setSkill] = useState<SkillItem | null>(null)
  const [files, setFiles] = useState<SkillFileItem[]>([])
  // Aligned with ComputeNest: prefer query param, fallback to skill.SkillSpaceId
  const skillSpaceId = querySkillSpaceId || skill?.skillSpaceId || ''
  const [loading, setLoading] = useState(true)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [fileContent, setFileContent] = useState<string | null>(null)
  const [loadingFile, setLoadingFile] = useState(false)
  const [showEditDialog, setShowEditDialog] = useState(false)
  const [, setDeleting] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set())
  // Delete confirmation dialog state (aligned with ComputeNest Modal.confirm)
  const [deleteConfirm, setDeleteConfirm] = useState<{
    title: string
    content: string
    onConfirm: () => void
  } | null>(null)
  const [headerEditMenuOpen, setHeaderEditMenuOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<'readme' | 'files'>('files')
  const [readmeContent, setReadmeContent] = useState<string | null>(null)
  const [loadingReadme, setLoadingReadme] = useState(false)
  const [editBasicInfoOpen, setEditBasicInfoOpen] = useState(false)
  const [editBasicInfoSaving, setEditBasicInfoSaving] = useState(false)
  const [editDisplayName, setEditDisplayName] = useState('')
  const [editDescription, setEditDescription] = useState('')

  // Filter out README files from file tree (they are shown in the README tab)
  const filteredFileTree = buildFileTree(files.filter(f => !/^readme/i.test(f.filePath)))

  // 根据当前语言选择 README：中文用 README.md，英文用 README.en.md
  const currentLang = i18n.language // 'zh-CN' 或 'en'

  const readmeFile = (() => {
    const isEnglish = currentLang?.startsWith('en')
    // 英文环境优先找 README.en.md，中文环境优先找 README.md
    const preferredReadme = isEnglish
      ? files.find(f => /^readme\.en\.md$/i.test(f.filePath))
      : files.find(f => /^readme\.md$/i.test(f.filePath) && !/\.en\.md$/i.test(f.filePath))
    // fallback：如果首选不存在，使用另一种语言的
    if (preferredReadme) return preferredReadme
    return files.find(f => /^readme/i.test(f.filePath) && /\.md$/i.test(f.filePath))
  })()
  const hasReadme = !!readmeFile

  // Load README content when available or when language changes
  useEffect(() => {
    if (hasReadme && readmeFile && skillSpaceId && skillId) {
      setLoadingReadme(true)
      setActiveTab('readme')
      setReadmeContent(null)
      getSkillFileContent(token, skillSpaceId, skillId, readmeFile.filePath)
        .then(content => setReadmeContent(content))
        .catch(() => setReadmeContent(null))
        .finally(() => setLoadingReadme(false))
    }
  }, [hasReadme, readmeFile?.filePath, skillSpaceId, skillId])

  // Download handler for InstallPanel
  const handleDownload = async () => {
    if (!skill || !skillSpaceId || !skillId) return
    setDownloading(true)
    try {
      await downloadSkill(token, skillSpaceId, skillId, skill.skillName, isCustomSkill)
      toast.success(t('skillSpace.downloadSuccess', { defaultValue: '下载成功' }))
    } catch (e: any) {
      toast.error(e.message || t('skillSpace.downloadFailed', { defaultValue: '下载失败' }))
    } finally {
      setDownloading(false)
    }
  }

  // Edit basic info handler
  const handleSaveBasicInfo = async () => {
    if (!editDisplayName.trim() || !editDescription.trim()) {
      toast.error(t('skillSpace.nameAndDescRequired'))
      return
    }
    setEditBasicInfoSaving(true)
    try {
      await updateSkill(token, skillSpaceId, skill!.skillId, {
        skillDescription: editDescription.trim(),
        skillDisplayName: editDisplayName.trim(),
      })
      toast.success(t('skillSpace.updateSuccess'))
      setEditBasicInfoOpen(false)
      loadData()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setEditBasicInfoSaving(false)
    }
  }

  const loadData = useCallback(async () => {
    if (!querySkillSpaceId || !skillId) return
    setLoading(true)
    try {
      // Aligned with ComputeNest: only GetSkill + ListSkillFiles, no GetSkillSpace
      const [skillRes, filesRes] = await Promise.all([
        getSkill(token, querySkillSpaceId, skillId),
        listSkillFiles(token, querySkillSpaceId, skillId, { maxResults: 100 }),
      ])
      setSkill(skillRes.skill)
      setFiles(filesRes.skillFiles)
      // Auto-expand first level directories
      const firstLevelDirs = buildFileTree(filesRes.skillFiles)
        .filter(n => !n.isLeaf)
        .map(n => n.path)
      setExpandedDirs(new Set(firstLevelDirs))
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setLoading(false)
    }
  }, [token, querySkillSpaceId, skillId])

  useEffect(() => { loadData() }, [loadData])

  const handleFileClick = async (node: FileTreeNode) => {
    if (!node.isLeaf) {
      // Toggle directory expansion
      setExpandedDirs(prev => {
        const next = new Set(prev)
        if (next.has(node.path)) next.delete(node.path)
        else next.add(node.path)
        return next
      })
      return
    }

    setSelectedFile(node.path)
    setLoadingFile(true)
    setFileContent(null)
    try {
      // Always use backend proxy to load file content (avoids OSS CORS issues)
      const text = await getSkillFileContent(token, skillSpaceId, skillId!, node.path)
      setFileContent(text)
    } catch (e: any) {
      setFileContent(t('skillSpace.fileLoadFailed', { error: e.message }))
    } finally {
      setLoadingFile(false)
    }
  }

  const handleDelete = () => {
    if (!skillSpaceId || !skillId || !skill) return
    setDeleteConfirm({
      title: t('skillSpace.confirmDeleteSkill', { name: skill.skillName }),
      content: t('skillSpace.deleteSkillConfirmContent'),
      onConfirm: async () => {
        setDeleteConfirm(null)
        setDeleting(true)
        try {
          await deleteSkill(token, skillSpaceId, skillId)
          toast.success(t('skillSpace.deleteSkillSuccess'))
          // Aligned with ComputeNest: custom→space detail, official→market
          if (isCustomSkill && skillSpaceId) {
            const params = skillSpaceName ? `?skillSpaceName=${encodeURIComponent(skillSpaceName)}` : ''
            navigate(`/admin/skill-spaces/${skillSpaceId}${params}`)
          } else {
            navigate('/admin/skill-spaces')
          }
        } catch (e: any) {
          toast.error(e.message)
        } finally {
          setDeleting(false)
        }
      },
    })
  }

  // ── Render File Tree Node (recursive) ──
  const renderTreeNode = (node: FileTreeNode, depth: number = 0) => {
    const isExpanded = expandedDirs.has(node.path)
    const isSelected = selectedFile === node.path

    if (!node.isLeaf && !isExpanded) {
      // Collapsed directory
      return (
        <div key={node.path}>
          <button
            onClick={() => handleFileClick(node)}
            className={`w-full text-left flex items-center gap-1.5 px-2 py-1 rounded text-xs hover:bg-gray-50 transition-colors text-[rgba(0,0,0,0.65)]`}
            style={{ paddingLeft: `${depth * 16 + 8}px` }}
          >
            <ChevronRight className="w-3 h-3 text-gray-400 flex-shrink-0" />
            <Folder className="w-3.5 h-3.5 text-[#faad14] flex-shrink-0" />
            <span className="truncate">{node.name}</span>
          </button>
        </div>
      )
    }

    if (!node.isLeaf && isExpanded) {
      // Expanded directory
      return (
        <div key={node.path}>
          <button
            onClick={() => handleFileClick(node)}
            className={`w-full text-left flex items-center gap-1.5 px-2 py-1 rounded text-xs hover:bg-gray-50 transition-colors text-[rgba(0,0,0,0.65)]`}
            style={{ paddingLeft: `${depth * 16 + 8}px` }}
          >
            <ChevronDown className="w-3 h-3 text-gray-400 flex-shrink-0" />
            <FolderOpen className="w-3.5 h-3.5 text-[#faad14] flex-shrink-0" />
            <span className="truncate">{node.name}</span>
          </button>
          {node.children?.map(child => renderTreeNode(child, depth + 1))}
        </div>
      )
    }

    // File leaf
    return (
      <button
        key={node.path}
        onClick={() => handleFileClick(node)}
        className={`w-full text-left flex items-center gap-1.5 px-2 py-1 rounded text-xs transition-colors ${
          isSelected
            ? 'bg-[#e6f7ff] text-[#1890ff]'
            : 'text-[rgba(0,0,0,0.65)] hover:bg-gray-50'
        }`}
        style={{ paddingLeft: `${depth * 16 + 24}px` }}
      >
        <FileText className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
        <span className="truncate">{node.name}</span>
      </button>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
      </div>
    )
  }

  return (
    <div className="bg-white rounded-xl min-h-[calc(100vh-165px)] px-6 py-5">
      {/* ── Breadcrumb (aligned with ComputeNest buildBreadcrumb) ── */}
      <div className="flex items-center gap-2 text-sm text-[rgba(0,0,0,0.45)] mb-4">
        <button onClick={() => navigate('/admin/skill-spaces')} className="hover:text-[#1890ff] transition-colors">
          {t('skillSpace.skillMarket')}
        </button>
        {isCustomSkill && skillSpaceId && skillSpaceName ? (
          <>
            <ChevronRight className="w-3 h-3" />
            <button onClick={() => navigate('/admin/skill-spaces?tab=custom')} className="hover:text-[#1890ff] transition-colors">
              {t('skillSpace.customTab')}
            </button>
            <ChevronRight className="w-3 h-3" />
            <button onClick={() => navigate(`/admin/skill-spaces/${skillSpaceId}`)} className="hover:text-[#1890ff] transition-colors">
              {decodeURIComponent(skillSpaceName)}
            </button>
            <ChevronRight className="w-3 h-3" />
            <span className="text-[rgba(0,0,0,0.65)]">{skill ? getSkillDisplayName(skill) : t('skillSpace.skillDetail')}</span>
          </>
        ) : (
          <>
            <ChevronRight className="w-3 h-3" />
            <span className="text-[rgba(0,0,0,0.65)]">{skill ? getSkillDisplayName(skill) : t('skillSpace.skillDetail')}</span>
          </>
        )}
      </div>

      {/* ── SkillHeader: title + desc + tags + updateTime + actions ── */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex-1 min-w-0">
          {/* Title — aligned with ComputeNest: back arrow + name */}
          <h2 className="text-2xl font-medium text-gray-900 m-0 mb-1">
            <a
              onClick={() => navigate(-1)}
              className="inline-flex items-center justify-center h-6 w-6 mr-4 text-gray-600 hover:text-[#1890ff] cursor-pointer"
            >
              <ArrowLeft className="w-5 h-5" />
            </a>
            {skill ? getSkillDisplayName(skill) : ''}
          </h2>
          {/* Description (before identifier, aligned with ComputeNest) */}
          {skill?.skillDescription && (
            <p className="mt-1 text-sm text-[rgba(0,0,0,0.45)] line-clamp-2">{skill.skillDescription}</p>
          )}
          {/* Identifier + updateTime (after description, aligned with ComputeNest) */}
          <div className="flex items-center gap-1.5 mt-2">
            <span className="text-sm text-[rgba(0,0,0,0.45)]">{t('skillSpace.identifier')}: {skill?.skillName}</span>
            <button
              onClick={() => { if (skill?.skillName) { navigator.clipboard.writeText(skill.skillName); toast.success(t('skillSpace.copiedToClipboard')) } }}
              className="text-[rgba(0,0,0,0.35)] hover:text-[#1890ff] transition-colors"
              title={t('skillSpace.copyCommand')}
            >
              <Copy className="w-3.5 h-3.5" />
            </button>
            {skill?.updateTime && (
              <span className="text-sm text-[rgba(0,0,0,0.45)] ml-4">
                {t('skillSpace.updatedAt')}: {formatUpdateTime(skill.updateTime)}
              </span>
            )}
          </div>
          {/* Meta info: tags */}
          <div className="mt-2 flex items-center gap-3 flex-wrap">
            {skill?.skillLabels && skill.skillLabels.length > 0 && (
              <SkillTagsList tags={skill.skillLabels} />
            )}
          </div>
        </div>

        {/* Actions: edit + delete (aligned with ComputeNest SkillHeader) */}
        <div className="flex items-center gap-3 ml-4">
          {/* Edit dropdown + Delete for custom skills only */}
          {isCustomSkill && (
            <div className="flex items-center gap-2">
              <div className="relative">
                <button onClick={() => setHeaderEditMenuOpen(!headerEditMenuOpen)}
                  className="px-3 py-1.5 text-sm border border-[#d9d9d9] rounded hover:border-[#1890ff] hover:text-[#1890ff] flex items-center gap-1">
                  {t('skillSpace.edit')}
                  <ChevronDown className="w-3 h-3" />
                </button>
                {headerEditMenuOpen && (
                  <div className="absolute right-0 mt-1 w-36 bg-white border border-[#d9d9d9] rounded shadow-lg z-10">
                    <button onClick={() => { setEditBasicInfoOpen(true); setEditDisplayName(skill ? getSkillDisplayName(skill) : ''); setEditDescription(skill?.skillDescription || ''); setHeaderEditMenuOpen(false) }}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-[#f5f5f5]">
                      {t('skillSpace.editBasicInfo')}
                    </button>
                    <button onClick={() => { setShowEditDialog(true); setHeaderEditMenuOpen(false) }}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-[#f5f5f5]">
                      {t('skillSpace.updateSkillFile')}
                    </button>
                  </div>
                )}
              </div>
              <button onClick={handleDelete}
                className="px-3 py-1.5 text-sm border border-[#d9d9d9] rounded hover:border-[#ff4d4f] hover:text-[#ff4d4f]">
                {t('skillSpace.deleteSkill')}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── FileExplorer: Tabs + file tree + code preview + InstallPanel ── */}
      <div className="border border-[#e8e8e8] rounded overflow-hidden">
        {/* Tab navigation bar */}
        {hasReadme && (
          <div className="flex items-center px-4 border-b border-[#e8e8e8] bg-[#fafafa]">
            <button
              onClick={() => setActiveTab('readme')}
              className={`px-3 py-2.5 text-sm font-medium border-b-2 transition-colors ${activeTab === 'readme' ? 'border-[#1890ff] text-[#1890ff]' : 'border-transparent text-[rgba(0,0,0,0.65)] hover:text-[rgba(0,0,0,0.85)]'}`}
            >
              {t('skillSpace.readme')}
            </button>
            <button
              onClick={() => setActiveTab('files')}
              className={`px-3 py-2.5 text-sm font-medium border-b-2 transition-colors ${activeTab === 'files' ? 'border-[#1890ff] text-[#1890ff]' : 'border-transparent text-[rgba(0,0,0,0.65)] hover:text-[rgba(0,0,0,0.85)]'}`}
            >
              {t('skillSpace.skillFiles')}
            </button>
          </div>
        )}

        {/* Content area */}
        <div className="flex" style={{ height: 'calc(100vh - 400px)', minHeight: '350px' }}>
          {/* README Tab Content */}
          {activeTab === 'readme' && hasReadme && (
            <>
              <div className="flex-1 overflow-auto">
                <ReadmeTab content={readmeContent} loading={loadingReadme} />
              </div>
              <InstallPanel
                skillName={skill?.skillName || ''}
                skillSpaceName={skillSpaceName || undefined}
                isCustomSkill={isCustomSkill}
                onDownload={handleDownload}
                downloadLoading={downloading}
              />
            </>
          )}

          {/* Files Tab Content */}
          {(activeTab === 'files' || !hasReadme) && (
            <>
              {/* File tree 280px */}
              <div className="w-[280px] border-r border-[#e8e8e8] overflow-y-auto py-2 flex-shrink-0">
                {filteredFileTree.length === 0 ? (
                  <p className="text-xs text-[rgba(0,0,0,0.25)] text-center py-8">{t('skillSpace.noFiles')}</p>
                ) : (
                  filteredFileTree.map(node => renderTreeNode(node))
                )}
              </div>

              {/* Code preview flex-1 */}
              <div className="flex-1 overflow-hidden">
                {loadingFile ? (
                  <div className="flex items-center justify-center h-full">
                    <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
                  </div>
                ) : fileContent !== null ? (
                  <CodeViewer code={fileContent} fileName={selectedFile || ''} />
                ) : (
                  <div className="flex items-center justify-center h-full text-sm text-[rgba(0,0,0,0.25)]">
                    {t('skillSpace.clickFileToPreview')}
                  </div>
                )}
              </div>

              {/* Right InstallPanel 320px */}
              <InstallPanel
                skillName={skill?.skillName || ''}
                skillSpaceName={skillSpaceName || undefined}
                isCustomSkill={isCustomSkill}
                onDownload={handleDownload}
                downloadLoading={downloading}
              />
            </>
          )}
        </div>
      </div>

      {/* Edit dialog */}
      {showEditDialog && skill && (
        <EditSkillDialog
          token={token}
          skillSpaceId={skillSpaceId!}
          skill={skill}
          onClose={() => setShowEditDialog(false)}
          onSaved={() => { setShowEditDialog(false); loadData() }}
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
              <button onClick={() => setDeleteConfirm(null)} className="h-8 px-4 border border-[#d9d9d9] rounded text-sm text-[rgba(0,0,0,0.65)] hover:border-[#1890ff] hover:text-[#1890ff]">{t('skillSpace.cancel')}</button>
              <button onClick={deleteConfirm.onConfirm} className="h-8 px-4 bg-[#ff4d4f] text-white text-sm rounded hover:bg-[#ff7875]">{t('skillSpace.deleteSpaceConfirmOk')}</button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Basic Info dialog */}
      {editBasicInfoOpen && skill && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setEditBasicInfoOpen(false)}>
          <div className="bg-white rounded-[8px] shadow-xl w-full max-w-[480px]" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#f0f0f0]">
              <h3 className="text-base font-medium text-[rgba(0,0,0,0.88)]">{t('skillSpace.editBasicInfo')}</h3>
              <button onClick={() => setEditBasicInfoOpen(false)} className="text-[rgba(0,0,0,0.45)] hover:text-[rgba(0,0,0,0.75)] transition-colors"><X className="w-4 h-4" /></button>
            </div>
            <div className="px-6 py-4 space-y-4">
              <div>
                <label className="block text-sm font-medium text-[rgba(0,0,0,0.85)] mb-1">
                  {t('skillSpace.skillDisplayName')} <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={editDisplayName}
                  onChange={e => setEditDisplayName(e.target.value)}
                  maxLength={64}
                  className="w-full h-8 border border-[#d9d9d9] rounded px-3 text-sm focus:border-[#1890ff] focus:ring-1 focus:ring-[#1890ff]"
                  placeholder={t('skillSpace.skillDisplayNamePlaceholder')}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-[rgba(0,0,0,0.85)] mb-1">
                  {t('skillSpace.skillDescription')} <span className="text-red-500">*</span>
                </label>
                <div className="relative">
                  <textarea
                    value={editDescription}
                    onChange={e => setEditDescription(e.target.value)}
                    maxLength={1024}
                    rows={4}
                    className="w-full border border-[#d9d9d9] rounded px-3 py-1.5 text-sm focus:border-[#1890ff] focus:ring-1 focus:ring-[#1890ff] pb-6"
                    placeholder={t('skillSpace.skillDescPlaceholder')}
                  />
                  <span className="absolute right-2 bottom-1.5 text-xs text-[rgba(0,0,0,0.25)]">{editDescription.length} / 1024</span>
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2 px-6 py-4 border-t border-[#f0f0f0]">
              <button onClick={handleSaveBasicInfo} disabled={editBasicInfoSaving || !editDisplayName.trim() || !editDescription.trim()} className="h-8 px-4 bg-[#1890ff] text-white text-sm rounded hover:bg-[#40a9ff] disabled:opacity-50">
                {editBasicInfoSaving ? <Loader2 className="w-4 h-4 animate-spin inline" /> : t('skillSpace.save')}
              </button>
              <button onClick={() => setEditBasicInfoOpen(false)} className="h-8 px-4 border border-[#d9d9d9] rounded text-sm text-[rgba(0,0,0,0.65)] hover:border-[#1890ff] hover:text-[#1890ff]">{t('skillSpace.cancel')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Edit Skill Dialog (two-step, aligned with ComputeNest EditSkillModal) ──

function EditSkillDialog({ token, skillSpaceId, skill, onClose, onSaved }: {
  token: string
  skillSpaceId: string
  skill: SkillItem
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useTranslation('admin')
  const [currentStep, setCurrentStep] = useState<EditModalStep>('selectType')
  const [sourceType, setSourceType] = useState<EditSourceType>('UPLOAD')
  const [ossUrl, setOssUrl] = useState('')
  const [uploadedFile, setUploadedFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [selectedOfficialSkillId, setSelectedOfficialSkillId] = useState('')
  const [officialSkills, setOfficialSkills] = useState<SkillItem[]>([])
  const [loadingOfficialSkills, setLoadingOfficialSkills] = useState(false)
  const [editSkillSearchKeyword, setEditSkillSearchKeyword] = useState('')
  const [editSkillDropdownOpen, setEditSkillDropdownOpen] = useState(false)
  // Security detection state (aligned with ComputeNest)
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

  // File drop/select handlers (aligned with ComputeNest UploadSkillForm)
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

  const isUpdateDisabled = saving ||
    (sourceType === 'UPLOAD' && !ossUrl) ||
    (sourceType === 'COPY' && !selectedOfficialSkillId)

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-[8px] shadow-xl w-full max-w-[600px]" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#f0f0f0]">
          <h3 className="text-base font-medium text-[rgba(0,0,0,0.88)]">{t('skillSpace.editSkill')}: {skill.skillName}</h3>
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
              {/* ── UPLOAD: Drag & drop upload area (aligned with ComputeNest UploadSkillForm) ── */}
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