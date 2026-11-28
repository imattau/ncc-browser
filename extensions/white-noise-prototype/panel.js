const defaults = { relays: ['wss://relay.eu.whitenoise.chat', 'wss://relay.us.whitenoise.chat', 'wss://relay.damus.io', 'wss://relay.primal.net', 'wss://relay.ditto.pub'], useBrowserIdentity: false }
const previousDefaults = [
  ['wss://relay.damus.io', 'wss://relay.primal.net', 'wss://nos.lol'],
  ['wss://relay.damus.io', 'wss://nos.lol']
]
const $ = (id) => document.getElementById(id)
const mainView = $('mainView')
const settingsView = $('settingsView')
let connection = null
let connectionAttempt = false
let groups = []
let activeGroup = null
let liveConnection = null
let selectedRelays = defaults.relays
let groupRefreshTimer = null

function setStatus(text, connected = false) {
  $('statusText').textContent = text
  $('statusDot').classList.toggle('connected', connected)
}

function message(text, error = false) {
  $('message').textContent = text
  $('message').classList.toggle('error', error)
}

function showSettings() { mainView.classList.add('hidden'); settingsView.classList.remove('hidden') }
function showMain() { settingsView.classList.add('hidden'); mainView.classList.remove('hidden') }

async function load() {
  const saved = await chrome.storage.local.get(defaults)
  const savedRelays = saved.relays || defaults.relays
  selectedRelays = previousDefaults.some(relays => sameRelays(savedRelays, relays))
    ? defaults.relays
    : savedRelays.map(relay => relay === 'wss://nos.lol' ? 'wss://relay.ditto.pub' : relay)
  if (!sameRelays(selectedRelays, savedRelays)) await chrome.storage.local.set({ relays: selectedRelays })
  $('relayInput').value = selectedRelays.join('\n')
  $('useBrowserIdentity').checked = Boolean(saved.useBrowserIdentity)
  $('accountName').textContent = connection ? 'NCC signer connected' : 'Not connected'
  $('accountKey').textContent = connection ? `${connection.pubkey.slice(0, 12)}…${connection.pubkey.slice(-8)}` : 'Connect the NCC signer to begin'
  $('connectButton').textContent = connection ? 'Connected' : 'Connect NCC signer'
  $('connectButton').disabled = Boolean(connection || connectionAttempt)
  if (connection) setStatus('Relay session active', true)
  else setStatus('Not connected')
  renderGroups()
}

function sameRelays(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every(relay => right.includes(relay))
}

function renderGroups(filter = '') {
  const list = $('chatList')
  list.replaceChildren()
  const query = filter.trim().toLowerCase()
  const matching = groups.filter(group => (group.name || 'Untitled group').toLowerCase().includes(query))
  if (!matching.length) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    const title = query ? 'No chats match your search' : connection ? 'No conversations yet' : 'Connect to get started'
    const description = query ? 'Try a different name.' : connection ? 'Create a key package so contacts can invite you to an encrypted group.' : 'Connect the NCC signer to load your Marmot conversations.'
    empty.innerHTML = `<div class="empty-icon">◌</div><strong>${title}</strong><p>${description}</p>`
    if (connection && !query) {
      const button = document.createElement('button')
      button.className = 'primary'
      button.textContent = 'Create invite key package'
      button.addEventListener('click', () => void publishKeyPackage())
      empty.append(button)
    } else {
      const button = document.createElement('button')
      button.className = 'primary'
      button.textContent = 'Connect NCC signer'
      button.addEventListener('click', () => void connect())
      empty.append(button)
    }
    list.append(empty)
    return
  }
  for (const group of matching) {
    const row = document.createElement('button')
    row.className = 'chat-row'
    row.innerHTML = `<span class="chat-avatar">${escapeHtml((group.name || 'W').slice(0, 1).toUpperCase())}</span><span class="chat-copy"><strong>${escapeHtml(group.name || 'Untitled group')}</strong><small>${group.memberCount || 1} members · epoch ${group.epoch ?? '—'}</small><span class="last-message"></span></span>`
    if (group.last) row.querySelector('.last-message').textContent = group.last.content.slice(0, 48)
    row.addEventListener('click', () => openGroup(group))
    list.append(row)
  }
}

function escapeHtml(value) {
  const span = document.createElement('span')
  span.textContent = value
  return span.innerHTML
}

async function refreshGroups() {
  if (!connection) return
  const loaded = await window.MarmotCompanion.listGroups(connection.client)
  groups = await Promise.all(loaded.map(async group => {
    const history = await window.MarmotCompanion.history(group)
    group.on('changed', () => void refreshGroups())
    group.history.on('rumor', () => { void refreshGroups(); if (activeGroup?.id === group.snapshot.id) void showMessages(group) })
    return { id: group.snapshot.id, name: group.snapshot.groupData?.name || 'Encrypted group', memberCount: group.snapshot.members?.length, epoch: String(group.snapshot.epoch ?? '—'), instance: group, last: history[0] }
  }))
  renderGroups($('search').value)
}

