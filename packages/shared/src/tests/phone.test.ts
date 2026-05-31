/**
 * normalizePhone tests (Sprint 9 CP1 — inline helper coverage, NOT counted
 * toward the Sprint 9 CP5 +20 target).
 */

import { describe, expect, it } from 'bun:test'
import { normalizePhone } from '../phone'

describe('normalizePhone — E.164', () => {
  it('US 10-digit formatted → +1 prefix', () => {
    expect(normalizePhone('(555) 123-4567')).toBe('+15551234567')
  })

  it('international with + → digits preserved', () => {
    expect(normalizePhone('+44 20 7946 0958')).toBe('+442079460958')
    expect(normalizePhone('+5511987654321')).toBe('+5511987654321') // Brazil mobile
    expect(normalizePhone('+57 1 234 5678')).toBe('+5712345678') // Bogotá
  })

  it('US 11-digit starting with 1 → + prefix', () => {
    expect(normalizePhone('1-555-123-4567')).toBe('+15551234567')
  })

  it('garbage / un-inferrable → null', () => {
    expect(normalizePhone('abc')).toBeNull()
    expect(normalizePhone('')).toBeNull()
    expect(normalizePhone(null)).toBeNull()
    expect(normalizePhone(undefined)).toBeNull()
    expect(normalizePhone('12345')).toBeNull() // too short, no country code
  })
})
