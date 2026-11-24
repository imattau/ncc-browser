package io.github.imattau.nccbrowser

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Rect
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.view.PixelCopy
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.PermissionRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.CookieManager
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import androidx.webkit.WebSettingsCompat
import androidx.webkit.ScriptHandler
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

internal object PermissionRequestBridge {
  private val nextCode = AtomicInteger(0x7100)
  private val callbacks = ConcurrentHashMap<Int, (Boolean) -> Unit>()

  fun request(activity: Activity, permissions: Array<String>, callback: (Boolean) -> Unit) {
    val code = nextCode.getAndIncrement()
    callbacks[code] = callback
    activity.requestPermissions(permissions, code)
  }

  fun resolve(code: Int, grantResults: IntArray) {
    val callback = callbacks.remove(code) ?: return
    callback(grantResults.isNotEmpty() && grantResults.all { it == PackageManager.PERMISSION_GRANTED })
  }
}

/**
 * `window.nostr` for ordinary web pages. The proxy only rewrites documents it serves
 * (NCC services, nsites), so a site like nostr.com would otherwise find nothing.
 *
 * Runs at document start through a [androidx.webkit.WebViewCompat] listener: the page
 * posts a message, the WebView reports the *real* origin of the frame it came from, and
 * Rust decides. Nothing here trusts a value the page supplies.
 */
private const val NIP07_SHIM = """
(function () {
  var port = window.__nccNip07;
  if (!port || window.nostr || window.top !== window) return;
  if (!/^https?:$/.test(location.protocol) || /\.localhost${'$'}/.test(location.hostname)) return;
  var pending = {}, seq = 0;
  port.onmessage = function (event) {
    var reply;
    try { reply = JSON.parse(event.data); } catch (e) { return; }
    var entry = pending[reply.id];
    if (!entry) return;
    delete pending[reply.id];
    if (reply.ok) { entry.resolve(reply.result); return; }
    var error = new Error(reply.message || 'The signer refused the request.');
    error.code = reply.code;
    entry.reject(error);
  };
  function call(method, params) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending[id] = { resolve: resolve, reject: reject };
      port.postMessage(JSON.stringify({ id: id, method: method, params: params === undefined ? null : params }));
    });
  }
  var nostr = {
    getPublicKey: function () { return call('get-public-key'); },
    signEvent: function (event) { return call('sign-event', event); },
    getRelays: function () { return call('get-relays'); },
    nip04: {
      encrypt: function (peer, text) { return call('nip04-encrypt', { peer: peer, text: text }); },
      decrypt: function (peer, text) { return call('nip04-decrypt', { peer: peer, text: text }); }
    },
    nip44: {
      encrypt: function (peer, text) { return call('nip44-encrypt', { peer: peer, text: text }); },
      decrypt: function (peer, text) { return call('nip44-decrypt', { peer: peer, text: text }); }
    }
  };
  try {
    Object.defineProperty(window, 'nostr', { value: nostr, writable: false, configurable: false });
  } catch (e) { window.nostr = nostr; }
})();
"""

private val NIP07_METHODS = setOf(
  "get-public-key", "sign-event", "get-relays",
  "nip04-encrypt", "nip04-decrypt", "nip44-encrypt", "nip44-decrypt",
)

private const val WEBLN_SHIM = """
(function () {
  if (window.top !== window || window.webln) return;
  var port = window.__nccWebln, pending = {}, seq = 0;
  if (!port) return;
  port.onmessage = function (event) {
    var reply; try { reply = JSON.parse(event.data); } catch (_) { return; }
    var item = pending[reply.id]; if (!item) return; delete pending[reply.id];
    if (reply.ok) item.resolve(reply.result); else item.reject(new Error(reply.message || 'Lightning wallet request failed'));
  };
  function call(method, params) { return new Promise(function (resolve, reject) { var id = ++seq; pending[id] = {resolve:resolve,reject:reject}; port.postMessage(JSON.stringify({id:id,method:method,params:params || {}})); }); }
  var provider = { enable:function(){return call('enable')}, getInfo:function(){return call('get_info')}, getBalance:function(){return call('get_balance')}, sendPayment:function(value){return call('pay_invoice',typeof value === 'string' ? {paymentRequest:value} : value)}, makeInvoice:function(value){return call('make_invoice',value)} };
  document.addEventListener('click', function (event) { var target=event.target; var anchor=target && target.closest ? target.closest('a[href]') : null; var href=anchor && /^lightning:/i.test(anchor.href) ? anchor.href.replace(/^lightning:/i,'') : ''; var text=target && target.textContent ? target.textContent.slice(0,5000) : ''; var match=text.match(/\bln(?:bc|tb|bcrt)[0-9a-z]{20,}/i); var invoice=href || (match && match[0]); if (!invoice || !/^ln(?:bc|tb|bcrt)[0-9a-z]+$/i.test(invoice)) return; if (href) event.preventDefault(); provider.sendPayment({paymentRequest:invoice}).catch(function(){}); }, true);
  try { Object.defineProperty(window,'webln',{value:provider,writable:false,configurable:false}); } catch (_) { window.webln=provider; }
})();
"""

/**
 * Route WebAuthn through the encrypted NCC vault first. Private key data never leaves
 * the browser shell; the page receives only the standard WebAuthn response fields.
 */
