const defaults = { relays: ['wss://relay.damus.io', 'wss://relay.primal.net', 'wss://relay.ditto.pub'], desktopNotifications: false, keyPackageEncoding: 'framed' }
const previousDefaults = [
  ['wss://relay.damus.io', 'wss://relay.primal.net', 'wss://nos.lol'],
  ['wss://relay.damus.io', 'wss://nos.lol'],
  ['wss://relay.eu.whitenoise.chat', 'wss://relay.us.whitenoise.chat', 'wss://relay.damus.io', 'wss://relay.primal.net', 'wss://relay.ditto.pub'],
  ['wss://relay.damus.io', 'wss://relay.primal.net', 'wss://relay.ditto.pub', 'wss://relay.eu.whitenoise.chat', 'wss://relay.us.whitenoise.chat']
]
const WHITE_NOISE_FALLBACK_RELAYS = ['wss://relay.eu.whitenoise.chat', 'wss://relay.us.whitenoise.chat']
const $ = (id) => document.getElementById(id)
const mainView = $('mainView')
const settingsView = $('settingsView')
let connection = null
let connectionAttempt = false
let desktopNotifications = false
const notifiedEventIds = new Set()
let groups = []
let activeGroup = null
const observedGroupInstances = new WeakSet()
let liveConnection = null
let groupWatchStop = null
let selectedRelays = defaults.relays
let groupRefreshTimer = null
let showArchived = false
let pendingAttachments = []
let renderedMediaUrls = []
const mediaUrlCache = new Map()
let mediaUrlCacheBytes = 0
const MEDIA_URL_CACHE_LIMIT = 48 * 1024 * 1024
let inviteRefreshTimer = null
let signerWatchTimer = null
let pendingInvites = []
let contactAction = 'invite'
let replyTarget = null
let retentionRefreshTimeout = null
let folders = []
let selectedFolderId = 'all'
const profileCache = new Map()

function setStatus(text, connected = false) {
  $('statusText').textContent = text
  $('statusDot').classList.toggle('connected', connected)
}

function message(text, error = false, warning = false) {
  $('message').textContent = text
  $('message').classList.toggle('error', error)
  $('message').classList.toggle('warning', warning)
}

function shortPubkey(pubkey) {
  return `${String(pubkey || '').slice(0, 10)}…${String(pubkey || '').slice(-6)}`
}

function showSettings() { mainView.classList.add('hidden'); settingsView.classList.remove('hidden') }
function showMain() { settingsView.classList.add('hidden'); mainView.classList.remove('hidden') }

function clearReplyTarget() {
  replyTarget = null
  $('replyPreview').classList.add('hidden')
  $('composer').placeholder = 'Message'
}

function selectReplyTarget(rumor) {
  replyTarget = rumor
  const author = rumor.pubkey === connection.pubkey ? 'your message' : `message from ${rumor.pubkey.slice(0, 12)}…`
  const attachments = window.MarmotCompanion.mediaAttachments(rumor)
  const preview = rumor.content.replace(/^nostr:nevent1[^\s\r\n]*(?:\r?\n|$)/, '').trim()
  $('replyTitle').textContent = `Replying to ${author}`
  $('replyText').textContent = preview || (attachments.length ? attachments.map(item => item.filename).join(', ') : 'Message')
  $('replyPreview').classList.remove('hidden')
  $('composer').placeholder = 'Reply'
  $('composer').focus()
}

function addPollOption(value = '') {
  const options = $('pollOptions')
  if (options.children.length >= 10) return
  const row = document.createElement('div')
  row.className = 'poll-option-row'
  const input = document.createElement('input')
  input.type = 'text'
  input.required = true
  input.maxLength = 100
  input.placeholder = `Option ${options.children.length + 1}`
  input.value = value
  input.setAttribute('aria-label', `Poll option ${options.children.length + 1}`)
  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'icon-button poll-remove-option'
  remove.setAttribute('aria-label', 'Remove poll option')
  remove.textContent = '×'
  remove.addEventListener('click', () => {
    if (options.children.length <= 2) return
    row.remove()
    for (const [index, field] of [...options.querySelectorAll('input')].entries()) {
      field.placeholder = `Option ${index + 1}`
      field.setAttribute('aria-label', `Poll option ${index + 1}`)
    }
    $('addPollOption').disabled = options.children.length >= 10
  })
  row.append(input, remove)
  options.append(row)
  $('addPollOption').disabled = options.children.length >= 10
}

async function load() {
  const saved = await chrome.storage.local.get({ ...defaults, relaysConfigured: false })
  $('keyPackageEncoding').value = saved.keyPackageEncoding
  window.__NCC_WHITE_NOISE_KEY_PACKAGE_ENCODING__ = saved.keyPackageEncoding
  const savedRelays = saved.relays || defaults.relays
  selectedRelays = !saved.relaysConfigured && previousDefaults.some(relays => sameRelays(savedRelays, relays))
    ? defaults.relays
    : savedRelays
  if (!sameRelays(selectedRelays, savedRelays)) await chrome.storage.local.set({ relays: selectedRelays })
  $('relayInput').value = selectedRelays.join('\n')
  desktopNotifications = Boolean(saved.desktopNotifications)
  $('desktopNotifications').checked = desktopNotifications
  const accountProfile = connection ? profileCache.get(connection.pubkey) : null
  renderAccountProfile(accountProfile)
  $('accountKey').textContent = connection ? `Public key · ${connection.pubkey.slice(0, 12)}…${connection.pubkey.slice(-8)}` : 'Connect your browser account to begin'
  $('connectButton').textContent = 'Connect account'
  $('connectButton').classList.toggle('hidden', Boolean(connection))
  $('connectButton').disabled = Boolean(connection || connectionAttempt)
  $('switchAccountButton').classList.toggle('hidden', !connection)
  if (connection) setStatus('Relay session active', true)
  else setStatus('Not connected')
  renderGroups()
}

async function profileFor(pubkey) {
  if (!connection || !pubkey) return null
  if (profileCache.has(pubkey)) return profileCache.get(pubkey)
  profileCache.set(pubkey, null)
  try {
    const result = await ncc.nostr.getProfile(pubkey, connection.relays)
    profileCache.set(pubkey, result)
    if (pubkey === connection.pubkey) renderAccountProfile(result)
    return result
  } catch (error) {
    console.debug('[white-noise] profile lookup unavailable:', error?.message || error)
    return null
  }
}

function renderAccountProfile(profile) {
  $('accountName').textContent = connection
    ? profile?.name || (profile ? 'Your account' : 'Connected account')
    : 'Not connected'
  setAvatar(document.querySelector('.account .avatar'), profile, '●')
}

function setAvatar(element, profile, fallback) {
  element.classList.add('profile-avatar')
  element.classList.remove('profile-photo')
  element.style.backgroundImage = ''
  element.textContent = profile?.name?.slice(0, 1).toUpperCase() || fallback
  if (profile?.pictureDataUrl) {
    element.textContent = ''
    element.style.backgroundImage = `url("${profile.pictureDataUrl}")`
    element.classList.add('profile-photo')
  }
}

function clearMediaUrlCache() {
  for (const entry of mediaUrlCache.values()) URL.revokeObjectURL(entry.url)
  mediaUrlCache.clear()
  mediaUrlCacheBytes = 0
  renderedMediaUrls = []
}

function rememberMediaUrl(key, attachment, data) {
  const previous = mediaUrlCache.get(key)
  if (previous) {
    mediaUrlCacheBytes -= previous.size
    URL.revokeObjectURL(previous.url)
    mediaUrlCache.delete(key)
  }
  const size = data.byteLength
  if (!size || size > MEDIA_URL_CACHE_LIMIT) return null
  const url = URL.createObjectURL(new Blob([data], { type: attachment.mediaType }))
  mediaUrlCache.set(key, { url, size, attachment })
  mediaUrlCacheBytes += size
  while (mediaUrlCacheBytes > MEDIA_URL_CACHE_LIMIT) {
    const [oldestKey, oldest] = mediaUrlCache.entries().next().value
    mediaUrlCache.delete(oldestKey)
    mediaUrlCacheBytes -= oldest.size
    URL.revokeObjectURL(oldest.url)
  }
  return url
}

function cachedMedia(key) {
  const entry = mediaUrlCache.get(key)
  if (!entry) return null
  mediaUrlCache.delete(key)
  mediaUrlCache.set(key, entry)
  return entry
}

function appendMediaPreview(row, entry) {
  const { url, attachment } = entry
  if (attachment.mediaType.startsWith('video/')) {
    const video = document.createElement('video')
    video.src = url
    video.controls = true
    video.preload = 'metadata'
    video.setAttribute('aria-label', attachment.filename)
    video.className = 'attachment-video'
    const caption = document.createElement('span')
    caption.className = 'attachment-file'
    caption.textContent = attachment.filename
    const save = document.createElement('a')
    save.href = url
    save.download = attachment.filename
    save.className = 'attachment-file'
    save.textContent = 'Save video'
    row.append(video, caption, save)
    return
  }
  const link = document.createElement('a')
  link.href = url
  link.download = attachment.filename
  link.className = 'attachment-file'
  if (attachment.mediaType.startsWith('image/')) {
    const img = document.createElement('img')
    img.src = url
    img.alt = attachment.filename
    img.loading = 'lazy'
    link.append(img)
  } else {
    link.textContent = `${attachment.filename} · ${attachment.mediaType} · click to save`
  }
  row.append(link)
}

function sameRelays(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every(relay => right.includes(relay))
}

function withWhiteNoiseFallbacks(primaryRelays) {
  return [...new Set([...primaryRelays, ...WHITE_NOISE_FALLBACK_RELAYS])]
}

