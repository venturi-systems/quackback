/**
 * Opt-in real PostgreSQL checks. Run only with FEATURE_PIPELINE_TEST_DATABASE_URL
 * pointed at an isolated loopback database whose name ends in _test.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateId, toUuid } from '@quackback/ids'
import type { Sql } from 'postgres'

const state = vi.hoisted(() => ({
  url: process.env.FEATURE_PIPELINE_TEST_DATABASE_URL,
  client: null as Sql | null,
}))
vi.mock('@/lib/server/db', async () => {
  const schema = await import('@quackback/db/schema')
  const { sql } = await import('drizzle-orm')
  if (!state.url) return { db: null, sql, ...schema }
  const url = new URL(state.url)
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.pathname.endsWith('_test')) {
    throw new Error('Status effect fixtures require an isolated loopback test database')
  }
  const { default: postgres } = await import('postgres')
  const { drizzle } = await import('drizzle-orm/postgres-js')
  state.client = postgres(state.url, { max: 4 })
  return { db: drizzle(state.client, { schema }), sql, ...schema }
})
const { db, sql } = await import('@/lib/server/db')
const { applyPipelineStatus } = await import('./status-effects')

describe.skipIf(!state.url)('PostgreSQL status atomicity and semantic guards', () => {
  let ids: ReturnType<typeof fixtureIds>
  let openId: string
  let declinedId: string
  function fixtureIds() {
    const post = generateId('post')
    const nonce = toUuid(post)
    return {
      post,
      nonce,
      otherPost: generateId('post'),
      board: generateId('board'),
      otherBoard: generateId('board'),
      principal: generateId('principal'),
      tag: generateId('tag'),
      otherTag: generateId('tag'),
      capability: 'status-review-' + nonce,
      otherCapability: 'status-review-other-' + nonce,
      repository: 'venturi-systems/status-review-' + nonce,
    }
  }
  beforeEach(async () => {
    ids = fixtureIds()
    await db.transaction(async (tx) => {
      await tx.execute(sql`INSERT INTO post_statuses(id,name,slug,color,category)
        VALUES(${toUuid(generateId('status'))}::uuid,'Open','open','#aaa','active'),
          (${toUuid(generateId('status'))}::uuid,'Declined','declined','#bbb','closed')
        ON CONFLICT(slug) DO NOTHING`)
      const statuses = await tx.execute(
        sql`SELECT id,slug FROM post_statuses WHERE slug IN ('open','declined')`
      )
      openId = String(statuses.find((r) => r.slug === 'open')!.id)
      declinedId = String(statuses.find((r) => r.slug === 'declined')!.id)
      await tx.execute(sql`INSERT INTO boards(id,slug,name) VALUES
        (${toUuid(ids.board)}::uuid,${ids.capability},'Status review fixture'),
        (${toUuid(ids.otherBoard)}::uuid,${ids.otherCapability},'Ungoverned review fixture')`)
      await tx.execute(sql`INSERT INTO principal(id,type,role,display_name,created_at)
        VALUES(${toUuid(ids.principal)}::uuid,'service','user','Status fixture',now())`)
      await tx.execute(sql`INSERT INTO tags(id,name) VALUES
        (${toUuid(ids.tag)}::uuid,${'Outcome ' + ids.nonce}),
        (${toUuid(ids.otherTag)}::uuid,${'Other outcome ' + ids.nonce})`)
      for (const [capability, tag] of [
        [ids.capability, ids.tag],
        [ids.otherCapability, ids.otherTag],
      ]) {
        await tx.execute(sql`INSERT INTO feature_pipeline_capabilities
          (id,tag_id,visibility,taxonomy_version,repository,repository_id,source_repository,source_repository_id,route_policy)
          VALUES(${capability},${toUuid(tag)}::uuid,'customer','test.v1',${ids.repository},
            '987654321',${ids.repository},'987654321','direct')`)
      }
      await tx.execute(sql`INSERT INTO posts(id,board_id,title,content,principal_id,status_id,moderation_state)
        VALUES(${toUuid(ids.post)}::uuid,${toUuid(ids.board)}::uuid,'Atomic status fixture','Test only',
          ${toUuid(ids.principal)}::uuid,${openId}::uuid,'published'),
          (${toUuid(ids.otherPost)}::uuid,${toUuid(ids.otherBoard)}::uuid,'Move destination','Test only',
          ${toUuid(ids.principal)}::uuid,${openId}::uuid,'published')`)
      await tx.execute(sql`INSERT INTO post_tags(post_id,tag_id)
        VALUES(${toUuid(ids.post)}::uuid,${toUuid(ids.tag)}::uuid)`)
      await tx.execute(sql`INSERT INTO feature_pipeline_boards(board_id,enabled)
        VALUES(${toUuid(ids.board)}::uuid,true)`)
      await tx.execute(sql`INSERT INTO feature_pipeline_links
        (post_id,capability_id,taxonomy_version,repository,repository_id,classification,phase,source_snapshot,source_sha256)
        VALUES(${toUuid(ids.post)}::uuid,${ids.capability},'test.v1',${ids.repository},
          '987654321','feature request','held','{}',${'0'.repeat(64)})`)
    })
  })
  afterEach(async () => {
    if (!ids) return
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`DELETE FROM feature_pipeline_status_outbox WHERE post_id=${toUuid(ids.post)}::uuid`
      )
      await tx.execute(
        sql`DELETE FROM feature_pipeline_audit WHERE post_id=${toUuid(ids.post)}::uuid`
      )
      await tx.execute(
        sql`DELETE FROM feature_pipeline_links WHERE post_id=${toUuid(ids.post)}::uuid`
      )
      await tx.execute(sql`DELETE FROM audit_log WHERE target_id=${ids.post}`)
      await tx.execute(
        sql`DELETE FROM posts WHERE id IN (${toUuid(ids.post)}::uuid,${toUuid(ids.otherPost)}::uuid)`
      )
      await tx.execute(
        sql`DELETE FROM feature_pipeline_boards WHERE board_id=${toUuid(ids.board)}::uuid`
      )
      await tx.execute(
        sql`DELETE FROM feature_pipeline_capabilities WHERE id IN (${ids.capability},${ids.otherCapability})`
      )
      await tx.execute(
        sql`DELETE FROM tags WHERE id IN (${toUuid(ids.tag)}::uuid,${toUuid(ids.otherTag)}::uuid)`
      )
      await tx.execute(
        sql`DELETE FROM boards WHERE id IN (${toUuid(ids.board)}::uuid,${toUuid(ids.otherBoard)}::uuid)`
      )
      await tx.execute(sql`DELETE FROM principal WHERE id=${toUuid(ids.principal)}::uuid`)
    })
  })
  afterAll(async () => {
    await state.client?.end()
  })
  function change() {
    return {
      postId: ids.post,
      expectedStatusSlug: 'open' as const,
      targetStatusSlug: 'declined' as const,
      github: { repositoryId: '987654321', issueNodeId: 'I_fixture', issueNumber: 1 },
      reason: 'github_changed',
    }
  }
  async function observed() {
    const rows = await db.execute(sql`SELECT p.status_id,
      (SELECT count(*)::integer FROM audit_log WHERE target_id=${ids.post}) AS audits,
      (SELECT count(*)::integer FROM post_activity WHERE post_id=p.id) AS activities,
      (SELECT count(*)::integer FROM feature_pipeline_status_outbox WHERE post_id=p.id) AS events
      FROM posts p WHERE p.id=${toUuid(ids.post)}::uuid`)
    return rows[0]
  }
  it('commits exactly one native audit, activity and durable event with the status', async () => {
    await db.transaction((tx) => applyPipelineStatus(tx, change()))
    expect(await observed()).toMatchObject({
      status_id: declinedId,
      audits: 1,
      activities: 1,
      events: 1,
    })
    await db.transaction((tx) =>
      applyPipelineStatus(tx, { ...change(), expectedStatusSlug: 'declined' })
    )
    expect(await observed()).toMatchObject({ audits: 1, activities: 1, events: 1 })
  })
  it('rolls back all four effects if the worker crashes before transaction commit', async () => {
    await expect(
      db.transaction(async (tx) => {
        await applyPipelineStatus(tx, change())
        throw new Error('simulated pre-commit crash')
      })
    ).rejects.toThrow('pre-commit crash')
    expect(await observed()).toMatchObject({
      status_id: openId,
      audits: 0,
      activities: 0,
      events: 0,
    })
  })
  it('does not overwrite a portal edit made after the worker observation', async () => {
    await db.execute(
      sql`UPDATE posts SET status_id=${declinedId}::uuid WHERE id=${toUuid(ids.post)}::uuid`
    )
    await expect(db.transaction((tx) => applyPipelineStatus(tx, change()))).rejects.toThrow(
      'changed during reconciliation'
    )
    expect(await observed()).toMatchObject({
      status_id: declinedId,
      audits: 0,
      activities: 0,
      events: 0,
    })
  })
  it('rejects zero routing tags at commit', async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`DELETE FROM post_tags WHERE post_id=${toUuid(ids.post)}::uuid`)
      })
    ).rejects.toThrow('primary capability')
  })
  it('rejects multiple routing tags at commit', async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(
          sql`INSERT INTO post_tags(post_id,tag_id) VALUES(${toUuid(ids.post)}::uuid,${toUuid(ids.otherTag)}::uuid)`
        )
      })
    ).rejects.toThrow('primary capability')
  })
  it('rejects a rename to a repository name', async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(
          sql`UPDATE tags SET name=${ids.repository.split('/')[1]} WHERE id=${toUuid(ids.tag)}::uuid`
        )
      })
    ).rejects.toThrow('repository names')
  })
  it('rejects soft deletion or disabling of a referenced routing capability', async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`UPDATE tags SET deleted_at=now() WHERE id=${toUuid(ids.tag)}::uuid`)
      })
    ).rejects.toThrow('primary capability')
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(
          sql`UPDATE feature_pipeline_capabilities SET enabled=false WHERE id=${ids.capability}`
        )
      })
    ).rejects.toThrow('primary capability')
  })
  it('validates the OLD parent when moving its only tag to an ungoverned post', async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`UPDATE post_tags SET post_id=${toUuid(ids.otherPost)}::uuid
        WHERE post_id=${toUuid(ids.post)}::uuid AND tag_id=${toUuid(ids.tag)}::uuid`)
      })
    ).rejects.toThrow('primary capability')
  })
  it('validates the NEW parent when moving a second routing tag onto a governed post', async () => {
    await db.execute(
      sql`INSERT INTO post_tags(post_id,tag_id) VALUES(${toUuid(ids.otherPost)}::uuid,${toUuid(ids.otherTag)}::uuid)`
    )
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`UPDATE post_tags SET post_id=${toUuid(ids.post)}::uuid
        WHERE post_id=${toUuid(ids.otherPost)}::uuid AND tag_id=${toUuid(ids.otherTag)}::uuid`)
      })
    ).rejects.toThrow('primary capability')
  })
  it('accepts atomic removal and replacement of the same routing tag', async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`DELETE FROM post_tags WHERE post_id=${toUuid(ids.post)}::uuid`)
      await tx.execute(
        sql`INSERT INTO post_tags(post_id,tag_id) VALUES(${toUuid(ids.post)}::uuid,${toUuid(ids.tag)}::uuid)`
      )
    })
    const tags = await db.execute(
      sql`SELECT tag_id FROM post_tags WHERE post_id=${toUuid(ids.post)}::uuid`
    )
    expect(tags).toHaveLength(1)
  })
  it('rejects a linked request board transfer even to an ungoverned board', async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(
          sql`UPDATE posts SET board_id=${toUuid(ids.otherBoard)}::uuid WHERE id=${toUuid(ids.post)}::uuid`
        )
      })
    ).rejects.toThrow('reviewed transfer')
  })
})
