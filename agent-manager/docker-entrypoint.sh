#!/bin/sh
set -e

echo "=== Agent Manager Starting ==="

# Trust E2B self-signed CA certificate (must be set before any Node.js process starts)
if [ -f /app/data/ca-fullchain.pem ]; then
  export NODE_EXTRA_CA_CERTS=/app/data/ca-fullchain.pem
  export SSL_CERT_FILE=/app/data/ca-fullchain.pem
  echo "Loaded CA certificate: /app/data/ca-fullchain.pem"
fi

# ============================================================
# Step 1: Inject runtime environment variables into frontend
# ============================================================
# Vite embeds env vars at build time, so we need to replace placeholders
# or generate a runtime config file that the frontend can load.
CONFIG_FILE="/app/dist/env-config.js"

node > "$CONFIG_FILE" <<'NODE'
const env = {
  VITE_SUPABASE_URL: process.env.VITE_SUPABASE_URL || '',
  VITE_SUPABASE_ANON_KEY: process.env.VITE_SUPABASE_ANON_KEY || '',
  VITE_OSS_URL: process.env.VITE_OSS_URL || '',
  VITE_OSS_PV_NAME: process.env.VITE_OSS_PV_NAME || '',
  VITE_SKILLHUB_OSS_PV_NAME: process.env.VITE_SKILLHUB_OSS_PV_NAME || ''
}
process.stdout.write(`window.__ENV__ = ${JSON.stringify(env)};\n`)
NODE

echo "Generated runtime env config: $CONFIG_FILE"

# Inject env-config.js script tag into index.html if not already present
if ! grep -q "env-config.js" /app/dist/index.html; then
  sed -i 's|<head>|<head><script src="/env-config.js"></script>|' /app/dist/index.html
  echo "Injected env-config.js into index.html"
fi

