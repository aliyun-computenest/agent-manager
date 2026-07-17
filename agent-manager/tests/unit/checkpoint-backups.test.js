import { describe, expect, it } from 'vitest'
import * as service from '../../server/services/checkpoint-backups/index.js'
import {
  makeApi,
  makeCheckpoint,
  makeInstance,
  makeReadySnapshot
} from './helpers/checkpoint-backup-fixtures.js'

describe('checkpoint backup service: user backup flow', () => {
  it('starts a manual backup for the current instance with a generated backupId', async () => {
    const result = await service.startInstanceCheckpointBackup(makeInstance(), {
      api: makeApi(),
      namespace: 'default',
      now: new Date('2026-06-18T04:00:00Z'),
      oosClient: {
        async startExecution() {
          return { executionId: 'exec-generated-id' }
        }
      },
      clusterId: 'cluster-a',
      clusterRegionId: 'cn-hongkong'
    })

    expect(result).toMatchObject({
      status: 'Submitted',
      backupId: expect.stringMatching(/^ocb-11111111-20260618t040000z-/),
      sourceInstanceId: '11111111-1111-4111-8111-111111111111'
    })
    expect(result).not.toHaveProperty('checkpointId')
  })

  it('starts an OOS execution through the public template instead of local backup fabrication', async () => {
    const calls = []
    const oosClient = {
      async startExecution(payload) {
        calls.push({ action: 'startExecution', ...payload })
        return { executionId: 'exec-real-001' }
      }
    }

    const result = await service.startInstanceCheckpointBackup(makeInstance(), {
      api: makeApi(),
      namespace: 'default',
      now: new Date('2026-06-18T04:00:00Z'),
      oosClient,
      clusterId: 'ca59876e747dd4f8aa28dc4ef0b197487',
      clusterRegionId: 'cn-hongkong'
    })

    expect(result).toMatchObject({
      status: 'Submitted',
      sourceInstanceId: '11111111-1111-4111-8111-111111111111',
      oosExecutionId: 'exec-real-001'
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].action).toBe('startExecution')
    expect(calls[0].parameters).toMatchObject({
      ClusterId: 'ca59876e747dd4f8aa28dc4ef0b197487',
      RegionId: 'cn-hongkong',
      Namespace: 'default',
      RunMode: 'immediate',
      Scope: 'instances:11111111-1111-4111-8111-111111111111',
      RetentionCount: 5,
      Targets: [{
        namespace: 'default',
        instanceId: '11111111-1111-4111-8111-111111111111',
        sandboxName: 'sandbox-a'
      }]
    })
    expect(calls[0].templateName).toBe('ACS-CS-CreateAgentManagercheckpointBackup')
    expect(calls[0]).not.toHaveProperty('templateVersion')
    expect(calls[0]).not.toHaveProperty('templateContent')
    expect(calls[0].parameters).not.toHaveProperty('BackupIdSuffix')
    expect(calls[0].parameters.Targets[0].backupId).toMatch(/^ocb-11111111-20260618t040000z-/)
    expect(calls[0].parameters.Targets[0].backupIdPrefix).toMatch(/^ocb-11111111-20260618t040000z-/)
  })

  it('passes the Sandbox namespace parsed from sandbox_id into OOS execution parameters', async () => {
    const calls = []
    const oosClient = {
      async startExecution(payload) {
        calls.push({ action: 'startExecution', ...payload })
        return { executionId: 'exec-custom-ns' }
      }
    }

    await service.startInstanceCheckpointBackup(makeInstance({
      sandbox_id: 'custom-ns--sandbox-a'
    }), {
      api: makeApi(),
      namespace: 'default',
      now: new Date('2026-06-18T04:00:00Z'),
      oosClient,
      clusterId: 'cluster-a',
      clusterRegionId: 'cn-hongkong'
    })

    expect(calls[0].parameters).toMatchObject({
      ClusterId: 'cluster-a',
      RegionId: 'cn-hongkong',
      Namespace: 'custom-ns',
      RunMode: 'immediate'
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).not.toHaveProperty('templateContent')
  })

  it('delegates retention cleanup calculation to the OOS template without pre-listing backups', async () => {
    const calls = []
    const oosClient = {
      async startExecution(payload) {
        calls.push({ action: 'startExecution', ...payload })
        return { executionId: 'exec-real-002' }
      }
    }
    const api = makeApi()
    api.listCheckpoints = async () => {
      throw new Error('listCheckpoints should not be called before starting OOS cleanup')
    }

    await service.startInstanceCheckpointBackup(makeInstance(), {
      api,
      namespace: 'default',
      now: new Date('2026-06-18T04:00:00Z'),
      retentionCount: 2,
      oosClient,
      clusterId: 'cluster-a',
      clusterRegionId: 'cn-hongkong'
    })

    expect(calls[0].parameters.RetentionCount).toBe(2)
    expect(calls[0].templateName).toBe('ACS-CS-CreateAgentManagercheckpointBackup')
    expect(calls).toHaveLength(1)
    expect(calls[0]).not.toHaveProperty('templateContent')
  })

  it('rejects manual backup when the current Sandbox is already busy', async () => {
    await expect(service.startInstanceCheckpointBackup(makeInstance(), {
      api: makeApi({
        sandboxAnnotations: {
          'agent-manager.io/backup-lock-id': 'ocb-running'
        }
      }),
      namespace: 'default'
    })).rejects.toMatchObject({
      status: 409,
      code: 'BACKUP_IN_PROGRESS'
    })
  })

  it('does not treat completed restore metadata as a busy backup lock', async () => {
    const result = await service.restoreInstanceCheckpointBackup(makeInstance(), 'ocb-ready-newer', {
      api: makeApi({
        sandboxAnnotations: {
          'agent-manager.io/restore-backup-id': 'ocb-older',
          'agent-manager.io/restore-request-id': 'restore-older'
        }
      }),
      namespace: 'default',
      now: new Date('2026-06-18T04:05:00Z')
    })

    expect(result).toMatchObject({
      status: 'Submitted',
      backupId: 'ocb-ready-newer'
    })
  })

  it('lists only restorable backup points by backupId and createdAt', async () => {
    const items = await service.listInstanceCheckpointBackups(makeInstance(), {
      api: makeApi(),
      namespace: 'default'
    })

    expect(items).toEqual([
      {
        backupId: 'ocb-ready-newer',
        createdAt: '2026-06-18T03:00:00Z',
        status: 'Ready'
      },
      {
        backupId: 'ocb-ready-older',
        createdAt: '2026-06-18T02:00:00Z',
        status: 'Ready'
      }
    ])
  })

  it('does not leak checkpointId or snapshot internals from the user list', async () => {
    const [item] = await service.listInstanceCheckpointBackups(makeInstance(), {
      api: makeApi(),
      namespace: 'default'
    })

    expect(item).not.toHaveProperty('checkpointId')
    expect(item).not.toHaveProperty('checkpointName')
    expect(item).not.toHaveProperty('specSnapshot')
  })

  it('uses one snapshot ConfigMap list call when the Kubernetes API supports it', async () => {
    const checkpoint = makeCheckpoint({
      name: 'cp-ready',
      backupId: 'ocb-ready',
      createdAt: '2026-06-18T03:00:00Z',
      checkpointId: 'cp-ready',
      snapshotName: 'snapshot-ready',
      snapshotKey: 'snapshot-ready.json'
    })
    const api = {
      listConfigMapCalls: 0,
      getConfigMapCalls: 0,
      async listCheckpoints() {
        return { items: [checkpoint] }
      },
      async listConfigMaps() {
        this.listConfigMapCalls += 1
        return {
          items: [{
            metadata: {
              name: 'snapshot-ready',
              namespace: 'default',
              labels: {
                'agent-manager.io/backup-id': 'ocb-ready'
              }
            },
            data: {
              'snapshot-ready.json': JSON.stringify(makeReadySnapshot())
            }
          }]
        }
      },
      async getConfigMap() {
        this.getConfigMapCalls += 1
        throw new Error('unexpected per-backup ConfigMap read')
      }
    }

    const items = await service.listInstanceCheckpointBackups(makeInstance(), {
      api,
      namespace: 'default'
    })

    expect(items).toEqual([{
      backupId: 'ocb-ready',
      createdAt: '2026-06-18T03:00:00Z',
      status: 'Ready'
    }])
    expect(api.listConfigMapCalls).toBe(1)
    expect(api.getConfigMapCalls).toBe(0)
  })

  it('filters corrupt snapshots out of the user backup list', async () => {
    const corrupt = makeCheckpoint({
      name: 'cp-corrupt',
      backupId: 'ocb-corrupt',
      createdAt: '2026-06-18T03:30:00Z',
      checkpointId: 'cp-corrupt',
      snapshotName: 'snapshot-corrupt',
      snapshotKey: 'corrupt.json'
    })
    const items = await service.listInstanceCheckpointBackups(makeInstance(), {
      api: makeApi({
        checkpoints: [corrupt],
        configMaps: new Map([
          ['default/snapshot-corrupt', {
            metadata: { name: 'snapshot-corrupt', namespace: 'default', labels: {} },
            data: { 'corrupt.json': '{not-json' }
          }]
        ])
      }),
      namespace: 'default'
    })

    expect(items).toEqual([])
  })

  it('does not list checkpoints that are still creating even after a checkpointId appears', async () => {
    const creating = makeCheckpoint({
      name: 'cp-creating',
      backupId: 'ocb-creating',
      createdAt: '2026-06-18T03:45:00Z',
      checkpointId: 'cp-creating',
      snapshotName: 'snapshot-creating',
      snapshotKey: 'creating.json',
      statusPhase: 'Creating'
    })
    const items = await service.listInstanceCheckpointBackups(makeInstance(), {
      api: makeApi({
        checkpoints: [creating],
        configMaps: new Map([
          ['default/snapshot-creating', {
            metadata: { name: 'snapshot-creating', namespace: 'default', labels: {} },
            data: { 'creating.json': JSON.stringify(makeReadySnapshot()) }
          }]
        ])
      }),
      namespace: 'default'
    })

    expect(items).toEqual([])
  })

  it('creates a new sandbox from backupId without mutating the source sandbox', async () => {
    const api = makeApi({
      sandboxAnnotations: {
        'checkpoint.alibabacloud.com/restore-from': 'cp-stale'
      }
    })
    const result = await service.createSandboxFromCheckpointBackup(makeInstance(), 'ocb-ready-newer', {
      api,
      namespace: 'default',
      now: new Date('2026-06-18T04:05:00Z'),
      sandboxName: 'agent-manager-openclaw-r4ndm',
      newInstanceId: '33333333-3333-4333-8333-333333333333',
      newInstanceName: 'source-restore-r4ndm',
      principalId: '22222222-2222-4222-8222-222222222222',
      userId: '22222222-2222-4222-8222-222222222222',
      agentType: {
        id: 'c43dfb89-73b3-4208-9864-baf0f86176aa',
        code: 'openclaw',
        sandbox_template_id: 'agent-manager-openclaw'
      }
    })

    expect(result).toMatchObject({
      status: 'Submitted',
      backupId: 'ocb-ready-newer',
      sourceInstanceId: '11111111-1111-4111-8111-111111111111',
      agentImage: 'image:v1',
      sandboxId: 'default--agent-manager-openclaw-r4ndm',
      sandboxName: 'agent-manager-openclaw-r4ndm'
    })
    expect(result).not.toHaveProperty('checkpointId')
    expect(api.appliedPatches).toHaveLength(0)
    expect(api.deletedSandboxes).toEqual([])
    expect(api.createdSandboxes).toHaveLength(1)
    expect(api.createdSandboxes[0].namespace).toBe('default')
    expect(api.createdSandboxes[0].body).toMatchObject({
      apiVersion: 'agents.kruise.io/v1alpha1',
      kind: 'Sandbox',
      metadata: {
        name: 'agent-manager-openclaw-r4ndm',
        namespace: 'default',
        labels: {
          'agent-manager.io/instance-id': '33333333-3333-4333-8333-333333333333',
          'agent-manager.io/source-instance-id': '11111111-1111-4111-8111-111111111111'
        },
        annotations: {
          'agent-manager.io/restore-backup-id': 'ocb-ready-newer',
          'agent-manager.io/restore-requested-at': '2026-06-18T04:05:00.000Z',
          'agent-manager.io/instance-id': '33333333-3333-4333-8333-333333333333',
          instanceId: '33333333-3333-4333-8333-333333333333',
          instanceName: 'source-restore-r4ndm'
        }
      },
      spec: {
        sandboxName: 'agent-manager-openclaw-r4ndm',
        template: {
          metadata: {
            annotations: {
              'checkpoint.alibabacloud.com/restore-from': 'cp-ready-newer'
            }
          },
          spec: {
            containers: [{ name: 'agent', image: 'image:v1' }]
          }
        }
      }
    })
    expect(api.createdSandboxes[0].body.metadata.annotations).not.toHaveProperty('checkpoint.alibabacloud.com/restore-from')
  })

  it('restores a claimed SDK-created sandbox while preserving E2B owner metadata', async () => {
    const redactedSnapshot = makeReadySnapshot()
    redactedSnapshot.spec.template.spec.containers[0].env = [
      { name: 'OPENCLAW_GATEWAY_TOKEN' },
      { name: 'SERVICE_NAME', valueFrom: { fieldRef: { fieldPath: 'metadata.name' } } },
      { name: 'REMOVED_RUNTIME_VALUE', value: 'must-not-be-restored' }
    ]
    redactedSnapshot.spec.template.spec.containers[0].envFrom = [
      { secretRef: { name: 'old-runtime-env' } }
    ]
    const currentSpec = structuredClone(redactedSnapshot.spec)
    currentSpec.template.spec.containers[0] = {
      name: 'agent',
      image: 'image:v2',
      env: [
        { name: 'OPENCLAW_GATEWAY_TOKEN', value: 'runtime-token-new' },
        { name: 'SERVICE_NAME', valueFrom: { fieldRef: { fieldPath: 'metadata.name' } } },
        { name: 'CURRENT_RUNTIME_VALUE', value: 'current-value' }
      ],
      envFrom: [{ secretRef: { name: 'current-runtime-env' } }]
    }
    redactedSnapshot.spec.template.spec.containers.push({
      name: 'snapshot-sidecar',
      image: 'sidecar:v1',
      env: [{ name: 'SIDECAR_CONFIG', value: 'snapshot-sidecar-value' }]
    })
    const api = makeApi({
      sandboxSpec: currentSpec,
      configMaps: new Map([
        ['default/snapshot-a', {
          metadata: { name: 'snapshot-a', namespace: 'default', labels: {} },
          data: { 'ocb-ready-newer.json': JSON.stringify(redactedSnapshot) }
        }]
      ]),
      sandboxLabels: {
        'agents.kruise.io/sandbox-claimed': 'true',
        'agents.kruise.io/sandbox-pool': 'agent-manager-openclaw',
        'agents.kruise.io/sandbox-template': 'agent-manager-openclaw'
      },
      sandboxAnnotations: {
        'agents.kruise.io/owner': 'owner-for-current-api-key',
        'agents.kruise.io/runtime-access-token': 'runtime-token-new',
        'agents.kruise.io/init-runtime-request': '{"accessToken":"runtime-token-new"}',
        'agents.kruise.io/lock': 'lock-new',
        'agent-manager.io/instance-id': '33333333-3333-4333-8333-333333333333',
        'agent-manager.io/user-id': '22222222-2222-4222-8222-222222222222',
        instanceId: '33333333-3333-4333-8333-333333333333',
        instanceName: 'source-backup-r4ndm',
        userId: '22222222-2222-4222-8222-222222222222'
      }
    })

    const result = await service.restoreClaimedSandboxFromCheckpointBackup(makeInstance(), 'ocb-ready-newer', {
      api,
      namespace: 'default',
      now: new Date('2026-06-18T04:06:00Z'),
      sandboxName: 'agent-manager-openclaw-r4ndm'
    })

    expect(result).toMatchObject({
      status: 'Submitted',
      backupId: 'ocb-ready-newer',
      sourceInstanceId: '11111111-1111-4111-8111-111111111111',
      agentImage: 'image:v1',
      sandboxId: 'default--agent-manager-openclaw-r4ndm',
      sandboxName: 'agent-manager-openclaw-r4ndm'
    })
    expect(api.deletedSandboxes).toEqual([{ namespace: 'default', name: 'agent-manager-openclaw-r4ndm' }])
    expect(api.createdSandboxes).toHaveLength(1)
    const body = api.createdSandboxes[0].body
    expect(body.metadata.name).toBe('agent-manager-openclaw-r4ndm')
    expect(body.metadata.labels).toMatchObject({
      'agents.kruise.io/sandbox-claimed': 'true',
      'agents.kruise.io/sandbox-pool': 'agent-manager-openclaw',
      'agents.kruise.io/sandbox-template': 'agent-manager-openclaw'
    })
    expect(body.metadata.annotations).toMatchObject({
      'agents.kruise.io/owner': 'owner-for-current-api-key',
      'agents.kruise.io/runtime-access-token': 'runtime-token-new',
      'agents.kruise.io/init-runtime-request': '{"accessToken":"runtime-token-new"}',
      'agents.kruise.io/lock': 'lock-new',
      'agent-manager.io/restore-backup-id': 'ocb-ready-newer',
      'agent-manager.io/restore-requested-at': '2026-06-18T04:06:00.000Z',
      'agent-manager.io/instance-id': '33333333-3333-4333-8333-333333333333',
      instanceId: '33333333-3333-4333-8333-333333333333',
      instanceName: 'source-backup-r4ndm'
    })
    expect(body.spec.template.metadata.annotations).toMatchObject({
      'checkpoint.alibabacloud.com/restore-from': 'cp-ready-newer'
    })
    expect(body.spec.template.spec.containers[0]).toMatchObject({
      name: 'agent',
      image: 'image:v1',
      env: [
        { name: 'OPENCLAW_GATEWAY_TOKEN', value: 'runtime-token-new' },
        { name: 'SERVICE_NAME', valueFrom: { fieldRef: { fieldPath: 'metadata.name' } } },
        { name: 'CURRENT_RUNTIME_VALUE', value: 'current-value' }
      ],
      envFrom: [{ secretRef: { name: 'current-runtime-env' } }]
    })
    expect(JSON.stringify(body)).not.toContain('must-not-be-restored')
    expect(JSON.stringify(body)).not.toContain('old-runtime-env')
    expect(body.spec.template.spec.containers[1]).toMatchObject({
      name: 'snapshot-sidecar',
      env: [{ name: 'SIDECAR_CONFIG', value: 'snapshot-sidecar-value' }]
    })
  })

  it('returns 404 when backupId does not exist for the source instance', async () => {
    await expect(service.restoreInstanceCheckpointBackup(makeInstance(), 'ocb-unknown', {
      api: makeApi(),
      namespace: 'default'
    })).rejects.toMatchObject({
      status: 404,
      code: 'BACKUP_NOT_FOUND'
    })
  })

  it('returns 409 when multiple checkpoints match the same backupId', async () => {
    const duplicateA = makeCheckpoint({
      name: 'cp-a',
      backupId: 'ocb-duplicate',
      createdAt: '2026-06-18T03:00:00Z',
      checkpointId: 'cp-a'
    })
    const duplicateB = makeCheckpoint({
      name: 'cp-b',
      backupId: 'ocb-duplicate',
      createdAt: '2026-06-18T03:01:00Z',
      checkpointId: 'cp-b'
    })

    await expect(service.restoreInstanceCheckpointBackup(makeInstance(), 'ocb-duplicate', {
      api: makeApi({ checkpoints: [duplicateA, duplicateB] }),
      namespace: 'default'
    })).rejects.toMatchObject({
      status: 409,
      code: 'BACKUP_CONFLICT'
    })
  })

  it('returns 409 when the selected backup is not restorable', async () => {
    await expect(service.restoreInstanceCheckpointBackup(makeInstance(), 'ocb-missing-snapshot', {
      api: makeApi(),
      namespace: 'default'
    })).rejects.toMatchObject({
      status: 409,
      code: 'BACKUP_NOT_RESTORABLE'
    })
  })

  it('returns 409 instead of restoring when the checkpoint is still creating', async () => {
    const creating = makeCheckpoint({
      name: 'cp-creating',
      backupId: 'ocb-creating',
      createdAt: '2026-06-18T03:45:00Z',
      checkpointId: 'cp-creating',
      snapshotName: 'snapshot-creating',
      snapshotKey: 'creating.json',
      statusPhase: 'Creating'
    })
    const api = makeApi({
      checkpoints: [creating],
      configMaps: new Map([
        ['default/snapshot-creating', {
          metadata: { name: 'snapshot-creating', namespace: 'default', labels: {} },
          data: { 'creating.json': JSON.stringify(makeReadySnapshot()) }
        }]
      ])
    })

    await expect(service.createSandboxFromCheckpointBackup(makeInstance(), 'ocb-creating', {
      api,
      namespace: 'default',
      sandboxName: 'agent-manager-openclaw-r4ndm',
      newInstanceId: '33333333-3333-4333-8333-333333333333'
    })).rejects.toMatchObject({
      status: 409,
      code: 'BACKUP_NOT_RESTORABLE'
    })
    expect(api.createdSandboxes).toEqual([])
  })

  it('rejects backup actions while the instance has no Sandbox binding', async () => {
    await expect(service.startInstanceCheckpointBackup(makeInstance({ sandbox_id: null }), {
      api: makeApi(),
      namespace: 'default'
    })).rejects.toMatchObject({
      status: 409,
      code: 'SANDBOX_NOT_READY'
    })
  })
})
