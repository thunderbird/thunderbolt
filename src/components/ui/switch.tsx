/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useCallback, type ComponentProps } from 'react'
import * as SwitchPrimitive from '@radix-ui/react-switch'

import { useHaptics } from '@/hooks/use-haptics'
import { cn } from '@/lib/utils'

/**
 * A pill toggle. Geometry is state-independent: the track has a 1px border + 2px
 * inner padding, and the thumb is sized (via CSS vars) to exactly fill what's
 * left — so the dot's size and its 2px gap to the border are identical for OFF,
 * ON, and DISABLED. Only COLOR changes between states:
 *  - OFF      → `bg-input` track (`bg-secondary` in dark mode) with a
 *               `border-border` outline.
 *  - ON       → a muted amber→raspberry gradient with a light thumb, reading
 *               unambiguously as "on" without competing with nearby content.
 *  - DISABLED → dimmed, keeps the outline.
 */
const Switch = ({ className, onCheckedChange, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) => {
  const { triggerSelection } = useHaptics()

  const handleCheckedChange = useCallback(
    (checked: boolean) => {
      triggerSelection()
      onCheckedChange?.(checked)
    },
    [onCheckedChange, triggerSelection],
  )

  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      onCheckedChange={handleCheckedChange}
      className={cn(
        'peer inline-flex h-[var(--switch-track-height)] w-[var(--switch-track-width)] shrink-0 cursor-pointer items-center rounded-full border p-[2px] shadow-xs transition-colors outline-none',
        // OFF (default): filled track + visible outline. Dark uses secondary —
        // --color-input is a faint translucent field fill there, too weak for
        // a control that must read as a solid track.
        'border-border bg-input dark:bg-secondary',
        // ON — a lower-saturation version of the brand gradient in both modes.
        'data-[state=checked]:border-transparent data-[state=checked]:bg-brand-muted data-[state=checked]:bg-origin-border',
        'data-[state=checked]:[background-image:var(--gradient-brand-muted)]',
        // Focus + disabled (disabled keeps its outline).
        'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
        'disabled:cursor-not-allowed disabled:border-border disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          'pointer-events-none block size-[var(--switch-thumb-size)] rounded-full bg-background shadow-sm ring-0 transition-transform',
          'data-[state=unchecked]:translate-x-0 data-[state=checked]:translate-x-[var(--switch-thumb-translate)]',
          'data-[state=checked]:bg-white',
          'dark:data-[state=unchecked]:bg-foreground',
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
