/**
 * Alibaba Cloud AI Gateway Provider Class
 * Full-featured provider with consumer management, token limits, and statistics
 */

import { BaseProvider } from './BaseProvider.js'
import { supabaseAdmin } from '../../config/index.js'
import { encryptApiKey, decryptApiKey, maskApiKey } from '../../utils/crypto.js'
import { Budget, BudgetTimeRate, BudgetUnit, BudgetList } from './budget.js'
import {
  getTokenRateLimitConfig,
  updateTokenRateLimitConfig,
  getUserTokenRateLimitConfig,
  updateUserTokenRateLimitConfig,
  createApigConsumer,
  reauthorizeConsumer
} from '../apig.js'
import {
  getDashboardStats,
  getTodayTokensByConsumer,
  get30DaysTokensByConsumer,
  getTodayTokensByUsername,
  get30DaysTokensByUsername
} from '../sls.js'
import { loadGatewayConfig } from '../gateway-config.js'

export class AlibabaCloudAIGatewayProvider extends BaseProvider {
  /**
   * @param {object} config - Provider configuration
   * @param {string} name - Provider name
   */
  constructor(config, name) {
    super(config, name)
  }

  /**
   * Get provider type
   * @returns {string}
   */
  getType() {
    return 'AlibabaCloudAIGateway'
  }

  /**
   * Get provider configuration
   * @returns {Promise<object>}
   */
  async getConfig() {
    const config = await this._loadConfigFromDB()
    
    return {
      name: this.name,
      type: this.getType(),
      // Gateway infrastructure config
      regionId: config.regionId || 'cn-hangzhou',
      gatewayId: config.gatewayId || '',
      httpApiId: config.httpApiId || '',
      environmentId: config.environmentId || '',
      gatewayDomain: config.gatewayDomain || '',
      // Placeholders
      apiKeyPlaceholder: config.apiKeyPlaceholder || '${CONSUMER_API_KEY}',
      domainPlaceholder: config.domainPlaceholder || '${AI_GATEWAY_DOMAIN}',
      // Aliyun credentials (masked, keep original field names)
      aliyunAccessKeyId: maskApiKey(config.aliyunAccessKeyId),
      aliyunAccessKeySecret: maskApiKey(config.aliyunAccessKeySecret),
      hasCredentials: !!(config.aliyunAccessKeyId && config.aliyunAccessKeySecret),
      // DashScope API key (masked, keep original field name)
      dashscopeApiKey: maskApiKey(config.dashscopeApiKey),
      hasDashscopeApiKey: !!config.dashscopeApiKey
    }
  }

  async _getCredentialDetail({ isEnabled } = {}) {
    const config = await this._loadConfigFromDB()
    return {
      apiKey: maskApiKey(config.aliyunAccessKeyId),
      hasApiKey: !!(config.aliyunAccessKeyId && config.aliyunAccessKeySecret),
      gatewayConfig: {
        gatewayId: config.gatewayId || '',
        httpApiId: config.httpApiId || '',
        environmentId: config.environmentId || '',
        regionId: config.regionId || 'cn-hangzhou',
        gatewayDomain: config.gatewayDomain || '',
        enabled: isEnabled
      }
    }
  }

  /**
   * Update provider configuration
   * @param {object} updates - Configuration updates
   * @returns {Promise<object>}
   */
  async updateConfig(updates) {
    const existing = await this._loadConfigFromDB()
    const configUpdates = { ...existing }

    // Update gateway infrastructure config
    if (updates.regionId !== undefined) configUpdates.regionId = updates.regionId
    if (updates.gatewayId !== undefined) configUpdates.gatewayId = updates.gatewayId
    if (updates.httpApiId !== undefined) configUpdates.httpApiId = updates.httpApiId
    if (updates.environmentId !== undefined) configUpdates.environmentId = updates.environmentId
    if (updates.gatewayDomain !== undefined) configUpdates.gatewayDomain = updates.gatewayDomain
    if (updates.apiKeyPlaceholder !== undefined) configUpdates.apiKeyPlaceholder = updates.apiKeyPlaceholder
    if (updates.domainPlaceholder !== undefined) configUpdates.domainPlaceholder = updates.domainPlaceholder

    // Update credentials (plaintext values from user input)
    if (updates.aliyunAccessKeyId !== undefined) {
      configUpdates.aliyunAccessKeyId = updates.aliyunAccessKeyId || null
    }
    if (updates.aliyunAccessKeySecret !== undefined) {
      configUpdates.aliyunAccessKeySecret = updates.aliyunAccessKeySecret || null
    }
    if (updates.dashscopeApiKey !== undefined) {
      configUpdates.dashscopeApiKey = updates.dashscopeApiKey || null
    }

    // Encrypt ALL sensitive fields before saving to DB
    // (configUpdates contains decrypted values from _loadConfigFromDB + new plaintext values)
    const sensitiveFields = ['dashscopeApiKey', 'aliyunAccessKeyId', 'aliyunAccessKeySecret']
    for (const field of sensitiveFields) {
      if (configUpdates[field]) {
        configUpdates[field] = encryptApiKey(configUpdates[field])
      }
    }

    // Save to database
    const { error } = await supabaseAdmin
      .from('provider_config')
      .upsert({
        name: this.name,
        type: this.getType(),
        config: configUpdates,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'name'
      })

    if (error) {
      throw new Error(`Failed to update provider config: ${error.message}`)
    }

    // Refresh gateway-config.js in-memory cache so that apig.js/sls.js get updated values
    await loadGatewayConfig()

    // Update local config
    this.config = await this._loadConfigFromDB()

    return this.getConfig()
  }

