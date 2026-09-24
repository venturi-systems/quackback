/**
 * Tests for the GitLab inbound webhook status parser.
 */

import { describe, it, expect } from 'vitest'
import { gitlabInboundHandler } from '../inbound'

// The handler only reads the body; config/secrets are required by the
// InboundWebhookHandler interface signature but ignored here.
const parse = (payload: unknown) =>
  gitlabInboundHandler.parseStatusChange(JSON.stringify(payload), {}, {})

function issueEvent(state: string, action = 'update') {
  return { object_kind: 'issue', object_attributes: { iid: 7, action, state } }
}

describe('gitlabInboundHandler.parseStatusChange', () => {
  it('maps the opened and closed issue states', async () => {
    await expect(parse(issueEvent('opened', 'reopen'))).resolves.toEqual({
      externalId: '7',
      externalStatus: 'Open',
      eventType: 'issue.state_changed',
    })
    await expect(parse(issueEvent('closed', 'close'))).resolves.toEqual({
      externalId: '7',
      externalStatus: 'Closed',
      eventType: 'issue.state_changed',
    })
  })

  it('ignores a state it does not map', async () => {
    await expect(parse(issueEvent('locked'))).resolves.toBeNull()
  })

  it.each(['constructor', 'toString', 'hasOwnProperty', '__proto__'])(
    'ignores the state %s instead of resolving an inherited Object.prototype member',
    async (state) => {
      await expect(parse(issueEvent(state))).resolves.toBeNull()
    }
  )
})
