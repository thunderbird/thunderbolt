/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import { SkillForm, type SkillFormValues } from '@/skills/skill-form'
import type { CompanySkill } from '../data'
import type { AdminPreview } from '../use-admin-preview-state'

export const CompanySkillEditor = ({
  skill,
  preview,
  onClose,
  onSaved,
  onDirtyChange,
}: {
  skill?: CompanySkill
  preview: AdminPreview
  onClose: () => void
  onSaved: () => void
  onDirtyChange: (dirty: boolean) => void
}) => {
  const { t } = useLingui()
  const [slugError, setSlugError] = useState<string | null>(null)
  const save = (values: SkillFormValues) => {
    if (preview.companySkills.some((item) => item.id !== skill?.id && item.name === values.name)) {
      setSlugError(t`A skill with this slug already exists.`)
      return
    }
    preview.dispatch({
      type: 'save-skill',
      skill: {
        ...skill,
        ...values,
        id: skill?.id ?? crypto.randomUUID(),
        enabled: skill?.enabled ?? true,
        deletedAt: null,
      },
    })
    onSaved()
  }
  return (
    <SkillForm
      mode={skill ? 'edit' : 'create'}
      initialValues={skill}
      onCancel={onClose}
      onSubmit={save}
      onDirtyChange={onDirtyChange}
      slugError={slugError}
      onSlugChange={() => setSlugError(null)}
    />
  )
}
