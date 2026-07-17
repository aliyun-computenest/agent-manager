/**
 * APIG (Alibaba Cloud API Gateway) Service
 * Handles AI Gateway consumer creation and management
 * All config is read from gateway-config service (stored in provider_config table)
 */

import _Apig20240327, * as $Apig20240327 from '@alicloud/apig20240327'
const Apig20240327 = _Apig20240327.default || _Apig20240327
import _OpenApi, * as $OpenApi from '@alicloud/openapi-client'
const OpenApiClient = _OpenApi.default || _OpenApi
import _OpenApiUtil from '@alicloud/openapi-util'
const OpenApiUtil = _OpenApiUtil.default || _OpenApiUtil
import * as $Util from '@alicloud/tea-util'
import { getGatewayConfig } from './gateway-config.js'

/**
 * Create Alibaba Cloud APIG Client
 */
function createApigClient() {
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
    endpoint: `apig.${regionId}.aliyuncs.com`
  })

  return new Apig20240327(config)
}

/**
 * Get HTTP API details including policy configs
 * @param {string} httpApiId - The HTTP API ID
 * @returns {Promise<object>} HTTP API details
 */
async function getHttpApi(httpApiId) {
  const client = createApigClient()
  
  console.log(`📊 Getting HTTP API details: ${httpApiId}`)
  
  // SDK may not export GetHttpApiRequest as a constructor, pass empty object directly
  const response = await client.getHttpApi(httpApiId, {})
  
  if (!response.body?.data) {
    throw new Error('Failed to get HTTP API details')
  }
  
  return response.body.data
}

/**
 * Fetch HTTP API details using provided credentials (for configuration validation)
 * Extracts environmentId and gatewayDomain from the API response
 * @param {object} params - Parameters
 * @param {string} params.httpApiId - The HTTP API ID
 * @param {string} params.accessKeyId - Alibaba Cloud Access Key ID
 * @param {string} params.accessKeySecret - Alibaba Cloud Access Key Secret
 * @param {string} params.regionId - Region ID (e.g., 'cn-hangzhou')
 * @returns {Promise<{environmentId: string, gatewayDomain: string}>}
 */
async function fetchHttpApiDetailsWithCredentials({ httpApiId, accessKeyId, accessKeySecret, regionId }) {
  if (!httpApiId || !accessKeyId || !accessKeySecret || !regionId) {
    throw new Error('Missing required parameters: httpApiId, accessKeyId, accessKeySecret, regionId')
  }

  const config = new $OpenApi.Config({
    accessKeyId,
    accessKeySecret,
    endpoint: `apig.${regionId}.aliyuncs.com`
  })

  const client = new Apig20240327(config)
  
  console.log(`📊 Fetching HTTP API details for auto-config: ${httpApiId}`)
  
  const response = await client.getHttpApi(httpApiId, {})
  
  if (!response.body?.data) {
    throw new Error('Failed to get HTTP API details')
  }

  const data = response.body.data

  // Extract environmentId from deployConfigs or environments
  let environmentId = ''
  if (data.deployConfigs && data.deployConfigs.length > 0) {
    environmentId = data.deployConfigs[0].environmentId || ''
  } else if (data.environments && data.environments.length > 0) {
    environmentId = data.environments[0].environmentId || ''
  }

  // Extract gatewayDomain from subDomains (prefer Internet networkType)
  let gatewayDomain = ''
  let subDomains = []
  
  if (data.deployConfigs && data.deployConfigs.length > 0 && data.deployConfigs[0].subDomains) {
    subDomains = data.deployConfigs[0].subDomains
  } else if (data.environments && data.environments.length > 0 && data.environments[0].subDomains) {
    subDomains = data.environments[0].subDomains
  }

  // Find Internet domain first, fallback to first available
  const internetDomain = subDomains.find(d => d.networkType === 'Internet')
  if (internetDomain) {
    gatewayDomain = internetDomain.name || ''
  } else if (subDomains.length > 0) {
    gatewayDomain = subDomains[0].name || ''
  }

  console.log(`   Auto-detected: environmentId=${environmentId}, gatewayDomain=${gatewayDomain}`)

  return { environmentId, gatewayDomain }
}

