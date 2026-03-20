import { cn } from '@/lib/utils'
import * as PopoverPrimitive from '@radix-ui/react-popover'
import { CheckIcon, ChevronDownIcon, SearchIcon } from 'lucide-react'
import { type ReactNode, useMemo, useRef, useState } from 'react'

export type ComboboxItem = {
  id: string
  label: string
  description?: string
  icon?: ReactNode
  disabled?: boolean
}

type ComboboxProps = {
  items: ComboboxItem[]
  value?: string
  onValueChange: (id: string) => void
  placeholder?: string
  searchPlaceholder?: string
  emptyMessage?: string
  className?: string
  loading?: boolean
  loadingMessage?: string
}

export const Combobox = ({
  items,
  value,
  onValueChange,
  placeholder = 'Select...',
  searchPlaceholder = 'Search...',
  emptyMessage = 'No items found.',
  className,
  loading = false,
  loadingMessage = 'Loading...',
}: ComboboxProps) => {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const selected = items.find((item) => item.id === value)

  const filtered = useMemo(() => {
    if (!search.trim()) {
      return items
    }
    const q = search.toLowerCase()
    return items.filter(
      (item) =>
        item.label.toLowerCase().includes(q) ||
        item.description?.toLowerCase().includes(q) ||
        item.id.toLowerCase().includes(q),
    )
  }, [items, search])

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen)
    if (nextOpen) {
      requestAnimationFrame(() => inputRef.current?.focus())
    } else {
      setSearch('')
    }
  }

  const handleSelect = (id: string) => {
    onValueChange(id)
    setOpen(false)
  }

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={handleOpenChange}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          className={cn(
            "border-input data-[placeholder]:text-muted-foreground [&_svg:not([class*='text-'])]:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:bg-input/30 dark:hover:bg-input/50 flex w-full items-center justify-between gap-2 rounded-lg border bg-transparent px-3 py-2 text-[length:var(--font-size-body)] whitespace-nowrap shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 h-[var(--touch-height-default)] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
            !value && 'text-muted-foreground',
            className,
          )}
        >
          <span className="truncate">{selected?.label ?? placeholder}</span>
          <ChevronDownIcon className="size-4 opacity-50" />
        </button>
      </PopoverPrimitive.Trigger>

      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="bottom"
          align="start"
          sideOffset={4}
          className="bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 relative z-50 min-w-[8rem] origin-(--radix-popover-content-transform-origin) overflow-hidden rounded-lg border shadow-md"
          style={{ width: 'var(--radix-popover-trigger-width)' }}
        >
          {/* Search input */}
          <div className="flex items-center gap-2 border-b px-2">
            <SearchIcon className="size-4 text-muted-foreground shrink-0" />
            <input
              ref={inputRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={searchPlaceholder}
              className="flex h-[var(--touch-height-default)] w-full bg-transparent text-[length:var(--font-size-body)] placeholder:text-muted-foreground outline-none"
            />
          </div>

          {/* Items list */}
          <div className="max-h-[min(300px,var(--radix-popover-content-available-height,300px))] overflow-y-auto overscroll-contain p-1">
            {loading && (
              <div className="py-6 text-center text-[length:var(--font-size-body)] text-muted-foreground">
                {loadingMessage}
              </div>
            )}
            {!loading && filtered.length === 0 && (
              <div className="py-6 text-center text-[length:var(--font-size-body)] text-muted-foreground">
                {emptyMessage}
              </div>
            )}
            {!loading &&
              filtered.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  disabled={item.disabled}
                  onClick={() => handleSelect(item.id)}
                  className={cn(
                    "focus:bg-accent focus:text-accent-foreground [&_svg:not([class*='text-'])]:text-muted-foreground relative flex w-full cursor-default items-start gap-2 rounded-md py-1.5 pr-9 md:pr-8 pl-2 text-left text-[length:var(--font-size-body)] outline-hidden select-none hover:bg-accent hover:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
                  )}
                >
                  {item.icon && <span className="shrink-0">{item.icon}</span>}
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="truncate">{item.label}</span>
                    {item.description && (
                      <span className="text-xs text-muted-foreground truncate">{item.description}</span>
                    )}
                  </div>
                  <span className="absolute right-2 flex size-3.5 items-center justify-center">
                    {value === item.id && <CheckIcon className="size-4" />}
                  </span>
                </button>
              ))}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}
