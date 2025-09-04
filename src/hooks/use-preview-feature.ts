import posthog from 'posthog-js'
import { getBooleanSetting } from '@/lib/dal'
import { useEffect, useState } from 'react'

export const getPreviewFeatures = async () => {
  const experimental_feature_tasks = await getBooleanSetting('experimental_feature_tasks')
  const isTasksEnabled = (posthog.isFeatureEnabled('tasks') && experimental_feature_tasks) ?? false

  const experimental_feature_automations = await getBooleanSetting('experimental_feature_automations')
  const isAutomationsEnabled = (posthog.isFeatureEnabled('automations') && experimental_feature_automations) ?? false

  return {
    isTasksEnabled: isTasksEnabled ?? false,
    isAutomationsEnabled: isAutomationsEnabled ?? false,
  }
}

export const usePreviewFeature = () => {
  const [previewFeatures, setPreviewFeatures] = useState<{ isTasksEnabled: boolean; isAutomationsEnabled: boolean }>({
    isTasksEnabled: false,
    isAutomationsEnabled: false,
  })

  useEffect(() => {
    getPreviewFeatures().then((features) => setPreviewFeatures(features))
  }, [])

  return previewFeatures
}
