import { useState, useEffect } from 'react'
import { useSearch } from '@tanstack/react-router'
import { ArrowPathIcon, CheckCircleIcon } from '@heroicons/react/24/solid'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/shared/confirm-dialog'
import { useDeleteIntegration } from '@/lib/client/mutations'

interface OAuthConnectionActionsProps {
  integrationId?: string
  isConnected: boolean
  /** The search param key used for the OAuth callback (e.g. "github", "slack") */
  searchParamKey: string
  /** Server function that returns the OAuth connect URL */
  getConnectUrl: () => Promise<string>
  /** Display name for the disconnect dialog (e.g. "GitHub", "Slack") */
  displayName: string
  /** Description for the disconnect dialog */
  disconnectDescription: string
}

export function OAuthConnectionActions({
  integrationId,
  isConnected,
  searchParamKey,
  getConnectUrl,
  displayName,
  disconnectDescription,
}: OAuthConnectionActionsProps) {
  const search = useSearch({ strict: false })
  const deleteMutation = useDeleteIntegration()
  const [showSuccess, setShowSuccess] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [connectError, setConnectError] = useState<string | null>(null)
  const [disconnectDialogOpen, setDisconnectDialogOpen] = useState(false)

  useEffect(() => {
    const searchParams = search as Record<string, string | undefined>
    if (searchParams[searchParamKey] !== 'connected') return

    setShowSuccess(true)
    const url = new URL(window.location.href)
    url.searchParams.delete(searchParamKey)
    window.history.replaceState({}, '', url.toString())

    const timer = setTimeout(() => setShowSuccess(false), 3000)
    return () => clearTimeout(timer)
  }, [search, searchParamKey])

  useEffect(() => {
    // A restored browser history entry retains React state, including pending UI.
    const handlePageShow = () => setConnecting(false)
    window.addEventListener('pageshow', handlePageShow)
    return () => window.removeEventListener('pageshow', handlePageShow)
  }, [])

  const handleConnect = async () => {
    setConnectError(null)
    setConnecting(true)
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const url = await Promise.race([
        getConnectUrl(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Connection request timed out')), 30_000)
        }),
      ])
      window.location.href = url
    } catch {
      setConnectError(`Unable to start the ${displayName} connection. Please try again.`)
      setConnecting(false)
    } finally {
      clearTimeout(timeout)
    }
  }

  const handleDisconnect = () => {
    if (!integrationId) return
    deleteMutation.mutate({ id: integrationId })
  }

  const disconnecting = deleteMutation.isPending

  return (
    <>
      {showSuccess && (
        <div className="flex items-center gap-2 rounded-lg border border-green-500/30 bg-green-500/10 px-3 py-2 text-sm text-green-600 dark:text-green-400">
          <CheckCircleIcon className="h-4 w-4" />
          <span>Connected successfully!</span>
        </div>
      )}

      {connectError && (
        <p role="alert" className="max-w-sm text-sm text-destructive">
          {connectError}
        </p>
      )}

      <div className="flex items-center gap-2">
        {!isConnected && (
          <Button onClick={handleConnect} disabled={connecting}>
            {connecting ? (
              <>
                <ArrowPathIcon className="mr-2 h-4 w-4 animate-spin" />
                Connecting...
              </>
            ) : (
              'Connect'
            )}
          </Button>
        )}

        {isConnected && (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={disconnecting}
              onClick={() => setDisconnectDialogOpen(true)}
            >
              {disconnecting ? (
                <>
                  <ArrowPathIcon className="mr-2 h-4 w-4 animate-spin" />
                  Disconnecting...
                </>
              ) : (
                'Disconnect'
              )}
            </Button>
            <ConfirmDialog
              open={disconnectDialogOpen}
              onOpenChange={setDisconnectDialogOpen}
              title={`Disconnect ${displayName}?`}
              description={disconnectDescription}
              confirmLabel="Disconnect"
              isPending={disconnecting}
              onConfirm={handleDisconnect}
            />
          </>
        )}
      </div>
    </>
  )
}
