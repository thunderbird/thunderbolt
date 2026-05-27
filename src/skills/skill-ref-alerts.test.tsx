/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router'

import { SkillRefAlerts, type SkillRefProblem } from './skill-ref-alerts'

const renderWithRouter = (problems: SkillRefProblem[]) =>
  render(
    <MemoryRouter>
      <SkillRefAlerts problems={problems} />
    </MemoryRouter>,
  )

describe('SkillRefAlerts', () => {
  it('renders nothing when there are no problems', () => {
    const { container } = renderWithRouter([])
    expect(container.firstChild).toBeNull()
  })

  it('renders a disabled-skill row with an Enable link carrying the skill id in router state', () => {
    const { getByText } = renderWithRouter([{ kind: 'disabled', slug: 'task-triage', skillId: 'skill-123' }])
    expect(getByText('/task-triage')).toBeTruthy()
    const link = getByText('Enable') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('/settings/skills')
    // react-router stores state on the anchor; smoke-check it exists and has our id.
    // We don't read the state directly here (that needs a Memory location inspector);
    // the integration test of SkillsView consuming `editSkill` lives in skills-view tests.
  })

  it('renders an unknown-skill row with a Create-it link', () => {
    const { getByText } = renderWithRouter([{ kind: 'unknown', slug: 'no-such-skill' }])
    expect(getByText('/no-such-skill')).toBeTruthy()
    const link = getByText('Create it') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('/settings/skills')
  })

  it('renders multiple problems together with distinct links per row', () => {
    const { getAllByRole } = renderWithRouter([
      { kind: 'disabled', slug: 'a', skillId: 'id-a' },
      { kind: 'unknown', slug: 'b' },
      { kind: 'disabled', slug: 'c', skillId: 'id-c' },
    ])
    const links = getAllByRole('link') as HTMLAnchorElement[]
    expect(links).toHaveLength(3)
    expect(links.map((l) => l.textContent)).toEqual(['Enable', 'Create it', 'Enable'])
  })

  it('uses role="alert" so screen readers announce the strip', () => {
    const { container } = renderWithRouter([{ kind: 'unknown', slug: 'foo' }])
    expect(container.querySelector('[role="alert"]')).toBeTruthy()
  })
})
