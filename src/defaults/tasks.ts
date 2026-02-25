import { hashValues } from '@/lib/utils'
import type { Task } from '@/types'

/**
 * Compute hash of user-editable fields for a task
 * Includes item text and isComplete status - both are user modifications
 * Order is excluded as it's purely for display positioning
 */
export const hashTask = (task: Task): string => {
  return hashValues([task.item, task.isComplete])
}

/**
 * Default tasks shipped with the application
 * These are upserted on app start and serve as the baseline for diff comparisons
 */
export const defaultTaskConnectEmail: Task = {
  id: '0198ecc5-cc2b-735b-b478-93f8db7202ce',
  item: 'Connect your email account to get started',
  order: 100,
  isComplete: 0,
  defaultHash: null,
  deletedAt: null,
  userId: null,
}

export const defaultTaskSetPreferences: Task = {
  id: '0198ecc5-cc2b-735b-b478-96071aa92f62',
  item: 'Set your name and location in preferences for better AI responses',
  order: 200,
  isComplete: 0,
  defaultHash: null,
  deletedAt: null,
  userId: null,
}

export const defaultTaskExplorePro: Task = {
  id: '0198ecc5-cc2b-735b-b478-99e9874d61ba',
  item: 'Explore Thunderbolt Pro tools to extend capabilities',
  order: 300,
  isComplete: 0,
  defaultHash: null,
  deletedAt: null,
  userId: null,
}

/**
 * Array of all default tasks for iteration
 */
export const defaultTasks: ReadonlyArray<Task> = [
  defaultTaskConnectEmail,
  defaultTaskSetPreferences,
  defaultTaskExplorePro,
] as const
