/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, mock, test } from 'bun:test'
import { act, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { buildAttachmentPart, getAttachments } from '@/lib/attachments'
import { getClock } from '@/testing-library'
import type { ThunderboltUIMessage } from '@/types'

import { nextRemediationTarget, useAttachmentRemediation } from './use-attachment-remediation'

describe('useAttachmentRemediation', () => {
  test.each([
    {
      label: 'tool-schema rejection keeps the error visible without converting or regenerating',
      message:
        '400: {"message":"tools must not be an empty array","type":"BadRequestError","param":"tools","code":400}',
      delivery: 'text' as const,
      expectedDelivery: 'text',
      expectedRegenerations: 0,
    },
    {
      label: 'tool-schema rejection does not claim the file delivery ladder was exhausted',
      message:
        '400: {"message":"tools must not be an empty array","type":"BadRequestError","param":"tools","code":400}',
      delivery: 'images' as const,
      expectedDelivery: 'images',
      expectedRegenerations: 0,
    },
    {
      label: 'genuine file rejection advances text to images and regenerates once',
      message: '400: invalid file content',
      delivery: 'text' as const,
      expectedDelivery: 'images',
      expectedRegenerations: 1,
    },
  ])('$label', async ({ message, delivery, expectedDelivery, expectedRegenerations }) => {
    const regenerate = mock(() => {})
    const error = new Error(message)
    const { result, rerender } = renderHook(
      ({ active }) => {
        const [messages, setMessages] = useState<ThunderboltUIMessage[]>([
          {
            id: 'user-1',
            role: 'user',
            parts: [
              buildAttachmentPart({
                localFileId: 'pdf-1',
                filename: 'research.pdf',
                mimeType: 'application/pdf',
                deliverAs: delivery,
              }),
            ],
          },
        ])
        const remediation = useAttachmentRemediation({ messages, setMessages, regenerate, error, active })
        return { messages, ...remediation }
      },
      { initialProps: { active: false } },
    )

    rerender({ active: true })
    await act(async () => {
      await getClock().runAllAsync()
    })

    expect(getAttachments(result.current.messages[0])[0].deliverAs).toBe(expectedDelivery)
    expect(regenerate).toHaveBeenCalledTimes(expectedRegenerations)
    expect(result.current.suppressError).toBe(expectedRegenerations > 0)
    expect(result.current.deliveryExhausted).toBe(expectedRegenerations > 0)
  })
})

describe('nextRemediationTarget', () => {
  const caps = (over: Partial<{ canText: boolean; canImages: boolean; hasUsableText: boolean }> = {}) => ({
    canText: true,
    canImages: true,
    hasUsableText: true,
    ...over,
  })

  test('native digital doc → text', () => {
    expect(nextRemediationTarget(undefined, caps())).toBe('text')
  })

  test('native scan (no usable text) → images', () => {
    expect(nextRemediationTarget(undefined, caps({ hasUsableText: false }))).toBe('images')
  })

  test('native with only text transformer → text even if extraction looked empty', () => {
    expect(nextRemediationTarget(undefined, caps({ canImages: false, hasUsableText: false }))).toBe('text')
  })

  test('native with only images transformer → images', () => {
    expect(nextRemediationTarget(undefined, caps({ canText: false, hasUsableText: false }))).toBe('images')
  })

  test('native with no transformers → null', () => {
    expect(
      nextRemediationTarget(undefined, caps({ canText: false, canImages: false, hasUsableText: false })),
    ).toBeNull()
  })

  test('text failed → escalate to images', () => {
    expect(nextRemediationTarget('text', caps())).toBe('images')
  })

  test('text failed with no images transformer → null', () => {
    expect(nextRemediationTarget('text', caps({ canImages: false }))).toBeNull()
  })

  test('images is terminal', () => {
    expect(nextRemediationTarget('images', caps())).toBeNull()
  })
})