# Safety: strip any hardcoded localhost:3001 from built JS assets
# so the frontend always uses relative /api path through the 8080 reverse proxy
for jsfile in /app/dist/assets/*.js; do
  if grep -q "http://localhost:3001" "$jsfile"; then
    sed -i 's|http://localhost:3001||g' "$jsfile"
    echo "Stripped localhost:3001 from $(basename $jsfile)"
  fi
done

# ============================================================
# Step 2: Write .env file for server and migrations to read
# ============================================================
ENV_FILE="/app/.env"
cat > "$ENV_FILE" <<EOF
VITE_SUPABASE_URL=${VITE_SUPABASE_URL}
SUPABASE_INTERNAL_URL=${SUPABASE_INTERNAL_URL}
VITE_SUPABASE_ANON_KEY=${VITE_SUPABASE_ANON_KEY}
SERVICE_ROLE_KEY=${SERVICE_ROLE_KEY}
E2B_DOMAIN=${E2B_DOMAIN}
E2B_API_KEY=${E2B_API_KEY}
AGENT_GATEWAY_DOMAIN=${AGENT_GATEWAY_DOMAIN}
DEPLOY_ENVIRONMENT=${DEPLOY_ENVIRONMENT:-cloud-dev}
API_ENCRYPTION_KEY=${API_ENCRYPTION_KEY:-$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")}
DATABASE_URL=${DATABASE_URL}
SERVER_PORT=3001
VITE_OSS_URL=${VITE_OSS_URL}
VITE_OSS_PV_NAME=${VITE_OSS_PV_NAME}
ADMIN_EMAIL=${ADMIN_EMAIL}
ADMIN_PASSWORD=${ADMIN_PASSWORD}
OPENCLAW_TEMPLATE_PATH=${OPENCLAW_TEMPLATE_PATH:-/app/data/openclaw-template.json}
TERMINAL_SESSION_SECRET=${TERMINAL_SESSION_SECRET:-}
TERMINAL_MAX_SESSIONS_PER_USER=${TERMINAL_MAX_SESSIONS_PER_USER:-}
TERMINAL_MAX_SESSIONS_PER_INSTANCE=${TERMINAL_MAX_SESSIONS_PER_INSTANCE:-}
TERMINAL_SESSION_TTL_SECONDS=${TERMINAL_SESSION_TTL_SECONDS:-}
TERMINAL_IDLE_TIMEOUT_SECONDS=${TERMINAL_IDLE_TIMEOUT_SECONDS:-}
TERMINAL_SESSION_MAX_LIFETIME_SECONDS=${TERMINAL_SESSION_MAX_LIFETIME_SECONDS:-}
TERMINAL_OUTPUT_BUFFER_BYTES=${TERMINAL_OUTPUT_BUFFER_BYTES:-}
EOF

echo "Generated .env file for server"

# ============================================================
# Step 3: Run database migrations if DATABASE_URL is set
# Only runs on first deployment; skips if tables already exist
# ============================================================
if [ -n "$DATABASE_URL" ] && [ "$RUN_MIGRATIONS" = "true" ]; then
  cd /app

  # Check if database is already initialized by querying for the migration marker table
  DB_INITIALIZED=$(node -e "
    const fs = require('fs');
    const envContent = fs.readFileSync('/app/.env', 'utf-8');
    const vars = {};
    envContent.split('\n').forEach(l => { const m = l.match(/^([^=]+)=(.*)$/); if (m) vars[m[1].trim()] = m[2].trim(); });
    const dbUrl = vars.DATABASE_URL;
    if (!dbUrl || !dbUrl.startsWith('postgresql://')) { console.log('unknown'); process.exit(0); }
    const pg = require('pg');
    const m = dbUrl.match(/postgresql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)/);
    if (!m) { console.log('unknown'); process.exit(0); }
    const client = new pg.Client({ user: m[1], password: m[2], host: m[3], port: parseInt(m[4]), database: m[5], ssl: false });
    client.connect()
      .then(() => client.query(\"SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='schema_migrations') AS exists\"))
      .then(r => { console.log(r.rows[0].exists ? 'yes' : 'no'); client.end(); })
      .catch(() => { console.log('unknown'); client.end().catch(()=>{}); });
  " 2>/dev/null || echo "unknown")

  if [ "$DB_INITIALIZED" = "yes" ]; then
    echo "Database already initialized, skipping migrations"

    # Still check if admin user exists
    if [ "$INIT_ADMIN" = "true" ]; then
      ADMIN_EXISTS=$(node -e "
        const fs = require('fs');
        const envContent = fs.readFileSync('/app/.env', 'utf-8');
        const vars = {};
        envContent.split('\n').forEach(l => { const m = l.match(/^([^=]+)=(.*)$/); if (m) vars[m[1].trim()] = m[2].trim(); });
        const dbUrl = vars.DATABASE_URL;
        const pg = require('pg');
        const m = dbUrl.match(/postgresql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)/);
        if (!m) { console.log('unknown'); process.exit(0); }
        const client = new pg.Client({ user: m[1], password: m[2], host: m[3], port: parseInt(m[4]), database: m[5], ssl: false });
        client.connect()
          .then(() => client.query(\"SELECT EXISTS(SELECT 1 FROM principal_profiles WHERE role='admin') AS exists\"))
          .then(r => { console.log(r.rows[0].exists ? 'yes' : 'no'); client.end(); })
          .catch(() => { console.log('unknown'); client.end().catch(()=>{}); });
      " 2>/dev/null || echo "unknown")

      if [ "$ADMIN_EXISTS" = "yes" ]; then
        echo "Admin user already exists, skipping admin init"
      else
        echo "No admin user found, creating admin user..."
        node migrations/init-db.js init-admin || echo "Admin init warning (may already exist)"
      fi
    fi
  else
    echo "Running database migrations (first-time init)..."
    node migrations/init-db.js init || echo "Migration warning (may already exist)"

    if [ "$INIT_ADMIN" = "true" ]; then
      echo "Creating admin user..."
      node migrations/init-db.js init-admin || echo "Admin init warning (may already exist)"
    fi
  fi
fi

# ============================================================
# Step 4: Start backend API server (background)
# ============================================================
echo "Starting backend API server on port 3001..."
cd /app
node server/index.js &
SERVER_PID=$!

# ============================================================
# Step 5: Serve frontend static files on port 8080
# ============================================================
echo "Starting frontend static server on port 8080..."
node server/frontend-server.js &
FRONTEND_PID=$!

echo "=== Agent Manager Ready ==="
echo "  Frontend: http://0.0.0.0:8080"
echo "  Backend:  http://0.0.0.0:3001"

# Wait for both processes - if either exits, the script ends
wait $SERVER_PID $FRONTEND_PID
