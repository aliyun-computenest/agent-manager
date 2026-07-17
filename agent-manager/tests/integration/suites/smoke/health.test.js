/**
 * Smoke: 基础健康检查
 */
import { describe, it, expect } from 'vitest'
import { createApiClient, expectOk } from '../../helpers/api-client.js'

describe('smoke: /api/health', () => {
  const client = createApiClient()

  it('健康检查应返回 ok', async () => {
    const body = await expectOk(client.get('/api/health'))
    expect(body.status).toBe('ok')
    expect(body).toHaveProperty('version')
    expect(body).toHaveProperty('timestamp')
  })

  it('版本端点可访问', async () => {
    const body = await expectOk(client.get('/api/version'))
    expect(body).toHaveProperty('version')
  })
})
