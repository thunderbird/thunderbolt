/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createContext, useContext, useRef, useState, type ChangeEvent, type ReactNode, type RefObject } from 'react'
import { Search } from 'lucide-react'
import { Button } from './button'
import { SearchInput, type SearchInputProps } from './search-input'
import { cn } from '@/lib/utils'

type PageSearchContextValue = {
  open: boolean
  toggle: () => void
  inputRef: RefObject<HTMLInputElement | null>
  searchValue: string
  setSearchValue: (value: string) => void
}

const PageSearchContext = createContext<PageSearchContextValue | null>(null)

const usePageSearchContext = () => {
  const ctx = useContext(PageSearchContext)
  if (!ctx) {
    throw new Error('PageSearch sub-components must be used within <PageSearch>')
  }
  return ctx
}

type PageSearchProps = {
  onSearch: (value: string) => void
  children: ReactNode
}

/**
 * Compound component for page-level search.
 * Provides a togglable search button and collapsible search input.
 *
 * Usage:
 *   <PageSearch onSearch={handleSearch}>
 *     <PageSearch.Button />
 *     <PageSearch.Input placeholder="Search..." />
 *   </PageSearch>
 */
export const PageSearch = ({ onSearch, children }: PageSearchProps) => {
  const [open, setOpen] = useState(false)
  const [searchValue, setSearchValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next) {
      requestAnimationFrame(() => inputRef.current?.focus())
    } else {
      setSearchValue('')
      onSearch('')
    }
  }

  return (
    <PageSearchContext value={{ open, toggle, inputRef, searchValue, setSearchValue }}>{children}</PageSearchContext>
  )
}

const PageSearchButton = () => {
  const { open, toggle } = usePageSearchContext()

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Search"
      className={cn('rounded-lg hover:bg-accent', open && 'bg-accent')}
      onClick={toggle}
    >
      <Search className="h-4 w-4" />
    </Button>
  )
}

type PageSearchInputProps = Omit<SearchInputProps, 'onChange' | 'value' | 'debouncedOnChange'> & {
  delay?: number
  onSearch: (value: string) => void
  wrapperClassName?: string
}

const PageSearchInput = ({
  delay,
  onSearch,
  placeholder,
  wrapperClassName,
  ...searchInputProps
}: PageSearchInputProps) => {
  const { open, inputRef, searchValue, setSearchValue } = usePageSearchContext()

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    setSearchValue(event.target.value)
  }

  return (
    <div
      className={cn(
        'transition-all duration-300 ease-in-out flex-shrink-0',
        open ? 'max-h-14 opacity-100' : 'max-h-0 opacity-0 overflow-hidden',
        wrapperClassName,
      )}
    >
      <SearchInput
        ref={inputRef}
        inputSize="lg"
        showIcon
        className="rounded-full"
        placeholder={placeholder}
        value={searchValue}
        onChange={handleChange}
        debouncedOnChange={onSearch}
        delay={delay}
        {...searchInputProps}
      />
    </div>
  )
}

PageSearch.Button = PageSearchButton
PageSearch.Input = PageSearchInput
