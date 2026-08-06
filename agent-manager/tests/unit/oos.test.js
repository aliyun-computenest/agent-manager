import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  env: {},
  cluster: {
    clusterId: 'ca59876e747dd4f8aa28dc4ef0b197487',
    region: 'cn-hongkong'
  }
}))

vi.mock('../../server/config/index.js', () => ({
  env: state.env
}))

vi.mock('../../server/services/gateway-config.js', () => ({
  getClusterId: vi.fn(async () => state.cluster)
}))

describe('checkpoint backup OOS config discovery', () => {
  let service
  let originalProcessEnv

  const controlledEnvKeys = [
    'ALIBABA_CLOUD_ACCESS_KEY_ID',
    'ALIBABA_CLOUD_ACCESS_KEY_SECRET',
    'CHECKPOINT_BACKUP_OOS_REGION_ID',
    'CHECKPOINT_BACKUP_OOS_ENDPOINT',
    'CHECKPOINT_BACKUP_CLUSTER_ID',
    'CHECKPOINT_BACKUP_CLUSTER_REGION_ID',
    'OOS_REGION_ID',
    'OOS_ASSUME_ROLE',
    'CHECKPOINT_BACKUP_OOS_ASSUME_ROLE',
    'CHECKPOINT_BACKUP_OOS_ASSUME_ROLE_ARN',
    'CHECKPOINT_BACKUP_STS_ENDPOINT',
    'CHECKPOINT_BACKUP_OOS_TEMPLATE_NAME',
    'CHECKPOINT_BACKUP_OOS_TEMPLATE_VERSION',
    'ACS_CLUSTER_REGION_ID',
    'VITE_ACS_REGION_ID',
    'VITE_ACS_CLUSTER_ID',
    'ALIBABA_CLOUD_SECURITY_TOKEN'
  ]

  beforeEach(async () => {
    originalProcessEnv = Object.fromEntries(controlledEnvKeys.map(key => [key, process.env[key]]))
    for (const key of controlledEnvKeys) delete process.env[key]
    process.env.ALIBABA_CLOUD_ACCESS_KEY_ID = 'ak'
    process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET = 'sk'
    for (const key of Object.keys(state.env)) delete state.env[key]
    Object.assign(state.env, {
      ALIBABA_CLOUD_ACCESS_KEY_ID: 'ak',
      ALIBABA_CLOUD_ACCESS_KEY_SECRET: 'sk'
    })
    state.cluster = {
      clusterId: 'ca59876e747dd4f8aa28dc4ef0b197487',
      region: 'cn-hongkong'
    }
    vi.resetModules()
    service = await import('../../server/services/checkpoint-backups/oos.js')
  })

  afterEach(() => {
    for (const key of controlledEnvKeys) {
      if (originalProcessEnv[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = originalProcessEnv[key]
      }
    }
  })

  it('discovers cluster and region from the existing Kubernetes gateway config without checkpoint envs', async () => {
    const config = await service.resolveCheckpointBackupOosConfig()

    expect(config).toMatchObject({
      accessKeyId: 'ak',
      accessKeySecret: 'sk',
      clusterId: 'ca59876e747dd4f8aa28dc4ef0b197487',
      clusterRegionId: 'cn-hongkong',
      oosRegionId: 'cn-hongkong',
      oosAssumeRole: 'AgentManagerOOSServiceRole',
      oosAssumeRoleArn: '',
      oosTemplateName: 'ACS-CS-CreateAgentManagercheckpointBackup',
      oosTemplateVersion: '',
      endpoint: 'oos.cn-hongkong.aliyuncs.com',
      stsEndpoint: 'sts.cn-hongkong.aliyuncs.com'
    })
  })

  it('discovers the optional OOS assume role for TimerTrigger child executions', async () => {
    process.env.CHECKPOINT_BACKUP_OOS_ASSUME_ROLE = 'AliyunOOSExecutionRole'

    const config = await service.resolveCheckpointBackupOosConfig()

    expect(config.oosAssumeRole).toBe('AliyunOOSExecutionRole')
  })

  it('assumes the configured role before creating the OOS API client', async () => {
    process.env.ALIBABA_CLOUD_SECURITY_TOKEN = 'source-token'
    process.env.CHECKPOINT_BACKUP_OOS_ASSUME_ROLE_ARN = 'acs:ram::1234567890123456:role/agentmanageroosservicerole-test'
    const stsConfigs = []
    const assumeRoleRequests = []
    const oosConfigs = []

    const client = await service.createOosClient({
      stsClientFactory(config) {
        stsConfigs.push(config)
        return {
          async assumeRole(request) {
            assumeRoleRequests.push(request)
            return {
              body: {
                credentials: {
                  accessKeyId: 'sts-ak',
                  accessKeySecret: 'sts-sk',
                  securityToken: 'sts-token'
                }
              }
            }
          }
        }
      },
      openApiClientFactory(config) {
        oosConfigs.push(config)
        return {
          async callApi() {
            return { body: { ExecutionId: 'exec-assumed-role' } }
          }
        }
      }
    })

    await expect(client.startExecution({
      templateName: 'ACS-CS-CreateAgentManagercheckpointBackup',
      parameters: {}
    })).resolves.toMatchObject({ executionId: 'exec-assumed-role' })
    expect(stsConfigs[0]).toMatchObject({
      accessKeyId: 'ak',
      accessKeySecret: 'sk',
      securityToken: 'source-token',
      endpoint: 'sts.cn-hongkong.aliyuncs.com'
    })
    expect(assumeRoleRequests).toEqual([{
      roleArn: 'acs:ram::1234567890123456:role/agentmanageroosservicerole-test',
      roleSessionName: 'agent-manager-checkpoint-backup',
      durationSeconds: 900
    }])
    expect(typeof assumeRoleRequests[0].validate).toBe('function')
    expect(oosConfigs[0]).toMatchObject({
      accessKeyId: 'sts-ak',
      accessKeySecret: 'sts-sk',
      securityToken: 'sts-token',
      endpoint: 'oos.cn-hongkong.aliyuncs.com'
    })
  })

  it('discovers the single checkpoint backup public OOS template override', async () => {
    process.env.CHECKPOINT_BACKUP_OOS_TEMPLATE_NAME = 'AgentManagerCheckpointBackup'
    process.env.CHECKPOINT_BACKUP_OOS_TEMPLATE_VERSION = 'v2'

    const config = await service.resolveCheckpointBackupOosConfig()

    expect(config).toMatchObject({
      oosTemplateName: 'AgentManagerCheckpointBackup',
      oosTemplateVersion: 'v2'
    })
    expect(config).not.toHaveProperty('oosScheduledTemplateName')
    expect(config).not.toHaveProperty('oosScheduledTemplateVersion')
  })

  it('prefers explicit checkpoint cluster envs over Kubernetes host discovery', async () => {
    process.env.CHECKPOINT_BACKUP_CLUSTER_ID = 'c47d00ef8e08a449b8c7f547ae4ad09a6'
    process.env.CHECKPOINT_BACKUP_CLUSTER_REGION_ID = 'cn-hongkong'
    state.cluster = {
      clusterId: 'c2aa8f25b3d9443d28012b53cf7482920',
      region: 'cn-hongkong'
    }

    const config = await service.resolveCheckpointBackupOosConfig()

    expect(config).toMatchObject({
      clusterId: 'c47d00ef8e08a449b8c7f547ae4ad09a6',
      clusterRegionId: 'cn-hongkong',
      oosRegionId: 'cn-hongkong'
    })
  })

  it('lets explicit runtime overrides win over discovered values for local smoke tests', async () => {
    const config = await service.resolveCheckpointBackupOosConfig({
      clusterId: 'cluster-override',
      clusterRegionId: 'cn-hangzhou',
      oosRegionId: 'cn-hangzhou',
      endpoint: 'pre-oos.example.com'
    })

    expect(config).toMatchObject({
      clusterId: 'cluster-override',
      clusterRegionId: 'cn-hangzhou',
      oosRegionId: 'cn-hangzhou',
      endpoint: 'pre-oos.example.com'
    })
  })

  it('validates template content through the OOS API client', async () => {
    const calls = []
    const client = await service.createOosClient({
      client: {
        async callApi(params, request) {
          calls.push({ params, request })
          return {
            body: {
              RequestId: 'req-validate',
              Tasks: [{ Name: 'TaskA' }],
              Outputs: {}
            }
          }
        }
      }
    })

    const result = await client.validateTemplateContent({
      templateContent: 'FormatVersion: OOS-2019-06-01\nTasks: []'
    })

    expect(result.requestId).toBe('req-validate')
    expect(result.raw.Tasks).toEqual([{ Name: 'TaskA' }])
    expect(calls[0].params.action).toBe('ValidateTemplateContent')
    expect(calls[0].request.query).toMatchObject({
      RegionId: 'cn-hongkong'
    })
    expect(calls[0].request.body).toMatchObject({
      Content: 'FormatVersion: OOS-2019-06-01\nTasks: []'
    })
  })

  it('starts one-off executions with TemplateContent in the form body instead of the URL query', async () => {
    const calls = []
    const client = await service.createOosClient({
      client: {
        async callApi(params, request) {
          calls.push({ params, request })
          return {
            body: {
              ExecutionId: 'exec-by-template-content'
            }
          }
        }
      }
    })

    await expect(client.startExecution({
      templateContent: 'FormatVersion: OOS-2019-06-01\nTasks: []',
      parameters: { ClusterId: 'cluster-a', RegionId: 'cn-hongkong' },
      description: 'one-off backup'
    })).resolves.toMatchObject({
      executionId: 'exec-by-template-content'
    })

    expect(calls[0].request.query).toMatchObject({
      RegionId: 'cn-hongkong',
      SafetyCheck: 'Skip'
    })
    expect(calls[0].request.query).not.toHaveProperty('TemplateContent')
    expect(calls[0].request.body).toMatchObject({
      TemplateContent: 'FormatVersion: OOS-2019-06-01\nTasks: []',
      Parameters: JSON.stringify({ ClusterId: 'cluster-a', RegionId: 'cn-hongkong' }),
      Description: 'one-off backup'
    })
  })

  it('uses the latest named public template when no version is pinned', async () => {
    const calls = []
    const client = await service.createOosClient({
      client: {
        async callApi(params, request) {
          calls.push({ params, request })
          return { body: { ExecutionId: 'exec-latest-public-template' } }
        }
      }
    })

    await client.startExecution({
      templateName: 'ACS-CS-CreateAgentManagercheckpointBackup',
      parameters: { ClusterId: 'cluster-a' }
    })

    expect(calls[0].request.query).toMatchObject({
      TemplateName: 'ACS-CS-CreateAgentManagercheckpointBackup'
    })
    expect(calls[0].request.query).not.toHaveProperty('TemplateVersion')
  })

  it('sanitizes OOS SDK timeout messages before exposing them to API callers', () => {
    const message = service.getOosErrorMessage(new Error(
      'ConnectTimeout: Connect HTTPS://oos.cn-hongkong.aliyuncs.com/?RegionId=cn-hongkong&Content='
      + encodeURIComponent('FormatVersion: OOS-2019-06-01\n'.repeat(30))
    ))

    expect(message).toBe('OOS request timed out; check the Manager pod network path to the configured OOS endpoint')
    expect(message).not.toContain('FormatVersion')
    expect(message).not.toContain('Content=')
  })

  it('falls back to the default credential provider when env credentials are absent', async () => {
    delete process.env.ALIBABA_CLOUD_ACCESS_KEY_ID
    delete process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET
    for (const key of Object.keys(state.env)) delete state.env[key]
    const createdConfigs = []
    const credentialProvider = {
      getCredential: vi.fn(async () => ({
        accessKeyId: 'provider-ak',
        accessKeySecret: 'provider-sk',
        securityToken: 'provider-token'
      }))
    }
    const config = await service.resolveCheckpointBackupOosConfig()
    expect(config.accessKeyId).toBe('')
    expect(config.accessKeySecret).toBe('')

    await service.createOosClient({
      credentialProvider,
      openApiClientFactory(config) {
        createdConfigs.push(config)
        return {
          async callApi() {
            return { body: {} }
          }
        }
      }
    })

    expect(credentialProvider.getCredential).toHaveBeenCalledTimes(1)
    expect(createdConfigs[0]).toMatchObject({
      accessKeyId: 'provider-ak',
      accessKeySecret: 'provider-sk',
      securityToken: 'provider-token',
      endpoint: 'oos.cn-hongkong.aliyuncs.com'
    })
  })

  it('lists executions and task executions through the OOS API client', async () => {
    const calls = []
    const client = await service.createOosClient({
      client: {
        async callApi(params, request) {
          calls.push({ params, request })
          if (params.action === 'ListExecutions') {
            return { body: { Executions: [{ ExecutionId: 'exec-a', Status: 'Success' }] } }
          }
          return { body: { TaskExecutions: [{ TaskName: 'TaskA', Status: 'Success' }] } }
        }
      }
    })

    await expect(client.listExecutions({ executionId: 'exec-a', maxResults: 10 }))
      .resolves.toMatchObject({ executions: [{ ExecutionId: 'exec-a', Status: 'Success' }] })
    await expect(client.listTaskExecutions({ executionId: 'exec-a', maxResults: 20 }))
      .resolves.toMatchObject({ taskExecutions: [{ TaskName: 'TaskA', Status: 'Success' }] })

    expect(calls.map(call => call.params.action)).toEqual(['ListExecutions', 'ListTaskExecutions'])
    expect(calls[0].request.query).toMatchObject({
      RegionId: 'cn-hongkong',
      ExecutionId: 'exec-a',
      MaxResults: 10
    })
    expect(calls[1].request.query).toMatchObject({
      RegionId: 'cn-hongkong',
      ExecutionId: 'exec-a',
      MaxResults: 20
    })
  })
})
