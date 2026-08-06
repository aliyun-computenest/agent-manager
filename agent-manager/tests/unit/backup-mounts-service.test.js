import { describe, expect, it } from 'vitest'
import { buildBackupSubPath } from '../../server/services/backup-mounts.js'

describe('buildBackupSubPath', () => {
  it('rejects path traversal segments', () => {
    expect(() => buildBackupSubPath({
      agentTypeId: '..',
      userId: 'user-id',
      instanceId: 'instance-id'
    })).toThrow(/path traversal|subPath/i)
  })
})
