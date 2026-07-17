/**
 * LiteLLM Provider Class
 * Provider implementation for LiteLLM Proxy Server
 * Supports consumer management (user + key), budget limits, and usage stats
 */

import crypto from 'crypto'
import { BaseProvider } from './BaseProvider.js'
import { supabaseAdmin, env } from '../../config/index.js'
import { encryptApiKey, decryptApiKey, maskApiKey } from '../../utils/crypto.js'
import { Budget, BudgetTimeRate, BudgetUnit, BudgetList } from './budget.js'

export class LiteLLMProvider extends BaseProvider {
  constructor(config, name) {
    super(config, name)
  }

  getType() {
    return 'LiteLLM'
  }

  // ========== Configuration ==========

  async getConfig() {
    const dbConfig = await this._loadConfigFromDB()
    const envConfig = this._getEnvConfig()

    const rawProxyUrl = dbConfig.proxyUrl || envConfig.proxyUrl || ''
    return {
      name: this.name,
      type: this.getType(),
      // proxyUrl 保留原值，供前端编辑回显
      proxyUrl: rawProxyUrl,
      // httpApiId 返回归一化后的 effective URL，与 createConsumer().httpApiId 一致，
      // 供 instance-provisioner 做变更检测（authorized_http_api_id）使用
      httpApiId: LiteLLMProvider._normalizeProxyUrl(rawProxyUrl),
      masterKey: maskApiKey(dbConfig.masterKey || envConfig.masterKey),
      hasMasterKey: !!(dbConfig.masterKey || envConfig.masterKey),
      apiKeyPlaceholder: dbConfig.apiKeyPlaceholder || '${LITELLM_API_KEY}',
      domainPlaceholder: dbConfig.domainPlaceholder || '${LITELLM_PROXY_URL}'
    }
  }

  async _getCredentialDetail({ isEnabled } = {}) {
    const dbConfig = await this._loadConfigFromDB()
    const envConfig = this._getEnvConfig()
    const masterKey = dbConfig.masterKey || envConfig.masterKey
    const proxyUrl = dbConfig.proxyUrl || envConfig.proxyUrl
    return {
      apiKey: maskApiKey(masterKey),
      hasApiKey: !!(proxyUrl && masterKey),
    }
  }

  async updateConfig(updates) {
    const existing = await this._loadConfigFromDB()
    const configUpdates = { ...existing }

    if (updates.proxyUrl !== undefined) configUpdates.proxyUrl = updates.proxyUrl
    if (updates.masterKey !== undefined) configUpdates.masterKey = updates.masterKey || null
    if (updates.apiKeyPlaceholder !== undefined) configUpdates.apiKeyPlaceholder = updates.apiKeyPlaceholder
    if (updates.domainPlaceholder !== undefined) configUpdates.domainPlaceholder = updates.domainPlaceholder

    // Encrypt masterKey before saving
    if (configUpdates.masterKey) {
      configUpdates.masterKey = encryptApiKey(configUpdates.masterKey)
    }

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

    this.config = configUpdates
    return this.getConfig()
  }

  async getApiKey() {
    const dbConfig = await this._loadConfigFromDB()
    if (dbConfig.masterKey) {
      return dbConfig.masterKey
    }
    const envMasterKey = env.LITELLM_MASTER_KEY
    if (envMasterKey) {
      return envMasterKey
    }
    throw new Error('LiteLLM master key not configured')
  }

  async validateConfig() {
    const dbConfig = await this._loadConfigFromDB()
    const envConfig = this._getEnvConfig()
    const errors = []
    const proxyUrl = dbConfig.proxyUrl || envConfig.proxyUrl
    const masterKey = dbConfig.masterKey || envConfig.masterKey
    if (!proxyUrl) errors.push('LiteLLM Proxy URL is required (or set LITELLM_PROXY_URL env var)')
    if (!masterKey) errors.push('LiteLLM Master Key is required (or set LITELLM_MASTER_KEY env var)')
    return { valid: errors.length === 0, errors }
  }

  getApiKeyPlaceholder() {
    return this.config.apiKeyPlaceholder || '${LITELLM_API_KEY}'
  }

  // ========== Consumer Management ==========

  supportsConsumerManagement() {
    return true
  }

