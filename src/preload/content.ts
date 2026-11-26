import { contextBridge, ipcRenderer, webFrame } from 'electron'
import { TOR_TAB_ARGUMENT, useAnonymousLanguage } from '../shared/tor-identity'
import { installPasswordManager } from './password-manager'
import { installExtensionRuntime } from './extension-content'
import { installExtensionPage } from './extension-page'

/**
 * Content preload for remote pages and extension pages. Web/NCC pages get a NIP-07
 * provider plus the isolated password and extension runtimes; `ncc-ext://` pages get
 * only the extension shim. There is no general IPC bridge and no Node either way.
 */

const isMainFrame = (process as unknown as { isMainFrame?: boolean }).isMainFrame !== false
const isTorTab = process.argv.includes(TOR_TAB_ARGUMENT)

// Frames too, and before any page script runs.
if (isTorTab) contextBridge.executeInMainWorld({ func: useAnonymousLanguage })

if (location.protocol === 'ncc-ext:') {
  if (isMainFrame) installExtensionPage()
} else if (isMainFrame) {
  installExtensionRuntime()
  installPasswordManager()
  // Tor tabs get no passkey bridge: it carries this app's name, and a saved passkey
  // would name its owner.
  if (!isTorTab) installPasskeyBridge()

  const nip04 = {
    encrypt: (peer: string, plaintext: string): Promise<string> =>
      ipcRenderer.invoke('nip07:nip04-encrypt', peer, plaintext),
    decrypt: (peer: string, ciphertext: string): Promise<string> =>
      ipcRenderer.invoke('nip07:nip04-decrypt', peer, ciphertext)
  }

  const nip44 = {
    encrypt: (peer: string, plaintext: string): Promise<string> =>
      ipcRenderer.invoke('nip07:nip44-encrypt', peer, plaintext),
    decrypt: (peer: string, ciphertext: string): Promise<string> =>
      ipcRenderer.invoke('nip07:nip44-decrypt', peer, ciphertext)
  }

  const accountListeners = new Set<(accounts: string[]) => void>()
  ipcRenderer.on('nip07:accounts-changed', (_event, accounts: unknown) => {
    if (!Array.isArray(accounts)) return
    for (const listener of accountListeners) {
      try { listener(accounts as string[]) } catch (error) { console.error('window.nostr accountsChanged listener failed', error) }
    }
  })

  contextBridge.exposeInMainWorld('nostr', {
    getPublicKey: (): Promise<string> => ipcRenderer.invoke('nip07:get-public-key'),
    signEvent: (event: unknown): Promise<unknown> =>
      ipcRenderer.invoke('nip07:sign-event', event),
    getRelays: (): Promise<Record<string, { read: boolean; write: boolean }>> =>
      ipcRenderer.invoke('nip07:get-relays'),
    nip04,
    nip44,
    on: (event: string, listener: (accounts: string[]) => void): void => {
      if (event === 'accountsChanged' && typeof listener === 'function') accountListeners.add(listener)
    },
    off: (event: string, listener: (accounts: string[]) => void): void => {
      if (event === 'accountsChanged') accountListeners.delete(listener)
    }
  })

  contextBridge.exposeInMainWorld('webln', {
    enable: (): Promise<unknown> => ipcRenderer.invoke('nwc:page-info'),
    getInfo: (): Promise<unknown> => ipcRenderer.invoke('nwc:page-info'),
    getBalance: async (): Promise<{ balance: number }> => ({ balance: (await ipcRenderer.invoke('nwc:page-balance') as { balance: number }).balance / 1000 }),
    sendPayment: (paymentRequest: string | { paymentRequest: string }): Promise<unknown> =>
      ipcRenderer.invoke('nwc:page-pay', typeof paymentRequest === 'string' ? paymentRequest : paymentRequest.paymentRequest),
    makeInvoice: (args: { amount: number; defaultDescription?: string }): Promise<unknown> =>
      ipcRenderer.invoke('nwc:page-invoice', args)
  })

  // Lightning payment links are handed to NCC's in-app confirmation instead of an
  // external wallet app. The trusted main process derives the origin from this frame.
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null
    const anchor = target?.closest('a[href]') as HTMLAnchorElement | null
    const hrefInvoice = anchor && /^lightning:/i.test(anchor.href) ? anchor.href.replace(/^lightning:/i, '') : null
    const textInvoice = target?.textContent?.slice(0, 5000).match(/\bln(?:bc|tb|bcrt)[0-9a-z]{20,}/i)?.[0] ?? null
    const invoice = hrefInvoice ?? textInvoice
    if (typeof invoice !== 'string' || !/^ln(?:bc|tb|bcrt)[0-9a-z]+$/i.test(invoice)) return
    if (hrefInvoice) event.preventDefault()
    void ipcRenderer.invoke('nwc:page-pay', invoice).catch(() => undefined)
  }, true)
}

