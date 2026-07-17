#!/usr/bin/env node
/**
 * Database initialization script for Agent Manager
 *
 * This script directly executes SQL against Supabase using PostgreSQL connection
 *
 * Usage:
 *   node init-db.js drop       # Drop all tables
 *   node init-db.js init       # Create tables and seed data (idempotent: skipped if already initialized)
 *   node init-db.js full       # Drop then init
 *   node init-db.js init-admin # Create admin user
 *   node init-db.js migrate    # Apply pending migrations from versions/<semver>/*.sql
 */

import pg from 'pg';
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { KubeConfig, CustomObjectsApi } from '@kubernetes/client-node';
import { SANDBOXSET_TEMPLATES, buildSandboxSet } from './sandboxset-templates.js';

const { Client } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));

// PG advisory lock keys for serializing concurrent migrate runs.
// Uses the two-int form of pg_try_advisory_lock(int4, int4) to avoid
// JS BigInt/int8 precision concerns.
const MIGRATE_LOCK_KEY_1 = 0x4F434C57; // "OCLW"
const MIGRATE_LOCK_KEY_2 = 0x4D494721; // "MIG!"
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

// Load environment variables from .env file
function loadEnv() {
  try {
    const envPath = join(__dirname, '..', '.env');
    const envContent = readFileSync(envPath, 'utf-8');
    const env = {};
    
    envContent.split('\n').forEach(line => {
      // Skip empty lines and comments
      if (!line || line.startsWith('#')) return;
      
      const match = line.match(/^([^=]+)=(.*)$/);
      if (match) {
        const key = match[1].trim();
        let value = match[2].trim();
        // Remove surrounding quotes if present
        if ((value.startsWith('"') && value.endsWith('"')) || 
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        env[key] = value;
      }
    });
    
    return env;
  } catch (error) {
    console.error('Error loading .env file:', error.message);
    process.exit(1);
  }
}

// Parse DATABASE_URL to get connection config.
// Uses regex instead of `new URL()` so that raw special characters in the
// password (e.g. @, #, $, !) don't break URL parsing.
// Accepted format: postgresql://USER:PASSWORD@HOST:PORT/DATABASE
const DATABASE_URL_RE = /^postgresql:\/\/([^:]+):(.+)@([^:/?#]+):(\d+)\/(.+)$/;

function getConnectionConfig(databaseUrl) {
  const match = databaseUrl.match(DATABASE_URL_RE);
  if (!match) {
    throw new Error(
      'Invalid DATABASE_URL format. Expected: postgresql://USER:PASSWORD@HOST:PORT/DATABASE'
    );
  }
  const [, user, password, host, port, database] = match;
  return { user, password, host, port: parseInt(port, 10), database, ssl: false };
}

// Execute SQL file
async function executeSqlFile(client, filePath, description) {
  console.log(`\n📦 ${description}...`);
  
  const sql = readFileSync(filePath, 'utf-8');
  
  try {
    await client.query(sql);
    console.log(`✅ ${description} completed successfully`);
  } catch (error) {
    console.error(`\n❌ Error executing ${description}:`);
    console.error(error.message);
    throw error;
  }
}

// Determine whether the database has already been initialized.
//   - schema_migrations exists       → already initialized (skip init)
//   - schema_migrations missing      → fresh database (run init)
async function isAlreadyInitialized(client) {
  const { rows } = await client.query(`
    SELECT
      to_regclass('public.schema_migrations') AS schema_migrations
  `);
  const row = rows[0] || {};

  if (row.schema_migrations) {
    console.log('✅ schema_migrations table exists — database already initialized. Skipping init.');
    return true;
  }
  return false;
}

// Ensure the schema_migrations tracking table exists.
async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     TEXT        NOT NULL,
      filename    TEXT        NOT NULL,
      checksum    TEXT        NOT NULL DEFAULT '',
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (version, filename)
    )
  `);
}

// After init_database.sql has created schema_migrations with a single
// marker row (the latest version), stamp all migration files up to that
// version so that subsequent migrate runs skip them correctly.
async function baselineMigrations(client) {
  const plan = loadMigrationPlan();
  if (plan.length === 0) {
    return;
  }

  await ensureMigrationsTable(client);

  // Read the marker row inserted by init_database.sql to determine the
  // baseline version.  If no marker exists, fall back to INITIAL_VERSION.
  const { rows } = await client.query(
    'SELECT version FROM schema_migrations ORDER BY applied_at DESC LIMIT 1'
  );
  const baselineVersion = rows.length > 0 ? rows[0].version : INITIAL_VERSION;
  console.log(`📌 Baseline version from init_database.sql: v${baselineVersion}`);

  const itemsToStamp = plan.filter(item => compareSemver(item.version, baselineVersion) <= 0);
  let stamped = 0;
  for (const item of itemsToStamp) {
    await client.query(
      `INSERT INTO schema_migrations (version, filename, checksum)
       VALUES ($1, $2, $3)
       ON CONFLICT (version, filename) DO UPDATE SET checksum = $3`,
      [item.version, item.filename, item.checksum]
    );
    stamped += 1;
  }
  console.log(`✅ Baseline: stamped ${stamped} migration(s) up to v${baselineVersion}`);
}

// Discover migration files under migrations/versions/<semver>/*.sql
// Returns array of { version, filename, fullPath, checksum, sql }
// sorted by semver then filename ascending.
function loadMigrationPlan() {
  const versionsDir = join(__dirname, 'versions');
  if (!existsSync(versionsDir)) {
    return [];
  }

  const versionDirs = readdirSync(versionsDir).filter(name => {
    const full = join(versionsDir, name);
    return statSync(full).isDirectory() && SEMVER_RE.test(name);
  });

  versionDirs.sort((a, b) => {
    const [, a1, a2, a3] = a.match(SEMVER_RE);
    const [, b1, b2, b3] = b.match(SEMVER_RE);
    return (
      Number(a1) - Number(b1) ||
      Number(a2) - Number(b2) ||
      Number(a3) - Number(b3)
    );
  });

  const plan = [];
  for (const version of versionDirs) {
    const dir = join(versionsDir, version);
    const files = readdirSync(dir)
      .filter(f => f.toLowerCase().endsWith('.sql'))
      .sort();
    for (const filename of files) {
      const fullPath = join(dir, filename);
      const sql = readFileSync(fullPath, 'utf-8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      plan.push({ version, filename, fullPath, checksum, sql });
    }
  }
  return plan;
}

// Initial version assumed when schema_migrations has no records.
// An environment without migration records was created before the
// migration framework existed, i.e. its schema is already at this version.
const INITIAL_VERSION = '1.0.0';

// Compare two semver strings. Returns negative / zero / positive.
function compareSemver(a, b) {
  const [, a1, a2, a3] = a.match(SEMVER_RE);
  const [, b1, b2, b3] = b.match(SEMVER_RE);
  return Number(a1) - Number(b1) || Number(a2) - Number(b2) || Number(a3) - Number(b3);
}

// Detect the current database version from schema_migrations.
// Returns the highest recorded version, or INITIAL_VERSION if no records exist.
async function detectCurrentVersion(client) {
  const { rows } = await client.query(
    `SELECT DISTINCT version FROM schema_migrations ORDER BY version`
  );
  if (rows.length === 0) {
    return INITIAL_VERSION;
  }
  const versions = rows.map(r => r.version).filter(v => SEMVER_RE.test(v));
  if (versions.length === 0) {
    return INITIAL_VERSION;
  }
  versions.sort(compareSemver);
  return versions[versions.length - 1];
}

// When schema_migrations has no records, the database predates the migration
// framework. Stamp INITIAL_VERSION files so they are skipped (not executed).
async function stampCurrentVersionIfNeeded(client, plan) {
  const { rows } = await client.query('SELECT count(*)::int AS cnt FROM schema_migrations');
  if (rows[0].cnt > 0) {
    return; // already has records — nothing to bootstrap
  }

  const currentVersion = INITIAL_VERSION;
  const itemsToStamp = plan.filter(item => compareSemver(item.version, currentVersion) <= 0);
  if (itemsToStamp.length === 0) {
    return;
  }

  console.log(`ℹ️  No migration records found — treating as existing v${currentVersion} environment.`);
  console.log(`   Stamping v${currentVersion} and earlier (${itemsToStamp.length} file(s)) without executing...`);
  for (const item of itemsToStamp) {
    const key = `${item.version}/${item.filename}`;
    await client.query(
      `INSERT INTO schema_migrations (version, filename, checksum)
       VALUES ($1, $2, $3)
       ON CONFLICT (version, filename) DO NOTHING`,
      [item.version, item.filename, item.checksum]
    );
    console.log(`   ✓ stamped ${key}`);
  }
}

// Apply pending migrations atomically with advisory-lock serialization.
async function runMigrate(client) {
  console.log('\n📦 Running migrations...');

  // Serialize concurrent runners.
  const lockRes = await client.query(
    'SELECT pg_try_advisory_lock($1::int, $2::int) AS locked',
    [MIGRATE_LOCK_KEY_1, MIGRATE_LOCK_KEY_2]
  );
  if (!lockRes.rows[0].locked) {
    console.log('⚠️  Another migration is already running. Skipping.');
    return;
  }

  try {
    await ensureMigrationsTable(client);

    const plan = loadMigrationPlan();
    if (plan.length === 0) {
      console.log('ℹ️  No migration files found under versions/. Nothing to do.');
      return;
    }

    // Log all discovered versions
    const allVersions = [...new Set(plan.map(item => item.version))];
    allVersions.sort(compareSemver);
    console.log(`📋 Discovered versions: ${allVersions.join(', ')}`);
    console.log(`   Total migration files: ${plan.length}`);
    for (const item of plan) {
      console.log(`   - ${item.version}/${item.filename} (checksum: ${item.checksum.slice(0, 12)}...)`);
    }

    // Detect current database version
    const currentVersion = await detectCurrentVersion(client);
    console.log(`\n🔍 Current database version: v${currentVersion}`);
    const latestVersion = allVersions[allVersions.length - 1];
    console.log(`🎯 Latest available version: v${latestVersion}`);

    // If this is a pre-migration-framework environment (no records),
    // stamp the current version so those files are skipped.
    await stampCurrentVersionIfNeeded(client, plan);

    const { rows: appliedRows } = await client.query(
      'SELECT version, filename, checksum FROM schema_migrations'
    );
    const appliedMap = new Map(
      appliedRows.map(r => [`${r.version}/${r.filename}`, r.checksum])
    );

    // Separate pending from already-applied
    const pendingItems = plan.filter(item => !appliedMap.has(`${item.version}/${item.filename}`));
    if (pendingItems.length === 0) {
      console.log('\nℹ️  All migrations already applied. Nothing to do.');
    } else {
      const pendingVersions = [...new Set(pendingItems.map(item => item.version))];
      pendingVersions.sort(compareSemver);
      console.log(`\n🚀 Upgrade path: v${currentVersion} → v${pendingVersions[pendingVersions.length - 1]}`);
      console.log(`   Pending migrations (${pendingItems.length} file(s)):`);
      for (const item of pendingItems) {
        console.log(`   - ${item.version}/${item.filename} (${item.sql.length} bytes, checksum: ${item.checksum.slice(0, 12)}...)`);
      }
    }

    let appliedCount = 0;
    let skippedCount = 0;

    for (const item of plan) {
      const key = `${item.version}/${item.filename}`;
      const existingChecksum = appliedMap.get(key);

      if (existingChecksum) {
        if (existingChecksum !== item.checksum) {
          throw new Error(
            `Checksum mismatch for ${key}. ` +
            `Applied migrations must never be modified. ` +
            `Create a new versions/<next-semver>/ directory instead.`
          );
        }
        skippedCount += 1;
        continue;
      }

      console.log(`\n   → applying ${key} (${item.sql.length} bytes) ...`);
      try {
        await client.query('BEGIN');
        await client.query(item.sql);
        await client.query(
          `INSERT INTO schema_migrations (version, filename, checksum)
           VALUES ($1, $2, $3)`,
          [item.version, item.filename, item.checksum]
        );
        await client.query('COMMIT');
        appliedCount += 1;
        console.log(`   ✅ ${key} applied successfully`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`   ❌ ${key} failed: ${err.message}`);
        throw new Error(`Migration failed at ${key}: ${err.message}`);
      }
    }

    console.log(
      `\n✅ Migrations done. applied=${appliedCount} skipped=${skippedCount} total=${plan.length}`
    );
    if (appliedCount > 0) {
      const newVersion = await detectCurrentVersion(client);
      console.log(`📌 Database is now at v${newVersion}`);
    }
  } finally {
    await client.query(
      'SELECT pg_advisory_unlock($1::int, $2::int)',
      [MIGRATE_LOCK_KEY_1, MIGRATE_LOCK_KEY_2]
    );
  }
}

// Initialize admin user using Supabase Admin API (idempotent: safe to re-run on upgrades)
async function initAdminUser(client, env) {
  console.log('\n📦 Ensuring admin user exists...');

  // Prefer internal URL (VPC endpoint) over public URL for Pod-to-Supabase communication
  const supabaseUrl = env.SUPABASE_INTERNAL_URL || env.VITE_SUPABASE_URL;
  const serviceRoleKey = env.SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('VITE_SUPABASE_URL or SERVICE_ROLE_KEY not set in .env');
  }

  // Check if trigger exists
  console.log('   Checking trigger status...');
  const triggerCheck = await client.query(`
    SELECT tgname, tgenabled
    FROM pg_trigger
    WHERE tgname = 'on_auth_user_created'
  `);
  if (triggerCheck.rows.length > 0) {
    console.log(`   Trigger exists, enabled: ${triggerCheck.rows[0].tgenabled}`);
  } else {
    console.log('   ⚠️  Trigger does NOT exist on auth.users!');
    console.log('   This is normal for Supabase - will create profile manually.');
  }

  const email = process.env.ADMIN_EMAIL || 'admin@openclaw.local';
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  const username = 'Admin';

  console.log(`   Email: ${email}`);

  const adminSupabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: WebSocket }
  });

  // Check if admin user already exists (idempotent for upgrades)
  let userId;
  const existingUserResult = await client.query(
    `SELECT id FROM auth.users WHERE email = $1 LIMIT 1`,
    [email]
  );

  if (existingUserResult.rows.length > 0) {
    userId = existingUserResult.rows[0].id;
    console.log(`   Admin user already exists (id: ${userId}). Updating metadata (password preserved)...`);

    const { error: updateError } = await adminSupabase.auth.admin.updateUserById(userId, {
      email_confirm: true,
      user_metadata: {
        username: username,
        role: 'admin',
      },
    });

    if (updateError) {
      throw new Error(`Failed to update existing admin user: ${updateError.message}`);
    }
    console.log('✅ Admin auth record updated (password unchanged)');
  } else {
    // User does not exist — create it
    const { data, error } = await adminSupabase.auth.admin.createUser({
      email: email,
      password: password,
      email_confirm: true,
      user_metadata: {
        username: username,
        role: 'admin',
      },
    });

    if (error) {
      throw new Error(`Failed to create user: ${error.message}`);
    }

    userId = data.user.id;
    console.log(`✅ User created successfully (id: ${userId})`);
  }

  const profilesTable = 'principal_profiles';

  // Detect which optional columns exist in the profile table.
  // init-admin must NOT alter the schema — that is migrate's responsibility.
  const { rows: colRows } = await client.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1
  `, [profilesTable]);
  const columns = new Set(colRows.map(r => r.column_name));
  const hasMaxAgentInstances = columns.has('max_agent_instances');
  const hasMaxOpenclawInstances = columns.has('max_openclaw_instances');
  const hasIsFirstLogin = columns.has('is_first_login');

  // Ensure profile exists and is up-to-date (upsert)
  const profileCheck = await client.query(
    `SELECT id FROM ${profilesTable} WHERE id = $1`,
    [userId]
  );

  if (profileCheck.rows.length === 0) {
    // Profile missing — create it (adapt to current schema)
    console.log('   Profile not found, inserting...');
    const insertCols = ['id', 'name', 'email', 'role', 'status'];
    const insertVals = [userId, username, email, 'admin', 'active'];
    if (hasMaxAgentInstances) {
      insertCols.push('max_agent_instances');
      insertVals.push(999);
    } else if (hasMaxOpenclawInstances) {
      insertCols.push('max_openclaw_instances');
      insertVals.push(999);
    }
    if (hasIsFirstLogin) {
      insertCols.push('is_first_login');
      insertVals.push(true);
    }
    const placeholders = insertVals.map((_, i) => `$${i + 1}`).join(', ');
    await client.query(
      `INSERT INTO ${profilesTable} (${insertCols.join(', ')}) VALUES (${placeholders})`,
      insertVals
    );
    console.log('✅ Created admin profile');
  } else {
    // Profile exists — ensure admin role and fields are current
    const setClauses = ["name = $1", "role = 'admin'", "status = 'active'", 'updated_at = NOW()'];
    if (hasMaxAgentInstances) {
      setClauses.push('max_agent_instances = 999');
    } else if (hasMaxOpenclawInstances) {
      setClauses.push('max_openclaw_instances = 999');
    }
    await client.query(
      `UPDATE ${profilesTable} SET ${setClauses.join(', ')} WHERE id = $2`,
      [username, userId]
    );
    console.log('✅ Updated admin profile');
  }

  console.log(`\n✅ Admin user ready!`);
  console.log(`   Email: ${email}`);
}

