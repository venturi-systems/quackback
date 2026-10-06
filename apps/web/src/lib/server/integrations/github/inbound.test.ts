/**
 * Tests for the GitHub inbound webhook status parser.
 *
 * A GitHub issue number is unique only within its repository, so the parser
 * must hand the central handler the issue's own URL alongside the number.
 */

import { describe, it, expect } from 'vitest'
import { githubInboundHandler } from './inbound'

// The handler only reads the body; config/secrets are required by the
// InboundWebhookHandler interface signature but ignored here.
const parse = (payload: unknown) =>
  githubInboundHandler.parseStatusChange(JSON.stringify(payload), {}, {})

const ISSUE_URL = 'https://github.com/example-org/service-b/issues/7'

function issueEvent(action: string, issue: Record<string, unknown> = {}) {
  return {
    action,
    issue: { number: 7, html_url: ISSUE_URL, ...issue },
    repository: { full_name: 'example-org/service-b' },
  }
}

describe('githubInboundHandler.parseStatusChange', () => {
  it('maps closed and reopened events and carries the issue URL', async () => {
    await expect(parse(issueEvent('closed'))).resolves.toEqual({
      externalId: '7',
      externalStatus: 'Closed',
      eventType: 'issues.closed',
      externalUrl: ISSUE_URL,
    })
    await expect(parse(issueEvent('reopened'))).resolves.toEqual({
      externalId: '7',
      externalStatus: 'Open',
      eventType: 'issues.reopened',
      externalUrl: ISSUE_URL,
    })
  })

  it.each(['opened', 'edited', 'labeled', 'transferred'])(
    'ignores the %s action',
    async (action) => {
      await expect(parse(issueEvent(action))).resolves.toBeNull()
    }
  )

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['not a string', 7],
  ])(
    'ignores an event whose issue URL is %s instead of matching by number alone',
    async (_label, htmlUrl) => {
      await expect(parse(issueEvent('closed', { html_url: htmlUrl }))).resolves.toBeNull()
    }
  )
})
