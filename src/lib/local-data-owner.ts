/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Binds the local database to the account that owns it (THU-963).
 *
 * "Leave data on device" keeps an account's database, including local-only
 * secrets (MCP, integration, model and agent credentials) and its unsent
 * PowerSync queue. So each account that signs in on the device gets its own
 * slot (a database file and an attachment store), and the app opens only the
 * signed-in account's slot. The ownership record in localStorage names each
 * slot's owner and the device's active slot. When a session for another account
 * appears, by any sign-in path, the app switches: it stops rendering, removes
 * the previous owner's keys and device credentials, and reloads into the new
 * account's slot. The previous slot stays untouched until its owner signs in
 * again.
 *
 * The first account to sign in on a fresh device claims its ownerless slot.
 * A pre-slot database kept by a signed-out account has no provable owner, so it
 * is never opened again; its bytes stay until a full local wipe (manual
 * recovery: docs/internals/architecture/delete-account-and-revoke-device.md).
 *
 * A tab stops rendering and reloads when its slot stops being the device's
 * active one, or when another tab starts switching away from it. For cookie-only
 * SSO sessions, the ownership record is the only signal other tabs get. A tab
 * that boots during another tab's switch waits for it before opening any slot.
 * The switching tab holds an origin-wide Web Lock for the whole switch, and the
 * browser releases that lock if the tab dies, so the lock tells a live switch
 * from a dead one without a timer.
 *
 * A tab that opens a slot with an owner stays `unbound` until the session
 * resolves to that owner, to another account (a switch), or to nobody. Until
 * then the app does not render. A usable cached session (for the stored bearer
 * token, or in SSO mode for the cookie) resolves it at boot, so an offline
 * reload renders. An SSO cookie may by then belong to another account; when
 * `/get-session` names that account, the tab switches.
 */

import { getAuthToken } from '@/lib/auth-token'
import { isSsoMode } from '@/lib/auth-mode'
import {
  deleteIndexedDbDatabase,
  deleteOpfsFile,
  hasIndexedDbDatabase,
  hasOpfsFile,
  isOpfsAvailable,
  listIndexedDbDatabases,
  powerSyncDbFilename,
} from '@/lib/platform'
import { getCachedSession, getUsableCachedSession } from '@/lib/session-cache'
import {
  accountLocalSettingsSchema,
  initialLocalSettings,
  useLocalSettingsStore,
  type AccountLocalSettings,
} from '@/stores/local-settings-store'
import { hashValues } from '@shared/lib/hash'
import { z } from 'zod'

const slotSchema = z.object({
  owner: z.string().optional(),
  /** The owner's account settings (the voice key among them) while another account uses the device. */
  settings: accountLocalSettingsSchema.optional(),
  /** Sign-in learned the owner is a returning user while switching here; the next boot marks it onboarded. */
  deferredOnboardedMark: z.literal(true).optional(),
  /** Only a session for the bearer token with this hash may claim the slot (an upgrade that knew the token but not its account). */
  claimTokenHash: z.string().optional(),
  /** The owner is an anonymous account, so no one can reach the slot once its token is gone. See `deleteAbandonedSlots`. */
  anonymous: z.literal(true).optional(),
})

const localDataStateSchema = z.object({
  active: z.string(),
  slots: z.record(z.string(), slotSchema),
  /** A tab holding `switchLockName` is moving the device to this slot; no tab may use the active slot. */
  switchingTo: z.string().optional(),
})

type LocalDataState = z.infer<typeof localDataStateSchema>
type Slot = z.infer<typeof slotSchema>

type BindOptions = {
  /** The account is anonymous, so a later boot deletes its slot once its token leaves the device. */
  isAnonymous?: boolean | null
  /** The anonymous account this sign-in replaced. Its slot passes to the signed-in account unless that account already has one here. */
  promotedFrom?: string
}

