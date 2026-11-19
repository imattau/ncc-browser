export function createPaymentCards({ content, invoke, byId, showPanel, closePanel, getTabs, getActiveUrl, getActiveTabId }) {
  let cards = []
  let pending = null
  let waiting = null
  let authChoice = null
  let unlocked = false
  const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key) ?? JSON.stringify(fallback)) } catch { return fallback } }
  const offerSave = () => read('ncc.payment.offerSave', true) !== false
  const saveCvc = () => read('ncc.payment.saveCvc', false) === true
  const allowNostrAuth = () => read('ncc.payment.allowNostrAuth', false) === true
  const defaultNostrAuth = () => allowNostrAuth() && read('ncc.payment.defaultNostrAuth', false) === true
  function credentialReply(ok) { const fn = waiting; waiting = null; fn?.(ok === true) }
  function authenticate() {
    if (typeof content?.unlockWithDeviceCredential !== 'function') return Promise.resolve(false)
    return new Promise((resolve) => {
      waiting = resolve
      content.unlockWithDeviceCredential('payment-card')
      setTimeout(() => { if (waiting === resolve) { waiting = null; resolve(false) } }, 180000)
    })
  }
  async function hasNostrSigner() {
    try {
      const profiles = await invoke('identity_profiles')
      return Array.isArray(profiles?.identities) && profiles.identities.some((profile) => profile.active)
    } catch { return false }
  }
  async function authorizeNostr(card, url) {
    await invoke('payment_cards_authenticate', {
      site: new URL(url).origin,
      network: card.network || network(card.number),
      last4: card.last4 || String(card.number || '').slice(-4)
    })
    return true
  }
  async function authenticateForFill(card, url) {
    if (!allowNostrAuth()) return authenticate()
    if (defaultNostrAuth()) {
      try { return await authorizeNostr(card, url) }
      catch (error) { byId('payment-note').textContent = String(error); return false }
    }
    if (!await hasNostrSigner()) {
      if (content?.unlockWithDeviceCredential) return authenticate()
      byId('payment-note').textContent = 'Connect a Nostr signer to use Nostr confirmation.'
      return false
    }
    byId('payment-auth-detail').textContent = `${card.network || network(card.number || '')} ending in ${card.last4 || String(card.number || '').slice(-4)} will be filled on ${new URL(url).hostname}.`
    byId('payment-auth-make-default').checked = false
    byId('payment-auth-note').textContent = ''
    byId('payment-auth-system').hidden = !content?.unlockWithDeviceCredential
    showPanel('payment-auth-choice')
    const method = await new Promise((resolve) => { authChoice = resolve })
    if (method === 'system') return authenticate()
    if (method !== 'nostr') return false
    try { return await authorizeNostr(card, url) }
    catch (error) { byId('payment-note').textContent = String(error); return false }
  }
  function chooseAuth(method) {
    if (!authChoice) return
    const resolve = authChoice
    authChoice = null
    if (method === 'nostr' && byId('payment-auth-make-default').checked) {
      localStorage.setItem('ncc.payment.allowNostrAuth', 'true')
      localStorage.setItem('ncc.payment.defaultNostrAuth', 'true')
      byId('payment-allow-nostr').checked = true
      byId('payment-default-nostr').checked = true
    }
    closePanel()
    resolve(method)
  }
  function network(number) {
    if (/^4/.test(number)) return 'Visa'
    if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(number)) return 'Mastercard'
    if (/^3[47]/.test(number)) return 'American Express'
    if (/^6(?:011|5)/.test(number)) return 'Discover'
    return 'Card'
  }
  function validLuhn(number) {
    const digits = String(number || '').replace(/\D/g, '')
    if (!/^\d{12,19}$/.test(digits)) return false
    let total = 0, double = false
    for (let i = digits.length - 1; i >= 0; i--) { let n = Number(digits[i]); if (double) { n *= 2; if (n > 9) n -= 9 } total += n; double = !double }
    return total % 10 === 0
  }
  function row(card, choose = false) {
    const button = document.createElement(choose ? 'button' : 'div')
    button.className = 'row'
    if (choose) button.type = 'button'
    const brand = card.network || network(card.number || '')
    const icon = document.createElement('span'); icon.className = 'row-icon payment-network'; icon.textContent = brand === 'Mastercard' ? 'MC' : brand === 'American Express' ? 'AMEX' : brand === 'Discover' ? 'DISC' : brand === 'Visa' ? 'VISA' : 'CARD'
    const text = document.createElement('span'); text.className = 'row-text'
    const title = document.createElement('b'); title.textContent = card.nickname || card.name || card.network || network(card.number || '')
    const detail = document.createElement('small'); detail.textContent = `${card.network || network(card.number || '')} ···· ${card.last4 || String(card.number || '').slice(-4)} · ${card.expMonth}/${card.expYear}`
    text.append(title, detail); button.append(icon, text)
    if (choose) button.addEventListener('click', () => void fill(card.id))
    else {
      const remove = document.createElement('button')
      remove.className = 'ib'
      remove.type = 'button'
      remove.setAttribute('aria-label', `Remove ${card.network} card ending in ${card.last4}`)
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'i')
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use'); use.setAttribute('href', '#i-trash'); svg.appendChild(use); remove.appendChild(svg)
      remove.addEventListener('click', () => void removeCard(card.id))
      button.appendChild(remove)
    }
    return button
  }
  async function removeCard(id) {
    if (!await authenticate()) { byId('payment-note').textContent = 'Device authentication was cancelled.'; return }
    try { await invoke('payment_cards_remove', { id }); await load() }
    catch (error) { byId('payment-note').textContent = String(error) }
  }
  async function load() {
    byId('payment-offer-save').checked = offerSave()
    byId('payment-save-cvc').checked = saveCvc()
    byId('payment-allow-nostr').checked = allowNostrAuth()
    byId('payment-default-nostr').checked = defaultNostrAuth()
    byId('payment-default-nostr').disabled = !allowNostrAuth()
    try {
      cards = await invoke('payment_cards_list'); unlocked = true
      byId('payment-state').textContent = `${cards.length} saved card${cards.length === 1 ? '' : 's'} · encrypted on this device`
      byId('payment-unlock').hidden = true
      byId('payment-list').replaceChildren(...cards.map((card) => row(card)))
      if (!cards.length) byId('payment-list').textContent = 'No cards saved yet.'
      byId('sub-payment-cards').textContent = `${cards.length} saved`
    } catch (error) {
      unlocked = false; cards = []
      byId('payment-state').textContent = String(error)
      byId('payment-unlock').hidden = false
      byId('payment-list').textContent = ''
      byId('sub-payment-cards').textContent = 'Autofill and save'
    }
  }
  async function unlock() {
    byId('payment-note').textContent = ''
    if (!await authenticate()) { byId('payment-note').textContent = 'Device authentication was cancelled.'; return }
    try { await invoke('payment_cards_unlock'); await load() } catch (error) { byId('payment-note').textContent = String(error) }
  }
  function secureActive(url = getActiveUrl()) {
    const tab = getTabs().find((item) => item.id === getActiveTabId())
    return Boolean(tab && tab.kind === 'normal' && /^https:\/\//i.test(url))
  }
  function showPicker(url) {
    if (!secureActive(url) || !cards.length) return
    byId('payment-picker-site').textContent = new URL(url).hostname
    byId('payment-picker-list').replaceChildren(...cards.map((card) => row(card, true)))
    showPanel('payment-picker')
  }
  async function detect(event) {
    if (!secureActive(event.url)) return
    try { cards = await invoke('payment_cards_list'); unlocked = true } catch { return }
    showPicker(event.url)
  }
  async function fill(id) {
    const tabId = getActiveTabId(), url = getActiveUrl()
    if (!secureActive(url)) return
    const tab = getTabs().find((item) => item.id === tabId)
    if (!tab || tab.kind !== 'normal') return
    try {
      const summary = cards.find((item) => item.id === id)
      if (!summary || getActiveTabId() !== tabId || getActiveUrl() !== url) throw new Error('The payment page changed before the card could be filled.')
      if (!await authenticateForFill(summary, url)) { byId('payment-note').textContent = 'Card confirmation was cancelled.'; closePanel(); return }
      const card = await invoke('payment_cards_get', { id })
      if (!card) throw new Error('That card is unavailable.')
      if (getActiveTabId() !== tabId || getActiveUrl() !== url || !secureActive(url)) throw new Error('The payment page changed before the card could be filled.')
      const cvc = saveCvc() ? card.cvc : undefined
      const payload = { name: card.name, number: card.number, expMonth: card.expMonth, expYear: card.expYear, ...(cvc ? { cvc } : {}) }
      closePanel()
      content.fillPaymentCard(tabId, JSON.stringify(payload), new URL(url).origin)
    } catch (error) { byId('payment-note').textContent = String(error); closePanel() }
  }
  function edit(card = {}) {
    byId('payment-name').value = card.name || ''
    byId('payment-number').value = card.number || ''
    byId('payment-month').value = card.expMonth || ''
    byId('payment-year').value = card.expYear || ''
    byId('payment-cvc').value = card.cvc || ''
    showPanel('payment-edit')
  }
  async function saveCard(card) {
    const number = String(card.number || '').replace(/\D/g, '')
    if (!validLuhn(number)) throw new Error('Enter a valid card number.')
    if (!/^\d{1,2}$/.test(String(card.expMonth || '')) || Number(card.expMonth) < 1 || Number(card.expMonth) > 12) throw new Error('Enter a valid expiry month.')
    if (!/^\d{2}(?:\d{2})?$/.test(String(card.expYear || ''))) throw new Error('Enter a valid expiry year.')
    const expYear = String(card.expYear).length === 2 ? `20${card.expYear}` : String(card.expYear)
    const match = cards.find((item) => item.number === number)
    await invoke('payment_cards_save', { card: { id: match?.id || '', name: String(card.name || '').slice(0, 100), number, ...(saveCvc() && /^\d{3,4}$/.test(card.cvc || '') ? { cvc: card.cvc } : {}), expMonth: String(card.expMonth).padStart(2, '0'), expYear, nickname: '', createdAt: Date.now(), updatedAt: Date.now(), deleted: false }, saveCvc: saveCvc() })
    await load()
  }
  async function capture(event) {
    if (!offerSave() || !secureActive(event.url)) return
    const card = event.card || {}
    card.number = String(card.number || '').replace(/\D/g, '')
    if (!validLuhn(card.number) || !card.expMonth || !card.expYear) return
    pending = card
    const existing = cards.find((item) => item.number === card.number)
    byId('payment-save-title').textContent = existing ? 'Update this card?' : 'Save this card?'
    byId('payment-save-brand').textContent = network(card.number)
    byId('payment-save-brand').dataset.network = network(card.number).toLowerCase().replace(/\s+/g, '-')
    byId('payment-save-detail').textContent = `${network(card.number)} ending in ${card.number.slice(-4)} · ${card.expMonth}/${card.expYear}${saveCvc() && card.cvc ? ' · security code included' : ''}`
    byId('payment-save-accept').textContent = existing ? 'Update card' : 'Save card'
    showPanel('payment-save')
  }
  async function acceptSave() {
    if (!pending) return
    try {
      if (!unlocked) { if (!await authenticate()) throw new Error('Device authentication was cancelled.'); await invoke('payment_cards_unlock'); unlocked = true; cards = await invoke('payment_cards_list') }
      await saveCard(pending); pending = null; closePanel()
    } catch (error) { byId('payment-save-note').textContent = String(error) }
  }
  function wire() {
    byId('payment-unlock').addEventListener('click', () => void unlock())
    byId('payment-add').addEventListener('click', () => edit())
    byId('payment-edit-save').addEventListener('click', async () => {
      byId('payment-edit-note').textContent = ''
      try { if (!unlocked) { if (!await authenticate()) throw new Error('Device authentication was cancelled.'); await invoke('payment_cards_unlock'); unlocked = true; cards = await invoke('payment_cards_list') }
        await saveCard({ name: byId('payment-name').value, number: byId('payment-number').value, expMonth: byId('payment-month').value, expYear: byId('payment-year').value, cvc: byId('payment-cvc').value }); showPanel('payment-cards')
      } catch (error) { byId('payment-edit-note').textContent = String(error) }
    })
    byId('payment-offer-save').addEventListener('change', (e) => localStorage.setItem('ncc.payment.offerSave', JSON.stringify(e.target.checked)))
    byId('payment-save-cvc').addEventListener('change', async (e) => {
      localStorage.setItem('ncc.payment.saveCvc', JSON.stringify(e.target.checked))
      if (!e.target.checked) {
        try {
          if (!unlocked) { if (!await authenticate()) throw new Error('Device authentication was cancelled.'); await invoke('payment_cards_unlock'); unlocked = true }
          await invoke('payment_cards_clear_cvc'); await load()
        } catch (error) {
          e.target.checked = true
          localStorage.setItem('ncc.payment.saveCvc', 'true')
          byId('payment-note').textContent = `Security codes could not be removed: ${String(error)}`
        }
      }
    })
    byId('payment-allow-nostr').addEventListener('change', (e) => {
      localStorage.setItem('ncc.payment.allowNostrAuth', JSON.stringify(e.target.checked))
      if (!e.target.checked) {
        localStorage.setItem('ncc.payment.defaultNostrAuth', 'false')
        byId('payment-default-nostr').checked = false
      }
      byId('payment-default-nostr').disabled = !e.target.checked
    })
    byId('payment-default-nostr').addEventListener('change', (e) => {
      localStorage.setItem('ncc.payment.allowNostrAuth', 'true')
      localStorage.setItem('ncc.payment.defaultNostrAuth', JSON.stringify(e.target.checked))
      byId('payment-allow-nostr').checked = true
    })
    byId('payment-auth-system').addEventListener('click', async () => {
      if (!await authenticate()) { byId('payment-note').textContent = 'Device authentication was cancelled.'; chooseAuth(null); return }
      chooseAuth('system')
    })
    byId('payment-auth-nostr').addEventListener('click', () => chooseAuth('nostr'))
    byId('payment-auth-cancel').addEventListener('click', () => chooseAuth(null))
    byId('payment-picker-close').addEventListener('click', closePanel)
    byId('payment-save-dismiss').addEventListener('click', () => { pending = null; closePanel() })
    byId('payment-save-accept').addEventListener('click', () => void acceptSave())
  }
  return { load, detect, capture, credentialReply, wire }
}
