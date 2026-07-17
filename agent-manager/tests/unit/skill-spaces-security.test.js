import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../server/middleware/auth.js', () => ({
  requireAuth: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}))

vi.mock('../../server/services/computenest.js', () => ({
  listSkills: vi.fn(),
  listOfficialSkills: vi.fn(),
}))

vi.mock('../../server/utils/logger.js', () => ({
  appLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import router from '../../server/routes/skill-spaces.js'
import * as computenest from '../../server/services/computenest.js'

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    headersSent: false,
    status(code) {
      this.statusCode = code
      return this
    },
    json(body) {
      this.body = body
      this.headersSent = true
      return this
    },
  }
}

async function invokeRoute(path, request) {
  const route = router.stack.find(layer => layer.route?.path === path)?.route
  if (!route) throw new Error(`Route not found: ${path}`)
  const handlers = route.stack.map(layer => layer.handle)
  const response = createResponse()

  async function dispatch(index) {
    if (index >= handlers.length) return
    let nextCalled = false
    let downstream
    const next = error => {
      nextCalled = true
      downstream = error ? Promise.reject(error) : dispatch(index + 1)
      return downstream
    }
    await handlers[index](request, response, next)
    if (nextCalled) await downstream
  }

  await dispatch(0)
  return response
}

describe('Skill catalog download URL boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each([
    ['/skill-spaces/:skillSpaceId/skills', 'listSkills', { skillSpaceId: 'space-1' }],
    ['/official-skills', 'listOfficialSkills', {}],
  ])('rejects needDownloadUrl on the user catalog route %s', async (path, serviceName, params) => {
    const response = await invokeRoute(path, {
      params,
      query: { needDownloadUrl: 'true' },
    })

    expect(response.statusCode).toBe(400)
    expect(response.body).toEqual(expect.objectContaining({ success: false }))
    expect(computenest[serviceName]).not.toHaveBeenCalled()
  })

  it.each([
    ['/skill-spaces/:skillSpaceId/skills', 'listSkills', { skillSpaceId: 'space-1' }],
    ['/official-skills', 'listOfficialSkills', {}],
  ])('strips download URLs from the user catalog response %s', async (path, serviceName, params) => {
    computenest[serviceName].mockResolvedValue({
      skills: [{
        skillId: 'skill-1',
        skillName: 'private-skill',
        skillDescription: 'test',
        skillSpaceId: 'space-1',
        downloadUrl: 'https://example.com/signed',
        DownloadUrl: 'https://example.com/legacy-signed',
      }],
    })

    const response = await invokeRoute(path, { params, query: {} })

    expect(response.statusCode).toBe(200)
    expect(response.body.skills[0]).not.toHaveProperty('downloadUrl')
    expect(response.body.skills[0]).not.toHaveProperty('DownloadUrl')
    expect(computenest[serviceName]).toHaveBeenCalledWith(expect.not.objectContaining({ needDownloadUrl: expect.anything() }))
  })

  it('keeps download URL lookup inside the administrator download proxy', async () => {
    computenest.listSkills.mockResolvedValue({ skills: [{ skillId: 'skill-1' }] })

    const response = await invokeRoute('/skill-spaces/:skillSpaceId/skills/:skillId/download', {
      params: { skillSpaceId: 'space-1', skillId: 'skill-1' },
      query: { skillType: 'custom' },
    })

    expect(response.statusCode).toBe(404)
    expect(computenest.listSkills).toHaveBeenCalledWith({
      skillSpaceId: 'space-1',
      skillId: 'skill-1',
      needDownloadUrl: true,
    })
  })
})
