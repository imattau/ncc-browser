import { cn } from '../../lib/cn'
import { PROGRESS_BAR } from '../guided/ui'
import { cancelSiteJob, type VerifyJob } from './siteFlow'

/** Progress and outcome of downloading a site's files back to check them. */
export function VerifyStatus({ verify }: { verify: VerifyJob }) {
  if (verify.running) {
    return (
      <div data-nsite-verify className="mt-2 text-ui-105 text-[color:var(--color-muted)]">
        <div className="flex items-center justify-between gap-2">
          <span>
            Checking files: {verify.done} of {verify.total}
          </span>
          <button
            type="button"
            onClick={() => void cancelSiteJob()}
            className="rounded-lg border border-[color:var(--color-line)] px-2 py-0.5 hover:bg-[color:var(--color-hover)]"
          >
            Cancel
          </button>
        </div>
        <progress
          aria-label="Checking files"
          className={PROGRESS_BAR}
          value={verify.done}
          max={Math.max(1, verify.total)}
        />
      </div>
    )
  }
  const missing = verify.result?.missing ?? []
  const ok = Boolean(verify.result) && missing.length === 0
  return (
    <p
      data-nsite-verify
      role="status"
      className={cn(
        'mt-2 break-words rounded-lg px-2.5 py-1.5 text-ui-105',
        ok
          ? 'bg-[color:var(--color-ok)]/10 text-[color:var(--color-ok)]'
          : 'bg-[color:var(--color-danger)]/10 text-[color:var(--color-danger)]'
      )}
    >
      {!verify.result
        ? `Could not check the files: ${verify.error}`
        : ok
          ? `All ${verify.result.checked} files are online and unchanged.`
          : `${missing.length} of ${verify.result.checked} files were not found or did not match: ${missing.join(', ')}`}
    </p>
  )
}
