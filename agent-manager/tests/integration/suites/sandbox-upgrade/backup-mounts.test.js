import { describe, expect, it } from 'vitest'
import {
  buildBackupVolumeConfig,
} from '../../../../server/services/backup-mounts.js'

describe('backup mount config', () => {
  it('builds E2B CSI volume config for the per-instance backup path', () => {
    const config = buildBackupVolumeConfig({
      pvName: 'oss-pv-openclaw-shared',
      mountPath: '/backup',
      agentTypeId: 'agent-type-1',
      userId: 'user-1',
      instanceId: 'instance-1',
    })

    expect(config).toEqual([
      {
        pvName: 'oss-pv-openclaw-shared',
        mountPath: '/backup',
        subPath: '/backup/agent-type-1/user-1/instance-1',
        readOnly: false,
      },
    ])
  })

  it('uses shared OSS defaults when optional mount settings are blank', () => {
    const config = buildBackupVolumeConfig({
      pvName: ' ',
      mountPath: ' ',
      agentTypeId: 'agent-type-1',
      userId: 'user-1',
      instanceId: 'instance-1',
    })

    expect(config[0]).toMatchObject({
      pvName: 'oss-pv-openclaw-shared',
      mountPath: '/backup',
      subPath: '/backup/agent-type-1/user-1/instance-1',
    })
  })
})
