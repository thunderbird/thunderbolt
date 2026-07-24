/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'

import { Button } from './button'
import { Dialog } from './dialog'
import { FormFooter } from './form-footer'
import { Input } from './input'
import {
  ResponsiveModal,
  ResponsiveModalCancel,
  ResponsiveModalContent,
  ResponsiveModalContentComposable,
  ResponsiveModalDescription,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from './responsive-modal'

const meta = {
  title: 'UI/ResponsiveModal',
  component: ResponsiveModal,
  parameters: {
    layout: 'fullscreen',
  },
  args: {
    open: true,
    onOpenChange: fn(),
    children: null,
  },
} satisfies Meta<typeof ResponsiveModal>

export default meta
type Story = StoryObj<typeof meta>

const modalContents = (
  <>
    <ResponsiveModalHeader>
      <ResponsiveModalTitle>Connect a service</ResponsiveModalTitle>
      <ResponsiveModalDescription>Add the endpoint used by your agents.</ResponsiveModalDescription>
    </ResponsiveModalHeader>
    <ResponsiveModalContent>
      <label className="flex flex-col gap-2 text-sm font-medium">
        Server URL
        <Input defaultValue="https://example.com/mcp" />
      </label>
    </ResponsiveModalContent>
    <FormFooter>
      <ResponsiveModalCancel>Cancel</ResponsiveModalCancel>
      <Button>Connect</Button>
    </FormFooter>
  </>
)

export const DesktopStructured: Story = {
  render: (args) => <ResponsiveModal {...args}>{modalContents}</ResponsiveModal>,
}

export const MobileStructured: Story = {
  render: (args) => <ResponsiveModal {...args}>{modalContents}</ResponsiveModal>,
  parameters: {
    viewport: { defaultViewport: 'mobile1' },
  },
}

export const Composable: Story = {
  render: () => (
    <Dialog open>
      <ResponsiveModalContentComposable>
        <ResponsiveModalHeader>
          <ResponsiveModalTitle>Composable detail</ResponsiveModalTitle>
          <ResponsiveModalDescription>This surface is shared by trigger-driven dialogs.</ResponsiveModalDescription>
        </ResponsiveModalHeader>
        <ResponsiveModalContent centered>
          <p className="text-center text-sm text-muted-foreground">Dialog content can supply its own anatomy.</p>
        </ResponsiveModalContent>
      </ResponsiveModalContentComposable>
    </Dialog>
  ),
}