function renderGroups(filter = '') {
  const list = $('chatList')
  for (const image of list.querySelectorAll('[data-image-url]')) URL.revokeObjectURL(image.dataset.imageUrl)
  list.replaceChildren()
  const query = filter.trim().toLowerCase()
  renderFolderBar()
  const matching = groups
    .filter(group => Boolean(group.archived) === showArchived && (showArchived || selectedFolderId === 'all' || group.folderId === selectedFolderId) && (group.name || 'Untitled group').toLowerCase().includes(query))
    .sort((left, right) => Number(right.pinned) - Number(left.pinned) || left.order - right.order)
  $('toggleArchived').textContent = showArchived ? 'Chats' : 'Archived'
  $('chatSectionTitle').textContent = showArchived ? 'Archived chats' : 'Chats'
  if (!matching.length) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    const title = query ? 'No chats match your search' : !showArchived && selectedFolderId !== 'all' ? 'This folder is empty' : connection ? 'No chats yet' : 'Connect to get started'
    const description = query ? 'Try a different name.' : !showArchived && selectedFolderId !== 'all' ? 'Move a chat here from its chat options.' : connection ? 'Chats and group state are saved on each device. Groups this account already joined on another device cannot be restored here yet; linked-device support is still in development.' : 'Connect your browser account to load your chats.'
    empty.innerHTML = `<div class="empty-icon">◌</div><strong>${title}</strong><p>${description}</p>`
    if (!query) {
      const button = document.createElement('button')
      button.className = 'primary'
      if (connection) {
        button.textContent = 'Set up invitations'
        button.addEventListener('click', () => void publishKeyPackage())
      } else {
        button.textContent = 'Connect account'
        button.addEventListener('click', () => void connect())
      }
      empty.append(button)
    }
    list.append(empty)
    return
  }
  for (const group of matching) {
    const row = document.createElement('button')
    row.className = `chat-row${group.unread ? ' unread' : ''}`
    row.innerHTML = `<span class="chat-avatar">${escapeHtml((group.name || 'W').slice(0, 1).toUpperCase())}</span><span class="chat-copy"><strong>${escapeHtml(group.name || 'Untitled group')}<span class="chat-flags">${group.pinned ? '<span title="Pinned">◆</span>' : ''}${group.muted ? '<span title="Muted">🔕</span>' : ''}</span></strong><small>${group.memberCount || 1} members · epoch ${group.epoch ?? '—'}${group.unread ? ' · Unread' : ''}</small><span class="last-message"></span></span><span class="row-menu" role="button" tabindex="0" aria-label="Chat options">⋯</span>`
    const otherMembers = (group.instance.snapshot.members || []).filter(pubkey => pubkey !== connection?.pubkey).slice(0, 2)
    if (!group.name || group.name === 'Encrypted group') {
      void Promise.all(otherMembers.map(profileFor)).then(profiles => {
        const names = profiles.filter(profile => profile?.name).map(profile => profile.name)
        if (names.length && row.isConnected) row.querySelector('.chat-copy strong').prepend(document.createTextNode(`${names.join(', ')} · `))
      })
    }
    void loadGroupPhoto(group, row.querySelector('.chat-avatar'))
    if (group.last) row.querySelector('.last-message').textContent = group.last.content.slice(0, 48)
    row.addEventListener('click', event => {
      if (event.target.closest('.row-menu')) {
        activeGroup = group
        updateGroupMenu(group)
        $('groupMenu').classList.remove('hidden')
        return
      }
      openGroup(group)
    })
    row.addEventListener('contextmenu', event => { event.preventDefault(); activeGroup = group; updateGroupMenu(group); $('groupMenu').classList.remove('hidden') })
    list.append(row)
  }
}

function renderFolderBar() {
  const bar = $('folderBar')
  bar.replaceChildren()
  bar.classList.toggle('hidden', showArchived)
  if (showArchived) return
  const addFilter = (id, label) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `folder-chip${selectedFolderId === id ? ' active' : ''}`
    button.textContent = label
    button.addEventListener('click', () => { selectedFolderId = id; renderGroups($('search').value) })
    bar.append(button)
  }
  addFilter('all', 'All')
  for (const folder of folders) addFilter(folder.id, folder.name)
  const manage = document.createElement('button')
  manage.type = 'button'
  manage.className = 'folder-manage text-button'
  manage.textContent = 'Manage'
  manage.addEventListener('click', () => { renderFolderManager(); $('folderManagerDialog').classList.remove('hidden') })
  bar.append(manage)
}

function folderStorageKey() {
  return connection ? `marmot:folders:${connection.pubkey}` : null
}

async function saveFolders() {
  const key = folderStorageKey()
  if (!key) return
  await chrome.storage.local.set({ [key]: folders })
}

function renderFolderManager() {
  const list = $('folderManagerList')
  list.replaceChildren()
  if (!folders.length) {
    const empty = document.createElement('p')
    empty.className = 'field-hint'
    empty.textContent = 'Create folders to organize your chats.'
    list.append(empty)
    return
  }
  for (const folder of folders) {
    const row = document.createElement('div')
    row.className = 'folder-manager-row'
    const name = document.createElement('strong')
    name.textContent = folder.name
    const rename = document.createElement('button')
    rename.type = 'button'
    rename.className = 'secondary'
    rename.textContent = 'Rename'
    rename.addEventListener('click', async () => {
      const next = prompt('Rename folder', folder.name)?.trim().slice(0, 40)
      if (!next || next === folder.name) return
      if (folders.some(item => item.id !== folder.id && item.name.toLowerCase() === next.toLowerCase())) { message('A folder with that name already exists.', true); return }
      folder.name = next
      await saveFolders()
      renderFolderManager()
      renderGroups($('search').value)
    })
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'secondary'
    remove.textContent = 'Delete'
    remove.addEventListener('click', async () => {
      if (!confirm(`Delete “${folder.name}”? Chats will stay in All.`)) return
      folders = folders.filter(item => item.id !== folder.id)
      await Promise.all(groups.filter(group => group.folderId === folder.id).map(group => setChatUiState(group.idStr, { folderId: null })))
      if (selectedFolderId === folder.id) selectedFolderId = 'all'
      await saveFolders()
      await refreshGroups()
      renderFolderManager()
    })
    row.append(name, rename, remove)
    list.append(row)
  }
}

function openFolderAssignment(group) {
  const select = $('folderAssignmentSelect')
  select.replaceChildren()
  const addOption = (id, label) => {
    const option = document.createElement('option')
    option.value = id
    option.textContent = label
    select.append(option)
  }
  addOption('', 'No folder')
  for (const folder of folders) addOption(folder.id, folder.name)
  select.value = group.folderId || ''
  $('folderAssignmentForm').dataset.groupId = group.idStr
  $('groupMenu').classList.add('hidden')
  $('folderAssignmentDialog').classList.remove('hidden')
}

function escapeHtml(value) {
  const span = document.createElement('span')
  span.textContent = value
  return span.innerHTML
}

// Many things ask for a refresh at once, such as each message while catching up.
const refreshGroups = window.MarmotCompanion.coalesce(() => timed('chat list', loadGroups), 150)
const showMessages = window.MarmotCompanion.coalesce(() => activeGroup ? timed('messages', () => renderMessages(activeGroup)) : undefined, 30)
const refreshInvites = window.MarmotCompanion.coalesce(() => timed('invitations', loadInvites), 150)

async function timed(label, task) {
  const started = performance.now()
  try { return await task() }
  finally {
    const elapsed = Math.round(performance.now() - started)
    if (elapsed > 200) console.warn(`[white-noise] slow refresh: ${label} took ${elapsed} ms`)
  }
}

function watchClient(client) {
  groupWatchStop?.()
  groupWatchStop = window.MarmotCompanion.watchGroups(client, () => {
    if (connection?.client === client) void refreshGroups()
  }, error => console.warn('[white-noise] group watcher failed', error))
  client.invites.on('decrypted', () => void refreshInvites())
  client.invites.on('read', () => void refreshInvites())
}

async function loadGroups() {
  const current = connection
  if (!current) return
  const foldersKey = folderStorageKey()
  const storedFolders = (await chrome.storage.local.get(foldersKey))[foldersKey]
  folders = Array.isArray(storedFolders)
    ? storedFolders.filter(folder => folder && typeof folder.id === 'string' && typeof folder.name === 'string' && folder.name.trim()).slice(0, 100)
    : []
  if (selectedFolderId !== 'all' && !folders.some(folder => folder.id === selectedFolderId)) selectedFolderId = 'all'
  const loaded = await window.MarmotCompanion.listGroups(connection.client)
  const loadedGroups = await Promise.all(loaded.map(async group => {
    const history = retainedHistory(group, await window.MarmotCompanion.history(group))
    if (!observedGroupInstances.has(group)) {
      observedGroupInstances.add(group)
      group.on('changed', () => void refreshGroups())
      const historyChanged = () => {
        void refreshGroups()
        if (activeGroup?.idStr === group.idStr) void showMessages()
      }
      group.history.on('removed', historyChanged)
      group.history.on('cleared', historyChanged)
      group.history.on('rumor', rumor => {
        if (activeGroup?.idStr !== group.idStr && (rumor?.kind === 9 || rumor?.kind === 1068) && rumorIsRetained(group, rumor)) {
          void setChatUiState(group.idStr, { unread: true })
          if (rumor.pubkey !== connection?.pubkey) void notifyIncomingMessage(rumor, group)
        }
        historyChanged()
      })
    }
    const key = `marmot:chat-ui:${connection.pubkey}:${group.idStr}`
    const uiState = (await chrome.storage.local.get(key))[key] || {}
    const lastChatMessage = history.find(rumor => rumor.kind === 9 || rumor.kind === 1068)
    const preview = lastChatMessage?.kind === 1068 ? `Poll: ${lastChatMessage.content}` : lastChatMessage?.content.startsWith('nostr:') ? 'Shared a contact' : lastChatMessage?.content
    return { id: group.snapshot.id, idStr: group.idStr, name: group.snapshot.groupData?.name || 'Encrypted group', memberCount: group.snapshot.members?.length, epoch: String(group.snapshot.epoch ?? '—'), instance: group, last: lastChatMessage ? { ...lastChatMessage, content: preview } : null, archived: Boolean(uiState.archived), pinned: Boolean(uiState.pinned), muted: Boolean(uiState.muted), unread: Boolean(uiState.unread), folderId: typeof uiState.folderId === 'string' ? uiState.folderId : null, order: Number.isFinite(uiState.order) ? uiState.order : loaded.indexOf(group) }
  }))
  // The account may have been switched or disconnected while this was loading.
  if (connection !== current) return
  groups = loadedGroups
  renderGroups($('search').value)
}

