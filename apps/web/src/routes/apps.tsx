import { createFileRoute, notFound, Outlet } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { setResponseHeader } from '@tanstack/react-start/server'

const setIframeHeaders = createServerFn({ method: 'GET' }).handler(async () => {
  setResponseHeader('Content-Security-Policy', 'frame-ancestors *')
  setResponseHeader('X-Frame-Options', 'ALLOWALL')
})

export const Route = createFileRoute('/apps')({
  // /apps itself is not an app surface: without this it rendered an empty,
  // frameable page. Only concrete app routes (e.g. /apps/zendesk/sidebar)
  // get the iframe headers.
  loader: ({ location }) => {
    if (/^\/apps\/?$/.test(location.pathname)) throw notFound()
    return setIframeHeaders()
  },
  component: AppsLayout,
})

function AppsLayout() {
  return (
    <>
      <style
        dangerouslySetInnerHTML={{
          __html: `
            body { overflow: auto; margin: 0; }
            html, body, #root { height: 100%; }
          `,
        }}
      />
      <Outlet />
    </>
  )
}
