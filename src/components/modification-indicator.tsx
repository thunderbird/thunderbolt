/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { type ElementType, type ReactNode, useState } from 'react'

type ModificationIndicatorProps = {
  /**
   * Whether the item has been modified from its default
   */
  hasModifications: boolean
  /**
   * Callback when user confirms reset
   */
  onReset: () => void
  /**
   * The label/text to display with the underline indicator
   */
  children: ReactNode
  /**
   * The HTML element or component to render as
   * @default "span"
   */
  as?: ElementType
  /**
   * Additional CSS classes to apply
   */
  className?: string
  /**
   * Optional DOM id, forwarded to the label's inner text node (not the outer
   * element, which carries a state `aria-label` like "Modified item" that would
   * otherwise mask the text). Lets a control reference this label via
   * `aria-labelledby` so screen readers announce the label text — and, if the
   * control also self-references, its current value.
   */
  id?: string
  /**
   * Optional custom message for the popover body
   * @default "You've customized this setting."
   */
  customMessage?: string
  /**
   * Optional custom confirmation message
   * @default "Are you sure? You will lose any changes that you made."
   */
  confirmMessage?: string
  /**
   * Optional custom aria-label for the indicator
   * @default "Modified item"
   */
  ariaLabel?: string
  /**
   * Whether to show a confirmation step before resetting
   * When false, clicking "Reset to Default" immediately resets without confirmation
   * @default false
   */
  requireConfirmation?: boolean
}

/**
 * Reusable component that shows an underline indicator on text
 * - Transparent underline when unmodified (maintains consistent text position)
 * - Brand-gradient underline when modified with reset popover on click
 * Used across automations, settings, and other default-based content
 */
export const ModificationIndicator = ({
  hasModifications,
  onReset,
  children,
  as: Component = 'span',
  className = '',
  id,
  customMessage = "You've customized this setting.",
  confirmMessage = 'Are you sure? You will lose any changes that you made.',
  ariaLabel = 'Modified item',
  requireConfirmation = false,
}: ModificationIndicatorProps) => {
  const [isPopoverOpen, setIsPopoverOpen] = useState(false)
  const [showConfirmation, setShowConfirmation] = useState(false)

  const handleResetClick = () => {
    if (requireConfirmation) {
      setShowConfirmation(true)
    } else {
      onReset()
      setIsPopoverOpen(false)
    }
  }

  const handleResetConfirm = () => {
    onReset()
    setIsPopoverOpen(false)
    setShowConfirmation(false)
  }

  const handlePopoverChange = (open: boolean) => {
    setIsPopoverOpen(open)
    if (!open) {
      // Reset confirmation state when popover closes
      setShowConfirmation(false)
    }
  }

  // Base classes for the underline indicator wrapper
  // leading-none ensures consistent line-height across different parent elements
  // pb-1 creates consistent spacing between text and underline
  const underlineClasses = 'border-b-2 inline-block pb-1 leading-none'

  if (!hasModifications) {
    // Show transparent underline for unmodified state (non-interactive)
    // Maintains consistent vertical text position
    return (
      <Component className={className} aria-label="Default setting">
        <span id={id} className={cn(underlineClasses, 'border-transparent')}>
          {children}
        </span>
      </Component>
    )
  }

  return (
    <Popover open={isPopoverOpen} onOpenChange={handlePopoverChange}>
      <PopoverTrigger asChild>
        <Component className={className} aria-label={ariaLabel} htmlFor={undefined}>
          {/* A border can't take a gradient, so the modified underline is a
              bottom-anchored 2px background strip painted through the (still
              transparent) border — [background-origin:border-box] pushes it
              into the border area so it sits exactly where the border-b-2
              would. Hover thickens the strip for feedback since there's no
              hover color to swap to. */}
          <span
            id={id}
            className={cn(
              underlineClasses,
              'cursor-pointer border-transparent bg-bottom bg-no-repeat transition-[background-size]',
              '[background-image:var(--gradient-brand)] [background-origin:border-box] [background-size:100%_2px] hover:[background-size:100%_3px]',
            )}
          >
            {children}
          </span>
        </Component>
      </PopoverTrigger>
      <PopoverContent align="start" side="bottom" className="w-[240px] p-0">
        <div className="flex flex-col">
          {/* Body */}
          <div className="p-3 pb-2">
            <p className="text-sm text-muted-foreground">{!showConfirmation ? customMessage : confirmMessage}</p>
          </div>
          {/* Footer */}
          <div className="p-3 pt-2">
            {!showConfirmation ? (
              <Button size="sm" onClick={handleResetClick} className="w-full">
                Reset to Default
              </Button>
            ) : (
              <Button size="sm" onClick={handleResetConfirm} className="w-full">
                Confirm
              </Button>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
