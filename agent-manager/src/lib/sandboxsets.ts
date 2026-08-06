import { apiUrl } from './api'

export interface SandboxSetSummary {
  name: string
  namespace: string
  image: string
  replicas: number
  updatedAt: string
  relatedAgentTypeCodes: string[]
}

export interface SandboxSetDetail extends SandboxSetSummary {
  yaml: string
  createdAt: string
}

async function request<T>(path: string, token: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${apiUrl}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      ...(options?.body ? { 'Content-Type': 'application/json' } : {}),
      ...options?.headers,
    },
  })
  const data = await res.json()
  if (!data.success) {
    const err = new Error(data.error || '请求失败')
    ;(err as any).code = data.code
    ;(err as any).httpStatus = res.status
    throw err
  }
  return data
}

export async function listSandboxSets(token: string, namespace?: string): Promise<SandboxSetSummary[]> {
  const qs = namespace ? `?namespace=${encodeURIComponent(namespace)}` : ''
  const data = await request<{ sandboxSets: SandboxSetSummary[] }>(`/api/sandboxsets${qs}`, token)
  return data.sandboxSets || []
}

export async function getSandboxSet(name: string, token: string, namespace = 'default'): Promise<SandboxSetDetail | null> {
  try {
    const data = await request<{ sandboxSet: SandboxSetDetail }>(
      `/api/sandboxsets/${encodeURIComponent(name)}?namespace=${encodeURIComponent(namespace)}`,
      token,
    )
    return data.sandboxSet
  } catch (err: any) {
    if (err.httpStatus === 404) return null
    throw err
  }
}

export async function createSandboxSet(
  input: { name: string; namespace: string; yaml: string },
  token: string,
): Promise<SandboxSetDetail> {
  const data = await request<{ sandboxSet: SandboxSetDetail }>('/api/sandboxsets', token, {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return data.sandboxSet
}

export async function saveSandboxSet(
  name: string,
  yamlStr: string,
  token: string,
  namespace = 'default',
): Promise<SandboxSetDetail> {
  const data = await request<{ sandboxSet: SandboxSetDetail }>(
    `/api/sandboxsets/${encodeURIComponent(name)}?namespace=${encodeURIComponent(namespace)}`,
    token,
    { method: 'PUT', body: JSON.stringify({ yaml: yamlStr }) },
  )
  return data.sandboxSet
}

export async function deleteSandboxSet(
  name: string,
  token: string,
  namespace = 'default',
): Promise<void> {
  await request(
    `/api/sandboxsets/${encodeURIComponent(name)}?namespace=${encodeURIComponent(namespace)}`,
    token,
    { method: 'DELETE' },
  )
}
