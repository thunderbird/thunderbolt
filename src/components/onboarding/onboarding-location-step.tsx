import { useEffect, useRef, useState } from 'react'
import { Form, FormControl, FormField, FormItem, FormMessage } from '@/components/ui/form'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { cn } from '@/lib/utils'
import { ChevronsUpDown, MapPin } from 'lucide-react'
import { useLocationSearch, type LocationData } from '@/hooks/use-location-search'
import type { OnboardingState } from '@/hooks/use-onboarding-state'
import { Button } from '@/components/ui/button'
import { IconCircle } from './icon-circle'

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
  state: OnboardingState
  actions: {
    setLocationValue: (value: string) => void
    setLocationValid: (valid: boolean) => void
    setSubmittingLocation: (submitting: boolean) => void
    submitLocation: (locationData: { locationName: string; locationLat: number; locationLng: number }) => Promise<void>
    nextStep: () => Promise<void>
    prevStep: () => Promise<void>
    skipStep: () => Promise<void>
  }
  onFormDirtyChange?: (isDirty: boolean) => void
}

export const OnboardingLocationStep = ({ actions, onFormDirtyChange }: OnboardingLocationStepProps) => {
  const locationSearch = useLocationSearch()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [isInitialized, setIsInitialized] = useState(false)

  const form = useForm<LocationFormData>({
    resolver: zodResolver(locationFormSchema),
    defaultValues: {
      locationName: '',
      locationLat: undefined,
      locationLng: undefined,
    },
  })

  const isFormDirty = form.formState.isDirty && isInitialized

  const handleSelectLocation = async (location: LocationData) => {
    form.setValue('locationName', location.name, { shouldDirty: true })
    form.setValue('locationLat', location.coordinates.lat, { shouldDirty: true })
    form.setValue('locationLng', location.coordinates.lng, { shouldDirty: true })
    form.trigger()
    locationSearch.setOpen(false)

    try {
      await actions.submitLocation({
        locationName: location.name,
        locationLat: location.coordinates.lat,
        locationLng: location.coordinates.lng,
      })
    } catch (error) {
      console.error('Failed to save location:', error)
    }
  }

  useEffect(() => {
    if (buttonRef.current) {
      buttonRef.current.click()
    }
    if (searchInputRef.current) {
      searchInputRef.current.focus()
    }
  }, [])

  useEffect(() => {
    if (!isInitialized) return

    const subscription = form.watch((value) => {
      const hasValidLocation = !!(
        value.locationName &&
        value.locationName.trim().length > 0 &&
        value.locationLat &&
        value.locationLng
      )
      actions.setLocationValue(value.locationName || '')
      actions.setLocationValid(hasValidLocation)
    })
    return () => subscription.unsubscribe()
  }, [form, actions, isInitialized])

  useEffect(() => {
    onFormDirtyChange?.(isFormDirty)
  }, [isFormDirty, onFormDirtyChange])

  useEffect(() => {
    form.reset(form.getValues())

    const currentValues = form.getValues()
    const hasValidLocation = !!(
      currentValues.locationName &&
      currentValues.locationName.trim().length > 0 &&
      currentValues.locationLat &&
      currentValues.locationLng
    )
    actions.setLocationValue(currentValues.locationName || '')
    actions.setLocationValid(hasValidLocation)

    setIsInitialized(true)
    onFormDirtyChange?.(false)
  }, [])

  const onSubmit = async (values: LocationFormData) => {
    try {
      await actions.submitLocation({
        locationName: values.locationName,
        locationLat: values.locationLat!,
        locationLng: values.locationLng!,
      })
      actions.nextStep()
    } catch (error) {
      console.error('Failed to submit location:', error)
    }
  }

  return (
    <div className="w-full h-full flex flex-col justify-center">
      <div className="text-center space-y-4">
        <IconCircle>
          <MapPin className="w-8 h-8 text-primary" />
        </IconCircle>
        <h2 className="text-2xl font-bold">Where are you located?</h2>
        <p className="text-muted-foreground">
          This helps us personalize your experience with local settings and features.
        </p>
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6 pt-5">
          <FormField
            control={form.control}
            name="locationName"
            render={({ field }) => (
              <FormItem className="flex flex-col">
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
        </form>
      </Form>
    </div>
  )
}
