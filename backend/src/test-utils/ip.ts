/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

let counter = 0

/**
 * Return a client IP no earlier call in this process has used (the counter
 * wraps after 65,536 calls), drawn from the 198.18.0.0/15 benchmarking range
 * (RFC 2544), which never routes publicly.
 *
 * Rate-limit buckets outlive a single test: Better Auth's limiter store is
 * process-global and `--rerun-each` re-runs a test body without reloading the
 * module, so a hardcoded IP is only fresh on the first repetition.
 */
export const uniqueTestIp = (): string => {
  counter += 1
  const third = Math.floor(counter / 256) % 256
  const fourth = counter % 256
  return `198.18.${third}.${fourth}`
}
