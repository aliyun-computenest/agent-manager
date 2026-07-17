/**
 * Agent Configuration Utilities
 * Handles template loading and configuration generation for sandboxes
 * Supports multiple agent types by reading config from agent_types table
 */

import { Sandbox } from '@e2b/code-interpreter'
import { supabaseAdmin } from '../config/index.js'
import { decryptApiKey, decodeConsumerKey } from './crypto.js'
import { createSkillInjector } from './skill-injector.js'

/**
 * Connect to a sandbox if given an ID string, or return the sandbox object as-is.
 * @param {string|Object} sandboxOrId
 * @returns {Promise<Object>} sandbox instance
 */
async function resolveSandbox(sandboxOrId) {
  if (typeof sandboxOrId === 'string') {
    return Sandbox.connect(sandboxOrId)
  }
  return sandboxOrId
}

/**
 * Replace ${VAR} and $VAR placeholders in a string with values from `vars` map.
 * Missing keys are replaced with empty string.
 * @param {string} tpl
 * @param {Object} vars
 * @returns {string}
 */
function substituteTemplate(tpl, vars) {
  if (!tpl) return ''
  return tpl.replace(/\$\{(\w+)\}|\$(\w+)/g, (match, braced, unbraced) => {
    const key = braced || unbraced
    if (key in vars) {
      return vars[key] ?? ''
    }
    return ''
  })
}

/**
 * Build the configSubstVars map where every key maps to its own `${KEY}`
 * placeholder. This makes `substituteTemplate` preserve all placeholders
 * in the config output, so OpenClaw resolves them from .env at runtime.
 * @param {Object} templateVars
 * @returns {Object} map where each key → `${key}` (the placeholder string)
 */
function buildConfigSubstVars(templateVars) {
  const configSubstVars = {}
  for (const [key, value] of Object.entries(templateVars)) {
    // Only preserve ${VAR} placeholder when the variable has a real value
    // (will be written to .env). Use explicit null/undefined/'' check instead
    // of falsy so that legitimate values like 0/false aren't dropped.
    configSubstVars[key] = (value !== undefined && value !== null && value !== '')
      ? `\${${key}}`
      : ''
  }
  return configSubstVars
}

/**
 * Parse a dotenv-formatted string into a key-value map.
 * Handles both quoted and unquoted values. Lines starting with # are skipped.
 * @param {string} content
 * @returns {Object}
 */
function parseDotEnvContent(content) {
  const result = {}
  if (!content) return result
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx < 1) continue
    const key = trimmed.substring(0, eqIdx)
    let value = trimmed.substring(eqIdx + 1)
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    // Unescape common escape sequences
    value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r')
      .replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    result[key] = value
  }
  return result
}

/**
 * Build a dotenv-formatted string from a key-value map.
 * Empty values are omitted; non-empty values are wrapped in double quotes
 * with backslashes / quotes / CR / LF escaped so that special characters
 * (=, #, spaces, base64 trailing '=') don't break dotenv parsing at runtime.
 * @param {Object} vars
 * @returns {string}
 */
function buildDotEnvContent(vars) {
  return Object.entries(vars)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => {
      const escaped = String(v)
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
      return `${k}="${escaped}"`
    })
    .join('\n') + '\n'
}

/**
 * Build the full template variables map used for both config generation
 * and modify-command execution. This centralizes provider/consumer key resolution.
 *
 * Also returns `sensitiveCustomVarKeys`: the set of variable names that came
 * from `agentType.custom_vars_schema` with `type === 'password'`. Callers pass
 * this to `logTemplateVars` so the underlying secret value is masked even when
 * the variable name is something like `PASSWORD` / `DB_PASS` that would not be
 * caught by the default key/secret/token heuristic.
 *
 * @param {Object} agentType
 * @param {Object} instanceData
 * @returns {Promise<{ templateVars: Object, sensitiveCustomVarKeys: Set<string> }>}
 */