private const val PASSKEY_SHIM = """
(function () {
  var port = window.__nccPasskeys;
  if (location.protocol !== 'https:' || !port || window.top !== window || !navigator.credentials || !window.PublicKeyCredential) return;
  var credentials = navigator.credentials;
  var nativeCreate = credentials.create.bind(credentials);
  var nativeGet = credentials.get.bind(credentials);
  var pending = {}, sequence = 0, conditionals = new Set(), suggestion = null;
  function encode(value) {
    if (value instanceof ArrayBuffer) value = new Uint8Array(value);
    if (ArrayBuffer.isView(value)) value = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (!(value instanceof Uint8Array)) return '';
    var binary = ''; for (var i = 0; i < value.length; i++) binary += String.fromCharCode(value[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }
  function decode(value) {
    var raw = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
    var output = new Uint8Array(raw.length); for (var i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
    return output.buffer;
  }
  function pack(value) {
    return Object.assign({}, value, {
      challenge: encode(value.challenge),
      user: value.user ? Object.assign({}, value.user, { id: encode(value.user.id) }) : undefined,
      allowCredentials: value.allowCredentials && value.allowCredentials.map(function (item) { return Object.assign({}, item, { id: encode(item.id) }); }),
      excludeCredentials: value.excludeCredentials && value.excludeCredentials.map(function (item) { return Object.assign({}, item, { id: encode(item.id) }); })
    });
  }
  function request(operation, options, credentialId, signal) {
    return new Promise(function (resolve, reject) {
      if (signal && signal.aborted) { reject(new DOMException('The operation was aborted', 'AbortError')); return; }
      var id = ++sequence;
      var item = { resolve: resolve, reject: reject, signal: signal, onAbort: null };
      item.onAbort = function () {
        delete pending[id];
        try { port.postMessage(JSON.stringify({ id: id, operation: 'cancel' })); } catch (_) {}
        reject(new DOMException('The operation was aborted', 'AbortError'));
      };
      pending[id] = item;
      if (signal) signal.addEventListener('abort', item.onAbort, { once: true });
      var payload = { id: id, operation: operation };
      if (options) payload.options = pack(options);
      if (credentialId) payload.credentialId = credentialId;
      try { port.postMessage(JSON.stringify(payload)); }
      catch (error) { delete pending[id]; reject(error); }
    });
  }
  port.onmessage = function (event) {
    var message; try { message = JSON.parse(event.data); } catch (_) { return; }
    var item = pending[message.id]; if (!item) return;
    delete pending[message.id];
    if (item.signal) item.signal.removeEventListener('abort', item.onAbort);
    item.resolve(message);
  };
  function responseObject(value, creation) {
    var response = Object.create(creation ? AuthenticatorAttestationResponse.prototype : AuthenticatorAssertionResponse.prototype);
    var members = { clientDataJSON: { value: decode(value.clientDataJSON), enumerable: true } };
    if (creation) {
      members.attestationObject = { value: decode(value.attestationObject), enumerable: true };
      members.getTransports = { value: function () { return ['internal']; } };
      if (value.publicKey) members.getPublicKey = { value: function () { return decode(value.publicKey); } };
      members.getPublicKeyAlgorithm = { value: function () { return -7; } };
    } else {
      members.authenticatorData = { value: decode(value.authenticatorData), enumerable: true };
      members.signature = { value: decode(value.signature), enumerable: true };
      members.userHandle = { value: value.userHandle ? decode(value.userHandle) : null, enumerable: true };
    }
    Object.defineProperties(response, members);
    var rawId = decode(value.rawId);
    var result = Object.create(PublicKeyCredential.prototype);
    Object.defineProperties(result, {
      id: { value: value.id, enumerable: true }, rawId: { value: rawId, enumerable: true },
      type: { value: 'public-key', enumerable: true }, response: { value: response, enumerable: true },
      authenticatorAttachment: { value: 'platform', enumerable: true },
      getClientExtensionResults: { value: function () { return {}; }, enumerable: true },
      toJSON: { value: function () {
        return { id: value.id, rawId: value.rawId, type: 'public-key', authenticatorAttachment: 'platform', clientExtensionResults: {}, response: creation
          ? { clientDataJSON: value.clientDataJSON, attestationObject: value.attestationObject, transports: ['internal'] }
          : { clientDataJSON: value.clientDataJSON, authenticatorData: value.authenticatorData, signature: value.signature, userHandle: value.userHandle || null } };
      } }
    });
    return result;
  }
  async function resolve(operation, options, credentialId, signal) {
    var result = await request(operation, options, credentialId, signal);
    if (!result.handled) return null;
    if (result.error) throw new DOMException(result.error === 'InvalidStateError' ? 'Credential already exists' : result.error, result.errorName || (result.error === 'InvalidStateError' ? 'InvalidStateError' : 'NotAllowedError'));
    if (operation === 'candidates') return result.candidates || [];
    return result.response ? responseObject(result.response, operation === 'create') : null;
  }
  function usernameField(element) {
    if (!(element instanceof HTMLElement)) return false;
    var input = element instanceof HTMLInputElement ? element : element.querySelector && element.querySelector('input');
    var tokens = (element.getAttribute('autocomplete') || (input && input.getAttribute('autocomplete')) || '').toLowerCase().split(/\s+/);
    return tokens.indexOf('webauthn') >= 0 && (tokens.indexOf('username') >= 0 || (input && ['text', 'email'].indexOf(input.type) >= 0));
  }
  function hideSuggestion() { if (suggestion) suggestion.hidden = true; }
  async function showSuggestion(element) {
    if (!usernameField(element)) { hideSuggestion(); return; }
    var requestItem = Array.from(conditionals).find(function (entry) { return !entry.settled; });
    if (!requestItem || !requestItem.accounts.length) { hideSuggestion(); return; }
    if (!suggestion) {
      suggestion = document.createElement('div'); suggestion.id = 'ncc-passkey-suggestion';
      suggestion.style.cssText = 'position:fixed;z-index:2147483647;background:white;color:#222;border:1px solid #bbb;border-radius:10px;box-shadow:0 8px 28px #0004;padding:6px;font:14px system-ui;';
      document.documentElement.appendChild(suggestion);
    }
    suggestion.replaceChildren();
    requestItem.accounts.forEach(function (account) {
      var button = document.createElement('button'); button.type = 'button'; button.textContent = 'Use NCC passkey · ' + account.name;
      button.style.cssText = 'display:block;width:100%;padding:10px;border:0;background:white;text-align:left;color:#222;';
      button.addEventListener('pointerdown', function (event) { event.preventDefault(); });
      button.addEventListener('click', async function () {
        hideSuggestion(); requestItem.settled = true; conditionals.delete(requestItem);
        try {
          var credential = await resolve('get', requestItem.options, account.credentialId, requestItem.signal);
          requestItem.resolve(credential || await nativeGet(requestItem.nativeOptions));
        } catch (error) { requestItem.reject(error); }
      });
      suggestion.appendChild(button);
    });
    var rect = element.getBoundingClientRect();
    suggestion.style.left = Math.max(4, Math.min(rect.left, innerWidth - 320)) + 'px';
    suggestion.style.top = Math.max(4, Math.min(rect.bottom, innerHeight - 160)) + 'px';
    suggestion.hidden = false;
  }
  document.addEventListener('focusin', function (event) {
    var target = event.composedPath && event.composedPath().find(usernameField) || event.target;
    void showSuggestion(target);
  }, true);
  document.addEventListener('focusout', function () { setTimeout(function () { if (!suggestion || !suggestion.contains(document.activeElement)) hideSuggestion(); }, 150); }, true);
  document.addEventListener('keydown', function (event) { if (event.key === 'Escape') hideSuggestion(); }, true);
  Object.defineProperty(credentials, 'create', { configurable: true, value: async function (options) {
    if (!options || !options.publicKey) return nativeCreate(options);
    var result = await resolve('create', options.publicKey);
    return result || nativeCreate(options);
  } });
  Object.defineProperty(credentials, 'get', { configurable: true, value: async function (options) {
    if (!options || !options.publicKey) return nativeGet(options);
    if (options.mediation === 'conditional') {
      var accounts;
      try { accounts = await resolve('candidates', options.publicKey); } catch (_) { return nativeGet(options); }
      if (!accounts || !accounts.length) return nativeGet(options);
      return new Promise(function (resolvePromise, rejectPromise) {
        var requestItem = { accounts: accounts, options: options.publicKey, nativeOptions: options, signal: options.signal, resolve: resolvePromise, reject: rejectPromise, settled: false };
        if (options.signal && options.signal.aborted) { rejectPromise(new DOMException('The operation was aborted', 'AbortError')); return; }
        if (options.signal) options.signal.addEventListener('abort', function () {
          if (requestItem.settled) return; requestItem.settled = true; conditionals.delete(requestItem); hideSuggestion(); rejectPromise(new DOMException('The operation was aborted', 'AbortError'));
        }, { once: true });
        conditionals.add(requestItem);
        if (usernameField(document.activeElement)) void showSuggestion(document.activeElement);
      });
    }
    var result = await resolve('get', options.publicKey, null, options.signal);
    return result || nativeGet(options);
  } });
  var nativeConditional = PublicKeyCredential.isConditionalMediationAvailable && PublicKeyCredential.isConditionalMediationAvailable.bind(PublicKeyCredential);
  Object.defineProperty(PublicKeyCredential, 'isConditionalMediationAvailable', { configurable: true, value: async function () { return true; } });
  var nativeCapabilities = PublicKeyCredential.getClientCapabilities && PublicKeyCredential.getClientCapabilities.bind(PublicKeyCredential);
  if (nativeCapabilities) Object.defineProperty(PublicKeyCredential, 'getClientCapabilities', { configurable: true, value: async function () { return Object.assign({}, await nativeCapabilities(), { conditionalGet: true, passkeyPlatformAuthenticator: true, userVerifyingPlatformAuthenticator: true }); } });
})();
"""

/**
 * Reports a submitted login to the native side. Scoped to a window flag so a second
 * page load in the same document does not double-report.
 */
private const val PASSWORD_HOOK = """
(function () {
  if (window.__nccPasswordHook) return
  window.__nccPasswordHook = true
  var last = { key: '', at: 0 }

  function visible(el) {
    if (!el) return false
    if (el.hidden || el.disabled || el.readOnly) return false
    var style = getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden') return false
    return el.getClientRects().length > 0
  }

  function passwordInputs(root) {
    return [].slice.call(root.querySelectorAll('input')).filter(function (input) {
      return input.type === 'password' && visible(input)
    })
  }

  function usernameFor(field, root) {
    var inputs = [].slice.call(root.querySelectorAll('input'))
    var candidates = inputs.filter(function (input) {
      return input !== field && visible(input) &&
        (input.autocomplete === 'username' || input.type === 'email' ||
         input.type === 'text' || input.type === 'tel' || !input.type)
    })
    var explicit = candidates.filter(function (input) {
      return input.autocomplete === 'username'
    })[0]
    if (explicit) return explicit
    var before = candidates.filter(function (input) {
      return (field.compareDocumentPosition(input) & 4) !== 0
    })
    return before[before.length - 1] || candidates[0] || null
  }

  document.addEventListener('submit', function (event) {
    if (!event.isTrusted) return
    var form = event.target
    if (!(form instanceof HTMLFormElement)) return
    var fields = passwordInputs(form)
    var values = fields.map(function (field) { return field.value }).filter(function (value) {
      return value.length > 0
    })
    if (values.length === 0) return
    if (new Set(values).size > 1) return
    var password = values[0]
    var field = fields.filter(function (candidate) { return candidate.value === password })[0]
    if (!field) return
    var user = usernameFor(field, form)
    var key = (user ? user.value : '') + '\u0000' + password
    var now = Date.now()
    if (last.key === key && now - last.at < 2500) return
    last.key = key
    last.at = now
    if (window.NccVault && window.NccVault.capture) {
      window.NccVault.capture(
        user ? user.value.slice(0, 320) : '',
        password.slice(0, 4096),
        (document.title || '').slice(0, 200)
      )
    }
  }, true)
})()
"""

