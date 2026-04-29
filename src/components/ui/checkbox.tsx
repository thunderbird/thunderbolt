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
        'peer size-[var(--icon-size-default)] shrink-0 rounded-[4px] border border-primary ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground cursor-pointer',
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
