/**
 * E2B Sandbox Service
 * Handles sandbox pause, resume, and lifecycle operations
 */

import { Sandbox } from '@e2b/code-interpreter'
import { E2B_DOMAIN, E2B_API_KEY } from '../config/index.js'

/**
 * Pause sandbox with retry mechanism
 * Aligns with Python SDK's sandbox.beta_pause() behavior
 * Fallback to REST API if beta_pause is not available
 * @param {Sandbox} sandbox - The sandbox instance
 * @param {string} sandboxId - The sandbox ID
 * @param {number} maxRetries - Maximum retry attempts (default: 5)
 * @param {number} retryDelay - Delay between retries in ms (default: 5000)
 */
async function pauseSandbox(sandbox, sandboxId, maxRetries = 5, retryDelay = 5000) {
  let lastError = null
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`▶️  Attempting to pause sandbox (attempt ${attempt}/${maxRetries})...`)
      
      const apiDomain = E2B_DOMAIN || 'e2b.dev'
      const pauseUrl = `https://api.${apiDomain}/sandboxes/${sandboxId}/pause`
      
      const response = await fetch(pauseUrl, {
        method: 'POST',
        headers: {
          'X-API-Key': E2B_API_KEY,
          'Content-Type': 'application/json'
        }
      })
      
      if (response.ok) {
        console.log(`⏸️  REST API pause succeeded`)
        return true
      }
      
      const errorText = await response.text()
      throw new Error(`REST API pause failed: ${response.status} - ${errorText}`)
      
    } catch (e) {
      lastError = e
      const errorMsg = e.message?.toLowerCase() || ''
      
      // Only retry for 'not satisfied' or 'double check' errors
      if (errorMsg.includes('not satisfied') || errorMsg.includes('double check')) {
        console.log(`⏸️  Pause attempt ${attempt} failed with retryable error: ${e.message}`)
        if (attempt < maxRetries) {
          console.log(`⏸️  Waiting ${retryDelay/1000}s before retry...`)
          await new Promise(resolve => setTimeout(resolve, retryDelay))
          continue
        }
      } else {
        // Non-retryable error, throw immediately
        throw e
      }
    }
  }
  
  throw lastError || new Error('Pause failed after all retries')
}

/**
 * Resume sandbox with retry mechanism
 * Uses REST API to resume paused sandbox, then connects
 * @param {string} sandboxId - The sandbox ID
 * @param {number} timeout - Connection timeout in ms (default: 180000)
 * @param {number} maxRetries - Maximum retry attempts (default: 5)
 * @param {number} retryDelay - Delay between retries in ms (default: 5000)
 * @returns {Promise<Sandbox>} - The connected sandbox instance
 */
async function resumeSandbox(sandboxId, timeout = 180000, maxRetries = 5, retryDelay = 5000) {
  let lastError = null
  const apiDomain = E2B_DOMAIN || 'e2b.dev'
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`▶️  Attempting to resume sandbox (attempt ${attempt}/${maxRetries})...`)
      const startTime = Date.now()
      
      // Step 1: Call REST API to resume the sandbox
      console.log(`▶️  Calling REST API to resume sandbox...`)
      const resumeUrl = `https://api.${apiDomain}/sandboxes/${sandboxId}/resume`
      
      const response = await fetch(resumeUrl, {
        method: 'POST',
        headers: {
          'X-API-Key': E2B_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ timeout: 180 })
      })
      
      const responseText = await response.text()
      console.log(`▶️  Resume API response: ${response.status} - ${responseText.substring(0, 200)}`)
      
      if (!response.ok && response.status !== 409) {
        console.log(`▶️  Resume API failed, will retry...`)
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, retryDelay))
          continue
        }
        throw new Error(`Resume API failed: ${response.status} - ${responseText}`)
      }
      
      console.log(`▶️  Resume API succeeded!`)
      
      // Step 2: Wait for sandbox to wake up
      console.log(`▶️  Waiting 10s for sandbox to fully wake up...`)
      await new Promise(resolve => setTimeout(resolve, 10000))
      
      // Step 3: Connect to the sandbox
      console.log(`▶️  Connecting to sandbox...`)
      const sandbox = await Sandbox.connect(sandboxId, { timeout })
      
      const totalTime = (Date.now() - startTime) / 1000
      console.log(`▶️  Sandbox resumed and connected in ${totalTime.toFixed(2)}s`)
      
      return sandbox
      
    } catch (e) {
      lastError = e
      console.log(`▶️  Resume attempt ${attempt} failed: ${e.message}`)
      
      if (attempt < maxRetries) {
        console.log(`▶️  Waiting ${retryDelay/1000}s before retry...`)
        await new Promise(resolve => setTimeout(resolve, retryDelay))
        continue
      }
    }
  }
  
  throw lastError || new Error('Resume failed after all retries')
}

