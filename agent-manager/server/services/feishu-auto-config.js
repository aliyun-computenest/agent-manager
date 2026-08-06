/**
 * Feishu (飞书) Auto-Config Service
 *
 * Implements the Feishu Device Registration Flow based on OAuth 2.0 Device
 * Authorization Grant (RFC 8628). Uses a SINGLE endpoint with action parameter:
 *
 *   POST https://accounts.feishu.cn/oauth/v1/app/registration
 *   Content-Type: application/x-www-form-urlencoded
 *
 *   action=begin → device_code, verification_uri_complete, expire_in, interval
 *   action=poll  → client_id + client_secret on success, or error field while pending
 *
 * Reference: https://github.com/larksuite/oapi-sdk-go/blob/v3_main/scene/registration/registration.go
 */

const FEISHU_DOMAIN = 'https://accounts.feishu.cn'
const ENDPOINT = '/oauth/v1/app/registration'
const SDK_SOURCE = 'openclaw-manager'

// Hard timeout for every outbound call to prevent the Express worker from
// hanging when Feishu's edge keeps the socket open without responding.
const REQUEST_TIMEOUT_MS = Number(process.env.FEISHU_API_TIMEOUT_MS) || 10000

/**
 * Step 1: Begin the registration flow.
 * Sends action=begin to get device_code and verification URL.
 * @returns {Promise<{deviceCode: string, userCode: string, verificationUrl: string, verificationUri: string, interval: number, expiresIn: number}>}
 */
export async function begin() {
  const params = new URLSearchParams({
    action: 'begin',
    archetype: 'PersonalAgent',
    auth_method: 'client_secret',
    request_user_info: 'open_id'
  })

  const res = await fetch(`${FEISHU_DOMAIN}${ENDPOINT}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Feishu registration failed (${res.status}): ${text}`)
  }

  const data = await res.json()

  if (data.error) {
    throw new Error(`Feishu registration/begin error: ${data.error} - ${data.error_description || ''}`)
  }

  if (!data.device_code || !data.verification_uri_complete) {
    throw new Error('Feishu registration/begin did not return expected fields: ' + JSON.stringify(data))
  }

  // Build QR code URL with source tracking
  let verificationUrl = data.verification_uri_complete
  try {
    const u = new URL(verificationUrl)
    u.searchParams.set('from', 'sdk')
    u.searchParams.set('tp', 'sdk')
    u.searchParams.set('source', SDK_SOURCE)
    verificationUrl = u.toString()
  } catch (e) {
    // Use raw URL if parsing fails
  }

  return {
    deviceCode: data.device_code,
    userCode: data.user_code || '',
    verificationUrl,
    verificationUri: data.verification_uri || '',
    interval: data.interval || 5,
    expiresIn: data.expire_in || 600
  }
}

/**
 * Step 2: Poll the registration status.
 * @param {string} deviceCode - The device_code from begin()
 * @returns {Promise<{status: string, clientId?: string, clientSecret?: string, interval?: number, errmsg?: string}>}
 */
export async function poll(deviceCode) {
  if (!deviceCode) throw new Error('deviceCode is required for registration/poll')

  const params = new URLSearchParams({
    action: 'poll',
    device_code: deviceCode
  })

  const res = await fetch(`${FEISHU_DOMAIN}${ENDPOINT}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })

  // Feishu returns HTTP 400 together with an RFC 8628 error body while the
  // user has not finished authorizing yet (authorization_pending / slow_down),
  // so the body must be parsed before deciding whether this is a real failure.
  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  } catch (e) {
    throw new Error(`Feishu registration/poll failed (${res.status}): ${text}`)
  }

  if (!res.ok && !data.error) {
    throw new Error(`Feishu registration/poll failed (${res.status}): ${text}`)
  }

  // Success – user authorized, credentials returned
  if (data.client_id && data.client_secret) {
    return {
      status: 'SUCCESS',
      clientId: data.client_id,
      clientSecret: data.client_secret
    }
  }

  // Handle error field from Feishu (RFC 8628 style)
  switch (data.error) {
    case 'authorization_pending':
      return {
        status: 'PENDING',
        errmsg: 'authorization_pending'
      }

    case 'slow_down':
      return {
        status: 'PENDING',
        interval: 5, // SDK adds 5 seconds on slow_down
        errmsg: 'slow_down'
      }

    case 'access_denied':
      return {
        status: 'ERROR',
        errmsg: data.error_description || '用户拒绝了授权'
      }

    case 'expired_token':
      return {
        status: 'EXPIRED',
        errmsg: data.error_description || '授权已过期'
      }

    default:
      // Unknown error or empty response without credentials
      if (data.error) {
        return {
          status: 'ERROR',
          errmsg: `${data.error}: ${data.error_description || ''}`
        }
      }
      // No error field and no credentials – treat as pending
      return {
        status: 'PENDING',
        errmsg: 'waiting'
      }
  }
}
