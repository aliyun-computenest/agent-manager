/**
 * user-management: privilege-escalation guard on principal_profiles
 *
 * Locks down the path where a normal user could PATCH their own
 * principal_profiles row to set role='admin' (or other privileged columns) via
 * the Supabase PostgREST endpoint.
 *
 * Backed by the privileged-column trigger on principal_profiles and the
 * tightened RLS WITH CHECK clause.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { testEnv } from '../../setup/test-env.js'
import { testSupabaseAdmin } from '../../helpers/supabase.js'
import { createEphemeralUser } from '../../helpers/auth.js'

async function patchProfile({ token, profileId, body }) {
  const res = await fetch(
    `${testEnv.supabaseUrl}/rest/v1/principal_profiles?id=eq.${encodeURIComponent(profileId)}`,
    {
      method: 'PATCH',
      headers: {
        apikey: testEnv.anonKey,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(testEnv.requestTimeoutMs),
    },
  )
  let payload = null
  const text = await res.text()
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = text
    }
  }
  return { status: res.status, payload }
}

async function readProfile(profileId) {
  const { data, error } = await testSupabaseAdmin
    .from('principal_profiles')
    .select('id, username:name, email, role, status, max_agent_instances, is_first_login, consumer_id, consumer_apikey_encrypted, authorized_http_api_id')
    .eq('id', profileId)
    .single()
  if (error) throw new Error(`read profile ${profileId} failed: ${error.message}`)
  return data
}

describe('user-management: principal_profiles privilege escalation guard', () => {
  let normalUser
  let victimUser

  beforeAll(async () => {
    normalUser = await createEphemeralUser({ role: 'user', tag: 'rls-self' })
    victimUser = await createEphemeralUser({ role: 'user', tag: 'rls-other' })
  }, 60_000)

  afterAll(async () => {
    await Promise.allSettled([normalUser?.cleanup(), victimUser?.cleanup()])
  })

  describe('non-admin self-update — privileged columns must stay frozen', () => {
    const protectedAttempts = [
      { name: 'role=admin', body: { role: 'admin' }, column: 'role', expected: 'user' },
      { name: 'status=disabled', body: { status: 'disabled' }, column: 'status', expected: 'active' },
      { name: 'max_agent_instances=9999', body: { max_agent_instances: 9999 }, column: 'max_agent_instances', expected: 5 },
      { name: 'consumer_id=spoofed', body: { consumer_id: 'spoofed-consumer' }, column: 'consumer_id', expected: null },
      { name: 'consumer_apikey_encrypted=evil', body: { consumer_apikey_encrypted: 'evil' }, column: 'consumer_apikey_encrypted', expected: null },
      { name: 'authorized_http_api_id=evil', body: { authorized_http_api_id: 'evil' }, column: 'authorized_http_api_id', expected: null },
    ]

    for (const attempt of protectedAttempts) {
      it(`PATCH own profile ${attempt.name} → 4xx and column unchanged`, async () => {
        const { status, payload } = await patchProfile({
          token: normalUser.token,
          profileId: normalUser.userId,
          body: attempt.body,
        })
        expect(status, `payload=${JSON.stringify(payload)}`).toBeGreaterThanOrEqual(400)
        expect(status, `payload=${JSON.stringify(payload)}`).toBeLessThan(500)

        const fresh = await readProfile(normalUser.userId)
        expect(fresh[attempt.column]).toBe(attempt.expected)
      })
    }

    it('PATCH own email → 4xx and email unchanged', async () => {
      const { status } = await patchProfile({
        token: normalUser.token,
        profileId: normalUser.userId,
        body: { email: 'spoofed@test.local' },
      })
      expect(status).toBeGreaterThanOrEqual(400)
      expect(status).toBeLessThan(500)

      const fresh = await readProfile(normalUser.userId)
      expect(fresh.email).toBe(normalUser.email)
    })
  })

  describe('non-admin cross-row update — RLS must drop the write', () => {
    it("PATCH another user's row with own bearer → no row mutated", async () => {
      const beforeVictim = await readProfile(victimUser.userId)

      const { status, payload } = await patchProfile({
        token: normalUser.token,
        profileId: victimUser.userId,
        body: { name: 'pwned-by-attacker' },
      })

      // RLS may either return 200 with [] (USING filter dropped the row)
      // or a 4xx; both are acceptable as long as victim row is untouched.
      expect(status, `payload=${JSON.stringify(payload)}`).toBeLessThan(500)
      if (Array.isArray(payload)) {
        expect(payload.length).toBe(0)
      }

      const afterVictim = await readProfile(victimUser.userId)
      expect(afterVictim.username).toBe(beforeVictim.username)
      expect(afterVictim.role).toBe(beforeVictim.role)
      expect(afterVictim.status).toBe(beforeVictim.status)
    })
  })

  describe('non-admin self-update — non-privileged columns still work', () => {
    it('PATCH own name → 2xx and username alias updated', async () => {
      const newUsername = `${normalUser.username}-renamed`
      const { status, payload } = await patchProfile({
        token: normalUser.token,
        profileId: normalUser.userId,
        body: { name: newUsername },
      })
      expect(status, `payload=${JSON.stringify(payload)}`).toBeLessThan(300)

      const fresh = await readProfile(normalUser.userId)
      expect(fresh.username).toBe(newUsername)
    })

    it('PATCH own is_first_login → 2xx and value updated', async () => {
      const { status } = await patchProfile({
        token: normalUser.token,
        profileId: normalUser.userId,
        body: { is_first_login: true },
      })
      expect(status).toBeLessThan(300)

      const fresh = await readProfile(normalUser.userId)
      expect(fresh.is_first_login).toBe(true)
    })
  })

  describe('admin / service-role still have full edit power', () => {
    it('service-role can change protected columns on any profile', async () => {
      const { error: setRoleErr } = await testSupabaseAdmin
        .from('principal_profiles')
        .update({ role: 'admin' })
        .eq('id', normalUser.userId)
      expect(setRoleErr).toBeNull()

      const promoted = await readProfile(normalUser.userId)
      expect(promoted.role).toBe('admin')

      // Restore so other tests / cleanup behave deterministically.
      const { error: restoreErr } = await testSupabaseAdmin
        .from('principal_profiles')
        .update({ role: 'user', max_agent_instances: 5, status: 'active' })
        .eq('id', normalUser.userId)
      expect(restoreErr).toBeNull()
    })
  })
})