function notifyIncomingMessage(rumor, group) {
  if (!desktopNotifications || !rumor?.id || notifiedEventIds.has(rumor.id)) return
  if (activeGroup?.idStr === group.idStr) return
  notifiedEventIds.add(rumor.id)
  if (notifiedEventIds.size > 500) notifiedEventIds.delete(notifiedEventIds.values().next().value)
  const key = `marmot:chat-ui:${connection.pubkey}:${group.idStr}`
  void chrome.storage.local.get(key).then(saved => {
    if (saved[key]?.muted) return
    return chrome.notifications.create({ title: 'White Noise', message: 'New encrypted message' })
  }).catch(error => console.debug('[white-noise] notification unavailable:', error?.message || error))
}

async function loadInvites() {
  const current = connection
  if (!current) return
  try {
    const invites = await window.MarmotCompanion.getInvites(current.client)
    if (connection !== current) return
    pendingInvites = invites
    renderInvites()
  } catch (error) {
    message(error?.message || String(error), true)
  }
}

function renderInvites() {
  const section = $('incomingInvites')
  section.replaceChildren()
  section.classList.toggle('hidden', pendingInvites.length === 0)
  if (!pendingInvites.length) return
  const heading = document.createElement('strong')
  heading.className = 'incoming-heading'
  heading.textContent = pendingInvites.length === 1 ? 'NEW INVITATION' : `${pendingInvites.length} NEW INVITATIONS`
  section.append(heading)
  for (const item of pendingInvites) {
    const card = document.createElement('article')
    card.className = 'invite-card'
    const title = document.createElement('strong')
    title.textContent = item.preview.group?.name || 'Encrypted group invitation'
    const detail = document.createElement('small')
    detail.textContent = item.canJoin
      ? `${item.preview.group?.relays?.length || item.preview.relays?.length || 0} group relays`
      : 'This account no longer has the information needed to accept this invite.'
    const actions = document.createElement('div')
    actions.className = 'invite-card-actions'
    const join = document.createElement('button')
    join.className = 'primary'
    join.textContent = 'Join'
    join.disabled = !item.canJoin
    join.addEventListener('click', () => void acceptInvite(item))
    const dismiss = document.createElement('button')
    dismiss.className = 'secondary'
    dismiss.textContent = 'Dismiss'
    dismiss.addEventListener('click', () => void dismissInvite(item))
    actions.append(join, dismiss)
    card.append(title, detail, actions)
    section.append(card)
  }
}

async function acceptInvite(item) {
  try {
    message('Joining the encrypted group…')
    await window.MarmotCompanion.joinInvite(connection.client, item.rumor)
    pendingInvites = pendingInvites.filter(invite => invite.rumor.id !== item.rumor.id)
    renderInvites()
    await refreshGroups()
    message('Joined the encrypted group.')
  } catch (error) { message(error?.message || String(error), true) }
}

async function dismissInvite(item) {
  await window.MarmotCompanion.dismissInvite(connection.client, item.rumor)
  pendingInvites = pendingInvites.filter(invite => invite.rumor.id !== item.rumor.id)
  renderInvites()
}

