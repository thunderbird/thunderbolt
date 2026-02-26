import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/utils'
import { ChevronDown, Search } from 'lucide-react'
import { memo, useMemo, useState } from 'react'
import { flushSync } from 'react-dom'
import type { SearchableMenuGroup, SearchableMenuItem, SearchableMenuProps } from './types'
import { findItemById, flattenItems, isGroupedItems } from './types'

type ItemButtonProps<T> = {
  item: SearchableMenuItem<T>
  isSelected: boolean
  onClick: () => void
  renderItem?: (item: SearchableMenuItem<T>, isSelected: boolean) => React.ReactNode
}

const ItemButton = memo(<T,>({ item, isSelected, onClick, renderItem }: ItemButtonProps<T>) => {
  if (renderItem) {
    return (
      <button type="button" disabled={item.disabled} onClick={onClick} className="w-full text-left">
        {renderItem(item, isSelected)}
      </button>
    )
  }

  return (
    <button
      type="button"
      disabled={item.disabled}
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors text-left cursor-pointer',
        'hover:bg-accent/50 focus:bg-accent/50 focus:outline-none',
        isSelected && 'bg-accent',
        item.disabled && 'opacity-50 cursor-not-allowed',
      )}
    >
      {item.icon && <span className="flex-shrink-0">{item.icon}</span>}
      <div className="flex flex-col gap-0.5 min-w-0 flex-1">
        <span className="font-medium truncate">{item.label}</span>
        {item.description && <span className="text-sm text-muted-foreground truncate">{item.description}</span>}
      </div>
    </button>
  )
}) as <T>(props: ItemButtonProps<T>) => React.ReactNode
;(ItemButton as { displayName?: string }).displayName = 'ItemButton'

type GroupSectionProps<T> = {
  group: SearchableMenuGroup<T>
  value?: string
  onSelect: (id: string, item: SearchableMenuItem<T>) => void
  renderItem?: (item: SearchableMenuItem<T>, isSelected: boolean) => React.ReactNode
}

const GroupSection = memo(<T,>({ group, value, onSelect, renderItem }: GroupSectionProps<T>) => {
  if (group.items.length === 0) return null

  return (
    <div className="flex flex-col gap-1">
      {group.label && <h3 className="text-xs font-medium text-muted-foreground px-3 pt-2">{group.label}</h3>}
      <div className="flex flex-col">
        {group.items.map((item) => (
          <ItemButton
            key={item.id}
            item={item}
            isSelected={value === item.id}
            onClick={() => onSelect(item.id, item)}
            renderItem={renderItem}
          />
        ))}
      </div>
    </div>
  )
}) as <T>(props: GroupSectionProps<T>) => React.ReactNode
;(GroupSection as { displayName?: string }).displayName = 'GroupSection'

const DefaultTrigger = <T,>({
  selected,
  isOpen,
  placeholder = 'Select...',
}: {
  selected: SearchableMenuItem<T> | undefined
  isOpen: boolean
  placeholder?: string
}) => (
  <div
    className={cn(
      'flex items-center gap-2 px-3 py-1.5 rounded-full cursor-pointer transition-colors text-sm border',
      isOpen ? 'bg-secondary' : 'hover:bg-secondary/50',
    )}
  >
    {selected?.icon}
    <span className="font-medium">{selected?.label ?? placeholder}</span>
    <ChevronDown className={cn('size-3.5 text-muted-foreground transition-transform', isOpen && 'rotate-180')} />
  </div>
)

