import * as DialogPrimitive from '@radix-ui/react-dialog'
import { XIcon } from 'lucide-react'
import { createContext, type ComponentProps, type ReactNode } from 'react'

import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { SidebarCloseButton } from '@/components/ui/sidebar-close-button'
import { useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/utils'

// =============================================================================
// Context for sharing mobile state and close handler with sub-components
// =============================================================================

const ResponsiveModalContext = createContext<{ isMobile: boolean; onClose: () => void }>({
  isMobile: false,
  onClose: () => {},
})

// =============================================================================
// Main ResponsiveModal component
// =============================================================================

type ResponsiveModalProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: ReactNode
  /** Additional className for the dialog content */
  className?: string
  /** Whether to show the close button (default: true) */
  showCloseButton?: boolean
  /** Callback fired when focus moves into the content after opening */
  onOpenAutoFocus?: (event: Event) => void
  /** Callback fired when user clicks outside the dialog */
  onInteractOutside?: (event: Event) => void
  /** Callback fired when user presses Escape */
  onEscapeKeyDown?: (event: KeyboardEvent) => void
}

/**
 * A responsive modal that is full-screen on mobile and a centered dialog on desktop.
 *
 * @example
 * ```tsx
 * <ResponsiveModal open={open} onOpenChange={setOpen}>
 *   <ResponsiveModalHeader>
 *     <ResponsiveModalTitle>Title</ResponsiveModalTitle>
 *     <ResponsiveModalDescription>Description</ResponsiveModalDescription>
 *   </ResponsiveModalHeader>
 *
 *   <ResponsiveModalContent centered>
 *     <p>Your content here</p>
 *   </ResponsiveModalContent>
 *
 *   <ResponsiveModalFooter>
 *     <Button onClick={() => setOpen(false)}>Close</Button>
 *   </ResponsiveModalFooter>
 * </ResponsiveModal>
 * ```
 */
export const ResponsiveModal = ({
  open,
  onOpenChange,
  children,
  className,
  showCloseButton = true,
  onOpenAutoFocus,
  onInteractOutside,
  onEscapeKeyDown,
}: ResponsiveModalProps) => {
  const { isMobile } = useIsMobile()

  const handleClose = () => onOpenChange(false)

  return (
    <ResponsiveModalContext.Provider value={{ isMobile, onClose: handleClose }}>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogPortal>
          <DialogOverlay />
          <DialogPrimitive.Content
            onOpenAutoFocus={onOpenAutoFocus}
            onInteractOutside={onInteractOutside}
            onEscapeKeyDown={onEscapeKeyDown}
            className={cn(
              'bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed z-50 duration-200',
              isMobile
                ? 'inset-0 w-full min-h-dvh border-0 rounded-none shadow-none overflow-y-auto flex flex-col'
                : 'top-[50%] left-[50%] w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] rounded-[var(--radius-lg)] border sm:max-w-md shadow-lg min-h-[550px] max-h-[85vh] flex flex-col',
              className,
            )}
            style={
              isMobile
                ? {
                    paddingTop: 'var(--safe-area-top-padding, 0px)',
                    paddingBottom: 'calc(var(--safe-area-bottom-padding, 0px) + 24px)',
                  }
                : { padding: 24 }
            }
          >
            {isMobile ? (
              <>
                {/* Close button positioned to match sidebar header's close button position */}
                {showCloseButton && (
                  <div
                    className="absolute right-2 z-10"
                    style={{ top: 'calc(var(--safe-area-top-padding, 0px) + 8px)' }}
                  >
                    <SidebarCloseButton onClick={handleClose} />
                  </div>
                )}
                <div className="flex flex-col min-h-full flex-1 px-6 pt-14">{children}</div>
              </>
            ) : (
              <>
                {children}
                {showCloseButton && (
                  <DialogPrimitive.Close className="ring-offset-background focus:ring-ring absolute right-4 top-4 flex h-[var(--touch-height-sm)] w-[var(--touch-height-sm)] cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:ring-2 focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none">
                    <XIcon className="size-[var(--icon-size-default)]" />
                    <span className="sr-only">Close</span>
                  </DialogPrimitive.Close>
                )}
              </>
            )}
          </DialogPrimitive.Content>
        </DialogPortal>
      </Dialog>
    </ResponsiveModalContext.Provider>
  )
}

