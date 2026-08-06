import { describe, expect, it } from 'vitest'
import {
  buildSandboxUpdateOps,
  buildSandboxUpdatePatchFromSandboxSet,
  buildOriginalTargetAnnotation,
  getSandboxSetBackupRestoreCapability,
  getBlockingSandboxUpdateOps,
  getRetryLifecycleMode,
  getRetryTargetFromSandboxUpdateOps,
  canRepairSandboxUpdateOps,
  getPatchSampleSandboxesForTarget,
  getSandboxListOptionsForTarget,
  normalizeUpgradeMetadataForLifecycle,
  shouldPatchUpgradeIdLabel,
  summarizeSandboxUpdateOps
} from '../../server/services/sandbox-upgrades.js'

function sandboxUpdateOps(name, phase) {
  return {
    metadata: { name },
    status: phase === undefined ? {} : { phase }
  }
}

function sandboxSet() {
  return {
    metadata: { name: 'agent-manager-openclaw' },
    spec: {
      template: {
        spec: {
          containers: [
            {
              name: 'agent-manager-openclaw',
              image: 'registry.example/openclaw:v2'
            }
          ]
        }
      }
    }
  }
}

function sandboxFromTemplate(templateSpec) {
  return {
    spec: {
      template: {
        spec: templateSpec
      }
    }
  }
}

describe('getBlockingSandboxUpdateOps', () => {
  it('blocks failed SandboxUpdateOps that has not been deleted', () => {
    const blocking = getBlockingSandboxUpdateOps([
      sandboxUpdateOps('finished-upgrade', 'Completed'),
      sandboxUpdateOps('failed-upgrade', 'Failed')
    ])

    expect(blocking?.metadata?.name).toBe('failed-upgrade')
  })

  it('blocks unfinished SandboxUpdateOps without a completed phase', () => {
    expect(getBlockingSandboxUpdateOps([sandboxUpdateOps('updating-upgrade', 'Updating')])?.metadata?.name)
      .toBe('updating-upgrade')
    expect(getBlockingSandboxUpdateOps([sandboxUpdateOps('pending-upgrade')])?.metadata?.name)
      .toBe('pending-upgrade')
  })

  it('allows creating another upgrade when all existing SandboxUpdateOps are completed', () => {
    expect(getBlockingSandboxUpdateOps([
      sandboxUpdateOps('finished-upgrade', 'Completed')
    ])).toBeNull()
  })
})

describe('normalizeUpgradeMetadataForLifecycle', () => {
  it('allows PatchOnly upgrades without pre/post hooks', () => {
    expect(normalizeUpgradeMetadataForLifecycle({}, 'PatchOnly')).toBeNull()
  })

  it('keeps requiring pre/post hooks for Full upgrades', () => {
    expect(() => normalizeUpgradeMetadataForLifecycle({}, 'Full')).toThrow(/preUpgrade/i)
  })

  it('allows PostOnly upgrades with only post hooks', () => {
    expect(normalizeUpgradeMetadataForLifecycle({
      timeoutSeconds: 30,
      postUpgrade: { command: ['sh', '-lc', 'restore'] }
    }, 'PostOnly')).toEqual({
      timeoutSeconds: 30,
      postUpgrade: { command: ['sh', '-lc', 'restore'] }
    })
  })
})

describe('getSandboxSetBackupRestoreCapability', () => {
  it('requires both agent-runtime and csi runtimes', () => {
    const capability = getSandboxSetBackupRestoreCapability({
      spec: {
        runtimes: [
          { name: 'agent-runtime' },
          { name: 'csi' }
        ]
      }
    })

    expect(capability.Supported).toBe(true)
    expect(capability.MissingRuntimes).toEqual([])
  })

  it('reports missing runtimes when the SandboxSet cannot mount backup storage', () => {
    const capability = getSandboxSetBackupRestoreCapability({
      spec: {
        runtimes: [
          { name: 'agent-runtime' }
        ]
      }
    })

    expect(capability.Supported).toBe(false)
    expect(capability.MissingRuntimes).toEqual(['csi'])
    expect(capability.Message).toContain('csi')
  })
})

