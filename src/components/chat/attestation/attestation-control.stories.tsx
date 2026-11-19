/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Meta, StoryObj } from '@storybook/react-vite'
import { createRef } from 'react'
import { AttestationControl } from './attestation-control'
import { AttestationModal } from './attestation-modal'
import { AttestationMenuRow } from './attestation-menu-row'

const meta = {
  title: 'Chat/Attestation',
  component: AttestationModal,
  parameters: { layout: 'centered' },
  args: {
    target: { kind: 'local', key: 'preview', provider: 'Tinfoil', client: 'system' },
    onVerify: async () => {},
    hour12: false,
    open: true,
    onOpenChange: () => {},
    returnFocusRef: createRef<HTMLButtonElement>(),
  },
  decorators: [
    (Story) => (
      <div className="flex min-h-96 items-end justify-center">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AttestationModal>

export default meta
type Story = StoryObj<typeof meta>

export const Verified: Story = {
  args: {
    state: {
      status: 'verified',
      evidence: {
        provider: 'Tinfoil',
        verifiedAt: Date.now(),
        endpoint: 'inference.tinfoil.sh',
        checks: ['hardware', 'code', 'measurement', 'channel'],
        details: [
          { label: 'source', value: 'tinfoilsh/confidential-model-router' },
          { label: 'release', value: 'a4d9c7e2b80f163dc36a8f25b1d09e4a6397c2d840ef56b9137a82ed0c65f349' },
          { label: 'measurement', value: 'be34f189ac04572d02ef7d5a7b812ed3cb9690bd81e6a4dc7c1ce197f49639a1' },
        ],
      },
    },
  },
}
export const BeforeFirstConnection: Story = { args: { state: { status: 'idle' } } }
export const Verifying: Story = { args: { state: { status: 'verifying' } } }
export const Failed: Story = { args: { state: { status: 'failed', reason: 'verification' } } }
export const Timeout: Story = { args: { state: { status: 'failed', reason: 'timeout' } } }
export const RemoteAgent: Story = {
  args: { target: { kind: 'agent', key: 'remote', name: 'My coding agent' }, state: { status: 'idle' } },
}
export const UnsupportedProvider: Story = {
  args: { target: { kind: 'unsupported', key: 'custom' }, state: { status: 'idle' } },
}

export const VerifiedMenuRow: Story = {
  args: Verified.args,
  render: (args) => (
    <div className="w-80 rounded-xl border">
      <AttestationMenuRow target={args.target} state={args.state} onClick={() => {}} />
    </div>
  ),
}
export const AgentTrigger: Story = {
  args: RemoteAgent.args,
  render: (args) => <AttestationControl {...args} />,
}
