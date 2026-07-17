import { beforeEach, describe, expect, it, vi } from 'vitest'

const fsState = vi.hoisted(() => ({
  content: null
}))

vi.mock('fs', () => ({
  default: {
    readFileSync: vi.fn(() => {
      if (fsState.content === null) {
        const error = new Error('not found')
        error.code = 'ENOENT'
        throw error
      }
      return fsState.content
    })
  }
}))

describe('kubernetes api configuration', () => {
  let service

  beforeEach(async () => {
    delete process.env.SANDBOX_NAMESPACE
    delete process.env.OPENCLAW_SANDBOX_NAMESPACE
    fsState.content = null
    vi.resetModules()
    service = await import('../../server/services/kubernetes-api.js')
  })

  it('uses the current Kubernetes service account namespace when no env override exists', () => {
    fsState.content = 'agent-manager\n'

    expect(service.getSandboxNamespace()).toBe('agent-manager')
  })

  it('keeps env override support for local smoke tests', () => {
    process.env.SANDBOX_NAMESPACE = 'default'
    fsState.content = 'agent-manager\n'

    expect(service.getSandboxNamespace()).toBe('default')
  })
})
