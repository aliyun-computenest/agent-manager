import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApiClient } from '../../helpers/api-client.js'
import { createEphemeralUserViaApi, getAdminToken } from '../../helpers/auth.js'
import { prefixedName } from '../../helpers/factory.js'
import { testSupabaseAdmin } from '../../helpers/supabase.js'
import { waitFor } from '../../helpers/wait-for.js'
import { testEnv } from '../../setup/test-env.js'
import { discoverLifecycleContexts } from '../instance-lifecycle/_shared.js'

const WRITE_REQ_TIMEOUT_MS = Math.max(
  Number(process.env.TEST_INSTANCE_WRITE_TIMEOUT_MS || 0) || 0,
  testEnv.instanceReadyTimeoutMs,
  120_000,
)
const BACKUP_READY_TIMEOUT_MS = Number(process.env.TEST_CHECKPOINT_BACKUP_READY_TIMEOUT_MS || 0) || 300_000
const BACKUP_POLL_INTERVAL_MS = Number(process.env.TEST_CHECKPOINT_BACKUP_POLL_INTERVAL_MS || 0) || 5_000
const RESTORE_READY_TIMEOUT_MS = Number(process.env.TEST_CHECKPOINT_RESTORE_READY_TIMEOUT_MS || 0)
  || Math.max(testEnv.instanceReadyTimeoutMs, 360_000)
const INSTANCE_CREATE_ATTEMPTS = Number(process.env.TEST_CHECKPOINT_BACKUP_CREATE_ATTEMPTS || 0) || 3
const INSTANCE_CREATE_RETRY_DELAY_MS = Number(process.env.TEST_CHECKPOINT_BACKUP_CREATE_RETRY_DELAY_MS || 0) || 15_000

const describeRealCheckpointBackups = testEnv.skipE2b ? describe.skip : describe

