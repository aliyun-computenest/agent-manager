import _OpenApi, * as $OpenApi from '@alicloud/openapi-client'
const OpenApiClient = _OpenApi.default || _OpenApi
import _Credential from '@alicloud/credentials'
const CredentialClient = _Credential.default || _Credential
import _Sts20150401, * as $Sts20150401 from '@alicloud/sts20150401'
const Sts20150401 = _Sts20150401.default || _Sts20150401
import * as $Util from '@alicloud/tea-util'
import { env } from '../../config/index.js'
import { getClusterId } from '../gateway-config.js'
import { DEFAULT_OOS_ASSUME_ROLE } from './constants.js'

export const DEFAULT_CHECKPOINT_BACKUP_OOS_TEMPLATE_NAME = 'ACS-CS-CreateAgentManagercheckpointBackup'
export const DEFAULT_CHECKPOINT_BACKUP_OOS_TEMPLATE_VERSION = ''
const OOS_ROLE_SESSION_NAME = 'agent-manager-checkpoint-backup'
const OOS_ROLE_SESSION_DURATION_SECONDS = 900

function readConfig(name, fallback = '') {
  return process.env[name] || env[name] || fallback
}

function requireConfig(value, name) {
  if (!value) throw new Error(`${name} is required`)
  return value
}

function getBody(response) {
  return response?.body || response || {}
}

function parseExecutionId(body) {
  return body.ExecutionId
    || body.executionId
    || body.Execution?.ExecutionId
    || body.execution?.executionId
    || null
}

function createOosApiParams(action) {
  return new $OpenApi.Params({
    action,
    version: '2019-06-01',
    protocol: 'HTTPS',
    method: 'POST',
    authType: 'AK',
    style: 'RPC',
    pathname: '/',
    reqBodyType: 'formData',
    bodyType: 'json'
  })
}

function createOosFormRequest({ query = {}, body = {} } = {}) {
  return new $OpenApi.OpenApiRequest({
    query,
    body
  })
}

export function getOosErrorMessage(error, fallback = 'OOS request failed') {
  const rawMessage = error?.message || fallback
  if (/ConnectTimeout|ReadTimeout|SocketTimeout|ETIMEDOUT|ECONNRESET/i.test(rawMessage)) {
    return 'OOS request timed out; check the Manager pod network path to the configured OOS endpoint'
  }
  return rawMessage.length > 240 ? `${rawMessage.slice(0, 240)}...` : rawMessage
}

async function discoverClusterConfig(overrides = {}) {
  const configuredClusterId = overrides.clusterId
    || readConfig('CHECKPOINT_BACKUP_CLUSTER_ID')
    || readConfig('VITE_ACS_CLUSTER_ID')
  const configuredClusterRegionId = overrides.clusterRegionId
    || readConfig('CHECKPOINT_BACKUP_CLUSTER_REGION_ID')
    || readConfig('ACS_CLUSTER_REGION_ID')
    || readConfig('VITE_ACS_REGION_ID')

  if (configuredClusterId && configuredClusterRegionId) {
    return {
      clusterId: configuredClusterId,
      clusterRegionId: configuredClusterRegionId
    }
  }

  try {
    const discovered = await getClusterId()
    const clusterRegionId = discovered.clusterRegionId || discovered.region || discovered.regionId || ''
    return {
      clusterId: configuredClusterId || discovered.clusterId || '',
      clusterRegionId: configuredClusterRegionId || clusterRegionId
    }
  } catch {
    return {
      clusterId: configuredClusterId,
      clusterRegionId: configuredClusterRegionId
    }
  }
}

