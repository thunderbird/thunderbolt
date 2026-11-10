/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from 'zod'

/** Bound page-provided text before it enters composer state or model context. */
const boundedText = (length: number) => z.string().transform((value) => value.slice(0, length))

const browserElementSelectionSchema = z.object({
  url: boundedText(4_096),
  title: boundedText(256),
  element: z.object({
    id: z.string().min(1).max(256),
    label: boundedText(256),
    text: boundedText(8_000),
    rect: z.object({
      x: z.number().finite(),
      y: z.number().finite(),
      width: z.number().finite().nonnegative(),
      height: z.number().finite().nonnegative(),
    }),
    data: z
      .object({
        selector: boundedText(512).optional(),
        tag: boundedText(64).optional(),
        role: boundedText(64).optional(),
        href: boundedText(4_096).optional(),
      })
      .optional(),
  }),
})

export type BrowserElementSelection = z.infer<typeof browserElementSelectionSchema>

const browserPickerResultSchema = z.union([
  z.null(),
  z.object({ cancelled: z.literal(true) }),
  browserElementSelectionSchema,
])

/** Validate native picker results, whose contents originate in an untrusted page. */
export const parseBrowserPickerResult = (value: unknown) => browserPickerResultSchema.parse(value)

/** Preserve the selected passage and its actionable browser reference in the existing quote format. */
export const toBrowserElementPassage = (selection: BrowserElementSelection, tabId: string): string => {
  const { element, url, title } = selection
  const reference = {
    tabId,
    elementRef: element.id,
    url,
    title,
    ...element.data,
  }
  return `${element.label}\n${element.text}\nBrowser reference: ${JSON.stringify(reference)}`
}