/**
 * Whether this tab may use the open slot:
 * - `unbound`: the slot has an owner, and no session has resolved to that owner or to nobody yet
 * - `ready`: the slot is the signed-in account's, or no one is signed in; local data may be used
 * - `switching`: the device is moving to another account's slot, or another tab moved it; a reload follows
 * - `failed`: a switch could not remove the previous owner's identity, so the new session stays blocked
 */
export type LocalDataStatus = 'unbound' | 'ready' | 'switching' | 'failed'

const storageKey = 'thunderbolt_local_data'
/** Held from publishing `switchingTo` until the switch is written. Cleanup takes the key-store lock separately. */
const switchLockName = 'thunderbolt-local-data-switch'
/** The pre-slot database keeps its filename, so an upgraded install opens the same file. */
const defaultSlot = 'default'

let openedSlot: string | undefined
let status: LocalDataStatus = 'ready'
let switchTarget: string | undefined
/** Sign-in deferred an onboarded mark, maybe before the switch knew its target slot. */
let hasDeferredOnboardedMark = false
const listeners = new Set<() => void>()

/** Null when missing or unreadable; callers then treat every slot as owned by another account. */
const readState = (raw = localStorage.getItem(storageKey)): LocalDataState | null => {
  try {
    return localDataStateSchema.safeParse(JSON.parse(raw ?? 'null')).data ?? null
  } catch {
    return null
  }
}

const writeState = (state: LocalDataState) => localStorage.setItem(storageKey, JSON.stringify(state))

const setStatus = (next: LocalDataStatus) => {
  status = next
  listeners.forEach((listener) => listener())
}

const slotOf = (state: LocalDataState, userId: string): string | undefined =>
  Object.keys(state.slots).find((id) => state.slots[id].owner === userId)

/** A slot owned by `owner`, marked `anonymous` when that account is anonymous. */
const ownedSlot = (owner: string, isAnonymous: boolean | null | undefined): Slot =>
  isAnonymous ? { owner, anonymous: true } : { owner }

/** Only the account settings, out of the whole local settings store. */
const accountSettingsOf = ({ voiceProvider, recoveryPhrasePending }: AccountLocalSettings): AccountLocalSettings => ({
  voiceProvider,
  recoveryPhrasePending,
})

const setLiveAccountSettings = (settings: AccountLocalSettings) => useLocalSettingsStore.setState(settings)

const defaultAccountSettings = accountSettingsOf(initialLocalSettings)

/** The database filename of a slot. The default slot keeps the name from before slots. */
const slotFilename = (slot: string): string =>
  slot === defaultSlot ? powerSyncDbFilename : `thunderbolt-sync-${slot}.db`

/** The IndexedDB database holding a slot's chat attachments. The default slot keeps the name from before slots. */
const slotAttachmentDatabase = (slot: string): string =>
  slot === defaultSlot ? 'thunderbolt-files' : `thunderbolt-files-${slot}`

/** The open slot's attachment database (see `file-blob-storage.ts`). */
export const attachmentDatabaseName = (): string => slotAttachmentDatabase(openedSlot ?? defaultSlot)

/** A slot id other than the default one, as `crypto.randomUUID` makes them. */
const slotIdPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/

/** Whether `name` is a slot's database or attachment store (or earlier builds' `:memory:`), with or without OPFS. */
const isAppDatabaseName = (name: string): boolean => {
  const slot = name.match(slotIdPattern)?.[0] ?? defaultSlot
  return name === slotFilename(slot) || name === slotAttachmentDatabase(slot) || name === ':memory:'
}

const hasDefaultDatabase = async (): Promise<boolean> =>
  (await hasOpfsFile(powerSyncDbFilename)) || (await hasIndexedDbDatabase(powerSyncDbFilename))

/**
 * Every IndexedDB database name an account's data may live in: each recorded slot's database and
 * attachment store, the default ones, the empty database earlier builds' in-memory fallback
 * created, and any app-named database the browser lists (a slot the ownership record no longer names).
 */
