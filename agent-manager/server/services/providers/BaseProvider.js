/**
 * Base Provider Class
 * Abstract base class for all AI providers
 * Defines the common interface that all providers must implement
 */

export class BaseProvider {
  /**
   * @param {object} config - Provider configuration from provider_config table
   * @param {string} name - Provider name
   */
  constructor(config, name) {
    this.config = config || {}
    this.name = name
    /** @type {{ displayName?: string, isEnabled?: boolean, description?: string }} */
    this.metadata = {}
  }

  /**
   * Get provider type
   * @returns {string} Provider type identifier
   */
  getType() {
    throw new Error('getType() must be implemented by subclass')
  }

  /**
   * Get provider configuration
   * @returns {Promise<object>} Provider configuration
   */
  async getConfig() {
    return {
      name: this.name,
      type: this.getType(),
      ...this.config
    }
  }

  /**
   * 返回 GET /providers/:code 路由的完整响应对象
   * 公共字段由 BaseProvider 从 metadata + config 组装，类型特定字段委托给 _getCredentialDetail()
   * @returns {Promise<object>} 完整的 provider 详情响应
   */
  async getProviderDetail() {
    const credentialDetail = await this._getCredentialDetail({ isEnabled: this.metadata.isEnabled ?? false })
    return {
      code: this.name,
      displayName: this.metadata.displayName || this.name,
      apiKeyPlaceholder: this.config.apiKeyPlaceholder || '',
      domainPlaceholder: this.config.domainPlaceholder || '',
      type: this.getType(),
      isEnabled: this.metadata.isEnabled ?? false,
      description: this.metadata.description || '',
      ...credentialDetail
    }
  }

  /**
   * 返回类型特定的凭证/配置字段（子类重写）
   * @param {object} context - { isEnabled }
   * @returns {Promise<object>}
   */
  async _getCredentialDetail({ isEnabled } = {}) {
    return {}
  }

  /**
   * Update provider configuration
   * @param {object} updates - Configuration updates
   * @returns {Promise<object>} Updated configuration
   */
  async updateConfig(updates) {
    throw new Error('updateConfig() must be implemented by subclass')
  }

  /**
   * Validate provider configuration
   * @returns {Promise<{valid: boolean, errors: string[]}>}
   */
  async validateConfig() {
    return { valid: true, errors: [] }
  }

  /**
   * Get API key for model access
   * @returns {Promise<string>} API key
   */
  async getApiKey() {
    throw new Error('getApiKey() must be implemented by subclass')
  }

  /**
   * Get API key placeholder for template substitution
   * @returns {string} Placeholder string
   */
  getApiKeyPlaceholder() {
    return this.config.apiKeyPlaceholder || '${API_KEY}'
  }

  // ========== Limit & Stats Features (default implementations) ==========

  /**
   * Check if provider supports limit configuration
   * @returns {boolean}
   */
  supportsLimitConfig() {
    return false
  }

  /**
   * Check if provider supports usage statistics
   * @returns {boolean}
   */
  supportsStats() {
    return false
  }

  /**
   * Get provider statistics
   * @returns {Promise<object|null>} Statistics data
   */
  async getStats() {
    return null
  }

  /**
   * Get usage by consumer
   * @param {number} days - Number of days (1 or 30)
   * @returns {Promise<Array<{consumer: string, value: number, unit: string}>>}
   */
  async getUsageByConsumer(days = 1) {
    return []
  }

  /**
   * Check if provider supports consumer management
   * @returns {boolean}
   */
  supportsConsumerManagement() {
    return false
  }

  /**
   * Create a consumer for the provider
   * @param {string} email - User email (或 group name；作为外部可读标识与记录者使用)
   * @param {object} [opts]
   * @param {string} [opts.displayName] - DB 中的用户名/group 名，由上层传入，供 Provider 生成可读 consumer_id
   * @param {string} [opts.principalType] - 'user' | 'group'，用于 displayName 经 sanitize 后为空时的回退前缀
   * @returns {Promise<{consumerId: string, apikey: string}>}
   */
  async createConsumer(email, opts) {
    throw new Error('Consumer management not supported by this provider')
  }

  /**
   * Reauthorize an existing consumer
   * @param {string} consumerId - Consumer ID
   * @returns {Promise<{httpApiId: string}>}
   */
  async reauthorizeConsumer(consumerId) {
    throw new Error('Consumer management not supported by this provider')
  }

  /**
   * Get usage for a specific user
   * @param {string} identifier - User identifier (sanitized email for AlibabaCloud, consumer_id for LiteLLM)
   * @param {number} days - Number of days (ignored by some providers)
   * @returns {Promise<{value: number, unit: string}|null>}
   */
  async getUserUsage(identifier, days = 1) {
    return null
  }

  /**
   * Get per-user budget limit
   * @param {string} identifier - User identifier
   * @returns {Promise<Array<{value: number, unit: string, timeRate: string}>>}
   */
  async getUserBudgetLimit(identifier) {
    return []
  }

  // ========== Budget-based Limit Management (unified interface) ==========

  /**
   * 获取限额配置 — 从 Provider API 实时获取，封装为 Budget[]
   * 不落库，直接通过 Provider API 读写
   * @returns {Promise<{ enabled: boolean, budgets: Array }>}
   */
  async getLimitConfig() {
    return { enabled: false, budgets: [] }
  }

  /**
   * 更新限额配置 — 接收 Budget[]，调用 Provider API 实时设置
   * @param {Array} budgets - Budget 对象数组
   * @returns {Promise<{ success: boolean, message: string }>}
   */
  async updateLimitConfig(budgets) {
    throw new Error('Limit configuration not supported by this provider')
  }

  /**
   * 获取用户限额
   * @param {string} userId - 用户 ID
   * @returns {Promise<{ enabled: boolean, budgets: Array, usage: object }>}
   */
  async getUserLimit(userId) {
    return { enabled: false, budgets: [], usage: {} }
  }

  /**
   * 更新用户限额
   * @param {string} userId - 用户 ID
   * @param {Array} budgets - Budget 对象数组
   * @returns {Promise<{ success: boolean, message: string }>}
   */
  async updateUserLimit(userId, budgets) {
    throw new Error('User limit not supported by this provider')
  }
}

export default BaseProvider
