'use client'

/**
 * This component is from https://shadcnui-expansions.typeart.cc/docs/responsive-modal (with modifications)
 */

import * as DialogPrimitive from '@radix-ui/react-dialog'
import { cva, type VariantProps } from 'class-variance-authority'
import { X } from 'lucide-react'
import {
  forwardRef,
  type ElementRef,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type HTMLAttributes,
} from 'react'

import { cn } from '@/lib/utils'

const ResponsiveModal = DialogPrimitive.Root

const ResponsiveModalTrigger = DialogPrimitive.Trigger

const ResponsiveModalClose = DialogPrimitive.Close

const ResponsiveModalPortal = DialogPrimitive.Portal

const ResponsiveModalOverlay = forwardRef<
  ElementRef<typeof DialogPrimitive.Overlay>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    className={cn(
      'fixed inset-0 z-50 bg-background/80 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
      className,
    )}
    {...props}
    ref={ref}
  />
))
ResponsiveModalOverlay.displayName = DialogPrimitive.Overlay.displayName

const ResponsiveModalVariants = cva(
  cn(
    'fixed z-50 gap-4 bg-background p-6 shadow-lg transition ease-in-out data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:duration-300 data-[state=open]:duration-500 overflow-y-auto',
    'sm:left-[50%] sm:top-[50%] sm:w-full sm:max-w-lg sm:translate-x-[-50%] sm:translate-y-[-50%] sm:border sm:duration-200 sm:data-[state=open]:animate-in sm:data-[state=closed]:animate-out sm:data-[state=closed]:fade-out-0 sm:data-[state=open]:fade-in-0 sm:data-[state=closed]:zoom-out-95 sm:data-[state=open]:zoom-in-95 sm:rounded-xl',
  ),
  {
    variants: {
      side: {
        top: 'inset-x-0 top-0 border-b rounded-b-xl max-h-[80dvh] sm:h-fit data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top',
        bottom:
          'inset-x-0 bottom-0 border-t sm:h-fit max-h-[80dvh] rounded-t-xl data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom',
        left: 'inset-y-0 left-0 h-full sm:h-fit w-3/4 border-r rounded-r-xl data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:max-w-sm',
        right:
          'inset-y-0 right-0 h-full sm:h-fit w-3/4 border-l rounded-l-xl data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right sm:max-w-sm',
      },
    },
    defaultVariants: {
      side: 'bottom',
    },
  },
)

interface ResponsiveModalContentProps
  extends ComponentPropsWithoutRef<typeof DialogPrimitive.Content>,
    VariantProps<typeof ResponsiveModalVariants> {}

const ResponsiveModalContent = forwardRef<ElementRef<typeof DialogPrimitive.Content>, ResponsiveModalContentProps>(
  // Added `style` to the destructured props so we can merge custom styles
  ({ side = 'bottom', className, children, style, ...props }, ref) => {
    // Compute additional inline styles when the sheet is anchored to the bottom
    const bottomSheetStyle: CSSProperties | undefined =
      side === 'bottom'
        ? {
            // Lift the sheet above the software keyboard.
            bottom: 'var(--kb, 0px)',
            // Keep the sheet inside the visible viewport when raised.
            maxHeight: 'calc(80dvh - var(--kb, 0px))',
            // Ensure content isn’t hidden behind the iOS home indicator notch.
            paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + var(--kb, 0px))',
          }
        : undefined

    return (
      <ResponsiveModalPortal>
        <ResponsiveModalOverlay />
        <DialogPrimitive.Content
          ref={ref}
          className={cn(ResponsiveModalVariants({ side }), className)}
          // Merge caller-provided styles with our dynamic ones (caller styles win)
          style={{ ...bottomSheetStyle, ...style }}
          {...props}
        >
          {children}
          <ResponsiveModalClose className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-secondary">
            <X className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </ResponsiveModalClose>
        </DialogPrimitive.Content>
      </ResponsiveModalPortal>
    )
  },
)
ResponsiveModalContent.displayName = DialogPrimitive.Content.displayName

const ResponsiveModalHeader = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col space-y-2 text-center sm:text-left', className)} {...props} />
)
ResponsiveModalHeader.displayName = 'ResponsiveModalHeader'

const ResponsiveModalFooter = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2', className)} {...props} />
)
ResponsiveModalFooter.displayName = 'ResponsiveModalFooter'

const ResponsiveModalTitle = forwardRef<
  ElementRef<typeof DialogPrimitive.Title>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn('text-lg font-semibold text-foreground', className)} {...props} />
))
ResponsiveModalTitle.displayName = DialogPrimitive.Title.displayName

const ResponsiveModalDescription = forwardRef<
  ElementRef<typeof DialogPrimitive.Description>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} className={cn('text-sm text-muted-foreground', className)} {...props} />
))
ResponsiveModalDescription.displayName = DialogPrimitive.Description.displayName

export {
  ResponsiveModal,
  ResponsiveModalClose,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalOverlay,
  ResponsiveModalPortal,
  ResponsiveModalTitle,
  ResponsiveModalTrigger,
}
