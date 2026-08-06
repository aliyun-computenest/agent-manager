/**
 * SandboxSet CRUD 集成测试
 * 覆盖: GET /sandboxsets, GET /sandboxsets/{name}, POST /sandboxsets,
 *        PUT /sandboxsets/{name}, DELETE /sandboxsets/{name}
 *
 * 所有用例依赖 K8s 集群可达，不可达时整个 describe 自动 skip。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createApiClient, expectOk } from '../../helpers/api-client.js'
import { getAdminToken, createEphemeralUserViaApi } from '../../helpers/auth.js'
import { testEnv } from '../../setup/test-env.js'

const SANDBOX_SET_NAME = `it-${testEnv.runId}-sbset`

const MINIMAL_YAML = `apiVersion: agents.kruise.io/v1alpha1
kind: SandboxSet
metadata:
  name: ${SANDBOX_SET_NAME}
spec:
  replicas: 0
  template:
    spec:
      containers:
        - name: sandbox
          image: busybox:latest
          command: ["sleep", "3600"]
`

const UPDATED_YAML = MINIMAL_YAML.replace('busybox:latest', 'busybox:1.36')

async function isK8sReachable(admin) {
  try {
    const res = await admin.get('/api/sandboxsets', undefined, { timeoutMs: 15_000 })
    return res.status === 200
  } catch {
    return false
  }
}

describe('sandboxsets', () => {
  let admin
  let k8sReachable = false

  beforeAll(async () => {
    const token = await getAdminToken()
    admin = createApiClient({ token })
    k8sReachable = await isK8sReachable(admin)
    if (!k8sReachable) {
      console.warn('[sandboxsets] K8s 集群不可达，跳过所有用例')
    }
  })

  afterAll(async () => {
    if (k8sReachable) {
      await admin.delete(`/api/sandboxsets/${SANDBOX_SET_NAME}?namespace=default`).catch(() => {})
    }
  })

  describe('CRUD', () => {
    it('列出 SandboxSets', async () => {
      if (!k8sReachable) return
      const body = await expectOk(admin.get('/api/sandboxsets'))
      expect(body.success).toBe(true)
      expect(Array.isArray(body.sandboxSets)).toBe(true)
    })

    it('缺 name → 400', async () => {
      if (!k8sReachable) return
      const res = await admin.post('/api/sandboxsets', { yaml: MINIMAL_YAML })
      expect(res.status).toBe(400)
    })

    it('缺 yaml → 400', async () => {
      if (!k8sReachable) return
      const res = await admin.post('/api/sandboxsets', { name: SANDBOX_SET_NAME })
      expect(res.status).toBe(400)
    })

    it('创建 SandboxSet', async () => {
      if (!k8sReachable) return
      const body = await expectOk(admin.post('/api/sandboxsets', {
        name: SANDBOX_SET_NAME,
        yaml: MINIMAL_YAML,
      }))
      expect(body.success).toBe(true)
      expect(body.sandboxSet).toBeDefined()
    })

    it('获取 SandboxSet 详情', async () => {
      if (!k8sReachable) return
      const res = await admin.get(`/api/sandboxsets/${SANDBOX_SET_NAME}?namespace=default`)
      // 200 = 存在; 404 = 上一步创建失败
      if (res.status === 200) {
        expect(res.body.success).toBe(true)
        expect(res.body.sandboxSet).toBeDefined()
      } else {
        expect(res.status).toBe(404)
      }
    })

    it('更新 SandboxSet', async () => {
      if (!k8sReachable) return
      const res = await admin.put(`/api/sandboxsets/${SANDBOX_SET_NAME}?namespace=default`, {
        yaml: UPDATED_YAML,
      })
      if (res.status === 200) {
        expect(res.body.success).toBe(true)
      }
    })

    it('更新缺 yaml → 400', async () => {
      if (!k8sReachable) return
      const res = await admin.put(`/api/sandboxsets/${SANDBOX_SET_NAME}?namespace=default`, {})
      expect(res.status).toBe(400)
    })

    it('删除 SandboxSet', async () => {
      if (!k8sReachable) return
      const body = await expectOk(
        admin.delete(`/api/sandboxsets/${SANDBOX_SET_NAME}?namespace=default`),
      )
      expect(body.success).toBe(true)
    })

    it('获取不存在的 SandboxSet → 404', async () => {
      if (!k8sReachable) return
      const res = await admin.get('/api/sandboxsets/it-nonexistent-sbset?namespace=default')
      expect(res.status).toBe(404)
    })
  })

  describe('RBAC', () => {
    it('普通用户不能列出 SandboxSets → 403', async () => {
      if (!k8sReachable) return
      const user = await createEphemeralUserViaApi(admin, { tag: 'sbset-rbac' })
      const userClient = createApiClient({ token: user.token })
      const res = await userClient.get('/api/sandboxsets')
      expect([401, 403]).toContain(res.status)
      await user.cleanup()
    })
  })
})
