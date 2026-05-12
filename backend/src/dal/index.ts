/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Devices
export {
  getDeviceById,
  upsertDevice,
  revokeDevice,
  denyDevice,
  markDeviceTrusted,
  registerDevice,
  countActiveDevices,
} from './devices'

// Users
export { getUserById, getUserByEmail, deleteUser, markUserNotNew } from './users'

// Sessions
export { getActiveSessionByToken, linkSessionToDevice, revokeDeviceSessions } from './sessions'

// Waitlist
export { getWaitlistByEmail, createWaitlistEntry, approveWaitlistEntry } from './waitlist'

// PowerSync
export { applyOperation } from './powersync'

// OTP Challenge (session binding)
export {
  getOrCreateOtpChallenge,
  validateOtpChallenge,
  deleteOtpChallengesForEmail,
  deletePersistedSignInOtp,
} from './otp-challenge'

// Encryption
export {
  getEnvelopeByDeviceId,
  hasEnvelopesForUser,
  upsertEnvelope,
  deleteEnvelope,
  getEncryptionMetadata,
  insertEncryptionMetadataIfNotExists,
} from './encryption'
