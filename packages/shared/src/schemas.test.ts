import { describe, expect, it } from 'vitest'
import { addSchema, joinSchema, moveSchema, seekSchema } from './schemas'

const UUID = '3f2b8c1e-8d4a-4c6b-9f0e-2a1b3c4d5e6f'

describe('joinSchema', () => {
  it('trims the nickname', () => {
    expect(joinSchema.parse({ clientId: UUID, nickname: '  Minh  ' }).nickname).toBe('Minh')
  })
  it('rejects empty or long nicknames and bad ids', () => {
    expect(joinSchema.safeParse({ clientId: UUID, nickname: '   ' }).success).toBe(false)
    expect(joinSchema.safeParse({ clientId: UUID, nickname: 'x'.repeat(25) }).success).toBe(false)
    expect(joinSchema.safeParse({ clientId: 'nope', nickname: 'Minh' }).success).toBe(false)
  })
})

describe('other payloads', () => {
  it('validates add, move and seek', () => {
    expect(addSchema.safeParse({ input: 'https://youtu.be/dQw4w9WgXcQ' }).success).toBe(true)
    expect(addSchema.safeParse({ input: '' }).success).toBe(false)
    expect(moveSchema.safeParse({ itemId: UUID, toIndex: 0 }).success).toBe(true)
    expect(moveSchema.safeParse({ itemId: UUID, toIndex: -1 }).success).toBe(false)
    expect(moveSchema.safeParse({ itemId: UUID, toIndex: 1.5 }).success).toBe(false)
    expect(seekSchema.safeParse({ position: 12.5 }).success).toBe(true)
    expect(seekSchema.safeParse({ position: Number.NaN }).success).toBe(false)
    expect(seekSchema.safeParse({ position: -1 }).success).toBe(false)
  })
})
