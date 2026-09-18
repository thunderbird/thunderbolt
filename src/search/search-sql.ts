/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The pieces of the search SQL that are pinned to the FTS schema itself.
 *
 * Two callers query `search_index` — `buildSearchStatement` (raw string with
 * positional `?`, for PowerSync's `useQuery`) and `searchProjectChats` (drizzle
 * `sql` templates). Their incompatible binding models mean the statements can't
 * share a builder, but the values below are coupled to the column layout in
 * `buildCreateSql`: change the schema and every one of them has to move at once
 * or search silently misranks. They live here so that can't happen in one file
 * and not the other.
 *
 * Not shared, deliberately: snippet width and the truncation ellipses, which
 * differ per caller — the palette needs the polish, the model reading
 * `search_project_chats` output does not.
 */

/** Zero-based index of the `body` column, the one `snippet()` excerpts. */
export const bodyColumnIndex = 4

/**
 * bm25 weights title 10x over body. Weights are positional over every column,
 * so the three leading UNINDEXED columns (id, entity_type, parent_id) take a
 * no-op 1.0 before title's 10x boost.
 */
export const bm25Sql = 'bm25(search_index, 1.0, 1.0, 1.0, 10.0, 1.0)'
