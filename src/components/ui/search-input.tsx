import { Search } from 'lucide-react'
import { Input, InputProps } from './input'
import { cn } from '@/lib/utils'
import { useDebouncedCallback } from '@/hooks/use-debounce'
import { ChangeEvent } from 'react'

type SearchInputProps = InputProps & {
  containerClassName?: string
  debouncedOnChange?: (value: string) => void
  delay?: number
}

export function SearchInput({
  className,
  containerClassName,
  debouncedOnChange,
  delay = 50,
  ...props
}: SearchInputProps) {
  const debouncedCallback = useDebouncedCallback((event: ChangeEvent<HTMLInputElement>) => {
    debouncedOnChange?.(event.target.value)
  }, delay)

  return (
    <div className={cn('relative', containerClassName)}>
      <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input className={cn('pl-9', className)} onChange={debouncedCallback} {...props} />
    </div>
  )
}
