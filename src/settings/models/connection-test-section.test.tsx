/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'
import type { ComponentProps } from 'react'
import { ConnectionTestSection } from './connection-test-section'

const baseProps: ComponentProps<typeof ConnectionTestSection> = {
  provider: 'custom',
  model: 'gemma3:4b',
  apiKey: undefined,
  isTesting: false,
  onTest: () => {},
  status: 'success',
  error: null,
  toolSupport: 'supported',
}

describe('ConnectionTestSection', () => {
  afterEach(() => {
    cleanup()
  })

  it('shows the plain success card when the model accepts tools', () => {
    render(<ConnectionTestSection {...baseProps} />)

    expect(screen.getByText('Test successful!')).toBeInTheDocument()
    expect(screen.queryByText('Connected without tools')).not.toBeInTheDocument()
  })

  it('warns instead when the model connected but rejected tools', () => {
    render(<ConnectionTestSection {...baseProps} toolSupport="unsupported" />)

    expect(screen.getByText('Connected without tools')).toBeInTheDocument()
    expect(screen.queryByText('Test successful!')).not.toBeInTheDocument()
  })

  it('shows the failure, not a tool verdict, when the test failed', () => {
    render(<ConnectionTestSection {...baseProps} status="error" error="invalid api key" toolSupport={null} />)

    expect(screen.getByText('invalid api key')).toBeInTheDocument()
    expect(screen.queryByText('Connected without tools')).not.toBeInTheDocument()
  })
})
