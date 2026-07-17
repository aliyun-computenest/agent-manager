import { describe, expect, it } from 'vitest'
import * as service from '../../server/services/checkpoint-backups/index.js'
import {
  makeApi,
  makeInstance,
  makeReadySnapshot
} from './helpers/checkpoint-backup-fixtures.js'

describe('checkpoint backup service: admin execution flow', () => {
  it('starts one immediate OOS execution for multiple selected instances', async () => {
    const calls = []
    const oosClient = {
      async startExecution(payload) {
        calls.push({ action: 'startExecution', ...payload })
        return { executionId: 'exec-admin-multi' }
      }
    }
    const instances = [
      makeInstance(),
      makeInstance({
        id: '33333333-3333-4333-8333-333333333333',
        principal_id: '44444444-4444-4444-8444-444444444444',
        sandbox_id: 'default--sandbox-b'
      })
    ]

    const result = await service.startCheckpointBackupExecution(instances, {
      api: makeApi(),
      namespace: 'default',
      now: new Date('2026-06-18T04:00:00Z'),
      runMode: 'immediate',
      scope: 'instances:11111111-1111-4111-8111-111111111111,33333333-3333-4333-8333-333333333333',
      retentionCount: 3,
      oosClient,
      clusterId: 'cluster-a',
      clusterRegionId: 'cn-hongkong'
    })

    expect(result).toMatchObject({
      status: 'Submitted',
      oosExecutionId: 'exec-admin-multi',
      runMode: 'immediate',
      targetCount: 2,
      skippedCount: 0
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].action).toBe('startExecution')
    expect(calls[0].parameters).toMatchObject({
      ClusterId: 'cluster-a',
      RegionId: 'cn-hongkong',
      Namespace: 'default',
      RunMode: 'immediate',
      RateControl: {
        Mode: 'Concurrency',
        MaxErrors: '100%',
        Concurrency: 5
      },
      Targets: [
        {
          namespace: 'default',
          instanceId: '11111111-1111-4111-8111-111111111111',
          sandboxName: 'sandbox-a'
        },
        {
          namespace: 'default',
          instanceId: '33333333-3333-4333-8333-333333333333',
          sandboxName: 'sandbox-b'
        }
      ]
    })
    expect(calls[0].templateName).toBe('ACS-CS-CreateAgentManagercheckpointBackup')
    expect(calls[0]).not.toHaveProperty('templateVersion')
    expect(calls[0]).not.toHaveProperty('templateContent')
    expect(calls[0].parameters).not.toHaveProperty('BackupIdSuffix')
    expect(calls[0].parameters.Targets[0].backupId).toMatch(/^ocb-11111111-/)
    expect(calls[0].parameters.Targets[1].backupId).toMatch(/^ocb-33333333-/)
    expect(calls[0].parameters.Targets[0].backupIdPrefix).toMatch(/^ocb-11111111-/)
    expect(calls[0].parameters.Targets[1].backupIdPrefix).toMatch(/^ocb-33333333-/)
  })

  it('reads selected Sandbox targets concurrently for admin executions', async () => {
    const api = makeApi()
    let active = 0
    let maxActive = 0
    api.getSandbox = async (namespace, name) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, 10))
      active -= 1
      return {
        metadata: {
          name,
          labels: {},
          annotations: {}
        },
        spec: makeReadySnapshot().spec
      }
    }

    await service.startCheckpointBackupExecution([
      makeInstance({ id: '11111111-1111-4111-8111-111111111111', sandbox_id: 'default--sandbox-a' }),
      makeInstance({ id: '33333333-3333-4333-8333-333333333333', sandbox_id: 'default--sandbox-b' }),
      makeInstance({ id: '55555555-5555-4555-8555-555555555555', sandbox_id: 'default--sandbox-c' })
    ], {
      api,
      namespace: 'default',
      runMode: 'immediate',
      scope: 'instances:11111111-1111-4111-8111-111111111111,33333333-3333-4333-8333-333333333333,55555555-5555-4555-8555-555555555555',
      oosClient: {
        async startExecution() {
          return { executionId: 'exec-concurrent-targets' }
        }
      },
      clusterId: 'cluster-a',
      clusterRegionId: 'cn-hongkong'
    })

    expect(maxActive).toBeGreaterThan(1)
  })

  it('submits Scope=all without freezing Manager-resolved targets', async () => {
    const calls = []
    const result = await service.startCheckpointBackupExecution([], {
      namespace: 'default',
      runMode: 'immediate',
      scope: 'all',
      oosClient: {
        async startExecution(payload) {
          calls.push(payload)
          return { executionId: 'exec-dynamic-all' }
        }
      },
      clusterId: 'cluster-a',
      clusterRegionId: 'cn-hongkong'
    })

    expect(result).toMatchObject({
      oosExecutionId: 'exec-dynamic-all',
      targetCount: 0,
      skippedCount: 0
    })
    expect(calls[0]).toMatchObject({
      templateName: 'ACS-CS-CreateAgentManagercheckpointBackup',
      parameters: {
        Scope: 'all',
        Targets: []
      }
    })
  })

  it('passes each explicit target namespace to one OOS execution', async () => {
    const calls = []
    const result = await service.startCheckpointBackupExecution([
      makeInstance({
        id: '11111111-1111-4111-8111-111111111111',
        sandbox_id: 'tenant-a--sandbox-a'
      }),
      makeInstance({
        id: '33333333-3333-4333-8333-333333333333',
        sandbox_id: 'tenant-b--sandbox-b'
      })
    ], {
      api: makeApi(),
      namespace: 'default',
      runMode: 'immediate',
      scope: 'instances:11111111-1111-4111-8111-111111111111,33333333-3333-4333-8333-333333333333',
      oosClient: {
        async startExecution(payload) {
          calls.push(payload)
          return { executionId: 'exec-mixed-namespaces' }
        }
      },
      clusterId: 'cluster-a',
      clusterRegionId: 'cn-hongkong'
    })

    expect(result).toMatchObject({
      targetCount: 2,
      skippedCount: 0,
      oosExecutionId: 'exec-mixed-namespaces'
    })
    expect(calls[0].parameters.Targets).toMatchObject([
      { namespace: 'tenant-a', sandboxName: 'sandbox-a' },
      { namespace: 'tenant-b', sandboxName: 'sandbox-b' }
    ])
  })

  it('skips a busy explicit target without rejecting another namespace', async () => {
    const api = makeApi()
    const calls = []
    api.getSandbox = async (namespace, name) => ({
      metadata: {
        name,
        labels: {},
        annotations: namespace === 'tenant-b'
          ? { 'agent-manager.io/backup-lock-id': 'active-backup' }
          : {}
      },
      spec: makeReadySnapshot().spec
    })

    const result = await service.startCheckpointBackupExecution([
      makeInstance({
        id: '11111111-1111-4111-8111-111111111111',
        sandbox_id: 'tenant-a--sandbox-a'
      }),
      makeInstance({
        id: '33333333-3333-4333-8333-333333333333',
        sandbox_id: 'tenant-b--sandbox-b'
      })
    ], {
      api,
      namespace: 'default',
      runMode: 'immediate',
      scope: 'instances:11111111-1111-4111-8111-111111111111,33333333-3333-4333-8333-333333333333',
      oosClient: {
        async startExecution(payload) {
          calls.push(payload)
          return { executionId: 'exec-mixed-with-busy' }
        }
      },
      clusterId: 'cluster-a',
      clusterRegionId: 'cn-hongkong'
    })

    expect(result).toMatchObject({
      targetCount: 1,
      skippedCount: 1,
      skipped: [{
        instanceId: '33333333-3333-4333-8333-333333333333',
        reason: 'BUSY'
      }]
    })
    expect(calls[0].parameters.Targets).toMatchObject([
      { namespace: 'tenant-a', sandboxName: 'sandbox-a' }
    ])
  })

  it('starts a scheduled OOS execution through a runtime timer wrapper', async () => {
    const calls = []
    const oosClient = {
      async startExecution(payload) {
        calls.push({ action: 'startExecution', ...payload })
        return { executionId: 'exec-admin-scheduled' }
      }
    }

    const api = makeApi()
    api.getSandbox = async () => {
      throw new Error('dynamic all must not resolve fixed Sandbox targets in Manager')
    }
    const result = await service.startCheckpointBackupExecution([makeInstance()], {
      api,
      namespace: 'default',
      runMode: 'scheduled',
      scope: 'all',
      scheduleExpression: 'cron(0 0 3 * * ? *)',
      retentionCount: 5,
      oosClient,
      clusterId: 'cluster-a',
      clusterRegionId: 'cn-hongkong',
      oosAssumeRole: 'AliyunOOSExecutionRole'
    })

    expect(result).toMatchObject({
      status: 'Submitted',
      oosExecutionId: 'exec-admin-scheduled',
      runMode: 'scheduled',
      targetCount: 0
    })
    expect(result.backupIds).toEqual([])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      action: 'startExecution',
      parameters: {
        timerTrigger: {
          type: 'cron',
          expression: '0 0 3 * * ?',
          timeZone: 'Asia/Shanghai',
          endDate: '2099-12-31T23:59:59Z'
        },
        templateName: 'ACS-CS-CreateAgentManagercheckpointBackup',
        OOSAssumeRole: 'AliyunOOSExecutionRole'
      },
      safetyCheck: 'Skip'
    })
    expect(calls[0]).not.toHaveProperty('templateName')
    expect(calls[0]).not.toHaveProperty('templateVersion')
    expect(calls[0].templateContent).toContain("Action: 'ACS::TimerTrigger'")
    expect(calls[0].templateContent).toContain("Action: 'ACS::Template'")
    expect(calls[0].templateContent).not.toContain('TemplateVersion:')
    expect(calls[0].parameters.templateParameters).toMatchObject({
      ClusterId: 'cluster-a',
      RegionId: 'cn-hongkong',
      Namespace: 'default',
      RunMode: 'scheduled',
      Scope: 'all',
      RetentionCount: 5,
      OOSAssumeRole: 'AliyunOOSExecutionRole',
      RateControl: {
        Mode: 'Concurrency',
        MaxErrors: '100%',
        Concurrency: 5
      },
      Targets: []
    })
    expect(calls[0].parameters.templateParameters).not.toHaveProperty('BackupIdSuffix')
    expect(calls[0].parameters.templateParameters).not.toHaveProperty('ScheduleExpression')
  })

  it('uses the configured public template inside anonymous scheduled wrapper executions', async () => {
    const calls = []
    const oosClient = {
      async startExecution(payload) {
        calls.push(payload)
        return { executionId: 'exec-admin-scheduled-template' }
      }
    }

    await service.startCheckpointBackupExecution([makeInstance()], {
      api: makeApi(),
      namespace: 'default',
      runMode: 'scheduled',
      scope: 'all',
      scheduleExpression: 'cron(0 0 3 * * ? *)',
      oosClient,
      clusterId: 'cluster-a',
      clusterRegionId: 'cn-hongkong',
      oosTemplateName: 'AgentManagerCheckpointBackup',
      oosTemplateVersion: 'v2'
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      parameters: {
        templateName: 'AgentManagerCheckpointBackup'
      }
    })
    expect(calls[0].parameters).not.toHaveProperty('templateVersion')
    expect(calls[0]).not.toHaveProperty('templateName')
    expect(calls[0]).not.toHaveProperty('templateVersion')
    expect(calls[0].templateContent).not.toContain('AgentManagerCheckpointBackup')
    expect(calls[0].templateContent).not.toContain('templateVersion')
    expect(calls[0].parameters.templateParameters).toMatchObject({
      RunMode: 'scheduled'
    })
  })

  it('does not create a persistent custom template when wrapper execution fails', async () => {
    const calls = []
    const oosClient = {
      async startExecution(payload) {
        calls.push({ action: 'startExecution', ...payload })
        throw new Error('StartExecution failed')
      }
    }

    await expect(service.startCheckpointBackupExecution([makeInstance()], {
      api: makeApi(),
      namespace: 'default',
      runMode: 'scheduled',
      scope: 'all',
      scheduleExpression: 'cron(0 0 3 * * ? *)',
      oosClient,
      clusterId: 'cluster-a',
      clusterRegionId: 'cn-hongkong'
    })).rejects.toMatchObject({
      code: 'OOS_UNAVAILABLE',
      status: 502
    })

    expect(calls.map(call => call.action)).toEqual(['startExecution'])
    expect(calls[0]).not.toHaveProperty('templateName')
    expect(calls[0].templateContent).toContain("Action: 'ACS::Template'")
    expect(calls[0].parameters.templateName).toBe('ACS-CS-CreateAgentManagercheckpointBackup')
  })

  it('cancels an OOS backup execution by executionId', async () => {
    const calls = []
    const result = await service.cancelCheckpointBackupExecution('exec-scheduled-001', {
      oosClient: {
        async cancelExecution(payload) {
          calls.push(payload)
          return { executionId: payload.executionId }
        }
      }
    })

    expect(result).toEqual({
      status: 'Cancelled',
      executionId: 'exec-scheduled-001'
    })
    expect(calls).toEqual([{ executionId: 'exec-scheduled-001' }])
  })

  it('lists admin backup executions with only the page fields', async () => {
    const result = await service.listCheckpointBackupExecutions({
      limit: 10,
      oosClient: {
        config: { oosRegionId: 'cn-hongkong' },
        async listExecutions() {
          return {
            executions: [
              {
                ExecutionId: 'exec-scheduled-001',
                Status: 'Running',
                NextScheduleTime: '2026-06-24T03:00:00Z',
                StartDate: '2026-06-23T03:00:00Z',
                TemplateContent: [
                  'Description: Agent Manager checkpoint backup via ACS::Kubectl scheduled wrapper',
                  "Action: 'ACS::TimerTrigger'",
                  "Action: 'ACS::Template'"
                ].join('\n'),
                Parameters: JSON.stringify({
                  timerTrigger: {
                    type: 'cron',
                    expression: '0 0 3 * * ?',
                    timeZone: 'Asia/Shanghai',
                    endDate: '2099-12-31T23:59:59Z'
                  },
                  templateName: 'ACS-CS-CreateAgentManagercheckpointBackup',
                  templateVersion: 'v1',
                  templateParameters: {
                    RunMode: 'scheduled',
                    Scope: 'all',
                    RetentionCount: 5,
                    Targets: [{
                      instanceId: 'inst-a',
                      sandboxName: 'sandbox-a',
                      backupIdPrefix: 'ocb-inst-a-'
                    }]
                  }
                }),
                Outputs: {
                  Message: '16 成功 / 1 跳过 / 0 失败'
                }
              },
              {
                ExecutionId: 'exec-user-manual',
                Status: 'Success',
                TemplateContent: 'Description: user created one-off backup'
              },
              {
                ExecutionId: 'exec-other-template',
                Status: 'Running',
                TemplateName: 'ACS-CN-OtherAutomation',
                Parameters: JSON.stringify({
                  RunMode: 'scheduled',
                  Scope: 'all',
                  RetentionCount: 5
                })
              },
              {
                ExecutionId: 'exec-cancelled-001',
                Status: 'Cancelled',
                StartDate: '2026-06-25T03:00:00Z',
                Description: 'Agent Manager checkpoint backup via ACS::Kubectl; runMode=scheduled; scope=all; retentionCount=5; cronExpression=cron(0 0 3 * * ? *)',
                Outputs: {
                  Message: '用户取消'
                }
              }
            ],
            nextToken: null
          }
        }
      }
    })

    expect(result).toEqual({
      items: [
        {
          executionId: 'exec-scheduled-001',
          oosRegionId: 'cn-hongkong',
          runMode: 'scheduled',
          scope: 'all',
          cronExpression: 'cron(0 0 3 * * ? *)',
          retentionCount: 5,
          status: 'Running',
          nextRunAt: '2026-06-24T03:00:00Z',
          startedAt: '2026-06-23T03:00:00Z',
          message: '16 成功 / 1 跳过 / 0 失败'
        },
        {
          executionId: 'exec-cancelled-001',
          oosRegionId: 'cn-hongkong',
          runMode: 'scheduled',
          scope: 'all',
          cronExpression: 'cron(0 0 3 * * ? *)',
          retentionCount: 5,
          status: 'Cancelled',
          nextRunAt: null,
          startedAt: '2026-06-25T03:00:00Z',
          message: '用户取消'
        }
      ],
      nextToken: null
    })
    expect(result.items[0]).not.toHaveProperty('templateStatus')
    expect(result.items[0]).not.toHaveProperty('latestRecordSummary')
  })

  it('uses the OOS minimum page size for execution list calls', async () => {
    const calls = []
    await service.listCheckpointBackupExecutions({
      limit: 5,
      oosClient: {
        async listExecutions(payload) {
          calls.push(payload)
          return { executions: [], nextToken: null }
        }
      }
    })

    expect(calls).toEqual([{ maxResults: 10, nextToken: '' }])
  })

  it('lists template-name scheduled executions from OOS description metadata', async () => {
    const result = await service.listCheckpointBackupExecutions({
      limit: 10,
      oosClient: {
        config: { oosRegionId: 'cn-hongkong' },
        async listExecutions() {
          return {
            executions: [{
              ExecutionId: 'exec-template-name-scheduled',
              Status: 'Running',
              StartDate: '2026-07-06T04:30:00Z',
              TemplateName: 'ACS-CS-CreateAgentManagercheckpointBackup',
              Description: 'Agent Manager checkpoint backup via ACS::Kubectl; runMode=scheduled; scope=instances:inst-a; retentionCount=5; cronExpression=cron(0 59 23 * * ? *)'
            }],
            nextToken: null
          }
        }
      }
    })

    expect(result).toEqual({
      items: [{
        executionId: 'exec-template-name-scheduled',
        oosRegionId: 'cn-hongkong',
        runMode: 'scheduled',
        scope: 'instances:inst-a',
        cronExpression: 'cron(0 59 23 * * ? *)',
        retentionCount: 5,
        status: 'Running',
        nextRunAt: null,
        startedAt: '2026-07-06T04:30:00Z',
        message: null
      }],
      nextToken: null
    })
  })

  it('reports tolerated target failures as partial failures', async () => {
    const result = await service.listCheckpointBackupExecutions({
      limit: 10,
      oosClient: {
        async listExecutions() {
          return {
            executions: [{
              ExecutionId: 'exec-partial-backup',
              Status: 'Success',
              TemplateName: 'ACS-CS-CreateAgentManagercheckpointBackup',
              Parameters: {
                RunMode: 'immediate',
                Scope: 'instances:inst-a,inst-b',
                RetentionCount: 5
              },
              Outputs: {
                CheckpointIds: [null, 'cp-success']
              },
              StatusMessage: 'BackupTargets execution failed, Failed to get one Sandbox'
            }],
            nextToken: null
          }
        }
      }
    })

    expect(result.items).toMatchObject([{
      executionId: 'exec-partial-backup',
      status: 'PartialFailed',
      message: 'BackupTargets execution failed, Failed to get one Sandbox'
    }])
  })

  it('reports an execution as failed when all tolerated targets miss checkpoints', async () => {
    const result = await service.getCheckpointBackupExecution('exec-all-failed', {
      oosClient: {
        async listExecutions() {
          return {
            executions: [{
              ExecutionId: 'exec-all-failed',
              Status: 'Success',
              TemplateName: 'ACS-CS-CreateAgentManagercheckpointBackup',
              Outputs: JSON.stringify({ CheckpointIds: [null, null] })
            }]
          }
        }
      }
    })

    expect(result).toMatchObject({
      status: 'Failed',
      message: 'OOS execution completed without any successful Checkpoint'
    })
  })

  it('reports a completed dynamic backup as failed when checkpoint output is missing', async () => {
    const result = await service.getCheckpointBackupExecution('exec-missing-checkpoint-output', {
      oosClient: {
        async listExecutions() {
          return {
            executions: [{
              ExecutionId: 'exec-missing-checkpoint-output',
              Status: 'Success',
              TemplateName: 'ACS-CS-CreateAgentManagercheckpointBackup',
              Parameters: {
                RunMode: 'immediate',
                Scope: 'all',
                Targets: []
              },
              Outputs: {}
            }]
          }
        }
      }
    })

    expect(result).toMatchObject({
      status: 'Failed',
      message: 'OOS execution completed without any successful Checkpoint'
    })
  })

  it('reports an explicit execution as failed when validation drops every target', async () => {
    const result = await service.getCheckpointBackupExecution('exec-no-valid-targets', {
      oosClient: {
        async listExecutions() {
          return {
            executions: [{
              ExecutionId: 'exec-no-valid-targets',
              Status: 'Success',
              TemplateName: 'ACS-CS-CreateAgentManagercheckpointBackup',
              Parameters: {
                Scope: 'instances:inst-a',
                Targets: [{
                  instanceId: 'inst-a',
                  sandboxName: 'sandbox-a',
                  backupIdPrefix: 'ocb-inst-a-'
                }]
              },
              Outputs: { CheckpointIds: [] }
            }]
          }
        }
      }
    })

    expect(result.status).toBe('Failed')
  })

  it('does not require checkpoint outputs from a successful scheduled wrapper', async () => {
    const result = await service.getCheckpointBackupExecution('exec-scheduled-wrapper-child', {
      oosClient: {
        async listExecutions() {
          return {
            executions: [{
              ExecutionId: 'exec-scheduled-wrapper-child',
              Status: 'Success',
              TemplateName: 'ACS::scheduled-wrapper-hash',
              Parameters: {
                timerTrigger: {
                  type: 'cron',
                  expression: '0 0/30 * * * ?',
                  timeZone: 'Asia/Shanghai'
                },
                templateName: 'ACS-CS-CreateAgentManagercheckpointBackup',
                templateVersion: 'v1',
                templateParameters: {
                  RunMode: 'scheduled',
                  Scope: 'instances:inst-a',
                  Targets: [{
                    instanceId: 'inst-a',
                    sandboxName: 'sandbox-a',
                    backupIdPrefix: 'ocb-inst-a-'
                  }]
                }
              },
              Outputs: {}
            }]
          }
        }
      }
    })

    expect(result).toMatchObject({
      runMode: 'scheduled',
      scope: 'instances:inst-a',
      status: 'Success'
    })
  })

  it('gets one admin backup execution by executionId', async () => {
    const calls = []
    const result = await service.getCheckpointBackupExecution('exec-template-name-scheduled', {
      oosClient: {
        config: { oosRegionId: 'cn-hongkong' },
        async listExecutions(payload) {
          calls.push(payload)
          return {
            executions: [{
              ExecutionId: 'exec-template-name-scheduled',
              Status: 'Running',
              StartDate: '2026-07-06T04:30:00Z',
              TemplateName: 'ACS-CS-CreateAgentManagercheckpointBackup',
              Description: 'Agent Manager checkpoint backup via ACS::Kubectl; runMode=scheduled; scope=instances:inst-a; retentionCount=5; cronExpression=cron(0 59 23 * * ? *)'
            }],
            nextToken: null
          }
        }
      }
    })

    expect(calls).toEqual([{ executionId: 'exec-template-name-scheduled', maxResults: 10, nextToken: '' }])
    expect(result).toMatchObject({
      executionId: 'exec-template-name-scheduled',
      oosRegionId: 'cn-hongkong',
      runMode: 'scheduled',
      scope: 'instances:inst-a',
      status: 'Running'
    })
  })

  it('lists simplified execution records for the selected admin execution', async () => {
    const result = await service.listCheckpointBackupExecutionRecords('exec-scheduled-001', {
      limit: 20,
      oosClient: {
        async listTaskExecutions() {
          return {
            taskExecutions: [
              {
                TaskExecutionId: 'task-1',
                TaskName: 'ApplyCheckpoint001',
                Status: 'Success',
                StartDate: '2026-06-23T03:00:00Z',
                Outputs: {
                  Message: '16 成功 / 1 跳过 / 0 失败，清理 5 个旧备份'
                }
              },
              {
                TaskExecutionId: 'task-2',
                TaskName: 'GetCheckpoint001',
                Status: 'Success',
                StartDate: '2026-06-23T03:01:00Z',
                Outputs: [
                  { Name: 'Phase', Value: 'Ready' },
                  { Name: 'CheckpointId', Value: 'checkpoint-abc' }
                ]
              },
              {
                TaskExecutionId: 'task-3',
                TaskName: 'TimerTrigger',
                Status: 'Success',
                StartDate: '2026-06-23T03:00:00Z'
              },
              {
                TaskExecutionId: 'task-4',
                TaskName: 'ListNamespaces',
                Status: 'Skipped',
                StartDate: '2026-06-23T03:00:00Z'
              }
            ],
            nextToken: 'next-records'
          }
        }
      }
    })

    expect(result).toEqual({
      items: [
        {
          status: 'Success',
          startedAt: '2026-06-23T03:00:00Z',
          message: '16 成功 / 1 跳过 / 0 失败，清理 5 个旧备份'
        },
        {
          status: 'Success',
          startedAt: '2026-06-23T03:01:00Z',
          message: '确认备份点状态成功，状态 Ready，Checkpoint checkpoint-abc（GetCheckpoint001）'
        }
      ],
      nextToken: 'next-records'
    })
    expect(result.items[0]).not.toHaveProperty('recordId')
    expect(result.items[0]).not.toHaveProperty('backupId')
  })

  it('uses the OOS minimum page size for execution record calls', async () => {
    const calls = []
    await service.listCheckpointBackupExecutionRecords('exec-scheduled-001', {
      limit: 5,
      oosClient: {
        async listTaskExecutions(payload) {
          calls.push(payload)
          return { taskExecutions: [], nextToken: null }
        }
      }
    })

    expect(calls).toEqual([{ executionId: 'exec-scheduled-001', maxResults: 10, nextToken: '' }])
  })
})
