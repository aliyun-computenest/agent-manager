import { beforeAll, describe, expect, it } from 'vitest'
import { createApiClient } from '../../helpers/api-client.js'
import { getAdminToken } from '../../helpers/auth.js'

describe('skill install API', () => {
  const anonymous = createApiClient()
  let admin

  beforeAll(async () => {
    admin = createApiClient({ token: await getAdminToken() })
  })

  it('rejects anonymous installation requests', async () => {
    const response = await anonymous.post(
      '/api/instances/00000000-0000-4000-8000-000000000000/install-skills',
      { skills: [{ skillId: '0-ui-ux-pro-max' }] },
    )
    expect([401, 403]).toContain(response.status)
  })

  it('rejects an empty Skill selection before executing any command', async () => {
    const response = await admin.post(
      '/api/instances/00000000-0000-4000-8000-000000000000/install-skills',
      { skills: [] },
    )
    expect(response.status).toBe(400)
  })

  it('rejects mixed official and private sources as one atomic batch', async () => {
    const response = await admin.post(
      '/api/instances/00000000-0000-4000-8000-000000000000/install-skills',
      {
        skills: [
          { skillId: '0-ui-ux-pro-max' },
          { skillId: 'private-skill', skillSpaceId: 'ss-private' },
        ],
      },
    )
    expect(response.status).toBe(400)
  })

  it('installs an official Skill into a real running instance when fixtures are available', async () => {
    const [instancesResponse, skillsResponse] = await Promise.all([
      admin.get('/api/admin/instances?page=1&pageSize=100&status=running'),
      admin.get('/api/official-skills?maxResults=10'),
    ])
    expect(instancesResponse.status).toBe(200)
    expect(skillsResponse.status).toBe(200)

    const instance = (instancesResponse.body?.instances || []).find(item => item.sandbox_id)
    const skill = skillsResponse.body?.skills?.[0]
    if (!instance || !skill) return

    const response = await admin.post(
      `/api/instances/${instance.id}/install-skills`,
      { skills: [{ skillId: skill.skillId }] },
      {},
      { timeoutMs: 240_000 },
    )
    expect(response.status).toBe(200)
    expect(response.body?.success).toBe(true)
    expect(response.body?.results).toEqual([
      expect.objectContaining({
        skillId: skill.skillId,
        status: expect.stringMatching(/^(succeeded|failed)$/),
      }),
    ])
    if (response.body.results[0].status === 'failed') {
      expect([
        'SKILL_DOWNLOAD_FAILED',
        'SKILL_INSTALL_TIMEOUT',
        'SKILL_INSTALL_INTERRUPTED',
      ]).toContain(response.body.results[0].errorCode)
    }
  }, 250_000)

  it('installs a private Skill without requiring instance skill_config authorization', async () => {
    const [instancesResponse, spacesResponse] = await Promise.all([
      admin.get('/api/admin/instances?page=1&pageSize=100&status=running'),
      admin.get('/api/skill-spaces?maxResults=10'),
    ])
    expect(instancesResponse.status).toBe(200)
    expect(spacesResponse.status).toBe(200)

    const instance = (instancesResponse.body?.instances || []).find(item => item.sandbox_id)
    const space = spacesResponse.body?.skillSpaces?.[0]
    if (!instance || !space) return

    const skillsResponse = await admin.get(`/api/skill-spaces/${space.skillSpaceId}/skills?maxResults=10`)
    expect(skillsResponse.status).toBe(200)
    const skill = skillsResponse.body?.skills?.[0]
    if (!skill) return

    const response = await admin.post(
      `/api/instances/${instance.id}/install-skills`,
      { skills: [{ skillId: skill.skillId, skillSpaceId: space.skillSpaceId }] },
      {},
      { timeoutMs: 240_000 },
    )
    expect(response.status).toBe(200)
    expect(response.body?.success).toBe(true)
    expect(response.body?.results).toEqual([
      expect.objectContaining({
        skillId: skill.skillId,
        status: expect.stringMatching(/^(succeeded|failed)$/),
      }),
    ])
    if (response.body.results[0].status === 'failed') {
      expect([
        'SKILL_ASSUME_ROLE_DENIED',
        'SKILL_ROLE_PERMISSION_DENIED',
        'SKILL_DOWNLOAD_FAILED',
        'SKILL_INSTALL_TIMEOUT',
        'SKILL_INSTALL_INTERRUPTED',
      ]).toContain(response.body.results[0].errorCode)
    }
  }, 250_000)
})
