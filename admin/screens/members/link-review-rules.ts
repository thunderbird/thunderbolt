/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

const linkReviewEditPrefix = 'link:'

/** The `?edit=` value that opens a link review's panel on Members; member ids never carry the prefix. */
export const linkReviewEditId = (reviewId: string) => `${linkReviewEditPrefix}${reviewId}`

/** The link review id an `?edit=` value opens, or null for anything else. */
export const parseLinkReviewEditId = (editId: string | null) =>
  editId?.startsWith(linkReviewEditPrefix) ? editId.slice(linkReviewEditPrefix.length) : null
