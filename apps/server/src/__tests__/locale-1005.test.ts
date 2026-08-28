import { describe, it, expect } from 'vitest'
import { isKnownLang, resolveMailLocale } from '../locale.js'

describe('#1005 isKnownLang / resolveMailLocale', () => {
  it('accepts only the known set', () => {
    expect(isKnownLang('en')).toBe(true)
    expect(isKnownLang('ja')).toBe(true)
    expect(isKnownLang('fr')).toBe(false)
    expect(isKnownLang(null)).toBe(false)
    expect(isKnownLang(undefined)).toBe(false)
    expect(isKnownLang('')).toBe(false)
  })

  it('resolves member → tenant → en, in that order', () => {
    expect(resolveMailLocale('ja', 'en')).toBe('ja')
    expect(resolveMailLocale(null, 'ja')).toBe('ja')
    expect(resolveMailLocale(null, null)).toBe('en')
    expect(resolveMailLocale('not-a-lang', 'ja')).toBe('ja')
    expect(resolveMailLocale('not-a-lang', 'also-not-a-lang')).toBe('en')
  })
})
