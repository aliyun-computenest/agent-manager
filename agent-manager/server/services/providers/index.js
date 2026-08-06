/**
 * Provider Factory
 * Creates appropriate provider instances based on type
 */

import { APIProvider } from './APIProvider.js'
import { AlibabaCloudAIGatewayProvider } from './AlibabaCloudAIGatewayProvider.js'
import { LiteLLMProvider } from './LiteLLMProvider.js'
import { supabaseAdmin } from '../../config/index.js'

// Provider type registry
const PROVIDER_REGISTRY = {
  'API': APIProvider,
  'AlibabaCloudAIGateway': AlibabaCloudAIGatewayProvider,
  'LiteLLM': LiteLLMProvider
}

/**
 * Create a provider instance
 * @param {string} name - Provider name
 * @param {string} type - Provider type ('API' | 'AlibabaCloudAIGateway')
 * @param {object} config - Provider configuration
 * @returns {BaseProvider} Provider instance
 */
export function createProvider(name, type, config = {}) {
  const ProviderClass = PROVIDER_REGISTRY[type]
  
  if (!ProviderClass) {
    throw new Error(`Unknown provider type: ${type}. Supported types: ${Object.keys(PROVIDER_REGISTRY).join(', ')}`)
  }
  
  return new ProviderClass(config, name)
}

/**
 * Create a provider instance from database
 * @param {string} name - Provider name
 * @returns {Promise<BaseProvider>} Provider instance
 */
export async function createProviderFromDB(name) {
  const { data, error } = await supabaseAdmin
    .from('provider_config')
    .select('name, display_name, type, config, enabled, description')
    .eq('name', name)
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to load provider: ${error.message}`)
  }

  if (!data) {
    throw new Error(`Provider not found: ${name}`)
  }

  console.log(`[ProviderFactory] createProviderFromDB('${name}'): DB type='${data.type}', config keys=[${Object.keys(data.config || {}).join(', ')}]`)
  const provider = createProvider(data.name, data.type, data.config)
  provider.metadata = {
    displayName: data.display_name,
    isEnabled: data.enabled,
    description: data.description,
  }
  return provider
}

/**
 * Get all providers from database
 * @returns {Promise<Array<BaseProvider>>} Array of provider instances
 */
export async function getAllProviders() {
  const { data, error } = await supabaseAdmin
    .from('provider_config')
    .select('name, type, config')

  if (error) {
    throw new Error(`Failed to load providers: ${error.message}`)
  }

  return (data || []).map(row => createProvider(row.name, row.type, row.config))
}

/**
 * Register a new provider type
 * @param {string} type - Provider type name
 * @param {class} ProviderClass - Provider class extending BaseProvider
 */
export function registerProviderType(type, ProviderClass) {
  PROVIDER_REGISTRY[type] = ProviderClass
}

/**
 * Get supported provider types
 * @returns {string[]} Array of supported provider type names
 */
export function getSupportedProviderTypes() {
  return Object.keys(PROVIDER_REGISTRY)
}

// Re-export provider classes
export { BaseProvider } from './BaseProvider.js'
export { APIProvider } from './APIProvider.js'
export { AlibabaCloudAIGatewayProvider } from './AlibabaCloudAIGatewayProvider.js'
export { LiteLLMProvider } from './LiteLLMProvider.js'
