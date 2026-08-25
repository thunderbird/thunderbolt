/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { XIcon } from 'lucide-react'
import { createContext, useContext, type ComponentProps, type ReactNode } from 'react'

import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { modalAnimationClass, modalCloseClass, modalFieldSurfaceClass } from '@/components/ui/modal-styles'
import { Scrim } from '@/components/ui/scrim'
import { useIsMobile } from '@/hooks/use-mobile'
import { withCollapsedAutoFocusSelection } from '@/lib/focus'
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
  flush?: boolean
}

/**
 * Returns the shared inline geometry for a responsive modal surface.
 *
 * The mobile shell reserves the device insets (`--modal-top-inset` clears the
 * pinned corner controls, `--modal-bottom-inset` the home indicator or the
 * keyboard) so content sits between them and clips at their edges. This matters
 * for the keyboard in particular: the shell is pinned at `h-dvh`, and `dvh` does
 * not shrink when the keyboard opens, so without giving up that space the lower
 * half of a form sits under the keyboard with nothing to scroll — the content
 * still "fits" the viewport. Reserving it shrinks the surface's content box,
 * which hands the overflow to the inner scroller.
 *
 * `flush` gives up both insets and runs the surface corner to corner instead,
 * letting content scroll under the controls and the footer behind their scrims.
 * The caller then pads its own scroll container by the same two variables, so
 * content still starts clear of both at rest — and so the keyboard is still
 * accounted for, just one level in.
 */
export const getResponsiveModalSurfaceStyle = (isMobile: boolean, flush = false) => {
  if (!isMobile) {
    return undefined
  }
  return {
    paddingBottom: flush ? 0 : 'var(--modal-bottom-inset)',
    paddingTop: flush ? 0 : 'var(--modal-top-inset)',
  }
}

/** Returns the shared surface classes for a responsive modal viewport and API variant. */
export const getResponsiveModalSurfaceClass = (isMobile: boolean, surfaceVariant: ResponsiveModalSurfaceVariant) => {
  if (isMobile) {
    return 'inset-0 h-dvh w-full gap-4 overflow-auto rounded-none border-0 p-4 shadow-none'
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
  flush = false,
  onOpenAutoFocus,
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
            `${modalAnimationClass} data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed z-50 flex flex-col bg-background duration-200`,
            modalFieldSurfaceClass,
            getResponsiveModalSurfaceClass(isMobile, surfaceVariant),
            className,
          )}
          style={getResponsiveModalSurfaceStyle(isMobile, flush)}
          onOpenAutoFocus={withCollapsedAutoFocusSelection(onOpenAutoFocus)}
          {...props}
        >
          {/* Content runs to the top of the window, so it needs the same scrim
              the app header uses, keeping content legible as it scrolls behind
              the pinned controls. */}
          {isMobile && flush && (
            <Scrim
              data-slot="responsive-modal-top-scrim"
              className="z-10"
              height="calc(var(--modal-top-inset) + 2.5rem)"
            />
          )}
          {children}
          {showCloseButton && (
            <DialogClose
              data-slot="responsive-modal-close"
              className={cn(modalCloseClass, isMobile ? 'left-2' : 'right-4')}
              style={{
                top: isMobile ? 'var(--header-control-top)' : 16,
              }}
            >
              <XIcon className="size-[var(--icon-size-default)]" />
              <span className="sr-only">
                <Trans>Close</Trans>
              </span>
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
 *   <FormFooter>
 *     <Button onClick={() => setOpen(false)}>Close</Button>
 *   </FormFooter>
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

/**
 * Mobile-only pinned title bar: vertically centered with the corner controls
 * (close top-left, actions top-right) and horizontally centered between them,
 * so the title lives in the control row instead of consuming content space.
 * The horizontal insets clear a corner control plus breathing room on each
 * side; long titles truncate.
 */
export const ResponsiveModalPinnedHeader = ({ title, subtitle }: { title: string; subtitle?: string }) => (
  <div
    data-slot="responsive-modal-pinned-header"
    className="pointer-events-none absolute inset-x-[calc(0.5rem+var(--touch-height-lg)+0.5rem)] z-10 flex h-[var(--touch-height-lg)] flex-col items-center justify-center"
    style={{ top: 'var(--header-control-top)' }}
  >
    <ResponsiveModalTitle className="max-w-full truncate text-[length:var(--font-size-body)]">
      {title}
    </ResponsiveModalTitle>
    {subtitle && (
      <ResponsiveModalDescription className="max-w-full truncate text-[length:var(--font-size-xs)]">
        {subtitle}
      </ResponsiveModalDescription>
    )}
  </div>
)

type ResponsiveModalActionsProps = ComponentProps<'div'>

/** Optional mobile toolbar actions, positioned opposite the shared close control
 *  (close sits top-left; actions sit top-right). */
export const ResponsiveModalActions = ({ className, ...props }: ResponsiveModalActionsProps) => (
  <div
    className={cn(
      // No size/radius overrides here: action buttons style themselves via
      // mutedIconButtonClass, which mirrors the shared close control's
      // responsive size (--touch-height-lg on mobile, --touch-height-sm on
      // desktop) and mobile circle shape. They also
      // pair it with mobileHeaderControlFillClass so the tap target stays
      // visible at rest, like the close control opposite them.
      'fixed right-2 z-10 flex items-center',
      className,
    )}
    style={{ top: 'var(--header-control-top)' }}
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

/** Standard secondary action for dismissing a responsive modal form. */
export const ResponsiveModalCancel = ({
  children = 'Cancel',
  className,
  ...props
}: Omit<ComponentProps<typeof Button>, 'type' | 'variant'>) => (
  <Button
    type="button"
    variant="outline"
    className={cn('max-md:bg-background/80 max-md:backdrop-blur-md max-md:dark:bg-card/80', className)}
    {...props}
  >
    {children}
  </Button>
)

// =============================================================================
// Composable pattern exports (for trigger-based modals)
// =============================================================================

type ResponsiveModalContentComposableProps = ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
  /** Run mobile content corner to corner and let it scroll under the pinned
   *  controls and the footer behind their scrims, instead of sitting between
   *  them. The content must then pad its own scroll container — top by
   *  `--modal-top-inset`, bottom by enough to clear its pinned footer (see
   *  `DetailPanel`). */
  flush?: boolean
}

/**
 * Alternative content component for trigger-based modals.
 * Use with ResponsiveModalTrigger when you need a trigger button.
 */
export const ResponsiveModalContentComposable = ({
  className,
  children,
  showCloseButton = true,
  flush = false,
  ...props
}: ResponsiveModalContentComposableProps) => {
  return (
    <ResponsiveModalDialogContent
      className={className}
      showCloseButton={showCloseButton}
      surfaceVariant="composable"
      flush={flush}
      {...props}
    >
      {children}
    </ResponsiveModalDialogContent>
  )
}

export const ResponsiveModalTrigger = DialogTrigger
