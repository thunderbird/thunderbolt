/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Meta, StoryObj } from '@storybook/react-vite'
import { Bot, Plus, Zap } from 'lucide-react'
import { fn } from 'storybook/test'

import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { SettingsEmptyState, SettingsNoResults } from './settings-empty-state'
import { SettingsListBody, SettingsListPane, SettingsSectionLabel, SettingsSelectableRow } from './settings-list'

const meta = {
  title: 'Settings/ListPatterns',
  component: SettingsSelectableRow,
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    (Story) => (
      <div className="h-[640px] bg-background">
        <Story />
      </div>
    ),
  ],
  args: {
    title: 'Research assistant',
    ariaLabel: 'Open Research assistant',
    onSelect: fn(),
  },
} satisfies Meta<typeof SettingsSelectableRow>

export default meta
type Story = StoryObj<typeof meta>

export const RowStates: Story = {
  render: () => (
    <SettingsListPane>
      <SettingsSectionLabel>Agents</SettingsSectionLabel>
      <SettingsListBody>
        <SettingsSelectableRow
          title="Research assistant"
          subtitle="Uses web search and citations"
          leading={<Bot className="size-5" />}
          isSelected
          trailing={<Switch aria-label="Enable Research assistant" defaultChecked />}
          onSelect={fn()}
          ariaLabel="Open Research assistant"
        />
        <SettingsSelectableRow
          title="Writing assistant"
          subtitle="Drafts and edits documents"
          leading={<Zap className="size-5" />}
          trailing={<Switch aria-label="Enable Writing assistant" />}
          onSelect={fn()}
          ariaLabel="Open Writing assistant"
        />
        <SettingsSelectableRow
          title="Unavailable assistant"
          subtitle="Requires a connection"
          leading={<Bot className="size-5" />}
          isDimmed
          onSelect={fn()}
          ariaLabel="Open Unavailable assistant"
        />
      </SettingsListBody>
    </SettingsListPane>
  ),
}

export const EmptyState: Story = {
  render: () => (
    <SettingsListPane>
      <SettingsSectionLabel>Connections</SettingsSectionLabel>
      <SettingsEmptyState
        icon={<Zap className="size-8 text-muted-foreground" />}
        title="No connections yet"
        description="Connect a service to make it available to your agents."
        action={
          <Button>
            <Plus />
            Add connection
          </Button>
        }
      />
    </SettingsListPane>
  ),
}

export const NoSearchResults: Story = {
  render: () => (
    <SettingsListPane>
      <SettingsSectionLabel>Connections</SettingsSectionLabel>
      <SettingsNoResults>No matching connections.</SettingsNoResults>
    </SettingsListPane>
  ),
}
