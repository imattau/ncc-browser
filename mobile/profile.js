const PROFILE_KEY = 'ncc.profiles'
const PROFILE_TTL = 6 * 60 * 60 * 1000
const PROFILE_CACHE_LIMIT = 8
const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'

/** `npub1…` to the 64-character hex key. The checksum is not needed to read one. */
export function npubToHex(npub) {
  const text = String(npub || '').toLowerCase()
  if (!text.startsWith('npub1')) return null
  const data = [...text.slice(5, -6)].map((char) => BECH32.indexOf(char))
  if (data.length === 0 || data.includes(-1)) return null

  let acc = 0
  let bits = 0
  const out = []
  for (const value of data) {
    acc = (acc << 5) | value
    bits += 5
    while (bits >= 8) {
      bits -= 8
      out.push((acc >> bits) & 255)
    }
    acc &= (1 << bits) - 1
  }
  return out.length === 32 ? out.map((byte) => byte.toString(16).padStart(2, '0')).join('') : null
}

export function createProfile({ invoke, byId, avatar, shortId, getIdentity, getBrowserSettings }) {
  const profilePictureRequests = new Set()
  let profile = null

  function readProfiles() {
    try {
      const value = JSON.parse(globalThis.localStorage?.getItem(PROFILE_KEY) || '{}')
      return value && typeof value === 'object' ? value : {}
    } catch {
      return {}
    }
  }

  function boundedProfiles(profiles) {
    const keep = Object.entries(profiles)
      .sort((a, b) => (b[1]?.at || 0) - (a[1]?.at || 0))
      .slice(0, PROFILE_CACHE_LIMIT)
    return Object.fromEntries(keep)
  }

  function saveProfile(hex, profile) {
    const profiles = readProfiles()
    profiles[hex] = { ...profile, at: Date.now() }
    try {
      globalThis.localStorage?.setItem(PROFILE_KEY, JSON.stringify(boundedProfiles(profiles)))
    } catch {
      // Not persisted; it is asked for again next launch.
    }
  }

  function saveProfilePicture(hex, url, pictureData) {
    const profiles = readProfiles()
    const cached = profiles[hex]
    if (!cached || cached.picture !== url) return false
    profiles[hex] = { ...cached, pictureData, pictureDataAt: Date.now() }
    try {
      globalThis.localStorage?.setItem(PROFILE_KEY, JSON.stringify(boundedProfiles(profiles)))
      return true
    } catch {
      // Keep the remote URL and retry on the next launch if storage is full.
      return false
    }
  }

  /** Only https images: a profile is written by someone else and shown as-is. */
  function safePicture(url) {
    try {
      return new URL(url).protocol === 'https:' ? url : ''
    } catch {
      return ''
    }
  }

  function isCachedPictureData(value) {
    return typeof value === 'string' && /^data:image\/(?:jpeg|png|webp|gif|avif);base64,[a-z0-9+/]+={0,2}$/i.test(value)
  }

  /** Newest kind 0 for a key, asked of the user's own relays. */
  function queryProfile(hex, relays) {
    return new Promise((resolve) => {
      const urls = relays.filter((url) => /^wss?:\/\//i.test(url)).slice(0, 5)
      if (urls.length === 0) return resolve(null)

      let best = null
      let remaining = urls.length
      const sockets = []
      let finished = false

      const finish = () => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        for (const socket of sockets) {
          try {
            socket.close()
          } catch {
            // Already closed.
          }
        }
        resolve(best)
      }
      const timer = setTimeout(finish, 6000)

      for (const url of urls) {
        let settled = false
        const settle = () => {
          if (settled) return
          settled = true
          if (--remaining === 0) finish()
        }

        let socket
        try {
          socket = new WebSocket(url)
        } catch {
          settle()
          continue
        }
        sockets.push(socket)

        const sub = `p${Math.random().toString(36).slice(2, 8)}`
        socket.onopen = () => socket.send(JSON.stringify(['REQ', sub, { kinds: [0], authors: [hex], limit: 1 }]))
        socket.onmessage = (message) => {
          try {
            const data = JSON.parse(message.data)
            if (data[0] === 'EVENT' && data[2]?.kind === 0 && data[2].pubkey === hex) {
              if (!best || data[2].created_at > best.created_at) best = data[2]
            }
            if (data[0] === 'EOSE') settle()
          } catch {
            // Not a frame we understand.
          }
        }
        socket.onerror = settle
        socket.onclose = settle
      }
    })
  }

  /** Show what is cached straight away, then refresh it if it is stale. */
  async function loadProfile() {
    const hex = npubToHex(getIdentity()?.npub)
    if (!hex || !getIdentity()?.unlocked) {
      profile = null
      renderHomeIdentity()
      return
    }

    const cached = readProfiles()[hex]
    profile = cached || null
    renderHomeIdentity()
    if (cached && Date.now() - cached.at < PROFILE_TTL) {
      if (cached.picture && !cached.pictureData) void cacheProfilePicture(hex, cached.picture)
      return
    }

    const event = await queryProfile(hex, getBrowserSettings()?.relays || [])
    if (!event || npubToHex(getIdentity()?.npub) !== hex) return

    try {
      const meta = JSON.parse(event.content)
      const picture = safePicture(meta.picture)
      const previous = readProfiles()[hex]
      saveProfile(hex, {
        name: String(meta.display_name || meta.name || '').slice(0, 60),
        picture,
        pictureData: picture && picture === previous?.picture ? previous.pictureData || '' : ''
      })
      profile = readProfiles()[hex]
      renderHomeIdentity()
      if (profile?.picture && !profile.pictureData) void cacheProfilePicture(hex, profile.picture)
    } catch {
      // A profile that is not JSON is ignored; the app icon stays.
    }
  }

  /** Scale an image data URL to a small square avatar. Null if it cannot be decoded. */
  function shrinkPicture(dataUrl, size = 192) {
    return new Promise((resolve) => {
      const image = new Image()
      image.onload = () => {
        try {
          const side = Math.min(image.naturalWidth, image.naturalHeight)
          if (!side) return resolve(null)
          const canvas = document.createElement('canvas')
          canvas.width = canvas.height = Math.min(size, side)
          const context = canvas.getContext('2d')
          context.drawImage(
            image,
            (image.naturalWidth - side) / 2,
            (image.naturalHeight - side) / 2,
            side,
            side,
            0,
            0,
            canvas.width,
            canvas.height
          )
          const webp = canvas.toDataURL('image/webp', 0.85)
          resolve(isCachedPictureData(webp) ? webp : canvas.toDataURL('image/jpeg', 0.85))
        } catch {
          resolve(null)
        }
      }
      image.onerror = () => resolve(null)
      image.src = dataUrl
    })
  }

  async function cacheProfilePicture(hex, url) {
    const requestKey = `${hex}|${url}`
    if (profilePictureRequests.has(requestKey)) return
    profilePictureRequests.add(requestKey)
    try {
      const downloaded = await invoke('profile_picture_data', { url })
      if (!downloaded || npubToHex(getIdentity()?.npub) !== hex) return
      // Avatars are shown small; keep a compact copy so the local cache stays within quota.
      const pictureData = await shrinkPicture(downloaded)
      if (!pictureData) return
      if (!saveProfilePicture(hex, url, pictureData)) return
      profile = readProfiles()[hex] || null
      renderHomeIdentity()
    } catch {
      // The cached letter avatar remains usable when the image host is unavailable.
    } finally {
      profilePictureRequests.delete(requestKey)
    }
  }

  function renderHomeIdentity() {
    const text = byId('home-identity-text')
    const mark = byId('brand-mark')
    const identity = getIdentity()
    if (!identity) return

    text.textContent = !identity.initialised
      ? 'Set up your identity'
      : identity.unlocked
        ? `${profile?.name ? `${profile.name} · ` : 'Unlocked · '}${shortId(identity.npub)}`
        : `Locked · ${shortId(identity.npub)}`

    const signedIn = identity.initialised && identity.unlocked
    const picture = signedIn && isCachedPictureData(profile?.pictureData) ? profile.pictureData : ''
    const key = `${signedIn}|${profile?.picture || ''}|${profile?.pictureDataAt || 0}|${profile?.name || ''}`
    if (mark.dataset.key === key) return
    mark.dataset.key = key

    mark.classList.toggle('is-avatar', signedIn)
    mark.textContent = ''

    const fallback = () => {
      mark.textContent = ''
      mark.appendChild(avatar(profile?.name || identity.npub || 'N'))
    }

    if (!signedIn) {
      const image = document.createElement('img')
      image.src = 'app-icon.png'
      image.alt = ''
      image.draggable = false
      mark.appendChild(image)
    } else if (picture) {
      const image = document.createElement('img')
      image.alt = ''
      image.draggable = false
      image.addEventListener('error', fallback)
      image.src = picture
      mark.appendChild(image)
    } else {
      fallback()
    }
  }

  return { loadProfile, renderHomeIdentity }
}
