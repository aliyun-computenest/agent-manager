import { describe, expect, it } from 'vitest'
import {
  completeCheckpointRestoreConfigJson,
  createRestoredSandboxName,
  getBackupRestoreCapabilityForSandboxSet,
  resolveInstanceAgentImage
} from '../../server/services/instance-provisioner.js'
import { getSandboxTemplateAgentImage } from '../../server/services/checkpoint-backups/sandbox-image.js'

describe('createRestoredSandboxName', () => {
  it('builds a valid random Sandbox name from the source SandboxSet name', () => {
    const name = createRestoredSandboxName('agent-manager-openclaw')

    expect(name).toMatch(/^agent-manager-openclaw-[a-z0-9]{6}$/)
    expect(name.length).toBeLessThanOrEqual(63)
  })

  it('sanitizes unusual template names into a Kubernetes DNS label', () => {
    const name = createRestoredSandboxName('Agent_Manager OpenClaw 恢复')

    expect(name).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/)
    expect(name).toMatch(/^agent-manager-openclaw-[a-z0-9]{6}$/)
  })
})

describe('getBackupRestoreCapabilityForSandboxSet', () => {
  it('fails closed when SandboxSet capability cannot be inspected', async () => {
    const api = {
      async getSandboxSet() {
        const error = new Error('cluster unavailable')
        error.httpStatus = 503
        throw error
      }
    }

    await expect(getBackupRestoreCapabilityForSandboxSet('agent-manager-openclaw', {
      api,
      namespace: 'default'
    })).rejects.toMatchObject({
      name: 'ProvisionError',
      status: 503
    })
  })

  it('can degrade to unsupported capability without blocking sandbox creation', async () => {
    const api = {
      async getSandboxSet() {
        const error = new Error('SandboxSet "agent-manager-qwenpaw" not found')
        error.httpStatus = 404
        throw error
      }
    }

    const capability = await getBackupRestoreCapabilityForSandboxSet('agent-manager-qwenpaw', {
      api,
      namespace: 'default',
      required: false
    })

    expect(capability).toMatchObject({
      Supported: false,
      RequiredRuntimes: [],
      MissingRuntimes: []
    })
    expect(capability.Message).toContain('Unable to check backup/restore capability for SandboxSet agent-manager-qwenpaw')
    expect(capability.Message).toContain('SandboxSet "agent-manager-qwenpaw" not found')
  })

  it('can degrade when the optional Kubernetes API client cannot be created', async () => {
    const capability = await getBackupRestoreCapabilityForSandboxSet('agent-manager-qwenpaw', {
      createApi() {
        throw new Error('kube config unavailable')
      },
      namespace: 'default',
      required: false
    })

    expect(capability).toMatchObject({
      Supported: false,
      RequiredRuntimes: [],
      MissingRuntimes: []
    })
    expect(capability.Message).toContain('Unable to check backup/restore capability for SandboxSet agent-manager-qwenpaw')
    expect(capability.Message).toContain('kube config unavailable')
  })

  it('still fails closed when required Kubernetes API client cannot be created', async () => {
    await expect(getBackupRestoreCapabilityForSandboxSet('agent-manager-openclaw', {
      createApi() {
        throw new Error('kube config unavailable')
      },
      namespace: 'default'
    })).rejects.toMatchObject({
      name: 'ProvisionError',
      status: 503
    })
  })

  it('falls back from the manager namespace to the sandbox namespace', async () => {
    const calls = []
    const api = {
      async getSandboxSet(namespace, name) {
        calls.push([namespace, name])
        if (namespace !== 'default') {
          const error = new Error(`SandboxSet "${name}" not found in ${namespace}`)
          error.httpStatus = 404
          throw error
        }
        return {
          spec: {
            runtimes: [
              { name: 'agent-runtime' },
              { name: 'csi' }
            ]
          }
        }
      }
    }

    const capability = await getBackupRestoreCapabilityForSandboxSet('agent-manager-openclaw', {
      api,
      namespaces: ['openclaw-platform', 'default'],
      required: false
    })

    expect(capability.Supported).toBe(true)
    expect(calls).toEqual([
      ['openclaw-platform', 'agent-manager-openclaw'],
      ['default', 'agent-manager-openclaw']
    ])
  })
})