describeRealCheckpointBackups('instance backups API: real OOS checkpoint backup and clone restore flow', () => {
  let user
  let otherUser
  let client
  let otherClient
  let adminClient
  let lifecycleContext
  let sourceInstanceId
  let secondInstanceId
  let sourceInstanceName
  let manualBackupId
  let immediateExecutionId
  const createdInstanceIds = []

  beforeAll(async () => {
    adminClient = createApiClient({ token: await getAdminToken() })
    const contexts = await discoverLifecycleContexts(adminClient)
    lifecycleContext = contexts.find(ctx => ctx.builtinAgentType.code === 'openclaw') || contexts[0]
    if (!lifecycleContext?.builtinAgentType || !lifecycleContext?.primaryModel) {
      throw new Error('[checkpoint-backups] no enabled builtin agent type/model found for real instance creation')
    }

    user = await createEphemeralUserViaApi(adminClient, {
      tag: 'backup-user',
      maxInstances: 10,
    })
    otherUser = await createEphemeralUserViaApi(adminClient, {
      tag: 'backup-deny',
      maxInstances: 2,
    })
    client = createApiClient({ token: user.token })
    otherClient = createApiClient({ token: otherUser.token })

    const source = await createRealInstance(client, 'backup-source')
    const second = await createRealInstance(client, 'backup-source-2')
    sourceInstanceId = source.id
    secondInstanceId = second.id
    sourceInstanceName = source.name
  }, testEnv.instanceReadyTimeoutMs * 2 + 180_000)

  afterAll(async () => {
    for (const id of [...createdInstanceIds].reverse()) {
      await adminClient?.delete?.(`/api/instances/${id}`).catch(error => {
        console.warn(`[checkpoint-backups] cleanup delete failed for ${id}: ${error.message}`)
      })
    }
    await user?.cleanup?.()
    await otherUser?.cleanup?.()
  }, 180_000)

  async function createRealInstance(actor, tag) {
    let createRes = null
    for (let attempt = 1; attempt <= INSTANCE_CREATE_ATTEMPTS; attempt += 1) {
      createRes = await actor.post(
        '/api/instances',
        {
          name: prefixedName(`${tag}-${attempt}`),
          agentTypeId: lifecycleContext.builtinAgentType.id,
          description: `checkpoint backup integration (${tag})`,
          modelId: lifecycleContext.primaryModel.id,
          configJson: {},
          async: true,
        },
        undefined,
        { timeoutMs: WRITE_REQ_TIMEOUT_MS },
      )
      if (createRes.status === 200 && createRes.body?.success) break
      if (!isRetryableCreateFailure(createRes) || attempt === INSTANCE_CREATE_ATTEMPTS) break
      console.warn(`[checkpoint-backups] ${tag} create attempt ${attempt} failed, retrying: ${JSON.stringify(createRes.body)}`)
      await delay(INSTANCE_CREATE_RETRY_DELAY_MS)
    }
    expect(createRes.status, `[${tag}] create body=${JSON.stringify(createRes.body)}`).toBe(200)
    expect(createRes.body?.success).toBe(true)
    const instanceId = createRes.body.instance?.id
    expect(instanceId).toBeTruthy()
    createdInstanceIds.push(instanceId)

    const instance = await waitForInstanceRunning(actor, instanceId, tag)
    expect(instance.sandboxId || instance.sandbox_id, `[${tag}] sandboxId should be real`).toBeTruthy()
    return {
      id: instanceId,
      name: instance.name || createRes.body.instance?.name,
      sandboxId: instance.sandboxId || instance.sandbox_id,
    }
  }

  function isRetryableCreateFailure(res) {
    const text = JSON.stringify(res?.body || {})
    return res?.status >= 500 && (
      text.includes('Failed to connect to E2B API')
      || text.includes('aborted due to timeout')
      || text.includes('ECONNRESET')
      || text.includes('ETIMEDOUT')
    )
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  async function waitForInstanceRunning(actor, instanceId, label, timeoutMs = testEnv.instanceReadyTimeoutMs) {
    return waitFor(
      async () => {
        const res = await actor.get(`/api/instances/${instanceId}`)
        if (res.status !== 200) return null
        const instance = res.body?.instance
        if (!instance) return null
        if (instance.status === 'failed' || instance.status === 'error') {
          throw new Error(`[${label}] instance failed: ${JSON.stringify(instance)}`)
        }
        return instance.status === 'running' ? instance : null
      },
      {
        timeoutMs,
        intervalMs: 5_000,
        label: `[${label}] instance ${instanceId} -> running`,
      },
    )
  }

  async function waitForBackupReady(actor, instanceId, backupId, label) {
    return waitFor(
      async () => {
        const res = await actor.get(`/api/instances/${instanceId}/backups?limit=50`)
        expect(res.status, `[${label}] list backups body=${JSON.stringify(res.body)}`).toBe(200)
        expectNoMockValue(res.body, `[${label}] list backups`)
        const items = res.body?.items || []
        const item = backupId
          ? items.find(candidate => candidate.backupId === backupId)
          : items.find(candidate => candidate.status === 'Ready')
        return item?.status === 'Ready' ? item : null
      },
      {
        timeoutMs: BACKUP_READY_TIMEOUT_MS,
        intervalMs: BACKUP_POLL_INTERVAL_MS,
        label: `[${label}] backup ${backupId || '<any>'} -> Ready`,
      },
    )
  }

  async function waitForBackupExecution(executionId, label) {
    return waitFor(
      async () => {
        const res = await adminClient.get('/api/admin/backups/executions?limit=100')
        expect(res.status, `[${label}] list executions body=${JSON.stringify(res.body)}`).toBe(200)
        expectNoMockValue(res.body, `[${label}] list executions`)
        return (res.body?.items || []).find(item => item.executionId === executionId) || null
      },
      {
        timeoutMs: 120_000,
        intervalMs: 3_000,
        label: `[${label}] execution ${executionId} visible`,
      },
    )
  }

  async function waitForExecutionRecords(executionId, label) {
    return waitFor(
      async () => {
        const res = await adminClient.get(`/api/admin/backups/executions/${executionId}/records?limit=100`)
        expect(res.status, `[${label}] list records body=${JSON.stringify(res.body)}`).toBe(200)
        expectNoMockValue(res.body, `[${label}] execution records`)
        const items = res.body?.items || []
        return items.length > 0 ? items : null
      },
      {
        timeoutMs: 120_000,
        intervalMs: 3_000,
        label: `[${label}] execution ${executionId} records`,
      },
    )
  }

  function expectRealExecutionId(executionId) {
    expect(executionId).toEqual(expect.stringMatching(/^exec-/))
    expect(executionId).not.toContain('mock-oos')
  }

  function expectNoMockValue(value, label) {
    expect(JSON.stringify(value), `${label} should not contain mock OOS data`).not.toContain('mock-oos')
  }

  function expectUserBackupShape(item) {
    expect(item).toEqual({
      backupId: expect.any(String),
      createdAt: expect.any(String),
      status: 'Ready',
    })
    expect(item.backupId).toMatch(/^ocb-/)
    expect(item).not.toHaveProperty('checkpointId')
    expect(item).not.toHaveProperty('checkpointName')
    expect(item).not.toHaveProperty('specSnapshot')
  }

  it('lets a user start a real manual backup and later list the restorable point', async () => {
    const res = await client.post(`/api/instances/${sourceInstanceId}/backups`, {})

    expect(res.status, JSON.stringify(res.body)).toBe(202)
    expect(res.body).toMatchObject({
      success: true,
      backupId: expect.stringMatching(new RegExp(`^ocb-${sourceInstanceId.slice(0, 8)}-`)),
    })
    expect(res.body).not.toHaveProperty('checkpointId')
    expectNoMockValue(res.body, 'manual backup response')

    manualBackupId = res.body.backupId
    const ready = await waitForBackupReady(client, sourceInstanceId, manualBackupId, 'manual backup')
    expectUserBackupShape(ready)
  }, BACKUP_READY_TIMEOUT_MS + 60_000)

  it('lets an admin start one real immediate backup execution for multiple instances', async () => {
    const res = await adminClient.post('/api/admin/backups/executions', {
      runMode: 'immediate',
      scope: {
        type: 'instances',
        instanceIds: [sourceInstanceId, secondInstanceId],
      },
      retentionCount: 5,
    })

    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body).toMatchObject({
      success: true,
      runMode: 'immediate',
      targetCount: 2,
      skippedCount: 0,
    })
    expectRealExecutionId(res.body.executionId)
    immediateExecutionId = res.body.executionId

    const execution = await waitForBackupExecution(immediateExecutionId, 'admin immediate')
    expect(execution).toMatchObject({
      executionId: immediateExecutionId,
      runMode: 'immediate',
      scope: `instances:${sourceInstanceId},${secondInstanceId}`,
      retentionCount: 5,
    })
    expect(execution).not.toHaveProperty('oosConsoleUrl')
    expect(execution).not.toHaveProperty('templateStatus')

    const records = await waitForExecutionRecords(immediateExecutionId, 'admin immediate')
    expect(records[0]).toEqual({
      status: expect.stringMatching(/Success|Running|Failed|PartialFailed/),
      startedAt: expect.any(String),
      message: expect.any(String),
    })
    expect(records[0]).not.toHaveProperty('recordId')
    expect(records[0]).not.toHaveProperty('backupId')

    await waitForBackupReady(client, sourceInstanceId, null, 'admin immediate source backup')
    await waitForBackupReady(client, secondInstanceId, null, 'admin immediate second backup')
  }, BACKUP_READY_TIMEOUT_MS + 180_000)

  it('lets an admin create, list, and cancel a real scheduled backup execution', async () => {
    const res = await adminClient.post('/api/admin/backups/executions', {
      runMode: 'scheduled',
      scope: {
        type: 'instances',
        instanceIds: [secondInstanceId],
      },
      cronExpression: 'cron(0 30 3 * * ? *)',
      retentionCount: 5,
    })

    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body).toMatchObject({
      success: true,
      runMode: 'scheduled',
      targetCount: 1,
      skippedCount: 0,
    })
    expectRealExecutionId(res.body.executionId)

    const execution = await waitForBackupExecution(res.body.executionId, 'admin scheduled')
    expect(execution).toMatchObject({
      executionId: res.body.executionId,
      runMode: 'scheduled',
      scope: `instances:${secondInstanceId}`,
      cronExpression: 'cron(0 30 3 * * ? *)',
      retentionCount: 5,
      status: 'Running',
    })

    const cancel = await adminClient.post(`/api/admin/backups/executions/${res.body.executionId}/cancel`, {})
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(204)
    expect(cancel.body).toBeNull()
  }, 180_000)

  it('rejects admin backup execution APIs for regular users before touching OOS', async () => {
    const list = await client.get('/api/admin/backups/executions')
    expect(list.status).toBe(403)

    const records = await client.get('/api/admin/backups/executions/exec-denied-placeholder/records')
    expect(records.status).toBe(403)

    const create = await client.post('/api/admin/backups/executions', {
      runMode: 'immediate',
      scope: {
        type: 'instances',
        instanceIds: [sourceInstanceId],
      },
    })
    expect(create.status).toBe(403)

    const cancel = await client.post('/api/admin/backups/executions/exec-denied-placeholder/cancel', {})
    expect(cancel.status).toBe(403)
  })

  it('lists only restorable backup points for the current instance without leaking internals', async () => {
    const res = await client.get(`/api/instances/${sourceInstanceId}/backups?limit=50`)

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body?.success).toBe(true)
    expect(res.body?.latestOperation).toBeNull()
    expectNoMockValue(res.body, 'user backup list')
    expect(res.body?.items?.length).toBeGreaterThanOrEqual(1)

    const first = res.body.items[0]
    expectUserBackupShape(first)
  })

  it('creates a new real instance from a selected backupId without mutating the source instance', async () => {
    expect(manualBackupId, 'manual backup should be created by the first test before restore').toBeTruthy()
    const backup = manualBackupId
      ? await waitForBackupReady(client, sourceInstanceId, manualBackupId, 'restore source backup')
      : await waitForBackupReady(client, sourceInstanceId, null, 'restore source backup')
    const backupId = backup.backupId

    const res = await client.post('/api/instances', {
      name: prefixedName('backup-restore-clone'),
      agentTypeId: lifecycleContext.builtinAgentType.id,
      description: 'checkpoint backup integration restore clone',
      modelId: lifecycleContext.primaryModel.id,
      configJson: {},
      async: true,
      backupId,
    }, undefined, { timeoutMs: WRITE_REQ_TIMEOUT_MS })
    expect(res.status, JSON.stringify(res.body)).toBe(202)
    expect(res.body).toMatchObject({
      success: true,
      instance: {
        id: expect.any(String),
        status: 'starting',
      },
    })
    expect(res.body).not.toHaveProperty('checkpointId')
    expectNoMockValue(res.body, 'restore create response')
    const restoredInstanceId = res.body.instance.id
    expect(restoredInstanceId).not.toBe(sourceInstanceId)
    createdInstanceIds.push(restoredInstanceId)

    const restored = await waitForInstanceRunning(
      client,
      restoredInstanceId,
      'restore clone',
      RESTORE_READY_TIMEOUT_MS,
    )
    expect(restored.sandboxId || restored.sandbox_id).toBeTruthy()

    const sourceDetail = await client.get(`/api/instances/${sourceInstanceId}`)
    expect(sourceDetail.status, JSON.stringify(sourceDetail.body)).toBe(200)
    expect(sourceDetail.body.instance).toMatchObject({
      id: sourceInstanceId,
      name: sourceInstanceName,
    })
    expect(sourceDetail.body.instance.sandbox_id).toBeTruthy()
    expect(sourceDetail.body.instance.sandbox_id).not.toBe(restored.sandboxId || restored.sandbox_id)

    const { data: rows, error } = await testSupabaseAdmin
      .from('agent_instances')
      .select('id, principal_id, name, sandbox_id, config_json')
      .eq('principal_id', user.userId)
    expect(error).toBeNull()
    const sourceRows = rows.filter(row => row.id === sourceInstanceId)
    const restoredRows = rows.filter(row => row.id === restoredInstanceId)
    expect(sourceRows).toHaveLength(1)
    expect(restoredRows).toHaveLength(1)
    expect(restoredRows[0].sandbox_id).toBeTruthy()
    expect(restoredRows[0].sandbox_id).not.toBe(sourceRows[0].sandbox_id)
    expect(sourceRows[0].config_json?.restoreSource).toBeUndefined()
  }, BACKUP_READY_TIMEOUT_MS + RESTORE_READY_TIMEOUT_MS + 120_000)

  it('rejects missing or non-restorable backup points on a real instance', async () => {
    const res = await client.post('/api/instances', {
      name: prefixedName('backup-restore-missing'),
      agentTypeId: lifecycleContext.builtinAgentType.id,
      modelId: lifecycleContext.primaryModel.id,
      configJson: {},
      async: true,
      backupId: 'ocb-does-not-exist',
    }, undefined, { timeoutMs: WRITE_REQ_TIMEOUT_MS })

    expect(res.status).toBe(404)
    expect(res.body).toMatchObject({
      success: false,
      errorCode: 'BACKUP_NOT_FOUND',
    })
  })

  it('does not expose user backup actions to another principal', async () => {
    const start = await otherClient.post(`/api/instances/${sourceInstanceId}/backups`, {})
    expect(start.status).toBe(404)

    const list = await otherClient.get(`/api/instances/${sourceInstanceId}/backups`)
    expect(list.status).toBe(404)

    const restore = await otherClient.post(`/api/instances/${sourceInstanceId}/backups/ocb-any/restore`, {})
    expect(restore.status).toBe(404)
  })

  it('does not let another principal clone a source user backup into their own account', async () => {
    expect(manualBackupId, 'manual backup should be created before cross-principal restore denial').toBeTruthy()

    const res = await otherClient.post('/api/instances', {
      name: prefixedName('backup-restore-denied'),
      agentTypeId: lifecycleContext.builtinAgentType.id,
      modelId: lifecycleContext.primaryModel.id,
      configJson: {},
      async: true,
      backupId: manualBackupId,
    }, undefined, { timeoutMs: WRITE_REQ_TIMEOUT_MS })

    expect(res.status, JSON.stringify(res.body)).toBe(404)

    const { data: rows, error } = await testSupabaseAdmin
      .from('agent_instances')
      .select('id, principal_id, name')
      .eq('principal_id', otherUser.userId)
      .ilike('name', '%backup-restore-denied%')
    expect(error).toBeNull()
    expect(rows || []).toHaveLength(0)
  })
})
