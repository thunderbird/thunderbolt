/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Meta, StoryObj } from '@storybook/react-vite'
import { MemoryRouter } from 'react-router'

import { createTestProvider } from '@/test-utils/test-provider'
import { SkillRefAlerts } from './skill-ref-alerts'

const TestProvider = createTestProvider()

const meta = {
  title: 'Skills/SkillRefAlerts',
  component: SkillRefAlerts,
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        component:
          "Inline strip rendered between the chat composer's pinned chips and the input. Calls out committed `/slug` references that won't resolve at send time: disabled skills get an `Enable` deep-link, unknown names get a `Create it` deep-link. Lives outside the overlay because the overlay is pointer-events-none for textarea interactivity.",
      },
    },
  },
  decorators: [
    (Story) => (
      <TestProvider>
        <MemoryRouter>
          <div className="w-[480px] bg-background p-6">
            <Story />
          </div>
        </MemoryRouter>
      </TestProvider>
    ),
  ],
} satisfies Meta<typeof SkillRefAlerts>

export default meta
type Story = StoryObj<typeof meta>

export const Empty: Story = {
  args: { problems: [] },
}

export const SingleDisabled: Story = {
  args: { problems: [{ kind: 'disabled', slug: 'task-triage', skillId: 'skill-1' }] },
}

export const SingleUnknown: Story = {
  args: { problems: [{ kind: 'unknown', slug: 'no-such-skill' }] },
}

export const Mixed: Story = {
  args: {
    problems: [
      { kind: 'disabled', slug: 'task-triage', skillId: 'skill-1' },
      { kind: 'unknown', slug: 'meetnig-notes' },
      { kind: 'disabled', slug: 'weekly-review', skillId: 'skill-2' },
    ],
  },
}
