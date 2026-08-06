import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { createClient } from '@supabase/supabase-js'

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
  const email = process.argv[2] || 'e2e-admin-fwx1y2@openclaw.local'

  const supabase = createClient(env.VITE_SUPABASE_URL, env.SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })

  const { data: usersData, error: usersError } = await supabase.auth.admin.listUsers()
  if (usersError) {
    throw usersError
  }

  const user = usersData.users.find((item) => item.email === email)
  if (!user) {
    throw new Error(`Admin user not found: ${email}`)
  }

  const payload = {
    id: user.id,
    principal_type: 'user',
    name: user.user_metadata?.username || email.split('@')[0],
    email,
    role: 'admin',
    status: 'active',
    max_agent_instances: 999,
    is_first_login: true,
  }

  const { data, error } = await supabase
    .from('principal_profiles')
    .upsert(payload, { onConflict: 'id' })
    .select('id, email, role, status')
    .single()

  if (error) {
    throw error
  }

  console.log(JSON.stringify({
    ok: true,
    userId: data.id,
    email: data.email,
    role: data.role,
    status: data.status,
    supabaseUrl: env.VITE_SUPABASE_URL,
  }))
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, message: error.message }))
  process.exit(1)
})
