/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useReducer } from 'react'

type State = {
  /** Device id whose "set pairing identity" dialog is open, or null. */
  dialogFor: string | null
  /** Device id whose pairing QR is currently expanded, or null (one at a time). */
  qrFor: string | null
}

type Action =
  | { type: 'openDialog'; deviceId: string }
  | { type: 'closeDialog' }
  | { type: 'toggleQr'; deviceId: string }

const reducer = (state: State, action: Action): State => {
  switch (action.type) {
    case 'openDialog':
      return { ...state, dialogFor: action.deviceId }
    case 'closeDialog':
      return { ...state, dialogFor: null }
    case 'toggleQr':
      return { ...state, qrFor: state.qrFor === action.deviceId ? null : action.deviceId }
  }
}

/** Groups the device-pairing UI selections (open dialog + expanded QR) into one reducer. */
export const useDevicePairing = () => {
  const [state, dispatch] = useReducer(reducer, { dialogFor: null, qrFor: null })
  return {
    dialogFor: state.dialogFor,
    qrFor: state.qrFor,
    openDialog: (deviceId: string) => dispatch({ type: 'openDialog', deviceId }),
    closeDialog: () => dispatch({ type: 'closeDialog' }),
    toggleQr: (deviceId: string) => dispatch({ type: 'toggleQr', deviceId }),
  }
}
