/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getKnownImageSupport, imageSupportKey, setCachedImageSupport } from '@/ai/image-support'
import { defaultDeliveryMode } from '@/files/transformers'
import { getAttachments } from '@/lib/attachments'
import type { FetchFn } from '@/lib/proxy-fetch'
import { useProxyFetchGetter } from '@/lib/proxy-fetch-context'
import type { AttachmentData, Model, ThunderboltUIMessage } from '@/types'
import { type ImageSupport, staticImageSupport } from '@shared/defaults/models'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'

/** What the composer shows about image support, and whether the user can overrule it. */
export type ImageSupportCheck = {
  /** Banner above the composer. The send is held while one is showing. */
  readonly notice: 'checking' | 'unsupported' | undefined
  /** Accept images for this model anyway. Offered only when detection, not a fixed rule, ruled them out. */
  readonly tryAnyway: (() => void) | undefined
}

type DetectImageSupport = (model: Model, getProxyFetch: () => FetchFn) => Promise<ImageSupport>

/** Loads detection on demand so its catalog and probe code stays off the chat entry chunk. */
const detectOnDemand: DetectImageSupport = async (model, getProxyFetch) => {
  const { detectImageSupport } = await import('@/ai/image-support-detection')
  return detectImageSupport(model, getProxyFetch)
}

/** True for attachments sent to the model as raw image bytes, the only kind that needs image support. */
export const isImageAttachment = (attachment: Pick<AttachmentData, 'mimeType'>): boolean =>
  attachment.mimeType.startsWith('image/') && defaultDeliveryMode(attachment.mimeType) === undefined

const noCheck: ImageSupportCheck = { notice: undefined, tryAnyway: undefined }

type UseImageSupportCheckOptions = {
  model: Model
  /** Images attached in the composer but not sent yet. */
  attachments: AttachmentData[]
  /** The thread so far. A live agent session resends its earlier images on every
   *  turn, so a thread with images needs a verdict even when the draft has none. */
  messages: ThunderboltUIMessage[]
  /** Whether the user has started a message. Thread images alone wait for this, so
   *  opening an old thread doesn't spend a probe the user may never need. */
  hasDraft: boolean
  /** False for agents that deliver files themselves, which skips the check. */
  enabled: boolean
  /** Test seam for the detection call. */
  detect?: DetectImageSupport
}

/**
 * Checks whether the selected model can read images, starting as soon as an
 * image is attached, or once the user starts a message in a thread that already
 * has one. Runs at most once per model per device (see `image-support.ts`), and
 * again when the user switches to a model that hasn't been checked. The send is
 * held while checking; a verdict of "unsupported" blocks it only when the draft
 * itself has an image, since history images are simply dropped for such models.
 * A check that can't reach a verdict lets the send go ahead. That outcome isn't
 * cached, so it runs again after a reload or a composer remount (not on focus).
 */
export const useImageSupportCheck = ({
  model,
  attachments,
  messages,
  hasDraft,
  enabled,
  detect = detectOnDemand,
}: UseImageSupportCheckOptions): ImageSupportCheck => {
  const getProxyFetch = useProxyFetchGetter()
  const queryClient = useQueryClient()
  const queryKey = ['image-support', imageSupportKey(model)]
  const hasDraftImage = attachments.some(isImageAttachment)
  const hasHistoryImage = useMemo(
    () => messages.some((message) => getAttachments(message).some(isImageAttachment)),
    [messages],
  )
  const isCheckNeeded = enabled && (hasDraftImage || (hasHistoryImage && hasDraft))

  const query = useQuery({
    queryKey,
    queryFn: async () => {
      try {
        return await detect(model, getProxyFetch)
      } catch (error) {
        console.warn(`Couldn't tell whether ${model.model} reads images; sending anyway`, error)
        throw error
      }
    },
    enabled: isCheckNeeded,
    initialData: () => getKnownImageSupport(model),
    staleTime: Infinity,
    retry: false,
    // A failed check has no data, so Query treats it as stale regardless of
    // staleTime. Without these, every window focus would re-run the probe, which
    // can be a paid inference call.
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })

  if (!isCheckNeeded) {
    return noCheck
  }
  if (!query.data) {
    return query.isError ? noCheck : { notice: 'checking', tryAnyway: undefined }
  }
  if (query.data === 'supported' || !hasDraftImage) {
    return noCheck
  }
  const isOverridable = staticImageSupport(model) === undefined
  return {
    notice: 'unsupported',
    tryAnyway: isOverridable
      ? () => {
          setCachedImageSupport(model, 'supported')
          queryClient.setQueryData(queryKey, 'supported')
        }
      : undefined,
  }
}