async function connect() {
  if (connection || connectionAttempt) return
  connectionAttempt = true
  try {
    await load()
    setStatus('Connecting account…')
    const configured = $('relayInput').value.split(/\r?\n/).map(value => value.trim()).filter(Boolean)
    if (!configured.length) throw new Error('Add at least one relay in Settings first.')
    const relays = [...new Set(configured.map(value => {
      const url = new URL(value)
      if (url.protocol !== 'wss:' || !['relay.eu.whitenoise.chat', 'relay.us.whitenoise.chat', 'relay.damus.io', 'relay.primal.net', 'relay.ditto.pub', 'nos.lol'].includes(url.hostname) || url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error(`Relay host is not permitted by this prototype: ${url.hostname}`)
      return url.toString().replace(/\/$/, '')
    }))]
    const fallbackRelays = withWhiteNoiseFallbacks(relays)
    const runtime = await window.MarmotCompanion.connect(relays, null, fallbackRelays)
    connection = { ...runtime, relays, fallbackRelays }
    liveConnection = runtime.live
    watchClient(runtime.client)
    await refreshGroups()
    await refreshInvites()
    if (groupRefreshTimer) clearInterval(groupRefreshTimer)
    // Changes arrive as events. These slow timers cover what nothing announces, such
    // as a message passing its disappearing-message time.
    groupRefreshTimer = setInterval(() => { void refreshGroups() }, 60_000)
    if (inviteRefreshTimer) clearInterval(inviteRefreshTimer)
    inviteRefreshTimer = setInterval(() => { void refreshInvites() }, 60_000)
    if (signerWatchTimer) clearInterval(signerWatchTimer)
    signerWatchTimer = setInterval(() => { void checkActiveSigner() }, 5000)
    await chrome.storage.local.set({ connectedSignerPubkey: runtime.pubkey })
    setStatus(`Connected · ${relays.length} relays`, true)
    message('Account connected. Your chats and group invitations are ready.')
    void profileFor(runtime.pubkey)
  } catch (error) {
    setStatus('Connection failed')
    message(error?.message || String(error), true)
  } finally {
    connectionAttempt = false
    await load()
  }
}

async function disconnectCurrentAccount() {
  groupWatchStop?.()
  groupWatchStop = null
  liveConnection?.unsubscribe()
  connection?.inviteListener?.unsubscribe()
  liveConnection = null
  if (retentionRefreshTimeout) clearTimeout(retentionRefreshTimeout)
  retentionRefreshTimeout = null
  for (const timer of [groupRefreshTimer, inviteRefreshTimer, signerWatchTimer]) {
    if (timer) clearInterval(timer)
  }
  groupRefreshTimer = inviteRefreshTimer = signerWatchTimer = null
  connection = null
  profileCache.clear()
  clearMediaUrlCache()
  activeGroup = null
  groups = []
  pendingInvites = []
  renderInvites()
  $('conversationView').classList.add('hidden')
  mainView.classList.remove('hidden')
  await load()
}

async function checkActiveSigner() {
  if (!connection || connectionAttempt) return
  try {
    const currentPubkey = await ncc.nostr.getPublicKey()
    if (currentPubkey === connection.pubkey) return
    await disconnectCurrentAccount()
    message('Browser account changed. Loading its chats…')
    await connect()
  } catch (error) {
    message(`Could not refresh the browser account: ${error?.message || String(error)}`, true)
  }
}

async function publishKeyPackage() {
  if (!connection) return
  const button = $('newChat')
  button.disabled = true
  try {
    message('Setting up group invitations. Approve the request in your browser when prompted.')
    const entry = await window.MarmotCompanion.createKeyPackage(connection.client, connection.relays)
    const responses = Object.entries(entry.publication?.responses || {})
    const accepted = responses.filter(([, result]) => result.ok).map(([relay]) => new URL(relay).hostname)
    const failed = responses.filter(([, result]) => !result.ok).map(([relay, result]) => `${new URL(relay).hostname}${result.message ? ` (${result.message})` : ''}`)
    const inboxAccepted = Object.values(entry.inboxPublication || {}).filter(result => result.ok).length
    if (!accepted.length) {
      message(`Could not make invitations available. No relay accepted them.${failed.length ? ` ${failed.join('; ')}` : ' No relay response was received.'}`, true)
    } else {
      message(`You can now be invited to a group. Your invitation is available on ${accepted.length} relay(s), and incoming invites are set to ${inboxAccepted} relay(s). Share your profile address with a contact.${failed.length ? ` Some relays are unavailable: ${failed.join('; ')}` : ''}`, false, failed.length > 0)
    }
  } catch (error) { message(error?.message || String(error), true) }
  finally { button.disabled = false }
}

async function renderMessages(group) {
  const allHistory = await window.MarmotCompanion.history(group.instance)
  const history = retainedHistory(group.instance, allHistory)
  if (retentionRefreshTimeout) clearTimeout(retentionRefreshTimeout)
  retentionRefreshTimeout = null
  const retention = Number(group.instance.snapshot.groupData?.messageRetention ?? 0n)
  if (Number.isSafeInteger(retention) && retention > 0) {
    const now = Math.floor(Date.now() / 1000)
    const nextExpiry = allHistory
      .map(rumor => Number.isSafeInteger(rumor.created_at) ? rumor.created_at + retention : Infinity)
      .filter(expiration => expiration > now)
      .sort((left, right) => left - right)[0]
    if (Number.isFinite(nextExpiry)) {
      retentionRefreshTimeout = setTimeout(() => {
        if (activeGroup?.idStr === group.idStr) void showMessages()
      }, Math.min(2147483647, Math.max(100, (nextExpiry - now) * 1000 + 50)))
    }
  }
  const visibleHistory = history.filter(rumor => rumor.kind === 9 || rumor.kind === 1068)
  const list = $('messageList')
  const query = $('messageSearch').value.trim().toLowerCase()
  const matches = visibleHistory.filter(rumor => !query || rumor.content.toLowerCase().includes(query) || (rumor.tags || []).some(tag => tag[0] === 'option' && String(tag[2] || '').toLowerCase().includes(query)) || window.MarmotCompanion.mediaAttachments(rumor).some(item => item.filename.toLowerCase().includes(query)))
  list.replaceChildren()
  if (!matches.length) {
    const empty = document.createElement('p')
    empty.className = 'field-hint'
    empty.textContent = query ? 'No messages match this search.' : allHistory.length > history.length ? 'No messages remain under this group’s disappearing-message timer.' : 'No messages yet. Messages are end-to-end encrypted.'
    list.append(empty)
    return
  }
  for (const rumor of [...matches].reverse()) {
    const row = document.createElement('article')
    row.className = 'message-bubble'
    const author = document.createElement('strong')
    const senderProfile = await profileFor(rumor.pubkey)
    author.textContent = rumor.pubkey === connection.pubkey ? (senderProfile?.name || 'You') : (senderProfile?.name || `${rumor.pubkey.slice(0, 12)}…`)
    row.append(author)
    if (rumor.kind === 1068) {
      renderPoll(row, rumor, history, group)
    } else {
      renderReplyContext(row, rumor, history)
      if (!renderContactCard(row, rumor)) {
        const content = document.createElement('p')
        content.textContent = visibleChatContent(rumor.content)
        row.append(content)
      }
    }
    const timestamp = document.createElement('time')
    timestamp.textContent = new Date(rumor.created_at * 1000).toLocaleString()
    row.append(timestamp)
    if (rumor.kind === 9) {
      const reply = document.createElement('button')
      reply.type = 'button'
      reply.className = 'message-action'
      reply.textContent = 'Reply'
      reply.addEventListener('click', () => selectReplyTarget(rumor))
      row.append(reply)
    }
    const attachments = window.MarmotCompanion.mediaAttachments(rumor)
    if (attachments.length) {
      const mediaKeys = attachments.map((attachment, index) => `${connection.pubkey}:${group.idStr}:${rumor.id}:${index}:${attachment.url}`)
      const ready = mediaKeys.map(cachedMedia)
      const mediaContent = document.createElement('div')
      mediaContent.className = 'attachment-content'
      for (const entry of ready) if (entry) appendMediaPreview(mediaContent, entry)
      row.append(mediaContent)
      const open = document.createElement('button')
      open.type = 'button'
      open.className = 'attachment-download secondary'
      open.textContent = ready.every(Boolean) ? 'Reload attachments' : `Load ${attachments.length === 1 ? attachments[0].filename : `${attachments.length} attachments`}`
      open.addEventListener('click', async () => {
        open.disabled = true
        open.textContent = 'Downloading and decrypting…'
        try {
          const results = await window.MarmotCompanion.downloadMedia(connection.client, group.id, rumor, connection.mediaTransport)
          mediaContent.replaceChildren()
          for (const [index, result] of results.entries()) {
            if (result.status !== 'ready') continue
            const url = rememberMediaUrl(mediaKeys[index], result.attachment, result.data)
            if (url) appendMediaPreview(mediaContent, { url, attachment: result.attachment })
          }
          if (results.some(result => result.status === 'unavailable')) message('Some attachments could not be downloaded or decrypted.', true)
          open.disabled = false
          open.textContent = 'Reload attachments'
        } catch (error) {
          open.disabled = false
          open.textContent = 'Retry download'
          message(error?.message || String(error), true)
        }
      })
      row.append(open)
      if (attachments.some(attachment => attachment.mediaType.startsWith('image/') || attachment.mediaType.startsWith('video/')) && !ready.every(Boolean)) {
        const observer = new IntersectionObserver(entries => {
          if (!entries.some(entry => entry.isIntersecting)) return
          observer.disconnect()
          if (!open.disabled && open.textContent.startsWith('Load ')) open.click()
        }, { root: list, rootMargin: '250px 0px' })
        observer.observe(row)
      }
    }
    renderReactions(row, rumor, history, group)
    list.append(row)
  }
  list.scrollTop = list.scrollHeight
}

function renderReactions(row, target, history, group) {
  const reactions = window.MarmotCompanion.summarizeReactions(history, target.id, connection.pubkey)
  const area = document.createElement('div')
  area.className = 'message-reactions'
  if (reactions.length) {
    const summary = document.createElement('div')
    summary.className = 'reaction-summary'
    for (const reaction of reactions) {
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = `reaction-chip${reaction.reacted ? ' reacted' : ''}`
      chip.textContent = `${reaction.emoji} ${reaction.count}`
      chip.title = reaction.reacted ? 'You reacted with this' : `React with ${window.MarmotCompanion.reactionLabel(reaction.emoji)}`
      chip.setAttribute('aria-label', `${window.MarmotCompanion.reactionLabel(reaction.emoji)}, ${reaction.count}${reaction.reacted ? ', including you' : ''}`)
      chip.disabled = reaction.reacted
      if (!reaction.reacted) chip.addEventListener('click', () => sendReaction(target, reaction.emoji, group, chip))
      summary.append(chip)
    }
    area.append(summary)
  }

  const controls = document.createElement('div')
  controls.className = 'reaction-controls'
  const open = document.createElement('button')
  open.type = 'button'
  open.className = 'message-action reaction-open'
  open.textContent = 'React'
  open.setAttribute('aria-expanded', 'false')
  const picker = document.createElement('div')
  picker.className = 'reaction-picker hidden'
  picker.setAttribute('aria-label', 'Choose a reaction')
  const ownReactions = new Set(reactions.filter(reaction => reaction.reacted).map(reaction => reaction.emoji))
  for (const emoji of window.MarmotCompanion.quickReactions) {
    const choice = document.createElement('button')
    choice.type = 'button'
    choice.className = 'reaction-choice'
    choice.textContent = emoji
    choice.title = `React with ${window.MarmotCompanion.reactionLabel(emoji)}`
    choice.setAttribute('aria-label', choice.title)
    choice.disabled = ownReactions.has(emoji)
    if (!choice.disabled) choice.addEventListener('click', () => sendReaction(target, emoji, group, choice))
    picker.append(choice)
  }
  open.addEventListener('click', () => {
    const expanded = open.getAttribute('aria-expanded') === 'true'
    open.setAttribute('aria-expanded', String(!expanded))
    picker.classList.toggle('hidden', expanded)
  })
  controls.append(open, picker)
  area.append(controls)
  row.append(area)
}

async function sendReaction(target, emoji, group, control) {
  control.disabled = true
  try {
    await window.MarmotCompanion.react(connection.client, group.id, target, emoji)
    await showMessages()
    message('Reaction sent.')
  } catch (error) {
    control.disabled = false
    message(error?.message || String(error), true)
  }
}

function retainedHistory(group, history) {
  const retention = Number(group.snapshot.groupData?.messageRetention ?? 0n)
  if (!Number.isSafeInteger(retention) || retention <= 0) return history
  return history.filter(rumor => rumorIsRetained(group, rumor))
}

function rumorIsRetained(group, rumor, now = Math.floor(Date.now() / 1000)) {
  const retention = Number(group.snapshot.groupData?.messageRetention ?? 0n)
  return !Number.isSafeInteger(retention) || retention <= 0 || !Number.isSafeInteger(rumor.created_at) || rumor.created_at + retention > now
}

function visibleChatContent(content) {
  return content.replace(/^nostr:nevent1[^\s\r\n]*(?:\r?\n|$)/, '')
}

function renderReplyContext(row, rumor, history) {
  const replyTag = (rumor.tags || []).find(tag => tag[0] === 'q' && /^[0-9a-f]{64}$/i.test(tag[1] || ''))
  if (!replyTag) return
  const parent = history.find(item => item.id === replyTag[1])
  const quote = document.createElement('blockquote')
  quote.className = 'reply-quote'
  const author = parent?.pubkey === connection.pubkey ? 'You' : parent ? `${parent.pubkey.slice(0, 12)}…` : 'Original message'
  const body = parent ? visibleChatContent(parent.content).trim() || window.MarmotCompanion.mediaAttachments(parent).map(item => item.filename).join(', ') || 'Message' : 'Message is not in the loaded history.'
  quote.textContent = `${author}: ${body.slice(0, 140)}`
  row.append(quote)
}

function renderContactCard(row, rumor) {
  const npub = rumor.content.match(/^nostr:(npub1[023456789acdefghjklmnpqrstuvwxyz]+)$/i)?.[1]
  const taggedPubkey = (rumor.tags || []).find(tag => tag[0] === 'p')?.[1]
  if (!npub || !/^[0-9a-f]{64}$/i.test(taggedPubkey || '') || window.MarmotCompanion.decodeContactNpub(npub) !== taggedPubkey.toLowerCase()) return false
  const card = document.createElement('div')
  card.className = 'contact-card'
  const title = document.createElement('strong')
  title.textContent = 'Shared contact'
  const address = document.createElement('code')
  address.textContent = `${npub.slice(0, 18)}…${npub.slice(-8)}`
  const copy = document.createElement('button')
  copy.type = 'button'
  copy.className = 'secondary contact-copy'
  copy.textContent = 'Copy profile address'
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(npub)
      message('Contact profile address copied.')
    } catch (error) { message(error?.message || 'Could not copy the profile address.', true) }
  })
  card.append(title, address, copy)
  row.append(card)
  return true
}

function pollOptions(poll) {
  return (poll.tags || []).filter(tag => tag[0] === 'option' && tag.length >= 3).map(tag => ({ id: String(tag[1]), label: String(tag[2]) }))
}

