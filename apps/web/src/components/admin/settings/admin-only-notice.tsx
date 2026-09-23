import { Link } from '@tanstack/react-router'
import { LockClosedIcon } from '@heroicons/react/24/outline'

/**
 * Durable restricted state for a team member who opened an
 * administrator-only settings page. It names the reason (the page needs the
 * administrator role) and the request path (ask an administrator), and lists
 * what the member can still change, instead of an error screen or a toast.
 */
export function AdminOnlyNotice() {
  return (
    <section
      aria-labelledby="admin-only-notice-title"
      className="max-w-3xl space-y-4 rounded-lg border border-border bg-card p-6"
      data-testid="admin-only-notice"
    >
      <div className="flex items-start gap-3">
        <LockClosedIcon className="mt-1 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="space-y-2">
          <h2 id="admin-only-notice-title" className="text-lg font-medium">
            Administrators only
          </h2>
          <p className="text-sm text-muted-foreground">
            Only administrators can change workspace settings such as members, sign-in, portal
            access, branding, boards and integrations. Ask an administrator in your workspace if
            something needs to change.
          </p>
        </div>
      </div>
      <div className="space-y-2 text-sm">
        <p className="font-medium">As a team member you can change</p>
        <ul className="flex flex-wrap gap-x-6 gap-y-1">
          <li>
            <Link
              to="/admin/settings/statuses"
              className="inline-flex min-h-11 items-center underline underline-offset-4"
            >
              Statuses
            </Link>
          </li>
          <li>
            <Link
              to="/admin/settings/tags"
              className="inline-flex min-h-11 items-center underline underline-offset-4"
            >
              Tags
            </Link>
          </li>
        </ul>
        <p className="text-muted-foreground">
          Reviewing feedback, setting status, moving roadmap items and moderating submissions stay
          in the sidebar.
        </p>
      </div>
    </section>
  )
}
