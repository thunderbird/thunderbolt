import { renderHook, act } from '@testing-library/react'
import { describe, expect, it, mock } from 'bun:test'
import { useChatListItemState } from './use-chat-list-item-state'

describe('useChatListItemState', () => {
  const setup = (title: string | null = 'My Chat') => {
    const onRename = mock()
    const result = renderHook(() => useChatListItemState({ title, onRename }))
    return { onRename, ...result }
  }

  it('starts in non-editing state', () => {
    const { result } = setup()
    expect(result.current.isEditing).toBe(false)
  })

  it('enters edit mode with current title on handleRenameStart', () => {
    const { result } = setup()
    act(() => result.current.handleRenameStart())

    expect(result.current.isEditing).toBe(true)
    expect(result.current.editValue).toBe('My Chat')
  })

  it('uses "New Chat" when title is null', () => {
    const { result } = setup(null)
    act(() => result.current.handleRenameStart())

    expect(result.current.editValue).toBe('New Chat')
  })

  it('calls onRename with new title on submit', () => {
    const { result, onRename } = setup()
    act(() => result.current.handleRenameStart())
    act(() => result.current.setEditValue('Renamed'))
    act(() => result.current.handleRenameSubmit())

    expect(onRename).toHaveBeenCalledWith('Renamed')
    expect(result.current.isEditing).toBe(false)
  })

  it('does not call onRename when title is unchanged', () => {
    const { result, onRename } = setup()
    act(() => result.current.handleRenameStart())
    act(() => result.current.handleRenameSubmit())

    expect(onRename).not.toHaveBeenCalled()
    expect(result.current.isEditing).toBe(false)
  })

  it('falls back to "New Chat" when value is whitespace', () => {
    const { result, onRename } = setup()
    act(() => result.current.handleRenameStart())
    act(() => result.current.setEditValue('   '))
    act(() => result.current.handleRenameSubmit())

    expect(onRename).toHaveBeenCalledWith('New Chat')
  })

  it('does not call onRename on cancel', () => {
    const { result, onRename } = setup()
    act(() => result.current.handleRenameStart())
    act(() => result.current.setEditValue('Changed'))
    act(() => result.current.handleRenameCancel())

    expect(onRename).not.toHaveBeenCalled()
    expect(result.current.isEditing).toBe(false)
  })

  it('does not call onRename on submit after cancel (blur guard)', () => {
    const { result, onRename } = setup()
    act(() => result.current.handleRenameStart())
    act(() => result.current.setEditValue('Changed'))
    act(() => result.current.handleRenameCancel())
    act(() => result.current.handleRenameSubmit())

    expect(onRename).not.toHaveBeenCalled()
  })

  it('works on first attempt after a cancel', () => {
    const { result, onRename } = setup()

    // Cancel first attempt
    act(() => result.current.handleRenameStart())
    act(() => result.current.handleRenameCancel())

    // Second attempt should work
    act(() => result.current.handleRenameStart())
    act(() => result.current.setEditValue('After Cancel'))
    act(() => result.current.handleRenameSubmit())

    expect(onRename).toHaveBeenCalledWith('After Cancel')
  })
})
