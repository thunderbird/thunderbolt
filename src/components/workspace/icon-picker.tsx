/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { EmojiPicker } from 'frimousse'
import { ImagePlus, Pencil, Smile, Trash2 } from 'lucide-react'
import { useRef, useState } from 'react'
import { isDataUrlIcon, resizeImageToBase64 } from './icon-utils'

type IconPickerProps = {
  /** Current icon — emoji string or `data:image/...` URL. `null` = no icon set. */
  value: string | null
  /** Fired with the new icon value, or `null` to clear. */
  onChange: (next: string | null) => void
  /** Placeholder rendered inside the square when no icon is set. */
  placeholder?: string
  className?: string
}

type PickerView = 'menu' | 'emoji'

export const IconPicker = ({ value, onChange, placeholder, className }: IconPickerProps) => {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<PickerView>('menu')
  const [uploadError, setUploadError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Single close path — resets the inner view + error state. Radix only fires
  // `onOpenChange` for user-initiated transitions, so closing the popover from
  // an action handler must reset the view explicitly or the picker reopens
  // back into emoji mode on the next click.
  const closePopover = () => {
    setOpen(false)
    setView('menu')
    setUploadError(null)
  }

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      closePopover()
      return
    }
    setOpen(true)
  }

  const handleEmojiSelect = (emoji: string) => {
    onChange(emoji)
    closePopover()
  }

  const handleFile = async (file: File) => {
    setUploadError(null)
    try {
      const dataUrl = await resizeImageToBase64(file)
      onChange(dataUrl)
      closePopover()
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Failed to process image.')
    }
  }

  const triggerFilePicker = () => {
    fileInputRef.current?.click()
  }

  const handleRemove = () => {
    onChange(null)
    closePopover()
  }

  return (
    <div className={cn('relative size-20 shrink-0', className)}>
      <div className="size-20 rounded-xl bg-muted flex items-center justify-center overflow-hidden text-3xl">
        {isDataUrlIcon(value) ? (
          <img src={value} alt="" className="size-full object-cover" />
        ) : value ? (
          <span aria-hidden>{value}</span>
        ) : (
          <span aria-hidden className="text-muted-foreground text-2xl font-semibold">
            {placeholder ?? '?'}
          </span>
        )}
      </div>

      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant="secondary"
            className="absolute -bottom-2 -right-2 size-8 rounded-full shadow-md"
            aria-label="Edit icon"
          >
            <Pencil className="size-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" sideOffset={8} className="p-2 w-auto min-w-56">
          {view === 'menu' ? (
            <div className="flex flex-col gap-1">
              <Button type="button" variant="ghost" className="justify-start" onClick={() => setView('emoji')}>
                <Smile className="size-4" />
                Pick emoji
              </Button>
              <Button type="button" variant="ghost" className="justify-start" onClick={triggerFilePicker}>
                <ImagePlus className="size-4" />
                Upload image
              </Button>
              {value !== null && (
                <Button
                  type="button"
                  variant="ghost"
                  className="justify-start text-destructive hover:text-destructive"
                  onClick={handleRemove}
                >
                  <Trash2 className="size-4" />
                  Remove
                </Button>
              )}
              {uploadError && (
                <p className="px-3 pt-1 text-xs text-destructive" role="alert">
                  {uploadError}
                </p>
              )}
            </div>
          ) : (
            <EmojiPicker.Root
              className="isolate flex flex-col h-[340px] w-[280px]"
              onEmojiSelect={({ emoji }) => handleEmojiSelect(emoji)}
            >
              <EmojiPicker.Search
                className="z-10 mx-1 mt-1 appearance-none rounded-md border border-input bg-transparent px-2 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
                placeholder="Search emoji"
              />
              <EmojiPicker.Viewport className="relative flex-1 outline-hidden mt-1">
                <EmojiPicker.Loading className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                  Loading…
                </EmojiPicker.Loading>
                <EmojiPicker.Empty className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                  No emoji found
                </EmojiPicker.Empty>
                <EmojiPicker.List
                  className="select-none pb-1.5"
                  components={{
                    CategoryHeader: ({ category, ...props }) => (
                      <div className="bg-popover px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground" {...props}>
                        {category.label}
                      </div>
                    ),
                    Row: ({ children, ...props }) => (
                      <div className="scroll-my-1.5 px-1.5" {...props}>
                        {children}
                      </div>
                    ),
                    Emoji: ({ emoji, ...props }) => (
                      <button
                        type="button"
                        className="flex size-8 items-center justify-center rounded-md text-lg data-[active]:bg-accent"
                        {...props}
                      >
                        {emoji.emoji}
                      </button>
                    ),
                  }}
                />
              </EmojiPicker.Viewport>
            </EmojiPicker.Root>
          )}
        </PopoverContent>
      </Popover>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0]
          // Reset the input so re-selecting the same file fires onChange again.
          e.target.value = ''
          if (file) {
            void handleFile(file)
          }
        }}
      />
    </div>
  )
}
