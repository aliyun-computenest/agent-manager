import { describe, expect, it } from 'vitest'
import { getLoginRouteError, hasSignupDisabledError } from '../../src/lib/login-route-error'

describe('getLoginRouteError', () => {
  it('识别 /login?error=unauthorized 无权限登录场景', () => {
    expect(getLoginRouteError({
      pathname: '/login',
      search: '?error=unauthorized',
    })).toBe('unauthorized')
  })

  it('忽略其它登录错误参数', () => {
    expect(getLoginRouteError({
      pathname: '/login',
      search: '?error=server_error',
    })).toBeNull()
  })

  it('将 Supabase 禁止注册的 OAuth 回调识别为无权限登录', () => {
    expect(getLoginRouteError({
      pathname: '/login',
      search: '?error=access_denied&error_code=signup_disabled&error_description=Signups+not+allowed+for+this+instance',
    })).toBe('unauthorized')
  })

  it('支持 Supabase 将禁止注册错误放在 hash 中的 OAuth 回调', () => {
    expect(getLoginRouteError({
      pathname: '/login',
      search: '',
      hash: '#error=access_denied&error_code=signup_disabled&sb=',
    })).toBe('unauthorized')
  })

  it('只在登录页识别 unauthorized 参数', () => {
    expect(getLoginRouteError({
      pathname: '/admin/login',
      search: '?error=unauthorized',
    })).toBeNull()
  })

  it('识别任意路由上的 Supabase signup_disabled 错误', () => {
    expect(hasSignupDisabledError({
      search: '?error=access_denied&error_code=signup_disabled',
    })).toBe(true)
    expect(hasSignupDisabledError({
      search: '',
      hash: '#error=access_denied&error_code=signup_disabled&sb=',
    })).toBe(true)
    expect(hasSignupDisabledError({
      search: '?error=server_error',
    })).toBe(false)
  })
})
