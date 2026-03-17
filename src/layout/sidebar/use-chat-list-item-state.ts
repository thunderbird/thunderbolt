import { useEffect, useRef, useState } from 'react'

type UseChatListItemStateParams = {
  title: string | null
  onRename: (title: string) => void
}

/**
 * Manages inline rename state for a chat list item.
 * Extracted from ChatListItem to separate logic from display and enable unit testing.
 */
export const useChatListItemState = ({ title, onRename }: UseChatListItemStateParams) => {
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const cancelledRef = useRef(false)

  useEffect(() => {
    if (!isEditing) {
      return
    }
    const frameId = requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return () => cancelAnimationFrame(frameId)
  }, [isEditing])

  const handleRenameStart = () => {
    cancelledRef.current = false
    setEditValue(title ?? 'New Chat')
    setIsEditing(true)
  }

  const handleRenameSubmit = () => {
    if (cancelledRef.current) {
      cancelledRef.current = false
      return
    }
    const trimmed = editValue.trim()
    const newTitle = trimmed || 'New Chat'
    if (newTitle !== (title ?? 'New Chat')) {
      onRename(newTitle)
    }
    setIsEditing(false)
  }

  const handleRenameCancel = () => {
    cancelledRef.current = true
    setIsEditing(false)
  }

  return {
    isEditing,
    editValue,
    setEditValue,
    inputRef,
    handleRenameStart,
    handleRenameSubmit,
    handleRenameCancel,
  }
}