describe('buildSandboxUpdateOps', () => {
  it('builds PatchOnly upgrades without lifecycle hooks', () => {
    const manifest = buildSandboxUpdateOps({
      upgradeId: 'sbu-patch-only',
      namespace: 'default',
      agentTypeId: 'agent-type-id',
      sandboxSet: sandboxSet(),
      selector: {
        matchLabels: {
          app: 'agent-manager-openclaw'
        },
        matchExpressions: []
      },
      maxUnavailable: 1,
      clientTokenHash: 'client-token-hash',
      upgradeMetadata: {},
      lifecycleMode: 'PatchOnly'
    })

    expect(manifest.spec.lifecycle).toBeUndefined()
    expect(manifest.spec.selector).toEqual({
      matchLabels: {
        app: 'agent-manager-openclaw'
      }
    })
    expect(manifest.spec.patch.spec.containers).toEqual([
      {
        name: 'agent-manager-openclaw',
        image: 'registry.example/openclaw:v2'
      }
    ])
  })

  it('builds automatic patches from changed SandboxSet template fields', () => {
    const targetSandboxSet = {
      metadata: { name: 'agent-manager-openclaw' },
      spec: {
        template: {
          spec: {
            containers: [
              {
                name: 'agent-manager-openclaw',
                image: 'registry.example/openclaw:v2',
                command: ['supervisord', '-n'],
                env: [
                  { name: 'OPENCLAW_CONFIG_DIR', value: '/home/node/.openclaw/openclaw.json' },
                  { name: 'OPENCLAW_GATEWAY_TOKEN', value: 'xxx' }
                ],
                volumeMounts: [
                  { name: 'workspace', mountPath: '/home/node/.openclaw' }
                ]
              }
            ],
            volumes: [
              { name: 'workspace', emptyDir: {} }
            ]
          }
        }
      }
    }

    const patch = buildSandboxUpdatePatchFromSandboxSet(targetSandboxSet, [
      sandboxFromTemplate({
        containers: [
          {
            name: 'agent-manager-openclaw',
            image: 'registry.example/openclaw:v1',
            env: [
              { name: 'OPENCLAW_CONFIG_DIR', value: '/home/node/.openclaw/openclaw.json' }
            ]
          }
        ]
      })
    ])

    expect(patch).toEqual({
      spec: {
        containers: [
          {
            name: 'agent-manager-openclaw',
            image: 'registry.example/openclaw:v2',
            command: ['supervisord', '-n'],
            env: [
              { name: 'OPENCLAW_CONFIG_DIR', value: '/home/node/.openclaw/openclaw.json' },
              { name: 'OPENCLAW_GATEWAY_TOKEN', value: 'xxx' }
            ],
            volumeMounts: [
              { name: 'workspace', mountPath: '/home/node/.openclaw' }
            ]
          }
        ],
        volumes: [
          { name: 'workspace', emptyDir: {} }
        ]
      }
    })
  })

  it('adds strategic merge delete directives for removed template list items', () => {
    const targetSandboxSet = {
      metadata: { name: 'agent-manager-openclaw' },
      spec: {
        template: {
          spec: {
            containers: [
              {
                name: 'agent-manager-openclaw',
                image: 'registry.example/openclaw:v2',
                env: [
                  { name: 'OPENCLAW_CONFIG_DIR', value: '/home/node/.openclaw/openclaw.json' }
                ],
                volumeMounts: [
                  { name: 'workspace', mountPath: '/home/node/.openclaw' }
                ]
              }
            ],
            volumes: [
              { name: 'workspace', emptyDir: {} }
            ]
          }
        }
      }
    }

    const patch = buildSandboxUpdatePatchFromSandboxSet(targetSandboxSet, [
      sandboxFromTemplate({
        containers: [
          {
            name: 'agent-manager-openclaw',
            image: 'registry.example/openclaw:v2',
            env: [
              { name: 'OPENCLAW_CONFIG_DIR', value: '/home/node/.openclaw/openclaw.json' },
              { name: 'OPENCLAW_AUTO_PATCH_TEST', value: 'stale' }
            ],
            volumeMounts: [
              { name: 'workspace', mountPath: '/home/node/.openclaw' },
              { name: 'old-cache', mountPath: '/tmp/old-cache' }
            ]
          }
        ],
        volumes: [
          { name: 'workspace', emptyDir: {} },
          { name: 'old-cache', emptyDir: {} }
        ]
      })
    ])

    expect(patch.spec.containers[0].env).toEqual([
      { name: 'OPENCLAW_CONFIG_DIR', value: '/home/node/.openclaw/openclaw.json' },
      { name: 'OPENCLAW_AUTO_PATCH_TEST', $patch: 'delete' }
    ])
    expect(patch.spec.containers[0].volumeMounts).toEqual([
      { name: 'workspace', mountPath: '/home/node/.openclaw' },
      { mountPath: '/tmp/old-cache', $patch: 'delete' }
    ])
    expect(patch.spec.volumes).toEqual([
      { name: 'workspace', emptyDir: {} },
      { name: 'old-cache', $patch: 'delete' }
    ])
  })

  it('keeps unchanged optional fields out of the automatic patch', () => {
    const targetSandboxSet = {
      metadata: { name: 'agent-manager-openclaw' },
      spec: {
        template: {
          spec: {
            containers: [
              {
                name: 'agent-manager-openclaw',
                image: 'registry.example/openclaw:v2',
                command: ['supervisord', '-n'],
                env: [
                  { name: 'OPENCLAW_GATEWAY_TOKEN', value: 'xxx' }
                ]
              }
            ]
          }
        }
      }
    }

    const manifest = buildSandboxUpdateOps({
      upgradeId: 'sbu-auto-patch',
      namespace: 'default',
      agentTypeId: 'agent-type-id',
      sandboxSet: targetSandboxSet,
      sandboxes: [
        sandboxFromTemplate({
          containers: [
            {
              name: 'agent-manager-openclaw',
              image: 'registry.example/openclaw:v1',
              command: ['supervisord', '-n'],
              env: [
                { name: 'OPENCLAW_GATEWAY_TOKEN', value: 'xxx' }
              ]
            }
          ]
        })
      ],
      selector: {
        matchLabels: {
          app: 'agent-manager-openclaw'
        },
        matchExpressions: []
      },
      maxUnavailable: 1,
      clientTokenHash: 'client-token-hash',
      upgradeMetadata: {},
      lifecycleMode: 'PatchOnly'
    })

    expect(manifest.spec.patch).toEqual({
      spec: {
        containers: [
          {
            name: 'agent-manager-openclaw',
            image: 'registry.example/openclaw:v2'
          }
        ]
      }
    })
  })
})

