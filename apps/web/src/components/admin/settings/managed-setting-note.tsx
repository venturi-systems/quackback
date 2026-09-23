import { useRouteContext } from '@tanstack/react-router'
import { LockClosedIcon } from '@heroicons/react/24/outline'
import { isPathManagedFromBootstrap } from '@/lib/client/config-file'

/** True when the deployment declares this settings path as managed. */
export function useIsManagedSetting(path: string): boolean {
  const { managedFieldPaths } = useRouteContext({ from: '__root__' })
  return isPathManagedFromBootstrap(path, managedFieldPaths ?? [])
}

/**
 * Read-only explanation for a setting the deployment configuration owns.
 * Without it an administrator could save a value, see success, and later find
 * it silently reverted by the policy process that owns the field.
 */
export function ManagedSettingNote({ what }: { what: string }) {
  return (
    <p
      className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
      data-testid="managed-setting-note"
    >
      <LockClosedIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>
        {what} is managed by the deployment configuration (for this workspace, the feedback
        infrastructure repository). Change it there; it is read-only here.
      </span>
    </p>
  )
}
