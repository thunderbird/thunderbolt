/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, mock } from 'bun:test'
import { useState } from 'react'
import { OnboardingNameStep } from './onboarding-name-step'

describe('OnboardingNameStep', () => {
  it('renders the saved name with an accessible, focused input', () => {
    const setNameValue = mock()
    render(<OnboardingNameStep state={{ nameValue: 'Alice', isSubmittingName: false }} actions={{ setNameValue }} />)
    const input = screen.getByRole('textbox', { name: 'Enter your name' })
    expect(input).toHaveValue('Alice')
    expect(input).toHaveFocus()
    expect(setNameValue).not.toHaveBeenCalled()
  })

  it.each(['', '   ', 'José María O’Connor-Smith', '  Alice  '])(
    'sends the complete edit to its owner: %j',
    (value) => {
      const setNameValue = mock()
      const Step = () => {
        const [nameValue, setName] = useState('Initial')
        return (
          <OnboardingNameStep
            state={{ nameValue, isSubmittingName: false }}
            actions={{
              setNameValue: (next) => {
                setNameValue(next)
                setName(next)
              },
            }}
          />
        )
      }
      render(<Step />)
      const input = screen.getByRole('textbox')
      fireEvent.change(input, { target: { value } })
      expect(setNameValue).toHaveBeenLastCalledWith(value)
      expect(input).toHaveValue(value)
    },
  )

  it('reflects parent data directly and disables edits during persistence', () => {
    const actions = { setNameValue: mock() }
    const { rerender } = render(
      <OnboardingNameStep state={{ nameValue: '', isSubmittingName: false }} actions={actions} />,
    )
    rerender(<OnboardingNameStep state={{ nameValue: 'Loaded', isSubmittingName: true }} actions={actions} />)
    expect(screen.getByRole('textbox')).toHaveValue('Loaded')
    expect(screen.getByRole('textbox')).toBeDisabled()
    expect(actions.setNameValue).not.toHaveBeenCalled()
  })
})
