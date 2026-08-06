// SSL Certificate - use the CA cert file instead of disabling verification
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { readFileSync } from 'fs'
import { execSync } from 'child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
process.env.SSL_CERT_FILE = join(__dirname, '..', 'data', 'ca-fullchain.pem')
process.env.NODE_EXTRA_CA_CERTS = join(__dirname, '..', 'data', 'ca-fullchain.pem')

// E2B Configuration
process.env.E2B_DOMAIN = 'agent-vpc.infra'
process.env.E2B_API_KEY = 'e2b_v8oblgjnpz8xmgjjpnd4a1y5vb5i9wqw'

// Disable SSL verification for fetch requests
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

import { Sandbox } from '@e2b/code-interpreter'

// Helper function to sleep
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

async function testE2B() {
  console.log('Hello from openclaw-demo!')
  console.log('E2B_DOMAIN:', process.env.E2B_DOMAIN)
  console.log('E2B_API_KEY:', process.env.E2B_API_KEY ? '***' + process.env.E2B_API_KEY.slice(-6) : 'NOT SET')

  let sandbox = null

  try {
    // Step 1: Create sandbox
    console.log('\n[Step 1] Creating sandbox...')
    let startTime = Date.now()
    
    sandbox = await Sandbox.create('openclaw', {
      metadata: {
        'e2b.agents.kruise.io/never-timeout': 'true'
      }
    })
    
    console.log(`Created sandbox in ${((Date.now() - startTime) / 1000).toFixed(2)} seconds`)
    console.log(`Sandbox ID: ${sandbox.sandboxId}`)

    // Auto add /etc/hosts entries
    const E2B_IP = 'xx.xx.xx.xx'
    const hosts = [
      `${E2B_IP} 18789-${sandbox.sandboxId}.agent-vpc.infra`,
      `${E2B_IP} 49983-${sandbox.sandboxId}.agent-vpc.infra`
    ]
    console.log('\n[Auto] Adding /etc/hosts entries...')
    for (const entry of hosts) {
      try {
        const hostname = entry.split(' ')[1]
        const check = execSync(`grep -q "${hostname}" /etc/hosts && echo exists || echo missing`, { encoding: 'utf-8' }).trim()
        if (check === 'missing') {
          execSync(`echo "${entry}" | sudo tee -a /etc/hosts`, { stdio: 'inherit' })
          console.log(`Added: ${entry}`)
        } else {
          console.log(`Exists: ${hostname}`)
        }
      } catch (e) {
        console.log(`Failed: ${e.message}`)
      }
    }

    // Read environment variables
    const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || 'clawdbot-mode-123456'
    const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY || 'sk-****'

    // Read and render template file
    console.log('\n[Step 2] Rendering openclaw-template.json...')
    const templatePath = join(__dirname, '..', 'data', 'openclaw-template.json')
    const templateContent = readFileSync(templatePath, 'utf-8')
    
    // Simple template substitution
    const renderedContent = templateContent
      .replace(/\$\{GATEWAY_TOKEN\}/g, GATEWAY_TOKEN)
      .replace(/\$\{DASHSCOPE_API_KEY\}/g, DASHSCOPE_API_KEY)
      .replace(/\$MODEL_NAME/g, '')
      .replace(/\$MODEL_PROVIDER/g, '')
    
    await sandbox.files.write('/home/node/.openclaw/openclaw.json', renderedContent, { user: 'node' })
    console.log('Wrote rendered config to /home/node/.openclaw/openclaw.json')

    // Wait for gateway to start
    console.log('Waiting 30 seconds for gateway to start...')
    await sleep(30000)

    // Step 3: Wait for service to be ready
    console.log('\n[Step 3] Waiting for service to be ready...')
    const host = sandbox.getHost(18789)
    const baseUrl = `https://${host}`
    console.log(`base_url: ${baseUrl}`)
    
    startTime = Date.now()
    let ready = false
    
    while (!ready) {
      try {
        const response = await fetch(`${baseUrl}/?token=${GATEWAY_TOKEN}`, {
          method: 'GET',
          signal: AbortSignal.timeout(5000)
        })
        console.log(`Response status: ${response.status}`)
        
        if (response.status === 200) {
          const text = await response.text()
          console.log('Service is ready!')
          console.log(`Response content: ${text.substring(0, 200)}...`)
          ready = true
          break
        }
      } catch (e) {
        if (e.name === 'TimeoutError') {
          console.log('Request timeout, continuing to wait...')
        } else {
          console.log(`Connection error: ${e.message}`)
        }
      }
      await sleep(500)
      console.log('waiting...')
    }
    
    console.log(`Total wait time: ${((Date.now() - startTime) / 1000).toFixed(2)} seconds`)

    console.log('\nAll steps completed!')

  } catch (error) {
    console.error('❌ Error:', error.message)
    console.error('')
    console.error('Full error:')
    console.error(error)
  }
}

testE2B()
