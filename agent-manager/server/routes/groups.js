/**
 * Agent group sharing routes
 */

import { randomUUID } from 'crypto'
import { Router } from 'express'
import { z } from 'zod'
import { supabaseAdmin } from '../config/index.js'
import { requireAuth } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'
import { defineRoute } from '../openapi/route-helper.js'
import { errorResponse } from '../schemas/common.js'
import {
  AccessError,
  assertGroupMembership,
  isPlatformAdminProfile
} from '../services/principal-access.js'
import {
  sendGroupError,
  parseFilters,
  loadPrincipalProfiles,
  buildGroupResponse,
  getGroupOrThrow,
  ensureGroupCredential,
  assertCanManageGroup,
  sanitizePostgrestSearch
} from './groups-helpers.js'
import groupsLimitRouter from './groups-limit.js'

const router = Router()

const GroupIdParamsSchema = z.object({
  groupId: z.string().uuid().describe('Group principal ID')
})

const GroupMemberParamsSchema = GroupIdParamsSchema.extend({
  principalId: z.string().uuid().describe('Member principal ID')
})

const ListGroupsQuerySchema = z.object({}).passthrough()
const ListMembersQuerySchema = z.object({}).passthrough()

const CreateGroupBody = z.object({
  name: z.string().min(1).max(100),
  maxAgentInstances: z.number().int().min(0).optional()
})

const UpdateGroupBody = z.object({
  name: z.string().min(1).max(100).optional(),
  maxAgentInstances: z.number().int().min(0).optional()
})

const AddMemberBody = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'member']).optional()
})

const GroupResponseSchema = z.object({
  success: z.literal(true),
  group: z.object({
    id: z.string().uuid(),
    name: z.string(),
    role: z.string().nullable(),
    quota: z.object({
      used: z.number().int(),
      limit: z.number().int().nullable()
    }),
    apiKey: z.object({
      status: z.string(),
      provider: z.string().nullable()
    }),
    createdAt: z.string(),
    updatedAt: z.string()
  })
})

const ListGroupsResponseSchema = z.object({
  success: z.literal(true),
  groups: z.array(GroupResponseSchema.shape.group)
})

const GroupMemberSchema = z.object({
  principalId: z.string().uuid(),
  username: z.string().nullable(),
  email: z.string().nullable(),
  role: z.enum(['admin', 'member']),
  status: z.enum(['active', 'removed']),
  createdAt: z.string(),
  updatedAt: z.string()
})

const ListMembersResponseSchema = z.object({
  success: z.literal(true),
  members: z.array(GroupMemberSchema)
})

const GroupMemberResponseSchema = z.object({
  success: z.literal(true),
  member: GroupMemberSchema
})

const DeleteGroupResponseSchema = z.object({
  success: z.literal(true),
  message: z.string(),
  groupId: z.string().uuid()
})

async function loadGroupUsage(groupIds) {
  const ids = [...new Set((groupIds || []).filter(Boolean))]
  if (ids.length === 0) return new Map()

  const usage = new Map(ids.map(id => [id, 0]))
  const { data, error } = await supabaseAdmin
    .rpc('get_group_usage_counts', { target_group_ids: ids })

  if (error) throw new AccessError(`Failed to load group usage: ${error.message}`, 500)

  for (const row of data || []) {
    usage.set(row.group_id, Number(row.instance_count || 0))
  }
  return usage
}

/**
 * GET /api/groups
 */
