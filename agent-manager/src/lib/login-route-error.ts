export type LoginRouteError = 'unauthorized' | null

interface LoginRouteLocation {
  pathname: string
  search: string
  hash?: string
}

function routeParams(search: string, hash = '') {
  return [
    new URLSearchParams(search),
    new URLSearchParams(hash.replace(/^#/, '')),
  ]
}

export function hasSignupDisabledError({ search, hash = '' }: Pick<LoginRouteLocation, 'search' | 'hash'>) {
  return routeParams(search, hash).some(params => params.get('error_code') === 'signup_disabled')
}

function hasUnauthorizedLoginError(params: URLSearchParams) {
  return params.get('error') === 'unauthorized'
}

export function getLoginRouteError({ pathname, search, hash = '' }: LoginRouteLocation): LoginRouteError {
  if (pathname !== '/login') return null

  const params = routeParams(search, hash)
  if (params.some(hasUnauthorizedLoginError) || hasSignupDisabledError({ search, hash })) {
    return 'unauthorized'
  }

  return null
}