describe('LabelSelector target handling', () => {
  it('does not require temporary upgrade labels for LabelSelector targets', () => {
    expect(shouldPatchUpgradeIdLabel({ type: 'LabelSelector', selector: { matchLabels: { app: 'demo' } } })).toBe(false)
    expect(shouldPatchUpgradeIdLabel({ type: 'SelectedSandboxes', sandboxNames: ['demo-1'] })).toBe(true)
  })

  it('uses a single representative Sandbox sample for LabelSelector patch generation', () => {
    const sandboxes = [
      { metadata: { name: 'demo-1' } },
      { metadata: { name: 'demo-2' } }
    ]

    expect(getSandboxListOptionsForTarget({ type: 'LabelSelector', selector: { matchLabels: { app: 'demo' } } }))
      .toEqual({ limit: 1 })
    expect(getPatchSampleSandboxesForTarget({ type: 'LabelSelector', selector: { matchLabels: { app: 'demo' } } }, sandboxes))
      .toEqual([sandboxes[0]])
  })

  it('keeps all matched Sandboxes as patch input for SelectedSandboxes targets', () => {
    const sandboxes = [
      { metadata: { name: 'demo-1' } },
      { metadata: { name: 'demo-2' } }
    ]

    expect(getSandboxListOptionsForTarget({ type: 'SelectedSandboxes', sandboxNames: ['demo-1', 'demo-2'] }))
      .toEqual({})
    expect(getPatchSampleSandboxesForTarget({ type: 'SelectedSandboxes', sandboxNames: ['demo-1', 'demo-2'] }, sandboxes))
      .toEqual(sandboxes)
  })

  it('stores the original target so failed LabelSelector upgrades can be retried', () => {
    const target = { type: 'LabelSelector', selector: { matchLabels: { app: 'demo' }, matchExpressions: [] } }

    expect(JSON.parse(buildOriginalTargetAnnotation(target))).toEqual({
      type: 'LabelSelector',
      selector: {
        matchLabels: {
          app: 'demo'
        }
      }
    })
  })
})

