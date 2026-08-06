/**
 * User Management Routes
 * Handles user CRUD operations
 */

import { Router } from 'express'
import { z } from 'zod'
import { supabaseAdmin, supabaseUrl, serviceRoleKey } from '../config/index.js'
import { requireAdmin, requireAuth } from '../middleware/auth.js'
import { defineRoute } from '../openapi/route-helper.js'
import { errorResponse, DeleteResponseSchema } from '../schemas/common.js'
import { validate } from '../middleware/validate.js'

const router = Router()
const UserProfileSelect = 'id, username:name, email, role, status, max_agent_instances, is_first_login, consumer_id, authorized_http_api_id, created_at, updated_at'

function generateRandomPassword(length = 16) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*'
  let generated = ''
  for (let index = 0; index < length; index += 1) {
    generated += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return generated
}

export async function ensureUserByEmail({ email, username, role = 'user', maxInstances = 5 }) {
  const resolvedUsername = username || email.split('@')[0]

  const { data: existing } = await supabaseAdmin
    .from('principal_profiles')
    .select(UserProfileSelect)
    .eq('email', email)
    .eq('principal_type', 'user')
    .single()

  if (existing) return existing

  const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
    email,
    password: generateRandomPassword(),
    email_confirm: true,
    user_metadata: { username: resolvedUsername, role }
  })

  if (authError) throw new Error(`用户创建失败: ${authError.message}`)

  const userId = authData.user.id

  const { data: profileData } = await supabaseAdmin
    .from('principal_profiles')
    .select(UserProfileSelect)
    .eq('id', userId)
    .eq('principal_type', 'user')
    .single()

  if (!profileData) {
    const { error: insertError } = await supabaseAdmin
      .from('principal_profiles')
      .insert({
        id: userId,
        principal_type: 'user',
        name: resolvedUsername,
        email,
        role,
        status: 'active',
        max_agent_instances: maxInstances
      })

    if (insertError) {
      try { await supabaseAdmin.auth.admin.deleteUser(userId) } catch (_) { /* best-effort rollback */ }
      throw new Error(`用户档案创建失败: ${insertError.message}`)
    }
  } else {
    await supabaseAdmin
      .from('principal_profiles')
      .update({
        name: resolvedUsername,
        role,
        max_agent_instances: maxInstances,
        updated_at: new Date().toISOString()
      })
      .eq('id', userId)
      .eq('principal_type', 'user')
  }

  const { data: profile, error: fetchError } = await supabaseAdmin
    .from('principal_profiles')
    .select(UserProfileSelect)
    .eq('id', userId)
    .eq('principal_type', 'user')
    .single()

  if (fetchError || !profile) throw new Error('用户创建成功但无法获取用户档案')
  return profile
}

const UserIdParamsSchema = z.object({
  userId: z.string().describe('用户 ID (UUID)'),
})

const ListUsersQuerySchema = z.object({
  page: z.string().optional().describe('页码(默认1)'),
  pageSize: z.string().optional().describe('每页数量(默认20, 最大100)'),
  search: z.string().optional().describe('按用户名或邮箱搜索'),
})

const CreateUsersBatchBody = z.object({ users: z.array(z.object({}).passthrough()).min(1).max(50000) }).passthrough()

const CreateUserBody = z.object({ email: z.string({ required_error: 'email and username are required' }).min(1, { message: 'email and username are required' }), username: z.string({ required_error: 'email and username are required' }).min(1, { message: 'email and username are required' }) }).passthrough()

const UpdateUserBody = z.object({}).passthrough()

const UpdateUserMePasswordBody = z.object({ currentPassword: z.string({ required_error: '请输入当前密码' }).min(1, { message: '请输入当前密码' }) }).passthrough()

const UpdateUserPasswordBody = z.object({
  password: z.string({ required_error: '密码至少需要 6 个字符' }).min(6, { message: '密码至少需要 6 个字符' }),
}).passthrough()

