const defaults = { relays: ['wss://relay.damus.io', 'wss://relay.primal.net', 'wss://relay.ditto.pub'], useBrowserIdentity: false, keyPackageEncoding: 'framed' }
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
let groups = []
let activeGroup = null
const observedGroupInstances = new WeakSet()
let liveConnection = null
let selectedRelays = defaults.relays
let groupRefreshTimer = null
let showArchived = false
let pendingAttachments = []
let renderedMediaUrls = []
let inviteRefreshTimer = null
let signerWatchTimer = null
let pendingInvites = []
let contactAction = 'invite'
let replyTarget = null
let retentionRefreshTimeout = null

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
  $('useBrowserIdentity').checked = Boolean(saved.useBrowserIdentity)
  $('accountName').textContent = connection ? 'NCC signer connected' : 'Not connected'
  $('accountKey').textContent = connection ? `${connection.pubkey.slice(0, 12)}…${connection.pubkey.slice(-8)}` : 'Connect the NCC signer to begin'
  $('connectButton').textContent = connection ? 'Connected' : 'Connect NCC signer'
  $('connectButton').disabled = Boolean(connection || connectionAttempt)
  $('switchAccountButton').classList.toggle('hidden', !connection)
  if (connection) setStatus('Relay session active', true)
  else setStatus('Not connected')
  renderGroups()
}

function sameRelays(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every(relay => right.includes(relay))
}

function withWhiteNoiseFallbacks(primaryRelays) {
  return [...new Set([...primaryRelays, ...WHITE_NOISE_FALLBACK_RELAYS])]
}