/**
 * Create a generic OpenAPI client for raw API calls
 */
function createGenericClient() {
  const gwConfig = getGatewayConfig()
  const akId = gwConfig.aliyunAccessKeyId || ''
  const akSecret = gwConfig.aliyunAccessKeySecret || ''
  const regionId = gwConfig.regionId || 'cn-hangzhou'

  const config = new $OpenApi.Config({
    accessKeyId: akId,
    accessKeySecret: akSecret,
    endpoint: `apig.${regionId}.aliyuncs.com`
  })

  return new OpenApiClient(config)
}

/**
 * Update HTTP API with new configuration
 * Uses generic OpenAPI client to bypass SDK validate() requirement
 * @param {string} httpApiId - The HTTP API ID
 * @param {object} content - The update content object (fields like type, basePath, deployConfigs, etc.)
 * @returns {Promise<object>} Update result
 */
async function updateHttpApi(httpApiId, content) {
  const client = createGenericClient()
  
  console.log(`📝 Updating HTTP API: ${httpApiId}`)
  
  // The API expects individual fields (type, basePath, deployConfigs, etc.) as direct body fields
  // NOT wrapped in a { content: "..." } envelope
  const bodyObj = typeof content === 'string' ? JSON.parse(content) : content
  
  // Use generic callApi to bypass SDK's validate() requirement
  const params = new $OpenApi.Params({
    action: 'UpdateHttpApi',
    version: '2024-03-27',
    protocol: 'HTTPS',
    method: 'PUT',
    authType: 'AK',
    style: 'ROA',
    pathname: `/v1/http-apis/${httpApiId}`,
    reqBodyType: 'json',
    bodyType: 'json'
  })

  const request = new $OpenApi.OpenApiRequest({
    body: bodyObj
  })

  const runtime = new $Util.RuntimeOptions({})

  const response = await client.callApi(params, request, runtime)
  
  return response?.body
}

/**
 * Get current token rate limit configuration
 * @returns {Promise<{enabled: boolean, dailyTokenLimit: number}>}
 */
async function getTokenRateLimitConfig() {
  const gwConfig = getGatewayConfig()
  
  if (!gwConfig.httpApiId) {
    return { enabled: false, dailyTokenLimit: 0, monthlyTokenLimit: 0 }
  }

  try {
    const httpApiData = await getHttpApi(gwConfig.httpApiId)
    
    // Find AiTokenRateLimit policy in deployConfigs
    const deployConfig = httpApiData.deployConfigs?.[0]
    if (!deployConfig?.policyConfigs) {
      return { enabled: false, dailyTokenLimit: 0, monthlyTokenLimit: 0 }
    }

    const tokenRateLimitPolicy = deployConfig.policyConfigs.find(
      (p) => p.type === 'AiTokenRateLimit'
    )

    if (!tokenRateLimitPolicy || !tokenRateLimitPolicy.enable) {
      return { enabled: false, dailyTokenLimit: 0, monthlyTokenLimit: 0 }
    }

    // Find the global token limit rules
    const rules = tokenRateLimitPolicy.aiTokenRateLimitConfig?.rules || []
    const globalDailyRule = rules.find(
      (r) => r.limitType === 'Consumer' && r.matchType === 'All' && r.limitMode === 'TokenPerDay'
    )
    const globalMonthlyRule = rules.find(
      (r) => r.limitType === 'Consumer' && r.matchType === 'All' && r.limitMode === 'TokenPerMonth'
    )

    return {
      enabled: true,
      dailyTokenLimit: globalDailyRule?.limitValue || 0,
      monthlyTokenLimit: globalMonthlyRule?.limitValue || 0
    }
  } catch (error) {
    console.error('Failed to get token rate limit config:', error.message)
    return { enabled: false, dailyTokenLimit: 0, monthlyTokenLimit: 0 }
  }
}

