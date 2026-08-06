import { describe, expect, it, vi } from 'vitest'

vi.mock('../../server/services/gateway-config.js', () => ({
  getAccountIdWithCredentials: vi.fn(),
}))

vi.mock('../../server/utils/logger.js', () => ({
  appLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import {
  isInternationalAccountId,
  resolveComputeNestEndpointRegion,
} from '../../server/services/computenest.js'

describe('ComputeNest site detection', () => {
  it.each([
    ['5123456789012345', true],
    ['51234567890123456', true],
    ['4123456789012345', false],
    ['512345678901234', false],
    ['', false],
  ])('classifies AccountId %s as international=%s', (accountId, expected) => {
    expect(isInternationalAccountId(accountId)).toBe(expected)
  })

  it('uses STS AccountId to select the international endpoint', async () => {
    const getAccountId = vi.fn(async () => '5123456789012345')
    await expect(resolveComputeNestEndpointRegion({
      accessKeyId: 'test-ak',
      accessKeySecret: 'test-secret',
      getAccountId,
    })).resolves.toBe('ap-southeast-1')
    expect(getAccountId).toHaveBeenCalledWith('test-ak', 'test-secret')
  })

  it('uses the domestic endpoint for other AccountIds', async () => {
    await expect(resolveComputeNestEndpointRegion({
      getAccountId: vi.fn(async () => '1234567890123456'),
    })).resolves.toBe('cn-hangzhou')
  })
})
