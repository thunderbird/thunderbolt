/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getLocalSetting, useLocalSettingsStore } from '@/stores/local-settings-store'

/**
 * Tracks the window between minting a 24-word recovery phrase and the user
 * confirming they saved it.
 *
 * Every mint commits to the server FIRST (bootstrap / rotate / upgrade), and the
 * phrase then exists only in component state until the confirmation dialog is
 * dismissed. A reload, crash or force-quit in that window leaves an account that
 * is fully set up with no phrase anywhere — silently, because nothing recorded
 * that one was owed.
 *
 * The phrase itself is deliberately NOT persisted: the seed derives the recovery
 * keypair that opens the AK envelope, so writing it beside the keys it protects
 * would defeat its purpose. What persists is the unacknowledged FACT; the remedy
 * is to mint a fresh phrase via `changeRecoveryPhrase`, which is what the
 * re-prompt offers.
 *
 * Set by the minting services, cleared only by an explicit user confirmation.
 * Never derive it from "E2EE is set up but no phrase seen" — followers and
 * recovered devices legitimately never receive one and must not be nagged.
 */
export const markRecoveryPhrasePending = (): void => {
  useLocalSettingsStore.getState().setLocalSetting('recoveryPhrasePending', true)
}

/** The user confirmed they saved the phrase. */
export const clearRecoveryPhrasePending = (): void => {
  useLocalSettingsStore.getState().setLocalSetting('recoveryPhrasePending', false)
}

/** Non-reactive read, for imperative callers. */
export const isRecoveryPhrasePending = (): boolean => getLocalSetting('recoveryPhrasePending')

/** Reactive read, for the re-prompt gate. */
export const useRecoveryPhrasePending = (): boolean => useLocalSettingsStore((state) => state.recoveryPhrasePending)