export const appIndexedDbNames = async (): Promise<string[]> => {
  const slots = [...Object.keys(readState()?.slots ?? {}), defaultSlot]
  const recorded = slots.flatMap((slot) => [slotFilename(slot), slotAttachmentDatabase(slot)])
  const names = [...recorded, ':memory:', ...(await listIndexedDbDatabases())]
  return [...new Set(names)].filter(isAppDatabaseName)
}

/**
 * Forget every slot: their databases are being wiped. Other tabs reload. The ownership record is
 * replaced, not removed, so a boot during or after a wipe that stops partway never runs `initialState`
 * on what is left. Leftovers stay out of reach until the next wipe removes them. The new slot has no owner, so
 * the account settings go back to their defaults.
 */
export const forgetLocalDataSlots = (): void => {
  setLiveAccountSettings(defaultAccountSettings)
  writeState(freshSlotState())
}

/** The account signed in at upgrade, as far as the device can tie its session to one. */
const upgradeClaim = (): Slot | undefined => {
  const cachedUser = getCachedSession()?.user
  const token = getAuthToken()
  if (cachedUser?.id && (token || isSsoMode())) {
    return ownedSlot(cachedUser.id, cachedUser.isAnonymous)
  }
  // Without a cached user, only that token's session may claim the slot.
  return token ? { claimTokenHash: hashValues([token]) } : undefined
}

/**
 * Whether the stored bearer token is the one `claimTokenHash` names. The ownership record outlives
 * the token, so it keeps only a 32-bit hash: no credential, and another server-issued token matches
 * about once in 4 billion.
 */
const isClaimTokenStored = (claimTokenHash: string): boolean => {
  const token = getAuthToken()
  return token !== null && hashValues([token]) === claimTokenHash
}

/** Only explicit persisted flags establish that pre-slot data never belonged to a signed-in account. */
const wasNeverAuthenticated = async (): Promise<boolean> => {
  const { name, storage } = useLocalSettingsStore.persist.getOptions()
  if (name === undefined || storage === undefined) {
    return false
  }
  const saved = await storage.getItem(name)
  return saved?.state?.localMode === true && saved.state.serverHasAuthenticated === false
}

/** First boot with slots: decide which account owns the database this install already has. */
const initialState = async (isStandaloneUpgrade: boolean): Promise<LocalDataState> => {
  const claim = upgradeClaim()
  // Without OPFS, the default slot's bare name may be an IndexedDB database an earlier install
  // left (owner unknown) or an in-memory one a still-open tab holds, so never reuse it. The new
  // slot is empty, so it can go to the signed-in account along with the account settings it uses.
  if (!(await isOpfsAvailable())) {
    return freshSlotState(claim)
  }
  if (!(await hasDefaultDatabase())) {
    return { active: defaultSlot, slots: { [defaultSlot]: {} } }
  }
  if (claim || isStandaloneUpgrade) {
    return { active: defaultSlot, slots: { [defaultSlot]: claim ?? {} } }
  }
  // Kept by an account that signed out before slots existed: no owner can be proven, so fail closed.
  return freshSlotState()
}

const freshSlotState = (claim: Slot = {}): LocalDataState => {
  const slot = crypto.randomUUID()
  return { active: slot, slots: { [slot]: claim } }
}

/**
 * Open the active slot before its database opens. The switch lock covers the settings refresh and
 * ownership writes so another tab cannot switch accounts midway. This also creates the record on
 * first boot, deletes abandoned slots, starts following other tabs, and binds a usable cached session.
 * @returns The filename to pass to `getDatabasePath`
 */
