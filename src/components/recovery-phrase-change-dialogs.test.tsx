/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'
import { RecoveryPhraseChangeDialogs, type RecoveryPhraseChangeFlow } from './recovery-phrase-change-dialogs'

const noop = () => {}
const asyncNoop = async () => {}

const flowIn = (status: RecoveryPhraseChangeFlow['status'], overrides: Partial<RecoveryPhraseChangeFlow> = {}) =>
  ({
    status,
    busy: 'none',
    otp: '',
    newRecoveryKey: status === 'display' ? 'one two three' : null,
    error: null,
    isBusy: false,
    isSubmitting: false,
    openConfirm: noop,
    cancel: noop,
    setOtp: noop,
    requestStepUpCode: asyncNoop,
    confirmRotation: asyncNoop,
    done: noop,
    ...overrides,
  }) satisfies RecoveryPhraseChangeFlow

const renderDialogs = (flow: RecoveryPhraseChangeFlow) =>
  render(<RecoveryPhraseChangeDialogs flow={flow} confirmTitle="Confirm title" confirmDescription="Confirm body" />)

describe('RecoveryPhraseChangeDialogs', () => {
  afterEach(cleanup)

  it('asks for confirmation with the given copy', () => {
    renderDialogs(flowIn('confirming'))
    expect(screen.getByText('Confirm title')).toBeInTheDocument()
    expect(screen.getByText('Confirm body')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send code' })).toBeInTheDocument()
  })

  it('offers a retry when the code request failed', () => {
    renderDialogs(flowIn('confirming', { error: 'mail down' }))
    expect(screen.getByRole('alert')).toHaveTextContent('mail down')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('asks for the emailed code', () => {
    renderDialogs(flowIn('stepUp'))
    expect(screen.getByRole('button', { name: 'Generate new phrase' })).toBeInTheDocument()
  })

  it('shows the new phrase once', () => {
    renderDialogs(flowIn('display'))
    expect(screen.getByRole('dialog', { name: 'Save your new recovery phrase' })).toBeInTheDocument()
  })

  it('renders nothing while idle', () => {
    renderDialogs(flowIn('idle'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
})
