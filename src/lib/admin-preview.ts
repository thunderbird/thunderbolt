/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Explicit demo capability, never a production authorization decision. */
export const isAdminDesignPreview = import.meta.env.VITE_ADMIN_DESIGN_PREVIEW === 'true'

/** Single lazy boundary shared by the sidebar and route preloader. */
export const loadAdminDesignPreview = () => {
  if (!isAdminDesignPreview) {
    throw new Error('Admin design preview is disabled')
  }
  return import('../../admin')
}
