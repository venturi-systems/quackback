import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import configFactory from '../apps/web/vite.config'

describe('public bundle boundaries', () => {
  it('leaves route chunking to TanStack Start', async () => {
    const config = await configFactory({
      command: 'build',
      mode: 'production',
      isSsrBuild: false,
      isPreview: false,
    })

    const output = config.build?.rolldownOptions?.output
    const outputs = Array.isArray(output) ? output : output ? [output] : []

    for (const entry of outputs) {
      expect(entry).not.toHaveProperty('manualChunks')
    }
  })

  it('does not load the full feedback composer for the signed-out empty state', () => {
    const routeSource = readFileSync(
      path.resolve(import.meta.dirname, '../apps/web/src/routes/_portal/index.tsx'),
      'utf8'
    )

    expect(routeSource).not.toContain(
      "import { FeedbackContainer } from '@/components/public/feedback/feedback-container'"
    )
    expect(routeSource).toContain("import('@/components/public/feedback/feedback-container')")
  })
})
