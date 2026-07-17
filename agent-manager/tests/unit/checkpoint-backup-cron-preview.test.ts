import { describe, expect, it } from 'vitest'
import {
  findNearbyScheduledCronConflict,
  getCronSchedulePreview
} from '../../src/components/CheckpointBackupExecutions'

describe('checkpoint backup cron preview', () => {
  it('previews upcoming daily executions', () => {
    const preview = getCronSchedulePreview(
      'cron(0 0 14 * * ? *)',
      new Date('2026-07-06T13:20:00+08:00'),
      3,
    )

    expect(preview.message).toBeNull()
    expect(preview.items).toHaveLength(3)
    expect(preview.items[0]).toContain('14:00:00')
  })

  it('returns a guidance message for unsupported complex expressions', () => {
    const preview = getCronSchedulePreview(
      'cron(0 15 10 L * ? *)',
      new Date('2026-07-06T13:20:00+08:00'),
    )

    expect(preview.items).toEqual([])
    expect(preview.message).toContain('OOS 文档')
  })

  it('detects an existing all-scope scheduled execution with a nearby cron', () => {
    const conflict = findNearbyScheduledCronConflict([
      {
        executionId: 'exec-scheduled-001',
        runMode: 'scheduled',
        scope: 'all',
        cronExpression: 'cron(0 0 14 * * ? *)',
        status: 'Running'
      }
    ], {
      cronExpression: 'cron(0 8 14 * * ? *)',
      scope: 'all',
      baseDate: new Date('2026-07-06T13:20:00+08:00')
    })

    expect(conflict?.execution.executionId).toBe('exec-scheduled-001')
    expect(conflict?.deltaMinutes).toBe(8)
  })

  it('ignores nearby cron executions when selected instance scopes do not overlap', () => {
    const conflict = findNearbyScheduledCronConflict([
      {
        executionId: 'exec-scheduled-001',
        runMode: 'scheduled',
        scope: 'instances:inst-a',
        cronExpression: 'cron(0 0 14 * * ? *)',
        status: 'Running'
      }
    ], {
      cronExpression: 'cron(0 5 14 * * ? *)',
      scope: 'instances:inst-b',
      baseDate: new Date('2026-07-06T13:20:00+08:00')
    })

    expect(conflict).toBeNull()
  })

  it('allows scheduled executions outside the nearby cron window', () => {
    const conflict = findNearbyScheduledCronConflict([
      {
        executionId: 'exec-scheduled-001',
        runMode: 'scheduled',
        scope: 'all',
        cronExpression: 'cron(0 0 14 * * ? *)',
        status: 'Running'
      }
    ], {
      cronExpression: 'cron(0 20 14 * * ? *)',
      scope: 'all',
      baseDate: new Date('2026-07-06T13:20:00+08:00')
    })

    expect(conflict).toBeNull()
  })
})
