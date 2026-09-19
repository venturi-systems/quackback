import * as React from 'react'
import * as PopoverPrimitive from '@radix-ui/react-popover'

import { cn } from '@/lib/shared/utils'

/**
 * When a Popover is inside a Dialog, we portal to the dialog content element
 * instead of document.body. This keeps the popover inside react-remove-scroll's
 * boundary so wheel events work on scrollable content inside the popover.
 */
const PortalContainerContext = React.createContext<{
  container: HTMLElement | null
  setTriggerEl: (el: HTMLElement | null) => void
}>({ container: null, setTriggerEl: () => {} })

function Popover({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  const [container, setContainer] = React.useState<HTMLElement | null>(null)

  const setTriggerEl = React.useCallback((el: HTMLElement | null) => {
    if (!el) return
    const dialog = el.closest<HTMLElement>('[data-slot="dialog-content"]')
    setContainer(dialog)
  }, [])

  const ctx = React.useMemo(() => ({ container, setTriggerEl }), [container, setTriggerEl])

  return (
    <PortalContainerContext.Provider value={ctx}>
      <PopoverPrimitive.Root data-slot="popover" {...props} />
    </PortalContainerContext.Provider>
  )
}

function PopoverTrigger({
  ref: externalRef,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  const { setTriggerEl } = React.useContext(PortalContainerContext)
  const internalRef = React.useRef<HTMLButtonElement>(null)

  React.useEffect(() => {
    setTriggerEl(internalRef.current)
  }, [setTriggerEl])

  return (
    <PopoverPrimitive.Trigger
      data-slot="popover-trigger"
      ref={(node) => {
        internalRef.current = node
        if (typeof externalRef === 'function') externalRef(node)
        else if (externalRef)
          (externalRef as React.MutableRefObject<HTMLButtonElement | null>).current = node
      }}
      {...props}
    />
  )
}

function PopoverContent({
  className,
  align = 'center',
  sideOffset = 4,
  container: containerProp,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content> & { container?: HTMLElement | null }) {
  const { container: dialogContainer } = React.useContext(PortalContainerContext)
  const portalContainer = containerProp ?? dialogContainer ?? undefined

  return (
    <PopoverPrimitive.Portal container={portalContainer}>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-72 origin-(--radix-popover-content-transform-origin) [border-radius:calc(var(--radius)*0.8)] border p-4 shadow-md outline-hidden',
          className
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}

function PopoverAnchor({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />
}

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor }
