'use client'

import { useState } from 'react'
import { PlusIcon, ArrowPathIcon, TrashIcon, KeyIcon } from '@heroicons/react/24/outline'
import { EmptyState } from '@/components/shared/empty-state'
import { EllipsisVerticalIcon } from '@heroicons/react/24/solid'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { CreateApiKeyDialog } from './create-api-key-dialog'
import { ApiKeyRevealDialog } from './api-key-reveal-dialog'
import { RevokeApiKeyDialog } from './revoke-api-key-dialog'
import { RotateApiKeyDialog } from './rotate-api-key-dialog'
import type { ApiKey } from '@/lib/shared/types'
import { apiKeyExpiresAt, effectiveApiKeyScopes } from '@/lib/shared/api-key-scopes'
import { formatDistanceToNow } from 'date-fns'

/** A key's expiry line. A key stored without one expires a year after creation. */
function expiryLabel(key: ApiKey): string {
  const expiresAt = apiKeyExpiresAt(key.expiresAt, key.createdAt)
  if (expiresAt.getTime() <= Date.now()) return 'Expired'
  const label = `Expires ${formatDistanceToNow(expiresAt, { addSuffix: true })}`
  return key.expiresAt ? label : `${label} (created before expiry was required)`
}

/** A key's scopes line. A key stored without scopes reads only (DEF-15). */
function scopesLabel(key: ApiKey): string {
  const scopes = effectiveApiKeyScopes(key.scopes).join(', ')
  return key.scopes ? `Scopes: ${scopes}` : `Scopes: ${scopes} (created before keys had scopes)`
}

/**
 * The line on a key the DEF-15 migration limited to reading. The date is the
 * UTC calendar date, so the server and the browser render the same text.
 */
function legacyBoundLabel(boundedAt: Date): string {
  const day = new Date(boundedAt).toISOString().slice(0, 10)
  return `Limited to reading on ${day} because it was created before keys needed scopes and an expiry. Replace it before it expires.`
}

interface ApiKeysSettingsProps {
  apiKeys: ApiKey[]
}

