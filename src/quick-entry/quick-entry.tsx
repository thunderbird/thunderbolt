/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import logoSrc from '@/assets/logo.svg'
import { FileCard } from '@/components/chat/file-card'
import { ModelSelector, ModelSelectorTrigger } from '@/components/ui/model-selector'
import { PickerTrigger } from '@/components/ui/picker-trigger'
import { PromptInput } from '@/components/ui/prompt-input'
import { useLingui } from '@lingui/react/macro'
import { QuickEntryChatList } from './quick-entry-chat-list'
import { type FittedWindow, useFitWindowToContent } from './use-fit-window-to-content'
import { type QuickEntryWindow, useQuickEntryState } from './use-quick-entry-state'

type QuickEntryProps = {
  quickEntryWindow?: QuickEntryWindow & FittedWindow
  hideApp?: () => Promise<void>
}

/**
 * The menu bar prompt: the chat composer's input, with the app mark and a chat
 * picker where the composer keeps its add menu, and a model picker for a new
 * chat. The window grows and shrinks with the text.
 *
 * Pasted images and files preview above the input, as in the composer.
 *
 * The pickers open their lists inline above the input rather than in a popover:
 * the window is only as tall as the panel, so a popover would be clipped, while
 * an inline list grows the panel and the window with it.
 */
export const QuickEntry = ({ quickEntryWindow, hideApp }: QuickEntryProps) => {
  const { t } = useLingui()
  const {
    prompt,
    setPrompt,
    models,
    selectedModel,
    selectModel,
    chats,
    selectedChat,
    selectChat,
    openPicker,
    togglePicker,
    closePicker,
    attachments,
    attachError,
    handlePaste,
    removeAttachment,
    canSubmit,
    submit,
    handleKeyDown,
    panelRef,
  } = useQuickEntryState({ quickEntryWindow, hideApp })
  useFitWindowToContent(panelRef, quickEntryWindow)

  const pickerList =
    openPicker === 'chat' ? (
      <QuickEntryChatList
        chats={chats}
        selectedChatId={selectedChat?.id ?? null}
        onSelect={selectChat}
        onClose={closePicker}
      />
    ) : openPicker === 'model' ? (
      <ModelSelector
        embedded
        models={models}
        selectedModel={selectedModel}
        chatThread={null}
        onModelChange={selectModel}
        onClose={closePicker}
      />
    ) : null

  return (
    <PromptInput
      ref={panelRef}
      value={prompt}
      onChange={setPrompt}
      onSubmit={() => void submit()}
      onTextareaKeyDown={handleKeyDown}
      submitOnEnter
      autoFocus
      placeholder={t`Ask me anything…`}
      // self-start: #root is a stretching flex row, and the window is sized
      // from this element's height, so it must not take the window's height.
      className="flex w-full flex-col gap-0 self-start rounded-3xl border border-border bg-sidebar p-2"
      onTextareaPaste={handlePaste}
      canSubmit={canSubmit}
      headerSlot={
        (pickerList || attachError || attachments.length > 0) && (
          <div className="flex flex-col gap-2 pb-2">
            {pickerList && <div className="border-b border-border pb-1">{pickerList}</div>}
            {attachError && (
              <p role="alert" className="px-1 text-[length:var(--font-size-sm)] text-destructive">
                {attachError}
              </p>
            )}
            {attachments.length > 0 && (
              <div className="flex flex-wrap items-start gap-2">
                {attachments.map((attachment) => (
                  <FileCard
                    key={attachment.localFileId}
                    localFileId={attachment.localFileId}
                    filename={attachment.filename}
                    mimeType={attachment.mimeType}
                    onRemove={() => removeAttachment(attachment.localFileId)}
                  />
                ))}
              </div>
            )}
          </div>
        )
      }
      footerStartElements={
        <>
          <img src={logoSrc} width={20} height={20} alt="" draggable={false} className="ml-1 shrink-0" />
          <button
            type="button"
            aria-expanded={openPicker === 'chat'}
            onClick={() => togglePicker('chat')}
            // The footer's start cluster cannot shrink, so cap the title here and let it ellipsize.
            className="min-w-0 max-w-64"
          >
            <PickerTrigger
              label={selectedChat?.title ?? t`New Chat`}
              isOpen={openPicker === 'chat'}
              variant="composer"
            />
          </button>
        </>
      }
      footerEndElements={
        models.length > 0 && (
          <button
            type="button"
            aria-expanded={openPicker === 'model'}
            onClick={() => togglePicker('model')}
            className="min-w-0"
          >
            <ModelSelectorTrigger model={selectedModel} isOpen={openPicker === 'model'} variant="composer" />
          </button>
        )
      }
    />
  )
}
