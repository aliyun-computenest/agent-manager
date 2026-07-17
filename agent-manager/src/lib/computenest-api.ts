/**
 * ComputeNest Skill API client — wraps all 15 proxy endpoints
 * exposed by the agent-manager backend.
 */
import { apiUrl } from './api'

// ── Types ──────────────────────────────────────────────────────────

export interface SkillHubConfigResponse {
  success: boolean
  configured: boolean
  hubConfig: {
    ossBucketName: string
    ossRegionId: string
  } | null
}

export interface SkillSpaceItem {
  skillSpaceId: string
  skillSpaceName: string
  skillSpaceDescription: string
  createTime?: string
  updateTime?: string
}

export interface ListSkillSpacesResponse {
  success: boolean
  skillSpaces: SkillSpaceItem[]
  nextToken: string | null
  totalCount: number
}

export interface CreateSkillSpaceResponse {
  success: boolean
  skillSpaceId: string
}

export interface SkillItem {
  skillId: string
  skillName: string
  skillDisplayName?: string
  skillDescription: string
  skillSpaceId: string
  skillLabels?: string[]
  downloadUrl?: string
  createTime?: string
  updateTime?: string
}

export interface ListSkillsResponse {
  success: boolean
  skills: SkillItem[]
  nextToken: string | null
  totalCount: number
}

export interface CreateSkillResponse {
  success: boolean
  skillId: string
}

export interface SkillFileItem {
  filePath: string
  signedUrl: string
}

export interface ListSkillFilesResponse {
  success: boolean
  skillFiles: SkillFileItem[]
  nextToken: string | null
  totalCount: number
}

export interface FileDetectResult {
  success: boolean
  hashKey: string
  result: number  // 0=safe, 1=suspicious, 2=failed, 3=detecting
  score: number
  message: string
}

export interface InstallSkillInput {
  skillId: string
  skillSpaceId?: string
}

export interface InstallSkillResult {
  skillId: string
  status: 'succeeded' | 'failed'
  errorCode: string | null
  errorMessage: string | null
}

export interface InstallSkillsResponse {
  success: true
  results: InstallSkillResult[]
}

// ── Official skill label categories ────────────────────────────────

export const SKILL_LABEL_CATEGORIES = [
  { value: 'category:skill-management', label: '技能管理' },
  { value: 'category:developer-tools', label: '开发工具' },
  { value: 'category:marketing-seo', label: '营销 SEO' },
  { value: 'category:frontend-development', label: '前端开发' },
  { value: 'category:ai-media', label: 'AI 媒体' },
  { value: 'category:code-quality-testing', label: '代码质量与测试' },
  { value: 'category:mobile-development', label: '移动开发' },
  { value: 'category:cloud-devops', label: '云与运维' },
  { value: 'category:other', label: '其他' },
] as const

// ── Helpers ────────────────────────────────────────────────────────

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  })
  const data = await res.json()
  if (!data.success) {
    throw new Error(data.error || `ComputeNest API error: ${res.status}`)
  }
  return data as T
}

