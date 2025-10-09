import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { settingsTable } from '@/db/tables'
import { DatabaseSingleton } from '@/db/singleton'
import { trackEvent } from '@/lib/analytics'
import { detectUnitSystem, getDefaultUnits, DEFAULT_IMPERIAL_UNITS } from '@/lib/unit-detection'
import type { UnitsData, PreferencesSettings } from '@/types'

const localizationFormSchema = z.object({
  temperatureUnit: z.string(),
  windSpeedUnit: z.string(),
  precipitationUnit: z.string(),
  timeFormat: z.string(),
  distanceUnit: z.string(),
})

type LocalizationFormData = z.infer<typeof localizationFormSchema>

type UseLocalizationFormProps = {
  settings: PreferencesSettings | undefined
  unitsData: UnitsData | undefined
  unitsLoading: boolean
}

/**
 * Creates form values object from settings or default units
 */
const createFormValues = (
  settings: PreferencesSettings | undefined,
  defaultUnits: ReturnType<typeof getDefaultUnits>,
) => ({
  temperatureUnit: settings?.temperatureUnit || defaultUnits.temperature,
  windSpeedUnit: settings?.windSpeedUnit || defaultUnits.speed,
  precipitationUnit: settings?.precipitationUnit || defaultUnits.precipitation,
  timeFormat: settings?.timeFormat || defaultUnits.timeFormat,
  distanceUnit: settings?.distanceUnit || defaultUnits.distance,
})

/**
 * Manages localization form state and auto-detection logic
 * Extracted from preferences component for better separation of concerns
 */
export const useLocalizationForm = ({ settings, unitsData, unitsLoading }: UseLocalizationFormProps) => {
  const db = DatabaseSingleton.instance.db
  const queryClient = useQueryClient()

  const localizationForm = useForm<LocalizationFormData>({
    resolver: zodResolver(localizationFormSchema),
    defaultValues: {
      temperatureUnit: '',
      windSpeedUnit: '',
      precipitationUnit: '',
      timeFormat: '',
      distanceUnit: '',
    },
  })

  const saveLocalizationMutation = useMutation({
    mutationFn: async (values: LocalizationFormData) => {
      const settingsToSave = [
        { key: 'temperature_unit', value: values.temperatureUnit },
        { key: 'wind_speed_unit', value: values.windSpeedUnit },
        { key: 'precipitation_unit', value: values.precipitationUnit },
        { key: 'time_format', value: values.timeFormat },
        { key: 'distance_unit', value: values.distanceUnit },
      ]

      // Save all settings sequentially using async/await
      for (const { key, value } of settingsToSave) {
        await db.insert(settingsTable).values({ key, value }).onConflictDoUpdate({
          target: settingsTable.key,
          set: { value },
        })
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] })
      trackEvent('settings_localization_update')
    },
    onError: (error) => {
      console.error('Localization settings save failed:', error)
    },
  })

  useEffect(() => {
    const initializeForm = async () => {
      if (!settings || !unitsData || unitsLoading) return

      const currentValues = localizationForm.getValues()
      const hasFormValues = Object.values(currentValues).some((value) => value && value.trim() !== '')

      // If form already has values, don't reset
      if (hasFormValues) return

      const hasAnyLocalizationSettings =
        settings.temperatureUnit ||
        settings.windSpeedUnit ||
        settings.precipitationUnit ||
        settings.timeFormat ||
        settings.distanceUnit

      if (hasAnyLocalizationSettings) {
        const formValues = createFormValues(settings, DEFAULT_IMPERIAL_UNITS)
        localizationForm.reset(formValues)
      } else {
        try {
          const unitSystem = await detectUnitSystem()
          const defaultUnits = getDefaultUnits(unitSystem)

          const formValues = createFormValues(undefined, defaultUnits)
          localizationForm.reset(formValues)
          await saveLocalizationMutation.mutateAsync(formValues)
        } catch (error) {
          console.warn('Failed to auto-detect units, using imperial defaults:', error)
          const formValues = createFormValues(undefined, DEFAULT_IMPERIAL_UNITS)
          localizationForm.reset(formValues)
        }
      }
    }

    initializeForm()
  }, [settings, unitsData, unitsLoading, localizationForm, saveLocalizationMutation])

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
