/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Trash2 } from 'lucide-react'
import { DetailPanel, DetailPanelSurface } from '@/components/detail-panel'
import { DetailActionsMenu } from '@/components/settings/detail-actions-menu'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { SkillsList } from '@/skills/skills-list'
import { PreviewResetAction } from '../preview-reset-action'
import type { AdminPreview } from '../use-admin-preview-state'
import { CompanySkillEditor } from './company-skill-editor'
import { ResourcePageDialogs } from './resource-page-dialogs'
import { useResourcePageState } from './use-resource-page-state'

export const CompanySkillsPage = ({ preview }: { preview: AdminPreview }) => {
  const { t } = useLingui()
  const page = useResourcePageState()
  const skill = preview.companySkills.find((item) => item.id === page.selectedId)
  const open = page.selectedId === 'new' || !!skill
  const skills = [...preview.companySkills].sort((a, b) => a.name.localeCompare(b.name))
  return (
    <div className="relative flex h-full">
      <div className="min-w-0 flex-1 overflow-hidden">
        <SkillsList
          skills={skills}
          activeSkillId={skill?.id ?? null}
          isEnabled={(id) => preview.companySkills.some((item) => item.id === id && item.enabled)}
          onToggleEnabled={(id, enabled) => {
            const item = preview.companySkills.find((row) => row.id === id)
            if (item) {
              preview.dispatch({ type: 'save-skill', skill: { ...item, enabled } })
            }
          }}
          onCreate={() => page.requestSelect('new')}
          onSelectSkill={page.requestSelect}
          onEditSkill={page.requestSelect}
          onDeleteSkill={(removeId) => page.patch({ removeId })}
          actions={
            <PreviewResetAction
              onReset={() => {
                preview.dispatch({ type: 'reset' })
                page.select(null)
              }}
            />
          }
          intro={
            <>
              <p className="text-sm text-muted-foreground">
                <Trans>Skills for the company's Thunderbolt agent.</Trans>
              </p>
            </>
          }
        />
      </div>
      <DetailPanelSurface open={open} onClose={page.close}>
        {open && (
          <DetailPanel
            title={skill ? t`Edit Skill` : t`Create Skill`}
            subtitle={t`Thunderbolt agent`}
            onClose={page.close}
            actions={
              skill && (
                <DetailActionsMenu>
                  <DropdownMenuItem onClick={() => page.patch({ removeId: skill.id })}>
                    <Trash2 />
                    <Trans>Remove skill</Trans>
                  </DropdownMenuItem>
                </DetailActionsMenu>
              )
            }
          >
            <CompanySkillEditor
              key={page.selectedId}
              skill={skill}
              preview={preview}
              onClose={page.close}
              onSaved={() => page.select(null)}
              onDirtyChange={(dirty) => page.patch({ dirty })}
            />
          </DetailPanel>
        )}
      </DetailPanelSurface>
      <ResourcePageDialogs
        page={page}
        onRemove={(id) => preview.dispatch({ type: 'remove', kind: 'companySkills', id, at: Date.now() })}
      />
    </div>
  )
}
