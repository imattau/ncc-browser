import type { DownloadNotice, DownloadState } from './types'

export function isActiveDownload(state: DownloadState): boolean {
  return state === 'started'
}

/** 0–100, or null when the server did not send a content length. */
export function downloadPercent(notice: DownloadNotice): number | null {
  if (notice.state === 'completed') return 100
  if (notice.totalBytes <= 0) return null
  return Math.min(100, Math.max(0, Math.round((notice.receivedBytes / notice.totalBytes) * 100)))
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const rounded = Math.round(value * 10) / 10
  const display = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
  return `${display} ${units[unit]}`
}

export function describeDownload(notice: DownloadNotice): string {
  switch (notice.state) {
    case 'started': {
      const percent = downloadPercent(notice)
      if (percent !== null) return `${percent}% of ${formatBytes(notice.totalBytes)}`
      if (notice.receivedBytes > 0) return `${formatBytes(notice.receivedBytes)} received`
      return 'Starting…'
    }
    case 'completed':
      return notice.totalBytes > 0 ? formatBytes(notice.totalBytes) : 'Completed'
    case 'cancelled':
      return 'Cancelled'
    case 'failed':
      return 'Failed'
  }
}

/** Active downloads first, then newest first. */
export function sortDownloads(notices: readonly DownloadNotice[]): DownloadNotice[] {
  return [...notices].sort((a, b) => {
    const active = Number(isActiveDownload(b.state)) - Number(isActiveDownload(a.state))
    if (active !== 0) return active
    return b.startedAt - a.startedAt
  })
}