const UpdateUserStatusBody = z.object({
  status: z.enum(['active', 'disabled'], { message: 'status must be active or disabled' }),
}).passthrough()

const UserProfileSchema = z.object({
  id: z.string().describe('用户 ID'),
  username: z.string().describe('用户名'),
  email: z.string().describe('邮箱'),
  role: z.string().describe('角色'),
  status: z.string().describe('状态'),
  max_agent_instances: z.number().int().describe('最大实例数'),
  is_first_login: z.boolean().nullable().describe('是否首次登录'),
  consumer_id: z.string().nullable().describe('AI Gateway Consumer ID'),
  authorized_http_api_id: z.string().nullable().describe('已授权的 HTTP API ID'),
  created_at: z.string().describe('创建时间'),
  updated_at: z.string().describe('更新时间'),
}).strict()

const PaginationSchema = z.object({
  page: z.number().int().describe('当前页码'),
  pageSize: z.number().int().describe('每页数量'),
  total: z.number().int().describe('总记录数'),
  totalPages: z.number().int().describe('总页数'),
})

const ListUsersResponseSchema = z.object({
  success: z.literal(true),
  users: z.array(UserProfileSchema),
  pagination: PaginationSchema,
})

const BatchCreateResultItemSchema = z.object({
  email: z.string(),
  username: z.string(),
  userId: z.string(),
  role: z.string(),
  authProvider: z.string(),
  status: z.string(),
})

const BatchCreateErrorItemSchema = z.object({
  email: z.string(),
  error: z.string(),
})

const CreateUsersBatchResponseSchema = z.object({
  success: z.literal(true),
  total: z.number().int().describe('总提交用户数'),
  created: z.number().int().describe('成功创建数'),
  failed: z.number().int().describe('失败数'),
  results: z.array(BatchCreateResultItemSchema),
  errors: z.array(BatchCreateErrorItemSchema),
})

const CreateUserResponseSchema = z.object({
  success: z.literal(true),
  user: z.object({
    id: z.string().describe('用户 ID'),
    email: z.string().describe('邮箱'),
    username: z.string().describe('用户名'),
    role: z.string().describe('角色'),
  }),
})

const SuccessOnlyResponseSchema = z.object({
  success: z.literal(true),
})

const GetUserMeAuthModeResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    emailAuthEnabled: z.boolean().describe('是否启用邮箱认证'),
  }),
})

const UpdateUserMePasswordResponseSchema = z.object({
  success: z.literal(true),
  message: z.string().optional().describe('操作结果描述'),
  requiresEmailVerification: z.boolean().optional().describe('是否需要邮箱验证完成密码修改'),
})

const UpdateUserPasswordResponseSchema = z.object({
  success: z.literal(true),
  message: z.string().describe('操作结果描述'),
})

/**
 * Batch create users
 * POST /api/users/batch
 * Body: {
 *   users: [
 *     { email, password, username, role?, maxInstances? },
 *     ...
 *   ]
 * }
 */