// Initialize SandboxSet CRDs in K8s cluster (idempotent: skip if name already exists).
// Should run once per cluster — used to bootstrap built-in agent types' sandbox configs.
//
// Annotations and container image are inherited from any existing SandboxSet in
// the same namespace, so cluster-specific values (e.g. e2b template IDs) are
// preserved without ROS template changes.
async function ensureSandboxSets() {
  console.log('\n📦 Ensuring built-in SandboxSets exist in cluster...');

  const SANDBOXSET_GROUP = 'agents.kruise.io';
  const SANDBOXSET_VERSION = 'v1alpha1';
  const SANDBOXSET_PLURAL = 'sandboxsets';

  let api;
  try {
    const kc = new KubeConfig();
    const env = process.env.DEPLOY_ENVIRONMENT || 'local-dev';
    if (env === 'local-dev') {
      kc.loadFromDefault();
    } else {
      kc.loadFromCluster();
    }
    api = kc.makeApiClient(CustomObjectsApi);
  } catch (err) {
    console.warn(`⚠️  Failed to init K8s client: ${err.message}. Skipping SandboxSet bootstrap.`);
    return;
  }

  // Group templates by namespace so we can fetch one reference per namespace.
  const namespaces = [...new Set(SANDBOXSET_TEMPLATES.map(t => t.namespace))];
  const templateNamesByNamespace = SANDBOXSET_TEMPLATES.reduce((acc, t) => {
    (acc[t.namespace] ||= new Set()).add(t.name);
    return acc;
  }, {});
  const referencesByNamespace = {};

  // 真·动态 annotation 前缀（vsw / 安全组 / 镜像缓存等），与
  // sandboxset-templates.js 的 DYNAMIC_ANNOTATION_PREFIXES 保持一致。
  // 选 reference 时，pod template 的 annotation 命中越多前缀的 SandboxSet 越优先。
  const DYNAMIC_PREFIXES = [
    'network.alibabacloud.com/',
    'image.alibabacloud.com/',
    'k8s.aliyun.com/',
  ];
  const DYNAMIC_KEY_HINTS = ['vswitch-ids', 'security-group-ids', 'enable-image-cache'];

  function scoreReference(item) {
    const podAnn = item?.spec?.template?.metadata?.annotations || {};
    const topAnn = item?.metadata?.annotations || {};
    const allKeys = [...Object.keys(podAnn), ...Object.keys(topAnn)];
    let score = 0;
    for (const k of allKeys) {
      if (DYNAMIC_PREFIXES.some(p => k.startsWith(p))) score += 1;
      if (DYNAMIC_KEY_HINTS.some(h => k.endsWith(h))) score += 5;  // 强信号优先
    }
    return score;
  }

  for (const ns of namespaces) {
    try {
      const res = await api.listNamespacedCustomObject({
        group: SANDBOXSET_GROUP,
        version: SANDBOXSET_VERSION,
        namespace: ns,
        plural: SANDBOXSET_PLURAL,
      });
      const items = (res?.body ?? res)?.items || [];
      // 排除将要被本次 init 创建/管理的 SandboxSet 自己（避免拿"上次跑出来的退化版"当 reference）
      const ownNames = templateNamesByNamespace[ns] || new Set();
      const candidates = items.filter(i => !ownNames.has(i?.metadata?.name));
      // 按真·动态 annotation 命中数降序，挑分数最高的；若全为 0 再退回到 items[0]
      candidates.sort((a, b) => scoreReference(b) - scoreReference(a));
      const best = candidates[0] && scoreReference(candidates[0]) > 0 ? candidates[0] : items[0];
      referencesByNamespace[ns] = best || null;
      if (best) {
        console.log(`   📎 Reference SandboxSet in ns "${ns}": ${best.metadata.name} (score=${scoreReference(best)})`);
      } else {
        console.warn(`   ⚠️  No existing SandboxSet in ns "${ns}". annotations/image will be empty.`);
      }
    } catch (err) {
      console.warn(`   ⚠️  Failed to list SandboxSets in ns "${ns}": ${err.message}`);
      referencesByNamespace[ns] = null;
    }
  }

  let created = 0;
  let skipped = 0;
  for (const template of SANDBOXSET_TEMPLATES) {
    // Check existence first to avoid overwriting user modifications.
    try {
      await api.getNamespacedCustomObject({
        group: SANDBOXSET_GROUP,
        version: SANDBOXSET_VERSION,
        namespace: template.namespace,
        plural: SANDBOXSET_PLURAL,
        name: template.name,
      });
      console.log(`   ⏭️  SandboxSet "${template.name}" already exists. Skipping.`);
      skipped += 1;
      continue;
    } catch (err) {
      const status = err?.response?.statusCode || err?.statusCode || err?.code;
      if (status !== 404 && status !== '404') {
        console.warn(`   ⚠️  Failed to check SandboxSet "${template.name}": ${err.message}`);
        continue;
      }
      // 404 — proceed to create
    }

    const body = buildSandboxSet(template, referencesByNamespace[template.namespace]);
    try {
      await api.createNamespacedCustomObject({
        group: SANDBOXSET_GROUP,
        version: SANDBOXSET_VERSION,
        namespace: template.namespace,
        plural: SANDBOXSET_PLURAL,
        body,
      });
      console.log(`   ✅ Created SandboxSet "${template.name}" in ns "${template.namespace}"`);
      created += 1;
    } catch (err) {
      console.error(`   ❌ Failed to create SandboxSet "${template.name}": ${err.message}`);
    }
  }

  console.log(`✅ SandboxSet bootstrap done. created=${created} skipped=${skipped}`);
}

