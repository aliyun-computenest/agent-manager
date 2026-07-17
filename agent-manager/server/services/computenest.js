/**
 * ComputeNest Skill API proxy service
 * Wraps all 15 ComputeNest Skill-related API calls using the generic OpenAPI client.
 * The dedicated ComputeNest SDK (@alicloud/computenest20210601) does not include
 * Skill APIs yet, so we use OpenApiClient.callApi directly.
 */

import _OpenApi, * as $OpenApi from '@alicloud/openapi-client'
const OpenApiClient = _OpenApi.default || _OpenApi
import * as $Util from '@alicloud/tea-util'
import { getAccountIdWithCredentials } from './gateway-config.js'
import { appLogger } from '../utils/logger.js'

const API_VERSION = '2021-06-01'
const PRODUCT = 'computenest'
const ENDPOINT_SUFFIX = '.aliyuncs.com'

// ---------------------------------------------------------------------------
// Client creation
// ---------------------------------------------------------------------------

let _cachedEndpointRegion = null  // endpoint region: cn-hangzhou (domestic) or ap-southeast-1 (international)

export function isInternationalAccountId(accountId) {
  const normalized = String(accountId || '')
  return normalized.startsWith('5') && normalized.length >= 16
}

export async function resolveComputeNestEndpointRegion({
  accessKeyId = process.env.ALIBABA_CLOUD_ACCESS_KEY_ID || '',
  accessKeySecret = process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET || '',
  getAccountId = getAccountIdWithCredentials,
} = {}) {
  const accountId = await getAccountId(accessKeyId, accessKeySecret)
  return isInternationalAccountId(accountId) ? 'ap-southeast-1' : 'cn-hangzhou'
}

export async function getComputeNestEndpointRegion() {
  if (_cachedEndpointRegion) return _cachedEndpointRegion

  try {
    _cachedEndpointRegion = await resolveComputeNestEndpointRegion()
  } catch (error) {
    appLogger.warn('Failed to detect ComputeNest site from STS AccountId; using domestic endpoint', {
      code: error?.code || error?.name || 'UNKNOWN',
    })
    _cachedEndpointRegion = 'cn-hangzhou'
  }
  return _cachedEndpointRegion
}

/**
 * Create an OpenAPI client configured with cluster-level AK/SK.
 * Site attribution is determined from the real AccountId returned by STS.
 *
 * IMPORTANT: RegionId in request bodies must use endpointRegion (a supported region)
 * because ComputeNest backend generates STS credentials based on RegionId, and
 * unsupported regions cause OSS AccessDenied errors.
 * @returns {Promise<import('@alicloud/openapi-client').default>}
 */
async function createClient() {
  const accessKeyId = process.env.ALIBABA_CLOUD_ACCESS_KEY_ID || ''
  const accessKeySecret = process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET || ''
  if (!accessKeyId || !accessKeySecret) {
    throw new Error('MISSING_CREDENTIALS: ALIBABA_CLOUD_ACCESS_KEY_ID / ALIBABA_CLOUD_ACCESS_KEY_SECRET not set')
  }
  const endpointRegion = await getComputeNestEndpointRegion()
  const config = new $OpenApi.Config({
    accessKeyId,
    accessKeySecret,
    endpoint: `${PRODUCT}.${endpointRegion}${ENDPOINT_SUFFIX}`
  })
  return new OpenApiClient(config)
}

// ---------------------------------------------------------------------------
// Exception mapping
// ---------------------------------------------------------------------------

/**
 * Map a ComputeNest SDK error to an HTTP-ready error with httpStatus.
 * @param {Error} err
 * @returns {Error}
 */
