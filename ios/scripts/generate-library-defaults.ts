/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { defaultSkills, defaultSkillsVersion, hashSkill, isWidgetSkillId } from '../../src/defaults/skills'
import { defaultSettings, defaultSettingsVersion, hashSetting } from '../../src/defaults/settings'
import { defaultTasks, defaultTasksVersion, hashTask } from '../../src/defaults/tasks'

const defaults = [
  {
    table: 'skills', version: defaultSkillsVersion,
    rows: defaultSkills.map((skill) => ({
      id: skill.id,
      values: { name: skill.name, label: skill.label, description: skill.description, instruction: skill.instruction,
        enabled: skill.enabled, pinned_order: skill.pinnedOrder, deleted_at: skill.deletedAt },
      hash: hashSkill(skill),
      hashColumns: ['name', 'label', 'description', 'instruction',
        ...(isWidgetSkillId(skill.id) ? [] : ['enabled', 'pinned_order', 'deleted_at'])],
      frozenColumns: isWidgetSkillId(skill.id) ? ['enabled', 'pinned_order'] : [],
      skipWhenMissing: false,
    })),
  },
  {
    table: 'settings', version: defaultSettingsVersion,
    rows: defaultSettings.map((setting) => ({
      id: setting.key, values: { value: setting.value, updated_at: setting.updatedAt },
      hash: hashSetting(setting), hashColumns: ['$id', 'value'], frozenColumns: [],
      skipWhenMissing: setting.value === null,
    })),
  },
  {
    table: 'tasks', version: defaultTasksVersion,
    rows: defaultTasks.map((task) => ({
      id: task.id, values: { item: task.item, order: task.order, is_complete: task.isComplete, deleted_at: task.deletedAt },
      hash: hashTask(task), hashColumns: ['item', 'is_complete'], frozenColumns: [], skipWhenMissing: false,
    })),
  },
]

const target = new URL('../Thunderbolt/Library/LibraryDefaults.json', import.meta.url)
const output = `${JSON.stringify(defaults, null, 2)}\n`
if (Bun.argv.includes('--check')) {
  if (await Bun.file(target).text() !== output) throw new Error('Run bun ios/scripts/generate-library-defaults.ts to update native defaults')
} else {
  await Bun.write(target, output)
}
