/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** The one organization a deployment runs today. It is also the SCIM `provisioningDomainId`. */
export const implicitOrganizationId = 'default'

/**
 * The organization the current request acts in. Every identity query takes its org from here, so
 * serving several orgs later changes only this function.
 */
export const getCurrentOrganizationId = () => implicitOrganizationId
