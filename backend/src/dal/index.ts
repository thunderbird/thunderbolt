// Devices
export { getDeviceById, upsertDevice, revokeDevice, denyDevice, markDeviceTrusted, registerDevice } from './devices'

// Users
export { getUserById, getUserByEmail, deleteUser, markUserNotNew } from './users'

// Sessions
export { getActiveSessionByToken, revokeOtherSessions } from './sessions'

// Waitlist
export { getWaitlistByEmail, createWaitlistEntry, approveWaitlistEntry } from './waitlist'

// PowerSync
export { applyOperation } from './powersync'

// OTP Challenge (session binding)
export { getOrCreateOtpChallenge, validateOtpChallenge, deleteOtpChallengesForEmail } from './otp-challenge'

// Encryption
export {
  getEnvelopeByDeviceId,
  hasEnvelopesForUser,
  upsertEnvelope,
  deleteEnvelope,
  getEncryptionMetadata,
  insertEncryptionMetadataIfNotExists,
} from './encryption'
