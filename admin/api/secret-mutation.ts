/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

/**
 * Spread into every mutation whose result holds a secret (a SCIM token): with `gcTime: 0` the
 * mutation cache drops the result as soon as nothing observes it. Render the secret from
 * `mutation.data` and call `mutation.reset()` in `CopyOnceSecret`'s `onDone`; never copy it into the
 * query cache.
 */
export const secretMutationOptions = { gcTime: 0 } as const