async function buildTemplateVars(agentType, instanceData) {
  const sensitiveCustomVarKeys = new Set()
  if (Array.isArray(agentType?.custom_vars_schema)) {
    for (const field of agentType.custom_vars_schema) {
      if (field && field.type === 'password' && typeof field.name === 'string' && field.name) {
        sensitiveCustomVarKeys.add(field.name)
      }
    }
  }

  const templateVars = {
    GATEWAY_TOKEN: instanceData.token || '',
    MODEL_NAME: instanceData.modelName || '',
    MODEL_PROVIDER: instanceData.modelProvider || '',
    AI_GATEWAY_DOMAIN: instanceData.aiGatewayDomain || '',
    CHANNEL_TYPE: instanceData.channelType || '',
    CHANNEL_CLIENT_ID: instanceData.channelClientId || '',
    CHANNEL_CLIENT_SECRET: instanceData.channelClientSecret || '',
    CUSTOM_API_KEY: instanceData.customApiKey || '',
    CUSTOM_BASE_URL: instanceData.customBaseUrl || '',
    CONSUMER_API_KEY: instanceData.consumerApikey || ''
  }

  // Get all provider_config records from database
  const { data: allProviderConfigs } = await supabaseAdmin
    .from('provider_config')
    .select('name, type, config, enabled')

  const providerConfigMap = new Map()
  for (const config of (allProviderConfigs || [])) {
    providerConfigMap.set(config.name, {
      name: config.name,
      type: config.type,
      isGateway: config.type === 'AlibabaCloudAIGateway' || config.type === 'LiteLLM',
      enabled: config.enabled,
      ...config.config
    })
  }

  // Load consumer API key map from principal_profiles.
  //
  // Bugfix: 之前写死 principal_type='user' 拿的是【创建者用户】自己的 key，
  // 但分组实例的 credential principal 是 group。导致分组实例运行时用了
  // 创建者的 LiteLLM key，spend 全部记到创建者 user_id 下，分组用量永远为 0。
  //
  // 现在按实例归属的 principal 查询：优先用 instanceData.principalId（由
  // provisioner 传入，分组场景=groupId，个人场景=userId），fallback 到
  // instanceData.userId 兼容老调用方。同时移除 principal_type 限制，让 group
  // profile 也能命中。
  const consumerKeyMap = new Map()
  const credentialPrincipalId = instanceData.principalId || instanceData.userId
  if (credentialPrincipalId) {
    try {
      const { data: principalProfile } = await supabaseAdmin
        .from('principal_profiles')
        .select('consumer_apikey_encrypted')
        .eq('id', credentialPrincipalId)
        .maybeSingle()

      if (principalProfile?.consumer_apikey_encrypted) {
        const decoded = decodeConsumerKey(principalProfile.consumer_apikey_encrypted)
        if (decoded.apikey) {
          if (decoded.type) {
            consumerKeyMap.set(decoded.type, decoded.apikey)
          } else {
            for (const [name, cfg] of providerConfigMap) {
              if (cfg.isGateway && cfg.enabled) {
                consumerKeyMap.set(name, decoded.apikey)
                break
              }
            }
          }
        }
      }
    } catch (e) {
      console.warn(`Failed to load consumer key: ${e.message}`)
    }
  }

  // If MODEL_PROVIDER is known and CONSUMER_API_KEY not explicitly set, pick from map
  if (!templateVars.CONSUMER_API_KEY && instanceData.modelProvider) {
    const k = consumerKeyMap.get(instanceData.modelProvider)
    if (k) templateVars.CONSUMER_API_KEY = k
  }

  // Populate provider API key variables via apiKeyPlaceholder.
  //
  // Bugfix: 优先级翻转。instanceData.consumerApikey 由调用方（provisioner）按
  // credentialPrincipalId 提前算好，是当前实例真正应该用的 key。consumerKeyMap
  // 只是 DB 兜底来源，不应该覆盖调用方显式传入的值，否则分组实例会被遮蔽成
  // 创建者用户的 key（spend 记错主体）。
  for (const [providerName, providerConfig] of providerConfigMap) {
    const apiKeyPlaceholder = providerConfig.apiKeyPlaceholder
    if (!apiKeyPlaceholder) continue
    const placeholderMatch = apiKeyPlaceholder.match(/\$\{(\w+)\}/)
    if (!placeholderMatch) continue
    const varName = placeholderMatch[1]
    if (templateVars[varName]) continue

    const isGateway = providerConfig.isGateway || false
    let apiKey = ''
    if (isGateway) {
      if (providerConfig.enabled && instanceData.consumerApikey) {
        apiKey = instanceData.consumerApikey
      } else if (providerConfig.enabled) {
        const providerConsumerKey = consumerKeyMap.get(providerName)
        if (providerConsumerKey) apiKey = providerConsumerKey
      }
    } else if (providerConfig.apiKey) {
      try { apiKey = decryptApiKey(providerConfig.apiKey) } catch (e) { /* ignore */ }
    }
    templateVars[varName] = apiKey
  }

  // Populate provider domain variables via domainPlaceholder
  for (const [providerName, providerConfig] of providerConfigMap) {
    const domainPlaceholder = providerConfig.domainPlaceholder
    if (!domainPlaceholder) continue
    if (providerConfig.isGateway && !providerConfig.enabled) continue
    const placeholderMatch = domainPlaceholder.match(/\$\{(\w+)\}/)
    if (!placeholderMatch) continue
    const varName = placeholderMatch[1]
    if (templateVars[varName]) continue
    let domainValue = providerConfig.gatewayDomain || providerConfig.proxyUrl || providerConfig.domain || providerConfig.baseUrl || ''
    // LiteLLM 协议头处理：
    //   - 默认与 LiteLLMProvider._getEffectiveConfig 对齐，将 host:port 补全为完整 URL，
    //     供下游 sandbox 内 SDK / qwenpaw run-cmd.sh 直接使用。
    //   - 例外：openclaw 的 config_template 历史上硬编码为 "http://${LITELLM_PROXY_URL}"
    //     （早期约定变量仅存 host:port）。为避免修改已落库的在线模板，
    //     针对 openclaw 写入 .env 时剥掉协议头，让运行时拼接仍是合法 URL。
    //     根本治本需以后静态修改模板，这里仅作为兼容层。
    if (domainValue && providerConfig.type === 'LiteLLM') {
      const trimmed = String(domainValue).trim()
      const normalized = (/^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`).replace(/\/+$/, '')
      domainValue = agentType?.code === 'openclaw'
        ? normalized.replace(/^https?:\/\//i, '')
        : normalized
    }
    templateVars[varName] = domainValue
  }

  // CHANNEL_CONFIG_JSON: fully-rendered channel block (single-line JSON string).
  //
  // Why this exists:
  //   modify-channel commands must write a COMPLETE channel block into the
  //   agent's config file (e.g. openclaw.json's "dingtalk-connector" key with
  //   all 8 fields). Previously the SQL command template only passed 3 fields
  //   with the wrong top-level key ("dingtalk" vs "dingtalk-connector"),
  //   producing invalid config. Instead of hard-coding the shape per channel
  //   inside a SQL string, we reuse the single source of truth — the
  //   `channel_templates` row — exactly like initial provisioning does.
  //
  // NOTE: we do NOT gate this on `agentType.supports_channels`. The existence
  // of a matching channel_templates row is itself the authoritative signal
  // — avoids misses when supports_channels happens to be falsy/stale.
  if (agentType?.id && instanceData.channelType) {
    try {
      const { data: channelTemplateRows, error: channelTemplateErr } = await supabaseAdmin
        .from('channel_templates')
        .select('config_template, is_enabled')
        .eq('channel_type', instanceData.channelType)
        .eq('agent_type_id', agentType.id)
        .limit(1)

      if (channelTemplateErr) {
        console.warn(`Failed to query channel_templates: ${channelTemplateErr.message}`)
      }

      const channelTemplate = Array.isArray(channelTemplateRows) ? channelTemplateRows[0] : null
      const chTpl = channelTemplate?.config_template
      if (chTpl && typeof chTpl === 'object' && Object.keys(chTpl).length > 0) {
        const { _meta, _format, _content, ...templateObj } = chTpl
        if (_format === 'yaml') {
          console.warn(`⚠️  YAML channel_templates not yet supported by modify-channel (channel_type=${instanceData.channelType}), skipping CHANNEL_CONFIG_JSON`)
        } else if (Object.keys(templateObj).length === 0) {
          console.warn(`⚠️  channel_templates row has empty JSON body after stripping meta (channel_type=${instanceData.channelType}, agent_type_id=${agentType.id})`)
        } else {
          // When supports_env_vars is true, preserve ${VAR} placeholders so
          // OpenClaw resolves them from .env. Otherwise substitute directly.
          //
          // IMPORTANT contract: when placeholders are preserved, the rendered
          // JSON contains unresolved tokens (e.g. ${GATEWAY_TOKEN}). It is the
          // agent's `run-cmd.sh modify-channel` responsibility to read
          // ~/.openclaw/.env and expand these tokens before writing the channel
          // block into openclaw.json. Any change to that script must keep this
          // contract; integration tests exercising modify-channel cover this
          // expansion end-to-end.
          const channelSubstVars = agentType?.supports_env_vars
            ? buildConfigSubstVars(templateVars)
            : templateVars
          const rendered = substituteTemplate(JSON.stringify(templateObj), channelSubstVars)
          templateVars.CHANNEL_CONFIG_JSON = rendered
          console.log(`📡 CHANNEL_CONFIG_JSON rendered with placeholders (channel_type=${instanceData.channelType}, top-level keys=${Object.keys(templateObj).join(',')}, length=${rendered.length})`)
        }
      } else {
        console.warn(`⚠️  No channel_templates row found (channel_type=${instanceData.channelType}, agent_type_id=${agentType.id}). supports_channels=${agentType?.supports_channels}`)
      }
    } catch (e) {
      console.warn(`Failed to load channel template for modify-channel: ${e.message}`)
    }
  }

  // Inject custom variables from instanceData.customVars.
  // These are user-provided values defined by the admin's custom_vars_schema.
  // password-type values are stored encrypted (prefixed with "encrypted:") and
  // need to be decrypted before injection into templateVars.
  if (instanceData.customVars && typeof instanceData.customVars === 'object') {
    for (const [key, value] of Object.entries(instanceData.customVars)) {
      // Do NOT overwrite system built-in variables
      if (templateVars[key]) continue
      if (typeof value === 'string' && value.startsWith('encrypted:')) {
        try {
          templateVars[key] = decryptApiKey(value.slice('encrypted:'.length))
        } catch (e) {
          console.warn(`\u26A0\uFE0F Failed to decrypt custom var ${key}: ${e.message}`)
          templateVars[key] = ''
        }
      } else {
        templateVars[key] = value || ''
      }
    }
    console.log(`\uD83D\uDD27 Injected ${Object.keys(instanceData.customVars).length} custom variable(s) into templateVars`)
  }

  return { templateVars, sensitiveCustomVarKeys }
}

/**
 * Log template variables while masking sensitive values.
 *
 * `sensitiveKeys` is an explicit allow-list (typically the set of password-type
 * names from `custom_vars_schema`) that forces masking even when the variable
 * name does not match the default key/secret/token heuristic — this prevents
 * admin-defined password fields like `PASSWORD` / `DB_PASS` from being printed
 * in plaintext to server logs.
 *
 * @param {Object} templateVars
 * @param {Set<string>} [sensitiveKeys]
 */
function logTemplateVars(templateVars, sensitiveKeys) {
  const sensitive = sensitiveKeys instanceof Set ? sensitiveKeys : new Set()
  console.log(`📝 Template variables to substitute:`)
  for (const [key, value] of Object.entries(templateVars)) {
    const lower = key.toLowerCase()
    const isSensitive = sensitive.has(key) ||
      lower.includes('key') || lower.includes('secret') ||
      lower.includes('token') || lower.includes('password') || lower.includes('passwd')
    const displayValue = isSensitive
      ? (value ? `${String(value).substring(0, 8)}...` : '(empty)')
      : (value || '(empty)')
    console.log(`   ${key}: ${displayValue}`)
  }
}

/**
 * Route ALL non-empty template variables through the sandbox process env
 * (as `_AGENT_<VAR>`) instead of substituting their raw values into the bash
 * script body. This serves two purposes:
 *
 *   1. Secrets (*_KEY / *_SECRET / *_TOKEN / CHANNEL_CONFIG_JSON which embeds
 *      clientSecret + gatewayToken) stay out of `ps` / shell history.
 *
 *   2. Non-secret values (MODEL_NAME, MODEL_PROVIDER, CHANNEL_TYPE,
 *      CHANNEL_CLIENT_ID, …) previously went through string substitution into
 *      a file we hand to `bash`, which meant shell metacharacters inside those
 *      values (``$(…)``, backticks, `;`, `&&`, …) were interpreted by bash
 *      at runtime — i.e. a command-injection vector. Routing them through env
 *      turns them into opaque strings as far as the script source is
 *      concerned: the script only references `${_AGENT_VAR}` and bash expands
 *      the env value verbatim without re-parsing it as shell syntax.
 *
 * Empty values are substituted literally as the empty string to match previous
 * `substituteTemplate` behaviour (missing keys → '').
 */
function splitAllVars(templateVars) {
  const envs = {}
  const safeVars = {}
  for (const [key, value] of Object.entries(templateVars)) {
    if (value === undefined || value === null || value === '') {
      safeVars[key] = ''
      continue
    }
    envs[`_AGENT_${key}`] = String(value)
    safeVars[key] = `$\{_AGENT_${key}\}`
  }
  return { safeVars, envs }
}

/**
 * Execute a modify command (model/channel) inside the sandbox.
 * Placeholders are substituted from templateVars; sensitive values are passed via env
 * (_AGENT_<VAR>) so they don't appear on the process command line.
 *
 * @param {string|Object} sandboxOrId
 * @param {Object} agentType
 * @param {string} commandTemplate - e.g. 'bash /usr/local/bin/run-cmd.sh modify-model "${MODEL_NAME}" ...'
 * @param {Object} instanceData
 * @returns {Promise<{exitCode:number, stdout:string, stderr:string}>}
 */
async function runModifyCommand(sandboxOrId, agentType, commandTemplate, instanceData) {
  if (!commandTemplate || !commandTemplate.trim()) {
    throw new Error('modify command is empty')
  }
  const sandbox = await resolveSandbox(sandboxOrId)
  const { templateVars, sensitiveCustomVarKeys } = await buildTemplateVars(agentType, instanceData)
  logTemplateVars(templateVars, sensitiveCustomVarKeys)

  // Fail fast when the command references ${CHANNEL_CONFIG_JSON} but nothing
  // was rendered (missing channel_templates row, YAML template, etc.). Without
  // this, substituteTemplate would silently expand to '' and the script would
  // emit the misleading "channel JSON is required" error.
  const referencesChannelJson = /\$\{CHANNEL_CONFIG_JSON\}|\$CHANNEL_CONFIG_JSON\b/.test(commandTemplate)
  if (referencesChannelJson && !templateVars.CHANNEL_CONFIG_JSON) {
    throw new Error(
      `modify-channel 命令引用了 \${CHANNEL_CONFIG_JSON}，但没有找到对应的渠道模板。请确保 ` +
      `channel_templates 表中存在 (channel_type="${instanceData.channelType}", agent_type_id="${agentType?.id}") 的完整 JSON 配置。`
    )
  }

  const { safeVars, envs } = splitAllVars(templateVars)
  // All template vars — sensitive or not — are routed through process env as
  // ${_AGENT_VAR}; substituteTemplate only emits those env-expansion forms into
  // the script body, so bash never sees user-controlled values as source code
  // (no command injection) and secrets never hit the command line.
  const commandBody = substituteTemplate(commandTemplate, safeVars)

  // Compose final script: set -e + the (env-expanded) command
  const script = `#!/usr/bin/env bash\nset -e\n${commandBody}\n`
  const scriptPath = `/tmp/_agent_modify_${Date.now()}.sh`
  console.log(`🛠️ Writing modify script to ${scriptPath} (${script.length} chars)`)
  const writeOpts = agentType.sandbox_user ? { user: agentType.sandbox_user } : undefined
  await sandbox.files.write(scriptPath, script, writeOpts)

  // Pre-write .env BEFORE executing the command. The command may include a
  // service restart (e.g. `supervisorctl restart openclaw`); if .env is only
  // written after the command completes, the restarted process won't find the
  // required secrets (DASHSCOPE_API_KEY, GATEWAY_TOKEN, etc.) and will fail.
  //
  // IMPORTANT: We MERGE new vars into the existing .env instead of overwriting.
  // buildTemplateVars may not resolve every secret (e.g. DASHSCOPE_API_KEY from
  // a provider whose apiKey wasn't persisted or whose decryption key differs).
  // By merging, we preserve keys that were correctly written during initial
  // provisioning while still updating channel/model-related variables.
  const configWritePath = agentType.config_write_path
  if (agentType.supports_env_vars && configWritePath) {
    const configDir = configWritePath.substring(0, configWritePath.lastIndexOf('/'))
    const dotEnvPath = `${configDir}/.env`
    try {
      // 1. Read existing .env from sandbox
      let existingVars = {}
      try {
        const existingContent = await sandbox.files.read(dotEnvPath)
        existingVars = parseDotEnvContent(existingContent)
      } catch (_readErr) {
        // .env may not exist yet — that's fine, start fresh
      }

      // 2. When this invocation carries channel context (modify-channel), drop
      //    every existing CHANNEL_* entry before merging. Without this, switching
      //    a sandbox between channel types (e.g. dingtalk → feishu) would keep
      //    stale channel-scoped keys around because only same-named keys get
      //    overwritten by the new templateVars; channel-specific keys present
      //    only in the previous template would silently linger forever.
      if (templateVars.CHANNEL_TYPE) {
        for (const key of Object.keys(existingVars)) {
          if (key.startsWith('CHANNEL_')) delete existingVars[key]
        }
      }

      // 3. Merge: new non-empty vars override existing; existing keys preserved
      const mergedVars = { ...existingVars }
      for (const [key, value] of Object.entries(templateVars)) {
        if (value !== undefined && value !== null && value !== '') {
          mergedVars[key] = value
        }
      }

      // 4. Write merged .env
      const dotEnvContent = buildDotEnvContent(mergedVars)
      if (dotEnvContent.trim()) {
        await sandbox.files.write(dotEnvPath, dotEnvContent, writeOpts)
        // Ensure .env is readable by the process user. When sandbox_user is
        // known, strict 600 owned by that user. Otherwise fall back to 'node'
        // (OpenClaw's runtime user) so supervisord-launched processes can read.
        const chownUser = agentType.sandbox_user || 'node'
        const chmodMode = agentType.sandbox_user ? '600' : '644'
        await sandbox.commands.run(`chown ${chownUser}:${chownUser} ${dotEnvPath} && chmod ${chmodMode} ${dotEnvPath}`, {
          user: 'root',
          timeoutMs: 5000
        })
        console.log(`🔐 .env merged at ${dotEnvPath} (existing=${Object.keys(existingVars).length}, merged=${Object.keys(mergedVars).length}, owner=${chownUser})`)
      }
    } catch (envErr) {
      console.warn(`⚠️ Failed to pre-write .env file: ${envErr.message}`)
    }
  }

  try {
    const result = await sandbox.commands.run(`bash ${scriptPath}`, {
      user: agentType.sandbox_user || 'root',
      envs,
      timeoutMs: 30000
    })
    if (result.exitCode !== 0) {
      console.warn(`⚠️ modify command exited with code ${result.exitCode}`)
      if (result.stderr) console.warn(`   stderr: ${result.stderr.substring(0, 500)}`)
    } else {
      console.log(`✅ modify command executed successfully`)
    }
    return result
  } finally {
    // Best-effort cleanup: remove the temp script so it doesn't linger in the
    // sandbox filesystem between invocations. Uses the sandbox's own rm to
    // respect the sandbox user; we swallow any error since a stale script is
    // harmless (rewritten on the next run with a fresh timestamp).
    try {
      await sandbox.commands.run(`rm -f ${scriptPath}`, {
        user: agentType.sandbox_user || 'root',
        timeoutMs: 5000
      })
    } catch (cleanupErr) {
      console.warn(`⚠️ Failed to remove modify script ${scriptPath}: ${cleanupErr.message}`)
    }
  }
}

/**
 * Generate and write agent config to sandbox
 * @param {string|Object} sandboxOrId - The sandbox instance or sandbox ID
 * @param {Object} agentType - The agent type record from agent_types table
 * @param {Object} instanceData - Instance configuration data
 * @returns {Promise<string>} - The generated template content
 */
async function generateAndWriteAgentConfig(sandboxOrId, agentType, instanceData) {
  if (!agentType || !agentType.config_template) {
    throw new Error('Agent 配置模板未设置')
  }

  const configTemplate = agentType.config_template
  const configWritePath = agentType.config_write_path

  if (!configWritePath) {
    throw new Error(`Agent 配置 ${agentType.code} 未配置 config_write_path`)
  }

  const sandbox = await resolveSandbox(sandboxOrId)

  // Check if template is YAML format
  const isYaml = configTemplate._format === 'yaml'

  let templateContent
  if (isYaml) {
    templateContent = configTemplate._content || ''
  } else {
    const { _meta, _format, _content, ...templateObj } = configTemplate
    templateContent = JSON.stringify(templateObj)
  }

  console.log(`📄 Template loaded for agent type: ${agentType.code}, format: ${isYaml ? 'yaml' : 'json'}, length: ${templateContent.length}`)

  // Build template variables via shared helper
  const { templateVars, sensitiveCustomVarKeys } = await buildTemplateVars(agentType, instanceData)

  // For JSON templates, also scan template's models.providers for additional placeholder discovery
  if (!isYaml) {
    const { _meta: _m, _format: _f, _content: _c, ...cleanTemplate } = configTemplate
    const templateProviders = cleanTemplate.models?.providers || {}
    console.log(`🔧 Processing ${Object.keys(templateProviders).length} providers from template`)

    const { data: allProviderConfigs } = await supabaseAdmin
      .from('provider_config')
      .select('name, type, config, enabled')
    const providerConfigMap = new Map()
    for (const config of (allProviderConfigs || [])) {
      providerConfigMap.set(config.name, {
        name: config.name,
        type: config.type,
        isGateway: config.type === 'AlibabaCloudAIGateway' || config.type === 'LiteLLM',
        enabled: config.enabled,
        ...config.config
      })
    }

    for (const [providerCode, providerData] of Object.entries(templateProviders)) {
      const providerConfig = providerConfigMap.get(providerCode)
      if (!providerConfig) continue

      let apiKeyPlaceholder = providerConfig.apiKeyPlaceholder
      if (!apiKeyPlaceholder && providerData.apiKey) apiKeyPlaceholder = providerData.apiKey
      if (!apiKeyPlaceholder) continue
      const placeholderMatch = apiKeyPlaceholder.match(/\$\{(\w+)\}/)
      if (!placeholderMatch) continue
      const varName = placeholderMatch[1]
      if (templateVars[varName]) continue

      const isGateway = providerConfig.isGateway || false
      let apiKey = ''
      if (isGateway) {
        if (providerConfig.enabled && instanceData.consumerApikey) apiKey = instanceData.consumerApikey
      } else if (providerConfig.apiKey) {
        try { apiKey = decryptApiKey(providerConfig.apiKey) } catch (e) { /* ignore */ }
      }
      templateVars[varName] = apiKey
    }
  }

  logTemplateVars(templateVars, sensitiveCustomVarKeys)

  // When the agent type supports env-var resolution (e.g. OpenClaw), keep
  // ${VAR} placeholders in the config and write actual values to .env.
  // Otherwise, substitute all values directly into the config (old behaviour).
  const useEnvVars = agentType.supports_env_vars === true
  const configSubstVars = useEnvVars
    ? buildConfigSubstVars(templateVars)
    : templateVars

  templateContent = substituteTemplate(templateContent, configSubstVars)

  // Fix double protocol: when a domain value already contains http(s)://
  // and the template also has http://, the result is http://http://...
  // Keep the protocol from the actual value (the inner one).
  templateContent = templateContent.replace(/(https?:\/\/)(https?:\/\/)/g, '$2')

  console.log(`📄 Content after substitution length: ${templateContent.length}`)

  // For JSON templates, inject channel config
  if (!isYaml && agentType.supports_channels && instanceData.channelType) {
    let templateJson
    try {
      templateJson = JSON.parse(templateContent)
    } catch (parseError) {
      console.error('❌ JSON parse error:', parseError.message)
      throw new Error(`Failed to parse template as JSON: ${parseError.message}`)
    }

    // Load channel config from channel_templates table (filter by agent_type_id to avoid duplicates)
    const { data: channelTemplate } = await supabaseAdmin
      .from('channel_templates')
      .select('config_template')
      .eq('channel_type', instanceData.channelType)
      .eq('agent_type_id', agentType.id)
      .maybeSingle()

    if (channelTemplate?.config_template && Object.keys(channelTemplate.config_template).length > 0) {
      const chTpl = channelTemplate.config_template
      const isChannelYaml = chTpl._format === 'yaml'

      if (isChannelYaml) {
        // Channel config is YAML but agent template is JSON — skip injection, log warning
        console.warn(`⚠️  Channel config for ${instanceData.channelType} is YAML but agent template is JSON, skipping injection`)
      } else {
        let channelContent = JSON.stringify(chTpl)
        console.log(`📡 Channel config loaded from channel_templates for: ${instanceData.channelType}`)

        channelContent = channelContent.replace(/\$\{(\w+)\}|\$(\w+)/g, (match, braced, unbraced) => {
          const key = braced || unbraced
          return key in configSubstVars ? configSubstVars[key] : match
        })

        const channelConfig = JSON.parse(channelContent)
        if (!templateJson.channels) templateJson.channels = {}
        Object.assign(templateJson.channels, channelConfig)
        console.log(`📡 Injected ${instanceData.channelType} channel config`)
      }
    } else {
      console.warn(`⚠️  No channel config found for channel type: ${instanceData.channelType}`)
    }

    templateContent = JSON.stringify(templateJson, null, 2)
  }

  // For YAML templates, inject channel config by appending
  if (isYaml && agentType.supports_channels && instanceData.channelType) {
    const { data: channelTemplate } = await supabaseAdmin
      .from('channel_templates')
      .select('config_template')
      .eq('channel_type', instanceData.channelType)
      .eq('agent_type_id', agentType.id)
      .maybeSingle()

    if (channelTemplate?.config_template && Object.keys(channelTemplate.config_template).length > 0) {
      const chTpl = channelTemplate.config_template
      const isChannelYaml = chTpl._format === 'yaml'

      let channelContent
      if (isChannelYaml) {
        channelContent = chTpl._content || ''
      } else {
        // Channel config is JSON but agent template is YAML — convert to simple YAML-like key: value
        // Just inject as JSON string in a yaml comment block, or skip
        console.warn(`⚠️  Channel config for ${instanceData.channelType} is JSON but agent template is YAML, skipping injection`)
        channelContent = ''
      }

      if (channelContent) {
        // Variable substitution on channel content — sensitive vars preserved as placeholders
        channelContent = channelContent.replace(/\$\{(\w+)\}|\$(\w+)/g, (match, braced, unbraced) => {
          const key = braced || unbraced
          return key in configSubstVars ? configSubstVars[key] : match
        })

        // Append channel config to YAML template with a separator
        templateContent = templateContent.trimEnd() + '\n\n# Channel configuration\n' + channelContent
        console.log(`📡 Appended YAML channel config for: ${instanceData.channelType}`)
      }
    } else {
      console.warn(`⚠️  No channel config found for channel type: ${instanceData.channelType}`)
    }
  }

  // Inject skills configuration via SkillInjector (template method pattern)
  const skillInjector = createSkillInjector(agentType.code)
  if (skillInjector) {
    templateContent = await skillInjector.inject(sandbox, agentType, templateContent, instanceData.skillConfigSnapshot)
  } else if (agentType.skill_config && Array.isArray(agentType.skill_config) && agentType.skill_config.length > 0) {
    console.warn(`⚠️ No SkillInjector registered for agent type "${agentType.code}", skill_config will be ignored`)
  }

  console.log(`📝 Writing config to sandbox at path: ${configWritePath} (${templateContent.length} chars)${agentType.sandbox_user ? `, user: ${agentType.sandbox_user}` : ''}`)
  console.log(`📝 templateContent: ${templateContent}`)

  // Preserve ARMS / diagnostics observability segments written by entrypoint.sh.
  // If the existing openclaw.json already contains these segments (e.g. set up
  // by entrypoint.sh on Pod first-boot), the template overwrite below would lose
  // them, causing the ARMS OpenTelemetry plugin to not load — gateway reports
  // 0 plugins and no trace is ever reported.
  //
  // For JSON configs: read existing, deep-merge ARMS plugins.allow / ARMS
  // plugins.entries[opentelemetry-instrumentation-openclaw] / diagnostics.otel
  // from existing into templateContent before writing.
  // For YAML configs: no-op (YAML templates are append-style).
  if (!isYaml && configWritePath.endsWith('.json')) {
    try {
      const existingRaw = await sandbox.files.read(configWritePath)
      const existing = JSON.parse(existingRaw)
      const incoming = JSON.parse(templateContent)
      const PLUGIN_NAME = 'opentelemetry-instrumentation-openclaw'

      // Preserve plugins.allow entries that are not in incoming.plugins.allow
      // (e.g. ARMS plugin name added by entrypoint.sh).
      if (existing.plugins?.allow && Array.isArray(existing.plugins.allow)) {
        incoming.plugins = incoming.plugins || {}
        incoming.plugins.allow = Array.from(new Set([
          ...(incoming.plugins.allow || []),
          ...existing.plugins.allow
        ]))
      }
      // Preserve plugins.load.paths entries
      if (existing.plugins?.load?.paths && Array.isArray(existing.plugins.load.paths)) {
        incoming.plugins = incoming.plugins || {}
        incoming.plugins.load = incoming.plugins.load || {}
        incoming.plugins.load.paths = Array.from(new Set([
          ...(incoming.plugins.load?.paths || []),
          ...existing.plugins.load.paths
        ]))
      }
      // Preserve ARMS plugin entry if present in existing but not in incoming.
      if (existing.plugins?.entries?.[PLUGIN_NAME] && !incoming.plugins?.entries?.[PLUGIN_NAME]) {
        incoming.plugins = incoming.plugins || {}
        incoming.plugins.entries = incoming.plugins.entries || {}
        incoming.plugins.entries[PLUGIN_NAME] = existing.plugins.entries[PLUGIN_NAME]
      }
      // Preserve diagnostics.otel OTLP exporter config if present.
      if (existing.diagnostics?.otel && !incoming.diagnostics?.otel) {
        incoming.diagnostics = incoming.diagnostics || {}
        incoming.diagnostics.otel = existing.diagnostics.otel
        incoming.diagnostics.enabled = existing.diagnostics.enabled ?? true
      }

      templateContent = JSON.stringify(incoming, null, 2)
      console.log(`🔧 Merged ARMS / diagnostics segments from existing openclaw.json`)
    } catch (mergeErr) {
      // File may not exist yet, or not JSON — proceed with original templateContent.
      console.log(`🔧 Skipping ARMS merge (no existing config or not JSON): ${mergeErr.message}`)
    }
  }

  const writeOpts = agentType.sandbox_user ? { user: agentType.sandbox_user } : undefined
  try {
    await sandbox.files.write(configWritePath, templateContent, writeOpts)
  } catch (writeErr) {
    console.error(`❌ sandbox.files.write failed:`)
    console.error(`   name: ${writeErr.name}`)
    console.error(`   message: ${writeErr.message}`)
    console.error(`   cause: ${writeErr.cause ? JSON.stringify(writeErr.cause) : 'none'}`)
    console.error(`   stack: ${writeErr.stack}`)
    throw writeErr
  }
  console.log(`✅ Config written successfully to ${configWritePath}`)

  // Write .env only when the agent type resolves ${VAR} from .env at runtime.
  const dotEnvEntries = useEnvVars ? buildDotEnvContent(templateVars) : ''
  if (dotEnvEntries.trim()) {
    const configDir = configWritePath.substring(0, configWritePath.lastIndexOf('/'))
    const dotEnvPath = `${configDir}/.env`
    console.log(`🔐 Writing .env to ${dotEnvPath} (${Object.keys(templateVars).filter(k => templateVars[k]).length} vars)`)
    try {
      await sandbox.files.write(dotEnvPath, dotEnvEntries, writeOpts)
      // Ensure correct ownership and restrict read to owner only
      const chownUser = agentType.sandbox_user || 'root'
      await sandbox.commands.run(`chown ${chownUser}:${chownUser} ${dotEnvPath} && chmod 600 ${dotEnvPath}`, {
        user: 'root',
        timeoutMs: 5000
      })
      console.log(`✅ .env written and secured at ${dotEnvPath}`)
    } catch (envErr) {
      console.warn(`⚠️ Failed to write .env file: ${envErr.message}`)
    }
  }

  // Execute startup command if configured
  if (agentType.startup_command) {
    // SECURITY: route ALL templateVars through the sandbox process env as
    // `_AGENT_<VAR>` instead of substituting raw values into the script body.
    //
    // Without this, custom variables (and any other user/admin-controlled
    // value) containing shell metacharacters — `$(...)`, backticks, `;`, `&&`,
    // newlines, etc. — would be interpreted by bash as source code, giving the
    // user arbitrary command execution inside the sandbox. It also breaks
    // legitimate multi-line `textarea` values which would otherwise smash the
    // script structure (this is what stalls the lifecycle integration tests).
    //
    // Mirrors the `runModifyCommand` hardening — see `splitAllVars` for the
    // rationale in detail.
    const { safeVars, envs } = splitAllVars(templateVars)
    const startupCmd = agentType.startup_command.replace(/\$\{(\w+)\}|\$(\w+)/g, (match, braced, unbraced) => {
      const key = braced || unbraced
      if (key in safeVars) {
        return safeVars[key]
      }
      console.log(`   ⚠️ Startup command placeholder ${match} has no value, replacing with empty string`)
      return ''
    })

    // Write startup command to a temp script file and execute it
    // This ensures multi-line scripts (heredoc, etc.) work correctly
    const startupScriptPath = '/tmp/_agent_startup.sh'
    console.log(`🚀 Writing startup script to ${startupScriptPath} (${startupCmd.length} chars)`)
    try {
      const startupWriteOpts = agentType.sandbox_user ? { user: agentType.sandbox_user } : undefined
      await sandbox.files.write(startupScriptPath, startupCmd, startupWriteOpts)
      // Use a short timeout: if the script triggers a process/container restart
      // (e.g. hermes gateway restart), it will block or disconnect — that's expected.
      const result = await sandbox.commands.run(`bash ${startupScriptPath}`, {
        user: agentType.sandbox_user || 'root',
        envs,
        timeoutMs: 30000
      })
      if (result.exitCode !== 0) {
        console.warn(`⚠️ Startup command exited with code ${result.exitCode}`)
        if (result.stderr) console.warn(`   stderr: ${result.stderr.substring(0, 500)}`)
      } else {
        console.log(`✅ Startup command executed successfully`)
      }
    } catch (cmdError) {
      // Startup commands may cause process/container restarts (terminated, timeout, disconnect).
      // These are expected — the readiness check will verify the service is actually up.
      const msg = cmdError.message || ''
      console.warn(`⚠️ Startup command ended with: ${msg}`)
      console.log(`⏳ Waiting for sandbox to recover...`)
      await new Promise(resolve => setTimeout(resolve, 10000))
    }
  }

  return templateContent
}

/**
 * Get agent type by ID from database
 * @param {string} agentTypeId - UUID of the agent type
 * @returns {Promise<Object>} - The agent type record
 */
async function getAgentType(agentTypeId) {
  const { data, error } = await supabaseAdmin
    .from('agent_types')
    .select('*')
    .eq('id', agentTypeId)
    .single()

  if (error) throw error
  return data
}

/**
 * Get agent type by code from database
 * @param {string} code - Code of the agent type (e.g., 'openclaw')
 * @returns {Promise<Object>} - The agent type record
 */
async function getAgentTypeByCode(code) {
  const { data, error } = await supabaseAdmin
    .from('agent_types')
    .select('*')
    .eq('code', code)
    .single()

  if (error) throw error
  return data
}


export {
  generateAndWriteAgentConfig,
  getAgentType,
  getAgentTypeByCode,
  runModifyCommand,
  substituteTemplate,
  buildTemplateVars
}
