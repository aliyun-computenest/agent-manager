#!/bin/sh
set -e

echo "=== OpenClaw Production Platform Starting ==="

# ============================================================
# Step 1: Inject runtime environment variables into frontend
# ============================================================
CONFIG_FILE="/app/dist/env-config.js"

node > "$CONFIG_FILE" <<'NODE'
const env = {
  VITE_SUPABASE_URL: process.env.VITE_SUPABASE_URL || '',
  VITE_SUPABASE_ANON_KEY: process.env.VITE_SUPABASE_ANON_KEY || '',
  VITE_APP_ID: process.env.VITE_APP_ID || '',
  VITE_OSS_URL: process.env.VITE_OSS_URL || '',
  VITE_OSS_PV_NAME: process.env.VITE_OSS_PV_NAME || ''
}
process.stdout.write(`window.__ENV__ = ${JSON.stringify(env)};\n`)
NODE

echo "Generated runtime env config: $CONFIG_FILE"

# Inject env-config.js script tag into index.html if not already present
if ! grep -q "env-config.js" /app/dist/index.html; then
  sed -i 's|<head>|<head><script src="/env-config.js"></script>|' /app/dist/index.html
  echo "Injected env-config.js into index.html"
fi

# ============================================================
# Step 2: Run database migrations if DATABASE_URL is set
# ============================================================
if [ -n "$DATABASE_URL" ] && [ "$RUN_MIGRATIONS" = "true" ]; then
  echo "Running database migrations..."
  cd /app
  node migrations/init-db.js init || echo "Migration warning (may already exist)"
  
  if [ "$INIT_ADMIN" = "true" ]; then
    echo "Creating admin user..."
    node migrations/init-db.js init-admin || echo "Admin init warning (may already exist)"
  fi
fi

# ============================================================
# Step 3: Write .env file for server to read
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
DATABASE_URL=${DATABASE_URL}
SERVER_PORT=3000
OPENCLAW_TEMPLATE_PATH=${OPENCLAW_TEMPLATE_PATH:-/app/data/openclaw-template.json}
SSL_CERT_FILE=${SSL_CERT_FILE}
DASHSCOPE_API_KEY=${DASHSCOPE_API_KEY}
ENABLE_AI_GATEWAY=${ENABLE_AI_GATEWAY}
APIG_GATEWAY_ID=${APIG_GATEWAY_ID}
APIG_HTTP_API_ID=${APIG_HTTP_API_ID}
APIG_ENVIRONMENT_ID=${APIG_ENVIRONMENT_ID}
APIG_REGION_ID=${APIG_REGION_ID}
AI_GATEWAY_DOMAIN=${AI_GATEWAY_DOMAIN}
ALIBABA_CLOUD_ACCESS_KEY_ID=${ALIBABA_CLOUD_ACCESS_KEY_ID}
ALIBABA_CLOUD_ACCESS_KEY_SECRET=${ALIBABA_CLOUD_ACCESS_KEY_SECRET}
API_ENCRYPTION_KEY=${API_ENCRYPTION_KEY}
VITE_ACS_CLUSTER_ID=${VITE_ACS_CLUSTER_ID}
VITE_OSS_URL=${VITE_OSS_URL}
VITE_OSS_PV_NAME=${VITE_OSS_PV_NAME}
DEPLOY_ENVIRONMENT=${DEPLOY_ENVIRONMENT:-production}
EOF

echo "Generated .env file for server"

# ============================================================
# Step 4: Start server (serves both API and static frontend)
# ============================================================
echo "Starting OpenClaw server on port 3000..."
echo "  - API endpoints: http://0.0.0.0:3000/api/*"
echo "  - Frontend: http://0.0.0.0:3000/"

cd /app
exec node server/index.js
