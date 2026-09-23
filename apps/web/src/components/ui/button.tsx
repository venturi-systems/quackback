import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/shared/utils'

const buttonVariants = cva(
  [
    'inline-flex items-center justify-center gap-2 shrink-0',
    'text-sm font-medium whitespace-nowrap',
    'cursor-pointer',
    'transition-[background-color,border-color,color,box-shadow] duration-200 ease-out',
    'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
    'disabled:pointer-events-none disabled:opacity-50',
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ],
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground shadow-xs hover:bg-primary/90 hover:shadow-sm active:bg-primary/85 active:shadow-none',
        destructive:
          'bg-destructive text-white shadow-xs hover:bg-destructive/90 hover:shadow-sm active:bg-destructive/85 focus-visible:ring-destructive',
        outline:
          'border border-input bg-transparent hover:bg-muted/40 hover:border-ring active:bg-muted/60',
        secondary: 'bg-muted text-foreground hover:bg-muted/80 active:bg-muted/70',
        ghost: 'text-muted-foreground hover:text-foreground hover:bg-muted/40 active:bg-muted/60',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      // v6.6 control heights (component.button.height-*): default 42px,
      // sm 32px (header, card footers and dense toolbars only), lg 44px.
      // Heights stay fixed so a caller's own h-* still wins (tailwind-merge),
      // and on coarse pointers every size meets the 44px touch minimum.
      size: {
        default:
          'h-(--ds-component-button-height-default) px-4 py-2 has-[>svg]:px-3 pointer-coarse:h-(--ds-component-touch-minimum)',
        sm: 'h-(--ds-component-button-height-sm) gap-1.5 px-3 has-[>svg]:px-2.5 pointer-coarse:h-(--ds-component-touch-minimum)',
        lg: 'h-(--ds-component-button-height-lg) px-6 has-[>svg]:px-5',
        icon: 'size-9 pointer-coarse:size-(--ds-component-touch-minimum)',
        'icon-sm': 'size-8 pointer-coarse:size-(--ds-component-touch-minimum)',
        'icon-lg': 'size-(--ds-component-touch-minimum)',
      },
      shape: {
        default: '[border-radius:var(--radius)]',
        pill: 'rounded-full',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
      shape: 'default',
    },
  }
)

function Button({
  className,
  variant,
  size,
  shape,
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot : 'button'

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, shape, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