// Main function
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  
  if (!command || !['drop', 'init', 'full', 'init-admin', 'migrate'].includes(command)) {
    console.log('Usage: node init-db.js <command>');
    console.log('Commands:');
    console.log('  drop       - Drop all tables in public schema');
    console.log('  init       - Create tables and seed data (idempotent, skipped if already initialized)');
    console.log('  full       - Drop then init');
    console.log('  init-admin - Create admin user');
    console.log('  migrate    - Apply pending migrations from versions/<semver>/*.sql');
    process.exit(1);
  }

  console.log('🚀 Agent Manager Database Initialization\n')
  
  // Load environment
  const env = loadEnv();
  const databaseUrl = env.DATABASE_URL || env.DATABASEURL;
  
  if (!databaseUrl) {
    console.error('❌ Missing required environment variable: DATABASE_URL or DATABASEURL');
    process.exit(1);
  }
  
  console.log(`📍 Schema: public`);
  console.log(`🔗 Connecting via DATABASE_URL\n`);
  
  // Get connection config
  let connectionConfig;
  try {
    connectionConfig = getConnectionConfig(databaseUrl);
  } catch (error) {
    console.error('❌ Failed to parse DATABASE_URL:', error.message);
    process.exit(1);
  }
  
  // Create client
  const client = new Client(connectionConfig);
  
  try {
    console.log('🔌 Connecting to database...');
    await client.connect();
    console.log('✅ Connected\n');
    
    if (command === 'drop' || command === 'full') {
      await executeSqlFile(
        client,
        join(__dirname, 'drop.sql'),
        'Dropping tables'
      );
    }
    
    if (command === 'init' || command === 'full') {
      if (command === 'init' && await isAlreadyInitialized(client)) {
        // schema_migrations exists → DB was already initialized, skip
      } else {
        await executeSqlFile(
          client,
          join(__dirname, 'init_database.sql'),
          'Initializing database'
        );
        await baselineMigrations(client);
      }
    }
    
    if (command === 'init-admin') {
      await initAdminUser(client, env);
      await ensureSandboxSets();
    }

    if (command === 'migrate') {
      await runMigrate(client);
    }

    console.log('\n🎉 Done!');
    
  } catch (error) {
    console.error('\n❌ Failed:', error.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