/** Route a page's WebAuthn requests to the passkeys saved in this browser. */
function installPasskeyBridge(): void {
  contextBridge.exposeInMainWorld('__nccWebAuthn', {
    canHandle: (operation: string, options: unknown) => ipcRenderer.sendSync('ncc:webauthn-can-handle', operation, options),
    hasPasskeys: () => ipcRenderer.sendSync('ncc:webauthn-available'),
    authenticatorAvailable: () => ipcRenderer.sendSync('ncc:webauthn-authenticator-available'),
    candidates: (options: unknown) => ipcRenderer.invoke('ncc:webauthn-candidates', options),
    create: (options: unknown) => ipcRenderer.invoke('ncc:webauthn-create', options),
    get: (options: unknown, requestId: string, selectedCredentialId?: string) => ipcRenderer.invoke('ncc:webauthn-get', { options, requestId, selectedCredentialId }),
    cancel: (requestId: string) => ipcRenderer.send('ncc:webauthn-cancel', requestId)
  })
  void webFrame.executeJavaScript(`(() => {
    const bridge = window.__nccWebAuthn;
    if (!bridge || !navigator.credentials) return;
    const credentials = navigator.credentials;
    const nativeCreate = credentials.create.bind(credentials);
    const nativeGet = credentials.get.bind(credentials);
    const credentialApi = window.PublicKeyCredential;
    const nativeConditionalAvailable = credentialApi?.isConditionalMediationAvailable?.bind(credentialApi);
    const nativePlatformAvailable = credentialApi?.isUserVerifyingPlatformAuthenticatorAvailable?.bind(credentialApi);
    const nativeGetClientCapabilities = credentialApi?.getClientCapabilities?.bind(credentialApi);
    const encode = (v) => {
      if (v instanceof ArrayBuffer) v = new Uint8Array(v);
      if (ArrayBuffer.isView(v)) v = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      if (!(v instanceof Uint8Array)) return '';
      let s = ''; for (const b of v) s += String.fromCharCode(b);
      return btoa(s).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/g, '');
    };
    const decode = (s) => {
      const raw = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4));
      const out = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i); return out.buffer;
    };
    const pack = (o) => ({
      ...o, challenge: encode(o.challenge),
      user: o.user ? { ...o.user, id: encode(o.user.id) } : undefined,
      excludeCredentials: o.excludeCredentials?.map((c) => ({ ...c, id: encode(c.id) })),
      allowCredentials: o.allowCredentials?.map((c) => ({ ...c, id: encode(c.id) }))
    });
    const conditionalRequests = new Set();
    let suggestionHost = null;
    const isWebauthnUsername = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const input = element instanceof HTMLInputElement ? element : element.querySelector?.('input');
      const tokens = (element.getAttribute('autocomplete') || input?.getAttribute('autocomplete') || '').toLowerCase().split(/\\s+/);
      return tokens.includes('webauthn') && (tokens.includes('username') || input?.type === 'text' || input?.type === 'email' || element.tagName.toLowerCase().includes('text-field'));
    };
    const hideSuggestions = () => { if (suggestionHost) suggestionHost.hidden = true; };
    const showSuggestions = async (element) => {
      if (!isWebauthnUsername(element)) { hideSuggestions(); return; }
      const request = [...conditionalRequests].find((item) => !item.settled);
      if (!request) { hideSuggestions(); return; }
      if (!suggestionHost) {
        suggestionHost = document.createElement('div');
        suggestionHost.id = 'ncc-passkey-suggestions';
        suggestionHost.style.cssText = 'position:fixed;z-index:2147483647;display:block;';
        const shadow = suggestionHost.attachShadow({ mode: 'open' });
        shadow.innerHTML = '<style>:host{font:13px system-ui;color:#1f2937}.box{min-width:250px;max-width:360px;background:#fff;border:1px solid #cbd5e1;border-radius:10px;box-shadow:0 8px 28px #0004;padding:5px}.title{font-size:11px;color:#64748b;padding:7px 9px 4px}.item{display:block;width:100%;border:0;background:transparent;text-align:left;padding:9px;border-radius:7px;color:inherit;cursor:pointer}.item:hover,.item:focus{background:#eff6ff;outline:none}.name{font-weight:600}.site{font-size:11px;color:#64748b;margin-top:2px}</style><div class="box" role="listbox" aria-label="Passkeys"><div class="title">Passkeys in NCC</div><div class="items"></div></div>';
        document.documentElement.append(suggestionHost);
      }
      const rect = element.getBoundingClientRect();
      suggestionHost.style.left = Math.max(4, Math.min(rect.left, innerWidth - 370)) + 'px';
      suggestionHost.style.top = Math.max(4, Math.min(rect.bottom, innerHeight - 280)) + 'px';
      const items = suggestionHost.shadowRoot.querySelector('.items');
      items.replaceChildren();
      if (request.available) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'item';
        button.setAttribute('role', 'option');
        const name = document.createElement('div');
        name.className = 'name';
        name.textContent = 'Use a passkey';
        const detail = document.createElement('div');
        detail.className = 'site';
        detail.textContent = request.site;
        button.append(name, detail);
        button.addEventListener('pointerdown', (event) => event.preventDefault());
        button.addEventListener('click', () => {
          hideSuggestions();
          void request.select();
        });
        items.append(button);
      }
      suggestionHost.hidden = !request.available;
    };
    document.addEventListener('focusin', (event) => {
      const field = event.composedPath?.().find(isWebauthnUsername) || event.target;
      void showSuggestions(field);
    }, true);
    document.addEventListener('focusout', () => setTimeout(() => {
      if (!suggestionHost?.shadowRoot.activeElement) hideSuggestions();
    }, 150), true);
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') hideSuggestions(); }, true);
    window.addEventListener('resize', hideSuggestions, true);
    window.addEventListener('scroll', hideSuggestions, true);
    const abortError = () => new DOMException('The operation was aborted', 'AbortError');
    const startVaultGet = async (publicKey, candidate, signal) => {
      const requestId = crypto.randomUUID();
      if (signal?.aborted) throw abortError();
      const onAbort = () => bridge.cancel(requestId);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      try {
        const result = await bridge.get(publicKey, requestId, candidate?.id);
        if (signal?.aborted) throw abortError();
        if (!result?.handled) return null;
        if (result.error) throw new DOMException(result.error, 'NotAllowedError');
        return makeCredential(result.response, false);
      } finally { signal?.removeEventListener('abort', onAbort); }
    };
    const makeResponse = (v, creation) => {
      const bytes = (name) => decode(v[name]);
      const response = Object.create(creation ? AuthenticatorAttestationResponse.prototype : AuthenticatorAssertionResponse.prototype);
      Object.defineProperties(response, {
        clientDataJSON: { value: bytes('clientDataJSON'), enumerable: true },
        ...(creation ? {
          attestationObject: { value: bytes('attestationObject'), enumerable: true },
          getTransports: { value: () => ['internal'] },
          getPublicKey: { value: () => bytes('publicKey') },
          getPublicKeyAlgorithm: { value: () => -7 }
        } : {
          authenticatorData: { value: bytes('authenticatorData'), enumerable: true },
          signature: { value: bytes('signature'), enumerable: true },
          userHandle: { value: v.userHandle ? bytes('userHandle') : null, enumerable: true }
        })
      });
      return response;
    };
    const makeCredential = (v, creation) => {
      const result = Object.create(PublicKeyCredential.prototype);
      const response = makeResponse(v, creation);
      Object.defineProperties(result, {
        id: { value: v.id, enumerable: true }, rawId: { value: decode(v.rawId), enumerable: true },
        type: { value: 'public-key', enumerable: true }, response: { value: response, enumerable: true },
        authenticatorAttachment: { value: 'platform', enumerable: true },
        getClientExtensionResults: { value: () => ({}), enumerable: true },
        toJSON: { value: () => ({
          id: v.id,
          rawId: v.rawId,
          type: 'public-key',
          authenticatorAttachment: 'platform',
          clientExtensionResults: {},
          response: creation ? {
            clientDataJSON: encode(response.clientDataJSON),
            attestationObject: encode(response.attestationObject),
            transports: ['internal']
          } : {
            clientDataJSON: encode(response.clientDataJSON),
            authenticatorData: encode(response.authenticatorData),
            signature: encode(response.signature),
            userHandle: v.userHandle ? encode(response.userHandle) : null
          }
        }) }
      });
      return result;
    };
    Object.defineProperty(credentials, 'create', { configurable: true, value: async (options) => {
      if (!options?.publicKey) return nativeCreate(options);
      const packed = pack(options.publicKey);
      if (!bridge.canHandle('create', packed)) return nativeCreate(options);
      const result = await bridge.create(packed);
      if (!result?.handled) return nativeCreate(options);
      if (result.error) throw new DOMException(result.error === 'InvalidStateError' ? 'Credential already exists' : result.error, result.error === 'InvalidStateError' ? 'InvalidStateError' : 'NotAllowedError');
      return makeCredential(result.response, true);
    }});
    Object.defineProperty(credentials, 'get', { configurable: true, value: async (options) => {
      if (!options?.publicKey) return nativeGet(options);
      const packed = pack(options.publicKey);
      if (options.mediation === 'conditional') {
        if (options.signal?.aborted) throw abortError();
        let candidates;
        try { candidates = await bridge.candidates(packed); } catch { return nativeGet(options); }
        if (options.signal?.aborted) throw abortError();
        if (!candidates) return nativeGet(options);
        return new Promise((resolve, reject) => {
          const request = {
            available: candidates,
            site: location.hostname,
            settled: false,
            select: async () => {
              if (request.settled) return;
              request.settled = true;
              conditionalRequests.delete(request);
              try {
                const credential = await startVaultGet(packed, undefined, options.signal);
                if (!credential) { resolve(await nativeGet(options)); return; }
                resolve(credential);
              } catch (error) { reject(error); }
            }
          };
          const onAbort = () => {
            if (request.settled) return;
            request.settled = true;
            conditionalRequests.delete(request);
            hideSuggestions();
            reject(abortError());
          };
          request.removeAbort = () => options.signal?.removeEventListener('abort', onAbort);
          options.signal?.addEventListener('abort', onAbort, { once: true });
          conditionalRequests.add(request);
          const active = document.activeElement;
          if (isWebauthnUsername(active)) void showSuggestions(active);
          // Once selected, the approval prompt is active; remove the conditional
          // abort handler and let startVaultGet cancel the in-flight IPC request.
          const originalSelect = request.select;
          request.select = async () => {
            request.removeAbort();
            await originalSelect();
          };
        });
      }
      if (!bridge.canHandle('get', packed)) return nativeGet(options);
      const credential = await startVaultGet(packed, undefined, options.signal);
      return credential ?? nativeGet(options);
    }});
    if (credentialApi) {
      // Current passkey integrations (including Google's form-autofill
      // example) feature-detect conditional requests through this capability
      // dictionary. Keep native capabilities and advertise conditionalGet
      // when the NCC vault can act as a discoverable-credential provider.
      if (nativeGetClientCapabilities || bridge.hasPasskeys()) {
        Object.defineProperty(credentialApi, 'getClientCapabilities', { configurable: true, value: async () => {
          const native = nativeGetClientCapabilities ? await nativeGetClientCapabilities() : {};
          const hasPasskeys = bridge.hasPasskeys();
          const authenticatorAvailable = bridge.authenticatorAvailable() || hasPasskeys;
          return {
            ...native,
            ...(hasPasskeys ? { conditionalGet: true } : {}),
            ...(authenticatorAvailable ? { passkeyPlatformAuthenticator: true, userVerifyingPlatformAuthenticator: true } : {})
          };
        }});
      }
      Object.defineProperty(credentialApi, 'isConditionalMediationAvailable', { configurable: true, value: async () =>
        bridge.hasPasskeys() || (nativeConditionalAvailable ? await nativeConditionalAvailable() : false)
      });
      Object.defineProperty(credentialApi, 'isUserVerifyingPlatformAuthenticatorAvailable', { configurable: true, value: async () =>
        bridge.authenticatorAvailable() || bridge.hasPasskeys() || (nativePlatformAvailable ? await nativePlatformAvailable() : false)
      });
    }
  })()`).catch(() => undefined)
}
