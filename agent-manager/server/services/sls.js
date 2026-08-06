/**
 * SLS (Simple Log Service) Module
 * Handles token usage statistics from Alibaba Cloud SLS
 */

import _Sls20201230, * as $Sls20201230 from '@alicloud/sls20201230'
const Sls20201230 = _Sls20201230.default || _Sls20201230
import _OpenApi, * as $OpenApi from '@alicloud/openapi-client'
const OpenApiClient = _OpenApi.default || _OpenApi
import _OpenApiUtil from '@alicloud/openapi-util'
const OpenApiUtil = _OpenApiUtil.default || _OpenApiUtil
import * as $Util from '@alicloud/tea-util'
import { env } from '../config/index.js'
import { getGatewayConfig, onGatewayConfigChange } from './gateway-config.js'

// Cache for SLS project name and API name
let cachedSlsProjectName = null
let cachedHttpApiName = null
let cacheExpiry = 0
const CACHE_TTL = 10 * 60 * 1000 // 10 minutes

/**
 * Invalidate SLS cache (project name and API name)
 * Called when gateway config changes to force re-fetch on next query
 */
function invalidateSlsCache() {
  cachedSlsProjectName = null
  cachedHttpApiName = null
  cacheExpiry = 0
  console.log('🔄 SLS cache invalidated due to gateway config change')
}

// Auto-invalidate SLS cache when gateway config changes
onGatewayConfigChange(() => invalidateSlsCache())

/**
 * Create Alibaba Cloud SLS Client
 */
function createSlsClient() {
  const gwConfig = getGatewayConfig()
  const akId = gwConfig.aliyunAccessKeyId || ''
  const akSecret = gwConfig.aliyunAccessKeySecret || ''
  const regionId = gwConfig.regionId || 'cn-hangzhou'

  if (!akId || !akSecret) {
    throw new Error('Alibaba Cloud credentials not configured')
  }

  const config = new $OpenApi.Config({
    accessKeyId: akId,
    accessKeySecret: akSecret,
    endpoint: `${regionId}.log.aliyuncs.com`
  })

  return new Sls20201230(config)
}

/**
 * Get SLS Project Name from APIG Dashboard using raw OpenAPI call
 * This bypasses SDK type casting issues
 * @returns {Promise<string|null>} SLS project name or null if not available
 */
