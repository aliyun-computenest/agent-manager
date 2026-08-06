import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(__dirname, '../../migrations')
const versionsDir = join(migrationsDir, 'versions')
const initDatabasePath = join(migrationsDir, 'init_database.sql')
const initDbScriptPath = join(migrationsDir, 'init-db.js')
const sandboxSetTemplatesPath = join(migrationsDir, 'sandboxset-templates.js')
const groupSharingMigrationPath = join(versionsDir, '1.0.4/002__principal_group_sharing.sql')
const groupsHelpersPath = join(__dirname, '../../server/routes/groups-helpers.js')
const usersRoutePath = join(__dirname, '../../server/routes/users.js')
const ensureAdminProfilePath = join(__dirname, '../../scripts/ensure-admin-profile.mjs')
const platformTemplatePath = join(__dirname, '../../../template/platform_template.yaml')
const SEMVER_RE = /^\d+\.\d+\.\d+$/

function compareSemver(a, b) {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i]
  }
  return 0
}

function readLatestMigrationVersion() {
  return readdirSync(versionsDir)
    .filter((name) => SEMVER_RE.test(name))
    .filter((name) => statSync(join(versionsDir, name)).isDirectory())
    .sort(compareSemver)
    .at(-1)
}

function readInitDatabaseBaselineVersion() {
  const sql = readFileSync(initDatabasePath, 'utf8')
  const match = sql.match(/INSERT INTO schema_migrations \(version, filename\) VALUES\s*\n\s*\('([^']+)',\s*'init_database\.sql'\)/)
  return match?.[1] || null
}