/**
 * Wait for sandbox to become ready
 * @param {string} sandboxId - The sandbox ID
 * @param {number} maxWaitTime - Maximum wait time in ms (default: 120000)
 * @param {number} pollInterval - Polling interval in ms (default: 2000)
 * @returns {Promise<boolean>} - Whether sandbox is ready
 */
async function waitForSandboxReady(sandboxId, maxWaitTime = 120000, pollInterval = 2000) {
  console.log('⏳ Waiting for sandbox to be ready...')
  const startTime = Date.now()
  
  while ((Date.now() - startTime) < maxWaitTime) {
    try {
      const testSandbox = await Sandbox.connect(sandboxId)
      console.log('✅ Sandbox is ready!')
      return true
    } catch (e) {
      console.log(`   Sandbox not ready yet: ${e.message}, retrying...`)
    }
    await new Promise(resolve => setTimeout(resolve, pollInterval))
  }
  
  console.warn('⚠️ Sandbox did not become ready within timeout, proceeding anyway...')
  return false
}

/**
 * Wait for agent service to be ready based on readiness_check config
 * Supports two check types:
 *   - http: polls an HTTP endpoint until it returns 200
 *   - tcp: polls a TCP port until it's connectable
 * @param {Sandbox} sandbox - The sandbox instance
 * @param {string} token - Access token for the gateway
 * @param {Object} readinessCheck - Readiness check config from agent_types {type, port, path, timeout}
 * @param {number} pollInterval - Polling interval in ms (default: 2000)
 * @returns {Promise<boolean>} - Whether service is ready
 */
async function waitForGatewayReady(sandbox, token, readinessCheck = {}, pollInterval = 2000) {
  const checkType = readinessCheck.type || 'http'
  const port = readinessCheck.port || 18789
  const healthPath = readinessCheck.path || '/'
  const maxWaitTime = (readinessCheck.timeout || 120) * 1000

  console.log(`⏳ Polling for service readiness (type: ${checkType}, port: ${port}, timeout: ${maxWaitTime / 1000}s)...`)
  const startTime = Date.now()

  if (checkType === 'tcp') {
    // TCP readiness check: try to get the host for the port
    while ((Date.now() - startTime) < maxWaitTime) {
      try {
        const host = sandbox.getHost(port)
        const url = `https://${host}/`
        const response = await fetch(url, {
          method: 'GET',
          signal: AbortSignal.timeout(5000)
        })
        // Any response (even non-200) means the port is listening
        console.log(`✅ Service is ready on port ${port} (status: ${response.status})`)
        return true
      } catch (e) {
        if (e.name === 'TimeoutError') {
          console.log(`   TCP check on port ${port}: timeout, retrying...`)
        } else {
          console.log(`   TCP check on port ${port}: ${e.message}, retrying...`)
        }
      }
      await new Promise(resolve => setTimeout(resolve, pollInterval))
    }
  } else {
    // HTTP readiness check (default)
    const host = sandbox.getHost(port)
    const baseUrl = `https://${host}`
    const checkUrl = healthPath === '/' 
      ? `${baseUrl}/?token=${token}` 
      : `${baseUrl}${healthPath}`

    while ((Date.now() - startTime) < maxWaitTime) {
      try {
        const response = await fetch(checkUrl, {
          method: 'GET',
          signal: AbortSignal.timeout(5000)
        })

        if (response.status === 200) {
          console.log('✅ Gateway is ready!')
          return true
        } else {
          console.log(`   Status: ${response.status}, retrying...`)
        }
      } catch (e) {
        if (e.name === 'TimeoutError') {
          console.log('   Request timeout, retrying...')
        } else {
          console.log(`   Connection error: ${e.message}, retrying...`)
        }
      }
      await new Promise(resolve => setTimeout(resolve, pollInterval))
    }
  }

  console.warn('⚠️ Service did not become ready within timeout, proceeding anyway...')
  return false
}

/**
 * Get sandbox status via API
 * @param {string} sandboxId - The sandbox ID
 * @returns {Promise<string|null>} - Sandbox status or null if not found
 */
async function getSandboxStatus(sandboxId) {
  try {
    const apiDomain = E2B_DOMAIN || 'e2b.dev'
    const sandboxInfoUrl = `https://api.${apiDomain}/sandboxes/${sandboxId}`

    const response = await fetch(sandboxInfoUrl, {
      method: 'GET',
      headers: {
        'X-API-Key': E2B_API_KEY,
        'Content-Type': 'application/json'
      }
    })

    if (response.ok) {
      const sandboxData = await response.json()
      return sandboxData.state || sandboxData.status || 'unknown'
    } else if (response.status === 404) {
      return 'not_found'
    }
    
    return null
  } catch (e) {
    console.error(`Failed to get sandbox status: ${e.message}`)
    return null
  }
}

export {
  pauseSandbox,
  resumeSandbox,
  waitForSandboxReady,
  waitForGatewayReady,
  getSandboxStatus
}
