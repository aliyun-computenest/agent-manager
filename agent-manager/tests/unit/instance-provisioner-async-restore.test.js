import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const state = {
    insertedRows: [],
    updates: [],
    instanceIdFilter: null
  }

  function makeEqThenable(result, onEq = null) {
    return {
      eq(column, value) {
        if (onEq) onEq(column, value)
        return this
      },
      then(resolve, reject) {
        return Promise.resolve(result).then(resolve, reject)
      }
    }
  }

  function makeAgentInstancesQuery() {
    return {
      select(_columns, options) {
        if (options?.count === 'exact') {
          return makeEqThenable({ count: 0, error: null })
        }
        return this
      },
      eq() {
        return this
      },
      insert(row) {
        state.insertedRows.push(row)
        return {
          select() {
            return this
          },
          async single() {
            return {
              data: {
                ...row,
                created_at: '2026-07-07T08:00:00.000Z'
              },
              error: null
            }
          }
        }
      },
      async maybeSingle() {
        return {
          data: {
            config_json: state.insertedRows[0]?.config_json || {}
          },
          error: null
        }
      },
      update(update) {
        state.updates.push(update)
        return makeEqThenable({ data: null, error: null }, (column, value) => {
          if (column === 'id') state.instanceIdFilter = value
        })
      }
    }
  }

  const principalProfile = {
    id: 'user-async-restore',
    principal_type: 'user',
    name: 'Async Restore User',
    email: 'async-restore@example.com',
    max_agent_instances: 5
  }

  const supabaseAdmin = {
    from(table) {
      if (table === 'principal_profiles') {
        return {
          select() { return this },
          eq() { return this },
          async maybeSingle() {
            return { data: principalProfile, error: null }
          }
        }
      }
      if (table === 'agent_instances') return makeAgentInstancesQuery()
      throw new Error(`Unexpected table ${table}`)
    }
  }

  return {
    state,
    principalProfile,
    supabaseAdmin,
    sandboxConnect: vi.fn(async () => ({})),
    sandboxCreate: vi.fn(async () => {
      throw new Error('restore sandbox is still provisioning')
    }),
    waitForSandboxReady: vi.fn(),
    restoreClaimed: vi.fn()
  }
})

vi.mock('@e2b/code-interpreter', () => ({
  Sandbox: {
    create: mocks.sandboxCreate,
    connect: mocks.sandboxConnect
  }
}))

vi.mock('../../server/node_modules/@e2b/code-interpreter/dist/index.js', () => ({
  Sandbox: {
    create: mocks.sandboxCreate,
    connect: mocks.sandboxConnect
  }
}))

vi.mock('../../server/config/index.js', () => ({
  env: { API_ENCRYPTION_KEY: 'a'.repeat(32) },
  supabaseAdmin: mocks.supabaseAdmin,
  E2B_DOMAIN: 'example.e2b',
  E2B_API_KEY: 'test-e2b-key',
  DEPLOY_ENVIRONMENT: 'test',
  NATIVE_AGENT_UI_ENABLED: true,
  PLATFORM_PUBLIC_URL: 'https://manager.example.test',
  E2B_HOSTS_IP: '',
  OSS_PV_NAME: 'backup-pv',
  BACKUP_MOUNT_PATH: '/backup',
  VITE_OSS_PV_NAME: 'oss-pv',
  VITE_SKILLHUB_OSS_PV_NAME: 'skillhub-pv'
}))

vi.mock('../../server/utils/agent-config.js', () => ({
  getAgentType: vi.fn(async () => ({
    id: 'agent-type-openclaw',
    code: 'openclaw',
    sandbox_template_id: 'agent-manager-openclaw',
    sandbox_timeout: 60,
    custom_vars_schema: [],
    skill_config: [],
    readiness_check: { port: 18789 }
  })),
  generateAndWriteAgentConfig: vi.fn()
}))

vi.mock('../../server/services/kubernetes-api.js', () => ({
  createKubernetesApi: vi.fn(() => ({
    async getSandboxSet() {
      return {
        spec: {
          runtimes: [
            { name: 'agent-runtime' },
            { name: 'csi' }
          ]
        }
      }
    }
  })),
  getSandboxNamespace: vi.fn(() => 'default')
}))

vi.mock('../../server/services/providers/index.js', () => ({
  createProviderFromDB: vi.fn()
}))

vi.mock('../../server/services/k8s.js', () => ({
  getImageFromSandboxSet: vi.fn(async () => 'template-image:v1')
}))