  /**
   * Get API key for model access
   * @returns {Promise<string>}
   */
  async getApiKey() {
    // For AI Gateway, return the DashScope API key
    const config = await this._loadConfigFromDB()
    if (!config.dashscopeApiKey) {
      throw new Error(`DashScope API key not configured for provider: ${this.name}`)
    }
    return decryptApiKey(config.dashscopeApiKey)
  }

  /**
   * Validate provider configuration
   * @returns {Promise<{valid: boolean, errors: string[]}>}
   */
  async validateConfig() {
    const config = await this._loadConfigFromDB()
    const errors = []

    if (!config.gatewayId) errors.push('Gateway ID is required')
    if (!config.httpApiId) errors.push('HTTP API ID is required')
    if (!config.environmentId || config.environmentId.trim() === '') errors.push('Environment ID is required')
    if (!config.gatewayDomain || config.gatewayDomain.trim() === '') errors.push('Gateway domain is required')
    if (!config.aliyunAccessKeyId) errors.push('Aliyun AccessKey ID is required')
    if (!config.aliyunAccessKeySecret) errors.push('Aliyun AccessKey Secret is required')

    return {
      valid: errors.length === 0,
      errors
    }
  }

  // ========== Limit Configuration ==========

  /**
   * Check if provider supports limit configuration
   * @returns {boolean}
   */
  supportsLimitConfig() {
    return true
  }

  /**
   * Get token rate limit configuration from APIG
   * @private
   * @returns {Promise<{enabled: boolean, dailyTokenLimit: number, monthlyTokenLimit: number}>}
   */
  async _getTokenRateLimit() {
    return getTokenRateLimitConfig()
  }

  /**
   * Update token rate limit configuration via APIG
   * @private
   * @param {number} dailyTokenLimit
   * @param {number} monthlyTokenLimit
   * @returns {Promise<{success: boolean, message: string}>}
   */
  async _updateTokenRateLimit(dailyTokenLimit, monthlyTokenLimit) {
    return updateTokenRateLimitConfig(dailyTokenLimit, monthlyTokenLimit)
  }

  // ========== Statistics Features ==========

  /**
   * Check if provider supports usage statistics
   * @returns {boolean}
   */
  supportsStats() {
    return true
  }

  /**
   * Get provider statistics
   * @returns {Promise<object>}
   */
  async getStats() {
    return getDashboardStats()
  }

  /**
   * Get usage by consumer
   * @param {number} days - Number of days (1 or 30)
   * @returns {Promise<Array<{consumer: string, value: number, unit: string}>>}
   */
  async getUsageByConsumer(days = 1) {
    const raw = days === 30
      ? await get30DaysTokensByConsumer()
      : await getTodayTokensByConsumer()
    return (raw || []).map(item => ({
      ...item,
      value: item.totalToken,
      unit: BudgetUnit.TOKEN,
      type: item.type || 'user'
    }))
  }

  /**
   * Get usage for a specific user
   * @param {string} identifier - Sanitized consumer name (email-based)
   * @param {number} days - Number of days (1 or 30)
   * @returns {Promise<{value: number, unit: string}|null>}
   */
  async getUserUsage(identifier, days = 1) {
    const consumerName = this._sanitizeConsumerName(identifier)
    if (days === 30) {
      const result = await get30DaysTokensByUsername(consumerName)
      return result ? { value: result.totalToken, unit: BudgetUnit.TOKEN } : null
    }
    const result = await getTodayTokensByUsername(consumerName)
    return result ? { value: result.totalToken, unit: BudgetUnit.TOKEN } : null
  }

