// @vitest-environment happy-dom
import { render, screen, within } from '@testing-library/react'
import { IntlProvider } from 'react-intl'
import { describe, expect, it } from 'vitest'
import { PortalRolesExplainer } from '../portal-roles-explainer'

function renderExplainer(visibility?: 'public' | 'authenticated' | 'private') {
  return render(
    <IntlProvider locale="en" defaultLocale="en">
      <PortalRolesExplainer visibility={visibility} />
    </IntlProvider>
  )
}

function roleGroup(name: string) {
  return screen.getByRole('region', { name })
}

// Owner decision 5 on landing-page#2309: the sign-in page states who can
// post, vote, comment, set status and manage the roadmap. Each statement
// must match what the server enforces.
describe('PortalRolesExplainer', () => {
  it('states what each role can do', () => {
    renderExplainer('authenticated')

    expect(screen.getByRole('heading', { level: 2, name: 'Who can do what' })).toBeVisible()
    const contributor = roleGroup('Contributor')
    for (const power of [
      'Read ideas and the roadmap',
      'Post new ideas',
      'Vote on ideas',
      'Comment on ideas',
    ]) {
      expect(within(contributor).getByText(power)).toBeInTheDocument()
    }
    const member = roleGroup('Team member')
    for (const power of ['Set the status of ideas', 'Move roadmap items', 'Review new posts']) {
      expect(within(member).getByText(power)).toBeInTheDocument()
    }
    const admin = roleGroup('Administrator')
    for (const power of [
      'Delete boards',
      'Set who can read and post',
      'Manage members and roles',
    ]) {
      expect(within(admin).getByText(power)).toBeInTheDocument()
    }
    expect(within(member).getByText('Added by an administrator')).toBeInTheDocument()
    expect(within(admin).getByText('Added by an administrator')).toBeInTheDocument()
  })

  it('says anyone who signs in is a contributor when sign-in grants read access', () => {
    renderExplainer('authenticated')
    expect(within(roleGroup('Contributor')).getByText('Anyone who signs in')).toBeInTheDocument()
  })

  it('makes the narrower claim for a private portal or an unknown posture', () => {
    for (const visibility of ['private', undefined] as const) {
      const { unmount } = renderExplainer(visibility)
      expect(
        within(roleGroup('Contributor')).getByText('People given access to this portal')
      ).toBeInTheDocument()
      unmount()
    }
  })
})
