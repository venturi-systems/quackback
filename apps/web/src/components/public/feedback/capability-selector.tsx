import { useEffect, useState } from 'react'
import type { BoardId, TagId } from '@quackback/ids'
import { getFeatureCapabilitiesFn } from '@/lib/server/functions/feature-capabilities'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

export function CapabilitySelector({
  boardId,
  value,
  onChange,
  getAuthHeaders,
  refreshKey,
}: {
  refreshKey?: string
  boardId: string
  value: TagId | undefined
  onChange: (value: TagId | undefined) => void
  getAuthHeaders?: () => Record<string, string>
}) {
  const [options, setOptions] = useState<Array<{ id: TagId; label: string }>>([])
  const [required, setRequired] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    setError('')
    setOptions([])
    setRequired(false)
    onChange(undefined)
    if (!boardId) return
    void getFeatureCapabilitiesFn({
      data: { boardId: boardId as BoardId },
      ...(getAuthHeaders ? { headers: getAuthHeaders() } : {}),
    })
      .then((result) => {
        if (active) {
          setOptions(result.options)
          setRequired(result.required)
        }
      })
      .catch(() => {
        if (active) setError('Sign in to choose a capability, then submit your request.')
      })
    return () => {
      active = false
    }
  }, [boardId, getAuthHeaders, onChange, refreshKey])
  if (error)
    return (
      <p role="status" className="text-muted-foreground text-sm">
        {error}
      </p>
    )
  if (!required) return null
  return (
    <div className="space-y-2">
      <label htmlFor="feature-capability" className="text-sm font-medium">
        Primary capability (required)
      </label>
      <Select value={value ?? ''} onValueChange={(id) => onChange(id as TagId)}>
        <SelectTrigger id="feature-capability" aria-required="true">
          <SelectValue placeholder="What should this request improve?" />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-muted-foreground text-xs">
        Choose the capability that best describes your request.
      </p>
    </div>
  )
}
