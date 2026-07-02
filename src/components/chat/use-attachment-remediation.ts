/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { defaultDeliveryMode, getTransformer, hasTransformer } from '@/files/transformers'
import { getAttachments, isAttachmentPart } from '@/lib/attachments'
import { isContentRejectionError } from '@/lib/error-utils'
import { getAttachment } from '@/lib/file-blob-storage'
import type { AttachmentData, ThunderboltUIMessage } from '@/types'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

type DeliverAs = 'text' | 'images'

/** Min trimmed chars of extracted text to treat a PDF as digital (vs a scan). */
const minUsefulTextLength = 16

/**
 * Pure escalation ladder: native (undefined) → text → images. Given the current
 * delivery mode and what each transformer can produce, returns the next mode to
 * try, or `null` when the chain is exhausted. `hasUsableText` lets the first hop
 * skip straight to images for scans (empty text layer).
 */
export const nextRemediationTarget = (
  deliverAs: DeliverAs | undefined,
  caps: { canText: boolean; canImages: boolean; hasUsableText: boolean },
): DeliverAs | null => {
  if (deliverAs === 'images') {
    return null
  }
  if (deliverAs === 'text') {
    return caps.canImages ? 'images' : null
  }
  if (caps.canText && caps.hasUsableText) {
    return 'text'
  }
  if (caps.canImages) {
    return 'images'
  }
  return caps.canText ? 'text' : null
}

/** True if the text transformer yields enough text to be worth sending (vs a scan). */
const hasExtractableText = async (attachment: AttachmentData): Promise<boolean> => {
  const file = await getAttachment(attachment.localFileId)
  const transformer = file ? await getTransformer(attachment.mimeType, 'text') : null
  if (!file || !transformer) {
    return false
  }
  const output = await transformer(file)
  return 'text' in output && output.text.trim().length >= minUsefulTextLength
}

/** The delivery mode CURRENTLY in effect: an explicit remediation override, else
 *  the type's default (plain-text mimes already go out as text via
 *  `defaultDeliveryMode`). Using this — not the raw `deliverAs` — as the ladder's
 *  starting rung means a plain-text file already delivered as text isn't treated
 *  as an un-tried "native" rung, so we don't pointlessly re-send text→text and then
 *  falsely mark it "couldn't read the file". */
const currentMode = (attachment: AttachmentData): DeliverAs | undefined =>
  attachment.deliverAs ?? defaultDeliveryMode(attachment.mimeType)

/** Decide the next delivery mode for one attachment, inspecting its text layer on the first hop. */
const pickTarget = async (attachment: AttachmentData): Promise<DeliverAs | null> => {
  const mode = currentMode(attachment)
  const canText = hasTransformer(attachment.mimeType, 'text')
  const canImages = hasTransformer(attachment.mimeType, 'images')
  // Only the native→? hop needs to distinguish a digital doc from a scan.
  const hasUsableText = canText && mode === undefined ? await hasExtractableText(attachment) : false
  return nextRemediationTarget(mode, { canText, canImages, hasUsableText })
}

/**
 * Synchronous, byte-free check of whether an attachment can still advance a rung
 * (text from native; images from native/text). Mirrors {@link nextRemediationTarget}
 * minus the scan inspection, so the UI can decide *during render* whether an
 * auto-remediation is coming — and suppress the error flash before it paints.
 */
const canAdvance = (attachment: AttachmentData): boolean => {
  const mode = currentMode(attachment)
  if (mode === 'images') {
    return false
  }
  if (mode === 'text') {
    return hasTransformer(attachment.mimeType, 'images')
  }
  return hasTransformer(attachment.mimeType, 'text') || hasTransformer(attachment.mimeType, 'images')
}

/** Identity of a turn's delivery state — changes each time an attachment advances a rung. */
const signatureOf = (message: ThunderboltUIMessage): string =>
  `${message.id}:${getAttachments(message)
    .map((a) => a.deliverAs ?? 'native')
    .join(',')}`

type SetMessages = (
  messages: ThunderboltUIMessage[] | ((prev: ThunderboltUIMessage[]) => ThunderboltUIMessage[]),
) => void

type UseAttachmentRemediationParams = {
  messages: ThunderboltUIMessage[]
  setMessages: SetMessages
  regenerate: () => void
  error?: Error | null
  /** True when an error is settled (not actively streaming/retrying) — gate for auto-fire. */
  active: boolean
}

type AttachmentRemediation = {
  /**
   * True while an auto-remediation is imminent or in flight — the caller should
   * hide the error UI (and show a loading state) so the brief error frame before
   * the automatic retry never paints.
   */
  suppressError: boolean
  /**
   * True when the failed turn carried an attachment the model couldn't read and
   * the delivery ladder is exhausted (no rung left to try). Lets the error UI
   * show file-specific guidance instead of the generic message.
   */
  deliveryExhausted: boolean
}

/**
 * Re-delivers a failed turn's attachments along the native → text → images
 * ladder. On a detected content-rejection it auto-advances and retries once per
 * delivery state (bounded by the terminal `images` step); the returned handlers
 * expose the same as manual escape hatches when the error wasn't classified.
 * Setting `deliverAs` on the attachment reference makes the next hydration emit
 * the chosen form, and `regenerate()` re-runs the turn.
 */
