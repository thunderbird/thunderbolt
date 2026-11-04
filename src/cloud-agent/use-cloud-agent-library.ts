/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQuery } from '@powersync/tanstack-react-query'
import { useDatabase } from '@/contexts'
import { getAllModels } from '@/dal/models'
import { getAllSkills } from '@/dal/skills'
import type { Model, Skill } from '@/types'

/** Share the ordinary Settings libraries; cloud agents select existing records and snapshot them only when saved. */
export const useCloudAgentLibrary = () => {
  const database = useDatabase()
  const models = useQuery({ queryKey: ['models'], query: toCompilableQuery(getAllModels(database)) })
  const skills = useQuery({ queryKey: ['skills'], query: toCompilableQuery(getAllSkills(database)) })
  return {
    models: (models.data ?? []) as Model[],
    skills: (skills.data ?? []) as Skill[],
    isLoading: models.isLoading || skills.isLoading,
  }
}
