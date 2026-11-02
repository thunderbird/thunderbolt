/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'

import { SkillDetail } from './skill-detail'

const noop = () => {}

afterEach(() => {
  cleanup()
})

describe('SkillDetail', () => {
  it('breaks long unbroken words in the description and instructions instead of overflowing the panel', () => {
    const longWord = 'Supercalifragilisticexpialidocious_'.repeat(17)
    render(
      <SkillDetail
        name="Long words skill"
        description={`About ${longWord}`}
        instruction={`Be polite. ${longWord}`}
        readOnly={false}
        onEdit={noop}
        onDelete={noop}
        onClose={noop}
      />,
    )

    expect(screen.getByText(`About ${longWord}`)).toHaveClass('whitespace-pre-wrap', 'break-words')
    expect(screen.getByText(`Be polite. ${longWord}`)).toHaveClass('whitespace-pre-wrap', 'break-words')
  })
})
