/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
const text = (max: number) => z.string().transform((value) => value.slice(0, max))
const rect = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative(),
})
/** Bound observations from sandboxed documents before exposing them to the agent. */
export const pageObservationSchema = z.object({
  url: text(8192),
  title: text(500),
  documentId: text(200),
  viewport: z.object({
    width: z.number().finite(),
    height: z.number().finite(),
    scrollX: z.number().finite(),
    scrollY: z.number().finite(),
  }),
  text: text(24000),
  elements: z
    .array(
      z.object({
        ref: text(200),
        tag: text(64),
        role: text(64),
        name: text(500),
        text: text(2000).optional(),
        value: text(2000).optional(),
        rect,
      }),
    )
    .max(250),
  screenshot: z
    .object({
      data: z.string().max(32 * 1024 * 1024),
      mediaType: z.literal('image/png'),
      width: z.number().positive().optional(),
      height: z.number().positive().optional(),
    })
    .optional(),
  warnings: z.array(text(1000)).max(20).optional(),
})
