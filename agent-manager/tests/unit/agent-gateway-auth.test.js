import { existsSync, readFileSync } from 'node:fs'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import {
  buildGatewayUrl,
  canAccessGatewayInstance,
  normalizeGatewayDomain,
  normalizeNextPath,
  parseGatewayDomainConfig,
  sameHostname
} from '../../server/utils/agent-gateway-auth.js'

const gatewayHost = 'apps.example.com'
const instanceId = '1aa75d2e-55ee-409e-8c30-f318cfa4cdeb'
const sandboxId = 'default--agent-manager-hermes-c7982'

function readDeployGatewayTemplate() {
  return readFileSync(
    new URL('../../deploy/agent-gateway/openresty.conf.template', import.meta.url),
    'utf8'
  )
}

function readRosTemplate(relativePath) {
  return yaml.load(readFileSync(new URL(relativePath, import.meta.url), 'utf8'))
}

function readRosGatewayTemplate(relativePath) {
  const template = readRosTemplate(relativePath)
  return template.Resources.AgentGatewayResources.Properties.YamlContent['Fn::Sub'][0]
}

function readInstancesRoute() {
  return readFileSync(new URL('../../server/routes/instances.js', import.meta.url), 'utf8')
}

function readAgentGatewayInternalRoute() {
  return readFileSync(new URL('../../server/routes/internal/agent-gateway.js', import.meta.url), 'utf8')
}

function readGatewayDeployFile(filename) {
  return readFileSync(new URL(`../../deploy/agent-gateway/${filename}`, import.meta.url), 'utf8')
}

function allGatewayTemplates() {
  return [
    { name: 'deploy', template: readDeployGatewayTemplate() }
  ]
}

function allRosTemplates() {
  return [
    { name: 'platform_template.yaml', path: '../../../template/platform_template.yaml' },
    { name: 'platform_template_intl.yaml', path: '../../../template/platform_template_intl.yaml' }
  ]
    .filter(item => existsSync(new URL(item.path, import.meta.url)))
    .map(item => ({ name: item.name, template: readRosTemplate(item.path) }))
}

