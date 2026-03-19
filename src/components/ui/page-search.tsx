import { useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { Button } from './button'
import { SearchInput, type SearchInputProps } from './search-input'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip'
import { cn } from '@/lib/utils'

type PageSearchProps = Omit<SearchInputProps, 'onChange' | 'value'> & {
  onSearch: (value: string) => void
  delay?: number
  tooltip?: string
}

/**
 * A search toggle button + collapsible search input for page-level search.
 * Renders a ghost search icon button (to place in a PageHeader) and a
 * slide-down SearchInput that appears when toggled.
 */
export const usePageSearch = ({
  onSearch,
  delay,
  tooltip = 'Search',
  placeholder,
  ...searchInputProps
}: PageSearchProps) => {
  const [open, setOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next) {
      requestAnimationFrame(() => inputRef.current?.focus())
    } else {
      onSearch('')
    }
  }

  const searchButton = (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" className="rounded-lg" onClick={toggle}>
            <Search className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <p>{tooltip}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )

  const searchInput = (
    <div
      className={cn(
        'transition-all duration-300 ease-in-out flex-shrink-0 pr-2',
        open ? 'max-h-14 opacity-100' : 'max-h-0 opacity-0 overflow-hidden',
      )}
    >
      <SearchInput
        ref={inputRef}
        inputSize="lg"
        showIcon
        className="rounded-full"
        placeholder={placeholder}
        debouncedOnChange={onSearch}
        delay={delay}
        {...searchInputProps}
      />
    </div>
  )

  return { searchButton, searchInput }
}