  /**
   * 创建消费者：先创建 User，再创建 Key
   * @param {string} email - 上层传入的外部标识（user 为 email，group 为 name），记载到 metadata
   * @param {object} [opts]
   * @param {string} [opts.displayName] - DB 中的用户名/group 名。优先作为 user_id 生成依据
   * @returns {Promise<{consumerId: string, apikey: string, httpApiId: string}>}
   */
  async createConsumer(email, opts = {}) {
    const { proxyUrl, masterKey } = await this._getEffectiveConfig()
    const dbConfig = await this._loadConfigFromDB()

    const userId = this._generateUserId(opts.displayName || email, { principalType: opts.principalType })

    // Read budget config from DB to apply to new user
    const budgetConfig = dbConfig.budgetConfig
    const userBudgetFields = {}
    if (budgetConfig && budgetConfig.max_budget > 0) {
      userBudgetFields.max_budget = budgetConfig.max_budget
      userBudgetFields.budget_duration = budgetConfig.budget_duration || '30d'
      console.log(`[LiteLLM] createConsumer: applying budget to new user: max_budget=${userBudgetFields.max_budget}, budget_duration=${userBudgetFields.budget_duration}`)
    }

    // 1. Create User（注意：/user/new 的 API 文档声称会返回 token，但实际不返回，必须再调用 /key/generate）
    const userRes = await fetch(`${proxyUrl}/user/new`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${masterKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        user_id: userId,
        ...userBudgetFields,
        metadata: { email, source: 'openclaw' }
      })
    })

    if (!userRes.ok) {
      const errorText = await userRes.text()
      // User 已存在（例如上次配置时创建了 user 但 key 生成失败，或并发请求）：
      // LiteLLM 返回 409 + "already exists"。视为成功并继续后续 key 创建步骤，保证幂等性。
      const isAlreadyExists = (userRes.status === 409 || userRes.status === 400) && /already exists/i.test(errorText)
      if (isAlreadyExists) {
        console.log(`[LiteLLM] User '${userId}' already exists, reusing existing user for key generation`)
      } else {
        throw new Error(`Failed to create LiteLLM user: ${errorText}`)
      }
    }

    // 2. Create Key
    const keyRes = await fetch(`${proxyUrl}/key/generate`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${masterKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        user_id: userId,
        key_alias: userId,
        metadata: { email, source: 'openclaw' }
      })
    })

    let keyData
    if (!keyRes.ok) {
      const errorText = await keyRes.text()
      // Key alias already exists (e.g. switching back to LiteLLM from another provider)
      // Retry with a unique alias suffix
      if (keyRes.status === 400 && errorText.includes('already exists')) {
        const newAlias = `${userId}_${Date.now()}`
        console.log(`[LiteLLM] Key alias '${userId}' already exists, retrying with alias '${newAlias}'`)
        const retryRes = await fetch(`${proxyUrl}/key/generate`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${masterKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            user_id: userId,
            key_alias: newAlias,
            metadata: { email, source: 'openclaw' }
          })
        })
        if (!retryRes.ok) {
          throw new Error(`Failed to create LiteLLM key: ${await retryRes.text()}`)
        }
        keyData = await retryRes.json()
      } else {
        throw new Error(`Failed to create LiteLLM key: ${errorText}`)
      }
    } else {
      keyData = await keyRes.json()
    }

    return {
      consumerId: userId,
      apikey: keyData.key,
      httpApiId: proxyUrl,
      token: keyData.token
    }
  }

  /**
   * 重新授权：为用户生成新 Key
   * @param {string} consumerId - LiteLLM user_id
   * @returns {Promise<{apikey: string, httpApiId: string}>}
   */
  async reauthorizeConsumer(consumerId) {
    const { proxyUrl, masterKey } = await this._getEffectiveConfig()

    const res = await fetch(`${proxyUrl}/key/generate`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${masterKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        user_id: consumerId,
        metadata: { source: 'openclaw', reauthorized: true }
      })
    })

    if (!res.ok) {
      throw new Error(`Failed to reauthorize: ${await res.text()}`)
    }

    const data = await res.json()
    return {
      apikey: data.key,
      httpApiId: proxyUrl,
      token: data.token
    }
  }

  // ========== Budget-based Limit Management ==========

  supportsLimitConfig() {
    return true
  }

  /**
   * 获取限额配置 — 从 DB config 中读取保存的限额规则（per-user 统一模板）
   */
  async getLimitConfig() {
    try {
      const dbConfig = await this._loadConfigFromDB()
      const budgetConfig = dbConfig.budgetConfig // { max_budget, budget_duration }
      console.log(`[LiteLLM] getLimitConfig: budgetConfig from DB =`, JSON.stringify(budgetConfig))

      if (!budgetConfig || !budgetConfig.max_budget || budgetConfig.max_budget <= 0) {
        return { enabled: false, budgets: [] }
      }

      const durationToRate = { '1d': 'daily', '30d': 'monthly', '1mo': 'monthly' }
      const timeRate = durationToRate[budgetConfig.budget_duration] || 'monthly'
      const budget = new Budget(timeRate, budgetConfig.max_budget, BudgetUnit.USD)

      return { enabled: true, budgets: [budget.toJSON()] }
    } catch (error) {
      console.error('[LiteLLM] getLimitConfig exception:', error.message)
      return { enabled: false, budgets: [] }
    }
  }

  /**
   * 更新限额配置 — 保存到 DB config + 批量同步到所有已注册的 LiteLLM user
   */
  async updateLimitConfig(budgets) {
    const bl = new BudgetList(budgets)
    const budget = bl.getByUnit(BudgetUnit.USD)[0]
    const durationMap = { daily: '1d', monthly: '30d' }
    const budgetDuration = durationMap[budget?.timeRate] || '30d'
    const maxBudget = budget?.value || 0

    // 1. 保存限额规则到 DB config（直接读原始 config，不解密，只追加 budgetConfig 字段）
    const { data: rawRow } = await supabaseAdmin
      .from('provider_config')
      .select('config')
      .eq('name', this.name)
      .maybeSingle()
    const rawConfig = rawRow?.config || {}
    rawConfig.budgetConfig = { max_budget: maxBudget, budget_duration: budgetDuration }
    await supabaseAdmin
      .from('provider_config')
      .update({ config: rawConfig, updated_at: new Date().toISOString() })
      .eq('name', this.name)
    console.log(`[LiteLLM] updateLimitConfig: saved budgetConfig to DB: max_budget=${maxBudget}, budget_duration=${budgetDuration}`)

    // 2. 批量同步到所有已注册的 LiteLLM user
    const { proxyUrl, masterKey } = await this._getEffectiveConfig()
    const { data: allProfiles } = await supabaseAdmin
      .from('principal_profiles')
      .select('principal_id:id, consumer_id, consumer_apikey_encrypted, username:name, email')
      .eq('principal_type', 'user')
      .not('consumer_id', 'is', null)
    // Filter to only LiteLLM consumers by checking type prefix
    const consumers = (allProfiles || []).filter(row => {
      if (!row.consumer_apikey_encrypted) return false
      return row.consumer_apikey_encrypted.startsWith('litellm:')
    })

    const syncResults = { success: 0, failed: 0 }
    if (consumers.length > 0) {
      for (const consumer of consumers) {
        try {
          const res = await fetch(`${proxyUrl}/user/update`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${masterKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              user_id: consumer.consumer_id,
              max_budget: maxBudget,
              budget_duration: budgetDuration
            })
          })
          if (res.ok) {
            syncResults.success++
          } else {
            syncResults.failed++
            console.error(`[LiteLLM] updateLimitConfig: failed to sync user ${consumer.consumer_id}: HTTP ${res.status}`)
          }
        } catch (e) {
          syncResults.failed++
          console.error(`[LiteLLM] updateLimitConfig: failed to sync user ${consumer.consumer_id}:`, e.message)
        }
      }
    }

    // Also sync group consumers from principal_profiles
    const { data: groupProfiles } = await supabaseAdmin
      .from('principal_profiles')
      .select('principal_id:id, consumer_id, consumer_apikey_encrypted')
      .eq('principal_type', 'group')
      .not('consumer_id', 'is', null)

    const groupConsumers = (groupProfiles || []).filter(row => {
      if (!row.consumer_apikey_encrypted) return false
      return row.consumer_apikey_encrypted.startsWith('litellm:')
    })

    for (const consumer of groupConsumers) {
      try {
        const res = await fetch(`${proxyUrl}/user/update`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${masterKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            user_id: consumer.consumer_id,
            max_budget: maxBudget,
            budget_duration: budgetDuration
          })
        })
        if (res.ok) {
          syncResults.success++
        } else {
          syncResults.failed++
          console.error(`[LiteLLM] updateLimitConfig: failed to sync group ${consumer.consumer_id}: HTTP ${res.status}`)
        }
      } catch (e) {
        syncResults.failed++
        console.error(`[LiteLLM] updateLimitConfig: failed to sync group ${consumer.consumer_id}:`, e.message)
      }
    }

    console.log(`[LiteLLM] updateLimitConfig: synced ${syncResults.success} users+groups, ${syncResults.failed} failed`)

    return { success: true, message: `默认预算已设置: ${bl.toString()}（已同步 ${syncResults.success} 个用户/分组）` }
  }

  /**
   * 获取用户限额 — 从 LiteLLM Proxy 获取用户信息
   */
  async getUserLimit(userId) {
    // 从 principal_profiles 获取该用户的 consumer_id
    const { data: profile } = await supabaseAdmin
      .from('principal_profiles')
      .select('consumer_id')
      .eq('id', userId)
      .eq('principal_type', 'user')
      .maybeSingle()

    if (!profile?.consumer_id) {
      return { enabled: false, usageUnit: BudgetUnit.USD, budgets: [], globalBudgets: [], effectiveBudgets: [], hasConsumer: false }
    }

    const litellmUserId = profile.consumer_id

    try {
      const userInfo = await this._fetchUserInfo(litellmUserId)
      if (!userInfo) {
        return { enabled: false, usageUnit: BudgetUnit.USD, budgets: [], globalBudgets: [], effectiveBudgets: [], hasConsumer: true }
      }

      const budgets = []
      if (userInfo.max_budget > 0) {
        const durationToRate = { '1d': 'daily', '30d': 'monthly', '1mo': 'monthly' }
        const timeRate = durationToRate[userInfo.budget_duration] || 'monthly'
        budgets.push(new Budget(timeRate, userInfo.max_budget, BudgetUnit.USD))
      }

      // 获取全局限额
      const globalResult = await this.getLimitConfig()

      return {
        enabled: budgets.length > 0 || globalResult.enabled,
        usageUnit: BudgetUnit.USD,
        budgets: budgets.map(b => b.toJSON()),
        globalBudgets: globalResult.budgets,
        effectiveBudgets: budgets.length > 0 ? budgets.map(b => b.toJSON()) : globalResult.budgets,
        hasConsumer: true,
        spend: userInfo.spend || 0
      }
    } catch (error) {
      console.error('LiteLLM getUserLimit error:', error.message)
      return { enabled: false, budgets: [], globalBudgets: [], effectiveBudgets: [], hasConsumer: true }
    }
  }

  /**
   * 更新用户限额 — 调用 LiteLLM Proxy /user/update 设置用户预算
   */
  async updateUserLimit(userId, budgets) {
    const { proxyUrl, masterKey } = await this._getEffectiveConfig()

    // 从 principal_profiles 获取该用户的 consumer_id
    const { data: profile } = await supabaseAdmin
      .from('principal_profiles')
      .select('consumer_id')
      .eq('id', userId)
      .eq('principal_type', 'user')
      .maybeSingle()

    if (!profile?.consumer_id) {
      throw new Error('用户尚未绑定 Consumer，请先为用户创建实例')
    }

    const litellmUserId = profile.consumer_id
    const bl = new BudgetList(budgets)
    const budget = bl.getByUnit(BudgetUnit.USD)[0]
    const durationMap = { daily: '1d', monthly: '30d' }
    const budgetDuration = durationMap[budget?.timeRate] || '30d'

    const url = `${proxyUrl}/user/update`
    const payload = {
      user_id: litellmUserId,
      max_budget: budget?.value || 0,
      budget_duration: budgetDuration
    }
    console.log(`[LiteLLM] updateUserLimit → POST ${url}`, JSON.stringify(payload))

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${masterKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    })
    console.log(`[LiteLLM] updateUserLimit ← status=${res.status} content-type=${res.headers.get('content-type')}`)

    if (!res.ok) {
      const body = await res.text()
      console.error(`[LiteLLM] updateUserLimit error body:`, body.substring(0, 500))
      throw new Error(`LiteLLM 用户预算更新失败 (HTTP ${res.status}): ${body.substring(0, 200)}`)
    }

    return { success: true, message: `用户预算已设置: ${bl.toString()}` }
  }

  /**
   * 获取主体限额 — 从 principal_profiles 获取 consumer_id，逻辑同 getUserLimit
   */
  async getPrincipalLimit(principalId) {
    const { data: profile } = await supabaseAdmin
      .from('principal_profiles')
      .select('consumer_id')
      .eq('id', principalId)
      .maybeSingle()

    if (!profile?.consumer_id) {
      return { enabled: false, budgets: [], globalBudgets: [], effectiveBudgets: [], hasConsumer: false }
    }

    const litellmUserId = profile.consumer_id

    try {
      const userInfo = await this._fetchUserInfo(litellmUserId)
      if (!userInfo) {
        return { enabled: false, budgets: [], globalBudgets: [], effectiveBudgets: [], hasConsumer: true }
      }

      const budgets = []
      if (userInfo.max_budget > 0) {
        const durationToRate = { '1d': 'daily', '30d': 'monthly', '1mo': 'monthly' }
        const timeRate = durationToRate[userInfo.budget_duration] || 'monthly'
        budgets.push(new Budget(timeRate, userInfo.max_budget, BudgetUnit.USD))
      }

      const globalResult = await this.getLimitConfig()

      return {
        enabled: budgets.length > 0 || globalResult.enabled,
        budgets: budgets.map(b => b.toJSON()),
        globalBudgets: globalResult.budgets,
        effectiveBudgets: budgets.length > 0 ? budgets.map(b => b.toJSON()) : globalResult.budgets,
        hasConsumer: true,
        spend: userInfo.spend || 0
      }
    } catch (error) {
      console.error('LiteLLM getPrincipalLimit error:', error.message)
      return { enabled: false, usageUnit: BudgetUnit.USD, budgets: [], globalBudgets: [], effectiveBudgets: [], hasConsumer: true }
    }
  }

  /**
   * 更新主体限额 — 从 principal_profiles 获取 consumer_id，逻辑同 updateUserLimit
   */
  async updatePrincipalLimit(principalId, budgets) {
    const { proxyUrl, masterKey } = await this._getEffectiveConfig()

    const { data: profile } = await supabaseAdmin
      .from('principal_profiles')
      .select('consumer_id')
      .eq('id', principalId)
      .maybeSingle()

    if (!profile?.consumer_id) {
      throw new Error('该主体尚未绑定 Consumer')
    }

    const litellmUserId = profile.consumer_id
    const bl = new BudgetList(budgets)
    const budget = bl.getByUnit(BudgetUnit.USD)[0]
    if (!budget && bl.budgets.length > 0) {
      throw new Error('当前网关不支持分组限额：LiteLLM only supports USD budgets')
    }
    const durationMap = { daily: '1d', monthly: '30d' }
    const budgetDuration = durationMap[budget?.timeRate] || '30d'

    const url = `${proxyUrl}/user/update`
    const payload = {
      user_id: litellmUserId,
      max_budget: budget?.value || 0,
      budget_duration: budgetDuration
    }
    console.log(`[LiteLLM] updatePrincipalLimit → POST ${url}`, JSON.stringify(payload))

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${masterKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    })
    console.log(`[LiteLLM] updatePrincipalLimit ← status=${res.status} content-type=${res.headers.get('content-type')}`)

    if (!res.ok) {
      const body = await res.text()
      console.error(`[LiteLLM] updatePrincipalLimit error body:`, body.substring(0, 500))
      throw new Error(`LiteLLM 主体预算更新失败 (HTTP ${res.status}): ${body.substring(0, 200)}`)
    }

    return { success: true, message: `主体预算已设置: ${bl.toString()}` }
  }

  /**
   * 获取用户用量 — 通过 /user/daily/activity/aggregated 按日期范围查询
   * @param {string} identifier - LiteLLM user_id (如 openclaw_xxxx)
   * @param {number} days - 天数范围 (1=今日, 30=近30天)
   * @returns {Promise<{value: number, unit: string}|null>}
   */
  async getUserUsage(identifier, days = 1) {
    try {
      // 全局调用（不带 api_key），获取所有 api_keys breakdown
      const data = await this._fetchAggregatedActivity(days)
      if (!data) return null

      // 遍历 results[].breakdown.api_keys，以 metadata.key_alias 匹配该用户并累加 spend
      // LiteLLM 实际返回结构：results[].breakdown.api_keys[<token_hash>] = { metadata: { key_alias }, metrics: { spend } }
      // 注意：createConsumer 在 key_alias 冲突时会重试为 `${userId}_${Date.now()}`（13 位毫秒），
      // 而 DB 端 consumer_id 仍存原始 userId。这里剥掉时间戳后缀以归一化匹配。
      // 生成规则是 sanitized_<6 位 hex>，不会与 13 位数字撞。
      let totalSpend = 0
      const dayResults = Array.isArray(data.results) ? data.results : []
      for (const day of dayResults) {
        const apiKeys = day?.breakdown?.api_keys
        if (!apiKeys || typeof apiKeys !== 'object') continue
        for (const keyData of Object.values(apiKeys)) {
          const rawAlias = keyData?.metadata?.key_alias
          if (!rawAlias) continue
          const normalizedAlias = String(rawAlias).replace(/_\d{13}$/, '')
          if (normalizedAlias === identifier) {
            totalSpend += Number(keyData?.metrics?.spend) || 0
          }
        }
      }
      return { value: totalSpend, unit: BudgetUnit.USD }
    } catch (error) {
      console.error('[LiteLLM] getUserUsage exception:', error.message)
      return null
    }
  }

  /**
   * Check if provider supports usage statistics
   * @returns {boolean}
   */
  supportsStats() {
    return true
  }

  /**
   * Get provider statistics — total USD spend from LiteLLM
   * @returns {Promise<object>}
   */
  async getStats() {
    try {
      const { proxyUrl, masterKey } = await this._getEffectiveConfig()
      const res = await fetch(`${proxyUrl}/global/spend`, {
        headers: { 'Authorization': `Bearer ${masterKey}` }
      })

      if (!res.ok) {
        return { totalSpend: 0, aiGatewayEnabled: true, slsEnabled: true, usageUnit: BudgetUnit.USD, proxyUrl }
      }

      const data = await res.json()
      const totalSpend = typeof data === 'number' ? data : (data.total_spend ?? data.spend ?? 0)
      return {
        totalSpend,
        aiGatewayEnabled: true,
        slsEnabled: true,
        usageUnit: BudgetUnit.USD,
        proxyUrl
      }
    } catch (error) {
      console.error('[LiteLLM] getStats exception:', error.message)
      // 异常分支仍需返回 proxyUrl，保证前端跳转 URL 可构建（与成功分支字段保持一致）
      let proxyUrl = ''
      try {
        const cfg = await this._getEffectiveConfig()
        proxyUrl = cfg.proxyUrl
      } catch (_) {
        // ignore: 连配置都拿不到时返回空字符串
      }
      return { totalSpend: 0, aiGatewayEnabled: true, slsEnabled: false, usageUnit: BudgetUnit.USD, proxyUrl }
    }
  }

  /**
   * 获取 per-user 用量 — 通过全局 daily activity API 获取 api_keys breakdown
   * 数据路径：results[].breakdown.api_keys[*].metadata.key_alias 作为 consumer_id
   * @param {number} days - 天数范围 (1=今日, 30=近30天)
   * @returns {Promise<Array<{consumer: string, username: string, value: number, unit: string, type: string}>>}
   */
  async getUsageByConsumer(days = 1) {
    try {
      const data = await this._fetchAggregatedActivity(days)
      if (!data) return []

      // 遍历每天的 breakdown.api_keys，按 metadata.key_alias 聚合每个 consumer 的 spend
      const consumerSpendMap = new Map()
      const dayResults = Array.isArray(data.results) ? data.results : []
      for (const day of dayResults) {
        const apiKeys = day?.breakdown?.api_keys
        if (!apiKeys || typeof apiKeys !== 'object') continue
        for (const keyData of Object.values(apiKeys)) {
          const rawAlias = keyData?.metadata?.key_alias
          if (!rawAlias) continue
          // 同 getUserUsage：剥掉 createConsumer 重试时附加的 _${Date.now()} 13 位时间戳后缀，
          // 还原回 DB principal_profiles.consumer_id 的命名，使 spend 归并到正确的 consumer。
          const keyAlias = String(rawAlias).replace(/_\d{13}$/, '')
          const spend = Number(keyData?.metrics?.spend) || 0
          if (spend === 0) continue
          consumerSpendMap.set(keyAlias, (consumerSpendMap.get(keyAlias) || 0) + spend)
        }
      }

      if (consumerSpendMap.size === 0) {
        if (process.env.LITELLM_USAGE_DEBUG === '1') {
          console.log('[LiteLLM][debug] getUsageByConsumer: consumerSpendMap is empty (no api_keys with spend>0 returned by LiteLLM)')
        }
        return []
      }

      // 从 principal_profiles 映射 consumer_id -> display name + principal_type
      const { data: profiles } = await supabaseAdmin
        .from('principal_profiles')
        .select('consumer_id, name, principal_type')
        .not('consumer_id', 'is', null)
      const consumerToProfile = new Map()
      for (const p of (profiles || [])) {
        if (p.consumer_id) {
          consumerToProfile.set(p.consumer_id, {
            displayName: p.name || p.consumer_id,
            principalType: p.principal_type || 'user'
          })
        }
      }

      // 诊断日志：开启 LITELLM_USAGE_DEBUG=1 后，输出 LiteLLM 端 alias 与 DB consumer_id 的匹配命中情况
      if (process.env.LITELLM_USAGE_DEBUG === '1') {
        const litellmKeys = Array.from(consumerSpendMap.keys())
        const dbKeys = Array.from(consumerToProfile.keys())
        const dbGroupKeys = (profiles || []).filter(p => p.principal_type === 'group').map(p => p.consumer_id)
        const matched = litellmKeys.filter(k => consumerToProfile.has(k))
        const missed = litellmKeys.filter(k => !consumerToProfile.has(k))
        console.log('[LiteLLM][debug] getUsageByConsumer:')
        console.log('  litellm aliases (post-normalize):', JSON.stringify(litellmKeys))
        console.log('  db consumer_ids (groups only)   :', JSON.stringify(dbGroupKeys))
        console.log('  matched                         :', JSON.stringify(matched))
        console.log('  missed (alias not in DB)        :', JSON.stringify(missed))
      }

      const results = []
      for (const [consumerId, spend] of consumerSpendMap) {
        const profile = consumerToProfile.get(consumerId)
        results.push({
          consumer: consumerId,
          username: profile?.displayName || consumerId,
          value: spend,
          unit: BudgetUnit.USD,
          type: profile?.principalType || 'user'
        })
      }

      return results.sort((a, b) => b.value - a.value)
    } catch (error) {
      console.error('[LiteLLM] getUsageByConsumer exception:', error.message)
      return []
    }
  }

  /**
   * 获取用户预算限额 — 从 LiteLLM /user/info 获取 max_budget
   * @param {string} identifier - LiteLLM user_id
   * @returns {Promise<Array<{value: number, unit: string, timeRate: string}>>}
   */
  async getUserBudgetLimit(identifier) {
    try {
      const userInfo = await this._fetchUserInfo(identifier)
      if (!userInfo || !userInfo.max_budget || userInfo.max_budget <= 0) {
        return []
      }
      const durationToRate = { '1d': 'daily', '30d': 'monthly', '1mo': 'monthly' }
      const timeRate = durationToRate[userInfo.budget_duration] || 'monthly'
      return [{ value: userInfo.max_budget, unit: BudgetUnit.USD, timeRate }]
    } catch (error) {
      console.error('[LiteLLM] getUserBudgetLimit exception:', error.message)
      return []
    }
  }

  // ========== Private Methods ==========

  /**
   * 从 LiteLLM /user/daily/activity/aggregated 获取聚合用量数据
   * @param {number} days - 天数范围 (1=今日, 30=近30天)
   * @param {string} tokenId - key 的 token_id，空字符串表示全局查询
   * @returns {Promise<{results: Array, metadata: object}|null>}
   */
  async _fetchAggregatedActivity(days, tokenId = '') {
    const { proxyUrl, masterKey } = await this._getEffectiveConfig()

    const endDate = new Date()
    const startDate = new Date()
    if (days > 1) {
      startDate.setDate(startDate.getDate() - (days - 1))
    }

    const formatDate = (d) => d.toISOString().split('T')[0]
    const params = new URLSearchParams({
      start_date: formatDate(startDate),
      end_date: formatDate(endDate)
    })
    if (tokenId) {
      params.set('api_key', tokenId)
    }

    const url = `${proxyUrl}/user/daily/activity/aggregated?${params}`

    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${masterKey}` }
    })

    if (!res.ok) {
      const body = await res.text()
      console.error(`[LiteLLM] _fetchAggregatedActivity error:`, body.substring(0, 500))
      return null
    }

    const data = await res.json()
    return data
  }

  /**
   * 从 LiteLLM /user/info 获取用户信息（复用方法）
   * @param {string} litellmUserId - LiteLLM user_id
   * @returns {Promise<object|null>} userInfo 对象，包含 max_budget、budget_duration、spend 等字段
   */
  async _fetchUserInfo(litellmUserId) {
    const { proxyUrl, masterKey } = await this._getEffectiveConfig()
    const url = `${proxyUrl}/user/info?user_id=${encodeURIComponent(litellmUserId)}`
    console.log(`[LiteLLM] _fetchUserInfo → GET ${url}`)
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${masterKey}` }
    })

    if (!res.ok) {
      const body = await res.text()
      console.error(`[LiteLLM] _fetchUserInfo error body:`, body.substring(0, 500))
      return null
    }

    const data = await res.json()
    return data.user_info || data
  }

  /**
   * 从数据库加载并解密配置
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

    const config = data?.config || {}

    // Decrypt masterKey
    if (config.masterKey) {
      try {
        const decrypted = decryptApiKey(config.masterKey)
        // Validate: decryption with wrong key produces garbage containing U+FFFD replacement chars
        // or other non-printable characters. A valid masterKey should be printable ASCII.
        if (decrypted && /^[\x20-\x7E]+$/.test(decrypted)) {
          config.masterKey = decrypted
        } else {
          console.error(`[LiteLLM] masterKey decryption produced invalid characters for ${this.name}. Check API_ENCRYPTION_KEY in .env`)
          throw new Error('masterKey decryption produced invalid output. API_ENCRYPTION_KEY may be incorrect or missing.')
        }
      } catch (e) {
        if (e.message.includes('masterKey decryption produced invalid')) throw e
        console.error(`[LiteLLM] Failed to decrypt masterKey for ${this.name}: ${e.message}`)
        throw new Error(`Failed to decrypt masterKey. Ensure API_ENCRYPTION_KEY is set correctly in .env`)
      }
    }

    return config
  }

  /**
   * 从环境变量获取配置
   */
  _getEnvConfig() {
    return {
      proxyUrl: env.LITELLM_PROXY_URL || '',
      masterKey: env.LITELLM_MASTER_KEY || ''
    }
  }

  /**
   * 获取最终生效的配置（DB 优先，env 回退）
   * proxyUrl 协议自适应：若未带 http:// 或 https://，自动补 http://
   * 设计依据：proxyUrl 推荐以 host:port 形式存储（不含协议前缀），
   * 由本方法在运行期统一补全，避免分散到每个调用点。
   */
  async _getEffectiveConfig() {
    const dbConfig = await this._loadConfigFromDB()
    const envConfig = this._getEnvConfig()

    const rawProxyUrl = dbConfig.proxyUrl || envConfig.proxyUrl
    const masterKey = dbConfig.masterKey || envConfig.masterKey

    if (!rawProxyUrl) throw new Error('LiteLLM Proxy URL not configured')
    if (!masterKey) throw new Error('LiteLLM Master Key not configured')

    return { proxyUrl: LiteLLMProvider._normalizeProxyUrl(rawProxyUrl), masterKey }
  }

  /**
   * 协议与尾斜杠归一化：该规则是 LiteLLM proxyUrl 的唯一源头。
   * 仅调用者：_getEffectiveConfig、getConfig().httpApiId。
   * 输入为空返回空串（调用者自行处理）。
   */
  static _normalizeProxyUrl(rawUrl) {
    if (!rawUrl) return ''
    const trimmed = String(rawUrl).trim()
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
    return withScheme.replace(/\/+$/, '')
  }

  /**
   * 生成 LiteLLM user_id
   * 规则：<sanitized_name>_<6位 hex 随机后缀>
   * sanitize：转小写、取 email @ 前部分、仅保留 [a-z0-9-]、截断到 32 字符
   * 若 sanitize 后为空（如纯中文 group 名），回退为 `${principalType}_${sha256(raw).slice(0,8)}`
   *   —— 同名分组哈希稳定可复现，便于后台溯源；与正常用户的 `user_xxx` 命名空间区分。
   * @param {string} nameOrEmail - 优先传入 DB 中的用户名/group 名；未提供时可传 email 作为兑底
   * @param {object} [opts]
   * @param {string} [opts.principalType] - 'user' | 'group'，决定 sanitize 为空时的回退前缀
   */
  _generateUserId(nameOrEmail, opts = {}) {
    let raw = (nameOrEmail || '').toString().toLowerCase().trim()
    if (raw.includes('@')) {
      raw = raw.split('@')[0]
    }
    let sanitized = raw.replace(/[^a-z0-9-]/g, '').slice(0, 32)
    if (!sanitized) {
      // 纯中文/纯特殊字符的 group 名等场景：用 principalType + 内容哈希做可读前缀，避免全部坍塌成 'user'
      const prefix = opts.principalType === 'group' ? 'group' : 'user'
      const contentHash = crypto.createHash('sha256').update(raw || 'unnamed').digest('hex').slice(0, 8)
      sanitized = `${prefix}_${contentHash}`
    }
    const randomSuffix = crypto.randomBytes(3).toString('hex') // 3 bytes = 6 hex 字符
    return `${sanitized}_${randomSuffix}`
  }
}
