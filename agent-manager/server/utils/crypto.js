/**
 * Cryptographic Utilities
 * RC4 symmetric encryption for API keys storage
 */

import { env } from '../config/index.js'

// RC4 encryption key from environment variable
// If not set, use a default key (should be configured in production)
const getEncryptionKey = () => {
  return env.API_ENCRYPTION_KEY
}

// Log encryption key source on module load
const keySource = env.API_ENCRYPTION_KEY ? 'env.API_ENCRYPTION_KEY' : 'default'
console.log(`🔐 Crypto: Using encryption key from ${keySource}`)

/**
 * RC4 Key Scheduling Algorithm (KSA)
 * Initializes the permutation array S
 * @param {Buffer} key - The encryption key
 * @returns {Uint8Array} - Initialized S-box
 */
function rc4Init(key) {
  const S = new Uint8Array(256)
  
  // Initialize S with identity permutation
  for (let i = 0; i < 256; i++) {
    S[i] = i
  }
  
  // Key scheduling algorithm
  let j = 0
  for (let i = 0; i < 256; i++) {
    j = (j + S[i] + key[i % key.length]) & 255
    // Swap S[i] and S[j]
    const temp = S[i]
    S[i] = S[j]
    S[j] = temp
  }
  
  return S
}

/**
 * RC4 Pseudo-Random Generation Algorithm (PRGA)
 * Generates keystream and XORs with data
 * @param {Uint8Array} S - Initialized S-box
 * @param {Buffer} data - Data to encrypt/decrypt
 * @returns {Buffer} - Encrypted/decrypted data
 */
function rc4Process(S, data) {
  // Create a copy of S to avoid modifying the original
  const state = new Uint8Array(S)
  const output = Buffer.alloc(data.length)
  
  let i = 0
  let j = 0
  
  for (let k = 0; k < data.length; k++) {
    i = (i + 1) & 255
    j = (j + state[i]) & 255
    
    // Swap state[i] and state[j]
    const temp = state[i]
    state[i] = state[j]
    state[j] = temp
    
    // Generate keystream byte and XOR with data
    const keystreamByte = state[(state[i] + state[j]) & 255]
    output[k] = data[k] ^ keystreamByte
  }
  
  return output
}

/**
 * Encrypt API key using RC4 symmetric encryption
 * Returns base64-encoded ciphertext for safe storage
 * @param {string} apikey - The API key to encrypt
 * @returns {string} - Base64-encoded encrypted API key
 */
function encryptApiKey(apikey) {
  if (!apikey) return ''
  
  const key = Buffer.from(getEncryptionKey(), 'utf-8')
  const plaintext = Buffer.from(apikey, 'utf-8')
  
  // Initialize RC4 state
  const S = rc4Init(key)
  
  // Encrypt the data
  const ciphertext = rc4Process(S, plaintext)
  
  // Return base64-encoded ciphertext
  return ciphertext.toString('base64')
}

/**
 * Decrypt API key using RC4 symmetric encryption
 * @param {string} encrypted - Base64-encoded encrypted API key
 * @returns {string} - Decrypted API key
 */
function decryptApiKey(encrypted) {
  if (!encrypted) return ''
  
  const key = Buffer.from(getEncryptionKey(), 'utf-8')
  const ciphertext = Buffer.from(encrypted, 'base64')
  
  // Initialize RC4 state
  const S = rc4Init(key)
  
  // Decrypt the data (RC4 is symmetric, same operation)
  const plaintext = rc4Process(S, ciphertext)
  
  return plaintext.toString('utf-8')
}

// Known gateway provider names for consumer key type prefix
const KNOWN_PROVIDER_NAMES = new Set(['api_gateway', 'litellm'])

function getConsumerKeyProvider(storedValue) {
  if (!storedValue || typeof storedValue !== 'string') return null
  const colonIdx = storedValue.indexOf(':')
  if (colonIdx <= 0) return null
  const prefix = storedValue.substring(0, colonIdx)
  return KNOWN_PROVIDER_NAMES.has(prefix) ? prefix : null
}

/**
 * Encode a consumer API key with a provider type prefix.
 * Stores as `providerName:base64encrypted` so the type can be read without decryption.
 * @param {string} providerName - e.g. 'api_gateway', 'litellm'
 * @param {string} apikey - The plaintext API key
 * @returns {string} - `providerName:base64encrypted`
 */
function encodeConsumerKey(providerName, apikey) {
  if (!apikey) return ''
  const encrypted = encryptApiKey(apikey)
  return `${providerName}:${encrypted}`
}

/**
 * Decode a consumer API key, extracting the provider type prefix.
 * Handles both new format (`type:encrypted`) and legacy format (plain encrypted).
 * @param {string} storedValue - The stored consumer_apikey_encrypted value
 * @returns {{ type: string|null, apikey: string }}
 */
function decodeConsumerKey(storedValue) {
  if (!storedValue) return { type: null, apikey: '' }

  const colonIdx = storedValue.indexOf(':')
  if (colonIdx > 0) {
    const prefix = getConsumerKeyProvider(storedValue)
    if (prefix) {
      const encryptedPart = storedValue.substring(colonIdx + 1)
      return { type: prefix, apikey: decryptApiKey(encryptedPart) }
    }
  }

  // Legacy format: no recognized prefix, treat entire value as encrypted
  return { type: null, apikey: decryptApiKey(storedValue) }
}

/**
 * Mask API key for display
 * @param {string} apiKey - The API key to mask
 * @returns {string} - Masked API key
 */
function maskApiKey(apiKey) {
  if (!apiKey) return ''
  if (apiKey.length <= 4) return '***'
  if (apiKey.length <= 8) return `${apiKey.substring(0, 2)}***`
  return `${apiKey.substring(0, 4)}...${apiKey.slice(-4)}`
}

export {
  encryptApiKey,
  decryptApiKey,
  encodeConsumerKey,
  decodeConsumerKey,
  getConsumerKeyProvider,
  maskApiKey
}
