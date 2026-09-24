/**
 * Tests for the Jira inbound webhook status parser.
 */

import { describe, it, expect } from 'vitest'
import { jiraInboundHandler } from '../inbound'

// The handler only reads the body; config/secrets are required by the
// InboundWebhookHandler interface signature but ignored here.
const parse = (payload: unknown) =>
  jiraInboundHandler.parseStatusChange(JSON.stringify(payload), {}, {})

function issueUpdated(statusItem: Record<string, unknown>) {
  return {
    webhookEvent: 'jira:issue_updated',
    issue: { key: 'QUA-7' },
    changelog: { items: [{ field: 'summary', toString: 'New title' }, statusItem] },
  }
}

describe('jiraInboundHandler.parseStatusChange', () => {
  it('reads the new status name from the changelog item', async () => {
    const payload = issueUpdated({ field: 'status', fromString: 'To Do', toString: 'Done' })
    await expect(parse(payload)).resolves.toEqual({
      externalId: 'QUA-7',
      externalStatus: 'Done',
      eventType: 'jira:issue_updated',
    })
  })

  it('ignores a status item without its own toString field', async () => {
    // A plain read would return the inherited Object.prototype.toString function.
    await expect(parse(issueUpdated({ field: 'status', fromString: 'To Do' }))).resolves.toBeNull()
  })

  it.each([null, '', 42, { name: 'Done' }])(
    'ignores a status item whose toString is %j',
    async (toString) => {
      await expect(parse(issueUpdated({ field: 'status', toString }))).resolves.toBeNull()
    }
  )

  it('ignores an update without a status change', async () => {
    const payload = issueUpdated({ field: 'assignee', toString: 'Jess' })
    await expect(parse(payload)).resolves.toBeNull()
  })
})