export const openLocalData = (): Promise<string> =>
  navigator.locks.request(switchLockName, async () => {
    // The store may have hydrated before another tab finished switching.
    await useLocalSettingsStore.persist.rehydrate()
    abandonSwitch()
    const raw = localStorage.getItem(storageKey)
    const stored = readState(raw)
    const isStandaloneUpgrade = raw === null && (await wasNeverAuthenticated())
    if (raw !== null && !stored) {
      console.error('[local-data] The ownership record is unreadable, so no slot it named will open again')
    }
    // An unreadable record cannot say which account owns which slot, so start an empty slot.
    const state = stored ?? (raw === null ? await initialState(isStandaloneUpgrade) : freshSlotState())
    await deleteAbandonedSlots(state)
    const slot = state.slots[state.active]
    const isOwnerless = slot !== undefined && slot.owner === undefined && slot.claimTokenHash === undefined
    if (!stored && isOwnerless && !isStandaloneUpgrade) {
      // No one can prove they own the new slot, so the live account settings may be anyone's.
      setLiveAccountSettings(defaultAccountSettings)
    }
    writeState(state)
    if (openedSlot === undefined) {
      window.addEventListener('storage', followOtherTabs)
    }
    openedSlot = state.active
    setStatus(isOwnerless ? 'ready' : 'unbound')
    // PowerSync asks for credentials before `AuthProvider` mounts and seeds this same session, and
    // refuses them while the slot is `unbound`. A session for another account waits: the session
    // subscriber starts that switch after boot.
    // Trade-off (SSO): a cookie that now belongs to another account shows the cached owner's data until `/get-session` answers.
    const cachedUser = getUsableCachedSession()?.user
    if (cachedUser?.id) {
      claimOpenSlot(state.active, cachedUser.id, { isAnonymous: cachedUser.isAnonymous })
    }
    return slotFilename(state.active)
  })

/**
 * Delete each anonymous slot that is not active and that no one can reach any more. An anonymous
 * account has no way back in once its bearer token leaves the device. The token leaves when the account
 * is promoted into an account that already has a slot here, when it signs out, and when its session
 * expires and the device starts a new anonymous session. So its slot goes when no token is stored or the
 * cached session for the stored token names another account. Without a usable cached session, nothing
 * proves whose token it is, so the slot waits. A slot another tab still holds open stays for the next boot.
 */
const deleteAbandonedSlots = async (state: LocalDataState) => {
  const abandoned = Object.keys(state.slots).filter((slot) => state.slots[slot].anonymous && slot !== state.active)
  if (abandoned.length === 0) {
    return
  }
  const cachedUserId = getUsableCachedSession()?.user?.id
  const hasOpfs = await isOpfsAvailable()
  for (const slot of abandoned) {
    const isTokenGone = !getAuthToken() || (cachedUserId !== undefined && cachedUserId !== state.slots[slot].owner)
    if (isTokenGone) {
      try {
        await deleteSlotFiles(slot, hasOpfs)
        delete state.slots[slot]
      } catch (error) {
        console.error('[local-data] Could not delete an abandoned anonymous slot yet:', error)
      }
    }
  }
}

/** Delete the slot's database (an OPFS file with its journals, or an IndexedDB database) and its attachment store. */
const deleteSlotFiles = async (slot: string, hasOpfs: boolean) => {
  const filename = slotFilename(slot)
  if (hasOpfs) {
    for (const suffix of ['', '-journal', '-wal']) {
      await deleteOpfsFile(`${filename}${suffix}`)
    }
  }
  await deleteIndexedDbDatabase(filename)
  await deleteIndexedDbDatabase(slotAttachmentDatabase(slot))
}

/**
 * Undo a switch that stopped before finishing. Runs under the switch lock. The live account
 * settings belong to the active slot, so settings saved on the active slot were staged by that
 * switch and go back to being the live ones. Every write here is safe to repeat if this also stops
 * halfway.
 */
const abandonSwitch = () => {
  const state = readState()
  if (!state?.switchingTo) {
    return
  }
  const staged = state.slots[state.active]?.settings
  if (staged) {
    setLiveAccountSettings(staged)
    delete state.slots[state.active].settings
  }
  delete state.switchingTo
  writeState(state)
}

