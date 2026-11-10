/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLingui } from '@lingui/react/macro'
import { ArrowRight, Globe } from 'lucide-react'
import { useRef, useState, type FormEvent, type RefObject } from 'react'
import { Input } from '@/components/ui/input'
import { BrowserToolbarButton } from './browser-toolbar-button'
import { resolveBrowserInput } from './browser-url'

type BrowserAddressBarProps = {
  url: string
  inputRef: RefObject<HTMLInputElement | null>
  disabled: boolean
  onNavigate: (url: string) => Promise<boolean>
}

/** Keep an unfinished address edit intact while the page redirects or updates. */
export const BrowserAddressBar = ({ url, inputRef, disabled, onNavigate }: BrowserAddressBarProps) => {
  const { t } = useLingui()
  const [draft, setDraft] = useState<string | null>(null)
  const target = resolveBrowserInput(draft ?? url)
  const draftRevision = useRef(0)
  const selectAfterClick = useRef(false)
  const resetDraft = () => {
    draftRevision.current += 1
    setDraft(null)
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (disabled || !target) {
      return
    }
    const submittedRevision = draftRevision.current
    if (await onNavigate(target)) {
      if (submittedRevision !== draftRevision.current) {
        return
      }
      resetDraft()
      inputRef.current?.blur()
    }
  }
  return (
    <div className="min-w-0 flex-1">
      <form
        onSubmit={submit}
        onBlur={(event) => {
          // Keep the draft through input → Go focus changes so clicks submit the edit.
          if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) {
            return
          }
          resetDraft()
        }}
        className="relative flex min-w-0 items-center gap-1"
      >
        <Globe className="pointer-events-none absolute left-2.5 size-3.5 text-muted-foreground" aria-hidden="true" />
        <Input
          ref={inputRef}
          aria-label={t`Address`}
          placeholder={t`Enter a URL`}
          inputSize="sm"
          className="h-9 pl-8 pr-9 text-sm"
          value={draft ?? url}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          onMouseDown={(event) => {
            if (document.activeElement !== event.currentTarget || !document.hasFocus()) {
              // Prevent WebKit's mouse-up caret placement from collapsing the
              // select-all performed when the address field receives focus.
              event.preventDefault()
              selectAfterClick.current = true
              event.currentTarget.focus()
              event.currentTarget.select()
            }
          }}
          onClick={(event) => {
            // Native text inputs can collapse the focus selection before click.
            if (selectAfterClick.current) {
              event.currentTarget.select()
            }
            selectAfterClick.current = false
          }}
          onFocus={(event) => {
            selectAfterClick.current = true
            draftRevision.current += 1
            setDraft(event.currentTarget.value)
            event.currentTarget.select()
          }}
          onChange={(event) => {
            draftRevision.current += 1
            setDraft(event.currentTarget.value)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              resetDraft()
              event.currentTarget.blur()
            }
          }}
        />
        <div className="absolute right-1 flex items-center">
          <BrowserToolbarButton
            type="submit"
            label={t`Go`}
            disabled={disabled || !target}
            onMouseDown={(event) => {
              // WebKit does not focus clicked buttons: without this, the input
              // blurs to the body and clears its draft before the form submits.
              event.preventDefault()
            }}
          >
            <ArrowRight className="size-4" />
          </BrowserToolbarButton>
        </div>
      </form>
    </div>
  )
}