defineRoute(router, {
  method: 'get',
  path: '/groups',
  operationId: 'listGroups',
  tags: ['Groups'],
  summary: '列出可访问的分组',
  description: '平台管理员返回全部分组，普通用户返回自己 active 加入的分组。',
  security: [{ bearerAuth: [] }],
  request: { query: ListGroupsQuerySchema },
  responses: {
    200: { description: '成功返回分组列表', content: { 'application/json': { schema: ListGroupsResponseSchema } } },
    400: errorResponse,
    401: errorResponse,
    500: errorResponse
  }
}, requireAuth, validate({ query: ListGroupsQuerySchema }), async (req, res) => {
  try {
    const filters = parseFilters(req.query.filter, ['search'])
    const search = filters.search?.[0] || ''
    const roleByGroup = new Map()
    let groupIds = null

    if (!isPlatformAdminProfile(req.userProfile)) {
      const { data: memberships, error } = await supabaseAdmin
        .from('agent_group_members')
        .select('group_id, role')
        .eq('principal_id', req.user.id)
        .eq('status', 'active')

      if (error) throw new AccessError(`Failed to load groups: ${error.message}`, 500)
      groupIds = (memberships || []).map(membership => membership.group_id)
      for (const membership of memberships || []) roleByGroup.set(membership.group_id, membership.role)
      if (groupIds.length === 0) {
        return res.json({ success: true, groups: [] })
      }
    }

    let query = supabaseAdmin
      .from('principal_profiles')
      .select('*')
      .eq('principal_type', 'group')
      .order('created_at', { ascending: false })

    if (groupIds) query = query.in('id', groupIds)
    if (search) {
      const sanitized = sanitizePostgrestSearch(search)
      if (sanitized) query = query.ilike('name', `%${sanitized}%`)
    }

    const { data: groups, error } = await query
    if (error) throw new AccessError(`Failed to list groups: ${error.message}`, 500)

    const ids = (groups || []).map(group => group.principal_id || group.id)
    const usage = await loadGroupUsage(ids)

    res.json({
      success: true,
      groups: (groups || []).map(group => buildGroupResponse(group, {
        role: isPlatformAdminProfile(req.userProfile) ? 'admin' : roleByGroup.get(group.principal_id || group.id) || null,
        used: usage.get(group.principal_id || group.id) || 0
      }))
    })
  } catch (error) {
    return sendGroupError(res, error)
  }
})

/**
 * GET /api/groups/:groupId
 */
defineRoute(router, {
  method: 'get',
  path: '/groups/{groupId}',
  operationId: 'getGroupById',
  tags: ['Groups'],
  summary: '获取分组详情',
  description: 'active 成员或平台管理员可查看分组详情。',
  security: [{ bearerAuth: [] }],
  request: { params: GroupIdParamsSchema },
  responses: {
    200: { description: '成功返回分组详情', content: { 'application/json': { schema: GroupResponseSchema } } },
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    500: errorResponse
  }
}, requireAuth, validate({ params: GroupIdParamsSchema }), async (req, res) => {
  try {
    const { groupId } = req.params
    const group = await getGroupOrThrow(groupId)
    let role = 'admin'
    if (!isPlatformAdminProfile(req.userProfile)) {
      const membership = await assertGroupMembership({ principalId: req.user.id, userProfile: req.userProfile, groupId })
      role = membership.role
    }
    const usage = await loadGroupUsage([groupId])
    res.json({
      success: true,
      group: buildGroupResponse(group, {
        role,
        used: usage.get(groupId) || 0
      })
    })
  } catch (error) {
    return sendGroupError(res, error)
  }
})

/**
 * GET /api/groups/:groupId/members
 */
