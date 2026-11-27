/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { msg } from '@lingui/core/macro'
import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { GuardedAction } from './guarded-action'

describe('GuardedAction', () => {
  afterEach(() => {
    cleanup()
  })

  it('runs the action when it is available', () => {
    const onClick = mock(() => {})
    render(
      <GuardedAction availability={{ available: true }} onClick={onClick}>
        Block
      </GuardedAction>,
    )
    const button = screen.getByRole('button', { name: 'Block' })
    expect(button).not.toHaveAccessibleDescription()
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('is disabled and described by the reason when it is not', () => {
    render(
      <GuardedAction availability={{ available: false, reason: msg`You can't block yourself.` }}>Block</GuardedAction>,
    )
    const button = screen.getByRole('button', { name: 'Block' })
    expect(button).toBeDisabled()
    expect(button).toHaveAccessibleDescription("You can't block yourself.")
  })
})
