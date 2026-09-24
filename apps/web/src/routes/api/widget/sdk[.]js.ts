import { createFileRoute } from '@tanstack/react-router'
import { config } from '@/lib/server/config'
import { widgetNotFoundResponse } from '@/lib/server/widget/widget-enabled'
// Vite `?raw` imports ship the bundle content as a string at build time.
// packages/widget/dist/browser.js must exist — produced by `bun run --filter
// @quackback/widget build` before the web app builds.
import widgetBundle from '../../../../../../packages/widget/dist/browser.js?raw'

function jsResponse(body: string, maxAge: number): Response {
  return new Response(body, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': `public, max-age=${maxAge}`,
    },
  })
}

export const Route = createFileRoute('/api/widget/sdk.js')({
  server: {
    handlers: {
      GET: async () => {
        const { getWidgetConfig } = await import('@/lib/server/domains/settings/settings.widget')
        const widgetConfig = await getWidgetConfig()
        // A disabled widget answers like a route that does not exist.
        if (!widgetConfig.enabled) {
          return widgetNotFoundResponse({
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=60',
          })
        }
        // Prepend a tenant-specific URL. The bundle reads window.__QUACKBACK_URL__
        // during browser-queue init to auto-fire Quackback.init when the script
        // loads via a raw <script src="/api/widget/sdk.js"> tag.
        const prelude = `window.__QUACKBACK_URL__=${JSON.stringify(config.baseUrl)};`
        return jsResponse(prelude + (widgetBundle as string), 3600)
      },
    },
  },
})
