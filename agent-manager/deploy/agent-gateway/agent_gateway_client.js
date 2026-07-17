(function () {
  var gatewayPrefix = ''

  function normalizeGatewayPrefix(value) {
    var prefix = typeof value === 'string' ? value.trim() : ''
    if (!/^\/[A-Za-z0-9_-]+\/?$/.test(prefix)) return ''
    return prefix.replace(/\/$/, '')
  }

  gatewayPrefix = normalizeGatewayPrefix(window.__agent_gateway_prefix)
  if (!gatewayPrefix) {
    var prefixMatch = window.location.pathname.match(/^\/[A-Za-z0-9_-]+(?:\/|$)/)
    gatewayPrefix = normalizeGatewayPrefix(prefixMatch ? prefixMatch[0] : '')
  }

  function getGatewayInstanceId() {
    return gatewayPrefix ? gatewayPrefix.slice(1) : ''
  }

  function getGatewayTokenCookieName() {
    var instanceId = getGatewayInstanceId()
    return instanceId ? '__agent_gateway_upstream_token_' + instanceId : ''
  }

  function readCookie(name) {
    if (!name || typeof document.cookie !== 'string') return ''
    var parts = document.cookie.split(';')
    for (var i = 0; i < parts.length; i += 1) {
      var part = parts[i].trim()
      if (part.indexOf(name + '=') === 0) {
        try {
          return decodeURIComponent(part.slice(name.length + 1))
        } catch (error) {
          return ''
        }
      }
    }
    return ''
  }

  function clearGatewayTokenCookie(name) {
    if (!name || !gatewayPrefix) return
    document.cookie = name + '=; Path=' + gatewayPrefix + '/; Max-Age=0; SameSite=Lax'
  }

  function readGatewayToken() {
    var tokenParam = readCookie(getGatewayTokenCookieName())
    if (!tokenParam) return ''
    if (tokenParam.charAt(0) === '?' || tokenParam.charAt(0) === '&') {
      tokenParam = tokenParam.slice(1)
    }
    try {
      return new URLSearchParams(tokenParam).get('token') || ''
    } catch (error) {
      return ''
    }
  }

  function setOpenClawControlToken(key, token) {
    try {
      window.localStorage.setItem(key, token)
    } catch (error) {}
    try {
      window.sessionStorage.setItem(key, token)
    } catch (error) {}
  }

  function installOpenClawControlToken() {
    if (!gatewayPrefix) return
    var tokenCookieName = getGatewayTokenCookieName()
    var token = readGatewayToken()
    clearGatewayTokenCookie(tokenCookieName)
    if (!token) return

    try {
      var protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      var gatewayUrl = protocol + '//' + window.location.host + gatewayPrefix
      setOpenClawControlToken('openclaw.control.token.v1:' + gatewayUrl, token)
      setOpenClawControlToken('openclaw.control.token.v1:' + gatewayUrl + '/', token)
    } catch (error) {}
  }

  installOpenClawControlToken()

  function getStorageNamespacePrefix() {
    var instanceId = getGatewayInstanceId()
    return instanceId ? '__agent_gateway_storage__:' + instanceId + ':' : ''
  }

  function shouldBypassStorageNamespace(key) {
    return key.indexOf('openclaw.control.token.v1:') === 0 ||
      key.indexOf('__agent_gateway_') === 0
  }

  function namespaceStorageKey(prefix, key) {
    key = String(key)
    if (!prefix || shouldBypassStorageNamespace(key) || key.indexOf(prefix) === 0) {
      return key
    }
    return prefix + key
  }

  function stripStorageNamespace(prefix, key) {
    return prefix && key.indexOf(prefix) === 0 ? key.slice(prefix.length) : key
  }

  function patchWebStorageNamespace() {
    var prefix = getStorageNamespacePrefix()
    if (!gatewayPrefix || !prefix || !window.Storage || !window.Storage.prototype) return
    var proto = window.Storage.prototype
    if (proto.__agentGatewayStorageNamespacePatched) return

    var nativeGetItem = proto.getItem
    var nativeSetItem = proto.setItem
    var nativeRemoveItem = proto.removeItem
    var nativeKey = proto.key
    var nativeClear = proto.clear
    if (!nativeGetItem || !nativeSetItem || !nativeRemoveItem || !nativeKey || !nativeClear) return

    try {
      Object.defineProperty(proto, '__agentGatewayStorageNamespacePatched', {
        configurable: true,
        value: true
      })
    } catch (error) {
      proto.__agentGatewayStorageNamespacePatched = true
    }

    proto.getItem = function (key) {
      return nativeGetItem.call(this, namespaceStorageKey(prefix, key))
    }
    proto.setItem = function (key, value) {
      return nativeSetItem.call(this, namespaceStorageKey(prefix, key), value)
    }
    proto.removeItem = function (key) {
      return nativeRemoveItem.call(this, namespaceStorageKey(prefix, key))
    }
    proto.key = function (index) {
      var targetIndex = Number(index)
      if (!Number.isFinite(targetIndex) || Math.floor(targetIndex) !== targetIndex || targetIndex < 0) return null
      var matchedIndex = 0
      for (var i = 0; i < this.length; i += 1) {
        var key = nativeKey.call(this, i)
        if (typeof key === 'string' && key.indexOf(prefix) === 0) {
          if (matchedIndex === targetIndex) return stripStorageNamespace(prefix, key)
          matchedIndex += 1
        }
      }
      return null
    }
    proto.clear = function () {
      var keys = []
      for (var i = 0; i < this.length; i += 1) {
        var key = nativeKey.call(this, i)
        if (typeof key === 'string' && key.indexOf(prefix) === 0) {
          keys.push(key)
        }
      }
      keys.forEach(function (key) {
        nativeRemoveItem.call(this, key)
      }, this)
    }
  }

  function patchIndexedDBNamespace() {
    var prefix = getStorageNamespacePrefix()
    if (!gatewayPrefix || !prefix || !window.indexedDB) return
    if (window.indexedDB.__agentGatewayStorageNamespacePatched) return

    var nativeOpen = window.indexedDB.open
    var nativeDeleteDatabase = window.indexedDB.deleteDatabase
    if (!nativeOpen || !nativeDeleteDatabase) return

    try {
      Object.defineProperty(window.indexedDB, '__agentGatewayStorageNamespacePatched', {
        configurable: true,
        value: true
      })
    } catch (error) {
      window.indexedDB.__agentGatewayStorageNamespacePatched = true
    }

    window.indexedDB.open = function (name, version) {
      var dbName = namespaceStorageKey(prefix, name)
      return arguments.length > 1 ? nativeOpen.call(this, dbName, version) : nativeOpen.call(this, dbName)
    }
    window.indexedDB.deleteDatabase = function (name) {
      return nativeDeleteDatabase.call(this, namespaceStorageKey(prefix, name))
    }
    if (window.indexedDB.databases) {
      var nativeDatabases = window.indexedDB.databases
      window.indexedDB.databases = function () {
        return nativeDatabases.call(this).then(function (databases) {
          return databases
            .filter(function (database) {
              return database && typeof database.name === 'string' && database.name.indexOf(prefix) === 0
            })
            .map(function (database) {
              return Object.assign({}, database, { name: stripStorageNamespace(prefix, database.name) })
            })
        })
      }
    }
  }

  patchWebStorageNamespace()
  patchIndexedDBNamespace()

  function isReservedGatewayPath(pathname) {
    return pathname.indexOf('/__agent_gateway_') === 0
  }

  function isSameGatewayOrigin(url) {
    if (!url) return false
    if (url.origin === window.location.origin) return true
    if (url.host !== window.location.host) return false
    return (url.protocol === 'ws:' && window.location.protocol === 'http:') ||
      (url.protocol === 'wss:' && window.location.protocol === 'https:')
  }

  function stripGatewayPrefix(pathname) {
    if (!gatewayPrefix) return pathname
    if (pathname === gatewayPrefix) return '/'
    if (pathname.indexOf(gatewayPrefix + '/') === 0) {
      return pathname.slice(gatewayPrefix.length) || '/'
    }
    return pathname
  }

  function ensureGatewayPrefix(url) {
    if (!gatewayPrefix || !isSameGatewayOrigin(url) || isReservedGatewayPath(url.pathname)) {
      return url
    }
    if (url.pathname === gatewayPrefix || url.pathname.indexOf(gatewayPrefix + '/') === 0) {
      return url
    }
    url.pathname = gatewayPrefix + url.pathname
    return url
  }

  function serializeUrl(url) {
    return url.pathname + url.search + url.hash
  }

  function toUrl(value) {
    try {
      return new URL(String(value), window.location.href)
    } catch (error) {
      return null
    }
  }

  function prefixSameOriginUrl(value) {
    if (value === undefined || value === null || value === '') return value
    var url = toUrl(value)
    if (!url) return value
    if (url.origin !== window.location.origin) return value
    ensureGatewayPrefix(url)
    return serializeUrl(url)
  }

  function maskedLocationFor(url) {
    if (!gatewayPrefix || !url || !isSameGatewayOrigin(url) || isReservedGatewayPath(url.pathname)) {
      return null
    }
    if (url.pathname !== gatewayPrefix && url.pathname.indexOf(gatewayPrefix + '/') !== 0) {
      return null
    }
    return {
      pathname: stripGatewayPrefix(url.pathname),
      search: url.search,
      hash: url.hash
    }
  }

  function withMaskedState(state, value) {
    var url = toUrl(value || window.location.href)
    var masked = maskedLocationFor(url)
    if (!masked) return state
    var nextState = state && typeof state === 'object' && !Array.isArray(state)
      ? Object.assign({}, state)
      : {}
    nextState.masked = masked
    return nextState
  }

  function applyCurrentMaskedState(nativeReplaceState) {
    try {
      var maskedState = withMaskedState(window.history.state, window.location.href)
      if (maskedState !== window.history.state) {
        nativeReplaceState.call(window.history, maskedState, '', serializeUrl(window.location))
      }
    } catch (error) {}
  }

  function prefixGatewayUrl(input) {
    var url = new URL(String(input), window.location.href)
    ensureGatewayPrefix(url)
    return url.toString()
  }

  if (gatewayPrefix && window.history) {
    var nativePushState = window.history.pushState
    var nativeReplaceState = window.history.replaceState
    window.history.pushState = function (state, title, url) {
      if (arguments.length > 2) {
        arguments[2] = prefixSameOriginUrl(url)
        arguments[0] = withMaskedState(state, arguments[2])
      } else {
        arguments[0] = withMaskedState(state, window.location.href)
      }
      return nativePushState.apply(this, arguments)
    }
    window.history.replaceState = function (state, title, url) {
      if (arguments.length > 2) {
        arguments[2] = prefixSameOriginUrl(url)
        arguments[0] = withMaskedState(state, arguments[2])
      } else {
        arguments[0] = withMaskedState(state, window.location.href)
      }
      return nativeReplaceState.apply(this, arguments)
    }
    applyCurrentMaskedState(nativeReplaceState)
  }

  function prefixElementUrl(value, absolute) {
    if (value === undefined || value === null || value === '') return value
    var url = toUrl(value)
    if (!url || !isSameGatewayOrigin(url)) return value
    ensureGatewayPrefix(url)
    return absolute ? url.href : serializeUrl(url)
  }

  function patchUrlProperty(proto, property) {
    if (!proto) return
    var descriptor = Object.getOwnPropertyDescriptor(proto, property)
    if (!descriptor || !descriptor.set || !descriptor.get) return
    try {
      Object.defineProperty(proto, property, {
        configurable: true,
        enumerable: descriptor.enumerable,
        get: function () {
          return descriptor.get.call(this)
        },
        set: function (value) {
          return descriptor.set.call(this, prefixElementUrl(value, true))
        }
      })
    } catch (error) {}
  }

  function patchElementAttributes(element) {
    if (!element || element.nodeType !== 1) return
    var tag = element.tagName
    if (tag === 'A' || tag === 'LINK') {
      var href = element.getAttribute('href')
      if (href) element.setAttribute('href', prefixElementUrl(href, false))
    }
    if (tag === 'SCRIPT' || tag === 'IMG' || tag === 'IFRAME') {
      var src = element.getAttribute('src')
      if (src) element.setAttribute('src', prefixElementUrl(src, false))
    }
    if (tag === 'FORM') {
      var action = element.getAttribute('action')
      if (action) element.setAttribute('action', prefixElementUrl(action, false))
    }
  }

  if (gatewayPrefix && window.Element) {
    var nativeSetAttribute = window.Element.prototype.setAttribute
    window.Element.prototype.setAttribute = function (name, value) {
      var normalized = String(name || '').toLowerCase()
      if (normalized === 'href' || normalized === 'src' || normalized === 'action') {
        value = prefixElementUrl(value, false)
      }
      return nativeSetAttribute.call(this, name, value)
    }
    patchUrlProperty(window.HTMLAnchorElement && window.HTMLAnchorElement.prototype, 'href')
    patchUrlProperty(window.HTMLLinkElement && window.HTMLLinkElement.prototype, 'href')
    patchUrlProperty(window.HTMLScriptElement && window.HTMLScriptElement.prototype, 'src')
    patchUrlProperty(window.HTMLImageElement && window.HTMLImageElement.prototype, 'src')
    patchUrlProperty(window.HTMLIFrameElement && window.HTMLIFrameElement.prototype, 'src')
    patchUrlProperty(window.HTMLFormElement && window.HTMLFormElement.prototype, 'action')

    document.addEventListener('click', function (event) {
      var element = event.target && event.target.closest ? event.target.closest('a[href]') : null
      patchElementAttributes(element)
    }, true)

    if (window.MutationObserver) {
      var observer = new MutationObserver(function (mutations) {
        mutations.forEach(function (mutation) {
          mutation.addedNodes && mutation.addedNodes.forEach(function (node) {
            patchElementAttributes(node)
            if (node && node.querySelectorAll) {
              node.querySelectorAll('a[href],link[href],script[src],img[src],iframe[src],form[action]').forEach(patchElementAttributes)
            }
          })
        })
      })
      observer.observe(document.documentElement, { childList: true, subtree: true })
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      document.querySelectorAll('a[href],link[href],script[src],img[src],iframe[src],form[action]').forEach(patchElementAttributes)
    })
  } else {
    document.querySelectorAll('a[href],link[href],script[src],img[src],iframe[src],form[action]').forEach(patchElementAttributes)
  }

  var nativeFetch = window.fetch
  if (nativeFetch) {
    window.fetch = function (input, init) {
      if (input instanceof Request) {
        input = new Request(prefixGatewayUrl(input.url), input)
      } else {
        input = prefixGatewayUrl(input)
      }
      return nativeFetch.call(this, input, init)
    }
  }

  var nativeOpen = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function (method, url) {
    arguments[1] = prefixGatewayUrl(url)
    return nativeOpen.apply(this, arguments)
  }

  var NativeWebSocket = window.WebSocket
  if (NativeWebSocket) {
    var GatewayWebSocket = class extends NativeWebSocket {
      constructor(url, protocols) {
        if (protocols === undefined) {
          super(prefixGatewayUrl(url))
        } else {
          super(prefixGatewayUrl(url), protocols)
        }
      }
    }
    ;['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (key) {
      GatewayWebSocket[key] = NativeWebSocket[key]
    })
    window.WebSocket = GatewayWebSocket
  }

  var NativeEventSource = window.EventSource
  if (NativeEventSource) {
    var GatewayEventSource = class extends NativeEventSource {
      constructor(url, eventSourceInitDict) {
        super(prefixGatewayUrl(url), eventSourceInitDict)
      }
    }
    ;['CONNECTING', 'OPEN', 'CLOSED'].forEach(function (key) {
      GatewayEventSource[key] = NativeEventSource[key]
    })
    window.EventSource = GatewayEventSource
  }

  if (window.navigator && window.navigator.sendBeacon) {
    var nativeSendBeacon = window.navigator.sendBeacon
    window.navigator.sendBeacon = function (url, data) {
      return nativeSendBeacon.call(this, prefixGatewayUrl(url), data)
    }
  }
})()