  // ========== Consumer Management Features ==========

  /**
   * Check if provider supports consumer management
   * @returns {boolean}
   */
  supportsConsumerManagement() {
    return true
  }

  /**
   * Create a consumer for the provider
   * @param {string} email - User email
   * @returns {Promise<{consumerId: string, apikey: string}>}
   */
  async createConsumer(email) {
    return createApigConsumer(email)
  }

  /**
   * Reauthorize an existing consumer
   * @param {string} consumerId - Consumer ID
   * @returns {Promise<{httpApiId: string}>}
   */
  async reauthorizeConsumer(consumerId) {
    return reauthorizeConsumer(consumerId)
  }

  /**
   * Get per-user budget limit
   * @param {string} identifier - Consumer name
   * @returns {Promise<Array<{value: number, unit: string, timeRate: string}>>}
   */
  async getUserBudgetLimit(identifier) {
    const config = await getUserTokenRateLimitConfig(identifier)
    const budgets = []
    if (config.dailyTokenLimit > 0) {
      budgets.push({ value: config.dailyTokenLimit, unit: BudgetUnit.TOKEN, timeRate: BudgetTimeRate.DAILY })
    }
    if (config.monthlyTokenLimit > 0) {
      budgets.push({ value: config.monthlyTokenLimit, unit: BudgetUnit.TOKEN, timeRate: BudgetTimeRate.MONTHLY })
    }
    return budgets
  }

  /**
   * Update per-user token rate limit via APIG
   * @private
   * @param {string} consumerName - Consumer name
   * @param {number} dailyTokenLimit
   * @param {number} monthlyTokenLimit
   * @returns {Promise<{success: boolean, message: string}>}
   */
  async _updateUserTokenRateLimit(consumerName, dailyTokenLimit, monthlyTokenLimit) {
    return updateUserTokenRateLimitConfig(consumerName, dailyTokenLimit, monthlyTokenLimit)
  }

  // ========== Budget-based Limit Management ==========

  /**
   * 获取限额配置 — 从 APIG API 实时获取，转换为 Budget[]
   * @returns {Promise<{ enabled: boolean, budgets: Array }>}
   */
  async getLimitConfig() {
    const config = await this._getTokenRateLimit()
    const budgets = []
    if (config.dailyTokenLimit > 0) {
      budgets.push(new Budget(BudgetTimeRate.DAILY, config.dailyTokenLimit, BudgetUnit.TOKEN))
    }
    if (config.monthlyTokenLimit > 0) {
      budgets.push(new Budget(BudgetTimeRate.MONTHLY, config.monthlyTokenLimit, BudgetUnit.TOKEN))
    }
    return { enabled: config.enabled, budgets: budgets.map(b => b.toJSON()) }
  }

  /**
   * 更新限额配置 — 接收 Budget[]，调用 APIG API 设置
   * @param {Array} budgets - Budget 对象数组
   * @returns {Promise<{ success: boolean, message: string }>}
   */
  async updateLimitConfig(budgets) {
    const bl = new BudgetList(budgets)
    const daily = bl.find(BudgetUnit.TOKEN, BudgetTimeRate.DAILY)
    const monthly = bl.find(BudgetUnit.TOKEN, BudgetTimeRate.MONTHLY)
    return this._updateTokenRateLimit(daily?.value || 0, monthly?.value || 0)
  }

