import { afterAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'

const migration = readFileSync(
  new URL('../../drizzle/9006_venturi_magic_link_1_7.sql', import.meta.url),
  'utf8'
)
const databaseUrl = process.env.DATABASE_URL
const client = databaseUrl ? postgres(databaseUrl, { max: 1 }) : null
afterAll(async () => {
  await client?.end()
})

describe.skipIf(!client)('legacy magic-link migration to Better Auth 1.7', () => {
  it('preserves unused link authority and expiry, rejects collisions and remains replay safe', async () => {
    if (!client) throw new Error('DATABASE_URL required')
    const schema = 'magic_17_' + randomUUID().replaceAll('-', '')
    const rollback = new Error('rollback isolated magic-link migration fixture')
    await expect(
      client.begin(async (tx) => {
        await tx.unsafe(`CREATE SCHEMA "${schema}"`)
        await tx.unsafe(`SET LOCAL search_path TO "${schema}"`)
        await tx.unsafe(`CREATE TABLE verification (
        id text PRIMARY KEY, identifier text NOT NULL, value text NOT NULL,
        expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`)
        const future = new Date(Date.now() + 7 * 24 * 3600_000)
        const rows = [
          {
            id: 'invitation',
            identifier: 'A'.repeat(32),
            value: JSON.stringify({ email: 'owner@example.com', attempt: 0 }),
            expires_at: future,
          },
          {
            id: 'named',
            identifier: 'B'.repeat(32),
            value: JSON.stringify({ email: 'member@example.com', name: 'Member', attempt: 0 }),
            expires_at: future,
          },
          {
            id: 'expired',
            identifier: 'C'.repeat(32),
            value: JSON.stringify({ email: 'owner@example.com', attempt: 0 }),
            expires_at: new Date(1),
          },
          {
            id: 'used',
            identifier: 'D'.repeat(32),
            value: JSON.stringify({ email: 'owner@example.com', attempt: 1 }),
            expires_at: future,
          },
          { id: 'malformed', identifier: 'E'.repeat(32), value: '{broken', expires_at: future },
          {
            id: 'other-protocol',
            identifier: 'F'.repeat(32),
            value: JSON.stringify({
              email: 'owner@example.com',
              attempt: 0,
              type: 'password-reset',
            }),
            expires_at: future,
          },
          {
            id: 'otp',
            identifier: 'sign-in-otp-owner@example.com',
            value: '123456:0',
            expires_at: future,
          },
          {
            id: 'invalid-email',
            identifier: 'G'.repeat(32),
            value: JSON.stringify({ email: 'owner@exampleXcom', attempt: 0 }),
            expires_at: future,
          },
          {
            id: 'invalid-name',
            identifier: 'H'.repeat(32),
            value: JSON.stringify({ email: 'owner@example.com', name: null, attempt: 0 }),
            expires_at: future,
          },
        ]
        rows.push(
          {
            id: 'unrepresentable-unicode',
            identifier: 'J'.repeat(32),
            value: String.raw`{"email":"owner@example.com","attempt":0,"name":"\u0000"}`,
            expires_at: future,
          },
          {
            id: 'out-of-range-number',
            identifier: 'K'.repeat(32),
            value: '{"email":"owner@example.com","attempt":1e1000000}',
            expires_at: future,
          }
        )
        await tx`INSERT INTO verification ${tx(rows)}`
        const before = await tx`SELECT * FROM verification ORDER BY id`
        await tx.unsafe(migration)
        const after = await tx`SELECT * FROM verification ORDER BY id`
        for (const row of before) {
          const changed = after.find((candidate) => candidate.id === row.id)!
          if (['invitation', 'named'].includes(row.id)) {
            expect(changed).toMatchObject({
              ...row,
              identifier: 'magic-link:' + row.identifier,
              value: expect.any(String),
            })
            const original = JSON.parse(row.value)
            expect(JSON.parse(changed.value)).toEqual({
              type: 'magic-link',
              email: original.email,
              ...(original.name ? { name: original.name } : {}),
            })
          } else {
            expect(changed).toEqual(row)
          }
        }
        await tx.unsafe(migration)
        expect(await tx`SELECT * FROM verification ORDER BY id`).toEqual(after)

        await expect(
          tx.savepoint(async (sp) => {
            await sp`INSERT INTO verification (id, identifier, value, expires_at) VALUES
          ('collision-legacy', ${'Z'.repeat(32)}, ${JSON.stringify({ email: 'owner@example.com', attempt: 0 })}, ${future}),
          ('collision-current', ${'magic-link:' + 'Z'.repeat(32)}, ${JSON.stringify({ type: 'magic-link', email: 'other@example.com' })}, ${future})`
            await sp.unsafe(migration)
          })
        ).rejects.toThrow('Resolve legacy magic-link namespace collision')
        expect(await tx`SELECT * FROM verification ORDER BY id`).toEqual(after)
        throw rollback
      })
    ).rejects.toBe(rollback)
  })
})
