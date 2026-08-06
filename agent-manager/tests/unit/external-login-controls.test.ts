import { describe, expect, it } from 'vitest'
import { getNextLoginTab, getVisibleLoginTab, shouldLoadOAuthProviders } from '../../src/components/Auth/ExternalLoginControls'

describe('ExternalLoginControls tab selection', () => {
  it('外部登录启用且用户未手动切换时默认显示 SSO 登录', () => {
    expect(getNextLoginTab({
      loginProvidersLoaded: true,
      hasExternalLogin: true,
      forcePassword: false,
      loginTabTouched: false,
    })).toBe('sso')
  })

  it('没有外部登录或强制密码登录时显示账号密码登录', () => {
    expect(getNextLoginTab({
      loginProvidersLoaded: true,
      hasExternalLogin: false,
      forcePassword: false,
      loginTabTouched: false,
    })).toBe('password')

    expect(getNextLoginTab({
      loginProvidersLoaded: true,
      hasExternalLogin: true,
      forcePassword: true,
      loginTabTouched: false,
    })).toBe('password')
  })

  it('用户手动切换过 tab 后不覆盖当前选择', () => {
    expect(getNextLoginTab({
      loginProvidersLoaded: true,
      hasExternalLogin: true,
      forcePassword: false,
      loginTabTouched: true,
    })).toBeNull()
  })

  it('未启用外部登录时 visible tab 始终是账号密码登录', () => {
    expect(getVisibleLoginTab({
      hasExternalLogin: false,
      activeLoginTab: 'sso',
    })).toBe('password')
  })

  it('只有 OAuth 模式会读取 Supabase OAuth provider settings', () => {
    expect(shouldLoadOAuthProviders('oauth')).toBe(true)
    expect(shouldLoadOAuthProviders('none')).toBe(false)
    expect(shouldLoadOAuthProviders('saml')).toBe(false)
  })
})
