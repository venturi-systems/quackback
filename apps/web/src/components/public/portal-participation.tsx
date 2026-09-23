import { FormattedMessage } from 'react-intl'

function ParticipationList({ className }: { className?: string }) {
  return (
    <dl
      className={`portal-participation ${className ?? ''}`.trim()}
      aria-label="How participation works"
    >
      <div>
        <dt>
          <FormattedMessage
            id="portal.participation.read.title"
            defaultMessage="Explore feedback"
          />
        </dt>
        <dd>
          <FormattedMessage
            id="portal.participation.read.description"
            defaultMessage="Read published ideas and follow progress on the roadmap."
          />
        </dd>
      </div>
      <div>
        <dt>
          <FormattedMessage
            id="portal.participation.contribute.title"
            defaultMessage="Share your perspective"
          />
        </dt>
        <dd>
          <FormattedMessage
            id="portal.participation.contribute.description"
            defaultMessage="Your board access determines whether you can submit, vote, or comment. Signing in does not grant team access."
          />
        </dd>
      </div>
      <div>
        <dt>
          <FormattedMessage
            id="portal.participation.manage.title"
            defaultMessage="The team manages progress"
          />
        </dt>
        <dd>
          <FormattedMessage
            id="portal.participation.manage.description"
            defaultMessage="Only team members and administrators can review submissions, move roadmap items, or change their status."
          />
        </dd>
      </div>
    </dl>
  )
}

/**
 * Explains the actual server-enforced role boundary without granting access.
 *
 * Wide screens show the three statements side by side. On phones the same
 * statements sit behind a "How participation works" disclosure, so the
 * composer and the first posts stay in the first viewport; nothing is removed,
 * only disclosed on request. CSS shows exactly one of the two renderings.
 */
export function PortalParticipation() {
  return (
    <>
      <details className="portal-participation-disclosure">
        <summary>
          <FormattedMessage
            id="portal.participation.disclosure"
            defaultMessage="How participation works"
          />
        </summary>
        <ParticipationList />
      </details>
      <ParticipationList className="portal-participation--wide" />
    </>
  )
}
