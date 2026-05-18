/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useCallback, type ComponentProps } from 'react'
import * as SwitchPrimitive from '@radix-ui/react-switch'

import { useHaptics } from '@/hooks/use-haptics'
import { cn } from '@/lib/utils'

// Port of thunderbolt-skill's Switch design: rounded-md track with the
// `--icon-brand` yellow-green for checked state, translucent slate for
// unchecked. Two sizes — `default` (18×33) and `sm` (14×24) — matching the
// skill's pixel values rather than thunderbolt's `--switch-*` responsive vars.
const Switch = ({
  className,
  size = 'default',
  onCheckedChange,
  ...props
}: ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: 'sm' | 'default'
}) => {
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
      data-size={size}
      className={cn(
        'peer group/switch relative inline-flex shrink-0 cursor-pointer items-center rounded-[12px] border border-solid shadow-[0_1px_2px_0_rgba(0,0,0,0.05)] transition-all outline-none after:absolute after:-inset-x-3 after:-inset-y-2',
        'focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:ring-[3px] aria-invalid:ring-destructive/40',
        'data-[size=default]:h-[18px] data-[size=default]:w-[33px] data-[size=sm]:h-[14px] data-[size=sm]:w-[24px]',
        'data-[state=checked]:bg-[rgba(59,130,246,0.17)] data-[state=checked]:border-[#1d4ed8]',
        'dark:data-[state=checked]:bg-[rgba(220,232,117,0.17)] dark:data-[state=checked]:border-[#7d9247]',
        'data-[state=unchecked]:bg-[rgba(37,50,61,0.37)] data-[state=unchecked]:border-[#414a52]',
        'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50',
        className,
      )}
      onCheckedChange={handleCheckedChange}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          'pointer-events-none block rounded-full ring-0 transition-transform',
          'group-data-[size=default]/switch:size-3.5 group-data-[size=sm]/switch:size-2.5',
          'data-[state=checked]:bg-[#3b82f6] dark:data-[state=checked]:bg-[#dce875] data-[state=unchecked]:bg-white',
          'group-data-[size=default]/switch:data-[state=unchecked]:translate-x-[2px] group-data-[size=default]/switch:data-[state=checked]:translate-x-[16px]',
          'group-data-[size=sm]/switch:data-[state=unchecked]:translate-x-[2px] group-data-[size=sm]/switch:data-[state=checked]:translate-x-[10px]',
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