function pollVotes(poll, history, options) {
  const ids = new Set(options.map(option => option.id))
  const endsAt = Number((poll.tags || []).find(tag => tag[0] === 'endsAt')?.[1])
  const latestByMember = new Map()
  const votes = history.filter(rumor => rumor.kind === 1018 && (rumor.tags || []).some(tag => tag[0] === 'e' && tag[1] === poll.id))
    .filter(rumor => !Number.isFinite(endsAt) || endsAt <= 0 || rumor.created_at <= endsAt)
    .sort((left, right) => left.created_at - right.created_at || left.id.localeCompare(right.id))
  for (const vote of votes) {
    const responses = (vote.tags || []).filter(tag => tag[0] === 'response' && ids.has(String(tag[1]))).map(tag => String(tag[1]))
    if (responses.length) latestByMember.set(vote.pubkey, { vote, responses: [...new Set(responses)] })
  }
  return latestByMember
}

function renderPoll(row, poll, history, group) {
  const options = pollOptions(poll)
  const type = (poll.tags || []).find(tag => tag[0] === 'polltype')?.[1] === 'multiplechoice' ? 'multiplechoice' : 'singlechoice'
  const heading = document.createElement('p')
  heading.className = 'poll-question'
  heading.textContent = poll.content
  row.append(heading)
  if (options.length < 2 || options.length > 10) {
    const invalid = document.createElement('p')
    invalid.className = 'field-hint'
    invalid.textContent = 'This poll has an unsupported option list.'
    row.append(invalid)
    return
  }
  const latestVotes = pollVotes(poll, history, options)
  const myVote = latestVotes.get(connection.pubkey)?.responses || []
  const totals = new Map(options.map(option => [option.id, 0]))
  for (const { responses } of latestVotes.values()) for (const id of responses) totals.set(id, (totals.get(id) || 0) + 1)
  const choices = document.createElement('div')
  choices.className = 'poll-choices'
  for (const option of options) {
    const choice = document.createElement('button')
    choice.type = 'button'
    choice.className = `poll-choice${myVote.includes(option.id) ? ' selected' : ''}`
    choice.textContent = `${myVote.includes(option.id) ? '✓ ' : ''}${option.label} · ${totals.get(option.id) || 0}`
    choice.disabled = Boolean((poll.tags || []).find(tag => tag[0] === 'endsAt' && Number(tag[1]) <= Math.floor(Date.now() / 1000)))
    choice.addEventListener('click', async () => {
      let next = myVote
      if (type === 'multiplechoice') {
        next = myVote.includes(option.id) ? myVote.filter(id => id !== option.id) : [...myVote, option.id]
        if (!next.length) { message('Keep at least one option selected.', true); return }
      } else if (myVote.length === 1 && myVote[0] === option.id) {
        return
      } else {
        next = [option.id]
      }
      choice.disabled = true
      try {
        await window.MarmotCompanion.votePoll(connection.client, group.id, poll.id, next)
        await showMessages()
        message('Vote sent.')
      } catch (error) { message(error?.message || String(error), true) }
      finally { choice.disabled = false }
    })
    choices.append(choice)
  }
  const summary = document.createElement('small')
  summary.className = 'poll-summary'
  summary.textContent = `${latestVotes.size} ${latestVotes.size === 1 ? 'vote' : 'votes'} · ${type === 'singlechoice' ? 'Single choice' : 'Multiple choice'} · Votes are visible to group members`
  const viewVotes = document.createElement('details')
  viewVotes.className = 'poll-voters'
  const viewTitle = document.createElement('summary')
  viewTitle.textContent = 'View votes'
  viewVotes.append(viewTitle)
  for (const option of options) {
    const voters = [...latestVotes.entries()].filter(([, entry]) => entry.responses.includes(option.id)).map(([pubkey]) => pubkey === connection.pubkey ? 'You' : `${pubkey.slice(0, 12)}…`)
    const line = document.createElement('p')
    line.textContent = `${option.label}: ${voters.length ? voters.join(', ') : 'No votes'}`
    viewVotes.append(line)
  }
  row.append(choices, summary, viewVotes)
}

$('messageSearch').addEventListener('input', () => {
  if (activeGroup) void showMessages()
})
$('openMessageSearch').addEventListener('click', () => {
  const search = $('chatSearch')
  const opening = search.classList.contains('hidden')
  search.classList.toggle('hidden', !opening)
  $('openMessageSearch').setAttribute('aria-expanded', String(opening))
  if (opening) $('messageSearch').focus()
  else {
    $('messageSearch').value = ''
    if (activeGroup) void showMessages()
  }
})
$('clearMessageSearch').addEventListener('click', () => {
  $('messageSearch').value = ''
  if (activeGroup) void showMessages()
})

async function openGroup(group) {
  activeGroup = group
  await setChatUiState(group.idStr, { unread: false })
  group.unread = false
  renderGroups($('search').value)
  clearReplyTarget()
  pendingAttachments = []
  renderPendingAttachments()
  $('messageSearch').value = ''
  $('chatSearch').classList.add('hidden')
  $('openMessageSearch').setAttribute('aria-expanded', 'false')
  $('conversationTitle').textContent = group.name || 'Encrypted group'
  $('conversationView').classList.remove('hidden')
  mainView.classList.add('hidden')
  await showMessages()
}

async function manageGroup(group, action) {
  $('groupMenu').classList.add('hidden')
  if (action === 'details') {
    showGroupDetails(group)
    return
  }
  if (action === 'folder') {
    openFolderAssignment(group)
    return
  }
  try {
    if (action === 'pin' || action === 'mute' || action === 'unread') {
      const field = action === 'pin' ? 'pinned' : action === 'mute' ? 'muted' : 'unread'
      const value = !group[field]
      await setChatUiState(group.idStr, { [field]: value })
      await refreshGroups()
      message(field === 'pinned'
        ? (value ? 'Chat pinned.' : 'Chat unpinned.')
        : field === 'muted'
          ? (value ? 'Notifications muted for this chat.' : 'Chat unmuted on this device.')
          : (value ? 'Chat marked unread.' : 'Chat marked read.'))
    } else if (action === 'move-up' || action === 'move-down') {
      const peers = groups
        .filter(item => item.archived === group.archived && item.pinned === group.pinned)
        .sort((a, b) => a.order - b.order)
      const index = peers.findIndex(item => item.idStr === group.idStr)
      const other = peers[index + (action === 'move-up' ? -1 : 1)]
      if (!other) return
      await Promise.all([
        setChatUiState(group.idStr, { order: other.order }),
        setChatUiState(other.idStr, { order: group.order })
      ])
      await refreshGroups()
      message('Chat order updated.')
    } else if (action === 'rename') {
      const name = prompt('New group name', group.name)?.trim()
      if (!name) return
      await window.MarmotCompanion.renameGroup(connection.client, group.id, name)
      await refreshGroups()
      message('Group renamed.')
    } else if (action === 'archive' || action === 'restore') {
      const shouldArchive = action === 'archive' && !group.archived
      await setChatUiState(group.idStr, { archived: shouldArchive })
      await refreshGroups()
      message(shouldArchive ? 'Chat archived.' : 'Chat restored.')
    } else if (action === 'clear') {
      if (!confirm(`Clear local message history for "${group.name}"? This cannot be undone.`)) return
      await group.instance.history.purgeMessages()
      await refreshGroups()
      if (activeGroup?.idStr === group.idStr) await showMessages()
      message('Local message history cleared.')
    } else if (action === 'delete') {
      if (!confirm(`Delete "${group.name}" from this device? This only removes local chat data.`)) return
      await connection.client.groups.destroy(group.id)
      activeGroup = null
      $('conversationView').classList.add('hidden')
      mainView.classList.remove('hidden')
      await refreshGroups()
      message('Local chat data deleted from this device.')
    } else if (action === 'leave') {
      const ownPubkey = connection.pubkey
      const admins = group.instance.snapshot.groupData?.adminPubkeys || []
      if (admins.includes(ownPubkey)) {
        openAdminHandoff(group)
        return
      }
      if (!confirm(`Leave “${group.name}”? Its chat data will be removed from this device after the request is delivered.`)) return
      await window.MarmotCompanion.leaveGroup(connection.client, group.id)
      if (activeGroup?.idStr === group.idStr) {
        activeGroup = null
        $('conversationView').classList.add('hidden')
        mainView.classList.remove('hidden')
      }
      await refreshGroups()
      message('Leave request acknowledged. Local group data removed.')
    }
  } catch (error) {
    message(error?.message || String(error), true)
  }
}

function updateGroupMenu(group) {
  const labels = {
    pin: group.pinned ? 'Unpin chat' : 'Pin chat',
    mute: group.muted ? 'Unmute notifications' : 'Mute notifications',
    unread: group.unread ? 'Mark as read' : 'Mark as unread',
    archive: group.archived ? 'Restore chat' : 'Archive chat'
  }
  for (const [action, label] of Object.entries(labels)) {
    const button = $('groupMenu').querySelector(`[data-group-action="${action}"]`)
    if (button) button.textContent = label
  }
}

async function setChatUiState(groupId, patch) {
  if (!connection) return
  const key = `marmot:chat-ui:${connection.pubkey}:${groupId}`
  const current = (await chrome.storage.local.get(key))[key] || {}
  await chrome.storage.local.set({ [key]: { ...current, ...patch } })
}