export async function resolveCheckpointBackupOosConfig(overrides = {}) {
  const cluster = await discoverClusterConfig(overrides)
  const oosRegionId = overrides.oosRegionId
    || readConfig('CHECKPOINT_BACKUP_OOS_REGION_ID')
    || readConfig('OOS_REGION_ID')
    || cluster.clusterRegionId
    || 'cn-hangzhou'
  return {
    accessKeyId: overrides.accessKeyId
      || readConfig('ALIBABA_CLOUD_ACCESS_KEY_ID'),
    accessKeySecret: overrides.accessKeySecret
      || readConfig('ALIBABA_CLOUD_ACCESS_KEY_SECRET'),
    securityToken: overrides.securityToken
      || readConfig('ALIBABA_CLOUD_SECURITY_TOKEN'),
    endpoint: overrides.endpoint
      || readConfig('CHECKPOINT_BACKUP_OOS_ENDPOINT')
      || `oos.${oosRegionId}.aliyuncs.com`,
    oosAssumeRole: overrides.oosAssumeRole
      || readConfig('CHECKPOINT_BACKUP_OOS_ASSUME_ROLE')
      || readConfig('OOS_ASSUME_ROLE')
      || DEFAULT_OOS_ASSUME_ROLE,
    oosAssumeRoleArn: overrides.oosAssumeRoleArn
      || readConfig('CHECKPOINT_BACKUP_OOS_ASSUME_ROLE_ARN'),
    stsEndpoint: overrides.stsEndpoint
      || readConfig('CHECKPOINT_BACKUP_STS_ENDPOINT')
      || `sts.${oosRegionId}.aliyuncs.com`,
    oosTemplateName: overrides.oosTemplateName
      || readConfig('CHECKPOINT_BACKUP_OOS_TEMPLATE_NAME', DEFAULT_CHECKPOINT_BACKUP_OOS_TEMPLATE_NAME),
    oosTemplateVersion: overrides.oosTemplateVersion
      || readConfig('CHECKPOINT_BACKUP_OOS_TEMPLATE_VERSION', DEFAULT_CHECKPOINT_BACKUP_OOS_TEMPLATE_VERSION),
    oosRegionId,
    clusterRegionId: cluster.clusterRegionId || oosRegionId,
    clusterId: cluster.clusterId
  }
}

async function resolveOpenApiCredential(config, overrides = {}) {
  if (config.accessKeyId && config.accessKeySecret) {
    return {
      accessKeyId: config.accessKeyId,
      accessKeySecret: config.accessKeySecret,
      securityToken: config.securityToken || undefined
    }
  }

  const provider = overrides.credentialProvider || new CredentialClient()
  const credential = await provider.getCredential()
  return {
    accessKeyId: requireConfig(
      credential?.accessKeyId || credential?.AccessKeyId,
      'ALIBABA_CLOUD_ACCESS_KEY_ID'
    ),
    accessKeySecret: requireConfig(
      credential?.accessKeySecret || credential?.AccessKeySecret,
      'ALIBABA_CLOUD_ACCESS_KEY_SECRET'
    ),
    securityToken: credential?.securityToken || credential?.SecurityToken || undefined
  }
}

async function assumeOosRoleCredential(config, sourceCredential, overrides = {}) {
  if (!config.oosAssumeRoleArn) return sourceCredential

  const stsConfig = new $OpenApi.Config({
    accessKeyId: sourceCredential.accessKeyId,
    accessKeySecret: sourceCredential.accessKeySecret,
    securityToken: sourceCredential.securityToken,
    endpoint: config.stsEndpoint
  })
  const stsClientFactory = overrides.stsClientFactory || (clientConfig => new Sts20150401(clientConfig))
  const stsClient = stsClientFactory(stsConfig)
  const response = await stsClient.assumeRole(new $Sts20150401.AssumeRoleRequest({
    roleArn: config.oosAssumeRoleArn,
    roleSessionName: OOS_ROLE_SESSION_NAME,
    durationSeconds: OOS_ROLE_SESSION_DURATION_SECONDS
  }))
  const body = getBody(response)
  const credential = body.credentials || body.Credentials || {}

  return {
    accessKeyId: requireConfig(
      credential.accessKeyId || credential.AccessKeyId,
      'STS AssumeRole AccessKeyId'
    ),
    accessKeySecret: requireConfig(
      credential.accessKeySecret || credential.AccessKeySecret,
      'STS AssumeRole AccessKeySecret'
    ),
    securityToken: requireConfig(
      credential.securityToken || credential.SecurityToken,
      'STS AssumeRole SecurityToken'
    )
  }
}