  /**
   * 获取用户限额 — 从 APIG API 获取用户 + 全局限制，合并为 Budget[]
   * @param {string} userId - 用户 ID
   * @returns {Promise<{ enabled: boolean, budgets: Array, globalBudgets: Array, effectiveBudgets: Array }>}
   */
  async getUserLimit(userId) {
    // 从 principal_profiles 获取邮箱和 consumer_id
    const { data: userProfile, error } = await supabaseAdmin
      .from('principal_profiles')
      .select('email, consumer_id')
      .eq('id', userId)
      .eq('principal_type', 'user')
      .maybeSingle()

    if (error || !userProfile) {
      return { enabled: false, budgets: [], globalBudgets: [], effectiveBudgets: [] }
    }

    if (!userProfile.consumer_id) {
      return { enabled: false, budgets: [], globalBudgets: [], effectiveBudgets: [], hasConsumer: false }
    }

    const consumerName = this._sanitizeConsumerName(userProfile.email)

    // 获取用户个人限制（新接口返回数组 [{value, unit, timeRate}]）
    const userLimits = await this.getUserBudgetLimit(consumerName)
    const userBudgets = userLimits.map(l => new Budget(l.timeRate, l.value, l.unit))

    // 获取全局限制
    const globalConfig = await this._getTokenRateLimit()
    const globalBudgets = []
    if (globalConfig.dailyTokenLimit > 0) {
      globalBudgets.push(new Budget(BudgetTimeRate.DAILY, globalConfig.dailyTokenLimit, BudgetUnit.TOKEN))
    }
    if (globalConfig.monthlyTokenLimit > 0) {
      globalBudgets.push(new Budget(BudgetTimeRate.MONTHLY, globalConfig.monthlyTokenLimit, BudgetUnit.TOKEN))
    }

    // 计算生效限制（个人优先，否则全局）
    const userDaily = userLimits.find(l => l.timeRate === BudgetTimeRate.DAILY)
    const userMonthly = userLimits.find(l => l.timeRate === BudgetTimeRate.MONTHLY)
    const effectiveDaily = userDaily ? userDaily.value : globalConfig.dailyTokenLimit
    const effectiveMonthly = userMonthly ? userMonthly.value : globalConfig.monthlyTokenLimit
    const effectiveBudgets = []
    if (effectiveDaily > 0) {
      effectiveBudgets.push(new Budget(BudgetTimeRate.DAILY, effectiveDaily, BudgetUnit.TOKEN))
    }
    if (effectiveMonthly > 0) {
      effectiveBudgets.push(new Budget(BudgetTimeRate.MONTHLY, effectiveMonthly, BudgetUnit.TOKEN))
    }

    return {
      enabled: userBudgets.length > 0 || globalBudgets.length > 0,
      budgets: userBudgets.map(b => b.toJSON()),
      globalBudgets: globalBudgets.map(b => b.toJSON()),
      effectiveBudgets: effectiveBudgets.map(b => b.toJSON()),
      hasConsumer: true
    }
  }

  /**
   * 更新用户限额 — 接收 Budget[]，调用 APIG API 设置
   * @param {string} userId - 用户 ID
   * @param {Array} budgets - Budget 对象数组
   * @returns {Promise<{ success: boolean, message: string }>}
   */
  async updateUserLimit(userId, budgets) {
    // 从 principal_profiles 获取邮箱和 consumer_id
    const { data: userProfile, error } = await supabaseAdmin
      .from('principal_profiles')
      .select('email, consumer_id')
      .eq('id', userId)
      .eq('principal_type', 'user')
      .maybeSingle()

    if (error || !userProfile) {
      throw new Error('用户不存在')
    }

    if (!userProfile.consumer_id) {
      throw new Error('用户尚未绑定 Consumer，请先为用户创建实例')
    }

    const consumerName = this._sanitizeConsumerName(userProfile.email)
    const bl = new BudgetList(budgets)
    const daily = bl.find(BudgetUnit.TOKEN, BudgetTimeRate.DAILY)
    const monthly = bl.find(BudgetUnit.TOKEN, BudgetTimeRate.MONTHLY)

    return this._updateUserTokenRateLimit(consumerName, daily?.value || 0, monthly?.value || 0)
  }

  /**
   * 获取主体限额 — 从 principal_profiles 获取 consumer，分组用 name、用户用 email
   * @param {string} principalId - 主体 ID（用户或分组）
   * @returns {Promise<{ enabled: boolean, budgets: Array, globalBudgets: Array, effectiveBudgets: Array }>}
   */
  async getPrincipalLimit(principalId) {
    const { data: profile, error } = await supabaseAdmin
      .from('principal_profiles')
      .select('email, name, principal_type, consumer_id')
      .eq('id', principalId)
      .maybeSingle()

    if (error || !profile || !profile.consumer_id) {
      return {
        enabled: false,
        usageUnit: BudgetUnit.TOKEN,
        budgets: [],
        globalBudgets: [],
        effectiveBudgets: [],
        hasConsumer: !!(profile?.consumer_id)
      }
    }

    const consumerName = profile.principal_type === 'group'
      ? this._sanitizeConsumerName(profile.name)
      : this._sanitizeConsumerName(profile.email)

    const userLimits = await this.getUserBudgetLimit(consumerName)
    const userBudgets = userLimits.map(l => new Budget(l.timeRate, l.value, l.unit))

    const globalConfig = await this._getTokenRateLimit()
    const globalBudgets = []
    if (globalConfig.dailyTokenLimit > 0) {
      globalBudgets.push(new Budget(BudgetTimeRate.DAILY, globalConfig.dailyTokenLimit, BudgetUnit.TOKEN))
    }
    if (globalConfig.monthlyTokenLimit > 0) {
      globalBudgets.push(new Budget(BudgetTimeRate.MONTHLY, globalConfig.monthlyTokenLimit, BudgetUnit.TOKEN))
    }

    const userDaily = userLimits.find(l => l.timeRate === BudgetTimeRate.DAILY)
    const userMonthly = userLimits.find(l => l.timeRate === BudgetTimeRate.MONTHLY)
    const effectiveDaily = userDaily ? userDaily.value : globalConfig.dailyTokenLimit
    const effectiveMonthly = userMonthly ? userMonthly.value : globalConfig.monthlyTokenLimit
    const effectiveBudgets = []
    if (effectiveDaily > 0) {
      effectiveBudgets.push(new Budget(BudgetTimeRate.DAILY, effectiveDaily, BudgetUnit.TOKEN))
    }
    if (effectiveMonthly > 0) {
      effectiveBudgets.push(new Budget(BudgetTimeRate.MONTHLY, effectiveMonthly, BudgetUnit.TOKEN))
    }

    return {
      enabled: userBudgets.length > 0 || globalBudgets.length > 0,
      usageUnit: BudgetUnit.TOKEN,
      budgets: userBudgets.map(b => b.toJSON()),
      globalBudgets: globalBudgets.map(b => b.toJSON()),
      effectiveBudgets: effectiveBudgets.map(b => b.toJSON()),
      hasConsumer: true
    }
  }