function renderGroups(filter = '') {
  const list = $('chatList')
  list.replaceChildren()
  const query = filter.trim().toLowerCase()
  const matching = groups
    .filter(group => Boolean(group.archived) === showArchived && (group.name || 'Untitled group').toLowerCase().includes(query))
    .sort((left, right) => Number(right.pinned) - Number(left.pinned) || left.order - right.order)
  $('toggleArchived').textContent = showArchived ? 'Chats' : 'Archived'
  $('chatSectionTitle').textContent = showArchived ? 'ARCHIVED' : 'CHATS'
  if (!matching.length) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    const title = query ? 'No chats match your search' : connection ? 'No conversations yet' : 'Connect to get started'
    const description = query ? 'Try a different name.' : connection ? 'Create a key package so contacts can invite you to an encrypted group.' : 'Connect the NCC signer to load your Marmot conversations.'
    empty.innerHTML = `<div class="empty-icon">◌</div><strong>${title}</strong><p>${description}</p>`
    if (!query) {
      const button = document.createElement('button')
      button.className = 'primary'
      if (connection) {
        button.textContent = 'Create invite key package'
        button.addEventListener('click', () => void publishKeyPackage())
      } else {
        button.textContent = 'Connect NCC signer'
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

function escapeHtml(value) {
  const span = document.createElement('span')
  span.textContent = value
  return span.innerHTML
}

async function refreshGroups() {
  if (!connection) return
  const loaded = await window.MarmotCompanion.listGroups(connection.client)
  groups = await Promise.all(loaded.map(async group => {
    const history = retainedHistory(group, await window.MarmotCompanion.history(group))
    if (!observedGroupInstances.has(group)) {
      observedGroupInstances.add(group)
      group.on('changed', () => void refreshGroups())
      group.history.on('rumor', rumor => {
        if (activeGroup?.idStr !== group.idStr && (rumor?.kind === 9 || rumor?.kind === 1068) && rumorIsRetained(group, rumor)) {
          void setChatUiState(group.idStr, { unread: true })
        }
        void refreshGroups()
        if (activeGroup?.idStr === group.idStr) void showMessages(activeGroup)
      })
    }
    const key = `marmot:chat-ui:${connection.pubkey}:${group.idStr}`
    const uiState = (await chrome.storage.local.get(key))[key] || {}
    const lastChatMessage = history.find(rumor => rumor.kind === 9 || rumor.kind === 1068)
    const preview = lastChatMessage?.kind === 1068 ? `Poll: ${lastChatMessage.content}` : lastChatMessage?.content.startsWith('nostr:') ? 'Shared a contact' : lastChatMessage?.content
    return { id: group.snapshot.id, idStr: group.idStr, name: group.snapshot.groupData?.name || 'Encrypted group', memberCount: group.snapshot.members?.length, epoch: String(group.snapshot.epoch ?? '—'), instance: group, last: lastChatMessage ? { ...lastChatMessage, content: preview } : null, archived: Boolean(uiState.archived), pinned: Boolean(uiState.pinned), muted: Boolean(uiState.muted), unread: Boolean(uiState.unread), order: Number.isFinite(uiState.order) ? uiState.order : loaded.indexOf(group) }
  }))
  renderGroups($('search').value)
}

async function refreshInvites() {
  if (!connection) return
  try {
    pendingInvites = await window.MarmotCompanion.getInvites(connection.client)
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
      : 'This invite does not match a saved key package.'
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
    setStatus('Connecting to NCC signer…')
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
    await refreshGroups()
    await refreshInvites()
    if (groupRefreshTimer) clearInterval(groupRefreshTimer)
    groupRefreshTimer = setInterval(() => { void refreshGroups() }, 5000)
    if (inviteRefreshTimer) clearInterval(inviteRefreshTimer)
    inviteRefreshTimer = setInterval(() => { void refreshInvites() }, 5000)
    if (signerWatchTimer) clearInterval(signerWatchTimer)
    signerWatchTimer = setInterval(() => { void checkActiveSigner() }, 5000)
    await chrome.storage.local.set({ connectedSignerPubkey: runtime.pubkey })
    setStatus(`Connected · ${relays.length} relays`, true)
    message('Signer approved. Chats and incoming group invitations are listening on the selected relays.')
  } catch (error) {
    setStatus('Connection failed')
    message(error?.message || String(error), true)
  } finally {
    connectionAttempt = false
    await load()
  }
}

async function disconnectCurrentAccount() {
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
    message('NCC profile changed. Loading chats for the active profile…')
    await connect()
  } catch (error) {
    message(`Could not refresh the active NCC profile: ${error?.message || String(error)}`, true)
  }
}

async function publishKeyPackage() {
  if (!connection) return
  const button = $('newChat')
  button.disabled = true
  try {
    message('Publishing your invite key and inbox relay list. NCC will ask you to approve the Nostr signatures.')
    const entry = await window.MarmotCompanion.createKeyPackage(connection.client, connection.relays)
    const responses = Object.entries(entry.publication?.responses || {})
    const accepted = responses.filter(([, result]) => result.ok).map(([relay]) => new URL(relay).hostname)
    const failed = responses.filter(([, result]) => !result.ok).map(([relay, result]) => `${new URL(relay).hostname}${result.message ? ` (${result.message})` : ''}`)
    const inboxAccepted = Object.values(entry.inboxPublication || {}).filter(result => result.ok).length
    if (!accepted.length) {
      message(`Key package created locally, but no relay acknowledged publication.${failed.length ? ` Failed: ${failed.join('; ')}` : ' No relay response was received.'}`, true)
    } else {
      message(`Invite key package published to ${accepted.length} relay(s); inbox relay list is available on ${inboxAccepted} relay(s). Share your public key with a contact so they can invite you.${failed.length ? ` Failed: ${failed.join('; ')}` : ''}`, failed.length > 0)
    }
  } catch (error) { message(error?.message || String(error), true) }
  finally { button.disabled = false }
}

async function showMessages(group) {
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
        if (activeGroup?.idStr === group.idStr) void showMessages(group)
      }, Math.min(2147483647, Math.max(100, (nextExpiry - now) * 1000 + 50)))
    }
  }
  const visibleHistory = history.filter(rumor => rumor.kind === 9 || rumor.kind === 1068)
  const list = $('messageList')
  for (const url of renderedMediaUrls) URL.revokeObjectURL(url)
  renderedMediaUrls = []
  const query = $('messageSearch').value.trim().toLowerCase()
  const matches = visibleHistory.filter(rumor => !query || rumor.content.toLowerCase().includes(query) || (rumor.tags || []).some(tag => tag[0] === 'option' && String(tag[2] || '').toLowerCase().includes(query)) || window.MarmotCompanion.mediaAttachments(rumor).some(item => item.filename.toLowerCase().includes(query)))
  list.replaceChildren()
  if (!matches.length) {
    const empty = document.createElement('p')
    empty.className = 'field-hint'
    empty.textContent = query ? 'No messages match this search.' : allHistory.length > history.length ? 'No messages remain under this group’s disappearing-message timer.' : 'No messages yet. Messages are end-to-end encrypted with MLS.'
    list.append(empty)
    return
  }
  for (const rumor of [...matches].reverse()) {
    const row = document.createElement('article')
    row.className = 'message-bubble'
    const author = document.createElement('strong')
    author.textContent = rumor.pubkey === connection.pubkey ? 'You' : `${rumor.pubkey.slice(0, 12)}…`
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
      const open = document.createElement('button')
      open.type = 'button'
      open.className = 'attachment-download secondary'
      open.textContent = `Download ${attachments.length === 1 ? attachments[0].filename : `${attachments.length} attachments`}`
      open.addEventListener('click', async () => {
        open.disabled = true
        open.textContent = 'Downloading and decrypting…'
        try {
          const results = await window.MarmotCompanion.downloadMedia(connection.client, group.id, rumor, connection.mediaTransport)
          for (const result of results) {
            if (result.status !== 'ready') continue
            const blob = new Blob([result.data], { type: result.attachment.mediaType })
            const url = URL.createObjectURL(blob)
            renderedMediaUrls.push(url)
            const link = document.createElement('a')
            link.href = url
            link.download = result.attachment.filename
            link.className = 'attachment-file'
            if (result.attachment.mediaType.startsWith('image/')) {
              const img = document.createElement('img')
              img.src = url
              img.alt = result.attachment.filename
              link.append(img)
            } else {
              link.textContent = `${result.attachment.filename} · ${result.attachment.mediaType} · click to save`
            }
            row.append(link)
          }
          if (results.some(result => result.status === 'unavailable')) message('Some attachments could not be downloaded or decrypted.', true)
          open.remove()
        } catch (error) {
          open.disabled = false
          open.textContent = 'Retry download'
          message(error?.message || String(error), true)
        }
      })
      row.append(open)
    }
    list.append(row)
  }
  list.scrollTop = list.scrollHeight
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
  copy.textContent = 'Copy npub'
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(npub)
      message('Contact npub copied.')
    } catch (error) { message(error?.message || 'Could not copy the npub.', true) }
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
        await showMessages(group)
        message('Vote sent through MLS.')
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
  if (activeGroup) void showMessages(activeGroup)
})
$('clearMessageSearch').addEventListener('click', () => {
  $('messageSearch').value = ''
  if (activeGroup) void showMessages(activeGroup)
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
  $('conversationTitle').textContent = group.name || 'Encrypted group'
  $('conversationView').classList.remove('hidden')
  mainView.classList.add('hidden')
  await showMessages(group)
}

async function manageGroup(group, action) {
  $('groupMenu').classList.add('hidden')
  if (action === 'details') {
    showGroupDetails(group)
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
          ? (value ? 'Notification preference saved. Desktop notifications are not available yet.' : 'Chat unmuted on this device.')
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
      if (activeGroup?.idStr === group.idStr) await showMessages(group)
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
      if (!confirm(`Leave "${group.name}"? Its local MLS state will be removed after a relay acknowledges the leave request.`)) return
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
  addDetail('MLS epoch', String(snapshot.epoch ?? '—'))
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
$('toggleArchived').addEventListener('click', () => { showArchived = !showArchived; renderGroups($('search').value) })
$('groupActions').addEventListener('click', () => {
  if (activeGroup) updateGroupMenu(activeGroup)
  $('groupMenu').classList.toggle('hidden')
})
$('groupMenu').addEventListener('click', event => {
  const action = event.target.closest('[data-group-action]')?.dataset.groupAction
  if (activeGroup && action) {
    void manageGroup(activeGroup, action)
  }
})
$('closeGroupDetails').addEventListener('click', () => $('groupDetailsDialog').classList.add('hidden'))
$('cancelGroupSettings').addEventListener('click', () => $('groupSettingsDialog').classList.add('hidden'))
$('groupSettingsForm').addEventListener('submit', async event => {
  event.preventDefault()
  const form = event.currentTarget
  const group = groups.find(item => item.idStr === form.dataset.groupId)
  if (!group || !connection) return
  const submit = form.querySelector('button[type="submit"]')
  submit.disabled = true
  try {
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
        await showMessages(refreshed)
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
  if (!event.target.closest('#groupMenu, #groupActions, .row-menu')) $('groupMenu').classList.add('hidden')
  if (!event.target.closest('#newChatMenu, #newChat')) $('newChatMenu').classList.add('hidden')
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
      message('Switch the active NCC profile in the browser. The companion will load its chats automatically.')
      return
    }
    await disconnectCurrentAccount()
    await connect()
  })()
})
$('connectButtonSettings').addEventListener('click', () => { showMain(); void connect() })
$('newChat').addEventListener('click', () => $('newChatMenu').classList.toggle('hidden'))
$('newChatMenu').addEventListener('click', event => {
  const action = event.target.closest('[data-new-action]')?.dataset.newAction
  $('newChatMenu').classList.add('hidden')
  if (action === 'group') $('createGroupForm').classList.toggle('hidden')
  else if (action === 'keypackage') void publishKeyPackage()
})
$('createGroupButton').addEventListener('click', async () => {
  if (!connection) { message('Connect the NCC signer first.', true); return }
  const name = $('groupName').value.trim()
  if (!name) { message('Enter a group name.', true); return }
  $('createGroupButton').disabled = true
  try {
    message(`Creating “${name}” and publishing the initial encrypted note… NCC will ask you to approve signatures.`)
    const group = await window.MarmotCompanion.createGroup(connection.client, connection.relays, name, $('groupDescription').value, Number($('groupRetention').value))
    $('createGroupForm').classList.add('hidden')
    $('groupDescription').value = ''
    $('groupRetention').value = '0'
    await refreshGroups()
    const entry = groups.find(item => item.id === group.snapshot.id)
    if (entry) await openGroup(entry)
    message('Group created and initial note sent through MLS.')
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
  $('contactAddressLabel').textContent = 'Contact public key'
  $('inviteForm').querySelector('button[type="submit"]').textContent = 'Invite'
  $('inviteForm').classList.remove('hidden')
  $('contactAddress').focus()
})
$('shareContactButton').addEventListener('click', () => {
  $('composerMenu').classList.add('hidden')
  $('plusButton').setAttribute('aria-expanded', 'false')
  contactAction = 'share'
  $('contactAddressLabel').textContent = 'Contact to share'
  $('inviteForm').querySelector('button[type="submit"]').textContent = 'Share contact'
  $('inviteForm').classList.remove('hidden')
  $('contactAddress').focus()
})
$('addAttachmentButton').addEventListener('click', () => {
  $('composerMenu').classList.add('hidden')
  $('plusButton').setAttribute('aria-expanded', 'false')
  $('attachmentInput').click()
})
$('attachmentInput').addEventListener('change', event => {
  addAttachments(event.currentTarget.files || [])
  event.currentTarget.value = ''
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
  if (!connection || !activeGroup) { message('Open a group and connect the NCC signer first.', true); return }
  const button = $('pollForm').querySelector('button[type="submit"]')
  const options = [...$('pollOptions').querySelectorAll('input')].map(input => input.value)
  button.disabled = true
  try {
    await window.MarmotCompanion.createPoll(connection.client, activeGroup.id, $('pollQuestion').value, options, $('pollType').value)
    $('pollDialog').classList.add('hidden')
    await showMessages(activeGroup)
    message('Poll posted through MLS.')
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
      message('Sharing the contact card through MLS…')
      outcome = await window.MarmotCompanion.shareContact(connection.client, activeGroup.id, $('contactAddress').value)
    } else {
      message('Looking up the contact key package and sending an encrypted group invite…')
      outcome = await window.MarmotCompanion.inviteContact(connection.client, activeGroup.id, $('contactAddress').value, connection.relays)
    }
    $('inviteForm').classList.add('hidden')
    $('contactAddress').value = ''
    if (contactAction === 'share') {
      await showMessages(activeGroup)
      message('Contact card sent through MLS.')
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
  if (replyTarget && pendingAttachments.length) {
    message('Remove the attachment or cancel the reply before sending.', true)
    return
  }
  $('sendButton').disabled = true
  try {
    const rumor = pendingAttachments.length
      ? await window.MarmotCompanion.sendMedia(connection.client, activeGroup.id, pendingAttachments.map(file => ({ blob: file, metadata: { filename: file.name, type: file.type || 'application/octet-stream' } })), text, connection.mediaTransport)
      : await window.MarmotCompanion.send(connection.client, activeGroup.id, text, replyTarget, activeGroup.instance.snapshot.groupData?.relays || [])
    $('composer').value = ''
    const wasReply = Boolean(replyTarget)
    clearReplyTarget()
    if (!window.MarmotCompanion.mediaAttachments(rumor).length) await activeGroup.instance.history.saveRumor(rumor)
    pendingAttachments = []
    renderPendingAttachments()
    await showMessages(activeGroup)
    message(window.MarmotCompanion.mediaAttachments(rumor).length ? 'Encrypted attachment sent through MLS.' : wasReply ? 'Reply sent through MLS.' : 'Message sent through MLS.')
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
  await chrome.storage.local.set({ relays: normalizedRelays, relaysConfigured: true, useBrowserIdentity: $('useBrowserIdentity').checked, keyPackageEncoding })
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
    liveConnection = connection.client.groups.connectAll({ fallbackRelays: connection.fallbackRelays })
    await refreshGroups()
    await refreshInvites()
    const summary = [`Relay list saved and active group subscriptions refreshed. ${changedRelayGroups.length} group(s) updated.`]
    if (failedRelayGroups.length) summary.push(`Failed: ${failedRelayGroups.join('; ')}`)
    message(summary.join(' '), failedRelayGroups.length > 0)
  } else message('Relay list saved. It will be used when the NCC signer connects.')
})
$('relayInput').setAttribute('placeholder', 'Primary relays, one per line. White Noise EU/US are appended as fallbacks.')
$('openWhiteNoise').addEventListener('click', () => message('White Noise desktop is not installed in this development profile.'))
$('search').addEventListener('input', () => renderGroups($('search').value))
async function initialize() {
  const { connectedSignerPubkey } = await chrome.storage.local.get('connectedSignerPubkey')
  if (connectedSignerPubkey) await connect()
  else await load()
}

void initialize()