export function mapComputeNestError(err) {
  const code = err.code || err.name || ''
  const msg = err.message || 'Unknown error'

  // SkillHubConfig.NotFound is a special case — callers handle it themselves
  if (code === 'SkillHubConfig.NotFound') {
    const mapped = new Error(msg)
    mapped.code = code
    mapped.httpStatus = 404
    throw mapped
  }

  if (code === 'InvalidParameter' || code === 'MissingParameter' || code === 'MissingSkillSpaceId') {
    const mapped = new Error(msg)
    mapped.code = code
    mapped.httpStatus = 400
    throw mapped
  }
  if (code === 'NotFound') {
    const mapped = new Error(msg)
    mapped.code = code
    mapped.httpStatus = 404
    throw mapped
  }
  if (code === 'AlreadyExists') {
    const mapped = new Error(msg)
    mapped.code = code
    mapped.httpStatus = 409
    throw mapped
  }
  if (code === 'Forbidden' || code === 'NoPermission') {
    const mapped = new Error('当前 AK/SK 无计算巢访问权限，请检查 RAM 授权（AliyunComputeNestReadOnlyAccess）')
    mapped.code = code
    mapped.httpStatus = 403
    throw mapped
  }
  if (code === 'InvalidAction.NotFound') {
    const mapped = new Error('计算巢 API 不存在，请检查 API 版本和 region 配置')
    mapped.code = code
    mapped.httpStatus = 502
    throw mapped
  }

  // ComputeNest server-side errors (5xx) — typically transient or caused by skill state
  if (code === 'InternalError' || code === 'ServiceUnavailable' || code === 'InternalFailure') {
    appLogger.error(`[ComputeNest] Server error: code=${code} msg=${msg} requestid=${err?.data?.Recommend?.requestId || err?.data?.requestId || ''}`)
    const mapped = new Error('计算巢服务内部错误，请确认该 Skill 未被任何 Agent 类型引用后重试，或稍后再试')
    mapped.code = code
    mapped.httpStatus = 502
    mapped.originalMsg = msg
    throw mapped
  }

  // Default: 502
  appLogger.error(`[ComputeNest] Unmapped error: code=${code} msg=${msg} requestid=${err?.data?.Recommend?.requestId || ''}`)
  const mapped = new Error(`ComputeNest 服务异常: ${msg}`)
  mapped.code = code
  mapped.httpStatus = 502
  mapped.originalMsg = msg
  throw mapped
}

// ---------------------------------------------------------------------------
// Generic callApi wrapper
// ---------------------------------------------------------------------------

/**
 * @param {object} params - $OpenApi.Params
 * @param {object} request - $OpenApi.OpenApiRequest
 * @returns {Promise<object>} response.body
 */
async function callComputeNestApi(params, request) {
  const client = await createClient()
  const runtime = new $Util.RuntimeOptions({ connectTimeout: 10000, readTimeout: 30000 })
  try {
    const result = await client.callApi(params, request, runtime)
    const camelResult = toCamelCase(result.body)
    return camelResult
  } catch (err) {
    // Log full error details for diagnosis
    appLogger.error(`[ComputeNest] Full error for ${params.action}: ${JSON.stringify({
      code: err.code,
      message: err.message,
      statusCode: err.statusCode,
      data: err.data,
      requestId: err?.data?.RequestId || err?.data?.requestId,
      allKeys: err.data ? Object.keys(err.data) : []
    })}`)
    mapComputeNestError(err)
  }
}

/**
 * Recursively convert PascalCase object keys to camelCase.
 * ComputeNest API returns PascalCase (e.g. SkillSpaces, TotalCount, OssBucketName)
 * but our Zod schemas and frontend expect camelCase (e.g. skillSpaces, totalCount, ossBucketName).
 * @param {any} obj
 * @returns {any}
 */
function toCamelCase(obj) {
  if (obj === null || obj === undefined) return obj
  if (Array.isArray(obj)) return obj.map(toCamelCase)
  if (typeof obj === 'object') {
    const result = {}
    for (const [key, value] of Object.entries(obj)) {
      // Skip undefined values (ComputeNest may return fields as undefined)
      if (value === undefined) continue
      // PascalCase: first letter uppercase → lowercase
      const camelKey = key.charAt(0).toLowerCase() + key.slice(1)
      result[camelKey] = toCamelCase(value)
    }
    return result
  }
  return obj
}

// ---------------------------------------------------------------------------
// Helper: build ROA-style callApi params + request
// ---------------------------------------------------------------------------

function roaParams(action, method, pathname, queries = {}) {
  return new $OpenApi.Params({
    action,
    version: API_VERSION,
    protocol: 'HTTPS',
    method,
    authType: 'AK',
    style: 'ROA',
    pathname,
    reqBodyType: 'json',
    bodyType: 'json'
  })
}

