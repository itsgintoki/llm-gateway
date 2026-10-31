import crypto from 'node:crypto';

/**
 * Computes the SHA-256 hex digest of a virtual API key.
 * Used to store and query hashed keys in the database.
 */
export function hashKey(rawKey: string): string {
  return crypto.createHash('sha256').update(rawKey.trim()).digest('hex');
}
