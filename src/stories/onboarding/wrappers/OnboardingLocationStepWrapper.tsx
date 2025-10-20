import { useState, useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { cn } from '@/lib/utils'
import { ChevronsUpDown, MapPin } from 'lucide-react'
import { OnboardingFooter } from '@/components/onboarding/onboarding-footer'

const locationFormSchema = z
  .object({
    locationName: z.string().min(1, { message: 'Location is required.' }),
    locationLat: z.number().optional(),
    locationLng: z.number().optional(),
  })
  .refine(
    (data) => {
      if (data.locationName && data.locationName.length > 0) {
        return data.locationLat !== undefined && data.locationLng !== undefined
      }
      return true
    },
    {
      message: 'Please select a location from the dropdown to get coordinates.',
      path: ['locationName'],
    },
  )

type LocationFormData = z.infer<typeof locationFormSchema>

type LocationData = {
  name: string
  coordinates: {
    lat: number
    lng: number
  }
}

type OnboardingLocationStepWrapperProps = {
  onNext: () => void
  onSkip: () => void
  onBack: () => void
}

export const OnboardingLocationStepWrapper = ({ onNext, onSkip, onBack }: OnboardingLocationStepWrapperProps) => {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [open, setOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [isSearching, setIsSearching] = useState(false)
  const [locations, setLocations] = useState<LocationData[]>([])
  const buttonRef = useRef<HTMLButtonElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  const form = useForm<LocationFormData>({
    resolver: zodResolver(locationFormSchema),
    defaultValues: {
      locationName: '',
      locationLat: undefined,
      locationLng: undefined,
    },
  })

  const handleSelectLocation = (location: LocationData) => {
    form.setValue('locationName', location.name)
    form.setValue('locationLat', location.coordinates.lat)
    form.setValue('locationLng', location.coordinates.lng)
    setOpen(false)
  }

  const clearSearch = () => {
    setSearchQuery('')
    setLocations([])
    setIsSearching(false)
  }

  // Mock search functionality
  const mockSearch = (query: string) => {
    if (query.trim().length === 0) {
      setLocations([])
      return
    }

    setIsSearching(true)

    // Simulate API delay
    setTimeout(() => {
      const mockLocations: LocationData[] = [
        { name: 'New York, NY, USA', coordinates: { lat: 40.7128, lng: -74.006 } },
        { name: 'Los Angeles, CA, USA', coordinates: { lat: 34.0522, lng: -118.2437 } },
        { name: 'Chicago, IL, USA', coordinates: { lat: 41.8781, lng: -87.6298 } },
        { name: 'Houston, TX, USA', coordinates: { lat: 29.7604, lng: -95.3698 } },
        { name: 'Phoenix, AZ, USA', coordinates: { lat: 33.4484, lng: -112.074 } },
      ].filter((location) => location.name.toLowerCase().includes(query.toLowerCase()))

      setLocations(mockLocations)
      setIsSearching(false)
    }, 500)
  }

  // Update locations when search query changes
  useEffect(() => {
    mockSearch(searchQuery)
  }, [searchQuery])

  useEffect(() => {
    if (buttonRef.current) {
      buttonRef.current.click()
    }
    if (searchInputRef.current) {
      searchInputRef.current.focus()
    }
  }, [])

  const onSubmit = async () => {
    setIsSubmitting(true)
    // Simulate saving
    await new Promise((resolve) => setTimeout(resolve, 1000))
    setIsSubmitting(false)
    onNext()
  }

  return (
    <div className="h-full flex flex-col justify-center overflow-x-hidden px-2">
      <div className="text-center space-y-4">
        <div className="mx-auto w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center">
          <MapPin className="w-8 h-8 text-primary" />
        </div>
        <h2 className="text-2xl font-bold">Where are you located?</h2>
        <p className="text-muted-foreground">
          This helps us personalize your experience with local settings and features.
        </p>
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6 pt-3">
          <FormField
            control={form.control}
            name="locationName"
            render={({ field }) => (
              <FormItem className="flex flex-col">
                <FormLabel>Location</FormLabel>
                <Popover
                  open={open}
                  onOpenChange={(newOpen) => {
                    setOpen(newOpen)
                    if (!newOpen) {
                      clearSearch()
                    }
                  }}
                >
                  <PopoverTrigger asChild>
                    <FormControl>
                      <Button
                        ref={buttonRef}
                        variant="outline"
                        role="combobox"
                        aria-expanded={open}
                        className={cn('w-full justify-between', !field.value && 'text-muted-foreground')}
                      >
                        {field.value || 'Select location...'}
                        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                      </Button>
                    </FormControl>
                  </PopoverTrigger>
                  <PopoverContent
                    className="p-0 w-[--radix-popover-trigger-width]"
                    side="bottom"
                    align="start"
                    sideOffset={4}
                  >
                    <Command>
                      <CommandInput
                        ref={searchInputRef}
                        placeholder="Search for locations..."
                        value={searchQuery}
                        onValueChange={setSearchQuery}
                      />
                      <CommandList>
                        {searchQuery.trim().length > 0 && isSearching && (
                          <div className="py-6 text-center text-sm">
                            <div className="inline-flex items-center gap-2">
                              <div className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600" />
                              Searching...
                            </div>
                          </div>
                        )}
                        {searchQuery.trim().length > 0 && !isSearching && locations.length === 0 && (
                          <CommandEmpty>No locations found.</CommandEmpty>
                        )}
                        {!isSearching && locations.length > 0 && (
                          <CommandGroup>
                            {locations.map((location) => (
                              <CommandItem
                                key={`${location.coordinates.lat}-${location.coordinates.lng}`}
                                value={location.name}
                                onSelect={() => handleSelectLocation(location)}
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
                <FormMessage />
              </FormItem>
            )}
          />

          <OnboardingFooter
            onBack={onBack}
            onSkip={onSkip}
            onContinue={form.handleSubmit(onSubmit)}
            continueText={isSubmitting ? 'Setting up...' : 'Complete Setup'}
            continueDisabled={isSubmitting}
          />
        </form>
      </Form>
    </div>
  )
}