/** Detect card forms from their combined autocomplete, labels, and field layout. */
private const val PAYMENT_HOOK = """
(function(){
  if(window.__nccPaymentHook)return;window.__nccPaymentHook=true;
  function send(type,data){try{if(window.__nccPaymentBridge)window.__nccPaymentBridge.postMessage(JSON.stringify(Object.assign({type:type},data||{})))}catch(_){}}
  function visible(e){if(!e||e.disabled||e.readOnly)return false;var s=getComputedStyle(e);return s.display!=='none'&&s.visibility!=='hidden'&&e.getClientRects().length>0}
  function text(e){return [e.name,e.id,e.autocomplete,e.placeholder,e.getAttribute('aria-label'),e.labels&&[].map.call(e.labels,function(l){return l.textContent}).join(' '),e.parentElement&&e.parentElement.textContent].join(' ').toLowerCase()}
  function inspect(form){var els=[].slice.call((form||document).querySelectorAll('input,select')).filter(visible);var num=els.find(function(e){return e.autocomplete==='cc-number'||/card.?number|cc.?number|credit.?card/.test(text(e))});var exp=els.find(function(e){return e.autocomplete==='cc-exp'||e.autocomplete==='cc-exp-month'||/expir|valid.?thru/.test(text(e))});var expYear=els.find(function(e){return e.autocomplete==='cc-exp-year'||/expir.*year|year.*expir/.test(text(e))});var name=els.find(function(e){return e.autocomplete==='cc-name'||/card.?holder|name.?on.?card/.test(text(e))});var cvc=els.find(function(e){return e.autocomplete==='cc-csc'||/cvc|cvv|security.?code/.test(text(e))});var network=els.find(function(e){return e.tagName==='SELECT'&&/visa|mastercard|amex|discover/.test(e.textContent.toLowerCase())});var n=!!num,a=!!exp||!!expYear,h=!!name,s=!!cvc,k=!!network;var score=(n?3:0)+(a?2:0)+(h?1:0)+(s?1:0)+(k?2:0)+(els.some(function(e){return /^cc-/.test(e.autocomplete||'')})?2:0);return score>=5&&n?{form:form||document,number:num,exp:exp,expYear:expYear,name:name,cvc:cvc,network:network}:null}
  function likelyForms(){var fs=[].slice.call(document.forms);if(!fs.length)fs=[document];return fs.map(inspect).filter(Boolean)}
  function announce(){var found=likelyForms();if(found.length)send('detected',{blank:!found[0].number.value})}
  document.addEventListener('focusin',function(ev){var form=ev.target&&ev.target.form;var hit=inspect(form||document);if(hit)send('detected',{blank:!hit.number.value})},true);
  document.addEventListener('submit',function(ev){if(!ev.isTrusted)return;var hit=inspect(ev.target);if(!hit||!hit.number)return;var digits=function(e){return e?e.value.replace(/\D/g,''):''};var exp=digits(hit.exp);var month=hit.exp&&hit.exp.autocomplete==='cc-exp-month'?exp:exp.slice(0,2);var year=hit.expYear?digits(hit.expYear):(hit.exp&&hit.exp.autocomplete==='cc-exp-month'?'':exp.slice(2));if(hit.exp&&hit.exp.autocomplete==='cc-exp'){var raw=hit.exp.value;var m=raw.match(/(\d{1,2})\D+(\d{2,4})/);if(m){month=m[1];year=m[2]}}var data={name:hit.name?hit.name.value:'',number:digits(hit.number),expMonth:month,expYear:year,cvc:hit.cvc?digits(hit.cvc):''};if(!/^\d{12,19}$/.test(data.number)||!data.expMonth||!data.expYear)return;send('capture',{card:data})},true);
  announce();new MutationObserver(announce).observe(document.documentElement,{childList:true,subtree:true});
})()
"""

/** Refresh the declared icon without changing the page's normal HTTP cache policy. */
private const val FAVICON_REFRESH_SCRIPT = """
(function(){
  var bridge=window.__nccFaviconBridge;
  if(!bridge||window.top!==window)return;
  var urls=[];
  try{
    document.querySelectorAll('link[rel]').forEach(function(link){
      var rel=(link.rel||'').toLowerCase().split(/\s+/);
      if(rel.indexOf('icon')!==-1&&link.href)urls.push(link.href);
    });
    urls.push(new URL('/favicon.ico',location.href).href);
  }catch(_){return;}
  var page=location.href;
  function next(index){
    if(index>=urls.length)return;
    fetch(urls[index],{cache:'no-store',credentials:'same-origin'}).then(function(response){
      if(!response.ok)return null;
      var type=(response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
      if(type.indexOf('image/')!==0)return null;
      return response.blob().then(function(blob){return {blob:blob};});
    }).then(function(result){
      if(!result||result.blob.size===0||result.blob.size>262144)return next(index+1);
      var reader=new FileReader();
      reader.onload=function(){try{bridge.postMessage(JSON.stringify({url:page,icon:reader.result}));}catch(_){}};
      reader.onerror=function(){next(index+1);};
      reader.readAsDataURL(result.blob);
    }).catch(function(){next(index+1);});
  }
  next(0);
})();
"""

private fun faviconPageKey(raw: String?): String? = raw?.substringBefore('#')?.takeIf { it.isNotBlank() }

private fun faviconOrigin(raw: String?): String? {
  val uri = raw?.let { try { Uri.parse(it) } catch (_: Exception) { null } } ?: return null
  val scheme = uri.scheme?.lowercase() ?: return null
  val host = uri.host?.lowercase() ?: return null
  if (scheme != "http" && scheme != "https") return null
  val port = if (uri.port == -1 || (scheme == "https" && uri.port == 443) || (scheme == "http" && uri.port == 80)) "" else ":${uri.port}"
  return "$scheme://$host$port"
}

private fun webOrigin(raw: String?): String? {
  val uri = raw?.let { try { Uri.parse(it) } catch (_: Exception) { null } } ?: return null
  val scheme = uri.scheme?.lowercase() ?: return null
  val host = uri.host?.lowercase() ?: return null
  if (scheme != "https") return null
  val port = if (uri.port == -1 || uri.port == 443) "" else ":${uri.port}"
  return "$scheme://$host$port"
}

/**
 * One tab: a WebView plus what the switcher needs to draw it.
 *
 * Pages load straight from `http://<npub>.<service>.localhost:<port>/…`. Chromium
 * resolves `*.localhost` to loopback, so the proxy is reached natively and the
 * document keeps that origin — cookies, storage, service workers and request bodies
 * all behave as they would anywhere else.
 *
 * Clearnet pages load here too, exactly as they do on the desktop: this is a browser,
 * and sending a page to the system browser is a dead end for anything the app knows
 * how to render. The proxy port therefore cannot be read off the current URL — a
 * clearnet page does not carry it — so it is supplied by the activity.
 */
