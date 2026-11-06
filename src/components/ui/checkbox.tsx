/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as CheckboxPrimitive from '@radix-ui/react-checkbox'
import { Check } from 'lucide-react'
import { forwardRef, useCallback, type ElementRef, type ComponentPropsWithoutRef } from 'react'

import { useHaptics } from '@/hooks/use-haptics'
import { cn } from '@/lib/utils'

const Checkbox = forwardRef<
  ElementRef<typeof CheckboxPrimitive.Root>,
  ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, onCheckedChange, ...props }, ref) => {
  const { triggerSelection } = useHaptics()

  const handleCheckedChange = useCallback(
    (checked: boolean | 'indeterminate') => {
      triggerSelection()
      onCheckedChange?.(checked)
    },
    [onCheckedChange, triggerSelection],
  )

  return (
    <CheckboxPrimitive.Root
      ref={ref}
      className={cn(
        // border-border-strong (not border-primary): the near-black primary
        // outline read as stray ink against the theme's warm hairlines. The
        // checked fill mirrors the Switch ON track — the app's other boolean
        // control — instead of a solid near-black primary block.
        // bg-origin-border spans the gradient across the transparent border so
        // no fallback ring shows at the edges (same trick as the Switch).
        'peer size-[var(--icon-size-default)] shrink-0 rounded-md border border-border-strong ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer',
        'data-[state=checked]:border-transparent data-[state=checked]:bg-brand data-[state=checked]:bg-origin-border data-[state=checked]:[background-image:var(--gradient-brand)] data-[state=checked]:text-brand-foreground',
        className,
      )}
      onCheckedChange={handleCheckedChange}
      {...props}
    >
      <CheckboxPrimitive.Indicator className={cn('flex items-center justify-center text-current')}>
        <Check className="h-3 w-3" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
})
Checkbox.displayName = CheckboxPrimitive.Root.displayName

export { Checkbox }
