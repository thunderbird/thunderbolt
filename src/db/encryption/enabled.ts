/**
 * Global encryption toggle.
 * Enabled by default — call setEncryptionEnabled(false) at startup to disable
 * (e.g. enterprise builds, feature flags).
 */
let encryptionEnabled = true

export const isEncryptionEnabled = () => encryptionEnabled

export const setEncryptionEnabled = (enabled: boolean) => {
  encryptionEnabled = enabled
}
