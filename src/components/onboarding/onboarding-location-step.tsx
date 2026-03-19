import { Form, FormControl, FormField, FormItem, FormMessage } from '@/components/ui/form'
import type { LocationData } from '@/hooks/use-location-search'
import type { OnboardingState } from '@/hooks/use-onboarding-state'
import { zodResolver } from '@hookform/resolvers/zod'
import { MapPin } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { LocationSearchCombobox } from '../location-search-combobox'
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
    if (!isInitialized) {
      return
    }

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
                <FormControl>
                  <LocationSearchCombobox value={field.value} onSelect={handleSelectLocation} autoOpen />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </form>
      </Form>
    </div>
  )
}
