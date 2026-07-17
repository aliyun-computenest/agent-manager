/**
 * API Provider Class
 * Simple API key-based provider implementation
 * Used for providers that only require an API key (e.g., OpenAI, DashScope direct)
 */

import { BaseProvider } from './BaseProvider.js'
import { supabaseAdmin } from '../../config/index.js'
import { encryptApiKey, decryptApiKey, maskApiKey } from '../../utils/crypto.js'

export class APIProvider extends BaseProvider {
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
    return 'API'
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
      apiKeyPlaceholder: config.apiKeyPlaceholder || '${API_KEY}',
      apiKey: maskApiKey(config.apiKey), // Return masked value under original field name
      hasApiKey: !!config.apiKey
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
    
    if (updates.apiKeyPlaceholder !== undefined) {
      configUpdates.apiKeyPlaceholder = updates.apiKeyPlaceholder
    }
    
    if (updates.apiKey !== undefined) {
      configUpdates.apiKey = updates.apiKey || null
    }

    // Encrypt apiKey before saving to DB
    // (configUpdates may contain decrypted value from _loadConfigFromDB)
    if (configUpdates.apiKey) {
      configUpdates.apiKey = encryptApiKey(configUpdates.apiKey)
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

    // Update local config
    this.config = configUpdates

    return this.getConfig()
  }

  async _getCredentialDetail({ isEnabled } = {}) {
    const config = await this._loadConfigFromDB()
    return {
      apiKey: config.apiKey ? maskApiKey(config.apiKey) : '',
      hasApiKey: !!config.apiKey,
      domain: config.domain ? maskApiKey(config.domain) : ''
    }
  }

  /**
   * Get API key for model access
   * @returns {Promise<string>}
   */
  async getApiKey() {
    const config = await this._loadConfigFromDB()
    if (!config.apiKey) {
      throw new Error(`API key not configured for provider: ${this.name}`)
    }
    return decryptApiKey(config.apiKey)
  }

  /**
   * Validate provider configuration
   * @returns {Promise<{valid: boolean, errors: string[]}>}
   */
  async validateConfig() {
    const config = await this._loadConfigFromDB()
    const errors = []

    if (!config.apiKey) {
      errors.push('API Key is required')
    }

    return {
      valid: errors.length === 0,
      errors
    }
  }

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

    // Decrypt API key if present
    const config = data?.config || {}
    if (config.apiKey) {
      try {
        config.apiKey = decryptApiKey(config.apiKey)
      } catch (e) {
        // If decryption fails, assume it's plaintext and encrypt it
        console.warn(`API key for ${this.name} appears to be plaintext, will encrypt on next update`)
      }
    }

    return config
  }
}

export default APIProvider
