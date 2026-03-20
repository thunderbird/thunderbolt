import { useDebouncedCallback } from '@/hooks/use-debounce'
import { cn } from '@/lib/utils'
import { Search, X } from 'lucide-react'
import { forwardRef, useState, type ChangeEvent } from 'react'
import { Input, type InputProps } from './input'

export type SearchInputProps = InputProps & {
  containerClassName?: string
  debouncedOnChange?: (value: string) => void
  delay?: number
  showIcon?: boolean
}

export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(
  (
    {
      className,
      containerClassName,
      debouncedOnChange,
      delay = 50,
      showIcon = false,
      value,
      onChange,
      defaultValue,
      ...props
    },
    ref,
  ) => {
    const [internalValue, setInternalValue] = useState(defaultValue?.toString() || '')
    const isControlled = value !== undefined
    const displayValue = isControlled ? value : internalValue

    const debouncedCallback = useDebouncedCallback((value: string) => {
      debouncedOnChange?.(value)
    }, delay)

    const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
      const newValue = event.target.value
      if (!isControlled) {
        setInternalValue(newValue)
      }
      onChange?.(event)
      debouncedCallback(newValue)
    }

    const handleClear = () => {
      if (!isControlled) {
        setInternalValue('')
      }
      if (onChange && ref && 'current' in ref && ref.current) {
        // Create a proper synthetic event by setting the input value and triggering change
        ref.current.value = ''
        const event = new Event('change', { bubbles: true }) as unknown as ChangeEvent<HTMLInputElement>
        Object.defineProperty(event, 'target', { value: ref.current, enumerable: true })
        onChange(event)
      }
      debouncedOnChange?.('')
    }

    const hasValue = displayValue && displayValue.toString().length > 0

    return (
      <div className={cn('relative', containerClassName)}>
        {showIcon && <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />}
        <Input
          ref={ref}
          value={displayValue}
          className={cn('text-sm', showIcon ? 'pl-9' : '', hasValue ? 'pr-9' : '', className)}
          onChange={handleChange}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck="false"
          data-1p-ignore
          data-lpignore="true"
          {...props}
        />
        {hasValue && (
          <button
            type="button"
            onClick={handleClear}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/80 hover:text-foreground transition-colors focus:outline-none cursor-pointer"
            aria-label="Clear search"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    )
  },
)