describe('agent gateway auth helpers', () => {
  it('configures nginx to pass the instance token only to the upstream sandbox', () => {
    for (const { name, template } of allGatewayTemplates()) {
      expect(template, name).toContain('set $openclaw_upstream_host "";')
      expect(template, name).toContain('set $openclaw_upstream_uri $uri;')
      expect(template, name).toContain('local upstream_host = res.header["X-Agent-Gateway-Upstream-Host"]')
      expect(template, name).toContain('proxy_pass https://$openclaw_upstream_host$openclaw_upstream_uri$is_args$args$openclaw_upstream_token_suffix;')
      expect(template, name).toContain('proxy_ssl_trusted_certificate /etc/openclaw-agent-gateway/e2b-ca/ca-fullchain.pem;')
      expect(template, name).toContain('proxy_ssl_verify on;')
      expect(template, name).toContain('proxy_request_buffering off;')
      expect(template, name).not.toContain('lua_need_request_body on;')
    }
  })

  it('uses the latest agent gateway public contract names', () => {
    for (const { name, template } of allGatewayTemplates()) {
      expect(template, name).toContain('/__agent_gateway_auth')
      expect(template, name).toContain('/__agent_gateway_health')
      expect(template, name).toContain('/__agent_gateway_client.js')
      expect(template, name).toContain('X-Agent-Gateway-Upstream-Host')
      expect(template, name).not.toContain('X-Agent-Gateway-Mode')
      expect(template, name).not.toContain('X-Agent-Gateway-Auth')
      expect(template, name).not.toContain('mode == "cookie"')
      expect(template, name).not.toContain('/__openclaw_')
      expect(template, name).not.toContain('__openclaw_')
      expect(template, name).not.toContain('X-OpenClaw')
      expect(template, name).not.toContain('__agent_gateway_tab_session')
      expect(template, name).not.toContain('__agent_gateway_active_session')
      expect(template, name).not.toContain('当前页面已失效')
    }
  })

  it('supports path-prefix routing with per-instance gateway cookies', () => {
    for (const { name, template } of allGatewayTemplates()) {
      expect(template, name).toContain('__agent_gateway_token_')
      expect(template, name).toContain('__agent_gateway_current')
      expect(template, name).toContain('__agent_gateway_upstream_token_')
      expect(template, name).toContain('__agent_gateway_client.js')
      expect(template, name).toContain('window.__agent_gateway_prefix')
      expect(template, name).toContain('window.__OPENCLAW_CONTROL_UI_BASE_PATH__')
      expect(template, name).not.toContain('window.__agent_gateway_token_param')
      expect(template, name).toContain('local path_instance_id = original_uri:match("^/([^/]+)")')
      expect(template, name).toContain('local instance_id = is_instance_prefix(path_instance_id) and path_instance_id or nil')
      expect(template, name).toContain('set $openclaw_upstream_authorization "";')
      expect(template, name).toContain('proxy_set_header Authorization $openclaw_upstream_authorization;')
      expect(template, name).toContain('需要从 Agent Manager 平台打开')
      expect(template, name).not.toContain('gateway_session_conflict')
      expect(template, name).not.toContain('ngx.HTTP_CONFLICT')
      expect(template, name).not.toContain('__agent_gateway_session')
      expect(template, name).not.toContain('__agent_gateway_instance')
      expect(template, name).not.toContain('__agent_gateway_token=;')
      expect(template, name).not.toContain('read_cookie("__agent_gateway_token")')
      expect(template, name).not.toContain('legacy_instance_id')
      expect(template, name).not.toContain('resty.random')
      expect(template, name).not.toContain('original_uri == "/"')
      expect(template, name).not.toContain('query_changed')
    }
  })

  it('defaults ROS gateway access on while leaving TLS certificates manually managed', () => {
    for (const { name, template } of allRosTemplates()) {
      expect(template.Parameters.EnableAgentGatewayAccess.Default, name).toBe('true')
      expect(template.Parameters, name).not.toHaveProperty('AgentGatewayDomain')
      expect(template.Parameters, name).not.toHaveProperty('AgentGatewayTlsCert')
      expect(template.Parameters, name).not.toHaveProperty('AgentGatewayTlsKey')
      expect(template.Conditions, name).not.toHaveProperty('AgentGatewayDomainProvided')
      expect(template.Conditions, name).not.toHaveProperty('CreateAgentGatewayTlsSecret')
      expect(template.Resources, name).not.toHaveProperty('AgentGatewayTlsSecret')
      const gatewayEndpointValue = template.Resources.PlatformConfigMap.Properties.YamlContent['Fn::Sub'][1].AgentGatewayEndpointValue
      expect(JSON.stringify(gatewayEndpointValue), name).toContain('http://${GatewayIp}:8080')
      expect(JSON.stringify(template.Outputs.AgentGatewayUrl.Value), name).toContain('http://${GatewayIp}:8080')
    }

    const deployment = readGatewayDeployFile('deployment.yaml')
    expect(deployment).toContain('secretName: openclaw-agent-gateway-tls')
    expect(deployment).toContain('optional: true')
  })

  it('deploys ROS gateway resources from a ComputeNest file artifact bundle', () => {
    for (const { name, template } of allRosTemplates()) {
      const gatewayTemplate = template.Resources.AgentGatewayResources.Properties.YamlContent['Fn::Sub'][0]

      expect(gatewayTemplate, name).toContain('{{ computenest::file::agent-gateway-bundle }}')
      expect(gatewayTemplate, name).toContain('install-agent-gateway-bundle.sh')
      expect(gatewayTemplate, name).toContain('AGENT_GATEWAY_BUNDLE_URL')
      expect(gatewayTemplate, name).not.toContain('agent_gateway_client.js: |')
      expect(gatewayTemplate, name).not.toContain('openresty.conf.template: |')
      expect(gatewayTemplate, name).not.toContain('worker_processes auto;')
      expect(gatewayTemplate, name).not.toContain('window.__agent_gateway_prefix')
    }
  })

  it('keeps the gateway artifact installer responsible for applying bundled files', () => {
    const installer = readGatewayDeployFile('install-agent-gateway-bundle.sh')
    const deployment = readGatewayDeployFile('deployment.yaml')
    const service = readGatewayDeployFile('service.yaml')
    const startScript = readGatewayDeployFile('start-openresty.sh')

    expect(installer).toContain('AGENT_GATEWAY_BUNDLE_URL is required')
    expect(installer).toContain('__AGENT_GATEWAY_BUNDLE_URL__')
    expect(installer).toContain('start-openresty.sh')
    expect(installer).not.toContain('create configmap openclaw-agent-gateway-config')
    expect(installer).not.toContain('--from-file=openresty.conf.template=')
    expect(installer).not.toContain('--from-file=agent_gateway_client.js=')
    expect(deployment).toContain('initContainers:')
    expect(deployment).toContain('name: fetch-agent-gateway-bundle')
    expect(deployment).toContain('emptyDir: {}')
    expect(deployment).toContain('AGENT_GATEWAY_BUNDLE_URL')
    expect(deployment).toContain('__AGENT_GATEWAY_BUNDLE_URL__')
    expect(deployment).toContain('cpu: "1"')
    expect(deployment).toContain('memory: 1Gi')
    expect(deployment).toContain('cpu: "2"')
    expect(deployment).toContain('memory: 2Gi')
    expect(deployment).toContain('command: ["/bin/sh", "/etc/openclaw-agent-gateway/start-openresty.sh"]')
    expect(deployment).not.toContain('escape_sed_replacement()')
    expect(startScript).toContain('exec openresty')
    expect(installer).toContain('__GATEWAY_SLB_ID__')
    expect(installer).toContain('__PLATFORM_PUBLIC_URL__')
    expect(installer).toContain('kubectl -n "$NAMESPACE" apply -f')
    expect(service).toContain('service.beta.kubernetes.io/alibaba-cloud-loadbalancer-id')
    expect(service).toContain('__GATEWAY_SLB_ID__')
    expect(service).toContain('port: 8080')
    expect(service).toContain('targetPort: 8080')
  })

  it('hardens gateway runtime templates against unsafe generated values', () => {
    const installer = readGatewayDeployFile('install-agent-gateway-bundle.sh')
    const deployment = readGatewayDeployFile('deployment.yaml')
    const startScript = readGatewayDeployFile('start-openresty.sh')
    const nginx = readDeployGatewayTemplate()

    expect(installer).toContain("grep -Eq '^lb-[A-Za-z0-9-]+$'")
    expect(installer).toContain("grep -Eq '^[A-Za-z0-9_.:-]+$'")
    expect(installer).toContain('kubectl -n "$NAMESPACE" annotate deployment openclaw-agent-gateway')
    expect(installer).not.toContain('kubectl -n "$NAMESPACE" patch deployment openclaw-agent-gateway')
    expect(startScript).toContain("grep -Eq '^([0-9]{1,3}\\.){3}[0-9]{1,3}$'")
    expect(startScript).toContain('PLATFORM_API must not contain control characters')
    expect(startScript).toContain('PLATFORM_PUBLIC_URL must start with http:// or https://')
    expect(deployment).toContain('PLATFORM_PUBLIC_URL')
    expect(deployment).toContain('livenessProbe:')
    expect(nginx).toContain('worker_connections 4096;')
    expect(nginx).toContain('set $platform_login_url "__PLATFORM_LOGIN_URL__";')
    expect(nginx).toContain('return 302 $platform_login_url;')
    expect(nginx).toContain('Max-Age=3600')
    expect(nginx).not.toContain('sub_filter_types *;')
    expect(nginx).toContain('client_max_body_size 1024m;')
    expect(nginx).toContain('client_body_buffer_size 1024k;')
    expect(nginx).toContain('large_client_header_buffers 4 1024k;')
    expect(nginx).toContain('proxy_buffer_size 1024k;')
    expect(nginx).toContain('proxy_buffers 8 1024k;')
    expect(nginx).toContain('proxy_busy_buffers_size 1024k;')
  })

  it('keeps ordinary instance details on the existing sandboxUrl shape', () => {
    const route = readInstancesRoute()
    expect(route).not.toContain('agentAccessStatus')
    expect(route).not.toContain('agentAccessScheme')
    expect(route).not.toContain('agentAccessMode')
    expect(route).not.toContain('sandboxAccessStatus')
  })

  it('allows operators to force legacy direct sandbox URLs from server config', () => {
    const config = readFileSync(new URL('../../server/config/index.js', import.meta.url), 'utf8')
    const route = readInstancesRoute()

    expect(config).toContain("AGENT_GATEWAY_ACCESS_MODE = (process.env.AGENT_GATEWAY_ACCESS_MODE || env.AGENT_GATEWAY_ACCESS_MODE || 'auto')")
    expect(config).toContain('AGENT_GATEWAY_ACCESS_MODE')
    expect(route).toContain("const AgentAuthType = Object.freeze({")
    expect(route).toContain("Auth: 'Auth'")
    expect(route).toContain("NoAuth: 'NoAuth'")
    expect(route).toContain('agentAuthType === AgentAuthType.NoAuth')
    expect(route).toContain("const shouldUseAgentGatewayUrl = AGENT_GATEWAY_ACCESS_MODE !== 'legacy'")
    expect(route).toContain('if (shouldUseAgentGatewayUrl) {')
    for (const { name, template } of allRosTemplates()) {
      const configYaml = template.Resources.PlatformConfigMap.Properties.YamlContent['Fn::Sub'][0]
      const gatewayTemplate = template.Resources.AgentGatewayResources.Properties.YamlContent['Fn::Sub'][0]
      expect(configYaml, name).toContain('AGENT_GATEWAY_ACCESS_MODE: "auto"')
      expect(gatewayTemplate, name).toContain('PLATFORM_PUBLIC_URL="${PlatformPublicUrl}"')
    }
  })

  it('uses a dedicated internal API for gateway validation', () => {
    const nginx = readDeployGatewayTemplate()
    const routeIndex = readFileSync(new URL('../../server/routes/index.js', import.meta.url), 'utf8')
    const instancesRoute = readInstancesRoute()
    const internalRoute = readAgentGatewayInternalRoute()

    expect(nginx).toContain('proxy_pass $platform_api/internal/agent-gateway/instances/$1;')
    expect(nginx).not.toContain('/api/instances/$1?gatewayAuth=1')
    expect(routeIndex).toContain("app.use('/internal/agent-gateway', agentGatewayRoutes)")
    expect(instancesRoute).not.toContain('gatewayAuth')
    expect(instancesRoute).not.toContain('isGatewayAuthRequest')
    expect(internalRoute).not.toContain('x-agent-gateway-auth')
    expect(internalRoute).not.toContain('Gateway auth required')
    expect(internalRoute).toContain("path: '/instances/{instanceId}'")
  })

  it('keeps the internal gateway API lean and short-lived cached', () => {
    const internalRoute = readAgentGatewayInternalRoute()

    expect(internalRoute).toContain("select('id,principal_id,sandbox_id,status,token,agent_type_id')")
    expect(internalRoute).not.toContain(".select('*')")
    expect(internalRoute).toContain('GATEWAY_VALIDATION_CACHE_TTL_MS')
    expect(internalRoute).toContain('getCachedGatewayValidation')
    expect(internalRoute).toContain('setCachedGatewayValidation')
    expect(internalRoute).toContain('buildAgentGatewayValidation')
    expect(internalRoute).toContain('resolveAgentGatewayPort')
    expect(internalRoute).toContain('return sendGatewayValidationResult(res, cachedValidation)')
    expect(internalRoute).toContain('return res.status(204).end()')
    expect(internalRoute).not.toContain('sandboxUrl: gatewaySandboxUrl')
    expect(internalRoute).not.toContain('buildE2BUpstreamHost')
    expect(internalRoute).not.toContain('buildAgentGatewaySandboxUrl')
    // 网关授权使用 canAccessInstanceRecord 支持分组成员访问
    expect(internalRoute).toContain('canAccessInstanceRecord')
    expect(internalRoute).toContain('getActiveGroupMemberships')
    expect(internalRoute).toContain('principal-access')
    // 不再使用仅检查 owner 的 canAccessGatewayInstance
    expect(internalRoute).not.toContain('canAccessGatewayInstance')
    // 不按用户过滤查询，因为分组成员也需要访问分组实例
    expect(internalRoute).not.toContain(".eq('principal_id', req.user.id")
  })

  it('keeps gateway host validation header only in the internal proxy location', () => {
    const nginx = readDeployGatewayTemplate()

    expect(nginx).toContain('proxy_set_header X-Agent-Gateway-Host $host;')
    expect(nginx).not.toContain('proxy_set_header X-Agent-Gateway-Auth')
    expect(nginx).not.toContain('ngx.req.set_header("X-Agent-Gateway-Auth"')
    expect(nginx).not.toContain('ngx.req.set_header("X-Agent-Gateway-Host"')
  })

  it('keeps the upstream token out of browser-visible URLs', () => {
    for (const { name, template } of allGatewayTemplates()) {
      expect(template, name).toContain('query_args["token"] = nil')
      expect(template, name).toContain('$openclaw_upstream_token_suffix')
      expect(template, name).toContain('__agent_gateway_upstream_token_')
      expect(template, name).not.toContain('next_path = next_path .. "#" .. upstream_token_param')
      expect(template, name).not.toContain('window.__agent_gateway_token_param')
    }
  })

  it('seeds the OpenClaw control UI token without using a visible URL token', () => {
    const client = readGatewayDeployFile('agent_gateway_client.js')
    const nginx = readDeployGatewayTemplate()

    expect(client).toContain('openclaw.control.token.v1:')
    expect(client).toContain("setOpenClawControlToken('openclaw.control.token.v1:' + gatewayUrl, token)")
    expect(client).toContain("setOpenClawControlToken('openclaw.control.token.v1:' + gatewayUrl + '/', token)")
    expect(client).toContain('window.localStorage.setItem(key, token)')
    expect(client).toContain('window.sessionStorage.setItem(key, token)')
    expect(nginx).toContain('window.__OPENCLAW_CONTROL_UI_BASE_PATH__="/$openclaw_gateway_instance_id"')
    expect(client).not.toContain('window.__OPENCLAW_CONTROL_UI_BASE_PATH__ = gatewayPrefix')
    expect(client).toContain('__agent_gateway_upstream_token_')
    expect(client).toContain('clearGatewayTokenCookie(tokenCookieName)')
    expect(client).toContain("new URLSearchParams(tokenParam).get('token')")
    expect(client).toContain('function isSameGatewayOrigin(url)')
    expect(client).toContain("url.protocol === 'ws:'")
    expect(client).not.toContain('window.location.hash')
    expect(client).not.toContain('window.location.search')
    expect(client).not.toContain('__agent_gateway_token_param')
  })

  it('namespaces browser storage by gateway instance', () => {
    const client = readGatewayDeployFile('agent_gateway_client.js')

    expect(client).toContain("return instanceId ? '__agent_gateway_storage__:' + instanceId + ':' : ''")
    expect(client).toContain('function patchWebStorageNamespace()')
    expect(client).toContain('proto.setItem = function (key, value)')
    expect(client).toContain('namespaceStorageKey(prefix, key)')
    expect(client).toContain('proto.clear = function ()')
    expect(client).toContain('function patchIndexedDBNamespace()')
    expect(client).toContain('window.indexedDB.open = function (name, version)')
    expect(client).toContain('window.indexedDB.deleteDatabase = function (name)')
    expect(client).toContain("key.indexOf('openclaw.control.token.v1:') === 0")
  })

  it('normalizes gateway domain config with an optional scheme', () => {
    expect(parseGatewayDomainConfig('apps.example.com')).toEqual({
      domain: 'apps.example.com',
      scheme: 'http',
      enabled: true
    })
    expect(parseGatewayDomainConfig('https://Apps.Example.com/')).toEqual({
      domain: 'apps.example.com',
      scheme: 'https',
      enabled: true
    })
    expect(parseGatewayDomainConfig('')).toEqual({
      domain: '',
      scheme: 'http',
      enabled: false
    })
    expect(normalizeGatewayDomain('http://apps.example.com/path')).toBe('apps.example.com')
  })

  it('builds path-prefix gateway URLs when HTTPS is configured', () => {
    expect(buildGatewayUrl({
      scheme: 'https',
      instanceId,
      sandboxId,
      agentPort: 9119,
      gatewayDomain: 'apps.example.com'
    })).toBe(`https://${gatewayHost}/${instanceId}/`)
  })

  it('builds path-prefix gateway URLs when HTTP or IP is configured', () => {
    expect(buildGatewayUrl({
      scheme: 'http',
      instanceId,
      gatewayDomain: '47.83.224.130'
    })).toBe(`http://47.83.224.130:8080/${instanceId}/`)

    expect(buildGatewayUrl({
      scheme: 'http',
      instanceId,
      gatewayDomain: '47.83.224.130:8088'
    })).toBe(`http://47.83.224.130:8088/${instanceId}/`)

    expect(buildGatewayUrl({
      scheme: 'http',
      instanceId,
      gatewayDomain: 'apps.example.com'
    })).toBe(`http://apps.example.com/${instanceId}/`)

    expect(buildGatewayUrl({
      scheme: 'http',
      instanceId: '../bad',
      gatewayDomain: '47.83.224.130'
    })).toBeNull()
  })

  it('normalizes unsafe next paths to root', () => {
    expect(normalizeNextPath('/')).toBe('/')
    expect(normalizeNextPath('/workspace?tab=1')).toBe('/workspace?tab=1')
    expect(normalizeNextPath('//evil.example.com')).toBe('/')
    expect(normalizeNextPath('https://evil.example.com')).toBe('/')
    expect(normalizeNextPath('/a/../b')).toBe('/')
    expect(normalizeNextPath('/safe/%252e%252e/admin')).toBe('/')
    expect(normalizeNextPath('/safe/%252E%252E/admin')).toBe('/')
  })

  it('compares sandbox urls with gateway request hosts', () => {
    const url = `https://${gatewayHost}/${instanceId}/`
    expect(sameHostname(url, gatewayHost)).toBe(true)
    expect(sameHostname(url, `${gatewayHost}:443`)).toBe(true)
    expect(sameHostname(`http://47.83.224.130:8080/${instanceId}/`, '47.83.224.130')).toBe(true)
    expect(sameHostname(url, `other.${gatewayHost}`)).toBe(false)
  })

  it('allows admins and owners while blocking other users', () => {
    expect(canAccessGatewayInstance({
      isAdmin: false,
      instancePrincipalId: 'owner-user',
      instanceUserId: 'owner-user',
      requestUserId: 'owner-user'
    })).toBe(true)
    expect(canAccessGatewayInstance({
      isAdmin: false,
      instancePrincipalId: 'owner-user',
      instanceUserId: 'owner-user',
      requestUserId: 'other-user'
    })).toBe(false)
    expect(canAccessGatewayInstance({
      isAdmin: true,
      instancePrincipalId: 'owner-user',
      instanceUserId: 'owner-user',
      requestUserId: 'admin-user'
    })).toBe(true)
  })

  it('allows group members to access shared instances', () => {
    const groupId = 'group-123'
    const memberships = [
      { group_id: groupId, principal_id: 'member-user', role: 'member', status: 'active' }
    ]

    // 同分组 active 成员可以访问
    expect(canAccessGatewayInstance({
      isAdmin: false,
      instancePrincipalId: groupId,
      instanceUserId: 'owner-user',
      requestUserId: 'member-user',
      groupMemberships: memberships
    })).toBe(true)

    // removed 成员不能访问
    const removedMemberships = [
      { group_id: groupId, principal_id: 'member-user', role: 'member', status: 'removed' }
    ]
    expect(canAccessGatewayInstance({
      isAdmin: false,
      instancePrincipalId: groupId,
      instanceUserId: 'owner-user',
      requestUserId: 'member-user',
      groupMemberships: removedMemberships
    })).toBe(false)

    // 不在分组中的用户不能访问
    expect(canAccessGatewayInstance({
      isAdmin: false,
      instancePrincipalId: groupId,
      instanceUserId: 'owner-user',
      requestUserId: 'non-member-user',
      groupMemberships: memberships
    })).toBe(false)

    // 私有实例 owner 是用户 principal，同组成员无关，仍需 owner
    expect(canAccessGatewayInstance({
      isAdmin: false,
      instancePrincipalId: 'owner-user',
      instanceUserId: 'owner-user',
      requestUserId: 'member-user',
      groupMemberships: memberships
    })).toBe(false)

    // 不同分组的成员不能访问
    const otherGroupMemberships = [
      { group_id: 'other-group', principal_id: 'member-user', role: 'member', status: 'active' }
    ]
    expect(canAccessGatewayInstance({
      isAdmin: false,
      instancePrincipalId: groupId,
      instanceUserId: 'owner-user',
      requestUserId: 'member-user',
      groupMemberships: otherGroupMemberships
    })).toBe(false)

    // admin 仍然可以访问分组实例
    expect(canAccessGatewayInstance({
      isAdmin: true,
      instancePrincipalId: groupId,
      instanceUserId: 'owner-user',
      requestUserId: 'admin-user',
      groupMemberships: []
    })).toBe(true)

    // 创建者也必须仍是 active member 才可以访问分组实例
    expect(canAccessGatewayInstance({
      isAdmin: false,
      instancePrincipalId: groupId,
      instanceUserId: 'owner-user',
      requestUserId: 'owner-user',
      groupMemberships: []
    })).toBe(false)
    expect(canAccessGatewayInstance({
      isAdmin: false,
      instancePrincipalId: groupId,
      instanceUserId: 'owner-user',
      requestUserId: 'owner-user',
      groupMemberships: [{ group_id: groupId, principal_id: 'owner-user', role: 'member', status: 'active' }]
    })).toBe(true)
  })
})
