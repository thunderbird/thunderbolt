import React from 'react'
import { Form, FormField } from '@/components/ui/form'
import { Switch } from '@/components/ui/switch'
import { SectionCard } from '@/components/ui/section-card'
import { usePreviewFeatures, PreviewFeaturesFormData } from './use-preview-features'

interface PreviewFeaturesSectionProps {
  settings: any
  onFeatureToggle: (
    featureName: keyof PreviewFeaturesFormData,
    value: boolean,
  ) => Promise<{ requiresTelemetry: boolean; featureName?: string }>
}

export const PreviewFeaturesSection: React.FC<PreviewFeaturesSectionProps> = ({ settings, onFeatureToggle }) => {
  const { form, features } = usePreviewFeatures(settings)

  const handleToggle = async (featureName: keyof PreviewFeaturesFormData, value: boolean) => {
    return await onFeatureToggle(featureName, value)
  }

  return (
    <SectionCard title="Preview Features">
      <p className="mb-4 text-sm text-muted-foreground">
        Try out experimental features before they're officially released. These features may be unstable or change
        without notice. To enable them, you'll need to turn on telemetry so we can learn and improve from real usage.
      </p>

      <Form {...form}>
        <form className="flex flex-col gap-4" onSubmit={(e) => e.preventDefault()}>
          {features.map((feature) => (
            <FormField
              key={feature.databaseKey}
              control={form.control}
              name={feature.formFieldName as keyof PreviewFeaturesFormData}
              render={({ field }) => (
                <div className="flex-row flex items-center gap-4">
                  <div className="flex-1">
                    <label className="text-sm font-medium">{feature.name}</label>
                  </div>
                  <Switch
                    checked={field.value}
                    onCheckedChange={(value) =>
                      handleToggle(feature.formFieldName as keyof PreviewFeaturesFormData, value)
                    }
                  />
                </div>
              )}
            />
          ))}
        </form>
      </Form>
    </SectionCard>
  )
}
