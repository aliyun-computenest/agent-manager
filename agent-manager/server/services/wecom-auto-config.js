/**
 * WeCom (企业微信) Auto-Config Service
 *
 * Implements the WeCom QR Code Bot Registration Flow (reverse-engineered from
 * @wecom/wecom-openclaw-cli v1.1.0 dist/utils/qrcode.js):
 *
 *   1. generate()     – GET  /ai/qc/generate?source=openclaw-manager&plat=3
 *                        → { data: { scode, auth_url } }
 *   2. queryResult()  – GET  /ai/qc/query_result?scode=xxx
 *                        → { data: { status: "success", bot_info: { botid, secret } } }
 *
 * This enables scan-to-configure: users scan a QR code with WeCom app,
 * authorize bot creation, and the platform automatically receives channel credentials.
 *
 * Variable mapping:
 *   bot_info.botid  → clientId  (CHANNEL_CLIENT_ID)
 *   bot_info.secret → clientSecret (CHANNEL_CLIENT_SECRET)
 *
 * Note: The correct base domain is https://work.weixin.qq.com (NOT open., qyapi., or developer.)
 */

const WECOM_API_BASE = process.env.WECOM_API_BASE || 'https://work.weixin.qq.com'
const SOURCE = 'openclaw-manager'
// Platform code: 1=darwin, 2=win32, 3=linux, 0=other (server-side is typically linux)
const PLAT_CODE = 3

// Hard timeout for every outbound call to prevent the Express worker from
// hanging when WeCom's edge keeps the socket open without responding.
const REQUEST_TIMEOUT_MS = Number(process.env.WECOM_API_TIMEOUT_MS) || 10000

/**
 * Step 1: Generate the QR code authorization URL.
 * Calls WeCom GET /ai/qc/generate to get auth_url and a session identifier (scode).
 * @returns {Promise<{authUrl: string, qcId: string, expiresIn: number}>}
 */
export async function generate() {
  const url = `${WECOM_API_BASE}/ai/qc/generate?source=${SOURCE}&plat=${PLAT_CODE}`

  const res = await fetch(url, {
    method: 'GET',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`WeCom qc/generate failed (${res.status}): ${text}`)
  }

  const resp = await res.json()

  if (!resp?.data?.scode || !resp?.data?.auth_url) {
    throw new Error('WeCom qc/generate did not return expected fields (data.scode, data.auth_url): ' + JSON.stringify(resp))
  }

  return {
    authUrl: resp.data.auth_url,
    qcId: resp.data.scode, // externally named qcId for API consistency
    expiresIn: 300 // 5 minutes, matching CLI POLL_TIMEOUT
  }
}

/**
 * Step 2: Query the authorization result.
 * Polls WeCom GET /ai/qc/query_result?scode=xxx until user scans and authorizes.
 * @param {string} qcId - The scode from generate() (named qcId for API consistency)
 * @returns {Promise<{status: string, clientId?: string, clientSecret?: string, errmsg?: string}>}
 */
export async function queryResult(qcId) {
  if (!qcId) throw new Error('qcId (scode) is required for qc/query_result')

  const url = `${WECOM_API_BASE}/ai/qc/query_result?scode=${encodeURIComponent(qcId)}`

  const res = await fetch(url, {
    method: 'GET',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`WeCom qc/query_result failed (${res.status}): ${text}`)
  }

  const resp = await res.json()

  // Success – status is "success" and bot_info contains credentials
  if (resp?.data?.status === 'success') {
    const botInfo = resp.data.bot_info
    if (botInfo?.botid && botInfo?.secret) {
      return {
        status: 'SUCCESS',
        clientId: botInfo.botid,
        clientSecret: botInfo.secret
      }
    }
    // status=success but missing bot_info fields
    return {
      status: 'ERROR',
      errmsg: '扫码成功但未获取到 Bot 信息'
    }
  }

  // Explicit expired/timeout status
  if (resp?.data?.status === 'expired' || resp?.data?.status === 'timeout') {
    return {
      status: 'EXPIRED',
      errmsg: '二维码已过期'
    }
  }

  // Any other status (including undefined) – treat as pending (user hasn't scanned yet)
  return {
    status: 'PENDING',
    errmsg: 'authorization_pending'
  }
}
