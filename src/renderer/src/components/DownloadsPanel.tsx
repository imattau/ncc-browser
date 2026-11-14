import { Download, FolderOpen, X } from 'lucide-react'
import { describeDownload, downloadPercent, isActiveDownload } from '@shared/downloads'
import type { DownloadNotice } from '@shared/types'
import { cn } from '../lib/cn'
import { Popover } from './Popover'

interface DownloadsPanelProps {
  downloads: DownloadNotice[]
  onClose: () => void
  onCancel: (id: string) => void
  onReveal: (id: string) => void
  onClear: () => void
}

export function DownloadsPanel({
  downloads,
  onClose,
  onCancel,
  onReveal,
  onClear
}: DownloadsPanelProps) {
  const active = downloads.filter((notice) => isActiveDownload(notice.state)).length
  const finished = downloads.length - active

  return (
    <Popover
      title="Downloads"
      subtitle={
        downloads.length === 0
          ? 'Nothing downloaded this session'
          : `${active} active · ${finished} finished`
      }
      testId="downloads"
      onClose={onClose}
      footer={
        <button
          type="button"
          disabled={finished === 0}
          onClick={onClear}
          className="text-[11px] text-[color:var(--color-muted)] underline-offset-2 hover:text-white hover:underline disabled:cursor-default disabled:opacity-40"
        >
          Clear finished downloads
        </button>
      }
    >
      {downloads.length === 0 ? (
        <div className="px-3 py-8 text-center">
          <Download className="mx-auto h-5 w-5 text-[#4d5462]" />
          <p className="mt-2 text-[11.5px] text-[color:var(--color-muted)]">
            Files you download from a service appear here.
          </p>
        </div>
      ) : (
        <ul className="space-y-1">
          {downloads.map((notice) => {
            const percent = downloadPercent(notice)
            const activeDownload = isActiveDownload(notice.state)
            return (
              <li
                key={notice.id}
                data-download-id={notice.id}
                className={cn(
                  'rounded-lg border px-2.5 py-2',
                  notice.state === 'failed'
                    ? 'border-[color:var(--color-danger)]/25 bg-[color:var(--color-danger)]/[0.06]'
                    : 'border-transparent hover:border-[color:var(--color-line)] hover:bg-white/[0.03]'
                )}
              >
                <div className="flex items-center gap-2">
                  <Download
                    className={cn(
                      'h-3.5 w-3.5 shrink-0',
                      notice.state === 'failed'
                        ? 'text-[color:var(--color-danger)]'
                        : 'text-[color:var(--color-accent)]'
                    )}
                  />
                  <span
                    className="min-w-0 flex-1 truncate text-[11.5px] text-[#dfe3ea]"
                    title={notice.path ?? notice.filename}
                  >
                    {notice.filename}
                  </span>

                  {notice.state === 'completed' ? (
                    <button
                      type="button"
                      aria-label={`Show ${notice.filename} in folder`}
                      title="Show in folder"
                      onClick={() => onReveal(notice.id)}
                      className="shrink-0 rounded p-1 text-[color:var(--color-muted)] hover:bg-white/5 hover:text-white"
                    >
                      <FolderOpen className="h-3.5 w-3.5" />
                    </button>
                  ) : null}

                  {activeDownload ? (
                    <button
                      type="button"
                      aria-label={`Cancel ${notice.filename}`}
                      title="Cancel download"
                      onClick={() => onCancel(notice.id)}
                      className="shrink-0 rounded p-1 text-[color:var(--color-muted)] hover:bg-white/5 hover:text-[color:var(--color-danger)]"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                </div>

                <div className="mt-1 flex items-center justify-between gap-2 pl-5 text-[10px] text-[color:var(--color-muted)]">
                  <span
                    className={cn(notice.state === 'failed' && 'text-[color:var(--color-danger)]')}
                  >
                    {describeDownload(notice)}
                  </span>
                  <span className="truncate font-mono text-[9.5px] text-[#5d6575]">
                    {folderOf(notice.path)}
                  </span>
                </div>

                {activeDownload ? (
                  <div className="mt-1.5 ml-5 h-1 overflow-hidden rounded-full bg-white/[0.07]">
                    <div
                      className={cn(
                        'h-full rounded-full bg-[color:var(--color-accent)] transition-[width] duration-200',
                        percent === null && 'animate-pulse'
                      )}
                      style={{ width: `${percent ?? 35}%` }}
                    />
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </Popover>
  )
}

function folderOf(path?: string): string {
  if (!path) return ''
  const parts = path.split(/[\\/]/)
  parts.pop()
  return parts.join('/')
}
