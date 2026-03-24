import { cn } from '@/lib/utils'
import * as PopoverPrimitive from '@radix-ui/react-popover'
import { CheckIcon, ChevronDownIcon, Loader2 } from 'lucide-react'
import { type ComponentPropsWithoutRef, type ReactNode, useCallback, useState } from 'react'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from './command'

export type ComboboxItem = {
  id: string
  label: string
  description?: string
  icon?: ReactNode
  disabled?: boolean
  filterValue?: string
}

type ComboboxProps = Omit<ComponentPropsWithoutRef<'button'>, 'value'> & {
  items: ComboboxItem[]
  value?: string
  onValueChange: (id: string) => void
  placeholder?: string
  searchPlaceholder?: string

  // Async search mode
  searchValue?: string
  onSearchChange?: (search: string) => void

  // States
  emptyMessage?: string
  loading?: boolean

  // Open state (uncontrolled by default)
  open?: boolean
  onOpenChange?: (open: boolean) => void

  // Display
  displayValue?: string
  contentClassName?: string
  align?: 'start' | 'center' | 'end'
}

export const Combobox = ({
  items,
  value,
  onValueChange,
  placeholder = 'Select...',
  searchPlaceholder = 'Search...',
  searchValue,
  onSearchChange,
  emptyMessage = 'No items found.',
  loading = false,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  displayValue,
  className,
  contentClassName,
  align = 'start',
  disabled = false,
  ...triggerProps
}: ComboboxProps) => {
  const [internalOpen, setInternalOpen] = useState(false)
  const [internalSearch, setInternalSearch] = useState('')

  const isControlled = controlledOpen !== undefined
  const open = isControlled ? controlledOpen : internalOpen
  const isAsync = !!onSearchChange

  const setOpen = useCallback(
    (nextOpen: boolean) => {
      if (!isControlled) {
        setInternalOpen(nextOpen)
      }
      controlledOnOpenChange?.(nextOpen)
    },
    [isControlled, controlledOnOpenChange],
  )

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen)
    if (!nextOpen && !isAsync) {
      setInternalSearch('')
    }
  }

  const selected = items.find((item) => item.id === value)
  const triggerLabel = displayValue ?? selected?.label

  const handleSelect = (id: string) => {
    onValueChange(id)
    handleOpenChange(false)
  }

  const hasListContent = items.length > 0 || (!loading && !!emptyMessage)

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={handleOpenChange}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          {...triggerProps}
          className={cn(
            "border-input data-[placeholder]:text-muted-foreground [&_svg:not([class*='text-'])]:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:bg-input/30 dark:hover:bg-input/50 flex w-full items-center justify-between gap-2 rounded-lg border bg-transparent px-3 py-2 text-[length:var(--font-size-body)] whitespace-nowrap shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 h-[var(--touch-height-default)] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
            !triggerLabel && 'text-muted-foreground',
            className,
          )}
        >
          <span className="truncate">{triggerLabel ?? placeholder}</span>
          <ChevronDownIcon className="size-4 opacity-50" />
        </button>
      </PopoverPrimitive.Trigger>

      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="bottom"
          align={align}
          sideOffset={4}
          className={cn(
            'bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 relative z-50 min-w-[8rem] origin-(--radix-popover-content-transform-origin) overflow-hidden rounded-lg border shadow-md w-[--radix-popover-trigger-width]',
            contentClassName,
          )}
        >
          <Command
            shouldFilter={!isAsync}
            className="overflow-visible rounded-none bg-transparent [&_[data-slot=command-input-wrapper]]:border-b-0"
          >
            <div className={cn('relative', hasListContent && 'border-b')}>
              <CommandInput
                placeholder={searchPlaceholder}
                value={isAsync ? searchValue : internalSearch}
                onValueChange={isAsync ? onSearchChange : setInternalSearch}
              />
              {loading && (
                <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 size-4 animate-spin text-muted-foreground" />
              )}
            </div>
            {hasListContent && (
              <CommandList className="max-h-[min(300px,var(--radix-popover-content-available-height,300px))] overscroll-contain p-1">
                {!loading && emptyMessage && <CommandEmpty>{emptyMessage}</CommandEmpty>}
                {items.map((item) => (
                  <CommandItem
                    key={item.id}
                    value={item.id}
                    keywords={[item.label, item.filterValue, item.description].filter(Boolean) as string[]}
                    disabled={item.disabled}
                    onSelect={() => handleSelect(item.id)}
                    className="items-start pr-9 md:pr-8"
                  >
                    {item.icon && <span className="shrink-0">{item.icon}</span>}
                    <div className="flex flex-col gap-0.5 min-w-0">
                      <span className="truncate">{item.label}</span>
                      {item.description && (
                        <span className="text-[length:var(--font-size-xs)] text-muted-foreground truncate">
                          {item.description}
                        </span>
                      )}
                    </div>
                    <span className="absolute right-2 top-1/2 -translate-y-1/2 flex size-3.5 items-center justify-center">
                      {value === item.id && <CheckIcon className="size-4" />}
                    </span>
                  </CommandItem>
                ))}
              </CommandList>
            )}
          </Command>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}
