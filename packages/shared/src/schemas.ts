import { z } from 'zod'
import { MAX_QUEUE } from './types'

export const joinSchema = z.object({
  clientId: z.string().uuid(),
  nickname: z.string().trim().min(1).max(24),
})
export const addSchema = z.object({ input: z.string().trim().min(1).max(500) })
export const removeSchema = z.object({ itemId: z.string().uuid() })
export const moveSchema = z.object({
  itemId: z.string().uuid(),
  toIndex: z.number().int().min(0).max(MAX_QUEUE - 1),
})
export const seekSchema = z.object({ position: z.number().finite().min(0) })
export const emptySchema = z.object({}).passthrough()
export const searchQuerySchema = z.object({ q: z.string().trim().min(1).max(200) })
