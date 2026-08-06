import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

function loadEnv() {
  const envPath = join(__dirname, '..', '.env')
  const envContent = readFileSync(envPath, 'utf-8')
  const env = {}

  for (const rawLine of envContent.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const idx = line.indexOf('=')
    if (idx === -1) continue
    env[line.slice(0, idx)] = line.slice(idx + 1)
  }

  return env
}

async function main() {
  const env = loadEnv()
  const frontendUrl = 'http://localhost:5173'
  const baseUrl = env.VITE_SUPABASE_URL
  const apiUrl = env.VITE_API_URL
  const email = 'e2e-admin-fwx1y2@openclaw.local'
  const password = 'admin123'

  const frontendRes = await fetch(frontendUrl)
  const frontendHtml = await frontendRes.text()
  const titleMatch = frontendHtml.match(/<title>([^<]+)<\/title>/i)
  console.log(JSON.stringify({
    step: 'frontend',
    ok: frontendRes.ok,
    status: frontendRes.status,
    title: titleMatch ? titleMatch[1] : null,
  }))

  const loginRes = await fetch(`${baseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: env.VITE_SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ email, password }),
  })
  const loginData = await loginRes.json()

  if (!loginRes.ok || !loginData.access_token) {
    console.log(JSON.stringify({
      step: 'login',
      ok: false,
      status: loginRes.status,
      body: loginData,
    }))
    process.exit(1)
  }

  const token = loginData.access_token
  console.log(JSON.stringify({
    step: 'login',
    ok: true,
    status: loginRes.status,
    email: loginData.user?.email,
    userId: loginData.user?.id,
  }))

  const usersRes = await fetch(`${apiUrl}/api/users?page=1&pageSize=2`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })
  const usersData = await usersRes.json()
  console.log(JSON.stringify({
    step: 'list',
    ok: usersRes.ok,
    status: usersRes.status,
    total: usersData.pagination?.total ?? null,
    firstEmail: usersData.users?.[0]?.email ?? null,
    error: usersData.error ?? null,
  }))

  const unique = Date.now().toString()
  const emailUser = `restart-email-${unique}@example.com`
  const samlUser = `restart-saml-${unique}@openclaw.local`

  const emailRes = await fetch(`${apiUrl}/api/users/batch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      users: [
        {
          email: emailUser,
          password: 'Test123456!',
          username: `RestartEmail${unique}`,
          role: 'user',
          authProvider: 'email',
          maxInstances: 2,
          dailyTokenLimit: 50000,
        },
      ],
    }),
  })
  const emailData = await emailRes.json()
  console.log(JSON.stringify({
    step: 'batch_email',
    ok: emailRes.ok,
    status: emailRes.status,
    created: emailData.created ?? null,
    failed: emailData.failed ?? null,
    email: emailUser,
    error: emailData.error ?? null,
  }))

  const samlRes = await fetch(`${apiUrl}/api/users/batch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      users: [
        {
          email: samlUser,
          username: `RestartSaml${unique}`,
          role: 'user',
          authProvider: 'saml',
          maxInstances: 1,
          dailyTokenLimit: 30000,
        },
      ],
    }),
  })
  const samlData = await samlRes.json()
  console.log(JSON.stringify({
    step: 'batch_saml',
    ok: samlRes.ok,
    status: samlRes.status,
    created: samlData.created ?? null,
    failed: samlData.failed ?? null,
    email: samlUser,
    error: samlData.error ?? null,
  }))

  const verifyRes = await fetch(`${apiUrl}/api/users?page=1&pageSize=20&search=${encodeURIComponent(emailUser)}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })
  const verifyData = await verifyRes.json()
  const foundEmail = Array.isArray(verifyData.users) && verifyData.users.some((item) => item.email === emailUser)
  console.log(JSON.stringify({
    step: 'verify',
    ok: verifyRes.ok,
    status: verifyRes.status,
    foundEmail,
    error: verifyData.error ?? null,
  }))
}

main().catch((error) => {
  console.error(JSON.stringify({ step: 'fatal', ok: false, message: error.message }))
  process.exit(1)
})