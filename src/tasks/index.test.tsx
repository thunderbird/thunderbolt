/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'

import { deleteTask, getIncompleteTasks } from '@/dal'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { renderWithReactivity, waitForElement } from '@/test-utils/powersync-reactivity-test'
import { getClock } from '@/testing-library'
import TasksPage, {
  getVisibleOptimisticTask,
  initialTasksPageState,
  normalizeTaskSearchQuery,
  tasksPageReducer,
  type TaskListItem,
} from './index'

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

beforeEach(async () => {
  await resetTestDatabase()
})

afterEach(cleanup)

const flush = async () => {
  await act(async () => {
    await getClock().runAllAsync()
  })
}

describe('optimistic task creation', () => {
  const task: TaskListItem = {
    id: 'new-task',
    item: 'Appears immediately',
    order: 1000,
    isComplete: 0,
  }

  it('keeps a submitted task visible until the database query includes it', () => {
    const submitted = tasksPageReducer({ ...initialTasksPageState, isAddingNew: true }, { type: 'SUBMIT_ADD', task })

    expect(submitted.isAddingNew).toBe(false)
    expect(getVisibleOptimisticTask(submitted.optimisticTask, [], '')).toBe(task)
    expect(getVisibleOptimisticTask(submitted.optimisticTask, [task], '')).toBeNull()
    expect(tasksPageReducer(submitted, { type: 'ADD_RECONCILED', id: task.id }).optimisticTask).toBeNull()
  })

  it('normalizes padded searches for both optimistic and database filtering', () => {
    const searched = tasksPageReducer(initialTasksPageState, {
      type: 'SEARCH_CHANGED',
      query: '  Appears immediately  ',
    })

    expect(normalizeTaskSearchQuery('  Appears immediately  ')).toBe('Appears immediately')
    expect(searched.searchQuery).toBe('Appears immediately')
    expect(getVisibleOptimisticTask(task, [], searched.searchQuery)).toBe(task)
  })

  it('reconciles the optimistic row when the reactive task arrives', async () => {
    const { triggerChange } = renderWithReactivity(<TasksPage />, { tables: ['tasks'] })
    const addButton = await waitForElement(() => screen.queryByRole('button', { name: 'Add Your First Task' }))
    fireEvent.click(addButton)

    const input = screen.getByPlaceholderText('Add a new task…')
    fireEvent.change(input, { target: { value: task.item } })
    fireEvent.keyDown(input, { key: 'Enter' })

    const pendingRow = screen.getByText(task.item).closest('[data-task-id]')
    expect(pendingRow).toHaveAttribute('data-pending')
    expect(screen.queryByText('No tasks yet')).not.toBeInTheDocument()

    await flush()
    expect(await getIncompleteTasks(getDb())).toHaveLength(1)
    triggerChange(['tasks'])
    await flush()

    const storedRow = screen.getByText(task.item).closest('[data-task-id]')
    expect(storedRow).toBeInTheDocument()
    expect(storedRow).not.toHaveAttribute('data-pending')

    const [storedTask] = await getIncompleteTasks(getDb())
    expect(storedTask).toBeDefined()
    if (!storedTask) {
      throw new Error('Expected the submitted task to be stored')
    }
    await deleteTask(getDb(), storedTask.id)
    triggerChange(['tasks'])
    await flush()
    expect(screen.queryByText(task.item)).not.toBeInTheDocument()
  })
})