// =============================================================================
// Header components
// =============================================================================

type ResponsiveModalHeaderProps = ComponentProps<'div'>

/** Header section - stays at top of modal, always centered */
export const ResponsiveModalHeader = ({ className, ...props }: ResponsiveModalHeaderProps) => (
  <DialogHeader className={cn('flex-shrink-0 text-center sm:text-center mb-4', className)} {...props} />
)

type ResponsiveModalTitleProps = ComponentProps<typeof DialogTitle>

export const ResponsiveModalTitle = ({ className, ...props }: ResponsiveModalTitleProps) => (
  <DialogTitle className={className} {...props} />
)

type ResponsiveModalDescriptionProps = ComponentProps<typeof DialogDescription>

export const ResponsiveModalDescription = ({ className, ...props }: ResponsiveModalDescriptionProps) => (
  <DialogDescription className={className} {...props} />
)

// =============================================================================
// Content component
// =============================================================================

type ResponsiveModalContentProps = ComponentProps<'div'> & {
  /** Center content vertically (useful for simple content like cards) */
  centered?: boolean
}

/**
 * Main content area - grows to fill available space.
 * Use `centered` prop to vertically center content.
 */
export const ResponsiveModalContent = ({ className, centered, ...props }: ResponsiveModalContentProps) => (
  <div
    className={cn('flex-1 py-4 px-1 -mx-1 overflow-auto', centered && 'flex flex-col justify-center', className)}
    {...props}
  />
)

// =============================================================================
// Footer component
// =============================================================================

type ResponsiveModalFooterProps = ComponentProps<'div'>

/** Footer section - stays at bottom of modal */
export const ResponsiveModalFooter = ({ className, ...props }: ResponsiveModalFooterProps) => (
  <DialogFooter className={cn('flex-shrink-0 flex-row gap-2 sm:justify-end', className)} {...props} />
)

// =============================================================================
// Composable pattern exports (for trigger-based modals)
// =============================================================================

type ResponsiveModalContentComposableProps = ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
}

/**
 * Alternative content component for trigger-based modals.
 * Use with ResponsiveModalTrigger when you need a trigger button.
 */
export const ResponsiveModalContentComposable = ({
  className,
  children,
  showCloseButton = true,
  ...props
}: ResponsiveModalContentComposableProps) => {
  const { isMobile } = useIsMobile()

  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        className={cn(
          'bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed z-50 flex flex-col gap-4 p-6 duration-200',
          isMobile
            ? 'inset-0 w-full h-dvh border-0 rounded-none shadow-none overflow-auto'
            : 'top-[50%] left-[50%] w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] rounded-[var(--radius-lg)] border sm:max-w-lg shadow-lg',
          className,
        )}
        style={
          isMobile
            ? {
                paddingBottom: 'calc(var(--safe-area-bottom-padding, 0px) + 24px)',
                paddingTop: 'calc(var(--safe-area-top-padding, 0px) + 56px)',
              }
            : undefined
        }
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogClose
            className="ring-offset-background focus:ring-ring absolute right-4 flex h-[var(--touch-height-sm)] w-[var(--touch-height-sm)] cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:ring-2 focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none"
            style={{ top: isMobile ? 'calc(var(--safe-area-top-padding, 0px) + 16px)' : 16 }}
          >
            <XIcon className="size-[var(--icon-size-default)]" />
            <span className="sr-only">Close</span>
          </DialogClose>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

export const ResponsiveModalTrigger = DialogTrigger

// =============================================================================
// Deprecated exports (for backwards compatibility)
// =============================================================================

/** @deprecated Use ResponsiveModalContent instead */
export const ResponsiveModalBody = ResponsiveModalContent
