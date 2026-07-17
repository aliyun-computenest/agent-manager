/**
 * instance-lifecycle: 自定义变量集成验证
 *
 * 覆盖点：
 *   1. 当 agent-type 定义了 custom_vars_schema 时，创建实例必须传入 customVars
 *   2. 缺少必填 customVars 时应返回 400
 *   3. password 类型值在 DB 中以 encrypted: 前缀存储（不是明文）
 *   4. text 类型值在 DB 中原样存储
 *
 * 注意：本测试不依赖 E2B sandbox 真正启动，使用 async:true 创建后立即验证 DB 数据，
 * 然后清理。如果当前环境的所有 agent-type 都没有定义 custom_vars_schema，整个 suite 跳过。
 */
import { describe, it, expect, afterAll } from 'vitest'
import { createApiClient, expectOk } from '../../helpers/api-client.js'
import { getAdminToken } from '../../helpers/auth.js'
import { prefixedName } from '../../helpers/factory.js'
import { testSupabaseAdmin } from '../../helpers/supabase.js'
import { testEnv } from '../../setup/test-env.js'

const WRITE_TIMEOUT = Math.max(testEnv.instanceReadyTimeoutMs, 120_000)

// 预取 admin 和有 custom_vars_schema 的 agent-type
const admin = createApiClient({ token: await getAdminToken() })
const typesBody = await expectOk(admin.get('/api/agent-types'))
const allTypes = typesBody.agentTypes || []
const typeWithCustomVars = allTypes.find(
  (t) => t.is_enabled && Array.isArray(t.custom_vars_schema) && t.custom_vars_schema.length > 0,
)

if (!typeWithCustomVars) {
  describe.skip('instance-lifecycle: 自定义变量验证', () => {
    it.skip('跳过：当前环境无 agent-type 定义了 custom_vars_schema', () => {})
  })
} else {
  const schema = typeWithCustomVars.custom_vars_schema
  const hasRequiredField = schema.some((f) => f.required)
  const hasPasswordField = schema.some((f) => f.type === 'password')

  console.log(
    `[custom-vars] 使用 agent-type: ${typeWithCustomVars.code} (id=${typeWithCustomVars.id}), ` +
      `schema fields: ${schema.map((f) => `${f.name}(${f.type}${f.required ? ',required' : ''})`).join(', ')}`,
  )

  // 获取一个可用模型
  const modelsBody = await expectOk(admin.get('/api/models'))
  const model = (modelsBody.models || []).find((m) => m.is_enabled !== false)

  const createdIds = []

  afterAll(async () => {
    for (const id of createdIds) {
      await admin.delete(`/api/instances/${id}`).catch(() => {})
    }
  })

  describe('instance-lifecycle: 自定义变量验证', () => {
    if (hasRequiredField) {
      it('缺少必填 customVars → 400', async () => {
        const res = await admin.post(
          '/api/instances',
          {
            name: prefixedName('cv-missing'),
            agentTypeId: typeWithCustomVars.id,
            modelId: model?.id,
            configJson: {},
            async: true,
            // 故意不传 customVars
          },
          undefined,
          { timeoutMs: WRITE_TIMEOUT },
        )
        // 服务端应因缺少必填自定义变量而拒绝
        expect(res.status, '缺必填 customVars 应 400').toBe(400)
      })
    }

    it('传入 customVars 创建实例成功', async () => {
      // 为每个 schema field 构造测试值
      const customVars = {}
      for (const field of schema) {
        if (field.type === 'password') {
          customVars[field.name] = 'it-secret-value-123'
        } else if (field.type === 'textarea') {
          customVars[field.name] = 'it-multiline\nline2'
        } else {
          customVars[field.name] = 'it-text-value'
        }
      }

      const res = await admin.post(
        '/api/instances',
        {
          name: prefixedName('cv-ok'),
          agentTypeId: typeWithCustomVars.id,
          modelId: model?.id,
          configJson: {},
          async: true,
          customVars,
        },
        undefined,
        { timeoutMs: WRITE_TIMEOUT },
      )
      expect(res.status, 'create with customVars').toBe(200)
      expect(res.body?.success).toBe(true)
      const instanceId = res.body.instance.id
      expect(instanceId).toBeTruthy()
      createdIds.push(instanceId)

      // 直接查询 DB 验证 config_json.customVars 的存储格式
      const { data: row, error } = await testSupabaseAdmin
        .from('agent_instances')
        .select('config_json')
        .eq('id', instanceId)
        .single()

      expect(error, 'DB query should succeed').toBeNull()
      expect(row).toBeTruthy()

      const storedCustomVars = row.config_json?.customVars
      expect(storedCustomVars, 'config_json.customVars should exist').toBeTruthy()

      // 验证每个字段的存储格式
      for (const field of schema) {
        const stored = storedCustomVars[field.name]
        if (field.type === 'password') {
          // password 类型应以 encrypted: 前缀加密存储
          expect(
            stored?.startsWith('encrypted:'),
            `password field "${field.name}" should be stored with encrypted: prefix, got: ${stored?.slice(0, 30)}`,
          ).toBe(true)
          // 加密后不应等于原始明文
          expect(stored).not.toBe(customVars[field.name])
          expect(stored).not.toBe(`encrypted:${customVars[field.name]}`)
        } else {
          // text / textarea 类型应原样存储
          expect(
            stored,
            `text field "${field.name}" should be stored as-is`,
          ).toBe(customVars[field.name])
        }
      }

      console.log(`[custom-vars] ✅ DB 验证通过: password 已加密, text 原样存储`)
    }, WRITE_TIMEOUT + 60_000)

    if (hasPasswordField) {
      it('password 字段不通过 API 回显明文', async () => {
        // 如果前面创建了实例，查看 GET 接口是否泄露明文
        if (createdIds.length === 0) return
        const instanceId = createdIds[0]

        const res = await admin.get(`/api/instances/${instanceId}`)
        expect(res.status).toBe(200)

        // API 返回的 instance 对象中 config_json 不应包含明文密码
        const configJson = res.body?.instance?.config_json
        if (configJson?.customVars) {
          for (const field of schema) {
            if (field.type === 'password') {
              const val = configJson.customVars[field.name]
              // 值要么不回显, 要么是加密形式
              if (val) {
                expect(
                  val.startsWith('encrypted:') || val === '******',
                  `password field "${field.name}" should not be plaintext in API response`,
                ).toBe(true)
              }
            }
          }
        }
      })
    }
  })
}
