import { customAlphabet } from 'nanoid';

const ALPHANUMERIC = '0123456789abcdefghijklmnopqrstuvwxyz';

const _nanoidSlug = customAlphabet(ALPHANUMERIC, 12);
const _nanoidCode = customAlphabet(ALPHANUMERIC, 8);

/**
 * generateTrustSlug() — 12-char lowercase alphanumeric (unguessable).
 */
export function generateTrustSlug() {
  return _nanoidSlug();
}

/**
 * generateInviteCode() — 8-char lowercase alphanumeric for circle invite links.
 */
export function generateInviteCode() {
  return _nanoidCode();
}
