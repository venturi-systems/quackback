/**
 * Widget routes answer 404 while the widget is off.
 *
 * A disabled widget is not a feature to describe to strangers: every widget
 * endpoint (identify, session, search, upload, config, SDK, the iframe page and
 * the portal handoff) answers exactly like a route that does not exist. That
 * matches the /widget page and keeps a disabled workspace from exposing a
 * session-minting surface (landing-page#2309).
 */

export function widgetNotFoundResponse(headers?: HeadersInit): Response {
  return Response.json(
    { error: { code: 'NOT_FOUND', message: 'Not found' } },
    { status: 404, headers }
  )
}

/** A 404 response when the widget is disabled, or null when it is on. */
export async function widgetDisabledResponse(headers?: HeadersInit): Promise<Response | null> {
  const { getWidgetConfig } = await import('@/lib/server/domains/settings/settings.widget')
  const widgetConfig = await getWidgetConfig()
  return widgetConfig.enabled ? null : widgetNotFoundResponse(headers)
}
