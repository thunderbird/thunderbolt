/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { emojiAssetFilename } from './emoji-assets'

/** Local SVG artwork keeps project emoji visible even when native color fonts fail. */
export const EmojiGlyph = ({ emoji }: { emoji: string }) => (
  <img
    src={`/emoji/${emojiAssetFilename(emoji)}`}
    alt=""
    aria-hidden="true"
    draggable={false}
    className="size-[1em] shrink-0 object-contain"
  />
)
