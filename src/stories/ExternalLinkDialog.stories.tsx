/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ExternalLinkDialog } from '@/components/chat/external-link-dialog'
import { Button } from '@/components/ui/button'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { fn } from 'storybook/test'

// More on how to set up stories at: https://storybook.js.org/docs/writing-stories#default-export
const meta = {
  title: 'components/external-link-dialog',
  component: ExternalLinkDialog,
  parameters: {
    layout: 'centered',
    docs: {
      story: {
        inline: false,
        iframeHeight: 400,
      },
    },
  },
  tags: ['autodocs'],
  argTypes: {
    url: {
      control: 'text',
      description: 'The URL to display in the confirmation dialog',
    },
  },
  args: {
    url: 'https://example.com',
    onConfirm: fn(),
  },
} satisfies Meta<typeof ExternalLinkDialog>

export default meta
type Story = StoryObj<typeof meta>

/**
 * Dialog shown in open state with a typical URL
 */
export const Open: Story = {
  args: {
    open: true,
    onOpenChange: fn(),
  },
}

/**
 * Dialog with a long URL that wraps and scrolls
 */
export const LongURL: Story = {
  args: {
    open: true,
    onOpenChange: fn(),
    url: 'https://example.com/very/long/path/that/continues/for/a/while/and/might/need/to/wrap/or/scroll?with=many&query=parameters&that=make&it=even&longer=true',
  },
}

/**
 * Dialog with a GitHub pull request URL
 */
export const GitHubURL: Story = {
  args: {
    open: true,
    onOpenChange: fn(),
    url: 'https://github.com/anthropics/claude-code/pull/123',
  },
}

/**
 * Dialog with localhost URL (for development links)
 */
export const LocalhostURL: Story = {
  args: {
    open: true,
    onOpenChange: fn(),
    url: 'http://localhost:3000/debug/stats',
  },
}

/**
 * Interactive story with a button to open the dialog
 */
export const Interactive: Story = {
  render: ({ url, onConfirm }) => {
    const [open, setOpen] = useState(false)

    const handleConfirm = async () => {
      onConfirm()
      // Simulate async operation
      await new Promise((resolve) => setTimeout(resolve, 100))
      setOpen(false)
    }

    return (
      <>
        <Button onClick={() => setOpen(true)}>Open External Link Dialog</Button>
        <ExternalLinkDialog open={open} onOpenChange={setOpen} url={url} onConfirm={handleConfirm} />
      </>
    )
  },
  args: {
    open: false,
    onOpenChange: fn(),
    url: 'https://anthropic.com',
    onConfirm: fn(),
  },
}

/**
 * Dialog with short domain-only URL
 */
export const ShortURL: Story = {
  args: {
    open: true,
    onOpenChange: fn(),
    url: 'https://mozilla.org',
  },
}

/**
 * Dialog in loading state while opening the URL
 */
export const Opening: Story = {
  args: {
    open: true,
    onOpenChange: fn(),
    url: 'https://example.com/slow-redirect',
    isOpening: true,
  },
}

/**
 * Dialog showing an error after failing to open the URL
 */
export const WithError: Story = {
  args: {
    open: true,
    onOpenChange: fn(),
    url: 'https://example.com',
    openError: 'Could not open link. Please try again or copy the URL.',
  },
}

/**
 * Desktop variant with "Open in Thunderbolt" sidebar button
 */
export const WithOpenInApp: Story = {
  args: {
    open: true,
    onOpenChange: fn(),
    url: 'https://example.com/article',
    onOpenInApp: fn(),
  },
}
