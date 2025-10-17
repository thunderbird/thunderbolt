import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { cn } from '@/lib/utils'
import { ChevronsUpDown } from 'lucide-react'
import { useLocationSearch, type LocationData } from '@/hooks/use-location-search'
import { useSettings } from '@/hooks/use-settings'

const step1FormSchema = z
  .object({
    preferredName: z.string().min(1, { message: 'Name is required.' }),
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

type Step1FormData = z.infer<typeof step1FormSchema>

type OnboardingStep1Props = {
  onCompleteStep1: () => void
}

export default function OnboardingStep1({ onCompleteStep1 }: OnboardingStep1Props) {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const locationSearch = useLocationSearch()

  const { preferredName, locationName, locationLat, locationLng, userHasCompletedOnboarding } = useSettings({
    preferred_name: '',
    location_name: '',
    location_lat: '',
    location_lng: '',
    user_has_completed_onboarding: false,
  })

  const form = useForm<Step1FormData>({
    resolver: zodResolver(step1FormSchema),
    defaultValues: {
      preferredName: '',
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

  const onSubmit = async (values: Step1FormData) => {
    setIsSubmitting(true)
    try {
      await Promise.all([
        preferredName.setValue(values.preferredName),
        locationName.setValue(values.locationName),
        locationLat.setValue(String(values.locationLat)),
        locationLng.setValue(String(values.locationLng)),
        userHasCompletedOnboarding.setValue(true),
      ])
      onCompleteStep1()
    } catch (error) {
      console.error('Error saving onboarding data:', error)
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
        <div className="space-y-4">
          <FormField
            control={form.control}
            name="preferredName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>What should we call you?</FormLabel>
                <FormControl>
                  <Input placeholder="Enter your name" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="locationName"
            render={({ field }) => (
              <FormItem className="flex flex-col">
                <FormLabel>Where are you located?</FormLabel>
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
        </div>

        <div className="pt-4">
          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? 'Saving...' : 'Continue'}
          </Button>
        </div>
      </form>
    </Form>
  )
}