/**
 * Update token rate limit configuration for all consumers
 * @param {number} dailyTokenLimit - Daily token limit per consumer (0 to disable)
 * @param {number} monthlyTokenLimit - Monthly (30-day) token limit per consumer (0 to disable)
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function updateTokenRateLimitConfig(dailyTokenLimit, monthlyTokenLimit = 0) {
  const gwConfig = getGatewayConfig()
  
  if (!gwConfig.httpApiId) {
    throw new Error('HTTP API ID not configured')
  }

  try {
    // Step 1: Get current HTTP API configuration
    const httpApiData = await getHttpApi(gwConfig.httpApiId)
    
    if (!httpApiData.deployConfigs || httpApiData.deployConfigs.length === 0) {
      throw new Error('No deploy configs found')
    }

    // Step 2: Build the update content, only modifying the AiTokenRateLimit policy
    const deployConfig = httpApiData.deployConfigs[0]
    const policyConfigs = deployConfig.policyConfigs || []
    
    // Find or create AiTokenRateLimit policy
    let tokenRateLimitPolicyIndex = policyConfigs.findIndex(
      (p) => p.type === 'AiTokenRateLimit'
    )
    
    // Get existing rules (except global daily/monthly rules)
    let existingRules = []
    if (tokenRateLimitPolicyIndex >= 0) {
      const existingPolicy = policyConfigs[tokenRateLimitPolicyIndex]
      existingRules = (existingPolicy.aiTokenRateLimitConfig?.rules || []).filter(
        (r) => !(r.limitType === 'Consumer' && r.matchType === 'All' && 
                 (r.limitMode === 'TokenPerDay' || r.limitMode === 'TokenPerMonth'))
      )
    }

    // Build new rules array
    const newRules = [...existingRules]
    
    // Add global daily token limit rule if dailyTokenLimit > 0
    if (dailyTokenLimit > 0) {
      newRules.push({
        limitType: 'Consumer',
        matchType: 'All',
        limitMode: 'TokenPerDay',
        matchKey: '',
        limitValue: dailyTokenLimit
      })
    }

    // Add global monthly token limit rule if monthlyTokenLimit > 0
    if (monthlyTokenLimit > 0) {
      newRules.push({
        limitType: 'Consumer',
        matchType: 'All',
        limitMode: 'TokenPerMonth',
        matchKey: '',
        limitValue: monthlyTokenLimit
      })
    }

    // Build new AiTokenRateLimit policy
    const newTokenRateLimitPolicy = {
      type: 'AiTokenRateLimit',
      enable: newRules.length > 0,
      aiTokenRateLimitConfig: {
        rules: newRules,
        enableGlobalRules: false
      }
    }

    // Update or add policy
    const updatedPolicyConfigs = [...policyConfigs]
    if (tokenRateLimitPolicyIndex >= 0) {
      updatedPolicyConfigs[tokenRateLimitPolicyIndex] = newTokenRateLimitPolicy
    } else {
      updatedPolicyConfigs.push(newTokenRateLimitPolicy)
    }

    // Build the minimal update content
    // NOTE: Do NOT include domain-related fields (customDomainIds, customDomainInfos, subDomains, envDomainIds)
    // to avoid accidentally clearing bound access domains when only updating policy configs
    const updateContent = {
      type: httpApiData.type || 'LLM',
      basePath: httpApiData.basePath || '/',
      deployConfigs: [{
        backendScene: deployConfig.backendScene || 'SingleService',
        environmentId: deployConfig.environmentId,
        gatewayType: deployConfig.gatewayType || 'AI',
        serviceConfigs: deployConfig.serviceConfigs || [],
        autoDeploy: deployConfig.autoDeploy !== false,
        gatewayInfo: deployConfig.gatewayInfo,
        policyConfigs: updatedPolicyConfigs,
        gatewayId: deployConfig.gatewayId || gwConfig.gatewayId
      }],
      aiProtocols: httpApiData.aiProtocols || ['OpenAI/v1'],
      enableAuth: httpApiData.enableAuth !== false,
      authConfig: httpApiData.authConfig || { authMode: 'Custom', authType: 'Apikey' },
      onlyChangeConfig: true  // Important: only update config, don't redeploy
    }

    // Step 3: Update HTTP API
    await updateHttpApi(gwConfig.httpApiId, updateContent)

    // Build result message
    const messages = []
    if (dailyTokenLimit > 0) {
      messages.push(`每日上限 ${dailyTokenLimit.toLocaleString()} tokens`)
    }
    if (monthlyTokenLimit > 0) {
      messages.push(`每30天上限 ${monthlyTokenLimit.toLocaleString()} tokens`)
    }
    const summaryMsg = messages.length > 0 ? messages.join('，') : '已禁用所有 Token 限制'
    
    console.log(`✅ Token rate limit updated: daily=${dailyTokenLimit}, monthly=${monthlyTokenLimit}`)
    
    return {
      success: true,
      message: messages.length > 0 
        ? `已设置每用户 Token 限流：${summaryMsg}`
        : '已禁用所有 Token 限制'
    }
  } catch (error) {
    console.error('Failed to update token rate limit config:', error)
    throw error
  }
}

/**
 * Create APIG Consumer for a user
 * @param {string} email - The user email for the consumer
 * @returns {Promise<{consumerId: string, apikey: string}>}
 */