defineRoute(router, {
  method: 'get',
  path: '/groups/{groupId}/members',
  operationId: 'listGroupMembers',
  tags: ['Groups'],
  summary: '列出分组成员',
  description: '列出分组成员，默认仅返回 active 成员。',
  security: [{ bearerAuth: [] }],
  request: { params: GroupIdParamsSchema, query: ListMembersQuerySchema },
  responses: {
    200: { description: '成功返回成员列表', content: { 'application/json': { schema: ListMembersResponseSchema } } },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    500: errorResponse
  }
}, requireAuth, validate({ params: GroupIdParamsSchema, query: ListMembersQuerySchema }), async (req, res) => {
  try {
    const { groupId } = req.params
    await getGroupOrThrow(groupId)
    const filters = parseFilters(req.query.filter, ['status'])
    const status = filters.status?.[0] || 'active'

    if (status !== 'active') {
      await assertCanManageGroup({ principalId: req.user.id, userProfile: req.userProfile, groupId })
    } else if (!isPlatformAdminProfile(req.userProfile)) {
      await assertGroupMembership({ principalId: req.user.id, userProfile: req.userProfile, groupId })
    }

    let query = supabaseAdmin
      .from('agent_group_members')
      .select('principal_id, role, status, created_at, updated_at')
      .eq('group_id', groupId)
      .order('created_at', { ascending: true })

    if (status) query = query.eq('status', status)

    const { data: memberships, error } = await query
    if (error) throw new AccessError(`Failed to list members: ${error.message}`, 500)

    const principalMap = await loadPrincipalProfiles((memberships || []).map(membership => membership.principal_id))
    res.json({
      success: true,
      members: (memberships || []).map(membership => {
        const profile = principalMap.get(membership.principal_id)
        return {
          principalId: membership.principal_id,
          username: profile?.username || null,
          email: profile?.email || null,
          role: membership.role,
          status: membership.status,
          createdAt: membership.created_at,
          updatedAt: membership.updated_at
        }
      })
    })
  } catch (error) {
    return sendGroupError(res, error)
  }
})

/**
 * POST /api/groups
 */
defineRoute(router, {
  method: 'post',
  path: '/groups',
  operationId: 'createGroup',
  tags: ['Groups'],
  summary: '创建分组',
  description: '仅平台管理员可创建分组，创建者作为初始分组管理员。',
  security: [{ bearerAuth: [] }],
  request: { body: { content: { 'application/json': { schema: CreateGroupBody } } } },
  responses: {
    200: { description: '创建成功', content: { 'application/json': { schema: GroupResponseSchema } } },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    500: errorResponse
  }
}, requireAuth, validate({ body: CreateGroupBody }), async (req, res) => {
  if (!isPlatformAdminProfile(req.userProfile)) {
    return res.status(403).json({
      success: false,
      error: 'ADMIN_ACCESS_REQUIRED',
      message: 'Admin access required'
    })
  }

  const principalId = randomUUID()
  try {
    const { data: groups, error: groupError } = await supabaseAdmin
      .rpc('create_group_with_admin', {
        target_group_id: principalId,
        group_name: req.body.name,
        admin_principal_id: req.user.id
      })
    let group = groups?.[0]

    if (groupError) throw new AccessError(`Failed to create group: ${groupError.message}`, 500)
    if (!group) throw new AccessError('Failed to create group', 500)

    if (req.body.maxAgentInstances !== undefined) {
      const { data: updatedGroup, error: quotaError } = await supabaseAdmin
        .from('principal_profiles')
        .update({
          max_agent_instances: req.body.maxAgentInstances,
          updated_at: new Date().toISOString()
        })
        .eq('id', principalId)
        .eq('principal_type', 'group')
        .select()
        .single()

      if (quotaError) throw new AccessError(`Failed to update group quota: ${quotaError.message}`, 500)
      group = updatedGroup
    }

    const groupWithCredential = await ensureGroupCredential(group)

    res.json({
      success: true,
      group: buildGroupResponse(groupWithCredential, {
        role: 'admin',
        used: 0
      })
    })
  } catch (error) {
    return sendGroupError(res, error)
  }
})

/**
 * PUT /api/groups/:groupId
 */
