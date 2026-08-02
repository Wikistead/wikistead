// Password policy (#568 / ADR-198 §8).
//
// LENGTH ONLY, at a minimum of 12. Composition rules ("one uppercase, one digit, one symbol") are
// what produce Password1! — they narrow the search space while making the result harder to remember,
// and every current guideline has dropped them. A longer minimum buys more than any rule about which
// characters appear in it.
//
// A maximum exists purely as a resource bound: scrypt hashes whatever it is given, and an
// unauthenticated endpoint should not accept a megabyte of it. 1024 is far above any real passphrase.
//
// The breach-corpus check ADR-198 §8 leaves as an open slot goes HERE when it lands; nothing about
// this signature changes when it does.
export const PASSWORD_MIN_LENGTH = 12
export const PASSWORD_MAX_LENGTH = 1024

export function validatePasswordPolicy(password: unknown): password is string {
  if (typeof password !== 'string') return false
  // Codepoints, not UTF-16 units: an emoji or a CJK passphrase must not be counted twice or half.
  const length = [...password].length
  return length >= PASSWORD_MIN_LENGTH && length <= PASSWORD_MAX_LENGTH
}
