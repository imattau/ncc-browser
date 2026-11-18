export interface SecurityEndpoint {
  pinned?: boolean
  protocol?: string
  family?: string
}

export interface SecurityInfo {
  error?: string
  kind?: string
  secure?: boolean
  endpoints?: SecurityEndpoint[]
}

export interface SecurityFeature {
  SECURITY: Record<string, { label: string; detail: string; lock: string }>
  cache: Map<string, string>
  classifySecurity(data: SecurityInfo | null | undefined): string
  fetchInfo(url: string): Promise<SecurityInfo>
  isOnionPage(url: string): boolean
  isTorWebPage(url: string): boolean
  isClearnetPage(url: string): boolean
  clearnetInfo(url: string): SecurityInfo
  onionInfo(url: string): SecurityInfo
  securityFor(url: string): Promise<string>
}

export function createSecurity(deps: { getProxyPort: () => number | null }): SecurityFeature
