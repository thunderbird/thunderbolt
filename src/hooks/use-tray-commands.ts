/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { trayCommandEvent, type TrayCommand } from '@/lib/tray'
import { useEffect, useEffectEvent } from 'react'
import { useNavigate } from 'react-router'
import { useCreateNewChat } from './use-create-new-chat'

/**
 * Run the tray menu's router actions. The tray is built during app
 * initialization, outside the router, so it fires `trayCommandEvent` after
 * bringing the main window forward and this hook, mounted inside the router,
 * does the navigation. New Chat goes through `useCreateNewChat`, the same entry
 * point as the sidebar's button.
 */
export const useTrayCommands = () => {
  const navigate = useNavigate()
  const createNewChat = useCreateNewChat()

  const run = useEffectEvent((command: TrayCommand) => {
    if (command === 'new-chat') {
      createNewChat()
      return
    }
    // `/settings` itself is an empty page: the app's Settings button only
    // switches the sidebar, so land on its first page instead.
    navigate('/settings/preferences')
  })

  useEffect(() => {
    const handle = (event: Event) => run((event as CustomEvent<TrayCommand>).detail)
    window.addEventListener(trayCommandEvent, handle)
    return () => window.removeEventListener(trayCommandEvent, handle)
  }, [])
}
