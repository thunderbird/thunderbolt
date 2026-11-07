/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from 'zod'

export const contactBodySchema = z.strictObject({
  email: z.string().trim().max(254).pipe(z.email()),
  firstName: z.string().trim().max(150).optional(),
  lastName: z.string().trim().max(150).optional(),
  title: z.string().trim().max(150).optional(),
  org: z.string().trim().max(200).optional(),
  help: z.string().trim().max(5000).optional(),
  companySize: z.enum(['', '1 to 50', '51 to 200', '201 to 1,000', '1,001+']).optional(),
  website: z.literal('').optional(),
})

export type ContactSubmission = z.infer<typeof contactBodySchema>
