import { FormattedMessage } from 'react-intl'

interface RoleGroup {
  id: 'contributor' | 'member' | 'admin'
  title: { id: string; defaultMessage: string }
  who: { id: string; defaultMessage: string }
  can: Array<{ id: string; defaultMessage: string }>
}

/**
 * What each role can do, stated to match the server's enforcement:
 * portal users read, post, vote and comment (subject to board access and
 * review); team members (`member`) moderate, set status, curate the roadmap
 * and create or rename boards; administrators also delete boards and run
 * access, sign-in, settings and members. Roles use one vocabulary everywhere
 * (lib/shared/roles ROLE_LABELS).
 */
const CONTRIBUTOR_WHO = {
  authenticated: { id: 'portal.roles.contributor.who', defaultMessage: 'Anyone who signs in' },
  private: {
    id: 'portal.roles.contributor.whoPrivate',
    defaultMessage: 'People given access to this portal',
  },
} as const

const ROLE_GROUPS: RoleGroup[] = [
  {
    id: 'contributor',
    title: { id: 'portal.roles.contributor.title', defaultMessage: 'Contributor' },
    who: CONTRIBUTOR_WHO.authenticated,
    can: [
      { id: 'portal.roles.contributor.read', defaultMessage: 'Read ideas and the roadmap' },
      { id: 'portal.roles.contributor.post', defaultMessage: 'Post new ideas' },
      { id: 'portal.roles.contributor.vote', defaultMessage: 'Vote on ideas' },
      { id: 'portal.roles.contributor.comment', defaultMessage: 'Comment on ideas' },
    ],
  },
  {
    id: 'member',
    title: { id: 'portal.roles.member.title', defaultMessage: 'Team member' },
    who: { id: 'portal.roles.member.who', defaultMessage: 'Added by an administrator' },
    can: [
      { id: 'portal.roles.member.review', defaultMessage: 'Review new posts' },
      { id: 'portal.roles.member.status', defaultMessage: 'Set the status of ideas' },
      { id: 'portal.roles.member.roadmap', defaultMessage: 'Move roadmap items' },
      { id: 'portal.roles.member.merge', defaultMessage: 'Merge duplicate ideas' },
      { id: 'portal.roles.member.changelog', defaultMessage: 'Publish the changelog' },
      { id: 'portal.roles.member.boards', defaultMessage: 'Create and rename boards' },
    ],
  },
  {
    id: 'admin',
    title: { id: 'portal.roles.admin.title', defaultMessage: 'Administrator' },
    who: { id: 'portal.roles.admin.who', defaultMessage: 'Added by an administrator' },
    can: [
      { id: 'portal.roles.admin.everything', defaultMessage: 'Everything a team member can do' },
      { id: 'portal.roles.admin.boards', defaultMessage: 'Delete boards' },
      { id: 'portal.roles.admin.access', defaultMessage: 'Set who can read and post' },
      { id: 'portal.roles.admin.settings', defaultMessage: 'Change sign-in and portal settings' },
      { id: 'portal.roles.admin.members', defaultMessage: 'Manage members and roles' },
    ],
  },
]

/**
 * "Who can do what" section for the sign-in page. `visibility` states who may
 * read: anyone who signs in (`authenticated`) or only people given access
 * (`private`). Unknown values read as private, the narrower claim.
 */
export function PortalRolesExplainer({
  headingLevel = 2,
  visibility,
}: {
  headingLevel?: 2 | 3
  visibility?: 'public' | 'authenticated' | 'private'
}) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3'
  const RoleHeading = headingLevel === 2 ? 'h3' : 'h4'
  return (
    <section className="portal-roles" aria-labelledby="portal-roles-title">
      <Heading id="portal-roles-title" className="portal-roles__title">
        <FormattedMessage id="portal.roles.title" defaultMessage="Who can do what" />
      </Heading>
      <div className="portal-roles__grid">
        {ROLE_GROUPS.map((group) => {
          const who =
            group.id === 'contributor' && visibility !== 'authenticated' && visibility !== 'public'
              ? CONTRIBUTOR_WHO.private
              : group.who
          return (
            <section
              key={group.id}
              className="portal-roles__group"
              aria-labelledby={`portal-role-${group.id}`}
            >
              <RoleHeading id={`portal-role-${group.id}`} className="portal-roles__role">
                <FormattedMessage {...group.title} />
              </RoleHeading>
              <p className="portal-roles__who">
                <FormattedMessage {...who} />
              </p>
              <ul className="portal-roles__list">
                {group.can.map((item) => (
                  <li key={item.id}>
                    <FormattedMessage {...item} />
                  </li>
                ))}
              </ul>
            </section>
          )
        })}
      </div>
      <p className="portal-roles__note">
        <FormattedMessage
          id="portal.roles.note"
          defaultMessage="Some boards hold new posts for the team to review first. Only designated accounts hold team roles."
        />
      </p>
    </section>
  )
}
