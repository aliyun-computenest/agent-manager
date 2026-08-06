/**
 * CMS (Cloud Monitor Service) - CreateTicket for console embedding
 *
 * Uses AK/SK to directly call CreateTicket API, generating time-limited
 * single-use embed tickets for Alibaba Cloud console pages.
 */
import _OpenApi, * as $OpenApi from '@alicloud/openapi-client'
const OpenApiClient = _OpenApi.default || _OpenApi
import * as $Util from '@alicloud/tea-util'
import { env } from '../config/index.js'

const CMS_ENDPOINT = env.CMS_ENDPOINT || 'cms.cn-shanghai.aliyuncs.com'

/**
 * Generate embed URL with ticket
 * @param {string} baseUrl - The Alibaba Cloud console URL to embed
 * @param {string} akId - AccessKey ID for CMS CreateTicket
 * @param {string} akSecret - AccessKey Secret for CMS CreateTicket
 * @returns {Promise<{success: boolean, embedUrl?: string, ticket?: string, error?: string}>}
 */
export async function generateEmbedUrl(baseUrl, akId, akSecret) {
  try {
    if (!akId || !akSecret) {
      throw new Error('Missing AccessKey ID or Secret for CMS CreateTicket')
    }

    const config = new $OpenApi.Config({
      accessKeyId: akId,
      accessKeySecret: akSecret,
      endpoint: CMS_ENDPOINT
    })

    const client = new OpenApiClient(config)

    const params = new $OpenApi.Params({
      action: 'CreateTicket',
      version: '2024-03-30',
      protocol: 'HTTPS',
      method: 'POST',
      authType: 'AK',
      style: 'ROA',
      pathname: '/tickets',
      reqBodyType: 'json',
      bodyType: 'json'
    })

    const request = new $OpenApi.OpenApiRequest({
      body: {
        expirationTime: 86400
      }
    })

    const runtime = new $Util.RuntimeOptions({})

    const ticketResp = await client.callApi(params, request, runtime)
    const body = ticketResp?.body

    const ticket = body?.Data?.Ticket || body?.ticket || body?.Data?.ticket
    if (!ticket) {
      throw new Error('CreateTicket returned no ticket: ' + JSON.stringify(body))
    }

    // Build embed URL
    const separator = baseUrl.includes('?') ? '&' : '?'
    const embedUrl = `${baseUrl}${separator}sls_ticket=${encodeURIComponent(ticket)}&hideTopbar=true&hideSiderbar=true&hideBreadcrumb=true`

    return { success: true, embedUrl }
  } catch (error) {
    console.error('[CMS] Generate embed URL failed:', error)
    return { success: false, error: error.message }
  }
}