describe('getRetryTargetFromSandboxUpdateOps', () => {
  it('reuses the original LabelSelector target', () => {
    const target = { type: 'LabelSelector', selector: { matchLabels: { app: 'demo' }, matchExpressions: [] } }
    const retryTarget = getRetryTargetFromSandboxUpdateOps({
      metadata: {
        annotations: {
          'openclaw.io/target-type': 'LabelSelector',
          'openclaw.io/original-target': buildOriginalTargetAnnotation(target)
        }
      },
      spec: {
        selector: {
          matchLabels: {
            app: 'demo',
            'openclaw.io/upgrade-id': 'old-upgrade'
          },
          matchExpressions: []
        }
      }
    })

    expect(retryTarget).toEqual({
      type: 'LabelSelector',
      selector: {
        matchLabels: {
          app: 'demo'
        }
      }
    })
  })

  it('prefers failed Sandbox names over the original LabelSelector target', () => {
    const target = { type: 'LabelSelector', selector: { matchLabels: { app: 'demo' }, matchExpressions: [] } }
    const retryTarget = getRetryTargetFromSandboxUpdateOps({
      metadata: {
        annotations: {
          'openclaw.io/target-type': 'LabelSelector',
          'openclaw.io/original-target': buildOriginalTargetAnnotation(target)
        }
      }
    }, [
      { SandboxName: 'demo-2', ConditionType: 'Upgrading', ConditionStatus: 'False', Reason: 'UpgradePodFailed' }
    ])

    expect(retryTarget).toEqual({
      type: 'SelectedSandboxes',
      sandboxNames: ['demo-2']
    })
  })

  it('retries only failed sandboxes for SelectedSandboxes targets', () => {
    const retryTarget = getRetryTargetFromSandboxUpdateOps({
      metadata: {
        annotations: {
          'openclaw.io/target-type': 'SelectedSandboxes',
          'openclaw.io/target-sandbox-names': JSON.stringify(['demo-1', 'demo-2'])
        }
      }
    }, [
      { SandboxName: 'demo-2', ConditionType: 'Upgrading', ConditionStatus: 'False', Reason: 'UpgradePodFailed' }
    ])

    expect(retryTarget).toEqual({
      type: 'SelectedSandboxes',
      sandboxNames: ['demo-2']
    })
  })
})

describe('getRetryLifecycleMode', () => {
  it('retries from the beginning when the upgrade-before command failed', () => {
    expect(getRetryLifecycleMode({
      metadata: { annotations: { 'openclaw.io/lifecycle-mode': 'Full' } }
    }, [
      { Reason: 'PreUpgradeFailed', Message: 'pre upgrade hook failed' }
    ])).toBe('Full')
  })

  it('uses restore-only retry for pod startup or restore failures', () => {
    expect(getRetryLifecycleMode({
      metadata: { annotations: { 'openclaw.io/lifecycle-mode': 'Full' } }
    }, [
      { Reason: 'UpgradePodFailed', Message: 'ImagePullBackOff' }
    ])).toBe('PostOnly')
  })

  it('can detect upgrade-before failures from ops conditions before sandbox details sync', () => {
    expect(getRetryLifecycleMode({
      metadata: { annotations: { 'openclaw.io/lifecycle-mode': 'Full' } },
      status: {
        conditions: [
          { reason: 'PreUpgradeFailed', message: 'upgrade-before command failed' }
        ]
      }
    }, [])).toBe('Full')
  })
})

