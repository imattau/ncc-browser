export interface NccSearchUpdateFile {
  path: string
  sha256: string
  asset: string
}

export interface NccSearchUpdateManifest {
  version: string
  releaseTag: string
  files: NccSearchUpdateFile[]
  signature: string
}

/** Stable byte representation signed by the release workflow and verified by clients. */
export function nccSearchManifestPayload(manifest: Omit<NccSearchUpdateManifest, 'signature'>): string {
  return [manifest.version, manifest.releaseTag, ...manifest.files
    .slice()
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    .map(({ path, sha256 }) => `${path}\t${sha256}`)].join('\n')
}
