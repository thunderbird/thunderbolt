/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { defaultSettings, defaultSettingsVersion, hashSetting } from './settings'

/**
 * Snapshot pinning the shipped defaults to their declared version. When you
 * change any default setting (add/remove/edit/reorder), this test fails.
 *
 * Fix it in this order:
 *   1. Bump `defaultSettingsVersion` in `src/defaults/settings.ts`.
 *   2. Update `expected` below to match the actual values from the failure.
 *
 * The version is the ordering signal reconcile uses to decide who owns the
 * newest defaults across devices (THU-637 pattern extended to settings in
 * THU-677). Changing defaults without bumping the version breaks that
 * ordering silently.
 */
const computeSnapshotHash = () =>
  defaultSettings.map((setting, index) => `${index}:${setting.key}:${hashSetting(setting)}`).join('|')

const expected = {
  version: 1,
  hash: '0:data_collection:9xnigq|1:is_triggers_enabled:eonvmh|2:experimental_feature_tasks:-zg8zmz|3:preferred_name:-5w6dil|4:location_name:27rtqf|5:location_lat:-tpss8p|6:location_lng:-tpsiwv|7:distance_unit:-3esuvm|8:temperature_unit:-dmzg9f|9:date_format:52oyc|10:time_format:we6fw3|11:currency:avihzf|12:integrations_pro_is_enabled:bbnpv0|13:user_has_completed_onboarding:-hxwxxt|14:content_view_width:8pnzc5|15:integrations_do_not_ask_again:yv9tj5',
}

describe('defaultSettings version snapshot', () => {
  test('version and content are in sync — read the file header if this fails', () => {
    expect({
      version: defaultSettingsVersion,
      hash: computeSnapshotHash(),
    }).toEqual(expected)
  })
})
