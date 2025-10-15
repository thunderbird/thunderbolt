import { useEffect, useCallback, useRef } from 'react'
import { useForm, type UseFormReturn } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { setSettings } from '@/lib/dal'
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
    ? countryUnitsData?.unit || settings?.distanceUnit || 'imperial'
    : settings?.distanceUnit || countryUnitsData?.unit || 'imperial',
  temperatureUnit: prioritizeCountryData
    ? countryUnitsData?.temperature || settings?.temperatureUnit || 'F'
    : settings?.temperatureUnit || countryUnitsData?.temperature || 'F',
  dateFormat: prioritizeCountryData
    ? countryUnitsData?.dateFormatExample || settings?.dateFormat || 'MM/DD/YYYY'
    : settings?.dateFormat || countryUnitsData?.dateFormatExample || 'MM/DD/YYYY',
  timeFormat: prioritizeCountryData
    ? countryUnitsData?.timeFormat || settings?.timeFormat || '12h'
    : settings?.timeFormat || countryUnitsData?.timeFormat || '12h',
  currency: prioritizeCountryData
    ? countryUnitsData?.currency?.code || settings?.currency || 'USD'
    : settings?.currency || countryUnitsData?.currency?.code || 'USD',
})

/**
 * Manages localization form state and auto-detection logic
 * Extracted from preferences component for better separation of concerns
 */
export const useLocalizationForm = ({ settings, countryUnitsData, countryUnitsLoading }: UseLocalizationFormProps) => {
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
    mutationFn: useCallback(async (values: LocalizationFormData) => {
      const settingsToSave = {
        distance_unit: values.distanceUnit,
        temperature_unit: values.temperatureUnit,
        date_format: values.dateFormat,
        time_format: values.timeFormat,
        currency: values.currency,
      }

      await setSettings(settingsToSave)
    }, []),
    onSuccess: useCallback(() => {
      queryClient.invalidateQueries({ queryKey: ['preferences-settings'] })
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
    if (!settings || countryUnitsLoading || hasInitialized.current) return

    const hasPreferencesLocalizationSettings =
      settings.distanceUnit ||
      settings.temperatureUnit ||
      settings.dateFormat ||
      settings.timeFormat ||
      settings.currency

    if (hasPreferencesLocalizationSettings) {
      const formValues = createFormValues(settings, countryUnitsData, false)
      resetForm(formValues)
    } else {
      const formValues = createFormValues(undefined, countryUnitsData)
      resetForm(formValues)

      saveLocalizationMutation.mutateAsync(formValues).catch((error) => {
        console.error('Auto-save localization settings failed:', error)
      })
    }

    hasInitialized.current = true
  }, [settings, countryUnitsLoading, countryUnitsData, resetForm, saveLocalizationMutation])

  useEffect(() => {
    if (!hasInitialized.current || !countryUnitsData || countryUnitsLoading) return

    const formValues = createFormValues(settings, countryUnitsData, true)
    resetForm(formValues)
  }, [countryUnitsData, countryUnitsLoading, settings, resetForm])

  const handleLocalizationChange = async (fieldName: keyof LocalizationFormData, value: string) => {
    const currentValues = localizationForm.getValues()
    const valuesToSave = {
      ...currentValues,
      [fieldName]: value,
    }

    try {
      await saveLocalizationMutation.mutateAsync(valuesToSave)
    } catch (error) {
      console.error('Failed to save localization settings:', error)
    }
  }

  return {
    localizationForm,
    handleLocalizationChange,
  }
}