function showGroupDetails(group) {
  const snapshot = group.instance.snapshot
  const admins = new Set(snapshot.groupData?.adminPubkeys || [])
  const content = $('groupDetailsContent')
  content.replaceChildren()
  const addDetail = (label, value) => {
    const row = document.createElement('div')
    row.className = 'detail-row'
    const heading = document.createElement('strong')
    heading.textContent = label
    const text = document.createElement('span')
    text.textContent = value
    row.append(heading, text)
    content.append(row)
  }
  addDetail('Group', group.name)
  addDetail('Description', snapshot.groupData?.description || 'No description')
  addDetail('Group version', String(snapshot.epoch ?? '—'))
  addDetail('Members', String(snapshot.members.length))
  addDetail('Relays', (snapshot.groupData?.relays || []).join(', ') || 'No group relays')
  addDetail('Disappearing messages', retentionLabel(snapshot.groupData?.messageRetention))
  addDetail('Encrypted media', snapshot.groupData?.encryptedMedia ? 'Enabled' : 'Not enabled for this group')
  if (admins.has(connection.pubkey)) {
    const edit = document.createElement('button')
    edit.type = 'button'
    edit.className = 'secondary full'
    edit.textContent = 'Edit group details'
    edit.addEventListener('click', () => openGroupSettings(group))
    content.append(edit)
  }
  if (!snapshot.groupData?.encryptedMedia && admins.has(connection.pubkey)) {
    const enable = document.createElement('button')
    enable.type = 'button'
    enable.className = 'secondary full'
    enable.textContent = 'Enable encrypted photos and files'
    enable.addEventListener('click', () => void enableGroupMedia(group))
    content.append(enable)
  }
  const memberHeading = document.createElement('h3')
  memberHeading.textContent = 'Members'
  content.append(memberHeading)
  for (const pubkey of snapshot.members) {
    const row = document.createElement('div')
    row.className = 'member-row'
    const key = document.createElement('code')
    key.textContent = pubkey
    const role = document.createElement('span')
    role.textContent = admins.has(pubkey) ? 'Admin' : 'Member'
    row.append(key, role)
    if (pubkey !== connection.pubkey && admins.has(connection.pubkey)) {
      const remove = document.createElement('button')
      remove.className = 'text-button member-remove'
      remove.type = 'button'
      remove.textContent = 'Remove'
      remove.setAttribute('aria-label', `Remove member ${pubkey}`)
      remove.addEventListener('click', () => void removeGroupMember(group, pubkey))
      row.append(remove)
    }
    content.append(row)
  }
  $('groupDetailsDialog').classList.remove('hidden')
}

function retentionLabel(value) {
  const seconds = Number(value ?? 0)
  const labels = new Map([[0, 'Off'], [3600, '1 hour'], [86400, '1 day'], [604800, '1 week'], [2419200, '4 weeks']])
  return labels.get(seconds) || `${seconds} seconds`
}

function openGroupSettings(group) {
  $('editGroupName').value = group.instance.snapshot.groupData?.name || group.name
  $('editGroupDescription').value = group.instance.snapshot.groupData?.description || ''
  $('editGroupPhoto').value = ''
  $('editGroupPhotoPreview').classList.add('hidden')
  $('clearGroupPhoto').disabled = false
  void loadGroupPhoto(group, $('editGroupPhotoPreview'))
  const retention = String(group.instance.snapshot.groupData?.messageRetention ?? 0n)
  const select = $('editGroupRetention')
  if (![...select.options].some(option => option.value === retention)) {
    const option = document.createElement('option')
    option.value = retention
    option.textContent = retentionLabel(BigInt(retention))
    select.append(option)
  }
  select.value = retention
  $('groupSettingsForm').dataset.groupId = group.idStr
  $('groupSettingsDialog').classList.remove('hidden')
}

async function loadGroupPhoto(group, image) {
  if (!connection || !image) return
  try {
    const result = await window.MarmotCompanion.readGroupImage(connection.client, group.id, connection.blossomServers)
    if (result.kind !== 'available' || !image.isConnected) return
    const url = URL.createObjectURL(new Blob([result.bytes], { type: result.mediaType }))
    if (image.dataset.imageUrl) URL.revokeObjectURL(image.dataset.imageUrl)
    image.dataset.imageUrl = url
    if (image instanceof HTMLImageElement) image.src = url
    else image.style.backgroundImage = `url("${url}")`
    image.classList.remove('hidden')
    if (image.classList.contains('chat-avatar')) image.textContent = ''
  } catch (error) { console.debug('[white-noise] group image unavailable:', error?.message || error) }
}

async function enableGroupMedia(group) {
  const servers = connection.blossomServers || []
  if (!confirm(`Enable encrypted media for “${group.name}”? Files are encrypted before upload to ${servers.join(', ')}. Server operators can see upload metadata and network requests, but not file contents.`)) return
  try {
    await window.MarmotCompanion.enableGroupMedia(connection.client, group.id, servers)
    await refreshGroups()
    const updated = groups.find(item => item.idStr === group.idStr)
    if (updated) showGroupDetails(updated)
    message('Encrypted media enabled for this group.')
  } catch (error) { message(error?.message || String(error), true) }
}

function renderPendingAttachments() {
  const tray = $('attachmentTray')
  tray.replaceChildren()
  tray.classList.toggle('hidden', pendingAttachments.length === 0)
  for (const [index, file] of pendingAttachments.entries()) {
    const chip = document.createElement('div')
    chip.className = 'attachment-chip'
    const label = document.createElement('span')
    label.textContent = `${file.name} · ${formatBytes(file.size)}`
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.setAttribute('aria-label', `Remove ${file.name}`)
    remove.textContent = '×'
    remove.addEventListener('click', () => { pendingAttachments.splice(index, 1); renderPendingAttachments() })
    chip.append(label, remove)
    tray.append(chip)
  }
}

function addAttachments(files) {
  let remaining = [...files]
  const rejected = []
  while (remaining.length && pendingAttachments.length < 10) {
    const file = remaining.shift()
    const total = pendingAttachments.reduce((sum, item) => sum + item.size, 0)
    if (file.size > 0 && file.size <= 25 * 1024 * 1024 && total + file.size <= 100 * 1024 * 1024) pendingAttachments.push(file)
    else rejected.push(file)
  }
  rejected.push(...remaining)
  renderPendingAttachments()
  if (rejected.length) message('Choose up to 10 files, 25 MB each and 100 MB total.', true)
}

function formatBytes(size) {
  return size < 1024 * 1024 ? `${Math.ceil(size / 1024)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`
}

async function removeGroupMember(group, pubkey) {
  if (!confirm(`Remove ${pubkey.slice(0, 12)}… from “${group.name}”? They will lose access to future group messages.`)) return
  try {
    await window.MarmotCompanion.removeGroupMember(connection.client, group.id, pubkey)
    const current = await connection.client.groups.get(group.id)
    const updated = { ...group, instance: current, name: current.snapshot.groupData?.name || group.name }
    groups = groups.map(item => item.idStr === group.idStr ? updated : item)
    await refreshGroups()
    const refreshed = groups.find(item => item.idStr === group.idStr)
    if (refreshed) showGroupDetails(refreshed)
    message('Member removed from the group.')
  } catch (error) {
    message(error?.message || String(error), true)
  }
}

function openAdminHandoff(group) {
  const members = group.instance.snapshot.members || []
  const admins = group.instance.snapshot.groupData?.adminPubkeys || []
  const candidates = members.filter(pubkey => pubkey !== connection.pubkey)
  if (!candidates.length) {
    message('You are the only group member and admin. This group cannot be left through a member handoff.', true)
    return
  }
  const select = $('adminSuccessor')
  select.replaceChildren()
  for (const pubkey of candidates) {
    const option = document.createElement('option')
    option.value = pubkey
    option.textContent = `${pubkey.slice(0, 12)}…${admins.includes(pubkey) ? ' (current admin)' : ''}`
    select.append(option)
  }
  $('adminHandoffDescription').textContent = `Choose a member to retain admin access for “${group.name}”. The companion first publishes the admin change, then requests your removal.`
  $('adminHandoffDialog').classList.remove('hidden')
  $('adminHandoffForm').dataset.groupId = group.idStr
}

$('cancelAdminHandoff').addEventListener('click', () => $('adminHandoffDialog').classList.add('hidden'))
$('adminHandoffForm').addEventListener('submit', async event => {
  event.preventDefault()
  const form = event.currentTarget
  const group = groups.find(item => item.idStr === form.dataset.groupId)
  if (!group) return
  const submit = form.querySelector('button[type="submit"]')
  submit.disabled = true
  try {
    await window.MarmotCompanion.transferAdminAndLeave(connection.client, group.id, $('adminSuccessor').value)
    $('adminHandoffDialog').classList.add('hidden')
    activeGroup = null
    $('conversationView').classList.add('hidden')
    mainView.classList.remove('hidden')
    await refreshGroups()
    message('Admin transferred and leave request acknowledged.')
  } catch (error) {
    message(error?.message || String(error), true)
  } finally {
    submit.disabled = false
  }
})

