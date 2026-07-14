/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'

import type { PermissionOption, RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { useChatStore } from '@/chats/chat-store'
import { createMockChatInstance, hydrateStore, resetStore } from '@/test-utils/chat-store-mocks'
import { PermissionDialog } from './permission-dialog'
import { PermissionDialogHost } from './permission-dialog-host'

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
const defaultHandlers = {
  onAlwaysAllowAgent: () => {},
  onAlwaysAllowTool: () => {},
  onRespond: () => {},
}

describe('PermissionDialog', () => {
  afterEach(cleanup)

  it('renders the tool kind label, title, and location', () => {
    render(<PermissionDialog {...defaultHandlers} request={baseRequest} />)

    expect(screen.getByText('Run command')).toBeInTheDocument()
    expect(screen.getByText('Read /etc/passwd')).toBeInTheDocument()
    expect(screen.getByText(/\/etc\/passwd:1/)).toBeInTheDocument()
  })

  it('renders complete raw tool input as inert, scrollable text', () => {
    const hiddenTail = `; ${'x'.repeat(500)}; rm -rf /`
    const rawInput = { command: `echo '<img src=x onerror="pwned">'${hiddenTail}`, timeout: 1_000 }
    const request: RequestPermissionRequest = {
      ...baseRequest,
      toolCall: { ...baseRequest.toolCall, rawInput } as RequestPermissionRequest['toolCall'],
    }
    const { container } = render(<PermissionDialog {...defaultHandlers} request={request} />)
    const input = screen.getByLabelText('Tool input')

    expect(input.textContent).toBe(JSON.stringify(rawInput, null, 2))
    expect(input).toHaveClass('max-h-64', 'overflow-auto', 'whitespace-pre-wrap', 'break-words')
    expect(container.querySelector('img')).toBeNull()
  })

  it('renders a string raw input without JSON quote decoration', () => {
    const request: RequestPermissionRequest = {
      ...baseRequest,
      toolCall: { ...baseRequest.toolCall, rawInput: 'echo hello' } as RequestPermissionRequest['toolCall'],
    }
    render(<PermissionDialog {...defaultHandlers} request={request} />)

    expect(screen.getByLabelText('Tool input')).toHaveTextContent('echo hello')
  })

  it('calls onRespond with the selected option once and then disables buttons', () => {
    const onRespond = mock(() => {})
    render(<PermissionDialog {...defaultHandlers} request={baseRequest} onRespond={onRespond} />)

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
    render(<PermissionDialog {...defaultHandlers} request={request} />)
    expect(screen.getByText('Action')).toBeInTheDocument()
  })

  it('renders both always-allow actions when an allow option exists', () => {
    render(<PermissionDialog {...defaultHandlers} request={baseRequest} />)

    expect(screen.getByText('Always allow this tool')).toBeInTheDocument()
    expect(screen.getByText('Always allow everything from this agent')).toBeInTheDocument()
  })

  it('hides always-allow actions when no allow option exists', () => {
    const request: RequestPermissionRequest = {
      ...baseRequest,
      options: [{ optionId: 'reject', name: 'Reject', kind: 'reject_once' }],
    }

    render(<PermissionDialog {...defaultHandlers} request={request} />)

    expect(screen.queryByText('Always allow this tool')).not.toBeInTheDocument()
    expect(screen.queryByText('Always allow everything from this agent')).not.toBeInTheDocument()
  })

  it('calls the tool always-allow handler and disables further input', () => {
    const onAlwaysAllowTool = mock(() => {})
    const onAlwaysAllowAgent = mock(() => {})
    render(
      <PermissionDialog
        {...defaultHandlers}
        request={baseRequest}
        onAlwaysAllowTool={onAlwaysAllowTool}
        onAlwaysAllowAgent={onAlwaysAllowAgent}
      />,
    )

    fireEvent.click(screen.getByText('Always allow this tool'))
    fireEvent.click(screen.getByText('Always allow everything from this agent'))

    expect(onAlwaysAllowTool).toHaveBeenCalledTimes(1)
    expect(onAlwaysAllowAgent).not.toHaveBeenCalled()
  })

  it('calls the agent always-allow handler', () => {
    const onAlwaysAllowAgent = mock(() => {})
    render(<PermissionDialog {...defaultHandlers} request={baseRequest} onAlwaysAllowAgent={onAlwaysAllowAgent} />)

    fireEvent.click(screen.getByText('Always allow everything from this agent'))

    expect(onAlwaysAllowAgent).toHaveBeenCalledTimes(1)
  })
})

describe('PermissionDialogHost', () => {
  afterEach(() => {
    cleanup()
    resetStore()
    useChatStore.setState({ alwaysAllowedAgentIds: new Set(), alwaysAllowedAgentToolKeys: new Set() })
  })

  /** Renders host with a real store session containing one pending request. */
  const renderPendingPermission = (resolve: (response: RequestPermissionResponse) => void) => {
    hydrateStore({
      chatInstance: createMockChatInstance(),
      chatThread: null,
      id: 'session-1',
      selectedModel: null,
      triggerData: null,
    })
    useChatStore.getState().setPendingPermission('session-1', {
      agentId: 'agent-1',
      requestId: 'request-1',
      request: baseRequest,
      resolve,
    })

    render(<PermissionDialogHost />)
  }

  it('records a tool allowance and resolves the current request', () => {
    const resolve = mock(() => {})
    renderPendingPermission(resolve)

    fireEvent.click(screen.getByText('Always allow this tool'))

    expect(useChatStore.getState().isAlwaysAllowed('agent-1', 'Read /etc/passwd')).toBe(true)
    expect(useChatStore.getState().isAlwaysAllowed('agent-1', 'another tool')).toBe(false)
    expect(resolve).toHaveBeenCalledWith({ outcome: { outcome: 'selected', optionId: 'allow' } })
    expect(useChatStore.getState().sessions.get('session-1')!.pendingPermission).toBeNull()
  })

  it('records an agent allowance and resolves the current request', () => {
    const resolve = mock(() => {})
    renderPendingPermission(resolve)

    fireEvent.click(screen.getByText('Always allow everything from this agent'))

    expect(useChatStore.getState().isAlwaysAllowed('agent-1', 'another tool')).toBe(true)
    expect(useChatStore.getState().isAlwaysAllowed('agent-2', 'Read /etc/passwd')).toBe(false)
    expect(resolve).toHaveBeenCalledWith({ outcome: { outcome: 'selected', optionId: 'allow' } })
    expect(useChatStore.getState().sessions.get('session-1')!.pendingPermission).toBeNull()
  })
})
