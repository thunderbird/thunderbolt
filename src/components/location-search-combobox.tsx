import { type ComponentProps } from 'react'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useLocationSearch, type LocationData } from '@/hooks/use-location-search'
import { cn } from '@/lib/utils'
import { ChevronsUpDown } from 'lucide-react'

type LocationSearchComboboxProps = Omit<ComponentProps<typeof Button>, 'onSelect'> & {
  value?: string | null
  onSelect: (location: LocationData) => void | Promise<void>
  placeholder?: string
  autoOpen?: boolean
}

export const LocationSearchCombobox = ({
  value,
  onSelect,
  placeholder = 'Select location...',
  autoOpen = false,
  className,
  ...triggerProps
}: LocationSearchComboboxProps) => {
  const locationSearch = useLocationSearch({ autoOpen })

  const handleSelect = (location: LocationData) => {
    onSelect(location)
    locationSearch.setOpen(false)
  }

  return (
    <Popover
      open={locationSearch.open}
      onOpenChange={(newOpen) => {
        locationSearch.setOpen(newOpen)
        if (!newOpen) {
          locationSearch.clearSearch()
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={locationSearch.open}
          className={cn('w-full justify-between rounded-lg', !value && 'text-muted-foreground', className)}
          {...triggerProps}
        >
          {value || placeholder}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="rounded-lg p-0 w-[--radix-popover-trigger-width]"
        side="bottom"
        align="start"
        sideOffset={4}
      >
        <Command>
          <CommandInput
            placeholder="Search for locations..."
            value={locationSearch.searchQuery}
            onValueChange={locationSearch.setSearchQuery}
          />
          <CommandList>
            {locationSearch.searchQuery.trim().length > 0 && locationSearch.isSearching && (
              <div className="py-6 text-center text-sm">
                <div className="inline-flex items-center gap-2">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600" />
                  Searching...
                </div>
              </div>
            )}
            {locationSearch.searchQuery.trim().length > 0 &&
              !locationSearch.isSearching &&
              locationSearch.locations.length === 0 && <CommandEmpty>No locations found.</CommandEmpty>}
            {!locationSearch.isSearching && locationSearch.locations.length > 0 && (
              <CommandGroup>
                {locationSearch.locations.map((location) => (
                  <CommandItem
                    key={`${location.coordinates.lat}-${location.coordinates.lng}`}
                    value={location.name}
                    onSelect={() => handleSelect(location)}
                    className="pl-2"
                  >
                    {location.name}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
