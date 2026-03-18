/** Format a recovery key hex string for display — groups of 8 chars separated by spaces. */
export const formatRecoveryKeyForDisplay = (hex: string): string =>
  hex
    .replace(/\s+/g, '')
    .match(/.{1,8}/g)
    ?.join(' ') ?? hex
