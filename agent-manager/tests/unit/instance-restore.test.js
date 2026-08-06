import { describe, expect, it } from 'vitest'
import {
  resolveCreateInstanceFromBackupOptions
} from '../../server/services/instance-restore.js'

function makeRestoreClient({ profile, instances = [] }) {
  return {
    from(table) {
      if (table === 'agent_instances') {
        return {
          select() { return this },
          not() { return this },
          order() { return this },
          limit() { return this },
          in() { return this },
          then(resolve, reject) {
            return Promise.resolve({ data: instances, error: null }).then(resolve, reject)
          }
        }
      }
      expect(table).toBe('principal_profiles')
      return {
        select() { return this },
        eq() { return this },
        async maybeSingle() {
          return { data: profile, error: null }
        }
      }
    }
  }
}

describe('instance restore helpers', () => {
  it('keeps restored personal instances owned by the source principal and source namespace', async () => {
    const sourceInstance = {
      id: 'source-instance-1',
      principal_id: 'source-user-1',
      sandbox_id: 'tenant-a--sandbox-a',
      agent_type_id: 'agent-type-a',
      model_id: 'model-a',
      config_json: { fromSource: true }
    }

    const result = await resolveCreateInstanceFromBackupOptions({
      actorPrincipalId: 'admin-user-1',
      actorProfile: { principal_type: 'user', role: 'admin', status: 'active' },
      backupId: 'ocb-source',
      hasConfigJson: false,
      supabaseClient: makeRestoreClient({
        profile: { id: 'source-user-1', principal_type: 'user' },
        instances: [sourceInstance]
      }),
      async loadMemberships() {
        return []
      },
      async listBackups(instance) {
        expect(instance.id).toBe(sourceInstance.id)
        return [{ backupId: 'ocb-source' }]
      }
    })

    expect(result).toMatchObject({
      effectiveUserId: 'source-user-1',
      effectiveGroupId: null,
      effectiveAgentTypeId: 'agent-type-a',
      effectiveModelId: 'model-a',
      effectiveConfigJson: { fromSource: true },
      restoreFromBackup: {
        backupId: 'ocb-source',
        sourceInstance,
        namespace: 'tenant-a'
      }
    })
  })

  it('keeps restored group instances in the source group namespace and quota principal', async () => {
    const groupId = '44444444-4444-4444-8444-444444444444'
    const memberId = '55555555-5555-4555-8555-555555555555'
    const sourceInstance = {
      id: 'source-instance-2',
      principal_id: groupId,
      sandbox_id: 'team-ns--sandbox-b',
      agent_type_id: 'agent-type-b',
      model_id: 'model-b',
      config_json: { fromSource: true }
    }

    const result = await resolveCreateInstanceFromBackupOptions({
      actorPrincipalId: memberId,
      actorProfile: { principal_type: 'user', role: 'user', status: 'active' },
      backupId: 'ocb-group',
      requestedAgentTypeId: 'override-agent-type',
      requestedModelId: 'override-model',
      hasConfigJson: true,
      configJson: { explicit: true },
      supabaseClient: makeRestoreClient({
        profile: { id: groupId, principal_type: 'group' },
        instances: [sourceInstance]
      }),
      async loadMemberships() {
        return [{ group_id: groupId, principal_id: memberId, status: 'active' }]
      },
      async listBackups(instance) {
        expect(instance.id).toBe(sourceInstance.id)
        return [{ backupId: 'ocb-group' }]
      }
    })

    expect(result).toMatchObject({
      effectiveUserId: memberId,
      effectiveGroupId: groupId,
      effectiveAgentTypeId: 'override-agent-type',
      effectiveModelId: 'override-model',
      effectiveConfigJson: { explicit: true },
      restoreFromBackup: {
        backupId: 'ocb-group',
        sourceInstance,
        namespace: 'team-ns'
      }
    })
  })

  it('checks restore source candidates concurrently instead of serial K8s scans', async () => {
    const instances = Array.from({ length: 4 }, (_, index) => ({
      id: `source-instance-${index}`,
      principal_id: 'source-user-1',
      sandbox_id: `tenant-a--sandbox-${index}`,
      agent_type_id: 'agent-type-a',
      model_id: 'model-a',
      config_json: { index }
    }))
    let active = 0
    let maxActive = 0

    const result = await resolveCreateInstanceFromBackupOptions({
      actorPrincipalId: 'admin-user-1',
      actorProfile: { principal_type: 'user', role: 'admin', status: 'active' },
      backupId: 'manual-backup-no-prefix',
      hasConfigJson: false,
      supabaseClient: makeRestoreClient({
        profile: { id: 'source-user-1', principal_type: 'user' },
        instances
      }),
      async loadMemberships() {
        return []
      },
      async listBackups(instance) {
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise(resolve => setTimeout(resolve, 10))
        active -= 1
        return instance.id === 'source-instance-2'
          ? [{ backupId: 'manual-backup-no-prefix' }]
          : []
      }
    })

    expect(result.restoreFromBackup.sourceInstance.id).toBe('source-instance-2')
    expect(maxActive).toBeGreaterThan(1)
  })
})