describe('summarizeSandboxUpdateOps', () => {
  it('does not throw when Kubernetes returns an item without metadata', () => {
    expect(summarizeSandboxUpdateOps({ status: { phase: 'Failed' } })).toMatchObject({
      UpgradeId: undefined,
      Phase: 'Failed'
    })
  })

  it('uses update-ops Sandbox details as the progress source of truth', () => {
    const summary = summarizeSandboxUpdateOps({
      status: {
        phase: 'Updating',
        replicas: 5,
        updatedReplicas: 2,
        updatingReplicas: 0,
        failedReplicas: 1
      }
    }, [
      { SandboxName: 'sandbox-a', Phase: 'Running', ConditionType: 'Upgrading', ConditionStatus: 'True', Reason: 'Succeeded' },
      { SandboxName: 'sandbox-b', Phase: 'Running', ConditionType: 'Upgrading', ConditionStatus: 'True', Reason: 'Succeeded' },
      { SandboxName: 'sandbox-c', Phase: 'Upgrading', ConditionType: 'Upgrading', ConditionStatus: 'False', Reason: 'UpgradePodFailed', Message: 'CrashLoopBackOff' }
    ])

    expect(summary.RawPhase).toBe('Updating')
    expect(summary.Phase).toBe('Failed')
    expect(summary.Progress).toEqual({
      Replicas: 3,
      UpdatedReplicas: 2,
      UpdatingReplicas: 0,
      FailedReplicas: 1
    })
  })

  it('uses matched sandbox count for completed history when controller clears status counts', () => {
    const summary = summarizeSandboxUpdateOps({
      metadata: {
        creationTimestamp: '2026-06-01T00:00:00Z',
        annotations: {
          'openclaw.io/matched-sandbox-count': '1'
        }
      },
      status: {
        phase: 'Completed',
        replicas: 0,
        updatedReplicas: 0,
        updatingReplicas: 0,
        failedReplicas: 0
      }
    })

    expect(summary.Phase).toBe('Completed')
    expect(summary.Progress).toEqual({
      Replicas: 1,
      UpdatedReplicas: 1,
      UpdatingReplicas: 0,
      FailedReplicas: 0
    })
  })

  it('does not mark a just-created empty completed status as completed history', () => {
    const summary = summarizeSandboxUpdateOps({
      metadata: {
        creationTimestamp: new Date().toISOString(),
        annotations: {
          'openclaw.io/matched-sandbox-count': '1'
        }
      },
      status: {
        phase: 'Completed',
        replicas: 0,
        updatedReplicas: 0,
        updatingReplicas: 0,
        failedReplicas: 0
      }
    })

    expect(summary.Phase).toBe('Pending')
    expect(summary.Progress).toEqual({
      Replicas: 1,
      UpdatedReplicas: 0,
      UpdatingReplicas: 0,
      FailedReplicas: 0
    })
  })

  it('does not mark a just-created labeled but not-yet-upgrading Sandbox as completed', () => {
    const summary = summarizeSandboxUpdateOps({
      metadata: {
        name: 'sbu-new',
        creationTimestamp: new Date().toISOString(),
        annotations: {
          'openclaw.io/matched-sandbox-count': '1'
        }
      },
      status: {
        phase: 'Completed',
        replicas: 0,
        updatedReplicas: 0,
        updatingReplicas: 0,
        failedReplicas: 0
      }
    }, [
      {
        SandboxName: 'sandbox-a',
        Phase: 'Running',
        ConditionType: 'Ready',
        ConditionStatus: 'True',
        Reason: 'Ready'
      }
    ])

    expect(summary.Phase).toBe('Pending')
    expect(summary.Progress).toEqual({
      Replicas: 1,
      UpdatedReplicas: 0,
      UpdatingReplicas: 0,
      FailedReplicas: 0
    })
  })

  it('does not treat an in-progress upgrade stage as failed', () => {
    const summary = summarizeSandboxUpdateOps({
      status: {
        phase: 'Updating',
        replicas: 1,
        updatedReplicas: 0,
        updatingReplicas: 1,
        failedReplicas: 0
      }
    }, [
      { SandboxName: 'sandbox-a', Phase: 'Upgrading', ConditionType: 'Upgrading', ConditionStatus: 'False', Reason: 'UpgradePod' }
    ])

    expect(summary.Phase).toBe('Updating')
    expect(summary.Progress).toEqual({
      Replicas: 1,
      UpdatedReplicas: 0,
      UpdatingReplicas: 1,
      FailedReplicas: 0
    })
  })

  it('treats unknown false upgrade conditions as failed', () => {
    const summary = summarizeSandboxUpdateOps({
      status: {
        phase: 'Updating',
        replicas: 1,
        updatedReplicas: 0,
        updatingReplicas: 1,
        failedReplicas: 0
      }
    }, [
      { SandboxName: 'sandbox-a', Phase: 'Upgrading', ConditionType: 'Upgrading', ConditionStatus: 'False', Reason: 'TimeoutExceeded' }
    ])

    expect(summary.Phase).toBe('Failed')
    expect(summary.Retryable).toBe(true)
    expect(summary.Progress).toEqual({
      Replicas: 1,
      UpdatedReplicas: 0,
      UpdatingReplicas: 0,
      FailedReplicas: 1
    })
  })
})

describe('canRepairSandboxUpdateOps', () => {
  it('allows repairing a stuck Updating ops when all active details have settled with failures', () => {
    expect(canRepairSandboxUpdateOps({
      status: {
        phase: 'Updating',
        replicas: 5,
        updatedReplicas: 2,
        updatingReplicas: 0,
        failedReplicas: 1
      }
    }, [
      { SandboxName: 'sandbox-a', Phase: 'Running', ConditionType: 'Upgrading', ConditionStatus: 'True', Reason: 'Succeeded' },
      { SandboxName: 'sandbox-b', Phase: 'Running', ConditionType: 'Upgrading', ConditionStatus: 'True', Reason: 'Succeeded' },
      { SandboxName: 'sandbox-c', Phase: 'Upgrading', ConditionType: 'Upgrading', ConditionStatus: 'False', Reason: 'UpgradePodFailed' }
    ])).toBe(true)
  })

  it('does not allow repairing a SandboxUpdateOps that still has an active Sandbox update', () => {
    expect(canRepairSandboxUpdateOps({
      status: {
        phase: 'Updating',
        replicas: 1,
        updatedReplicas: 0,
        updatingReplicas: 1,
        failedReplicas: 0
      }
    }, [
      { SandboxName: 'sandbox-a', Phase: 'Upgrading', ConditionType: 'Upgrading', ConditionStatus: 'False', Reason: 'UpgradePod' }
    ])).toBe(false)
  })
})
