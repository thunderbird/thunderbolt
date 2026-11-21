/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { importWhenReachable } from '@/lib/import-when-reachable'

/**
 * pdfjs for the PDF transformers. Its chunk is the PDF viewers' too, and Safari never loads a chunk again once it
 * failed to fetch it, so the import waits for the app's server. One loader for both transformers, so once one has
 * loaded it, the other needs no network.
 */
export const loadPdfjs = importWhenReachable(() => import('pdfjs-dist'))
