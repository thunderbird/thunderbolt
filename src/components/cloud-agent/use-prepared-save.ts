/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { createPreparedCloudRequest } from '@/cloud-agent/prepared-request'

/** Freeze the submitted command across uncertain responses while the editor remains open. */
export const usePreparedSave = <Command, Result, Variables = void>({
  prepare,
  submit,
  onSuccess,
}: {
  prepare: (variables: Variables) => Command | Promise<Command>
  submit: (command: Command) => Promise<Result>
  onSuccess: (result: Result) => unknown | Promise<unknown>
}) => {
  const [request] = useState(() => createPreparedCloudRequest<Command>())
  const mutation = useMutation({
    mutationFn: (variables: Variables) => request.run(variables, prepare, submit),
    onSuccess,
    retry: false,
    networkMode: 'always',
  })
  return { ...mutation, hasPrepared: request.pending() }
}