async function createApigConsumer(email) {
  const gwConfig = getGatewayConfig()

  if (!gwConfig.gatewayId || !gwConfig.httpApiId || !gwConfig.environmentId) {
    throw new Error('AI Gateway configuration incomplete')
  }

  const client = createApigClient()

  // Sanitize email to valid consumer name
  const consumerName = sanitizeConsumerName(email)

  // Step 1: Create Consumer
  console.log(`🔐 Creating APIG Consumer for user: ${email} (name: ${consumerName})`)

  // Build nested config objects using SDK classes
  const apikeySource = new $Apig20240327.ApiKeyIdentityConfigApikeySource({
    source: 'Default',
    value: 'Authorization'
  })

  const apikeyCredentials = [new $Apig20240327.ApiKeyIdentityConfigCredentials({
    generateMode: 'System'
  })]

  const apikeyIdentityConfig = new $Apig20240327.ApiKeyIdentityConfig({
    type: 'Apikey',
    apikeySource: apikeySource,
    credentials: apikeyCredentials
  })

  const createConsumerRequest = new $Apig20240327.CreateConsumerRequest({
    name: consumerName,
    enable: true,
    gatewayType: 'AI',
    apikeyIdentityConfig: apikeyIdentityConfig
  })

  let consumerId

  try {
    const createConsumerResponse = await client.createConsumer(createConsumerRequest)

    if (!createConsumerResponse.body?.data?.consumerId) {
      throw new Error('Failed to create consumer: no consumerId returned')
    }

    consumerId = createConsumerResponse.body.data.consumerId
    console.log(`   Consumer created: ${consumerId}`)
  } catch (createError) {
    // Handle duplicate consumer name (409 Conflict) - find existing consumer
    if (createError.code === 'Conflict.ConsumerNameDuplicate' || createError.statusCode === 409) {
      console.log(`   ⚠️ Consumer name "${consumerName}" already exists, looking up existing consumer...`)
      
      const listRequest = new $Apig20240327.ListConsumersRequest({
        nameLike: consumerName,
        gatewayType: 'AI',
        pageNumber: 1,
        pageSize: 10
      })
      const listResponse = await client.listConsumers(listRequest)
      const existing = listResponse.body?.data?.items?.find(c => c.name === consumerName)
      
      if (!existing?.consumerId) {
        throw new Error(`Consumer "${consumerName}" exists but could not be found via list API`)
      }
      
      consumerId = existing.consumerId
      console.log(`   Found existing consumer: ${consumerId}`)
    } else {
      throw createError
    }
  }

  // Step 2: Create Authorization Rules
  console.log(`🔐 Creating authorization rules for consumer: ${consumerId}`)

  const createAuthRulesRequest = new $Apig20240327.CreateConsumerAuthorizationRulesRequest({
    authorizationRules: [{
      consumerId: consumerId,
      resourceType: 'LLM',
      resourceIdentifier: {
        resourceId: gwConfig.httpApiId,
        environmentId: gwConfig.environmentId
      },
      expireMode: 'LongTerm'
    }]
  })

  try {
    await client.createConsumerAuthorizationRules(createAuthRulesRequest)
    console.log(`   Authorization rules created`)
  } catch (authError) {
    // Consumer already authorized to this resource — safe to skip
    if (authError.code === 'Conflict.ConsumerAuthorizationForbidden' || authError.statusCode === 409) {
      console.log(`   ⚠️ Consumer ${consumerId} already authorized to resource ${gwConfig.httpApiId}, skipping`)
    } else {
      throw authError
    }
  }

  // Step 3: Get Consumer to retrieve API Key
  console.log(`🔐 Retrieving API Key for consumer: ${consumerId}`)

  const getConsumerResponse = await client.getConsumer(consumerId)

  const credentials = getConsumerResponse.body?.data?.apiKeyIdentityConfig?.credentials
  if (!credentials || credentials.length === 0) {
    throw new Error('Failed to get consumer API key')
  }

  const apikey = credentials[0].apikey
  console.log(`   API Key retrieved successfully`)

  return { consumerId, apikey, httpApiId: gwConfig.httpApiId }
}

