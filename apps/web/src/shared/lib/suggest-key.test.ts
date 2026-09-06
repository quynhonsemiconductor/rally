/**
 * The key a form offers when the reader has typed only a name.
 *
 * Asserted per shape, because the two callers advertise different results on their own forms and a
 * single "obvious" rule would silently change what one of them has always suggested.
 */
import { describe, expect, it } from 'vitest'

import { suggestKey } from './suggest-key'

describe('suggestKey — initials, for a team', () => {
  const initials = (name: string) => suggestKey(name, { style: 'initials', max: 10 })

  it('takes one letter per word, which is what the form promises', () => {
    expect(initials('Core Platform')).toBe('CP')
    expect(initials('Quality Assurance Team')).toBe('QAT')
  })

  it('falls back to a prefix for a single word — one initial is not a legal key', () => {
    // The server takes `^[A-Z][A-Z0-9]{1,9}$`, so `P` would be refused.
    expect(initials('Platform')).toBe('PLATFORM')
  })

  it('ignores punctuation and collapses whitespace', () => {
    expect(initials('  core   platform! ')).toBe('CP')
    expect(initials('R&D / Tooling')).toBe('RT')
  })

  it('keeps digits, since the key allows them after the first character', () => {
    expect(initials('Squad 2 Delivery')).toBe('S2D')
  })

  it('respects the maximum', () => {
    expect(initials('a b c d e f g h i j k l')).toHaveLength(10)
  })

  it('answers empty for an empty name rather than inventing something', () => {
    expect(initials('')).toBe('')
    expect(initials('   ')).toBe('')
  })
})

describe('suggestKey — prefix, for a project', () => {
  const prefix = (name: string) => suggestKey(name, { style: 'prefix', max: 4 })

  it('keeps the behaviour the project form has always had', () => {
    expect(prefix('Mini Rova')).toBe('MINI')
    expect(prefix('Payments')).toBe('PAYM')
  })

  it('strips everything the key cannot carry', () => {
    expect(prefix('next-gen platform')).toBe('NEXT')
  })
})
