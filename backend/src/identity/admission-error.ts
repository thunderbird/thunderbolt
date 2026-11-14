/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export type AdmissionErrorCode =
  | 'INVALID_DOMAIN'
  | 'DOMAIN_NOT_FOUND'
  | 'DOMAIN_NOT_VERIFIED'
  | 'DOMAIN_CLAIMED_BY_IDP'
  | 'ALREADY_MEMBER'
  | 'INVITATION_NOT_FOUND'

/** A refused invitation or domain change. Admin routes map `code` to their response. */
export class AdmissionError extends Error {
  constructor(readonly code: AdmissionErrorCode) {
    super(code)
  }
}
