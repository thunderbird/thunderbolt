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
import { useLocationSearch, type LocationData } from '@/hooks/use-location-search'
import { useSettings } from '@/hooks/use-settings'
import { useCountryUnits } from '@/hooks/use-country-units'
import { extractCountryFromLocation } from '@/lib/country-utils'
import { OnboardingFooter } from './onboarding-footer'

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

type OnboardingLocationStepProps = {
  onNext: () => void
  onSkip: () => void
  onBack: () => void
}

export default function OnboardingLocationStep({ onNext, onSkip, onBack }: OnboardingLocationStepProps) {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const locationSearch = useLocationSearch()
  const { fetchCountryUnits } = useCountryUnits()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  const { locationName, locationLat, locationLng, distanceUnit, temperatureUnit, dateFormat, timeFormat, currency } =
    useSettings({
      location_name: '',
      location_lat: '',
      location_lng: '',
      distance_unit: 'imperial',
      temperature_unit: 'f',
      date_format: 'MM/DD/YYYY',
      time_format: '12h',
      currency: 'USD',
    })

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
    locationSearch.setOpen(false)
  }

  useEffect(() => {
    if (buttonRef.current) {
      buttonRef.current.click()
    }
    if (searchInputRef.current) {
      searchInputRef.current.focus()
    }
  }, [])

  const onSubmit = async (values: LocationFormData) => {
    setIsSubmitting(true)

    // Save location data
    await Promise.all([
      locationName.setValue(values.locationName),
      locationLat.setValue(String(values.locationLat)),
      locationLng.setValue(String(values.locationLng)),
    ])

    const country = extractCountryFromLocation(values.locationName)
    if (country) {
      const countryUnitsData = await fetchCountryUnits(country)
      if (countryUnitsData) {
        await Promise.all([
          distanceUnit.setValue(countryUnitsData.unit, { recomputeHash: true }),
          temperatureUnit.setValue(countryUnitsData.temperature, { recomputeHash: true }),
          dateFormat.setValue(countryUnitsData.dateFormatExample, { recomputeHash: true }),
          timeFormat.setValue(countryUnitsData.timeFormat, { recomputeHash: true }),
          currency.setValue(countryUnitsData.currency.code, { recomputeHash: true }),
        ])
      }
    }

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
                  open={locationSearch.open}
                  onOpenChange={(newOpen) => {
                    locationSearch.setOpen(newOpen)
                    if (!newOpen) {
                      locationSearch.clearSearch()
                    }
                  }}
                >
                  <PopoverTrigger asChild>
                    <FormControl>
                      <Button
                        ref={buttonRef}
                        variant="outline"
                        role="combobox"
                        aria-expanded={locationSearch.open}
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
