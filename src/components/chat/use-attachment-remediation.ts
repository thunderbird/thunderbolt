/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getTransformer, hasTransformer } from '@/files/transformers'
import { getAttachments, isAttachmentPart } from '@/lib/attachments'
import { isContentRejectionError } from '@/lib/error-utils'
import { getAttachment } from '@/lib/file-blob-storage'
import type { AttachmentData, ThunderboltUIMessage } from '@/types'
import { useCallback, useEffect, useMemo, useRef } from 'react'

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

/** Decide the next delivery mode for one attachment, inspecting its text layer on the first hop. */
const pickTarget = async (attachment: AttachmentData): Promise<DeliverAs | null> => {
  const canText = hasTransformer(attachment.mimeType, 'text')
  const canImages = hasTransformer(attachment.mimeType, 'images')
  // Only the native→? hop needs to distinguish a digital doc from a scan.
  const hasUsableText = canText && attachment.deliverAs === undefined ? await hasExtractableText(attachment) : false
  return nextRemediationTarget(attachment.deliverAs, { canText, canImages, hasUsableText })
}

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
  /** Manual "convert to text & retry" handler, present only when it would change something. */
  onRetryAsText?: () => void
  /** Manual "send as images & retry" handler, present only when it would change something. */
  onRetryAsImages?: () => void
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

  // Auto-remediation: when a content-rejection settles, advance each attachment
  // one rung and retry. The signature (message id + each attachment's current
  // delivery mode) is recorded so a given state is auto-attempted at most once;
  // since each retry advances toward the terminal `images` state, the chain is
  // finite. Reacts to an external (chat SDK) error event, hence an effect.
  const attemptedSignatures = useRef(new Set<string>())
  useEffect(() => {
    if (!active || !isContentRejectionError(error) || !lastUserMessage) {
      return
    }
    const attachments = getAttachments(lastUserMessage)
    if (attachments.length === 0) {
      return
    }
    const signature = `${lastUserMessage.id}:${attachments.map((a) => a.deliverAs ?? 'native').join(',')}`
    if (attemptedSignatures.current.has(signature)) {
      return
    }
    attemptedSignatures.current.add(signature)

    void (async () => {
      const decisions = new Map<string, DeliverAs>()
      await Promise.all(
        attachments.map(async (attachment) => {
          const target = await pickTarget(attachment)
          if (target) {
            decisions.set(attachment.localFileId, target)
          }
        }),
      )
      if (decisions.size > 0) {
        applyTargets(lastUserMessage.id, (attachment) => decisions.get(attachment.localFileId) ?? null)
      }
    })()
  }, [active, error, lastUserMessage, applyTargets])

  const manualRetryAs = (target: DeliverAs) => {
    if (
      !lastUserMessage ||
      !getAttachments(lastUserMessage).some((a) => a.deliverAs !== target && hasTransformer(a.mimeType, target))
    ) {
      return undefined
    }
    return () =>
      applyTargets(lastUserMessage.id, (attachment) =>
        hasTransformer(attachment.mimeType, target) && attachment.deliverAs !== target ? target : null,
      )
  }

  return {
    onRetryAsText: manualRetryAs('text'),
    onRetryAsImages: manualRetryAs('images'),
  }
}