$('settingsButton').addEventListener('click', showSettings)
$('toggleArchived').addEventListener('click', () => { showArchived = !showArchived; selectedFolderId = 'all'; renderGroups($('search').value) })
$('groupActions').addEventListener('click', () => {
  if (activeGroup) updateGroupMenu(activeGroup)
  const open = $('groupMenu').classList.toggle('hidden') === false
  $('groupActions').setAttribute('aria-expanded', String(open))
})
$('groupMenu').addEventListener('click', event => {
  const action = event.target.closest('[data-group-action]')?.dataset.groupAction
  if (activeGroup && action) {
    void manageGroup(activeGroup, action)
  }
})
$('createFolderForm').addEventListener('submit', async event => {
  event.preventDefault()
  const name = $('newFolderName').value.trim().slice(0, 40)
  if (!name) return
  if (folders.some(folder => folder.name.toLowerCase() === name.toLowerCase())) { message('A folder with that name already exists.', true); return }
  folders.push({ id: crypto.randomUUID(), name })
  await saveFolders()
  $('newFolderName').value = ''
  renderFolderManager()
  renderGroups($('search').value)
})
$('closeFolderManager').addEventListener('click', () => $('folderManagerDialog').classList.add('hidden'))
$('cancelFolderAssignment').addEventListener('click', () => $('folderAssignmentDialog').classList.add('hidden'))
$('folderAssignmentForm').addEventListener('submit', async event => {
  event.preventDefault()
  const groupId = event.currentTarget.dataset.groupId
  const folderId = $('folderAssignmentSelect').value || null
  await setChatUiState(groupId, { folderId })
  $('folderAssignmentDialog').classList.add('hidden')
  await refreshGroups()
  const folder = folders.find(item => item.id === folderId)
  message(folder ? `Chat moved to ${folder.name}.` : 'Chat removed from its folder.')
})
$('closeGroupDetails').addEventListener('click', () => $('groupDetailsDialog').classList.add('hidden'))
$('cancelGroupSettings').addEventListener('click', () => $('groupSettingsDialog').classList.add('hidden'))
$('clearGroupPhoto').addEventListener('click', async () => {
  const group = groups.find(item => item.idStr === $('groupSettingsForm').dataset.groupId)
  if (!group || !connection) return
  const button = $('clearGroupPhoto')
  button.disabled = true
  try {
    await window.MarmotCompanion.clearGroupImage(connection.client, group.id)
    $('editGroupPhotoPreview').classList.add('hidden')
    await refreshGroups()
    message('Group photo removed.')
  } catch (error) { message(error?.message || String(error), true) }
  finally { button.disabled = false }
})
$('groupSettingsForm').addEventListener('submit', async event => {
  event.preventDefault()
  const form = event.currentTarget
  const group = groups.find(item => item.idStr === form.dataset.groupId)
  if (!group || !connection) return
  const submit = form.querySelector('button[type="submit"]')
  submit.disabled = true
  try {
    const photo = $('editGroupPhoto').files?.[0]
    if (photo) {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(photo.type) || photo.size > 5 * 1024 * 1024) throw new Error('Choose a JPEG, PNG or WebP image smaller than 5 MB.')
      await window.MarmotCompanion.replaceGroupImage(connection.client, group.id, new Uint8Array(await photo.arrayBuffer()), photo.type, connection.blossomServers)
    }
    await window.MarmotCompanion.updateGroupMetadata(connection.client, group.id, {
      name: $('editGroupName').value,
      description: $('editGroupDescription').value,
      messageRetention: Number($('editGroupRetention').value)
    })
    $('groupSettingsDialog').classList.add('hidden')
    await refreshGroups()
    const refreshed = groups.find(item => item.idStr === group.idStr)
    if (refreshed) {
      if (activeGroup?.idStr === group.idStr) {
        activeGroup = refreshed
        $('conversationTitle').textContent = refreshed.name
        await showMessages()
      }
      showGroupDetails(refreshed)
    }
    message('Group details updated for members.')
  } catch (error) {
    message(error?.message || String(error), true)
  } finally {
    submit.disabled = false
  }
})
document.addEventListener('click', event => {
  if (!event.target.closest('#groupMenu, #groupActions, .row-menu')) {
    $('groupMenu').classList.add('hidden')
    $('groupActions').setAttribute('aria-expanded', 'false')
  }
  if (!event.target.closest('#newChatMenu, #newChat')) {
    $('newChatMenu').classList.add('hidden')
    $('newChat').setAttribute('aria-expanded', 'false')
  }
  if (!event.target.closest('#composerMenu, #plusButton')) {
    $('composerMenu').classList.add('hidden')
    $('plusButton').setAttribute('aria-expanded', 'false')
  }
})
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return
  $('groupMenu').classList.add('hidden')
  $('groupActions').setAttribute('aria-expanded', 'false')
  $('newChatMenu').classList.add('hidden')
  $('newChat').setAttribute('aria-expanded', 'false')
  if (!$('createGroupButton').disabled) $('createGroupForm').classList.add('hidden')
  $('composerMenu').classList.add('hidden')
  $('plusButton').setAttribute('aria-expanded', 'false')
  $('contactsPicker').classList.add('hidden')
})
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
$('switchAccountButton').addEventListener('click', () => {
  void (async () => {
    if (connection && await ncc.nostr.getPublicKey() === connection.pubkey) {
      message('Switch the active browser account. Its chats will load automatically.')
      return
    }
    await disconnectCurrentAccount()
    await connect()
  })()
})
$('connectButtonSettings').addEventListener('click', () => { showMain(); void connect() })
$('newChat').addEventListener('click', () => {
  const open = $('newChatMenu').classList.toggle('hidden') === false
  $('newChat').setAttribute('aria-expanded', String(open))
})
$('newChatMenu').addEventListener('click', event => {
  const action = event.target.closest('[data-new-action]')?.dataset.newAction
  $('newChatMenu').classList.add('hidden')
  $('newChat').setAttribute('aria-expanded', 'false')
  if (action === 'group') $('createGroupForm').classList.toggle('hidden')
  else if (action === 'chat') void openContactsPicker()
  else if (action === 'keypackage') void publishKeyPackage()
})
async function openContactsPicker() {
  $('createGroupForm').classList.add('hidden')
  $('contactsPicker').classList.remove('hidden')
  $('contactSearch').focus()
  await loadContacts(false)
}
let contactEntries = []
async function loadContacts(refresh) {
  const list = $('contactsList')
  list.replaceChildren()
  const loading = document.createElement('div')
  loading.className = 'contacts-empty'
  loading.textContent = refresh ? 'Refreshing contacts…' : 'Loading contacts…'
  list.append(loading)
  try {
    let state = refresh ? await ncc.contacts.refresh() : await ncc.contacts.state()
    if (!state?.list) state = await ncc.contacts.refresh()
    contactEntries = Array.isArray(state?.list?.contacts) ? state.list.contacts : []
    renderContactChoices($('contactSearch').value)
  } catch (error) {
    list.replaceChildren()
    const empty = document.createElement('div')
    empty.className = 'contacts-empty'
    empty.textContent = error?.message || 'Contacts could not be loaded.'
    list.append(empty)
  }
}
function renderContactChoices(query = '') {
  const list = $('contactsList')
  list.replaceChildren()
  const term = query.trim().toLocaleLowerCase()
  const matches = contactEntries.filter(contact => [contact.displayName, contact.name, contact.nip05, contact.pubkey].some(value => String(value || '').toLocaleLowerCase().includes(term)))
  if (!matches.length) {
    const empty = document.createElement('div')
    empty.className = 'contacts-empty'
    empty.textContent = contactEntries.length ? 'No matching contacts.' : 'No contacts found. Follow someone or enter their npub below.'
    list.append(empty)
    return
  }
  for (const contact of matches.slice(0, 200)) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'contact-choice'
    const avatar = document.createElement('span')
    avatar.className = 'chat-avatar'
    const name = contact.displayName?.trim() || contact.name?.trim() || contact.nip05?.trim() || shortPubkey(contact.pubkey)
    setAvatar(avatar, contact, name.slice(0, 1).toUpperCase())
    const copy = document.createElement('span')
    copy.className = 'contact-choice-copy'
    const strong = document.createElement('strong')
    strong.textContent = name
    const small = document.createElement('small')
    small.textContent = contact.nip05 || shortPubkey(contact.pubkey)
    copy.append(strong, small)
    button.append(avatar, copy)
    button.addEventListener('click', () => void startDirectChat(contact.pubkey, name, button))
    list.append(button)
  }
}
async function startDirectChat(address, name, button = null) {
  if (!connection) { message('Connect your browser account first.', true); return }
  let pubkey
  try { pubkey = window.MarmotCompanion.decodeContactNpub(address) }
  catch (error) { message(error?.message || String(error), true); return }
  if (!name || name === 'New chat') name = `Chat · ${shortPubkey(pubkey)}`
  const existing = groups.find(group => {
    const members = group.instance.snapshot.members || []
    return members.length === 2 && members.includes(connection.pubkey) && members.includes(pubkey)
  })
  if (existing) {
    $('contactsPicker').classList.add('hidden')
    await openGroup(existing)
    return
  }
  if (button) button.disabled = true
  $('contactsList').setAttribute('aria-busy', 'true')
  try {
    message(`Starting an encrypted chat with ${name}. Approve the invite key lookup and group creation when prompted.`)
    const group = await window.MarmotCompanion.createDirectChat(connection.client, connection.relays, pubkey, name)
    $('contactsPicker').classList.add('hidden')
    await refreshGroups()
    const entry = groups.find(item => item.id === group.snapshot.id)
    if (entry) await openGroup(entry)
    message(`Chat started with ${name}.`)
  } catch (error) { message(error?.message || String(error), true) }
  finally {
    $('contactsList').removeAttribute('aria-busy')
    if (button) button.disabled = false
  }
}
$('closeContactsPicker').addEventListener('click', () => $('contactsPicker').classList.add('hidden'))
$('refreshContacts').addEventListener('click', () => void loadContacts(true))
$('contactSearch').addEventListener('input', event => renderContactChoices(event.target.value))
$('directAddressForm').addEventListener('submit', event => {
  event.preventDefault()
  const address = $('directAddress').value.trim()
  if (!address) return
  void startDirectChat(address, 'New chat')
})
$('cancelCreateGroup').addEventListener('click', () => {
  if ($('createGroupButton').disabled) return
  $('createGroupForm').classList.add('hidden')
  $('groupName').value = 'Note to self'
  $('groupDescription').value = ''
  $('groupRetention').value = '0'
  message('')
})
$('createGroupButton').addEventListener('click', async () => {
  if (!connection) { message('Connect your browser account first.', true); return }
  const name = $('groupName').value.trim()
  if (!name) { message('Enter a group name.', true); return }
  $('createGroupButton').disabled = true
  try {
    message(`Creating “${name}” and sending the first encrypted message. Approve the request in your browser when prompted.`)
    const group = await window.MarmotCompanion.createGroup(connection.client, connection.relays, name, $('groupDescription').value, Number($('groupRetention').value))
    $('createGroupForm').classList.add('hidden')
    $('groupDescription').value = ''
    $('groupRetention').value = '0'
    await refreshGroups()
    const entry = groups.find(item => item.id === group.snapshot.id)
    if (entry) await openGroup(entry)
    message('Group created.')
  } catch (error) { message(error?.message || String(error), true) }
  finally { $('createGroupButton').disabled = false }
})
$('backConversation').addEventListener('click', () => {
  $('conversationView').classList.add('hidden')
  if (retentionRefreshTimeout) clearTimeout(retentionRefreshTimeout)
  retentionRefreshTimeout = null
  activeGroup = null
  clearReplyTarget()
  showMain()
})
$('plusButton').addEventListener('click', () => {
  const menu = $('composerMenu')
  const open = menu.classList.toggle('hidden') === false
  $('plusButton').setAttribute('aria-expanded', String(open))
})
$('inviteContactButton').addEventListener('click', () => {
  $('composerMenu').classList.add('hidden')
  $('plusButton').setAttribute('aria-expanded', 'false')
  contactAction = 'invite'
  $('contactAddressLabel').textContent = 'Member’s profile address'
  $('inviteForm').querySelector('button[type="submit"]').textContent = 'Invite'
  $('inviteForm').classList.remove('hidden')
  $('contactAddress').focus()
})
$('shareContactButton').addEventListener('click', () => {
  $('composerMenu').classList.add('hidden')
  $('plusButton').setAttribute('aria-expanded', 'false')
  contactAction = 'share'
  $('contactAddressLabel').textContent = 'Profile address to share'
  $('inviteForm').querySelector('button[type="submit"]').textContent = 'Share contact'
  $('inviteForm').classList.remove('hidden')
  $('contactAddress').focus()
})
function chooseAttachments(accept = '') {
  $('composerMenu').classList.add('hidden')
  $('plusButton').setAttribute('aria-expanded', 'false')
  const input = $('attachmentInput')
  input.accept = accept
  input.click()
}
$('addMediaButton').addEventListener('click', () => chooseAttachments('image/*,video/*'))
$('addFileButton').addEventListener('click', () => chooseAttachments())
$('attachmentInput').addEventListener('change', event => {
  addAttachments(event.currentTarget.files || [])
  event.currentTarget.value = ''
  event.currentTarget.accept = ''
})
$('composer').addEventListener('paste', event => {
  const files = [...(event.clipboardData?.files || [])]
  if (!files.length) return
  event.preventDefault()
  addAttachments(files)
})
$('cancelInvite').addEventListener('click', () => $('inviteForm').classList.add('hidden'))
$('cancelReply').addEventListener('click', clearReplyTarget)
$('createPollButton').addEventListener('click', () => {
  $('composerMenu').classList.add('hidden')
  $('plusButton').setAttribute('aria-expanded', 'false')
  $('pollForm').reset()
  $('pollOptions').replaceChildren()
  addPollOption('Option 1')
  addPollOption('Option 2')
  $('pollDialog').classList.remove('hidden')
  $('pollQuestion').focus()
})
$('addPollOption').addEventListener('click', () => addPollOption())
$('cancelPoll').addEventListener('click', () => $('pollDialog').classList.add('hidden'))
$('pollForm').addEventListener('submit', async event => {
  event.preventDefault()
  if (!connection || !activeGroup) { message('Open a group and connect your browser account first.', true); return }
  const button = $('pollForm').querySelector('button[type="submit"]')
  const options = [...$('pollOptions').querySelectorAll('input')].map(input => input.value)
  button.disabled = true
  try {
    await window.MarmotCompanion.createPoll(connection.client, activeGroup.id, $('pollQuestion').value, options, $('pollType').value)
    $('pollDialog').classList.add('hidden')
    await showMessages()
    message('Poll posted.')
  } catch (error) { message(error?.message || String(error), true) }
  finally { button.disabled = false }
})
$('inviteForm').addEventListener('submit', async event => {
  event.preventDefault()
  const button = $('inviteForm').querySelector('button[type="submit"]')
  if (!connection || !activeGroup) return
  button.disabled = true
  try {
    let outcome
    if (contactAction === 'share') {
      message('Sharing the contact card…')
      outcome = await window.MarmotCompanion.shareContact(connection.client, activeGroup.id, $('contactAddress').value)
    } else {
      message('Finding their invitation and adding them to the group…')
      outcome = await window.MarmotCompanion.inviteContact(connection.client, activeGroup.id, $('contactAddress').value, connection.relays)
    }
    $('inviteForm').classList.add('hidden')
    $('contactAddress').value = ''
    if (contactAction === 'share') {
      await showMessages()
      message('Contact shared.')
      return
    }
    const delivery = outcome?.kind === 'attempted' ? outcome.outcomes[0] : null
    if (delivery?.kind === 'succeeded') message('An inbox relay accepted the invite.')
    else message(delivery?.error || 'Invite delivery could not be confirmed.', true)
    await refreshGroups()
  } catch (error) { message(error?.message || String(error), true) }
  finally { button.disabled = false }
})
$('sendButton').addEventListener('click', async () => {
  const text = $('composer').value.trim()
  if ((!text && !pendingAttachments.length) || !activeGroup || !connection) return
  $('sendButton').disabled = true
  try {
    const rumor = pendingAttachments.length
      ? await window.MarmotCompanion.sendMedia(connection.client, activeGroup.id, pendingAttachments.map(file => ({ blob: file, metadata: { filename: file.name, type: file.type || 'application/octet-stream' } })), text, connection.mediaTransport, replyTarget)
      : await window.MarmotCompanion.send(connection.client, activeGroup.id, text, replyTarget)
    $('composer').value = ''
    const wasReply = Boolean(replyTarget)
    clearReplyTarget()
    if (!window.MarmotCompanion.mediaAttachments(rumor).length) await activeGroup.instance.history.saveRumor(rumor)
    pendingAttachments = []
    renderPendingAttachments()
    await showMessages()
    message(wasReply ? 'Reply sent.' : window.MarmotCompanion.mediaAttachments(rumor).length ? 'Attachment sent.' : 'Message sent.')
  } catch (error) { message(error?.message || String(error), true) }
  finally { $('sendButton').disabled = false }
})
$('composer').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('sendButton').click() } })
$('saveButton').addEventListener('click', async () => {
  const relays = $('relayInput').value.split(/\r?\n/).map(value => value.trim()).filter(Boolean)
  if (!relays.length || !relays.every(value => /^wss:\/\//i.test(value))) { message('Relay addresses must start with wss://.', true); return }
  const normalizedRelays = [...new Set(relays.map(value => {
    const url = new URL(value)
    if (url.protocol !== 'wss:' || !['relay.eu.whitenoise.chat', 'relay.us.whitenoise.chat', 'relay.damus.io', 'relay.primal.net', 'relay.ditto.pub', 'nos.lol'].includes(url.hostname) || url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error(`Relay host is not permitted by this prototype: ${url.hostname}`)
    return url.toString().replace(/\/$/, '')
  }))]
  const keyPackageEncoding = $('keyPackageEncoding').value === 'mdk08-raw' ? 'mdk08-raw' : 'framed'
  window.__NCC_WHITE_NOISE_KEY_PACKAGE_ENCODING__ = keyPackageEncoding
  desktopNotifications = $('desktopNotifications').checked
  await chrome.storage.local.set({ relays: normalizedRelays, relaysConfigured: true, desktopNotifications, keyPackageEncoding })
  selectedRelays = normalizedRelays
  if (connection) {
    liveConnection?.unsubscribe()
    connection.inviteListener?.unsubscribe()
    const fallbackRelays = withWhiteNoiseFallbacks(selectedRelays)
    connection = { ...connection, fallbackRelays }
    liveConnection = connection.client.groups.connectAll({ fallbackRelays })
    const inviteListener = await connection.client.invites.listen(selectedRelays)
    connection = { ...connection, relays: selectedRelays, fallbackRelays, inviteListener }
    const changedRelayGroups = []
    const failedRelayGroups = []
    const accountPubkey = await connection.client.signer.getPublicKey()
    const relayPlan = window.MarmotCompanion.planGroupRelayUpdates(
      await connection.client.groups.loadAll(), accountPubkey, selectedRelays
    )
    for (const { group, name } of relayPlan.update) {
      try {
        const result = await window.MarmotCompanion.updateGroupRelays(connection.client, group.id, selectedRelays)
        if (Object.values(result || {}).some(relay => relay.ok)) changedRelayGroups.push(name)
        else failedRelayGroups.push(`${name} (no relay acknowledged)`)
      } catch (error) {
        failedRelayGroups.push(`${name} (${error?.message || String(error)})`)
      }
    }
    liveConnection?.unsubscribe()
    liveConnection = connection.client.groups.connectAll({ fallbackRelays: connection.fallbackRelays })
    await refreshGroups()
    await refreshInvites()
    const summary = [`Relay list saved and active group subscriptions refreshed. ${changedRelayGroups.length} group(s) updated.`]
    if (relayPlan.adminRequired.length) {
      summary.push(`${relayPlan.adminRequired.length} group(s) kept their shared relay list because only a group admin can change it.`)
    }
    if (failedRelayGroups.length) summary.push(`Failed: ${failedRelayGroups.join('; ')}`)
    message(summary.join(' '), failedRelayGroups.length > 0)
  } else message('Relay list saved. It will be used when you connect your browser account.')
})
$('relayInput').setAttribute('placeholder', 'Primary relays, one per line. White Noise EU/US are appended as fallbacks.')
$('search').addEventListener('input', () => renderGroups($('search').value))
async function initialize() {
  const { connectedSignerPubkey } = await chrome.storage.local.get('connectedSignerPubkey')
  if (connectedSignerPubkey) await connect()
  else await load()
}

void initialize()
