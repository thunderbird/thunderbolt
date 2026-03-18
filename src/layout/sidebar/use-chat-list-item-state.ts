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
  const [optimisticTitle, setOptimisticTitle] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const cancelledRef = useRef(false)

  useEffect(() => {
    if (optimisticTitle !== null && title === optimisticTitle) {
      setOptimisticTitle(null)
    }
  }, [title, optimisticTitle])

  useEffect(() => {
    if (!isEditing) {
      return
    }
    // setTimeout is needed (not rAF) because Radix dropdown restores focus
    // to the trigger after closing — setTimeout defers past that restoration
    const timer = setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
    return () => clearTimeout(timer)
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
      setOptimisticTitle(newTitle)
      onRename(newTitle)
    }
    setIsEditing(false)
  }

  const handleRenameCancel = () => {
    cancelledRef.current = true
    setIsEditing(false)
  }

  const displayTitle = optimisticTitle ?? title

  return {
    isEditing,
    editValue,
    setEditValue,
    displayTitle,
    inputRef,
    handleRenameStart,
    handleRenameSubmit,
    handleRenameCancel,
  }
}