defineRoute(router, {
  method: 'post',
  path: '/users/batch',
  operationId: 'createUsersBatch',
  tags: ['Users'],
  summary: '批量创建用户',
  description: '管理员批量创建用户账号，最多支持 50000 个用户。',
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: CreateUsersBatchBody } } },
  },
  responses: {
    200: {
      description: '批量创建结果',
      content: { 'application/json': { schema: CreateUsersBatchResponseSchema } },
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ body: CreateUsersBatchBody }), async (req, res) => {
  const { users } = req.body

  const results = []
  const errors = []

  for (const user of users) {
    const {
      email,
      password: inputPassword,
      username,
      role = 'user',
      maxInstances = 5,
      authProvider = 'email'
    } = user

    const normalizedAuthProvider = (authProvider || 'email').toLowerCase().trim()
    const isExternalAuth = ['oauth', 'saml'].includes(normalizedAuthProvider)

    let password = inputPassword

    // Validate required fields
    if (!email || !username) {
      errors.push({
        email: email || 'unknown',
        error: 'email and username are required'
      })
      continue
    }

    if (!isExternalAuth) {
      if (!password) {
        errors.push({
          email,
          error: 'password is required for email authentication'
        })
        continue
      }

      if (password.length < 6) {
        errors.push({
          email,
          error: 'password must be at least 6 characters'
        })
        continue
      }
    } else if (!password) {
      password = generateRandomPassword()
    }

    if (password.length < 6) {
      errors.push({
        email,
        error: 'password must be at least 6 characters'
      })
      continue
    }

    try {
      // Create user via Supabase Admin API
      const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true, // Auto-confirm email
        user_metadata: {
          username,
          role,
          auth_provider: normalizedAuthProvider
        }
      })

      if (authError) {
        errors.push({ email, error: authError.message })
        continue
      }

      const userId = authData.user.id

      // Check if profile was auto-created by trigger
      const { data: profileData } = await supabaseAdmin
        .from('principal_profiles')
        .select('id')
        .eq('id', userId)
        .eq('principal_type', 'user')
        .single()

      if (!profileData) {
        // Create profile manually
        const { error: profileError } = await supabaseAdmin
          .from('principal_profiles')
          .insert({
            id: userId,
            principal_type: 'user',
            name: username,
            email,
            role,
            status: 'active',
            max_agent_instances: maxInstances
          })

        if (profileError) {
          errors.push({ email, error: `Profile creation failed: ${profileError.message}` })
          continue
        }
      } else {
        // Update the auto-created profile
        const { error: updateError } = await supabaseAdmin
          .from('principal_profiles')
          .update({
            name: username,
            role,
            max_agent_instances: maxInstances,
            updated_at: new Date().toISOString()
          })
          .eq('id', userId)
          .eq('principal_type', 'user')

        if (updateError) {
          errors.push({ email, error: `Profile update failed: ${updateError.message}` })
          continue
        }
      }

      results.push({
        email,
        username,
        userId,
        role,
        authProvider: normalizedAuthProvider,
        status: 'created'
      })

    } catch (err) {
      errors.push({ email, error: err.message })
    }
  }

  res.json({
    success: true,
    total: users.length,
    created: results.length,
    failed: errors.length,
    results,
    errors
  })
})

/**
 * List users with pagination and search
 * GET /api/users
 * Query: { page?, pageSize?, search? }
 */
defineRoute(router, {
  method: 'get',
  path: '/users',
  operationId: 'listUsers',
  tags: ['Users'],
  summary: '获取用户列表（管理员）',
  description: '分页获取用户列表，支持按用户名或邮箱搜索。',
  security: [{ bearerAuth: [] }],
  request: {
    query: ListUsersQuerySchema,
  },
  responses: {
    200: {
      description: '用户列表',
      content: { 'application/json': { schema: ListUsersResponseSchema } },
    },
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ query: ListUsersQuerySchema }), async (req, res) => {
  const page = parseInt(req.query.page) || 1
  const pageSize = Math.min(parseInt(req.query.pageSize) || 20, 100)
  const search = req.query.search || ''
  const offset = (page - 1) * pageSize

  console.log('GET /api/users - page:', page, 'pageSize:', pageSize, 'offset:', offset, 'search:', search)

  let query = supabaseAdmin
    .from('principal_profiles')
    .select(UserProfileSelect, { count: 'exact' })
    .eq('principal_type', 'user')

  // Filter by search term (username or email)
  if (search) {
    query = query.or(`name.ilike.%${search}%,email.ilike.%${search}%`)
  }

  // Apply pagination and ordering
  query = query
    .order('created_at', { ascending: false })
    .range(offset, offset + pageSize - 1)

  const { data: users, error, count } = await query

  console.log('GET /api/users - found:', users?.length, 'total count:', count, 'error:', error)

  if (error) {
    throw error
  }

  res.json({
    success: true,
    users: users || [],
    pagination: {
      page,
      pageSize,
      total: count || 0,
      totalPages: Math.ceil((count || 0) / pageSize)
    }
  })
})