async function getSlsProjectName() {
  // Check cache first
  if (cachedSlsProjectName && Date.now() < cacheExpiry) {
    return cachedSlsProjectName
  }

  const gwConfig = getGatewayConfig()
  if (!gwConfig.gatewayId) {
    return null
  }

  try {
    const akId = gwConfig.aliyunAccessKeyId || ''
    const akSecret = gwConfig.aliyunAccessKeySecret || ''
    const regionId = gwConfig.regionId || 'cn-hangzhou'

    if (!akId || !akSecret) {
      throw new Error('Alibaba Cloud credentials not configured')
    }

    // Create a generic OpenAPI client
    const config = new $OpenApi.Config({
      accessKeyId: akId,
      accessKeySecret: akSecret,
      endpoint: `apig.${regionId}.aliyuncs.com`
    })
    const client = new OpenApiClient(config)

    // Build raw API request
    const params = new $OpenApi.Params({
      action: 'GetDashboard',
      version: '2024-03-27',
      protocol: 'HTTPS',
      method: 'GET',
      authType: 'AK',
      style: 'ROA',
      pathname: `/v1/gateways/${gwConfig.gatewayId}/dashboards`,
      reqBodyType: 'json',
      bodyType: 'json'
    })

    const query = {
      name: 'LOG',
      source: 'SLS'
    }

    const request = new $OpenApi.OpenApiRequest({
      query: OpenApiUtil.query(query)
    })

    const runtime = new $Util.RuntimeOptions({})

    const response = await client.callApi(params, request, runtime)
    
    const body = response?.body
    if (!body?.data?.url) {
      console.log('SLS Dashboard not configured for this gateway')
      return null
    }

    // Extract project name from URL
    // URL format: https://sls.console.aliyun.com/lognext/project/aliyun-product-data-xxx-cn-shanghai/logsearch/...
    const url = body.data.url
    const projectMatch = url.match(/\/project\/([^/]+)\//)
    
    if (!projectMatch) {
      console.error('Failed to extract SLS project name from URL:', url)
      return null
    }

    cachedSlsProjectName = projectMatch[1]
    cacheExpiry = Date.now() + CACHE_TTL
    
    console.log(`📊 SLS Project Name: ${cachedSlsProjectName}`)
    return cachedSlsProjectName
  } catch (error) {
    console.error('Failed to get SLS project name:', error.message)
    return null
  }
}

/**
 * Get HTTP API Name from APIG GetHttpApi
 * The API name is used in SLS query for ai_log.api field
 * Format in SLS: "{apiName}@_origin_@_reserved_"
 * @returns {Promise<string|null>} HTTP API name or null if not available
 */
async function getHttpApiName() {
  // Check cache first (shared expiry with SLS project name)
  if (cachedHttpApiName && Date.now() < cacheExpiry) {
    return cachedHttpApiName
  }

  const gwConfig = getGatewayConfig()
  if (!gwConfig.httpApiId) {
    console.log('⚠️ SLS: HTTP API ID not configured, cannot get API name')
    return null
  }

  try {
    const akId = gwConfig.aliyunAccessKeyId || ''
    const akSecret = gwConfig.aliyunAccessKeySecret || ''
    const regionId = gwConfig.regionId || 'cn-hangzhou'

    if (!akId || !akSecret) {
      throw new Error('Alibaba Cloud credentials not configured')
    }

    // Create APIG client
    const config = new $OpenApi.Config({
      accessKeyId: akId,
      accessKeySecret: akSecret,
      endpoint: `apig.${regionId}.aliyuncs.com`
    })
    const client = new OpenApiClient(config)

    // Call GetHttpApi
    const params = new $OpenApi.Params({
      action: 'GetHttpApi',
      version: '2024-03-27',
      protocol: 'HTTPS',
      method: 'GET',
      authType: 'AK',
      style: 'ROA',
      pathname: `/v1/http-apis/${gwConfig.httpApiId}`,
      reqBodyType: 'json',
      bodyType: 'json'
    })

    const request = new $OpenApi.OpenApiRequest({})
    const runtime = new $Util.RuntimeOptions({})

    const response = await client.callApi(params, request, runtime)
    
    const apiName = response?.body?.data?.name
    if (!apiName) {
      console.log('⚠️ SLS: Failed to get API name from GetHttpApi response')
      return null
    }

    cachedHttpApiName = apiName
    // Note: cacheExpiry is already set by getSlsProjectName or will be set when both are called together
    if (!cacheExpiry || Date.now() >= cacheExpiry) {
      cacheExpiry = Date.now() + CACHE_TTL
    }
    
    console.log(`📊 HTTP API Name: ${cachedHttpApiName}`)
    return cachedHttpApiName
  } catch (error) {
    console.error('Failed to get HTTP API name:', error.message)
    return null
  }
}

/**
 * Get the full API identifier for SLS query
 * Format: "{apiName}@_origin_@_reserved_"
 * @returns {Promise<string|null>} Full API identifier or null
 */
async function getSlsApiIdentifier() {
  const apiName = await getHttpApiName()
  if (!apiName) {
    return null
  }
  return `${apiName}@_origin_@_reserved_`
}

// 业务口径按「东八区（Asia/Shanghai）自然日」统计，避免容器默认 UTC 时区
// 导致"今日零点"被错误地解释为 UTC 00:00（即上海时间 08:00）。
const SHANGHAI_OFFSET_SEC = 8 * 3600
const SECONDS_PER_DAY = 86400

/**
 * Get today's start timestamp (Asia/Shanghai 00:00:00) in seconds.
 * 显式按东八区计算，不依赖进程 TZ 环境变量。
 */
function getTodayStartTimestamp() {
  const nowSec = Math.floor(Date.now() / 1000)
  // 将"现在"平移到东八区的绝对秒，对齐到当日零点，再减回偏移得到 UTC 时间戳
  return Math.floor((nowSec + SHANGHAI_OFFSET_SEC) / SECONDS_PER_DAY) * SECONDS_PER_DAY - SHANGHAI_OFFSET_SEC
}

/**
 * Get current timestamp in seconds
 */
function getCurrentTimestamp() {
  return Math.floor(Date.now() / 1000)
}

/**
 * Get 30 days ago start timestamp (Asia/Shanghai 00:00:00, 30 天前) in seconds
 */
function get30DaysStartTimestamp() {
  return getTodayStartTimestamp() - 30 * SECONDS_PER_DAY
}

/**
 * Query SLS for today's total requests
 * @returns {Promise<number>} Total request count
 */
async function getTodayTotalRequests() {
  const [projectName, apiIdentifier] = await Promise.all([
    getSlsProjectName(),
    getSlsApiIdentifier()
  ])
  
  if (!projectName || !apiIdentifier) {
    console.log('⚠️ SLS: getTodayTotalRequests - Missing projectName or apiIdentifier')
    return 0
  }

  try {
    const client = createSlsClient()
    const gatewayId = getGatewayConfig().gatewayId

    const query = `(((*))and ((cluster_id: ${gatewayId}) and (ai_log.api: "${apiIdentifier}")))| select count(1) as pv`
    console.log('🔍 SLS Query (requests):', query)

    const request = new $Sls20201230.GetLogsRequest({
      type: 'log',
      from: getTodayStartTimestamp(),
      to: getCurrentTimestamp(),
      query
    })

    const response = await client.getLogs(projectName, 'apig-access-log', request)
    console.log('📊 SLS Response (requests):', JSON.stringify(response.body, null, 2))
    
    if (response.body && response.body.length > 0) {
      const pv = parseInt(response.body[0].pv || '0', 10)
      return pv
    }
    return 0
  } catch (error) {
    console.error('Failed to get today total requests:', error.message)
    return 0
  }
}

/**
 * Query SLS for today's total token consumption
 * @returns {Promise<number>} Total tokens consumed
 */
async function getTodayTotalTokens() {
  const [projectName, apiIdentifier] = await Promise.all([
    getSlsProjectName(),
    getSlsApiIdentifier()
  ])
  
  if (!projectName || !apiIdentifier) {
    console.log('⚠️ SLS: getTodayTotalTokens - Missing projectName or apiIdentifier')
    return 0
  }

  try {
    const client = createSlsClient()
    const gatewayId = getGatewayConfig().gatewayId

    const query = `((ai_log.model : *)and ((cluster_id: ${gatewayId}) and (ai_log.api: "${apiIdentifier}")))| select sum(cast(json_extract(ai_log, '$.input_token') as integer)) + sum(cast(json_extract(ai_log, '$.output_token') as integer)) as token`
    console.log('🔍 SLS Query (tokens):', query)

    const request = new $Sls20201230.GetLogsRequest({
      type: 'log',
      from: getTodayStartTimestamp(),
      to: getCurrentTimestamp(),
      query
    })

    const response = await client.getLogs(projectName, 'apig-access-log', request)
    console.log('📊 SLS Response (tokens):', JSON.stringify(response.body, null, 2))
    
    if (response.body && response.body.length > 0) {
      const token = parseInt(response.body[0].token || '0', 10)
      return isNaN(token) ? 0 : token
    }
    return 0
  } catch (error) {
    console.error('Failed to get today total tokens:', error.message)
    return 0
  }
}

/**
 * Query SLS for today's active users (unique visitors)
 * @returns {Promise<number>} Active user count
 */
async function getTodayActiveUsers() {
  const [projectName, apiIdentifier] = await Promise.all([
    getSlsProjectName(),
    getSlsApiIdentifier()
  ])
  
  if (!projectName || !apiIdentifier) {
    console.log('⚠️ SLS: getTodayActiveUsers - Missing projectName or apiIdentifier')
    return 0
  }

  try {
    const client = createSlsClient()
    const gatewayId = getGatewayConfig().gatewayId

    const query = `((ai_log.response_type : normal or ai_log.response_type : stream))and ((cluster_id: ${gatewayId}) and (ai_log.api: "${apiIdentifier}"))| select approx_distinct("x_forwarded_for") as uv`
    console.log('🔍 SLS Query (active users):', query)

    const request = new $Sls20201230.GetLogsRequest({
      type: 'log',
      from: getTodayStartTimestamp(),
      to: getCurrentTimestamp(),
      query
    })

    const response = await client.getLogs(projectName, 'apig-access-log', request)
    
    if (response.body && response.body.length > 0) {
      const uv = parseInt(response.body[0].uv || '0', 10)
      return isNaN(uv) ? 0 : uv
    }
    return 0
  } catch (error) {
    console.error('Failed to get today active users:', error.message)
    return 0
  }
}

/**
 * Query SLS for today's token consumption by consumer
 * @returns {Promise<Array<{consumer: string, inputToken: number, outputToken: number, totalToken: number, requests: number}>>}
 */
async function getTodayTokensByConsumer() {
  const [projectName, apiIdentifier] = await Promise.all([
    getSlsProjectName(),
    getSlsApiIdentifier()
  ])
  
  if (!projectName || !apiIdentifier) {
    console.log('⚠️ SLS: getTodayTokensByConsumer - Missing projectName or apiIdentifier')
    return []
  }

  try {
    const client = createSlsClient()
    const gatewayId = getGatewayConfig().gatewayId

    const query = `(ai_log.consumer : *)and ((cluster_id: ${gatewayId}) and (ai_log.api: "${apiIdentifier}"))| select json_extract(ai_log, '$.consumer') as consumer, sum(cast(json_extract(ai_log, '$.input_token') as integer)) as input_token, sum(cast(json_extract(ai_log, '$.output_token') as integer)) as output_token, sum(cast(json_extract(ai_log, '$.input_token') as integer)) + sum(cast(json_extract(ai_log, '$.output_token') as integer)) as total_token, count(1) as request group by consumer order by total_token desc`
    console.log('🔍 SLS Query (by consumer):', query)

    const request = new $Sls20201230.GetLogsRequest({
      type: 'log',
      from: getTodayStartTimestamp(),
      to: getCurrentTimestamp(),
      query
    })

    const response = await client.getLogs(projectName, 'apig-access-log', request)
    console.log('📊 SLS Response (by consumer):', JSON.stringify(response.body, null, 2))
    
    if (response.body && response.body.length > 0) {
      return response.body.map(item => ({
        consumer: (item.consumer || '').replace(/^"|"$/g, ''), // Remove surrounding quotes
        inputToken: parseInt(item.input_token || '0', 10),
        outputToken: parseInt(item.output_token || '0', 10),
        totalToken: parseInt(item.total_token || '0', 10),
        requests: parseInt(item.request || '0', 10)
      }))
    }
    return []
  } catch (error) {
    console.error('Failed to get today tokens by consumer:', error.message)
    return []
  }
}

/**
 * Query SLS for today's token consumption for a specific user (by username/consumer name)
 * @param {string} username - The username to query (consumer name in SLS)
 * @returns {Promise<{inputToken: number, outputToken: number, totalToken: number, requests: number} | null>}
 */
async function getTodayTokensByUsername(username) {
  if (!username) {
    return null
  }

  const [projectName, apiIdentifier] = await Promise.all([
    getSlsProjectName(),
    getSlsApiIdentifier()
  ])
  
  if (!projectName || !apiIdentifier) {
    console.log('⚠️ SLS: getTodayTokensByUsername - Missing projectName or apiIdentifier')
    return null
  }

  try {
    const client = createSlsClient()
    const gatewayId = getGatewayConfig().gatewayId

    // Query for specific consumer (username)
    const query = `(ai_log.consumer : "${username}")and ((cluster_id: ${gatewayId}) and (ai_log.api: "${apiIdentifier}"))| select sum(cast(json_extract(ai_log, '$.input_token') as integer)) as input_token, sum(cast(json_extract(ai_log, '$.output_token') as integer)) as output_token, sum(cast(json_extract(ai_log, '$.input_token') as integer)) + sum(cast(json_extract(ai_log, '$.output_token') as integer)) as total_token, count(1) as request`
    console.log('🔍 SLS Query (by username):', query)

    const request = new $Sls20201230.GetLogsRequest({
      type: 'log',
      from: getTodayStartTimestamp(),
      to: getCurrentTimestamp(),
      query
    })

    const response = await client.getLogs(projectName, 'apig-access-log', request)
    
    if (response.body && response.body.length > 0) {
      const item = response.body[0]
      return {
        inputToken: parseInt(item.input_token || '0', 10) || 0,
        outputToken: parseInt(item.output_token || '0', 10) || 0,
        totalToken: parseInt(item.total_token || '0', 10) || 0,
        requests: parseInt(item.request || '0', 10) || 0
      }
    }
    return { inputToken: 0, outputToken: 0, totalToken: 0, requests: 0 }
  } catch (error) {
    console.error('Failed to get today tokens by username:', error.message)
    return null
  }
}

/**
 * Get all dashboard statistics
 * @returns {Promise<{todayTokens: number, todayRequests: number, todayActiveUsers: number, slsEnabled: boolean}>}
 */
async function getDashboardStats() {
  const [projectName, apiIdentifier] = await Promise.all([
    getSlsProjectName(),
    getSlsApiIdentifier()
  ])
  
  if (!projectName || !apiIdentifier) {
    console.log('⚠️ SLS: getDashboardStats - Missing projectName or apiIdentifier, returning disabled state')
    return {
      todayTokens: 0,
      todayRequests: 0,
      todayActiveUsers: 0,
      aiGatewayEnabled: true,
      slsEnabled: false
    }
  }

  // Query all stats in parallel
  const [todayTokens, todayRequests, todayActiveUsers] = await Promise.all([
    getTodayTotalTokens(),
    getTodayTotalRequests(),
    getTodayActiveUsers()
  ])

  return {
    todayTokens,
    todayRequests,
    todayActiveUsers,
    aiGatewayEnabled: true,
    slsEnabled: true
  }
}

/**
 * Query SLS for last 30 days token consumption by consumer
 * @returns {Promise<Array<{consumer: string, totalToken: number}>>}
 */
async function get30DaysTokensByConsumer() {
  const [projectName, apiIdentifier] = await Promise.all([
    getSlsProjectName(),
    getSlsApiIdentifier()
  ])
  
  if (!projectName || !apiIdentifier) {
    return []
  }

  try {
    const client = createSlsClient()
    const gatewayId = getGatewayConfig().gatewayId

    const query = `(ai_log.consumer : *)and ((cluster_id: ${gatewayId}) and (ai_log.api: "${apiIdentifier}"))| select json_extract(ai_log, '$.consumer') as consumer, sum(cast(json_extract(ai_log, '$.input_token') as integer)) + sum(cast(json_extract(ai_log, '$.output_token') as integer)) as total_token group by consumer order by total_token desc`

    const request = new $Sls20201230.GetLogsRequest({
      type: 'log',
      from: get30DaysStartTimestamp(),
      to: getCurrentTimestamp(),
      query
    })

    const response = await client.getLogs(projectName, 'apig-access-log', request)
    
    if (response.body && response.body.length > 0) {
      return response.body.map(item => ({
        consumer: (item.consumer || '').replace(/^"|"$/g, ''),
        totalToken: parseInt(item.total_token || '0', 10)
      }))
    }
    return []
  } catch (error) {
    console.error('Failed to get 30 days tokens by consumer:', error.message)
    return []
  }
}

/**
 * Query SLS for last 30 days token consumption by username
 * @param {string} username
 * @returns {Promise<{totalToken: number} | null>}
 */
async function get30DaysTokensByUsername(username) {
  if (!username) return null

  const [projectName, apiIdentifier] = await Promise.all([
    getSlsProjectName(),
    getSlsApiIdentifier()
  ])
  
  if (!projectName || !apiIdentifier) {
    return null
  }

  try {
    const client = createSlsClient()
    const gatewayId = getGatewayConfig().gatewayId

    const query = `(ai_log.consumer : "${username}")and ((cluster_id: ${gatewayId}) and (ai_log.api: "${apiIdentifier}"))| select sum(cast(json_extract(ai_log, '$.input_token') as integer)) + sum(cast(json_extract(ai_log, '$.output_token') as integer)) as total_token`

    const request = new $Sls20201230.GetLogsRequest({
      type: 'log',
      from: get30DaysStartTimestamp(),
      to: getCurrentTimestamp(),
      query
    })

    const response = await client.getLogs(projectName, 'apig-access-log', request)
    
    if (response.body && response.body.length > 0) {
      const totalToken = parseInt(response.body[0].total_token || '0', 10)
      return { totalToken: isNaN(totalToken) ? 0 : totalToken }
    }
    return { totalToken: 0 }
  } catch (error) {
    console.error('Failed to get 30 days tokens by username:', error.message)
    return null
  }
}

export {
  getSlsProjectName,
  getTodayTotalRequests,
  getTodayTotalTokens,
  getTodayActiveUsers,
  getTodayTokensByConsumer,
  getTodayTokensByUsername,
  get30DaysTokensByConsumer,
  get30DaysTokensByUsername,
  getDashboardStats,
  invalidateSlsCache
}
