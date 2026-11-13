/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from 'zod'

const optionalText = (maxLength: number) => z.string().trim().max(maxLength).optional()

/** The website contact form. Unknown keys are rejected, so a visitor cannot supply a recipient. */
export const contactBodySchema = z.strictObject({
  // The browser's own `type="email"` rule, so an address the form accepts is not refused here.
  email: z
    .string()
    .trim()
    .max(254)
    .pipe(z.email({ pattern: z.regexes.html5Email })),
  firstName: optionalText(150),
  lastName: optionalText(150),
  title: optionalText(150),
  org: optionalText(200),
  help: optionalText(5000),
  companySize: optionalText(50),
  // Honeypot: the form hides this field from people, so only a bot fills it in.
  website: z.literal('').optional(),
})

export type ContactSubmission = z.infer<typeof contactBodySchema>