export const useAttachmentRemediation = ({
  messages,
  setMessages,
  regenerate,
  error,
  active,
}: UseAttachmentRemediationParams): AttachmentRemediation => {
  const lastUserMessage = useMemo(() => messages.findLast((m) => m.role === 'user'), [messages])

  const applyTargets = useCallback(
    (messageId: string, targetFor: (attachment: AttachmentData) => DeliverAs | null) => {
      setMessages((prev) =>
        prev.map((message) => {
          if (message.id !== messageId) {
            return message
          }
          return {
            ...message,
            parts: message.parts.map((part) => {
              if (!isAttachmentPart(part)) {
                return part
              }
              const target = targetFor(part.data)
              return target ? { ...part, data: { ...part.data, deliverAs: target } } : part
            }),
          }
        }),
      )
      regenerate()
    },
    [setMessages, regenerate],
  )

  // Auto-remediation: when a non-retryable 4xx settles on a turn carrying
  // attachments, advance each one a rung and retry — a client error on a request
  // with a file is the file being rejected. The signature (message id + each
  // attachment's current delivery mode) is recorded so a given state is
  // auto-attempted at most once; since each retry advances toward the terminal
  // `images` state, the chain is finite. Reacts to an external (chat SDK) error
  // event, hence an effect.
  const attemptedSignatures = useRef(new Set<string>())
  const [remediating, setRemediating] = useState(false)

  // Only a genuine content rejection (the endpoint couldn't carry the file's
  // form — a 400/422) is worth remediating. Auth (401/403), not-found, timeouts,
  // rate limits, and context overflow are all excluded by isContentRejectionError
  // — converting native→text/images can't fix those, and churning the ladder
  // would end in a misleading "couldn't read the file" message.
  const isRemediableError = isContentRejectionError(error)

  // If a content-rejection error is already present on the FIRST render, it's a
  // stale failure from a reopened/remounted thread, not a fresh send — record its
  // signature synchronously so we neither auto-remediate (re-running a turn the
  // user already saw fail) nor leave its error hidden. Only errors that appear
  // *after* mount are treated as new. (Synchronous ref init in render body, per
  // the React ref-assignment pattern.)
  const seeded = useRef(false)
  if (!seeded.current) {
    seeded.current = true
    if (active && isRemediableError && lastUserMessage) {
      attemptedSignatures.current.add(signatureOf(lastUserMessage))
    }
  }

  // Whether an auto-remediation is *about* to fire — computed synchronously so
  // the error UI can be suppressed on the very first error frame, before the
  // effect below runs. Mirrors the effect's gate (minus the async scan check).
  const willAutoRemediate =
    active &&
    isRemediableError &&
    !!lastUserMessage &&
    getAttachments(lastUserMessage).some(canAdvance) &&
    !attemptedSignatures.current.has(signatureOf(lastUserMessage))

  useEffect(() => {
    // Error cleared (e.g. the retry started streaming) — end the suppression window.
    if (!active) {
      setRemediating(false)
      return
    }
    if (!isRemediableError || !lastUserMessage) {
      return
    }
    // A remediation we initiated is still in flight: applyTargets has bumped an
    // attachment's deliverAs (changing the turn signature) and called regenerate(),
    // but the retry hasn't started streaming yet so `active` is still true. Without
    // this guard the effect would re-fire on the new signature and advance another
    // rung (native→text→images) in one go, skipping the intermediate text retry.
    // It clears when the retry streams (`!active` branch) or the attempt finds nothing.
    if (remediating) {
      return
    }
    const attachments = getAttachments(lastUserMessage)
    if (!attachments.some(canAdvance)) {
      return
    }
    const signature = signatureOf(lastUserMessage)
    if (attemptedSignatures.current.has(signature)) {
      return
    }
    attemptedSignatures.current.add(signature)
    setRemediating(true)

    void (async () => {
      const decisions = new Map<string, DeliverAs>()
      try {
        await Promise.all(
          attachments.map(async (attachment) => {
            const target = await pickTarget(attachment)
            if (target) {
              decisions.set(attachment.localFileId, target)
            }
          }),
        )
      } catch (err) {
        // A transformer (PDF text inspection, rasterization) threw — abandon the
        // auto-attempt and surface the original error rather than hang on a
        // permanent loading state with no retry.
        console.error('Attachment remediation failed:', err)
        setRemediating(false)
        return
      }
      if (decisions.size > 0) {
        applyTargets(lastUserMessage.id, (attachment) => decisions.get(attachment.localFileId) ?? null)
      } else {
        // Nothing to send (e.g. the file vanished) — surface the error after all.
        setRemediating(false)
      }
    })()
  }, [active, error, isRemediableError, lastUserMessage, applyTargets, remediating])

  // The turn failed with a file the model couldn't read and there's no rung left
  // to try automatically — surface file-specific guidance rather than a retry.
  // (Excludes context-overflow, which has its own message.)
  const deliveryExhausted =
    active &&
    isRemediableError &&
    !!lastUserMessage &&
    getAttachments(lastUserMessage).length > 0 &&
    !getAttachments(lastUserMessage).some(canAdvance)

  return {
    suppressError: willAutoRemediate || remediating,
    deliveryExhausted,
  }
}
