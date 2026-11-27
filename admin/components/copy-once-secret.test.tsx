/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { useMutation } from '@tanstack/react-query'
import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test'
import { secretMutationOptions } from '../api/secret-mutation'
import { createAdminTestHarness, flush } from '../test-utils'
import { CopyOnceSecret } from './copy-once-secret'

/** The screen pattern: the secret lives in the mutation's result only until `onDone`. */
const RotateCredential = () => {
  const rotate = useMutation({ mutationFn: async () => ({ token: 'scim-token-123' }), ...secretMutationOptions })
  if (!rotate.data) {
    return (
      <button type="button" onClick={() => rotate.mutate()}>
        Rotate
      </button>
    )
  }
  return (
    <CopyOnceSecret
      label="SCIM token"
      copyLabel="Copy SCIM token"
      secret={rotate.data.token}
      onDone={() => rotate.reset()}
    />
  )
}

describe('CopyOnceSecret', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
  afterEach(() => {
    cleanup()
  })

  it('shows the secret and its details with copy buttons', () => {
    const onDone = mock(() => {})
    render(
      <CopyOnceSecret
        label="SCIM token"
        copyLabel="Copy SCIM token"
        secret="scim-token-123"
        details={[
          {
            label: 'SCIM base URL',
            copyLabel: 'Copy SCIM base URL',
            value: 'https://example.com/v1/api/auth/scim/v2',
          },
        ]}
        onDone={onDone}
      />,
      { wrapper: createAdminTestHarness().wrapper },
    )
    expect(screen.getByRole('textbox', { name: 'SCIM token' })).toHaveValue('scim-token-123')
    expect(screen.getByRole('textbox', { name: 'SCIM base URL' })).toHaveValue(
      'https://example.com/v1/api/auth/scim/v2',
    )
    expect(screen.getByRole('button', { name: 'Copy SCIM token' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy SCIM base URL' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('leaves no copy of the secret in the mutation cache after Done', async () => {
    const harness = createAdminTestHarness()
    render(<RotateCredential />, { wrapper: harness.wrapper })
    const holdsSecret = () =>
      harness.queryClient
        .getMutationCache()
        .getAll()
        .some((mutation) => JSON.stringify(mutation.state.data ?? null).includes('scim-token-123'))

    fireEvent.click(screen.getByRole('button', { name: 'Rotate' }))
    await flush()
    expect(screen.getByRole('textbox', { name: 'SCIM token' })).toHaveValue('scim-token-123')
    expect(holdsSecret()).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await flush()
    expect(screen.queryByRole('textbox', { name: 'SCIM token' })).not.toBeInTheDocument()
    expect(holdsSecret()).toBe(false)
  })
})
