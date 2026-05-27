/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'

import type { PermissionOption, RequestPermissionRequest } from '@agentclientprotocol/sdk'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { PermissionDialog } from './permission-dialog'

const baseRequest: RequestPermissionRequest = {
  sessionId: 's1',
  options: [
    { optionId: 'allow', name: 'Allow', kind: 'allow_once' } as PermissionOption,
    { optionId: 'reject', name: 'Reject', kind: 'reject_once' } as PermissionOption,
  ],
  toolCall: {
    toolCallId: 'tc1',
    title: 'Read /etc/passwd',
    kind: 'execute',
    status: 'pending',
    locations: [{ path: '/etc/passwd', line: 1 }],
  } as RequestPermissionRequest['toolCall'],
}

describe('PermissionDialog', () => {
  afterEach(cleanup)

  it('renders the tool kind label, title, and location', () => {
    render(<PermissionDialog request={baseRequest} onRespond={mock()} />)

    expect(screen.getByText('Run command')).toBeInTheDocument()
    expect(screen.getByText('Read /etc/passwd')).toBeInTheDocument()
    expect(screen.getByText(/\/etc\/passwd:1/)).toBeInTheDocument()
  })

  it('calls onRespond with the selected option once and then disables buttons', () => {
    const onRespond = mock(() => {})
    render(<PermissionDialog request={baseRequest} onRespond={onRespond} />)

    fireEvent.click(screen.getByText('Allow'))
    expect(onRespond).toHaveBeenCalledTimes(1)
    expect(onRespond).toHaveBeenCalledWith({ outcome: { outcome: 'selected', optionId: 'allow' } })

    fireEvent.click(screen.getByText('Reject'))
    expect(onRespond).toHaveBeenCalledTimes(1)
  })

  it('falls back to the generic Action label when toolCall.kind is unknown', () => {
    const request: RequestPermissionRequest = {
      ...baseRequest,
      toolCall: { ...baseRequest.toolCall, kind: undefined } as RequestPermissionRequest['toolCall'],
    }
    render(<PermissionDialog request={request} onRespond={mock()} />)
    expect(screen.getByText('Action')).toBeInTheDocument()
  })
})
