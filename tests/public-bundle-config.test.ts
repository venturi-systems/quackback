import { describe, expect, it } from 'vitest'

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
})