/** Another tab changed which account's data the device uses: stop using this tab's slot. */
const followOtherTabs = (event: StorageEvent) => {
  // `key` is null when another tab cleared all of localStorage (a full wipe).
  const isRecordChange = event.storageArea === localStorage && (event.key === storageKey || event.key === null)
  // A tab that is switching itself reloads when it finishes.
  if (!isRecordChange || switchTarget !== undefined) {
    return
  }
  const state = readState()
  const isSlotStillActive = state !== null && state.active === openedSlot && state.switchingTo === undefined
  if (isSlotStillActive && (status === 'ready' || status === 'unbound')) {
    return
  }
  setStatus('switching')
  window.location.reload()
}

/** Remove the previous owner's identity from the device, then reload into `userId`'s slot. */
const switchLocalData = async (userId: string, fromSlot: string, isAnonymous: boolean | null | undefined) => {
  setStatus('switching')
  try {
    await navigator.locks.request(switchLockName, async () => {
      try {
        await switchLocalDataLocked(userId, fromSlot, isAnonymous)
      } catch (error) {
        // Undone while this tab still holds the lock, so no other tab's switch starts in between.
        abandonSwitch()
        throw error
      }
    })
  } catch (error) {
    // The previous owner's keys may still be here, so the new session stays blocked. Reloading retries.
    setStatus('failed')
    switchTarget = undefined
    console.error('[local-data] Failed to switch accounts:', error)
  }
}

const switchLocalDataLocked = async (userId: string, fromSlot: string, isAnonymous: boolean | null | undefined) => {
  // Without an ownership record, `fromSlot` stays active with no owner and no entry, so a failed switch retries.
  const state = readState() ?? { active: fromSlot, slots: {} }
  if (state.active !== fromSlot) {
    // Another tab switched the device while this one waited; its cleanup and settings handover are done.
    window.location.reload()
    return
  }
  const target = slotOf(state, userId) ?? crypto.randomUUID()
  const incoming = (state.slots[target] ??= ownedSlot(userId, isAnonymous))
  if (hasDeferredOnboardedMark) {
    incoming.deferredOnboardedMark = true
  }
  state.switchingTo = target
  writeState(state)
  switchTarget = target
  // Imported dynamically to break the cycle cleanup → services/encryption → http → the PowerSync
  // connector, which imports this module.
  const { clearLocalDataOrThrow } = await import('@/lib/cleanup')
  await clearLocalDataOrThrow({ clearDatabase: false, keepSession: true })
  finishSwitch(fromSlot, target)
  window.location.reload()
}

/**
 * Hand the account settings over in steps, so each set stays tied to its account if the tab dies
 * between them: stage the outgoing set on its slot, make the incoming one live, then make `target`
 * active. The ownership record is read again for the marks sign-in wrote during cleanup. When another
 * tab replaced it meanwhile (a full wipe), that tab's record stands.
 */
const finishSwitch = (fromSlot: string, target: string) => {
  const state = readState()
  const incoming = state?.slots[target]
  if (!state || !incoming || state.active !== fromSlot) {
    return
  }
  const outgoing = state.slots[fromSlot]
  if (outgoing) {
    outgoing.settings = accountSettingsOf(useLocalSettingsStore.getState())
  }
  writeState(state)
  setLiveAccountSettings(incoming.settings ?? defaultAccountSettings)
  delete incoming.settings
  state.active = target
  delete state.switchingTo
  writeState(state)
}

/**
 * Bind the open slot to the signed-in account. Call before any authenticated use of local data.
 *
 * Claims an ownerless slot. Otherwise, when another account owns the open slot, starts switching
 * to `userId`'s slot; the caller must not touch local data.
 *
 * @returns True when the open slot is now `userId`'s. False while switching, after a failed switch,
 *   or when no slot was opened
 */
export const bindLocalData = (userId: string, options: BindOptions = {}): boolean => {
  // A database opened without `openLocalData` belongs to no one, so nothing may use it as an account's.
  if (openedSlot === undefined) {
    return false
  }
  // The switch under way, or the failed one, decides what this tab does next.
  if (status === 'switching' || status === 'failed') {
    return false
  }
  if (claimOpenSlot(openedSlot, userId, options)) {
    return true
  }
  void switchLocalData(userId, openedSlot, options.isAnonymous)
  return false
}

