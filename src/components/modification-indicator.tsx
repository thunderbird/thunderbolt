import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useState } from 'react'

interface ModificationIndicatorProps {
  /**
   * Whether the item has been modified from its default
   */
  hasModifications: boolean
  /**
   * Callback when user confirms reset
   */
  onReset: () => void
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
}

/**
 * Reusable component that shows a persistent dot indicator
 * - Light grey when unmodified (default state)
 * - Blue when modified with reset popover
 * Used across automations, settings, and other default-based content
 */
export const ModificationIndicator = ({
  hasModifications,
  onReset,
  customMessage = "You've customized this setting.",
  confirmMessage = 'Are you sure? You will lose any changes that you made.',
  ariaLabel = 'Modified item',
}: ModificationIndicatorProps) => {
  const [isPopoverOpen, setIsPopoverOpen] = useState(false)
  const [showConfirmation, setShowConfirmation] = useState(false)

  const handleResetClick = () => {
    setShowConfirmation(true)
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

  if (!hasModifications) {
    // Show grey dot for unmodified state (non-interactive, same color as secondary button)
    // Fixed width container ensures consistent spacing
    return (
      <span className="inline-flex items-center justify-center w-[18px]" aria-label="Default setting">
        <div className="w-2 h-2 rounded-full bg-secondary" />
      </span>
    )
  }

  return (
    <Popover open={isPopoverOpen} onOpenChange={handlePopoverChange}>
      <PopoverTrigger asChild>
        <span className="inline-flex items-center justify-center w-[18px]">
          <button
            className="w-2 h-2 rounded-full bg-blue-500 hover:bg-blue-600 transition-colors cursor-pointer"
            aria-label={ariaLabel}
          />
        </span>
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
              <Button size="sm" variant="outline" onClick={handleResetClick} className="w-full">
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
