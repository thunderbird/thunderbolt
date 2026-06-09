/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { cn, isValidEmailFormat } from '@/lib/utils'
import { X } from 'lucide-react'
import { type ClipboardEvent, type KeyboardEvent, useId, useRef, useState } from 'react'

const separatorRegex = /[\s,;]+/

const normalize = (email: string): string => email.toLowerCase().trim()

type EmailChipInputProps = {
  value: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  disabled?: boolean
  className?: string
  /** Optional id for the visible input (use to associate a <label>). */
  inputId?: string
}

/**
 * Multi-email entry input — emails commit to chips on `,` / space / Enter or
 * blur. Backspace at the empty input pops the last chip. Pasted text is split
 * on commas / whitespace / semicolons and each token validated.
 *
 * Controlled: `value: string[]` + `onChange(next)`. Values are stored
 * normalized (lowercased + trimmed) and duplicates within the array are
 * silently dropped — match the BE's `normalizeEmail` so the same email entered
 * twice doesn't produce two pending rows.
 *
 * Invalid input stays in the text field with an `aria-invalid` ring + an
 * inline message under the field; the parent isn't notified until the value
 * commits as a chip.
 */
export const EmailChipInput = ({
  value,
  onChange,
  placeholder = 'Enter emails…',
  disabled,
  className,
  inputId,
}: EmailChipInputProps) => {
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const autoId = useId()
  const fieldId = inputId ?? autoId

  const focusInput = () => inputRef.current?.focus()

  const addEmail = (raw: string): boolean => {
    const email = normalize(raw)
    if (!email) {
      return false
    }
    if (!isValidEmailFormat(email)) {
      setError(`"${raw.trim()}" is not a valid email`)
      return false
    }
    if (value.includes(email)) {
      // Already in the list — silently drop, clear draft.
      return true
    }
    onChange([...value, email])
    setError(null)
    return true
  }

  const commitDraft = (): boolean => {
    const trimmed = draft.trim()
    if (!trimmed) {
      return true
    }
    if (addEmail(trimmed)) {
      setDraft('')
      return true
    }
    return false
  }

  const removeAt = (index: number) => {
    const next = value.slice()
    next.splice(index, 1)
    onChange(next)
    setError(null)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',' || event.key === ' ') {
      event.preventDefault()
      commitDraft()
      return
    }
    if (event.key === 'Backspace' && draft === '' && value.length > 0) {
      event.preventDefault()
      removeAt(value.length - 1)
    }
  }

  const handlePaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData('text')
    if (!text || !separatorRegex.test(text)) {
      return
    }
    event.preventDefault()
    const tokens = text.split(separatorRegex).filter(Boolean)
    if (tokens.length === 0) {
      return
    }
    const accepted: string[] = []
    const rejected: string[] = []
    const seen = new Set(value)
    for (const token of tokens) {
      const email = normalize(token)
      if (!email) {
        continue
      }
      if (!isValidEmailFormat(email)) {
        rejected.push(token.trim())
        continue
      }
      if (seen.has(email)) {
        continue
      }
      seen.add(email)
      accepted.push(email)
    }
    if (accepted.length > 0) {
      onChange([...value, ...accepted])
    }
    if (rejected.length > 0) {
      setError(`Could not add: ${rejected.join(', ')}`)
    } else {
      setError(null)
    }
    setDraft('')
  }

  const handleBlur = () => {
    commitDraft()
  }

  return (
    <div className={className}>
      <div
        onClick={focusInput}
        className={cn(
          'flex w-full flex-wrap items-center gap-1.5 rounded-lg border border-input bg-transparent px-2 py-1.5 text-left cursor-text',
          'min-h-[var(--touch-height-default)]',
          'focus-within:border-ring focus-within:ring-ring/50 focus-within:ring-[3px]',
          error && 'border-destructive focus-within:border-destructive focus-within:ring-destructive/20',
          disabled && 'pointer-events-none cursor-not-allowed opacity-50',
        )}
        aria-invalid={error ? 'true' : undefined}
      >
        {value.map((email, index) => (
          <span
            key={email}
            data-testid={`email-chip-${email}`}
            className="inline-flex items-center gap-1 rounded-md bg-accent px-2 py-0.5 text-[length:var(--font-size-xs)] text-accent-foreground"
          >
            <span>{email}</span>
            <button
              type="button"
              aria-label={`Remove ${email}`}
              onClick={(e) => {
                e.stopPropagation()
                removeAt(index)
              }}
              className="inline-flex items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          id={fieldId}
          type="text"
          inputMode="email"
          autoComplete="email"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
            if (error) {
              setError(null)
            }
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onBlur={handleBlur}
          disabled={disabled}
          placeholder={value.length === 0 ? placeholder : undefined}
          className="flex-1 min-w-[8ch] bg-transparent outline-none text-[length:var(--font-size-body)] placeholder:text-muted-foreground"
        />
      </div>
      {error && (
        <p role="alert" className="mt-1.5 text-[length:var(--font-size-xs)] text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