/**
 * Re-authorize an existing Consumer for the current HTTP API
 * Used when admin changes the AI Gateway HTTP API server
 * @param {string} consumerId - Existing consumer ID
 * @returns {Promise<{httpApiId: string}>}
 */
async function reauthorizeConsumer(consumerId) {
  const gwConfig = getGatewayConfig()

  if (!gwConfig.httpApiId || !gwConfig.environmentId) {
    throw new Error('AI Gateway configuration incomplete (httpApiId or environmentId missing)')
  }

  const client = createApigClient()

  console.log(`🔐 Re-authorizing consumer ${consumerId} for HTTP API: ${gwConfig.httpApiId}`)

  const createAuthRulesRequest = new $Apig20240327.CreateConsumerAuthorizationRulesRequest({
    authorizationRules: [{
      consumerId: consumerId,
      resourceType: 'LLM',
      resourceIdentifier: {
        resourceId: gwConfig.httpApiId,
        environmentId: gwConfig.environmentId
      },
      expireMode: 'LongTerm'
    }]
  })

  try {
    await client.createConsumerAuthorizationRules(createAuthRulesRequest)
    console.log(`   ✅ Authorization rules updated for consumer: ${consumerId}`)
  } catch (authError) {
    if (authError.code === 'Conflict.ConsumerAuthorizationForbidden' || authError.statusCode === 409) {
      console.log(`   ⚠️ Consumer ${consumerId} already authorized to resource ${gwConfig.httpApiId}, skipping`)
    } else {
      throw authError
    }
  }

  return { httpApiId: gwConfig.httpApiId }
}

/**
 * Sanitize email to a valid consumer name.
 * Rules: only [a-zA-Z0-9.\-], must start/end with alphanumeric, length 2-64.
 * @param {string} email - user email address
 * @returns {string}
 */
