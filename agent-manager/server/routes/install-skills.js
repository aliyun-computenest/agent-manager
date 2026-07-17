import { Router } from 'express'
import { z } from 'zod'
import { defineRoute } from '../openapi/route-helper.js'
import { requireAuth } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'
import { errorResponse } from '../schemas/common.js'
import {
  InstallSkillsRequestSchema,
  InstallSkillsResponseSchema,
} from '../schemas/skill-hub.js'
import { assertInstanceAccess, AccessError } from '../services/principal-access.js'
import {
  installSkills,
  resolveSkillInstallRuntime,
  SkillInstallError,
} from '../services/skill-installer.js'
import * as computenest from '../services/computenest.js'
import { getAgentType } from '../utils/agent-config.js'

const router = Router()
const InstallSkillsParamsSchema = z.object({ instanceId: z.string().uuid() })

function sendError(res, status, code, message) {
  return res.status(status).json({ success: false, code, error: message })
}

async function resolveOfficialSkills(skills) {
  const resolved = []
  for (const requested of skills) {
    const result = await computenest.listOfficialSkills({
      skillId: requested.skillId,
      maxResults: 10,
    })
    const metadata = (result.skills || []).find(skill => skill.skillId === requested.skillId)
    if (!metadata?.skillName) {
      throw new SkillInstallError('SKILL_NOT_ALLOWED', 'Skill 不在允许范围内', 400)
    }
    resolved.push({
      skillId: metadata.skillId,
      skillName: metadata.skillName,
      skillSpaceId: null,
      skillSpaceName: null,
    })
  }
  return resolved
}

async function resolvePrivateSkills(skills) {
  const skillSpaceId = skills[0].skillSpaceId
  if (!skillSpaceId) {
    throw new SkillInstallError('SKILL_NOT_ALLOWED', '缺少 Skill 空间', 400)
  }

  const space = await computenest.getSkillSpace(skillSpaceId)
  if (!space?.skillSpaceName) {
    throw new SkillInstallError('SKILL_NOT_ALLOWED', 'Skill 空间不存在', 400)
  }

  const resolved = []
  for (const requested of skills) {
    const result = await computenest.listSkills({
      skillSpaceId,
      skillId: requested.skillId,
      maxResults: 10,
    })
    const metadata = (result.skills || []).find(skill => skill.skillId === requested.skillId)
    if (!metadata?.skillName) {
      throw new SkillInstallError('SKILL_NOT_ALLOWED', 'Skill 不在允许范围内', 400)
    }
    resolved.push({
      skillId: metadata.skillId,
      skillName: metadata.skillName,
      skillSpaceId,
      skillSpaceName: space.skillSpaceName,
    })
  }
  return resolved
}

defineRoute(router, {
  method: 'post',
  path: '/instances/{instanceId}/install-skills',
  operationId: 'installSkillsToInstance',
  tags: ['Instances', 'Skills'],
  summary: '安装 Skill 到 Agent 实例',
  description: '校验实例访问权限、运行状态和 Skill 元数据后，在 Agent Sandbox 内同步安装一个或多个 Skill。',
  security: [{ bearerAuth: [] }],
  request: {
    params: InstallSkillsParamsSchema,
    body: { content: { 'application/json': { schema: InstallSkillsRequestSchema } } },
  },
  responses: {
    200: { description: '返回本次逐项安装结果', content: { 'application/json': { schema: InstallSkillsResponseSchema } } },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    409: errorResponse,
    500: errorResponse,
    502: errorResponse,
  },
}, requireAuth, validate({ params: InstallSkillsParamsSchema, body: InstallSkillsRequestSchema }), async (req, res) => {
  const { instanceId } = req.params
  let instance
  try {
    const access = await assertInstanceAccess({
      principalId: req.user.id,
      userProfile: req.userProfile,
      instanceId,
      action: 'write',
    })
    instance = access.instance
  } catch (error) {
    if (error instanceof AccessError) {
      return sendError(res, error.status, error.status === 404 ? 'INSTANCE_NOT_FOUND' : 'INSTANCE_ACCESS_DENIED', error.message)
    }
    throw error
  }

  if (instance.status !== 'running' || !instance.sandbox_id) {
    return sendError(res, 400, 'INSTANCE_NOT_RUNNING', '实例未运行')
  }

  let agentType
  try {
    agentType = instance.agent_type_id ? await getAgentType(instance.agent_type_id) : null
  } catch (error) {
    if (error?.code === 'PGRST116') {
      return sendError(res, 400, 'SKILL_NOT_ALLOWED', '当前实例没有可用的 Agent 类型')
    }
    throw error
  }
  if (!agentType) {
    return sendError(res, 400, 'SKILL_NOT_ALLOWED', '当前实例没有可用的 Agent 类型')
  }

  let resolvedSkills
  try {
    const isPrivate = Boolean(req.body.skills[0].skillSpaceId)
    resolvedSkills = isPrivate
      ? await resolvePrivateSkills(req.body.skills)
      : await resolveOfficialSkills(req.body.skills)
  } catch (error) {
    if (error instanceof SkillInstallError) {
      return sendError(res, error.status || 400, error.code, error.message)
    }
    return sendError(res, 502, 'SKILL_CATALOG_UNAVAILABLE', 'Skill 目录暂时不可用')
  }

  const abortController = new AbortController()
  req.once('aborted', () => abortController.abort())
  try {
    const installRuntime = resolveSkillInstallRuntime(agentType)
    const results = await installSkills({
      sandboxId: instance.sandbox_id,
      sandboxUser: installRuntime.sandboxUser,
      targetRoot: installRuntime.targetRoot,
      skills: resolvedSkills,
      signal: abortController.signal,
    })
    return res.json({ success: true, results })
  } catch (error) {
    if (error instanceof SkillInstallError) {
      return sendError(res, error.status || 500, error.code, error.message)
    }
    throw error
  }
})

export default router
