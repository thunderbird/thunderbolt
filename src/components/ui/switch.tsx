import { useCallback, type ComponentProps } from 'react'
import * as SwitchPrimitive from '@radix-ui/react-switch'

import { useHaptics } from '@/hooks/use-haptics'
import { cn } from '@/lib/utils'

const switchClassName =
  'cursor-pointer peer data-[state=checked]:bg-primary data-[state=unchecked]:bg-input focus-visible:border-ring focus-visible:ring-ring/50 dark:data-[state=unchecked]:bg-input/80 inline-flex h-[1.15rem] w-8 shrink-0 items-center rounded-full border border-transparent shadow-xs transition-all outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50'

const thumbClassName =
  'bg-background dark:data-[state=unchecked]:bg-foreground dark:data-[state=checked]:bg-primary-foreground pointer-events-none block size-4 rounded-full ring-0 transition-transform data-[state=checked]:translate-x-[calc(100%-2px)] data-[state=unchecked]:translate-x-0'

const SwitchWithHaptics = ({ className, onCheckedChange, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) => {
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
      className={cn(switchClassName, className)}
      {...props}
      onCheckedChange={handleCheckedChange}
    >
      <SwitchPrimitive.Thumb data-slot="switch-thumb" className={cn(thumbClassName)} />
    </SwitchPrimitive.Root>
  )
}

const Switch = ({
  className,
  enableHaptics = false,
  onCheckedChange,
  ...props
}: ComponentProps<typeof SwitchPrimitive.Root> & { enableHaptics?: boolean }) => {
  if (enableHaptics) {
    return <SwitchWithHaptics className={className} onCheckedChange={onCheckedChange} {...props} />
  }

  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(switchClassName, className)}
      {...props}
      onCheckedChange={onCheckedChange}
    >
      <SwitchPrimitive.Thumb data-slot="switch-thumb" className={cn(thumbClassName)} />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
