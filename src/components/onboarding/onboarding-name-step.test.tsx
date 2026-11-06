/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import '@testing-library/jest-dom'
import { useState } from 'react'
import { getSettings, updateSettings } from '@/dal'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { HttpClientProvider } from '@/contexts'
import { useOnboardingState } from '@/hooks/use-onboarding-state'
import { getClock } from '@/testing-library'
import { renderWithReactivity } from '@/test-utils/powersync-reactivity-test'
import { createMockHttpClient } from '@/test-utils/http-client'
import { OnboardingNameStep } from './onboarding-name-step'

const WizardHarness = () => {
  const { state, actions } = useOnboardingState({ isStandalone: true })
  const [visible, setVisible] = useState(true)
  return (
    <>
      {visible && <OnboardingNameStep state={state} actions={actions} />}
      <button disabled={!state.isNameValid} onClick={() => actions.submitName(state.nameValue)}>
        Save name
      </button>
      <button onClick={() => setVisible(!visible)}>Toggle step</button>
    </>
  )
}

const settle = async () => {
  await act(async () => {
    await getClock().runAllAsync()
  })
}

const renderWizard = () =>
  renderWithReactivity(
    <HttpClientProvider httpClient={createMockHttpClient()}>
      <WizardHarness />
    </HttpClientProvider>,
    { tables: ['settings'] },
  )

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

describe('onboarding name draft', () => {
  it('labels and focuses the input without inventing a valid empty name', () => {
    renderWizard()
    expect(screen.getByRole('heading', { name: 'What should we call you?' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Save name' })).toBeDisabled()
  })

  it.each(['', '   ', '\t'])('rejects an empty or whitespace-only draft %j', async (value) => {
    renderWizard()
    fireEvent.change(screen.getByRole('textbox'), { target: { value } })
    await settle()
    expect(screen.getByRole('button', { name: 'Save name' })).toBeDisabled()
  })

  it('saves exactly the displayed Unicode name', async () => {
    renderWizard()
    const name = "José María O'Connor-Smith"
    fireEvent.change(screen.getByRole('textbox'), { target: { value: name } })
    expect(screen.getByRole('textbox')).toHaveValue(name)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save name' }))
      await getClock().runAllAsync()
    })
    expect((await getSettings(getDb(), { preferred_name: '' })).preferredName).toBe(name)
  })

  it('loads a saved name and makes it immediately usable', async () => {
    await updateSettings(getDb(), { preferred_name: 'Saved name' })
    renderWizard()
    await settle()
    expect(screen.getByRole('textbox')).toHaveValue('Saved name')
    expect(screen.getByRole('button', { name: 'Save name' })).toBeEnabled()
  })

  it('accepts late saved data only while the draft is untouched', async () => {
    const { triggerChange } = renderWizard()
    await settle()
    await updateSettings(getDb(), { preferred_name: 'Synced name' })
    triggerChange(['settings'])
    await settle()
    expect(screen.getByRole('textbox')).toHaveValue('Synced name')
  })

  it('does not let late sync replace the value submitted after an edit', async () => {
    const { triggerChange } = renderWizard()
    await settle()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'My draft' } })
    await updateSettings(getDb(), { preferred_name: 'Older synced value' })
    triggerChange(['settings'])
    await settle()
    expect(screen.getByRole('textbox')).toHaveValue('My draft')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save name' }))
      await getClock().runAllAsync()
    })
    expect((await getSettings(getDb(), { preferred_name: '' })).preferredName).toBe('My draft')
  })

  it('preserves an explicitly cleared draft when settings update', async () => {
    await updateSettings(getDb(), { preferred_name: 'Original' })
    const { triggerChange } = renderWizard()
    await settle()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } })
    await updateSettings(getDb(), { preferred_name: 'New synced name' })
    triggerChange(['settings'])
    await settle()
    expect(screen.getByRole('textbox')).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Save name' })).toBeDisabled()
  })

  it('retains the draft when leaving and returning to the step', () => {
    renderWizard()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Draft name' } })
    fireEvent.click(screen.getByRole('button', { name: 'Toggle step' }))
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Toggle step' }))
    expect(screen.getByRole('textbox')).toHaveValue('Draft name')
  })
})
