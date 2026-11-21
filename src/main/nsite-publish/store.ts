import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  validateNsiteFiles,
  validateNsiteSiteId,
  type NsitePublishState,
  type NsiteSiteFile,
  type PublishedNsite
} from '@shared/nsite-publish'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function emptyState(): NsitePublishState {
  return { version: 1, sites: [] }
}

/**
 * Published nsite manifests in `userData/nsite-sites.json`. Only the index is stored;
 * the files live on Blossom by hash. Writes are atomic and `0600`.
 */
export class NsiteStore {
  private cache: NsitePublishState | null = null

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = nowSeconds
  ) {}

  state(): NsitePublishState {
    return clone(this.ensure())
  }

  find(id: string): PublishedNsite | null {
    return clone(this.ensure().sites.find((site) => site.id === id) ?? null)
  }

  findByAddress(owner: string, siteId: string | null): PublishedNsite | null {
    const hex = owner.toLowerCase()
    return clone(
      this.ensure().sites.find((site) => site.owner === hex && site.siteId === siteId) ?? null
    )
  }

  upsert(site: PublishedNsite): PublishedNsite {
    const state = this.ensure()
    const index = state.sites.findIndex((entry) => entry.id === site.id)
    if (index === -1) state.sites.push(site)
    else state.sites[index] = site
    this.flush()
    return clone(site)
  }

  remove(id: string): void {
    const state = this.ensure()
    state.sites = state.sites.filter((site) => site.id !== id)
    this.flush()
  }

  markPublished(id: string, at = this.now()): void {
    const site = this.ensure().sites.find((entry) => entry.id === id)
    if (!site) return
    site.lastPublishedAt = at
    delete site.lastPublishError
    this.flush()
  }

  markError(id: string, message: string): void {
    const site = this.ensure().sites.find((entry) => entry.id === id)
    if (!site) return
    site.lastPublishError = message.slice(0, 500)
    this.flush()
  }

  private ensure(): NsitePublishState {
    this.cache ??= this.read()
    return this.cache
  }

  private read(): NsitePublishState {
    if (!existsSync(this.filePath)) return emptyState()
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<NsitePublishState>
      if (!parsed || parsed.version !== 1) return emptyState()
      return normalizeState(parsed, this.now())
    } catch (error) {
      console.warn('[nsite-publish] ignoring unreadable sites file:', error)
      return emptyState()
    }
  }

  private flush(): void {
    const state = this.ensure()
    mkdirSync(dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.tmp`
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    })
    renameSync(temporary, this.filePath)
    try {
      chmodSync(this.filePath, 0o600)
    } catch {
      // Some filesystems do not implement POSIX modes.
    }
  }
}

function normalizeState(parsed: Partial<NsitePublishState>, now: number): NsitePublishState {
  const sites: PublishedNsite[] = []
  const seen = new Set<string>()
  for (const raw of Array.isArray(parsed.sites) ? parsed.sites : []) {
    if (!raw || typeof raw !== 'object') continue
    const candidate = raw as Partial<PublishedNsite>
    if (
      typeof candidate.id !== 'string' ||
      typeof candidate.owner !== 'string' ||
      !/^[0-9a-f]{64}$/i.test(candidate.owner) ||
      (candidate.siteId !== null && typeof candidate.siteId !== 'string') ||
      validateNsiteSiteId(candidate.siteId ?? null) !== null ||
      typeof candidate.manifestEventId !== 'string' ||
      !Array.isArray(candidate.files)
    ) {
      continue
    }
    const siteId = candidate.siteId ? candidate.siteId : null
    const key = `${candidate.owner.toLowerCase()}:${siteId ?? ''}`
    if (seen.has(key)) continue
    const files: NsiteSiteFile[] = candidate.files
      .filter((file): file is NsiteSiteFile =>
        Boolean(
          file &&
            typeof file.path === 'string' &&
            file.path.startsWith('/') &&
            typeof file.hash === 'string' &&
            /^[0-9a-f]{64}$/i.test(file.hash) &&
            Number.isFinite(file.size)
        )
      )
      .map((file) => ({ path: file.path, hash: file.hash.toLowerCase(), size: file.size }))
    if (validateNsiteFiles(files).length > 0) continue
    const servers = (Array.isArray(candidate.servers) ? candidate.servers : [])
      .filter((server): server is string => typeof server === 'string' && /^https?:\/\//i.test(server))
      .slice(0, 8)
    const createdAt = Number.isFinite(candidate.createdAt) ? Number(candidate.createdAt) : now
    sites.push({
      id: candidate.id,
      owner: candidate.owner.toLowerCase(),
      siteId,
      ...(typeof candidate.title === 'string' ? { title: candidate.title.slice(0, 120) } : {}),
      ...(typeof candidate.description === 'string'
        ? { description: candidate.description.slice(0, 400) }
        : {}),
      ...(typeof candidate.source === 'string' ? { source: candidate.source.slice(0, 500) } : {}),
      servers,
      files,
      manifestEventId: candidate.manifestEventId,
      createdAt,
      updatedAt: Number.isFinite(candidate.updatedAt) ? Number(candidate.updatedAt) : createdAt,
      ...(Number.isFinite(candidate.lastPublishedAt)
        ? { lastPublishedAt: Number(candidate.lastPublishedAt) }
        : {}),
      ...(typeof candidate.lastPublishError === 'string'
        ? { lastPublishError: candidate.lastPublishError.slice(0, 500) }
        : {})
    })
    seen.add(key)
  }
  return { version: 1, sites }
}