/**
 * Create single user
 * POST /api/users
 * Body: { email, password?, username, role?, maxInstances?, authProvider? }
 * password is optional for OAuth/SAML users
 */
defineRoute(router, {
  method: 'post',
  path: '/users',
  operationId: 'createUser',
  tags: ['Users'],
  summary: '创建单个用户',
  description: '管理员创建单个用户账号，支持 email、OAuth、SAML 认证方式。',
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: CreateUserBody } } },
  },
  responses: {
    200: {
      description: '创建成功',
      content: { 'application/json': { schema: CreateUserResponseSchema } },
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ body: CreateUserBody }), async (req, res) => {
  const {
    email,
    password: inputPassword,
    username,
    role = 'user',
    maxInstances = 5,
    authProvider = 'email'
  } = req.body

  const normalizedAuthProvider = (authProvider || 'email').toLowerCase().trim()
  const isExternalAuth = ['oauth', 'saml'].includes(normalizedAuthProvider)

  let password = inputPassword

  // Password validation
  if (!isExternalAuth) {
    if (!password) {
      return res.status(400).json({
        success: false,
        error: 'password is required for email authentication'
      })
    }
    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        error: 'password must be at least 6 characters'
      })
    }
  } else if (!password) {
    // Auto-generate password for OAuth/SAML users
    password = generateRandomPassword()
  }

  // Create user via Supabase Admin API
  const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      username,
      role,
      auth_provider: normalizedAuthProvider
    }
  })

  if (authError) {
    return res.status(400).json({
      success: false,
      error: authError.message
    })
  }

  const userId = authData.user.id

  // Check if profile was auto-created by trigger
  const { data: profileData } = await supabaseAdmin
    .from('principal_profiles')
    .select('id')
    .eq('id', userId)
    .eq('principal_type', 'user')
    .single()

  if (!profileData) {
    // Create profile manually
    const { error: insertError } = await supabaseAdmin
      .from('principal_profiles')
      .insert({
        id: userId,
        principal_type: 'user',
        name: username,
        email,
        role,
        status: 'active',
        max_agent_instances: maxInstances
      })

    if (insertError) {
      console.error('Failed to create user profile:', insertError)
      // Rollback: delete the auth user
      try {
        await supabaseAdmin.auth.admin.deleteUser(userId)
        console.log(`🔄 Rolled back user creation for ${username}`)
      } catch (rollbackError) {
        console.error(`❌ Failed to rollback user ${username}:`, rollbackError.message)
      }
      return res.status(500).json({
        success: false,
        error: `用户档案创建失败: ${insertError.message}`
      })
    }
  } else {
    // Update the auto-created profile
    const { error: updateError } = await supabaseAdmin
      .from('principal_profiles')
      .update({
        name: username,
        role,
        max_agent_instances: maxInstances,
        updated_at: new Date().toISOString()
      })
      .eq('id', userId)
      .eq('principal_type', 'user')

    if (updateError) {
      console.error('Failed to update user profile:', updateError)
      return res.status(500).json({
        success: false,
        error: `用户档案更新失败: ${updateError.message}`
      })
    }
  }

  res.json({
    success: true,
    user: {
      id: userId,
      email,
      username,
      role
    }
  })
})

/**
 * Update user profile and sync email to Supabase Auth
 * PUT /api/users/:userId
 * Body: { username?, email?, role?, status?, maxInstances? }
 */
