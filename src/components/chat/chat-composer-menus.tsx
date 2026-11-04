/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState, type ComponentProps } from 'react'
import { AgentEnvironmentPicker } from './agent-environment-picker'
import { CloudApprovalPicker } from './cloud-approval-picker'
import { ChatAddMenu } from './chat-add-menu'

type ComposerMenu = 'environment' | 'approvals' | 'add'

/** Adjacent composer menus share one open state, so opening one always replaces the previous menu. */
export const ChatComposerMenus = ({
  environment,
  side = 'top',
  disabled,
  approvalMode,
  onApprovalChange,
  onUploadFile,
  onOpenConnections,
}: {
  side?: 'top' | 'bottom'
  environment?: Pick<ComponentProps<typeof AgentEnvironmentPicker>, 'value' | 'locked' | 'onChange'>
  disabled: boolean
  approvalMode: ComponentProps<typeof CloudApprovalPicker>['value']
  onApprovalChange: ComponentProps<typeof CloudApprovalPicker>['onChange']
  onUploadFile?: () => void
  onOpenConnections?: () => void
}) => {
  const [activeMenu, setActiveMenu] = useState<ComposerMenu | null>(null)
  const changeOpen = (menu: ComposerMenu, open: boolean) => {
    setActiveMenu((current) => (open ? menu : current === menu ? null : current))
  }
  return (
    <>
      {environment && (
        <>
          <AgentEnvironmentPicker
            side={side}
            {...environment}
            disabled={disabled}
            open={activeMenu === 'environment'}
            onOpenChange={(open) => changeOpen('environment', open)}
          />
          <CloudApprovalPicker
            side={side}
            disabled={disabled}
            value={approvalMode}
            onChange={onApprovalChange}
            open={activeMenu === 'approvals'}
            onOpenChange={(open) => changeOpen('approvals', open)}
          />
        </>
      )}
      <ChatAddMenu
        side={side}
        onUploadFile={onUploadFile}
        onOpenConnections={onOpenConnections}
        open={activeMenu === 'add'}
        onOpenChange={(open) => changeOpen('add', open)}
      />
    </>
  )
}