vi.mock('../../server/services/sandbox.js', () => ({
  waitForSandboxReady: mocks.waitForSandboxReady,
  waitForGatewayReady: vi.fn()
}))

vi.mock('../../server/services/gateway-config.js', () => ({
  getGatewayConfig: vi.fn(() => ({ gatewayDomain: 'gateway.example.test' }))
}))

vi.mock('../../server/services/checkpoint-backups/index.js', () => ({
  restoreClaimedSandboxFromCheckpointBackup: mocks.restoreClaimed
}))

const { createInstanceForUser } = await import('../../server/services/instance-provisioner.js')

describe('createInstanceForUser async backup restore', () => {
  beforeEach(() => {
    mocks.state.insertedRows.length = 0
    mocks.state.updates.length = 0
    mocks.state.instanceIdFilter = null
    mocks.sandboxCreate.mockClear()
    mocks.sandboxConnect.mockClear()
    mocks.waitForSandboxReady.mockClear()
    mocks.restoreClaimed.mockReset()
    mocks.sandboxCreate.mockImplementation(async () => {
      throw new Error('restore sandbox is still provisioning')
    })
  })

  it('returns a pending restoring instance before the restored Sandbox exists', async () => {
    const result = await createInstanceForUser({
      userId: 'user-async-restore',
      userProfile: mocks.principalProfile,
      name: 'restore-target',
      inputAgentTypeId: 'agent-type-openclaw',
      asyncMode: true,
      restoreFromBackup: {
        backupId: 'ocb-ready',
        namespace: 'default',
        sourceInstance: {
          id: 'source-instance',
          agent_image: 'source-image:v1'
        }
      }
    })

    expect(result).toMatchObject({
      name: 'restore-target',
      sandboxId: null,
      status: 'starting'
    })
    expect(mocks.state.insertedRows).toHaveLength(1)
    expect(mocks.state.insertedRows[0]).toMatchObject({
      sandbox_id: null,
      status: 'starting',
      agent_image: 'source-image:v1',
      backup_enabled: false,
      config_json: {
        checkpointRestore: {
          backupId: 'ocb-ready',
          sourceInstanceId: 'source-instance',
          status: 'restoring'
        }
      }
    })

    await new Promise(resolve => setTimeout(resolve, 0))
    expect(mocks.state.updates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 'error',
        config_json: expect.objectContaining({
          checkpointRestore: expect.objectContaining({
            status: 'failed',
            message: 'restore sandbox is still provisioning'
          })
        })
      })
    ]))
  })

  it('updates sandbox_id in the background after restore Sandbox creation succeeds', async () => {
    mocks.sandboxCreate.mockResolvedValueOnce({ sandboxId: 'default--temporary-sandbox' })
    mocks.restoreClaimed.mockResolvedValueOnce({
      backupId: 'ocb-ready',
      sandboxId: 'default--restored-sandbox',
      agentImage: 'restored-image:v2'
    })

    const result = await createInstanceForUser({
      userId: 'user-async-restore',
      userProfile: mocks.principalProfile,
      name: 'restore-target',
      inputAgentTypeId: 'agent-type-openclaw',
      asyncMode: true,
      restoreFromBackup: {
        backupId: 'ocb-ready',
        namespace: 'default',
        sourceInstance: {
          id: 'source-instance',
          sandbox_id: 'default--source-sandbox',
          agent_image: 'source-image:v1'
        }
      }
    })

    expect(result).toMatchObject({
      sandboxId: null,
      status: 'starting'
    })

    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (mocks.state.updates.some(update => update.sandbox_id === 'default--restored-sandbox')) break
      await new Promise(resolve => setTimeout(resolve, 0))
    }

    expect(mocks.state.updates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sandbox_id: 'default--restored-sandbox',
        agent_image: 'restored-image:v2',
        backup_enabled: true,
        status: 'starting'
      })
    ]))
    expect(mocks.sandboxCreate).toHaveBeenCalledWith(
      'agent-manager-openclaw',
      expect.objectContaining({
        timeoutMs: 300_000,
        requestTimeoutMs: 300_000,
        metadata: expect.objectContaining({
          'agent-manager.io/managed-by': 'agent-manager',
          'agent-manager.io/instance-id': result.id,
          'agent-manager.io/principal-id': 'user-async-restore'
        })
      })
    )
    expect(mocks.waitForSandboxReady).toHaveBeenCalledWith('default--restored-sandbox', 300_000)
  })
})
