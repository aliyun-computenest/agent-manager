# ============================================================
# Stage 1: Build frontend (Vite + React)
# ============================================================
FROM node:20-alpine AS frontend-builder

WORKDIR /app

# Install frontend dependencies
# ------------------------------------------------------------
# IMPORTANT: package-lock.json MUST be in sync with package.json.
# Do NOT switch to "npm install" — CI must consume the committed lock.
#
# If this step fails with errors like:
#   - "Invalid: lock file's X@... does not satisfy X@..."
#   - "Missing: X from lock file"
# 那基本是 lock 与 package.json 脱节，按下面步骤在本地修复：
#   1) cd agent-manager
#   2) git ls-files -v package-lock.json
#      若第一列是 'S' (skip-worktree)，先执行：
#        git update-index --no-skip-worktree package-lock.json
#   3) rm package-lock.json
#      npm install --package-lock-only --include=optional
#   4) git add package-lock.json && git commit -m "chore: sync lock"
# 详情参考：docs/DEVELOPMENT_GUIDE.md (依赖管理章节)
# ------------------------------------------------------------
COPY package.json package-lock.json ./
RUN npm ci --include=optional --ignore-scripts

# Bind frontend source/build layers to the requested Harness revision while
# preserving the dependency-install cache above.
ARG SOURCE_REVISION=local
RUN printf '%s' "$SOURCE_REVISION" > /tmp/frontend-source-revision

# Copy frontend source and build
COPY src/ src/
COPY index.html tsconfig.json tsconfig.node.json vite.config.ts tailwind.config.js postcss.config.js version.json ./

# Ensure VITE_API_URL is empty so frontend uses relative path /api
# (8080 port has reverse proxy to backend 3001)
ENV VITE_API_URL=""
ENV VITE_SKILLHUB_OSS_PV_NAME=""
RUN npm run build

# ============================================================
# Stage 2: Build backend dependencies
# ============================================================
FROM node:20-alpine AS backend-builder

WORKDIR /app/server

# Install backend dependencies
# 同根目录 npm ci 排错说明：见 frontend-builder stage 上方注释
COPY server/package.json server/package-lock.json ./
RUN npm ci --include=optional --omit=dev --ignore-scripts

# ============================================================
# Stage 2.5: Build migration dependencies (pg package)
# ============================================================
FROM node:20-alpine AS migration-builder

WORKDIR /app/migrations

RUN npm init -y && npm install pg @supabase/supabase-js @kubernetes/client-node js-yaml ws

# ============================================================
# Stage 3: Production image
# ============================================================
FROM node:20-alpine

RUN apk add --no-cache postgresql-client tini

WORKDIR /app

RUN mkdir -p /var/log/agent-manager && chown -R node:node /var/log/agent-manager

# Bind runtime source-copy layers to the same revision. This prevents a stale
# backend/frontend combination while retaining base-image and dependency caches.
ARG SOURCE_REVISION=local
RUN printf '%s' "$SOURCE_REVISION" > /app/.source-revision

# Copy built frontend assets
COPY --from=frontend-builder /app/dist ./dist
COPY version.json ./version.json

# Copy backend server and dependencies
COPY --from=backend-builder /app/server/node_modules ./server/node_modules
COPY server/ ./server/

# Copy database migrations and dependencies
COPY migrations/ ./migrations/
COPY --from=migration-builder /app/migrations/node_modules ./migrations/node_modules

# Copy SandboxSet templates (used by init-db.js → ensureSandboxSets)
COPY agents/ ./agents/

COPY data/ ./data/

# Copy entrypoint script
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Expose ports: 3001 (API), 8080 (frontend static serve)
EXPOSE 3001 8080

# Environment variables
ENV NODE_ENV=production
ENV SERVER_PORT=3001
ENV OPENCLAW_TEMPLATE_PATH=/app/data/openclaw-template.json
ENV LOG_DIR=/var/log/agent-manager

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/docker-entrypoint.sh"]
