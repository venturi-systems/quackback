'use client'

import { useState, useTransition } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { createApiKeyFn } from '@/lib/server/functions/api-keys'
import {
  API_KEY_DEFAULT_EXPIRY_DAYS,
  API_KEY_EXPIRY_OPTIONS_DAYS,
  API_KEY_PRESETS,
  API_KEY_SCOPE_DESCRIPTIONS,
  DEFAULT_API_KEY_PRESET,
  type ApiKeyPreset,
} from '@/lib/shared/api-key-scopes'
import type { ApiKey } from '@/lib/shared/types'

interface CreateApiKeyDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onKeyCreated: (key: ApiKey, plainTextKey: string) => void
}

/** Expiry as an ISO timestamp `days` from now. */
function expiryFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
}

export function CreateApiKeyDialog({ open, onOpenChange, onKeyCreated }: CreateApiKeyDialogProps) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const [isPending, startTransition] = useTransition()
  const [name, setName] = useState('')
  const [presetId, setPresetId] = useState<ApiKeyPreset['id']>(DEFAULT_API_KEY_PRESET)
  const [expiryDays, setExpiryDays] = useState<number>(API_KEY_DEFAULT_EXPIRY_DAYS)
  const [error, setError] = useState<string | null>(null)

  const preset = API_KEY_PRESETS.find((p) => p.id === presetId) ?? API_KEY_PRESETS[0]

  const reset = () => {
    setName('')
    setPresetId(DEFAULT_API_KEY_PRESET)
    setExpiryDays(API_KEY_DEFAULT_EXPIRY_DAYS)
    setError(null)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (!name.trim()) {
      setError('Please enter a name for the API key')
      return
    }

    try {
      const result = await createApiKeyFn({
        data: {
          name: name.trim(),
          scopes: [...preset.scopes],
          expiresAt: expiryFromNow(expiryDays),
        },
      })

      // Invalidate queries to refresh the list
      startTransition(() => {
        queryClient.invalidateQueries({ queryKey: ['admin', 'api-keys'] })
        router.invalidate()
      })

      // Reset form and notify parent
      reset()
      onKeyCreated(result.apiKey, result.plainTextKey)
    } catch (err) {
      console.error('Failed to create API key:', err)
      setError(err instanceof Error ? err.message : 'Failed to create API key')
    }
  }

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) reset()
    onOpenChange(newOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create API Key</DialogTitle>
          <DialogDescription>
            Create a new API key to authenticate with the Venturi Feedback API. A key acts with your
            role and never more, and no key can change a post&apos;s status.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                placeholder="e.g., Production API, Integration Bot"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={isPending}
                autoFocus
              />
              <p className="text-xs text-muted-foreground">
                Give your key a descriptive name so you can identify it later.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="api-key-access">Access</Label>
              <Select
                value={presetId}
                onValueChange={(value) => setPresetId(value as ApiKeyPreset['id'])}
                disabled={isPending}
              >
                <SelectTrigger id="api-key-access" aria-label="Access">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {API_KEY_PRESETS.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{preset.description}</p>
              <ul className="text-xs text-muted-foreground list-disc pl-4" data-testid="scope-list">
                {preset.scopes.map((scope) => (
                  <li key={scope}>
                    <code>{scope}</code>: {API_KEY_SCOPE_DESCRIPTIONS[scope].detail}
                  </li>
                ))}
              </ul>
            </div>

            <div className="space-y-2">
              <Label htmlFor="api-key-expiry">Expires</Label>
              <Select
                value={String(expiryDays)}
                onValueChange={(value) => setExpiryDays(Number(value))}
                disabled={isPending}
              >
                <SelectTrigger id="api-key-expiry" aria-label="Expires">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {API_KEY_EXPIRY_OPTIONS_DAYS.map((days) => (
                    <SelectItem key={days} value={String(days)}>
                      In {days} days
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Every key expires. Rotate or create a new key before it does.
              </p>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isPending || !name.trim()}>
              {isPending ? 'Creating...' : 'Create Key'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
