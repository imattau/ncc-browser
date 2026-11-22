import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import type { SignerPermission } from '@shared/types'
import { SectionHeading } from './shared'

/**
 * Origins remembered for signing without a prompt. Read-only apart from revoking, so
 * it reloads from main whenever the section is opened — that also picks up any
 * permission granted elsewhere without a shared store.
 */
export function TrustedServices() {
  const [permissions, setPermissions] = useState<SignerPermission[]>([])

  useEffect(() => {
    void window.ncc.signerPermissions().then(setPermissions)
  }, [])

  return (
    <>
      <SectionHeading
        title="Trusted services"
        hint="Origins that can sign without asking again. Revoke anything you no longer use."
      />
      <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-2">
        {permissions.length === 0 ? (
          <p className="px-3 py-8 text-center text-ui-115 text-[color:var(--color-muted)]">
            No service has been remembered yet.
          </p>
        ) : (
          <ul className="space-y-1">
            {permissions.map((permission) => (
              <li
                key={permission.origin}
                className="flex items-center justify-between gap-2 rounded-lg border border-transparent px-2.5 py-2 hover:border-[color:var(--color-line)] hover:bg-[color:var(--color-hover-soft)]"
              >
                <span className="min-w-0">
                  <span className="block truncate font-mono text-ui-11 text-[color:var(--color-text-soft)]">
                    {permission.label}
                  </span>
                  <span className="mt-0.5 block truncate font-mono text-ui-95 text-[color:var(--color-faint)]">
                    {permission.origin}
                  </span>
                </span>
                <button
                  type="button"
                  aria-label={`Revoke ${permission.label}`}
                  onClick={() =>
                    void window.ncc
                      .revokePermission(permission.origin)
                      .then(setPermissions)
                  }
                  className="shrink-0 rounded p-1.5 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-danger)]"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  )
}
