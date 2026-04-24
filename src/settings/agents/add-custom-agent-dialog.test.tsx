import { describe, expect, it, mock, beforeEach } from 'bun:test'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { Dialog } from '@/components/ui/dialog'
import { AddCustomAgentDialogContent } from './add-custom-agent-dialog'

const noop = () => {}

const renderDialog = (props: { onAdd?: (p: any) => void; onClose?: () => void; remoteOnly?: boolean }) => {
  return render(
    <Dialog open={true}>
      <AddCustomAgentDialogContent
        onAdd={props.onAdd ?? noop}
        onClose={props.onClose ?? noop}
        remoteOnly={props.remoteOnly}
      />
    </Dialog>,
  )
}

describe('AddCustomAgentDialogContent', () => {
  beforeEach(() => {
    cleanup()
  })

  it('renders name, command, args, and description fields', () => {
    renderDialog({})
    expect(screen.getByLabelText('Name')).toBeDefined()
    expect(screen.getByLabelText('Command')).toBeDefined()
    expect(screen.getByLabelText('Arguments (optional)')).toBeDefined()
    expect(screen.getByLabelText('Description (optional)')).toBeDefined()
  })

  it('Add Agent button is disabled when name is empty', () => {
    renderDialog({})
    const addBtn = screen.getByText('Add Agent').closest('button')
    expect(addBtn?.disabled).toBe(true)
  })

  it('Add Agent button is disabled when command is empty', () => {
    renderDialog({})
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My Agent' } })
    const addBtn = screen.getByText('Add Agent').closest('button')
    expect(addBtn?.disabled).toBe(true)
  })

  it('Add Agent button is enabled when name and command are filled', () => {
    renderDialog({})
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My Agent' } })
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: '/usr/bin/my-agent' } })
    const addBtn = screen.getByText('Add Agent').closest('button')
    expect(addBtn?.disabled).toBe(false)
  })

  it('calls onAdd with correct params on submit', () => {
    const onAdd = mock(() => {})
    renderDialog({ onAdd })

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My Agent' } })
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: '/usr/bin/my-agent' } })
    fireEvent.change(screen.getByLabelText('Arguments (optional)'), { target: { value: '--acp --verbose' } })
    fireEvent.change(screen.getByLabelText('Description (optional)'), { target: { value: 'Test agent' } })

    fireEvent.click(screen.getByText('Add Agent'))

    expect(onAdd).toHaveBeenCalledTimes(1)
    expect(onAdd).toHaveBeenCalledWith({
      type: 'local',
      name: 'My Agent',
      command: '/usr/bin/my-agent',
      args: ['--acp', '--verbose'],
      description: 'Test agent',
      apiKey: undefined,
    })
  })

  it('omits args when args field is empty', () => {
    const onAdd = mock(() => {})
    renderDialog({ onAdd })

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My Agent' } })
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: '/usr/bin/my-agent' } })

    fireEvent.click(screen.getByText('Add Agent'))

    expect(onAdd).toHaveBeenCalledWith({
      type: 'local',
      name: 'My Agent',
      command: '/usr/bin/my-agent',
      args: undefined,
      description: undefined,
      apiKey: undefined,
    })
  })

  it('calls onClose when Cancel clicked', () => {
    const onClose = mock(() => {})
    renderDialog({ onClose })
    fireEvent.click(screen.getByText('Cancel'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('trims whitespace from inputs', () => {
    const onAdd = mock(() => {})
    renderDialog({ onAdd })

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  My Agent  ' } })
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: '  /usr/bin/my-agent  ' } })
    fireEvent.change(screen.getByLabelText('API Key (optional)'), { target: { value: '  sk-test  ' } })

    fireEvent.click(screen.getByText('Add Agent'))

    expect(onAdd).toHaveBeenCalledWith({
      type: 'local',
      name: 'My Agent',
      command: '/usr/bin/my-agent',
      args: undefined,
      description: undefined,
      apiKey: 'sk-test',
    })
  })

  describe('remote mode via dropdown', () => {
    it('shows only remote form when remoteOnly is true', () => {
      renderDialog({ remoteOnly: true })
      expect(screen.getByLabelText('WebSocket URL')).toBeDefined()
      expect(screen.queryByLabelText('Command')).toBeNull()
      // Type dropdown should not be visible in remote-only mode
      expect(screen.queryByLabelText('Type')).toBeNull()
    })

    it('shows Type dropdown when not remoteOnly', () => {
      renderDialog({})
      expect(screen.getByLabelText('Type')).toBeDefined()
    })

    it('defaults to Local type showing command fields', () => {
      renderDialog({})
      expect(screen.getByLabelText('Command')).toBeDefined()
      expect(screen.queryByLabelText('WebSocket URL')).toBeNull()
    })
  })

  it('renders API Key field', () => {
    renderDialog({})
    expect(screen.getByLabelText('API Key (optional)')).toBeDefined()
  })

  it('includes apiKey in local agent params when provided', () => {
    const onAdd = mock(() => {})
    renderDialog({ onAdd })

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My Agent' } })
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: '/usr/bin/my-agent' } })
    fireEvent.change(screen.getByLabelText('API Key (optional)'), { target: { value: 'sk-test-key-123' } })

    fireEvent.click(screen.getByText('Add Agent'))

    expect(onAdd).toHaveBeenCalledWith({
      type: 'local',
      name: 'My Agent',
      command: '/usr/bin/my-agent',
      args: undefined,
      description: undefined,
      apiKey: 'sk-test-key-123',
    })
  })

  it('includes apiKey in remote agent params when provided', () => {
    const onAdd = mock(() => {})
    renderDialog({ onAdd, remoteOnly: true })

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Remote Agent' } })
    fireEvent.change(screen.getByLabelText('WebSocket URL'), { target: { value: 'wss://example.com/agent' } })
    fireEvent.change(screen.getByLabelText('API Key (optional)'), { target: { value: 'sk-remote-key' } })

    fireEvent.click(screen.getByText('Add Agent'))

    expect(onAdd).toHaveBeenCalledWith({
      type: 'remote',
      name: 'Remote Agent',
      url: 'wss://example.com/agent',
      description: undefined,
      apiKey: 'sk-remote-key',
    })
  })

  it('omits apiKey when empty', () => {
    const onAdd = mock(() => {})
    renderDialog({ onAdd })

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My Agent' } })
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: '/usr/bin/my-agent' } })

    fireEvent.click(screen.getByText('Add Agent'))

    expect(onAdd).toHaveBeenCalledWith({
      type: 'local',
      name: 'My Agent',
      command: '/usr/bin/my-agent',
      args: undefined,
      description: undefined,
      apiKey: undefined,
    })
  })
})
