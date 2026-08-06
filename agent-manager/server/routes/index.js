/**
 * Routes Index
 * Aggregates and exports all route modules
 */

import healthRoutes from './health.js'
import usersRoutes from './users.js'
import agentTypesRoutes from './agent-types.js'
import modelsRoutes from './models.js'
import instancesRoutes from './instances.js'
import channelsRoutes from './channels.js'
import ssoRoutes from './sso.js'
import providersRoutes from './providers.js'
import emailRoutes from './email.js'
import sandboxsetsRoutes from './sandboxsets.js'
import sandboxUpgradesRoutes from './sandbox-upgrades.js'
import observabilityRoutes from './observability.js'
import terminalRoutes from './terminal.js'
import channelAutoConfigRoutes from './channel-auto-config.js'
import groupsRoutes from './groups.js'
import skillHubConfigRoutes from './skill-hub-config.js'
import skillSpacesRoutes from './skill-spaces.js'
import skillFileDetectRoutes from './skill-file-detect.js'
import checkpointBackupsRoutes from './checkpoint-backups.js'
import installSkillsRoutes from './install-skills.js'

/**
 * Register all routes with the Express app
 * @param {Express} app - Express application instance
 */
function registerRoutes(app) {
  // Health check
  app.use('/api', healthRoutes)
  
  // User management
  app.use('/api', usersRoutes)
  
  // Agent type management (includes legacy template API)
  app.use('/api', agentTypesRoutes)

  // Sandbox backup and upgrade
  app.use('/api', sandboxUpgradesRoutes)

  // SAML SSO configuration
  app.use('/api', ssoRoutes)
  
  // AI Model management
  app.use('/api', modelsRoutes)
  
  // Agent instances
  app.use('/api', instancesRoutes)
  app.use('/api', installSkillsRoutes)

  // Checkpoint backup executions
  app.use('/api', checkpointBackupsRoutes)

  // Agent groups
  app.use('/api', groupsRoutes)

  // Browser terminal sessions
  app.use('/api', terminalRoutes)
  
  // Channel templates and config
  app.use('/api', channelsRoutes)
  
  // Provider management
  app.use('/api', providersRoutes)

  // Email auth settings
  app.use('/api', emailRoutes)

  // SandboxSet management (K8s CRD)
  app.use('/api', sandboxsetsRoutes)

  // Observability console embedding
  app.use('/api', observabilityRoutes)

  // Channel auto-config (DingTalk scan-to-configure)
  app.use('/api', channelAutoConfigRoutes)

  // ComputeNest Skill API proxy (catalog GETs are available to authenticated users)
  app.use('/api', skillHubConfigRoutes)
  app.use('/api', skillSpacesRoutes)
  app.use('/api', skillFileDetectRoutes)
}

export {
  registerRoutes,
  healthRoutes,
  usersRoutes,
  agentTypesRoutes,
  ssoRoutes,
  modelsRoutes,
  instancesRoutes,
  channelsRoutes,
  providersRoutes,
  sandboxsetsRoutes,
  sandboxUpgradesRoutes,
  observabilityRoutes,
  terminalRoutes,
  channelAutoConfigRoutes,
  groupsRoutes,
  skillHubConfigRoutes,
  skillSpacesRoutes,
  skillFileDetectRoutes,
  checkpointBackupsRoutes,
  installSkillsRoutes
}
