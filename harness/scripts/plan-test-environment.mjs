#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const ciRepo = 'acs-automation/agent-manager'
const ciRepoCodeUrl = 'https://code.alibaba-inc.com/acs-automation/agent-manager'
const ciPipelines = {
  envCreate: '.aoneci/harness_env_create.yaml',
  buildDeploy: '.aoneci/harness_build_deploy.yaml',
  envCleanup: '.aoneci/harness_env_cleanup.yaml',
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--work-item') {
      args.workItemId = argv[i + 1]
      i += 1
    } else if (arg === '--task') {
      args.taskId = argv[i + 1]
      i += 1
    } else if (arg === '--feature') {
      args.featureId = argv[i + 1]
      i += 1
    } else if (arg === '--artifact-root') {
      args.artifactRoot = argv[i + 1]
      i += 1
    } else if (arg === '--namespace-prefix') {
      args.namespacePrefix = argv[i + 1]
      i += 1
    } else if (arg === '--service-prefix') {
      args.servicePrefix = argv[i + 1]
      i += 1
    } else if (arg === '--base-domain') {
      args.baseDomain = argv[i + 1]
      i += 1
    } else if (arg === '--image-registry') {
      args.imageRegistry = argv[i + 1]
      i += 1
    } else if (arg === '--computenest-region') {
      args.computenestRegion = argv[i + 1]
      i += 1
    } else if (arg === '--deploy-region-id') {
      args.deployRegionId = argv[i + 1]
      i += 1
    } else if (arg === '--acs-region') {
      args.acsRegion = argv[i + 1]
      i += 1
    } else if (arg === '--acs-service-id') {
      args.acsServiceId = argv[i + 1]
      i += 1
    } else if (arg === '--ros-region') {
      args.rosRegion = argv[i + 1]
      i += 1
    } else if (arg === '--ros-template-path') {
      args.rosTemplatePath = argv[i + 1]
      i += 1
    } else if (arg === '--ros-parameter-file') {
      args.rosParameterFile = argv[i + 1]
      i += 1
    } else if (arg === '--help' || arg === '-h') {
      args.help = true
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return args
}

function requireValue(value, name) {
  if (!value) throw new Error(`${name} is required`)
  return value
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'run'
}

function hashParts(parts) {
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 12)
}

function trimDashes(value) {
  return String(value).replace(/^-+|-+$/g, '')
}