export const SearchableMenu = <T,>({
  items,
  value,
  onValueChange,
  searchable = true,
  searchPlaceholder = 'Search...',
  emptyMessage = 'No items found',
  blurBackdrop = false,
  trigger,
  renderItem,
  footer,
  width = 320,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  contentClassName,
  align = 'start',
  side,
  maxHeight = 300,
}: SearchableMenuProps<T>) => {
  const [internalOpen, setInternalOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const { isMobile } = useIsMobile()

  const isControlled = controlledOpen !== undefined
  const open = isControlled ? controlledOpen : internalOpen
  const setOpen = (newOpen: boolean) => {
    if (!isControlled) setInternalOpen(newOpen)
    controlledOnOpenChange?.(newOpen)
    if (!newOpen) setSearchQuery('')
  }

  const selected = value ? findItemById(items, value) : undefined

  const filteredItems = useMemo(() => {
    if (!searchQuery.trim()) return items

    const query = searchQuery.toLowerCase()

    const matchesQuery = (item: SearchableMenuItem<T>) =>
      item.label.toLowerCase().includes(query) ||
      item.description?.toLowerCase().includes(query) ||
      item.searchTerms?.toLowerCase().includes(query)

    if (isGroupedItems(items)) {
      return items
        .map((group) => ({
          ...group,
          items: group.items.filter(matchesQuery),
        }))
        .filter((group) => group.items.length > 0)
    }

    return items.filter(matchesQuery)
  }, [items, searchQuery])

  const handleSelect = (id: string, item: SearchableMenuItem<T>) => {
    flushSync(() => {
      setOpen(false)
    })
    onValueChange(id, item)
  }

  const flatFiltered = flattenItems(filteredItems)
  const showBlur = blurBackdrop && isMobile && open

  const triggerContent =
    typeof trigger === 'function' ? (
      trigger(selected, open)
    ) : trigger ? (
      trigger
    ) : (
      <DefaultTrigger selected={selected} isOpen={open} />
    )

  const contentWidth = isMobile ? 'calc(100vw - 2rem)' : typeof width === 'number' ? `${width}px` : width

  return (
    <Popover open={open} onOpenChange={setOpen} modal={isMobile}>
      <PopoverTrigger asChild>
        <button type="button" className={cn('flex items-center focus:outline-none', showBlur && 'relative z-50')}>
          {triggerContent}
        </button>
      </PopoverTrigger>

      {showBlur && (
        <div
          className="fixed inset-0 z-40 backdrop-blur-sm bg-white/30 dark:bg-black/30"
          onClick={() => setOpen(false)}
        />
      )}

      <PopoverContent
        align={isMobile ? 'center' : align}
        side={side}
        collisionPadding={16}
        className={cn('p-0 rounded-lg overflow-hidden duration-100', showBlur && 'z-50', contentClassName)}
        style={{ width: contentWidth }}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex flex-col gap-2 bg-background">
          {searchable && (
            <div className="px-4 pt-4">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                <Input
                  placeholder={searchPlaceholder}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9"
                  autoFocus={false}
                />
              </div>
            </div>
          )}

          <div
            className="overflow-y-auto"
            style={{ maxHeight: typeof maxHeight === 'number' ? `${maxHeight}px` : maxHeight }}
          >
            <div className={cn('flex flex-col gap-4 px-2 pb-2', !searchable && 'pt-2')}>
              {isGroupedItems(filteredItems) ? (
                filteredItems.map((group) => (
                  <GroupSection
                    key={group.id}
                    group={group}
                    value={value}
                    onSelect={handleSelect}
                    renderItem={renderItem}
                  />
                ))
              ) : (
                <div className="flex flex-col">
                  {(filteredItems as SearchableMenuItem<T>[]).map((item) => (
                    <ItemButton
                      key={item.id}
                      item={item}
                      isSelected={value === item.id}
                      onClick={() => handleSelect(item.id, item)}
                      renderItem={renderItem}
                    />
                  ))}
                </div>
              )}

              {flatFiltered.length === 0 && (
                <div className="px-3 py-6 text-center text-sm text-muted-foreground">{emptyMessage}</div>
              )}
            </div>
          </div>

          {footer && <div className="border-t px-4 py-4">{footer}</div>}
        </div>
      </PopoverContent>
    </Popover>
  )
}