defineRoute(router, {
  method: 'put',
  path: '/groups/{groupId}',
  operationId: 'updateGroupById',
  tags: ['Groups'],
  summary: '更新分组',
  description: '更新分组名称或实例数量上限。',
  security: [{ bearerAuth: [] }],
  request: {
    params: GroupIdParamsSchema,
    body: { content: { 'application/json': { schema: UpdateGroupBody } } }
  },
  responses: {
    200: { description: '更新成功', content: { 'application/json': { schema: GroupResponseSchema } } },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    500: errorResponse
  }
}, requireAuth, validate({ params: GroupIdParamsSchema, body: UpdateGroupBody }), async (req, res) => {
  try {
    const { groupId } = req.params
    await getGroupOrThrow(groupId)
    await assertCanManageGroup({ principalId: req.user.id, userProfile: req.userProfile, groupId })

    const updates = { updated_at: new Date().toISOString() }
    if (req.body.name !== undefined) updates.name = req.body.name
    if (req.body.maxAgentInstances !== undefined) updates.max_agent_instances = req.body.maxAgentInstances

    const { data: group, error } = await supabaseAdmin
      .from('principal_profiles')
      .update(updates)
      .eq('id', groupId)
      .eq('principal_type', 'group')
      .select()
      .single()

    if (error) throw new AccessError(`Failed to update group: ${error.message}`, 500)

    const usage = await loadGroupUsage([groupId])
    res.json({
      success: true,
      group: buildGroupResponse(group, {
        role: isPlatformAdminProfile(req.userProfile) ? 'admin' : null,
        used: usage.get(groupId) || 0
      })
    })
  } catch (error) {
    return sendGroupError(res, error)
  }
})

/**
 * DELETE /api/groups/:groupId
 */
defineRoute(router, {
  method: 'delete',
  path: '/groups/{groupId}',
  operationId: 'deleteGroupById',
  tags: ['Groups'],
  summary: '删除空分组',
  description: '仅平台管理员可删除没有实例、没有 active 成员的分组。',
  security: [{ bearerAuth: [] }],
  request: { params: GroupIdParamsSchema },
  responses: {
    200: { description: '删除成功', content: { 'application/json': { schema: DeleteGroupResponseSchema } } },
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    409: errorResponse,
    500: errorResponse
  }
}, requireAuth, validate({ params: GroupIdParamsSchema }), async (req, res) => {
  if (!isPlatformAdminProfile(req.userProfile)) {
    return res.status(403).json({
      success: false,
      error: 'ADMIN_ACCESS_REQUIRED',
      message: 'Admin access required'
    })
  }

  try {
    const { groupId } = req.params
    await getGroupOrThrow(groupId)

    const { count: instanceCount, error: instanceError } = await supabaseAdmin
      .from('agent_instances')
      .select('id', { count: 'exact', head: true })
      .eq('principal_id', groupId)
    if (instanceError) throw new AccessError(`Failed to check group instances: ${instanceError.message}`, 500)
    if ((instanceCount || 0) > 0) {
      return res.status(409).json({
        success: false,
        error: 'GROUP_HAS_INSTANCES',
        message: 'Group still has active instances'
      })
    }

    const { count: memberCount, error: memberError } = await supabaseAdmin
      .from('agent_group_members')
      .select('id', { count: 'exact', head: true })
      .eq('group_id', groupId)
      .eq('status', 'active')
    if (memberError) throw new AccessError(`Failed to check group members: ${memberError.message}`, 500)
    if ((memberCount || 0) > 0) {
      return res.status(409).json({
        success: false,
        error: 'GROUP_HAS_ACTIVE_MEMBERS',
        message: 'Group still has active members'
      })
    }

    // 删除 group principal 会清理本地 credential 字段；当前 provider 层没有统一 revoke 接口，
    // 因此删除前只阻断仍有实例或 active 成员的分组。
    const { error } = await supabaseAdmin
      .from('principal_profiles')
      .delete()
      .eq('id', groupId)
      .eq('principal_type', 'group')
    if (error) throw new AccessError(`Failed to delete group: ${error.message}`, 500)

    res.json({ success: true, message: 'Group deleted successfully', groupId })
  } catch (error) {
    return sendGroupError(res, error)
  }
})

/**
 * POST /api/groups/:groupId/members
 */
