/**
 * The JavaScript shim injected into an extension's isolated world (content scripts)
 * or main world (extension pages and the hidden background page). It is a string so
 * the same source can be evaluated in any world without bundling a second runtime.
 *
 * The only bridge to the main process is `window.__nccExtensionBridge`, which the
 * preload exposes through contextBridge. Page JavaScript cannot see it.
 */

export const EXTENSION_SHIM = String.raw`
(function () {
  var bridge = window.__nccExtensionBridge
  if (!bridge) return
  delete window.__nccExtensionBridge

  var listeners = Object.create(null)

  function addListener(kind, fn) {
    if (typeof fn !== 'function') return
    var list = listeners[kind] || (listeners[kind] = [])
    if (list.indexOf(fn) === -1) list.push(fn)
  }

  function removeListener(kind, fn) {
    var list = listeners[kind]
    if (!list) return
    var index = list.indexOf(fn)
    if (index >= 0) list.splice(index, 1)
  }

  function emit(kind, args) {
    var list = (listeners[kind] || []).slice()
    for (var index = 0; index < list.length; index += 1) {
      try {
        list[index].apply(null, args)
      } catch (error) {
        setTimeout(function () { throw error }, 0)
      }
    }
  }

  var runtime = {
    id: bridge.id,
    lastError: null,
    getURL: function (path) { return bridge.getURL(path) },
    getManifest: function () { return bridge.manifest },
    getPlatformInfo: function (callback) {
      var info = { os: 'linux', arch: 'x86-64', nacl_arch: 'x86-64' }
      if (typeof callback === 'function') { callback(info); return }
      return Promise.resolve(info)
    },
    closePanel: function () { return bridge.invoke('ncc.panel.close', []) },
    setPanelWidth: function (width) { return bridge.invoke('ncc.panel.resize', [width]) },
    sendMessage: function (message, callback) {
      return finish(bridge.invoke('runtime.sendMessage', [message]), callback)
    },
    connect: function () {
      throw new Error('runtime.connect ports are not supported yet')
    },
    onMessage: {
      addListener: function (fn) { addListener('runtime.message', fn) },
      removeListener: function (fn) { removeListener('runtime.message', fn) },
      hasListener: function (fn) { return (listeners['runtime.message'] || []).indexOf(fn) >= 0 }
    },
    onInstalled: {
      addListener: function (fn) { addListener('runtime.installed', fn) },
      removeListener: function (fn) { removeListener('runtime.installed', fn) }
    },
    onStartup: {
      addListener: function (fn) { addListener('runtime.startup', fn) },
      removeListener: function (fn) { removeListener('runtime.startup', fn) }
    }
  }

  function finish(promise, callback, fallback) {
    if (typeof callback !== 'function') return promise
    promise.then(
      function (value) { callback(value) },
      function (error) {
        runtime.lastError = { message: error && error.message ? error.message : String(error) }
        callback(fallback)
        setTimeout(function () { runtime.lastError = null }, 0)
      }
    )
  }

  function storageArea(area) {
    return {
      get: function (keys, callback) {
        return finish(bridge.invoke('storage.get', [area, keys]), callback, {})
      },
      set: function (items, callback) {
        return finish(bridge.invoke('storage.set', [area, items]), callback)
      },
      remove: function (keys, callback) {
        return finish(bridge.invoke('storage.remove', [area, keys]), callback)
      },
      clear: function (callback) {
        return finish(bridge.invoke('storage.clear', [area]), callback)
      }
    }
  }

  var storage = {
    local: storageArea('local'),
    sync: storageArea('sync'),
    session: storageArea('session'),
    onChanged: {
      addListener: function (fn) { addListener('storage.changed', fn) },
      removeListener: function (fn) { removeListener('storage.changed', fn) }
    }
  }

  var tabs = {
    query: function (query, callback) {
      return finish(bridge.invoke('tabs.query', [query || {}]), callback, [])
    },
    get: function (tabId, callback) {
      return finish(bridge.invoke('tabs.get', [tabId]), callback)
    },
    create: function (props, callback) {
      return finish(bridge.invoke('tabs.create', [props || {}]), callback)
    },
    sendMessage: function (tabId, message, callback) {
      return finish(bridge.invoke('tabs.sendMessage', [tabId, message]), callback)
    },
    reload: function (tabId, callback) {
      return finish(bridge.invoke('tabs.reload', [tabId]), callback)
    },
    update: function (tabId, props, callback) {
      return finish(bridge.invoke('tabs.update', [tabId, props || {}]), callback)
    },
    remove: function (tabId, callback) {
      return finish(bridge.invoke('tabs.remove', [tabId]), callback)
    }
  }

  var scripting = {
    executeScript: function (injection, callback) {
      return finish(bridge.invoke('scripting.executeScript', [injection || {}]), callback, [])
    }
  }

  var action = {
    onClicked: {
      addListener: function (fn) { addListener('action.clicked', fn) },
      removeListener: function (fn) { removeListener('action.clicked', fn) }
    }
  }

  var contextMenus = {
    onClicked: {
      addListener: function (fn) { addListener('contextMenus.clicked', fn) },
      removeListener: function (fn) { removeListener('contextMenus.clicked', fn) }
    },
    create: function (props, callback) {
      return finish(bridge.invoke('contextMenus.create', [props || {}]), callback)
    },
    remove: function (id, callback) {
      return finish(bridge.invoke('contextMenus.remove', [id]), callback)
    },
    removeAll: function (callback) {
      return finish(bridge.invoke('contextMenus.removeAll', []), callback)
    }
  }

  var notifications = {
    create: function (id, options, callback) {
      if (id && typeof id === 'object') {
        callback = options
        options = id
        id = ''
      }
      return finish(bridge.invoke('notifications.create', [id || '', options || {}]), callback, '')
    }
  }

  var i18n = {
    getMessage: function (key, substitutions) {
      var messages = bridge.i18n || {}
      var value = messages[key]
      if (typeof value !== 'string') return ''
      if (!substitutions) return value
      var list = Array.isArray(substitutions) ? substitutions : [substitutions]
      return value.replace(/\$([1-9])/g, function (_, index) {
        return list[Number(index) - 1] == null ? '' : String(list[Number(index) - 1])
      })
    }
  }

  var chrome = {
    runtime: runtime,
    storage: storage,
    tabs: tabs,
    scripting: scripting,
    action: action,
    contextMenus: contextMenus,
    notifications: notifications,
    i18n: i18n,
    extension: {
      getURL: runtime.getURL,
      getBackgroundPage: function () { return null },
      lastError: null
    }
  }

  var nostr = {
    getPublicKey: function () { return bridge.invoke('nostr.getPublicKey', []) },
    getProfile: function (pubkey, relays) { return bridge.invoke('nostr.getProfile', [pubkey, relays]) },
    signEvent: function (event) { return bridge.invoke('nostr.signEvent', [event]) },
    getRelays: function () { return bridge.invoke('nostr.getRelays', []) },
    requestEvents: function (relays, filters) { return bridge.invoke('nostr.requestEvents', [relays, filters]) },
    publishEvent: function (relays, event) { return bridge.invoke('nostr.publishEvent', [relays, event]) },
    nip04: {
      encrypt: function (peer, plaintext) {
        return bridge.invoke('nostr.nip04Encrypt', [peer, plaintext])
      },
      decrypt: function (peer, ciphertext) {
        return bridge.invoke('nostr.nip04Decrypt', [peer, ciphertext])
      }
    },
    nip44: {
      encrypt: function (peer, plaintext) {
        return bridge.invoke('nostr.nip44Encrypt', [peer, plaintext])
      },
      decrypt: function (peer, ciphertext) {
        return bridge.invoke('nostr.nip44Decrypt', [peer, ciphertext])
      }
    }
  }

  var blossom = {
    groupImageRequest: function (request) { return bridge.invoke('blossom.groupImageRequest', [request]) }
  }

  var ncc = {
    version: 1,
    nostr: nostr,
    blossom: blossom,
    runtime: {
      getURL: runtime.getURL,
      closePanel: runtime.closePanel,
      setPanelWidth: runtime.setPanelWidth
    },
    storage: { private: storageArea('private') }
  }

  function dispatchMessage(payload) {
    return new Promise(function (resolve) {
      var handlers = (listeners['runtime.message'] || []).slice()
      if (!handlers.length) {
        resolve(undefined)
        return
      }
      var done = false
      var timer = setTimeout(function () { finish(undefined) }, 5000)
      function finish(value) {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(value)
      }
      function sendResponse(value) { finish(value) }
      for (var index = 0; index < handlers.length; index += 1) {
        try {
          var returned = handlers[index](payload.message, payload.sender, sendResponse)
          if (returned && typeof returned.then === 'function') {
            returned.then(
              function (value) { if (value !== undefined) finish(value) },
              function (error) { finish({ __nccError: String(error) }) }
            )
          }
        } catch (error) {
          finish({ __nccError: String(error) })
          return
        }
      }
    })
  }

  globalThis.__nccDispatch = function (kind, payload) {
    if (kind === 'runtime.message') return dispatchMessage(payload)
    if (kind === 'storage.changed') {
      emit('storage.changed', [payload.changes || {}, payload.area || 'local'])
      return undefined
    }
    if (kind === 'action.clicked') {
      emit('action.clicked', [payload.tab])
      return undefined
    }
    if (kind === 'contextMenus.clicked') {
      emit('contextMenus.clicked', [payload, payload.tab])
      return undefined
    }
    if (kind === 'runtime.installed') {
      emit('runtime.installed', [payload])
      return undefined
    }
    if (kind === 'runtime.startup') {
      emit('runtime.startup', [])
      return undefined
    }
    return undefined
  }

  globalThis.chrome = chrome
  globalThis.browser = chrome
  globalThis.ncc = ncc
})()
`
