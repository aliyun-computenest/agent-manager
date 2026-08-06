/**
 * Environment Variables Management Service
 * Handles updating and reloading environment variables
 */

import { readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { env } from '../config/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const envPath = join(__dirname, '..', '..', '.env')

/**
 * Update .env file with new values
 * @param {Object} updates - Key-value pairs to update
 */
function updateEnvFile(updates) {
  let content = readFileSync(envPath, 'utf-8')

  for (const [key, value] of Object.entries(updates)) {
    const regex = new RegExp(`^${key}=.*$`, 'm')
    const newLine = `${key}=${value}`

    if (regex.test(content)) {
      content = content.replace(regex, newLine)
    } else {
      content += `\n${newLine}`
    }
  }

  writeFileSync(envPath, content, 'utf-8')

  // Reload env
  Object.assign(env, updates)
}

/**
 * Reload environment variables from .env file
 */
function reloadEnv() {
  const envContent = readFileSync(envPath, 'utf-8')

  envContent.split('\n').forEach(line => {
    if (!line || line.startsWith('#')) return
    const match = line.match(/^([^=]+)=(.*)$/)
    if (match) {
      const key = match[1].trim()
      let value = match[2].trim()
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      env[key] = value
    }
  })
}

export {
  updateEnvFile,
  reloadEnv
}