function extractCreateTable(sql, tableName) {
  const match = sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${tableName} \\([\\s\\S]*?\\n\\);`))
  return match?.[0] || ''
}

function extractFunctionSignatures(sql) {
  return [...sql.matchAll(/CREATE OR REPLACE FUNCTION\s+([a-z_]+)\s*\(([\s\S]*?)\)\s*RETURNS/g)]
    .map(([, name, args]) => {
      const normalizedArgs = args.trim()
        ? args.split(',').map((arg) => arg.trim().split(/\s+/).at(-1).toUpperCase()).join(', ')
        : ''
      return `${name}(${normalizedArgs})`
    })
}

describe('database migration baseline', () => {
  it('loads js-yaml through CommonJS interop in the Node 20 init job', () => {
    const sandboxSetTemplates = readFileSync(sandboxSetTemplatesPath, 'utf8')

    expect(sandboxSetTemplates).toContain("import { createRequire } from 'module'")
    expect(sandboxSetTemplates).toContain("const yaml = require('js-yaml')")
    expect(sandboxSetTemplates).not.toContain("import yaml from 'js-yaml'")
  })

  it('keeps init_database.sql baseline at or above the latest migration version', () => {
    const latestMigrationVersion = readLatestMigrationVersion()
    const initBaselineVersion = readInitDatabaseBaselineVersion()
    const initSql = readFileSync(initDatabasePath, 'utf8')

    expect(initBaselineVersion, 'init_database.sql must stamp schema_migrations for init_database.sql').toBeTruthy()
    expect(
      compareSemver(initBaselineVersion, latestMigrationVersion),
      `init_database.sql baseline ${initBaselineVersion} is lower than latest migrations/versions/${latestMigrationVersion}; update the schema_migrations INSERT version`,
    ).toBeGreaterThanOrEqual(0)
    expect(initSql, 'init_database.sql is a fresh-install baseline and should not contain upgrade-time DROP statements').not.toMatch(/^\s*DROP\b/m)
  })

  it('uses principal_profiles as the canonical principal table', () => {
    const migrationSql = readFileSync(groupSharingMigrationPath, 'utf8')
    const initSql = readFileSync(initDatabasePath, 'utf8')

    expect(migrationSql).not.toContain('CREATE TABLE IF NOT EXISTS principal_profiles')
    expect(initSql).toContain('CREATE TABLE IF NOT EXISTS principal_profiles')
    expect(initSql).not.toContain('CREATE TABLE IF NOT EXISTS user_profiles')
    expect(migrationSql).toContain('ALTER TABLE user_profiles RENAME TO principal_profiles')
    expect(migrationSql).toContain('ALTER TABLE principal_profiles')
    expect(extractCreateTable(initSql, 'principal_profiles')).toMatch(/^\s*name VARCHAR\(100\)/m)
    expect(extractCreateTable(initSql, 'principal_profiles')).not.toMatch(/^\s*username VARCHAR/m)
    expect(extractCreateTable(initSql, 'principal_profiles')).not.toContain('consumer_provider_type')
    expect(extractCreateTable(initSql, 'principal_profiles')).not.toContain('email VARCHAR(255) UNIQUE')
    expect(initSql).toContain('idx_principal_profiles_user_email_unique')
    expect(initSql).toContain("WHERE principal_type = 'user'")
    expect(migrationSql).toContain('ALTER TABLE principal_profiles RENAME COLUMN username TO name')
    expect(migrationSql).not.toContain('consumer_provider_type')
    expect(migrationSql).toContain('idx_principal_profiles_user_email_unique')
    expect(migrationSql).toContain('DROP CONSTRAINT IF EXISTS user_profiles_email_key')
    expect(migrationSql).toContain('DROP CONSTRAINT IF EXISTS principal_profiles_email_key')
    expect(migrationSql).toContain('idx_principal_profiles_group_name')
    expect(migrationSql).not.toContain('ADD COLUMN IF NOT EXISTS group_id')
    expect(migrationSql).not.toContain('DROP COLUMN IF EXISTS group_id')
    expect(extractCreateTable(initSql, 'agent_instances')).not.toMatch(/^\s*group_id UUID/m)
    expect(extractCreateTable(initSql, 'agent_instances'))
      .toContain('principal_id UUID NOT NULL REFERENCES principal_profiles(id) ON DELETE RESTRICT')
    expect(extractCreateTable(initSql, 'agent_instances'))
      .not.toContain('principal_id UUID NOT NULL REFERENCES principal_profiles(id) ON DELETE RESTRICT ON UPDATE CASCADE')
    expect(extractCreateTable(initSql, 'agent_group_members'))
      .not.toContain('ON UPDATE CASCADE')
    expect(extractCreateTable(initSql, 'agent_instances'))
      .not.toMatch(/^\s*created_by UUID/m)
    expect(extractCreateTable(initSql, 'agent_instances'))
      .not.toMatch(/^\s*user_id UUID/m)
    expect(extractCreateTable(initSql, 'agent_group_members')).not.toContain('added_by')
    expect(migrationSql).toContain('SET principal_id = user_id')
    expect(migrationSql).toContain('DROP COLUMN user_id')
    expect(migrationSql).not.toContain('created_by')
    expect(migrationSql).not.toContain('added_by')
    expect(initSql).not.toContain('NEW.created_by')
    expect(initSql).not.toContain('current_principal_id')
    expect(migrationSql).not.toContain('current_principal_id')
  })

  it('drops user_id-dependent RLS policies before dropping agent_instances.user_id', () => {
    const migrationSql = readFileSync(groupSharingMigrationPath, 'utf8')
    const dropColumn = migrationSql.indexOf('\n  DROP COLUMN user_id')

    expect(dropColumn).toBeGreaterThan(0)
    for (const policyName of [
      '"Users can view own instances"',
      '"Users can create instances"',
      '"Users can update own instances"',
      '"Users can delete own instances"',
      '"Users can manage own instances"',
      '"Users can view own instance channel configs"',
      '"Users can manage own instance channel configs"',
    ]) {
      const dropPolicy = migrationSql.indexOf(`DROP POLICY IF EXISTS ${policyName}`)
      expect(dropPolicy, `${policyName} must be dropped before agent_instances.user_id`).toBeGreaterThan(0)
      expect(dropPolicy, `${policyName} must be dropped before agent_instances.user_id`).toBeLessThan(dropColumn)
    }
  })

  it('keeps admin bootstrap scripts aligned with principal_profiles.name', () => {
    const initDbScript = readFileSync(initDbScriptPath, 'utf8')
    const ensureAdminProfile = readFileSync(ensureAdminProfilePath, 'utf8')

    expect(initDbScript).toContain("const profilesTable = 'principal_profiles'")
    expect(initDbScript).toContain("const insertCols = ['id', 'name', 'email', 'role', 'status']")
    expect(initDbScript).toContain("const setClauses = [\"name = $1\", \"role = 'admin'\", \"status = 'active'\", 'updated_at = NOW()']")
    expect(initDbScript).not.toContain('public.user_profiles')
    expect(initDbScript).not.toContain("to_regclass('public.principal_profiles') AS principal_profiles")
    expect(initDbScript).not.toContain('principal_profiles exists but no schema_migrations')
    expect(initDbScript).not.toContain("return 'user_profiles'")
    expect(initDbScript).not.toContain("profileNameColumn")
    expect(initDbScript).not.toContain("['id', 'username', 'email', 'role', 'status']")
    expect(initDbScript).not.toContain("username = $1")
    expect(ensureAdminProfile).toContain('name: user.user_metadata?.username')
    expect(ensureAdminProfile).not.toMatch(/\n\s+username:/)
  })

  it('uses schema_migrations as the only runtime initialization marker', () => {
    const initDbScript = readFileSync(initDbScriptPath, 'utf8')
    const dockerEntrypoint = readFileSync(join(__dirname, '../../../agent-manager/docker-entrypoint.sh'), 'utf8')

    expect(initDbScript).not.toContain('user_profiles')
    expect(initDbScript).not.toContain("to_regclass('public.principal_profiles') AS principal_profiles")
    expect(initDbScript).toContain("to_regclass('public.schema_migrations') AS schema_migrations")
    expect(dockerEntrypoint).not.toContain('user_profiles')
    expect(dockerEntrypoint).toContain("table_name='schema_migrations'")
  })

  it('removes the group owner role from baseline and incremental migration', () => {
    const migrationSql = readFileSync(groupSharingMigrationPath, 'utf8')
    const initSql = readFileSync(initDatabasePath, 'utf8')

    for (const sql of [initSql, migrationSql]) {
      expect(sql).not.toContain("'owner'")
      expect(sql).not.toContain('transfer_group_owner')
      expect(sql).not.toContain('ensure_group_has_active_owner')
      expect(sql).not.toContain('idx_agent_group_members_one_owner')
      expect(sql).not.toContain('active owner')
    }
  })

  it('keeps database admin and group RPC checks constrained', () => {
    const migrationSql = readFileSync(groupSharingMigrationPath, 'utf8')
    const initSql = readFileSync(initDatabasePath, 'utf8')

    for (const sql of [initSql, migrationSql]) {
      expect(sql).toMatch(/CREATE OR REPLACE FUNCTION is_admin_check\(\)[\s\S]*AND status = 'active'[\s\S]*LANGUAGE SQL SECURITY DEFINER STABLE/)
      expect(sql).not.toContain('RETURN is_admin_check();')
      expect(sql).toMatch(/CREATE OR REPLACE FUNCTION is_admin\(user_uuid UUID\)[\s\S]*WHERE id = user_uuid[\s\S]*AND status = 'active'[\s\S]*LANGUAGE SQL SECURITY DEFINER STABLE/)
      for (const signature of [
        'get_group_usage_counts(UUID[])',
        'create_group_with_admin(UUID, TEXT, UUID)',
      ]) {
        expect(sql).toContain(`REVOKE EXECUTE ON FUNCTION ${signature} FROM PUBLIC, anon, authenticated;`)
        expect(sql).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO service_role;`)
      }
    }
  })

  it('creates principal_profiles before fresh-install admin helper functions', () => {
    const initSql = readFileSync(initDatabasePath, 'utf8')
    const createPrincipalProfiles = initSql.indexOf('CREATE TABLE IF NOT EXISTS principal_profiles')
    const createIsAdminCheck = initSql.indexOf('CREATE OR REPLACE FUNCTION is_admin_check()')
    const createIsAdmin = initSql.indexOf('CREATE OR REPLACE FUNCTION is_admin(user_uuid UUID)')
    const createProfilePolicy = initSql.indexOf('CREATE POLICY "Admins can view all profiles" ON principal_profiles')

    expect(createPrincipalProfiles).toBeGreaterThanOrEqual(0)
    expect(createIsAdminCheck).toBeGreaterThan(createPrincipalProfiles)
    expect(createIsAdmin).toBeGreaterThan(createPrincipalProfiles)
    expect(createIsAdminCheck).toBeLessThan(createProfilePolicy)
    expect(createIsAdmin).toBeLessThan(createProfilePolicy)
  })

  it('hardens self-service principal creation without group ownership invariants', () => {
    const migrationSql = readFileSync(groupSharingMigrationPath, 'utf8')
    const initSql = readFileSync(initDatabasePath, 'utf8')

    for (const sql of [initSql, migrationSql]) {
      expect(sql).not.toContain("NEW.raw_user_meta_data->>'role'")
      expect(sql).not.toContain("NEW.raw_user_meta_data->>'status'")
      expect(sql).toContain("NEW.email,\n    'user',\n    'active'")
      expect(sql).toMatch(/CREATE POLICY "Users can create own profile" ON principal_profiles[\s\S]*role = 'user'[\s\S]*status = 'active'[\s\S]*max_agent_instances = 5[\s\S]*consumer_apikey_encrypted IS NULL/)
      expect(sql).not.toContain('CREATE OR REPLACE FUNCTION ensure_group_has_active_owner()')
      expect(sql).not.toContain('CREATE CONSTRAINT TRIGGER ensure_group_has_active_owner')
      expect(sql).not.toContain('agent_group_members must keep one active owner per group')
    }

    for (const tableName of ['principal_profiles', 'ai_models', 'agent_instances']) {
      expect(initSql).not.toContain(`CREATE TRIGGER set_updated_at\n  BEFORE UPDATE ON ${tableName}`)
    }
  })

  it('documents database functions changed by the group sharing migration', () => {
    const migrationSql = readFileSync(groupSharingMigrationPath, 'utf8')
    const initSql = readFileSync(initDatabasePath, 'utf8')
    const signatures = extractFunctionSignatures(migrationSql)

    expect(signatures.length).toBeGreaterThan(0)
    for (const signature of signatures) {
      expect(migrationSql, `${signature} must have a COMMENT ON FUNCTION in 1.0.4 migration`)
        .toContain(`COMMENT ON FUNCTION ${signature} IS`)
      expect(initSql, `${signature} must have a COMMENT ON FUNCTION in init_database.sql baseline`)
        .toContain(`COMMENT ON FUNCTION ${signature} IS`)
    }
  })

  it('relies on Supabase identity linking instead of application-level OAuth profile claiming', () => {
    const initSql = readFileSync(initDatabasePath, 'utf8')
    const release104Files = readdirSync(join(versionsDir, '1.0.4'))

    expect(release104Files).not.toContain('003__claim_oauth_profile_by_email.sql')
    expect(initSql).not.toContain('claim_current_user_profile_by_email')
    expect(initSql).not.toContain('email_conflict')
    expect(initSql).not.toContain("current_setting('app.claim_current_user_profile_by_email', true)")
    expect(initSql).toContain('validate_agent_instance_principals')
  })

  it('keeps group API responses from exposing provider consumer identifiers', () => {
    const helpers = readFileSync(groupsHelpersPath, 'utf8')
    const usersRoute = readFileSync(usersRoutePath, 'utf8')

    expect(helpers).not.toContain('consumerId:')
    expect(helpers).toContain('getConsumerKeyProvider')
    expect(usersRoute.match(/const UserProfileSelect = '([^']+)'/)?.[1])
      .not.toContain('consumer_apikey_encrypted')
  })

  it('runs database migrations before the ROS platform deployment', () => {
    const template = readFileSync(platformTemplatePath, 'utf8')
    const oosPermissionBlock = template.slice(
      template.indexOf('  AgentManagerOOSClusterPermissions:'),
      template.indexOf('  # ===== 13. Deployment =====')
    )

    expect(template).toContain('DbMigrateJob:')
    expect(template).toContain('node migrations/init-db.js migrate')
    expect(template).toContain('AgentManagerOOSClusterPermissions:')
    expect(template).not.toContain('AgentManagerRamUserClusterPermissions:')
    expect(template).toContain('AgentManagerRamUser:')
    expect(template).toContain('AgentManagerRamAccessKey:')
    expect(template).toContain('CreateAgentManagerRamAccessKey:')
    expect(template).toContain('Fn::Sub: ${ALIYUN::StackName}-agent-manager')
    expect(template).not.toContain('OpenClawCloudRamUser')
    expect(template).not.toContain('OpenClawCloudAccessKey')
    expect(template).not.toContain('OpenClawCloudUserClusterPermissions')
    expect(template).not.toContain('CreateOpenClawAccessKey')
    expect(template).not.toContain('${ALIYUN::StackName}-openclaw-cloud')
    expect(template).toContain('Type: ALIYUN::CS::GrantPermissions')
    expect(template).not.toContain('CheckpointBackupOOSAssumeRoleName:')
    expect(template).toContain('AgentManagerOOSServiceRole-${RoleSuffix}')
    expect(template).toContain("Ref: ALIYUN::StackId")
    expect(template).toContain(
      'CHECKPOINT_BACKUP_OOS_ASSUME_ROLE: "${CheckpointBackupOOSRoleName}"'
    )
    expect(template).toContain(
      'CHECKPOINT_BACKUP_OOS_ASSUME_ROLE_ARN: "${CheckpointBackupOOSRoleArn}"'
    )
    expect(template).toContain('Fn::GetAtt: [AgentManagerOOSExecutionRole, RoleName]')
    expect(template).toContain('Fn::GetAtt: [AgentManagerOOSExecutionRole, Arn]')
    expect(template).toContain('acs:ram::${ALIYUN::TenantId}:role/agentmanageroosservicerole-*')
    expect(template).toContain("- 'sts:AssumeRole'")
    expect(template).toContain('Fn::Sub: acs:ram::${ALIYUN::TenantId}:root')
    expect(template).toContain("- 'oos:StartExecution'")
    expect(template).toContain("- 'ram:PassRole'")
    expect(template).toContain('CheckpointBackupOOSRoleName:')
    expect(template).toContain('CheckpointBackupOOSRoleId:')
    expect(template).toContain('CheckpointBackupOOSRoleArn:')
    expect(template).not.toContain('name: agent-manager-oos-checkpoint-backup-${StackName}')
    expect(oosPermissionBlock).toContain('RoleName: admin')
    expect(oosPermissionBlock).toContain('IsCustom: false')
    expect(oosPermissionBlock).toContain('IsRamRole: true')
    expect(template).not.toContain('Fn::GetAtt: [AgentManagerRamUser, UserId]')
    expect(template).toContain("- 'cs:DescribeClusterEndpoints'")
    expect(template).toContain("- 'cs:DescribeEdasClusterToken'")
    expect(template).toContain("- 'cs:DescribeUserPermission'")
    expect(template).toContain("- 'cs:DescribeClusterDetail'")
    expect(template).toContain(
      'Fn::Sub: acs:cs:${ALIYUN::Region}:${ALIYUN::TenantId}:cluster/${ClusterId}'
    )
    expect(template).toContain("- 'sts:AssumeRoleWithServiceIdentity'")
    expect(template).not.toContain("- 'cs:*'")
    expect(template).toContain(
      'DependsOn: [PlatformConfigMap, PlatformSecret, E2BCaCertConfigMap, DbMigrateJob, PlatformRBAC, AgentManagerOOSClusterPermissions]'
    )
  })
})
