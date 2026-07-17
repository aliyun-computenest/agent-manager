interface ResolveOAuthProfileEmailInput {
  provider: string
  authEmail?: string | null
  metadata?: Record<string, any> | null
}

const OAUTH_PLACEHOLDER_EMAIL_SUFFIXES = ['@feishu.user', '@dingtalk.user']

export function isOAuthPlaceholderEmail(email?: string | null) {
  if (!email) return false
  const normalized = email.toLowerCase()
  return OAUTH_PLACEHOLDER_EMAIL_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
}

function normalizeEmailCandidate(value: unknown) {
  if (typeof value !== 'string') return undefined
  const email = value.trim()
  const atIndex = email.indexOf('@')
  const hasSingleAt = atIndex > 0 && atIndex === email.lastIndexOf('@') && atIndex < email.length - 1
  const hasWhitespace = /\s/.test(email)

  if (!hasSingleAt || hasWhitespace || isOAuthPlaceholderEmail(email)) {
    return undefined
  }

  return email
}

function getMetadataEmail(metadata: Record<string, any>) {
  const customClaims = metadata.custom_claims || {}
  return normalizeEmailCandidate(metadata.enterprise_email) ||
    normalizeEmailCandidate(customClaims.enterprise_email) ||
    normalizeEmailCandidate(metadata.email) ||
    normalizeEmailCandidate(customClaims.email)
}

export function shouldUseProviderMetadataEmail(provider: string) {
  return provider === 'feishu' || provider === 'dingtalk'
}

export function resolveOAuthProfileEmail({
  provider,
  authEmail,
  metadata,
}: ResolveOAuthProfileEmailInput) {
  if (metadata && shouldUseProviderMetadataEmail(provider)) {
    return getMetadataEmail(metadata) || authEmail
  }

  return authEmail
}
