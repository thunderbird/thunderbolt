/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Meta, StoryObj } from '@storybook/react-vite'
import { MoreVertical, Plug } from 'lucide-react'
import { fn } from 'storybook/test'

import { DetailDivider, DetailPanel, DetailPanelSurface, DetailSectionTitle } from './detail-panel'
import { Button, mutedIconButtonClass } from './ui/button'
import { FormFooter } from './ui/form-footer'

const meta = {
  title: 'Settings/DetailPanel',
  component: DetailPanelSurface,
  parameters: {
    layout: 'fullscreen',
  },
  args: {
    open: true,
    isMobile: false,
    onClose: fn(),
    children: null,
  },
} satisfies Meta<typeof DetailPanelSurface>

export default meta
type Story = StoryObj<typeof meta>

const detailContents = (onClose: () => void) => (
  <DetailPanel
    icon={
      <div className="flex size-9 items-center justify-center rounded-lg bg-accent">
        <Plug className="size-5" />
      </div>
    }
    title="Example connection"
    subtitle="https://example.com/mcp"
    actions={
      <Button variant="ghost" size="icon" aria-label="More actions" className={mutedIconButtonClass}>
        <MoreVertical />
      </Button>
    }
    onClose={onClose}
  >
    <div className="flex flex-col gap-2">
      <DetailSectionTitle>Status</DetailSectionTitle>
      <p className="text-sm">Connected and available to agents.</p>
    </div>
    <DetailDivider />
    <div className="flex flex-col gap-2">
      <DetailSectionTitle>Server URL</DetailSectionTitle>
      <p className="truncate text-sm">https://example.com/mcp</p>
    </div>
    <FormFooter>
      <Button variant="outline">Disconnect</Button>
      <Button>Save</Button>
    </FormFooter>
  </DetailPanel>
)

export const DesktopSplitView: Story = {
  render: (args) => (
    <div className="flex h-screen overflow-hidden bg-background">
      <main className="min-w-0 flex-1 p-6">
        <h1 className="text-xl">Connections</h1>
        <div className="mt-4 rounded-xl border p-4">Selected connection</div>
      </main>
      <DetailPanelSurface {...args}>{detailContents(args.onClose)}</DetailPanelSurface>
    </div>
  ),
}

export const MobileModal: Story = {
  args: {
    isMobile: true,
  },
  render: (args) => <DetailPanelSurface {...args}>{detailContents(args.onClose)}</DetailPanelSurface>,
  parameters: {
    viewport: { defaultViewport: 'mobile1' },
  },
}