describe('resolveInstanceAgentImage', () => {
  it('uses the restored snapshot image before source or SandboxSet lookup', async () => {
    const image = await resolveInstanceAgentImage({
      sandboxTemplateId: 'agent-manager-openclaw',
      restoredAgentImage: 'snapshot-image:v1',
      sourceAgentImage: 'source-image:v1',
      async lookupImage() {
        return 'template-image:v2'
      }
    })

    expect(image).toBe('snapshot-image:v1')
  })

  it('falls back to the source instance image for restored instances', async () => {
    const image = await resolveInstanceAgentImage({
      sandboxTemplateId: 'agent-manager-openclaw',
      sourceAgentImage: 'source-image:v1',
      async lookupImage() {
        throw new Error('cluster unavailable')
      }
    })

    expect(image).toBe('source-image:v1')
  })

  it('uses the SandboxSet image for ordinary new instances', async () => {
    const image = await resolveInstanceAgentImage({
      sandboxTemplateId: 'agent-manager-openclaw',
      async lookupImage(name) {
        expect(name).toBe('agent-manager-openclaw')
        return 'template-image:v2'
      }
    })

    expect(image).toBe('template-image:v2')
  })

  it('looks up SandboxSet image from the sandbox namespace before the manager namespace', async () => {
    const previousNamespace = process.env.SANDBOX_NAMESPACE
    process.env.SANDBOX_NAMESPACE = 'openclaw-platform'
    const calls = []
    try {
      const image = await resolveInstanceAgentImage({
        sandboxTemplateId: 'agent-manager-openclaw',
        sandboxNamespace: 'default',
        async lookupImage(name, namespace) {
          calls.push([name, namespace])
          if (namespace === 'default') return 'template-image:default'
          throw new Error(`SandboxSet not found in ${namespace}`)
        }
      })

      expect(image).toBe('template-image:default')
      expect(calls).toEqual([['agent-manager-openclaw', 'default']])
    } finally {
      if (previousNamespace === undefined) {
        delete process.env.SANDBOX_NAMESPACE
      } else {
        process.env.SANDBOX_NAMESPACE = previousNamespace
      }
    }
  })
})

describe('completeCheckpointRestoreConfigJson', () => {
  it('marks restoring checkpoint metadata as completed', () => {
    const now = new Date('2026-07-07T08:00:00Z')
    const result = completeCheckpointRestoreConfigJson({
      customVars: { foo: 'bar' },
      checkpointRestore: {
        backupId: 'ocb-ready',
        status: 'restoring',
        startedAt: '2026-07-07T07:59:00Z'
      }
    }, now)

    expect(result).toEqual({
      changed: true,
      configJson: {
        customVars: { foo: 'bar' },
        checkpointRestore: {
          backupId: 'ocb-ready',
          status: 'completed',
          startedAt: '2026-07-07T07:59:00Z',
          completedAt: '2026-07-07T08:00:00.000Z'
        }
      }
    })
  })

  it('leaves non-restore config unchanged', () => {
    const result = completeCheckpointRestoreConfigJson({ customVars: { foo: 'bar' } })

    expect(result).toEqual({
      changed: false,
      configJson: { customVars: { foo: 'bar' } }
    })
  })
})

describe('getSandboxTemplateAgentImage', () => {
  it('reads images from current and legacy Sandbox template shapes', () => {
    expect(getSandboxTemplateAgentImage({
      spec: { template: { spec: { containers: [{ image: 'current:v1' }] } } }
    })).toBe('current:v1')
    expect(getSandboxTemplateAgentImage({
      spec: { template: { containers: [{ image: 'legacy:v1' }] } }
    })).toBe('legacy:v1')
  })
})