function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` }
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') search.set(k, String(v))
  }
  const s = search.toString()
  return s ? `?${s}` : ''
}

// ── API Functions ──────────────────────────────────────────────────

/** GET /api/skill-hub-config */
export async function getSkillHubConfig(token: string): Promise<SkillHubConfigResponse> {
  return request<SkillHubConfigResponse>('/api/skill-hub-config', {
    headers: authHeader(token),
  })
}

/** GET /api/skill-spaces */
export async function listSkillSpaces(
  token: string,
  params?: { keyword?: string; nextToken?: string; maxResults?: number },
): Promise<ListSkillSpacesResponse> {
  return request<ListSkillSpacesResponse>(`/api/skill-spaces${qs(params || {})}`, {
    headers: authHeader(token),
  })
}

/** POST /api/skill-spaces */
export async function createSkillSpace(
  token: string,
  body: { skillSpaceName: string; skillSpaceDescription: string },
): Promise<CreateSkillSpaceResponse> {
  return request<CreateSkillSpaceResponse>('/api/skill-spaces', {
    method: 'POST',
    headers: authHeader(token),
    body: JSON.stringify(body),
  })
}

/** GET /api/skill-spaces/:skillSpaceId */
export async function getSkillSpace(
  token: string,
  skillSpaceId: string,
): Promise<{ success: boolean; skillSpace: SkillSpaceItem }> {
  return request(`/api/skill-spaces/${skillSpaceId}`, {
    headers: authHeader(token),
  })
}

/** DELETE /api/skill-spaces/:skillSpaceId */
export async function deleteSkillSpace(
  token: string,
  skillSpaceId: string,
): Promise<{ success: boolean }> {
  return request(`/api/skill-spaces/${skillSpaceId}`, {
    method: 'DELETE',
    headers: authHeader(token),
  })
}

/** GET /api/skill-spaces/:skillSpaceId/skills */
export async function listSkills(
  token: string,
  skillSpaceId: string,
  params?: { keyword?: string; nextToken?: string; maxResults?: number },
): Promise<ListSkillsResponse> {
  return request<ListSkillsResponse>(
    `/api/skill-spaces/${skillSpaceId}/skills${qs(params || {})}`,
    { headers: authHeader(token) },
  )
}

/** POST /api/skill-spaces/:skillSpaceId/skills */
export async function createSkill(
  token: string,
  skillSpaceId: string,
  body: {
    sourceType: string
    skillName: string
    skillDisplayName: string
    skillDescription: string
    ossUrl?: string
    sourceSkillId?: string
    skillLabels?: string[]
  },
): Promise<CreateSkillResponse> {
  return request<CreateSkillResponse>(`/api/skill-spaces/${skillSpaceId}/skills`, {
    method: 'POST',
    headers: authHeader(token),
    body: JSON.stringify(body),
  })
}

/** GET /api/skill-spaces/:skillSpaceId/skills/:skillId */
export async function getSkill(
  token: string,
  skillSpaceId: string,
  skillId: string,
): Promise<{ success: boolean; skill: SkillItem }> {
  return request(
    `/api/skill-spaces/${skillSpaceId}/skills/${skillId}`,
    { headers: authHeader(token) },
  )
}

/** PUT /api/skill-spaces/:skillSpaceId/skills/:skillId */
export async function updateSkill(
  token: string,
  skillSpaceId: string,
  skillId: string,
  body: {
    sourceType?: string
    skillName?: string
    skillDisplayName?: string
    skillDescription?: string
    ossUrl?: string
    sourceSkillId?: string
    skillLabels?: string[]
  },
): Promise<CreateSkillResponse> {
  return request<CreateSkillResponse>(
    `/api/skill-spaces/${skillSpaceId}/skills/${skillId}`,
    {
      method: 'PUT',
      headers: authHeader(token),
      body: JSON.stringify(body),
    },
  )
}

/** DELETE /api/skill-spaces/:skillSpaceId/skills/:skillId */
export async function deleteSkill(
  token: string,
  skillSpaceId: string,
  skillId: string,
): Promise<{ success: boolean }> {
  return request(`/api/skill-spaces/${skillSpaceId}/skills/${skillId}`, {
    method: 'DELETE',
    headers: authHeader(token),
  })
}

/** GET /api/skill-spaces/:skillSpaceId/skills/:skillId/files */
export async function listSkillFiles(
  token: string,
  skillSpaceId: string,
  skillId: string,
  params?: { maxResults?: number; nextToken?: string },
): Promise<ListSkillFilesResponse> {
  return request<ListSkillFilesResponse>(
    `/api/skill-spaces/${skillSpaceId}/skills/${skillId}/files${qs(params || {})}`,
    { headers: authHeader(token) },
  )
}

/** GET /api/skill-spaces/:skillSpaceId/skills/:skillId/file-content — proxy fetch file content via backend */
export async function getSkillFileContent(
  token: string,
  skillSpaceId: string,
  skillId: string,
  filePath: string,
): Promise<string> {
  const params = qs({ filePath })
  const res = await fetch(
    `${apiUrl}/api/skill-spaces/${skillSpaceId}/skills/${skillId}/file-content${params}`,
    { headers: { ...authHeader(token) } },
  )
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    throw new Error(data.error || `Failed to fetch file content: ${res.status}`)
  }
  return res.text()
}

/** Download skill via backend proxy (avoids browser CORS with OSS downloadUrl) */
export async function downloadSkill(
  token: string,
  skillSpaceId: string,
  skillId: string,
  skillName: string,
  isCustomSkill?: boolean,
): Promise<void> {
  // Use backend download proxy — backend fetches OSS downloadUrl and streams zip back
  const skillType = isCustomSkill ? 'custom' : 'official'
  const downloadUrl = `${apiUrl}/api/skill-spaces/${skillSpaceId}/skills/${skillId}/download${qs({ skillName, skillType })}`
  const res = await fetch(downloadUrl, { headers: authHeader(token) })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    throw new Error(data.error || `下载失败: HTTP ${res.status}`)
  }
  // Read response as blob and trigger browser download
  const blob = await res.blob()
  const blobUrl = window.URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = blobUrl
  link.download = `${skillName}.zip`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  window.URL.revokeObjectURL(blobUrl)
}

/** Upload skill file to OSS via backend proxy (multipart/form-data) */
export interface UploadSkillFileResponse {
  ossUrl: string
  metadata: { name: string; description: string } | null
}

export async function uploadSkillFile(
  token: string,
  skillSpaceId: string,
  file: File,
): Promise<UploadSkillFileResponse> {
  const formData = new FormData()
  formData.append('file', file)
  const res = await fetch(
    `${apiUrl}/api/skill-spaces/${skillSpaceId}/skills/upload`,
    {
      method: 'POST',
      headers: authHeader(token),
      body: formData,
    },
  )
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    throw new Error(data.error || `Upload failed: ${res.status}`)
  }
  const data = await res.json()
  return { ossUrl: data.ossUrl, metadata: data.metadata || null }
}

/** GET /api/official-skills */
export async function listOfficialSkills(
  token: string,
  params?: { keyword?: string; skillLabel?: string; nextToken?: string; maxResults?: number },
): Promise<ListSkillsResponse> {
  return request<ListSkillsResponse>(`/api/official-skills${qs(params || {})}`, {
    headers: authHeader(token),
  })
}

/** POST /api/instances/:instanceId/install-skills */
export async function installSkills(
  token: string,
  instanceId: string,
  skills: InstallSkillInput[],
): Promise<InstallSkillsResponse> {
  return request<InstallSkillsResponse>(`/api/instances/${instanceId}/install-skills`, {
    method: 'POST',
    headers: authHeader(token),
    body: JSON.stringify({ skills }),
  })
}

/** POST /api/skill-file-detect */
export async function createSkillFileDetect(
  token: string,
  body: { ossUrl: string },
): Promise<{ success: boolean; hashKey: string }> {
  return request('/api/skill-file-detect', {
    method: 'POST',
    headers: authHeader(token),
    body: JSON.stringify(body),
  })
}

/** GET /api/skill-file-detect/:hashKey */
export async function getSkillFileDetectResult(
  token: string,
  hashKey: string,
): Promise<FileDetectResult> {
  return request(`/api/skill-file-detect/${hashKey}`, {
    headers: authHeader(token),
  })
}

/**
 * Poll file detect result until complete (result !== 3) or timeout.
 * @returns Final FileDetectResult
 * @throws Error on timeout (60s)
 */
export async function pollFileDetectResult(
  token: string,
  hashKey: string,
  { interval = 2000, timeout = 60000 }: { interval?: number; timeout?: number } = {},
): Promise<FileDetectResult> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const result = await getSkillFileDetectResult(token, hashKey)
    if (result.result !== 3) return result
    await new Promise(r => setTimeout(r, interval))
  }
  throw new Error('文件安全检测超时，请稍后重试')
}

/** 对齐计算巢 getSkillDisplayName：优先 skillDisplayName，fallback 到 skillName */
export function getSkillDisplayName(skill: Pick<SkillItem, 'skillName' | 'skillDisplayName'>): string {
  return skill.skillDisplayName || skill.skillName
}