defineRoute(router, {
  method: 'post',
  path: '/groups/{groupId}/members',
  operationId: 'upsertGroupMember',
  tags: ['Groups'],
  summary: '添加或更新分组成员',
  description: '添加 active 用户为分组成员，或恢复并更新已有 membership。',
  security: [{ bearerAuth: [] }],
  request: {
    params: GroupIdParamsSchema,
    body: { content: { 'application/json': { schema: AddMemberBody } } }
  },
  responses: {
    200: { description: '更新成功', content: { 'application/json': { schema: GroupMemberResponseSchema } } },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    500: errorResponse
  }
}, requireAuth, validate({ params: GroupIdParamsSchema, body: AddMemberBody }), async (req, res) => {
  try {
    const { groupId } = req.params
    const role = req.body.role || 'member'
    await getGroupOrThrow(groupId)
    await assertCanManageGroup({ principalId: req.user.id, userProfile: req.userProfile, groupId })

    const { data: principal, error: principalError } = await supabaseAdmin
      .from('principal_profiles')
      .select('principal_id:id, username:name, email')
      .eq('principal_type', 'user')
      .eq('status', 'active')
      .eq('email', req.body.email)
      .maybeSingle()

    if (principalError) throw new AccessError(`Failed to load member principal: ${principalError.message}`, 500)
    if (!principal) throw new AccessError('Member user not found', 404)

    const now = new Date().toISOString()
    const { data: member, error: memberError } = await supabaseAdmin
      .from('agent_group_members')
      .upsert({
        group_id: groupId,
        principal_id: principal.principal_id,
        role,
        status: 'active',
        updated_at: now
      }, { onConflict: 'group_id,principal_id' })
      .select('principal_id, role, status, created_at, updated_at')
      .single()

    if (memberError) throw new AccessError(`Failed to save group member: ${memberError.message}`, 500)

    res.json({
      success: true,
      member: {
        principalId: member.principal_id,
        username: principal.username || null,
        email: principal.email || null,
        role: member.role,
        status: member.status,
        createdAt: member.created_at,
        updatedAt: member.updated_at || now
      }
    })
  } catch (error) {
    return sendGroupError(res, error)
  }
})

/**
 * DELETE /api/groups/:groupId/members/:principalId
 */
defineRoute(router, {
  method: 'delete',
  path: '/groups/{groupId}/members/{principalId}',
  operationId: 'removeGroupMember',
  tags: ['Groups'],
  summary: '移除分组成员',
  description: '将 membership.status 标记为 removed。',
  security: [{ bearerAuth: [] }],
  request: { params: GroupMemberParamsSchema },
  responses: {
    200: { description: '移除成功', content: { 'application/json': { schema: GroupMemberResponseSchema } } },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    500: errorResponse
  }
}, requireAuth, validate({ params: GroupMemberParamsSchema }), async (req, res) => {
  try {
    const { groupId, principalId } = req.params
    await getGroupOrThrow(groupId)
    await assertCanManageGroup({ principalId: req.user.id, userProfile: req.userProfile, groupId })

    const { data: membership, error: membershipError } = await supabaseAdmin
      .from('agent_group_members')
      .select('principal_id, role, status, created_at, updated_at')
      .eq('group_id', groupId)
      .eq('principal_id', principalId)
      .eq('status', 'active')
      .maybeSingle()

    if (membershipError) throw new AccessError(`Failed to load group member: ${membershipError.message}`, 500)
    if (!membership) throw new AccessError('Member not found', 404)

    const now = new Date().toISOString()
    const { data: member, error: updateError } = await supabaseAdmin
      .from('agent_group_members')
      .update({ status: 'removed', updated_at: now })
      .eq('group_id', groupId)
      .eq('principal_id', principalId)
      .select('principal_id, role, status, created_at, updated_at')
      .single()

    if (updateError) throw new AccessError(`Failed to remove group member: ${updateError.message}`, 500)

    const principalMap = await loadPrincipalProfiles([principalId])
    const principal = principalMap.get(principalId)
    res.json({
      success: true,
      member: {
        principalId: member.principal_id,
        username: principal?.username || null,
        email: principal?.email || null,
        role: member.role,
        status: member.status,
        createdAt: member.created_at,
        updatedAt: member.updated_at || now
      }
    })
  } catch (error) {
    return sendGroupError(res, error)
  }
})

router.use(groupsLimitRouter)

export default router