defineRoute(router, {
  method: 'put',
  path: '/users/{userId}',
  operationId: 'updateUserByUserId',
  tags: ['Users'],
  summary: '更新用户信息（管理员）',
  description: '管理员更新指定用户的基本信息，包括用户名、邮箱、角色、状态等。',
  security: [{ bearerAuth: [] }],
  request: {
    params: UserIdParamsSchema,
    body: { content: { 'application/json': { schema: UpdateUserBody } } },
  },
  responses: {
    200: {
      description: '更新成功',
      content: { 'application/json': { schema: SuccessOnlyResponseSchema } },
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ body: UpdateUserBody, params: UserIdParamsSchema }), async (req, res) => {
  const { userId } = req.params
  const { username, email, role, status, maxInstances } = req.body

  // Build profile update object
  const profileUpdate = { updated_at: new Date().toISOString() }
  if (username !== undefined) profileUpdate.name = username
  if (email !== undefined) profileUpdate.email = email
  if (role !== undefined) profileUpdate.role = role
  if (status !== undefined) profileUpdate.status = status
  if (maxInstances !== undefined) profileUpdate.max_agent_instances = maxInstances

  // If email is being changed, sync to Supabase Auth (auth.users)
  if (email) {
    const { error: authError } = await supabaseAdmin.auth.admin.updateUserById(userId, {
      email: email,
      email_confirm: true
    })
    if (authError) {
      console.error('Failed to update auth email:', authError)
      return res.status(400).json({
        success: false,
        error: `邮箱更新失败: ${authError.message}`
      })
    }
  }

  // Update principal_profiles table
  const { error: profileError } = await supabaseAdmin
    .from('principal_profiles')
    .update(profileUpdate)
    .eq('id', userId)
    .eq('principal_type', 'user')

  if (profileError) {
    return res.status(500).json({
      success: false,
      error: `用户信息更新失败: ${profileError.message}`
    })
  }

  res.json({ success: true })
})

/**
 * Get auth mode for current user (email auth on/off)
 * GET /api/users/me/auth-mode
 */
defineRoute(router, {
  method: 'get',
  path: '/users/me/auth-mode',
  operationId: 'getUserMeAuthMode',
  tags: ['Users'],
  summary: '获取当前用户的认证模式',
  description: '获取当前用户是否启用了邮箱认证模式。',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: '认证模式',
      content: { 'application/json': { schema: GetUserMeAuthModeResponseSchema } },
    },
    401: errorResponse,
  },
}, requireAuth, async (req, res) => {
  try {
    const { data: configData } = await supabaseAdmin
      .from('system_config')
      .select('value')
      .eq('key', 'email_auth_enabled')
      .single()

    let emailAuthEnabled = configData?.value?.enabled === true

    if (!configData) {
      try {
        const settingsResp = await fetch(`${supabaseUrl}/auth/v1/settings`, {
          headers: {
            apikey: serviceRoleKey,
            Authorization: `Bearer ${serviceRoleKey}`,
          },
        })
        if (settingsResp.ok) {
          const settings = await settingsResp.json()
          emailAuthEnabled = settings.mailer_autoconfirm === false
        }
      } catch (_) { /* keep emailAuthEnabled = false */ }
    }

    res.json({ success: true, data: { emailAuthEnabled } })
  } catch (error) {
    res.json({ success: true, data: { emailAuthEnabled: false } })
  }
})

/**
 * Change own password (user self-service) - MUST be before :userId routes
 * PUT /api/users/me/password
 * Body: { currentPassword, newPassword }
 */
