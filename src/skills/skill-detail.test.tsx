/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { SkillDetail } from './skill-detail'

const renderDetail = (officeManual: Promise<string>) =>
  render(
    <SkillDetail
      name="Excel workbooks"
      description="Load before using run_office_script"
      instruction="The row's stub"
      officeManual={officeManual}
      readOnly
      onEdit={mock()}
      onDelete={mock()}
      onClose={mock()}
    />,
  )

describe('SkillDetail', () => {
  afterEach(() => {
    cleanup()
    mock.restore()
  })

  it("keeps the panel and shows the row's stub when the Office manual does not load", async () => {
    spyOn(console, 'error').mockImplementation(() => {})
    const failed = Promise.reject(new Error('Importing a module script failed.'))
    failed.catch(() => {})

    await act(async () => {
      renderDetail(failed)
    })

    expect(screen.getByText('Excel workbooks')).toBeInTheDocument()
    expect(screen.getByText("The row's stub")).toBeInTheDocument()
  })
})
