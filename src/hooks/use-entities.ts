/**
 * Unified exports for entity management hooks
 *
 * This module provides a single import point for all entity management hooks.
 * Each hook provides a consistent interface for:
 * - Fetching entity data
 * - Checking if entity is modified from default
 * - Updating entity
 * - Resetting entity to default
 *
 * Available in both singular and plural versions:
 * - Singular: `useModel`, `useSetting`, `useAutomation`, `useTask`
 * - Plural: `useModels`, `useSettings`, `useAutomations`, `useTasks`
 *
 * @example
 * ```tsx
 * import { useSetting, useModel, useModels } from '@/hooks/use-entities'
 *
 * function MyComponent() {
 *   // Singular - for working with one entity
 *   const model = useModel('model-id')
 *   const setting = useSetting('setting-key', 'default')
 *
 *   // Plural - for working with multiple entities
 *   const models = useModels()
 *
 *   return (
 *     <div>
 *       {model.isModified && <Button onClick={model.reset}>Reset Model</Button>}
 *       {models.data.map(m => (
 *         <div key={m.id}>
 *           {models.isModified(m.id) && <Button onClick={() => models.reset(m.id)}>Reset</Button>}
 *         </div>
 *       ))}
 *     </div>
 *   )
 * }
 * ```
 */

// Singular hooks
export { useAutomation } from './use-automation'
export { useEntity, type EntityConfig, type UseEntityResult } from './use-entity'
export { useModel } from './use-model'
export { useBooleanSetting, useSetting, type UseBooleanSettingResult, type UseSettingResult } from './use-setting'
export { useTask } from './use-task'

// Plural hooks
export { useAutomations } from './use-automations'
export { useEntities, type EntitiesConfig, type UseEntitiesResult } from './use-entities-plural'
export { useModels } from './use-models'
export {
  useBooleanSettings,
  useSettings,
  type BooleanSettingHook,
  type SettingHook,
  type UseBooleanSettingsResult,
  type UseSettingsResult,
} from './use-settings'
export { useTasks } from './use-tasks'