export function ApiKeysSettings({ apiKeys }: ApiKeysSettingsProps) {
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [revealDialogOpen, setRevealDialogOpen] = useState(false)
  const [revokeDialogOpen, setRevokeDialogOpen] = useState(false)
  const [rotateDialogOpen, setRotateDialogOpen] = useState(false)
  const [selectedKey, setSelectedKey] = useState<ApiKey | null>(null)
  const [newKeyValue, setNewKeyValue] = useState<string | null>(null)

  const handleKeyCreated = (key: ApiKey, plainTextKey: string) => {
    setNewKeyValue(plainTextKey)
    setSelectedKey(key)
    setCreateDialogOpen(false)
    setRevealDialogOpen(true)
  }

  const handleKeyRotated = (key: ApiKey, plainTextKey: string) => {
    setNewKeyValue(plainTextKey)
    setSelectedKey(key)
    setRotateDialogOpen(false)
    setRevealDialogOpen(true)
  }

  const handleRevokeClick = (key: ApiKey) => {
    setSelectedKey(key)
    setRevokeDialogOpen(true)
  }

  const handleRotateClick = (key: ApiKey) => {
    setSelectedKey(key)
    setRotateDialogOpen(true)
  }

  // Keys created before every key needed scopes and an expiry, which the
  // DEF-15 migration limited to reading and gave an expiry.
  const boundedKeys = apiKeys.filter((key) => key.legacyBoundedAt)

  return (
    <div className="space-y-4">
      {/* Empty state */}
      {apiKeys.length === 0 && (
        <div className="rounded-lg border border-dashed">
          <EmptyState
            icon={KeyIcon}
            title="No API keys yet"
            description="API keys let you integrate Quackback with your apps, sync feedback programmatically, and build custom workflows."
            action={
              <Button size="sm" onClick={() => setCreateDialogOpen(true)}>
                <PlusIcon className="h-4 w-4 mr-1.5" />
                Create your first API key
              </Button>
            }
          />
        </div>
      )}

      {/* Header with create button */}
      {apiKeys.length > 0 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            {apiKeys.length} active {apiKeys.length === 1 ? 'key' : 'keys'}
          </p>
          <Button size="sm" onClick={() => setCreateDialogOpen(true)}>
            <PlusIcon className="h-4 w-4 mr-1.5" />
            Create Key
          </Button>
        </div>
      )}

      {boundedKeys.length > 0 && (
        <div
          className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 text-sm"
          role="note"
          data-testid="api-keys-legacy-notice"
        >
          <p className="font-medium">
            {boundedKeys.length === 1
              ? '1 key was created before keys needed scopes and an expiry'
              : `${boundedKeys.length} keys were created before keys needed scopes and an expiry`}
          </p>
          <p className="mt-1 text-muted-foreground">
            They can now only read feedback and help articles, and each stops working on the
            date shown. Before then, create a key with the scopes the integration needs, move
            the integration to it, and revoke the old key.
          </p>
        </div>
      )}

      {/* API Keys list */}
      {apiKeys.length > 0 && (
        <div className="space-y-3">
          {apiKeys.map((key) => (
            <div
              key={key.id}
              className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-lg border border-border/50 p-4"
            >
              <div className="flex items-center gap-3 min-w-0">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <KeyIcon className="h-5 w-5 text-muted-foreground" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium break-words" data-text-origin="user">
                    {key.name}
                  </p>
                  <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2 text-xs text-muted-foreground">
                    <code className="rounded bg-muted px-1.5 py-0.5 font-mono w-fit">
                      {key.keyPrefix}...
                    </code>
                    <span className="hidden sm:inline">·</span>
                    <span>Created {formatDistanceToNow(key.createdAt, { addSuffix: true })}</span>
                    {key.lastUsedAt ? (
                      <>
                        <span className="hidden sm:inline">·</span>
                        <span>
                          Last used {formatDistanceToNow(key.lastUsedAt, { addSuffix: true })}
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="hidden sm:inline">·</span>
                        <span className="text-amber-700 dark:text-amber-400">Never used</span>
                      </>
                    )}
                    <span className="hidden sm:inline">·</span>
                    <span>{expiryLabel(key)}</span>
                  </div>
                  <p className="text-xs text-muted-foreground" data-testid="api-key-scopes">
                    {scopesLabel(key)}
                  </p>
                  {/* amber-700 reads 4.8:1 on the card; amber-600 read 3.0:1 (v6.6: 4.5:1). */}
                  {key.legacyBoundedAt && (
                    <p
                      className="text-xs text-amber-700 dark:text-amber-400"
                      data-testid="api-key-legacy-bound"
                    >
                      {legacyBoundLabel(key.legacyBoundedAt)}
                    </p>
                  )}
                </div>
              </div>

              {/* Desktop: show buttons */}
              <div className="hidden sm:flex items-center gap-2 shrink-0">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleRotateClick(key)}
                  aria-label={`Rotate ${key.name} API key`}
                >
                  <ArrowPathIcon className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleRevokeClick(key)}
                  aria-label={`Revoke ${key.name} API key`}
                  className="text-destructive hover:text-destructive"
                >
                  <TrashIcon className="h-4 w-4" />
                </Button>
              </div>

              {/* Mobile: dropdown menu */}
              <div className="sm:hidden self-end">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" aria-label="Key actions">
                      <EllipsisVerticalIcon className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => handleRotateClick(key)}>
                      <ArrowPathIcon className="h-4 w-4 mr-2" />
                      Rotate Key
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => handleRevokeClick(key)}
                      className="text-destructive focus:text-destructive"
                    >
                      <TrashIcon className="h-4 w-4 mr-2" />
                      Revoke Key
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Dialogs */}
      <CreateApiKeyDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onKeyCreated={handleKeyCreated}
      />

      <ApiKeyRevealDialog
        open={revealDialogOpen}
        onOpenChange={setRevealDialogOpen}
        keyValue={newKeyValue}
        keyName={selectedKey?.name ?? ''}
        onClose={() => setNewKeyValue(null)}
      />

      {selectedKey && (
        <>
          <RevokeApiKeyDialog
            open={revokeDialogOpen}
            onOpenChange={setRevokeDialogOpen}
            apiKey={selectedKey}
          />

          <RotateApiKeyDialog
            open={rotateDialogOpen}
            onOpenChange={setRotateDialogOpen}
            apiKey={selectedKey}
            onKeyRotated={handleKeyRotated}
          />
        </>
      )}
    </div>
  )
}
