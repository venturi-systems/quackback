import type { ComponentType } from 'react'
import { cn } from '@/lib/shared/utils'

interface EmptyStateProps {
  icon: ComponentType<{ className?: string }>
  title: string
  headingAs?: 'h1' | 'h2' | 'h3'
  description?: string
  action?: React.ReactNode
  className?: string
}

export function EmptyState({
  icon: Icon,
  title,
  headingAs: Heading = 'h3',
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn('flex flex-col items-center justify-center py-16 px-4 text-center', className)}
    >
      <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mb-4">
        <Icon className="h-6 w-6 text-muted-foreground" />
      </div>
      <Heading className="text-lg font-medium mb-1">{title}</Heading>
      {description && (
        <p className="text-sm text-muted-foreground max-w-sm text-balance">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}