defineRoute(router, {
  method: 'put',
  path: '/users/me/password',
  operationId: 'updateUserMePassword',
  tags: ['Users'],
  summary: '修改当前用户密码',
  description: '当前用户自助修改密码，需验证旧密码，开启邮箱认证时会发送重置邮件。',
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: UpdateUserMePasswordBody } } },
  },
  responses: {
    200: {
      description: '密码修改成功',
      content: { 'application/json': { schema: UpdateUserMePasswordResponseSchema } },
    },
    400: errorResponse,
    401: errorResponse,
    500: errorResponse,
  },
}, requireAuth, validate({ body: UpdateUserMePasswordBody }), async (req, res) => {
  const { currentPassword, newPassword } = req.body

  // Check email auth mode FIRST — determines whether newPassword is required
  const { data: configData } = await supabaseAdmin
    .from('system_config')
    .select('value')
    .eq('key', 'email_auth_enabled')
    .single()

  let emailAuthEnabled = configData?.value?.enabled === true

  // Fallback: if system_config has no record (e.g. open-source Supabase configured
  // via kubectl), read the actual mailer_autoconfirm from GoTrue settings
  if (!configData) {
    try {
      const settingsResp = await fetch(`${supabaseUrl}/auth/v1/settings`, {
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
        },
      })
      if (settingsResp.ok) {
        const settings = await settingsResp.json()
        emailAuthEnabled = settings.mailer_autoconfirm === false
      }
    } catch (_) { /* keep emailAuthEnabled = false */ }
  }

  // Only validate newPassword when NOT in email auth mode
  if (!emailAuthEnabled && (!newPassword || newPassword.length < 6)) {
    return res.status(400).json({ success: false, error: '新密码至少需要 6 个字符' })
  }

  // Verify current password via GoTrue token endpoint
  const userEmail = req.user.email
  const verifyResp = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email: userEmail, password: currentPassword }),
  })

  if (!verifyResp.ok) {
    return res.status(400).json({ success: false, error: '当前密码不正确' })
  }

  if (emailAuthEnabled) {
    // Email auth enabled: send recovery email via GoTrue /recover endpoint
    // Note: generate_link only generates the link but does NOT send email
    //       /recover actually sends the recovery email to the user

    // Read site_url from GoTrue settings to build redirect_to
    let siteUrl = ''
    try {
      const settingsResp = await fetch(`${supabaseUrl}/auth/v1/settings`, {
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
        },
      })
      if (settingsResp.ok) {
        const settings = await settingsResp.json()
        siteUrl = (settings.site_url || '').replace(/\/+$/, '')
      }
    } catch (e) {
      console.warn('Failed to read site_url from GoTrue settings:', e)
    }

    const redirectTo = `${siteUrl}/user/reset-password`
    const response = await fetch(`${supabaseUrl}/auth/v1/recover?redirect_to=${encodeURIComponent(redirectTo)}`, {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: userEmail,
      }),
    })

    if (!response.ok) {
      const errText = await response.text()
      throw new Error(`发送恢复邮件失败: ${errText}`)
    }

    return res.json({
      success: true,
      requiresEmailVerification: true,
      message: '已发送密码重置邮件到您的邮箱，请查收并通过邮件链接完成密码修改',
    })
  }

  // Email auth not enabled: update password directly (existing behavior)
  const { error } = await supabaseAdmin.auth.admin.updateUserById(req.user.id, {
    password: newPassword
  })

  if (error) {
    return res.status(400).json({ success: false, error: `密码修改失败: ${error.message}` })
  }

  res.json({ success: true, message: '密码修改成功' })
})

/**
 * Change user password (admin)
 * PUT /api/users/:userId/password
 * Body: { password }
 */
defineRoute(router, {
  method: 'put',
  path: '/users/{userId}/password',
  operationId: 'updateUserByUserIdPassword',
  tags: ['Users'],
  summary: '管理员重置用户密码',
  description: '管理员为指定用户重置密码，新密码至少 6 个字符。',
  security: [{ bearerAuth: [] }],
  request: {
    params: UserIdParamsSchema,
    body: { content: { 'application/json': { schema: UpdateUserPasswordBody } } },
  },
  responses: {
    200: {
      description: '修改成功',
      content: { 'application/json': { schema: UpdateUserPasswordResponseSchema } },
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ body: UpdateUserPasswordBody, params: UserIdParamsSchema }), async (req, res) => {
  const { userId } = req.params
  const { password } = req.body

  const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, {
    password: password
  })

  if (error) {
    return res.status(400).json({
      success: false,
      error: `密码修改失败: ${error.message}`
    })
  }

  res.json({ success: true, message: '密码修改成功' })
})

/**
 * Delete user completely (auth + profile)
 * DELETE /api/users/:userId
 */
