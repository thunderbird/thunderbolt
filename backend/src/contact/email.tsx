/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ContactSubmission } from './body'

/** Internal notification: React escapes every visitor-supplied value. */
export const ContactEmail = ({ submission }: { submission: ContactSubmission }) => (
  <html lang="en">
    <body style={{ fontFamily: 'sans-serif', lineHeight: 1.6 }}>
      <h1>Thunderbolt website inquiry</h1>
      <dl>
        <dt>Email</dt>
        <dd>{submission.email}</dd>
        <dt>Name</dt>
        <dd>{[submission.firstName, submission.lastName].filter(Boolean).join(' ') || 'Not provided'}</dd>
        <dt>Organization</dt>
        <dd>{submission.org || 'Not provided'}</dd>
        <dt>Job title</dt>
        <dd>{submission.title || 'Not provided'}</dd>
        <dt>Company size</dt>
        <dd>{submission.companySize || 'Not provided'}</dd>
      </dl>
      <h2>How can we help?</h2>
      <p style={{ whiteSpace: 'pre-wrap' }}>{submission.help || 'Not provided'}</p>
    </body>
  </html>
)
