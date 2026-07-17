export function makeInstance(overrides = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    principal_id: '22222222-2222-4222-8222-222222222222',
    agent_type_id: null,
    name: 'source',
    description: null,
    model_id: null,
    status: 'running',
    config_json: {},
    sandbox_id: 'default--sandbox-a',
    agent_image: null,
    ...overrides
  }
}

export function makeReadySnapshot() {
  return {
    apiVersion: 'agents.kruise.io/v1alpha1',
    kind: 'Sandbox',
    metadata: {
      labels: {
        'agent-manager.io/instance-id': '11111111-1111-4111-8111-111111111111'
      },
      annotations: {}
    },
    spec: {
      sandboxName: 'sandbox-a',
      template: {
        spec: {
          containers: [{ name: 'agent', image: 'image:v1' }]
        }
      }
    }
  }
}

export function makeCheckpoint({
  name,
  backupId,
  createdAt,
  checkpointId,
  snapshotName = 'snapshot-a',
  snapshotKey = `${backupId}.json`,
  statusPhase = 'Ready',
  sourceInstanceId = '11111111-1111-4111-8111-111111111111'
}) {
  return {
    metadata: {
      name,
      creationTimestamp: createdAt,
      labels: {
        'agent-manager.io/managed-by': 'agent-manager',
        'agent-manager.io/backup-kind': 'checkpoint',
        'agent-manager.io/source-instance-id': sourceInstanceId,
        'agent-manager.io/source-sandbox-name': 'sandbox-a',
        'agent-manager.io/backup-id': backupId,
        'agent-manager.io/backup-run-id': `run-${backupId}`
      },
      annotations: {
        'agent-manager.io/spec-snapshot-name': snapshotName,
        'agent-manager.io/spec-snapshot-key': snapshotKey
      }
    },
    spec: { sandboxName: 'sandbox-a' },
    status: checkpointId ? { phase: statusPhase, checkpointId } : { phase: statusPhase }
  }
}

export function makeApi({ sandboxAnnotations = {}, sandboxLabels = {}, checkpoints = null, configMaps = null, sandboxSpec = null } = {}) {
  const ready = makeCheckpoint({
    name: 'cp-newer',
    backupId: 'ocb-ready-newer',
    createdAt: '2026-06-18T03:00:00Z',
    checkpointId: 'cp-ready-newer'
  })
  const older = makeCheckpoint({
    name: 'cp-older',
    backupId: 'ocb-ready-older',
    createdAt: '2026-06-18T02:00:00Z',
    checkpointId: 'cp-ready-older',
    snapshotKey: 'ocb-ready-older.json'
  })
  const missingSnapshot = makeCheckpoint({
    name: 'cp-missing-snapshot',
    backupId: 'ocb-missing-snapshot',
    createdAt: '2026-06-18T01:00:00Z',
    checkpointId: 'cp-missing',
    snapshotName: 'missing-snapshot'
  })
  const withoutCheckpointId = makeCheckpoint({
    name: 'cp-no-id',
    backupId: 'ocb-no-id',
    createdAt: '2026-06-18T00:00:00Z',
    checkpointId: null,
    statusPhase: 'InProgress'
  })
  const checkpointItems = checkpoints || [missingSnapshot, withoutCheckpointId, older, ready]
  const maps = configMaps || new Map([
    ['default/snapshot-a', {
      metadata: {
        name: 'snapshot-a',
        namespace: 'default',
        labels: {
          'agent-manager.io/managed-by': 'agent-manager',
          'agent-manager.io/backup-kind': 'spec-snapshot',
          'agent-manager.io/source-instance-id': '11111111-1111-4111-8111-111111111111'
        }
      },
      data: {
        'ocb-ready-newer.json': JSON.stringify(makeReadySnapshot()),
        'ocb-ready-older.json': JSON.stringify(makeReadySnapshot())
      }
    }]
  ])
  const appliedPatches = []
  const deletedSandboxes = []
  const createdSandboxes = []
  let sandboxDeleted = false

  return {
    appliedPatches,
    deletedSandboxes,
    createdSandboxes,
    async getSandbox() {
      if (sandboxDeleted) {
        const error = new Error('not found')
        error.httpStatus = 404
        throw error
      }
      return {
        metadata: {
          name: 'sandbox-a',
          labels: {
            'agent-manager.io/managed-by': 'agent-manager',
            'agent-manager.io/instance-id': '11111111-1111-4111-8111-111111111111',
            ...sandboxLabels
          },
          annotations: sandboxAnnotations
        },
        spec: sandboxSpec || makeReadySnapshot().spec
      }
    },
    async listCheckpoints(namespace, selector) {
      const labels = selector?.matchLabels || {}
      const filtered = checkpointItems.filter((checkpoint) => Object.entries(labels).every(([key, value]) =>
        checkpoint.metadata?.labels?.[key] === value
      ))
      return { items: filtered }
    },
    async getConfigMap(namespace, name) {
      const configMap = maps.get(`${namespace}/${name}`)
      if (!configMap) {
        const error = new Error('not found')
        error.httpStatus = 404
        throw error
      }
      return configMap
    },
    async patchSandbox(namespace, name, patch) {
      appliedPatches.push({ namespace, name, patch })
      return { status: 'Success' }
    },
    async deleteSandbox(namespace, name) {
      deletedSandboxes.push({ namespace, name })
      sandboxDeleted = true
      return { status: 'Success' }
    },
    async createSandbox(namespace, body) {
      createdSandboxes.push({ namespace, body })
      sandboxDeleted = false
      return body
    }
  }
}
