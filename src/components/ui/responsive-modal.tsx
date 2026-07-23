/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as DialogPrimitive from '@radix-ui/react-dialog'
import { XIcon } from 'lucide-react'
import { createContext, useContext, type ComponentProps, type ReactNode } from 'react'

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
  modalFieldSurfaceClass,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/utils'

// =============================================================================
// Context for sharing the active surface with nested modal-aware components
// =============================================================================

const ResponsiveModalContext = createContext<{ isMobile: boolean }>({
  isMobile: false,
})

/** Reports whether a descendant is rendering inside the shared mobile modal shell. */
export const useResponsiveModalContext = () => useContext(ResponsiveModalContext)

type ResponsiveModalSurfaceVariant = 'structured' | 'composable'

type ResponsiveModalDialogContentProps = ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
  surfaceVariant: ResponsiveModalSurfaceVariant
}

/** Mobile pins the close top-LEFT (header actions like the ⋯ menu take the
 *  top-right); desktop centered dialogs keep the conventional top-right. */
const responsiveModalCloseClass =
  'ring-offset-background focus:ring-ring absolute z-10 flex h-[var(--touch-height-sm)] w-[var(--touch-height-sm)] cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:ring-2 focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none'

/** Returns the shared surface classes for a responsive modal viewport and API variant. */
export const getResponsiveModalSurfaceClass = (isMobile: boolean, surfaceVariant: ResponsiveModalSurfaceVariant) => {
  if (isMobile) {
    return 'inset-0 h-dvh w-full gap-4 overflow-auto rounded-none border-0 p-6 shadow-none'
  }

  if (surfaceVariant === 'structured') {
    return 'dark:bg-card top-[50%] left-[50%] min-h-[550px] max-h-[85vh] w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] overflow-hidden rounded-2xl p-6 shadow-lg sm:max-w-md'
  }

  return 'dark:bg-card top-[50%] left-[50%] w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 overflow-hidden rounded-2xl p-6 shadow-lg sm:max-w-lg'
}

/**
 * The single responsive dialog surface used by both public modal APIs and by
 * mobile detail views. Mobile geometry, safe areas, animation, fields, and the
 * close control must remain centralized here.
 */
const ResponsiveModalDialogContent = ({
  className,
  children,
  showCloseButton = true,
  surfaceVariant,
  ...props
}: ResponsiveModalDialogContentProps) => {
  const { isMobile } = useIsMobile()

  return (
    <ResponsiveModalContext value={{ isMobile }}>
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content
          data-slot="responsive-modal-content"
          className={cn(
            'bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed z-50 flex flex-col duration-200',
            modalFieldSurfaceClass,
            getResponsiveModalSurfaceClass(isMobile, surfaceVariant),
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
              data-slot="responsive-modal-close"
              className={cn(responsiveModalCloseClass, isMobile ? 'left-4' : 'right-4')}
              style={{ top: isMobile ? 'calc(var(--safe-area-top-padding, 0px) + 16px)' : 16 }}
            >
              <XIcon className="size-[var(--icon-size-default)]" />
              <span className="sr-only">Close</span>
            </DialogClose>
          )}
        </DialogPrimitive.Content>
      </DialogPortal>
    </ResponsiveModalContext>
  )
}

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
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveModalDialogContent
        className={className}
        showCloseButton={showCloseButton}
        surfaceVariant="structured"
        onOpenAutoFocus={onOpenAutoFocus}
        onInteractOutside={onInteractOutside}
        onEscapeKeyDown={onEscapeKeyDown}
      >
        {children}
      </ResponsiveModalDialogContent>
    </Dialog>
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

type ResponsiveModalActionsProps = ComponentProps<'div'>

/** Optional mobile toolbar actions, positioned opposite the shared close control
 *  (close sits top-left; actions sit top-right). */
export const ResponsiveModalActions = ({ className, ...props }: ResponsiveModalActionsProps) => (
  <div
    className={cn(
      // No size/radius overrides here: action buttons style themselves via
      // mutedIconButtonClass, which mirrors the shared close control's
      // responsive size (--touch-height-sm) and mobile circle shape.
      'fixed right-4 z-10 flex items-center',
      className,
    )}
    style={{ top: 'calc(var(--safe-area-top-padding, 0px) + 16px)' }}
    {...props}
  />
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
  <DialogFooter className={cn('mt-auto flex-shrink-0 flex-row justify-end gap-2 pt-4', className)} {...props} />
)

/** Standard secondary action for dismissing a responsive modal form. */
export const ResponsiveModalCancel = ({
  children = 'Cancel',
  ...props
}: Omit<ComponentProps<typeof Button>, 'type' | 'variant'>) => (
  <Button type="button" variant="outline" {...props}>
    {children}
  </Button>
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
  return (
    <ResponsiveModalDialogContent
      className={className}
      showCloseButton={showCloseButton}
      surfaceVariant="composable"
      {...props}
    >
      {children}
    </ResponsiveModalDialogContent>
  )
}

export const ResponsiveModalTrigger = DialogTrigger

// =============================================================================
// Deprecated exports (for backwards compatibility)
// =============================================================================

/** @deprecated Use ResponsiveModalContent instead */
export const ResponsiveModalBody = ResponsiveModalContent
