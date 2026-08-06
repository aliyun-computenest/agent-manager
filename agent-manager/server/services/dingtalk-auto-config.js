/**
 * DingTalk Auto-Config Service
 *
 * Implements the DingTalk Device Registration Flow:
 *   1. init()  – POST /app/registration/init  → nonce
 *   2. begin() – POST /app/registration/begin → device_code, verification_uri_complete, etc.
 *   3. poll()  – POST /app/registration/poll  → status + client_id/client_secret on SUCCESS
 *
 * This enables scan-to-configure: users scan a QR code with DingTalk app,
 * authorize, and the platform automatically receives channel credentials.
 */

const DINGTALK_API_BASE = 'https://api.dingtalk.com'

// Hard timeout for every outbound call. Without this the Express handler
// would hang for as long as the third-party server keeps the socket open,
// which can starve the worker thread under intermittent network issues.
const REQUEST_TIMEOUT_MS = Number(process.env.DINGTALK_API_TIMEOUT_MS) || 10000

/**
 * Step 1: Initialize the registration flow and obtain a nonce.
 * @returns {Promise<{nonce: string}>}
 */
export async function init() {
  const res = await fetch(`${DINGTALK_API_BASE}/app/registration/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`DingTalk registration/init failed (${res.status}): ${text}`)
  }

  const json = await res.json()
  if (json.data?.errcode && json.data.errcode !== 0) {
    throw new Error(`DingTalk registration/init error: ${json.data.errmsg || 'unknown'}`)
  }

  const nonce = json.data?.nonce || json.nonce
  if (!nonce) {
    throw new Error('DingTalk registration/init did not return nonce')
  }

  return { nonce }
}

/**
 * Step 2: Begin the registration flow – generates device_code and verification URL.
 * @param {string} nonce - The nonce from init()
 * @returns {Promise<{deviceCode: string, userCode: string, verificationUrl: string, verificationUri: string, interval: number, expiresIn: number}>}
 */
export async function begin(nonce) {
  if (!nonce) throw new Error('nonce is required for registration/begin')

  const res = await fetch(`${DINGTALK_API_BASE}/app/registration/begin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nonce }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`DingTalk registration/begin failed (${res.status}): ${text}`)
  }

  const json = await res.json()
  const data = json.data || json

  if (data.errcode && data.errcode !== 0) {
    throw new Error(`DingTalk registration/begin error: ${data.errmsg || 'unknown'}`)
  }

  if (!data.device_code || !data.verification_uri_complete) {
    throw new Error('DingTalk registration/begin did not return expected fields')
  }

  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUrl: data.verification_uri_complete,
    verificationUri: data.verification_uri,
    interval: data.interval || 2,
    expiresIn: data.expires_in || 7200
  }
}

/**
 * Step 3: Poll the registration status.
 * @param {string} deviceCode - The device_code from begin()
 * @returns {Promise<{status: string, clientId?: string, clientSecret?: string, errcode?: number, errmsg?: string}>}
 */
export async function poll(deviceCode) {
  if (!deviceCode) throw new Error('deviceCode is required for registration/poll')

  const res = await fetch(`${DINGTALK_API_BASE}/app/registration/poll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_code: deviceCode }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`DingTalk registration/poll failed (${res.status}): ${text}`)
  }

  const json = await res.json()
  const data = json.data || json

  // Handle pending/waiting states (user hasn't scanned yet)
  if (data.status && data.status !== 'SUCCESS') {
    return {
      status: data.status,
      errcode: data.errcode,
      errmsg: data.errmsg
    }
  }

  // Handle error codes that indicate still waiting
  if (data.errcode && data.errcode !== 0) {
    return {
      status: 'PENDING',
      errcode: data.errcode,
      errmsg: data.errmsg || 'authorization_pending'
    }
  }

  // Success – user authorized, credentials returned
  if (data.client_id && data.client_secret) {
    return {
      status: 'SUCCESS',
      clientId: data.client_id,
      clientSecret: data.client_secret
    }
  }

  // Fallback: treat as still pending
  return {
    status: data.status || 'PENDING',
    errcode: data.errcode,
    errmsg: data.errmsg
  }
}
