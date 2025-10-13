import { useEffect, useCallback } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { settingsTable } from '@/db/tables'
import { DatabaseSingleton } from '@/db/singleton'
import { trackEvent } from '@/lib/analytics'
import type { CountryUnitsData, PreferencesSettings } from '@/types'

export const localizationFormSchema = z.object({
  distanceUnit: z.string(),
  temperatureUnit: z.string(),
  dateFormat: z.string(),
  timeFormat: z.string(),
  currency: z.string(),
})

type LocalizationFormData = z.infer<typeof localizationFormSchema>

type UseLocalizationFormProps = {
  settings: PreferencesSettings | undefined
  countryUnitsData: CountryUnitsData | undefined
  countryUnitsLoading: boolean
}

/**
 * Creates form values object from settings or country units data
 * Defaults to US units if no country data is available
 */
const createFormValues = (
  settings: PreferencesSettings | undefined,
  countryUnitsData: CountryUnitsData | undefined,
) => ({
  distanceUnit: settings?.distanceUnit || countryUnitsData?.units || 'metric',
  temperatureUnit: settings?.temperatureUnit || countryUnitsData?.temperature || 'F',
  dateFormat: settings?.dateFormat || countryUnitsData?.dateFormatExample || 'MM/DD/YYYY',
  timeFormat: settings?.timeFormat || countryUnitsData?.timeFormat || '12',
  currency: settings?.currency || countryUnitsData?.currency?.code || 'USD',
})

/**
 * Manages localization form state and auto-detection logic
 * Extracted from preferences component for better separation of concerns
 */
export const useLocalizationForm = ({ settings, countryUnitsData, countryUnitsLoading }: UseLocalizationFormProps) => {
  const db = DatabaseSingleton.instance.db
  const queryClient = useQueryClient()

  const localizationForm = useForm<LocalizationFormData>({
    resolver: zodResolver(localizationFormSchema),
    defaultValues: {
      distanceUnit: '',
      temperatureUnit: '',
      dateFormat: '',
      timeFormat: '',
      currency: '',
    },
  })

  const saveLocalizationMutation = useMutation({
    mutationFn: useCallback(
      async (values: LocalizationFormData) => {
        const settingsToSave = [
          { key: 'distance_unit', value: values.distanceUnit },
          { key: 'temperature_unit', value: values.temperatureUnit },
          { key: 'date_format', value: values.dateFormat },
          { key: 'time_format', value: values.timeFormat },
          { key: 'currency', value: values.currency },
        ]

        for (const { key, value } of settingsToSave) {
          await db.insert(settingsTable).values({ key, value }).onConflictDoUpdate({
            target: settingsTable.key,
            set: { value },
          })
        }
      },
      [db],
    ),
    onSuccess: useCallback(() => {
      queryClient.invalidateQueries({ queryKey: ['settings'] })
      trackEvent('settings_localization_update')
    }, [queryClient]),
    onError: useCallback((error: Error) => {
      console.error('Localization settings save failed:', error)
    }, []),
  })

  useEffect(() => {
    const initializeForm = async () => {
      if (!settings || countryUnitsLoading) return

      const currentValues = localizationForm.getValues()
      const hasFormValues = Object.values(currentValues).some((value) => value && value.trim() !== '')

      if (hasFormValues) return

      const hasAnyLocalizationSettings =
        settings.distanceUnit ||
        settings.temperatureUnit ||
        settings.dateFormat ||
        settings.timeFormat ||
        settings.currency

      if (hasAnyLocalizationSettings) {
        const formValues = createFormValues(settings, countryUnitsData)
        localizationForm.reset(formValues)
      } else {
        // If no country data is available (no location set), use US defaults
        const formValues = createFormValues(undefined, countryUnitsData)
        localizationForm.reset(formValues)
        await saveLocalizationMutation.mutateAsync(formValues)
      }
    }

    initializeForm()
  }, [settings, countryUnitsData, countryUnitsLoading, localizationForm, saveLocalizationMutation])

  const handleLocalizationChange = async (fieldName: keyof LocalizationFormData, value: string) => {
    const currentValues = localizationForm.getValues()
    await saveLocalizationMutation.mutateAsync({
      ...currentValues,
      [fieldName]: value,
    })
  }

  return {
    localizationForm,
    handleLocalizationChange,
  }
}