export async function createOosClient(overrides = {}) {
  const config = await resolveCheckpointBackupOosConfig(overrides)
  const sourceCredential = overrides.client ? null : await resolveOpenApiCredential(config, overrides)
  const credential = sourceCredential
    ? await assumeOosRoleCredential(config, sourceCredential, overrides)
    : null
  const openApiConfig = credential ? new $OpenApi.Config({
    accessKeyId: credential.accessKeyId,
    accessKeySecret: credential.accessKeySecret,
    securityToken: credential.securityToken,
    endpoint: config.endpoint
  }) : null
  const openApiClientFactory = overrides.openApiClientFactory || (clientConfig => new OpenApiClient(clientConfig))
  const client = overrides.client || openApiClientFactory(openApiConfig)

  return {
    config,
    async validateTemplateContent({ templateContent }) {
      const params = createOosApiParams('ValidateTemplateContent')
      const request = createOosFormRequest({
        query: {
          RegionId: config.oosRegionId
        },
        body: {
          Content: templateContent
        }
      })
      const response = await client.callApi(params, request, new $Util.RuntimeOptions({}))
      const body = getBody(response)
      return {
        requestId: body.RequestId || body.requestId || null,
        raw: body
      }
    },
    async startExecution({
      templateContent,
      templateName,
      templateVersion,
      parameters,
      description = '',
      safetyCheck = 'Skip'
    }) {
      if (!templateContent && !templateName) {
        throw new Error('templateContent or templateName is required')
      }
      const params = createOosApiParams('StartExecution')
      const request = createOosFormRequest({
        query: {
          RegionId: config.oosRegionId,
          ...(templateName
            ? {
                TemplateName: templateName,
                ...(templateVersion ? { TemplateVersion: templateVersion } : {})
              }
            : {}),
          SafetyCheck: safetyCheck
        },
        body: {
          ...(!templateName ? { TemplateContent: templateContent } : {}),
          Parameters: JSON.stringify(parameters || {}),
          ...(description ? { Description: description } : {})
        }
      })
      const response = await client.callApi(params, request, new $Util.RuntimeOptions({}))
      const body = getBody(response)
      const executionId = parseExecutionId(body)
      if (!executionId) {
        throw new Error(`OOS StartExecution returned no executionId: ${JSON.stringify(body)}`)
      }
      return {
        executionId,
        requestId: body.RequestId || body.requestId || null,
        raw: body
      }
    },
    async cancelExecution({ executionId }) {
      if (!executionId) throw new Error('executionId is required')
      const params = createOosApiParams('CancelExecution')
      const request = new $OpenApi.OpenApiRequest({
        query: {
          RegionId: config.oosRegionId,
          ExecutionId: executionId
        }
      })
      const response = await client.callApi(params, request, new $Util.RuntimeOptions({}))
      const body = getBody(response)
      return {
        executionId,
        requestId: body.RequestId || body.requestId || null,
        raw: body
      }
    },
    async listExecutions({ executionId, maxResults = 10, nextToken = '' } = {}) {
      const params = createOosApiParams('ListExecutions')
      const request = new $OpenApi.OpenApiRequest({
        query: {
          RegionId: config.oosRegionId,
          ...(executionId ? { ExecutionId: executionId } : {}),
          MaxResults: maxResults,
          ...(nextToken ? { NextToken: nextToken } : {})
        }
      })
      const response = await client.callApi(params, request, new $Util.RuntimeOptions({}))
      const body = getBody(response)
      return {
        executions: body.Executions || body.executions || [],
        nextToken: body.NextToken || body.nextToken || null,
        requestId: body.RequestId || body.requestId || null,
        raw: body
      }
    },
    async listTaskExecutions({ executionId, maxResults = 100, nextToken = '' } = {}) {
      if (!executionId) throw new Error('executionId is required')
      const params = createOosApiParams('ListTaskExecutions')
      const request = new $OpenApi.OpenApiRequest({
        query: {
          RegionId: config.oosRegionId,
          ExecutionId: executionId,
          MaxResults: maxResults,
          ...(nextToken ? { NextToken: nextToken } : {})
        }
      })
      const response = await client.callApi(params, request, new $Util.RuntimeOptions({}))
      const body = getBody(response)
      return {
        taskExecutions: body.TaskExecutions || body.taskExecutions || [],
        nextToken: body.NextToken || body.nextToken || null,
        requestId: body.RequestId || body.requestId || null,
        raw: body
      }
    }
  }
}