/**
 * Build RPC-style params with form-urlencoded body.
 * ComputeNest backend controllers don't use @RequestBody, so Spring can't bind
 * JSON body — params must be sent as application/x-www-form-urlencoded.
 */
function rpcParams(action, method = 'POST') {
  return new $OpenApi.Params({
    action,
    version: API_VERSION,
    protocol: 'HTTPS',
    method,
    authType: 'AK',
    style: 'RPC',
    pathname: '/',
    reqBodyType: 'formData',
    bodyType: 'json'
  })
}

function buildRequest(body = undefined, query = undefined, headers = undefined) {
  return new $OpenApi.OpenApiRequest({ body, query, headers })
}

// ---------------------------------------------------------------------------
// 1. SkillHub configuration (2 APIs)
// ---------------------------------------------------------------------------

/**
 * Get SkillHub config. Returns { configured: true, hubConfig } or
 * { configured: false, hubConfig: null } when SkillHubConfig.NotFound.
 */
export async function getSkillHubConfig() {
  try {
    const params = roaParams('GetSkillHubConfig', 'GET', '/api/v1/skillHubConfig')
    const body = await callComputeNestApi(params, buildRequest())
    return { configured: true, hubConfig: body }
  } catch (err) {
    if (err.code === 'SkillHubConfig.NotFound') {
      return { configured: false, hubConfig: null }
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// 2. Skill Spaces (4 APIs)
// ---------------------------------------------------------------------------

/**
 * List skill spaces.
 * @param {{ keyword?: string, nextToken?: string, maxResults?: number }} opts
 */
export async function listSkillSpaces({ keyword, nextToken, maxResults } = {}) {
  const queries = {}
  if (keyword) {
    queries['Filter.1.Name'] = 'SkillSpaceName'
    queries['Filter.1.Value.1'] = keyword
  }
  if (nextToken) queries.NextToken = nextToken
  if (maxResults) queries.MaxResults = String(maxResults)

  const params = roaParams('ListSkillSpaces', 'GET', '/api/v1/skillSpaces', queries)
  return callComputeNestApi(params, buildRequest(undefined, queries))
}

/**
 * Create a skill space.
 * @param {{ skillSpaceName: string, skillSpaceDescription: string }} data
 */
export async function createSkillSpace({ skillSpaceName, skillSpaceDescription }) {
  const params = roaParams('CreateSkillSpace', 'POST', '/api/v1/skillSpaces')
  return callComputeNestApi(params, buildRequest({
    SkillSpaceName: skillSpaceName,
    SkillSpaceDescription: skillSpaceDescription,
    RegionId: _cachedEndpointRegion
  }))
}

/**
 * Get skill space detail.
 * @param {string} skillSpaceId
 */
export async function getSkillSpace(skillSpaceId) {
  const queries = { SkillSpaceId: skillSpaceId }
  const params = roaParams('GetSkillSpace', 'GET', `/api/v1/skillSpaces/${skillSpaceId}`, queries)
  return callComputeNestApi(params, buildRequest(undefined, queries))
}

/**
 * Delete a skill space.
 * ComputeNest Skill APIs are RPC-style: use POST + Action (not HTTP DELETE).
 * @param {string} skillSpaceId
 */
export async function deleteSkillSpace(skillSpaceId) {
  // ROA style — same reason as updateSkill/deleteSkill.
  const body = { RegionId: _cachedEndpointRegion, SkillSpaceId: skillSpaceId }
  const params = roaParams('DeleteSkillSpace', 'POST', `/api/v1/skillSpaces/${skillSpaceId}`)
  return callComputeNestApi(params, buildRequest(body))
}

// ---------------------------------------------------------------------------
// 3. Skills (5 APIs)
// ---------------------------------------------------------------------------

/**
 * List skills in a skill space.
 * @param {{ skillSpaceId: string, keyword?: string, nextToken?: string, maxResults?: number, needDownloadUrl?: boolean, skillId?: string }} opts
 */
export async function listSkills({ skillSpaceId, keyword, nextToken, maxResults, needDownloadUrl, skillId } = {}) {
  const queries = {
    'Filter.1.Name': 'SkillType',
    'Filter.1.Value.1': 'custom',
    'Filter.2.Name': 'SkillSpaceId',
    'Filter.2.Value.1': skillSpaceId
  }
  let filterIdx = 3
  if (skillId) {
    queries[`Filter.${filterIdx}.Name`] = 'SkillId'
    queries[`Filter.${filterIdx}.Value.1`] = skillId
    filterIdx++
  }
  if (keyword) {
    queries[`Filter.${filterIdx}.Name`] = 'SkillName'
    queries[`Filter.${filterIdx}.Value.1`] = keyword
    filterIdx++
  }
  if (nextToken) queries.NextToken = nextToken
  if (maxResults) queries.MaxResults = String(maxResults)
  if (needDownloadUrl) queries.NeedDownloadUrl = 'true'

  const params = roaParams('ListSkills', 'GET', `/api/v1/skillSpaces/${skillSpaceId}/skills`, queries)
  return callComputeNestApi(params, buildRequest(undefined, queries))
}

/**
 * Create a skill.
 * @param {{ skillSpaceId: string, sourceType: string, skillName: string, skillDisplayName?: string, skillDescription: string, ossUrl?: string, sourceSkillId?: string, skillLabels?: string[] }} data
 */
export async function createSkill({ skillSpaceId, sourceType, skillName, skillDisplayName, skillDescription, ossUrl, sourceSkillId, skillLabels }) {
  const body = {
    SourceType: sourceType,
    SkillName: skillName,
    SkillDisplayName: skillDisplayName || skillName,
    SkillDescription: skillDescription,
    SkillSpaceId: skillSpaceId,
    RegionId: _cachedEndpointRegion
  }
  if (ossUrl) body.OssUrl = ossUrl
  if (sourceSkillId) body.SourceSkillId = sourceSkillId
  if (skillLabels && skillLabels.length > 0) body.SkillLabels = skillLabels

  const params = roaParams('CreateSkill', 'POST', `/api/v1/skillSpaces/${skillSpaceId}/skills`)
  return callComputeNestApi(params, buildRequest(body))
}

/**
 * Get skill detail.
 * Note: ComputeNest's GetSkill API does NOT support NeedDownloadUrl;
 * use ListSkills + NeedDownloadUrl + Filter(SkillId) to get DownloadUrl.
 * @param {{ skillSpaceId: string, skillId: string }} opts
 */
export async function getSkill({ skillSpaceId, skillId } = {}) {
  const queries = { SkillId: skillId }

  const params = roaParams('GetSkill', 'GET', `/api/v1/skillSpaces/${skillSpaceId}/skills/${skillId}`, queries)
  return callComputeNestApi(params, buildRequest(undefined, queries))
}

/**
 * Update a skill.
 * ComputeNest Skill APIs are RPC-style: use POST + Action (not HTTP PUT).
 * @param {{ skillSpaceId: string, skillId: string, skillName?: string, skillDisplayName?: string, skillDescription?: string, sourceType: string, ossUrl?: string, sourceSkillId?: string, skillLabels?: string[] }} data
 */
export async function updateSkill({ skillSpaceId, skillId, skillName, skillDisplayName, skillDescription, sourceType, ossUrl, sourceSkillId, skillLabels }) {
  // Use the SAME ROA path as CreateSkill — the API Gateway must recognize
  // this path to inject aliUid. The x-acs-action header handles routing.
  const body = { RegionId: _cachedEndpointRegion, SkillId: skillId }
  if (sourceType) body.SourceType = sourceType
  if (skillName !== undefined) body.SkillName = skillName
  if (skillDisplayName !== undefined) body.SkillDisplayName = skillDisplayName
  if (skillDescription !== undefined) body.SkillDescription = skillDescription
  if (ossUrl) body.OssUrl = ossUrl
  if (sourceSkillId) body.SourceSkillId = sourceSkillId
  if (skillLabels !== undefined) body.SkillLabels = skillLabels

  const params = roaParams('UpdateSkill', 'POST', `/api/v1/skillSpaces/${skillSpaceId}/skills`)
  return callComputeNestApi(params, buildRequest(body))
}

/**
 * Delete a skill.
 * ComputeNest Skill APIs are RPC-style: use POST + Action (not HTTP DELETE).
 * @param {{ skillSpaceId: string, skillId: string }} opts
 */
export async function deleteSkill({ skillSpaceId, skillId }) {
  // ROA style — same as updateSkill, avoids RPC aliUid injection issue.
  const body = { RegionId: _cachedEndpointRegion, SkillId: skillId }
  const params = roaParams('DeleteSkill', 'POST', `/api/v1/skillSpaces/${skillSpaceId}/skills/${skillId}`)
  return callComputeNestApi(params, buildRequest(body))
}

// ---------------------------------------------------------------------------
// 4. Skill Files (1 API)
// ---------------------------------------------------------------------------

/**
 * List skill files.
 * @param {{ skillSpaceId: string, skillId: string, maxResults?: number, nextToken?: string }} opts
 */
export async function listSkillFiles({ skillSpaceId, skillId, maxResults, nextToken } = {}) {
  const queries = { SkillId: skillId }
  if (maxResults) queries.MaxResults = String(maxResults)
  if (nextToken) queries.NextToken = nextToken

  const params = roaParams('ListSkillFiles', 'GET', `/api/v1/skillSpaces/${skillSpaceId}/skills/${skillId}/files`, queries)
  return callComputeNestApi(params, buildRequest(undefined, queries))
}

// ---------------------------------------------------------------------------
// 5. Official Skills (1 API — reuses ListSkills with SkillType=official)
// ---------------------------------------------------------------------------

/**
 * List official skills (SkillType=official, no skillSpaceId required).
 * @param {{ keyword?: string, skillLabel?: string, nextToken?: string, maxResults?: number, needDownloadUrl?: boolean, skillId?: string, skillSpaceId?: string }} opts
 */
export async function listOfficialSkills({ keyword, skillLabel, nextToken, maxResults, needDownloadUrl, skillId, skillSpaceId } = {}) {
  const queries = {
    'Filter.1.Name': 'SkillType',
    'Filter.1.Value.1': 'official'
  }
  let filterIdx = 2
  if (skillId) {
    queries[`Filter.${filterIdx}.Name`] = 'SkillId'
    queries[`Filter.${filterIdx}.Value.1`] = skillId
    filterIdx++
  }
  if (skillSpaceId) {
    queries[`Filter.${filterIdx}.Name`] = 'SkillSpaceId'
    queries[`Filter.${filterIdx}.Value.1`] = skillSpaceId
    filterIdx++
  }
  if (keyword) {
    queries[`Filter.${filterIdx}.Name`] = 'SkillName'
    queries[`Filter.${filterIdx}.Value.1`] = keyword
    filterIdx++
  }
  if (skillLabel) {
    queries[`Filter.${filterIdx}.Name`] = 'SkillLabels'
    queries[`Filter.${filterIdx}.Value.1`] = skillLabel
    filterIdx++
  }
  if (nextToken) queries.NextToken = nextToken
  if (maxResults) queries.MaxResults = String(maxResults)
  if (needDownloadUrl) queries.NeedDownloadUrl = 'true'

  const params = roaParams('ListSkills', 'GET', '/api/v1/skills', queries)
  return callComputeNestApi(params, buildRequest(undefined, queries))
}

// ---------------------------------------------------------------------------
// 6. File Security Detection (2 APIs)
// ---------------------------------------------------------------------------

/**
 * Submit a file for security detection.
 * @param {{ ossUrl: string }} data
 */
export async function createSkillFileDetect({ ossUrl }) {
  const params = roaParams('CreateSkillFileDetect', 'POST', '/api/v1/skillFileDetect')
  return callComputeNestApi(params, buildRequest({ OssUrl: ossUrl }))
}

/**
 * Get file detection result.
 * @param {string} hashKey
 */
export async function getSkillFileDetectResult(hashKey) {
  const params = roaParams('GetSkillFileDetectResult', 'GET', `/api/v1/skillFileDetect/${hashKey}`)
  return callComputeNestApi(params, buildRequest(undefined, { HashKey: hashKey }))
}
