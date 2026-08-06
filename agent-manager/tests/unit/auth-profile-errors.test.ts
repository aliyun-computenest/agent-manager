import { describe, expect, it } from 'vitest'
import { isProfileCreationDenied } from '../../src/lib/auth-profile-errors'

describe('auth profile error classification', () => {
  it('treats RLS failures as denied profile creation', () => {
    expect(isProfileCreationDenied({
      code: '42501',
      message: 'new row violates row-level security policy',
    })).toBe(true)
  })

  it('treats profile email unique conflicts as denied profile creation', () => {
    expect(isProfileCreationDenied({
      code: '23505',
      message: 'duplicate key value violates unique constraint "user_profiles_email_key"',
    })).toBe(true)
    expect(isProfileCreationDenied({
      code: '23505',
      message: 'duplicate key value violates unique constraint "idx_principal_profiles_user_email_unique"',
    })).toBe(true)
  })

  it('does not swallow unrelated unique conflicts', () => {
    expect(isProfileCreationDenied({
      code: '23505',
      message: 'duplicate key value violates unique constraint "agent_instances_name_key"',
    })).toBe(false)
  })
})