function sanitizeConsumerName(email) {
  // Step 1: replace @ with dot, replace all other invalid chars with dash
  let name = email.replace(/@/g, '.').replace(/[^a-zA-Z0-9.\-]/g, '-')
  // Step 2: strip leading/trailing non-alphanumeric chars (dots, dashes)
  name = name.replace(/^[^a-zA-Z0-9]+/, '').replace(/[^a-zA-Z0-9]+$/, '')
  // Step 3: collapse consecutive dots/dashes into a single one
  name = name.replace(/([.\-]){2,}/g, '$1')
  // Step 4: truncate to 64 characters, then re-trim trailing non-alphanumeric
  if (name.length > 64) {
    name = name.slice(0, 64).replace(/[^a-zA-Z0-9]+$/, '')
  }
  // Step 5: ensure minimum length of 2
  if (name.length < 2) {
    name = name.padEnd(2, '0')
  }
  return name
}

/**
 * Get per-user token rate limit configuration from AiTokenRateLimit policy
 * @param {string} consumerName - The consumer name (sanitized username)
 * @returns {Promise<{dailyTokenLimit: number, monthlyTokenLimit: number}>}
 */
async function getUserTokenRateLimitConfig(consumerName) {
  const gwConfig = getGatewayConfig()
  
  if (!gwConfig.httpApiId) {
    return { dailyTokenLimit: 0, monthlyTokenLimit: 0 }
  }

  try {
    const httpApiData = await getHttpApi(gwConfig.httpApiId)
    
    const deployConfig = httpApiData.deployConfigs?.[0]
    if (!deployConfig?.policyConfigs) {
      return { dailyTokenLimit: 0, monthlyTokenLimit: 0 }
    }

    const tokenRateLimitPolicy = deployConfig.policyConfigs.find(
      (p) => p.type === 'AiTokenRateLimit'
    )

    if (!tokenRateLimitPolicy || !tokenRateLimitPolicy.enable) {
      return { dailyTokenLimit: 0, monthlyTokenLimit: 0 }
    }

    const rules = tokenRateLimitPolicy.aiTokenRateLimitConfig?.rules || []
    
    const userDailyRule = rules.find(
      (r) => r.limitType === 'Consumer' && r.matchType === 'Exact' && 
             r.matchValue === consumerName && r.limitMode === 'TokenPerDay'
    )
    const userMonthlyRule = rules.find(
      (r) => r.limitType === 'Consumer' && r.matchType === 'Exact' && 
             r.matchValue === consumerName && r.limitMode === 'TokenPerMonth'
    )

    return {
      dailyTokenLimit: userDailyRule?.limitValue || 0,
      monthlyTokenLimit: userMonthlyRule?.limitValue || 0
    }
  } catch (error) {
    console.error(`Failed to get user token rate limit for ${consumerName}:`, error.message)
    return { dailyTokenLimit: 0, monthlyTokenLimit: 0 }
  }
}