defineRoute(router, {
  method: 'delete',
  path: '/users/{userId}',
  operationId: 'deleteUserByUserId',
  tags: ['Users'],
  summary: '删除用户（管理员）',
  description: '管理员删除指定用户，需先清理该用户下的所有实例。',
  security: [{ bearerAuth: [] }],
  request: {
    params: UserIdParamsSchema,
  },
  responses: {
    200: {
      description: '删除成功',
      content: { 'application/json': { schema: DeleteResponseSchema } },
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ params: UserIdParamsSchema }), async (req, res) => {
  const { userId } = req.params

  // Prevent deleting yourself
  if (req.user.id === userId) {
    return res.status(400).json({
      success: false,
      error: '不能删除自己的账号'
    })
  }

  // Check whether the user still has agent instances. If so, block the deletion
  // and ask the admin to clean up instances first.
  const { data: existingInstances, error: instanceCheckError } = await supabaseAdmin
    .from('agent_instances')
    .select('id', { count: 'exact' })
    .eq('principal_id', userId)

  if (instanceCheckError) {
    console.error('Failed to check user instances before delete:', instanceCheckError)
    return res.status(500).json({
      success: false,
      error: `检查用户实例失败: ${instanceCheckError.message}`
    })
  }

  if (existingInstances && existingInstances.length > 0) {
    return res.status(400).json({
      success: false,
      errorCode: 'USER_HAS_INSTANCES',
      instanceCount: existingInstances.length,
      error: `该用户下仍存在 ${existingInstances.length} 个实例，请先清理完所有实例后再删除用户`
    })
  }

  // Delete from principal_profiles first
  const { error: profileError } = await supabaseAdmin
    .from('principal_profiles')
    .delete()
    .eq('id', userId)
    .eq('principal_type', 'user')

  if (profileError) {
    console.error('Failed to delete user profile:', profileError)
  }

  // Delete from Supabase Auth
  const { error: authError } = await supabaseAdmin.auth.admin.deleteUser(userId)

  if (authError) {
    return res.status(400).json({
      success: false,
      error: `删除用户失败: ${authError.message}`
    })
  }

  res.json({ success: true, message: '用户已删除' })
})

/**
 * Toggle user status (active/disabled)
 * PUT /api/users/:userId/status
 * Body: { status: 'active' | 'disabled' }
 */
defineRoute(router, {
  method: 'put',
  path: '/users/{userId}/status',
  operationId: 'updateUserByUserIdStatus',
  tags: ['Users'],
  summary: '切换用户状态（启用/禁用）',
  description: '管理员切换指定用户的状态，禁用后用户将无法登录。',
  security: [{ bearerAuth: [] }],
  request: {
    params: UserIdParamsSchema,
    body: { content: { 'application/json': { schema: UpdateUserStatusBody } } },
  },
  responses: {
    200: {
      description: '切换成功',
      content: { 'application/json': { schema: SuccessOnlyResponseSchema } },
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ body: UpdateUserStatusBody, params: UserIdParamsSchema }), async (req, res) => {
  const { userId } = req.params
  const { status } = req.body

  // 禁止管理员禁用自己
  if (status === 'disabled' && userId === req.user.id) {
    return res.status(400).json({
      success: false,
      error: '不能禁用自己的账号'
    })
  }

  const { error } = await supabaseAdmin
    .from('principal_profiles')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', userId)
    .eq('principal_type', 'user')

  if (error) {
    return res.status(500).json({
      success: false,
      error: `状态更新失败: ${error.message}`
    })
  }

  // Also ban/unban in Supabase Auth
  if (status === 'disabled') {
    await supabaseAdmin.auth.admin.updateUserById(userId, { ban_duration: '876600h' }) // ~100 years
  } else {
    await supabaseAdmin.auth.admin.updateUserById(userId, { ban_duration: 'none' })
  }

  res.json({ success: true })
})

/* /users/me/password route moved above :userId routes */

export default router
