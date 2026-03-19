import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useEffect, useRef, useState } from 'react'

type RenameChatDialogProps = {
  open: boolean
  title: string | null
  onOpenChange: (open: boolean) => void
  onRename: (title: string) => void
}

export const RenameChatDialog = ({ open, title, onOpenChange, onRename }: RenameChatDialogProps) => {
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setValue(title ?? 'New Chat')
    }
  }, [open, title])

  const handleSave = () => {
    const trimmed = value.trim()
    const newTitle = trimmed || 'New Chat'
    if (newTitle !== (title ?? 'New Chat')) {
      onRename(newTitle)
    }
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="top-[30%]"
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          inputRef.current?.focus()
          inputRef.current?.select()
        }}
      >
        <DialogHeader>
          <DialogTitle>Rename chat</DialogTitle>
        </DialogHeader>
        <Input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              handleSave()
            }
          }}
          placeholder="Chat name"
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
