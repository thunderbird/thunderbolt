/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Fragment } from 'react'
import type { ContactSubmission } from './body'

export const contactEmailSubject = 'Thunderbolt website inquiry'

/** Internal notification: React escapes every visitor-supplied value. */
export const ContactEmail = ({ submission }: { submission: ContactSubmission }) => {
  const details = [
    ['Email', submission.email],
    ['Name', [submission.firstName, submission.lastName].filter(Boolean).join(' ')],
    ['Organization', submission.org],
    ['Job title', submission.title],
    ['Company size', submission.companySize],
  ]

  return (
    <html lang="en">
      <body style={{ fontFamily: 'sans-serif', lineHeight: 1.6 }}>
        <h1>{contactEmailSubject}</h1>
        <dl>
          {details.map(([label, value]) => (
            <Fragment key={label}>
              <dt>{label}</dt>
              <dd>{value || 'Not provided'}</dd>
            </Fragment>
          ))}
        </dl>
        <h2>How can we help?</h2>
        <p style={{ whiteSpace: 'pre-wrap' }}>{submission.help || 'Not provided'}</p>
      </body>
    </html>
  )
}
