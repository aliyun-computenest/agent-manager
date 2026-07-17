export function isProfileCreationDenied(error: unknown) {
  const maybeError = error as { code?: string; message?: string } | null
  const message = maybeError?.message?.toLowerCase() || ''
  const isProfileEmailConflict = maybeError?.code === '23505' && (
    message.includes('user_profiles_email_key') ||
    message.includes('principal_profiles_email_key') ||
    message.includes('idx_principal_profiles_user_email_unique')
  )

  return maybeError?.code === '42501' ||
    isProfileEmailConflict ||
    message.includes('row-level security') ||
    message.includes('permission denied')
}
