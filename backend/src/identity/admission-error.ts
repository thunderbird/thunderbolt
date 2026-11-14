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
  | 'LINK_REVIEW_NOT_FOUND'
  | 'LINK_REVIEW_RESOLVED'
  | 'LINK_REVIEW_SELF'
  | 'LINK_REVIEW_RECORD_EXISTS'
  | 'LINK_REVIEW_INVALID_CURSOR'

/** A refused invitation, domain change or link review. Admin routes map `code` to their response. */
export class AdmissionError extends Error {
  constructor(readonly code: AdmissionErrorCode) {
    super(code)
  }
}