async function connect() {
  if (connection || connectionAttempt) return
  connectionAttempt = true
  await load()
  setStatus('Requesting signer approval…')
  try {
    const configured = $('relayInput').value.split(/\r?\n/).map(value => value.trim()).filter(Boolean)
    if (!configured.length) throw new Error('Add at least one relay in Settings first.')
    const relays = [...new Set(configured.map(value => {
      const url = new URL(value)
      if (url.protocol !== 'wss:' || !['relay.eu.whitenoise.chat', 'relay.us.whitenoise.chat', 'relay.damus.io', 'relay.primal.net', 'relay.ditto.pub'].includes(url.hostname) || url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error(`Relay host is not permitted by this prototype: ${url.hostname}`)
      return url.toString().replace(/\/$/, '')
    }))]
    const runtime = await window.MarmotCompanion.connect(relays)
    connection = { ...runtime, relays }
    liveConnection = runtime.live
    await refreshGroups()
    if (groupRefreshTimer) clearInterval(groupRefreshTimer)
    groupRefreshTimer = setInterval(() => { void refreshGroups() }, 5000)
    setStatus(`Connected · ${relays.length} relays`, true)
    message('Signer approved. Marmot client loaded and listening for group traffic.')
  } catch (error) {
    setStatus('Connection failed')
    message(error?.message || String(error), true)
  } finally {
    connectionAttempt = false
    await load()
  }
}

async function publishKeyPackage() {
  if (!connection) return
  const button = $('newChat')
  button.disabled = true
  try {
    message('Publishing an invite key package. NCC will ask you to approve the Nostr signature.')
    const entry = await window.MarmotCompanion.createKeyPackage(connection.client, connection.relays)
  message('Invite key package published. Share your public key with a contact so they can invite you.')
  } catch (error) { message(error?.message || String(error), true) }
  finally { button.disabled = false }
}

async function showMessages(group) {
  const history = await window.MarmotCompanion.history(group.instance)
  const list = $('messageList')
  list.replaceChildren()
  if (!history.length) {
    const empty = document.createElement('p')
    empty.className = 'field-hint'
    empty.textContent = 'No messages yet. Messages are end-to-end encrypted with MLS.'
    list.append(empty)
    return
  }
  for (const rumor of [...history].reverse()) {
    const row = document.createElement('article')
    row.className = 'message-bubble'
    row.innerHTML = `<strong>${rumor.pubkey === connection.pubkey ? 'You' : escapeHtml(rumor.pubkey.slice(0, 12) + '…')}</strong><p></p><time>${new Date(rumor.created_at * 1000).toLocaleString()}</time>`
    row.querySelector('p').textContent = rumor.content
    list.append(row)
  }
  list.scrollTop = list.scrollHeight
}

async function openGroup(group) {
  activeGroup = group
  $('conversationTitle').textContent = group.name || 'Encrypted group'
  $('conversationView').classList.remove('hidden')
  mainView.classList.add('hidden')
  await showMessages(group)
}

$('settingsButton').addEventListener('click', showSettings)
$('closeButton').addEventListener('click', () => void ncc.runtime.closePanel())
const resizeHandle = $('resizeHandle')
let resizeStartX = 0
let resizeStartWidth = 0
function finishPanelResize(event) {
  if (event && resizeHandle.hasPointerCapture(event.pointerId)) resizeHandle.releasePointerCapture(event.pointerId)
  resizeHandle.classList.remove('dragging')
}
resizeHandle.addEventListener('pointerdown', event => {
  if (event.button !== 0) return
  event.preventDefault()
  resizeStartX = event.screenX
  resizeStartWidth = window.innerWidth
  resizeHandle.setPointerCapture(event.pointerId)
  resizeHandle.classList.add('dragging')
})
resizeHandle.addEventListener('pointermove', event => {
  if (!resizeHandle.hasPointerCapture(event.pointerId)) return
  void ncc.runtime.setPanelWidth(resizeStartWidth + resizeStartX - event.screenX)
})
resizeHandle.addEventListener('pointerup', finishPanelResize)
resizeHandle.addEventListener('pointercancel', finishPanelResize)
resizeHandle.addEventListener('lostpointercapture', () => resizeHandle.classList.remove('dragging'))
resizeHandle.addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return
  event.preventDefault()
  void ncc.runtime.setPanelWidth(window.innerWidth + (event.key === 'ArrowLeft' ? 20 : -20))
})
$('setupButton').addEventListener('click', showSettings)
$('backButton').addEventListener('click', showMain)
$('connectButton').addEventListener('click', () => void connect())
$('connectButtonSettings').addEventListener('click', () => { showMain(); void connect() })
$('newChat').addEventListener('click', () => void publishKeyPackage())
$('newChat').addEventListener('contextmenu', event => { event.preventDefault(); $('createGroupForm').classList.toggle('hidden') })
$('createGroupButton').addEventListener('click', async () => {
  if (!connection) { message('Connect the NCC signer first.', true); return }
  const name = $('groupName').value.trim()
  if (!name) { message('Enter a group name.', true); return }
  $('createGroupButton').disabled = true
  try {
    message(`Creating “${name}” and publishing the initial encrypted note… NCC will ask you to approve signatures.`)
    const group = await window.MarmotCompanion.createGroup(connection.client, connection.relays, name)
    $('createGroupForm').classList.add('hidden')
    await refreshGroups()
    const entry = groups.find(item => item.id === group.snapshot.id)
    if (entry) await openGroup(entry)
    message('Group created and initial note sent through MLS.')
  } catch (error) { message(error?.message || String(error), true) }
  finally { $('createGroupButton').disabled = false }
})
$('backConversation').addEventListener('click', () => { $('conversationView').classList.add('hidden'); showMain() })
$('plusButton').addEventListener('click', () => {
  const menu = $('composerMenu')
  const open = menu.classList.toggle('hidden') === false
  $('plusButton').setAttribute('aria-expanded', String(open))
})
$('inviteContactButton').addEventListener('click', () => {
  $('composerMenu').classList.add('hidden')
  $('plusButton').setAttribute('aria-expanded', 'false')
  $('inviteForm').classList.remove('hidden')
  $('contactAddress').focus()
})
$('cancelInvite').addEventListener('click', () => $('inviteForm').classList.add('hidden'))
$('inviteForm').addEventListener('submit', async event => {
  event.preventDefault()
  const button = $('inviteForm').querySelector('button[type="submit"]')
  if (!connection || !activeGroup) return
  button.disabled = true
  try {
    message('Looking up the contact key package and sending an encrypted group invite…')
    const outcome = await window.MarmotCompanion.inviteContact(connection.client, activeGroup.id, $('contactAddress').value, connection.relays)
    $('inviteForm').classList.add('hidden')
    $('contactAddress').value = ''
    message(`Invite sent. Relay acknowledgements: ${Object.keys(outcome || {}).length}.`)
    await refreshGroups()
  } catch (error) { message(error?.message || String(error), true) }
  finally { button.disabled = false }
})
$('sendButton').addEventListener('click', async () => {
  const text = $('composer').value.trim()
  if (!text || !activeGroup || !connection) return
  $('sendButton').disabled = true
  try {
    const rumor = await window.MarmotCompanion.send(connection.client, activeGroup.id, text)
    $('composer').value = ''
    await activeGroup.instance.history.saveRumor(rumor)
    await showMessages(activeGroup)
    message('Message sent through MLS.')
  } catch (error) { message(error?.message || String(error), true) }
  finally { $('sendButton').disabled = false }
})
$('composer').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('sendButton').click() } })
$('saveButton').addEventListener('click', async () => {
  const relays = $('relayInput').value.split(/\r?\n/).map(value => value.trim()).filter(Boolean)
  if (!relays.length || !relays.every(value => /^wss:\/\//i.test(value))) { message('Relay addresses must start with wss://.', true); return }
  const normalizedRelays = [...new Set(relays.map(value => {
    const url = new URL(value)
    if (url.protocol !== 'wss:' || !['relay.eu.whitenoise.chat', 'relay.us.whitenoise.chat', 'relay.damus.io', 'relay.primal.net', 'relay.ditto.pub'].includes(url.hostname) || url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error(`Relay host is not permitted by this prototype: ${url.hostname}`)
    return url.toString().replace(/\/$/, '')
  }))]
  await chrome.storage.local.set({ relays: normalizedRelays, useBrowserIdentity: $('useBrowserIdentity').checked })
  selectedRelays = normalizedRelays
  if (connection) {
    liveConnection?.unsubscribe()
    liveConnection = connection.client.groups.connectAll({ fallbackRelays: selectedRelays })
    connection = { ...connection, relays: selectedRelays }
    const changedRelayGroups = []
    const failedRelayGroups = []
    for (const group of await connection.client.groups.loadAll()) {
      const current = group.snapshot.groupData?.relays || []
      if (current.length && !sameRelays(current, selectedRelays)) {
        const label = group.snapshot.groupData?.name || group.idStr
        try {
          const result = await window.MarmotCompanion.updateGroupRelays(connection.client, group.id, selectedRelays)
          if (Object.values(result || {}).some(relay => relay.ok)) changedRelayGroups.push(label)
          else failedRelayGroups.push(`${label} (no relay acknowledged)`)
        } catch (error) {
          failedRelayGroups.push(`${label} (${error?.message || String(error)})`)
        }
      }
    }
    liveConnection?.unsubscribe()
    liveConnection = connection.client.groups.connectAll({ fallbackRelays: selectedRelays })
    await refreshGroups()
    const summary = [`Relay list saved and active group subscriptions refreshed. ${changedRelayGroups.length} group(s) updated.`]
    if (failedRelayGroups.length) summary.push(`Failed: ${failedRelayGroups.join('; ')}`)
    message(summary.join(' '), failedRelayGroups.length > 0)
  } else message('Relay list saved. It will be used when the NCC signer connects.')
})
$('openWhiteNoise').addEventListener('click', () => message('White Noise desktop is not installed in this development profile.'))
$('search').addEventListener('input', () => renderGroups($('search').value))
void load()
