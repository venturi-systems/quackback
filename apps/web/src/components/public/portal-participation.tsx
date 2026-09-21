import { FormattedMessage } from 'react-intl'

/** Explains the actual server-enforced role boundary without granting access. */
export function PortalParticipation() {
  return (
    <dl className="portal-participation" aria-label="How participation works">
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
