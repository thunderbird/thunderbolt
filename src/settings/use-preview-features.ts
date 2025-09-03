import React from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { zodResolver } from '@hookform/resolvers/zod'
import { trackEvent } from '@/lib/analytics'
import { DatabaseSingleton } from '@/db/singleton'
import { settingsTable } from '@/db/tables'
import { PREVIEW_FEATURES } from './preview-features-config'

// Create a dynamic schema based on the preview features configuration
const createPreviewFeaturesSchema = () => {
  const schemaFields: Record<string, z.ZodBoolean> = {}

  PREVIEW_FEATURES.forEach((feature) => {
    schemaFields[feature.formFieldName] = z.boolean()
  })

  return z.object(schemaFields)
}

export type PreviewFeaturesFormData = z.infer<ReturnType<typeof createPreviewFeaturesSchema>>

export const usePreviewFeatures = (settings: any) => {
  const db = DatabaseSingleton.instance.db
  const queryClient = useQueryClient()

  // Create form with dynamic schema
  const form = useForm<PreviewFeaturesFormData>({
    resolver: zodResolver(createPreviewFeaturesSchema()),
    defaultValues: PREVIEW_FEATURES.reduce((acc, feature) => {
      acc[feature.formFieldName as keyof PreviewFeaturesFormData] = false
      return acc
    }, {} as PreviewFeaturesFormData),
  })

  // Update form when settings are loaded
  React.useEffect(() => {
    if (settings) {
      const defaultValues: PreviewFeaturesFormData = {} as PreviewFeaturesFormData

      PREVIEW_FEATURES.forEach((feature) => {
        const settingKey = feature.databaseKey as keyof typeof settings
        defaultValues[feature.formFieldName as keyof PreviewFeaturesFormData] = settings[settingKey] || false
      })

      form.reset(defaultValues)
    }
  }, [settings, form])

  // Sync preview features when telemetry is disabled
  React.useEffect(() => {
    if (!settings?.dataCollection) {
      PREVIEW_FEATURES.forEach((feature) => {
        if (settings?.[feature.databaseKey as keyof typeof settings]) {
          form.setValue(feature.formFieldName as keyof PreviewFeaturesFormData, false)
        }
      })
    }
  }, [settings?.dataCollection, settings, form])

  // Save preview features mutation
  const savePreviewFeaturesMutation = useMutation({
    mutationFn: async (values: PreviewFeaturesFormData) => {
      // Save each feature setting
      for (const feature of PREVIEW_FEATURES) {
        const value = values[feature.formFieldName as keyof PreviewFeaturesFormData]
        await db
          .insert(settingsTable)
          .values({
            key: feature.databaseKey,
            value: value ? 'true' : 'false',
          })
          .onConflictDoUpdate({
            target: settingsTable.key,
            set: { value: value ? 'true' : 'false' },
          })
      }
    },
    onSuccess: (_, values) => {
      queryClient.invalidateQueries({ queryKey: ['settings'] })

      // Track events for each feature
      PREVIEW_FEATURES.forEach((feature) => {
        const value = values[feature.formFieldName as keyof PreviewFeaturesFormData]
        if (value) {
          trackEvent(`settings_experimental_feature_${feature.id}_enabled`)
        } else {
          trackEvent(`settings_experimental_feature_${feature.id}_disabled`)
        }
      })
    },
  })

  // Handle individual feature toggle
  const handleFeatureToggle = async (featureName: keyof PreviewFeaturesFormData, value: boolean) => {
    if (value && !settings?.dataCollection) {
      return { requiresTelemetry: true, featureName }
    }

    const currentValues = form.getValues()
    await savePreviewFeaturesMutation.mutateAsync({
      ...currentValues,
      [featureName]: value,
    })

    return { requiresTelemetry: false }
  }

  // Handle bulk save (for when telemetry is enabled)
  const handleBulkSave = async (featureName: keyof PreviewFeaturesFormData, value: boolean) => {
    const currentValues = form.getValues()
    await savePreviewFeaturesMutation.mutateAsync({
      ...currentValues,
      [featureName]: value,
    })
  }

  // Disable all features (when telemetry is turned off)
  const disableAllFeatures = async () => {
    const currentValues = form.getValues()
    const disabledValues = { ...currentValues }

    PREVIEW_FEATURES.forEach((feature) => {
      disabledValues[feature.formFieldName as keyof PreviewFeaturesFormData] = false
    })

    await savePreviewFeaturesMutation.mutateAsync(disabledValues)
  }

  return {
    form,
    savePreviewFeaturesMutation,
    handleFeatureToggle,
    handleBulkSave,
    disableAllFeatures,
    features: PREVIEW_FEATURES,
  }
}