/**
 * Update per-user token rate limit configuration
 * @param {string} consumerName - The consumer name (sanitized username)
 * @param {number} dailyTokenLimit - Daily token limit (0 to remove)
 * @param {number} monthlyTokenLimit - Monthly token limit (0 to remove)
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function updateUserTokenRateLimitConfig(consumerName, dailyTokenLimit, monthlyTokenLimit) {
  const gwConfig = getGatewayConfig()
  
  if (!gwConfig.httpApiId) {
    throw new Error('HTTP API ID not configured')
  }

  try {
    const httpApiData = await getHttpApi(gwConfig.httpApiId)
    
    if (!httpApiData.deployConfigs || httpApiData.deployConfigs.length === 0) {
      throw new Error('No deploy configs found')
    }

    const deployConfig = httpApiData.deployConfigs[0]
    const policyConfigs = deployConfig.policyConfigs || []
    
    let tokenRateLimitPolicyIndex = policyConfigs.findIndex(
      (p) => p.type === 'AiTokenRateLimit'
    )
    
    // Get existing rules, excluding this user's Exact rules
    let existingRules = []
    if (tokenRateLimitPolicyIndex >= 0) {
      const existingPolicy = policyConfigs[tokenRateLimitPolicyIndex]
      existingRules = (existingPolicy.aiTokenRateLimitConfig?.rules || []).filter(
        (r) => !(r.limitType === 'Consumer' && r.matchType === 'Exact' && 
                 r.matchValue === consumerName &&
                 (r.limitMode === 'TokenPerDay' || r.limitMode === 'TokenPerMonth'))
      )
    }

    const newRules = [...existingRules]
    
    if (dailyTokenLimit > 0) {
      newRules.push({
        limitType: 'Consumer',
        matchType: 'Exact',
        limitMode: 'TokenPerDay',
        matchKey: '',
        matchValue: consumerName,
        limitValue: dailyTokenLimit
      })
    }

    if (monthlyTokenLimit > 0) {
      newRules.push({
        limitType: 'Consumer',
        matchType: 'Exact',
        limitMode: 'TokenPerMonth',
        matchKey: '',
        matchValue: consumerName,
        limitValue: monthlyTokenLimit
      })
    }

    const newTokenRateLimitPolicy = {
      type: 'AiTokenRateLimit',
      enable: newRules.length > 0,
      aiTokenRateLimitConfig: {
        rules: newRules,
        enableGlobalRules: false
      }
    }

    const updatedPolicyConfigs = [...policyConfigs]
    if (tokenRateLimitPolicyIndex >= 0) {
      updatedPolicyConfigs[tokenRateLimitPolicyIndex] = newTokenRateLimitPolicy
    } else {
      updatedPolicyConfigs.push(newTokenRateLimitPolicy)
    }

    // NOTE: Do NOT include domain-related fields (customDomainIds, customDomainInfos, subDomains, envDomainIds)
    // to avoid accidentally clearing bound access domains when only updating policy configs
    const updateContent = {
      type: httpApiData.type || 'LLM',
      basePath: httpApiData.basePath || '/',
      deployConfigs: [{
        backendScene: deployConfig.backendScene || 'SingleService',
        environmentId: deployConfig.environmentId,
        gatewayType: deployConfig.gatewayType || 'AI',
        serviceConfigs: deployConfig.serviceConfigs || [],
        autoDeploy: deployConfig.autoDeploy !== false,
        gatewayInfo: deployConfig.gatewayInfo,
        policyConfigs: updatedPolicyConfigs,
        gatewayId: deployConfig.gatewayId || gwConfig.gatewayId
      }],
      aiProtocols: httpApiData.aiProtocols || ['OpenAI/v1'],
      enableAuth: httpApiData.enableAuth !== false,
      authConfig: httpApiData.authConfig || { authMode: 'Custom', authType: 'Apikey' },
      onlyChangeConfig: true
    }

    await updateHttpApi(gwConfig.httpApiId, updateContent)

    const messages = []
    if (dailyTokenLimit > 0) {
      messages.push(`每日 ${dailyTokenLimit.toLocaleString()} tokens`)
    }
    if (monthlyTokenLimit > 0) {
      messages.push(`每30天 ${monthlyTokenLimit.toLocaleString()} tokens`)
    }

    console.log(`✅ User token rate limit updated for ${consumerName}: daily=${dailyTokenLimit}, monthly=${monthlyTokenLimit}`)
    
    return {
      success: true,
      message: messages.length > 0
        ? `已为 ${consumerName} 设置 Token 限流：${messages.join('，')}`
        : `已移除 ${consumerName} 的个人 Token 限流`
    }
  } catch (error) {
    console.error(`Failed to update user token rate limit for ${consumerName}:`, error)
    throw error
  }
}

export {
  createApigClient,
  createApigConsumer,
  reauthorizeConsumer,
  getHttpApi,
  fetchHttpApiDetailsWithCredentials,
  updateHttpApi,
  getTokenRateLimitConfig,
  updateTokenRateLimitConfig,
  getUserTokenRateLimitConfig,
  updateUserTokenRateLimitConfig,
  sanitizeConsumerName
}
