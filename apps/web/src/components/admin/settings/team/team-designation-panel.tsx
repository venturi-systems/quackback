'use client'

import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ShieldCheckIcon, UserIcon } from '@heroicons/react/24/solid'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/shared/confirm-dialog'
import { designateTeamMemberFn } from '@/lib/server/functions/admin'
import { ROLE_LABELS } from '@/lib/shared/roles'

/** Why a stored team role cannot act, in the words the panel shows. */
export const TEAM_IDENTITY_GAP_LABELS: Record<string, string> = {
  email_missing: 'The account has no email address.',
  email_domain: 'The email address is not at a team domain.',
  email_unverified: 'Google or GitHub has not verified the email address.',
  provider_missing: 'The account has not signed in with Google or GitHub.',
}

interface TeamPolicy {
  domains: string[]
  providers: string[]
}

interface Candidate {
  principalId: string
  name: string
  email: string
}

interface TeamDesignationPanelProps {
  policy: TeamPolicy
  candidates: Candidate[]
  isCurrentUserAdmin: boolean
}

function domainsLabel(domains: string[]): string {
  return domains.map((d) => `@${d}`).join(' or ')
}

/**
 * Admin > Team designation (owner decisions 6 and 7, landing-page#2309).
 *
 * States the rule the server enforces and lets an administrator designate an
 * existing account that already satisfies it. The server re-checks every
 * designation; this panel only offers accounts it would accept.
 */
export function TeamDesignationPanel({
  policy,
  candidates,
  isCurrentUserAdmin,
}: TeamDesignationPanelProps) {
  const queryClient = useQueryClient()
  const [pending, setPending] = useState<{ candidate: Candidate; role: 'member' | 'admin' } | null>(
    null
  )
  const [isLoading, setIsLoading] = useState(false)
  const domains = domainsLabel(policy.domains)
  const providers = policy.providers.join(' or ')

  const handleConfirm = async () => {
    if (!pending) return
    setIsLoading(true)
    try {
      await designateTeamMemberFn({
        data: { principalId: pending.candidate.principalId, role: pending.role },
      })
      toast.success(
        `${pending.candidate.name} is now a ${ROLE_LABELS[pending.role].toLowerCase()}.`
      )
      await queryClient.invalidateQueries({ queryKey: ['settings', 'team'] })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to designate team member')
    } finally {
      setIsLoading(false)
      setPending(null)
    }
  }

  return (
    <section
      aria-labelledby="team-designation-heading"
      className="rounded-xl border border-border/50 bg-card p-4 shadow-sm space-y-3"
      data-testid="team-designation-panel"
    >
      <h2 id="team-designation-heading" className="text-base font-semibold">
        Who can hold a team role
      </h2>
      <p className="text-sm text-muted-foreground">
        Anyone who signs up with {providers} is a Contributor. Only a designated person can be a
        Team member or an Administrator, and only with a verified {domains} address from a{' '}
        {providers} account. The server checks this on every team action, so a team role on any
        other account acts as a Contributor and is marked inactive below.
      </p>
      <p className="text-sm text-muted-foreground">
        To designate someone new, invite their {domains} address, or ask them to sign in once with{' '}
        {providers} and designate them here. Nobody can change or remove their own role, and the
        last administrator who can act cannot be removed.
      </p>

      {isCurrentUserAdmin && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Accounts ready to designate</h3>
          {candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No contributor with a verified {domains} {providers} account yet.
            </p>
          ) : (
            <ul className="divide-y divide-border/50 rounded-lg border border-border/50">
              {candidates.map((candidate) => (
                <li
                  key={candidate.principalId}
                  className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium break-words">{candidate.name}</p>
                    <p className="text-xs text-muted-foreground break-all">{candidate.email}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPending({ candidate, role: 'member' })}
                    >
                      <UserIcon className="h-4 w-4" />
                      Make team member
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPending({ candidate, role: 'admin' })}
                    >
                      <ShieldCheckIcon className="h-4 w-4" />
                      Make administrator
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null)
        }}
        title={
          pending
            ? `Make ${pending.candidate.name} a ${ROLE_LABELS[pending.role].toLowerCase()}?`
            : ''
        }
        description={
          pending?.role === 'admin' ? (
            <>
              <strong>{pending.candidate.name}</strong> will be able to manage settings, members,
              API keys and every workspace configuration.
            </>
          ) : (
            <>
              <strong>{pending?.candidate.name}</strong> will be able to review posts, set statuses,
              move roadmap items and publish the changelog.
            </>
          )
        }
        confirmLabel={isLoading ? 'Saving...' : 'Designate'}
        isPending={isLoading}
        onConfirm={handleConfirm}
      />
    </section>
  )
}