function shellValue(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`
}

function resolvePipelineCommand(yamlPath) {
  return `a1 ci pipeline get-by-path --repo ${ciRepo} --code-file-url ${ciRepoCodeUrl}/blob/<remote-branch>/${yamlPath} --format json`
}

function runPipelineCommand(pipelineId, params) {
  const paramFlags = Object.entries(params)
    .map(([key, value]) => `--param ${key}=${shellValue(value)}`)
    .join(' ')
  return `a1 ci pipeline run ${pipelineId} --repo ${ciRepo} --branch <remote-branch> ${paramFlags} --watch`
}

function buildPlan({
  workItemId,
  taskId,
  featureId,
  artifactRoot = 'harness/artifacts',
  namespacePrefix = 'am-harness',
  servicePrefix = 'openclaw-platform',
  baseDomain = '',
  imageRegistry = '',
  computenestRegion = 'ap-southeast-1',
  acsRegion = '',
  deployRegionId = 'cn-hongkong',
  acsServiceId = 'service-731298a621304868a3a4',
  acsClusterId = 'c2aa8f25b3d9443d28012b53cf7482920',
  vpcId = 'vpc-j6c11tziiynqsicwit1gv',
  vswitchId = 'vsw-j6ceq555bjkzfgmm5kewl',
  zoneId = 'cn-hongkong-d',
  skillhubOssBucket = 'skillhub-pre-test-intl',
  skillhubOssRegion = 'cn-hongkong',
  supabaseDeploymentMode = 'CreateNew',
  supabaseProjectSpec = '2C2G',
  supabaseStorageSize = '10',
  bootstrapImage = '',
  agentManagerArtifactId = 'artifact-d17025551f9b40a6a3ec',
  agentManagerArtifactRegion = 'ap-southeast-1',
  agentManagerArtifactVersion = '',
  rosRegion = 'cn-hongkong',
  rosTemplatePath = 'template/platform_template.yaml',
  rosParameterFile = '',
}) {
  const hash = hashParts([workItemId, taskId, featureId])
  const featureSlug = slug(featureId)
  const workItemSlug = slug(workItemId)
  const taskSlug = slug(taskId)
  const runId = `${featureSlug}-${hash}`
  const namespace = `${trimDashes(namespacePrefix)}-${hash}`
  const serviceName = trimDashes(servicePrefix)
  const imageTag = `${featureSlug}-${hash}`
  const normalizedBaseDomain = String(baseDomain || '').replace(/^https?:\/\//, '').replace(/\/+$/g, '')
  const baseUrl = normalizedBaseDomain ? `https://${serviceName}.${normalizedBaseDomain}` : `http://127.0.0.1:<port-forward-${hash}>`
  const imageRef = imageRegistry ? `${imageRegistry.replace(/\/+$/g, '')}:${imageTag}` : `<image-registry-required>:${imageTag}`
  const envCreateParameters = {
    work_item_id: workItemId,
    namespace,
    service_name: serviceName,
    computenest_region: computenestRegion || acsRegion || 'ap-southeast-1',
    deploy_region_id: deployRegionId,
    acs_service_id: acsServiceId,
    acs_cluster_id: acsClusterId,
    vpc_id: vpcId,
    vswitch_id: vswitchId,
    zone_id: zoneId,
    skillhub_oss_bucket: skillhubOssBucket,
    skillhub_oss_region: skillhubOssRegion,
    supabase_deployment_mode: supabaseDeploymentMode,
    supabase_project_spec: supabaseProjectSpec,
    supabase_storage_size: supabaseStorageSize,
    agent_manager_artifact_id: agentManagerArtifactId,
    agent_manager_artifact_region: agentManagerArtifactRegion,
    ros_region: rosRegion,
    ros_template_path: rosTemplatePath,
  }
  if (bootstrapImage) envCreateParameters.bootstrap_image = bootstrapImage
  if (agentManagerArtifactVersion) envCreateParameters.agent_manager_artifact_version = agentManagerArtifactVersion
  if (rosParameterFile) envCreateParameters.ros_parameter_file = rosParameterFile
  const buildDeployParameters = {
    image_tag: imageTag,
    namespace,
    service_name: serviceName,
    container_name: serviceName,
    work_item_id: workItemId,
  }
  return {
    schemaVersion: '1.0',
    runId,
    featureId,
    workItemId,
    taskId,
    isolated: true,
    namespace,
    serviceName,
    baseUrl,
    imageRegistry: imageRegistry || '<image-registry-required>',
    imageTag,
    imageRef,
    dbPrefix: `it_${hash}_`,
    artifactDir: `${artifactRoot.replace(/\/+$/g, '')}/${runId}`,
    labels: {
      'harness.work-item': workItemSlug,
      'harness.task': taskSlug,
      'harness.feature': featureSlug,
    },
    cleanup: {
      kubernetesNamespace: `kubectl delete namespace ${namespace} --ignore-not-found`,
      databasePrefix: `drop objects whose names start with it_${hash}_`,
      artifacts: `${artifactRoot.replace(/\/+$/g, '')}/${runId}`,
    },
    ci: {
      repo: ciRepo,
      branch: '<remote-branch>',
      envCreate: {
        pipelinePath: ciPipelines.envCreate,
        pipelineId: '<env_create_pipeline_id>',
        resolveCommand: resolvePipelineCommand(ciPipelines.envCreate),
        parameters: envCreateParameters,
        runCommand: runPipelineCommand('<env_create_pipeline_id>', envCreateParameters),
      },
      buildDeploy: {
        pipelinePath: ciPipelines.buildDeploy,
        pipelineId: '<build_deploy_pipeline_id>',
        resolveCommand: resolvePipelineCommand(ciPipelines.buildDeploy),
        parameters: buildDeployParameters,
        runCommand: runPipelineCommand('<build_deploy_pipeline_id>', buildDeployParameters),
      },
      envCleanup: {
        pipelinePath: ciPipelines.envCleanup,
        pipelineId: '<env_cleanup_pipeline_id>',
        resolveCommand: resolvePipelineCommand(ciPipelines.envCleanup),
        parameters: {
          namespace,
          work_item_id: workItemId,
        },
        runCommand: runPipelineCommand('<env_cleanup_pipeline_id>', {
          namespace,
          work_item_id: workItemId,
        }),
      },
    },
    localAccess: {
      portForwardCommand: `kubectl -n ${namespace} port-forward svc/${serviceName} 18080:80`,
      note: 'Port-forward is for local browser/API access after AOneCI deploys the Service; it is not deployment evidence by itself.',
    },
    repoRoot,
  }
}

function printHelp() {
  console.log(`Usage: node harness/scripts/plan-test-environment.mjs \\
  --work-item <id> --task <id> --feature <feature-id> [--artifact-root <path>]
  [--namespace-prefix am-harness] [--service-prefix openclaw-platform]
  [--computenest-region ap-southeast-1] [--deploy-region-id cn-hongkong]
  [--acs-service-id service-731298a621304868a3a4]
  [--ros-region cn-hongkong] [--ros-template-path template/platform_template.yaml]
  [--base-domain example.com] [--image-registry registry/repo]

Prints a deterministic isolated environment plan for Harness delivery runs.
The command is read-only and does not create namespaces, schemas, or artifacts.`)
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }
  const plan = buildPlan({
    workItemId: requireValue(args.workItemId, '--work-item'),
    taskId: requireValue(args.taskId, '--task'),
    featureId: requireValue(args.featureId, '--feature'),
    artifactRoot: args.artifactRoot,
    namespacePrefix: args.namespacePrefix,
    servicePrefix: args.servicePrefix,
    baseDomain: args.baseDomain,
    imageRegistry: args.imageRegistry,
    computenestRegion: args.computenestRegion,
    acsRegion: args.acsRegion,
    deployRegionId: args.deployRegionId,
    acsServiceId: args.acsServiceId,
    acsClusterId: args.acsClusterId,
    vpcId: args.vpcId,
    vswitchId: args.vswitchId,
    zoneId: args.zoneId,
    skillhubOssBucket: args.skillhubOssBucket,
    skillhubOssRegion: args.skillhubOssRegion,
    supabaseDeploymentMode: args.supabaseDeploymentMode,
    supabaseProjectSpec: args.supabaseProjectSpec,
    supabaseStorageSize: args.supabaseStorageSize,
    bootstrapImage: args.bootstrapImage,
    agentManagerArtifactId: args.agentManagerArtifactId,
    agentManagerArtifactRegion: args.agentManagerArtifactRegion,
    agentManagerArtifactVersion: args.agentManagerArtifactVersion,
    rosRegion: args.rosRegion,
    rosTemplatePath: args.rosTemplatePath,
    rosParameterFile: args.rosParameterFile,
  })
  console.log(JSON.stringify(plan, null, 2))
}

main()
