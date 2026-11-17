/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test'
import { AdminApiError } from '../api/client'
import { createAdminTestHarness, flush } from '../test-utils'
import { ResourcePageDialogs } from './resource-page-dialogs'
import { useResourcePageState } from './use-resource-page-state'

const Harness = ({ onConfirm }: { onConfirm: (id: string) => Promise<void> }) => {
  const page = useResourcePageState()
  return (
    <>
      <button type="button" onClick={() => page.patch({ removeId: 'g1' })}>
        Remove g1
      </button>
      <output aria-label="remove id">{page.removeId ?? 'none'}</output>
      <ResourcePageDialogs
        page={page}
        remove={{
          title: 'Delete group?',
          description: 'Its members lose the group.',
          confirmLabel: 'Delete',
          onConfirm,
        }}
      />
    </>
  )
}

describe('ResourcePageDialogs', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
  afterEach(() => {
    cleanup()
  })

  it('removes after confirmation and closes', async () => {
    const onConfirm = mock(async (_id: string) => {})
    render(<Harness onConfirm={onConfirm} />, { wrapper: createAdminTestHarness().wrapper })
    fireEvent.click(screen.getByRole('button', { name: 'Remove g1' }))

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await flush()

    expect(onConfirm).toHaveBeenCalledWith('g1')
    expect(screen.getByLabelText('remove id')).toHaveTextContent('none')
  })

  it('stays open and says why when the removal is refused', async () => {
    const onConfirm = async () => {
      throw new AdminApiError(404, 'GROUP_NOT_FOUND', {})
    }
    render(<Harness onConfirm={onConfirm} />, { wrapper: createAdminTestHarness().wrapper })
    fireEvent.click(screen.getByRole('button', { name: 'Remove g1' }))

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await flush()

    expect(screen.getByRole('alert')).toHaveTextContent('This group no longer exists.')
    expect(screen.getByLabelText('remove id')).toHaveTextContent('g1')
  })
})
