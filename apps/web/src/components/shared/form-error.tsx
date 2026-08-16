import { cn } from '@/lib/shared/utils'

interface FormErrorProps {
  id?: string
  message: string
  className?: string
}

export function FormError({ id, message, className }: FormErrorProps) {
  return (
    <div
      id={id}
      role="alert"
      aria-live="assertive"
      className={cn('rounded-md bg-destructive/10 p-3 text-sm text-destructive', className)}
    >
      {message}
    </div>
  )
}
