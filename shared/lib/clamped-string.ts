/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from 'zod'

/**
 * A bounded string that clamps rather than rejects.
 *
 * Nearly every string an embedded surface sends us is free text it derives from
 * its own DOM or its author's prose — a stack trace, a wide table row, a
 * select-all, a display name. The bounds we put on those are *our* prompt and
 * memory budgets, so the sender has no reason to know them, and in practice no
 * sender does: none of the guest bridges clamps anything except its error
 * message.
 *
 * A `.max()` on such a field therefore rejects the whole **message**, not the
 * field. That produced the same bug over and over, always looking like the
 * feature simply not working: the error strip never appeared, the marquee
 * resolved to nothing, `get_app_context` reported a busy page as silent, and a
 * long app name dropped the handshake so the app never connected at all. None
 * of them logged anything, because from the parser's point of view nothing
 * arrived.
 *
 * Clamping keeps the bound and keeps the message. Use `.max()` only where the
 * bound is a real correctness constraint the sender is required to honour.
 *
 * @param max Characters to keep; anything past this is cut.
 * @param min Minimum length, enforced *before* clamping — for fields where
 *   empty is genuinely meaningless (an id, a chip label).
 */
export const clampedString = (max: number, { min = 0 }: { min?: number } = {}) =>
  z
    .string()
    .min(min)
    .transform((value) => (value.length > max ? value.slice(0, max) : value))
