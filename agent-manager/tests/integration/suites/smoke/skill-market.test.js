/**
 * Smoke: Skill Market APIs
 * - 管理员可访问 Skill 市场相关接口
 * - 匿名访问被拒绝
 * - 返回数据格式正确
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { createApiClient } from '../../helpers/api-client.js'
import { getAdminToken } from '../../helpers/auth.js'

describe('smoke: skill market', () => {
  const anonymous = createApiClient()
  let adminClient

  beforeAll(async () => {
    const token = await getAdminToken()
    adminClient = createApiClient({ token })
  })

  // ----- 鉴权 -----

  it('匿名访问 /api/skill-spaces 应被拒绝', async () => {
    const res = await anonymous.get('/api/skill-spaces')
    expect([401, 403]).toContain(res.status)
  })

  it('匿名访问 /api/official-skills 应被拒绝', async () => {
    const res = await anonymous.get('/api/official-skills')
    expect([401, 403]).toContain(res.status)
  })

  it('匿名访问 /api/skill-hub-config 应被拒绝', async () => {
    const res = await anonymous.get('/api/skill-hub-config')
    expect([401, 403]).toContain(res.status)
  })

  // ----- 技能空间列表 -----

  it('GET /api/skill-spaces 返回技能空间列表', async () => {
    const res = await adminClient.get('/api/skill-spaces?maxResults=10')
    expect(res.status).toBe(200)
    expect(res.body?.success).toBe(true)
    expect(Array.isArray(res.body?.skillSpaces)).toBe(true)
  })

  it('GET /api/skill-spaces 支持 keyword 搜索', async () => {
    const res = await adminClient.get('/api/skill-spaces?keyword=test&maxResults=5')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body?.skillSpaces)).toBe(true)
  })

  // ----- 官方技能列表 -----

  it('GET /api/official-skills 返回官方技能列表', async () => {
    const res = await adminClient.get('/api/official-skills?maxResults=10')
    expect(res.status).toBe(200)
    expect(res.body?.success).toBe(true)
    expect(Array.isArray(res.body?.skills)).toBe(true)
  })

  // ----- SkillHub 配置 -----

  it('GET /api/skill-hub-config 返回配置（可为空）', async () => {
    const res = await adminClient.get('/api/skill-hub-config')
    expect(res.status).toBe(200)
    expect(res.body?.success).toBe(true)
  })

  // ----- 技能空间内技能列表（只读）-----

  it('GET /api/skill-spaces/{id}/skills 返回技能列表', async () => {
    // 先获取一个技能空间 ID
    const spacesRes = await adminClient.get('/api/skill-spaces?maxResults=1')
    const spaces = spacesRes.body?.skillSpaces || []
    if (spaces.length === 0) return // 无技能空间时跳过
    const spaceId = spaces[0].skillSpaceId
    const res = await adminClient.get(`/api/skill-spaces/${spaceId}/skills?maxResults=10`)
    expect(res.status).toBe(200)
    expect(res.body?.success).toBe(true)
    expect(Array.isArray(res.body?.skills)).toBe(true)
  })

  // ----- 官方技能详情（只读）-----

  it('GET /api/official-skills 返回的技能可查详情', async () => {
    const listRes = await adminClient.get('/api/official-skills?maxResults=1')
    const skills = listRes.body?.skills || []
    if (skills.length === 0) return // 无官方技能时跳过
    const skill = skills[0]
    const skillSpaceId = skill.skillSpaceId
    const skillId = skill.skillId
    const res = await adminClient.get(`/api/skill-spaces/${skillSpaceId}/skills/${skillId}`)
    expect(res.status).toBe(200)
    expect(res.body?.success).toBe(true)
    expect(res.body?.skill).toBeTruthy()
  })
})
