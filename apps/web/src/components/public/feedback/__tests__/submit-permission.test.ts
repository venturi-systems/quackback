import { describe, it, expect } from 'vitest'
import { resolveComposerMode, resolveSubmitState, submittableBoardIds } from '../submit-permission'

/**
 * The submit CTA must follow the SERVER-computed per-board `canSubmit` (which
 * already composes the board's access.submit tier with the workspace anonymous
 * switch for this viewer). The header must not re-open the form from the
 * workspace flag on a board whose submit tier requires sign-in (Codex #191).
 */
describe('resolveSubmitState', () => {
  const anonSession = { user: { principalType: 'anonymous' } }
  const userSession = { user: { principalType: 'user' } }

  it('disables submit when the selected board denies it, even for a logged-in user', () => {
    const state = resolveSubmitState(false, userSession)
    expect(state.canSubmit).toBe(false)
    expect(state.canPostAnonymously).toBe(false)
  })

  it('enables submit for a logged-in user when the board allows it (not anonymous)', () => {
    const state = resolveSubmitState(true, userSession)
    expect(state.canSubmit).toBe(true)
    expect(state.canPostAnonymously).toBe(false)
  })

  it('lets a no-session visitor post anonymously when the board allows it', () => {
    const state = resolveSubmitState(true, null)
    expect(state.canSubmit).toBe(true)
    expect(state.canPostAnonymously).toBe(true)
  })

  it('treats an existing anonymous session as posting anonymously when allowed', () => {
    const state = resolveSubmitState(true, anonSession)
    expect(state.canSubmit).toBe(true)
    expect(state.canPostAnonymously).toBe(true)
  })

  it('denies anonymous posting on a board that requires sign-in', () => {
    // The Codex case: board submit tier = 'authenticated'; server canSubmit is
    // false for the anon viewer, so the form/CTA stays closed.
    expect(resolveSubmitState(false, null)).toEqual({
      canSubmit: false,
      canPostAnonymously: false,
      noAccess: false,
    })
    expect(resolveSubmitState(false, anonSession)).toEqual({
      canSubmit: false,
      canPostAnonymously: false,
      noAccess: false,
    })
  })

  // noAccess distinguishes authz (signed-in but denied) from authn (sign in to
  // post). It drives the "You don't have access to post on this board" message.
  it('flags noAccess when a signed-in real user is denied (authorization, not auth)', () => {
    expect(resolveSubmitState(false, userSession).noAccess).toBe(true)
  })

  it('does not flag noAccess for a denied anonymous/no-session viewer (that is sign-in)', () => {
    expect(resolveSubmitState(false, null).noAccess).toBe(false)
    expect(resolveSubmitState(false, anonSession).noAccess).toBe(false)
  })

  it('does not flag noAccess when submission is allowed', () => {
    expect(resolveSubmitState(true, userSession).noAccess).toBe(false)
    expect(resolveSubmitState(true, null).noAccess).toBe(false)
  })
})

describe('resolveComposerMode (E-8: one honest share-an-idea surface)', () => {
  const anonSession = { user: { principalType: 'anonymous' } }
  const userSession = { user: { principalType: 'user' } }
  const ids = ['board_a', 'board_b']

  it('shows the composer when the viewer can post on any listed board', () => {
    const perms = {
      board_a: { canSubmit: false, signedInCanSubmit: true },
      board_b: { canSubmit: true, signedInCanSubmit: true },
    }
    expect(resolveComposerMode(ids, perms, null)).toBe('composer')
    expect(resolveComposerMode(ids, perms, userSession)).toBe('composer')
  })

  it('offers sign-in to a signed-out visitor only when signing in would allow posting', () => {
    const perms = {
      board_a: { canSubmit: false, signedInCanSubmit: true },
      board_b: { canSubmit: false, signedInCanSubmit: false },
    }
    expect(resolveComposerMode(ids, perms, null)).toBe('sign-in')
    expect(resolveComposerMode(ids, perms, anonSession)).toBe('sign-in')
  })

  it('never promises sign-in when every board is restricted to groups or the team', () => {
    const perms = {
      board_a: { canSubmit: false, signedInCanSubmit: false },
      board_b: { canSubmit: false, signedInCanSubmit: false },
    }
    expect(resolveComposerMode(ids, perms, null)).toBe('no-access')
  })

  it('tells a signed-in viewer they cannot post instead of asking them to sign in', () => {
    const perms = {
      board_a: { canSubmit: false, signedInCanSubmit: false },
      board_b: { canSubmit: false, signedInCanSubmit: false },
    }
    expect(resolveComposerMode(ids, perms, userSession)).toBe('no-access')
  })

  it('fails closed with no permission data', () => {
    expect(resolveComposerMode(ids, undefined, null)).toBe('no-access')
    expect(resolveComposerMode([], {}, userSession)).toBe('no-access')
  })

  it('lists only the boards the viewer can post to, in order', () => {
    const perms = {
      board_a: { canSubmit: false },
      board_b: { canSubmit: true },
      board_c: { canSubmit: true },
    }
    expect(submittableBoardIds(['board_c', 'board_a', 'board_b'], perms)).toEqual([
      'board_c',
      'board_b',
    ])
  })
})
