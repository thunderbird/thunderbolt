/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Meta, StoryObj } from '@storybook/react-vite'
import { MoreHorizontal } from 'lucide-react'

import { Button } from './button'
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from './card'

const meta = {
  title: 'UI/Card',
  component: Card,
  parameters: {
    layout: 'centered',
  },
} satisfies Meta<typeof Card>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <Card className="w-96">
      <CardHeader>
        <CardTitle>Daily Brief</CardTitle>
        <CardDescription>Weather, news, inbox, and calendar in one digest.</CardDescription>
        <CardAction>
          <Button variant="ghost" size="icon-xs" aria-label="More options">
            <MoreHorizontal />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <p className="text-sm">Runs every morning at 7am and posts a summary to your inbox. Uses your default model.</p>
      </CardContent>
      <CardFooter className="gap-2">
        <Button size="sm">Run now</Button>
        <Button size="sm" variant="outline">
          Edit
        </Button>
      </CardFooter>
    </Card>
  ),
}

export const Minimal: Story = {
  render: () => (
    <Card className="w-96">
      <CardContent>
        <p className="text-sm">A bare card with only content — no header or footer.</p>
      </CardContent>
    </Card>
  ),
}