class ContentSurface(
  val id: String,
  /** A private tab: it loads through the listener that keeps nothing. */
  val isPrivate: Boolean = false,
  /** A Tor tab: onion sites only, fetched through Tor by the third listener. */
  val isTor: Boolean = false,
  private val container: ViewGroup,
  private val proxyPort: () -> Int,
  private val report: (JSONObject) -> Unit,
  private val onDownload: (String, String?, String?) -> Unit,
  private val onOpenNewWindow: (String) -> Unit,
  /**
   * Create a new tab for a dialog-styled window.open() popup and return its WebView,
   * unnavigated, so it can be wired as the WebViewTransport target directly — see
   * onCreateWindow below. Null means no content host was available to put it in.
   */
  private val onOpenPopupWindow: () -> WebView?,
) {
  private external fun nativeProtectionCheck(url: String, source: String, requestType: String, method: String, kind: String): Boolean
  private external fun nativeProtectionLevel(): Int
  private external fun nativeCosmeticSelectors(url: String, kind: String): String
  private val cosmeticScripts = LinkedHashMap<String, ScriptHandler>()
  private val pendingNwc = ConcurrentHashMap<String, (String) -> Unit>()
  private val pendingPasskeys = ConcurrentHashMap<String, (String) -> Unit>()
  private external fun nativeClearProtectionSession(kind: String)
  private external fun nativeNip07(kind: String, origin: String, method: String, body: String): String
  private var webView: WebView? = null
  /** Captured from the first Tor URL so filtering does not race the shell bridge. */
  private var torListenerPort: Int? = null
  private var showingError = false
  private var pendingCertificateError: Pair<String, String>? = null
  /** Page whose refreshed favicon supersedes a potentially stale WebView bitmap. */
  private var refreshedFaviconPage: String? = null
  /// Set once the tab is gone, so a callback posted before that cannot touch it.
  private var destroyed = false
  private val sitePermissionDecisions = mutableMapOf<String, Boolean>()

  var title: String? = null
    private set
  var currentUrl: String? = null
    private set
  var thumbnail: String? = null
  var lastUsed: Long = System.currentTimeMillis()

  var desktopMode = false
    private set
  private var mobileAgent: String? = null

  /// A tab restored from the last run: it has an address and a title for the switcher
  /// but no WebView yet, so a dozen saved tabs do not all load at launch.
  private var parkedUrl: String? = null

  val isOpen: Boolean
    get() = webView?.visibility == View.VISIBLE

  fun accepts(url: String): Boolean {
    val scheme = Uri.parse(url).scheme?.lowercase()
    return scheme == "http" || scheme == "https"
  }

  fun clearProtectionSession() {
    if (isPrivate) nativeClearProtectionSession("private")
    if (isTor) nativeClearProtectionSession("tor")
  }

  private fun tabKind(): String = if (isPrivate) "private" else if (isTor) "tor" else "normal"

  /** Install host-specific cosmetic rules before page scripts and ad slots run. */
  private fun prepareCosmeticScript(web: WebView, url: String) {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
    val uri = Uri.parse(url)
    val scheme = uri.scheme?.lowercase() ?: return
    val host = uri.host ?: return
    if (scheme != "http" && scheme != "https") return
    val selectors = nativeCosmeticSelectors(url, tabKind())
    if (selectors.isBlank()) return
    val pathKey = url.substringBefore('#')
    cosmeticScripts.remove(pathKey)?.let { runCatching { it.remove() } }
    val port = if (uri.port > 0) ":${uri.port}" else ""
    val originRule = "$scheme://$host$port"
    val quotedUrl = JSONObject.quote(pathKey)
    val quotedSelectors = JSONObject.quote(selectors)
    val script = """(()=>{if(location.href.split('#')[0]!==$quotedUrl)return;const s=$quotedSelectors;const a=()=>{try{document.querySelectorAll(s).forEach(e=>e.remove())}catch{}};a();new MutationObserver(a).observe(document,{childList:true,subtree:true})})()"""
    try {
      cosmeticScripts[pathKey] = WebViewCompat.addDocumentStartJavaScript(web, script, setOf(originRule))
      while (cosmeticScripts.size > 64) {
        val oldest = cosmeticScripts.entries.first()
        runCatching { oldest.value.remove() }
        cosmeticScripts.remove(oldest.key)
      }
    } catch (_: Throwable) {
      // Older WebView providers may advertise the feature but fail to install it.
    }
  }

  private fun emptyResponse(): WebResourceResponse =
    WebResourceResponse("text/plain", "utf-8", ByteArrayInputStream(ByteArray(0)))

  /**
   * Expose the one thing a page may tell us about a login: what was submitted.
   *
   * The object is reachable from page JavaScript (Android has no isolated world), so
   * it is deliberately write-only and carries no secret from the vault. A hostile page
   * can offer captures; it cannot read one, and the user confirms every save.
   */
  private fun installPasswordBridge(web: WebView) {
    if (isPrivate || isTor) return
    web.addJavascriptInterface(
      object {
        @JavascriptInterface
        fun capture(username: String?, password: String?, title: String?) {
          if (destroyed) return
          val secret = password?.take(4096) ?: return
          if (secret.isEmpty()) return
          val user = username?.take(320) ?: ""
          val heading = title?.take(200) ?: ""
          // The page being submitted, read now: a submit that navigates updates
          // `currentUrl` before the posted lambda runs, and a login must be stored
          // under the form's origin, not the page it redirected to.
          val page = currentUrl ?: ""
          Handler(Looper.getMainLooper()).post {
            emit(
              JSONObject()
                .put("type", "capture")
                .put("username", user)
                .put("password", secret)
                .put("title", heading)
                .put("url", page),
            )
          }
        }
      },
      "NccVault",
    )
  }

  private fun installPaymentBridge(web: WebView) {
    if (isPrivate || isTor) return
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) ||
      !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
    try {
      WebViewCompat.addWebMessageListener(web, "__nccPaymentBridge", setOf("*")) { _, message, sourceOrigin, isMainFrame, _ ->
        if (!isMainFrame || sourceOrigin.scheme?.lowercase() != "https") return@addWebMessageListener
        val origin = sourceOrigin.toString().trimEnd('/')
        if (webOrigin(origin) == null || webOrigin(currentUrl) != webOrigin(origin)) return@addWebMessageListener
        val request = try { JSONObject(message.data ?: return@addWebMessageListener) } catch (_: Exception) { return@addWebMessageListener }
        val kind = request.optString("type")
        if (kind != "detected" && kind != "capture") return@addWebMessageListener
        Handler(Looper.getMainLooper()).post {
          if (destroyed || webOrigin(web.url) != webOrigin(origin) || webOrigin(currentUrl) != webOrigin(origin)) return@post
          val page = web.url ?: currentUrl ?: return@post
          if (kind == "detected") {
            if (request.optBoolean("blank", false)) emit(JSONObject().put("type", "payment-detected").put("url", page))
          } else {
            val card = request.optJSONObject("card") ?: return@post
            emit(JSONObject().put("type", "payment-capture").put("url", page).put("title", title ?: "").put("card", card))
          }
        }
      }
    } catch (_: Throwable) { /* Payment form assistance is unavailable on older WebView versions. */ }
  }

  /** Accept a freshly fetched favicon only from this tab's current top-level page. */
  private fun installFaviconRefreshBridge(web: WebView) {
    if (isPrivate || isTor || !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return
    try {
      WebViewCompat.addWebMessageListener(web, "__nccFaviconBridge", setOf("*")) { _, message, sourceOrigin, isMainFrame, _ ->
        if (!isMainFrame || destroyed) return@addWebMessageListener
        val request = try { JSONObject(message.data ?: return@addWebMessageListener) } catch (_: Exception) { return@addWebMessageListener }
        val page = request.optString("url").takeIf { it.isNotBlank() } ?: return@addWebMessageListener
        val icon = request.optString("icon").takeIf { it.startsWith("data:image/", ignoreCase = true) } ?: return@addWebMessageListener
        if (icon.length > 360_000) return@addWebMessageListener
        val pageKey = faviconPageKey(page) ?: return@addWebMessageListener
        val origin = faviconOrigin(page) ?: return@addWebMessageListener
        if (origin != faviconOrigin(sourceOrigin.toString()) || origin != faviconOrigin(currentUrl)) return@addWebMessageListener
        if (pageKey == refreshedFaviconPage) return@addWebMessageListener
        refreshedFaviconPage = pageKey

        Handler(Looper.getMainLooper()).post {
          if (destroyed || faviconPageKey(currentUrl) != pageKey || faviconPageKey(web.url) != pageKey) {
            if (refreshedFaviconPage == pageKey) refreshedFaviconPage = null
            return@post
          }
          emit(JSONObject().put("type", "icon").put("url", page).put("icon", icon))
        }
      }
    } catch (_: Throwable) {
      // The existing WebChromeClient favicon callback remains available on older WebViews.
    }
  }

  /**
   * Offer NIP-07 to web pages. Private tabs sign with a key that lives in memory and
   * Tor tabs with another; neither can reach the person's own key.
   */
  /** Route page WebAuthn requests to the browser shell and back to their originating tab. */
  private fun installPasskeyBridge(web: WebView) {
    if (isPrivate || isTor || !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) ||
      !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
    try {
      // The WebView origin-rule grammar has no HTTPS-only any-host rule: "https://*"
      // throws IllegalArgumentException. Use the universal rule, then keep the object
      // inert on non-HTTPS pages in PASSKEY_SHIM and reject non-HTTPS requests here.
      WebViewCompat.addWebMessageListener(web, "__nccPasskeys", setOf("*")) { _, message, sourceOrigin, isMainFrame, replyProxy ->
        if (destroyed) return@addWebMessageListener
        val request = try { JSONObject(message.data ?: return@addWebMessageListener) } catch (_: Exception) { return@addWebMessageListener }
        val callId = request.optInt("id", -1)
        val operation = request.optString("operation")
        if (operation == "cancel") {
          pendingPasskeys.entries.firstOrNull { it.key.startsWith("$id:$callId:") }?.let { (key, responder) ->
            pendingPasskeys.remove(key)
            responder(JSONObject().put("id", callId).put("handled", true).put("error", "AbortError").toString())
          }
          return@addWebMessageListener
        }
        val pageUrl = Uri.parse(web.url ?: currentUrl ?: "")
        val scheme = sourceOrigin.scheme?.lowercase()
        val host = sourceOrigin.host?.lowercase() ?: ""
        val pageOrigin = buildString {
          append(pageUrl.scheme?.lowercase() ?: "")
          append("://")
          append(pageUrl.host?.lowercase() ?: "")
          if (pageUrl.port > 0) append(":${pageUrl.port}")
        }
        if (callId < 0 || !isMainFrame || scheme != "https" || host.endsWith(".localhost") || sourceOrigin.toString().trimEnd('/') != pageOrigin) {
          replyProxy.postMessage(JSONObject().put("id", callId).put("handled", true).put("error", "NotAllowedError").toString())
          return@addWebMessageListener
        }
        val requestId = "$id:$callId:${System.nanoTime()}"
        val responder: (String) -> Unit = { raw ->
          val answer = try { JSONObject(raw) } catch (_: Exception) { JSONObject().put("handled", false) }
          val result = JSONObject().put("id", callId).put("handled", answer.optBoolean("handled"))
          if (answer.has("error")) result.put("error", answer.optString("error"))
          if (answer.has("errorName")) result.put("errorName", answer.optString("errorName"))
          if (answer.has("response")) result.put("response", answer.optJSONObject("response") ?: JSONObject())
          if (answer.has("candidates")) result.put("candidates", answer.optJSONArray("candidates") ?: org.json.JSONArray())
          Handler(Looper.getMainLooper()).post { if (!destroyed) replyProxy.postMessage(result.toString()) }
        }
        pendingPasskeys[requestId] = responder
        Handler(Looper.getMainLooper()).postDelayed({ pendingPasskeys.remove(requestId)?.invoke("{\"handled\":true,\"error\":\"NotAllowedError\"}") }, 120_000)
        emit(JSONObject()
          .put("type", "webauthn-request")
          .put("requestId", requestId)
          .put("operation", operation)
          .put("origin", sourceOrigin.toString().trimEnd('/'))
          .put("credentialId", request.optString("credentialId"))
          .put("options", request.optJSONObject("options") ?: JSONObject()))
      }
      WebViewCompat.addDocumentStartJavaScript(web, PASSKEY_SHIM, setOf("*"))
    } catch (error: Throwable) {
      android.util.Log.w("NccPasskeys", "Could not install the WebAuthn bridge; using the native WebView authenticator", error)
      // Fall back to the WebView's platform implementation when the bridge is unavailable.
    }
  }

  private fun installNip07(web: WebView) {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) ||
      !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
    ) {
      return
    }
    val kind = if (isPrivate) "private" else if (isTor) "tor" else "normal"
    try {
      WebViewCompat.addWebMessageListener(
        web,
        "__nccNip07",
        setOf("*"),
      ) { _, message, sourceOrigin, isMainFrame, replyProxy ->
        val text = message.data ?: return@addWebMessageListener
        val request = try { JSONObject(text) } catch (error: Exception) { return@addWebMessageListener }
        val id = request.optInt("id", -1)
        fun reply(ok: Boolean, result: Any?, code: String?, detail: String?) {
          val out = JSONObject().put("id", id).put("ok", ok)
          if (ok) out.put("result", result) else out.put("code", code ?: "failed").put("message", detail ?: "")
          Handler(Looper.getMainLooper()).post { if (!destroyed) replyProxy.postMessage(out.toString()) }
        }

        val scheme = sourceOrigin.scheme?.lowercase()
        val host = sourceOrigin.host?.lowercase() ?: ""
        val method = request.optString("method")
        when {
          id < 0 -> return@addWebMessageListener
          !isMainFrame || (scheme != "https" && scheme != "http") || host.endsWith(".localhost") ->
            reply(false, null, "not-allowed", "NIP-07 is only offered to the top-level page.")
          method !in NIP07_METHODS -> reply(false, null, "unknown-method", "Unknown signer method.")
          else -> {
            val body = JSONObject().put("params", request.opt("params") ?: JSONObject.NULL).toString()
            val origin = sourceOrigin.toString().trimEnd('/')
            Thread {
              try {
                val answer = JSONObject(nativeNip07(kind, origin, method, body))
                val status = answer.optInt("status", 500)
                val payload = try { JSONObject(answer.optString("body")) } catch (error: Exception) { JSONObject() }
                if (status in 200..299) reply(true, payload.opt("result"), null, null)
                else reply(false, null, payload.optString("code", "failed"), payload.optString("message"))
              } catch (error: Throwable) {
                reply(false, null, "failed", error.message ?: "The signer did not answer.")
              }
            }.start()
          }
        }
      }
      WebViewCompat.addDocumentStartJavaScript(web, NIP07_SHIM, setOf("*"))
      WebViewCompat.addWebMessageListener(web, "__nccWebln", setOf("*")) { _, message, sourceOrigin, isMainFrame, replyProxy ->
        val text = message.data ?: return@addWebMessageListener
        val request = try { JSONObject(text) } catch (_: Exception) { return@addWebMessageListener }
        val pageId = request.optInt("id", -1)
        val scheme = sourceOrigin.scheme?.lowercase()
        val method = request.optString("method")
        if (pageId < 0 || !isMainFrame || (scheme != "https" && scheme != "http")) {
          val denied = JSONObject().put("id", pageId).put("ok", false).put("message", "WebLN is only available to top-level web pages.")
          replyProxy.postMessage(denied.toString())
          return@addWebMessageListener
        }
        val requestId = "${id}-${System.nanoTime()}-${pageId}"
        pendingNwc[requestId] = { response ->
          val shellReply = try { JSONObject(response) } catch (_: Exception) { JSONObject().put("ok", false).put("message", "Invalid wallet response") }
          val reply = JSONObject().put("id", pageId).put("ok", shellReply.optBoolean("ok"))
          if (shellReply.optBoolean("ok")) reply.put("result", shellReply.opt("result")) else reply.put("message", shellReply.optString("message", "Payment cancelled"))
          Handler(Looper.getMainLooper()).post { if (!destroyed) replyProxy.postMessage(reply.toString()) }
        }
        Handler(Looper.getMainLooper()).postDelayed({
          pendingNwc.remove(requestId)?.invoke("{\"ok\":false,\"message\":\"Lightning request timed out\"}")
        }, 120_000)
        emit(JSONObject().put("type", "nwc-request").put("requestId", requestId).put("method", method)
          .put("origin", sourceOrigin.toString().trimEnd('/')).put("params", request.opt("params") ?: JSONObject.NULL))
      }
      WebViewCompat.addDocumentStartJavaScript(web, WEBLN_SHIM, setOf("*"))
    } catch (error: Throwable) {
      // A WebView that cannot do this simply has no window.nostr, as before.
    }
  }

  fun resolveNwc(requestId: String, response: String) {
    pendingNwc.remove(requestId)?.invoke(response)
  }

  fun resolvePasskey(requestId: String, response: String) {
    pendingPasskeys.remove(requestId)?.invoke(response)
  }

  /**
   * Fill the login form the user chose an entry for. Injected as a one-shot script:
   * there is no page-callable function that returns a credential.
   */
  fun fillLogin(username: String, password: String) {
    val web = webView ?: return
    if (isPrivate || isTor || destroyed) return

    val user = JSONObject.quote(username)
    val secret = JSONObject.quote(password)
    val script =
      """
      (function () {
        function visible(el) {
          if (!el) return false
          if (el.hidden || el.disabled || el.readOnly) return false
          var style = getComputedStyle(el)
          if (style.display === 'none' || style.visibility === 'hidden') return false
          return el.getClientRects().length > 0
        }
        var inputs = [].slice.call(document.querySelectorAll('input'))
        var passwords = inputs.filter(function (input) {
          return input.type === 'password' && visible(input)
        })
        var field = passwords[0]
        if (!field) return false
        var candidates = inputs.filter(function (input) {
          return input !== field && visible(input) &&
            (input.autocomplete === 'username' || input.type === 'email' ||
             input.type === 'text' || input.type === 'tel' || !input.type)
        })
        var explicit = candidates.filter(function (input) {
          return input.autocomplete === 'username'
        })[0]
        var before = candidates.filter(function (input) {
          return (field.compareDocumentPosition(input) & 4) !== 0
        })
        var userField = explicit || before[before.length - 1] || candidates[0] || null
        var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        function fill(el, value) {
          if (!el || !value) return
          setter.call(el, value)
          el.dispatchEvent(new Event('input', { bubbles: true }))
          el.dispatchEvent(new Event('change', { bubbles: true }))
        }
        fill(userField, $user)
        fill(field, $secret)
        field.focus()
        return true
      })()
      """.trimIndent()

    web.evaluateJavascript(script) { result ->
      emit(JSONObject().put("type", "filled").put("ok", result == "true"))
    }
  }

  fun fillPaymentCard(cardJson: String, expectedOrigin: String) {
    val web = webView ?: return
    if (isPrivate || isTor || destroyed || webOrigin(expectedOrigin) == null || webOrigin(currentUrl) != webOrigin(expectedOrigin) || webOrigin(web.url) != webOrigin(expectedOrigin)) return
    val card = try { JSONObject(cardJson) } catch (_: Exception) { return }
    // Embed the already parsed JSON object, not a quoted JSON string. The page
    // fill script reads `c.number` and the other fields directly.
    val values = card.toString()
    val origin = JSONObject.quote(expectedOrigin)
      web.evaluateJavascript("""(()=>{if(location.origin!==$origin)return;const c=$values;const vis=e=>e&&!e.disabled&&!e.readOnly&&e.getClientRects().length;const all=[...document.querySelectorAll('input,select')].filter(vis);const tx=e=>[e.name,e.id,e.autocomplete,e.placeholder,e.getAttribute('aria-label'),e.labels&&[...e.labels].map(x=>x.textContent).join(' ')].join(' ').toLowerCase();const pick=(re,ac)=>all.find(e=>e.autocomplete===ac||re.test(tx(e)));const set=(e,v)=>{if(!e||!v)return;const p=Object.getPrototypeOf(e);const d=Object.getOwnPropertyDescriptor(p,'value');if(d&&d.set)d.set.call(e,v);else e.value=v;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))};set(pick(/card.?number|cc.?number|credit.?card/,'cc-number'),c.number);set(pick(/card.?holder|name.?on.?card/,'cc-name'),c.name);let m=pick(/expir|valid.?thru/,'cc-exp');if(m){if(m.autocomplete==='cc-exp-month')set(m,c.expMonth);else set(m,String(c.expMonth).padStart(2,'0')+'/'+c.expYear)}const ys=all.find(e=>e.autocomplete==='cc-exp-year');set(ys,c.expYear);set(pick(/cvc|cvv|security.?code/,'cc-csc'),c.cvc)})()""", null)
  }

  fun open(url: String): Boolean {
    if (!accepts(url)) {
      emit(JSONObject().put("type", "rejected").put("url", url))
      return false
    }
    val web = webView ?: create().also { webView = it }
    if (isTor) torListenerPort = Uri.parse(url).port.takeIf { it > 0 }
    web.visibility = View.VISIBLE
    prepareCosmeticScript(web, url)
    web.loadUrl(url)
    return true
  }

  /**
   * Create this tab's WebView, without navigating it, so a window.open() popup can be
   * wired directly as its WebViewTransport target. Keeping the transport-provided
   * WebView itself as the popup (instead of reading its destination and reopening that
   * URL in an unrelated tab) is what keeps window.opener, and so postMessage-based
   * sign-in flows, working.
   */
  fun attachAsPopupTarget(): WebView {
    val web = webView ?: create().also { webView = it }
    web.visibility = View.VISIBLE
    return web
  }

  fun reload() {
    webView?.let { web ->
      currentUrl?.let { prepareCosmeticScript(web, it) }
      web.reload()
    }
  }

  fun clearCache() {
    webView?.clearCache(true)
  }

  fun back(): Boolean {
    val web = webView ?: return false
    if (web.canGoBack()) {
      web.goBack()
      return true
    }
    return false
  }

  fun canGoBack(): Boolean = webView?.canGoBack() == true

  fun canGoForward(): Boolean = webView?.canGoForward() == true

  fun forward() {
    webView?.takeIf { it.canGoForward() }?.goForward()
  }

  fun stop() {
    webView?.stopLoading()
  }

  /** Find in page: results arrive through the find listener as `find` events. */
  fun find(query: String) {
    webView?.findAllAsync(query)
  }

  fun findNext(forward: Boolean) {
    webView?.findNext(forward)
  }

  fun clearFind() {
    webView?.clearMatches()
  }

  /**
   * Ask for the desktop layout: a desktop user agent and a wide viewport, then reload.
   * The mobile agent is remembered so switching back restores exactly what the device
   * reported, including the NostrNavigator suffix.
   */
  fun setDesktopMode(enabled: Boolean) {
    val web = webView ?: return
    if (enabled == desktopMode) return
    desktopMode = enabled

    if (enabled) {
      val chrome = Regex("Chrome/([0-9.]+)").find(web.settings.userAgentString)?.groupValues?.get(1) ?: "120.0.0.0"
      web.settings.userAgentString =
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
          "Chrome/$chrome Safari/537.36 NostrNavigator/${BuildConfig.VERSION_NAME}"
    } else {
      web.settings.userAgentString = mobileAgent
    }
    web.settings.useWideViewPort = enabled
    web.settings.loadWithOverviewMode = enabled
    web.reload()
  }

  /**
   * Keep an address for later. The page loads when the tab is first shown, which is
   * when the person picks it, not when the app starts.
   */
  fun park(url: String, savedTitle: String?) {
    parkedUrl = url
    currentUrl = url
    title = savedTitle
  }

  fun show() {
    val parked = parkedUrl
    if (webView == null && parked != null) {
      parkedUrl = null
      open(parked)
      return
    }
    webView?.visibility = View.VISIBLE
  }

  fun hide() {
    hideFullscreen()
    webView?.visibility = View.GONE
  }

  private var fullscreenView: View? = null
  private var fullscreenCallback: WebChromeClient.CustomViewCallback? = null

  val isFullscreen: Boolean
    get() = fullscreenView != null

  private fun showFullscreen(view: View, callback: WebChromeClient.CustomViewCallback) {
    val activity = container.context as? Activity
    if (activity == null || fullscreenView != null) {
      callback.onCustomViewHidden()
      return
    }
    val decor = activity.window.decorView as ViewGroup
    val holder = FrameLayout(activity).apply {
      setBackgroundColor(android.graphics.Color.BLACK)
      addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    }
    decor.addView(holder, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    fullscreenView = holder
    fullscreenCallback = callback
    webView?.visibility = View.INVISIBLE
    WindowInsetsControllerCompat(activity.window, decor).apply {
      systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
      hide(WindowInsetsCompat.Type.systemBars())
    }
  }

  /** Leave page fullscreen. Returns false when there was none. */
  fun hideFullscreen(): Boolean {
    val holder = fullscreenView ?: return false
    val callback = fullscreenCallback
    fullscreenView = null
    fullscreenCallback = null
    (holder.parent as? ViewGroup)?.removeView(holder)
    webView?.visibility = View.VISIBLE
    (container.context as? Activity)?.let { activity ->
      val decor = activity.window.decorView
      WindowInsetsControllerCompat(activity.window, decor).show(WindowInsetsCompat.Type.systemBars())
    }
    runCatching { callback?.onCustomViewHidden() }
    return true
  }

  /**
   * Drop this tab.
   *
   * The WebView leaves its parent before `destroy()`: destroying one that is still
   * attached to the window is not allowed and takes the process down with it.
   */
  fun destroy() {
    if (destroyed) return
    destroyed = true
    hideFullscreen()

    val web = webView ?: return
    webView = null
    cosmeticScripts.values.forEach { runCatching { it.remove() } }
    cosmeticScripts.clear()
    web.stopLoading()
    // A private or Tor tab's HTTP cache is its profile's, so it goes with the tab.
    if (isPrivate || isTor) runCatching { web.clearCache(true) }
    (web.parent as? ViewGroup)?.removeView(web)
    // One tab's teardown must not take the browser with it: a WebView that is unhappy
    // throws from here, and that is a leak, not a reason to kill the process.
    runCatching { web.destroy() }
  }

  /**
   * Grab what this tab currently looks like, scaled down and JPEG-encoded for the
   * switcher. Only meaningful while the view is visible, which is why the tab manager
   * captures *before* hiding a tab.
   */
  fun capture(onCaptured: (String?) -> Unit) {
    val web = webView
    if (web == null || web.width == 0 || web.height == 0) {
      onCaptured(null)
      return
    }

    val activity = container.context as? Activity
    if (activity == null) {
      onCaptured(null)
      return
    }

    // PixelCopy has no View overload on this SDK: copy the rectangle the view occupies
    // out of the window instead.
    val location = IntArray(2)
    web.getLocationInWindow(location)
    val source = Rect(location[0], location[1], location[0] + web.width, location[1] + web.height)
    val full = Bitmap.createBitmap(source.width(), source.height(), Bitmap.Config.ARGB_8888)
    try {
      PixelCopy.request(
        activity.window,
        source,
        full,
        { result ->
          if (result != PixelCopy.SUCCESS) {
            onCaptured(null)
            return@request
          }
          val small = Bitmap.createScaledBitmap(
            full,
            (web.width / 3).coerceAtLeast(1),
            (web.height / 3).coerceAtLeast(1),
            true,
          )
          val bytes = ByteArrayOutputStream()
          small.compress(Bitmap.CompressFormat.JPEG, 45, bytes)
          onCaptured("data:image/jpeg;base64," + Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP))
        },
        Handler(Looper.getMainLooper()),
      )
    } catch (error: Throwable) {
      onCaptured(null)
    }
  }

  @SuppressLint("SetJavaScriptEnabled")
  private fun create(): WebView {
    val web = WebView(container.context)

    // Before anything else touches it: a profile cannot be chosen once a WebView is in
    // use. Normal tabs stay on the default profile.
    if (isTor) Profiles.apply(web, Profiles.TOR)
    else if (isPrivate) Profiles.apply(web, Profiles.PRIVATE)

    web.settings.apply {
      javaScriptEnabled = true
      domStorageEnabled = true
      databaseEnabled = true
      setSupportMultipleWindows(true)
      mediaPlaybackRequiresUserGesture = false
      mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
      userAgentString = "$userAgentString NostrNavigator/${BuildConfig.VERSION_NAME}"
      mobileAgent = userAgentString
      setSupportZoom(true)
      builtInZoomControls = true
      displayZoomControls = false
    }
    // Use Android's credential providers for ordinary browsing. Keep private and Tor
    // surfaces isolated from the persistent system credential store. Conditional UI
    // is not supported by Android WebView, but explicit create/get ceremonies are.
    if (!isPrivate && !isTor && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_AUTHENTICATION)) {
      WebSettingsCompat.setWebAuthenticationSupport(
        web.settings,
        WebSettingsCompat.WEB_AUTHENTICATION_SUPPORT_FOR_BROWSER,
      )
    }
    CookieManager.getInstance().setAcceptThirdPartyCookies(web, nativeProtectionLevel() != 2)

    web.setFindListener { active, total, _ ->
      emit(JSONObject().put("type", "find").put("current", if (total == 0) 0 else active + 1).put("total", total))
    }

    web.webChromeClient = object : WebChromeClient() {
      override fun onCreateWindow(
        view: WebView,
        isDialog: Boolean,
        isUserGesture: Boolean,
        resultMsg: android.os.Message,
      ): Boolean {
        if (!isUserGesture || destroyed) return false

        // A dialog-styled popup is the pattern most OAuth/payment sign-in buttons use
        // for window.open(); keep the transport's WebView as the actual popup content
        // instead of reading its destination and reopening that URL in an unrelated
        // tab below, so the opener's window.opener (and so a postMessage-based
        // handoff back to it once sign-in finishes) keeps working.
        if (isDialog) {
          val transport = resultMsg.obj as? WebView.WebViewTransport ?: return false
          val popupWeb = onOpenPopupWindow() ?: return false
          transport.webView = popupWeb
          resultMsg.sendToTarget()
          return true
        }

        // WebView does not open target="_blank" links by itself. Give it a short-lived
        // child surface to learn the destination, then hand that URL to the tab manager.
        // The page never gets to keep a second unmanaged WebView around.
        val popup = WebView(container.context)
        popup.visibility = View.INVISIBLE
        container.addView(
          popup,
          ViewGroup.LayoutParams(1, 1),
        )
        popup.settings.javaScriptEnabled = true
        popup.webViewClient = object : WebViewClient() {
          private var handled = false

          private fun consume(url: String?): Boolean {
            val target = url ?: return false
            if (handled || target == "about:blank") return false
            handled = true
            openWindowTarget(target)
            popup.post {
              popup.stopLoading()
              (popup.parent as? ViewGroup)?.removeView(popup)
              popup.destroy()
            }
            return true
          }

          override fun shouldOverrideUrlLoading(
            view: WebView,
            request: WebResourceRequest,
          ): Boolean {
            return request.isForMainFrame && consume(request.url.toString())
          }

          override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            consume(url)
          }
        }

        val transport = resultMsg.obj as? WebView.WebViewTransport ?: run {
          (popup.parent as? ViewGroup)?.removeView(popup)
          popup.destroy()
          return false
        }
        transport.webView = popup
        resultMsg.sendToTarget()
        return true
      }

      // JS called window.close() on a popup opened above (e.g. an OAuth dialog closing
      // itself once sign-in finishes). Android WebView has no owner that reacts to this
      // on its own, so left unhandled the tab just sits there instead of closing.
      override fun onCloseWindow(window: WebView) {
        emit(JSONObject().put("type", "close-requested"))
      }

      // HTML5 / embedded-player fullscreen: the WebView hands over a view that must be
      // shown by the host. Without this the page goes fullscreen into nothing (black).
      override fun onShowCustomView(view: View, callback: CustomViewCallback) {
        showFullscreen(view, callback)
      }

      override fun onHideCustomView() {
        hideFullscreen()
      }

      override fun onProgressChanged(view: WebView, newProgress: Int) {
        emit(JSONObject().put("type", "progress").put("value", newProgress))
      }

      override fun onGeolocationPermissionsShowPrompt(origin: String, callback: android.webkit.GeolocationPermissions.Callback) {
        val key = "$origin|location"
        sitePermissionDecisions[key]?.let { callback.invoke(origin, it, true); return }
        Handler(Looper.getMainLooper()).post {
          AlertDialog.Builder(container.context)
            .setTitle("Site location permission")
            .setMessage("$origin wants to use your location.")
            .setPositiveButton("Allow for this tab") { _, _ ->
              val activity = container.context as? Activity
              if (activity == null) { callback.invoke(origin, false, false); return@setPositiveButton }
              val needs = arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
                .filter { activity.checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }.toTypedArray()
              if (needs.isEmpty()) { sitePermissionDecisions[key] = true; callback.invoke(origin, true, true) }
              else PermissionRequestBridge.request(activity, needs) { granted ->
                sitePermissionDecisions[key] = granted
                callback.invoke(origin, granted, true)
              }
            }
            .setNegativeButton("Block") { _, _ ->
              sitePermissionDecisions[key] = false
              callback.invoke(origin, false, true)
            }
            .setOnCancelListener { callback.invoke(origin, false, false) }
            .show()
        }
      }

      override fun onPermissionRequest(request: PermissionRequest) {
        val origin = request.origin.toString()
        if (request.resources.any { it != PermissionRequest.RESOURCE_VIDEO_CAPTURE && it != PermissionRequest.RESOURCE_AUDIO_CAPTURE }) {
          request.deny()
          return
        }
        val resources = request.resources.joinToString(",")
        val key = "$origin|$resources"
        sitePermissionDecisions[key]?.let { if (it) request.grant(request.resources) else request.deny(); return }
        Handler(Looper.getMainLooper()).post {
          AlertDialog.Builder(container.context)
            .setTitle("Site permission")
            .setMessage("$origin wants access to ${resources.replace('_', ' ').lowercase()}.")
            .setPositiveButton("Allow for this tab") { _, _ ->
              val activity = container.context as? Activity
              if (activity == null) { request.deny(); return@setPositiveButton }
              val needs = buildList {
                if (request.resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) add(Manifest.permission.CAMERA)
                if (request.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) add(Manifest.permission.RECORD_AUDIO)
              }.distinct()
              val missing = needs.filter { activity.checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }.toTypedArray()
              val grant = {
                sitePermissionDecisions[key] = true
                request.grant(request.resources)
              }
              if (missing.isEmpty()) grant()
              else PermissionRequestBridge.request(activity, missing) { granted ->
                sitePermissionDecisions[key] = granted
                if (granted) grant() else request.deny()
              }
            }
            .setNegativeButton("Block") { _, _ ->
              sitePermissionDecisions[key] = false
              request.deny()
            }
            .setOnCancelListener { request.deny() }
            .show()
        }
      }

      /**
       * The page's own favicon, shrunk to something a tile or a tab card can carry.
       * The shell keeps it per service, so it outlives the tab.
       */
      override fun onReceivedIcon(view: WebView, icon: Bitmap) {
        val page = view.url ?: currentUrl ?: return
        if (faviconPageKey(page) == refreshedFaviconPage) return
        val size = 96
        val scale = size.toFloat() / maxOf(icon.width, icon.height).coerceAtLeast(1)
        val small = if (scale < 1f) {
          Bitmap.createScaledBitmap(
            icon,
            (icon.width * scale).toInt().coerceAtLeast(1),
            (icon.height * scale).toInt().coerceAtLeast(1),
            true,
          )
        } else {
          icon
        }
        val bytes = ByteArrayOutputStream()
        small.compress(Bitmap.CompressFormat.PNG, 100, bytes)
        emit(
          JSONObject()
            .put("type", "icon")
            .put("url", page)
            .put("icon", "data:image/png;base64," + Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP)),
        )
      }
    }

    // A file the WebView will not render becomes a download through the proxy, because
    // this process cannot resolve the virtual host itself.
    web.setDownloadListener { url, _, contentDisposition, mimeType, _ ->
      onDownload(url, mimeType, contentDisposition)
    }

    installPasswordBridge(web)
    installPaymentBridge(web)
    installFaviconRefreshBridge(web)
    installNip07(web)
    installPasskeyBridge(web)

    web.webViewClient = object : WebViewClient() {
      /**
       * Tor tabs must not reach the clearnet. A document the proxy rewrote is
       * confined by its policy, but a page can still ask for something the rewriter
       * never saw, so the request itself is refused here.
       */
      override fun shouldInterceptRequest(
        view: WebView,
        request: WebResourceRequest,
      ): WebResourceResponse? {
        val requestedUrl = request.url.toString()
        val headers = request.requestHeaders
        val sourceUrl = headers.entries.firstOrNull { it.key.equals("referer", ignoreCase = true) }?.value
          ?: currentUrl.orEmpty()
        // Query the browser's Fetch Metadata first: modern ad and video requests often
        // use extensionless URLs, so extension-only classification misses media rules.
        val destination = headers.entries.firstOrNull { it.key.equals("sec-fetch-dest", ignoreCase = true) }?.value?.lowercase()
        val requestType = if (request.isForMainFrame) "document" else when (destination) {
          "script" -> "script"
          "style" -> "stylesheet"
          "image" -> "image"
          "font" -> "font"
          "video", "audio", "track" -> "media"
          "document", "iframe", "frame" -> "subdocument"
          "object", "embed" -> "object"
          else -> when (request.url.path?.substringAfterLast('.', "")?.lowercase()) {
            "js", "mjs" -> "script"
            "css" -> "stylesheet"
            "png", "jpg", "jpeg", "gif", "webp", "svg", "ico" -> "image"
            "woff", "woff2", "ttf", "otf" -> "font"
            "mp4", "webm", "mp3", "m3u8", "m4s", "ts" -> "media"
            else -> "xmlhttprequest"
          }
        }
        val tabKind = if (isPrivate) "private" else if (isTor) "tor" else "normal"
        if (nativeProtectionCheck(requestedUrl, sourceUrl, requestType, request.method ?: "get", tabKind)) {
          emit(JSONObject().put("type", "protection-blocked").put("url", requestedUrl))
          return emptyResponse()
        }
        if (!isTor) return null
        val url = request.url
        return when (url.scheme?.lowercase()) {
          "http", "https" -> {
            // Every document and subresource of a Tor tab is served by this tab's
            // own listener, so the host is a virtual host under `.localhost` and the
            // port is the one the tab was built with. Checking the port matters: the
            // normal listener would fetch NCC content off the clearnet.
            val host = url.host?.lowercase() ?: ""
            val expectedPort = if (isTor) torListenerPort ?: proxyPort() else proxyPort()
            val allowed = host.endsWith(".localhost") && url.port == expectedPort
            if (allowed) null else emptyResponse()
          }
          "data", "blob", "about", "javascript" -> null
          else -> emptyResponse()
        }
      }

      override fun shouldOverrideUrlLoading(
        view: WebView,
        request: WebResourceRequest,
      ): Boolean {
        val url = request.url.toString()

        // A page can link to another service or site. Those carry the label rules that
        // live in Rust, so ask the proxy instead of reimplementing base32 here.
        val scheme = request.url.scheme?.lowercase()
        if (scheme == "ncc" || scheme == "nsite") {
          routeLink(view, url)
          return true
        }

        // In a Tor tab, following a clearnet link would be the leak the whole mode
        // exists to avoid. Refusing it is also what the desktop does.
        if (isTor && (scheme == "http" || scheme == "https")) {
          val host = request.url.host?.lowercase() ?: ""
          // Tor pages use their own listener. Redirects back into that listener must
          // stay in the Tor tab; comparing with the normal proxy port cancels them
          // after the first response and makes HTTPS pages look like they failed.
          val listenerPort = torListenerPort ?: proxyPort()
          val throughThisTab = host.endsWith(".localhost") && request.url.port == listenerPort
          if (!throughThisTab) {
            emit(
              JSONObject()
                .put("type", "blocked")
                .put("url", url)
                .put("reason", "clearnet"),
            )
            return true
          }
        }

        // An onion link in a normal tab cannot be loaded here: this WebView has no
        // Tor. Hand it to the shell, which opens a Tor tab.
        if (!isTor && (scheme == "http" || scheme == "https")) {
          val host = request.url.host?.lowercase() ?: ""
          if (host.endsWith(".onion")) {
            emit(JSONObject().put("type", "onion").put("url", url))
            return true
          }
        }

        if (accepts(url)) {
          prepareCosmeticScript(view, url)
          return false
        }

        // Everything else — mailto:, tel:, intent: — belongs to another app.
        val opened = try {
          container.context.startActivity(
            Intent(Intent.ACTION_VIEW, request.url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
          )
          true
        } catch (error: ActivityNotFoundException) {
          false
        }
        emit(JSONObject().put("type", if (opened) "external" else "blocked").put("url", url))
        return true
      }

      override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: android.net.http.SslError) {
        // Only the proxy's own listener could present a certificate on a `.localhost`
        // host; endpoints are pinned in Rust before anything is served.
        val host = Uri.parse(error.url ?: "").host?.lowercase() ?: ""
        if (host.endsWith(".localhost")) {
          handler.proceed()
        } else {
          val (code, rawError) = when (error.primaryError) {
            android.net.http.SslError.SSL_DATE_INVALID,
            android.net.http.SslError.SSL_EXPIRED,
            android.net.http.SslError.SSL_NOTYETVALID -> "certificate-date-invalid" to "net::ERR_CERT_DATE_INVALID"
            android.net.http.SslError.SSL_IDMISMATCH -> "certificate-name-mismatch" to "net::ERR_CERT_COMMON_NAME_INVALID"
            android.net.http.SslError.SSL_UNTRUSTED -> "certificate-untrusted" to "net::ERR_CERT_AUTHORITY_INVALID"
            else -> "certificate-invalid" to "net::ERR_CERT_INVALID"
          }
          pendingCertificateError = error.url.orEmpty() to "$code|$rawError"
          handler.cancel()
        }
      }

      override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
        if (showingError && url?.startsWith("data:text/html") == true) return
        pendingCertificateError = null
        pendingPasskeys.entries.toList().forEach { (requestId, reply) ->
          pendingPasskeys.remove(requestId)
          reply("{\"handled\":true,\"error\":\"AbortError\"}")
        }
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, nativeProtectionLevel() != 2)
        currentUrl = url
        refreshedFaviconPage = null
        emit(JSONObject().put("type", "loading").put("url", url ?: ""))
      }

      override fun onPageFinished(view: WebView, url: String?) {
        currentUrl = url
        title = view.title
        if (showingError) {
          showingError = false
          return
        }
        emit(
          JSONObject()
            .put("type", "loaded")
            .put("url", url ?: "")
            .put("title", view.title ?: "")
            .put("canGoBack", view.canGoBack())
            .put("canGoForward", view.canGoForward()),
        )

        if (!isPrivate && !isTor && faviconOrigin(url) != null) {
          view.evaluateJavascript(FAVICON_REFRESH_SCRIPT, null)
        }

        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
          val selectors = nativeCosmeticSelectors(url ?: "", tabKind())
          if (selectors.isNotBlank()) {
            val quoted = JSONObject.quote(selectors)
            view.evaluateJavascript("(()=>{const s=$quoted;const a=()=>{try{document.querySelectorAll(s).forEach(e=>e.remove())}catch{}};a();new MutationObserver(a).observe(document.documentElement,{childList:true,subtree:true})})()", null)
          }
        }

        if (PASSWORD_HOOK.isNotBlank() && !isPrivate && !isTor) {
          // Every page, not just NCC ones: clearnet pages are where most logins are,
          // and they do not come through the proxy, so the hook is installed here.
          view.evaluateJavascript(PASSWORD_HOOK, null)
          if (url?.startsWith("https://", true) == true) view.evaluateJavascript(PAYMENT_HOOK, null)
        }
      }

      /**
       * The renderer is a separate process. Letting its death through kills the whole
       * app, which is not what one broken page should be able to do.
       */
      override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
        if (!destroyed) {
          showFailure(
            view,
            currentUrl ?: "",
            if (detail.didCrash()) "This page's renderer crashed." else "The system reclaimed this page's renderer.",
          )
        }
        return true
      }

      override fun onReceivedError(
        view: WebView,
        request: WebResourceRequest,
        error: android.webkit.WebResourceError,
      ) {
        if (!request.isForMainFrame) return
        if (showingError) return
        val detail = "${error.errorCode} ${error.description}"
        currentUrl = request.url.toString()
        val pending = pendingCertificateError?.takeIf { it.first == request.url.toString() }
        pendingCertificateError = null
        val certificate = pending?.second?.split('|', limit = 2)
        val code = certificate?.getOrNull(0)
        val rawError = certificate?.getOrNull(1)
        val certificateMessage = when (code) {
          "certificate-date-invalid" -> "The certificate is outside its valid date range. Check this device’s date and time; if they are correct, the site owner may need to renew the certificate."
          "certificate-name-mismatch" -> "The certificate does not identify this website. Check the address or contact the site owner."
          "certificate-untrusted" -> "The browser could not verify who issued this certificate. The connection was blocked."
          "certificate-revoked" -> "The certificate issuer has withdrawn this certificate. The connection was blocked."
          else -> "The browser could not verify this website’s certificate, so it blocked the connection."
        }
        val payload = JSONObject().put("type", "failed").put("url", request.url.toString()).put("reason", if (rawError != null) rawError else detail)
        if (code != null) payload.put("certificateError", JSONObject().put("code", code).put("rawError", rawError).put("message", certificateMessage))
        emit(payload)
        // Chromium's own error page hides the address that failed, which is the one
        // thing needed to tell a bad address apart from a broken proxy.
        showFailure(view, request.url.toString(), detail, certificateMessage, rawError)
      }
    }

    web.layoutParams = ViewGroup.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.MATCH_PARENT,
    )
    web.visibility = View.GONE
    container.addView(web)

    return web
  }

  /** Resolve an `ncc://` or `nsite://` link through the proxy, then load it. */
  private fun routeLink(view: WebView, url: String) {
    val port = routePort()
    if (port <= 0) {
      emit(JSONObject().put("type", "blocked").put("url", url))
      return
    }

    Thread {
      val resolved = try {
        resolveRoute(port, url)
      } catch (error: Exception) {
        null
      }
      view.post {
        if (destroyed) return@post
        if (resolved != null) {
          prepareCosmeticScript(view, resolved)
          view.loadUrl(resolved)
        } else {
          emit(JSONObject().put("type", "blocked").put("url", url))
        }
      }
    }.apply { isDaemon = true }.start()
  }

  /** Resolve custom addresses before opening a page-requested new tab. */
  private fun openWindowTarget(url: String) {
    val scheme = Uri.parse(url).scheme?.lowercase()
    if (scheme == "ncc" || scheme == "nsite") {
      val port = routePort()
      Thread {
        val resolved = try {
          if (port > 0) resolveRoute(port, url) else null
        } catch (_: Exception) {
          null
        }
        container.post {
          if (destroyed) return@post
          if (resolved != null) {
            onOpenNewWindow(resolved)
          } else {
            emit(JSONObject().put("type", "blocked").put("url", url))
          }
        }
      }.apply { isDaemon = true }.start()
      return
    }

    if (accepts(url)) {
      val host = Uri.parse(url).host?.lowercase() ?: ""
      if (!isTor && host.endsWith(".onion")) {
        emit(JSONObject().put("type", "onion").put("url", url))
      } else {
        onOpenNewWindow(url)
      }
      return
    }

    emit(JSONObject().put("type", "blocked").put("url", url))
  }

  /** The shell port bridge can arrive after the page starts; its current origin is a fallback. */
  private fun routePort(): Int {
    val configured = proxyPort()
    if (configured > 0) return configured
    return Uri.parse(currentUrl.orEmpty()).port.takeIf { it > 0 } ?: 0
  }

  private fun resolveRoute(port: Int, url: String): String? {
    val encoded = URLEncoder.encode(url, "UTF-8")
    val connection = URL("http://127.0.0.1:$port/__ncc/route?u=$encoded").openConnection() as HttpURLConnection
    return try {
      connection.connectTimeout = 5000
      connection.readTimeout = 5000
      if (connection.responseCode != 200) {
        null
      } else {
        val body = connection.inputStream.bufferedReader().use { it.readText() }
        JSONObject(body).optString("url").takeIf { it.isNotEmpty() }
      }
    } catch (error: Exception) {
      null
    } finally {
      connection.disconnect()
    }
  }

  private fun emit(payload: JSONObject) {
    if (destroyed) return
    payload.put("tab", id)
    lastUsed = System.currentTimeMillis()
    report(payload)
  }

  private fun showFailure(view: WebView, url: String, detail: String, certificateMessage: String? = null, rawError: String? = null) {
    if (destroyed) return
    showingError = true
    val safeUrl = escapeHtml(url)
    val html = """
      <!doctype html><meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <meta name="color-scheme" content="light dark">
      <style>
        body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:12vh 24px 24px;
          max-width:34rem;margin-inline:auto}
        h1{font-size:1.4rem;margin:0 0 .5rem}
        p{color:CanvasText;opacity:.75;margin:.25rem 0 1rem}
        code{display:block;padding:.6rem .8rem;border-radius:10px;font-size:.8rem;
          background:color-mix(in srgb,CanvasText 8%,transparent);word-break:break-all}
        a.retry{display:inline-block;margin-top:1.25rem;padding:.8rem 1.6rem;
          border-radius:999px;background:#2457e6;color:#fff;font-weight:600;
          text-decoration:none}
      </style>
      <h1>${if (certificateMessage != null) "Connection blocked" else "This page did not load"}</h1>
      <p>${escapeHtml(certificateMessage ?: "The page could not be reached. If the address below is right, try again in a moment.")}</p>
      <code>$safeUrl</code>
      <p><small>${escapeHtml(rawError ?: detail)}</small></p>
      <a class="retry" href="$safeUrl">Try again</a>
    """.trimIndent()

    view.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
  }

  private fun escapeHtml(text: String): String =
    text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;")
}
