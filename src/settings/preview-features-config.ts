export enum PreviewFeatureDatabaseKey {
  AUTOMATIONS = 'experimental_feature_automations',
  TASKS = 'experimental_feature_tasks',
}

export interface PreviewFeature {
  name: string
  databaseKey: PreviewFeatureDatabaseKey
  formFieldName: string
  enabled: boolean
}

export const PREVIEW_FEATURES: PreviewFeature[] = [
  {
    name: 'Automations',
    databaseKey: PreviewFeatureDatabaseKey.AUTOMATIONS,
    formFieldName: 'experimentalFeatureAutomations',
    enabled: false,
  },
  {
    name: 'Tasks',
    databaseKey: PreviewFeatureDatabaseKey.TASKS,
    formFieldName: 'experimentalFeatureTasks',
    enabled: false,
  },
  // Add new preview features here by following the same pattern
]