/**
 * Bind the account a sign-in returned, once its token is stored and before the session listeners hear
 * of it. An anonymous session the sign-in replaced passes its slot along (`promotedFrom`).
 * @returns Whether the open slot is now `user`'s; false while a switch takes the device there
 */
export const bindSignedInAccount = (
  user: { id: string; isAnonymous?: boolean | null } | undefined,
  previousUser: { id: string; isAnonymous?: boolean | null } | undefined,
): boolean =>
  user !== undefined &&
  bindLocalData(user.id, {
    isAnonymous: user.isAnonymous,
    promotedFrom: previousUser?.isAnonymous ? previousUser.id : undefined,
  })

/** Bind `openSlot` to `userId` when it is theirs or theirs to claim. False when only a switch can bind them. */
const claimOpenSlot = (openSlot: string, userId: string, { isAnonymous, promotedFrom }: BindOptions): boolean => {
  const state = readState()
  const slot = state?.slots[openSlot]
  if (!state || !slot) {
    return false
  }
  if (slot.owner === userId) {
    setStatus('ready')
    return true
  }
  if (!isClaimable(slot, promotedFrom) || slotOf(state, userId)) {
    return false
  }
  // The `anonymous` mark describes the new owner, so a slot that passes to a named account loses it.
  delete slot.claimTokenHash
  delete slot.anonymous
  Object.assign(slot, ownedSlot(userId, isAnonymous))
  writeState(state)
  setStatus('ready')
  return true
}

/** No owner and no claim token, or only the stored token's; or owned by the anonymous account `promotedFrom`. */
const isClaimable = (slot: Slot, promotedFrom: string | undefined): boolean =>
  slot.owner === undefined
    ? slot.claimTokenHash === undefined || isClaimTokenStored(slot.claimTokenHash)
    : slot.owner === promotedFrom

/** Whether the open slot belongs to `userId` and may be used with that account's credentials. */
export const isLocalDataOwnedBy = (userId: string | undefined): boolean =>
  openedSlot !== undefined &&
  userId !== undefined &&
  status === 'ready' &&
  readState()?.slots[openedSlot]?.owner === userId

/** The session resolved to nobody: the signed-out app may use the open slot. */
export const releaseSignedOutLocalData = (): void => {
  if (status === 'unbound') {
    setStatus('ready')
  }
}

/** Defer an onboarded mark to the slot of the account being switched to (see `markOnboardedForReturningUser`). */
export const deferOnboardedMark = (): void => {
  hasDeferredOnboardedMark = true
  const state = readState()
  const target = switchTarget === undefined ? undefined : state?.slots[switchTarget]
  if (state && target) {
    target.deferredOnboardedMark = true
    writeState(state)
  }
}

/** Apply the open slot's deferred onboarded mark, then consume it. A failed `apply` keeps it for the next boot. */
export const takeDeferredOnboardedMark = async (apply: () => Promise<void>): Promise<void> => {
  const slotId = openedSlot
  if (slotId === undefined || !readState()?.slots[slotId]?.deferredOnboardedMark) {
    return
  }
  await apply()
  const state = readState()
  const slot = state?.slots[slotId]
  if (state && slot) {
    delete slot.deferredOnboardedMark
    writeState(state)
  }
}

/** Whether this tab may use the open slot (see {@link LocalDataStatus}). Only `ready` allows it. */
export const getLocalDataStatus = (): LocalDataStatus => status

/** `useSyncExternalStore` subscription for {@link getLocalDataStatus}. */
export const subscribeLocalDataStatus = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** @internal Test-only: forget the opened slot and status. */
export const resetLocalDataOwnerForTests = (): void => {
  window.removeEventListener('storage', followOtherTabs)
  openedSlot = undefined
  switchTarget = undefined
  hasDeferredOnboardedMark = false
  status = 'ready'
}
