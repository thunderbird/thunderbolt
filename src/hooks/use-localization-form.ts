import { useEffect, useCallback, useRef } from 'react'
import { useForm, type UseFormReturn } from 'react-hook-form'
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
export const createFormValues = (
  settings: PreferencesSettings | undefined,
  countryUnitsData: CountryUnitsData | undefined,
  prioritizeCountryData: boolean = false,
) => ({
  distanceUnit: prioritizeCountryData
    ? countryUnitsData?.units || settings?.distanceUnit || 'imperial'
    : settings?.distanceUnit || countryUnitsData?.units || 'imperial',
  temperatureUnit: prioritizeCountryData
    ? countryUnitsData?.temperature || settings?.temperatureUnit || 'F'
    : settings?.temperatureUnit || countryUnitsData?.temperature || 'F',
  dateFormat: prioritizeCountryData
    ? countryUnitsData?.dateFormatExample || settings?.dateFormat || 'MM/DD/YYYY'
    : settings?.dateFormat || countryUnitsData?.dateFormatExample || 'MM/DD/YYYY',
  timeFormat: prioritizeCountryData
    ? countryUnitsData?.timeFormat || settings?.timeFormat || '12'
    : settings?.timeFormat || countryUnitsData?.timeFormat || '12',
  currency: prioritizeCountryData
    ? countryUnitsData?.currency?.code || settings?.currency || 'USD'
    : settings?.currency || countryUnitsData?.currency?.code || 'USD',
})

/**
 * Manages localization form state and auto-detection logic
 * Extracted from preferences component for better separation of concerns
 */
export const useLocalizationForm = ({ settings, countryUnitsData, countryUnitsLoading }: UseLocalizationFormProps) => {
  const db = DatabaseSingleton.instance.db
  const queryClient = useQueryClient()
  const hasInitialized = useRef(false)
  const formRef = useRef<UseFormReturn<LocalizationFormData> | null>(null)

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

  formRef.current = localizationForm

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

  const resetForm = useCallback((formValues: LocalizationFormData) => {
    if (formRef.current) {
      formRef.current.reset(formValues)
    }
  }, [])

  useEffect(() => {
    if (!settings || countryUnitsLoading) return

    const currentValues = formRef.current?.getValues() || {
      distanceUnit: '',
      temperatureUnit: '',
      dateFormat: '',
      timeFormat: '',
      currency: '',
    }
    const hasFormValues = Object.values(currentValues).some((value) => value && value.trim() !== '')

    const hasAnyLocalizationSettings =
      settings.distanceUnit ||
      settings.temperatureUnit ||
      settings.dateFormat ||
      settings.timeFormat ||
      settings.currency
    if (!hasInitialized.current) {
      if (hasAnyLocalizationSettings) {
        const formValues = createFormValues(settings, countryUnitsData, false)
        resetForm(formValues)
      } else {
        const formValues = createFormValues(undefined, countryUnitsData)
        resetForm(formValues)

        if (!hasFormValues) {
          saveLocalizationMutation.mutateAsync(formValues).catch((error) => {
            console.error('Auto-save localization settings failed:', error)
          })
        }
      }
      hasInitialized.current = true
    }
  }, [settings, countryUnitsLoading, countryUnitsData, resetForm, saveLocalizationMutation])

  useEffect(() => {
    if (!settings || countryUnitsLoading || !hasInitialized.current) return

    if (countryUnitsData) {
      const formValues = createFormValues(settings, countryUnitsData, true)
      resetForm(formValues)
    }
  }, [settings, countryUnitsLoading, countryUnitsData, resetForm])

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