  /**
   * 更新主体限额 — 从 principal_profiles 获取 consumer，分组用 name、用户用 email
   * @param {string} principalId - 主体 ID（用户或分组）
   * @param {Array} budgets - Budget 对象数组
   * @returns {Promise<{ success: boolean, message: string }>}
   */
  async updatePrincipalLimit(principalId, budgets) {
    const { data: profile, error } = await supabaseAdmin
      .from('principal_profiles')
      .select('email, name, principal_type, consumer_id')
      .eq('id', principalId)
      .maybeSingle()

    if (error || !profile) {
      throw new Error('主体不存在')
    }

    if (!profile.consumer_id) {
      throw new Error('该主体尚未绑定 Consumer')
    }

    const consumerName = profile.principal_type === 'group'
      ? this._sanitizeConsumerName(profile.name)
      : this._sanitizeConsumerName(profile.email)
    const bl = new BudgetList(budgets)
    const daily = bl.find(BudgetUnit.TOKEN, BudgetTimeRate.DAILY)
    const monthly = bl.find(BudgetUnit.TOKEN, BudgetTimeRate.MONTHLY)

    return this._updateUserTokenRateLimit(consumerName, daily?.value || 0, monthly?.value || 0)
  }

  // ========== Private Methods ==========

  /**
   * Load config from database
   * @returns {Promise<object>}
   * @private
   */
  async _loadConfigFromDB() {
    const { data, error } = await supabaseAdmin
      .from('provider_config')
      .select('config')
      .eq('name', this.name)
      .maybeSingle()

    if (error) {
      throw new Error(`Failed to load provider config: ${error.message}`)
    }

    const rawConfig = data?.config || {}

    // Normalize: support both flat format (new) and nested parameters format (legacy)
    // If legacy 'parameters' key exists, merge it into flat format and remove the wrapper
    const { parameters: nestedParams, ...flatFields } = rawConfig
    const config = { ...(nestedParams || {}), ...flatFields }

    // Decrypt sensitive fields
    const sensitiveFields = ['dashscopeApiKey', 'aliyunAccessKeyId', 'aliyunAccessKeySecret']
    for (const field of sensitiveFields) {
      if (config[field]) {
        try {
          config[field] = decryptApiKey(config[field])
        } catch (e) {
          console.warn(`Field ${field} for ${this.name} appears to be plaintext`)
        }
      }
    }

    return config
  }

  /**
   * Sanitize email to valid consumer name
   * @param {string} email
   * @returns {string}
   * @private
   */
  _sanitizeConsumerName(email) {
    if (!email) return ''
    // Must match apig.js sanitizeConsumerName implementation exactly
    let name = email.replace(/@/g, '.').replace(/[^a-zA-Z0-9.\-]/g, '-')
    name = name.replace(/^[^a-zA-Z0-9]+/, '').replace(/[^a-zA-Z0-9]+$/, '')
    name = name.replace(/([\.\-]){2,}/g, '$1')
    if (name.length > 64) {
      name = name.slice(0, 64).replace(/[^a-zA-Z0-9]+$/, '')
    }
    if (name.length < 2) {
      name = name.padEnd(2, '0')
    }
    return name
  }
}

export default AlibabaCloudAIGatewayProvider
